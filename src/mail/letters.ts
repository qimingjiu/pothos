/**
 * 信件通道编排（Huginn 投递面，mail-信件通道-v0）。
 *
 * 三条邮件纪律的物理化（她口述 2026-09-07）：
 *  - 追踪像素禁令：只发 text/plain + 组合层 HTML/像素拒绝（门 4 双层）；
 *  - 确知事件：sent / bounced 入账（kind=letter，零冲量）；「她看了没回」永不入账（铁律 7）；
 *  - 回信闭环：IMAP 收信 → In-Reply-To 对上 Message-ID → phase=replied +
 *    她的话按 user_msg 入流（主燃料，C_t/C_s 配对照常咬合）。
 *
 * Huginn 六道门：幂等（letterId 唯一 + user_msg 幂等键）/ 状态机（phase 即断点，
 * 进程死在中间重启续跑）/ quiet_hours（管寄不管写——Date 与投递两个时间都真）/ 
 * 独立配额（maxAttempts 退避上限，放弃→held_manual 诚实挂起，不假装发出）。
 */
import { SerialQueue } from "../serial.js";
import { randomBytes, createHash } from "node:crypto";
import {
  buildRfc2822,
  assertLetterInput,
  assertPlainText,
  imapFetchUnseen,
  smtpSend,
  type FetchedMail,
  type SocketFactory,
} from "./protocol.js";
import type {
  EventStore,
  LetterPhase,
  LetterRow,
  NewLetterRow,
} from "../storage/types.js";
import type { RawEvent } from "../core/events.js";
import type { Params } from "../core/params.js";

/** 部署面凭据（全在引擎侧 env，不入仓库）。缺任一项 = 信件通道未配置（诚实缺席）。 */
export interface MailTransportConfig {
  smtp: { host: string; port?: number; user: string; pass: string; from: string };
  imap: { host: string; port?: number; user: string; pass: string };
  /** 她的收件地址（单人部署单收件人；发信锁的锚点）。 */
  toAddr: string;
  /** plus 门牌（Gmail 加号别名）：From 写成 user+<tag>@domain——她的「回复」自动寄到门牌；
   *  信箱同址但波索斯有自己的门牌号。默认 "pothos"。 */
  plusTag: string;
}

/** plus 别名：local+tag@domain（无 @ 的地址原样返回）。 */
export function plusAlias(addr: string, tag: string): string {
  const at = addr.lastIndexOf("@");
  if (at <= 0) return addr;
  return `${addr.slice(0, at)}+${tag}@${addr.slice(at + 1)}`;
}

/** 发信 Final Policy Check（投递层不放过）：envelope 收件人必须 == POTHOS_MAIL_TO，
 *  From: 头必须是 plus 门牌——构造层不生成，投递层不放过（双层）。违规 → held_manual。 */
export function assertSendPolicy(l: { toAddr: string }, raw: string, cfg: MailTransportConfig): void {
  if (l.toAddr !== cfg.toAddr) {
    throw new Error(`send-policy: envelope_to=${l.toAddr} != POTHOS_MAIL_TO=${cfg.toAddr}（发信锁：只能发给她）`);
  }
  const fromHeader = `From: ${plusAlias(cfg.smtp.from, cfg.plusTag)}`;
  if (!raw.startsWith(fromHeader)) {
    throw new Error(`send-policy: From 头不是 plus 门牌（${plusAlias(cfg.smtp.from, cfg.plusTag)}）——发信锁第二层`);
  }
}

export function mailConfigFromEnv(env: Record<string, string | undefined> = process.env): MailTransportConfig | null {
  const need = (k: string): string | undefined => env["POTHOS_" + k];
  const smtpHost = need("SMTP_HOST");
  const smtpUser = need("SMTP_USER");
  const smtpPass = need("SMTP_PASS");
  const from = need("SMTP_FROM");
  const imapHost = need("IMAP_HOST");
  const imapUser = need("IMAP_USER");
  const imapPass = need("IMAP_PASS");
  const toAddr = need("MAIL_TO");
  if (!smtpHost || !smtpUser || !smtpPass || !from || !imapHost || !imapUser || !imapPass || !toAddr) return null;
  const port = (k: string): number | undefined => {
    const v = need(k);
    return v ? Number(v) : undefined;
  };
  return {
    smtp: { host: smtpHost, port: port("SMTP_PORT"), user: smtpUser, pass: smtpPass, from },
    imap: { host: imapHost, port: port("IMAP_PORT"), user: imapUser, pass: imapPass },
    toAddr,
    plusTag: need("MAIL_PLUS_TAG") ?? "pothos",
  };
}

export interface LetterComposeInput {
  /** 信件句柄（幂等主键）；缺省生成。重复 compose 同句柄 = 静默幂等（门 1）。 */
  letterId?: string;
  subject: string;
  /** 信体：住户自己写的——引擎不给内容（内分泌不是提词器）。 */
  body: string;
  threadId?: string;
  /** Date: 头 = 写信时刻（缺省 now；「凌晨三点的信就是凌晨三点」）。 */
  composedTs?: number;
}

export interface MailWorkerDeps {
  store: EventStore;
  cfg: MailTransportConfig;
  /** 参数取值（quiet_hours / 重试上限走 params，param_changes 纪律）。 */
  params: () => Params;
  /** 事实事件入流（kind=letter 零冲量；她回信 = user_msg 主燃料）。 */
  ingest: (ev: RawEvent) => Promise<void>;
  clock: () => number;
  socketFn?: SocketFactory;
}

export interface PollReport {
  sent: number;
  held: number;
  bounced: number;
  failedRetry: number;
}
export class MailWorker {
  private readonly work = new SerialQueue();
  poll(): Promise<PollReport> { return this.work.run(() => this.pollUnlocked()); }
  pollReplies(): Promise<{ replies: number; unclaimed: number }> { return this.work.run(() => this.pollRepliesUnlocked()); }
  constructor(private readonly d: MailWorkerDeps) {}

  /** 投递窗口判断（她的时区 = 引擎主机时区口径；窗口跨午夜合法）。 */
  inDeliveryWindow(ts: number): boolean {
    const p = this.d.params();
    const h = new Date(ts).getHours();
    const start = p.mailWindowStartHour;
    const end = p.mailWindowEndHour;
    return start <= end ? h >= start && h < end : h >= start || h < end;
  }

  /** 住户侧创作入账：outbox 登记（幂等）+ composed 事件（零冲量）。 */
  async compose(input: LetterComposeInput): Promise<LetterRow | null> {
    assertLetterInput(input);
    const composedTs = input.composedTs ?? this.d.clock();
    const letterId = input.letterId ?? `lt-${composedTs}-${randomBytes(4).toString("hex")}`;
    const messageId = `${letterId}@pothos.local`;
    const draft: NewLetterRow = {
      letterId,
      threadId: input.threadId ?? null,
      toAddr: this.d.cfg.toAddr,
      subject: input.subject,
      body: input.body,
      composedTs,
      messageId,
    };
    const row = await this.d.store.insertLetter(draft);
    if (!row) return null; // 同 letterId 已登记——幂等，不重复发事件
    await this.d.ingest({
      kind: "letter",
      ts: composedTs,
      payload: { phase: "composed", letterId, subject: input.subject, threadId: input.threadId ?? null },
      idempotencyKey: `letter-${letterId}-composed`,
    });
    return row;
  }

  private buildRaw(l: LetterRow): string {
    // From: = plus 门牌（她的「回复」自动寄到 +pothos——收信锁第二把的一半）
    return buildRfc2822({
      from: plusAlias(this.d.cfg.smtp.from, this.d.cfg.plusTag),
      to: l.toAddr,
      subject: l.subject,
      body: l.body,
      composedTs: l.composedTs, // Date: = 写信时刻（门 5：管寄不管写，两时间都真）
      messageId: l.messageId ?? `${l.letterId}@pothos.local`,
    });
  }

  /** 收信 SEARCH 串（收信锁字面化）：FROM 她 AND TO plus 门牌，双条件命中才算数；
   *  白名单外的信不 fetch、不解析、不进住户视野——「从来不拿」，不是「拿了再删」。 */
  private searchQuery(): string {
    const her = this.d.cfg.toAddr;
    const alias = plusAlias(this.d.cfg.smtp.from, this.d.cfg.plusTag);
    if (her.includes('"') || alias.includes('"')) {
      throw new Error("收信锁：白名单地址含引号——SEARCH 字面化拒绝注入");
    }
    return `UNSEEN FROM "${her}" TO "${alias}"`;
  }

  /** 退避：第 n 次重试前的等待（min(2^n × 5min, 24h)）。 */
  static retryBackoffMs(attemptCount: number): number {
    return Math.min(2 ** attemptCount * 5 * 60_000, 24 * 3_600_000);
  }

  /**
   * worker 主循环（cron 每节律调用）：
   *  - 窗外 → held（不改信不删信，出窗即寄）；
   *  - 窗内到期 → SMTP 投递：2xx → sent；5xx → bounced（确知事件）；4xx/网络 → 退避重试；
   *  - 尝试数超上限 → held_manual（诚实放弃，人工面，不假装发出）。
   */
  private async pollUnlocked(): Promise<PollReport> {
    const report: PollReport = { sent: 0, held: 0, bounced: 0, failedRetry: 0 };
    const now = this.d.clock();
    const pending = await this.d.store.listLettersByPhase(["composed", "held"]);
    for (const l of pending) {
      if (!this.inDeliveryWindow(now)) {
        if (l.phase !== "held") {
          await this.d.store.transitionLetter(l.letterId, l.phase, "held", { atTs: now });
          report.held += 1;
        }
        continue; // 窗外不尝试（也不计尝试数——holding 不是失败）
      }
      const backoff = MailWorker.retryBackoffMs(l.attemptCount);
      if (l.attemptCount > 0 && now < l.updatedAt + backoff) continue; // 退避未到期
      let raw: string;
      // 发信 Final Policy Check（投递层不放过——构造层只生成这一个收件人，这里再断言一次）
      try {
        raw = this.buildRaw(l);
        assertSendPolicy(l, raw, this.d.cfg);
      } catch (e) {
        await this.d.store.transitionLetter(l.letterId, l.phase, "held_manual", {
          bounceReason: `send-policy: ${String((e as Error).message).slice(0, 160)}`,
          atTs: now,
        });
        continue; // 诚实放弃，不重试不假装发出
      }
      // 递增尝试数（同相 patch——held/composed 保持，失败语义落在下一条事件里）
      await this.d.store.transitionLetter(l.letterId, l.phase, l.phase, { attemptCount: l.attemptCount + 1, atTs: now });
      try {
        await smtpSend({ ...this.d.cfg.smtp, connectFn: this.d.socketFn }, l.toAddr, raw);
        await this.d.store.transitionLetter(l.letterId, l.phase, "sent", { sentTs: now, atTs: now });
        await this.d.ingest({
          kind: "letter",
          ts: now,
          payload: { phase: "sent", letterId: l.letterId, messageId: l.messageId },
          idempotencyKey: `letter-${l.letterId}-sent`,
        });
        report.sent += 1;
      } catch (e) {
        const err = e as SmtpLikeError;
        const message = String(err.message ?? err);
        const permanent = typeof err.code === "number" && err.code >= 500;
        if (permanent) {
          await this.d.store.transitionLetter(l.letterId, l.phase, "bounced", { bounceReason: message.slice(0, 200), atTs: now });
          await this.d.ingest({
            kind: "letter",
            ts: now,
            payload: { phase: "bounced", letterId: l.letterId, reason: message.slice(0, 200) },
            idempotencyKey: `letter-${l.letterId}-bounced`,
          });
          report.bounced += 1;
        } else if (l.attemptCount + 1 >= this.d.params().mailMaxAttempts) {
          // 尝试上限：诚实放弃（人工面），不是静默吞掉也不是假装发出
          await this.d.store.transitionLetter(l.letterId, l.phase, "held_manual", {
            bounceReason: `attempt-limit: ${message.slice(0, 160)}`,
            atTs: now,
          });
        } else {
          report.failedRetry += 1; // 保持 phase，下次 poll 按退避再试
        }
      }
    }
    return report;
  }

  /**
   * 回信闭环（IMAP poll，cron 调用）：
   * In-Reply-To 匹配我们发出的 Message-ID → phase=replied（确知事件）+
   * 她的话按 user_msg 入流（幂等键 = 回信 Message-ID——进程死在中间重投安全）。
   * 陌生 Message-ID 不冒认（只认自己发出的信）。
   */
  private async pollRepliesUnlocked(): Promise<{ replies: number; unclaimed: number }> {
    // Retry durable work first, even if IMAP is offline on this polling cycle.
    const report = await this.drainInbox();
    await imapFetchUnseen({ ...this.d.cfg.imap, search: this.searchQuery(), connectFn: this.d.socketFn,
      onMail: async mail => {
        if (!mail.messageId && !mail.uidValidity) throw new Error("IMAP message needs Message-ID or UIDVALIDITY for durable deduplication");
        const identity = mail.messageId ?? `uid:${mail.uidValidity}:${mail.seq}`;
        const inboxKey = createHash("sha256").update(`${this.d.cfg.imap.host}|${this.d.cfg.imap.user}|${identity}`).digest("hex");
        await this.d.store.insertInbox({ inboxKey, messageId: mail.messageId, inReplyTo: mail.inReplyTo,
          from: mail.from, subject: mail.subject, text: mail.text, receivedTs: this.d.clock() });
      },
    });
    const fresh = await this.drainInbox();
    return { replies: report.replies + fresh.replies, unclaimed: report.unclaimed + fresh.unclaimed };
  }

  private async drainInbox(): Promise<{ replies: number; unclaimed: number }> {
    let replies = 0, unclaimed = 0;
    for (const mail of await this.d.store.pendingInbox()) {
      const letter = mail.inReplyTo ? await this.d.store.getLetterByMessageId(mail.inReplyTo) : null;
      if (!letter || !["sent", "replied"].includes(letter.phase)) {
        // A send may have succeeded just before its outbox status update failed.
        // Keep matched but not-yet-sent letters pending instead of discarding replies.
        if (letter) continue;
        await this.d.store.completeInbox(mail.inboxKey, this.d.clock()); unclaimed++; continue;
      }
      await this.d.ingest({ kind: "letter", ts: mail.receivedTs,
        payload: { phase: "replied", letterId: letter.letterId, replyMessageId: mail.messageId, threadId: letter.threadId },
        idempotencyKey: `letter-${letter.letterId}-replied-${mail.inboxKey}` });
      await this.d.ingest({ kind: "user_msg", ts: mail.receivedTs, source: `email:${this.d.cfg.toAddr}`,
        payload: { text: mail.text, threadId: letter.threadId ?? null, letterId: letter.letterId },
        idempotencyKey: mail.messageId ? `mail-reply-${mail.messageId}` : `mail-reply-${mail.inboxKey}` });
      await this.d.store.transitionLetter(letter.letterId, letter.phase, "replied", { replyMessageId: mail.messageId, atTs: this.d.clock() });
      await this.d.store.completeInbox(mail.inboxKey, this.d.clock());
      replies++;
    }
    return { replies, unclaimed };
  }
}

interface SmtpLikeError extends Error {
  code?: number;
}
