/**
 * 状态核心：fold(events)（技术文档 §2/§3）。
 *
 * 状态 = fold(events)。快照只是缓存，可随时重放重建。
 * 确定性承诺：同一事件流（按到达序 id 排列——与实时摄入顺序一致）+ 同一起点
 * → 逐位相同的状态序列（M0 验收）。ts 只驱动 tick 目标：未来事件先推进动力学，
 * 迟到事件不倒流时间线（applyEvent 单调时间）。
 */
import { applyEvent } from "./apply.js";
import { initialState, type EngineState } from "./state.js";
import { tickTo, type AlertIntent } from "./tick.js";
import type { StoredEvent, ContingencyEstimator } from "./events.js";

export interface FoldOptions {
  /** RNG 种子（缺省 0x50544853 = "PTHS"） */
  rngSeed?: number;
  contingency?: ContingencyEstimator;
  /** 起始状态（快照恢复时传入；缺省出厂态） */
  from?: EngineState;
}

export interface FoldRun {
  state: EngineState;
  /** 全程收集的告警意图（服务层负责节流与去重持久化） */
  alertIntents: AlertIntent[];
  /** 侵蚀总量（观测） */
  hungerErosion: number;
}

/** 规范序 = 到达序（id）：与实时摄入顺序一致，重放才可能与活状态逐位一致。 */
function sortEvents(events: StoredEvent[]): StoredEvent[] {
  return [...events].sort((a, b) => a.id - b.id);
}

/** 折叠事件流并推进时间至 untilMs（缺省最后事件时刻）。 */
export function fold(
  events: StoredEvent[],
  untilMs?: number,
  opts: FoldOptions = {},
): FoldRun {
  const sorted = sortEvents(events);
  const st = opts.from ?? initialState(sorted[0]?.ts ?? untilMs ?? 0, opts.rngSeed ?? 0x50544853);
  const intents: AlertIntent[] = [];
  let hungerErosion = 0;

  for (const ev of sorted) {
    // 折叠时刻优先于 ts：服务层入库时记录的 foldedAt（= 事件实际被折叠的位置）
    // 让重放复现 cron tick 的历史；无 foldedAt 的事件（合成夹具/旧流）退回 ts。
    const foldedAt = typeof ev.payload["foldedAt"] === "number" ? (ev.payload["foldedAt"] as number) : ev.ts;
    // 先把动力学推进到折叠时刻，再应用事件——顺序不可颠倒
    if (foldedAt > st.t) {
      const r = tickTo(st, foldedAt);
      intents.push(...r.alertIntents);
      hungerErosion += r.hungerErosion;
    }
    applyEvent(st, ev, opts.contingency);
  }
  const end = untilMs ?? st.t;
  if (end > st.t) {
    const r = tickTo(st, end);
    intents.push(...r.alertIntents);
    hungerErosion += r.hungerErosion;
  }
  return { state: st, alertIntents: intents, hungerErosion };
}

/** 全量重放（对账基准）。 */
export function fullReplay(
  events: StoredEvent[],
  untilMs?: number,
  opts: FoldOptions = {},
): FoldRun {
  return fold(events, untilMs, opts);
}
