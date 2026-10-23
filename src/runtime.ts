import type { PothosService } from "./service.js";
import { MailWorker, mailConfigFromEnv } from "./mail/letters.js";

/** Shared lifecycle for HTTP and embedded MCP. No overlapping timer executions. */
export function startRuntime(svc: PothosService, opts: {
  tickMs?: number;
  env?: Record<string, string | undefined>;
  onError?: (task: string, error: unknown) => void;
} = {}): { stop(): Promise<void> } {
  const env = opts.env ?? process.env;
  const tickMs = opts.tickMs ?? Number(env["POTHOS_TICK_MS"] ?? 300_000);
  if (!Number.isFinite(tickMs) || tickMs < 1) throw new Error("invalid POTHOS_TICK_MS");
  const onError = opts.onError ?? ((task, error) => console.error(`[POTHOS] ${task}`, error));
  const timers: ReturnType<typeof setInterval>[] = [];
  const pending = new Set<Promise<unknown>>();
  let stopped = false;
  const every = (name: string, ms: number, task: () => Promise<unknown>): void => {
    let busy = false;
    timers.push(setInterval(() => {
      if (stopped || busy) return;
      busy = true;
      const p = task().catch(e => onError(name, e)).finally(() => { busy = false; pending.delete(p); });
      pending.add(p);
    }, ms));
  };
  every("tick", tickMs, () => svc.runTick());
  every("bench", 86_400_000, () => svc.runBench({ persist: "on-fail" }));
  every("reconcile", 86_400_000, () => svc.reconcileNow());
  every("contingency", 86_400_000, () => svc.contingencyBypass());
  const cfg = mailConfigFromEnv(env);
  if (cfg) {
    const worker = new MailWorker({ store: svc.store, cfg, params: () => svc.params,
      ingest: async ev => { await svc.ingest(ev); }, clock: () => svc.clock.now() });
    every("mail", 60_000, () => worker.poll());
    every("mail replies", 300_000, () => worker.pollReplies());
  }
  let closing: Promise<void> | undefined;
  return { stop: () => closing ??= (async () => {
    stopped = true;
    for (const timer of timers) clearInterval(timer);
    await Promise.allSettled([...pending]);
    await svc.runTick();
    await svc.drain();
  })() };
}
