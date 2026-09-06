/**
 * 网关 CLI：npx tsx src/declared/gateway-run.ts [--model M] [--poll MS] [--batch N]
 *
 * 连续轮询引擎事件流，读新 resident_msg → 调 A2 分类器 → 产出 declared 事件。
 * 引擎须已运行（内嵌 memory 模式或 HTTP 模式连远程）。
 * 当前实现：内嵌 memory 模式（进程自持引擎）——适合单人部署的网关样例。
 */
import { PothosService } from "../service.js";
import { MemoryStore } from "../storage/memory.js";
import { ManualClock } from "../clock.js";
import { ArkCliTransport } from "./classifier.js";
import { DeclaredGateway } from "./gateway.js";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? def : def;
}

async function main(): Promise<void> {
  const model = arg("model", "doubao-seed-evolving");
  const pollMs = Number(arg("poll", "10000"));
  const batch = Number(arg("batch", "50"));

  // 内嵌 memory 模式：进程自持引擎（生产用 PG + HTTP 模式时改为 PothosClient）
  const svc = new PothosService(new MemoryStore(), new ManualClock(Date.now()));
  const transport = new ArkCliTransport({ model, timeoutMs: 180_000 });
  const gw = new DeclaredGateway(svc, transport);

  console.log(`A2 网关启动：模型=${model} promptV=${gw.fingerprint.promptV} 轮询=${pollMs}ms 批量=${batch}`);
  console.log("（内嵌 memory 模式——生产部署用 PG 存储 + HTTP 模式连远程引擎）");

  // 连续轮询
  for (;;) {
    const r = await gw.pollOnce(batch);
    if (r.processed > 0) {
      console.log(`[${new Date().toISOString()}] 处理=${r.processed} declared=${r.declared} 跳过=${r.skipped} 失败=${r.failed}`);
      for (const e of r.errors) console.log(`  错误: event#${e.eventId}: ${e.error.slice(0, 120)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
