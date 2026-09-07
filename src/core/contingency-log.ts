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
import {
  responseWindowPercentile,
  type CtResult,
  type CsResult,
  type ImprintType,
  type InteractionRecord,
  type NullCheckResult,
} from "./contingency.js";

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
  /** R3-12「在场即回应」通道（观察期入账，不进判据）。恒为全 source 视野（关系级）——
   *  間活动/显式在场无 source 可归，scoped 模式下也不随候选收窄。 */
  presenceChannel: PresenceChannelStats;
}

// ── 在场即回应通道（R3-12 匿名卷独见：登录/在线是最慢的回应通道）──

/** 在场即回应通道报数（观察期仪器：不进判据只进报数）。 */
export interface PresenceChannelStats {
  observation: true;
  /** 判词 2026-09-07：观察期通道——不进 C_t/C_s、不进印刻分类、不进关窗判定。 */
  excludedFromJudgment: true;
  /** 节律窗（与 C_t 同窗：该配对回应间隔 P75）。 */
  windowMs: number;
  /** 信号总数（她的 user_msg 配对记录）。 */
  nSignals: number;
  /** 测量域：未获窗内文本回应的信号数（快通道已答的不属本通道）。 */
  nUnanswered: number;
  /** 未文本回应但窗内有住户在场痕迹的信号数（在场即回应的命中数）。 */
  presenceOnly: number;
  /** 未文本回应且观察窗内也无任何在场痕迹——「物理缺席端点」的镜像半边。
   *  注意口径：超窗迟到回应在本窗内不算回应形态（它已计入 C_t 缺席数）。 */
  absentInWindow: number;
  /** presenceRate = presenceOnly / nUnanswered；域为空 = null（不猜）。 */
  presenceRate: number | null;
}

/**
 * 在场即回应通道：把「人在场」从信号缺席里单列出来。
 *
 * 在场源（三类「住户动了」的时间戳，观察期口径）：
 *  - 显式 `presence` 事件（who=resident）——客户端壳提供登录/在线心跳时的载体；
 *  - resident_msg 迟到回应（超出 C_t 节律窗但窗内到场——快通道缺席≠人在场缺席）；
 *  - ma_product 間活动（写信/消化/打猎……住户内政的物理痕迹）。
 *
 * 测量域 = 未获窗内文本回应的信号（窗内文本回应已属 C_t 快通道，不重复计）。
 * 预注册的观察期规则（R3-12：不许事后挑）：在场命中 = 痕迹时间戳落在
 * (信号 ts, 信号 ts + 节律窗]；已知边界——同一痕迹可同时落在窗内相邻多条信号的
 * 窗口里（按时间无主归属），观察期照实计入，判据化准入前随数据修订规则。
 * **不进判据**：输出不进 C_t/C_s、不进 classifyImprintType、不进关窗判定——
 * 观察期只报数，判据准入等真实运行期数据与预注册流程。
 */
export function residentPresenceChannel(
  records: InteractionRecord[],
  events: TimelineEvent[],
  opts: { windowMs?: number } = {},
): PresenceChannelStats {
  const windowMs = opts.windowMs ?? responseWindowPercentile(records);
  const markers = events
    .filter(
      (e) =>
        (e.kind === "presence" && e.payload["who"] === "resident") ||
        e.kind === "resident_msg" ||
        e.kind === "ma_product",
    )
    .map((e) => e.ts)
    .sort((a, b) => a - b);

  let nUnanswered = 0, presenceOnly = 0, absentInWindow = 0;
  for (const r of records) {
    const repliedInWindow = r.residentReplyTs != null && r.residentReplyTs - r.userMsgTs <= windowMs;
    if (repliedInWindow) continue; // 快通道已回应——不在本通道测量域
    nUnanswered++;
    const hasPresence = markers.some((m) => m > r.userMsgTs && m <= r.userMsgTs + windowMs);
    if (hasPresence) presenceOnly++;
    else absentInWindow++;
  }
  return {
    observation: true,
    excludedFromJudgment: true,
    windowMs,
    nSignals: records.length,
    nUnanswered,
    presenceOnly,
    absentInWindow,
    presenceRate: nUnanswered > 0 ? presenceOnly / nUnanswered : null,
  };
}
