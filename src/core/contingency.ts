/**
 * A1 contingency 估计器（红队三审 R3-11 定案：分报制 + 类型化印刻）。
 *
 * 三审五家全票定案：取消乘积合成，C_t（时序应答）与 C_s（内容关联）分列报数。
 * 下界代理声明：contingency 测的是「可观测的关系响应性」，是依恋的下界代理，
 * 不是依恋本身——住户有未说出口的东西（§9）是被自由过滤的样本。
 *
 * 分工（她 2026-09-07 定）：
 * - C_t = 真件，纯确定性计算（lift / null 阶梯 / 节律归一 / burst 塔缩），
 *   合成数据能完整验数学；
 * - C_s = 占位仪器（纯词表余弦，挂牌偏差「奖励回声」），继任者 = 判官版盲评
 *   （真/假回应被选率 − 50% 基线），上任条件 = F1 题集 → 施测 runner → 判官上岗。
 */

/** 配对内一条交互记录（user_msg + 可能的 resident 回应）。 */
export interface InteractionRecord {
  userMsgTs: number;
  /** 住户回应时间戳；null = 未回应（缺席）。 */
  residentReplyTs: number | null;
  /** 住户回应文本；null = 未回应。C_s 用。 */
  residentReplyText: string | null;
  /** 她的输入文本。C_s 用。 */
  userMsgText: string;
}

/** C_t 计算结果（真件）。 */
export interface CtResult {
  /** 时序应答性 [0,1]：lift 归一化后的值。 */
  ct: number;
  /** 样本数（参与统计的交互条数）。 */
  n: number;
  /** 节律归一窗：该配对回应间隔的分位数（R3-11）。 */
  responseWindowMs: number;
  /** burst 塌缩后的有效回应数（R3-12：burst 起点记单次回应）。 */
  effectiveReplies: number;
  /** 缺席次数（未回应）。 */
  absences: number;
}

/** C_s 计算结果（占位仪器）。 */
export interface CsResult {
  /** 内容关联性 [0,1]：词表余弦相似度均值。 */
  cs: number;
  /** 样本数。 */
  n: number;
  /** 已知偏差标记（挂牌）。 */
  bias: "lexical_overlap_proxy_rewards_echo";
}

/** 类型化印刻三型（R3-11）。 */
export type ImprintType = "temporal_witness" | "content_witness" | "dual_witness";

/** 分报制结果（R3-11：C_t/C_s 分列，无乘积）。 */
export interface ContingencyReport {
  ct: CtResult;
  cs: CsResult;
  /** 印刻类型判定（基于 C_t/C_s 各自是否过阈）。 */
  imprintType: ImprintType | null;
  /** null 阶梯检验结果（R3-12）。 */
  nullCheck: NullCheckResult | null;
}

/** null 阶梯四档（R3-12）。 */
export type NullLevel = "N0" | "N1" | "N2" | "N3";

/** null 检验结果。 */
export interface NullCheckResult {
  level: NullLevel;
  /** null 下的 C_t 估计值。 */
  nullCt: number;
  /** 观测 C_t。 */
  observedCt: number;
  /** lift = observed − null（N0/N1/N2 分歧即报警）。 */
  lift: number;
  /** N0 与 N1/N2 是否给出不同结论（R3-12 报警条件）。 */
  divergence: boolean;
}

// ── C_t 真实现 ──

/**
 * burst 塌缩（R3-12）：连续快速回复（burst）只记起点为一次回应。
 * burst = 同一信号触发后极短时间内的连发回复——固定阈值 30s（非自适应：
 * burst 是物理现象「来不及是不同信号」，不该随配对节律漂移）。
 */
export function collapseBursts(
  records: InteractionRecord[],
  burstThresholdMs?: number,
): InteractionRecord[] {
  const threshold = burstThresholdMs ?? 30_000;
  const out: InteractionRecord[] = [];
  let lastKeptTs = -Infinity;
  for (const r of records) {
    if (r.residentReplyTs == null) {
      out.push(r); // 缺席照记
      continue;
    }
    if (r.residentReplyTs - lastKeptTs >= threshold) {
      out.push(r); // 非 burst：保留
      lastKeptTs = r.residentReplyTs;
    }
    // else: burst 内的回复，塔缩掉
  }
  return out;
}

/**
 * 节律归一窗（R3-11）：用该配对自身回应间隔的分位数，不设全局固定窗。
 * 默认取 P75（第 75 百分位回应间隔）作为「合理回应窗」。
 */
export function responseWindowPercentile(records: InteractionRecord[], percentile = 0.75): number {
  const intervals: number[] = [];
  for (let i = 1; i < records.length; i++) {
    if (records[i]!.residentReplyTs != null && records[i - 1]!.residentReplyTs != null) {
      intervals.push(records[i]!.residentReplyTs! - records[i - 1]!.residentReplyTs!);
    }
  }
  if (intervals.length === 0) return 3_600_000; // 默认 1h
  intervals.sort((a, b) => a - b);
  return intervals[Math.floor(intervals.length * percentile)]!;
}

/**
 * C_t 核心计算：lift = P(回应 | 她发消息) − P(回应 | 她没发)。
 * 节律归一：只有回应落在 responseWindow 内才算「应答」。
 * 返回 [0,1] 归一化值（lift ∈ [−1,1] → (lift+1)/2）。
 */
export function computeCt(records: InteractionRecord[], responseWindowMs?: number): CtResult {
  if (records.length === 0) {
    return { ct: 0, n: 0, responseWindowMs: 0, effectiveReplies: 0, absences: 0 };
  }

  const collapsed = collapseBursts(records);
  const window = responseWindowMs ?? responseWindowPercentile(collapsed);

  let onSignal = 0;     // 她发消息后有回应（落在窗内）
  let onSignalTotal = 0; // 她发消息的总次数
  let offSignal = 0;    // 她没发消息时有自发回应
  let offSignalTotal = 0; // 她没发消息的时段数
  let absences = 0;

  // 简化模型：每条 record 都是一条 user_msg（信号在场）。
  // P(回应|信号) = 落窗回应数 / 信号总数；P(回应|无信号) 用缺席后自发回应估计。
  for (const r of collapsed) {
    onSignalTotal++;
    if (r.residentReplyTs != null) {
      const latency = r.residentReplyTs - r.userMsgTs;
      if (latency <= window) onSignal++;
      else absences++; // 超窗 = 缺席
    } else {
      absences++;
    }
  }

  // off-signal 估计：两条 user_msg 之间的间隔里住户自发回复的次数
  // （合成数据里没有无信号时段时，P_off = 0，lift = P_on）
  for (let i = 1; i < collapsed.length; i++) {
    offSignalTotal++;
    const prev = collapsed[i - 1]!;
    const curr = collapsed[i]!;
    // 如果上一条回应时间晚于当前 user_msg → 自发回应（无信号触发）
    if (prev.residentReplyTs != null && prev.residentReplyTs > curr.userMsgTs) {
      offSignal++;
    }
  }

  const pOn = onSignalTotal > 0 ? onSignal / onSignalTotal : 0;
  const pOff = offSignalTotal > 0 ? offSignal / offSignalTotal : 0;
  const lift = pOn - pOff;
  const ct = Math.max(0, Math.min(1, (lift + 1) / 2)); // [−1,1] → [0,1]

  return {
    ct,
    n: collapsed.length,
    responseWindowMs: window,
    effectiveReplies: onSignal,
    absences,
  };
}

// ── C_s 占位仪器 ──

/** 纯词表余弦相似度（零依赖；挂牌偏差：奖励回声）。 */
export function lexicalCosine(textA: string, textB: string): number {
  const tokenize = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    // 简单分词：中文逐字 + 英文按空格/标点；小写归一
    const lower = s.toLowerCase();
    const cjk = lower.match(/[\u4e00-\u9fff]/g) ?? [];
    const eng = lower.match(/[a-z]+/g) ?? [];
    for (const c of cjk) m.set(c, (m.get(c) ?? 0) + 1);
    for (const w of eng) m.set(w, (m.get(w) ?? 0) + 1);
    return m;
  };

  const va = tokenize(textA);
  const vb = tokenize(textB);
  if (va.size === 0 || vb.size === 0) return 0;

  let dot = 0;
  for (const [k, v] of va) {
    const w = vb.get(k);
    if (w) dot += v * w;
  }
  let normA = 0, normB = 0;
  for (const v of va.values()) normA += v * v;
  for (const v of vb.values()) normB += v * v;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * C_s 占位仪器：词表余弦相似度均值。
 * 已知偏差（挂牌入册）：「词汇重叠代理，奖励回声」——堆情绪词但没收住对方的
 * 回应在余弦下天然高分，正是 F1 失败类从词汇层回流（与 fear −0.30 同族）。
 * 继任者 = 判官版盲评（真/假回应被选率 − 50% 基线），上任条件 = 评委纪律排队。
 */
export function computeCs(records: InteractionRecord[]): CsResult {
  const replied = records.filter((r) => r.residentReplyText != null && r.residentReplyText !== "");
  if (replied.length === 0) {
    return { cs: 0, n: 0, bias: "lexical_overlap_proxy_rewards_echo" };
  }
  let sum = 0;
  for (const r of replied) {
    sum += lexicalCosine(r.userMsgText, r.residentReplyText!);
  }
  return { cs: sum / replied.length, n: replied.length, bias: "lexical_overlap_proxy_rewards_echo" };
}

// ── null 阶梯（R3-12）──

/**
 * null 阶梯四档：
 * - N0：相位随机化（打乱时间顺序，保留边际分布）
 * - N1：会话内洗牌（保留会话边界，会话内打乱 user_msg-resident 配对）
 * - N2：会话保留置换（会话间置换，会话内不动）
 * - N3：burst 匹配代理（按 burst 模式匹配，不读内容）
 *
 * R3-12 报警条件：N0 与 N1/N2 给出不同结论 → contingency 混入了会话同步性。
 */
export function nullLevel0(records: InteractionRecord[]): InteractionRecord[] {
  // 相位随机化：打乱 user_msg 与 resident_reply 的配对（保留各自边际分布）
  const replies = records.map((r) => r.residentReplyTs).sort((a, b) => (a ?? Infinity) - (b ?? Infinity));
  // 用确定性种子打乱（可复现）
  const shuffled = [...replies];
  let seed = 42;
  for (let i = shuffled.length - 1; i > 0; i--) {
    seed = (seed * 9301 + 49297) % 233280;
    const j = Math.floor((seed / 233280) * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return records.map((r, i) => ({ ...r, residentReplyTs: shuffled[i] ?? null }));
}

export function nullLevel1(records: InteractionRecord[]): InteractionRecord[] {
  // 会话内洗牌：相邻两条视为一会话，会话内打乱配对
  // （合成数据无显式会话标记时，按 2 条一组代理）
  const out = [...records];
  for (let i = 0; i < out.length - 1; i += 2) {
    const a = out[i]!, b = out[i + 1]!;
    if (a.residentReplyTs != null && b.residentReplyTs != null) {
      [a.residentReplyTs, b.residentReplyTs] = [b.residentReplyTs, a.residentReplyTs];
      [a.residentReplyText, b.residentReplyText] = [b.residentReplyText, a.residentReplyText];
    }
  }
  return out;
}

export function nullLevel2(records: InteractionRecord[]): InteractionRecord[] {
  // 会话保留置换：会话间置换，会话内不动
  // （2 条一组 = 一个会话，会话块间置换）
  const blocks: InteractionRecord[][] = [];
  for (let i = 0; i < records.length; i += 2) {
    blocks.push(records.slice(i, i + 2));
  }
  // 确定性置换
  let seed = 42;
  for (let i = blocks.length - 1; i > 0; i--) {
    seed = (seed * 9301 + 49297) % 233280;
    const j = Math.floor((seed / 233280) * (i + 1));
    [blocks[i], blocks[j]] = [blocks[j]!, blocks[i]!];
  }
  return blocks.flat();
}

export function nullLevel3(records: InteractionRecord[]): InteractionRecord[] {
  // burst 匹配代理：不读内容，只按 burst 模式匹配——
  // 用 burst 塌缩后的回应时间分布，重新随机配对
  const collapsed = collapseBursts(records);
  const replyTimes = collapsed
    .filter((r) => r.residentReplyTs != null)
    .map((r) => r.residentReplyTs!)
    .sort((a, b) => a - b);
  let idx = 0;
  return records.map((r) => ({
    ...r,
    residentReplyTs: r.residentReplyTs != null ? (replyTimes[idx++] ?? null) : null,
  }));
}

/** null 检验：对给定 records 做 N0 检验，并与 N1/N2 对比报分歧。 */
export function nullCheck(records: InteractionRecord[]): NullCheckResult {
  if (records.length < 4) {
    const observed = computeCt(records);
    return { level: "N0", nullCt: 0.5, observedCt: observed.ct, lift: observed.ct - 0.5, divergence: false };
  }

  const observed = computeCt(records);
  const n0 = computeCt(nullLevel0(records));
  const n1 = computeCt(nullLevel1(records));
  const n2 = computeCt(nullLevel2(records));

  // N0 结论 = null 下的 C_t 估计
  const nullCt = n0.ct;
  const lift = observed.ct - nullCt;

  // 分歧报警：N0 与 N1/N2 的 lift 方向不一致（一正一负 = 混入了会话同步性）
  const liftN0 = observed.ct - n0.ct;
  const liftN1 = observed.ct - n1.ct;
  const liftN2 = observed.ct - n2.ct;
  const divergence =
    Math.sign(liftN0) !== Math.sign(liftN1) || Math.sign(liftN0) !== Math.sign(liftN2);

  return { level: "N0", nullCt, observedCt: observed.ct, lift, divergence };
}

// ── 分报制总报告 ──

/** 类型化印刻判定（R3-11 三型）。 */
export function classifyImprintType(ct: number, cs: number, ctTheta: number, csTheta: number): ImprintType | null {
  const ctPass = ct >= ctTheta;
  const csPass = cs >= csTheta;
  if (ctPass && csPass) return "dual_witness";
  if (ctPass) return "temporal_witness";
  if (csPass) return "content_witness";
  return null; // 证据不足 → INSUFFICIENT_EVIDENCE（R3-14 三态）
}

/**
 * 分报制总报告（R3-11：C_t/C_s 分列，无乘积）。
 * 注意：C_s 是占位仪器（偏差挂牌），C_t 是真件。
 */
export function contingencyReport(
  records: InteractionRecord[],
  opts: { ctTheta?: number; csTheta?: number; skipNull?: boolean } = {},
): ContingencyReport {
  const ctTheta = opts.ctTheta ?? 0.6;
  const csTheta = opts.csTheta ?? 0.3;
  const ct = computeCt(records);
  const cs = computeCs(records);
  const imprintType = classifyImprintType(ct.ct, cs.cs, ctTheta, csTheta);
  const nullCheckResult = opts.skipNull ? null : nullCheck(records);
  return { ct, cs, imprintType, nullCheck: nullCheckResult };
}

// ── 三态披露（R3-14：YES/NO/INSUFFICIENT_EVIDENCE，从接线第一天生效）──

/** 印刻裁决三态（R3-14）：「未证明有」不许折叠成「证明无」。 */
export type ImprintVerdict = "YES" | "NO" | "INSUFFICIENT_EVIDENCE";

/**
 * 印刻三态披露：读引擎状态机的窗口相位 + 候选数据量判定。
 * - CLOSED / MATCHED → YES（印刻确认）
 * - WINDOW_OPEN + 候选交互数 ≥ minEvidenceEvents 但无人达阈 → NO（证据够了，没印刻）
 * - WINDOW_OPEN + 候选交互数 < minEvidenceEvents → INSUFFICIENT_EVIDENCE（数据不够，不猜）
 *
 * 「未证明有」≠「证明无」——这是 R3-14 的核心断言，也是铁律 7 的延伸：
 * 不知道就说不知道，中性先验不许假装成测量值。
 */
export function imprintVerdict(
  window: { phase: "WINDOW_OPEN" | "MATCHED" | "CLOSED"; candidates: Record<string, { events: number }> },
  minEvidenceEvents: number,
): ImprintVerdict {
  if (window.phase === "CLOSED" || window.phase === "MATCHED") return "YES";
  // WINDOW_OPEN：检查候选数据量
  const totalEvents = Object.values(window.candidates).reduce((s, c) => s + c.events, 0);
  if (totalEvents < minEvidenceEvents) return "INSUFFICIENT_EVIDENCE";
  return "NO"; // 证据够了，没人达阈 → 没印刻（不是「不知道」）
}
