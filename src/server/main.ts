/**
 * 入口：Pothos 服务进程。
 *
 * 环境变量：
 * - POTHOS_PORT          监听端口（默认 7788）
 * - POTHOS_TOKEN         观测者鉴权 token（未设置 = 本地开发模式）
 * - POTHOS_PG_URL        PostgreSQL 连接串（未设置 = 内存存储·开发模式，数据不落盘）
 * - POTHOS_TICK_MS       tick 节律覆盖（默认 5 min）
 * - POTHOS_RECONCILE     内存模式启动也全量对账（=1）；PostgreSQL 总是对账
 * - B_daily / M_min      部署前必须以 param_changes 实测填写（定名权纪律）
 */
import { serve } from "@hono/node-server";
import { SystemClock } from "../clock.js";
import { MemoryStore } from "../storage/memory.js";
import { PostgresStore } from "../storage/postgres.js";
import { PothosService } from "../service.js";
import { createApp } from "./app.js";
import { startRuntime } from "../runtime.js";

async function pickStore() {
  const pg = PostgresStore.fromEnv();
  if (pg) {
    await pg.migrate();
    console.log("[POTHOS] storage = postgres");
    return pg;
  }
  console.log("[POTHOS] storage = memory（开发模式：数据不落盘。生产部署必须设置 POTHOS_PG_URL）");
  return new MemoryStore();
}

async function main(): Promise<void> {
  const store = await pickStore();
  // 单写者锁（B1）：同库双实例 = 双折叠双告警。拿不到就拒绝启动，不许带病双跑。
  if (!(await store.acquireSingletonLock())) {
    console.error("[POTHOS][P0] 单写者锁被占：已有引擎实例在同一存储上运行。拒绝启动（fail-loud）。");
    await store.close().catch(() => {});
    process.exit(1);
  }
  const mailTo = process.env["POTHOS_MAIL_TO"];
  const svc = new PothosService(
    store,
    new SystemClock(),
    mailTo ? { toAddr: mailTo } : undefined,
  );
  const boot = await svc.boot({ reconcile: store.kind === "postgres" || process.env["POTHOS_RECONCILE"] === "1" });
  if (boot.mismatch) {
    console.error("[POTHOS][P0] 对账不一致——快照或折叠实现有 bug，禁止带病上线");
    process.exit(1);
  }

  const app = createApp(svc);
  const port = Number(process.env["POTHOS_PORT"] ?? 7788);
  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[POTHOS] 玻璃房已开：http://localhost:${info.port}  （观测者协议：拉式透明，推式模糊）`);
  });
  // 监听失败（端口被占用等）给出一行明确的 P0，而不是裸的 unhandled error 栈
  server.on("error", (e: Error) => {
    console.error("[POTHOS][P0] HTTP 监听失败：", e.message, `（端口 ${port} 被占用？换 POTHOS_PORT 或释放端口后重试）`);
    process.exit(1);
  });

  const runtime = startRuntime(svc);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return; // 双信号（如 systemd 先 TERM 后 KILL 前的第二次 SIGINT）不重入
    shuttingDown = true;
    server.close();
    try {
      await runtime.stop();
    } catch (e) {
      console.error("[POTHOS] shutdown tick error", e);
    }
    try {
      await store.close();
    } catch (e) {
      console.error("[POTHOS] store close error", e);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((e) => {
  console.error("[POTHOS] fatal", e);
  process.exit(1);
});
