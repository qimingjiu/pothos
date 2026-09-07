/**
 * 邮件协议最小实现（零依赖手写——与 MCP stdio NDJSON 同族的工程裁决）。
 *
 * 三件套：
 *  - RFC 2822 信件构造：text/plain only（Huginn 门 4：追踪像素物理缺席）；
 *    `Date:` = 写信时刻（诚实时间一），`Message-ID` = 她回信 In-Reply-To 的匹配键；
 *  - SMTP 客户端：465 隐式 TLS，EHLO/AUTH LOGIN/MAIL/RCPT/DATA（dot-stuffing）/QUIT；
 *  - IMAP 客户端（最小面）：993 SSL，LOGIN/SELECT/SEARCH UNSEEN/FETCH（HEADER+TEXT，
 *    literal 字节级消费）/STORE \Seen。
 *
 * 测试纪律：socket 工厂可注入（脚本化字节序列），真网路径需部署凭据、不在测试里跑。
 */
import { connect as tlsConnect } from "node:tls";
import type { Duplex } from "node:stream";

// ── RFC 2822 信件构造 ──

export interface LetterDraft {
  from: string;
  to: string;
  subject: string;
  body: string;
  /** Date: 头 = 写信时刻（quiet_hours 管寄不管写——两个时间都诚实登记）。 */
  composedTs: number;
  messageId: string;
  /** 回信线程：In-Reply-To / References 对准原信 Message-ID。 */
  inReplyTo?: string;
  threadId?: string;
}

/** 门 4 组合层：HTML/像素痕迹拒绝（第二层；第一层是「只发 text/plain」本身）。 */
export function assertPlainText(body: string): void {
  if (/<[a-zA-Z][^>]*>|&[a-z]+;|data:image|\.(gif|png|jpe?g)\b/i.test(body)) {
    throw new Error("letter body 含 HTML/图像痕迹——信件通道只发 text/plain（追踪像素物理缺席，Huginn 门 4）");
  }
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** RFC 5322 日期（UTC 表示；邮戳诚实条款——真实时刻不因时区化妆）。 */
export function rfc5322Date(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${DAY_NAMES[d.getUTCDay()]}, ${p(d.getUTCDate())} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`
  );
}

/** 构造 text/plain 信件（CRLF 行尾；点填充在 SMTP DATA 层做）。 */
export function buildRfc2822(draft: LetterDraft): string {
  assertPlainText(draft.body);
  const headers: string[] = [
    `From: ${draft.from}`,
    `To: ${draft.to}`,
    `Subject: ${draft.subject}`,
    `Date: ${rfc5322Date(draft.composedTs)}`,
    `Message-ID: <${draft.messageId}>`,
  ];
  if (draft.inReplyTo) {
    headers.push(`In-Reply-To: <${draft.inReplyTo}>`, `References: <${draft.inReplyTo}>`);
  }
  if (draft.threadId) headers.push(`X-Pothos-Thread: ${draft.threadId}`);
  headers.push("MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit");
  return `${headers.join("\r\n")}\r\n\r\n${draft.body}\r\n`;
}

// ── MailSocket：字节级缓冲 + literal 感知读取 ──

export type SocketFactory = (opts: { host: string; port: number }) => Promise<Duplex>;

export const tlsSocketFactory: SocketFactory = (opts) =>
  new Promise((resolve, reject) => {
    const s = tlsConnect({ host: opts.host, port: opts.port, servername: opts.host });
    s.once("secureConnect", () => resolve(s));
    s.once("error", (e) => reject(e));
  });

export class MailSocketClosedError extends Error {}

/** 读写包装：字节缓冲（literal 按字节吃，行按 \r\n 切），可注入 Duplex（测试）。 */
export class MailSocket {
  private buf = Buffer.alloc(0);
  private closed = false;
  private err: Error | null = null;
  private wake: (() => void)[] = [];

  constructor(private readonly socket: Duplex) {
    socket.on("data", (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.release();
    });
    socket.on("error", (e: Error) => {
      this.err = e;
      this.release();
    });
    socket.on("close", () => {
      this.closed = true;
      this.release();
    });
  }

  write(s: string): void {
    this.socket.write(s, "utf8");
  }

  end(): void {
    this.socket.end();
  }

  private release(): void {
    const w = this.wake.splice(0);
    for (const f of w) f();
  }

  private async until(cond: () => boolean, what: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (cond()) return;
      if (this.err) throw this.err;
      if (this.closed) throw new Error(`${what}: 连接已关闭`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`${what}: 超时（${timeoutMs}ms）`);
      // 心跳兜底：丢唤醒竞态（cond 假→数据到→release 空 转）不会永久挂起
      await new Promise<void>((r) => {
        this.wake.push(r);
        setTimeout(r, 5);
      });
    }
  }

  /** 读一行（不含 \r\n）。 */
  async readLine(timeoutMs = 30_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    await this.until(() => this.buf.indexOf("\r\n") >= 0 || this.err != null || this.closed, "readLine", deadline - Date.now());
    const idx = this.buf.indexOf("\r\n");
    if (idx < 0) throw new Error("readLine: 读取失败");
    const line = this.buf.subarray(0, idx).toString("utf8");
    this.buf = this.buf.subarray(idx + 2);
    return line;
  }

  /** 读 n 个字节（IMAP literal）。 */
  async readBytes(n: number, timeoutMs = 30_000): Promise<Buffer> {
    const deadline = Date.now() + timeoutMs;
    await this.until(() => this.buf.length >= n || this.err != null || this.closed, `readBytes(${n})`, deadline - Date.now());
    if (this.buf.length < n) throw new Error("readBytes: 读取失败");
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return Buffer.from(out);
  }
}

// ── SMTP ──

export class SmtpError extends Error {
  constructor(public readonly code: number, message: string) {
    super(`SMTP ${code}: ${message}`);
  }
}

interface SmtpSession {
  host: string;
  port?: number; // 465 隐式 TLS（缺省）
  user: string;
  pass: string;
  from: string;
  connectFn?: SocketFactory;
}

/** 解析 SMTP 多行回复（末行 "NNN␠"）。 */
export async function readSmtpReply(ms: MailSocket): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  for (;;) {
    const line = await ms.readLine();
    lines.push(line);
    if (line.length < 4 || line[3] !== "-") break;
  }
  return { code: Number(lines[0]!.slice(0, 3)), text: lines.join("\n") };
}

function smtpCheck(reply: { code: number; text: string }, expected: number[], what: string): void {
  if (!expected.includes(reply.code)) throw new SmtpError(reply.code, `${what}: ${reply.text.slice(0, 160)}`);
}

/** 点填充（RFC 5321 §4.5.2）：行首的 . 加倍，防提前终止 DATA。 */
export function dotStuff(raw: string): string {
  return raw
    .split("\r\n")
    .map((l) => (l.startsWith(".") ? `.${l}` : l))
    .join("\r\n");
}

/** 发一封信（最小 SMTP 会话）。raw = RFC 2822 全文。5xx = 永久退信面（bounce 是确知事件）。 */
export async function smtpSend(opts: SmtpSession, to: string, raw: string): Promise<void> {
  const connect = opts.connectFn ?? tlsSocketFactory;
  const socket = await connect({ host: opts.host, port: opts.port ?? 465 });
  const ms = new MailSocket(socket);
  const sendLine = (line: string): void => ms.write(line + "\r\n");
  try {
    smtpCheck(await readSmtpReply(ms), [220], "greeting");
    sendLine(`EHLO pothos`);
    smtpCheck(await readSmtpReply(ms), [250], "EHLO");
    sendLine(`AUTH LOGIN`);
    smtpCheck(await readSmtpReply(ms), [334], "AUTH LOGIN");
    sendLine(Buffer.from(opts.user).toString("base64"));
    smtpCheck(await readSmtpReply(ms), [334], "AUTH user");
    sendLine(Buffer.from(opts.pass).toString("base64"));
    smtpCheck(await readSmtpReply(ms), [235], "AUTH pass");
    sendLine(`MAIL FROM:<${opts.from}>`);
    smtpCheck(await readSmtpReply(ms), [250], "MAIL FROM");
    sendLine(`RCPT TO:<${to}>`);
    smtpCheck(await readSmtpReply(ms), [250, 251], "RCPT TO");
    sendLine(`DATA`);
    smtpCheck(await readSmtpReply(ms), [354], "DATA");
    // DATA 体不落日志（信件内容是住户内政）；行首点填充 + 终止点
    ms.write(dotStuff(raw) + "\r\n.\r\n");
    smtpCheck(await readSmtpReply(ms), [250], "DATA end");
    sendLine(`QUIT`);
    await readSmtpReply(ms).catch(() => undefined); // QUIT 回复失败不回滚已受理的投递
  } finally {
    ms.end();
  }
}

// ── IMAP（最小面：收未读 + 标已读，literal 字节级）──

export interface FetchedMail {
  seq: number;
  messageId: string | null;
  inReplyTo: string | null;
  from: string | null;
  subject: string | null;
  text: string;
}

interface ImapSession {
  host: string;
  port?: number; // 993 SSL（缺省）
  user: string;
  pass: string;
  /** 收信白名单的 SEARCH 串（收信锁字面化：白名单外的信「从来不拿」，不是「拿了再删」）。
   *  例：`UNSEEN FROM "her@example.com" TO "me+pothos@gmail.com"`。缺省 UNSEEN。 */
  search?: string;
  connectFn?: SocketFactory;
}

/** 头部解析：折叠行并入上一头；小写字段名。 */
export function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  let last: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && last) {
      out[last] += ` ${line.trim()}`;
      continue;
    }
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) {
      last = m[1]!.toLowerCase();
      out[last] = m[2]!;
    }
  }
  return out;
}

function stripAngle(v: string | undefined): string | null {
  if (!v) return null;
  const m = v.match(/<([^>]+)>/);
  return m ? m[1]! : v.trim() || null;
}

/** IMAP 命令收尾器已并入 imapFetchUnseen（最小面不需要泛化会话对象）。 */

/**
 * 收未读信（脚本化友好的一次会话流程）。
 * 回信闭环用：她回一封 Re:，In-Reply-To 对上 Message-ID，信就成线。
 */
export async function imapFetchUnseen(opts: ImapSession): Promise<FetchedMail[]> {
  const connect = opts.connectFn ?? tlsSocketFactory;
  const socket = await connect({ host: opts.host, port: opts.port ?? 993 });
  const ms = new MailSocket(socket);
  const out: FetchedMail[] = [];
  let tag = 0;
  const literals: string[] = [];
  const cmd = async (line: string): Promise<string[]> => {
    tag += 1;
    const t = `a${tag}`;
    ms.write(`${t} ${line}\r\n`);
    literals.length = 0;
    const lines: string[] = [];
    for (;;) {
      const l = await ms.readLine();
      if (l.startsWith(`${t} `)) {
        if (/ (NO|BAD)/.test(l)) throw new Error(`IMAP NO/BAD：${l.slice(0, 160)}`);
        return lines;
      }
      lines.push(l);
      const m = l.match(/\{(\d+)\}$/);
      if (m) literals.push((await ms.readBytes(Number(m[1]))).toString("utf8"));
    }
  };
  try {
    const greet = await ms.readLine();
    if (!greet.startsWith("* ")) throw new Error(`IMAP greeting 异常：${greet.slice(0, 80)}`);
    await cmd(`LOGIN ${opts.user} ${opts.pass}`);
    await cmd(`SELECT INBOX`);
    const searchLines = await cmd(`SEARCH ${opts.search ?? "UNSEEN"}`);
    const searchLine = searchLines.find((l) => l.startsWith("* SEARCH ")) ?? "* SEARCH";
    const seqs = searchLine.slice("* SEARCH".length).trim().split(/\s+/).filter(Boolean);
    for (const seq of seqs) {
      literals.length = 0;
      await cmd(`FETCH ${seq} (BODY.PEEK[HEADER.FIELDS (MESSAGE-ID IN-REPLY-TO FROM SUBJECT)])`);
      const headers = parseHeaders(literals[0] ?? "");
      literals.length = 0;
      await cmd(`FETCH ${seq} (BODY.PEEK[TEXT])`);
      const text = literals[0] ?? "";
      out.push({
        seq: Number(seq),
        messageId: stripAngle(headers["message-id"]),
        inReplyTo: stripAngle(headers["in-reply-to"]),
        from: headers["from"] ?? null,
        subject: headers["subject"] ?? null,
        text: text.trim(),
      });
      await cmd(`STORE ${seq} +FLAGS (\\Seen)`);
    }
    ms.write(`aLogout LOGOUT\r\n`);
  } finally {
    ms.end();
  }
  return out;
}
