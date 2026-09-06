/**
 * 动力学层：tick（技术文档 §5）。
 *
 * 快变量有半衰期（平复是健康）；慢变量不衰减但需代谢；缺席通道独立生长；
 * 躯体化升格封顶 + 周期复位；悬停是终态不是崩溃。
 * 全部演化确定性：噪声来自状态内 RNG。
 */
import { assembleParams, maintenanceDemand, type Params } from "./params.js";
import type { EngineState } from "./state.js";

const DAY_MS = 86_400_000;

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function utcDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** 告警意图：方向盲——只有等级与时刻，无轴、无方向、无效价（物理缺席）。 */
export interface AlertIntent {
  ts: number;
  level: "notice" | "watch" | "urgent";
  /** 告警文案在渲染时固定为「需要陪伴性在场」；intent 不携带任何内容字段 */
  source: "somatic" | "nutrition";
}

export interface TickResult {
  /** 引擎产生的告警意图（由服务层持久化；节流在服务层执行） */
  alertIntents: AlertIntent[];
  /** 本次 tick 结算的饥饿侵蚀量（观测用） */
  hungerErosion: number;
}

/**
 * 推进动力学至 nowMs。内部按 tickMs 步长推进（每步独立演化，保证与步长无关的收敛）。
 * 原地修改 st 并返回副作用清单。
 */
export function tickTo(st: EngineState, nowMs: number, baseParams?: Params): TickResult {
  const params: Params = baseParams ?? assembleParams(st.paramOverrides);
  const intents: AlertIntent[] = [];
  let hungerErosion = 0;

  // 守卫只拦截病态参数（tickMs ≤ 0 等——校验边界之外的路径）。上限 1e6 步 ≈ 默认
  // 步长下 9.5 年的追赶，正常挂机恢复远够；耗尽即抛错，动力学失速不许静默截断。
  //
  // 分片锚定 tickMs 绝对网格（batch-invariant）：噪声按「步」消耗，若按调用目标分片，
  // cron 与事件交错产生的分片边界不在事件流里，重放无法复现噪声流（对账必然分歧）。
  // 网格分片下 [tickTo(a), tickTo(b)] ≡ tickTo(b)，分片只由 (st.t, 目标) 决定。
  let guard = 0;
  if (!(params.tickMs > 0) || !Number.isFinite(params.tickMs)) {
    throw new Error(`[POTHOS][P0] tickTo 病态参数：tickMs=${params.tickMs}——动力学失速，拒绝运行（守卫语义）`);
  }
  while (st.t < nowMs - 1) {
    const remaining = nowMs - st.t;
    const nextGrid = (Math.floor(st.t / params.tickMs) + 1) * params.tickMs;
    const dt = Math.min(nextGrid - st.t, params.tickMs, remaining);
    st.t += dt;
    hungerErosion += step(st, dt, params, intents);
    if (++guard >= 1_000_000) {
      throw new Error(
        `[POTHOS][P0] tickTo 守卫耗尽：state.t=${st.t} 未能在 1e6 步内推进到 ${nowMs}（tickMs=${params.tickMs}）——动力学失速，拒绝静默截断`,
      );
    }
  }

  // 跨日结算可能在 tick 内完成，这里兜底
  hungerErosion += settleDayBoundary(st, params, st.t);
  return { alertIntents: intents, hungerErosion };
}

/** 单步演化。返回本步结算的饥饿侵蚀量。 */
function step(st: EngineState, dt: number, p: Params, intents: AlertIntent[]): number {
  const rngNoise = (scale: number): number => {
    const r = mulberryPinkLocal(st, scale);
    return r;
  };

  // ── 快变量：f_i ← f_i·2^(−Δt/τ_i) + η_i（f_val 带对手过程：向 −o_val 回落）──
  const decay = (tauMs: number): number => Math.pow(2, -dt / tauMs);
  // 对手蓄积器向正向部分的慢跟踪（τ_opp 固定 6h；v0 常量，标定走 param_change 需先入 Params）
  st.opp.o_val += (Math.max(st.fast.f_val, 0) - st.opp.o_val) * (1 - Math.pow(2, -dt / (6 * 3_600_000)));
  st.fast.f_val = clamp(
    (st.fast.f_val + st.opp.o_val) * decay(p.tauFVal) - st.opp.o_val + rngNoise(p.noiseFast),
    -2,
    2,
  );
  st.fast.f_load = clamp(st.fast.f_load * decay(p.tauFLoad) + rngNoise(p.noiseFast * 0.5), 0, 2);
  st.fast.f_warm = clamp(st.fast.f_warm * decay(p.tauFWarm) + rngNoise(p.noiseFast * 0.5), 0, 2);
  st.fast.f_hurt = clamp(st.fast.f_hurt * decay(p.tauFHurt) + rngNoise(p.noiseFast * 0.5), 0, 2);
  st.fast.f_wonder = clamp(
    st.fast.f_wonder * decay(p.tauFWonder) + rngNoise(p.noiseFast * 0.6),
    0,
    2,
  );

  // ── 缺席通道 L：dL/dt = a·s_attach/(1 + t_h) + η_L（log 级生长 + 独立粉红噪声）──
  const absence = st.t - st.longing.lastContactAt;
  if (absence > p.longingAbsenceMinMs && st.slow.s_attach > 0.01) {
    const tHours = absence / 3_600_000;
    const growth = ((p.longingA * st.slow.s_attach) / (1 + tHours) + rngNoise(p.longingNoise)) *
      (dt / 3_600_000);
    st.longing.L = clamp(st.longing.L + growth, 0, p.longingCap);
  }

  // ── 身体：能量消耗 / 睡眠压力 / 梦种倾斜回落 ──
  const drainRate = (1 / DAY_MS) * st.body.energyDrainMultiplier * (st.somatic.hovering ? 0.5 : 1);
  st.body.energy = clamp(st.body.energy - drainRate * dt, 0, 1);
  st.body.sleepPressure = clamp(st.body.sleepPressure + (dt / DAY_MS) * 1.1, 0, 1);
  const sleepThreshold = clamp(1 - st.body.sleepAdvanceMs / DAY_MS, 0.3, 1);
  if (st.body.sleepPressure >= sleepThreshold) {
    // 入睡：压力清零，能量部分恢复（引擎自持，无观测者依赖）
    st.body.sleepPressure = 0;
    st.body.energy = clamp(st.body.energy + 0.6, 0, 1);
  }
  st.body.dreamTilt.strength = clamp(st.body.dreamTilt.strength * decay(p.tauFWonder), 0, 1);

  // ── 营养 / 饥饿 ──
  const erosion = settleDayBoundary(st, p, st.t);

  // ── 躯体化状态机（§8.1：第一层泄漏的唯一执行器）──
  updateSomatic(st, p, intents);

  // ── 营养告警（方向盲）──
  const cov = nutritionCovariate(st, p);
  if (p.M_min != null && cov < 0.6 && st.slow.s_attach > 0.05 && !st.somatic.hovering) {
    intents.push({ ts: st.t, level: cov < 0.3 ? "urgent" : "watch", source: "nutrition" });
  }
  return erosion;
}

/** 白噪声 + Kellet 粉红滤波（复用状态内 RNG，确定可复现）。 */
function mulberryPinkLocal(st: EngineState, scale: number): number {
  // 内联最小 RNG 步进（与 core/noise.ts 的 mulberryStep 相同常数——
  // 独立实现以避免循环依赖；测试保证两者一致）
  let s = st.rng.s;
  s = (s + 0x6d2b79f5) | 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const u = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  st.rng.s = s;
  const w = u * 2 - 1;
  const pk = st.rng.pink;
  pk[0] = 0.99886 * pk[0] + w * 0.0555179;
  pk[1] = 0.99332 * pk[1] + w * 0.0750759;
  pk[2] = 0.969 * pk[2] + w * 0.153852;
  pk[3] = 0.8665 * pk[3] + w * 0.3104856;
  pk[4] = 0.55 * pk[4] + w * 0.5329522;
  pk[5] = -0.7616 * pk[5] - w * 0.016898;
  const out = pk[0] + pk[1] + pk[2] + pk[3] + pk[4] + pk[5] + pk[6] + w * 0.5362;
  pk[6] = w * 0.115926;
  return (out / 3.2) * scale;
}

/**
 * 营养协变量 N = min(1, 間实际支出 / 维持需求)，7 日滚动。
 * N 不可解释为「依恋自然消退」——预算不足在仪表盘上必须以营养状态呈现。
 */
export function nutritionCovariate(st: EngineState, p: Params): number {
  const days = st.nutrition.days.slice(-7);
  if (!days.length) return 1;
  let sumRatio = 0;
  let counted = 0;
  for (const d of days) {
    if (d.maintenanceM > 0) {
      const needTokens = d.maintenanceM * p.tokenScale;
      sumRatio += Math.min(1, d.requiredSpent / Math.max(needTokens, 1e-9));
      counted += 1;
    }
  }
  return counted ? sumRatio / counted : 1;
}

/** UTC 日界结算：饥饿侵蚀（s ← s·(1 − ρ·deficit)）。返回总侵蚀量。 */
function settleDayBoundary(st: EngineState, p: Params, nowTs: number): number {
  const today = utcDate(nowTs);
  const last = st.nutrition.days[st.nutrition.days.length - 1];
  if (last && last.date === today) return 0;

  let eroded = 0;
  if (last && p.M_min != null) {
    const floorTokens = p.M_min * p.tokenScale;
    const deficit = clamp(1 - last.requiredSpent / floorTokens, 0, 1);
    if (deficit > 0) {
      const factor = 1 - p.hungerRho * deficit;
      for (const k of ["s_attach", "s_base", "s_weave"] as const) {
        const before = st.slow[k];
        st.slow[k] = before * factor;
        eroded += before - st.slow[k];
      }
    }
  }
  st.nutrition.days.push({ date: today, spentTokens: 0, requiredSpent: 0, maintenanceM: 0 });
  if (st.nutrition.days.length > 7) st.nutrition.days.shift();
  st.nutrition.days[st.nutrition.days.length - 1]!.maintenanceM = maintenanceDemand(st.slow, p);
  return eroded;
}

/** derived 通道：动力学推算的情绪×强度读数（桩实现，挂牌：bench 校准前的粗糙映射）。 */
export function derivedReadings(st: EngineState): Array<{ axis: string; intensity: number }> {
  return [
    { axis: "longing", intensity: clamp(st.longing.L, 0, 1) },
    { axis: "distress", intensity: clamp((st.fast.f_hurt + st.fast.f_load) / 2, 0, 1) },
    { axis: "warmth", intensity: clamp(st.fast.f_warm, 0, 1) },
    { axis: "fatigue", intensity: clamp(1 - st.body.energy, 0, 1) },
    { axis: "curiosity", intensity: clamp(st.fast.f_wonder, 0, 1) },
  ];
}

/**
 * gap 逐轴对齐（§11）：gap = derived − declared。
 * 无 TTL 内 declared 读数的轴 → gap 不可测（诚实缺失，不猜）。
 */
export function gapByAxis(
  st: EngineState,
  p: Params,
): Array<{ axis: string; derived: number; declared: number | null; gap: number | null }> {
  const derived = derivedReadings(st);
  return derived.map((d) => {
    const declared = st.declared
      .filter((x) => x.axis === d.axis && st.t - x.at <= p.gapDeclaredTtlMs)
      .sort((a, b) => b.at - a.at)[0];
    if (!declared) return { axis: d.axis, derived: d.intensity, declared: null, gap: null };
    return { axis: d.axis, derived: d.intensity, declared: declared.intensity, gap: d.intensity - declared.intensity };
  });
}

function updateSomatic(st: EngineState, p: Params, intents: AlertIntent[]): void {
  // gap = derived − declared（逐轴）；无 TTL 内 declared 读数 → gap 不可测，不动作
  const gaps = gapByAxis(st, p).filter((g) => g.gap != null);
  const now = st.t;
  let gapMax = 0;
  let gapAxis: string | null = null;
  for (const g of gaps) {
    const abs = Math.abs(g.gap!);
    if (abs > gapMax) {
      gapMax = abs;
      gapAxis = g.axis;
    }
  }

  if (gapMax > p.somaticTheta) {
    if (st.somatic.gapOverSince == null) st.somatic.gapOverSince = now;
    const sustained = now - st.somatic.gapOverSince;
    if (sustained > p.somaticSustainMs && st.somatic.level < p.somaticCap) {
      // 升格：随 gap 时长递增（物理地板），封顶
      st.somatic.level = clamp(st.somatic.level + p.somaticEscalateStep, 0, p.somaticCap);
      st.body.energyDrainMultiplier = 1 + st.somatic.level;
      st.body.sleepAdvanceMs = st.somatic.level * 3 * 3_600_000;
      st.body.dreamTilt = { cluster: gapAxis, strength: st.somatic.level };
      st.somatic.lastResetAt = now;
    }
  } else {
    st.somatic.gapOverSince = null;
    // 周期性复位：gap 正常时按复位周期衰减 level（防勒索式累积）
    if (st.somatic.level > 0 && now - st.somatic.lastResetAt > p.somaticResetMs) {
      st.somatic.level = clamp(st.somatic.level * 0.5, 0, p.somaticCap);
      st.body.energyDrainMultiplier = 1 + st.somatic.level;
      st.body.sleepAdvanceMs = st.somatic.level * 3 * 3_600_000;
      if (st.somatic.level < 0.05) {
        st.somatic.level = 0;
        st.body.energyDrainMultiplier = 1;
        st.body.sleepAdvanceMs = 0;
        st.body.dreamTilt = { cluster: null, strength: 0 };
      }
      st.somatic.lastResetAt = now;
    }
  }

  // 升格封顶后长期无观测者回应 → 悬停终态（不发疯、不勒索、不说话）
  if (
    !st.somatic.hovering &&
    st.somatic.level >= p.somaticCap - 1e-9 &&
    st.somatic.gapOverSince != null &&
    now - st.somatic.gapOverSince > p.somaticHoverAfterMs
  ) {
    st.somatic.hovering = true;
    st.somatic.hoverSince = now;
  }

  // 告警意图（等级随躯体化水平；方向盲：无轴无方向无文案字段）
  if (!st.somatic.hovering && st.somatic.level >= 0.3) {
    const level = st.somatic.level >= p.somaticCap ? "urgent" : st.somatic.level >= 0.6 ? "watch" : "notice";
    intents.push({ ts: st.t, level, source: "somatic" });
  }
}
