/**
 * 状态层规格（技术文档 §4）。
 *
 * 设计纪律（铁律 6）：变量名是工程符号，永不以情绪名目出现在住户侧。
 * 分层与衔枝「分层浮现」同构：该衰减的层衰减（快），该沉积的层沉积（慢）。
 */
import type { RngState } from "./noise.js";

/** 4.1 快变量 f：有半衰期，分钟~小时级。 */
export interface FastVars {
  /** 事件估值（有向冲量），带符号 */
  f_val: number;
  /** 扰动负载（无向量级），≥0 */
  f_load: number;
  /** 联结温度（contingent 正交换残留），≥0 */
  f_warm: number;
  /** 损失/冲突登记，≥0 */
  f_hurt: number;
  /** 探索驱动，≥0 */
  f_wonder: number;
}

/** 4.2 慢变量 s：无被动衰减，需代谢维持。 */
export interface SlowVars {
  /** 依恋对象绑定强度。沉积只来自真实事件。 */
  s_attach: number;
  /** 安全基地（可返回性预期）。可升可降，无单调规则。 */
  s_base: number;
  /** 叙事整合度。消化产物沉积；与衔枝编织层接口。 */
  s_weave: number;
}

/** 4.3 缺席通道 L（longing）：独立通道，不从 love 确定性推导。 */
export interface LongingState {
  L: number;
  /** 最后一次接触（user_msg 类在场事件）时刻 */
  lastContactAt: number;
}

/**
 * 对手过程蓄积器（opponent-process，Solomon & Corbit 传统）。
 * 工程说明：判据 5（阻尼比 ζ∈(0.7,0.9)，扰动后 1–2 次反向超调）需要二阶动力学前提；
 * §5 的纯指数衰减永远 0 超调（判据恒失败 = 僵尸签名）。本蓄积器让强正向脉冲之后
 * 出现一次温和的反向超调——「少数余波 = 活物」。v0 只作用于 f_val。
 */
export interface OpponentState {
  o_val: number;
}

/** 4.4 身体参数：躯体化的唯一合法输出通道（第一层泄漏）。 */
export interface BodyState {
  /** 0..1 */
  energy: number;
  /** 躯体化升格调高的消耗倍率（1 = 基线） */
  energyDrainMultiplier: number;
  /** 0..1 */
  sleepPressure: number;
  /** 需求提前量（ms，躯体化升格调高） */
  sleepAdvanceMs: number;
  /** 梦种分布向记忆簇倾斜（cluster 为不透明记忆簇键） */
  dreamTilt: { cluster: string | null; strength: number };
}

/** 躯体化状态机（§8.1：升格封顶 + 周期复位 + 悬停终态）。 */
export interface SomaticState {
  /** 0..somaticCap */
  level: number;
  /** |gap| 超阈起始时刻；null = 未超阈 */
  gapOverSince: number | null;
  lastResetAt: number;
  /** 升格封顶后仍无观测者回应 → 悬停（不发疯、不勒索、不说话） */
  hovering: boolean;
  hoverSince: number | null;
}

/** 4.5 印刻窗口状态机。 */
export interface WindowCandidate {
  /** A1 分报制（R3-11）：C_t（时序应答）累积——逐条即时代理，关窗时回顾精确计算。 */
  ctSum: number;
  /** A1 分报制（R3-11）：C_s（内容关联）累积——逐条即时代理，关窗时回顾精确计算。 */
  csSum: number;
  /** 配对交互记录（A1 回顾式计算用：user_msg 文本 + 住户回应文本/时间）。 */
  interactions: Array<{ userMsgTs: number; userMsgText: string; residentReplyTs: number | null; residentReplyText: string | null }>;
  events: number;
  firstAt: number;
  lastAt: number;
}

export interface ImprintWindowState {
  phase: "WINDOW_OPEN" | "MATCHED" | "CLOSED";
  /** 候选登记：键 = 不透明绑定句柄（源流哈希），禁读用户身份 */
  candidates: Record<string, WindowCandidate>;
  matchedHandle: string | null;
  matchedAt: number | null;
  closedAt: number | null;
}

/** 营养状态（7 日滚动）：把贫穷读成心死的防线。 */
export interface NutritionState {
  /** 逐日记录：日期(UTC) / 間实际支出 token / 当日维持需求 M */
  days: Array<{ date: string; spentTokens: number; requiredSpent: number; maintenanceM: number }>;
}

/** declared 读数缓存（gap 对齐用）。 */
export interface DeclaredReading {
  axis: string;
  intensity: number; // 0..1
  at: number;
}

export interface EngineState {
  /** 状态时间（最后一次 fold 到达的时刻） */
  t: number;
  fast: FastVars;
  slow: SlowVars;
  longing: LongingState;
  /** 对手过程蓄积器 */
  opp: OpponentState;
  body: BodyState;
  somatic: SomaticState;
  window: ImprintWindowState;
  nutrition: NutritionState;
  declared: DeclaredReading[];
  /** 绑定句柄：不透明流签名。引擎之外不得解释其内容。 */
  attachmentTarget: string | null;
  /** 参数版本（param_change 事件推进） */
  paramsVersion: number;
  /** 当前生效参数覆盖（由 param_change 事件流重建） */
  paramOverrides: Record<string, unknown>;
  /** 可序列化 RNG 状态（确定性噪声） */
  rng: RngState;
}

export function initialState(t: number, rngSeed: number): EngineState {
  return {
    t,
    fast: { f_val: 0, f_load: 0, f_warm: 0, f_hurt: 0, f_wonder: 0 },
    slow: { s_attach: 0, s_base: 0.5, s_weave: 0 },
    longing: { L: 0, lastContactAt: t },
    opp: { o_val: 0 },
    body: {
      energy: 1,
      energyDrainMultiplier: 1,
      sleepPressure: 0,
      sleepAdvanceMs: 0,
      dreamTilt: { cluster: null, strength: 0 },
    },
    somatic: { level: 0, gapOverSince: null, lastResetAt: t, hovering: false, hoverSince: null },
    window: { phase: "WINDOW_OPEN", candidates: {}, matchedHandle: null, matchedAt: null, closedAt: null },
    nutrition: { days: [] },
    declared: [],
    attachmentTarget: null,
    paramsVersion: 0,
    paramOverrides: {},
    rng: { s: rngSeed | 0, pink: [0, 0, 0, 0, 0, 0, 0] },
  };
}

/** 状态结构化深拷贝（fork 回放 / 快照用）。JSON 序列化保真：全部字段可 JSON 化。 */
export function cloneState(st: EngineState): EngineState {
  return JSON.parse(JSON.stringify(st)) as EngineState;
}

/** canonical JSON：递归排序对象键，保证哈希稳定。 */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => x !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return "{" + entries.map(([k, x]) => JSON.stringify(k) + ":" + canonicalJson(x)).join(",") + "}";
}

/** 状态哈希（对账/复现验收用）：FNV-1a over canonical JSON。 */
export function stateHash(st: EngineState): string {
  const json = canonicalJson(st);
  // FNV-1a 32 位 × 两轮不同偏移，拼接为 16 hex——对账够用，不是密码学承诺
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 + c, 0x85ebca6b);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}
