/**
 * M0 验收二：崩溃恢复后对账一致。
 * 快照 + 尾部事件重放 ≡ 全量重放（逐位哈希）。
 */
import { describe, expect, it } from "vitest";
import { fold } from "../../src/core/engine.js";
import { stateHash } from "../../src/core/state.js";
import { MemoryStore } from "../../src/storage/memory.js";
import { PothosService } from "../../src/service.js";
import { ManualClock } from "../../src/clock.js";
import { userMsg } from "../../src/bench/fixtures.js";
import { T0, rawEvent } from "../helpers.js";

const HOUR = 3_600_000;

describe("M0 · 崩溃恢复对账", () => {
  it("内存存储幂等键：重复投递静默幂等（家族判例）", async () => {
    const store = new MemoryStore();
    const ev = userMsg(T0, { contingency: 0.9 });
    const a = await store.appendEvent({ ...ev, idempotencyKey: "same-key" });
    const b = await store.appendEvent({ ...ev, idempotencyKey: "same-key" });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    expect((await store.loadEvents()).length).toBe(1);
  });

  it("快照路径 vs 全量重放：状态哈希一致", async () => {
    const clock = new ManualClock(T0);
    const store = new MemoryStore();
    const svc = new PothosService(store, clock);

    // 第一段事件
    for (let i = 0; i < 10; i++) {
      await svc.ingest(rawEvent({ kind: "user_msg", ts: T0 + i * HOUR, source: "handle:she", payload: { valence: 0.6, contingency: 0.9 } }));
    }
    // 快照（模拟崩溃前落盘）
    await store.saveSnapshot(svc.state, svc.lastEventId, "r1-test");
    const snapHashBefore = stateHash(svc.state);

    // 崩溃后重启：从快照 + 尾部恢复
    const svc2 = new PothosService(store, clock);
    await svc2.boot();
    expect(stateHash(svc2.state)).toBe(snapHashBefore);

    // 第二段事件
    for (let i = 10; i < 20; i++) {
      await svc2.ingest(rawEvent({ kind: "user_msg", ts: T0 + i * HOUR, source: "handle:she", payload: { valence: 0.5, contingency: 0.85 } }));
    }
    const recoveredHash = stateHash(svc2.state);

    // 全量重放（从零折叠全部事件）必须与快照路径一致
    const all = await store.loadEvents();
    const full = fold(all, T0 + 20 * HOUR);
    // svc2 状态未 tick 到 20h——对账比较前推进到同一时刻
    const { tickTo } = await import("../../src/core/tick.js");
    tickTo(svc2.state, T0 + 20 * HOUR);
    expect(stateHash(svc2.state)).toBe(stateHash(full.state));
    void recoveredHash;
  });

  it("boot 对账：mismatch=false 且 reconciled 非 null", async () => {
    const clock = new ManualClock(T0);
    const store = new MemoryStore();
    const svc = new PothosService(store, clock);
    await svc.ingest(rawEvent({ kind: "user_msg", ts: T0, source: "handle:she", payload: { valence: 0.5, contingency: 0.8 } }));
    await store.saveSnapshot(svc.state, svc.lastEventId, "r1-test");
    const svc2 = new PothosService(store, clock);
    const boot = await svc2.boot({ reconcile: true });
    expect(boot.mismatch).toBe(false);
    expect(boot.reconciled).toBe(true);
  });
});
