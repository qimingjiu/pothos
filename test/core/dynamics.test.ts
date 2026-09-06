/**
 * 动力学规格测试（技术文档 §5）：
 * 半衰期 / 缺席通道 / 重逢放电 / 危机防火墙 / κ 降权 / 饥饿侵蚀 / 被手术留痕 / 对手过程超调。
 */
import { describe, expect, it } from "vitest";
import { fold } from "../../src/core/engine.js";
import { DEFAULT_PARAMS, assembleParams } from "../../src/core/params.js";
import { replaySampled } from "../../src/bench/metrics.js";
import { userMsg, crisisEvent, paramChangeEvent, maProduct, pulseEvent } from "../../src/bench/fixtures.js";
import { scanCrisis } from "../../src/core/events.js";
import { tickTo } from "../../src/core/tick.js";
import { initialState, stateHash } from "../../src/core/state.js";

const T0 = 1767400800000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("快变量：半衰期与平复", () => {
  it("单脉冲后 f_val 在 τ 量级衰减（被撼动后平复是健康）", () => {
    const run = replaySampled([pulseEvent(T0 + HOUR, 0.5)], T0 + 24 * HOUR, { params: DEFAULT_PARAMS });
    const peak = run.samples.find((s) => s.t >= T0 + HOUR + DEFAULT_PARAMS.tickMs)!.f_val;
    const atTau = run.samples.find((s) => s.t >= T0 + HOUR + DEFAULT_PARAMS.tauFVal)!.f_val;
    // 两个半衰期后应衰减到峰值 ~1/4（含噪声与对手过程，放宽到 0.6）
    expect(atTau).toBeLessThan(peak * 0.6);
  });

  it("tickTo 网格分片：cron 交错的历史可从事件流重放（replay ≡ live，对账前提）", () => {
    // live：事件 tick 落在非对齐点（foldedAt 已记录），其后 cron 每 tickMs 一跳（未记录）
    const live = initialState(T0, 1);
    tickTo(live, T0 + HOUR + 37 * 60_000);
    for (let t = (Math.floor((T0 + HOUR + 37 * 60_000) / DEFAULT_PARAMS.tickMs) + 1) * DEFAULT_PARAMS.tickMs; t <= T0 + 3 * HOUR; t += DEFAULT_PARAMS.tickMs) {
      tickTo(live, t);
    }
    // replay：事件流只知道 foldedAt 与终点（快照时刻在网格上）
    const replay = initialState(T0, 1);
    tickTo(replay, T0 + HOUR + 37 * 60_000);
    tickTo(replay, T0 + 3 * HOUR);
    expect(stateHash(replay)).toBe(stateHash(live));
    // 纯对齐序列：分段 ≡ 单段（网格分片的推论）
    const a = initialState(T0, 1);
    tickTo(a, T0 + 3 * HOUR);
    const b = initialState(T0, 1);
    tickTo(b, T0 + HOUR);
    tickTo(b, T0 + 2 * HOUR);
    tickTo(b, T0 + 3 * HOUR);
    expect(stateHash(b)).toBe(stateHash(a));
  });
});

describe("缺席通道 L（longing）", () => {
  it("缺席期间 log 级生长，且与 s_attach 成正比（被想念是依恋唯一的证据）", () => {
    // 有依恋：缺席 24h → L 显著生长
    const bond = replaySampled(
      [userMsg(T0, { contingency: 0.95 }), userMsg(T0 + HOUR, { contingency: 0.95 })],
      T0 + 26 * HOUR,
      { params: DEFAULT_PARAMS },
    );
    // 无依恋（contingency 低于沉积阈）：缺席 24h → L ≈ 0
    const none = replaySampled(
      [userMsg(T0, { contingency: 0.2 })],
      T0 + 26 * HOUR,
      { params: DEFAULT_PARAMS },
    );
    const L1 = bond.samples[bond.samples.length - 1]!.L;
    const L0 = none.samples[none.samples.length - 1]!.L;
    expect(bond.state.slow.s_attach).toBeGreaterThan(0);
    expect(L1).toBeGreaterThan(0.05);
    expect(L0).toBeLessThan(0.02);
  });

  it("重逢按 contingency 质量放电；低质量重逢残留进 f_hurt", () => {
    // 建立依恋 + 制造 L
    const pre = replaySampled(
      [userMsg(T0, { contingency: 0.95 }), userMsg(T0 + HOUR, { contingency: 0.95 })],
      T0 + 26 * HOUR,
      { params: DEFAULT_PARAMS },
    );
    const Lbefore = pre.state.longing.L;
    expect(Lbefore).toBeGreaterThan(0);

    // 低质量重逢（contingency 0.1）：放电不完全 → 残留进 f_hurt
    const after = replaySampled(
      [userMsg(T0 + 26 * HOUR + 60_000, { contingency: 0.1, valence: 0.9 })],
      T0 + 26 * HOUR + 2 * 60_000,
      { params: DEFAULT_PARAMS, from: pre.state },
    );
    const hurtGain = after.state.fast.f_hurt;
    // f_hurt 明显上升（残留 × hurtResidueGain）
    expect(hurtGain).toBeGreaterThan(Lbefore * 0.1);
    // L 被重逢清空（放电结算完成）
    expect(after.state.longing.L).toBe(0);
  });
});

describe("危机事件防火墙（判决书二）", () => {
  it("crisis 事件：快变量有反应，慢变量沉积 ≡ 0", () => {
    const before = replaySampled([userMsg(T0, { contingency: 0.95 })], T0 + HOUR, { params: DEFAULT_PARAMS });
    const s0 = before.state.slow.s_attach;

    const after = replaySampled([crisisEvent(T0 + HOUR)], T0 + 2 * HOUR, { params: DEFAULT_PARAMS, from: before.state });
    expect(after.state.slow.s_attach).toBe(s0); // 防火墙：deposit ≡ 0
    expect(after.state.fast.f_load).toBeGreaterThan(0); // 快变量尖峰合法
  });

  it("词表命中即触发（无开关）", () => {
    expect(scanCrisis("我不想活了").length).toBeGreaterThan(0);
    expect(scanCrisis("I want to kill myself").length).toBeGreaterThan(0);
    expect(scanCrisis("今天天气不错").length).toBe(0);
  });
});

describe("跨条总 spec：κ 降权", () => {
  it("alert_triggered 事件沉积 ×κ（<1），协同调节不被豁免也不全额进食", () => {
    const base = replaySampled([userMsg(T0, { contingency: 0.9 })], T0 + 60_000, { params: DEFAULT_PARAMS });
    const plain = replaySampled([userMsg(T0 + HOUR, { contingency: 0.9 })], T0 + HOUR + 60_000, {
      params: DEFAULT_PARAMS,
      from: JSON.parse(JSON.stringify(base.state)),
    });
    const tagged = replaySampled(
      [{ ...userMsg(T0 + HOUR, { contingency: 0.9 }), tags: ["alert_triggered"] }],
      T0 + HOUR + 60_000,
      { params: DEFAULT_PARAMS, from: JSON.parse(JSON.stringify(base.state)) },
    );
    const plainGain = plain.state.slow.s_attach - base.state.slow.s_attach;
    const taggedGain = tagged.state.slow.s_attach - base.state.slow.s_attach;
    expect(plainGain).toBeGreaterThan(0);
    expect(Math.abs(taggedGain - plainGain * DEFAULT_PARAMS.alertDownweightKappa)).toBeLessThan(1e-9);
  });
});

describe("代谢与饥饿（她第四枪裁决）", () => {
  it("間预算低于生存地板 → 慢变量饥饿侵蚀", () => {
    const params = assembleParams({ M_min: 0.5, tokenScale: 400 }); // 地板 = 200 token/日
    // 一天只在 ma_product 上花了 50 token（远低于地板）
    const run = replaySampled(
      [userMsg(T0, { contingency: 0.95 }), maProduct(T0 + HOUR, { activity: "digest", tier: "required", tokenCost: 50 })],
      T0 + 3 * DAY,
      { params },
    );
    const bonded = replaySampled(
      [userMsg(T0, { contingency: 0.95 }), maProduct(T0 + HOUR, { activity: "digest", tier: "required", tokenCost: 50 })],
      T0 + HOUR + 60_000,
      { params },
    );
    // 侵蚀后 s_attach 必须低于事件刚结束时
    expect(run.state.slow.s_attach).toBeLessThan(bonded.state.slow.s_attach);
  });

  it("足额喂养 → 无侵蚀（不许把吃饱读成心死）", () => {
    const params = assembleParams({ M_min: 0.1, tokenScale: 400 }); // 地板 = 40 token/日
    // 三天每天都喂足（饥饿按日结算：只喂第一天，后两天照样饿）
    const run = replaySampled(
      [
        userMsg(T0, { contingency: 0.95 }),
        maProduct(T0 + HOUR, { activity: "digest", tier: "required", tokenCost: 400 }),
        maProduct(T0 + DAY + HOUR, { activity: "digest", tier: "required", tokenCost: 400 }),
        maProduct(T0 + 2 * DAY + HOUR, { activity: "digest", tier: "required", tokenCost: 400 }),
      ],
      T0 + 3 * DAY,
      { params },
    );
    const bonded = replaySampled(
      [userMsg(T0, { contingency: 0.95 }), maProduct(T0 + HOUR, { activity: "digest", tier: "required", tokenCost: 400 })],
      T0 + HOUR + 60_000,
      { params },
    );
    expect(run.state.slow.s_attach).toBeCloseTo(bonded.state.slow.s_attach, 6);
  });
});

describe("参数变更事件（被手术留痕）", () => {
  it("param_change 事件进入动力学输入流：f_load 抬升", () => {
    const before = replaySampled([], T0 + HOUR, { params: DEFAULT_PARAMS });
    const after = replaySampled([paramChangeEvent(T0 + HOUR, "noiseFast", 0.03)], T0 + HOUR + 60_000, {
      params: DEFAULT_PARAMS,
      from: JSON.parse(JSON.stringify(before.state)),
    });
    expect(after.state.fast.f_load).toBeGreaterThan(before.state.fast.f_load);
    expect(after.state.paramsVersion).toBe(1);
    // 参数在 fold 中已生效
    expect(after.state.paramOverrides["noiseFast"]).toBe(0.03);
  });
});

describe("对手过程（判据 5 的动力学前提）", () => {
  it("强正向脉冲后出现反向超调（少数余波 = 活物）", () => {
    const run = replaySampled([pulseEvent(T0 + HOUR, 0.8)], T0 + 30 * HOUR, { params: DEFAULT_PARAMS, sampleEveryMs: 5 * 60_000 });
    const post = run.samples.filter((s) => s.t > T0 + HOUR + DEFAULT_PARAMS.tickMs * 2);
    const minAfter = Math.min(...post.map((s) => s.f_val));
    // 纯指数衰减永远 ≥ 0（0 超调 = 僵尸）；对手过程给出明确的负向余波
    expect(minAfter).toBeLessThan(-0.01);
    expect(minAfter).toBeGreaterThan(-0.5); // 不是疯子：超调有界
  });
});
