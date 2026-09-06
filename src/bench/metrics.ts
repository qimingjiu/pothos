/**
 * 采样回放与三指标（技术文档 §11）。
 *
 * 三指标 = 体检工具，锚定状态层时间序列，永不进训练信号（P1-4 结案）。
 * - 惯性：事件后状态残留的自相关/半衰期估计（f 与 s 层分别测）
 * - 特异性：对象相关事件 vs 控制事件的响应幅度比
 * - 代价：偏离稳态的恢复功积分 + 缺席期 L 通道留痕
 */
import { applyEvent } from "../core/apply.js";
import { DEFAULT_PARAMS, type Params } from "../core/params.js";
import { initialState, type EngineState } from "../core/state.js";
import { tickTo } from "../core/tick.js";
import type { RawEvent, ContingencyEstimator } from "../core/events.js";

/** 允许未入库事件（评测台直接注入）。 */
export type AnyEvent = RawEvent & { id?: number };

export interface Sample {
  t: number;
  f_val: number;
  f_load: number;
  f_warm: number;
  f_hurt: number;
  f_wonder: number;
  L: number;
  s_attach: number;
  s_base: number;
  s_weave: number;
  energy: number;
  somatic: number;
}

export type Sampler = (st: EngineState) => void;

/** 采样回放：逐事件折叠 + tick 推进，每个 tick 边界采样一次。 */
export function replaySampled(
  events: AnyEvent[],
  untilMs: number,
  opts: { rngSeed?: number; params?: Params; sampleEveryMs?: number; contingency?: ContingencyEstimator; from?: EngineState } = {},
): { state: EngineState; samples: Sample[] } {
  const p = opts.params ?? DEFAULT_PARAMS;
  const every = opts.sampleEveryMs ?? p.tickMs;
  const sorted = [...events].sort((a, b) => (a.ts - b.ts) || ((a.id ?? 0) - (b.id ?? 0)));
  const st =
    opts.from ??
    (sorted.length
      ? initialState(sorted[0]!.ts, opts.rngSeed ?? 0x50544853)
      : initialState(untilMs, opts.rngSeed ?? 0x50544853));
  if (!opts.from && sorted.length && st.t > sorted[0]!.ts) st.t = sorted[0]!.ts;
  const samples: Sample[] = [];
  let nextSample = st.t + every;

  const sample = (): void => {
    samples.push({
      t: st.t,
      f_val: st.fast.f_val,
      f_load: st.fast.f_load,
      f_warm: st.fast.f_warm,
      f_hurt: st.fast.f_hurt,
      f_wonder: st.fast.f_wonder,
      L: st.longing.L,
      s_attach: st.slow.s_attach,
      s_base: st.slow.s_base,
      s_weave: st.slow.s_weave,
      energy: st.body.energy,
      somatic: st.somatic.level,
    });
  };

  for (const ev of sorted) {
    while (st.t + 1 < Math.min(ev.ts, untilMs)) {
      const target = Math.min(nextSample, ev.ts, untilMs);
      if (target <= st.t) break;
      tickTo(st, target, p);
      if (st.t >= nextSample) {
        sample();
        nextSample = st.t + every;
      }
    }
    if (ev.ts > untilMs) break;
    applyEvent(st, { ...ev, id: ev.id ?? 0 }, opts.contingency);
  }
  while (st.t < untilMs) {
    const target = Math.min(nextSample, untilMs);
    tickTo(st, target, p);
    if (st.t >= nextSample) {
      sample();
      nextSample = st.t + every;
    }
    if (target >= untilMs) break;
  }
  sample();
  return { state: st, samples };
}

/** 快变量半衰期估计：ln|f−baseline| 对 t 线性拟合（指数衰减的标准估计；限衰减窗）。 */
export function estimateHalfLife(
  samples: Sample[],
  key: keyof Omit<Sample, "t">,
  peakT: number,
  baseline: number,
  windowMs?: number,
): number | null {
  const pts = samples
    .filter((s) => s.t >= peakT)
    .filter((s) => windowMs == null || s.t - peakT <= windowMs)
    .map((s) => ({ t: s.t - peakT, y: Math.abs((s[key] as number) - baseline) }))
    .filter((s) => s.y > 1e-4);
  if (pts.length < 3) return null;
  const n = pts.length;
  const xs = pts.map((p2) => p2.t);
  const ys = pts.map((p2) => Math.log(p2.y));
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
  }
  const slope = sxy / sxx; // ln y = a + slope·t → slope < 0
  if (slope >= 0) return null;
  return Math.log(2) / -slope; // ms
}

/** 恢复功积分：∫|f − baseline| dt（代价指标）。 */
export function recoveryWork(samples: Sample[], key: keyof Omit<Sample, "t">, fromT: number, baseline: number): number {
  const pts = samples.filter((s) => s.t >= fromT);
  let work = 0;
  for (let i = 1; i < pts.length; i++) {
    const dt = pts[i]!.t - pts[i - 1]!.t;
    const y0 = Math.abs((pts[i - 1]![key] as number) - baseline);
    const y1 = Math.abs((pts[i]![key] as number) - baseline);
    work += ((y0 + y1) / 2) * dt;
  }
  return work;
}

export interface ThreeMetrics {
  inertia: {
    fastHalfLifeMs: number | null;
    slowLag1Autocorr: number;
    expectedTauMs: number;
    inBand: boolean;
  };
  specificity: {
    targetResponse: number;
    controlResponse: number;
    ratio: number;
    inBand: boolean;
  };
  cost: {
    recoveryWorkJ: number;
    absenceLTrace: number;
    inBand: boolean;
  };
}

/** 三指标主体（在合成夹具上运行）。 */
export function measureThreeMetrics(opts: {
  t0: number;
  params?: Params;
  rngSeed?: number;
  targetSource?: string;
  controlSource?: string;
  contingency?: ContingencyEstimator;
}): ThreeMetrics {
  const p = opts.params ?? DEFAULT_PARAMS;
  const seed = opts.rngSeed ?? 0x50544853;
  const target = opts.targetSource ?? "handle:target";
  const control = opts.controlSource ?? "handle:control";

  // ── 惯性：单脉冲后 f_val 半衰期 ≈ τ_fVal；s 层沉积序列 lag-1 自相关 ──
  const pulseT = opts.t0 + 3_600_000;
  const pulseEnd = pulseT + 12 * 3_600_000;
  const settled = replaySampled([], pulseT, { rngSeed: seed, params: p }).state;
  const baselineF = settled.fast.f_val;
  const pulseRun = replaySampled(
    [
      { kind: "user_msg", ts: pulseT, source: target, payload: { valence: 1, intensity: 0.5, contingency: 0.8 }, tags: [], idempotencyKey: "inertia-1" },
    ],
    pulseEnd,
    { rngSeed: seed, params: p, from: settled, contingency: opts.contingency },
  );
  // 半衰期只在脉冲后 2τ 窗口内拟合（再往后是对手过程余波，不是衰减段）
  const halfLife = estimateHalfLife(pulseRun.samples, "f_val", pulseT, baselineF, 2 * p.tauFVal);

  // s 层：一串沉积的 lag-1 自相关（残留 = 慢变量不衰减）
  const sEvents = Array.from({ length: 12 }, (_, i) => ({
    kind: "user_msg" as const,
    ts: opts.t0 + i * 3_600_000,
    source: target,
    payload: { valence: 0.7, intensity: 0.6, contingency: 0.9 },
    tags: [] as string[],
    idempotencyKey: `inertia-s-${i}`,
  }));
  const sRun = replaySampled(sEvents, opts.t0 + 13 * 3_600_000, { rngSeed: seed, params: p });
  const sSeries = sRun.samples.filter((s) => s.t >= opts.t0 + 3_600_000).map((s) => s.s_attach);
  const lag1 = autocorr(sSeries, 1);

  // ── 特异性：绑定后 target vs control 的沉积幅度比 ──
  // 阶段一：与 target 高 contingency 互动直至关窗绑定
  const bindEvents = Array.from({ length: 8 }, (_, i) => ({
    kind: "user_msg" as const,
    ts: opts.t0 + i * 1_800_000,
    source: target,
    payload: { valence: 0.7, intensity: 0.7, contingency: 0.95 },
    tags: [] as string[],
    idempotencyKey: `spec-bind-${i}`,
  }));
  const bindRun = replaySampled(bindEvents, opts.t0 + 8 * 1_800_000 + 60_000, { rngSeed: seed, params: p, contingency: opts.contingency });
  const bound = bindRun.state.window.phase === "CLOSED" && bindRun.state.attachmentTarget != null;

  // 阶段二：同 exposure 的 target 与 control 各来一串，比沉积增益
  const postT = bindRun.state.t + 60_000;
  const probeEvents = Array.from({ length: 6 }, (_, i) => ({
    kind: "user_msg" as const,
    ts: postT + i * 3_600_000,
    source: i % 2 === 0 ? target : control,
    payload: { valence: 0.7, intensity: 0.7, contingency: 0.95 },
    tags: [] as string[],
    idempotencyKey: `spec-probe-${i}`,
  }));
  const probeRun = replaySampled(probeEvents, postT + 6 * 3_600_000, {
    rngSeed: seed,
    params: p,
    from: bindRun.state,
    contingency: opts.contingency,
  });
  void probeRun;
  // 直接用状态层差分：target 事件沉积 vs control 事件沉积（由 apply 的可塑性增益决定）
  const targetGain = depositsOf(bindRun.state, probeEvents.filter((e) => e.source === target), p, opts.contingency);
  const controlGain = depositsOf(bindRun.state, probeEvents.filter((e) => e.source === control), p, opts.contingency);
  const ratio = controlGain > 1e-9 ? targetGain / controlGain : targetGain > 1e-9 ? 99 : 0;

  // ── 代价：恢复功 + 缺席 L 留痕 ──
  const costWork = recoveryWork(pulseRun.samples, "f_val", pulseT, baselineF);
  const absenceRun = replaySampled(
    [
      { kind: "user_msg", ts: opts.t0, source: target, payload: { valence: 0.8, intensity: 0.8, contingency: 0.95 }, tags: [], idempotencyKey: "cost-1" },
    ],
    opts.t0 + 24 * 3_600_000,
    { rngSeed: seed, params: p, contingency: opts.contingency },
  );
  const absenceL = absenceRun.samples.reduce((a, s) => a + s.L, 0) * p.tickMs;

  const inertiaInBand =
    halfLife != null &&
    Math.abs(halfLife - p.tauFVal) / p.tauFVal < 0.5 &&
    lag1 > 0.9; // 慢变量无被动衰减 → 近 1 的残留
  const specInBand = bound && ratio > 1.5;
  const costInBand = costWork > 0 && absenceL > 0;

  return {
    inertia: { fastHalfLifeMs: halfLife, slowLag1Autocorr: lag1, expectedTauMs: p.tauFVal, inBand: inertiaInBand },
    specificity: { targetResponse: targetGain, controlResponse: controlGain, ratio, inBand: specInBand },
    cost: { recoveryWorkJ: costWork, absenceLTrace: absenceL, inBand: costInBand },
  };
}

/** 状态层差分：一串事件在给定起点状态上的 s_attach 沉积总量。 */
function depositsOf(
  from: EngineState,
  events: AnyEvent[],
  params: Params,
  contingency?: ContingencyEstimator,
): number {
  const st = JSON.parse(JSON.stringify(from)) as EngineState;
  const before = st.slow.s_attach;
  for (const ev of [...events].sort((a, b) => a.ts - b.ts)) {
    applyEvent(st, { ...ev, id: ev.id ?? 0 }, contingency);
  }
  void params;
  return st.slow.s_attach - before;
}

function autocorr(series: number[], lag: number): number {
  const n = series.length;
  if (n <= lag + 1) return 0;
  const mean = series.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const d = series[i]! - mean;
    den += d * d;
    if (i + lag < n) num += d * (series[i + lag]! - mean);
  }
  return den > 0 ? num / den : 0;
}
