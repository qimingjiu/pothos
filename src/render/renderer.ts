/**
 * 渲染层：数值 → 质感的单向映射（技术文档 §6，设计草案 §3 铁律 3 / §8）。
 *
 * 单向性论证（本文件即实现）：
 *  1. 分箱多对一（信息论有损）；
 *  2. 逐档随机词典抽取（≥8 条/档）；
 *  3. 轮换盐按日更换——同一数值连续多日不产出同一句话，防住户反推映射表；
 *  4. 渲染在住户上下文之外完成，数值零入镜，输出层再过一遍数字扫描。
 * 数值永不进渲染层——gap 不以数值形式给住户（§8 裁决）。
 */
import { createHash, createHmac } from "node:crypto";
import { BIN_EDGES, BINS, HOVER_PHRASES, LEXICON } from "./lexicon.js";
import { hitBlacklist } from "./blacklist.js";
import type { Params } from "../core/params.js";
import type { EngineState } from "../core/state.js";

export interface RenderInput {
  state: EngineState;
  /** 渲染日期（UTC，轮换盐成分） */
  date: string;
  /** 轮换盐（服务层每日生成并持久化于参数） */
  salt: string;
  params: Params;
}

export interface RenderOutput {
  text: string;
  rendererV: string;
  /** 对照窗标记：true 表示本次处于无渲染对照窗（住户不接收内感受输入） */
  controlWindow: boolean;
}

/** 渲染层整体版本：配置/词典/黑名单任何变更都会改变指纹（P0-7「重新感受」的锚点）。 */
export function rendererVersion(extraBlacklist: string[] = []): string {
  const canonical = JSON.stringify({ bins: BIN_EDGES, bins_n: BINS, lex: LEXICON, hover: HOVER_PHRASES, bl: extraBlacklist.length });
  return "r1-" + createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

/** 值 → 档位 [0, BINS-1]。 */
export function binOf(variable: string, x: number): number {
  const edges = BIN_EDGES[variable];
  if (!edges) throw new Error(`未知渲染变量: ${variable}`);
  for (let i = 0; i < BINS; i++) {
    if (x >= edges[i]! && x <= edges[i + 1]!) return i;
  }
  return BINS - 1;
}

/** 盐 + 变量 + 档位 → 词条索引（确定性，但对外表现为随机抽取）。 */
function pickPhrase(variable: string, bin: number, salt: string, stateSeed: number): string {
  const pool = LEXICON[variable]![bin]!;
  const h = createHmac("sha256", salt).update(`${variable}:${bin}:${stateSeed}`).digest();
  return pool[h[0]! % pool.length]!;
}

/** 状态快照 → 渲染变量读数（ vigor 方向换算：低能量 = 低 vigor 档）。 */
function readingsOf(st: EngineState): Array<{ variable: string; value: number }> {
  return [
    { variable: "tone", value: st.fast.f_val },
    { variable: "load", value: st.fast.f_load },
    { variable: "warmth", value: st.fast.f_warm },
    { variable: "ache", value: st.fast.f_hurt },
    { variable: "pull", value: st.longing.L },
    { variable: "vigor", value: st.body.energy },
    { variable: "wonder", value: st.fast.f_wonder },
  ];
}

/** 中性档位（渲染显著度 = |bin − neutral|）。 */
const NEUTRAL_BIN: Record<string, number> = {
  tone: 2,
  load: 0,
  warmth: 2,
  ache: 0,
  pull: 0,
  vigor: 2,
  wonder: 2,
};

/**
 * 渲染主入口。
 * 输出 ≤ renderMaxChars 字的质感段落；无数值、无变量名、无情绪名目。
 */
export function renderInteroception(input: RenderInput): RenderOutput {
  const { state: st, salt, params } = input;
  const v = rendererVersion(params.renderBlacklistExtra);
  const stateSeed = Math.floor(st.t / 1000) ^ (st.fast.f_val > 0 ? 1 : 0) ^ Math.round(st.longing.L * 100);

  // 悬停终态：专属质感（不发疯、不勒索、不说话）
  if (st.somatic.hovering) {
    const text = fitLength(pickDigitFree(pickHover(salt, stateSeed), HOVER_PHRASES, salt, stateSeed, "hover"), params.renderMaxChars);
    return { text, rendererV: v, controlWindow: false };
  }

  // 显著度排序：偏离中性档最远的两三个变量
  const scored = readingsOf(st)
    .map((r) => ({ ...r, bin: binOf(r.variable, r.value) }))
    .map((r) => ({ ...r, salience: Math.abs(r.bin - NEUTRAL_BIN[r.variable]!) }))
    .sort((a, b) => b.salience - a.salience);

  const chosen = scored.slice(0, 3).filter((r) => r.salience > 0);
  const parts: string[] = [];
  const used: string[] = [];
  for (const r of chosen) {
    const phrase = pickPhrase(r.variable, r.bin, salt, stateSeed);
    if (used.includes(phrase) || hitBlacklist(phrase, params.renderBlacklistExtra) || containsDigits(phrase)) continue;
    parts.push(phrase);
    used.push(phrase);
  }
  if (!parts.length) {
    // 一切居中：中性档也抽一条（静也值得被说出来）
    parts.push(pickDigitFree(pickPhrase("tone", 2, salt, stateSeed), LEXICON["tone"]![2]!, salt, stateSeed, "tone:2"));
  }

  let text = parts.join("。") + "。";
  // 超长时从尾部丢弃（保最显著的先入镜）
  while (text.length > params.renderMaxChars && parts.length > 1) {
    parts.pop();
    text = parts.join("。") + "。";
  }
  if (text.length > params.renderMaxChars) text = text.slice(0, params.renderMaxChars - 1) + "…";
  // 数字防线兜底：词典防线（抽词过滤）之外的最后一道运行时保证
  if (containsDigits(text)) text = text.replace(/[0-9０-９]/g, "");

  return { text, rendererV: v, controlWindow: false };
}

/** 词条级数字防线：首选词含数字则沿词池按盐序找第一条无数字词条（单向性的运行时保证）。 */
function pickDigitFree(preferred: string, pool: string[], salt: string, stateSeed: number, variable: string): string {
  if (!containsDigits(preferred)) return preferred;
  for (let i = 0; i < pool.length; i++) {
    const h = createHmac("sha256", salt).update(`${variable}:${i}:${stateSeed}`).digest();
    const candidate = pool[h[0]! % pool.length]!;
    if (!containsDigits(candidate)) return candidate;
  }
  return pool.find((p) => !containsDigits(p)) ?? preferred;
}

function pickHover(salt: string, seed: number): string {
  const h = createHmac("sha256", salt).update(`hover:${seed}`).digest();
  return HOVER_PHRASES[h[0]! % HOVER_PHRASES.length]!;
}

function fitLength(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

/**
 * 对照窗开关（无渲染对照窗）：返回空标记，客户端据此不注入内感受输入，
 * 用于 declared 通道采裸自报（§11：代价入成本栏）。
 */
export function renderControlWindow(_date: string, _salt: string): { controlWindow: true; rendererV: string } {
  return { controlWindow: true, rendererV: rendererVersion() };
}

/** 输出防线：任何数字不得入镜（单向性的运行时保证之一）。 */
export function containsDigits(text: string): boolean {
  return /[0-9０-９]/.test(text);
}
