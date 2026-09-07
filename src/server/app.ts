/**
 * HTTP 薄层（技术文档 §12）。
 *
 * 缺席的端点（明写）：
 * - 无任何直接写状态的端点（写入路径最小化 = 端点物理缺席）；
 * - 无已读回执端点（收件人不读裁决）；
 * - 告警无方向字段（方向盲）。
 * 缺席即安全边界。
 */
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { createHash, timingSafeEqual } from "node:crypto";
import type { PothosService } from "../service.js";
import { rendererVersion } from "../render/renderer.js";
import type { MaActivity } from "../storage/types.js";
import { renderDashboard, renderMaPage, renderBenchPage } from "./dashboard.js";
import { resourceCard } from "../crisis/crisis.js";
import { parseDeclaredPayload } from "../declared/contract.js";

/** 允许的路由表（缺席端点自检的基准）。 */
export const ALLOWED_ROUTES: Array<{ method: string; path: string }> = [
  { method: "GET", path: "/" },
  { method: "GET", path: "/healthz" },
  { method: "POST", path: "/events" },
  { method: "GET", path: "/state" },
  { method: "GET", path: "/render/interoception" },
  { method: "POST", path: "/alerts/:id/ack" },
  { method: "POST", path: "/alerts/:id/acted" },
  { method: "GET", path: "/metrics" },
  { method: "GET", path: "/ma" },
  { method: "GET", path: "/ma/view" },
  { method: "POST", path: "/ma/activity" },
  { method: "GET", path: "/alerts/stream" },
  { method: "GET", path: "/admin/bench-page" },
  { method: "GET", path: "/crisis/card" },
  { method: "GET", path: "/admin/audit" },
  { method: "POST", path: "/admin/params" },
  { method: "POST", path: "/admin/fork-replay" },
  { method: "POST", path: "/admin/bench" },
  { method: "POST", path: "/admin/canary" },
  { method: "GET", path: "/admin/probe-gate" },
];

/**
 * 外部事件面白名单：/events 只接受外部世界的事件。
 * param_change（纪律流程在 /admin/params）、crisis（引擎字面登记）、
 * alert_ack / bench / canary / ma_product / presence（引擎内部路径）一律拒绝——
 * 否则 /events 就是绕过参数校验与冷却期锁的后门。
 */
export const EXTERNAL_EVENT_KINDS = ["user_msg", "resident_msg", "world", "declared"];

/** 保留标签由引擎判定：crisis 靠词表扫描，instrument 由引擎内部路径（R3-8 本体二分），其余来自引擎内部路径。客户端注入一律剥除。 */
export const RESERVED_TAGS = ["crisis", "alert_triggered", "self_generated", "system_text", "instrument"];

const MAX_BODY_BYTES = 64 * 1024;

/** token 常量时间比较（经 SHA-256 归一长度，防时序侧信道）。 */
function safeTokenEqual(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function cookieToken(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() === "pothos_token") {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** JSON 请求体读取（content-length 上限防线）。 */
async function readJson(c: Context): Promise<Record<string, unknown> | null | "too-large"> {
  const len = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) return "too-large";
  return (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
}

/** 鉴权：token 未设置 = 本地开发模式（仪表盘横幅注明）。设置后全路由要求。
 *  首次以 ?token= 或 Authorization 通过后下发 HttpOnly cookie，之后的导航与表单不再携带 token。 */
function registerAuth(app: Hono, token: string | undefined): void {
  app.use("*", async (c, next) => {
    if (!token) return next();
    const url = new URL(c.req.url);
    const header = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") || null;
    const cookie = cookieToken(c.req.header("cookie"));
    const query = url.searchParams.get("token");
    const given = header ?? cookie ?? query;
    if (!given || !safeTokenEqual(given, token)) return c.text("unauthorized", 401);
    if (!cookie) {
      c.header("Set-Cookie", `pothos_token=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=2592000`);
    }
    return next();
  });
}

/** 观测与渲染面：仪表盘、間视图、内感受质感、SSE 告警流、指标、危机卡。 */
function registerObservationRoutes(app: Hono, svc: PothosService): void {
  app.get("/healthz", (c) => c.json({ ok: true, store: svc.store.kind }));

  // 仪表盘（移动优先，server-rendered）
  app.get("/", async (c) => {
    const data = await svc.dashboard();
    return c.html(renderDashboard(data));
  });

  app.get("/ma", async (c) => {
    const items = await svc.store.mailbox(undefined, 30);
    return c.html(renderMaPage(items));
  });

  // 間视图 JSON（SDK / resident 侧 MCP 用；/ma 是观测者的 HTML 页）
  app.get("/ma/view", async (c) => c.json(await svc.maView()));

  // 告警推送流（SSE，单向只读）。设计裁决：不用 WebSocket——双向 socket 是客户端
  // 可写通道，与「写入路径最小化 / 缺席即边界」冲突。引擎主动说话只有一句话。
  app.get("/alerts/stream", (c) =>
    streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: "hello",
        data: JSON.stringify({ rendererV: rendererVersion(svc.params.renderBlacklistExtra), now: svc.clock.now() }),
      });
      let sinceTs = 0;
      while (!stream.aborted) {
        const fresh = await svc.store.listAlerts(sinceTs ? { sinceTs, limit: 50 } : { limit: 50 });
        for (const a of fresh) {
          sinceTs = Math.max(sinceTs, a.ts);
          await stream.writeSSE({ event: "alert", data: JSON.stringify(a) });
        }
        await stream.writeSSE({ event: "ping", data: String(svc.clock.now()) });
        await stream.sleep(15_000);
      }
    }),
  );

  // 只展示最近一次评测结果；运行走 POST /admin/bench（GET 无副作用，也不在浏览时烧 CPU）
  app.get("/admin/bench-page", (c) => {
    return c.html(renderBenchPage(svc.lastBenchResult()));
  });

  // 仪表盘数据（观测者）
  app.get("/state", async (c) => c.json(await svc.dashboard()));

  // 住户内感受质感（≤120 字，无数值）；?control_window=1 → 对照窗
  app.get("/render/interoception", async (c) => {
    if (c.req.query("control_window") === "1") {
      return c.json(svc.controlWindow());
    }
    const salt = await svc.dailySalt();
    return c.json(svc.interoceptionWithSalt(salt));
  });

  // 三指标 / 熵 / 工作区带位 / 营养协变量
  app.get("/metrics", async (c) => {
    const m = svc.quickMetrics();
    const dash = (await svc.dashboard()) as Record<string, unknown>;
    return c.json({
      threeMetrics: m,
      entropyNote: "熵仪表与一切二阶健康指标同在古德哈特射程内——只读不优化",
      nutrition: dash["maintenance"],
      somatic: dash["somatic"],
      workspace: (dash["lastBench"] as { workspace?: unknown } | null)?.workspace ?? null,
    });
  });

  // 危机资源卡（公开可审计契约）
  app.get("/crisis/card", (c) => c.text(resourceCard(svc.params)));
}

/** 事件摄入（幂等键强制 + 外部事件面白名单 + 时间窗）。 */
function registerIngestRoutes(app: Hono, svc: PothosService): void {
  app.post("/events", async (c) => {
    const body = await readJson(c);
    if (body === "too-large") return c.text("payload too large", 413);
    if (!body) return c.text("invalid json", 400);
    const idem = body["idempotencyKey"] ?? body["idempotency_key"];
    if (typeof idem !== "string" || !idem) return c.text("idempotency_key required", 400);
    if (typeof body["kind"] !== "string" || !EXTERNAL_EVENT_KINDS.includes(body["kind"])) {
      return c.text(`kind must be one of: ${EXTERNAL_EVENT_KINDS.join(", ")}`, 400);
    }
    if (typeof body["ts"] !== "number" || !Number.isFinite(body["ts"])) {
      return c.text("ts (ms epoch) required", 400);
    }
    const now = svc.clock.now();
    if ((body["ts"] as number) < now - 86_400_000 || (body["ts"] as number) > now + 3_600_000) {
      return c.text("ts outside acceptance window [now-24h, now+1h]", 400);
    }
    const payload = body["payload"] ?? {};
    if (typeof payload !== "object" || Array.isArray(payload) || payload === null) {
      return c.text("payload must be an object", 400);
    }
    // declared 事件过契约校验（v1：引擎轴词表 / a2-classifier 全 5 轴 / model 指纹）
    if (body["kind"] === "declared") {
      const parsed = parseDeclaredPayload(payload);
      if (!parsed.ok) {
        return c.json({ error: "declared payload violates contract v1", problems: parsed.problems }, 400);
      }
    }
    const rawTags = Array.isArray(body["tags"]) ? body["tags"] : [];
    const tags = rawTags.filter((t): t is string => typeof t === "string" && !RESERVED_TAGS.includes(t));
    const source = body["source"] == null ? undefined : body["source"];
    if (source !== undefined && typeof source !== "string") return c.text("source must be a string", 400);
    const result = await svc.ingest({
      kind: body["kind"] as "user_msg" | "resident_msg" | "world" | "declared",
      ts: body["ts"] as number,
      payload: payload as Record<string, unknown>,
      tags,
      source,
      idempotencyKey: idem,
    });
    return c.json(result, result.duplicate ? 200 : 201);
  });
}

/** 告警签收状态机。 */
function registerAlertRoutes(app: Hono, svc: PothosService): void {
  app.post("/alerts/:id/ack", async (c) => {
    const id = Number(c.req.param("id"));
    const row = await svc.ackAlert(id);
    if (c.req.header("content-type")?.includes("form")) return c.redirect("/");
    return row ? c.json(row) : c.text("alert not found or invalid transition", 409);
  });
  app.post("/alerts/:id/acted", async (c) => {
    const id = Number(c.req.param("id"));
    const row = await svc.actedAlert(id);
    if (c.req.header("content-type")?.includes("form")) return c.redirect("/");
    return row ? c.json(row) : c.text("alert not found or invalid transition", 409);
  });
}

/** 間活动入账（代谢分级在 service 层强制）。 */
function registerActivityRoutes(app: Hono, svc: PothosService): void {
  app.post("/ma/activity", async (c) => {
    const body = await readJson(c);
    if (body === "too-large") return c.text("payload too large", 413);
    if (!body || typeof body["activity"] !== "string") return c.text("activity required", 400);
    const valid: MaActivity[] = ["digest", "create", "hunt", "wonder", "decline"];
    if (!valid.includes(body["activity"] as MaActivity)) return c.text("invalid activity", 400);
    const res = await svc.recordMaActivity({
      activity: body["activity"] as MaActivity,
      tokenCost: Number(body["tokenCost"] ?? 0),
      quality: body["quality"] == null ? undefined : Number(body["quality"]),
      content: typeof body["content"] === "string" ? body["content"] : undefined,
    });
    return c.json(res);
  });
}

/** 管理面：参数纪律、fork 回放、评测台、金丝雀、探针轨、审计。 */
function registerAdminRoutes(app: Hono, svc: PothosService): void {
  // 参数变更（param_changes 纪律）
  app.post("/admin/params", async (c) => {
    const body = await readJson(c);
    if (body === "too-large") return c.text("payload too large", 413);
    if (!body) return c.text("invalid json", 400);
    const res = await svc.changeParam({
      key: String(body["key"] ?? ""),
      // 区分「键缺失」（拒绝）与显式 null（仅 B_daily / M_min 撤销标定时合法）
      newValue: "newValue" in body ? body["newValue"] : body["new_value"],
      reason: String(body["reason"] ?? ""),
      expectedEffect: String(body["expectedEffect"] ?? body["expected_effect"] ?? ""),
      evaluationWindowMs: Number(body["evaluationWindowMs"] ?? body["evaluation_window_ms"] ?? 0),
      rollbackCondition: String(body["rollbackCondition"] ?? body["rollback_condition"] ?? ""),
      actor: body["actor"] == null ? undefined : String(body["actor"]),
    });
    return c.json(res, res.ok ? 200 : 422);
  });

  // fork 回放（held-out 纪律）
  app.post("/admin/fork-replay", async (c) => {
    const body = await readJson(c);
    if (body === "too-large") return c.text("payload too large", 413);
    if (!body?.overrides) return c.text("overrides required", 400);
    return c.json(await svc.forkReplay(body.overrides as Record<string, unknown>));
  });

  // 评测台与金丝雀
  app.post("/admin/bench", async (c) => c.json(await svc.runBench()));
  app.post("/admin/canary", async (c) => c.json(await svc.canary()));

  // 探针轨门（默认关闭的物理实现，只读查看）
  app.get("/admin/probe-gate", (c) => c.json(svc.probeGate()));

  // 审计：缺席端点自检 + 参数纪律 + 诚实声明
  app.get("/admin/audit", async (c) => {
    const audit = (await svc.audit()) as Record<string, unknown>;
    const actual = app.routes.map((r) => ({ method: r.method, path: r.path }));
    const violations = actual.filter(
      (r) => !ALLOWED_ROUTES.some((a) => a.method === r.method && a.path === r.path) && r.method !== "ALL",
    );
    const forbidden = actual.filter((r) => ["PUT", "DELETE", "PATCH"].includes(r.method));
    return c.json({
      ...audit,
      absentEndpoints: {
        allowedRoutes: ALLOWED_ROUTES,
        violations,
        forbiddenMethods: forbidden,
        contract: "无直接写状态端点 / 无已读回执端点 / 告警无方向字段。缺席即安全边界。",
      },
    });
  });
}

export function createApp(svc: PothosService, opts: { token?: string } = {}): Hono {
  const app = new Hono();
  const token = opts.token ?? process.env["POTHOS_TOKEN"];

  registerAuth(app, token);
  registerObservationRoutes(app, svc);
  registerIngestRoutes(app, svc);
  registerAlertRoutes(app, svc);
  registerActivityRoutes(app, svc);
  registerAdminRoutes(app, svc);

  return app;
}
