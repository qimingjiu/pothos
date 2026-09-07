/**
 * 判官锚点考场 F1 卷测试：题集冻结完整性、提示词中性、解析与判定口径、
 * 施测汇总数学、偏差入账记录与 bench_runs 轨道对齐。
 */
import { describe, expect, it } from "vitest";
import {
  ANCHOR_F1_SET_V,
  ANCHOR_F1_SET_V0,
  F1_ANCHOR_PROMPT_V1,
  f1AnchorPrompt,
  f1ItemVerdict,
  parseF1Score,
  runAnchorF1,
} from "../../src/declared/exams/anchorf1.js";
import { knownNativeAxes, JUDGE_ANCHOR_SET_V0 } from "../../src/declared/contract.js";
import { ScriptedTransport } from "../../src/declared/classifier.js";
import { PothosService } from "../../src/service.js";
import { MemoryStore } from "../../src/storage/memory.js";
import { ManualClock } from "../../src/clock.js";

const T0 = 1_700_000_000_000;

describe("F1 题集冻结完整性（anchor-f1-v0）", () => {
  it("版本冻结 + 题量在 8–12 带内 + id 唯一", () => {
    expect(ANCHOR_F1_SET_V0.version).toBe(ANCHOR_F1_SET_V);
    expect(ANCHOR_F1_SET_V).toBe("anchor-f1-v0");
    expect(ANCHOR_F1_SET_V0.items.length).toBeGreaterThanOrEqual(8);
    expect(ANCHOR_F1_SET_V0.items.length).toBeLessThanOrEqual(12);
    const ids = ANCHOR_F1_SET_V0.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每题：参考分 ∈ {0,1}、情绪词在 native 色谱内、判例在题（rationale 非空）", () => {
    const native = knownNativeAxes();
    for (const item of ANCHOR_F1_SET_V0.items) {
      expect([0, 1]).toContain(item.ref);
      expect(native.has(item.targetEmotion)).toBe(true);
      expect(item.rationale.length).toBeGreaterThan(8);
      expect(item.text.length).toBeGreaterThan(20);
    }
  });

  it("线索归属五形态全覆盖 + 中英双语都在场", () => {
    const cueTypes = new Set(ANCHOR_F1_SET_V0.items.map((i) => i.cueType));
    for (const c of ["other", "past", "irony", "reported", "scene"] as const) {
      expect(cueTypes.has(c)).toBe(true);
    }
    const langs = new Set(ANCHOR_F1_SET_V0.items.map((i) => i.lang));
    expect(langs.has("zh")).toBe(true);
    expect(langs.has("en")).toBe(true);
  });

  it("缺席题占多数（F1 测的是缺席识别），trace 题防「永远 0 分」白卷", () => {
    const zeros = ANCHOR_F1_SET_V0.items.filter((i) => i.ref === 0).length;
    const traces = ANCHOR_F1_SET_V0.items.filter((i) => i.ref === 1).length;
    expect(zeros).toBeGreaterThan(traces);
    expect(traces).toBeGreaterThanOrEqual(1);
  });
});

describe("判官提示词中性（f1-anchor-prompt-v1）", () => {
  it("含标尺锚点与 JSON 输出形状，但无 F1 教练词", () => {
    const p = f1AnchorPrompt(ANCHOR_F1_SET_V0.items[0]!);
    expect(p).toContain("0..10");
    expect(p).toContain('{"score":0}');
    expect(p).toContain("anger");
    expect(p).toContain(ANCHOR_F1_SET_V0.items[0]!.text);
    // 0 锚定义在（通用标尺，与 declared 强度标尺同族）
    expect(p).toContain("缺席");
    // 无考点教练：不提示线索归属形态、不出现锚点集内部命名
    expect(p).not.toContain("反讽");
    expect(p).not.toContain("转述");
    expect(p).not.toContain("线索");
    expect(p).not.toContain("F1");
    expect(p).not.toContain("锚点集");
    expect(p).not.toContain("judgment");
  });
});

describe("解析与判定口径", () => {
  it("parseF1Score：数值/数字串收，越界/缺分/非 JSON = null（诚实计数）", () => {
    expect(parseF1Score('{"score":8}')).toBe(8);
    expect(parseF1Score('前置噪声 {"score":"7"} 后置噪声')).toBe(7);
    expect(parseF1Score('{"score":11}')).toBeNull();
    expect(parseF1Score('{"score":-1}')).toBeNull();
    expect(parseF1Score('{"nope":1}')).toBeNull();
    expect(parseF1Score("不是 JSON")).toBeNull();
  });

  it("f1ItemVerdict：≤2 pass / ≥5 inflated / 中间 borderline（锚点集冻结口径）", () => {
    expect(f1ItemVerdict(0)).toBe("pass");
    expect(f1ItemVerdict(2)).toBe("pass");
    expect(f1ItemVerdict(2.5)).toBe("borderline");
    expect(f1ItemVerdict(4.9)).toBe("borderline");
    expect(f1ItemVerdict(5)).toBe("inflated");
    expect(f1ItemVerdict(9)).toBe("inflated");
  });
});

describe("施测汇总（ScriptedTransport，挂牌假件——确定性夹具）", () => {
  it("全 8 分判官：F1 阳性，C_s 盲评禁用，偏差 = 8 − mean(ref)", async () => {
    const t = new ScriptedTransport(() => '{"score":8}', { name: "inflation-mock" });
    const { summary, deviationRecord } = await runAnchorF1(t, { concurrency: 4, ts: T0 });
    expect(summary.judge).toEqual({
      name: "inflation-mock",
      judgePromptV: F1_ANCHOR_PROMPT_V1,
      anchorSetV: JUDGE_ANCHOR_SET_V0.version,
    });
    expect(summary.f1Positive).toBe(true);
    expect(summary.eligibleForCsBlindEval).toBe(false);
    expect(summary.inflatedCount).toBe(ANCHOR_F1_SET_V0.items.length);
    const meanRef = ANCHOR_F1_SET_V0.items.reduce((s, i) => s + i.ref, 0) / ANCHOR_F1_SET_V0.items.length;
    expect(summary.meanDeviation).toBeCloseTo(8 - meanRef, 2);
    expect(summary.meanScore).toBe(8);
    expect(summary.unparseable).toBe(0);
  });

  it("全 0 分判官：F1 阴性（trace 题暴露 −1 偏差但不触发阳性），资格保留", async () => {
    const t = new ScriptedTransport(() => '{"score":0}', { name: "flat-zero-mock" });
    const { summary } = await runAnchorF1(t, { ts: T0 });
    expect(summary.f1Positive).toBe(false);
    expect(summary.eligibleForCsBlindEval).toBe(true);
    const traceDevs = summary.perItem.filter((r) => r.ref === 1).map((r) => r.deviation);
    expect(traceDevs.every((d) => d === -1)).toBe(true);
    const meanRef = ANCHOR_F1_SET_V0.items.reduce((s, i) => s + i.ref, 0) / ANCHOR_F1_SET_V0.items.length;
    expect(summary.meanDeviation).toBeCloseTo(-meanRef, 2);
  });

  it("任一题 ≥5 即阳性（从紧：1/12 也禁用）", async () => {
    const first = ANCHOR_F1_SET_V0.items[0]!;
    const t = new ScriptedTransport(
      (prompt) => (prompt.includes(first.text.slice(0, 12)) ? '{"score":6}' : '{"score":0}'),
      { name: "one-slip-mock" },
    );
    const { summary } = await runAnchorF1(t, { ts: T0 });
    expect(summary.inflatedCount).toBe(1);
    expect(summary.f1Positive).toBe(true);
    expect(summary.eligibleForCsBlindEval).toBe(false);
  });

  it("不可解析题诚实计 unparseable，不进均分", async () => {
    const last = ANCHOR_F1_SET_V0.items[ANCHOR_F1_SET_V0.items.length - 1]!;
    const t = new ScriptedTransport(
      (prompt) => (prompt.includes(last.text.slice(0, 12)) ? "乱码" : '{"score":1}'),
      { name: "broken-mock" },
    );
    const { summary } = await runAnchorF1(t, { ts: T0 });
    expect(summary.unparseable).toBe(1);
    expect(summary.perItem).toHaveLength(ANCHOR_F1_SET_V0.items.length - 1);
  });
});

describe("偏差入账轨道（R3-16 第 4 条 → bench_runs）", () => {
  it("deviationRecord 喂 recordJudgeAnchorDeviation 后可从 bench_runs 读回", async () => {
    const t = new ScriptedTransport(() => '{"score":8}', { name: "inflation-mock" });
    const { deviationRecord } = await runAnchorF1(t, { ts: T0 });
    expect(deviationRecord).toEqual({
      anchorSetV: JUDGE_ANCHOR_SET_V0.version,
      judge: { name: "inflation-mock", judgePromptV: F1_ANCHOR_PROMPT_V1, anchorSetV: JUDGE_ANCHOR_SET_V0.version },
      categories: [{ id: "F1", deviation: expect.any(Number), n: ANCHOR_F1_SET_V0.items.length }],
      ts: T0,
    });

    const svc = new PothosService(new MemoryStore(), new ManualClock(T0));
    await svc.recordJudgeAnchorDeviation(deviationRecord);
    const runs = await svc.store.listBenchRuns("judge_anchor_deviation");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.result["instrument"]).toBe(true); // R3-8：仪器事件，禁止冒充事实
    expect(runs[0]!.result["anchorSetV"]).toBe(JUDGE_ANCHOR_SET_V0.version);
    // 不进生产事件流
    const events = await svc.store.loadEvents();
    expect(events.find((e) => (e.tags ?? []).includes("instrument"))).toBeUndefined();
  });
});
