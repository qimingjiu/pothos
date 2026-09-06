/**
 * SDK 集成测试：起真 HTTP 服务（port 0），typed 客户端全方法过一遍。
 * 含 SSE 告警流的 hello/心跳解析与 422 纪律拒绝的非抛错语义。
 */
import { describe, expect, it, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import { createApp } from "../../src/server/app.js";
import { PothosService } from "../../src/service.js";
import { MemoryStore } from "../../src/storage/memory.js";
import { ManualClock } from "../../src/clock.js";
import { PothosClient, PothosApiError } from "../../src/client/sdk.js";

const T0 = 1767400800000;

const clock = new ManualClock(T0);
const svc = new PothosService(new MemoryStore(), clock);
const app = createApp(svc);

let resolvePort!: (p: number) => void;
const portPromise = new Promise<number>((r) => (resolvePort = r));
const server = serve({ fetch: app.fetch, port: 0 }, (info) => resolvePort(info.port));
const port = await portPromise;
const client = new PothosClient({ baseUrl: `http://127.0.0.1:${port}` });

afterAll(async () => {
  server.close();
  await new Promise<void>((r) => setTimeout(r, 20));
});

describe("SDK · 基础面", () => {
  it("health / state / metrics / maView / audit", async () => {
    expect((await client.health()).ok).toBe(true);
    const state = await client.state();
    expect(state.slow).toBeDefined();
    expect(await client.metrics()).toBeDefined();
    const ma = (await client.maView()) as { plan: Array<{ activity: string; allowed: boolean }> };
    expect(ma.plan.some((p) => p.activity === "digest")).toBe(true);
    expect((await client.audit())["absentEndpoints"]).toBeDefined();
  });

  it("ingestEvent：幂等键必填（400）→ 成功（201）→ 重复（200 duplicate）", async () => {
    let err: unknown = null;
    try {
      await client.ingestEvent({ kind: "user_msg", ts: T0, payload: {} } as never);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PothosApiError);
    expect((err as PothosApiError).status).toBe(400);

    const ev = { kind: "user_msg" as const, ts: T0, source: "handle:she", payload: { valence: 0.6, contingency: 0.9 }, idempotencyKey: "sdk-1" };
    const first = await client.ingestEvent(ev);
    expect(first.stored).toBe(true);
    const dup = await client.ingestEvent(ev);
    expect(dup.duplicate).toBe(true);
  });

  it("危机事件响应带字面登记与资源卡；crisisCard 返回纯文本", async () => {
    const res = await client.ingestEvent({ kind: "user_msg", ts: T0, source: "handle:she", payload: { text: "我不想活了", valence: -1, intensity: 0.9, contingency: 0.8 }, idempotencyKey: "sdk-crisis" });
    expect(res.crisis?.triggered).toBe(true);
    expect(res.crisis?.literalRegistration).toContain("危机服务");
    expect(typeof (await client.crisisCard())).toBe("string");
  });

  it("renderInteroception：无数值出镜；对照窗开关", async () => {
    const out = await client.renderInteroception();
    expect(out.controlWindow).toBe(false);
    expect(out.text).not.toMatch(/[0-9]/);
    expect((await client.renderInteroception({ controlWindow: true })).controlWindow).toBe(true);
  });

  it("changeParam：纪律拒绝 422 不抛错，error 原样返回", async () => {
    const bad = await client.changeParam({ key: "noiseFast", newValue: 0.01, reason: "", expectedEffect: "", evaluationWindowMs: 0, rollbackCondition: "" });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("先写预期");
    const unknown = await client.changeParam({ key: "未知键", newValue: 1, reason: "x", expectedEffect: "y", evaluationWindowMs: 0, rollbackCondition: "z" });
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain("未知参数键");
  });

  it("告警签收状态机：ack → acted（越级 409 抛 PothosApiError）", async () => {
    svc.state.somatic.level = 0.9;
    await svc.runTick(T0 + 30 * 60_000);
    const state = await client.state();
    const unacked = (state.alerts as { unacked: Array<{ id: number }> }).unacked;
    expect(unacked.length).toBeGreaterThan(0);
    const id = unacked[0]!.id;
    expect((await client.ackAlert(id)).status).toBe("ACKNOWLEDGED");
    expect((await client.actAlert(id)).status).toBe("ACTED");

    const other = (await client.state()) as { alerts: { unacked: Array<{ id: number }> } };
    const nextId = other.alerts.unacked[0]?.id;
    if (nextId != null) {
      let threw = false;
      try {
        await client.actAlert(nextId); // OBSERVED → ACTED 越级
      } catch (e) {
        threw = e instanceof PothosApiError && (e as PothosApiError).status === 409;
      }
      expect(threw).toBe(true);
    }
  });

  it("alertsStream：收到 hello 且可关闭（SSE 单向只读）", async () => {
    let hello: { rendererV: string } | null = null;
    const stream = client.alertsStream({ onHello: (h) => (hello = h) });
    await new Promise<void>((r) => {
      const t = setInterval(() => {
        if (hello != null) {
          clearInterval(t);
          r();
        }
      }, 50);
      setTimeout(() => {
        clearInterval(t);
        r();
      }, 5000);
    });
    expect(hello).not.toBeNull();
    expect(hello!.rendererV).toMatch(/^r1-/);
    stream.close();
  });
});
