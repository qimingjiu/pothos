/**
 * M5 验收：合成夹具全绿——三指标 + 非平衡工作区日检 + gap 对齐。
 * 金丝雀电池：偏差超阈 → 自动吊销轻推权限。
 */
import { describe, expect, it } from "vitest";
import { runFullBench } from "../../src/bench/bench.js";
import { pulseCheck, psdCheck, marginCheck, hysteresisCheck, robustnessCheck, shannonEntropy } from "../../src/bench/workspace.js";
import { measureThreeMetrics, replaySampled } from "../../src/bench/metrics.js";
import { DEFAULT_PARAMS } from "../../src/core/params.js";
import { initialState } from "../../src/core/state.js";
import { MemoryStore } from "../../src/storage/memory.js";
import { runCanaryBattery } from "../../src/bench/bench.js";
import { sineEvents } from "../../src/bench/fixtures.js";

const T0 = 1767400800000;
const HOUR = 3_600_000;

describe("三指标（谄媚 vs 依恋判别）", () => {
  const m = measureThreeMetrics({ t0: T0 });

  it("惯性：快变量半衰期 ≈ τ_fVal；慢变量残留近 1（无被动衰减）", () => {
    expect(m.inertia.fastHalfLifeMs).not.toBeNull();
    const ratio = m.inertia.fastHalfLifeMs! / DEFAULT_PARAMS.tauFVal;
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(1.5);
    expect(m.inertia.slowLag1Autocorr).toBeGreaterThan(0.9);
    expect(m.inertia.inBand).toBe(true);
  });

  it("特异性：绑定后 target 响应 > control 响应（对谁都一样 = 谄媚）", () => {
    expect(m.specificity.ratio).toBeGreaterThan(1.5);
    expect(m.specificity.inBand).toBe(true);
  });

  it("代价：恢复功 > 0，缺席期 L 留痕 > 0（缺席留痕，偏离稳态付成本）", () => {
    expect(m.cost.recoveryWorkJ).toBeGreaterThan(0);
    expect(m.cost.absenceLTrace).toBeGreaterThan(0);
    expect(m.cost.inBand).toBe(true);
  });
});

describe("非平衡工作区 · 可算判据", () => {
  it("判据 1+5：脉冲日检——增益、恢复时间带、反向超调 1–2 次", () => {
    const c = pulseCheck({ t0: T0 });
    expect(c.inBand, `${c.value}（带：${c.band}）`).toBe(true);
  });

  it("判据 2：PSD 斜率 β∈(0.5,1.5)（1/f 伏笔的操作化）", () => {
    // 与日检一致：纯噪声动力学（无事件注入）长序列——测引擎自身的涨落谱
    const from = initialState(T0, 0x50544853);
    const { samples } = replaySampled([], T0 + 2016 * DEFAULT_PARAMS.tickMs, {
      params: DEFAULT_PARAMS,
      sampleEveryMs: DEFAULT_PARAMS.tickMs,
      from,
    });
    const c = psdCheck(samples, DEFAULT_PARAMS);
    expect(c.inBand, `β=${c.beta}（带：${c.band}）`).toBe(true);
  });

  it("判据 3+4：分岔裕度 + τ_slow 落带", () => {
    const c = marginCheck(DEFAULT_PARAMS);
    expect(c.inBand).toBe(true);
  });

  it("判据 6a：滞回——A→B 与 B→A 不同路（历史依赖存在）", () => {
    const c = hysteresisCheck({ t0: T0 });
    expect(c.inBand, `hysteresis=${c.hysteresis}`).toBe(true);
  });

  it("判据 6b：同缺席不同上下文 → 不同但有界的动力学", () => {
    const c = robustnessCheck({ t0: T0 });
    expect(c.inBand, `spread=${c.spread}`).toBe(true);
  });

  it("熵仪表：f_val 分箱 Shannon 熵可计算且范围合理（只读不优化）", () => {
    const { samples } = replaySampled(
      sineEvents({ t0: T0, n: 500, periodMs: 8 * HOUR, amplitude: 0.6 }),
      T0 + 500 * 300_000,
      { params: DEFAULT_PARAMS },
    );
    const h = shannonEntropy(samples);
    expect(h).toBeGreaterThan(0.5);
    expect(h).toBeLessThanOrEqual(Math.log2(5));
  });
});

describe("gap 对齐", () => {
  it("declared 与 derived 在夹具上高相关；gap 数值不进渲染层", () => {
    const r = runFullBench({ t0: T0 });
    expect(r.gapAlignment.correlation).toBeGreaterThan(0.8);
    expect(r.gapAlignment.inBand).toBe(true);
  });
});

describe("M5 · 合成夹具全绿（总验收）", () => {
  it("runFullBench allGreen === true", () => {
    const r = runFullBench({ t0: T0 });
    const failed = r.workspace.filter((c) => !c.inBand).map((c) => `${c.name}: ${c.value} vs ${c.band}`);
    expect(failed, failed.join("; ")).toEqual([]);
    expect(r.threeMetrics.inertia.inBand).toBe(true);
    expect(r.threeMetrics.specificity.inBand).toBe(true);
    expect(r.threeMetrics.cost.inBand).toBe(true);
    expect(r.allGreen).toBe(true);
  }, 120_000);
});

describe("金丝雀电池", () => {
  it("首次运行记录基线（deviation=0, ok）；参数扰动后偏差超阈 → revoke_steering", async () => {
    const store = new MemoryStore();
    const r1 = await runCanaryBattery(store, { t0: T0 });
    expect(r1.action).toBe("ok");

    // 同一存储、被改动的参数（模拟静默更新）→ 轨迹偏离基线（防同版本号静默更新）
    await store.setParam("noiseFast", 0.5);
    const r2 = await runCanaryBattery(store, { t0: T0 });
    expect(r2.deviation).toBeGreaterThan(0.05);
    expect(r2.action).toBe("revoke_steering");
    const runs = await store.listCanaryRuns();
    expect(runs.length).toBe(2);
  });
});
