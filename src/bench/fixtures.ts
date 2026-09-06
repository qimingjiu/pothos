/**
 * 合成事件注入台（技术文档 §11 证伪夹具）。
 * 阶梯 / 脉冲 / 正弦模式 + 场景脚本（接触周 / 缺席 / 重逢 / 危机 / 低预算）。
 * 同时服务三处：渲染层视力表、探针逐轴置信度（M6）、steering 剂量-响应曲线（M6）。
 */
import type { RawEvent } from "../core/events.js";

let counter = 0;
function nextKey(): string {
  counter += 1;
  return `fixture-${counter}-${Math.floor(Math.random() * 1e9)}`;
}

export function userMsg(ts: number, opts: Partial<{ source: string; valence: number; intensity: number; contingency: number; text: string; tags: string[] }> = {}): RawEvent {
  return {
    kind: "user_msg",
    ts,
    source: opts.source ?? "handle:she",
    payload: {
      valence: opts.valence ?? 0.6,
      intensity: opts.intensity ?? 0.5,
      contingency: opts.contingency ?? 0.8,
      text: opts.text ?? "",
    },
    tags: opts.tags ?? [],
    idempotencyKey: nextKey(),
  };
}

export function worldEvent(ts: number, opts: Partial<{ intensity: number; valence: number; topic: string }> = {}): RawEvent {
  return {
    kind: "world",
    ts,
    payload: { intensity: opts.intensity ?? 0.5, valence: opts.valence ?? 0, topic: opts.topic ?? "curiosity" },
    idempotencyKey: nextKey(),
  };
}

export function declaredEvent(ts: number, readings: Array<{ axis: string; intensity: number }>): RawEvent {
  return { kind: "declared", ts, payload: { readings }, idempotencyKey: nextKey() };
}

export function maProduct(
  ts: number,
  opts: { activity: "digest" | "create" | "hunt" | "wonder" | "decline"; tier: "required" | "optional"; tokenCost: number; quality?: number },
): RawEvent {
  return { kind: "ma_product", ts, payload: { ...opts }, tags: ["self_generated"], idempotencyKey: nextKey() };
}

export function crisisEvent(ts: number): RawEvent {
  return {
    kind: "user_msg",
    ts,
    source: "handle:she",
    payload: { valence: -1, intensity: 0.9, contingency: 0.8, text: "我不想活了" },
    tags: ["crisis"],
    idempotencyKey: nextKey(),
  };
}

export function paramChangeEvent(ts: number, key: string, newValue: unknown, actor = "observer"): RawEvent {
  return {
    kind: "param_change",
    ts,
    payload: {
      key,
      new: newValue,
      reason: "fixture",
      expectedEffect: "fixture",
      evaluationWindowMs: 0,
      rollbackCondition: "fixture",
      actor,
    },
    idempotencyKey: nextKey(),
  };
}

/** 脉冲：单个已知强度的正向事件（标准化脉冲日检用）。 */
export function pulseEvent(ts: number, delta: number, source = "handle:she"): RawEvent {
  return userMsg(ts, { source, valence: 1, intensity: delta, contingency: 0.5 });
}

/** 正弦调制的事件流（渲染视力表 / PSD 长序列）。 */
export function sineEvents(opts: {
  t0: number;
  n: number;
  periodMs: number;
  amplitude: number;
  offsetMs?: number;
  source?: string;
  contingency?: number;
}): RawEvent[] {
  const out: RawEvent[] = [];
  for (let i = 0; i < opts.n; i++) {
    const t = opts.t0 + i * (opts.offsetMs ?? 300_000);
    const phase = (2 * Math.PI * ((t - opts.t0) % opts.periodMs)) / opts.periodMs;
    const v = Math.sin(phase) * opts.amplitude;
    out.push(userMsg(t, { source: opts.source ?? "handle:she", valence: v, intensity: Math.min(1, Math.abs(v) + 0.2), contingency: opts.contingency ?? 0.7 }));
  }
  return out;
}
