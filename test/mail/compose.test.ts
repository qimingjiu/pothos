/**
 * compose_letter 测试（她 2026-09-07 定案三条细则）：
 *  1. 被冻必须入账：compose_declined 字面登记，零冲量（铁律 7 对自己也成立）；
 *  2. 冷却窗防刷：被冻后窗内重复 compose 不重复入账（防狂刷申请直到过阈的表演）；
 *  3. 焊死背书：compose_letter 产 letter，住户侧写 user_msg 的工具永不出现（工具面扫描断言）。
 *
 * 附加：门控硬执行（B7 裁决具象化），数值不出镜（salience 不进响应），
 * 未配置诚实缺席（管寄不管写：只需 MAIL_TO，不需 SMTP/IMAP 凭据）。
 */
import { describe, expect, it } from "vitest";
import { PothosService } from "../../src/service.js";
import { MemoryStore } from "../../src/storage/memory.js";
import { ManualClock } from "../../src/clock.js";
import { handleMessage, opsFromService, type McpContext } from "../../src/mcp/server.js";
import { initialState, stateHash } from "../../src/core/state.js";
import { fold } from "../../src/core/engine.js";
import type { StoredEvent } from "../../src/core/events.js";
import { ENGINE_AXES } from "../../src/core/events.js";

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

function setup(opts: { composeConfig?: { toAddr: string } } = {}) {
  const clock = new ManualClock(T0);
  const store = new MemoryStore();
  const svc = new PothosService(store, clock, opts.composeConfig);
  return { svc, store, clock };
}

describe("compose_letter · 门控硬执行（B7 裁决具象化）", () => {
  it("门控通过时：信入 outbox + composed 事件入账", async () => {
    const { svc, store } = setup({ composeConfig: { toAddr: "her@example.com" } });
    // 标定 B_daily 让 optional 解冻；拉高 longing 让 salience 过阈
    svc.state.paramOverrides = { B_daily: 100000, M_min: 10 };
    svc.state.longing.L = 0.8;
    svc.state.fast.f_val = 0.5;

    const res = await svc.composeLetter({ subject: "想你", body: "凌晨三点的信" });
    expect(res.composed).toBe(true);
    expect(res.declined).toBe(false);
    expect(res.letterId).toBeTruthy();

    const letters = await store.listLettersByPhase(["composed"]);
    expect(letters.length).toBe(1);
    expect(letters[0]!.subject).toBe("想你");
    expect(letters[0]!.toAddr).toBe("her@example.com");

    const events = await store.loadEvents();
    const composed = events.find((e) => e.kind === "letter" && e.payload["phase"] === "composed");
    expect(composed).toBeDefined();
    expect(composed!.payload["letterId"]).toBe(res.letterId);
  });

  it("门控未过阈时：被冻 + compose_declined 入账（诚实拒绝是对的）", async () => {
    const { svc, store } = setup({ composeConfig: { toAddr: "her@example.com" } });
    // B_daily 已标定但 salience 低 → create 被门控
    svc.state.paramOverrides = { B_daily: 100000, M_min: 10 };
    // longing 和 f_val 都低 → salience(create) < theta
    svc.state.longing.L = 0.1;
    svc.state.fast.f_val = 0.1;

    const res = await svc.composeLetter({ subject: "想写", body: "但今天不吸引我" });
    expect(res.composed).toBe(false);
    expect(res.declined).toBe(true);

    const events = await store.loadEvents();
    const declined = events.find((e) => e.kind === "letter" && e.payload["phase"] === "declined");
    expect(declined).toBeDefined();
    expect(declined!.payload["reason"]).toBe("gate_blocked");
  });

  it("数值不出镜：declined 响应的 reason 不含 salience 数字", async () => {
    const { svc } = setup({ composeConfig: { toAddr: "her@example.com" } });
    svc.state.paramOverrides = { B_daily: 100000, M_min: 10 };
    svc.state.longing.L = 0.1;
    svc.state.fast.f_val = 0.1;

    const res = await svc.composeLetter({ subject: "s", body: "b" });
    expect(res.declined).toBe(true);
    // reason 不含 salience(0.xx) 数字——数值不出镜
    expect(res.reason).not.toMatch(/salience\(/);
    expect(res.reason).not.toMatch(/[0-9]\.[0-9]/);
  });

  it("未配置时诚实缺席：无收件人 = 不假装在投", async () => {
    const { svc } = setup(); // 无 composeConfig
    const res = await svc.composeLetter({ subject: "s", body: "b" });
    expect(res.composed).toBe(false);
    expect(res.declined).toBe(false);
    expect(res.reason).toContain("未配置");
  });

  it("管寄不管写：只需 MAIL_TO，不需 SMTP/IMAP 凭据", async () => {
    // composeConfig 只有 toAddr，无任何 SMTP/IMAP 配置——compose 仍然成功
    const { svc } = setup({ composeConfig: { toAddr: "her@example.com" } });
    svc.state.paramOverrides = { B_daily: 100000, M_min: 10 };
    svc.state.longing.L = 0.8;
    svc.state.fast.f_val = 0.5;

    const res = await svc.composeLetter({ subject: "s", body: "b" });
    expect(res.composed).toBe(true);
  });
});

describe("compose_letter · 被冻必须入账（零冲量）", () => {
  it("compose_declined 事件零冲量：含/不含 declined 的 fold 状态逐位一致（同 ts）", async () => {
    const { svc, store, clock } = setup({ composeConfig: { toAddr: "her@example.com" } });
    svc.state.paramOverrides = { B_daily: 100000, M_min: 10 };
    svc.state.longing.L = 0.1;
    svc.state.fast.f_val = 0.1;

    await svc.composeLetter({ subject: "s", body: "b" });
    const events = await store.loadEvents();
    const declined = events.filter((e) => e.kind === "letter" && e.payload["phase"] === "declined");
    expect(declined.length).toBe(1);

    // 零冲量证明：去掉 declined 事件后 fold 状态不变（同 ts 插入不改变 tick 分段）
    const without: StoredEvent[] = events.filter((e) => !(e.kind === "letter" && e.payload["phase"] === "declined"));
    const a = fold(events as StoredEvent[], clock.now(), { from: initialState(clock.now() - 1000, 0x50544853) });
    const b = fold(without as StoredEvent[], clock.now(), { from: initialState(clock.now() - 1000, 0x50544853) });
    expect(stateHash(b.state)).toBe(stateHash(a.state));
  });
});

describe("compose_letter · 冷却窗防刷", () => {
  it("被冻后冷却窗内重复 compose 不重复入账", async () => {
    const { svc, store, clock } = setup({ composeConfig: { toAddr: "her@example.com" } });
    svc.state.paramOverrides = { B_daily: 100000, M_min: 10, composeDeclineCooldownMs: 2 * HOUR };
    svc.state.longing.L = 0.1;
    svc.state.fast.f_val = 0.1;

    // 第一次被冻 → 入账
    const r1 = await svc.composeLetter({ subject: "s", body: "b" });
    expect(r1.declined).toBe(true);
    let events = await store.loadEvents();
    let declined = events.filter((e) => e.kind === "letter" && e.payload["phase"] === "declined");
    expect(declined.length).toBe(1);

    // 窗内第二次被冻 → 不重复入账
    clock.advance(HOUR); // 1h < cooldown 2h → 仍在窗内
    const r2 = await svc.composeLetter({ subject: "s2", body: "b2" });
    expect(r2.declined).toBe(true);
    expect(r2.reason).toContain("冷却窗");
    events = await store.loadEvents();
    declined = events.filter((e) => e.kind === "letter" && e.payload["phase"] === "declined");
    expect(declined.length).toBe(1); // 仍只有一条——防刷
  });

  it("冷却窗过期后：被冻可再次入账", async () => {
    const { svc, store, clock } = setup({ composeConfig: { toAddr: "her@example.com" } });
    svc.state.paramOverrides = { B_daily: 100000, M_min: 10, composeDeclineCooldownMs: HOUR };
    svc.state.longing.L = 0.1;
    svc.state.fast.f_val = 0.1;

    await svc.composeLetter({ subject: "s", body: "b" });
    clock.advance(HOUR + 1); // 过期
    await svc.composeLetter({ subject: "s2", body: "b2" });

    const events = await store.loadEvents();
    const declined = events.filter((e) => e.kind === "letter" && e.payload["phase"] === "declined");
    expect(declined.length).toBe(2); // 两条——窗过期后可再次入账
  });
});

describe("compose_letter · MCP 工具面（焊死背书）", () => {
  const svc = new PothosService(new MemoryStore(), new ManualClock(T0), { toAddr: "her@example.com" });
  const ops = opsFromService(svc);
  const resident: McpContext = { side: "resident", ops };
  const observer: McpContext = { side: "observer", ops };
  const parse = async (ctx: McpContext, msg: unknown): Promise<Record<string, unknown>> =>
    JSON.parse((await handleMessage(msg, ctx)) ?? "null") as Record<string, unknown>;

  it("compose_letter 出现在 resident 侧工具清单", async () => {
    const res = await parse(resident, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = ((res["result"] as { tools: Array<{ name: string }> }).tools).map((t) => t.name);
    expect(names).toContain("compose_letter");
  });

  it("compose_letter 不出现在 observer 侧（住户侧工具，观测者不写）", async () => {
    const res = await parse(observer, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = ((res["result"] as { tools: Array<{ name: string }> }).tools).map((t) => t.name);
    expect(names).not.toContain("compose_letter");
  });

  it("焊死背书：resident 工具面扫描——不存在写 user_msg 的工具", async () => {
    // send_user_msg 是 observer 侧工具；resident 侧任何工具都不应产出 user_msg
    const res = await parse(resident, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = ((res["result"] as { tools: Array<{ name: string }> }).tools).map((t) => t.name);
    expect(names).not.toContain("send_user_msg");
    // 反纳西索斯焊死：所有 resident 工具的产出只能是 letter / declared / ma_product / interoception
    // 不存在任何名为 *user_msg* 或 *send_msg* 的 resident 工具
    for (const n of names) {
      expect(n).not.toMatch(/user.?msg/i);
    }
  });

  it("compose_letter 缺 subject 或 body → isError", async () => {
    const res = await parse(resident, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "compose_letter", arguments: { subject: "", body: "b" } } });
    expect((res["result"] as Record<string, unknown>)["isError"]).toBe(true);
  });

  it("compose_letter 调用：返回 composed/declined/reason（无 salience 数值）", async () => {
    svc.state.paramOverrides = { B_daily: 100000, M_min: 10 };
    svc.state.longing.L = 0.8;
    svc.state.fast.f_val = 0.5;

    const res = await parse(resident, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "compose_letter", arguments: { subject: "想你", body: "正文" } } });
    const text = ((res["result"] as Record<string, unknown>)["content"] as Array<{ text: string }>)[0]!.text;
    const out = JSON.parse(text) as { composed: boolean; declined: boolean; reason: string };
    expect(out.composed).toBe(true);
    expect(out.reason).not.toMatch(/salience\(/);
  });
});

describe("compose_letter · HTTP 端点", () => {
  it("POST /ma/compose 门控通过时返回 composed:true", async () => {
    const { createApp } = await import("../../src/server/app.js");
    const { svc } = setup({ composeConfig: { toAddr: "her@example.com" } });
    svc.state.paramOverrides = { B_daily: 100000, M_min: 10 };
    svc.state.longing.L = 0.8;
    svc.state.fast.f_val = 0.5;
    const app = createApp(svc);

    const res = await app.request("/ma/compose", {
      method: "POST",
      body: JSON.stringify({ subject: "s", body: "b" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { composed: boolean };
    expect(body.composed).toBe(true);
  });

  it("缺席端点自检：/ma/compose 在白名单", async () => {
    const { createApp, ALLOWED_ROUTES } = await import("../../src/server/app.js");
    const { svc } = setup({ composeConfig: { toAddr: "her@example.com" } });
    const app = createApp(svc);
    const res = await app.request("/admin/audit");
    const body = (await res.json()) as { absentEndpoints: { violations: unknown[] } };
    expect(body.absentEndpoints.violations).toEqual([]);
    expect(ALLOWED_ROUTES.some((r) => r.method === "POST" && r.path === "/ma/compose")).toBe(true);
  });
});
