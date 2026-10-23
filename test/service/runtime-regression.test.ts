import { describe, it, expect, vi } from "vitest";
import { PothosService } from "../../src/service.js";
import { MemoryStore } from "../../src/storage/memory.js";
import { ManualClock } from "../../src/clock.js";
import { stateHash, initialState } from "../../src/core/state.js";
import { fold } from "../../src/core/engine.js";
import { tickTo } from "../../src/core/tick.js";
import { startRuntime } from "../../src/runtime.js";
import { createApp } from "../../src/server/app.js";
import { handleMessage, opsFromService } from "../../src/mcp/server.js";
import type { RawEvent } from "../../src/core/events.js";
import { T0 } from "../helpers.js";
import { previewRecovery, applyRecovery } from "../../src/admin/recovery.js";

async function make(store = new MemoryStore(), t0 = T0) {
  const clock = new ManualClock(t0);
  const svc = new PothosService(store, clock);
  await svc.boot();
  return { svc, clock, store };
}
const change = (svc: PothosService, key: string, newValue: unknown) => svc.changeParam({
  key, newValue, reason: "test calibration", expectedEffect: "enable test", evaluationWindowMs: 0, rollbackCondition: "test end",
});

describe("runtime audit regression", () => {
  it("non-grid timer jitter, late events, snapshots and restart preserve replay", async () => {
    const { svc, clock, store } = await make(undefined, T0 + 37);
    for (let i = 0; i < 20; i++) {
      clock.advance(300123 + i);
      await svc.runTick();
      if (i % 3 === 0) await svc.ingest({ kind: "world", ts: clock.now() - 23456, payload: { intensity: 0.7 }, idempotencyKey: `w-${i}` });
      expect(await svc.reconcileNow()).toEqual({ mismatch: false });
    }
    const before = stateHash(svc.state);
    const restored = new PothosService(store, clock);
    expect(await restored.boot({ reconcile: true })).toEqual({ reconciled: true, mismatch: false });
    expect(stateHash(restored.state)).toBe(before);
    clock.advance(736541);
    const again = new PothosService(store, clock);
    expect((await again.boot({ reconcile: true })).mismatch).toBe(false);
    expect(again.state.t).toBe(clock.now());
    expect(await again.reconcileNow()).toEqual({ mismatch: false });
    expect((await store.loadEvents()).filter(e => e.kind === "tick").length).toBeGreaterThan(20);
  });

  it("legacy mismatched snapshots remain rejected, without overwriting them", async () => {
    const { svc, store, clock } = await make();
    tickTo(svc.state, T0 + 300123); tickTo(svc.state, T0 + 600246);
    await store.saveSnapshot(svc.state, 0, "legacy");
    clock.set(T0 + 600246);
    const fresh = new PothosService(store, clock);
    expect((await fresh.boot({ reconcile: true })).mismatch).toBe(true);
    expect((await store.latestSnapshot())?.rendererV).toBe("legacy");
    expect(await store.loadEvents()).toHaveLength(0);
  });

  it("write queue includes delayed inserts, tick, and snapshot", async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const arrived = new Promise<void>(r => { entered = r; });
    const enteredKeys: (string | undefined)[] = [];
    class SlowStore extends MemoryStore {
      override async appendEvent(ev: RawEvent) {
        enteredKeys.push(ev.idempotencyKey);
        const row = await super.appendEvent(ev);
        if (ev.idempotencyKey === "first") { entered(); await gate; }
        return row;
      }
    }
    const { svc, clock } = await make(new SlowStore());
    const first = svc.ingest({ kind: "world", ts: T0 + 600000, payload: { valence: 1 }, idempotencyKey: "first" });
    await arrived;
    const second = svc.ingest({ kind: "world", ts: T0 + 1200000, payload: { valence: -1 }, idempotencyKey: "second" });
    clock.set(T0 + 1800123);
    const timer = svc.runTick();
    await Promise.resolve();
    expect(enteredKeys).toEqual(["first"]);
    release(); await Promise.all([first, second, timer]);
    expect(await svc.reconcileNow()).toEqual({ mismatch: false });
    expect(svc.lastEventId).toBe(3);
  });

  it("legacy repair previews without writes, guards stale plans and preserves replay after repair", async () => {
    const { svc, store, clock } = await make();
    await svc.ingest({ kind: "world", ts: T0, payload: {}, idempotencyKey: "legacy" });
    tickTo(svc.state, T0 + 300123); tickTo(svc.state, T0 + 600246);
    await store.saveSnapshot(svc.state, svc.lastEventId, "legacy");
    const plan = await previewRecovery(store);
    expect(plan.snapshotHash).not.toBe(plan.replayHash);
    expect((await store.loadEvents()).length).toBe(1);
    await expect(applyRecovery(store, "stale-token", "audit repair")).rejects.toThrow("preview changed");
    await applyRecovery(store, plan.token, "audit repair");
    expect((await store.listBenchRuns("snapshot_recovery"))[0]?.result.snapshotHash).toBe(plan.snapshotHash);
    clock.set(T0 + 900369);
    const restored = new PothosService(store, clock);
    expect((await restored.boot({ reconcile: true })).mismatch).toBe(false);
    clock.advance(300123); await restored.runTick();
    expect(await restored.reconcileNow()).toEqual({ mismatch: false });
  });

  it("digest deposits using activity quality, while legacy events replay unchanged", async () => {
    const { svc } = await make();
    const legacy = { id: 1, kind: "ma_product" as const, ts: T0, payload: { activity: "digest", quality: 1, tokenCost: 200 } };
    expect(fold([legacy], T0, { from: initialState(T0, 0x50544853) }).state.slow.s_weave).toBe(0);
    await svc.recordMaActivity({ activity: "digest", tokenCost: 200, quality: 1 });
    expect(svc.state.slow.s_weave).toBeGreaterThan(0);
    const weave = svc.state.slow.s_weave;
    await svc.recordMaActivity({ activity: "digest", tokenCost: 200, quality: 0 });
    expect(svc.state.slow.s_weave).toBe(weave);
    expect(await svc.reconcileNow()).toEqual({ mismatch: false });
  });

  it("resident cannot record denied activities; concurrent costs cannot overrun budget", async () => {
    const { svc, store } = await make();
    const res = JSON.parse((await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "record_ma_activity", arguments: { activity: "create", tokenCost: 1, content: "blocked" },
    } }, { side: "resident", ops: opsFromService(svc) }))!);
    expect(res.result.isError).toBe(true);
    expect(await store.mailbox()).toHaveLength(0);
    await change(svc, "B_daily", 100);
    await change(svc, "maSalienceTheta", 0);
    const attempts = await Promise.allSettled([1, 2].map(i => svc.recordMaActivity({ activity: "create", tokenCost: 60, content: `${i}` })));
    expect(attempts.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await store.mailbox()).toHaveLength(1);
    expect((await svc.maView()).spentToday).toBe(60);
    // Essential metabolism and Decline remain available even with no optional budget.
    await svc.recordMaActivity({ activity: "digest", tokenCost: 200 });
    await svc.recordMaActivity({ activity: "decline", tokenCost: 0 });
  });

  it.each(["oops", -1, null, 1e100])("HTTP rejects invalid token costs before any writes: %s", async value => {
    const { svc, store } = await make();
    const app = createApp(svc, { token: "audit" });
    const response = await app.request("/ma/activity", { method: "POST", headers: { authorization: "Bearer audit", "content-type": "application/json" }, body: JSON.stringify({ activity: "digest", tokenCost: value }) });
    expect(response.status).toBe(400);
    expect(await store.loadEvents()).toHaveLength(0);
    expect((await svc.maView()).spentToday).toBe(0);
  });

  it("health check succeeds with deployment credentials and stays protected", async () => {
    const { svc } = await make(); const app = createApp(svc, { token: "audit" });
    expect((await app.request("/healthz")).status).toBe(401);
    expect((await app.request("/healthz", { headers: { authorization: "Bearer audit" } })).status).toBe(200);
  });

  it("shared runtime advances a quiet embedded engine and drains on stop", async () => {
    vi.useFakeTimers();
    try {
      const { svc, clock } = await make();
      const runtime = startRuntime(svc, { tickMs: 10, env: {} });
      clock.advance(86400000);
      await vi.advanceTimersByTimeAsync(10);
      expect(svc.state.t).toBe(clock.now());
      expect(await svc.reconcileNow()).toEqual({ mismatch: false });
      await runtime.stop();
      clock.advance(1000000);
      await vi.advanceTimersByTimeAsync(100);
      expect(svc.state.t).toBe(T0 + 86400000);
    } finally { vi.useRealTimers(); }
  });
});
