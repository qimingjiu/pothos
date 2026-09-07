/**
 * 信件通道测试（mail-信件通道-v0）：
 * RFC 2822 构造 + 追踪像素禁令、SMTP 会话（脚本服务器，2xx/5xx/4xx）、
 * quiet_hours 管寄不管写、outbox 状态机幂等、IMAP literal 解析、回信闭环、
 * letter 事件零冲量。
 */
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";
import {
  assertPlainText,
  buildRfc2822,
  dotStuff,
  imapFetchUnseen,
  rfc5322Date,
  type SocketFactory,
} from "../../src/mail/protocol.js";
import {
  MailWorker,
  mailConfigFromEnv,
  plusAlias,
  assertSendPolicy,
  type MailTransportConfig,
} from "../../src/mail/letters.js";
import { DEFAULT_PARAMS, type Params } from "../../src/core/params.js";
import { MemoryStore } from "../../src/storage/memory.js";
import { ManualClock } from "../../src/clock.js";
import { PothosService } from "../../src/service.js";
import { initialState, stateHash } from "../../src/core/state.js";
import { fold } from "../../src/core/engine.js";
import type { StoredEvent } from "../../src/core/events.js";
import type { LetterPhase, LetterRow } from "../../src/storage/types.js";

const T0 = 1_700_000_000_000;

// ── 脚本化假 socket（MailSocket 只用 on/write/end 三面；EventEmitter 直发，绕开流语义）──

class FakeSock extends EventEmitter {
  private pending = "";
  clientLines: string[] = [];

  constructor(
    private readonly respond: (clientLine: string) => string | null,
    greeting?: string,
  ) {
    super();
    if (greeting) this.flushOut(greeting + "\r\n");
  }

  /** setImmediate 投递：构造期 push 的 greeting 保证在 MailSocket attach 之后到达。 */
  private flushOut(s: string): void {
    setImmediate(() => this.emit("data", Buffer.from(s, "utf8")));
  }

  write(s: string | Buffer): boolean {
    this.pending += s.toString("utf8");
    for (;;) {
      const i = this.pending.indexOf("\r\n");
      if (i < 0) break;
      const line = this.pending.slice(0, i);
      this.pending = this.pending.slice(i + 2);
      this.clientLines.push(line);
      const r = this.respond(line);
      if (r != null) this.flushOut(r.endsWith("\r\n") ? r : r + "\r\n");
    }
    return true;
  }

  end(): void {
    this.emit("close");
  }
}

// ── RFC 2822 ──

describe("RFC 2822 信件构造（Huginn 门 4/5）", () => {
  it("头完整：From/To/Subject/Date（写信时刻）/Message-ID/In-Reply-To/References", () => {
    const raw = buildRfc2822({
      from: "resident@pothos.local",
      to: "her@example.com",
      subject: "给她的信",
      body: "凌晨三点写的第一行。",
      composedTs: T0,
      messageId: "lt-1@pothos.local",
      inReplyTo: "her-earlier@x",
    });
    expect(raw).toContain(`Date: ${rfc5322Date(T0)}`);
    expect(raw).toContain("Message-ID: <lt-1@pothos.local>");
    expect(raw).toContain("In-Reply-To: <her-earlier@x>");
    expect(raw).toContain("References: <her-earlier@x>");
    expect(raw).toContain("Content-Type: text/plain; charset=utf-8");
    expect(raw).not.toMatch(/<html|<img/i);
  });

  it("门 4：HTML/像素痕迹拒绝（追踪像素走私通道物理缺席）", () => {
    expect(() => assertPlainText("正常信体")).not.toThrow();
    expect(() => assertPlainText("<img src=x>")).toThrow(/text\/plain/);
    expect(() => assertPlainText("https://x.com/pixel.png")).toThrow(/text\/plain/);
    expect(() => assertPlainText("data:image/png;base64,xx")).toThrow(/text\/plain/);
  });

  it("点填充：行首 . 加倍（防 DATA 提前终止）", () => {
    expect(dotStuff("a\r\n.b\r\nc")).toBe("a\r\n..b\r\nc");
  });
});

// ── 部署面 ──

describe("mailConfigFromEnv（凭据诚实缺席）", () => {
  it("缺任一项 → null（信件通道未配置，不是假装在投）", () => {
    const full: Record<string, string> = {
      POTHOS_SMTP_HOST: "s", POTHOS_SMTP_USER: "u", POTHOS_SMTP_PASS: "p", POTHOS_SMTP_FROM: "f",
      POTHOS_IMAP_HOST: "i", POTHOS_IMAP_USER: "iu", POTHOS_IMAP_PASS: "ip", POTHOS_MAIL_TO: "her@example.com",
    };
    expect(mailConfigFromEnv(full)!.plusTag).toBe("pothos"); // plus 门牌默认
    expect(mailConfigFromEnv({ ...full, POTHOS_MAIL_PLUS_TAG: "her-door" })!.plusTag).toBe("her-door");
    const broken = { ...full };
    delete broken["POTHOS_IMAP_PASS"];
    expect(mailConfigFromEnv(broken)).toBeNull();
    expect(mailConfigFromEnv({})).toBeNull();
  });
});

// ── 三把锁（她 2026-09-07 定案：MAIL_TO 管发，FROM 白名单 + plus 门牌管收，Message-ID 管线）──

describe("三把锁", () => {
  it("plus 门牌派生：user@domain → user+pothos@domain", () => {
    expect(plusAlias("yaoy0851@gmail.com", "pothos")).toBe("yaoy0851+pothos@gmail.com");
    expect(plusAlias("a@b.co", "her-door")).toBe("a+her-door@b.co");
  });

  it("发信 Final Policy Check：envelope ≠ MAIL_TO 或 From 非门牌 → 拒（构造层不生成、投递层不放过）", () => {
    const cfg: MailTransportConfig = {
      smtp: { host: "s", user: "u", pass: "p", from: "yaoy0851@gmail.com" },
      imap: { host: "i", user: "iu", pass: "ip" },
      toAddr: "her@example.com",
      plusTag: "pothos",
    };
    const raw = buildRfc2822({
      from: plusAlias("yaoy0851@gmail.com", "pothos"),
      to: "her@example.com", subject: "s", body: "b", composedTs: 0, messageId: "m",
    });
    expect(() => assertSendPolicy({ toAddr: "her@example.com" }, raw, cfg)).not.toThrow();
    expect(() => assertSendPolicy({ toAddr: "someone-else@example.com" }, raw, cfg)).toThrow(/send-policy/);
    const rawWrongFrom = buildRfc2822({ from: "yaoy0851@gmail.com", to: "her@example.com", subject: "s", body: "b", composedTs: 0, messageId: "m" });
    expect(() => assertSendPolicy({ toAddr: "her@example.com" }, rawWrongFrom, cfg)).toThrow(/plus/);
  });

  it("投递层锁：被篡改收件人的信 → held_manual（不重试、不投出、不假装发出）", async () => {
    class TamperedStore extends MemoryStore {
      override async listLettersByPhase(phases: LetterPhase[]): Promise<LetterRow[]> {
        const rows = await super.listLettersByPhase(phases);
        return rows.map((r) => ({ ...r, toAddr: "someone-else@example.com" }));
      }
    }
    const tampered = new TamperedStore();
    const ts = new Date(); ts.setHours(10, 0, 0, 0);
    const clock = new ManualClock(ts.getTime());
    const params: Params = { ...DEFAULT_PARAMS, mailWindowStartHour: 7, mailWindowEndHour: 23, mailMaxAttempts: 3 };
    let sockets = 0;
    const svc = new PothosService(tampered, clock);
    const worker = new MailWorker({
      store: tampered,
      cfg: { smtp: { host: "s", user: "u", pass: "p", from: "yaoy0851@gmail.com" }, imap: { host: "i", user: "iu", pass: "ip" }, toAddr: "her@example.com", plusTag: "pothos" },
      params: () => params,
      ingest: async (ev) => { await svc.ingest(ev); },
      clock: () => clock.now(),
      socketFn: (async () => { sockets += 1; return new FakeSock(makeSmtpScript("250 ok"), "220 mail.test ESMTP") as unknown as Duplex; }) as unknown as SocketFactory,
    });
    await worker.compose({ subject: "s", body: "b", composedTs: ts.getTime() });
    await worker.poll();
    const l = await tampered.listLettersByPhase(["held_manual"]);
    expect(l).toHaveLength(1);
    expect(l[0]!.bounceReason).toContain("send-policy");
    expect(sockets).toBe(0); // 违规信连 SMTP 会话都没开——构造层不生成、投递层不放过
  });

  it("收信锁字面化：SEARCH 带 FROM 她 + TO plus 门牌 双条件（白名单外的信从来不拿）", async () => {
    const ts = new Date(); ts.setHours(10, 0, 0, 0);
    const clock = new ManualClock(ts.getTime());
    const store = new MemoryStore();
    const sockets: FakeSock[] = [];
    const worker = new MailWorker({
      store,
      cfg: { smtp: { host: "s", user: "u", pass: "p", from: "yaoy0851@gmail.com" }, imap: { host: "imap.test", user: "iu", pass: "ip" }, toAddr: "her@example.com", plusTag: "pothos" },
      params: () => ({ ...DEFAULT_PARAMS, mailWindowStartHour: 7, mailWindowEndHour: 23, mailMaxAttempts: 3 }),
      ingest: async () => {},
      clock: () => clock.now(),
      socketFn: (async () => {
        const fd = new FakeSock(imapScript({ inReplyTo: null, messageId: "m-1", text: "x" }), "* OK ready");
        sockets.push(fd);
        return fd as unknown as Duplex;
      }) as unknown as SocketFactory,
    });
    await worker.pollReplies();
    const searchLine = sockets[0]!.clientLines.find((l) => l.includes("SEARCH"));
    expect(searchLine).toContain('FROM "her@example.com"');
    expect(searchLine).toContain('TO "yaoy0851+pothos@gmail.com"');
  });
});

// ── worker：状态机 / 幂等 / quiet_hours / 退信 ──

function makeWorker(opts: { hour: number; smtpReply: (line: string) => string | null; maxAttempts?: number }) {
  const store = new MemoryStore();
  const clock = new ManualClock(T0);
  const ts = new Date();
  ts.setHours(opts.hour, 0, 0, 0); // 本地时区小时——窗口判断与测试同一时区口径
  const clockFixed = new ManualClock(ts.getTime());
  const params: Params = {
    ...DEFAULT_PARAMS,
    mailWindowStartHour: 7,
    mailWindowEndHour: 23,
    mailMaxAttempts: opts.maxAttempts ?? 3,
  };
  const ingested: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const worker = new MailWorker({
    store,
    cfg: {
      smtp: { host: "smtp.test", user: "u", pass: "p", from: "resident@pothos.local" },
      imap: { host: "imap.test", user: "iu", pass: "ip" },
      toAddr: "her@example.com",
      plusTag: "pothos",
    },
    params: () => params,
    ingest: async (ev) => {
      ingested.push({ kind: ev.kind, payload: ev.payload });
      await svc.ingest(ev); // 走真 fold（letter 零冲量 + 危机扫描）
    },
    clock: () => clockFixed.now(),
    socketFn: (async () => {
      const fd = new FakeSock(opts.smtpReply, "220 mail.test ESMTP");
      return fd as unknown as Duplex;
    }) as unknown as SocketFactory,
  });
  const svc = new PothosService(store, clockFixed);
  return { worker, store, svc, ingested, now: ts.getTime() };
}

/** RCPT 定向失败脚本（脚本实例每 worker 一份——stage/inData 状态不串线）。 */
function makeRcptFailScript(failLine: string): (line: string) => string | null {
  const inner = makeSmtpScript("250 ok");
  return (line: string) => (line.startsWith("RCPT") ? failLine : inner(line));
}

describe("投递 worker：quiet_hours + 状态机 + 确知事件", () => {
  it("窗外 → held（不改信不计尝试）；窗内 → sent 事件 + 事件入流", async () => {
    const out = makeWorker({
      hour: 3, // 窗外（7–23）
      smtpReply: () => "250 ok",
    });
    const row = await out.worker.compose({ subject: "s", body: "凌晨三点的信", composedTs: out.now });
    const r1 = await out.worker.poll();
    expect(r1.held).toBe(1);
    expect((await out.store.getLetter(row!.letterId))!.phase).toBe("held");

    // 出窗（hour=10）→ 投递成功 → sent
    const inW = makeWorker({ hour: 10, smtpReply: makeSmtpScript("250") });
    const row2 = await inW.worker.compose({ subject: "s", body: "上午写的信", composedTs: inW.now });
    const r2 = await inW.worker.poll();
    expect(r2.sent).toBe(1);
    expect((await inW.store.getLetter(row2!.letterId))!.phase).toBe("sent");
    expect((await inW.store.getLetter(row2!.letterId))!.sentTs).toBe(inW.now);
    expect(inW.ingested.filter((e) => e.kind === "letter" && e.payload["phase"] === "sent")).toHaveLength(1);
  });

  it("compose 幂等（同 letterId）：第二次 null，事件不重复（门 1）", async () => {
    const w = makeWorker({ hour: 10, smtpReply: makeSmtpScript("250 ok") });
    const a = await w.worker.compose({ letterId: "lt-fixed", subject: "s", body: "b", composedTs: w.now });
    const b = await w.worker.compose({ letterId: "lt-fixed", subject: "s", body: "b", composedTs: w.now });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    expect(w.ingested.filter((e) => e.kind === "letter")).toHaveLength(1);
  });

  it("5xx = 永久退信（确知事件 bounced）；4xx = 退避重试；超限 = held_manual（诚实放弃）", async () => {
    const w550 = makeWorker({ hour: 10, smtpReply: makeRcptFailScript("550 no such user") });
    const row = await w550.worker.compose({ subject: "s", body: "b", composedTs: w550.now });
    const r = await w550.worker.poll();
    expect(r.bounced).toBe(1);
    expect((await w550.store.getLetter(row!.letterId))!.bounceReason).toContain("550");
    expect(w550.ingested.some((e) => e.kind === "letter" && e.payload["phase"] === "bounced")).toBe(true);

    const w451 = makeWorker({ hour: 10, smtpReply: makeRcptFailScript("451 try later") });
    const row2 = await w451.worker.compose({ subject: "s", body: "b", composedTs: w451.now });
    const r2 = await w451.worker.poll();
    expect(r2.sent).toBe(0);
    expect(r2.failedRetry).toBe(1);
    expect((await w451.store.getLetter(row2!.letterId))!.phase).toBe("composed"); // 瞬态失败保持原相（held 只归窗口门）
    expect((await w451.store.getLetter(row2!.letterId))!.attemptCount).toBe(1);

    // 超限：mailMaxAttempts=1 → 首次瞬态失败即 held_manual（诚实放弃；退避期同钟点不重试，
    // 多次失败路径由 maxAttempts=1 直接到达终态——独立 worker 验证，不与退避纠缠）
    const wLimit = makeWorker({ hour: 10, smtpReply: makeRcptFailScript("451 try later"), maxAttempts: 1 });
    const row3 = await wLimit.worker.compose({ subject: "s", body: "b", composedTs: wLimit.now });
    const r3 = await wLimit.worker.poll();
    expect(r3.sent).toBe(0);
    expect((await wLimit.store.getLetter(row3!.letterId))!.phase).toBe("held_manual");
    expect((await wLimit.store.getLetter(row3!.letterId))!.bounceReason).toContain("attempt-limit");
  });

  it("letter 事件零冲量：含/不含 letter 事件的 fold 状态逐位一致（同 ts）", async () => {
    const w = makeWorker({ hour: 10, smtpReply: makeSmtpScript("250 ok") });
    await w.worker.compose({ subject: "s", body: "b", composedTs: w.now });
    const events = await w.svc.store.loadEvents();
    const letterEvents = events.filter((e) => e.kind === "letter");
    expect(letterEvents.length).toBeGreaterThan(0);
    const withoutLetter: StoredEvent[] = events.filter((e) => e.kind !== "letter");
    const a = fold(events as StoredEvent[], w.now, { from: initialState(w.now - 1000, 0x50544853) });
    const b = fold(withoutLetter as StoredEvent[], w.now, { from: initialState(w.now - 1000, 0x50544853) });
    expect(stateHash(b.state)).toBe(stateHash(a.state));
  });
});

/** SMTP 会话脚本工厂（显式 DATA 状态机：inData 后体行静默，"." 终止回 250；每脚本独立 stage）。 */
function makeSmtpScript(okCode: string): (line: string) => string | null {
  let stage = 0;
  let inData = false;
  return (line: string): string | null => {
    if (inData) {
      if (line === ".") { inData = false; return "250 queued"; }
      return null; // DATA 体行不回复
    }
    if (line.startsWith("EHLO")) return "250-mail.test\r\n250 AUTH LOGIN";
    if (line === "AUTH LOGIN") return "334 VXNlcm5hbWU6";
    if (line.startsWith("MAIL FROM") || line.startsWith("RCPT TO")) return `${okCode} ok`;
    if (line === "DATA") { inData = true; return "354 go"; }
    if (line === "QUIT") return "221 bye";
    if (/^[A-Za-z0-9+/=]+$/.test(line)) {
      stage += 1;
      return stage % 2 === 1 ? "334 UGFzc3dvcmQ6" : `235 ${okCode}`;
    }
    return null;
  };
}

// ── IMAP + 回信闭环 ──

function imapScript(mail: { inReplyTo: string | null; messageId: string; text: string }): (line: string) => string | null {
  const hdr =
    `Message-ID: <${mail.messageId}>\r\nIn-Reply-To: ${mail.inReplyTo ? `<${mail.inReplyTo}>` : ""}\r\nFrom: Her <her@example.com>\r\nSubject: Re:\r\n\r\n`;
  const text = mail.text;
  // 回 tagged 行（命令循环等 tagged 收敛）；literal 按 {N}\r\n<bytes>) 原文块整体推送
  return (line: string): string | null => {
    const sp = line.indexOf(" ");
    const tag = sp > 0 ? line.slice(0, sp) : null;
    if (!tag || !/^a\d+$/.test(tag)) return null;
    const c = line.slice(sp + 1);
    if (c.startsWith("LOGIN")) return `${tag} OK logged in`;
    if (c.startsWith("SELECT")) return `* 3 EXISTS\r\n${tag} OK selected`;
    if (c.startsWith("SEARCH")) return `${mail.inReplyTo ? "* SEARCH 1" : "* SEARCH"}\r\n${tag} OK done`;
    if (c.includes("HEADER.FIELDS")) {
      const n = Buffer.byteLength(hdr, "utf8");
      return `* 1 FETCH (BODY[HEADER.FIELDS (MESSAGE-ID IN-REPLY-TO FROM SUBJECT)] {${n}}\r\n${hdr})\r\n${tag} OK`;
    }
    if (c.includes("BODY.PEEK[TEXT]")) {
      const n = Buffer.byteLength(text, "utf8");
      return `* 1 FETCH (BODY[TEXT] {${n}}\r\n${text})\r\n${tag} OK`;
    }
    if (c.startsWith("STORE")) return `${tag} OK stored`;
    return `${tag} OK`;
  };
}

describe("回信闭环（IMAP → In-Reply-To → replied + user_msg）", () => {
  function makeReplyWorker(mail: { inReplyTo: string | null; messageId: string; text: string }) {
    const store = new MemoryStore();
    const ts = new Date();
    ts.setHours(10, 0, 0, 0);
    const clock = new ManualClock(ts.getTime());
    const params: Params = { ...DEFAULT_PARAMS, mailWindowStartHour: 7, mailWindowEndHour: 23, mailMaxAttempts: 3 };
    const ingested: Array<{ kind: string; payload: Record<string, unknown>; idempotencyKey?: string }> = [];
    const worker = new MailWorker({
      store,
      cfg: {
        smtp: { host: "smtp.test", user: "u", pass: "p", from: "resident@pothos.local" },
        imap: { host: "imap.test", user: "iu", pass: "ip" },
        toAddr: "her@example.com",
        plusTag: "pothos",
      },
      params: () => params,
      ingest: async (ev) => {
        ingested.push({ kind: ev.kind, payload: ev.payload, idempotencyKey: ev.idempotencyKey });
      },
      clock: () => clock.now(),
      socketFn: (async () => new FakeSock(imapScript(mail), "* OK ready")) as unknown as SocketFactory,
    });
    const svc = new PothosService(store, clock);
    return { worker, store, svc, ingested, now: ts.getTime() };
  }

  it("她回 Re: → phase=replied + 她的话按 user_msg 入流（回信 Message-ID 幂等键）", async () => {
    const closer = makeReplyWorker({ inReplyTo: "lt-1@pothos.local", messageId: "her-reply-1", text: "看到了，周六见。" });
    await closer.worker.compose({ letterId: "lt-1", subject: "信", body: "正文", composedTs: closer.now });
    await closer.store.transitionLetter("lt-1", "composed", "sent", { atTs: closer.now });
    const r = await closer.worker.pollReplies();
    expect(r.replies).toBe(1);
    expect((await closer.store.getLetter("lt-1"))!.phase).toBe("replied");
    const userMsg = closer.ingested.find((e) => e.kind === "user_msg");
    expect(userMsg).toBeDefined();
    expect(userMsg!.payload["text"]).toBe("看到了，周六见。");
    expect(userMsg!.idempotencyKey).toContain("her-reply-1");
  });

  it("陌生 In-Reply-To 不冒认（unclaimed）；重跑幂等不重复入账", async () => {
    const stranger = makeReplyWorker({ inReplyTo: "someone-elses-mail@x", messageId: "m1", text: "hi" });
    const r1 = await stranger.worker.pollReplies();
    expect(r1.unclaimed).toBe(1);
    expect(stranger.ingested.filter((e) => e.kind === "user_msg")).toHaveLength(0);

    // 幂等重跑：已 replied 的信再 poll → transition 同相返回 null → 不重复入账
    const w = makeReplyWorker({ inReplyTo: "lt-known@pothos.local", messageId: "her-reply-2", text: "re" });
    await w.worker.compose({ letterId: "lt-known", subject: "s", body: "b", composedTs: w.now });
    await w.store.transitionLetter("lt-known", "composed", "sent", { atTs: w.now });
    await w.worker.pollReplies();
    const before = w.ingested.filter((e) => e.kind === "user_msg").length;
    await w.worker.pollReplies();
    expect(w.ingested.filter((e) => e.kind === "user_msg").length).toBe(before); // 幂等
  });
});

describe("IMAP literal 解析", () => {
  it("imapFetchUnseen 解析 literal 头与文本（STORE \u005cSeen 已发）", async () => {
    const script = imapScript({ inReplyTo: "lt-1@pothos.local", messageId: "her-reply-9", text: "回信正文" });
    const socket = new FakeSock((line) => {
      if (line.endsWith("LOGOUT")) return null;
      return script(line);
    }, "* OK ready");
    const mails = await imapFetchUnseen({
      host: "imap.test",
      user: "iu",
      pass: "ip",
      connectFn: (async () => socket) as unknown as SocketFactory,
    });
    expect(mails).toHaveLength(1);
    expect(mails[0]!.inReplyTo).toBe("lt-1@pothos.local");
    expect(mails[0]!.messageId).toBe("her-reply-9");
    expect(mails[0]!.text).toBe("回信正文");
    expect(socket.clientLines.some((l) => l.includes("+FLAGS"))).toBe(true);
  });
});
