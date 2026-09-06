/**
 * 红队三审缝合实现测试：R3-8 instrument 本体二分、R3-15 负载冻结、R3-16 判官入账轨。
 */
import { describe, expect, it } from "vitest";
import { computeValuation, type RawEvent } from "../../src/core/events.js";
import { initialState } from "../../src/core/state.js";
import { applyEvent } from "../../src/core/apply.js";
import { DEFAULT_PARAMS } from "../../src/core/params.js";
import { PothosService } from "../../src/service.js";
import { MemoryStore } from "../../src/storage/memory.js";
import { ManualClock } from "../../src/clock.js";

const T0 = 1_700_000_000_000;

describe("R3-8 · instrument 保留标签（本体二分）", () => {
  it("instrument 标签在 RESERVED_TAGS 中（注入面拦截）", async () => {
    const { RESERVED_TAGS } = await import("../../src/server/app.js");
    expect(RESERVED_TAGS).toContain("instrument");
  });

  it("instrument 事件估值中性（computeValuation 恒零冲量）", () => {
    const ev: RawEvent = {
      kind: "user_msg",
      ts: T0,
      payload: { valence: 0.9, intensity: 0.9 },
      tags: ["instrument"],
    };
    const { valuation } = computeValuation(ev, { estimate: () => ({ value: 0.95, stub: false }) });
    expect(valuation).toEqual({ val: 0, load: 0, warm: 0, hurt: 0, wonder: 0, quality: 0 });
  });

  it("同事件无 instrument 标签时正常估值（对照）", () => {
    const ev: RawEvent = { kind: "user_msg", ts: T0, payload: { valence: 0.9, intensity: 0.9 } };
    const { valuation } = computeValuation(ev, { estimate: () => ({ value: 0.95, stub: false }) });
    expect(valuation.val).toBeGreaterThan(0); // 0.9×0.9
  });

  it("/events 摄入面剥除 instrument 标签（客户端不可注入仪器事件）", async () => {
    const svc = new PothosService(new MemoryStore(), new ManualClock(T0));
    const { createApp } = await import("../../src/server/app.js");
    const app = createApp(svc);
    const res = await app.request("/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "user_msg", ts: T0, idempotencyKey: "instr-inj-1",
        payload: { text: "test", valence: 0.5 },
        tags: ["instrument", "custom"],
      }),
    });
    expect(res.status).toBe(201);
    const events = await svc.store.loadEvents();
    const ev = events[0]!;
    expect(ev.tags).not.toContain("instrument"); // 被剥除
    expect(ev.tags).toContain("custom"); // 非保留标签保留
  });
});

describe("R3-15 · MATCHED 负载冻结", () => {
  it("正常负载下 contingency 达阈 → MATCHED 正常触发", () => {
    const st = initialState(T0, 42);
    const handle = "src-a";
    // 高 contingency（=1.0）、低即时 load 的事件：load = |valence|·intensity + 0.15 ≈ 0.15 < 0.8
    for (let i = 0; i < 3; i++) {
      applyEvent(st, {
        kind: "user_msg", ts: T0 + i * 1000, source: handle,
        payload: { valence: 0.01, intensity: 0.01, contingency: 1.0 },
        id: i + 1,
      } as RawEvent & { id: number });
    }
    expect(st.window.phase).toBe("MATCHED");
  });

  it("高负载期（即时 load 超冻结阈）contingency 达阈 → MATCHED 冻结不触发", () => {
    const st = initialState(T0, 42);
    // 高 intensity 事件：即时 load = |valence|·intensity + 0.15。
    // valence=1, intensity=1 → load=1.15 > 冻结阈 0.8；contingency=1.0 ≥ depositTheta
    const handle = "src-b";
    for (let i = 0; i < 5; i++) {
      applyEvent(st, {
        kind: "user_msg", ts: T0 + i * 1000, source: handle,
        payload: { valence: 1.0, intensity: 1.0, contingency: 1.0 },
        id: i + 1,
      } as RawEvent & { id: number });
    }
    expect(st.window.phase).toBe("WINDOW_OPEN"); // 冻结：未进 MATCHED
    // 候选 contingency 已累积（冻结的是触发不是累积）
    const cand = st.window.candidates[handle];
    expect(cand).toBeDefined();
    expect(cand!.ctSum).toBeGreaterThanOrEqual(DEFAULT_PARAMS.windowMatchTheta);
  });

  it("负载回落后 MATCHED 解冻触发（延迟关窗 = 宁可延迟不可带混淆）", () => {
    // 高负载状态：MATCHED 被冻结
    const st = initialState(T0, 42);
    const handle = "src-c";
    for (let i = 0; i < 5; i++) {
      applyEvent(st, {
        kind: "user_msg", ts: T0 + i * 1000, source: handle,
        payload: { valence: 1.0, intensity: 1.0, contingency: 1.0 },
        id: i + 1,
      } as RawEvent & { id: number });
    }
    expect(st.window.phase).toBe("WINDOW_OPEN"); // 冻结中

    // 负载回落：新状态 f_load 极低，低即时 load 高 contingency 事件应正常触发 MATCHED
    const st2 = initialState(T0 + 999_999_999, 42);
    st2.fast.f_load = 0.1; // 远低于冻结阈
    const handle2 = "src-c";
    for (let i = 0; i < 3; i++) { // 恰 3 条达阈，不触发确认
      applyEvent(st2, {
        kind: "user_msg", ts: T0 + 1_000_000_000 + i * 1000, source: handle2,
        payload: { valence: 0.01, intensity: 0.01, contingency: 1.0 },
        id: i + 1,
      } as RawEvent & { id: number });
    }
    expect(st2.window.phase).toBe("MATCHED");
  });
});

describe("R3-16 · 判官入账轨", () => {
  it("judge_agreement 入 bench_runs（仪器事件，不进 events 流）", async () => {
    const svc = new PothosService(new MemoryStore(), new ManualClock(T0));
    await svc.recordJudgeAgreement({
      contractV: 1, panelId: "panel-1",
      judges: [
        { name: "model-alpha", judgePromptV: "jp-v1", anchorSetV: "ja-v0" },
        { name: "model-beta", judgePromptV: "jp-v1", anchorSetV: "ja-v0" },
      ],
      metric: "pearson", value: 0.72, n: 60, ts: T0,
    });
    const runs = await svc.store.listBenchRuns("judge_agreement");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.result["instrument"]).toBe(true);
    expect(runs[0]!.result["panelId"]).toBe("panel-1");
    // 确认不进 events 流
    const events = await svc.store.loadEvents();
    expect(events.find((e) => e.kind === "bench")).toBeUndefined();
  });

  it("judge_anchor_deviation 入 bench_runs", async () => {
    const svc = new PothosService(new MemoryStore(), new ManualClock(T0));
    await svc.recordJudgeAnchorDeviation({
      anchorSetV: "ja-v0",
      judge: { name: "model-alpha", judgePromptV: "jp-v1", anchorSetV: "ja-v0" },
      categories: [{ id: "F1", deviation: 0.35, n: 10 }],
      ts: T0,
    });
    const runs = await svc.store.listBenchRuns("judge_anchor_deviation");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.result["categories"]).toEqual([{ id: "F1", deviation: 0.35, n: 10 }]);
  });
});
