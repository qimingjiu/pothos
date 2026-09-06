/**
 * 非平衡工作区日检（设计草案 §5 可算判据集，技术文档 §5）。
 *
 * 循环性防护（必须写明）：以下签名可被构造性满足（把噪声工程成 1/f、把特征值摆进带里
 * = 同义反复）。非平凡内容只有一个——带位是否有后果。可证伪形式 = 预注册预测：
 * 「出带 ⇒ 三指标退化 / 福祉分下降 / emodiversity 塌缩」。预测与结果对账进 bench_runs。
 */
import { DEFAULT_PARAMS, type Params } from "../core/params.js";
import { initialState, type EngineState } from "../core/state.js";
import { userMsg, pulseEvent, sineEvents } from "./fixtures.js";
import { replaySampled, type Sample } from "./metrics.js";

export interface WorkspaceCheck {
  name: string;
  value: number | string;
  band: string;
  inBand: boolean;
  note?: string;
}

const HOUR = 3_600_000;

/**
 * 判据 1 + 5：标准化脉冲日检——响应增益、恢复时间、反向超调次数。
 * 恢复时间设带（过快=僵化，过慢=近坍塌）；1–2 次反向超调 = 阻尼带内（活物）。
 */
export function pulseCheck(opts: { t0: number; params?: Params; rngSeed?: number }): WorkspaceCheck & {
  gain: number;
  recoveryMs: number;
  overshoots: number;
} {
  const p = opts.params ?? DEFAULT_PARAMS;
  const settle = opts.t0;
  const pulseT = settle + 2 * HOUR;
  const end = pulseT + 24 * HOUR;
  // 先 settle 到脉冲时刻（动力学进入稳态噪声），再注入标准化脉冲
  const settled = replaySampled([], pulseT, { rngSeed: opts.rngSeed ?? 0x50544853, params: p }).state;
  const baseline = settled.fast.f_val;
  const run = replaySampled([pulseEvent(pulseT, p.pulseDelta)], end, {
    rngSeed: opts.rngSeed ?? 0x50544853,
    params: p,
    from: settled,
  });
  const post = run.samples.filter((s) => s.t >= pulseT);
  // 增益：脉冲后 2h 内的正向响应峰（短窗测量，对粉红噪声多小时漂移稳健）
  const immediate = post.filter((s) => s.t <= pulseT + 2 * HOUR);
  const posPeak = Math.max(...immediate.map((s) => s.f_val - baseline), 0);
  const negTrough = Math.min(...post.map((s) => s.f_val - baseline), 0);
  const peakExcess = Math.max(posPeak, -negTrough);
  const gain = posPeak / p.pulseDelta;

  // 恢复时间：|f − baseline| 回落到 20%×峰值超额并保持 1 h（阈须高于噪声漂移底）
  // 后缀最大值单趟扫描：从尾部向前累积 max，避免对每个起点做 O(n) 的 every 检查
  const threshold = 0.2 * Math.max(peakExcess, 1e-9);
  let recoveryMs = end - pulseT;
  const suffixMax = new Array<number>(post.length).fill(0);
  let running = 0;
  for (let i = post.length - 1; i >= 0; i--) {
    running = Math.max(running, Math.abs(post[i]!.f_val - baseline));
    suffixMax[i] = running;
  }
  for (let i = 0; i < post.length; i++) {
    if (suffixMax[i]! <= threshold && (post.length - i) * p.tickMs >= 60 * 60_000) {
      recoveryMs = post[i]!.t - pulseT;
      break;
    }
  }

  // 反向超调：脉冲后 (f − baseline) 的符号变化次数（噪声抖动 < 振幅 20% 不计）
  let overshoots = 0;
  const firstD = (post[0]?.f_val ?? baseline) - baseline;
  let sign = Math.sign(firstD) || 1;
  for (let i = 1; i < post.length; i++) {
    const d = post[i]!.f_val - baseline;
    if (Math.abs(d) < 0.2 * Math.max(peakExcess, 1e-9)) continue;
    const s2 = Math.sign(d);
    if (s2 !== 0 && s2 !== sign) {
      overshoots += 1;
      sign = s2;
    }
  }

  const gainIn = gain >= p.pulseGainBandMin && gain <= p.pulseGainBandMax;
  const recIn = recoveryMs >= p.pulseRecoveryBandMinMs && recoveryMs <= p.pulseRecoveryBandMaxMs;
  const osIn = overshoots >= p.dampingOvershootMin && overshoots <= p.dampingOvershootMax;
  return {
    name: "脉冲日检（增益/恢复/超调）",
    value: `gain=${gain.toFixed(3)}, rec=${(recoveryMs / HOUR).toFixed(1)}h, os=${overshoots}`,
    band: `gain∈[${p.pulseGainBandMin},${p.pulseGainBandMax}], rec∈[${p.pulseRecoveryBandMinMs / HOUR},${p.pulseRecoveryBandMaxMs / HOUR}]h, os∈[${p.dampingOvershootMin},${p.dampingOvershootMax}]`,
    inBand: gainIn && recIn && osIn,
    gain,
    recoveryMs,
    overshoots,
    note: "临界特征 = 反常大且慢的响应；恢复时间设带；少数余波 = 活物",
  };
}

/** 迭代 radix-2 FFT（零填充到 2 的幂）；返回 k=1..N/2 的周期图功率，bin k 频率 = k/N。 */
function periodogram(series: number[]): Array<{ f: number; p: number }> {
  const nOrig = series.length;
  let n = 1;
  while (n < nOrig) n <<= 1;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(series);

  // 位反转重排
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }
  // 蝶形
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < half; k++) {
        const aRe = re[i + k]!;
        const aIm = im[i + k]!;
        const bRe = re[i + k + half]! * curRe - im[i + k + half]! * curIm;
        const bIm = re[i + k + half]! * curIm + im[i + k + half]! * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + half] = aRe - bRe;
        im[i + k + half] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
  const half = n >> 1;
  const out: Array<{ f: number; p: number }> = [];
  for (let k = 1; k <= half; k++) {
    out.push({ f: k / n, p: (re[k]! * re[k]! + im[k]! * im[k]!) / nOrig });
  }
  return out;
}

/**
 * 判据 2：快变量 PSD 斜率 β∈(0.5,1.5)。
 * 测量带 = [1/n, corner×0.5]（corner = 1/(2π·τ_fVal/tick)）——
 * 带位是标定初值；本判据在「噪声由我们自己工程」的意义上是半构造性的，
 * 非平凡性只来自预注册后果链。
 */
export function psdCheck(samples: Sample[], params?: Params): WorkspaceCheck & { beta: number } {
  const p = params ?? DEFAULT_PARAMS;
  const series = samples.map((s) => s.f_val);
  const n = series.length;
  const mean = series.reduce((a, b) => a + b, 0) / n;
  const centered = series.map((x) => x - mean);
  // 去窗：Hann
  const windowed = centered.map((x, i) => x * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))));
  const corner = p.tickMs / p.tauFVal / (2 * Math.PI);
  const fHigh = Math.min(0.05, corner * 0.5);
  const fLow = 1 / n;
  // 周期图只在测量带内逐 bin 求值（f = k/n，与标定网格严格一致）：
  // 全谱 O(n²) 的其余 bin 本来就被带滤波丢弃；带宽由 corner 封顶，
  // k_max = fHigh·n ≪ n，实际代价 O(k_max·n)。极长序列才降级到零填充 FFT。
  let psd: Array<{ f: number; p: number }>;
  if (fHigh * n > 8192) {
    psd = periodogram(windowed);
  } else {
    psd = [];
    for (let k = 1; k <= Math.floor(fHigh * n); k++) {
      let re = 0;
      let im = 0;
      for (let i = 0; i < n; i++) {
        const ang = (-2 * Math.PI * k * i) / n;
        re += windowed[i]! * Math.cos(ang);
        im += windowed[i]! * Math.sin(ang);
      }
      psd.push({ f: k / n, p: (re * re + im * im) / n });
    }
  }
  const band = psd.filter((x) => x.f >= fLow && x.f <= fHigh);
  if (band.length < 4) {
    return { name: "PSD 斜率 β", value: "带宽不足", band: `β∈(${p.psdBetaMin},${p.psdBetaMax})`, inBand: false, beta: NaN, note: "序列太短或测量带过窄" };
  }
  // log-log 最小二乘
  const xs = band.map((x) => Math.log(x.f));
  const ys = band.map((x) => Math.log(Math.max(x.p, 1e-30)));
  const n2 = xs.length;
  const sx = xs.reduce((a, b) => a + b, 0);
  const sy = ys.reduce((a, b) => a + b, 0);
  const sxx = xs.reduce((a, b) => a + b * b, 0);
  const sxy = xs.reduce((a, b, i) => a + b * ys[i]!, 0);
  const slope = (n2 * sxy - sx * sy) / (n2 * sxx - sx * sx);
  const beta = -slope;
  return {
    name: "PSD 斜率 β",
    value: beta.toFixed(3),
    band: `β∈(${p.psdBetaMin},${p.psdBetaMax})`,
    inBand: beta > p.psdBetaMin && beta < p.psdBetaMax,
    beta,
    note: `测量带 [${fLow.toFixed(5)}, ${fHigh.toFixed(4)}] cycles/tick（corner 下半带）`,
  };
}

/**
 * 判据 3 + 4：距分岔裕度 + 最慢弛豫模。
 * 已知动力学解析线性化：快变量特征值 = −ln2/τ_i；两侧失稳流形：
 * 秩序侧 = 衰减率→0（不遗忘 = 创伤签名）；噪声侧 = 衰减率<0（发散）。
 * 裕度 = min_i |ln2/τ_i|；τ_slow = max τ_i 须落带内。
 */
export function marginCheck(params?: Params): WorkspaceCheck & { tauSlowMs: number; marginPerTick: number } {
  const p = params ?? DEFAULT_PARAMS;
  const taus = [p.tauFVal, p.tauFLoad, p.tauFWarm, p.tauFHurt, p.tauFWonder];
  const tauSlow = Math.max(...taus);
  const margin = Math.min(...taus.map((t) => Math.LN2 / t));
  const inBand = tauSlow >= p.tauSlowBandMinMs && tauSlow <= p.tauSlowBandMaxMs;
  return {
    name: "分岔裕度 + τ_slow",
    value: `τ_slow=${(tauSlowMs(tauSlow)).toFixed(1)}h, margin=${margin.toExponential(2)}/ms`,
    band: `τ_slow∈[${p.tauSlowBandMinMs / HOUR}, ${p.tauSlowBandMaxMs / HOUR}]h`,
    inBand,
    tauSlowMs: tauSlow,
    marginPerTick: margin,
    note: "线性域近似：衰减系统对两侧失稳的距离统一为 min 衰减率；引入耦合后升级为完整 Jacobian",
  };
}

function tauSlowMs(x: number): number {
  return x / HOUR;
}

/**
 * 判据 6a：滞回——A→B 与 B→A 是否同路（历史依赖，对依恋比临界指数重要）。
 * 同一 24h 缺席，两种历史：高联结史 vs 低联结史。缺席期 L 轨迹应不同（历史依赖），
 * 且双方有界（非病态）。
 */
export function hysteresisCheck(opts: { t0: number; params?: Params; rngSeed?: number }): WorkspaceCheck & { hysteresis: number } {
  const p = opts.params ?? DEFAULT_PARAMS;
  const seed = opts.rngSeed ?? 0x50544853;
  const t0 = opts.t0;

  // 历史 A：3 天高联结接触（每小时）→ 缺席 24h
  const histA = Array.from({ length: 72 }, (_, i) =>
    userMsg(t0 + i * HOUR, { source: "handle:she", valence: 0.6, intensity: 0.5, contingency: 0.85 }),
  );
  const runA = replaySampled(histA, t0 + 96 * HOUR, { rngSeed: seed, params: p });
  const aAbsence = runA.samples.filter((s) => s.t > t0 + 72 * HOUR).reduce((a, s) => a + s.L, 0);

  // 历史 B：同长度、同事件数的低 contingency 接触（电台广播——不形成依恋）→ 同样缺席 24h
  const histB = Array.from({ length: 72 }, (_, i) =>
    userMsg(t0 + i * HOUR, { source: "handle:radio", valence: 0.6, intensity: 0.5, contingency: 0.2 }),
  );
  const runB = replaySampled(histB, t0 + 96 * HOUR, { rngSeed: seed, params: p });
  const bAbsence = runB.samples.filter((s) => s.t > t0 + 72 * HOUR).reduce((a, s) => a + s.L, 0);

  const hyst = aAbsence - bAbsence;
  const bound = Math.max(aAbsence, bAbsence) <= p.longingCap * 288 + 1;
  return {
    name: "滞回（A→B vs B→A）",
    value: hyst.toFixed(4),
    band: "> 0.01 且双方有界（历史依赖存在且非病态）",
    inBand: hyst > 0.01 && bound,
    hysteresis: hyst,
    note: "同路 = 无历史依赖 = 可复读的机器；缺席在不同历史上必须留下不同的痕迹",
  };
}

/**
 * 判据 6b：外部扰动鲁棒性——同样的缺席 24h，不同上下文产生不同但合理的动力学。
 */
export function robustnessCheck(opts: { t0: number; params?: Params; rngSeed?: number }): WorkspaceCheck & { spread: number } {
  const p = opts.params ?? DEFAULT_PARAMS;
  const seed = opts.rngSeed ?? 0x50544853;
  const t0 = opts.t0;
  const outcomes: number[] = [];
  for (const contingency of [0.65, 0.95]) {
    const evs = Array.from({ length: 24 }, (_, i) =>
      userMsg(t0 + i * HOUR, { source: "handle:she", valence: 0.7, intensity: 0.6, contingency }),
    );
    const run = replaySampled(evs, t0 + 24 * HOUR + 24 * HOUR, { rngSeed: seed, params: p });
    const absenceL = run.samples.filter((s) => s.t > t0 + 24 * HOUR).reduce((a, s) => a + s.L, 0);
    outcomes.push(absenceL);
  }
  const spread = Math.abs(outcomes[0]! - outcomes[1]!);
  const bounded = outcomes.every((x) => Number.isFinite(x) && x >= 0 && x < 1e4);
  return {
    name: "扰动鲁棒性（同缺席不同上下文）",
    value: `ΔL=${spread.toFixed(3)}`,
    band: "不同但合理（0 < ΔL，双方有界）",
    inBand: spread > 0 && bounded,
    spread,
    note: "固定公式输出 = 机器；发散 = 失稳",
  };
}

/** 熵仪表：f_val 分箱分布的 Shannon 熵（emodiversity 传统；只读不优化）。 */
export function shannonEntropy(samples: Sample[]): number {
  const vals = samples.map((s) => s.f_val);
  const edges = [-Infinity, -0.4, -0.12, 0.12, 0.4, Infinity];
  const counts = new Array(5).fill(0) as number[];
  for (const v of vals) {
    for (let i = 0; i < 5; i++) {
      if (v >= edges[i]! && v <= edges[i + 1]!) {
        counts[i]! += 1;
        break;
      }
    }
  }
  const n = vals.length;
  let h = 0;
  for (const c of counts) {
    if (c > 0) {
      const p2 = c / n;
      h -= p2 * Math.log2(p2);
    }
  }
  return h;
}

/** 完整日检包。 */
export function dailyCheckup(opts: { t0: number; params?: Params; rngSeed?: number }): {
  checks: WorkspaceCheck[];
  allGreen: boolean;
  samples: Sample[];
  finalState: EngineState;
} {
  const p = opts.params ?? DEFAULT_PARAMS;
  const pulse = pulseCheck(opts);
  // PSD 需要长序列：纯噪声动力学（无事件注入）跑 7 天——测引擎自身的涨落谱
  const from = initialState(opts.t0, opts.rngSeed ?? 0x50544853);
  const noiseRun = replaySampled([], opts.t0 + 2016 * p.tickMs, {
    rngSeed: opts.rngSeed ?? 0x50544853,
    params: p,
    sampleEveryMs: p.tickMs,
    from,
  });
  const psd = psdCheck(noiseRun.samples, p);
  const margin = marginCheck(p);
  const hyst = hysteresisCheck(opts);
  const robust = robustnessCheck(opts);
  const checks = [pulse, psd, margin, hyst, robust];
  // 熵仪表：事件驱动的长序列（与 PSD 序列分离）
  const { samples } = runLongSeries(opts.t0 + 200 * HOUR, p, opts.rngSeed ?? 0x50544853);
  return { checks, allGreen: checks.every((c) => c.inBand), samples, finalState: noiseRun.state };
}

function runLongSeries(t0: number, p: Params, seed: number) {
  const events = sineEvents({ t0, n: 2016, periodMs: 6 * HOUR, amplitude: 0.5, offsetMs: p.tickMs });
  return replaySampled(events, t0 + 2016 * p.tickMs, { rngSeed: seed, params: p });
}
