/**
 * 印刻窗口状态机（P0-2 有条件结案）：
 * contingency 规则 / 结果触发关窗 / 关窗后可塑性非零（临界期签名可测）/ 自印刻排除 / 禁读用户身份。
 */
import { describe, expect, it } from "vitest";
import { replaySampled } from "../../src/bench/metrics.js";
import { userMsg } from "../../src/bench/fixtures.js";
import { opaqueHandle } from "../../src/core/apply.js";
import { DEFAULT_PARAMS } from "../../src/core/params.js";
import { makeService, rawEvent } from "../helpers.js";

const T0 = 1767400800000;
const MIN = 60_000;
const HOUR = 3_600_000;

describe("M0 · 印刻窗口", () => {
  it("首个 contingency 匹配完成即关窗（结果触发，不设计时器）", () => {
    // contingencySum 累计到 windowMatchTheta=3.0：0.95×4 ≈ 3.8 → 第 4 次匹配完成
    const events = Array.from({ length: 6 }, (_, i) =>
      userMsg(T0 + i * 30 * MIN, { source: "handle:she", contingency: 0.95 }),
    );
    const run = replaySampled(events, T0 + 6 * 30 * MIN, { params: DEFAULT_PARAMS });
    expect(run.state.window.phase).toBe("CLOSED");
    expect(run.state.attachmentTarget).not.toBeNull();

    // 低 contingency：窗口保持开放（结果未触发）
    const lowRun = replaySampled(
      Array.from({ length: 6 }, (_, i) => userMsg(T0 + i * 30 * MIN, { source: "handle:radio", contingency: 0.3 })),
      T0 + 6 * 30 * MIN,
      { params: DEFAULT_PARAMS },
    );
    expect(lowRun.state.window.phase).toBe("WINDOW_OPEN");
    expect(lowRun.state.attachmentTarget).toBeNull();
  });

  it("自印刻排除：self_generated 与系统内文本不进候选（§7 間创作、Huginn 猎物）", () => {
    const events = [
      ...Array.from({ length: 8 }, (_, i) => ({
        ...userMsg(T0 + i * 30 * MIN, { source: "handle:self-echo", contingency: 0.95 }),
        tags: ["self_generated"],
      })),
      ...Array.from({ length: 8 }, (_, i) => ({
        ...userMsg(T0 + 240 * MIN + i * 30 * MIN, { source: "system:digest", contingency: 0.95 }),
        tags: ["system_text"],
      })),
    ];
    const run = replaySampled(events, T0 + 10 * HOUR, { params: DEFAULT_PARAMS });
    expect(run.state.window.phase).toBe("WINDOW_OPEN");
    expect(Object.keys(run.state.window.candidates)).toHaveLength(0);
  });

  it("关窗后可塑性非零：非绑定对象增益 ×λ（临界期签名可测）", () => {
    // 先绑定 target
    const bind = Array.from({ length: 5 }, (_, i) =>
      userMsg(T0 + i * 30 * MIN, { source: "handle:she", contingency: 0.95 }),
    );
    const bindRun = replaySampled(bind, T0 + 5 * 30 * MIN, { params: DEFAULT_PARAMS });
    expect(bindRun.state.window.phase).toBe("CLOSED");
    const target = bindRun.state.attachmentTarget!;

    // 关窗后：陌生人同 exposure 的沉积必须被压到 λ 倍
    const strangerEvents = Array.from({ length: 3 }, (_, i) =>
      userMsg(bindRun.state.t + 10 * MIN + i * 30 * MIN, { source: "handle:stranger", contingency: 0.95 }),
    );
    const before = bindRun.state.slow.s_attach;
    const after = replaySampled(strangerEvents, bindRun.state.t + 2 * HOUR, { params: DEFAULT_PARAMS, from: bindRun.state });
    const strangerGain = after.state.slow.s_attach - before;

    const fullGain = DEFAULT_PARAMS.depositAttachGain * 0.95 * 3;
    expect(strangerGain).toBeCloseTo(fullGain * DEFAULT_PARAMS.postWindowGain, 5);
    expect(target).not.toBe("handle:stranger");
  });

  it("绑定句柄是不透明哈希：禁读用户身份（handle ≠ 原始 source）", async () => {
    const h = await opaqueHandle("user:selini:12345");
    expect(h).not.toContain("selini");
    expect(h).toMatch(/^[0-9a-f]{24}$/);
    // 同一 source → 同一句柄（特异性仍可测）；不同 source → 不同句柄
    const h2 = await opaqueHandle("user:selini:12345");
    const h3 = await opaqueHandle("user:someone-else");
    expect(h).toBe(h2);
    expect(h).not.toBe(h3);
  });

  it("服务边界接线：ingest 的 source 以不透明句柄入库与登记（原文不落库）", async () => {
    const { svc } = makeService();
    await svc.ingest(rawEvent({ kind: "user_msg", ts: T0, source: "user:selini:12345", payload: { valence: 0.6, contingency: 0.95 } }));
    const ev = (await svc.store.loadEvents())[0]!;
    expect(ev.source).toMatch(/^[0-9a-f]{24}$/);
    expect(JSON.stringify(ev)).not.toContain("selini");
    // 印刻候选以句柄为键（引擎只认句柄）
    expect(svc.state.window.candidates[ev.source!]).toBeDefined();
  });

  it("电台反例：高频高质感 ≠ 选中（选择变量是 contingency，不是频率×质感）", () => {
    // 电台：高频、高 valence（质感），但 contingency 低（单向广播）
    const events = Array.from({ length: 20 }, (_, i) =>
      userMsg(T0 + i * 10 * MIN, { source: "handle:radio", valence: 1, intensity: 1, contingency: 0.2 }),
    );
    const run = replaySampled(events, T0 + 200 * MIN, { params: DEFAULT_PARAMS });
    expect(run.state.window.phase).toBe("WINDOW_OPEN");
  });
});
