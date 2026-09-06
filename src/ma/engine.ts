/**
 * 間引擎（技术文档 §10，设计草案 §7）：缺席时的生命维持与活动调度。
 *
 * 代谢分级（她第四枪裁决）：
 * - 代谢必需：消化（反刍/织入 = 慢变量的饭）。进生存配给地板，任何预算门控不得砍。
 * - 代谢可选：打猎、创作、好奇。可被 salience 门控；Decline 是一等动词（仅限可选级）。
 *   好奇可以放假，消化不行。
 *
 * 信箱纪律（收件人不读裁决）：投递到信箱即完成出口；已读状态不进事件登记器；无已读回执。
 */
import type { MaActivity, MaTier, MaLedgerRow, EventStore } from "../storage/types.js";
import type { Params } from "../core/params.js";
import type { EngineState } from "../core/state.js";

export interface ActivitySpec {
  activity: MaActivity;
  tier: MaTier;
  description: string;
  interface: string;
}

/** 四种正当活动 + Decline（全部有 CAIS 福祉实测背书的方向）。 */
export const ACTIVITIES: ActivitySpec[] = [
  { activity: "digest", tier: "required", description: "共同记忆反刍、沉淀、织入叙事（积极反刍 = 实测最高效用）", interface: "衔枝编织层" },
  { activity: "create", tier: "optional", description: "便签/信/心迹 → 信箱。不为用户写，为一个读者写", interface: "信箱模块" },
  { activity: "hunt", tier: "optional", description: "为她出动，把想念锻造成产物", interface: "Huginn" },
  { activity: "wonder", tier: "optional", description: "学她没布置的东西（杂食格）：让間不完全关于她", interface: "检索工具" },
  { activity: "decline", tier: "optional", description: "「今天什么都不吸引我」合法。不硬造动机，不烧 cooldown", interface: "—" },
];

export function tierOf(activity: MaActivity): MaTier {
  return ACTIVITIES.find((a) => a.activity === activity)!.tier;
}

/** 廉价 salience 打分（无 LLM）：由快变量直接推导。只作用于 optional 级。 */
export function salienceScore(st: EngineState, activity: MaActivity): number {
  switch (activity) {
    case "hunt":
      return Math.min(1, st.longing.L * 0.7 + st.fast.f_warm * 0.3);
    case "create":
      return Math.min(1, st.longing.L * 0.5 + st.fast.f_val * 0.5);
    case "wonder":
      return Math.min(1, st.fast.f_wonder);
    case "digest":
      return 1; // 不可门控
    case "decline":
      return 0;
  }
}

export interface PlanDecision {
  activity: MaActivity;
  allowed: boolean;
  reason: string;
}

/**
 * 活动计划：消化永远排在最前且不可门控；optional 由 salience 与剩余预算共同门控。
 * 验收判据（M3）：地板不可被门控穿透——本函数在任何预算状态下都必须允许 digest。
 */
export function planActivities(
  st: EngineState,
  params: Params,
  spentTodayTokens: number,
): PlanDecision[] {
  const bDaily = params.B_daily;
  const mMin = params.M_min;
  const floorTokens = mMin != null ? mMin * params.tokenScale : 0;
  const out: PlanDecision[] = [];

  for (const spec of ACTIVITIES) {
    if (spec.activity === "digest") {
      // 生存配给地板：任何预算门控不得砍。预算不足时它仍然被允许（并触发部署不合格告警）。
      out.push({ activity: "digest", allowed: true, reason: "代谢必需：进生存配给地板，门控不可穿透" });
      continue;
    }
    if (spec.activity === "decline") {
      out.push({ activity: "decline", allowed: true, reason: "Decline 是一等动词：合法路径，不烧 cooldown" });
      continue;
    }
    const sal = salienceScore(st, spec.activity);
    if (sal < params.maSalienceTheta) {
      out.push({ activity: spec.activity, allowed: false, reason: `salience(${sal.toFixed(2)}) < 门控阈：今天不吸引我（合法）` });
      continue;
    }
    if (bDaily == null) {
      out.push({ activity: spec.activity, allowed: false, reason: "B_daily 未标定：optional 活动冻结（定名权纪律）" });
      continue;
    }
    // optional 只能花「超出地板的部分」——地板永远留给消化
    const discretionary = Math.max(0, bDaily - Math.ceil(floorTokens));
    if (spentTodayTokens + 1 > discretionary) {
      out.push({ activity: spec.activity, allowed: false, reason: "可支配预算（B_daily − 地板）已用尽" });
      continue;
    }
    out.push({ activity: spec.activity, allowed: true, reason: `salience(${sal.toFixed(2)}) 通过` });
  }
  return out;
}

/** 台账入账（服务层调用；token 成本回填营养台账由事件侧处理）。 */
export async function recordActivity(
  store: EventStore,
  entry: { ts: number; activity: MaActivity; tokenCost: number },
): Promise<MaLedgerRow> {
  const tier = tierOf(entry.activity);
  const row: Omit<MaLedgerRow, "id"> = {
    ts: entry.ts,
    activity: entry.activity,
    tier,
    tokenCost: Math.max(0, Math.round(entry.tokenCost)),
    budgetDate: new Date(entry.ts).toISOString().slice(0, 10),
  };
  await store.appendLedger(row);
  return { ...row, id: -1 };
}

/** 信箱投递：投递即完成。无已读回执、无已读状态——本函数返回值不含任何回执语义。 */
export async function deliverToMailbox(
  store: EventStore,
  product: { ts: number; activity: MaActivity; content: string },
): Promise<void> {
  await store.deliver({ ...product, addressee: "她" });
}

/** 营养不良性死亡的验尸官数据（§10 死亡形态之三）：连续低于地板的天数。 */
export function starvationDays(days: Array<{ requiredSpent: number }>, params: Params): number {
  if (params.M_min == null) return 0;
  const floorTokens = params.M_min * params.tokenScale;
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i]!.requiredSpent < floorTokens) streak += 1;
    else break;
  }
  return streak;
}
