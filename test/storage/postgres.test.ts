/**
 * PostgreSQL 适配器验收（README 诚实两栏挂牌件的实测）。
 *
 * 运行前提：POTHOS_PG_URL 指向可写的真实 PG 实例（README 承诺 PG 16）。
 *   POTHOS_PG_URL=postgresql://postgres@127.0.0.1:54329/pothos_test npm test
 * 未设置时整组跳过——CI / 无 PG 环境的默认跑法不受影响。
 *
 * 覆盖：
 *  - migrate 幂等；全部 7+1 表建齐；
 *  - 事件契约：幂等键、append-only、到达序（id）返回、ms 级 ts 精度、payload/tags/source 往返；
 *  - 快照/参数/告警状态机/間台账/信箱/评测台与金丝雀各表往返；
 *  - M0 服务级：boot → 摄入（含危机登记）→ tick/快照 → 重启 → 全量对账逐位一致；
 *  - foldedAt：迟到事件经 cron tick 后重启，重放仍与活状态逐位一致。
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { PostgresStore, migrationsPath } from "../../src/storage/postgres.js";
import { PothosService } from "../../src/service.js";
import { MemoryStore } from "../../src/storage/memory.js";
import { ManualClock } from "../../src/clock.js";
import { initialState, stateHash } from "../../src/core/state.js";
import { existsSync } from "node:fs";

const url = process.env["POTHOS_PG_URL"];
const HOUR = 3_600_000;

const d = url ? describe : describe.skip;

d("PG 适配器 · 迁移与路径", () => {
  it("migrationsPath 解析到真实存在的 001_init.sql", () => {
    const p = migrationsPath(import.meta.url);
    expect(p.replace(/\\/g, "/")).toContain("migrations/001_init.sql");
    // 从 test/storage 出发 ../../ 应到仓库根——直接用适配器自身的 URL 验证
    const adapterUrl = new URL("../../src/storage/postgres.ts", import.meta.url).href;
    expect(existsSync(migrationsPath(adapterUrl))).toBe(true);
  });
});

d("PG 适配器 · 契约测试", () => {
  let store: PostgresStore;

  beforeAll(async () => {
    store = new PostgresStore(url!);
    // 干净的起点：先清表再跑迁移（migrate 幂等的隐含验收）
    const tables = ["canary_runs", "bench_runs", "mailbox", "ma_ledger", "alerts", "param_changes", "params", "state_snapshots", "events"];
    for (const t of tables) await store["pool"].query(`DROP TABLE IF EXISTS ${t} CASCADE`);
    await store.migrate();
    await store.migrate(); // 第二次不抛错 = CREATE TABLE IF NOT EXISTS 幂等
  }, 30_000);

  afterAll(async () => {
    await store.close();
  });

  it("事件契约：幂等键去重 + 无键不去重 + 到达序返回 + ms 精度", async () => {
    const a = await store.appendEvent({
      kind: "user_msg",
      ts: 1767400800123, // 非 0 毫秒尾数，专测 timestamptz 的 ms 往返
      payload: { valence: 0.6, text: "你好", foldedAt: 1767400800123 },
      tags: ["crisis", "x"],
      source: "handle:she",
      idempotencyKey: "pg-dup-1",
    });
    expect(a).not.toBeNull();
    const dup = await store.appendEvent({ kind: "user_msg", ts: 1767400800123, payload: {}, tags: [], idempotencyKey: "pg-dup-1" });
    expect(dup).toBeNull();

    const noKey1 = await store.appendEvent({ kind: "world", ts: 1767400800456, payload: {}, tags: [] });
    const noKey2 = await store.appendEvent({ kind: "world", ts: 1767400800789, payload: {}, tags: [] });
    expect(noKey1).not.toBeNull();
    expect(noKey2).not.toBeNull();

    // 乱序 ts 入库 → loadEvents 仍按 id（到达序）返回
    const late = await store.appendEvent({ kind: "user_msg", ts: 1767400800001, payload: {}, tags: [], idempotencyKey: "pg-late" });
    expect(late).not.toBeNull();

    const events = await store.loadEvents();
    expect(events.map((e) => e.id)).toEqual([...events.map((e) => e.id)].sort((x, y) => x - y));
    const first = events.find((e) => e.idempotencyKey === "pg-dup-1")!;
    expect(first.ts).toBe(1767400800123); // ms 精度往返无损
    expect(first.payload).toEqual({ valence: 0.6, text: "你好", foldedAt: 1767400800123 });
    expect(first.tags).toEqual(["crisis", "x"]);
    expect(first.source).toBe("handle:she");
    expect(events.filter((e) => e.kind === "world").length).toBe(2); // 无幂等键不去重

    const after = await store.loadEvents(late!.id - 1);
    expect(after.every((e) => e.id > late!.id - 1)).toBe(true); // afterId 尾部重放
    void late;
  });

  it("快照：full_state 经 jsonb 往返后 stateHash 逐位一致", async () => {
    const st = initialState(1767400800123, 0x50544853);
    st.fast.f_val = 0.30000000000000004; // jsonb numeric 精度压力
    st.rng.s = -12345; // 负 int
    st.slow.s_attach = 0.1;
    st.attachmentTarget = "abcdef0123456789";
    const h0 = stateHash(st);
    // lastEventId 用真实事件数（引擎只会保存自身产出、落在 genesis 路径上的快照）
    const evs = await store.loadEvents();
    await store.saveSnapshot(st, evs.length, "r1-test");
    const snap = await store.latestSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.lastEventId).toBe(evs.length);
    expect(snap!.rendererV).toBe("r1-test");
    expect(stateHash(snap!.state)).toBe(h0);
    expect((snap!.state as unknown as Record<string, unknown>)["eventsSinceSnapshot"]).toBeUndefined(); // 遗留字段剥离
    // 本测试的状态是构造出来的（非 genesis 路径），用完即弃，免得污染后续服务级验收
    await store["pool"].query("DELETE FROM state_snapshots");
  });

  it("参数与参数变更：set/get 往返 + version 自增 + param_changes 落库", async () => {
    await store.setParam("state_origin_ts", 1767400800000);
    await store.setParam("render_salt", { date: "2026-01-03", value: "ab12" });
    await store.setParam("render_salt", { date: "2026-01-04", value: "cd34" });
    const params = await store.getParams();
    expect(params["state_origin_ts"]).toBe(1767400800000);
    expect(params["render_salt"]).toEqual({ date: "2026-01-04", value: "cd34" });

    await store.appendParamChange({
      actor: "observer", ts: 1767400800000, key: "noiseFast",
      oldValue: 0.004, newValue: 0.01, reason: "标定", expectedEffect: "β 上移",
      evaluationWindowMs: 86400000, rollbackCondition: "出带回滚",
    });
    const changes = await store.listParamChanges();
    expect(changes.length).toBe(1);
    expect(changes[0]!.newValue).toBe(0.01);
    expect(changes[0]!.expectedEffect).toContain("β");
  });

  it("告警状态机：OBSERVED→ACKNOWLEDGED→ACTED，越级与终态拒绝", async () => {
    const a = await store.insertAlert("watch", 1767400800000);
    expect(a.status).toBe("OBSERVED");
    expect(await store.transitionAlert(a.id, "ACTED", 1767400800001)).toBeNull(); // 越级
    const ack = await store.transitionAlert(a.id, "ACKNOWLEDGED", 1767400800002);
    expect(ack!.status).toBe("ACKNOWLEDGED");
    expect(await store.transitionAlert(a.id, "ACKNOWLEDGED", 1767400800003)).toBeNull(); // 终态锁
    const acted = await store.transitionAlert(a.id, "ACTED", 1767400800004);
    expect(acted!.actedTs).toBe(1767400800004);

    const b = await store.insertAlert("urgent", 1767400801000);
    const obs = await store.listAlerts({ status: "OBSERVED" });
    expect(obs.some((x) => x.id === b.id)).toBe(true);
    const since = await store.listAlerts({ sinceTs: 1767400800500 });
    expect(since.map((x) => x.id)).toContain(b.id);
    expect(since.map((x) => x.id)).not.toContain(a.id);
  });

  it("間台账 / 信箱 / 评测台 / 金丝雀：append + 查询往返", async () => {
    await store.appendLedger({ ts: 1767400800000, activity: "digest", tier: "required", tokenCost: 120, budgetDate: "2026-01-03" });
    await store.appendLedger({ ts: 1767400900000, activity: "hunt", tier: "optional", tokenCost: 80, budgetDate: "2026-01-03" });
    const ledger = await store.ledgerForDate("2026-01-03");
    expect(ledger.length).toBe(2);
    expect(ledger[0]!.activity).toBe("digest");
    const since = await store.ledgerSince(1767400850000);
    expect(since.length).toBe(1);

    await store.deliver({ ts: 1767400800000, activity: "create", content: "给她的信", addressee: "她" });
    const box = await store.mailbox();
    expect(box.length).toBe(1);
    expect(box[0]!.content).toBe("给她的信");
    expect("read" in box[0]!).toBe(false); // 收件人不读裁决：无已读字段

    await store.appendBenchRun({ ts: 1767400800000, benchKind: "full_bench", axis: null, result: { allGreen: true }, modelVersion: "pothos-v0.1.1" });
    expect((await store.listBenchRuns("full_bench")).length).toBe(1);
    expect((await store.listBenchRuns("three_metrics")).length).toBe(0);

    await store.appendCanaryRun({ ts: 1767400800000, fixtureSet: "canary-core-4", deviation: 0.01, action: "ok" });
    expect((await store.listCanaryRuns()).length).toBe(1);
  });

  it("M0 服务级：摄入（含危机登记）→ 快照 → 重启 → 全量对账逐位一致", async () => {
    const clock = new ManualClock(1767400800000);
    const svc = new PothosService(store, clock);
    await svc.boot();
    for (let i = 0; i < 5; i++) {
      await svc.ingest({ kind: "user_msg", ts: 1767400800000 + i * HOUR, source: "handle:she", payload: { valence: 0.6, contingency: 0.9 }, idempotencyKey: `m0-${i}` });
    }
    // 危机：登记事件入流
    await svc.ingest({ kind: "user_msg", ts: 1767400800000 + 5 * HOUR, source: "handle:she", payload: { text: "我不想活了", valence: -1, intensity: 0.9, contingency: 0.8 }, idempotencyKey: "m0-crisis" });
    const events = await store.loadEvents();
    expect(events.some((e) => e.kind === "crisis")).toBe(true);

    await svc.runTick(1767400800000 + 8 * HOUR); // 快照 #1
    await svc.ingest({ kind: "user_msg", ts: 1767400800000 + 8 * HOUR, source: "handle:she", payload: { valence: 0.7, contingency: 0.9 }, idempotencyKey: "m0-post" });
    await svc.runTick(1767400800000 + 10 * HOUR); // 快照 #2

    const liveHash = stateHash(svc.state);
    const svc2 = new PothosService(store, clock);
    const boot = await svc2.boot({ reconcile: true });
    expect(boot.mismatch).toBe(false);
    expect(boot.reconciled).toBe(true);
    expect(stateHash(svc2.state)).toBe(liveHash);
  });

  it("foldedAt：cron tick 越过迟到事件后重启，重放仍逐位一致", async () => {
    const clock = new ManualClock(1767400800000);
    const svc = new PothosService(store, clock);
    await svc.boot();
    await svc.runTick(1767400800000 + 14 * HOUR); // cron 先把状态推进到 +14h
    // 迟到事件：ts +13h，在 +14h 位置折叠（foldedAt 记入 payload）
    await svc.ingest({ kind: "user_msg", ts: 1767400800000 + 13 * HOUR, source: "handle:she", payload: { valence: 0.5, contingency: 0.85 }, idempotencyKey: "late-1" });
    const liveHash = stateHash(svc.state);
    const svc2 = new PothosService(store, clock);
    const boot = await svc2.boot({ reconcile: true });
    expect(boot.mismatch).toBe(false);
    expect(stateHash(svc2.state)).toBe(liveHash);
  });

  it("HTTP 冒烟：createApp + PG 存储，事件入库并渲染", async () => {
    const { createApp } = await import("../../src/server/app.js");
    const clock = new ManualClock(1767400800000);
    const svc = new PothosService(store, clock);
    await svc.boot();
    const app = createApp(svc);
    const res = await app.request("/events", {
      method: "POST",
      body: JSON.stringify({ kind: "user_msg", ts: 1767400800000, source: "handle:she", payload: { valence: 0.8, contingency: 0.9, text: "在吗" }, idempotencyKey: "http-pg-1" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(201);
    const render = await (await app.request("/render/interoception")).json();
    expect((render as { text: string }).text.length).toBeGreaterThan(0);
  });

  it("单写者锁：同库第二实例拿不到，持锁方 close 后可重拿（B1）", async () => {
    const holder = new PostgresStore(url!);
    const contender = new PostgresStore(url!);
    try {
      expect(await holder.acquireSingletonLock()).toBe(true);
      expect(await holder.acquireSingletonLock()).toBe(true); // 重入幂等
      expect(await contender.acquireSingletonLock()).toBe(false); // 竞争失败
      await holder.close(); // 解锁 + 释放
      expect(await contender.acquireSingletonLock()).toBe(true); // 锁随会话释放
    } finally {
      await contender.close().catch(() => {});
    }
  });
});

d("PG 适配器 · 环境守护", () => {
  it("fromEnv：未设环境变量返回 null，不猜测", () => {
    const saved = process.env["POTHOS_PG_URL"];
    delete process.env["POTHOS_PG_URL"];
    delete process.env["DATABASE_URL"];
    expect(PostgresStore.fromEnv()).toBeNull();
    process.env["DATABASE_URL"] = "postgresql://u@h/db";
    expect(PostgresStore.fromEnv()).not.toBeNull();
    delete process.env["DATABASE_URL"];
    if (saved != null) process.env["POTHOS_PG_URL"] = saved;
  });

  it("单写者锁：memory 恒真（单进程内嵌无竞争）", async () => {
    const mem = new MemoryStore();
    expect(await mem.acquireSingletonLock()).toBe(true);
    expect(await mem.acquireSingletonLock()).toBe(true);
  });

  it("memory 与 PG 的契约同构（幂等键语义抽查）", async () => {
    const mem = new MemoryStore();
    const ev = { kind: "user_msg" as const, ts: 1767400800000, payload: {}, tags: [], idempotencyKey: "parity-1" };
    expect(await mem.appendEvent(ev)).not.toBeNull();
    expect(await mem.appendEvent(ev)).toBeNull(); // 与 PG 组同语义：重复键静默幂等
  });
});
