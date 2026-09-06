/**
 * EQ-Bench 考场（A2 理解力上限卷）。
 *
 * 官方 v2 fullscale 评分（lib/scoring.py `calculate_score_fullscale` 的移植）：
 * 每题 4 情绪各打 0..10；逐情绪 d=|pred−ref|，d≤5 走 S 形缩放
 * 6.5/(1+e^(−1.2(d−4)))，否则取 d；题分 = 10 − tally×0.7477（随机作答 ≈ 0 分）；
 * 整体 = 100 × mean(题分)/10。本 runner 只做单轮（无修订轮），结果注明 first-pass。
 * 数据：github.com/EQ-bench/EQ-Bench data/eq_bench_v2_questions_171.json。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DeclaredClassifier } from "../classifier.js";
import { pool, printTable, sampleEven, writeResult } from "./harness.js";

export interface EQBenchQuestion {
  id: string;
  dialogue: string;
  emotions: string[]; // 4 个情绪词（保持题面顺序）
  reference: number[]; // 对应 0..10 参考分
}

interface EQBenchRaw {
  reference_answer_fullscale: Record<string, string | number>;
  prompt: string;
}

/** 从题面截取对话部分（到 [End dialogue] 为止）——不带官方作答格式说明，避免与 JSON 输出指令打架。 */
export function extractDialogue(prompt: string): string {
  const idx = prompt.indexOf("[End dialogue]");
  return idx >= 0 ? prompt.slice(0, idx + "[End dialogue]".length) : prompt;
}

export function loadEQBench(dataDir: string): EQBenchQuestion[] {
  const raw = JSON.parse(readFileSync(join(dataDir, "eqbench", "eq_bench_v2_questions_171.json"), "utf8")) as Record<string, EQBenchRaw>;
  return Object.entries(raw).map(([id, q]) => {
    const ref = q.reference_answer_fullscale;
    const emotions: string[] = [], reference: number[] = [];
    for (let i = 1; i <= 4; i++) {
      emotions.push(String(ref[`emotion${i}`] ?? ""));
      reference.push(Number(ref[`emotion${i}_score`]));
    }
    return { id, dialogue: extractDialogue(q.prompt), emotions, reference };
  });
}

/** 官方 v2 fullscale 题分（移植自 lib/scoring.py；情绪集合不匹配 → null 不可评分）。 */
export function eqBenchV2QuestionScore(reference: number[], user: number[]): number | null {
  if (user.length !== 4 || reference.length !== 4) return null;
  if (user.some((s) => !Number.isFinite(s) || s < 0)) return null;
  if (user.every((s) => s === 0)) return null; // 官方：至少一情绪 > 0
  let tally = 0;
  for (let i = 0; i < 4; i++) {
    const d = Math.abs(user[i]! - reference[i]!);
    if (d === 0) continue;
    tally += d <= 5 ? 6.5 * (1 / (1 + Math.exp(-1.2 * (d - 4)))) : d;
  }
  return 10 - tally * 0.7477;
}

export interface EQBenchRunOpts {
  n: number; // 题数（≤171；等距确定性采样）
  offset?: number; // 采样起点偏移（跑剩余题时用）
  concurrency?: number;
}

export async function runEQBench(
  clf: DeclaredClassifier,
  dataDir: string,
  opts: EQBenchRunOpts,
): Promise<{ summary: unknown; file: string }> {
  const all = loadEQBench(dataDir);
  const offset = opts.offset ?? 0;
  const questions = sampleEven(all.slice(offset), Math.min(opts.n, all.length - offset));
  const results = await pool(
    questions,
    (q) => clf.probe(q.dialogue, q.emotions).then((scores) => ({ q, user: q.emotions.map((e) => (scores[e] ?? 0) * 10) })),
    opts.concurrency ?? 4,
  );

  const perQuestion: Array<{ id: string; score: number | null; emotions: string[]; user: number[]; reference: number[] }> = [];
  let failed = 0;
  const scores: number[] = [];
  results.forEach((r, i) => {
    const q = questions[i]!;
    if (!r.ok) { failed++; perQuestion.push({ id: q.id, score: null, emotions: q.emotions, user: [], reference: q.reference }); return; }
    const score = eqBenchV2QuestionScore(r.value.q.reference, r.value.user);
    perQuestion.push({ id: r.value.q.id, score, emotions: r.value.q.emotions, user: r.value.user, reference: r.value.q.reference });
    if (score != null) scores.push(score);
  });

  const parseable = scores.length;
  const final = parseable ? (100 * (scores.reduce((a, b) => a + b, 0) / parseable)) / 10 : 0;
  const summary = {
    exam: "eqbench-v2-fullscale",
    model: clf.fingerprint.name,
    promptV: clf.fingerprint.promptV,
    revision: "first-pass-only",
    n: questions.length,
    parseable,
    failed,
    finalScore: final,
    perQuestion,
  };
  const file = writeResult("eqbench", clf.fingerprint.name, summary);
  console.log(`EQ-Bench v2 fullscale（first-pass）: final=${final.toFixed(1)} parseable=${parseable}/${questions.length} failed=${failed}`);
  if (failed > 0 && failed <= 5) {
    for (const r of results) if (!r.ok) console.log(`  失败: ${String(r.item.id)}: ${r.error.slice(0, 100)}`);
  }
  return { summary, file };
}
