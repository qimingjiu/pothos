/**
 * 考场共享件：统计量、确定性采样、并发池、结果落盘。
 *
 * 铁律在案：考场分数只进两处——零件选型与 docs/ 基线记录；永不进训练信号、
 * 永不进引擎动力学、生产 gap 统计永不回流校准（R3-16/三审缝合口径同步生效）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return Number.NaN;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i]!, y = ys[i]!;
    sx += x; sy += y;
    sxx += x * x; syy += y * y; sxy += x * y;
  }
  const cov = n * sxy - sx * sy;
  const vx = n * sxx - sx * sx;
  const vy = n * syy - sy * sy;
  if (vx <= 0 || vy <= 0) return Number.NaN;
  return cov / Math.sqrt(vx * vy);
}

export function mae(pred: number[], gold: number[]): number {
  const n = Math.min(pred.length, gold.length);
  if (n === 0) return Number.NaN;
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.abs(pred[i]! - gold[i]!);
  return s / n;
}

/** 确定性等距采样（代表性优先于随机性；可复现——基线数字要能对账）。 */
export function sampleEven<T>(items: T[], n: number): T[] {
  if (n >= items.length) return [...items];
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.floor((i * items.length) / n)]!);
  return out;
}

/** 有界并发池。arkcli 子进程重（每调用一个进程），默认并发 4。 */
export async function pool<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
  onProgress?: (done: number, total: number) => void,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: string; item: T }>> {
  const results = new Array<{ ok: true; value: R } | { ok: false; error: string; item: T }>(items.length);
  let next = 0, done = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      const item = items[i]!;
      try {
        results[i] = { ok: true, value: await fn(item, i) };
      } catch (e) {
        results[i] = { ok: false, error: String(e instanceof Error ? e.message : e), item };
      }
      done++;
      onProgress?.(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return results;
}

/** 结果落盘：exams/results/<name>-<model>-<ts>.json（数据不入库，结果入 docs 口径）。 */
export function writeResult(name: string, model: string, payload: unknown): string {
  const dir = join(process.cwd(), "exams", "results");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}-${model.replace(/[^\w.-]+/g, "_")}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
  return file;
}

/** 简单表格输出（跑完即读）。 */
export function printTable(rows: Array<Record<string, string | number>>): void {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]!);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(w[i]!)).join("  ");
  console.log(line(cols));
  console.log(line(w.map((x) => "-".repeat(x))));
  for (const r of rows) console.log(line(cols.map((c) => String(r[c] ?? ""))));
}
