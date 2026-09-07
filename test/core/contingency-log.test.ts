/**
 * A1 contingency 旁路骨架测试：收集器配对语义（burst/缺席/自发不配对/多 source 隔离）
 * + 服务层旁路（instrument 入账 bench_runs、scoped 关窗回顾、不进生产事件流）。
 */
import { describe, expect, it } from "vitest";
import {
  collectInteractionRecords,
  type TimelineEvent,
} from "../../src/core/contingency-log.js";
import { PothosService } from "../../src/service.js";
import { MemoryStore } from "../../src/storage/memory.js";
import { ManualClock } from "../../src/clock.js";

const T0 = 1_700_000_000_000;

function ev(kind: TimelineEvent["kind"], ts: number, source: string | null, text: string): TimelineEvent {
  return { kind, ts, source, payload: { text } };
}

describe("旁路收集器：配对语义", () => {
  it("基本配对：resident_msg 归属最近一条未回应信号，缺席照记", () => {
    const records = collectInteractionRecords([
      ev("user_msg", T0 + 1, "tg:1", "在吗"),
      ev("user_msg", T0 + 2, "tg:1", "睡了吗"),
      ev("resident_msg", T0 + 3, "tg:1", "在的"),
    ]);
    expect(records).toHaveLength(2);
    expect(records[0]!.userMsgText).toBe("在吗");
    expect(records[0]!.residentReplyTs).toBeNull(); // 最近未回应 = 第二条（睡了吗）
    expect(records[1]).toEqual({
      userMsgTs: T0 + 2, userMsgText: "睡了吗", residentReplyTs: T0 + 3, residentReplyText: "在的",
    });
  });

  it("burst：多条 resident_msg 对同一信号 → 首条入账，其余不入（塌缩语义在收集层同向）", () => {
    const records = collectInteractionRecords([
      ev("user_msg", T0, "tg:1", "在吗"),
      ev("resident_msg", T0 + 5, "tg:1", "在"),
      ev("resident_msg", T0 + 8, "tg:1", "在在"),
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]!.residentReplyTs).toBe(T0 + 5);
    expect(records[0]!.residentReplyText).toBe("在");
  });

  it("无信号在先的 resident_msg（自发表达）不入账——主动性不是应答性", () => {
    const records = collectInteractionRecords([
      ev("resident_msg", T0, "tg:1", "今天写了一首诗"),
    ]);
    expect(records).toHaveLength(0);
  });

  it("多 source 隔离：不跨 source 配对（回应只落在自己 source 的信号上）", () => {
    const records = collectInteractionRecords([
      ev("user_msg", T0, "tg:1", "a1"),
      ev("user_msg", T0 + 2, "tg:2", "b1"),
      ev("resident_msg", T0 + 3, "tg:2", "b-reply"),
    ]);
    expect(records).toHaveLength(2);
    const a1 = records.find((r) => r.userMsgText === "a1")!;
    const b1 = records.find((r) => r.userMsgText === "b1")!;
    expect(a1.residentReplyTs).toBeNull(); // tg:1 无回应
    expect(b1.residentReplyTs).toBe(T0 + 3); // tg:2 的回应没漏到 tg:1
  });

  it("sources 过滤：只收指定句柄", () => {
    const records = collectInteractionRecords(
      [
        ev("user_msg", T0, "tg:1", "a1"),
        ev("user_msg", T0 + 1, "other:9", "x1"),
      ],
      { sources: ["tg:1"] },
    );
    expect(records).toHaveLength(1);
    expect(records[0]!.userMsgText).toBe("a1");
  });

  it("乱序到达按 ts 重排后配对（迟到 resident_msg 不倒流）", () => {
    const records = collectInteractionRecords([
      ev("user_msg", T0 + 2, "tg:1", "later"),
      ev("resident_msg", T0 + 3, "tg:1", "reply"),
      ev("user_msg", T0 + 1, "tg:1", "earlier"),
    ]);
    expect(records.map((r) => r.userMsgText)).toEqual(["earlier", "later"]);
    expect(records[1]!.residentReplyTs).toBe(T0 + 3);
    expect(records[0]!.residentReplyTs).toBeNull();
  });
});

describe("服务层旁路：contingencyBypass", () => {
  it("instrument 入账 bench_runs（contingency_report），不进生产事件流；C_s 挂牌随行", async () => {
    const svc = new PothosService(new MemoryStore(), new ManualClock(T0));
    const mk = (ts: number, text: string, key: string) => ({
      kind: "user_msg" as const, ts, source: "tg:1", payload: { text }, tags: [], idempotencyKey: key,
    });
    await svc.ingest(mk(T0 + 1000, "在吗", "k1"));
    await svc.ingest(mk(T0 + 60_000, "今天好吗", "k2"));
    await svc.ingest({
      kind: "resident_msg" as const, ts: T0 + 65_000, source: "tg:1",
      payload: { text: "在的，你呢" }, tags: [], idempotencyKey: "k3",
    });
    const before = (await svc.store.loadEvents()).length;

    const report = await svc.contingencyBypass({ ts: T0 + 120_000 });
    expect(report.instrument).toBe(true);
    expect(report.kind).toBe("contingency_report");
    expect(report.scoped).toBe(false); // 窗口无候选 → 全 source 兜底
    expect(report.nRecords).toBe(2);
    expect(report.nReplied).toBe(1);
    expect(report.cs.bias).toBe("lexical_overlap_proxy_rewards_echo");
    expect(report.recheck).toEqual([]);

    const runs = await svc.store.listBenchRuns("contingency_report");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.result["instrument"]).toBe(true);
    // 旁路只写 bench_runs，不写事件流（R3-8 本体二分）
    expect((await svc.store.loadEvents()).length).toBe(before);
  });

  it("窗口有候选 → scoped：逐句柄关窗回顾精确重算 vs 即时代理（fold 真候选，哈希句柄）", async () => {
    const svc = new PothosService(new MemoryStore(), new ManualClock(T0));
    const mk = (ts: number, text: string, key: string, contingency?: number) => ({
      kind: "user_msg" as const, ts, source: "tg:1",
      payload: contingency === undefined ? { text } : { text, contingency }, tags: [], idempotencyKey: key,
    });
    await svc.ingest(mk(T0 + 1000, "在吗", "k1", 0.8));
    await svc.ingest(mk(T0 + 60_000, "睡了吗", "k2", 0.8));
    await svc.ingest({
      kind: "resident_msg" as const, ts: T0 + 65_000, source: "tg:1",
      payload: { text: "在的" }, tags: [], idempotencyKey: "k3",
    });

    // fold 已在 WINDOW_OPEN 期注册真候选（q=0.8 ≥ depositTheta 0.6；句柄 = opaqueHandle 哈希）
    const handles = Object.keys(svc.state.window.candidates);
    expect(handles).toHaveLength(1);
    const handle = handles[0]!;

    const report = await svc.contingencyBypass({ ts: T0 + 120_000 });
    expect(report.scoped).toBe(true);
    expect(report.recheck).toHaveLength(1);
    const r = report.recheck[0]!;
    expect(r.handle).toBe(handle);
    expect(r.proxyEvents).toBe(2);
    expect(r.proxyCtMean).toBeCloseTo(0.8, 6); // ctSum/events = 即时代理均值
    expect(r.preciseCt).toBeGreaterThanOrEqual(0);
    expect(r.preciseCt).toBeLessThanOrEqual(1);
    expect(r.preciseN).toBe(2);
  });
});
