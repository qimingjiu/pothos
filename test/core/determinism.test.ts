/**
 * M0 验收一：重放合成事件流 → 状态序列可复现。
 * 确定性承诺：同一事件流 + 同一起点 → 逐位相同的状态哈希。
 */
import { describe, expect, it } from "vitest";
import { fold, fullReplay } from "../../src/core/engine.js";
import { stateHash, initialState } from "../../src/core/state.js";
import { DEFAULT_PARAMS } from "../../src/core/params.js";
import { userMsg, worldEvent, crisisEvent, maProduct, sineEvents } from "../../src/bench/fixtures.js";
import type { StoredEvent } from "../../src/core/events.js";

const T0 = 1767400800000;
const HOUR = 3_600_000;

function asStored(raws: ReturnType<typeof userMsg>[]): StoredEvent[] {
  return raws.map((r, i) => ({ ...r, id: i + 1 }));
}

describe("M0 · 重放可复现", () => {
  it("同一事件流两次 fold → 状态哈希逐位一致", () => {
    const events = asStored([
      ...sineEvents({ t0: T0, n: 60, periodMs: 6 * HOUR, amplitude: 0.5 }),
      maProduct(T0 + 61 * 300_000, { activity: "digest", tier: "required", tokenCost: 200, quality: 0.8 }),
      worldEvent(T0 + 62 * 300_000, { intensity: 0.6, topic: "curiosity" }),
    ]);
    const a = fold(events, T0 + 64 * 300_000, { rngSeed: 42 });
    const b = fold(events, T0 + 64 * 300_000, { rngSeed: 42 });
    expect(stateHash(a.state)).toBe(stateHash(b.state));
    expect(a.alertIntents.length).toBe(b.alertIntents.length);
  });

  it("不同种子 → 噪声不同（噪声是器官，不是死值）", () => {
    const events = asStored(sineEvents({ t0: T0, n: 40, periodMs: 6 * HOUR, amplitude: 0.4 }));
    const a = fold(events, T0 + 42 * 300_000, { rngSeed: 1 });
    const b = fold(events, T0 + 42 * 300_000, { rngSeed: 2 });
    expect(stateHash(a.state)).not.toBe(stateHash(b.state));
  });

  it("乱序输入按到达序（id）折叠 → 与有序输入一致", () => {
    const events = asStored([
      userMsg(T0 + 2 * HOUR, { valence: 0.6, contingency: 0.9 }),
      userMsg(T0 + 1 * HOUR, { valence: -0.4, contingency: 0.7 }),
      worldEvent(T0 + 3 * HOUR, { intensity: 0.5 }),
    ]);
    const shuffled = [...events].sort(() => Math.random() - 0.5);
    const a = fold(events, T0 + 5 * HOUR);
    const b = fold(shuffled, T0 + 5 * HOUR);
    expect(stateHash(a.state)).toBe(stateHash(b.state));
  });

  it("迟到事件（ts < 状态时间）不倒流时间线", () => {
    const events = asStored([
      userMsg(T0 + 3 * HOUR, { valence: 0.8, contingency: 0.9 }),
      userMsg(T0 + 1 * HOUR, { valence: 0.8, contingency: 0.9 }),
    ]);
    const run = fold(events, T0 + 4 * HOUR);
    expect(run.state.t).toBe(T0 + 4 * HOUR);
    // 迟到事件仍被折叠（用户输入不丢弃）
    expect(run.state.fast.f_load).toBeGreaterThan(0);
  });

  it("空事件流 → 出厂态；时间从给定锚点起步", () => {
    const run = fullReplay([], T0 + HOUR);
    expect(run.state.t).toBe(T0 + HOUR);
    expect(run.state.window.phase).toBe("WINDOW_OPEN");
    expect(run.state.slow).toEqual({ s_attach: 0, s_base: 0.5, s_weave: 0 });
  });

  it("出厂态：印刻窗口开放（出厂配置 = 印刻窗口的开放态，不是对象）", () => {
    const st = initialState(T0, 1);
    expect(st.window.phase).toBe("WINDOW_OPEN");
    expect(st.attachmentTarget).toBeNull();
    expect(DEFAULT_PARAMS.postWindowGain).toBeLessThan(0.2);
  });
});
