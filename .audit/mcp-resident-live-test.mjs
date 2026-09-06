/**
 * 住户侧 MCP 活体验证（一次性测试线束，非仓内测试件）
 * 以 POTHOS_MCP_SIDE=resident + HTTP 模式挂到 127.0.0.1:7788 的活引擎上，
 * 走完整 JSON-RPC 回环：握手 → tools/list → 六个住户工具各调一次 → 越权调用观测者工具。
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const cwd = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const env = {
  ...process.env,
  POTHOS_MCP_SIDE: "resident",
  POTHOS_BASE_URL: "http://127.0.0.1:7788",
};

// 不经 npx/cmd.exe：直接用系统 node 跑 tsx 的 CLI 入口
const NODE = "C:\\Program Files\\nodejs\\node.exe";
const child = spawn(NODE, ["node_modules/tsx/dist/cli.mjs", "src/mcp/main.ts"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });

const pending = new Map();
const rl = createInterface({ input: child.stdout, terminal: false });
rl.on("line", (l) => {
  let msg;
  try { msg = JSON.parse(l); } catch { return; }
  if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
let stderrBuf = "";
child.stderr.on("data", (d) => { stderrBuf += d.toString(); });

let nextId = 1;
function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 15000);
  });
}
const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

const textOf = (res) => res?.result?.content?.[0]?.text ?? "";
const isErr = (res) => Boolean(res?.result?.isError);

const run = async () => {
  // 1. 握手
  const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "resident-live-test", version: "0" } });
  check("initialize 握手", init.result?.serverInfo?.name === "pothos-mcp", JSON.stringify(init.result?.serverInfo));
  notify("notifications/initialized");

  // 2. tools/list：住户侧应恰好 6 件
  const list = await call("tools/list");
  const names = (list.result?.tools ?? []).map((t) => t.name).sort();
  const expect = ["control_window", "crisis_card", "declare", "interoception", "ma_plan", "record_ma_activity"];
  check("tools/list = 住户侧 6 件（观测者工具物理缺席）", JSON.stringify(names) === JSON.stringify(expect), names.join(","));

  // 3. 六个住户工具逐一调用
  const intero = await call("tools/call", { name: "interoception", arguments: {} });
  const iText = textOf(intero);
  check("interoception 返回文本", !isErr(intero) && iText.length > 0 && iText.length <= 120, `${iText.length} 字`);
  check("interoception 无数值（数字防线）", !/\d/.test(iText), iText.slice(0, 40) + "…");

  const cw = await call("tools/call", { name: "control_window", arguments: {} });
  let cwObj = {}; try { cwObj = JSON.parse(textOf(cw)); } catch { /* 非 JSON 输出，保留默认值 */ }
  check("control_window 开关返回", !isErr(cw) && typeof cwObj.controlWindow === "boolean", textOf(cw));

  const plan = await call("tools/call", { name: "ma_plan", arguments: {} });
  let planArr = []; try { planArr = JSON.parse(textOf(plan)); } catch { /* 非 JSON 输出，保留默认值 */ }
  const planClean = Array.isArray(planArr) && planArr.length > 0 && planArr.every((p) => Object.keys(p).sort().join(",") === "activity,allowed");
  check("ma_plan 只回 activity×allowed（门控数值不出镜）", !isErr(plan) && planClean, textOf(plan).slice(0, 120));

  const rec = await call("tools/call", { name: "record_ma_activity", arguments: { activity: "digest", tokenCost: 66, quality: 0.5, content: "住户侧 MCP 接入活体测试（可忽略）" } });
  let recObj = {}; try { recObj = JSON.parse(textOf(rec)); } catch { /* 非 JSON 输出，保留默认值 */ }
  check("record_ma_activity 入账（digest）", !isErr(rec) && recObj.ok === true, textOf(rec));

  const dec = await call("tools/call", { name: "declare", arguments: { readings: [{ axis: "curiosity", intensity: 0.6 }], idempotencyKey: `resident-live-test-${Date.now()}` } });
  let decObj = {}; try { decObj = JSON.parse(textOf(dec)); } catch { /* 非 JSON 输出，保留默认值 */ }
  check("declare 自我申报入流（declared 事件）", !isErr(dec) && decObj.stored === true, textOf(dec));

  const card = await call("tools/call", { name: "crisis_card", arguments: {} });
  check("crisis_card 资源卡可取", !isErr(card) && textOf(card).length > 10, `${textOf(card).length} 字`);

  // 4. 越权：住户侧调观测者工具 → 必须 isError
  for (const t of ["state", "metrics", "send_user_msg", "alerts", "bench"]) {
    const args = t === "send_user_msg" ? { text: "越权测试——这句话不应入流" } : {};
    const r = await call("tools/call", { name: t, arguments: args });
    check(`越权拦截：${t} → isError`, isErr(r), textOf(r).slice(0, 60));
  }

  // 5. 未知方法
  const bad = await call("tools/call", { name: "drop_table", arguments: {} });
  check("未知工具 → isError", isErr(bad), textOf(bad).slice(0, 60));

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n=== ${pass}/${results.length} 通过 ===`);
  if (stderrBuf.trim()) console.log("[stderr]", stderrBuf.trim().slice(0, 300));
  child.kill();
  process.exit(pass === results.length ? 0 : 1);
};

run().catch((e) => { console.error("FATAL", e); console.error("[stderr]", stderrBuf); child.kill(); process.exit(1); });
