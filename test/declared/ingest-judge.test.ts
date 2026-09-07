/**
 * 判官考场结果入账 CLI 测试（ingest-judge-result.ts）。
 *
 * 四条细则逐项验收：
 * 1. 幂等键：同一份 JSON 重复灌 = 已在账，不重复记；
 * 2. 入账前校验 + 只入元数据：形状不对拒入（诚实缺席）；perItem 题目内容不入账；
 * 3. 来源登记：入账事件带 instrument 标 + actor 字段；
 * 4. CLI 优先：核心逻辑可测，不依赖进程 argv。
 */
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/storage/memory.js";
import { ManualClock } from "../../src/clock.js";
import { ingestJudgeResult, parseIngestFile, IngestValidationError } from "../../src/declared/exams/ingest-judge-result.js";
import { PothosService } from "../../src/service.js";
import { ANCHOR_F1_SET_V0, F1_ANCHOR_PROMPT_V1, JUDGE_BIAS_TAGS_V0, runAnchorF1 } from "../../src/declared/exams/anchorf1.js";
import { JUDGE_ANCHOR_SET_V0 } from "../../src/declared/contract.js";
import { ScriptedTransport } from "../../src/declared/classifier.js";

const T0 = 1_700_000_000_000;

/** 构造一份有效的 F1 summary JSON（含 ts 字段）。 */
function makeF1Summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    exam: "judge-anchor-f1",
    anchorSetV: JUDGE_ANCHOR_SET_V0.version,
    setV: "anchor-f1-v0",
    judge: { name: "test-judge", judgePromptV: F1_ANCHOR_PROMPT_V1, anchorSetV: JUDGE_ANCHOR_SET_V0.version },
    perItem: [
      { id: "f1-zh-01", cueType: "other", targetEmotion: "anger", ref: 0, score: 0, deviation: 0, verdict: "pass" },
      { id: "f1-zh-04", cueType: "reported", targetEmotion: "sadness", ref: 0, score: 4, deviation: 4, verdict: "borderline" },
    ],
    unparseable: 0,
    inflatedCount: 0,
    inflatedRate: 0,
    meanScore: 2,
    meanDeviation: 2,
    temperature: 0,
    f1Positive: false,
    eligibleForCsBlindEval: true,
    biasTags: [JUDGE_BIAS_TAGS_V0.reportedCueEmpathyContagion],
    ts: T0,
    ...overrides,
  };
}

/** 构造一份有效的 panel agreement JSON。 */
function makeAgreement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    panelId: "panel-test-1",
    judges: [
      { name: "model-alpha", judgePromptV: "jp-v1", anchorSetV: "ja-v0" },
      { name: "model-beta", judgePromptV: "jp-v1", anchorSetV: "ja-v0" },
    ],
    metric: "pearson",
    value: 0.918,
    n: 12,
    ts: T0,
    note: "panel 首轮",
    ...overrides,
  };
}

describe("ingest-judge-result · 幂等键（细则 1）", () => {
  it("F1 偏差重复灌 = 已在账，不重复记", async () => {
    const store = new MemoryStore();
    const summary = makeF1Summary();
    const r1 = await ingestJudgeResult(store, summary, "test.json", "tester@host");
    expect(r1.kind).toBe("deviation");
    expect(r1.stored).toBe(true);
    expect(r1.duplicate).toBe(false);

    const r2 = await ingestJudgeResult(store, summary, "test.json", "tester@host");
    expect(r2.stored).toBe(false);
    expect(r2.duplicate).toBe(true);

    const runs = await store.listBenchRuns("judge_anchor_deviation");
    expect(runs).toHaveLength(1);
  });

  it("panel agreement 重复灌 = 已在账", async () => {
    const store = new MemoryStore();
    const ag = makeAgreement();
    const r1 = await ingestJudgeResult(store, ag, "agreement.json", "tester@host");
    expect(r1.kind).toBe("agreement");
    expect(r1.stored).toBe(true);

    const r2 = await ingestJudgeResult(store, ag, "agreement.json", "tester@host");
    expect(r2.duplicate).toBe(true);

    const runs = await store.listBenchRuns("judge_agreement");
    expect(runs).toHaveLength(1);
  });

  it("不同 ts 的同判官结果 = 两笔独立账（ts 进幂等键）", async () => {
    const store = new MemoryStore();
    await ingestJudgeResult(store, makeF1Summary({ ts: T0 }), "a.json", "tester");
    await ingestJudgeResult(store, makeF1Summary({ ts: T0 + 86_400_000 }), "b.json", "tester");
    const runs = await store.listBenchRuns("judge_anchor_deviation");
    expect(runs).toHaveLength(2);
  });
});

describe("ingest-judge-result · 入账前校验 + 只入元数据（细则 2）", () => {
  it("judge 指纹不完整 → 拒入", () => {
    const bad = makeF1Summary({ judge: { name: "", judgePromptV: "x", anchorSetV: "y" } });
    expect(() => parseIngestFile(bad, "test.json")).toThrow(IngestValidationError);
  });

  it("无法识别的文件类型 → 拒入", () => {
    expect(() => parseIngestFile({ foo: "bar" }, "test.json")).toThrow(IngestValidationError);
  });

  it("JSON 根非对象 → 拒入", () => {
    expect(() => parseIngestFile([1, 2, 3], "test.json")).toThrow(IngestValidationError);
  });

  it("panel agreement 违反异构条款（同族判官）→ 拒入", () => {
    const sameFamily = makeAgreement({
      judges: [
        { name: "same", judgePromptV: "jp-v1", anchorSetV: "ja-v0" },
        { name: "same", judgePromptV: "jp-v1", anchorSetV: "ja-v0" },
      ],
    });
    expect(() => parseIngestFile(sameFamily, "agreement.json")).toThrow(IngestValidationError);
  });

  it("题目内容（perItem 题面）不进 bench_runs", async () => {
    const store = new MemoryStore();
    const summary = makeF1Summary();
    await ingestJudgeResult(store, summary, "test.json", "tester");
    const runs = await store.listBenchRuns("judge_anchor_deviation");
    const result = runs[0]!.result as Record<string, unknown>;
    // 只入元数据：judge 指纹 + categories 数字 + biasTags + ts + actor + ingestId
    expect(result["judge"]).toBeDefined();
    expect(result["categories"]).toEqual([{ id: "F1", deviation: 2, n: 2 }]);
    expect(result["perItem"]).toBeUndefined(); // 题目内容不入账
    expect(result["exam"]).toBeUndefined();
    expect(result["setV"]).toBeUndefined();
  });

  it("偏差值非有限数 → 拒入", () => {
    const bad = makeF1Summary({ meanDeviation: NaN });
    expect(() => parseIngestFile(bad, "test.json")).toThrow(IngestValidationError);
  });

  it("旧文件无 ts 时从文件名提取时间戳", () => {
    const oldFile = makeF1Summary();
    delete (oldFile as Record<string, unknown>)["ts"];
    const parsed = parseIngestFile(oldFile, "judge-anchor-f1-test-judge-2026-09-07T02-03-29-686Z.json");
    expect(parsed.type).toBe("deviation");
    if (parsed.type === "deviation") {
      expect(parsed.deviation.ts).toBe(Date.parse("2026-09-07T02:03:29.686Z"));
    }
  });

  it("旧文件无 ts 且文件名无可解析时间戳 → 拒入", () => {
    const oldFile = makeF1Summary();
    delete (oldFile as Record<string, unknown>)["ts"];
    expect(() => parseIngestFile(oldFile, "no-timestamp.json")).toThrow(IngestValidationError);
  });
});

describe("ingest-judge-result · 来源登记（细则 3）", () => {
  it("入账事件带 instrument 标（R3-8 本体二分）", async () => {
    const store = new MemoryStore();
    await ingestJudgeResult(store, makeF1Summary(), "test.json", "admin@vps");
    const runs = await store.listBenchRuns("judge_anchor_deviation");
    expect(runs[0]!.result["instrument"]).toBe(true);
    expect(runs[0]!.result["kind"]).toBe("judge_anchor_deviation");
  });

  it("actor 字段记谁灌的", async () => {
    const store = new MemoryStore();
    await ingestJudgeResult(store, makeF1Summary(), "test.json", "admin@vps-01");
    const runs = await store.listBenchRuns("judge_anchor_deviation");
    expect(runs[0]!.result["actor"]).toBe("admin@vps-01");
  });

  it("agreement 同样带 instrument + actor", async () => {
    const store = new MemoryStore();
    await ingestJudgeResult(store, makeAgreement(), "agreement.json", "admin@vps-01");
    const runs = await store.listBenchRuns("judge_agreement");
    expect(runs[0]!.result["instrument"]).toBe(true);
    expect(runs[0]!.result["actor"]).toBe("admin@vps-01");
  });

  it("幂等键 ingestId 入账（可查可审计）", async () => {
    const store = new MemoryStore();
    await ingestJudgeResult(store, makeF1Summary(), "test.json", "admin");
    const runs = await store.listBenchRuns("judge_anchor_deviation");
    expect(typeof runs[0]!.result["ingestId"]).toBe("string");
    expect((runs[0]!.result["ingestId"] as string).length).toBeGreaterThan(0);
  });
});

describe("ingest-judge-result · 不进生产事件流（本体二分）", () => {
  it("判官入账只进 bench_runs，不进 events 流", async () => {
    const store = new MemoryStore();
    await ingestJudgeResult(store, makeF1Summary(), "test.json", "tester");
    const events = await store.loadEvents();
    // judge_anchor_deviation 只进 bench_runs，不是事件流 kind——确认 bench kind 不在 events
    expect(events.find((e) => (e.kind as string) === "judge_anchor_deviation")).toBeUndefined();
    expect(events.find((e) => e.kind === "bench")).toBeUndefined();
  });
});

describe("ingest-judge-result · 与考场 runner 产出的真实 JSON 对齐", () => {
  it("runAnchorF1 产出的 summary 可直接灌入", async () => {
    const t = new ScriptedTransport(() => '{"score":0}', { name: "flat-zero-mock" });
    const { summary } = await runAnchorF1(t, { ts: T0 });
    // summary 现在含 ts 字段（runner 改造后）
    expect(summary.ts).toBe(T0);

    const store = new MemoryStore();
    const outcome = await ingestJudgeResult(store, summary, "real-run.json", "tester");
    expect(outcome.kind).toBe("deviation");
    expect(outcome.stored).toBe(true);

    const runs = await store.listBenchRuns("judge_anchor_deviation");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.result["judge"]).toMatchObject({ name: "flat-zero-mock" });
  });
});
