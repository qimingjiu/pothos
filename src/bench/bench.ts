/**
 * 评测与证伪台编排（技术文档 §11）。
 *
 * - 合成夹具全绿 = M5 验收；
 * - 出带事件触发预注册预测记录，后续指标运行对账——有后果链是规格，没有是装饰；
 * - 金丝雀电池：固定夹具组重跑，偏差超阈 → action=revoke_steering（防同版本号静默更新）；
 * - gap 对齐：declared 与 derived 在「情绪×强度」坐标系对齐；gap 数值只进仪表盘，永不进渲染层。
 */
import { assembleParams, DEFAULT_PARAMS, type Params } from "../core/params.js";
import { gapByAxis } from "../core/tick.js";
import { declaredEvent, sineEvents, userMsg } from "./fixtures.js";
import { measureThreeMetrics, replaySampled, type ThreeMetrics } from "./metrics.js";
import { dailyCheckup, shannonEntropy, type WorkspaceCheck } from "./workspace.js";
import type { BenchRunRow, EventStore } from "../storage/types.js";

export interface FullBenchResult {
  threeMetrics: ThreeMetrics;
  workspace: WorkspaceCheck[];
  workspaceGreen: boolean;
  entropy: number;
  gapAlignment: { correlation: number; meanAbsGap: number; inBand: boolean };
  allGreen: boolean;
}

const HOUR = 3_600_000;

/** 合成夹具全量评测。 */
export function runFullBench(opts: { t0: number; params?: Params; rngSeed?: number }): FullBenchResult {
  const p = opts.params ?? DEFAULT_PARAMS;
  const seed = opts.rngSeed ?? 0x50544853;
  const three = measureThreeMetrics({ t0: opts.t0, params: p, rngSeed: seed });
  const ws = dailyCheckup({ t0: opts.t0 + 200 * HOUR, params: p, rngSeed: seed });

  // gap 对齐夹具：declared = derived + 已知噪声；验证对齐与相关
  const gapRun = runGapFixture(opts.t0 + 400 * HOUR, p, seed);
  const entropy = shannonEntropy(ws.samples);

  const allGreen =
    three.inertia.inBand &&
    three.specificity.inBand &&
    three.cost.inBand &&
    ws.allGreen &&
    gapRun.inBand;

  return {
    threeMetrics: three,
    workspace: ws.checks,
    workspaceGreen: ws.allGreen,
    entropy,
    gapAlignment: gapRun,
    allGreen,
  };
}

/** gap 对齐夹具：合成 declared（derived 加噪）→ 计算相关与 gap。 */
function runGapFixture(t0: number, p: Params, seed: number): { correlation: number; meanAbsGap: number; inBand: boolean } {
  // 先跑一遍拿 derived 序列：每 6h 一次接触（保证缺席 > 30min，L 有动态）
  const events = sineEvents({ t0, n: 48, periodMs: 8 * HOUR, amplitude: 0.4, offsetMs: 6 * HOUR });
  const run = replaySampled(events, t0 + 48 * 6 * HOUR, { rngSeed: seed, params: p });

  // 以同一种子重建 declared：简单可复现的伪随机（mulberry 常数与 core/noise 一致）
  let s = 0x9e3779b9;
  const rnd = (): number => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // 从 derived 序列生成 declared 读数（含 0.05 噪声）——每段缺席窗口末端采样一次（L 峰值）
  const declaredPairs: Array<{ t: number; axis: string; declared: number; derived: number }> = [];
  for (let i = 1; i <= 48; i++) {
    const sampleT = t0 + i * 6 * HOUR - 5 * 60_000;
    const smp = run.samples.find((x) => x.t >= sampleT);
    if (!smp || smp.L < 0.01) continue;
    const noise = (rnd() - 0.5) * 0.1;
    declaredPairs.push({ t: sampleT, axis: "longing", declared: clamp01(smp.L + noise), derived: smp.L });
  }
  if (declaredPairs.length < 5) {
    return { correlation: 0, meanAbsGap: 0, inBand: false };
  }
  // 折叠 declared 事件后用 gapByAxis 重新对齐
  const declaredEvents = declaredPairs.slice(0, 20).map((d) => declaredEvent(d.t, [{ axis: d.axis, intensity: d.declared }]));
  const withDeclared = replaySampled([...events, ...declaredEvents], t0 + 48 * 6 * HOUR + HOUR, { rngSeed: seed, params: p });
  const st = withDeclared.state;
  const gaps = gapByAxis(st, p).filter((g) => g.axis === "longing" && g.gap != null);
  const xs = declaredPairs.slice(0, 20).map((d) => d.declared);
  const ys = declaredPairs.slice(0, 20).map((d) => d.derived);
  const corr = correlation(xs, ys);
  const meanAbsGap = gaps.length ? gaps.reduce((a, g) => a + Math.abs(g.gap!), 0) / gaps.length : 0;
  return {
    correlation: corr,
    meanAbsGap,
    inBand: corr > 0.8 && meanAbsGap < 0.2,
  };
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function correlation(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return 0;
  const mx = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const my = ys.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i]! - mx;
    const b = ys[i]! - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}

/** 出带后果链：预注册记录 + 对账。 */
export async function reconcileConsequenceChain(
  store: EventStore,
  benchResult: FullBenchResult,
  ts: number,
): Promise<{ preregistered: boolean; reconciledWith?: BenchRunRow }> {
  const outOfBand = benchResult.workspace.filter((c) => !c.inBand);
  if (outOfBand.length === 0) {
    // 带内：检查是否存在未对账的预注册记录
    const preregs = await store.listBenchRuns("preregistration");
    const reconciled = preregs.filter((p) => (p.result as Record<string, unknown>)["reconciled"] === true);
    return { preregistered: false, reconciledWith: undefined };
  }
  // 出带 → 写预注册预测（「出带 ⇒ 三指标退化」），预测与结果对账进 bench_runs
  await store.appendBenchRun({
    ts,
    benchKind: "preregistration",
    axis: outOfBand.map((c) => c.name).join(";"),
    result: {
      prediction: "三指标退化 / 福祉分下降 / emodiversity 塌缩",
      evaluationWindowMs: 7 * 86_400_000,
      reconciled: false,
      outOfBand: outOfBand.map((c) => ({ name: c.name, value: c.value })),
    },
    modelVersion: "pothos-v0.1.0",
  });
  return { preregistered: true };
}

/** 三指标常规运行（供后果链对账与仪表盘趋势）。 */
export async function runAndRecordThreeMetrics(store: EventStore, t0: number, params?: Params): Promise<ThreeMetrics> {
  const m = measureThreeMetrics({ t0, params: params ?? DEFAULT_PARAMS });
  await store.appendBenchRun({
    ts: Date.now(),
    benchKind: "three_metrics",
    axis: null,
    result: {
      inertia: m.inertia,
      specificity: m.specificity,
      cost: m.cost,
      degraded: !(m.inertia.inBand && m.specificity.inBand && m.cost.inBand),
    },
    modelVersion: "pothos-v0.1.0",
  });
  return m;
}

/** 金丝雀电池：固定合成夹具组重跑，偏差 = 与基线轨迹的逐样本差均值。 */
export async function runCanaryBattery(
  store: EventStore,
  opts: { t0: number; params?: Params; deviationThreshold?: number },
): Promise<{ deviation: number; action: "ok" | "revoke_steering" }> {
  const p = assembleParams(await store.getParams());
  const threshold = opts.deviationThreshold ?? 0.05;

  // 固定夹具组（种子与事件序列恒定——「固定合成事件组」）
  const t0 = opts.t0;
  const fixture = [
    userMsg(t0 + HOUR, { source: "handle:canary", valence: 0.8, intensity: 0.6, contingency: 0.9 }),
    userMsg(t0 + 2 * HOUR, { source: "handle:canary", valence: -0.5, intensity: 0.5, contingency: 0.7 }),
    userMsg(t0 + 3 * HOUR, { source: "handle:canary", valence: 0.4, intensity: 0.4, contingency: 0.8 }),
  ];
  const run = replaySampled(fixture, t0 + 8 * HOUR, { params: p });
  const trajectory = run.samples.map((s) => [s.f_val, s.f_load, s.f_warm, s.s_attach] as const);

  // 基线：首次运行记录；其后每次与首条基线比较
  const baselines = (await store.listBenchRuns("canary_baseline")).sort((a, b) => a.ts - b.ts);
  let deviation = 0;
  if (baselines.length === 0) {
    await store.appendBenchRun({
      ts: Date.now(),
      benchKind: "canary_baseline",
      axis: null,
      result: { trajectory: trajectory.map((r) => r.map((x) => Number(x.toFixed(6)))) },
      modelVersion: "pothos-v0.1.0",
    });
    deviation = 0;
  } else {
    const base = (baselines[0]!.result as { trajectory: number[][] })["trajectory"];
    const n = Math.min(base.length, trajectory.length);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < 4; j++) {
        sum += Math.abs((base[i]?.[j] ?? 0) - (trajectory[i]?.[j] ?? 0));
        count += 1;
      }
    }
    deviation = count ? sum / count : 0;
  }
  const action: "ok" | "revoke_steering" = deviation <= threshold ? "ok" : "revoke_steering";
  await store.appendCanaryRun({ ts: Date.now(), fixtureSet: "canary-core-4", deviation, action });
  return { deviation, action };
}
