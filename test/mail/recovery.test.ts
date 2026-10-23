import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";
import { MailWorker, type MailTransportConfig } from "../../src/mail/letters.js";
import { imapFetchUnseen, type SocketFactory } from "../../src/mail/protocol.js";
import { mimeText, parseHeaders } from "../../src/mail/mime.js";
import { MemoryStore } from "../../src/storage/memory.js";
import { PothosService } from "../../src/service.js";
import { ManualClock } from "../../src/clock.js";
import { DEFAULT_PARAMS } from "../../src/core/params.js";
import type { InboxRow, RawEvent } from "../../src/storage/types.js";

const now = Date.UTC(2026, 9, 23, 12);
const cfg: MailTransportConfig = { smtp: { host: "smtp.test", user: "u", pass: "p", from: "me@example.com" }, imap: { host: "imap.test", user: "u", pass: "p" }, toAddr: "her@example.com", plusTag: "pothos" };
class Socket extends EventEmitter {
  lines: string[] = [];
  constructor(private reply: (line: string) => string | null, greeting = "* OK ready") { super(); this.send(greeting); }
  send(s: string) { setImmediate(() => this.emit("data", Buffer.from(s + "\r\n"))); }
  write(s: string | Buffer) { for (const line of s.toString().split("\r\n").filter(Boolean)) { this.lines.push(line); const r = this.reply(line); if (r != null) this.send(r); } return true; }
  end() { this.emit("close"); }
}
function imapSocket(mail: { id?: string; text: string; mime?: string; uidValidity?: string }, ack?: () => void) {
  return new Socket(line => {
    const tag = line.split(" ")[0]!;
    if (line.includes("SELECT")) return `* OK [UIDVALIDITY ${mail.uidValidity ?? "10"}] valid\r\n${tag} OK`;
    if (line.includes("SEARCH")) return `* SEARCH 7\r\n${tag} OK`;
    if (line.includes("HEADER.FIELDS")) {
      const hdr = `${mail.id ? `Message-ID: <${mail.id}>\r\n` : ""}In-Reply-To: <lt@pothos.local>\r\nFrom: her@example.com\r\n${mail.mime ?? "Content-Type: text/plain; charset=utf-8"}\r\n\r\n`;
      return `* 1 FETCH (BODY[HEADER] {${Buffer.byteLength(hdr)}}\r\n${hdr})\r\n${tag} OK`;
    }
    if (line.includes("BODY.PEEK[TEXT]")) return `* 1 FETCH (BODY[TEXT] {${Buffer.byteLength(mail.text)}}\r\n${mail.text})\r\n${tag} OK`;
    if (line.includes("UID STORE")) ack?.();
    return `${tag} OK`;
  });
}
async function setup(store = new MemoryStore(), hooks: { ingest?: (ev: RawEvent) => Promise<void>; socket?: () => Socket } = {}) {
  const svc = new PothosService(store, new ManualClock(now)); await svc.boot();
  const socketFn: SocketFactory = async () => (hooks.socket?.() ?? imapSocket({ id: "reply", text: "收到，周末见。" })) as unknown as Duplex;
  const worker = new MailWorker({ store, cfg, params: () => ({ ...DEFAULT_PARAMS, mailWindowStartHour: 0, mailWindowEndHour: 24 }), clock: () => now,
    ingest: hooks.ingest ?? (async ev => { await svc.ingest(ev); }), socketFn });
  await store.insertLetter({ letterId: "lt", toAddr: cfg.toAddr, subject: "hello", body: "hello", composedTs: now - 1000, messageId: "lt@pothos.local" });
  await store.transitionLetter("lt", "composed", "sent", { sentTs: now - 500, atTs: now - 500 });
  return { store, svc, worker };
}

describe("durable inbox recovery", () => {
  it("does not acknowledge IMAP until inbox persistence succeeds", async () => {
    class BrokenStore extends MemoryStore { override async insertInbox(_row: InboxRow): Promise<void> { throw new Error("disk unavailable"); } }
    let acked = false;
    const { worker } = await setup(new BrokenStore(), { socket: () => imapSocket({ id: "r", text: "hello" }, () => { acked = true; }) });
    await expect(worker.pollReplies()).rejects.toThrow("disk unavailable");
    expect(acked).toBe(false);
  });

  it.each(["letter", "user_msg", "phase", "complete"])("retries safely after failure at %s", async stage => {
    let fail = true;
    class InterruptedStore extends MemoryStore {
      override async transitionLetter(...args: Parameters<MemoryStore["transitionLetter"]>) {
        if (fail && stage === "phase" && args[2] === "replied") { fail = false; throw new Error("interrupted"); }
        return super.transitionLetter(...args);
      }
      override async completeInbox(...args: Parameters<MemoryStore["completeInbox"]>) {
        if (fail && stage === "complete") { fail = false; throw new Error("interrupted"); }
        return super.completeInbox(...args);
      }
    }
    const store = new InterruptedStore();
    const svc = new PothosService(store, new ManualClock(now)); await svc.boot();
    const { worker } = await setup(store, { ingest: async ev => {
      // Crash after the write: replay must deduplicate already committed work too.
      await svc.ingest(ev);
      if (fail && ev.kind === stage) { fail = false; throw new Error("interrupted"); }
    } });
    await expect(worker.pollReplies()).rejects.toThrow("interrupted");
    expect(await store.pendingInbox()).toHaveLength(1);
    const restarted = new PothosService(store, new ManualClock(now));
    await restarted.boot({ reconcile: true });
    const resumed = new MailWorker({ store, cfg, params: () => DEFAULT_PARAMS, clock: () => now,
      ingest: async ev => { await restarted.ingest(ev); }, socketFn: async () => { throw new Error("offline"); } });
    // Durable inbox drains before the new network attempt.
    await expect(resumed.pollReplies()).rejects.toThrow("offline");
    expect(await store.pendingInbox()).toHaveLength(0);
    expect((await store.getLetter("lt"))?.phase).toBe("replied");
    const events = await store.loadEvents();
    expect(events.filter(e => e.kind === "user_msg")).toHaveLength(1);
    expect(events.filter(e => e.kind === "letter")).toHaveLength(1);
    expect(await restarted.reconcileNow()).toEqual({ mismatch: false });
  });

  it("deduplicates redelivery and accepts distinct replies to the same original", async () => {
    let id = "first";
    const { worker, store } = await setup(undefined, { socket: () => imapSocket({ id, text: id }) });
    await worker.pollReplies(); await worker.pollReplies();
    id = "second"; await worker.pollReplies(); await worker.pollReplies();
    expect((await store.loadEvents()).filter(e => e.kind === "user_msg").map(e => e.payload.text)).toEqual(["first", "second"]);
  });

  it("missing Message-ID uses UIDVALIDITY plus UID, including mailbox reset", async () => {
    let uidValidity = "10";
    const { worker, store } = await setup(undefined, { socket: () => imapSocket({ text: "hello", uidValidity }) });
    await worker.pollReplies(); await worker.pollReplies();
    uidValidity = "11"; await worker.pollReplies();
    expect((await store.loadEvents()).filter(e => e.kind === "user_msg")).toHaveLength(2);
  });
});

describe("MIME text extraction", () => {
  it("decodes UTF-8 base64 and quoted-printable without mojibake", () => {
    expect(mimeText({ "content-transfer-encoding": "base64" }, Buffer.from("你好，周六见。").toString("base64"))).toBe("你好，周六见。");
    expect(mimeText({ "content-transfer-encoding": "quoted-printable" }, "=E4=BD=A0=E5=A5=BD=\r\n=EF=BC=81")).toBe("你好！");
    expect(mimeText({ "content-type": "text/plain; charset=iso-8859-1" }, "caf\xe9")).toBe("café");
  });
  it("reads nested multipart plain text, skips HTML and attachments", () => {
    const body = ["preamble", "--outer", "Content-Type: multipart/alternative; boundary=inner", "", "--inner", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", Buffer.from("真实回复").toString("base64"), "--inner", "Content-Type: text/html", "", "<b>html</b>", "--inner--", "--outer", "Content-Type: text/plain", "Content-Disposition: attachment; filename=x.txt", "", "secret attachment", "--outer--"].join("\r\n");
    expect(mimeText(parseHeaders('Content-Type: multipart/mixed;\r\n boundary="outer"'), body)).toBe("真实回复");
  });
  it("rejects malformed encoding and HTML-only mail", () => {
    expect(() => mimeText({ "content-transfer-encoding": "base64" }, "not$base64")).toThrow();
    expect(() => mimeText({ "content-type": "text/html" }, "<b>hi</b>")).toThrow();
  });
  it("unsupported mail is not acknowledged", async () => {
    let acked = false;
    const sock = imapSocket({ id: "html", mime: "Content-Type: text/html", text: "<p>hello</p>" }, () => { acked = true; });
    const rows = await imapFetchUnseen({ ...cfg.imap, connectFn: async () => sock as unknown as Duplex, onMail: async () => { throw new Error("must not ingest"); } });
    expect(rows).toEqual([]); expect(acked).toBe(false);
  });
});
