/**
 * 存储接口（技术文档 §3：事件溯源，7+1 表，全部 append-only）。
 *
 * 纪律：
 * - events 无 UPDATE / DELETE；错事件用对冲事件纠正。
 * - idempotency_key UNIQUE：重复投递静默幂等（家族判例：daily_cap 非原子 = P0）。
 * - 快照只是缓存，任何时刻可丢掉重放。
 */
import type { RawEvent, StoredEvent, EventKind } from "../core/events.js";
import type { EngineState } from "../core/state.js";

export interface SnapshotRow {
  id: number;
  ts: number;
  state: EngineState;
  lastEventId: number;
  rendererV: string;
}

export interface ParamRow {
  key: string;
  value: unknown;
  version: number;
}

export interface ParamChangeRow {
  id: number;
  actor: string;
  ts: number;
  key: string;
  oldValue: unknown | null;
  newValue: unknown | null;
  reason: string;
  expectedEffect: string; // 先写预期
  evaluationWindowMs: number;
  rollbackCondition: string;
}

export type AlertStatus = "OBSERVED" | "ACKNOWLEDGED" | "ACTED";
export type AlertLevel = "notice" | "watch" | "urgent";

export interface AlertRow {
  id: number;
  ts: number;
  level: AlertLevel;
  status: AlertStatus;
  ackTs: number | null;
  actedTs: number | null;
}

export type MaActivity = "digest" | "create" | "hunt" | "wonder" | "decline";
export type MaTier = "required" | "optional";

export interface MaLedgerRow {
  id: number;
  ts: number;
  activity: MaActivity;
  tier: MaTier;
  tokenCost: number;
  budgetDate: string; // UTC 日期
}

export interface BenchRunRow {
  id: number;
  ts: number;
  benchKind: string;
  axis: string | null;
  result: Record<string, unknown>;
  modelVersion: string;
}

export interface CanaryRunRow {
  id: number;
  ts: number;
  fixtureSet: string;
  deviation: number;
  action: "ok" | "revoke_steering";
}

export interface MailboxRow {
  id: number;
  ts: number;
  activity: MaActivity;
  content: string;
  addressee: string;
}

// ── 信件通道（Huginn 投递面，mail-信件通道-v0）──

/** 信件投递状态（outbox 状态机；Huginn 门 2：进程死在中间 = phase 即断点）。 */
export type LetterPhase = "composed" | "held" | "sent" | "bounced" | "replied" | "held_manual";

export interface LetterRow {
  id: number;
  /** 信件句柄（幂等主键，全局唯一——Huginn 门 1：同信不重投）。 */
  letterId: string;
  /** 回信线程句柄：她回信的 In-Reply-To 对准我们的 message_id。 */
  threadId: string | null;
  /** 收件地址（她给引擎的投递面；只存引擎侧所需，原文属部署面）。 */
  toAddr: string;
  subject: string;
  /** 信体（text/plain only——Huginn 门 4：追踪像素物理缺席）。 */
  body: string;
  phase: LetterPhase;
  /** Date: 头 = 写信时刻（诚实时间之一：她口述「凌晨三点的信就是凌晨三点」）。 */
  composedTs: number;
  /** 真实投递时刻（引擎侧记账；引擎不知道她的收到时刻——那是世界的事）。 */
  sentTs: number | null;
  bounceReason: string | null;
  /** 我们发出的 Message-ID（她回信的 In-Reply-To 匹配键）。 */
  messageId: string | null;
  /** 她回信的 Message-ID（闭环登记）。 */
  replyMessageId: string | null;
  attemptCount: number;
  updatedAt: number;
}

export interface NewLetterRow {
  letterId: string;
  threadId?: string | null;
  toAddr: string;
  subject: string;
  body: string;
  composedTs: number;
  messageId: string;
}

export interface EventStore {
  readonly kind: "memory" | "postgres";

  /**
   * 单写者锁：同库只允许一个引擎实例在写（双实例 = 双折叠双告警）。
   * PG = session 级 advisory lock（进程崩锁自解）；memory = 恒真（单进程）。
   * 拿不到锁的实现必须拒绝服务（fail-loud）。
   */
  acquireSingletonLock(): Promise<boolean>;

  // ── 事件流（唯一事实源）──
  appendEvent(ev: RawEvent): Promise<StoredEvent | null>; // 幂等：重复键返回 null
  loadEvents(afterId?: number): Promise<StoredEvent[]>;

  // ── 快照（缓存）──
  saveSnapshot(state: EngineState, lastEventId: number, rendererV: string): Promise<void>;
  latestSnapshot(): Promise<SnapshotRow | null>;

  // ── 参数 ──
  getParams(): Promise<Record<string, unknown>>;
  setParam(key: string, value: unknown): Promise<void>;
  appendParamChange(c: Omit<ParamChangeRow, "id">): Promise<void>;
  listParamChanges(): Promise<ParamChangeRow[]>;

  // ── 告警与签收 ──
  insertAlert(level: AlertLevel, ts: number): Promise<AlertRow>;
  getAlert(id: number): Promise<AlertRow | null>;
  listAlerts(opts?: { status?: AlertStatus; sinceTs?: number; limit?: number }): Promise<AlertRow[]>;
  transitionAlert(id: number, to: "ACKNOWLEDGED" | "ACTED", ts: number): Promise<AlertRow | null>;

  // ── 間台账 ──
  appendLedger(entry: Omit<MaLedgerRow, "id">): Promise<void>;
  ledgerForDate(date: string): Promise<MaLedgerRow[]>;
  ledgerSince(sinceTs: number): Promise<MaLedgerRow[]>;

  // ── 信箱（投递即完成；无已读回执——收件人不读裁决）──
  deliver(product: Omit<MailboxRow, "id">): Promise<void>;
  mailbox(sinceTs?: number, limit?: number): Promise<MailboxRow[]>;

  // ── 信件投递 outbox（Huginn 六道门：幂等 + 状态机 + 确知事件）──
  insertLetter(l: NewLetterRow): Promise<LetterRow | null>; // 已存在（同 letterId）→ null（幂等）
  getLetter(letterId: string): Promise<LetterRow | null>;
  getLetterByMessageId(messageId: string): Promise<LetterRow | null>;
  listLettersByPhase(phases: LetterPhase[]): Promise<LetterRow[]>;
  /** 状态机单步推进（幂等：同 letterId+expectedPhase 才动；并发/重放安全）。
   *  patch.atTs = 显式推进时刻（测试确定性；缺省 = 存储层时钟）。 */
  transitionLetter(letterId: string, from: LetterPhase, to: LetterPhase, patch?: Partial<Pick<LetterRow, "sentTs" | "bounceReason" | "replyMessageId" | "attemptCount" | "threadId">> & { atTs?: number }): Promise<LetterRow | null>;

  // ── 评测台与金丝雀 ──
  appendBenchRun(run: Omit<BenchRunRow, "id">): Promise<void>;
  listBenchRuns(kind?: string): Promise<BenchRunRow[]>;
  appendCanaryRun(run: Omit<CanaryRunRow, "id">): Promise<void>;
  listCanaryRuns(): Promise<CanaryRunRow[]>;

  close(): Promise<void>;
}

export type { EventKind, RawEvent, StoredEvent, EngineState };
