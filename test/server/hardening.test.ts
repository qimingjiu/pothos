/**
 * HTTP 面加固测试：外部事件白名单 / 保留标签剥除 / 时间窗 / token 时序安全与 cookie。
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { createApp } from "../../src/server/app.js";
import { migrationsPath } from "../../src/storage/postgres.js";
import { PothosService } from "../../src/service.js";
import { MemoryStore } from "../../src/storage/memory.js";
import { ManualClock } from "../../src/clock.js";

const T0 = 1767400800000;
const HOUR = 3_600_000;

function setup() {
  const clock = new ManualClock(T0);
  const store = new MemoryStore();
  const svc = new PothosService(store, clock);
  const app = createApp(svc);
  return { svc, clock, store, app };
}

type App = ReturnType<typeof createApp>;

function post(app: App, path: string, body: unknown): Promise<Response> {
  return Promise.resolve(app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
}

describe("/events 外部事件面", () => {
  it("未知 kind → 400", async () => {
    const { app } = setup();
    expect((await post(app, "/events", { kind: "made-up", ts: T0, payload: {}, idempotencyKey: "k1" })).status).toBe(400);
  });

  it("内部 kind 一律拒绝（/events 不是绕过参数纪律的后门）", async () => {
    const { app } = setup();
    for (const kind of ["param_change", "crisis", "ma_product", "alert_ack", "bench", "canary"]) {
      const res = await post(app, "/events", { kind, ts: T0, payload: {}, idempotencyKey: `k-${kind}` });
      expect(res.status, kind).toBe(400);
    }
  });

  it("保留标签剥除：客户端注入 crisis 不触发危机协议；危机仍由词表内容触发", async () => {
    const { app, store } = setup();
    const res = await post(app, "/events", {
      kind: "user_msg", ts: T0, source: "handle:she", payload: { text: "今天天气不错" }, tags: ["crisis", "alert_triggered"], idempotencyKey: "tag1",
    });
    const body = (await res.json()) as { crisis?: unknown };
    expect(body.crisis).toBeUndefined();
    const ev = (await store.loadEvents()).find((e) => e.idempotencyKey === "tag1")!;
    expect(ev.tags).toEqual([]);

    const res2 = await post(app, "/events", { kind: "user_msg", ts: T0 + 60_000, source: "handle:she", payload: { text: "我不想活了" }, idempotencyKey: "tag2" });
    expect(((await res2.json()) as { crisis?: { triggered: boolean } }).crisis?.triggered).toBe(true);
  });

  it("ts 时间窗 [now-24h, now+1h]：越窗 400，窗内 201", async () => {
    const { app } = setup();
    expect((await post(app, "/events", { kind: "user_msg", ts: T0 - 25 * HOUR, payload: {}, idempotencyKey: "t1" })).status).toBe(400);
    expect((await post(app, "/events", { kind: "user_msg", ts: T0 + 2 * HOUR, payload: {}, idempotencyKey: "t2" })).status).toBe(400);
    expect((await post(app, "/events", { kind: "user_msg", ts: T0 + 30 * 60_000, payload: {}, idempotencyKey: "t3" })).status).toBe(201);
  });

  it("payload 必须是对象", async () => {
    const { app } = setup();
    expect((await post(app, "/events", { kind: "user_msg", ts: T0, payload: "hi", idempotencyKey: "p1" })).status).toBe(400);
  });
});

describe("鉴权（时序安全 + cookie 引导）", () => {
  it("无 token / 错 token → 401；正确 query token → 200 并下发 HttpOnly cookie", async () => {
    const { svc } = setup();
    const app = createApp(svc, { token: "secret" });
    expect((await app.request("/state")).status).toBe(401);
    expect((await app.request("/state?token=wrong")).status).toBe(401);
    const first = await app.request("/state?token=secret");
    expect(first.status).toBe(200);
    const setCookie = first.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("pothos_token=");
    expect(setCookie).toContain("HttpOnly");
  });

  it("cookie 鉴权：GET 与 POST 均可免 query token", async () => {
    const { svc } = setup();
    const app = createApp(svc, { token: "secret" });
    const first = await app.request("/state?token=secret");
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(cookie).toBeTruthy();
    expect((await app.request("/state", { headers: { cookie } })).status).toBe(200);
    expect((await app.request("/admin/bench", { method: "POST", headers: { cookie } })).status).toBe(200);
    expect((await app.request("/state")).status).toBe(401);
  }, 60_000);
});

describe("评测台页（GET 无副作用）", () => {
  it("GET 只展示最近结果、不触发运行；POST /admin/bench 才运行", async () => {
    const { app, store } = setup();
    const html1 = await (await app.request("/admin/bench-page")).text();
    expect(html1).toContain("未运行");
    expect((await store.listBenchRuns()).length).toBe(0);

    await app.request("/admin/bench", { method: "POST" });
    const html2 = await (await app.request("/admin/bench-page")).text();
    expect(html2).toContain("全绿");
    expect((await store.listBenchRuns("full_bench")).length).toBe(1);
  }, 120_000);
});

describe("postgres 迁移路径（Windows 安全）", () => {
  it("migrationsPath 解析到真实存在的 001_init.sql（fileURLToPath 处理盘符与百分号编码）", () => {
    const postgresUrl = new URL("../../src/storage/postgres.ts", import.meta.url).href;
    const p = migrationsPath(postgresUrl);
    expect(p.replace(/\\/g, "/")).toContain("migrations/001_init.sql");
    expect(existsSync(p)).toBe(true);
  });
});
