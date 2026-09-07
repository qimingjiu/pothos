/**
 * 入口：Pothos 服务进程。
 *
 * 环境变量：
 * - POTHOS_PORT          监听端口（默认 7788）
 * - POTHOS_TOKEN         观测者鉴权 token（未设置 = 本地开发模式）
 * - POTHOS_PG_URL        PostgreSQL 连接串（未设置 = 内存存储·开发模式，数据不落盘）
 * - POTHOS_TICK_MS       tick 节律覆盖（默认 5 min）
 * - POTHOS_RECONCILE     启动时强制全量对账（=1）
 * - B_daily / M_min      部署前必须以 param_changes 实测填写（定名权纪律）
 */
import { serve } from "@hono/node-server";
import { SystemClock } from "../clock.js";
import { MemoryStore } from "../storage/memory.js";
import { PostgresStore } from "../storage/postgres.js";
import { PothosService } from "../service.js";
import { createApp } from "./app.js";
import { MailWorker, mailConfigFromEnv } from "../mail/letters.js";

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
  const boot = await svc.boot({ reconcile: process.env["POTHOS_RECONCILE"] === "1" });
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

  // tick 节律（cron）
  const tickMs = Number(process.env["POTHOS_TICK_MS"] ?? 5 * 60_000);
  setInterval(() => {
    svc.runTick().catch((e) => console.error("[POTHOS] tick error", e));
  }, tickMs);

  // 营养与躯体化告警本就由 tick 驱动；工作区日检（名字就叫日检）每日跑一次，
  // 且只在出带时落库——正常日不写 bench_runs，台账不因巡检无界增长
  setInterval(() => {
    svc.runBench({ persist: "on-fail" }).catch((e) => console.error("[POTHOS] bench error", e));
  }, 86_400_000);

  // 每日全量对账（M0 契约的慢速哨兵；启动时的对账由 POTHOS_RECONCILE=1 触发）
  setInterval(() => {
    svc.reconcileNow().catch((e) => console.error("[POTHOS] reconcile error", e));
  }, 86_400_000);

  // A1 contingency 旁路（R3-11 接线）：每日一次配对收集 + C_t/C_s 分报 +
  // null 阶梯 + 关窗回顾，仪器事件入 bench_runs（测量层，不动 fold）
  setInterval(() => {
    svc.contingencyBypass().catch((e) => console.error("[POTHOS] contingency bypass error", e));
  }, 86_400_000);

  // 信件投递 worker（Huginn 投递面，mail-信件通道-v0）：部署凭据齐备才启用——
  // 未配置 = 信件通道诚实缺席，不是假装在投。poll = quiet_hours 管寄 + 退避重试；
  // pollReplies = IMAP 回信闭环（In-Reply-To → Message-ID → user_msg 入流）。
  const mailCfg = mailConfigFromEnv();
  if (mailCfg) {
    const worker = new MailWorker({
      store,
      cfg: mailCfg,
      params: () => svc.params,
      ingest: async (ev) => {
        await svc.ingest(ev);
      },
      clock: () => Date.now(),
    });
    setInterval(() => worker.poll().catch((e) => console.error("[POTHOS] mail poll error", e)), 60_000);
    setInterval(() => worker.pollReplies().catch((e) => console.error("[POTHOS] mail replies error", e)), 5 * 60_000);
    console.log("[POTHOS] 信件投递 worker 已启用（quiet_hours 管寄不管写）");
  }

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return; // 双信号（如 systemd 先 TERM 后 KILL 前的第二次 SIGINT）不重入
    shuttingDown = true;
    try {
      await svc.runTick();
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
