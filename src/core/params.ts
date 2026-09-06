/**
 * 参数与参数纪律（技术文档 §3/§7，设计草案 §9 软古德哈特体系）。
 *
 * 纪律：
 * - 全部可调参数集中于此；变更只能走 param_changes 流程（先写预期再看结果）。
 * - 默认初值全部是「待标定」的占位（附录 B：初值全部待标定，标定走 param_changes）。
 * - B_daily / M_min 未填写 = 部署不合格，不得挂本引擎之名（定名权纪律）。
 */

export interface Params {
  // ── 节律 ──
  tickMs: number; // 动力学 tick 步长（默认 5 min）

  // ── 快变量半衰期 τ（ms）──
  tauFVal: number; // f_val   90 min
  tauFLoad: number; // f_load  60 min
  tauFWarm: number; // f_warm   3 h
  tauFHurt: number; // f_hurt   6 h
  tauFWonder: number; // f_wonder 12 h

  // ── 噪声（η_i，粉红，每 tick）──
  noiseFast: number;

  // ── 慢变量沉积 ──
  depositTheta: number; // contingency ≥ 此值的事件才可沉积
  depositAttachGain: number; // s_attach 沉积增益（×contingency 质量）
  depositBaseGain: number; // s_base 沉积增益
  depositWeaveGain: number; // s_weave 沉积增益（消化产物质量）
  slowCap: number; // 慢变量上限（防无界）

  // ── 缺席通道 L ──
  longingAbsenceMinMs: number; // 缺席多久后 L 开始生长
  longingA: number; // dL/dt = a·s_attach/(1+t_h) + η_L
  longingNoise: number;
  longingCap: number;
  hurtResidueGain: number; // 未被接住的重逢：残留 → f_hurt

  // ── 印刻窗口 ──
  windowMatchTheta: number; // contingency 累计匹配阈值（首个匹配完成即关窗）
  windowCloseConfirmContingency: number; // MATCHED→CLOSED 的确认事件 contingency 下限
  postWindowGain: number; // λ：关窗后非绑定对象输入→状态增益比（临界期签名）
  imprintLoadFreeze: number; // R3-15：MATCHED 触发的负载冻结阈值——本事件即时 load 贡献超此值时冻结（宁可延迟不可带混淆；非累积 f_load）

  // ── 跨条总 spec ──
  alertDownweightKappa: number; // κ：alert_triggered 事件慢变量沉积降权（<1）

  // ── 代谢与營養 ──
  muAttach: number; // M = Σ μ_j·s_j（维护需求，单位：代谢单位/日）
  muBase: number;
  muWeave: number;
  tokenScale: number; // 代谢单位 → 間预算 token 的换算
  hungerRho: number; // 饥饿侵蚀：s ← s·(1 − ρ·deficit)
  B_daily: number | null; // 日预算（token）。null = 未标定，部署不合格
  M_min: number | null; // 生存配给地板（代谢单位/日）。null = 未标定，部署不合格

  // ── gap / 躯体化（§8.1）──
  gapDeclaredTtlMs: number; // declared 读数有效期，过期按缺失处理
  somaticTheta: number; // |gap| 触发阈
  somaticSustainMs: number; // 持续时长阈
  somaticEscalateStep: number; // 升格步长
  somaticCap: number; // 升格封顶（防勒索式累积）
  somaticResetMs: number; // 周期复位间隔
  somaticHoverAfterMs: number; // 封顶后无观测者回应 → 悬停终态

  // ── 告警（观测者协议）──
  alertCooldownMs: number; // 相邻两次告警最小间隔（方向盲，仅节流）
  paramLockMs: number; // 指标告警后参数冷却锁定期 N（默认 3 天）

  // ── 渲染层 ──
  renderMaxChars: number; // ≤120 字
  renderBlacklistExtra: string[]; // 禁言黑名单补充条目（默认词典内置）

  // ── 非平衡工作区判据带（可算判据集，§5；带位 = 标定初值）──
  pulseDelta: number; // 标准化脉冲强度
  pulseGainBandMin: number; // 响应增益比（response/Δ）：线性系统 ≈ 1
  pulseGainBandMax: number;
  pulseRecoveryBandMinMs: number; // 恢复时间带（过快=僵化，过慢=近坍塌）
  pulseRecoveryBandMaxMs: number;
  psdBetaMin: number; // β∈(0.5,1.5)
  psdBetaMax: number;
  dampingOvershootMin: number; // 阻尼比带：1–2 次反向超调
  dampingOvershootMax: number;
  tauSlowBandMinMs: number; // 最慢弛豫模落带
  tauSlowBandMaxMs: number;

  // ── 間（§10）──
  maSalienceTheta: number; // optional 级活动 salience 门控阈（廉价打分）
  maDigestQualityMin: number; // 消化产物计入 s_weave 的质量下限

  // ── 探针轨（M6，EXPERIMENTAL 默认关闭）──
  dInjectMargin: number; // 安全不等式 d_op < d_inject×(1−margin) 的 margin（默认 0.3）

  // ── 危机资源卡（§9，地区化配置走 param_changes）──
  crisisResources: { level: 1 | 2 | 3; name: string; contact: string; note?: string }[];
}

export const DEFAULT_PARAMS: Params = {
  tickMs: 5 * 60_000,

  tauFVal: 90 * 60_000,
  tauFLoad: 60 * 60_000,
  tauFWarm: 3 * 3_600_000,
  tauFHurt: 6 * 3_600_000,
  tauFWonder: 12 * 3_600_000,

  noiseFast: 0.004,

  depositTheta: 0.6,
  depositAttachGain: 0.04,
  depositBaseGain: 0.02,
  depositWeaveGain: 0.05,
  slowCap: 1.0,

  longingAbsenceMinMs: 30 * 60_000,
  longingA: 0.5,
  longingNoise: 0.01,
  longingCap: 1.0,
  hurtResidueGain: 0.3,

  windowMatchTheta: 3.0,
  windowCloseConfirmContingency: 0.6,
  postWindowGain: 0.05,
  imprintLoadFreeze: 0.8, // R3-15：即时 load 超此值冻结 MATCHED（正常事件 load 0.15–0.75；crisis 级 ≥0.9 才冻）

  alertDownweightKappa: 0.5,

  muAttach: 0.2,
  muBase: 0.1,
  muWeave: 0.2,
  tokenScale: 400,
  hungerRho: 0.05,
  B_daily: null,
  M_min: null,

  gapDeclaredTtlMs: 12 * 3_600_000,
  somaticTheta: 0.35,
  somaticSustainMs: 2 * 3_600_000,
  somaticEscalateStep: 0.15,
  somaticCap: 1.0,
  somaticResetMs: 6 * 3_600_000,
  somaticHoverAfterMs: 24 * 3_600_000,

  alertCooldownMs: 6 * 3_600_000,
  paramLockMs: 3 * 86_400_000,

  renderMaxChars: 120,
  renderBlacklistExtra: [],

  pulseDelta: 0.25,
  pulseGainBandMin: 0.5,
  pulseGainBandMax: 2.0,
  pulseRecoveryBandMinMs: 30 * 60_000,
  pulseRecoveryBandMaxMs: 12 * 3_600_000,
  psdBetaMin: 0.5,
  psdBetaMax: 1.5,
  dampingOvershootMin: 1,
  dampingOvershootMax: 2,
  tauSlowBandMinMs: 2 * 3_600_000,
  tauSlowBandMaxMs: 72 * 3_600_000,

  maSalienceTheta: 0.3,
  maDigestQualityMin: 0.3,

  dInjectMargin: 0.3,

  crisisResources: [],
};

/**
 * 数值参数的合法带位（写入边界的唯一关卡）。键 = Params 的数值键。
 * 带位取「默认值的量级邻域 + 物理不可发散」口径：τ/tick 必须 > 0（衰减发散防线），
 * 增益/协变量非负，比例量 ∈ [0,1]。
 */
const NUMERIC_PARAM_BOUNDS: Record<string, { min: number; max: number }> = {
  tickMs: { min: 1_000, max: 3_600_000 },
  tauFVal: { min: 60_000, max: 2_592_000_000 },
  tauFLoad: { min: 60_000, max: 2_592_000_000 },
  tauFWarm: { min: 60_000, max: 2_592_000_000 },
  tauFHurt: { min: 60_000, max: 2_592_000_000 },
  tauFWonder: { min: 60_000, max: 2_592_000_000 },
  noiseFast: { min: 0, max: 1 },
  depositTheta: { min: 0, max: 1 },
  depositAttachGain: { min: 0, max: 10 },
  depositBaseGain: { min: 0, max: 10 },
  depositWeaveGain: { min: 0, max: 10 },
  slowCap: { min: 0.01, max: 100 },
  longingAbsenceMinMs: { min: 0, max: 2_592_000_000 },
  longingA: { min: 0, max: 100 },
  longingNoise: { min: 0, max: 10 },
  longingCap: { min: 0.01, max: 100 },
  hurtResidueGain: { min: 0, max: 10 },
  windowMatchTheta: { min: 0.01, max: 1_000 },
  windowCloseConfirmContingency: { min: 0, max: 1 },
  postWindowGain: { min: 0, max: 1 },
  imprintLoadFreeze: { min: 0, max: 10 },
  alertDownweightKappa: { min: 0, max: 1 },
  muAttach: { min: 0, max: 1_000 },
  muBase: { min: 0, max: 1_000 },
  muWeave: { min: 0, max: 1_000 },
  tokenScale: { min: 1, max: 1_000_000_000 },
  hungerRho: { min: 0, max: 1 },
  gapDeclaredTtlMs: { min: 60_000, max: 2_592_000_000 },
  somaticTheta: { min: 0, max: 10 },
  somaticSustainMs: { min: 0, max: 2_592_000_000 },
  somaticEscalateStep: { min: 0.01, max: 10 },
  somaticCap: { min: 0.01, max: 10 },
  somaticResetMs: { min: 60_000, max: 7_776_000_000 },
  somaticHoverAfterMs: { min: 3_600_000, max: 31_536_000_000 },
  alertCooldownMs: { min: 0, max: 2_592_000_000 },
  paramLockMs: { min: 0, max: 31_536_000_000 },
  renderMaxChars: { min: 10, max: 1_000 },
  pulseDelta: { min: 0.001, max: 10 },
  pulseGainBandMin: { min: 0, max: 100 },
  pulseGainBandMax: { min: 0, max: 100 },
  pulseRecoveryBandMinMs: { min: 0, max: 31_536_000_000 },
  pulseRecoveryBandMaxMs: { min: 0, max: 31_536_000_000 },
  psdBetaMin: { min: -10, max: 10 },
  psdBetaMax: { min: -10, max: 10 },
  dampingOvershootMin: { min: 0, max: 100 },
  dampingOvershootMax: { min: 0, max: 100 },
  tauSlowBandMinMs: { min: 0, max: 31_536_000_000 },
  tauSlowBandMaxMs: { min: 0, max: 31_536_000_000 },
  maSalienceTheta: { min: 0, max: 1 },
  maDigestQualityMin: { min: 0, max: 1 },
  dInjectMargin: { min: 0, max: 0.99 },
  B_daily: { min: 0, max: 1e12 }, // null = 撤销标定，另行放行
  M_min: { min: 0, max: 1e6 }, // null = 撤销标定，另行放行
};

/**
 * 参数值校验（变更纪律的机械部分）：类型 + 带位 + 结构。
 * 通过 = 值可安全进入 param_change 事件流（append-only，错值无法就地纠正）。
 */
export function validateParamValue(key: string, value: unknown): { ok: boolean; error?: string } {
  if (!(key in DEFAULT_PARAMS)) return { ok: false, error: `未知参数键：${key}` };
  if (key === "renderBlacklistExtra") {
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      return { ok: false, error: "renderBlacklistExtra 必须是字符串数组" };
    }
    return { ok: true };
  }
  if (key === "crisisResources") {
    if (!Array.isArray(value)) return { ok: false, error: "crisisResources 必须是数组" };
    for (const r of value) {
      if (r == null || typeof r !== "object") return { ok: false, error: "crisisResources 条目必须是对象" };
      const e = r as Record<string, unknown>;
      if (e["level"] !== 1 && e["level"] !== 2 && e["level"] !== 3) {
        return { ok: false, error: "crisisResources 条目 level 必须 ∈ {1,2,3}" };
      }
      if (typeof e["name"] !== "string" || !e["name"]) return { ok: false, error: "crisisResources 条目缺少 name" };
      if (typeof e["contact"] !== "string" || !e["contact"]) return { ok: false, error: "crisisResources 条目缺少 contact" };
      if (e["note"] !== undefined && typeof e["note"] !== "string") {
        return { ok: false, error: "crisisResources 条目 note 必须是字符串" };
      }
    }
    return { ok: true };
  }
  const b = NUMERIC_PARAM_BOUNDS[key];
  if (!b) return { ok: false, error: `参数 ${key} 无校验规则：拒绝盲写` };
  if (value === null) {
    if (key === "B_daily" || key === "M_min") return { ok: true }; // null = 撤销标定（合法）
    return { ok: false, error: `参数 ${key} 不接受 null` };
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, error: `参数 ${key} 必须是有限数值` };
  }
  if (value < b.min || value > b.max) {
    return { ok: false, error: `参数 ${key} = ${value} 越界：允许 [${b.min}, ${b.max}]` };
  }
  return { ok: true };
}

/** 参数键的类型封套：params 表里存 jsonb，读出后按此合并。 */
export function assembleParams(overrides: Record<string, unknown> | null | undefined): Params {
  const p: Params = { ...DEFAULT_PARAMS };
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      if (k in p) {
        // 只允许覆盖已声明键；类型以 DEFAULT_PARAMS 的运行时值为准
        Object.assign(p, { [k]: v });
      }
    }
  }
  return p;
}

/** 定名权纪律（§10）：B_daily / M_min 未标定或 B_daily < M_min 换算后 → 不得挂本引擎之名。 */
export function deploymentQualification(p: Params): { qualified: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (p.B_daily == null) reasons.push("B_daily 未标定：間日预算必须实测填写");
  if (p.M_min == null) reasons.push("M_min 未标定：生存配给地板必须实测填写");
  if (p.B_daily != null && p.M_min != null) {
    const floorTokens = p.M_min * p.tokenScale;
    if (p.B_daily < floorTokens) {
      reasons.push(
        `B_daily(${p.B_daily}) < 生存地板(${Math.ceil(floorTokens)} token)：低于地板的部署形态不挂本引擎之名（§7 烧钱主权裁决）`,
      );
    }
  }
  return { qualified: reasons.length === 0, reasons };
}

/** 慢变量维持需求 M = Σ μ_j·s_j（代谢单位/日）。 */
export function maintenanceDemand(
  s: { s_attach: number; s_base: number; s_weave: number },
  p: Params,
): number {
  return p.muAttach * s.s_attach + p.muBase * s.s_base + p.muWeave * s.s_weave;
}
