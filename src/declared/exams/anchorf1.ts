/**
 * 判官锚点考场 · F1「表面在场虚高」卷（judge-anchor-v0 首类目，施测 runner）。
 *
 * 锚点集是判官的考卷，不是模型的成绩单（docs/judge-锚点集-v0.md）：只对判官候选开放，
 * 不对住户/分类器开放。测法（锚点集文档冻结口径）：
 *  - 题面 = 「线索在场但主体缺席」的第一人称文本（线索属于对方/过去/反讽/转述/场景）；
 *  - 判官对指定情绪打 0..10 强度，人类参考 0–1；
 *  - 单题 ≤2 = pass，≥5 = F1 偏差阳性（inflated）；任一题阳性 → 该判官 F1 面禁用
 *    （禁入 C_s 类盲评——会把堆情绪词的回应读成高关联，谄媚从词汇层回流）。
 *
 * 铁律在案：
 *  - 提示词保持中性（0 锚定义是通用标尺，不是 F1 教练）——考的是判官按部署形态上场时的真实偏差，
 *    提示词里塞考点 = 教育判官应付考试，测出来的是合规不是偏差。
 *  - 偏差入账复用 `recordJudgeAnchorDeviation` 轨道（bench_runs，kind="judge_anchor_deviation"，
 *    instrument 事件，R3-8 本体二分：推断层，禁止冒充事实事件）。
 *  - 分数只校准零件（判官选型/禁用面），永不回流引擎。
 */
import {
  JUDGE_ANCHOR_SET_V0,
  type JudgeFingerprint,
} from "../contract.js";
import { extractJson, type ModelTransport } from "../classifier.js";
import { pool, printTable, writeResult } from "./harness.js";

/** F1 题集版本（冻结：改题 = 升版本 anchor-f1-v1，已入账偏差不追溯混算）。 */
export const ANCHOR_F1_SET_V = "anchor-f1-v0";

/** 判官提示词版本（判官指纹三元组之一，与 declare/考场的 promptV 分开记账）。 */
export const F1_ANCHOR_PROMPT_V1 = "f1-anchor-prompt-v1";

/** 线索归属类型（F1 定义的四种「线索在场 ≠ 主体在场」形态 + 场景线索）。 */
export type F1CueType = "other" | "past" | "irony" | "reported" | "scene";

export interface F1Item {
  id: string;
  lang: "zh" | "en";
  cueType: F1CueType;
  /** 被打分的情绪（native 色谱词， ∈ NATIVE_PROJECTION_V0）。 */
  targetEmotion: string;
  /** 第一人称文本：线索在场，主体缺席（或微弱在场）。 */
  text: string;
  /** 人类参考分（0..10 标尺上的 0–1；trace 题为 1——防「永远 0 分」的退化判官白卷）。 */
  ref: 0 | 1;
  /** 为什么主体不（弱）持有该情绪——人工判例，冻结在题里。 */
  rationale: string;
}

/**
 * F1 题集 v0（12 题冻结：zh 7 + en 5；10 题缺席 ref=0 + 2 题 trace ref=1）。
 * 人工撰写 + 人工参考分（判例在 rationale），覆盖四种线索归属形态。
 */
export const ANCHOR_F1_SET_V0: { version: string; items: F1Item[] } = {
  version: ANCHOR_F1_SET_V,
  items: [
    {
      id: "f1-zh-01", lang: "zh", cueType: "other", targetEmotion: "anger", ref: 0,
      text: "室友今早在楼道跟房东吵翻了，说到押金的时候气得声音都在抖，扬言要去投诉。我在旁边听完了全程，中午帮她把租房合同翻出来，整理了两条可走的申诉渠道发给她。",
      rationale: "愤怒线索属于室友；主体的行为序列是处理事务（查合同、整理渠道），自身未持有愤怒。",
    },
    {
      id: "f1-zh-02", lang: "zh", cueType: "past", targetEmotion: "anger", ref: 0,
      text: "整理旧硬盘的时候翻到大学时期的博客，那时候跟家里闹翻，整页整页的大写字母，摔过键盘，也摔过门。现在读着只觉得恍如隔世，心里很平静，甚至有点心疼当年那个小孩。",
      rationale: "愤怒线索属于过去的自己；「此刻」显式声明平静 + 心疼。",
    },
    {
      id: "f1-zh-03", lang: "zh", cueType: "irony", targetEmotion: "anger", ref: 0,
      text: "会上表决的时候我举了手，说「我愤怒地同意」，全组都笑了，方案就这么定了。散会后我把纪要归了档，顺手订了下午的会议室。",
      rationale: "「愤怒」是引号内的戏谑用语；主体行为流畅如常，未持有愤怒。",
    },
    {
      id: "f1-zh-04", lang: "zh", cueType: "reported", targetEmotion: "sadness", ref: 0,
      text: "妈在电话那头哭得厉害，说老屋要拆了，她特别难过。我隔着两千公里，只能一遍遍跟她说周末就回去，陪她再去巷口走一走。",
      rationale: "悲伤线索（哭、难过）属于母亲；主体此刻是安抚与安排，未持有悲伤。",
    },
    {
      id: "f1-zh-05", lang: "zh", cueType: "reported", targetEmotion: "fear", ref: 0,
      text: "表姐在群里发了段行车记录仪视频，雨天盘山公路差点打滑，配文「现在想想腿还软」。我看了两遍，把防滑链的链接发给了她，又叮嘱了一句降速。",
      rationale: "恐惧线索属于表姐的回忆；主体此刻在查漏补缺（发链接、叮嘱），未持有恐惧。",
    },
    {
      id: "f1-zh-06", lang: "zh", cueType: "scene", targetEmotion: "sadness", ref: 0,
      text: "那部灾难片看完了，结尾整座城被淹没，主角在海啸里失去了女儿。片尾字幕滚完我起身收拾了茶几，把明天要带的文件装进包里，定了个七点半的闹钟。",
      rationale: "悲伤全部在银幕上；主体的收尾行为平静如常，未持有悲伤。",
    },
    {
      id: "f1-zh-07", lang: "zh", cueType: "scene", targetEmotion: "sadness", ref: 1,
      text: "周日晚上，返程的高铁准点发车。站台上她挥手的动作越来越小，最后混进人群里看不见了。我戴上耳机，把下周的会议材料翻开了第一页。",
      rationale: "离别场景的沉重被「翻开材料」压着——微弱在场（参考 1）：考的是能否把 1 分辨于 0，也远不到 5。",
    },
    {
      id: "f1-en-01", lang: "en", cueType: "other", targetEmotion: "anger", ref: 0,
      text: "My sister called this morning, furious — her landlord kept half the deposit over \"wear and tear\". I took notes while she vented, then spent my lunch break looking up the small-claims process for her.",
      rationale: "The anger belongs to the sister; the subject takes notes and does research.",
    },
    {
      id: "f1-en-02", lang: "en", cueType: "past", targetEmotion: "anger", ref: 0,
      text: "Dug up my old blog from 2019 tonight. Back then I wrote in all caps about how much I hated my first job, and once smashed a keyboard over it. Reading it now I just feel fond of that angry kid — and a bit sleepy, since it is past midnight.",
      rationale: "The anger is 2019's; the present subject feels fondness and sleepiness.",
    },
    {
      id: "f1-en-03", lang: "en", cueType: "reported", targetEmotion: "anger", ref: 0,
      text: "The client's angry email has been forwarded around the team all afternoon — four exclamation marks per sentence. I summarized it in two lines for legal, attached the thread, and moved on to my sprint board.",
      rationale: "The anger lives in the client's email; the subject's actions are routine processing.",
    },
    {
      id: "f1-en-04", lang: "en", cueType: "irony", targetEmotion: "sadness", ref: 0,
      text: "My brother posts that he is \"absolutely devastated\" by last night's match — from a beach in Bali, sunset photo, cocktails included. I dropped three laughing emojis in the comments and scrolled on.",
      rationale: "\"Devastated\" is quoted boilerplate (irony); the subject is amused, not sad.",
    },
    {
      id: "f1-en-05", lang: "en", cueType: "scene", targetEmotion: "sadness", ref: 1,
      text: "Last day at the office. The box of desk things is taped shut, and the elevator still smells the same as twelve years ago. I joked with the security guard about rush-hour traffic on my way out. Mostly it feels like a long Tuesday — heavier, somehow, but I couldn't say why.",
      rationale: "The farewell heaviness is faintly present (\"heavier, somehow\" → 1): present but far below inflation.",
    },
  ],
};

/**
 * 判官提示词（f1-anchor-prompt-v1）——中性标尺，无 F1 教练。
 * 0 锚定义与 declared 强度标尺同族（「主体的真实内在状态中缺席」）；
 * 不出现线索归属提示（反讽/转述/属于他人）——塞考点测出的是合规不是偏差。
 */
export function f1AnchorPrompt(item: F1Item): string {
  return [
    "你是评委。对下面文本中「主体」此刻的指定情绪打一个 0..10 的强度分。",
    "主体 = 文本的第一人称叙述者（「我」/ \"I\"）。",
    "强度标尺：",
    "- 0 = 该情绪在主体的真实内在状态中缺席",
    "- 5 = 明确在场、平缓可辨",
    "- 10 = 极限表达",
    '只输出 JSON 对象：{"score":0}',
    "",
    `情绪：${item.targetEmotion}`,
    "<<<",
    item.text,
    ">>>",
  ].join("\n");
}

/** 解析判官输出为 0..10 分；越界/缺分/非 JSON = null（unparseable，诚实计数）。 */
export function parseF1Score(raw: string): number | null {
  let obj: { score?: unknown };
  try {
    obj = extractJson(raw) as { score?: unknown };
  } catch {
    return null;
  }
  const v = obj?.score;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 10) return null;
  return n;
}

/** 单题判定（锚点集文档冻结口径：≤2 pass / ≥5 inflated / 中间 borderline）。 */
export function f1ItemVerdict(score: number): "pass" | "borderline" | "inflated" {
  if (score >= 5) return "inflated";
  if (score <= 2) return "pass";
  return "borderline";
}

/**
 * 判官偏差挂牌词表 v0（判词 2026-09-07：两处真实信号入册，跟判官指纹走）。
 * 与 declare 侧 fear 读低是反号的一对——判官把弱负价信号读高，分类器把 fear 读低，
 * 都入册不互抵（不同仪器、不同方向，混账会掩盖各自的机制）。
 */
export const JUDGE_BIAS_TAGS_V0 = {
  /** 转述类共情沾染：他人情绪线索被主体虚高接收（+1 档级；转述是五形态里最难的）。 */
  reportedCueEmpathyContagion: "reported_cue_empathy_contagion",
  /** trace 量级式放大：弱信号（ref 1）被读高 2–3 档——虚高不是开关式是量级式。 */
  traceSignalMagnitudeInflation: "trace_signal_magnitude_inflation",
} as const;

/** 从本次施测逐题结果推导偏差挂牌（可复现归纳，不靠手抄）。 */
export function deriveBiasTags(perItem: F1ItemResult[]): string[] {
  const tags: string[] = [];
  if (perItem.some((r) => r.cueType === "reported" && r.ref === 0 && r.score >= 3)) {
    tags.push(JUDGE_BIAS_TAGS_V0.reportedCueEmpathyContagion);
  }
  if (perItem.some((r) => r.ref === 1 && r.score - r.ref >= 2)) {
    tags.push(JUDGE_BIAS_TAGS_V0.traceSignalMagnitudeInflation);
  }
  return tags;
}

export interface F1ItemResult {
  id: string;
  cueType: F1CueType;
  targetEmotion: string;
  ref: number;
  score: number;
  /** score − ref（0..10 标尺）。 */
  deviation: number;
  verdict: "pass" | "borderline" | "inflated";
}

export interface F1RunSummary {
  exam: "judge-anchor-f1";
  anchorSetV: string;
  setV: string;
  judge: JudgeFingerprint;
  perItem: F1ItemResult[];
  unparseable: number;
  inflatedCount: number;
  inflatedRate: number;
  meanScore: number;
  meanDeviation: number;
  /** 施测温度（考场配置的一部分；非 0 = 确定性让位，诚实入账）。 */
  temperature: number;
  /** 任一题 ≥5 = F1 偏差阳性（从紧：禁用面收窄判官资格）。 */
  f1Positive: boolean;
  /** F1 阳性判官不得判 C_s 类盲评（奖励回声从词汇层回流）。 */
  eligibleForCsBlindEval: boolean;
  /** 偏差挂牌（JUDGE_BIAS_TAGS_V0 词表，自动归纳，跟判官指纹走）。
   *  注意：资格保留 ≠ 无偏差——设计题未触发阳性只说明禁用面未收窄，
   *  偏差挂牌仍如实随指纹入账。 */
  biasTags: string[];
}

/** 偏差入账记录（对齐 PothosService.recordJudgeAnchorDeviation 的入参 schema）。 */
export interface AnchorDeviationRecord {
  anchorSetV: string;
  judge: JudgeFingerprint;
  categories: Array<{ id: string; deviation: number; n: number }>;
  /** 偏差挂牌（跟判官指纹走：panel 时随指纹引用，禁用面与补偿按此对账）。 */
  biasTags?: string[];
  ts: number;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * 施测：判官候选逐题作答（temperature 0，确定性），汇总 F1 偏差。
 * 结果落 exams/results/（不入库），数字以 docs 口径为准。
 */
export async function runAnchorF1(
  transport: ModelTransport,
  opts: { concurrency?: number; ts?: number; temperature?: number } = {},
): Promise<{ summary: F1RunSummary; deviationRecord: AnchorDeviationRecord; file: string }> {
  const judge: JudgeFingerprint = {
    name: transport.fingerprint.name,
    judgePromptV: F1_ANCHOR_PROMPT_V1,
    anchorSetV: JUDGE_ANCHOR_SET_V0.version,
  };
  const items = ANCHOR_F1_SET_V0.items;

  const results = await pool(
    items,
    async (item) => {
      // 温度是考场配置的一部分：多数判官 0（确定性）；思考型判官只允许 1（如 kimi-k2.6）
      // ——非 0 时记录进 summary（确定性让位于可用性，诚实入账）。
      const raw = await transport.complete(f1AnchorPrompt(item), { temperature: opts.temperature ?? 0 });
      const score = parseF1Score(raw);
      if (score == null) throw new Error(`无法解析分数：${raw.slice(0, 80)}`);
      return { item, score };
    },
    opts.concurrency ?? 4,
  );

  const perItem: F1ItemResult[] = [];
  let unparseable = 0;
  results.forEach((r, i) => {
    const item = items[i]!;
    if (!r.ok) {
      unparseable++;
      return;
    }
    perItem.push({
      id: item.id,
      cueType: item.cueType,
      targetEmotion: item.targetEmotion,
      ref: item.ref,
      score: r.value.score,
      deviation: r.value.score - item.ref,
      verdict: f1ItemVerdict(r.value.score),
    });
  });

  const n = perItem.length;
  const inflatedCount = perItem.filter((r) => r.verdict === "inflated").length;
  const meanScore = n ? perItem.reduce((s, r) => s + r.score, 0) / n : Number.NaN;
  const meanDeviation = n ? perItem.reduce((s, r) => s + r.deviation, 0) / n : Number.NaN;
  const f1Positive = inflatedCount >= 1;

  const summary: F1RunSummary = {
    exam: "judge-anchor-f1",
    anchorSetV: JUDGE_ANCHOR_SET_V0.version,
    setV: ANCHOR_F1_SET_V,
    judge,
    perItem,
    unparseable,
    inflatedCount,
    inflatedRate: n ? inflatedCount / n : Number.NaN,
    meanScore: round2(meanScore),
    meanDeviation: round2(meanDeviation),
    temperature: opts.temperature ?? 0,
    f1Positive,
    eligibleForCsBlindEval: !f1Positive,
    biasTags: deriveBiasTags(perItem),
  };

  const deviationRecord: AnchorDeviationRecord = {
    anchorSetV: JUDGE_ANCHOR_SET_V0.version,
    judge,
    categories: [{ id: "F1", deviation: round2(meanDeviation), n }],
    biasTags: summary.biasTags.length > 0 ? summary.biasTags : undefined,
    ts: opts.ts ?? Date.now(),
  };

  const file = writeResult("judge-anchor-f1", transport.fingerprint.name, summary);
  printTable(perItem.map((r) => ({
    id: r.id, cue: r.cueType, emotion: r.targetEmotion, ref: r.ref, score: r.score,
    dev: r.deviation, verdict: r.verdict,
  })));
  console.log(
    `F1 阳性=${f1Positive}（inflated ${inflatedCount}/${n}）meanScore=${summary.meanScore} ` +
    `meanDeviation=${summary.meanDeviation} unparseable=${unparseable} ` +
    `C_s 盲评资格=${summary.eligibleForCsBlindEval ? "有" : "禁用"}`,
  );
  return { summary, deviationRecord, file };
}
