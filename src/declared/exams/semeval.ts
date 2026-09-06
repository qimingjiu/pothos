/**
 * SemEval-2018 Task 1 · EI-reg 考场（A2 强度标尺标定卷）。
 *
 * 官方形态的「情绪强度回归」：给定推文与情绪，输出 0..1 实值强度。
 * 官方指标 = 分情绪 Pearson r；补 MAE 与校准桶（预测 vs 金标的分桶偏差）。
 * 数据：官方分发 zip（saifmohammad.com），许可禁止再分发——本地解包不入库。
 *
 * 铁律在案：分数只用于强度标尺锚点（INTENSITY_ANCHORS_V1）与投影表校准，
 * 永不回流引擎。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DeclaredClassifier } from "../classifier.js";
import { mae, pearson, pool, printTable, sampleEven, writeResult } from "./harness.js";

export interface EIRegItem {
  id: string;
  tweet: string;
  emotion: string;
  gold: number;
}

/** 解析 EI-reg TSV（UTF-8 BOM + 表头 + CRLF；推文含制表符时按首尾列保护）。 */
export function parseEIRegTSV(content: string): EIRegItem[] {
  const items: EIRegItem[] = [];
  for (const rawLine of content.replace(/^\uFEFF/, "").split(/\r?\n/).slice(1)) {
    if (!rawLine.trim()) continue;
    const parts = rawLine.split("\t");
    if (parts.length < 4) continue;
    const id = parts[0];
    const emotion = parts[parts.length - 2];
    const gold = Number(parts[parts.length - 1]);
    const tweet = parts.slice(1, parts.length - 2).join("\t");
    if (!id || !emotion || !Number.isFinite(gold)) continue;
    items.push({ id, tweet, emotion, gold });
  }
  return items;
}

export function loadEIRegTestGold(dataDir: string, emotions: string[]): Record<string, EIRegItem[]> {
  const base = join(dataDir, "semeval2018", "SemEval2018-Task1-all-data", "English", "EI-reg", "test-gold");
  const out: Record<string, EIRegItem[]> = {};
  for (const e of emotions) {
    out[e] = parseEIRegTSV(readFileSync(join(base, `2018-EI-reg-En-${e}-test-gold.txt`), "utf8"));
  }
  return out;
}

export interface SemevalRunOpts {
  nPerEmotion: number; // 每情绪采样条数（等距确定性采样）
  concurrency?: number;
  emotions?: string[];
}

/** 跑考场：probe 模式（与 declare 共用同一份标尺锚点）。 */
export async function runSemevalEIReg(
  clf: DeclaredClassifier,
  dataDir: string,
  opts: SemevalRunOpts,
): Promise<{ summary: unknown; file: string }> {
  const emotions = opts.emotions ?? ["anger", "fear", "joy", "sadness"];
  const data = loadEIRegTestGold(dataDir, emotions);
  const perEmotion: Record<string, { pearson: number; mae: number; n: number; failed: number; meanGold: number; meanPred: number }> = {};
  const allPred: number[] = [], allGold: number[] = [];
  const buckets: Array<{ lo: number; hi: number; n: number; gold: number; pred: number }> = [];
  for (let i = 0; i < 5; i++) buckets.push({ lo: i * 0.2, hi: (i + 1) * 0.2, n: 0, gold: 0, pred: 0 });

  for (const e of emotions) {
    const items = sampleEven(data[e] ?? [], opts.nPerEmotion);
    const results = await pool(
      items,
      (item) => clf.probe(item.tweet, [item.emotion]),
      opts.concurrency ?? 4,
    );
    const pred: number[] = [], gold: number[] = [];
    let failed = 0;
    results.forEach((r, i) => {
      const it = items[i]!;
      if (r.ok) {
        pred.push(r.value[it.emotion] ?? 0);
        gold.push(it.gold);
        const b = buckets.find((x) => it.gold >= x.lo && (it.gold < x.hi || (x.hi === 1 && it.gold <= 1)));
        if (b) { b.n++; b.gold += it.gold; b.pred += r.value[it.emotion] ?? 0; }
      } else failed++;
    });
    allPred.push(...pred);
    allGold.push(...gold);
    perEmotion[e] = {
      pearson: pearson(pred, gold),
      mae: mae(pred, gold),
      n: pred.length,
      failed,
      meanGold: gold.reduce((a, b) => a + b, 0) / (gold.length || 1),
      meanPred: pred.reduce((a, b) => a + b, 0) / (pred.length || 1),
    };
  }

  const calibration = buckets
    .filter((b) => b.n > 0)
    .map((b) => ({ goldBin: `${b.lo.toFixed(1)}-${b.hi.toFixed(1)}`, n: b.n, meanGold: b.gold / b.n, meanPred: b.pred / b.n }));

  const summary = {
    exam: "semeval2018-eireg",
    split: "test-gold",
    model: clf.fingerprint.name,
    promptV: clf.fingerprint.promptV,
    nPerEmotion: opts.nPerEmotion,
    perEmotion,
    overall: { pearson: pearson(allPred, allGold), mae: mae(allPred, allGold), n: allPred.length },
    calibration,
  };
  const file = writeResult("semeval-eireg", clf.fingerprint.name, summary);
  printTable(
    emotions.map((e) => {
      const m = perEmotion[e] ?? { n: 0, failed: 0, pearson: Number.NaN, mae: Number.NaN, meanGold: Number.NaN, meanPred: Number.NaN };
      return {
        emotion: e,
        n: m.n,
        failed: m.failed,
        pearson: m.pearson.toFixed(3),
        mae: m.mae.toFixed(3),
        meanGold: m.meanGold.toFixed(3),
        meanPred: m.meanPred.toFixed(3),
      };
    }),
  );
  console.log(`overall pearson=${pearson(allPred, allGold).toFixed(3)} mae=${mae(allPred, allGold).toFixed(3)} n=${allPred.length}`);
  return { summary, file };
}
