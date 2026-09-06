/**
 * A2 网关桥测试：resident_msg → 分类器 → declared 事件入库；幂等；跳过空文本。
 */
import { describe, expect, it } from "vitest";
import { PothosService } from "../../src/service.js";
import { MemoryStore } from "../../src/storage/memory.js";
import { ManualClock } from "../../src/clock.js";
import { DeclaredGateway } from "../../src/declared/gateway.js";
import { ScriptedTransport } from "../../src/declared/classifier.js";
import { ENGINE_AXES } from "../../src/core/events.js";

const T0 = 1_700_000_000_000;

function makeResidentMsg(ts: number, text: string, idempotencyKey: string) {
  return { kind: "resident_msg" as const, ts, payload: { text }, idempotencyKey };
}

function classifierResponse(readings?: Array<{ axis: string; intensity: number }>) {
  return JSON.stringify({
    readings: readings ?? ENGINE_AXES.map((a) => ({ axis: a, intensity: 0.3 })),
    native: [{ axis: "sadness", intensity: 0.2 }],
    mixed: false,
    confidence: 0.8,
  });
}

describe("A2 网关桥", () => {
  it("resident_msg → 分类器 → declared 事件入库", async () => {
    const svc = new PothosService(new MemoryStore(), new ManualClock(T0));
    await svc.ingest(makeResidentMsg(T0, "她走了，我好想她。", "rm-1"));

    const transport = new ScriptedTransport(() => classifierResponse(), { name: "mock-gw", promptV: "declare-prompt-v1" });
    const gw = new DeclaredGateway(svc, transport);
    const r = await gw.pollOnce();

    expect(r.processed).toBe(1);
    expect(r.declared).toBe(1);
    expect(r.failed).toBe(0);

    const events = await svc.store.loadEvents();
    const declared = events.find((e) => e.kind === "declared");
    expect(declared).toBeDefined();
    expect(declared!.payload["producer"]).toBe("a2-classifier");
    expect(declared!.payload["model"]).toEqual({ name: "mock-gw", promptV: "declare-prompt-v1" });
    expect(declared!.payload["textHash"]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(declared!.idempotencyKey).toContain("a2-mock-gw");
  });

  it("幂等：同文本同 prompt 版本不重复入库", async () => {
    const svc = new PothosService(new MemoryStore(), new ManualClock(T0));
    await svc.ingest(makeResidentMsg(T0, "同样的文本", "rm-1"));

    const transport = new ScriptedTransport(() => classifierResponse(), { name: "mock-gw" });
    const gw = new DeclaredGateway(svc, transport);

    await gw.pollOnce();
    await gw.pollOnce(); // 第二次：lastId 已过，不再处理

    const declared = (await svc.store.loadEvents()).filter((e) => e.kind === "declared");
    expect(declared).toHaveLength(1);
  });

  it("空文本 resident_msg 跳过（不调分类器）", async () => {
    const svc = new PothosService(new MemoryStore(), new ManualClock(T0));
    await svc.ingest({ kind: "resident_msg", ts: T0, payload: { text: "" }, idempotencyKey: "rm-empty" });

    let called = 0;
    const transport = new ScriptedTransport(() => { called++; return classifierResponse(); }, { name: "mock-gw" });
    const gw = new DeclaredGateway(svc, transport);
    const r = await gw.pollOnce();

    expect(r.processed).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.declared).toBe(0);
    expect(called).toBe(0); // 分类器未被调用
  });

  it("分类器输出契约校验失败 → 记 failed，不崩", async () => {
    const svc = new PothosService(new MemoryStore(), new ManualClock(T0));
    await svc.ingest(makeResidentMsg(T0, "文本", "rm-1"));

    // 缺轴的分类器输出
    const transport = new ScriptedTransport(() => JSON.stringify({ readings: [{ axis: "longing", intensity: 0.5 }] }), { name: "bad-mock" });
    const gw = new DeclaredGateway(svc, transport);
    const r = await gw.pollOnce();

    expect(r.failed).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.error).toContain("契约校验失败");
    const declared = (await svc.store.loadEvents()).filter((e) => e.kind === "declared");
    expect(declared).toHaveLength(0); // 失败的不入库
  });

  it("catchUp：多批 resident_msg 一次性追完", async () => {
    const svc = new PothosService(new MemoryStore(), new ManualClock(T0));
    for (let i = 0; i < 5; i++) {
      await svc.ingest(makeResidentMsg(T0 + i * 1000, `表达${i}`, `rm-${i}`));
    }

    const transport = new ScriptedTransport(() => classifierResponse(), { name: "mock-gw" });
    const gw = new DeclaredGateway(svc, transport);
    const r = await gw.catchUp();

    expect(r.processed).toBe(5);
    expect(r.declared).toBe(5);
    const declared = (await svc.store.loadEvents()).filter((e) => e.kind === "declared");
    expect(declared).toHaveLength(5);
    // 每个 declared 的 textHash 不同（原文不同）
    const hashes = new Set(declared.map((d) => d.payload["textHash"]));
    expect(hashes.size).toBe(5);
  });

  it("只处理 resident_msg，不碰 user_msg / world / declared", async () => {
    const svc = new PothosService(new MemoryStore(), new ManualClock(T0));
    await svc.ingest({ kind: "user_msg", ts: T0, source: "she", payload: { text: "你好", valence: 0.5 }, idempotencyKey: "um-1" });
    await svc.ingest(makeResidentMsg(T0 + 1000, "住户表达", "rm-1"));
    await svc.ingest({ kind: "world", ts: T0 + 2000, payload: { intensity: 0.3 }, idempotencyKey: "w-1" });

    const transport = new ScriptedTransport(() => classifierResponse(), { name: "mock-gw" });
    const gw = new DeclaredGateway(svc, transport);
    const r = await gw.pollOnce();

    expect(r.processed).toBe(1); // 只有 resident_msg
    expect(r.declared).toBe(1);
  });
});
