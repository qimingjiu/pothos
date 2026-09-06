/**
 * declared 契约 v1 · 引擎接线测试：/events 校验门、apply 层轴过滤、MCP declare 工具。
 */
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { PothosService } from "../../src/service.js";
import { MemoryStore } from "../../src/storage/memory.js";
import { ManualClock } from "../../src/clock.js";
import { initialState } from "../../src/core/state.js";
import { applyEvent } from "../../src/core/apply.js";
import { handleMessage, opsFromService, type McpContext } from "../../src/mcp/server.js";
import type { RawEvent, StoredEvent } from "../../src/core/events.js";

function makeService(): PothosService {
  return new PothosService(new MemoryStore(), new ManualClock(1_700_000_000_000));
}

describe("/events · declared 契约门", () => {
  it("不合规 declared 载荷 400（引擎轴之外的轴）", async () => {
    const app = createApp(makeService());
    const res = await app.request("/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "declared",
        ts: 1_700_000_000_000,
        idempotencyKey: "decl-bad-1",
        payload: { readings: [{ axis: "melancholy", intensity: 0.5 }] },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { problems: string[] };
    expect(body.problems.join()).toContain("引擎轴词表");
  });

  it("a2-classifier 缺 model 指纹 / 缺轴 → 400", async () => {
    const app = createApp(makeService());
    const res = await app.request("/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "declared",
        ts: 1_700_000_000_000,
        idempotencyKey: "decl-bad-2",
        payload: { v: 1, producer: "a2-classifier", readings: [{ axis: "longing", intensity: 0.5 }] },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("合规 declared（v1 全字段）201 入库", async () => {
    const app = createApp(makeService());
    const res = await app.request("/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "declared",
        ts: 1_700_000_000_000,
        idempotencyKey: "decl-ok-1",
        payload: {
          v: 1,
          producer: "a2-classifier",
          readings: [
            { axis: "longing", intensity: 0.8 },
            { axis: "distress", intensity: 0.1 },
            { axis: "warmth", intensity: 0.2 },
            { axis: "fatigue", intensity: 0 },
            { axis: "curiosity", intensity: 0.3 },
          ],
          native: [{ axis: "joy", intensity: 0.2 }],
          model: { name: "test-model", promptV: "declare-prompt-v1" },
        },
      }),
    });
    expect(res.status).toBe(201);
  });
});

describe("apply 层 · 引擎轴过滤", () => {
  it("native/自由轴不进 declared 缓存（诊断层不进状态）", () => {
    const st = initialState(1_700_000_000_000, 7);
    const ev: RawEvent = {
      kind: "declared",
      ts: 1_700_000_000_000,
      payload: {
        readings: [
          { axis: "longing", intensity: 0.7 },
          { axis: "distress", intensity: 0.2 },
        ],
        native: [{ axis: "sadness", intensity: 0.9 }],
      },
    };
    applyEvent(st, { ...ev, id: 1 } as StoredEvent); // 原位折叠
    expect(st.declared.map((d) => d.axis)).toEqual(["longing", "distress"]);
  });
});

describe("MCP declare 工具 · 契约化", () => {
  const parse = async (ctx: McpContext, msg: unknown): Promise<Record<string, unknown>> =>
    JSON.parse((await handleMessage(msg, ctx)) ?? "null") as Record<string, unknown>;

  it("自由轴被工具层拒绝并指向 native；引擎轴通过且载荷带 resident-self 打标", async () => {
    const svc = makeService();
    const ctx: McpContext = { side: "resident", ops: opsFromService(svc) };
    const bad = await parse(ctx, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "declare", arguments: { readings: [{ axis: "melancholy", intensity: 0.5 }] } },
    });
    const badResult = bad["result"] as { isError?: boolean; content?: Array<{ text: string }> };
    expect(badResult.isError).toBe(true);
    expect(badResult.content?.[0]?.text ?? "").toMatch(/引擎轴词表/);

    const ok = await parse(ctx, {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: {
        name: "declare",
        arguments: {
          readings: [{ axis: "longing", intensity: 0.7 }],
          native: [{ axis: "Yearning", intensity: 0.4 }],
          idempotencyKey: "decl-mcp-1",
        },
      },
    });
    expect((ok["result"] as { isError?: boolean }).isError).toBeUndefined();
    const events = await svc.store.loadEvents();
    const ev = events.find((e) => e.idempotencyKey === "decl-mcp-1");
    expect(ev?.kind).toBe("declared");
    expect(ev?.payload["producer"]).toBe("resident-self");
    expect(ev?.payload["v"]).toBe(1);
    const native = ev?.payload["native"] as Array<{ axis: string }>;
    expect(native[0]?.axis).toBe("yearning"); // 小写归一
  });
});
