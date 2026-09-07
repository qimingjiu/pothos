/**
 * 「在场即回应」通道测试（R3-12 匿名卷独见，观察期仪器）：
 * presence kind 零冲量证明（fold 与无 presence 逐位一致）、通道配对语义、
 * 不进判据标志、服务层旁路入账。
 */
import { describe, expect, it } from "vitest";
import {
  residentPresenceChannel,
  type TimelineEvent,
} from "../../src/core/contingency-log.js";
import { fold } from "../../src/core/engine.js";
import { initialState, stateHash } from "../../src/core/state.js";
import { computeValuation, type RawEvent, type StoredEvent } from "../../src/core/events.js";
import { PothosService } from "../../src/service.js";
import { MemoryStore } from "../../src/storage/memory.js";
import { ManualClock } from "../../src/clock.js";

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

function ev(kind: TimelineEvent["kind"], ts: number, text: string, who?: string): TimelineEvent {
  return { kind, ts, source: kind === "ma_product" ? null : "tg:1", payload: who ? { text, who } : { text } };
}

describe("presence kind：零冲量（测量面不动 fold）", () => {
  it("computeValuation 对 presence 恒零冲量（在场是回应通道不是扰动源）", () => {
    const presenceEv: RawEvent = {
      kind: "presence", ts: T0, payload: { who: "resident" }, tags: [], idempotencyKey: "p",
    };
    const { valuation } = computeValuation(presenceEv);
    expect(valuation).toEqual({ val: 0, load: 0, warm: 0, hurt: 0, wonder: 0, quality: 0 });
  });

  it("presence 事件与既有事件同 ts 插入：fold 状态逐位一致（无额外 tick 分段）", () => {
    const base: RawEvent[] = [
      { kind: "user_msg", ts: T0, payload: { text: "在吗", valence: 0.5, intensity: 0.4 }, source: "tg:1", tags: [], idempotencyKey: "a" },
      { kind: "resident_msg", ts: T0 + 1000, payload: { text: "在的" }, source: "tg:1", tags: [], idempotencyKey: "b" },
    ];
    const withPresence: RawEvent[] = [
      ...base,
      { kind: "presence", ts: T0 + 1000, payload: { who: "resident" }, tags: [], idempotencyKey: "c" },
    ];
    const genesis = T0 - HOUR;
    // 注：不同 ts 的插入会改变 tick 分段（浮点积分有粒度效应），同 ts 插入才隔离「零冲量」本身
    const a = fold(base as StoredEvent[], T0 + HOUR, { from: initialState(genesis, 0x50544853) });
    const b = fold(withPresence as StoredEvent[], T0 + HOUR, { from: initialState(genesis, 0x50544853) });
    expect(stateHash(b.state)).toBe(stateHash(a.state));
  });
});

describe("residentPresenceChannel：通道语义", () => {
  it("窗内文本回应的信号不属本通道测量域；未回应信号分「在场命中」与「窗内缺席」", () => {
    const records = [
      // 快通道已答（residentReplyTs 在窗内）→ 不在域
      { userMsgTs: T0, userMsgText: "a", residentReplyTs: T0 + 1000, residentReplyText: "r" },
      // 未回应，窗内无任何在场痕迹 → absentInWindow
      { userMsgTs: T0 + 10 * HOUR, userMsgText: "b", residentReplyTs: null, residentReplyText: null },
      // 未回应，但窗内有間活动（ma_product）→ presenceOnly
      { userMsgTs: T0 + 20 * HOUR, userMsgText: "c", residentReplyTs: null, residentReplyText: null },
      // 迟到回应（超节律窗 2h）→ C_t 计缺席；回应时间戳也超观察窗 → absentInWindow
      { userMsgTs: T0 + 30 * HOUR, userMsgText: "d", residentReplyTs: T0 + 32 * HOUR, residentReplyText: "late" },
    ];
    const events: TimelineEvent[] = [
      ev("ma_product", T0 + 20 * HOUR + 1000, "create"),
      ev("resident_msg", T0 + 32 * HOUR, "late"),
    ];
    const stats = residentPresenceChannel(records, events, { windowMs: HOUR });
    expect(stats.observation).toBe(true);
    expect(stats.excludedFromJudgment).toBe(true);
    expect(stats.nSignals).toBe(4);
    expect(stats.nUnanswered).toBe(3); // a 已答出域；b/c/d 在域
    expect(stats.presenceOnly).toBe(1); // c（間活动在场）
    expect(stats.absentInWindow).toBe(2); // b 真缺席；d 迟到回应超观察窗（已入 C_t 缺席数）
    expect(stats.presenceRate).toBeCloseTo(1 / 3, 6);
  });

  it("显式 presence(who=resident) 计入；who=observer 不计入（那是 R3-10 方向的本子）", () => {
    const records = [
      { userMsgTs: T0, userMsgText: "a", residentReplyTs: null, residentReplyText: null },
    ];
    const residentMark = residentPresenceChannel(records, [ev("presence", T0 + 1000, "", "resident")], { windowMs: HOUR });
    expect(residentMark.presenceOnly).toBe(1);
    const observerMark = residentPresenceChannel(records, [ev("presence", T0 + 1000, "", "observer")], { windowMs: HOUR });
    expect(observerMark.presenceOnly).toBe(0);
    expect(observerMark.absentInWindow).toBe(1);
  });

  it("信号之前的在场痕迹不算回应（因果方向不可倒流）", () => {
    const records = [
      { userMsgTs: T0 + 2 * HOUR, userMsgText: "a", residentReplyTs: null, residentReplyText: null },
    ];
    const stats = residentPresenceChannel(records, [ev("ma_product", T0 + HOUR, "digest")], { windowMs: HOUR });
    expect(stats.presenceOnly).toBe(0);
    expect(stats.absentInWindow).toBe(1);
  });

  it("自定义窗：在场痕迹超窗不算；测量域为空 presenceRate = null（不猜）", () => {
    const records = [{ userMsgTs: T0, userMsgText: "a", residentReplyTs: null, residentReplyText: null }];
    const outOfWindow = residentPresenceChannel(records, [ev("ma_product", T0 + 2 * HOUR, "create")], { windowMs: HOUR });
    expect(outOfWindow.presenceOnly).toBe(0);
    const empty = residentPresenceChannel([], [ev("ma_product", T0, "digest")]);
    expect(empty.nSignals).toBe(0);
    expect(empty.presenceRate).toBeNull();
  });
});

describe("服务层旁路：presence 通道入账", () => {
  it("contingencyBypass 报数带 presenceChannel（观察期标志在案），不进判据", async () => {
    const svc = new PothosService(new MemoryStore(), new ManualClock(T0));
    await svc.ingest({ kind: "user_msg", ts: T0 + 1000, source: "tg:1", payload: { text: "在吗" }, tags: [], idempotencyKey: "k1" });
    // 住户没回话，但窗内有間活动（在场即回应的命中样本）
    await svc.ingest({ kind: "ma_product", ts: T0 + 60_000, payload: { activity: "digest", quality: 0.5 }, tags: [], idempotencyKey: "k2" });

    const report = await svc.contingencyBypass({ ts: T0 + 120_000 });
    expect(report.presenceChannel.observation).toBe(true);
    expect(report.presenceChannel.excludedFromJudgment).toBe(true);
    expect(report.presenceChannel.nSignals).toBe(1);
    expect(report.presenceChannel.nUnanswered).toBe(1);
    expect(report.presenceChannel.presenceOnly).toBe(1);
    expect(report.presenceChannel.absentInWindow).toBe(0);
    expect(report.presenceChannel.presenceRate).toBe(1);

    const runs = await svc.store.listBenchRuns("contingency_report");
    expect((runs[0]!.result as Record<string, unknown>)["presenceChannel"]).toMatchObject({ observation: true });
    // 不进判据：imprintType 仍由 C_t/C_s 决定（本例无回应 → null，在场命中不得顶替）
    expect(report.imprintType).toBeNull();
  });

  it("presence 事件走内部路径可入账，/events 外部白名单不含 presence", async () => {
    const svc = new PothosService(new MemoryStore(), new ManualClock(T0));
    const res = await svc.ingest({ kind: "presence", ts: T0, payload: { who: "resident" }, tags: [], idempotencyKey: "p1" });
    expect(res.stored).toBe(true);
    const events = await svc.store.loadEvents();
    expect(events.some((e) => e.kind === "presence")).toBe(true);

    const { EXTERNAL_EVENT_KINDS } = await import("../../src/server/app.js");
    expect(EXTERNAL_EVENT_KINDS).not.toContain("presence"); // 内部路径专用，不走外部写入面
  });
});
