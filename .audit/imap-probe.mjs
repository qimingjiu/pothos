// 服务器 IMAP 只读探针：她回信状态 + 标定信归档账目（不 STORE，不动任何 flag）
import tls from "node:tls";

const IMAP_HOST = "imap.gmail.com";
const IMAP_PORT = 993;
const USER = "yaoy0851@gmail.com";
const PASS = process.env.IMAP_PASS;
const HER = "2250756812@qq.com";
const ALIAS = "yaoy0851+pothos@gmail.com";

function connect(port, host) {
  return new Promise((res, rej) => {
    const s = tls.connect({ host, port }, () => res(s));
    s.on("error", rej);
    s.setTimeout(20000, () => { s.destroy(new Error("probe timeout")); });
  });
}

function makeSock(sock) {
  let buf = Buffer.alloc(0);
  let wake = null;
  let err = null;
  sock.on("data", (d) => { buf = Buffer.concat([buf, d]); if (wake) { const w = wake; wake = null; w(); } });
  sock.on("error", (e) => { err = e; if (wake) { const w = wake; wake = null; w(); } });
  sock.on("close", () => { err = err ?? new Error("socket closed"); if (wake) { const w = wake; wake = null; w(); } });
  async function readLine() {
    for (;;) {
      const i = buf.indexOf("\r\n");
      if (i >= 0) { const line = buf.slice(0, i).toString("utf8"); buf = buf.slice(i + 2); return line; }
      if (err) throw err;
      await new Promise((r) => { wake = r; });
    }
  }
  async function readBytes(n) {
    while (buf.length < n) {
      if (err) throw err;
      await new Promise((r) => { wake = r; });
    }
    const out = buf.slice(0, n).toString("utf8");
    buf = buf.slice(n);
    return out;
  }
  return { readLine, readBytes, write: (s) => sock.write(s), end: () => sock.end() };
}

async function main() {
  const sock = await connect(IMAP_PORT, IMAP_HOST);
  const ms = makeSock(sock);
  const greet = await ms.readLine();
  console.log("greeting:", greet.slice(0, 80));
  let tag = 0;
  async function cmd(line) {
    tag += 1;
    const t = "p" + tag;
    ms.write(`${t} ${line}\r\n`);
    const lines = [];
    for (;;) {
      const l = await ms.readLine();
      if (l.startsWith(`${t} `)) {
        const bad = / (NO|BAD)/.test(l);
        return { status: l, lines, bad };
      }
      lines.push(l);
      const m = l.match(/\{(\d+)\}$/);
      if (m) await ms.readBytes(Number(m[1])); // literal 内容探针不消费
    }
  }
  await cmd(`LOGIN "${USER}" "${PASS}"`);

  // ── INBOX：她的回信（不看 UNSEEN——查全部 + FLAGS）──
  await cmd('SELECT "INBOX"');
  const s1 = await cmd(`SEARCH FROM "${HER}" TO "${ALIAS}"`);
  const ids = ((s1.lines.join(" ").match(/\* SEARCH (.*)/) ?? [])[1] ?? "").trim().split(/\s+/).filter(Boolean);
  console.log(`\n[INBOX] FROM她+TO门牌 命中 ${ids.length} 封`);
  for (const id of ids) {
    const f = await cmd(`FETCH ${id} (FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (MESSAGE-ID IN-REPLY-TO SUBJECT DATE FROM TO)])`);
    console.log(`--- seq ${id} ---`);
    console.log(f.lines.join("\n").replace(/\r/g, ""));
  }

  // ── 已发送归档：标定信原文账目 ──
  const sel = await cmd('SELECT "[Gmail]/Sent Mail"');
  if (sel.bad) {
    console.log("\n[SENT] 选择失败：", sel.status);
  } else {
    const s2 = await cmd(`SEARCH TO "${HER}"`);
    const sentIds = ((s2.lines.join(" ").match(/\* SEARCH (.*)/) ?? [])[1] ?? "").trim().split(/\s+/).filter(Boolean);
    console.log(`\n[SENT] 发往她的信 ${sentIds.length} 封`);
    for (const id of sentIds.slice(-3)) {
      const f = await cmd(`FETCH ${id} (INTERNALDATE BODY.PEEK[HEADER.FIELDS (MESSAGE-ID SUBJECT DATE FROM TO)])`);
      console.log(`--- sent ${id} ---`);
      console.log(f.lines.join("\n").replace(/\r/g, ""));
      const b = await cmd(`FETCH ${id} (BODY.PEEK[TEXT])`);
      const txt = b.lines.filter((x) => !/^\* \d+ FETCH/.test(x)).join("\n");
      console.log(`body(${txt.length} chars): ${txt.slice(0, 300).replace(/\r/g, "")}`);
    }
  }
  await cmd("LOGOUT").catch(() => {});
  ms.end();
  console.log("\nprobe done（只读，未动 FLAGS）");
}

main().catch((e) => { console.error("PROBE-FAIL:", e.message); process.exit(1); });
