/**
 * 考场共享件测试：统计量的数学正确性（pearson 曾手滑写成 sx·sx，n>1 时 r 可 >1——
 * 用完全相关用例锁死：任何 pearson 实现必须给出 |r| ≤ 1）。
 */
import { describe, expect, it } from "vitest";
import { pearson, mae, sampleEven, pool } from "../../src/declared/exams/harness.js";
import { eqBenchV2QuestionScore } from "../../src/declared/exams/eqbench.js";
import { parseEIRegTSV } from "../../src/declared/exams/semeval.js";
import { mcqPrompt, parseMcqAnswer, loadEmoBench } from "../../src/declared/exams/emobench.js";

describe("考场共享件", () => {
  it("pearson：完全正相关 = 1，完全负相关 = −1", () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 10);
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 10);
  });

  it("pearson：已知值与方差为零的守卫", () => {
    // 近似线性：r ≈ 0.993
    expect(pearson([1, 2, 3], [1, 3, 6])).toBeCloseTo(0.993, 2);
    expect(Number.isNaN(pearson([1, 1, 1], [1, 2, 3]))).toBe(true); // xs 无方差
    expect(Number.isNaN(pearson([1, 2], [3]))).toBe(true); // n<2
  });

  it("mae 与等距采样", () => {
    expect(mae([0.5, 0.5], [0.25, 0.75])).toBeCloseTo(0.25);
    const s = sampleEven([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 3);
    expect(s).toEqual([0, 3, 6]); // floor(i·10/3) = 0,3,6——确定性可复现
    expect(sampleEven([1, 2], 5)).toEqual([1, 2]);
  });

  it("pool：结果与输入逐位对应，错误不打断其余", async () => {
    const out = await pool([1, 2, 3, 4], async (x) => {
      if (x === 3) throw new Error("boom");
      return x * 10;
    }, 2);
    expect(out.map((r) => (r.ok ? r.value : null))).toEqual([10, 20, null, 40]);
    expect(out[2]).toMatchObject({ ok: false, error: "boom" });
  });

  it("EQ-Bench v2 题分：零差 = 满分 10，随机 ≈ 0，缺 4 情绪 = null", () => {
    expect(eqBenchV2QuestionScore([1, 3, 0, 5], [1, 3, 0, 5])).toBeCloseTo(10, 6);
    expect(eqBenchV2QuestionScore([0, 10, 0, 0], [10, 0, 0, 0])).toBeLessThan(1);
    expect(eqBenchV2QuestionScore([1, 2, 3], [1, 2, 3])).toBeNull();
    expect(eqBenchV2QuestionScore([1, 2, 3, 4], [0, 0, 0, 0])).toBeNull(); // 官方：至少一情绪 > 0
  });
});

describe("考场数据解析", () => {
  it("EI-reg TSV：跳表头、容忍 BOM/CRLF、推文含制表符不崩", () => {
    const tsv = "\uFEFFID\tTweet\tAffect Dimension\tIntensity Score\r\nA1\thello\tanger\t0.500\r\nA2\ta\tb\tjoy\t0.250\r\n";
    const items = parseEIRegTSV(tsv);
    expect(items).toEqual([
      { id: "A1", tweet: "hello", emotion: "anger", gold: 0.5 },
      { id: "A2", tweet: "a\tb", emotion: "joy", gold: 0.25 },
    ]);
  });

  it("EmoBench：MCQ 提示词与字母解析（含越界字母拒绝）", () => {
    const items = loadEmoBench("exams/data");
    expect(items.length).toBe(1200); // EU 400×2 + EA 400
    const item = items[0]!;
    const p = mcqPrompt(item);
    expect(p).toContain('{"answer":"A"}');
    const tail = p.split("\n").slice(-item.choices.length);
    expect(tail.filter((l) => /^[A-G]\. /.test(l)).length).toBe(item.choices.length); // 末尾选项块完整
    expect(parseMcqAnswer('{"answer":"B"}', item.choices.length)).toBe("B");
    expect(parseMcqAnswer('{"answer":"b"}', item.choices.length)).toBe("B");
    expect(parseMcqAnswer('{"answer":"Z"}', item.choices.length)).toBeNull();
    expect(parseMcqAnswer("不是 JSON", item.choices.length)).toBeNull();
  });
});
