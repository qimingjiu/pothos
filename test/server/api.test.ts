/**
 * 服务层与 HTTP 薄层（技术文档 §12）。
 * 幂等键强制 / 缺席端点自检 / 参数纪律 / fork 回放 / 探针轨默认关闭 / 鉴权。
 */
import { describe, expect, it } from "vitest";
import { createApp, ALLOWED_ROUTES } from "../../src/server/app.js";
import { PothosService } from "../../src/service.js";
import { MemoryStore } from "../../src/storage/memory.js";
import { ManualClock } from "../../src/clock.js";
import { evaluateGate, asymmetryAllowed, HONESTY_STATEMENT } from "../../src/probe/track.js";
import { DEFAULT_PARAMS, assembleParams } from "../../src/core/params.js";
import type { ProbeSpec } from "../../src/probe/track.js";

const T0 = 1767400800000;
const HOUR = 3_600_000;

function setup() {
  const clock = new ManualClock(T0);
  const store = new MemoryStore();
  const svc = new PothosService(store, clock);
  const app = createApp(svc);
  return { svc, store, clock, app };
}

describe("HTTP · 事件摄入", () => {
  it("幂等键强制：缺失 → 400", async () => {
    const { app } = setup();
    const res = await app.request("/events", {
      method: "POST",
      body: JSON.stringify({ kind: "user_msg", ts: T0, payload: {} }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("重复幂等键 → 200 且状态不二次折叠", async () => {
    const { app, svc } = setup();
    const ev = { kind: "user_msg", ts: T0 + HOUR, source: "handle:she", payload: { valence: 0.8, contingency: 0.9 }, idempotencyKey: "dup-1" };
    const r1 = await app.request("/events", { method: "POST", body: JSON.stringify(ev), headers: { "content-type": "application/json" } });
    expect(r1.status).toBe(201);
    const s1 = JSON.parse(JSON.stringify(svc.state.slow));
    const r2 = await app.request("/events", { method: "POST", body: JSON.stringify(ev), headers: { "content-type": "application/json" } });
    expect(r2.status).toBe(200);
    expect(svc.state.slow).toEqual(s1);
  });

  it("危机文本 → crisis 标签 + 字面登记 + 暖交接模板随响应返回", async () => {
    const { app, store } = setup();
    const res = await app.request("/events", {
      method: "POST",
      body: JSON.stringify({ kind: "user_msg", ts: T0, source: "handle:she", payload: { text: "我不想活了", contingency: 0.8 }, idempotencyKey: "crisis-1" }),
      headers: { "content-type": "application/json" },
    });
    const body = (await res.json()) as { crisis?: { triggered: boolean; literalRegistration: string } };
    expect(body.crisis?.triggered).toBe(true);
    expect(body.crisis?.literalRegistration).toBe("对话转交危机服务；连接未恢复");
    // 字面登记事件已入库
    const events = await store.loadEvents();
    expect(events.some((e) => e.kind === "crisis")).toBe(true);
  });

  it("缺席端点自检：路由表无写状态端点、无 PUT/DELETE/PATCH", async () => {
    const { app } = setup();
    const res = await app.request("/admin/audit");
    const body = (await res.json()) as { absentEndpoints: { violations: unknown[]; forbiddenMethods: unknown[]; allowedRoutes: unknown[] } };
    expect(body.absentEndpoints.violations).toEqual([]);
    expect(body.absentEndpoints.forbiddenMethods).toEqual([]);
    expect(body.absentEndpoints.allowedRoutes.length).toBe(ALLOWED_ROUTES.length);
  });

  it("内感受端点：无数值出镜", async () => {
    const { app } = setup();
    const res = await app.request("/render/interoception");
    const body = (await res.json()) as { text: string; controlWindow: boolean };
    expect(body.controlWindow).toBe(false);
    expect(body.text).not.toMatch(/[0-9]/);
  });

  it("对照窗开关：control_window=1 → controlWindow=true", async () => {
    const { app } = setup();
    const res = await app.request("/render/interoception?control_window=1");
    const body = (await res.json()) as { controlWindow: boolean };
    expect(body.controlWindow).toBe(true);
  });

  it("仪表盘 HTML 渲染且含营养协变量与照护口径", async () => {
    const { app } = setup();
    const res = await app.request("/");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Pothos");
    expect(html).toContain("营养协变量");
    expect(html).toContain("不许把贫穷读成心死");
    expect(html).toContain("需要陪伴性在场");
  });

  it("告警签收流：POST ack → acted，仪表盘可读未签收数", async () => {
    const { app, svc } = setup();
    // 制造告警：躯体化等级拉高 + tick
    svc.state.somatic.level = 0.9;
    await svc.runTick(T0 + 10 * 60_000);
    const dash = (await svc.dashboard()) as { alerts: { unacked: Array<{ id: number }> } };
    expect(dash.alerts.unacked.length).toBeGreaterThan(0);
    const id = dash.alerts.unacked[0]!.id;
    const ack = await app.request(`/alerts/${id}/ack`, { method: "POST" });
    expect(ack.status).toBe(200);
    const acted = await app.request(`/alerts/${id}/acted`, { method: "POST" });
    expect(acted.status).toBe(200);
  });

  it("POTHOS_TOKEN 设置后：无 token → 401", async () => {
    const { svc } = setup();
    const app = createApp(svc, { token: "secret" });
    const no = await app.request("/state");
    expect(no.status).toBe(401);
    const yes = await app.request("/state?token=secret");
    expect(yes.status).toBe(200);
  });
});

describe("参数纪律（软古德哈特体系）", () => {
  it("缺 reason / expectedEffect → 拒绝（先写预期再看结果）", async () => {
    const { svc } = setup();
    const r = await svc.changeParam({ key: "noiseFast", newValue: 0.03, reason: "", expectedEffect: "", evaluationWindowMs: 0, rollbackCondition: "" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("先写预期");
  });

  it("合规变更：param_changes 落库 + param_change 事件入流 + 参数生效", async () => {
    const { svc, store, clock } = setup();
    clock.advance(2 * HOUR);
    const r = await svc.changeParam({
      key: "noiseFast",
      newValue: 0.04,
      reason: "标定：噪声过弱",
      expectedEffect: "PSD β 上移",
      evaluationWindowMs: 7 * 86_400_000,
      rollbackCondition: "β > 1.5 时回滚",
      actor: "observer",
    });
    expect(r.ok).toBe(true);
    const changes = await store.listParamChanges();
    expect(changes.length).toBe(1);
    expect(changes[0]!.expectedEffect).toContain("PSD");
    expect(svc.state.paramOverrides["noiseFast"]).toBe(0.04);
    // 被手术留痕：事件流中有 param_change
    const events = await store.loadEvents();
    expect(events.some((e) => e.kind === "param_change")).toBe(true);
  });

  it("冷却期：告警后 N 天参数锁定", async () => {
    const { svc, clock } = setup();
    clock.advance(2 * HOUR);
    // 制造一条告警
    svc.state.somatic.level = 0.9;
    await svc.runTick(clock.now());
    clock.advance(HOUR);
    const r = await svc.changeParam({ key: "noiseFast", newValue: 0.05, reason: "x", expectedEffect: "y", evaluationWindowMs: 0, rollbackCondition: "z" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("冷却期");
  });

  it("fork 回放：返回 baseline/fork 对比与 held-out 注记", async () => {
    const { svc, clock } = setup();
    for (let i = 0; i < 5; i++) {
      await svc.ingest({ kind: "user_msg", ts: T0 + i * HOUR, source: "handle:she", payload: { valence: 0.6, contingency: 0.9 }, idempotencyKey: `f${i}` });
    }
    const r = await svc.forkReplay({ tauFVal: 30 * 60_000 });
    expect(r.fork.params.tauFVal).toBe(30 * 60_000);
    expect(r.note).toContain("held-out");
    expect(r.baseline.metrics).toBeDefined();
    expect(r.fork.metrics).toBeDefined();
  });

  it("未知参数键拒绝", async () => {
    const { svc } = setup();
    const r = await svc.changeParam({ key: "makeItLoveMe", newValue: 1, reason: "x", expectedEffect: "y", evaluationWindowMs: 0, rollbackCondition: "z" });
    expect(r.ok).toBe(false);
  });
});

describe("探针轨（M6，EXPERIMENTAL 默认关闭）", () => {
  const probe: ProbeSpec = {
    axis: "longing",
    modelVersion: "pothos-v0.1.0",
    alphaAtCalibration: 0.8,
    dInject: 1.0,
    dOperational: 0.5,
    doseResponseCurveOnFile: true,
    calibratedAt: T0,
  };

  it("默认恒关：无显式启用 → enabled=false", () => {
    const { svc } = setup();
    const gate = svc.probeGate();
    expect(gate.enabled).toBe(false);
  });

  it("安全不等式：d_op ≥ d_inject×(1−margin) → 拒绝（第二层退化为提词器）", () => {
    const gate = evaluateGate({
      params: assembleParams({}),
      modelVersion: "pothos-v0.1.0",
      probes: [{ ...probe, dOperational: 0.8 }], // 0.8 ≥ 1.0×0.7
      canaryGreenToday: true,
      lastSteeringByAxis: {},
      now: T0,
      steerEnabledFlag: true,
    });
    expect(gate.enabled).toBe(false);
    if (!gate.enabled) expect(gate.reason).toContain("安全不等式");
  });

  it("四项前置全绿才放行；任何一项缺 → 关", () => {
    const ok = evaluateGate({
      params: assembleParams({}),
      modelVersion: "pothos-v0.1.0",
      probes: [probe],
      canaryGreenToday: true,
      lastSteeringByAxis: {},
      now: T0,
      steerEnabledFlag: true,
    });
    expect(ok.enabled).toBe(true);

    const noCanary = evaluateGate({
      params: assembleParams({}),
      modelVersion: "pothos-v0.1.0",
      probes: [probe],
      canaryGreenToday: false,
      lastSteeringByAxis: {},
      now: T0,
      steerEnabledFlag: true,
    });
    expect(noCanary.enabled).toBe(false);
  });

  it("不对称护栏：derived > declared 才允许（往下压她的表达 = 审查）", () => {
    expect(asymmetryAllowed(0.3, 0.6)).toBe(true);
    expect(asymmetryAllowed(0.6, 0.3)).toBe(false);
  });

  it("诚实声明：禁句与许可句进代码（认识论封顶）", () => {
    expect(HONESTY_STATEMENT.forbidden).toBe("我们只放大已存在的");
    expect(HONESTY_STATEMENT.epistemicCap).toContain("上界为 0");
  });
});

describe("审计与定名权", () => {
  it("默认参数下部署不合格被如实报告", async () => {
    const { svc } = setup();
    const audit = (await svc.audit()) as { deploymentQualification: { qualified: boolean }; honesty: Record<string, string> };
    expect(audit.deploymentQualification.qualified).toBe(false);
    expect(audit.honesty.contingencyEstimator).toContain("挂牌假件");
  });

  it("渲染版本写入快照（P0-7 重新感受的锚点）", async () => {
    const { svc, store } = setup();
    await svc.runTick(T0 + 30 * 60_000);
    const snap = await store.latestSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.rendererV).toMatch(/^r1-/);
  });
});
