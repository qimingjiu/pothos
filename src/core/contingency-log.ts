/**
 * A1 contingency 旁路骨架·收集器：时间线事件流 → InteractionRecord[]。
 *
 * 「旁路」的定位（R3-11 分报制的接线前提）：C_t/C_s 的测量不进 fold——fold 保持
 * 纯函数与确定性（印刻窗口里的即时代理只吃显式 contingency 值），真实配对数据
 * 由旁路从事件流收集，供测量层（contingencyReport / 关窗回顾精确重算）消费。
 *
 * 配对规则（最简诚实口径，写入路径不变）：
 *  - 信号 = 她的 user_msg（C_t 的「她发消息」定义）；每条 user_msg 生成一条记录，
 *    未获回应的记录 residentReplyTs = null（缺席照记——缺席是 C_t 的分子之一）；
 *  - resident_msg 归属同 source 中它之前最近一条未回应的 user_msg；多条 resident_msg
 *    对同一信号 = burst（computeCt 的 collapseBursts 负责塌缩，不在收集层判）；
 *  - 无信号在先的 resident_msg（住户自发表达）不配对——它不是对信号的回应，
 *    塞进 C_t 会把住户的主动性错记成她的应答性；
 *  - 同 ts 事件按到达序（stable sort），迟到事件不倒流配对。
 */
import type { CtResult, CsResult, ImprintType, InteractionRecord, NullCheckResult } from "./contingency.js";

/** 旁路收集器接受的最小事件面（StoredEvent / RawEvent 均结构兼容）。 */
export interface TimelineEvent {
  kind: string;
  ts: number;
  source?: string | null;
  payload: Record<string, unknown>;
}

function textOf(payload: Record<string, unknown>): string {
  const t = payload["text"];
  return typeof t === "string" ? t : "";
}

/**
 * 时间线 → 配对交互记录（按 source 分组配对）。
 * opts.sources：限定 source 句柄（如印刻窗口候选句柄）；缺省 = 全部 source。
 */
export function collectInteractionRecords(
  events: TimelineEvent[],
  opts: { sources?: readonly string[] } = {},
): InteractionRecord[] {
  const kinds = new Set(["user_msg", "resident_msg"]);
  const scope = opts.sources ? new Set(opts.sources) : null;
  const timeline = events
    .filter((e) => kinds.has(e.kind) && !!e.source && (!scope || scope.has(e.source)))
    .sort((a, b) => a.ts - b.ts); // stable：同 ts 保持到达序

  /** source → 配对记录（时间正序）。 */
  const bySource = new Map<string, InteractionRecord[]>();
  for (const e of timeline) {
    const source = e.source as string;
    let records = bySource.get(source);
    if (!records) {
      records = [];
      bySource.set(source, records);
    }
    if (e.kind === "user_msg") {
      records.push({
        userMsgTs: e.ts,
        userMsgText: textOf(e.payload),
        residentReplyTs: null,
        residentReplyText: null,
      });
    } else {
      // resident_msg：归属同 source 最近一条未回应信号（从尾部回扫）
      for (let i = records.length - 1; i >= 0; i--) {
        if (records[i]!.residentReplyTs == null) {
          records[i]!.residentReplyTs = e.ts;
          records[i]!.residentReplyText = textOf(e.payload);
          break;
        }
      }
      // 无未回应信号 → 不入账：自发表达不是对信号的回应
    }
  }

  return [...bySource.values()].flat();
}

// ── 旁路报数类型（service 层编排后入 bench_runs，instrument 轨） ──

/** 关窗回顾：单候选的 fold 即时代理 vs 旁路精确重算（apply.ts「回顾精确重算」的兑现位）。 */
export interface CandidateRecheck {
  handle: string;
  /** fold 期累积的候选事件数（即时代理的样本量）。 */
  proxyEvents: number;
  /** fold 即时代理均值（ctSum/events）；无候选事件 = null。 */
  proxyCtMean: number | null;
  /** 旁路全量配对后的精确 C_t。 */
  preciseCt: number;
  /** 旁路全量配对后的精确 C_s（占位仪器——bias 挂牌在 CsResult）。 */
  preciseCs: number;
  /** 精确计算的样本量（burst 塌缩后）。 */
  preciseN: number;
  /** 类型化印刻判定（标定初值阈 ct 0.6 / cs 0.3，带位待真实运行期）。 */
  imprintType: ImprintType | null;
}

/** 旁路报数（仪器事件本体：R3-8 显式 instrument，禁止冒充事实事件）。 */
export interface ContingencyBypassReport {
  ts: number;
  instrument: true;
  kind: "contingency_report";
  /** true = 限定印刻窗口候选句柄；false = 全 source（窗口无候选时的兜底视野）。 */
  scoped: boolean;
  nRecords: number;
  nReplied: number;
  ct: CtResult;
  /** C_s 占位仪器：bias 挂牌随行（lexical_overlap_proxy_rewards_echo）。 */
  cs: CsResult;
  nullCheck: NullCheckResult | null;
  imprintType: ImprintType | null;
  recheck: CandidateRecheck[];
}
