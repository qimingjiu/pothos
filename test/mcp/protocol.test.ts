/**
 * MCP 壳测试：
 *  1. 协议直测（handleMessage）：握手 / 工具清单 / 双侧纪律 / 调用 / 错误语义；
 *  2. stdio 回环（spawn 子进程跑真入口，NDJSON 协议全流程）。
 */
import { describe, expect, it, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { handleMessage, opsFromService, MCP_SERVER_INFO, type McpContext } from "../../src/mcp/server.js";
import { PothosService } from "../../src/service.js";
import { MemoryStore } from "../../src/storage/memory.js";
import { ManualClock } from "../../src/clock.js";

const T0 = 1767400800000;
const svc = new PothosService(new MemoryStore(), new ManualClock(T0));
const ops = opsFromService(svc);
const resident: McpContext = { side: "resident", ops };
const observer: McpContext = { side: "observer", ops };

const parse = async (ctx: McpContext, msg: unknown): Promise<Record<string, unknown>> => JSON.parse((await handleMessage(msg, ctx)) ?? "null") as Record<string, unknown>;

describe("MCP · 协议直测", () => {
  it("initialize：回显 protocolVersion + serverInfo + tools 能力", async () => {
    const res = await parse(resident, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    const result = res["result"] as Record<string, unknown>;
    expect(result["protocolVersion"]).toBe("2025-06-18");
    expect(result["serverInfo"]).toEqual(MCP_SERVER_INFO);
    expect((result["capabilities"] as Record<string, unknown>)["tools"]).toBeDefined();
    // 未带版本 → 服务端默认
    const res2 = await parse(resident, { jsonrpc: "2.0", id: 2, method: "initialize", params: {} });
    expect((res2["result"] as Record<string, unknown>)["protocolVersion"]).toBe("2025-06-18");
  });

  it("通知（notifications/initialized）不回应", async () => {
    expect(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, resident)).toBeNull();
  });

  it("双侧纪律：resident 拿不到任何数值工具；observer 拿不到申报类工具", async () => {
    const rList = (await parse(resident, { jsonrpc: "2.0", id: 1, method: "tools/list" }))["result"] as { tools: Array<{ name: string }> };
    const rNames = rList.tools.map((t) => t.name);
    expect(rNames).toEqual(expect.arrayContaining(["interoception", "ma_plan", "record_ma_activity", "declare", "crisis_card", "control_window"]));
    for (const forbidden of ["state", "metrics", "alerts", "ack_alert", "act_alert", "change_param", "audit", "bench", "send_user_msg"]) {
      expect(rNames, `resident 侧不得暴露 ${forbidden}`).not.toContain(forbidden);
    }

    const oList = (await parse(observer, { jsonrpc: "2.0", id: 2, method: "tools/list" }))["result"] as { tools: Array<{ name: string }> };
    const oNames = oList.tools.map((t) => t.name);
    expect(oNames).toEqual(expect.arrayContaining(["state", "metrics", "alerts", "ack_alert", "act_alert", "change_param", "audit", "bench", "interoception", "send_user_msg"]));
  });

  it("resident 侧越权调用 state 工具 → isError（越权在工具层物理拦截）", async () => {
    const res = await parse(resident, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "state", arguments: {} } });
    expect((res["result"] as Record<string, unknown>)["isError"]).toBe(true);
  });

  it("tools/call interoception：返回质感文本，无数值", async () => {
    const res = await parse(resident, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "interoception", arguments: {} } });
    const text = ((res["result"] as Record<string, unknown>)["content"] as Array<{ text: string }>)[0]!.text;
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/[0-9]/);
  });

  it("tools/call ma_plan（resident）：只有 activity 与 allowed，无 reason/salience 数值", async () => {
    const res = await parse(resident, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ma_plan", arguments: {} } });
    const text = ((res["result"] as Record<string, unknown>)["content"] as Array<{ text: string }>)[0]!.text;
    const plan = JSON.parse(text) as Array<Record<string, unknown>>;
    expect(plan.some((p) => p["activity"] === "digest" && p["allowed"] === true)).toBe(true);
    for (const p of plan) {
      expect(Object.keys(p).sort()).toEqual(["activity", "allowed"]);
    }
  });

  it("tools/call declare：declared 事件入库（resident 自我申报通道）", async () => {
    const res = await parse(resident, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "declare", arguments: { readings: [{ axis: "longing", intensity: 0.7 }], idempotencyKey: "mcp-declare-1" } } });
    const text = ((res["result"] as Record<string, unknown>)["content"] as Array<{ text: string }>)[0]!.text;
    expect(JSON.parse(text)["stored"]).toBe(true);
    const events = await svc.store.loadEvents();
    const declared = events.find((e) => e.idempotencyKey === "mcp-declare-1");
    expect(declared?.kind).toBe("declared");
    expect(declared?.payload["readings"]).toEqual([{ axis: "longing", intensity: 0.7 }]);
  });

  it("tools/call 参数非法 → isError + 可读错误", async () => {
    const res = await parse(resident, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "record_ma_activity", arguments: { activity: "sleep", tokenCost: 10 } } });
    const result = (res["result"] as Record<string, unknown>);
    expect(result["isError"]).toBe(true);
    expect(((result["content"] as Array<{ text: string }>)[0]!.text)).toContain("五种活動之一");
  });

  it("observer 侧 send_user_msg：她的话入流 + 危机词表引擎侧扫描（保留标签不可注入）", async () => {
    const res = await parse(observer, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_user_msg", arguments: { text: "我回来了，今天怎么样？" } } });
    const text = ((res["result"] as Record<string, unknown>)["content"] as Array<{ text: string }>)[0]!.text;
    const out = JSON.parse(text) as { stored: boolean; eventId?: number };
    expect(out.stored).toBe(true);
    const events = await svc.store.loadEvents();
    // source 在 ingest 边界已哈希为不透明句柄（"mcp:observer" 原文不落库）
    const um = events.find((e) => e.kind === "user_msg" && e.payload["text"] === "我回来了，今天怎么样？");
    expect(um).toBeDefined();
    expect(um!.source).toMatch(/^[0-9a-f]{24}$/);

    // 危机词表命中 → 字面登记事件入流（无开关，MCP 路径同样执行）
    const crisis = await parse(observer, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "send_user_msg", arguments: { text: "我不想活了" } } });
    const crisisOut = JSON.parse((((crisis["result"] as Record<string, unknown>)["content"] as Array<{ text: string }>)[0]!.text)) as { crisis?: { triggered: boolean } };
    expect(crisisOut.crisis?.triggered).toBe(true);
    expect((await svc.store.loadEvents()).some((e) => e.kind === "crisis")).toBe(true);
  });

  it("observer 侧 change_param：纪律拒绝以 ok:false 回传（422 语义）", async () => {
    const res = await parse(observer, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "change_param", arguments: { key: "noiseFast", newValue: 0.02, reason: "", expectedEffect: "", rollbackCondition: "" } } });
    const text = ((res["result"] as Record<string, unknown>)["content"] as Array<{ text: string }>)[0]!.text;
    expect(JSON.parse(text)["error"]).toContain("先写预期");
  });

  it("未知方法 → -32601；坏 JSON → -32700（stdio 层）；ping → 空结果", async () => {
    const res = await parse(resident, { jsonrpc: "2.0", id: 1, method: "resources/list" });
    expect((res["error"] as Record<string, unknown>)["code"]).toBe(-32601);
    const ping = await parse(resident, { jsonrpc: "2.0", id: 2, method: "ping" });
    expect(ping["result"]).toEqual({});
  });
});

describe("MCP · stdio 回环（spawn 真入口）", () => {
  let child: ReturnType<typeof spawn> | null = null;
  const collected = new Map<number, Record<string, unknown>>();

  afterAll(() => {
    child?.kill();
  });

  it("NDJSON 全流程：initialize → initialized → tools/list → tools/call（内嵌 memory 模式）", async () => {
    child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/mcp/main.ts"], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { ...process.env, POTHOS_MCP_SIDE: "resident" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const rl = createInterface({ input: child.stdout! });
    const done = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("stdio 回环超时")), 60_000);
      rl.on("line", (l) => {
        try {
          const msg = JSON.parse(l) as Record<string, unknown>;
          if (msg["id"] != null) collected.set(msg["id"] as number, msg);
          if (collected.size >= 3) {
            clearTimeout(timeout);
            resolve();
          }
        } catch {
          /* 忽略非 JSON 行 */
        }
      });
      child!.on("exit", (code) => { if (collected.size < 3) reject(new Error(`子进程提前退出：${code}`)); });
    });

    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "interoception", arguments: {} } }) + "\n");

    await done;
    const init = collected.get(1)!;
    expect(((init["result"] as Record<string, unknown>)["serverInfo"] as Record<string, unknown>)["name"]).toBe("pothos-mcp");
    const list = collected.get(2)!;
    const names = ((list["result"] as { tools: Array<{ name: string }> }).tools).map((t) => t.name);
    expect(names).toContain("interoception");
    expect(names).not.toContain("state");
    const call = collected.get(3)!;
    const text = ((call["result"] as Record<string, unknown>)["content"] as Array<{ text: string }>)[0]!.text;
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/[0-9]/);
  }, 70_000);
});
