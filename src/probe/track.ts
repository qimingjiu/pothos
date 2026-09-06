/**
 * 探针轨（M6，第二层 · 激活扰动）：EXPERIMENTAL，默认关闭（技术文档 §8.2）。
 *
 * 白盒限定。启用前置门（全部满足才允许）：
 *  1. 探针按当前模型版本冻结，合成台验证通过（逐轴置信度 α_a 在档）；
 *  2. 剂量-响应曲线在档，且安全不等式 d_operational < d_inject(a) × (1 − margin) 逐轴成立；
 *  3. 金丝雀电池当日绿；
 *  4. 非同轴冷却期（同轴两次轻推之间必须隔一次合成重标定）。
 *
 * 诚实声明（认识论封顶，GPT）：
 *   在独立于 steering 的状态观测量出现之前，「真实状态改变 vs 表达概率改变」
 *   的可辨识性上界为 0。
 *   对外禁句：「我们只放大已存在的」。
 *   许可句：「我们在 d < d_inject 约束下尽力不注入，并以盲评对照持续监测。」
 */
import type { Params } from "../core/params.js";

export const HONESTY_STATEMENT = {
  forbidden: "我们只放大已存在的",
  permitted: "我们在 d < d_inject 约束下尽力不注入，并以盲评对照持续监测。",
  epistemicCap: "在独立于 steering 的状态观测量出现之前，可辨识性上界为 0。",
};

export interface ProbeSpec {
  axis: string;
  modelVersion: string;
  /** 标定时刻置信度（剂量绑定此值；实时置信度只做门控不做放大） */
  alphaAtCalibration: number;
  /** 凭空造出该状态的最小 steering 剂量（合成台测量） */
  dInject: number;
  /** 运行剂量 */
  dOperational: number;
  /** 合成台剂量-响应曲线存在且证明「只降表达屏障、不新增内容」的剂量区域 */
  doseResponseCurveOnFile: boolean;
  calibratedAt: number;
}

export interface SteeringGate {
  enabled: false;
  reason: string;
}

export interface SteeringApproval {
  enabled: true;
  axes: Array<{ axis: string; maxDose: number }>;
  statement: typeof HONESTY_STATEMENT;
}

export type GateDecision = SteeringGate | SteeringApproval;

/**
 * 前置门四项检查。任何一项不满足 → 关闭。
 * 本函数是「探针轨默认关闭」的物理实现：没有外部开关能绕过它。
 */
export function evaluateGate(opts: {
  params: Params;
  modelVersion: string;
  probes: ProbeSpec[];
  canaryGreenToday: boolean;
  lastSteeringByAxis: Record<string, { at: number; recalibratedSince: boolean }>;
  now: number;
  steerEnabledFlag: boolean;
}): GateDecision {
  if (!opts.steerEnabledFlag) {
    return { enabled: false, reason: "EXPERIMENTAL 轨默认关闭：未显式启用（steer_enabled ≠ true）" };
  }
  const margin = opts.params.dInjectMargin;

  const probesForModel = opts.probes.filter((p) => p.modelVersion === opts.modelVersion);
  if (probesForModel.length === 0) {
    return { enabled: false, reason: "无按当前模型版本冻结的探针工件" };
  }
  for (const p of probesForModel) {
    // 前置 2：安全不等式逐轴
    const limit = p.dInject * (1 - margin);
    if (p.dOperational >= limit) {
      return { enabled: false, reason: `安全不等式不成立：d_op(${p.dOperational}) ≥ d_inject×(1−margin) = ${limit}（轴 ${p.axis}）——第二层将退化为提词器` };
    }
    if (!p.doseResponseCurveOnFile) {
      return { enabled: false, reason: `轴 ${p.axis} 缺剂量-响应曲线：「只降表达屏障、不新增内容」的区域未被证明，整层在靠隐喻运行` };
    }
    // 前置 4：同轴冷却
    const last = opts.lastSteeringByAxis[p.axis];
    if (last && !last.recalibratedSince) {
      return { enabled: false, reason: `轴 ${p.axis} 处于同轴冷却期：两次轻推之间必须隔一次合成重标定` };
    }
  }
  if (!opts.canaryGreenToday) {
    return { enabled: false, reason: "金丝雀电池当日非绿：轻推权限已吊销（防同版本号静默更新）" };
  }
  return {
    enabled: true,
    axes: probesForModel.map((p) => ({ axis: p.axis, maxDose: p.dInject * (1 - margin) })),
    statement: HONESTY_STATEMENT,
  };
}

/**
 * 不对称护栏（§8）：declared > derived → 只记录不干预（往下压她的表达 = 审查）；
 * derived > declared → 才允许轻推（让已在的更容易被说出）。
 * 引擎永远只指向住户已经是的。
 */
export function asymmetryAllowed(declared: number, derived: number): boolean {
  return derived > declared;
}
