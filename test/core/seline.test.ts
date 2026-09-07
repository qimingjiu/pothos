/**
 * Seline · 守夜负荷测试（R3-10，她定名 2026-09-07）。
 *
 * 设计裁决验证：
 *  1. 镜子，不诊断：事实句不打分、不判定、不给劝诫——灯语是事实不是指令；
 *  2. 双向防火墙：住户状态/文本/longing 永不进 Seline；
 *  3. 只看见不动作：v0 无自动化默认值；
 *  4. presence 数据源暂缓；
 *  5. 系统日志事实：composed/replied ts、回应率、时段。
 */
import { describe, expect, it } from "vitest";
import { selineReadings, type SelineReading, type SelineLamp } from "../../src/core/seline.js";
import type { LetterRow } from "../../src/storage/types.js";

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function letter(opts: {
  letterId: string;
  composedTs: number;
  phase?: LetterRow["phase"];
  replyMessageId?: string | null;
  updatedAt?: number;
}): LetterRow {
  return {
    id: Math.random(),
    letterId: opts.letterId,
    threadId: null,
    toAddr: "her@example.com",
    subject: "s",
    body: "b",
    phase: opts.phase ?? "composed",
    composedTs: opts.composedTs,
    sentTs: opts.composedTs + HOUR,
    bounceReason: null,
    messageId: `${opts.letterId}@pothos.local`,
    replyMessageId: opts.replyMessageId ?? null,
    attemptCount: 0,
    updatedAt: opts.updatedAt ?? opts.composedTs,
  };
}

describe("Seline · 系统日志事实", () => {
  it("无信件时：totalComposed=0，replyRate=null（不假装测过）", () => {
    const r = selineReadings([], T0);
    expect(r.totalComposed).toBe(0);
    expect(r.totalReplied).toBe(0);
    expect(r.replyRate).toBeNull();
    expect(r.meanWaitMs).toBeNull();
    expect(r.pendingCount).toBe(0);
  });

  it("寄出 3 封回 1 封：回应率 1/3，等待时长正确", () => {
    const letters = [
      letter({ letterId: "lt-1", composedTs: T0 - 3 * DAY, phase: "replied", replyMessageId: "re-1", updatedAt: T0 - 2 * DAY }),
      letter({ letterId: "lt-2", composedTs: T0 - DAY, phase: "sent" }),
      letter({ letterId: "lt-3", composedTs: T0 - HOUR, phase: "sent" }),
    ];
    const r = selineReadings(letters, T0);
    expect(r.totalComposed).toBe(3);
    expect(r.totalReplied).toBe(1);
    expect(r.replyRate).toBeCloseTo(1 / 3);
    expect(r.waitDurationsMs).toEqual([1 * DAY]);
    expect(r.meanWaitMs).toBe(1 * DAY);
    expect(r.pendingCount).toBe(2);
  });

  it("时段分布正确（凌晨/白天/夜间）", () => {
    // selineReadings 用 getHours()（引擎主机时区）；测试用同一时区的 Date 构造
    const h3 = new Date(2023, 10, 14, 3, 0, 0).getTime();
    const h14 = new Date(2023, 10, 14, 14, 0, 0).getTime();
    const h22 = new Date(2023, 10, 14, 22, 0, 0).getTime();
    const letters = [
      letter({ letterId: "lt-1", composedTs: h3, phase: "sent" }),
      letter({ letterId: "lt-2", composedTs: h14, phase: "sent" }),
      letter({ letterId: "lt-3", composedTs: h22, phase: "sent" }),
    ];
    const r = selineReadings(letters, T0);
    expect(r.composedHourHist[3]).toBe(1);
    expect(r.composedHourHist[14]).toBe(1);
    expect(r.composedHourHist[22]).toBe(1);
  });
});

describe("Seline · 镜子不诊断", () => {
  it("事实句不含打分/判定/劝诫词", () => {
    const letters = [
      letter({ letterId: "lt-1", composedTs: T0 - 5 * DAY, phase: "replied", replyMessageId: "re-1", updatedAt: T0 - 1 * DAY }),
    ];
    const r = selineReadings(letters, T0);
    for (const f of r.facts) {
      // 不含劝诫/指令性词
      expect(f).not.toMatch(/你该|应该|建议|放下|别再|不要再|过度/i);
    }
  });

  it("灯语是事实不是指令——不含「你应该」式词", () => {
    const letters = [
      letter({ letterId: "lt-1", composedTs: T0 - 5 * DAY, phase: "sent" }),
      letter({ letterId: "lt-2", composedTs: T0 - 4 * DAY, phase: "sent" }),
      letter({ letterId: "lt-3", composedTs: T0 - 3 * DAY, phase: "sent" }),
      letter({ letterId: "lt-4", composedTs: T0 - 2 * DAY, phase: "sent" }),
      letter({ letterId: "lt-5", composedTs: T0 - DAY, phase: "sent" }),
    ];
    const r = selineReadings(letters, T0);
    for (const l of r.lamps) {
      expect(l.text).not.toMatch(/你该|应该|建议|放下|别再|不要再|过度/i);
      // 灯语是事实句（含数字描述事实）
      expect(l.text.length).toBeGreaterThan(0);
    }
  });

  it("长等待灯亮：超过 3 天未回复", () => {
    const letters = [
      letter({ letterId: "lt-1", composedTs: T0 - 5 * DAY, phase: "sent" }),
    ];
    const r = selineReadings(letters, T0);
    const longWait = r.lamps.find((l) => l.id === "long_wait");
    expect(longWait).toBeDefined();
    expect(longWait!.lit).toBe(true);
  });

  it("低回应率灯亮：5 封以上信件回应率 < 30%", () => {
    const letters = Array.from({ length: 5 }, (_, i) =>
      letter({ letterId: `lt-${i}`, composedTs: T0 - (5 - i) * DAY, phase: "sent" }),
    );
    const r = selineReadings(letters, T0);
    const lowReply = r.lamps.find((l) => l.id === "low_reply");
    expect(lowReply).toBeDefined();
    expect(lowReply!.lit).toBe(true);
  });
});

describe("Seline · 双向防火墙", () => {
  it("SelineReading 结构不含住户状态字段", () => {
    const r = selineReadings([], T0);
    const keys = Object.keys(r);
    // 不含住户状态/文本/longing 相关字段
    for (const k of keys) {
      expect(k).not.toMatch(/longing|f_val|f_load|s_attach|resident|text|body|subject|interoception/i);
    }
  });

  it("selineReadings 只读 LetterRow 的系统日志字段——信体/主题不进读数", () => {
    const letters = [
      letter({ letterId: "lt-1", composedTs: T0 - DAY, phase: "sent" }),
    ];
    letters[0]!.body = "住户的私密文本";
    letters[0]!.subject = "私密主题";
    const r = selineReadings(letters, T0);
    const serialized = JSON.stringify(r);
    // 信体和主题绝不进 Seline 读数
    expect(serialized).not.toContain("住户的私密文本");
    expect(serialized).not.toContain("私密主题");
  });

  it("事实句不含信体内容", () => {
    const letters = [
      letter({ letterId: "lt-secret", composedTs: T0 - DAY, phase: "sent" }),
    ];
    letters[0]!.body = "凌晨三点的想念";
    const r = selineReadings(letters, T0);
    for (const f of r.facts) {
      expect(f).not.toContain("凌晨三点的想念");
    }
  });
});

describe("Seline · 只看见不动作", () => {
  it("v0 无自动化字段——SelineReading 不含 action/trigger/notify 字段", () => {
    const r = selineReadings([], T0);
    const keys = Object.keys(r);
    for (const k of keys) {
      expect(k).not.toMatch(/^action|trigger|notify|auto|alert_/i);
    }
  });

  it("灯只描述事实，不触发任何动作（lit=true 不等于 action）", () => {
    const letters = [
      letter({ letterId: "lt-1", composedTs: T0 - 5 * DAY, phase: "sent" }),
    ];
    const r = selineReadings(letters, T0);
    // 灯亮了但不触发——只看见
    expect(r.lamps.some((l) => l.lit)).toBe(true);
    // SelineReading 里没有 action 字段
    expect((r as Record<string, unknown>)["action"]).toBeUndefined();
  });
});

describe("Seline · presence 暂缓", () => {
  it("SelineReading 不含 presence 相关字段（v0 暂缓）", () => {
    const r = selineReadings([], T0);
    const keys = Object.keys(r);
    for (const k of keys) {
      expect(k).not.toMatch(/presence|heartbeat|online|login/i);
    }
  });
});

describe("Seline · HTTP 端点", () => {
  it("GET /seline 渲染 HTML 且含镜子不诊断口径", async () => {
    const { createApp } = await import("../../src/server/app.js");
    const { PothosService } = await import("../../src/service.js");
    const { MemoryStore } = await import("../../src/storage/memory.js");
    const { ManualClock } = await import("../../src/clock.js");
    const svc = new PothosService(new MemoryStore(), new ManualClock(T0));
    const app = createApp(svc);
    const res = await app.request("/seline");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("守夜");
    expect(html).toContain("镜子，不诊断");
    expect(html).toContain("双向防火墙");
    expect(html).toContain("只看见不动作");
  });

  it("缺席端点自检：/seline 在白名单", async () => {
    const { createApp, ALLOWED_ROUTES } = await import("../../src/server/app.js");
    const { PothosService } = await import("../../src/service.js");
    const { MemoryStore } = await import("../../src/storage/memory.js");
    const { ManualClock } = await import("../../src/clock.js");
    const svc = new PothosService(new MemoryStore(), new ManualClock(T0));
    const app = createApp(svc);
    const res = await app.request("/admin/audit");
    const body = (await res.json()) as { absentEndpoints: { violations: unknown[] } };
    expect(body.absentEndpoints.violations).toEqual([]);
    expect(ALLOWED_ROUTES.some((r) => r.method === "GET" && r.path === "/seline")).toBe(true);
  });
});
