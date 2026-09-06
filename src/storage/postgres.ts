/**
 * PostgreSQL 适配器（pg 直写 SQL，零 ORM——附录 A 裁决）。
 *
 * ◆ 诚实标注（附录 B-7）：本适配器代码与 migrations/001_init.sql 已实现，
 * 但截至 v0.1.0 未在真实 PostgreSQL 16 实例上验收（当前环境无 PG）。
 * 验收完成前，生产部署以 memory 适配器为唯一经过测试的路径——不许假装它是真件。
 */
import pg from "pg";
import { fileURLToPath } from "node:url";
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

const { Pool } = pg;

/** migrations/001_init.sql 的位置解析（fileURLToPath 处理 Windows 盘符与百分号编码）。 */
export function migrationsPath(moduleUrl: string): string {
  return fileURLToPath(new URL("../../migrations/001_init.sql", moduleUrl));
}

/** 快照完整性门：JSONB 读出的 full_state 必须是对象，否则状态流已损坏（fail fast）。 */
function asEngineState(v: unknown): EngineState {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error("corrupt snapshot: full_state 不是对象");
  }
  return v as EngineState;
}

export class PostgresStore implements EventStore {
  readonly kind = "postgres" as const;
  private pool: pg.Pool;
  /** 单写者锁的专用会话：advisory lock 是 session 级，必须钉在同一连接上 */
  private lockClient: pg.PoolClient | null = null;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  /**
   * 单写者锁（B1）：session 级 advisory lock，专用连接持有至 close()。
   * 进程崩溃连接断开 → 锁自动释放，无需人工清理。
   */
  async acquireSingletonLock(): Promise<boolean> {
    if (this.lockClient) return true;
    const client = await this.pool.connect();
    try {
      const res = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext('pothos-engine-singleton'), 0) AS locked",
      );
      if (res.rows[0]?.["locked"] === true) {
        this.lockClient = client;
        return true;
      }
    } catch (e) {
      client.release();
      throw e;
    }
    client.release();
    return false;
  }

  static fromEnv(): PostgresStore | null {
    const url = process.env["POTHOS_PG_URL"] ?? process.env["DATABASE_URL"];
    return url ? new PostgresStore(url) : null;
  }

  async migrate(): Promise<void> {
    // 生产部署请用 psql 跑 migrations/001_init.sql；此处为开发便利内联同版 schema
    const fs = await import("node:fs");
    const sqlPath = migrationsPath(import.meta.url);
    const sql = fs.readFileSync(sqlPath, "utf8");
    await this.pool.query(sql);
  }

  async appendEvent(ev: RawEvent): Promise<StoredEvent | null> {
    const res = await this.pool.query<{ id: string }>(
      `INSERT INTO events (ts, kind, payload, tags, source, idempotency_key)
       VALUES (to_timestamp($1/1000.0), $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [ev.ts, ev.kind, JSON.stringify(ev.payload), ev.tags ?? [], ev.source ?? null, ev.idempotencyKey ?? null],
    );
    if (!res.rows.length) return null;
    return { ...ev, id: Number(res.rows[0]!.id) };
  }

  async loadEvents(afterId?: number): Promise<StoredEvent[]> {
    // 规范序 = 到达序（id）：重放必须与实时摄入顺序一致，fold 才能逐位复现
    const res = afterId == null
      ? await this.pool.query(`SELECT id, ts, kind, payload, tags, source, idempotency_key FROM events ORDER BY id`)
      : await this.pool.query(
          `SELECT id, ts, kind, payload, tags, source, idempotency_key FROM events WHERE id > $1 ORDER BY id`,
          [afterId],
        );
    return res.rows.map((r) => ({
      id: Number(r["id"]),
      ts: new Date(r["ts"] as string).getTime(),
      kind: r["kind"] as RawEvent["kind"],
      payload: (typeof r["payload"] === "string" ? JSON.parse(r["payload"]) : r["payload"]) as Record<string, unknown>,
      tags: (r["tags"] ?? []) as string[],
      source: (r["source"] ?? undefined) as string | undefined,
      idempotencyKey: (r["idempotency_key"] ?? undefined) as string | undefined,
    }));
  }

  async saveSnapshot(state: EngineState, lastEventId: number, rendererV: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO state_snapshots (ts, fast, slow, body, "window", renderer_v, full_state, last_event_id)
       VALUES (to_timestamp($1/1000.0), $2, $3, $4, $5, $6, $7, $8)`,
      [
        state.t,
        JSON.stringify(state.fast),
        JSON.stringify({ ...state.slow, attachmentTarget: state.attachmentTarget }),
        JSON.stringify(state.body),
        JSON.stringify(state.window),
        rendererV,
        JSON.stringify(state),
        lastEventId,
      ],
    );
  }

  async latestSnapshot(): Promise<SnapshotRow | null> {
    const res = await this.pool.query(
      `SELECT id, ts, full_state, last_event_id, renderer_v FROM state_snapshots ORDER BY id DESC LIMIT 1`,
    );
    if (!res.rows.length) return null;
    const r = res.rows[0]!;
    const raw = (typeof r["full_state"] === "string" ? JSON.parse(r["full_state"]) : r["full_state"]) as Record<string, unknown>;
    // 旧版快照曾把运行性字段存进状态（会污染 stateHash 对账）——恢复时剥除
    delete raw["eventsSinceSnapshot"];
    delete raw["lastAlertIntentAt"];
    const state = asEngineState(raw);
    return {
      id: Number(r["id"]),
      ts: new Date(r["ts"] as string).getTime(),
      state,
      lastEventId: Number(r["last_event_id"]),
      rendererV: String(r["renderer_v"]),
    };
  }

  async getParams(): Promise<Record<string, unknown>> {
    const res = await this.pool.query(`SELECT key, value FROM params`);
    const out: Record<string, unknown> = {};
    for (const r of res.rows) {
      out[String(r["key"])] = typeof r["value"] === "string" ? JSON.parse(r["value"]) : r["value"];
    }
    return out;
  }

  async setParam(key: string, value: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO params (key, value, version) VALUES ($1, $2, 1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = params.version + 1`,
      [key, JSON.stringify(value)],
    );
  }

  async appendParamChange(c: Omit<ParamChangeRow, "id">): Promise<void> {
    await this.pool.query(
      `INSERT INTO param_changes (actor, ts, key, old_value, new_value, reason, expected_effect, evaluation_window_ms, rollback_condition)
       VALUES ($1, to_timestamp($2/1000.0), $3, $4, $5, $6, $7, $8, $9)`,
      [
        c.actor,
        c.ts,
        c.key,
        c.oldValue == null ? null : JSON.stringify(c.oldValue),
        c.newValue == null ? null : JSON.stringify(c.newValue),
        c.reason,
        c.expectedEffect,
        c.evaluationWindowMs,
        c.rollbackCondition,
      ],
    );
  }

  async listParamChanges(): Promise<ParamChangeRow[]> {
    const res = await this.pool.query(`SELECT * FROM param_changes ORDER BY id`);
    return res.rows.map((r) => ({
      id: Number(r["id"]),
      actor: String(r["actor"]),
      ts: new Date(r["ts"] as string).getTime(),
      key: String(r["key"]),
      oldValue: r["old_value"] == null ? null : typeof r["old_value"] === "string" ? JSON.parse(r["old_value"]) : r["old_value"],
      newValue: r["new_value"] == null ? null : typeof r["new_value"] === "string" ? JSON.parse(r["new_value"]) : r["new_value"],
      reason: String(r["reason"]),
      expectedEffect: String(r["expected_effect"]),
      evaluationWindowMs: Number(r["evaluation_window_ms"]),
      rollbackCondition: String(r["rollback_condition"]),
    }));
  }

  async insertAlert(level: AlertLevel, ts: number): Promise<AlertRow> {
    const res = await this.pool.query(
      `INSERT INTO alerts (ts, level) VALUES (to_timestamp($1/1000.0), $2) RETURNING id`,
      [ts, level],
    );
    return { id: Number(res.rows[0]!.id), ts, level, status: "OBSERVED", ackTs: null, actedTs: null };
  }

  private rowToAlert(r: Record<string, unknown>): AlertRow {
    return {
      id: Number(r["id"]),
      ts: new Date(r["ts"] as string).getTime(),
      level: r["level"] as AlertLevel,
      status: r["status"] as AlertStatus,
      ackTs: r["ack_ts"] ? new Date(r["ack_ts"] as string).getTime() : null,
      actedTs: r["acted_ts"] ? new Date(r["acted_ts"] as string).getTime() : null,
    };
  }

  async getAlert(id: number): Promise<AlertRow | null> {
    const res = await this.pool.query(`SELECT * FROM alerts WHERE id = $1`, [id]);
    return res.rows.length ? this.rowToAlert(res.rows[0]!) : null;
  }

  async listAlerts(opts?: { status?: AlertStatus; sinceTs?: number; limit?: number }): Promise<AlertRow[]> {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (opts?.status) {
      args.push(opts.status);
      clauses.push(`status = $${args.length}`);
    }
    if (opts?.sinceTs != null) {
      args.push(new Date(opts.sinceTs).toISOString());
      clauses.push(`ts >= $${args.length}`);
    }
    // 子句为硬编码字符串、值全参数化；插值只拼进查询文本（pg 动态查询标准写法）
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    const sql = `SELECT * FROM alerts ${where} ORDER BY ts DESC LIMIT ${args.length + 1}`;
    const res = await this.pool.query(sql, [...args, opts?.limit ?? 100]);
    return res.rows.map((r) => this.rowToAlert(r));
  }

  async transitionAlert(id: number, to: "ACKNOWLEDGED" | "ACTED", ts: number): Promise<AlertRow | null> {
    // 单语句条件更新 + RETURNING：状态机校验与迁移原子完成，消除读-改竞态
    // 列名来自封闭集合（非用户输入），值全部参数化
    const col = to === "ACKNOWLEDGED" ? "ack_ts" : "acted_ts";
    const prevStatus = to === "ACKNOWLEDGED" ? "OBSERVED" : "ACKNOWLEDGED";
    const sql = `UPDATE alerts SET status = $2, ${col} = to_timestamp($3/1000.0)
       WHERE id = $1 AND status = $4
       RETURNING id, ts, level, status, ack_ts, acted_ts`;
    const res = await this.pool.query(sql, [id, to, ts, prevStatus]);
    return res.rows.length ? this.rowToAlert(res.rows[0]!) : null;
  }

  async appendLedger(entry: Omit<MaLedgerRow, "id">): Promise<void> {
    await this.pool.query(
      `INSERT INTO ma_ledger (ts, activity, tier, token_cost, budget_date)
       VALUES (to_timestamp($1/1000.0), $2, $3, $4, $5)`,
      [entry.ts, entry.activity, entry.tier, entry.tokenCost, entry.budgetDate],
    );
  }

  async ledgerForDate(date: string): Promise<MaLedgerRow[]> {
    const res = await this.pool.query(`SELECT * FROM ma_ledger WHERE budget_date = $1 ORDER BY id`, [date]);
    return res.rows.map((r) => ({
      id: Number(r["id"]),
      ts: new Date(r["ts"] as string).getTime(),
      activity: r["activity"] as MaLedgerRow["activity"],
      tier: r["tier"] as MaLedgerRow["tier"],
      tokenCost: Number(r["token_cost"]),
      budgetDate: String(r["budget_date"]).slice(0, 10),
    }));
  }

  async ledgerSince(sinceTs: number): Promise<MaLedgerRow[]> {
    const res = await this.pool.query(
      `SELECT * FROM ma_ledger WHERE ts >= to_timestamp($1/1000.0) ORDER BY id`,
      [sinceTs],
    );
    return res.rows.map((r) => ({
      id: Number(r["id"]),
      ts: new Date(r["ts"] as string).getTime(),
      activity: r["activity"] as MaLedgerRow["activity"],
      tier: r["tier"] as MaLedgerRow["tier"],
      tokenCost: Number(r["token_cost"]),
      budgetDate: String(r["budget_date"]).slice(0, 10),
    }));
  }

  async deliver(product: Omit<MailboxRow, "id">): Promise<void> {
    await this.pool.query(
      `INSERT INTO mailbox (ts, activity, content, addressee) VALUES (to_timestamp($1/1000.0), $2, $3, $4)`,
      [product.ts, product.activity, product.content, product.addressee],
    );
  }

  async mailbox(sinceTs?: number, limit = 50): Promise<MailboxRow[]> {
    const res = sinceTs == null
      ? await this.pool.query(`SELECT * FROM mailbox ORDER BY id DESC LIMIT $1`, [limit])
      : await this.pool.query(
          `SELECT * FROM mailbox WHERE ts >= to_timestamp($1/1000.0) ORDER BY id DESC LIMIT $2`,
          [sinceTs, limit],
        );
    return res.rows.map((r) => ({
      id: Number(r["id"]),
      ts: new Date(r["ts"] as string).getTime(),
      activity: r["activity"] as MailboxRow["activity"],
      content: String(r["content"]),
      addressee: String(r["addressee"]),
    }));
  }

  async appendBenchRun(run: Omit<BenchRunRow, "id">): Promise<void> {
    await this.pool.query(
      `INSERT INTO bench_runs (ts, bench_kind, axis, result, model_version)
       VALUES (to_timestamp($1/1000.0), $2, $3, $4, $5)`,
      [run.ts, run.benchKind, run.axis, JSON.stringify(run.result), run.modelVersion],
    );
  }

  async listBenchRuns(kind?: string): Promise<BenchRunRow[]> {
    const res = kind
      ? await this.pool.query(`SELECT * FROM bench_runs WHERE bench_kind = $1 ORDER BY id`, [kind])
      : await this.pool.query(`SELECT * FROM bench_runs ORDER BY id`);
    return res.rows.map((r) => ({
      id: Number(r["id"]),
      ts: new Date(r["ts"] as string).getTime(),
      benchKind: String(r["bench_kind"]),
      axis: (r["axis"] ?? null) as string | null,
      result: (typeof r["result"] === "string" ? JSON.parse(r["result"]) : r["result"]) as Record<string, unknown>,
      modelVersion: String(r["model_version"]),
    }));
  }

  async appendCanaryRun(run: Omit<CanaryRunRow, "id">): Promise<void> {
    await this.pool.query(
      `INSERT INTO canary_runs (ts, fixture_set, deviation, action) VALUES (to_timestamp($1/1000.0), $2, $3, $4)`,
      [run.ts, run.fixtureSet, run.deviation, run.action],
    );
  }

  async listCanaryRuns(): Promise<CanaryRunRow[]> {
    const res = await this.pool.query(`SELECT * FROM canary_runs ORDER BY id`);
    return res.rows.map((r) => ({
      id: Number(r["id"]),
      ts: new Date(r["ts"] as string).getTime(),
      fixtureSet: String(r["fixture_set"]),
      deviation: Number(r["deviation"]),
      action: r["action"] as CanaryRunRow["action"],
    }));
  }

  async close(): Promise<void> {
    if (this.lockClient) {
      await this.lockClient
        .query("SELECT pg_advisory_unlock(hashtext('pothos-engine-singleton'), 0)")
        .catch(() => {}); // 进程退出路径：解锁失败不阻塞收尾
      this.lockClient.release();
      this.lockClient = null;
    }
    await this.pool.end();
  }
}
