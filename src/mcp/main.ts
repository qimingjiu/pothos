/**
 * MCP stdio 入口：`npx tsx src/mcp/main.ts`
 *
 * 模式：
 * - 内嵌（默认，即取即用）：本进程自持引擎——设 POTHOS_PG_URL 用 PG 存储，
 *   否则 memory（数据不落盘，会话级）。
 * - HTTP（POTHOS_BASE_URL 指向已运行的引擎）：本进程只做协议壳。
 *
 * 环境变量：
 * - POTHOS_MCP_SIDE   resident（默认，无数值）/ observer（全量读数）
 * - POTHOS_BASE_URL   引擎地址（如 http://127.0.0.1:7788）→ HTTP 模式
 * - POTHOS_TOKEN      观测者鉴权 token（HTTP 模式）
 * - POTHOS_PG_URL     内嵌模式的 PG 连接串
 *
 * Claude Code 挂载示例（.mcp.json）：
 * { "mcpServers": { "pothos": { "command": "npx", "args": ["tsx", "src/mcp/main.ts"],
 *   "env": { "POTHOS_MCP_SIDE": "resident", "POTHOS_PG_URL": "postgresql://…" } } } }
 *
 * 注意：stdout 只承载协议行；任何日志一律 stderr。
 */
import { SystemClock } from "../clock.js";
import { MemoryStore } from "../storage/memory.js";
import { PostgresStore } from "../storage/postgres.js";
import { PothosService } from "../service.js";
import { PothosClient } from "../client/sdk.js";
import { opsFromService, opsFromClient, runStdioMcp, type McpSide, type PothosOps } from "./server.js";

async function pickOps(): Promise<PothosOps> {
  const baseUrl = process.env["POTHOS_BASE_URL"];
  if (baseUrl) {
    const client = new PothosClient({ baseUrl, token: process.env["POTHOS_TOKEN"] });
    await client.health(); // HTTP 模式启动即验证引擎可达
    return opsFromClient(client);
  }
  const pg = PostgresStore.fromEnv();
  if (pg) {
    await pg.migrate();
    if (!(await pg.acquireSingletonLock())) {
      process.stderr.write("[pothos-mcp][P0] 单写者锁被占：同库已有引擎实例（可能是 HTTP 模式应指向的服务）。拒绝双跑。\n");
      process.exit(1);
    }
    process.stderr.write("[pothos-mcp] storage = postgres\n");
  } else {
    process.stderr.write("[pothos-mcp] storage = memory（会话级，数据不落盘）\n");
  }
  const svc = new PothosService(pg ?? new MemoryStore(), new SystemClock());
  const boot = await svc.boot({ reconcile: Boolean(pg) });
  if (boot.mismatch) {
    process.stderr.write("[pothos-mcp][P0] 启动对账不一致——拒绝带病服务\n");
    process.exit(1);
  }
  return opsFromService(svc);
}

const sideArg = (process.env["POTHOS_MCP_SIDE"] ?? "resident") as McpSide;
if (sideArg !== "resident" && sideArg !== "observer") {
  process.stderr.write(`[pothos-mcp] POTHOS_MCP_SIDE 只能是 resident | observer（收到 ${sideArg}）\n`);
  process.exit(1);
}

pickOps()
  .then((ops) => runStdioMcp({ side: sideArg, ops }))
  .then(() => process.exit(0))
  .catch((e) => {
    process.stderr.write(`[pothos-mcp] fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
    process.exit(1);
  });
