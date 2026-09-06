/**
 * 服务层不变量（M0 主承诺的端到端版）：
 * 任意合法操作序列后，活状态 ≡ fold(全部事件)（逐位哈希）。
 * 本文件是 #1 危机登记折叠 / #2 运行性字段出仓 / #3 foldStored 补齐 / 出厂原点持久化的回归网。
 */
import { describe, expect, it } from "vitest";
import { PothosService } from "../../src/service.js";
import { MemoryStore } from "../../src/storage/memory.js";
import { ManualClock } from "../../src/clock.js";
import { fold } from "../../src/core/engine.js";
import { initialState, stateHash } from "../../src/core/state.js";
import { rawEvent, T0 } from "../helpers.js";

const HOUR = 3_600_000;

/** 复现服务的重放原点（出厂时刻持久化在 params 表）。 */
async function replayFromGenesis(svc: PothosService) {
  const all = await svc.store.loadEvents();
  const params = await svc.store.getParams();
  const origin = typeof params["state_origin_ts"] === "number" ? (params["state_origin_ts"] as number) : T0;
  return fold(all, svc.state.t, { from: initialState(origin, 0x50544853) });
}

async function expectParity(svc: PothosService, label: string): Promise<void> {
  const replay = await replayFromGenesis(svc);
  expect(stateHash(svc.state), label).toBe(stateHash(replay.state));
}

describe("服务层不变量：活状态 ≡ fold(events)", () => {
  it("混合操作序列后逐位一致（乱序 / 危机 / 間 / 参数变更 / 告警 / 快照）", async () => {
    const clock = new ManualClock(T0);
    const svc = new PothosService(new MemoryStore(), clock);
    await expectParity(svc, "出厂态");

    // 乱序到达：先 t+2h 再 t+1h（到达序 = 因果序，重放按 id 排列）
    await svc.ingest(rawEvent({ kind: "user_msg", ts: T0 + 2 * HOUR, source: "handle:she", payload: { valence: 0.6, contingency: 0.9 } }));
    await expectParity(svc, "乱序事件 1");
    await svc.ingest(rawEvent({ kind: "user_msg", ts: T0 + 1 * HOUR, source: "handle:she", payload: { valence: 0.4, contingency: 0.85 } }));
    await expectParity(svc, "乱序事件 2");

    // 危机文本：字面登记事件也必须折叠进动力学
    await svc.ingest(rawEvent({ kind: "user_msg", ts: T0 + 3 * HOUR, source: "handle:she", payload: { text: "我不想活了", valence: -1, intensity: 0.9, contingency: 0.8 } }));
    await expectParity(svc, "危机登记");
    const events = await svc.store.loadEvents();
    expect(events.some((e) => e.kind === "crisis")).toBe(true);

    // 間活动（时钟推进后，foldStored 负责补 tick）。用 optional 级（hunt）：
    // digest 是 required，会喂饱营养协变量，营养告警就不会触发了。
    clock.advance(2 * HOUR);
    await svc.recordMaActivity({ activity: "hunt", tokenCost: 120, quality: 0.8 });
    await expectParity(svc, "間活动");

    // 参数变更（告警发生前，避开冷却期锁）
    await svc.changeParam({ key: "M_min", newValue: 0.5, reason: "标定", expectedEffect: "地板生效", evaluationWindowMs: 0, rollbackCondition: "x" });
    await expectParity(svc, "参数变更");

    // tick 产生营养告警（合法路径：M_min 生效 + 零喂养 → 意图入库）。
    // 注：危机事件 ts=T0+3h 已把 state.t 推到 T0+3h，时钟需越过它才有 tick 步进。
    clock.advance(2 * HOUR);
    const { alerts } = await svc.runTick(clock.now());
    expect(alerts.length).toBeGreaterThan(0);
    await expectParity(svc, "告警 tick");

    // 再推进 31 分钟触发快照调度
    await svc.runTick(clock.now() + 31 * 60_000);
    await expectParity(svc, "快照调度后");
    expect(await svc.store.latestSnapshot()).not.toBeNull();
  });

  it("多快照 + 告警后重启：reconciled=true（回归：eventsSinceSnapshot / lastAlertIntentAt 不再污染状态哈希）", async () => {
    const clock = new ManualClock(T0);
    const store = new MemoryStore();
    const svc = new PothosService(store, clock);
    for (let i = 0; i < 5; i++) {
      await svc.ingest(rawEvent({ kind: "user_msg", ts: T0 + i * HOUR, source: "handle:she", payload: { valence: 0.6, contingency: 0.9 } }));
    }
    await svc.runTick(T0 + 6 * HOUR); // 快照 #1
    for (let i = 5; i < 7; i++) {
      await svc.ingest(rawEvent({ kind: "user_msg", ts: T0 + i * HOUR, source: "handle:she", payload: { valence: 0.6, contingency: 0.9 } }));
    }
    await svc.runTick(T0 + 8 * HOUR); // 快照 #2

    const svc2 = new PothosService(store, clock);
    const boot = await svc2.boot({ reconcile: true });
    expect(boot.mismatch).toBe(false);
    expect(boot.reconciled).toBe(true);
  });

  it("无快照重启：出厂原点持久化后，重放与活状态逐位一致", async () => {
    const clock = new ManualClock(T0);
    const svc = new PothosService(new MemoryStore(), clock);
    // 首事件在出厂 2h 后：活服务的 RNG 流从出厂时刻演化，重放必须同原点
    await svc.ingest(rawEvent({ kind: "user_msg", ts: T0 + 2 * HOUR, source: "handle:she", payload: { valence: 0.6, contingency: 0.9 } }));
    const liveHash = stateHash(svc.state);

    const svc2 = new PothosService(svc.store, clock);
    await svc2.boot();
    expect(stateHash(svc2.state)).toBe(liveHash);
  });
});
