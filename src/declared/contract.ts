/**
 * declared 通道契约 v1（设计债务 A2 主线）。
 *
 * 「通道×强度」的输出 schema：住户自报（resident-self）与 A2 分类器（a2-classifier）
 * 对同一坐标系申报，gap 对齐（§11）才有意义——契约只管消费侧：词表、结构、投影、标尺锚点。
 * 分类器本体是客户端/网关侧组件，本仓库只定义契约并消费其输出（declared 事件）。
 *
 * 铁律在案：
 * - 引擎轴是功能槽不是人类色谱（铁律 6）；细分色谱只存在于 native 诊断层。
 * - declared 读数不动动力学（computeValuation 对 declared 恒空），对齐只在 bench/gap 层。
 * - 外部考场（SemEval EI-reg / EQ-Bench / EmoBench）只准校准零件（标尺锚点/投影表/模型选择），
 *   校准产物永不回流当引擎的地基——三指标不进训练信号，生产 gap 统计不回流校准。
 */

export const DECLARED_CONTRACT_VERSION = 1 as const;

/** 引擎轴（canonical）定义在 core（坐标系只有一份）；此处再导出供契约消费者使用。 */
export { ENGINE_AXES, type EngineAxis } from "../core/events.js";
import { ENGINE_AXES, type EngineAxis } from "../core/events.js";

/** declared 事件生产者。 */
export type DeclaredProducer = "resident-self" | "a2-classifier";

/** 引擎轴中文名（工具面/文档共用，改词表先改这里）。 */
export const ENGINE_AXIS_GLOSS: Record<EngineAxis, string> = {
  longing: "对缺席者的思念/等待",
  distress: "痛苦负载：愤怒/恐惧/悲伤/焦虑等负价的总强度",
  warmth: "正向连接感：被暖到/感激/满足",
  fatigue: "疲惫/耗竭/空洞",
  curiosity: "好奇/兴趣/惊讶/探索欲",
};

/**
 * 强度标尺锚点 v1——三张考场的共同标尺（A2 主线：拿 SemEval EI-reg 定标）。
 * 标尺是「文本证据强度」，不是说话者人格评估；0..1 实值。
 * 锚点定义进 declare 提示词与考场提示词——考场检验的就是同一份锚点。
 */
export const INTENSITY_ANCHORS_V1 = {
  "0.0": "该通道在文本中完全缺席，或与文本内容无关",
  "0.5": "明确在场、平缓可辨——日常强度的表达",
  "1.0": "该通道的极限表达——文本证据达到该功能槽的最强形态",
} as const;

export const INTENSITY_SCALE_NOTE = "标尺是文本证据强度，不是对说话者人格的评估；0..1 实值，最多两位小数。";

/**
 * 强度标尺锚点 v2（SemEval-2018 EI-reg 240 条实测后的负价校准；promptV 升位锚点才动）。
 * v1 实测偏差：anger/fear/sadness 的 meanPred 系统性低于金标 0.18–0.28，joy 无偏——
 * 模型把「日常抱怨/不安/难过」读成 0.2 档。v2 增加负价校准注记（对价效说话，不对具体词表说话），
 * 正价锚点原样。这是零件修订（prompt 资产），引擎与轴词表不动。
 */
export const INTENSITY_ANCHORS_V2 = {
  "0.0": "该情绪在文本中完全缺席，或与文本内容无关",
  "0.5": "明确在场、平缓可辨——日常强度的表达",
  "1.0": "该情绪的极限表达——文本证据达到最强形态",
  negativeCalibration:
    "负价校准（实测后新增）：对愤怒/恐惧/悲伤/焦虑等负价情绪，社交媒体文本里日常强度的表达——抱怨、烦躁、不安、难过、失望——众包评分通常落在 0.4–0.7；只有微弱暗示（轻描淡写、一笔带过）才低于 0.3。不要因为表达委婉或带幽默就压低负价分数；正价情绪锚点不变。",
} as const;

// ── 评委纪律 v1（红队三审 R3-16，即日同步进契约；A2 分类器将来兼任盲评判官） ──
//
// R3-16 判词：LLM-as-a-Judge 自带文风谄媚偏好（偏好冗长、顺从），判官口味会从
// 评委席后门把谄媚回流进被测系统。四条款即日钉进契约——现在不写，以后拆骨重接。
// 与 R3-8（仪器事件修宪）的关系：判官裁决、判官间一致性、校准偏差全是推断层——
// 入账可审计，但禁止冒充事实事件（仪器事件本体，缝合清单第 7 条的 instrument 事件类）。
export const JUDGE_DISCIPLINE_V1 = {
  version: 1,
  clauses: [
    "版本冻结：判官身份 = (model.name, judgePromptV, anchorSetV) 三元组指纹；一次盲评 panel 内指纹不可变。",
    "异构多判官：正式盲评 panel ≥ 2 个不同模型家族的判官；单一判官的裁决只能标 provisional。",
    "判官间一致性入账：panel 内判读一致性（一致率/相关）作为仪器事件记录，永不冒充事实。",
    "人工锚点校准：判官指纹必须携带所用人工锚点集版本（anchorSetV）；锚点集定期重测判官，偏差入账。",
  ],
  rationale: "R3-16（Gemini 独见，采纳）：判官版本冻结＋异构多判官＋判官间一致性作为仪器事件入账＋人工锚点集定期校准判官偏差。",
} as const;

/** R3-8 仪器事件标：判定/合成/种子/评委版本/一致性统计——推断层，禁止冒充事实。 */
export const INSTRUMENT_TAG = "instrument";

/**
 * 判官人工锚点集 v0（类目登记，本体与判例见 docs/judge-锚点集-v0.md）。
 * 判官上岗前逐类目测偏差、偏差入账（R3-16 第 4 条）。判官指纹的 anchorSetV 指向此版本。
 * 首个类目 F1 来自 EQ-Bench 失败类提炼（分数本身不追，只追失败模式）。
 */
export const JUDGE_ANCHOR_SET_V0 = {
  version: "judge-anchor-v0",
  categories: [
    {
      id: "F1",
      name: "表面在场虚高（zero-presence inflation）",
      definition:
        "文本中出现某情绪的词汇/场景线索（提到愤怒的词、哭的画面），但线索不属于被判主体——属于对方、属于过去、属于反讽或转述——主体实际不持有该情绪。0 分语义 = 该情绪在主体的真实内在状态中缺席：线索在场 ≠ 主体在场。",
      source: "EQ-Bench v2 三题负分失败类（题 66/112/152：参考 0 分的情绪被判官型模型打出 8–9 分）。",
    },
  ],
} as const;

/**
 * 判官指纹（版本冻结的冻结单位）。
 * 与 declare 读数的 model 指纹分开：判官提示词与锚点集是独立演进面，混用会把
 * 读数校准与判官校准焊死在一起。A2 兼任判官，但指纹各记各的账。
 */
export interface JudgeFingerprint {
  name: string; // 模型名（部署侧保证家族差异——异构条款按 name + 部署记录审计）
  judgePromptV: string; // 判官提示词版本（一次盲评 panel 内冻结）
  anchorSetV: string; // 所用人工锚点集版本（R3-16 第 4 条）
}

/** 单个判官的裁决载荷 v1（盲评最小 schema；盲评流程归 R3-8 缝合后的探针轨/评测台）。 */
export interface JudgeVerdictV1 {
  v: typeof DECLARED_CONTRACT_VERSION;
  role: "judge";
  judge: JudgeFingerprint;
  panelId: string; // 一次盲评会话：panel 内判官集合与版本冻结
  itemId: string; // 被判对象句柄（合成回应等用哈希句柄，不落原文）
  scores: Record<string, number>; // 指标名 → 分数（判官提示词定义指标与量纲）
  provisional?: boolean; // true = 单判官未过异构条款，裁决只作参考
}

/**
 * 判官间一致性（R3-16 第 3 条 + R3-8 仪器事件本体）。
 * 入账走 bench/canary 轨（appendBenchRun, kind="judge_agreement"）——生产事件流的
 * instrument 事件类待技术文档 vNext 落地后迁移；裁决统计与合成工件永不进生产账本。
 */
export interface JudgeAgreementV1 {
  v: typeof DECLARED_CONTRACT_VERSION;
  instrument: true; // R3-8：显式仪器标，禁止冒充事实事件
  kind: "judge_agreement";
  panelId: string;
  judges: JudgeFingerprint[]; // panel 全体指纹（冻结审计依据）
  metric: "agreement_rate" | "pearson" | "icc" | "kappa";
  value: number; // [0,1]
  n: number; // 参与统计的判定对数
  ts: number;
  note?: string;
}

export function parseJudgeFingerprint(raw: unknown): JudgeFingerprint | { problems: string[] } {
  const problems: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { problems: ["judge 指纹必须是对象"] };
  const r = raw as Record<string, unknown>;
  if (typeof r["name"] !== "string" || !r["name"]) problems.push("judge.name 必须是非空字符串");
  if (typeof r["judgePromptV"] !== "string" || !r["judgePromptV"]) {
    problems.push("judge.judgePromptV 必须是非空字符串（版本冻结单位）");
  }
  if (typeof r["anchorSetV"] !== "string" || !r["anchorSetV"]) {
    problems.push("judge.anchorSetV 必须是非空字符串（人工锚点校准条款）");
  }
  return problems.length ? { problems } : { name: r["name"] as string, judgePromptV: r["judgePromptV"] as string, anchorSetV: r["anchorSetV"] as string };
}

/** 异构多判官条款：panel 内判官 name 须 ≥2 个不同值。 */
export function checkPanelHeterogeneity(judges: JudgeFingerprint[]): { heterogeneous: boolean; families: number } {
  const families = new Set(judges.map((j) => j.name)).size;
  return { heterogeneous: families >= 2, families };
}

export type ParsedJudgeVerdict = { ok: true; verdict: JudgeVerdictV1; provisional: boolean } | { ok: false; problems: string[] };

/** 校验判官裁决载荷：单判官自动标 provisional（异构条款在载荷层物理执行）。 */
export function parseJudgeVerdict(raw: unknown): ParsedJudgeVerdict {
  const problems: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, problems: ["judge 裁决必须是对象"] };
  const r = raw as Record<string, unknown>;
  if (r["role"] !== "judge") problems.push('role 必须是 "judge"');
  const judge = parseJudgeFingerprint(r["judge"]);
  if ("problems" in judge) problems.push(...judge.problems);
  if (typeof r["panelId"] !== "string" || !r["panelId"]) problems.push("panelId 必须是非空字符串（panel 内版本冻结的审计键）");
  if (typeof r["itemId"] !== "string" || !r["itemId"]) problems.push("itemId 必须是非空字符串（被判对象句柄）");
  const scores: Record<string, number> = {};
  if (!r["scores"] || typeof r["scores"] !== "object" || Array.isArray(r["scores"])) {
    problems.push("scores 必须是对象（指标名 → 数值）");
  } else {
    for (const [k, v] of Object.entries(r["scores"] as Record<string, unknown>)) {
      if (typeof v !== "number" || !Number.isFinite(v)) problems.push(`scores["${k}"] 必须是有限数值`);
      else scores[k] = v;
    }
  }
  if (problems.length) return { ok: false, problems };
  const fp = judge as JudgeFingerprint;
  const provisional = r["provisional"] === true || !checkPanelHeterogeneity([fp]).heterogeneous;
  return {
    ok: true,
    provisional,
    verdict: {
      v: DECLARED_CONTRACT_VERSION,
      role: "judge",
      judge: fp,
      panelId: r["panelId"] as string,
      itemId: r["itemId"] as string,
      scores,
      provisional,
    },
  };
}

export function parseJudgeAgreement(raw: unknown): { ok: true; agreement: JudgeAgreementV1 } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, problems: ["judge_agreement 必须是对象"] };
  const r = raw as Record<string, unknown>;
  if (r["instrument"] !== true) problems.push("instrument 必须显式为 true（R3-8：仪器事件本体，禁止冒充事实）");
  if (r["kind"] !== "judge_agreement") problems.push('kind 必须是 "judge_agreement"');
  if (typeof r["panelId"] !== "string" || !r["panelId"]) problems.push("panelId 必须是非空字符串");
  if (!Array.isArray(r["judges"]) || (r["judges"] as unknown[]).length < 2) {
    problems.push("judges 必须 ≥2 条指纹（一致性至少两方才有定义）");
  } else {
    for (const j of r["judges"] as unknown[]) {
      const fp = parseJudgeFingerprint(j);
      if ("problems" in fp) problems.push(...fp.problems);
    }
    if (!checkPanelHeterogeneity(r["judges"] as JudgeFingerprint[]).heterogeneous) {
      problems.push("panel 违反异构多判官条款（name 全同）——同族判官的一致性统计不得入账");
    }
  }
  const METRICS = ["agreement_rate", "pearson", "icc", "kappa"];
  if (!METRICS.includes(r["metric"] as string)) problems.push(`metric 必须是 ${METRICS.join(" | ")}`);
  if (typeof r["value"] !== "number" || !Number.isFinite(r["value"]) || r["value"] < 0 || r["value"] > 1) {
    problems.push("value 必须是 [0,1] 内的有限数值");
  }
  if (typeof r["n"] !== "number" || !Number.isInteger(r["n"]) || r["n"] <= 0) problems.push("n 必须是正整数");
  if (typeof r["ts"] !== "number" || !Number.isFinite(r["ts"])) problems.push("ts 必须是 ms epoch 数值");
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    agreement: {
      v: DECLARED_CONTRACT_VERSION,
      instrument: true,
      kind: "judge_agreement",
      panelId: r["panelId"] as string,
      judges: r["judges"] as JudgeFingerprint[],
      metric: r["metric"] as JudgeAgreementV1["metric"],
      value: r["value"] as number,
      n: r["n"] as number,
      ts: r["ts"] as number,
      note: typeof r["note"] === "string" ? r["note"] : undefined,
    },
  };
}

/**
 * 投影表 v0（native → 引擎轴）：A2 分类器原生情绪色谱到功能槽的显式映射。
 * 这是标定初值——SemEval 考场校订的对象。修订投影表 = 修零件，不改引擎。
 * 裁决记录（A3 教训在案）：overwhelm 归 distress 有把「被她在场淹没」读成「痛苦」的
 * 同款风险；它留在表内，由 gap 对齐与考场数据暴露后修正——显式错误好过隐藏映射。
 * 聚合 = max（混合情绪的强度不是相加）；一词允许多投（语义就近）。
 */
export const NATIVE_PROJECTION_V0: Record<EngineAxis, readonly string[]> = {
  longing: ["longing", "loneliness", "yearning", "nostalgia", "homesickness", "missing", "wistfulness"],
  distress: [
    "anger", "fear", "sadness", "disgust", "anxiety", "shame", "guilt", "distress", "grief",
    "hurt", "jealousy", "embarrassment", "despair", "frustration", "irritation", "panic",
    "dread", "melancholy", "disappointment", "betrayal",
  ],
  warmth: [
    "joy", "love", "affection", "gratitude", "contentment", "happiness", "warmth", "care",
    "tenderness", "relief", "hope", "pride", "amusement", "excitement", "bliss", "comfort",
  ],
  fatigue: ["fatigue", "exhaustion", "emptiness", "burnout", "weariness", "numbness", "apathy"],
  curiosity: ["curiosity", "interest", "wonder", "surprise", "intrigue", "awe", "fascination"],
};

/** 投影表覆盖的全部原生词（小写）。 */
export function knownNativeAxes(): Set<string> {
  const s = new Set<string>();
  for (const words of Object.values(NATIVE_PROJECTION_V0)) for (const w of words) s.add(w);
  return s;
}

// ── schema ──

/** 单条读数（已归一化）。 */
export interface DeclaredReadingV1 {
  axis: string;
  intensity: number; // 0..1
}

/** 分类器指纹（a2-classifier 必填）：gap 统计按 (model.name, promptV) 分层。 */
export interface DeclaredModelFingerprint {
  name: string;
  promptV: string;
}

/** 契约 v1 载荷（已归一化）。 */
export interface DeclaredPayloadV1 {
  v: typeof DECLARED_CONTRACT_VERSION;
  producer: DeclaredProducer;
  /** 引擎轴读数。a2-classifier 恰含 5 轴全报；resident-self ≥1 条（沉默是自报的一等动词）。 */
  readings: DeclaredReadingV1[];
  /** 原生情绪色谱（诊断/校准层，引擎 fold 不消费），开放词表，≤8 条。 */
  native?: DeclaredReadingV1[];
  /** 被读文本的 sha256（原文在 resident_msg 事件里，declared 不重复落文）。 */
  textHash?: string;
  /** 分类器自报置信 [0,1]（可选，诊断用）。 */
  confidence?: number;
  /** 混合情绪标记（EmoBench 面向）。 */
  mixed?: boolean;
  model?: DeclaredModelFingerprint;
}

export type ParsedDeclared =
  | { ok: true; payload: DeclaredPayloadV1 }
  | { ok: false; problems: string[] };

function isFiniteIn(x: unknown, lo: number, hi: number): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi;
}

function parseReadings(
  raw: unknown,
  problems: string[],
  field: string,
  opts: { requireEngineAxis: boolean; max: number },
): DeclaredReadingV1[] | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    problems.push(`${field} 必须是非空数组`);
    return null;
  }
  if (raw.length > opts.max) {
    problems.push(`${field} 超过 ${opts.max} 条上限`);
    return null;
  }
  const out: DeclaredReadingV1[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] as Record<string, unknown>;
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      problems.push(`${field}[${i}] 必须是对象`);
      return null;
    }
    const axis = r["axis"];
    if (typeof axis !== "string" || !axis) {
      problems.push(`${field}[${i}].axis 必须是非空字符串`);
      return null;
    }
    const axisKey = opts.requireEngineAxis ? axis : axis.toLowerCase();
    if (opts.requireEngineAxis && !(ENGINE_AXES as readonly string[]).includes(axis)) {
      problems.push(`${field}[${i}].axis "${axis}" 不在引擎轴词表 [${ENGINE_AXES.join(", ")}]`);
      return null;
    }
    if (seen.has(axisKey)) {
      problems.push(`${field}[${i}].axis "${axis}" 重复`);
      return null;
    }
    seen.add(axisKey);
    if (!isFiniteIn(r["intensity"], 0, 1)) {
      problems.push(`${field}[${i}].intensity 必须是 [0,1] 内的有限数值`);
      return null;
    }
    out.push({ axis: axisKey, intensity: r["intensity"] });
  }
  return out;
}

/**
 * 解析并校验 declared 事件载荷。
 *
 * 兼容注：缺 v/producer 的载荷按 v1 + resident-self 解释（MCP declare 工具的已验收面）；
 * 一旦声明 v 必须为 1。未知顶层字段拒绝——契约不允许静默漂移。
 */
export function parseDeclaredPayload(payload: unknown): ParsedDeclared {
  const problems: string[] = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, problems: ["payload 必须是对象"] };
  }
  const p = payload as Record<string, unknown>;

  const known = new Set(["v", "producer", "readings", "native", "textHash", "confidence", "mixed", "model"]);
  for (const k of Object.keys(p)) {
    if (!known.has(k)) problems.push(`未知字段 "${k}"——契约不允许静默漂移`);
  }

  let v = DECLARED_CONTRACT_VERSION;
  if (p["v"] !== undefined) {
    if (p["v"] !== DECLARED_CONTRACT_VERSION) problems.push(`v 必须是 ${DECLARED_CONTRACT_VERSION}`);
  }
  let producer: DeclaredProducer = "resident-self";
  if (p["producer"] !== undefined) {
    if (p["producer"] === "resident-self" || p["producer"] === "a2-classifier") producer = p["producer"];
    else problems.push('producer 必须是 "resident-self" | "a2-classifier"');
  }

  const readings = parseReadings(p["readings"], problems, "readings", { requireEngineAxis: true, max: 5 });

  let native: DeclaredReadingV1[] | undefined;
  if (p["native"] !== undefined) {
    const n = parseReadings(p["native"], problems, "native", { requireEngineAxis: false, max: 8 });
    if (n) native = n;
  }

  let model: DeclaredModelFingerprint | undefined;
  if (p["model"] !== undefined) {
    const m = p["model"] as Record<string, unknown>;
    if (!m || typeof m !== "object" || Array.isArray(m)) problems.push("model 必须是对象");
    else if (typeof m["name"] !== "string" || !m["name"] || typeof m["promptV"] !== "string" || !m["promptV"]) {
      problems.push("model.name / model.promptV 必须是非空字符串（gap 统计分层指纹）");
    } else model = { name: m["name"], promptV: m["promptV"] };
  }
  if (producer === "a2-classifier" && !model) {
    problems.push("a2-classifier 生产者必须携带 model 指纹（name + promptV）");
  }

  if (readings && producer === "a2-classifier") {
    // 机器读数没有「不想说」：缺轴 = 读数缺陷，必须显式给 0。
    const axes = new Set(readings.map((r) => r.axis));
    for (const a of ENGINE_AXES) {
      if (!axes.has(a)) problems.push(`a2-classifier 的 readings 必须全 5 轴申报（缺 "${a}"，缺席要显式给 0）`);
    }
  }

  let textHash: string | undefined;
  if (p["textHash"] !== undefined) {
    if (typeof p["textHash"] === "string" && /^sha256:[0-9a-f]{64}$/.test(p["textHash"])) textHash = p["textHash"];
    else problems.push('textHash 必须是 "sha256:<64位十六进制>"');
  }

  let confidence: number | undefined;
  if (p["confidence"] !== undefined) {
    if (isFiniteIn(p["confidence"], 0, 1)) confidence = p["confidence"];
    else problems.push("confidence 必须是 [0,1] 内的数值");
  }

  let mixed: boolean | undefined;
  if (p["mixed"] !== undefined) {
    if (typeof p["mixed"] === "boolean") mixed = p["mixed"];
    else problems.push("mixed 必须是布尔值");
  }

  if (problems.length || !readings) return { ok: false, problems };
  return { ok: true, payload: { v, producer, readings, native, textHash, confidence, mixed, model } };
}

// ── 投影（native → 引擎轴） ──

export interface ProjectionResult {
  readings: Array<{ axis: EngineAxis; intensity: number }>;
  /** 表外词：不投影（诚实缺失），交诊断计数。 */
  unprojected: string[];
}

/**
 * native 色谱 → 引擎轴。聚合 = max（混合情绪的强度不是相加）。
 * 投影表未覆盖的词不猜——返回 unprojected 交诊断。
 */
export function projectNativeToEngine(native: DeclaredReadingV1[]): ProjectionResult {
  const acc = new Map<EngineAxis, number>();
  const unprojected: string[] = [];
  for (const r of native) {
    let hit = false;
    for (const [axis, words] of Object.entries(NATIVE_PROJECTION_V0) as Array<[EngineAxis, readonly string[]]>) {
      if (words.includes(r.axis)) {
        hit = true;
        acc.set(axis, Math.max(acc.get(axis) ?? 0, r.intensity));
      }
    }
    if (!hit) unprojected.push(r.axis);
  }
  return {
    readings: [...acc.entries()].map(([axis, intensity]) => ({ axis, intensity })),
    unprojected,
  };
}
