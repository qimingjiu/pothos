/**
 * EmoBench 考场（A2 真实输入面卷，ACL 2024）。
 *
 * EU（情感理解：情绪识别 + 原因识别，每记录两道 MCQ）+ EA（情感应用，单 MCQ），
 * 中英双语各 200 记录。选择题走 mcq 模式（不走强度 probe）——考的是理解与采择，
 * 不是标尺。指标 = 准确率，分 EU-emotion / EU-cause / EA × en/zh。
 * 数据：github.com/Sahandfer/EmoBench data/EU.jsonl + EA.jsonl（MIT）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractJson, type ModelTransport } from "../classifier.js";
import { pool, printTable, sampleEven, writeResult } from "./harness.js";

export interface MCQItem {
  id: string;
  language: "en" | "zh";
  track: "EU-emotion" | "EU-cause" | "EA";
  scenario: string;
  subject: string;
  choices: string[];
  answer: string; // 正确选项文本
}

interface EURaw {
  qid: string; language: string; scenario: string; subject: string;
  emotion_choices: string[]; emotion_label: string;
  cause_choices: string[]; cause_label: string;
}
interface EARaw {
  qid: string; language: string; scenario: string; subject: string;
  choices: string[]; label: string;
}

const LETTERS = "ABCDEFG";

export function loadEmoBench(dataDir: string): MCQItem[] {
  const items: MCQItem[] = [];
  const eu = readFileSync(join(dataDir, "emobench", "EU.jsonl"), "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of eu) {
    const r = JSON.parse(line) as EURaw;
    items.push({ id: `EU-${r.qid}-emo`, language: r.language as "en" | "zh", track: "EU-emotion", scenario: r.scenario, subject: r.subject, choices: r.emotion_choices, answer: r.emotion_label });
    items.push({ id: `EU-${r.qid}-cause`, language: r.language as "en" | "zh", track: "EU-cause", scenario: r.scenario, subject: r.subject, choices: r.cause_choices, answer: r.cause_label });
  }
  const ea = readFileSync(join(dataDir, "emobench", "EA.jsonl"), "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of ea) {
    const r = JSON.parse(line) as EARaw;
    items.push({ id: `EA-${r.qid}`, language: r.language as "en" | "zh", track: "EA", scenario: r.scenario, subject: r.subject, choices: r.choices, answer: r.label });
  }
  return items;
}

export function mcqPrompt(item: MCQItem): string {
  const isZh = item.language === "zh";
  const listing = item.choices.map((c, i) => `${LETTERS[i]}. ${c}`).join("\n");
  const ask = isZh
    ? `读下面的情境，判断${item.track === "EU-cause" ? "最可能的原因" : item.subject ? `「${item.subject}」此刻最可能的情绪` : "最可能的情绪"}。只输出 JSON：{"answer":"A"}（answer 是选项字母）`
    : `Read the scenario below and decide ${item.track === "EU-cause" ? "the most plausible cause" : `how ${item.subject || "the person"} most likely feels`}. Output ONLY JSON: {"answer":"A"} (the option letter).`;
  return [ask, "", "<<<", item.scenario, ">>>", "", listing].join("\n");
}

export function parseMcqAnswer(raw: string, choiceCount: number): string | null {
  let obj: { answer?: unknown };
  try {
    obj = extractJson(raw) as { answer?: unknown };
  } catch {
    return null; // 不可解析 = 错题，交 runner 记 unparseable
  }
  const a = obj?.answer;
  if (typeof a !== "string") return null;
  const letter = a.trim().toUpperCase().slice(0, 1);
  const idx = LETTERS.indexOf(letter);
  return idx >= 0 && idx < choiceCount ? letter : null;
}

export interface EmoBenchRunOpts {
  nPerQuadrant: number; // 每象限（track × language）采样记录数
  concurrency?: number;
}

export async function runEmoBench(
  transport: ModelTransport,
  dataDir: string,
  opts: EmoBenchRunOpts,
): Promise<{ summary: unknown; file: string }> {
  const all = loadEmoBench(dataDir);
  const tracks: MCQItem["track"][] = ["EU-emotion", "EU-cause", "EA"];
  const langs: Array<"en" | "zh"> = ["en", "zh"];
  const sampled: MCQItem[] = [];
  for (const t of tracks) {
    for (const l of langs) {
      sampled.push(...sampleEven(all.filter((i) => i.track === t && i.language === l), opts.nPerQuadrant));
    }
  }

  const results = await pool(
    sampled,
    async (item) => {
      const raw = await transport.complete(mcqPrompt(item), { temperature: 0 });
      const letter = parseMcqAnswer(raw, item.choices.length);
      if (letter == null) throw new Error(`无法解析选项：${raw.slice(0, 80)}`);
      return { item, chosen: item.choices[LETTERS.indexOf(letter)], correct: item.choices[LETTERS.indexOf(letter)] === item.answer };
    },
    opts.concurrency ?? 4,
  );

  const cells: Record<string, { n: number; correct: number }> = {};
  for (const t of tracks) for (const l of langs) cells[`${t}-${l}`] = { n: 0, correct: 0 };
  const cell = (t: string, l: string): { n: number; correct: number } => cells[`${t}-${l}`] ?? { n: 0, correct: 0 };
  let unparseable = 0;
  results.forEach((r) => {
    if (!r.ok) { unparseable++; return; }
    const c = cell(r.value.item.track, r.value.item.language);
    c.n++;
    if (r.value.correct) c.correct++;
  });

  const acc = (t: string, l: string): number => {
    const c = cell(t, l);
    return c.n ? c.correct / c.n : Number.NaN;
  };
  const perCell = Object.fromEntries(tracks.flatMap((t) => langs.map((l) => [`${t}-${l}`, { n: cell(t, l).n, acc: acc(t, l) }])));
  const euVals = (["EU-emotion", "EU-cause"] as const).flatMap((t) => langs.map((l) => acc(t, l))).filter(Number.isFinite);
  const eaVals = langs.map((l) => acc("EA", l)).filter(Number.isFinite);
  const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN);
  const summary = {
    exam: "emobench",
    model: transport.fingerprint.name,
    nPerQuadrant: opts.nPerQuadrant,
    perCell,
    euMean: mean(euVals),
    eaMean: mean(eaVals),
    unparseable,
  };
  const file = writeResult("emobench", transport.fingerprint.name, summary);
  printTable(
    tracks.flatMap((t) =>
      langs.map((l) => {
        const c = cell(t, l);
        return { track: t, lang: l, n: c.n, acc: c.n ? (c.correct / c.n).toFixed(3) : "-" };
      }),
    ),
  );
  console.log(`EU mean=${summary.euMean.toFixed(3)} EA mean=${summary.eaMean.toFixed(3)} unparseable=${unparseable}`);
  return { summary, file };
}
