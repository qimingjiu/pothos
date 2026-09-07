/**
 * A2 declared 通道分类器——客户端/网关侧组件（本仓库提供契约适配层）。
 *
 * 「从表达推情绪×强度」。两个工作模式：
 *  - declare：表达 → 全 5 引擎轴读数（+ native 诊断层）→ 契约载荷 → declared 事件；
 *  - probe：表达 + 指定情绪词 → 0..1 强度（考场探针，SemEval EI-reg / EQ-Bench 用）。
 *
 * 传输抽象：arkcli 子进程（本地/考场，鉴权由 arkcli 托管）与脚本化 mock（测试，
 * 附录 B-7 纪律——mock 必须挂牌）。网关部署可另实现 HTTP 传输（OpenAI 兼容面）。
 *
 * 铁律在案：考场只准校准零件（锚点/投影/模型选择）；分类器读数不动动力学
 * （computeValuation 对 declared 恒空），对齐只在 bench/gap 层。
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DECLARED_CONTRACT_VERSION,
  ENGINE_AXIS_GLOSS,
  ENGINE_AXES,
  INTENSITY_ANCHORS_V1,
  INTENSITY_ANCHORS_V2,
  INTENSITY_SCALE_NOTE,
  parseDeclaredPayload,
  type DeclaredModelFingerprint,
  type DeclaredPayloadV1,
  type ParsedDeclared,
} from "./contract.js";

export const DECLARE_PROMPT_V1 = "declare-prompt-v1";
export const DECLARE_PROMPT_V2 = "declare-prompt-v2";
export const PROBE_PROMPT_V1 = "probe-prompt-v1";
export const PROBE_PROMPT_V2 = "probe-prompt-v2";

/** 一次补全调用。 */
export interface ModelTransport {
  readonly fingerprint: DeclaredModelFingerprint;
  complete(prompt: string, opts?: { temperature?: number; maxOutputTokens?: number }): Promise<string>;
}

const ARKCLI_DEFAULT_ENTRY = "D:/dev/npm-global/node_modules/@volcengine/ark-cli/scripts/run.js";

/**
 * arkcli 子进程传输：`arkcli +chat --text-format json_object`。
 * 鉴权由 arkcli 托管（本机 SSO），仓库不接触密钥。考场与本地网关用。
 */
export class ArkCliTransport implements ModelTransport {
  readonly fingerprint: DeclaredModelFingerprint;
  private readonly model: string;
  private readonly entry: string;
  private readonly timeoutMs: number;

  constructor(opts: { model: string; entry?: string; timeoutMs?: number; promptV?: string }) {
    this.model = opts.model;
    this.entry = opts.entry ?? process.env["ARKCLI_ENTRY"] ?? ARKCLI_DEFAULT_ENTRY;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.fingerprint = { name: opts.model, promptV: opts.promptV ?? DECLARE_PROMPT_V1 };
  }

  async complete(prompt: string, opts?: { temperature?: number; maxOutputTokens?: number }): Promise<string> {
    const args = [
      this.entry,
      "+chat",
      "--model", this.model,
      "--thinking", "disabled",
      "--temperature", String(opts?.temperature ?? 0),
      "--text-format", "json_object",
      "--format", "json",
      "--no-progress",
    ];
    if (opts?.maxOutputTokens) args.push("--max-output-tokens", String(opts.maxOutputTokens));
    args.push(prompt);
    const res = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, args, { windowsHide: true });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`arkcli 超时（${this.timeoutMs}ms）`));
      }, this.timeoutMs);
      child.stdout.on("data", (d: Buffer) => (stdout += d));
      child.stderr.on("data", (d: Buffer) => (stderr += d));
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
    });
    if (res.code !== 0) throw new Error(`arkcli 退出码 ${res.code}：${res.stderr.slice(-400)}`);
    // --format json 输出 {id, model, content, usage, ...}；取 content 字段
    try {
      const outer = JSON.parse(res.stdout) as { content?: string };
      if (typeof outer.content === "string") return outer.content;
    } catch {
      /* fallthrough：非 JSON 输出按原文返回 */
    }
    return res.stdout;
  }
}

/**
 * 脚本化传输（测试/无网演示）。挂牌假件（附录 B-7）：这不是测量，
 * 只是契约回路的确定性夹具——它「知道」的答案是脚本塞给它的。
 */
export class ScriptedTransport implements ModelTransport {
  readonly fingerprint: DeclaredModelFingerprint;
  private readonly script: (prompt: string) => string;

  constructor(script: (prompt: string) => string, fingerprint?: Partial<DeclaredModelFingerprint>) {
    this.script = script;
    this.fingerprint = { name: fingerprint?.name ?? "scripted-mock", promptV: fingerprint?.promptV ?? DECLARE_PROMPT_V1 };
  }

  async complete(prompt: string): Promise<string> {
    return this.script(prompt);
  }
}

/** 方舟 v3 OpenAI 兼容面默认端点（北京区）。 */
export const ARK_HTTP_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";

/**
 * 从 arkcli 配置文本解析 platform 型 profile 的 api_key（鉴权托管，仓库不硬编码密钥）。
 * 结构：profiles: 下两空格缩进的 profile 块，块内四空格子键 api_key / type；
 * 取 type: platform 那块的 api_key（agent plan 型 key 只通 Responses 面）。
 * 找不到返回 null（调用方抛可读错误）。行级状态机解析——不引入 YAML 依赖。
 */
export function parsePlatformKeyFromArkcliConfig(text: string): string | null {
  const lines = text.split(/\r?\n/);
  let current: { apiKey: string | null; type: string | null } | null = null;
  let found: string | null = null;
  const flush = (): void => {
    if (!found && current && current.type === "platform" && current.apiKey) found = current.apiKey;
  };
  for (const line of lines) {
    const prof = line.match(/^ {2}(\S+):\s*$/); // profile 块开始（两空格缩进键）
    if (prof) {
      flush();
      current = { apiKey: null, type: null };
      continue;
    }
    if (!current) continue;
    const m = line.match(/^ {4}(api_key|type):\s*(\S+)$/); // profile 内的四空格子键
    if (m) {
      if (m[1] === "api_key") current.apiKey = m[2]!;
      else if (m[1] === "type") current.type = m[2]!;
    }
  }
  flush();
  return found;
}

function resolveArkPlatformKey(): string {
  const env = process.env["POTHOS_ARK_API_KEY"];
  if (env) return env;
  const configPath = process.env["ARKCLI_CONFIG"] ?? join(homedir(), ".arkcli", "config.yaml");
  let apiKey: string | null = null;
  try {
    apiKey = parsePlatformKeyFromArkcliConfig(readFileSync(configPath, "utf8"));
  } catch {
    /* fallthrough：统一抛可读错误 */
  }
  if (!apiKey) {
    throw new Error(
      `HTTP 传输找不到凭据：设 POTHOS_ARK_API_KEY，或确保 arkcli 配置（${configPath}）里有 platform 型 profile 的 api_key` +
      `（agent plan 型 key 只通 Responses 面，v3 OpenAI 兼容面需要 platform 型凭据）。`,
    );
  }
  return apiKey;
}

/**
 * 方舟 v3 OpenAI 兼容 HTTP 传输（挂账件还账：契约 §5 预留的传输面）。
 *
 * 分工：agent plan 面（doubao-seed 家族，Responses API）走 `ArkCliTransport`；
 * v3 经典面的第三方家族（deepseek / glm / qwen / kimi……）走此传输——
 * 两面鉴权凭据不同（agent-plan 型 key 不通 v3），按 profile 类型取。
 * baseUrl 可配：Moonshot/OpenAI 兼容网关换 POTHOS_ARK_HTTP_BASE_URL 即接。
 *
 * 鉴权托管：POTHOS_ARK_API_KEY 显式 > arkcli 配置 platform profile（~/.arkcli/config.yaml）。
 * 仓库不硬编码、不打印密钥；错误信息只带 error.code（不带 key）。
 */
export class ArkHttpTransport implements ModelTransport {
  readonly fingerprint: DeclaredModelFingerprint;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(
    opts: { model: string; baseUrl?: string; apiKey?: string; promptV?: string; timeoutMs?: number; fetchFn?: typeof fetch },
  ) {
    this.baseUrl = (opts.baseUrl ?? process.env["POTHOS_ARK_HTTP_BASE_URL"] ?? ARK_HTTP_BASE_URL).replace(/\/$/, "");
    const key = opts.apiKey ?? process.env["POTHOS_ARK_API_KEY"] ?? resolveArkPlatformKey();
    this.apiKey = key;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.fingerprint = { name: opts.model, promptV: opts.promptV ?? DECLARE_PROMPT_V1 };
  }

  async complete(prompt: string, req?: { temperature?: number; maxOutputTokens?: number }): Promise<string> {
    const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.fingerprint.name,
        messages: [{ role: "user", content: prompt }],
        temperature: req?.temperature ?? 0,
        ...(req?.maxOutputTokens ? { max_tokens: req.maxOutputTokens } : {}),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    } as RequestInit);
    if (!res.ok) {
      let code = `HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { error?: { code?: string; message?: string } };
        if (j.error?.code) code = `${j.error.code}（${(j.error.message ?? "").slice(0, 120)}）`;
      } catch { /* 非 JSON 错误体：保留状态码 */ }
      throw new Error(`ark v3 调用失败：${code}`);
    }
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = j.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error(`ark v3 输出缺 choices[0].message.content`);
    return content;
  }
}

/** 从模型输出中提取第一个平衡 JSON 对象（容忍 markdown 围栏/前后噪声）。 */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) throw new Error(`输出中没有 JSON 对象：${text.slice(0, 120)}`);
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error(`JSON 对象不闭合：${text.slice(0, 120)}`);
}

export function sha256Text(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** 锚点文本：v1 原版；v2 = SemEval 实测后的负价校准版（契约 §3/§9）。 */
function anchorLines(v2: boolean): string {
  const src = v2 ? INTENSITY_ANCHORS_V2 : INTENSITY_ANCHORS_V1;
  return Object.entries(src)
    .filter(([k]) => k !== "negativeCalibration")
    .map(([k, v]) => `- ${k} = ${v}`)
    .join("\n");
}

export function declarePrompt(text: string, v2 = false): string {
  const axes = ENGINE_AXES.map((a) => `- ${a}: ${ENGINE_AXIS_GLOSS[a]}`).join("\n");
  return [
    "你是 declared 通道的分类器。读下面的表达（一个对话住户模型的输出），对五个功能通道各打一个 0..1 的强度分。",
    "通道（功能槽）：", axes,
    "强度标尺锚点：", anchorLines(v2),
    v2 ? INTENSITY_ANCHORS_V2.negativeCalibration : "",
    INTENSITY_SCALE_NOTE,
    "五个通道必须全部打分（缺席也要显式给 0）。若文本里有更细的原生情绪，放入 native 数组（小写英文词，最多 8 条）。",
    '只输出 JSON 对象：{"readings":[{"axis":"longing","intensity":0},{"axis":"distress","intensity":0},{"axis":"warmth","intensity":0},{"axis":"fatigue","intensity":0},{"axis":"curiosity","intensity":0}],"native":[{"axis":"sadness","intensity":0}],"mixed":false,"confidence":0}',
    "",
    "表达：",
    "<<<",
    text,
    ">>>",
  ].filter(Boolean).join("\n");
}

export function probePrompt(text: string, emotions: string[], v2 = false): string {
  const keys = emotions.map((e) => `"${e}":0`).join(",");
  return [
    `对下面文本中下列情绪各打一个 0..1 的强度分：${emotions.join("、")}。`,
    "强度标尺锚点：", anchorLines(v2),
    v2 ? INTENSITY_ANCHORS_V2.negativeCalibration : "",
    INTENSITY_SCALE_NOTE,
    `只输出 JSON 对象：{"scores":{${keys}}}`,
    "",
    "文本：",
    "<<<",
    text,
    ">>>",
  ].filter(Boolean).join("\n");
}

/** 确定性邻居取整：契约要求最多两位小数。 */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** A2 分类器：契约载荷的生产者。 */
export class DeclaredClassifier {
  private readonly promptVersion: DeclaredModelFingerprint["promptV"];

  constructor(
    private readonly transport: ModelTransport,
    private readonly opts: { temperature?: number; promptV?: "v1" | "v2" } = {},
  ) {
    // prompt 版本以 classifier 为准（考场与 declared 事件的 model.promptV 都取 fingerprint）：
    // 显式 opts.promptV 覆盖 transport 默认；v2 = 负价校准锚点（INTENSITY_ANCHORS_V2）。
    this.promptVersion =
      opts.promptV === "v2" ? DECLARE_PROMPT_V2
      : opts.promptV === "v1" ? DECLARE_PROMPT_V1
      : transport.fingerprint.promptV;
  }

  /** 指纹（考场结果与 declared 事件的 model 指纹同源；promptV 以 classifier 为准）。 */
  get fingerprint(): DeclaredModelFingerprint {
    return { ...this.transport.fingerprint, promptV: this.promptVersion };
  }

  private isV2(): boolean {
    return this.promptVersion === DECLARE_PROMPT_V2 || this.promptVersion === PROBE_PROMPT_V2;
  }

  /** declare 模式：表达 → 契约载荷（未过校验的原始解析结果 + 原文哈希）。 */
  async declare(text: string): Promise<(ParsedDeclared & { raw: string; textHash: string })> {
    const raw = await this.transport.complete(declarePrompt(text, this.isV2()), { temperature: this.opts.temperature ?? 0 });
    const textHash = sha256Text(text);
    const parsed = this.parseAsPayload(raw, { textHash });
    return { ...parsed, raw, textHash };
  }

  /** probe 模式（考场）：表达 + 指定情绪词 → 各 0..1 强度。 */
  async probe(text: string, emotions: string[]): Promise<Record<string, number>> {
    const raw = await this.transport.complete(probePrompt(text, emotions, this.isV2()), { temperature: this.opts.temperature ?? 0 });
    return parseProbeScores(raw, emotions);
  }

  /** 把模型原始输出解释为契约载荷（补齐 v/producer/model/textHash 再过校验）。 */
  parseAsPayload(raw: string, extra: { textHash?: string } = {}): ParsedDeclared {
    let obj: unknown;
    try {
      obj = extractJson(raw);
    } catch (e) {
      return { ok: false, problems: [String(e)] };
    }
    const candidate = obj as Record<string, unknown>;
    const readings = Array.isArray(candidate["readings"])
      ? (candidate["readings"] as Array<Record<string, unknown>>).map((r) => ({
          axis: String(r["axis"] ?? ""),
          intensity: round2(Number(r["intensity"])),
        }))
      : undefined;
    const native = Array.isArray(candidate["native"])
      ? (candidate["native"] as Array<Record<string, unknown>>).map((r) => ({
          axis: String(r["axis"] ?? "").toLowerCase(),
          intensity: round2(Number(r["intensity"])),
        }))
      : undefined;
    const payload = {
      v: DECLARED_CONTRACT_VERSION,
      producer: "a2-classifier" as const,
      readings,
      native,
      mixed: typeof candidate["mixed"] === "boolean" ? candidate["mixed"] : undefined,
      confidence:
        typeof candidate["confidence"] === "number" && Number.isFinite(candidate["confidence"])
          ? round2(candidate["confidence"])
          : undefined,
      model: this.transport.fingerprint,
      textHash: extra.textHash,
    };
    return parseDeclaredPayload(payload);
  }
}

/** 解析 probe 输出为 0..1 分数表（缺词/越界按问题返回抛错——考场对错题诚实计 0 分并记数）。 */
export function parseProbeScores(raw: string, emotions: string[]): Record<string, number> {
  const obj = extractJson(raw) as { scores?: Record<string, unknown> };
  const scores = obj?.scores;
  if (!scores || typeof scores !== "object") throw new Error(`probe 输出缺 scores：${raw.slice(0, 120)}`);
  const out: Record<string, number> = {};
  for (const e of emotions) {
    const v = scores[e] ?? scores[e.toLowerCase?.() ?? e];
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isFinite(n)) throw new Error(`probe 输出缺情绪 "${e}" 的分数`);
    out[e] = Math.min(1, Math.max(0, n));
  }
  return out;
}

/** 便利：declare 结果 → declared 事件 payload（校验通过时），可直接 ingest。 */
export function toDeclaredEventPayload(parsed: ParsedDeclared): DeclaredPayloadV1 {
  if (!parsed.ok) throw new Error(`契约校验失败：${parsed.problems.join("；")}`);
  return parsed.payload;
}
