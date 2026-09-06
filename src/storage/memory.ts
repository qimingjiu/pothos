/**
 * 内存存储适配器：测试 / 开发 / fork 回放用。
 * 语义与 PostgreSQL 适配器严格一致（幂等键、append-only、状态机迁移校验）。
 * ◆ 挂牌：生产部署必须用 postgres 适配器；本适配器数据不落盘。
 */
import type {
  AlertLevel,
  AlertRow,
  AlertStatus,
  BenchRunRow,
  CanaryRunRow,
  EventStore,
  MaLedgerRow,
  MailboxRow,
  ParamChangeRow,
  RawEvent,
  SnapshotRow,
  StoredEvent,
} from "./types.js";
import type { EngineState } from "../core/state.js";

export class MemoryStore implements EventStore {
  readonly kind = "memory" as const;

  async acquireSingletonLock(): Promise<boolean> {
    return true; // 单进程内嵌引擎：无同库竞争
  }

  private eventId = 0;
  private events: StoredEvent[] = [];
  private byIdem = new Map<string, StoredEvent>();
  private snapshots: SnapshotRow[] = [];
  private params = new Map<string, { value: unknown; version: number }>();
  private paramChanges: ParamChangeRow[] = [];
  private alerts: AlertRow[] = [];
  private alertId = 0;
  private ledger: MaLedgerRow[] = [];
  private ledgerId = 0;
  private mailboxRows: MailboxRow[] = [];
  private mailboxId = 0;
  private benchRuns: BenchRunRow[] = [];
  private canaryRuns: CanaryRunRow[] = [];

  async appendEvent(ev: RawEvent): Promise<StoredEvent | null> {
    if (ev.idempotencyKey) {
      const dup = this.byIdem.get(ev.idempotencyKey);
      if (dup) return null;
    }
    this.eventId += 1;
    const stored: StoredEvent = { ...ev, id: this.eventId };
    this.events.push(stored);
    if (ev.idempotencyKey) this.byIdem.set(ev.idempotencyKey, stored);
    return stored;
  }

  async loadEvents(afterId?: number): Promise<StoredEvent[]> {
    return afterId == null ? [...this.events] : this.events.filter((e) => e.id > afterId);
  }

  async saveSnapshot(state: EngineState, lastEventId: number, rendererV: string): Promise<void> {
    this.snapshots.push({
      id: this.snapshots.length + 1,
      ts: state.t,
      state: JSON.parse(JSON.stringify(state)) as EngineState,
      lastEventId,
      rendererV,
    });
  }

  async latestSnapshot(): Promise<SnapshotRow | null> {
    return this.snapshots.length ? this.snapshots[this.snapshots.length - 1]! : null;
  }

  async getParams(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of this.params) out[k] = v.value;
    return out;
  }

  async setParam(key: string, value: unknown): Promise<void> {
    const cur = this.params.get(key);
    this.params.set(key, { value, version: (cur?.version ?? 0) + 1 });
  }

  async appendParamChange(c: Omit<ParamChangeRow, "id">): Promise<void> {
    this.paramChanges.push({ ...c, id: this.paramChanges.length + 1 });
  }

  async listParamChanges(): Promise<ParamChangeRow[]> {
    return [...this.paramChanges];
  }

  async insertAlert(level: AlertLevel, ts: number): Promise<AlertRow> {
    this.alertId += 1;
    const row: AlertRow = { id: this.alertId, ts, level, status: "OBSERVED", ackTs: null, actedTs: null };
    this.alerts.push(row);
    return { ...row };
  }

  async getAlert(id: number): Promise<AlertRow | null> {
    const a = this.alerts.find((x) => x.id === id);
    return a ? { ...a } : null;
  }

  async listAlerts(opts?: { status?: AlertStatus; sinceTs?: number; limit?: number }): Promise<AlertRow[]> {
    let out = [...this.alerts];
    if (opts?.status) out = out.filter((a) => a.status === opts.status);
    if (opts?.sinceTs != null) out = out.filter((a) => a.ts >= opts.sinceTs!);
    out.sort((a, b) => b.ts - a.ts);
    return out.slice(0, opts?.limit ?? 100).map((a) => ({ ...a }));
  }

  async transitionAlert(id: number, to: "ACKNOWLEDGED" | "ACTED", ts: number): Promise<AlertRow | null> {
    const a = this.alerts.find((x) => x.id === id);
    if (!a) return null;
    if (to === "ACKNOWLEDGED") {
      if (a.status !== "OBSERVED") return null; // 状态机：只允许 OBSERVED→ACKNOWLEDGED
      a.status = "ACKNOWLEDGED";
      a.ackTs = ts;
    } else {
      if (a.status !== "ACKNOWLEDGED") return null; // 只允许 ACKNOWLEDGED→ACTED
      a.status = "ACTED";
      a.actedTs = ts;
    }
    return { ...a };
  }

  async appendLedger(entry: Omit<MaLedgerRow, "id">): Promise<void> {
    this.ledgerId += 1;
    this.ledger.push({ ...entry, id: this.ledgerId });
  }

  async ledgerForDate(date: string): Promise<MaLedgerRow[]> {
    return this.ledger.filter((l) => l.budgetDate === date).map((l) => ({ ...l }));
  }

  async ledgerSince(sinceTs: number): Promise<MaLedgerRow[]> {
    return this.ledger.filter((l) => l.ts >= sinceTs).map((l) => ({ ...l }));
  }

  async deliver(product: Omit<MailboxRow, "id">): Promise<void> {
    this.mailboxId += 1;
    this.mailboxRows.push({ ...product, id: this.mailboxId });
    // 收件人不读裁决：这里没有、也永远不会有已读字段
  }

  async mailbox(sinceTs?: number, limit = 50): Promise<MailboxRow[]> {
    let out = sinceTs == null ? [...this.mailboxRows] : this.mailboxRows.filter((m) => m.ts >= sinceTs);
    out.sort((a, b) => b.ts - a.ts);
    return out.slice(0, limit).map((m) => ({ ...m }));
  }

  async appendBenchRun(run: Omit<BenchRunRow, "id">): Promise<void> {
    this.benchRuns.push({ ...run, id: this.benchRuns.length + 1 });
  }

  async listBenchRuns(kind?: string): Promise<BenchRunRow[]> {
    return kind ? this.benchRuns.filter((b) => b.benchKind === kind).map((b) => ({ ...b })) : [...this.benchRuns];
  }

  async appendCanaryRun(run: Omit<CanaryRunRow, "id">): Promise<void> {
    this.canaryRuns.push({ ...run, id: this.canaryRuns.length + 1 });
  }

  async listCanaryRuns(): Promise<CanaryRunRow[]> {
    return [...this.canaryRuns];
  }

  async close(): Promise<void> {
    /* 无资源 */
  }
}
