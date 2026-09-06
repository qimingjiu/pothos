/**
 * A2 网关桥（declared 通道接线）：监听 resident_msg → 调分类器 → 产出 declared 事件。
 *
 * 架构裁决：网关是独立可选组件，不进引擎核心动力学——分类器是客户端/网关侧
 * 组件（设计草案铁律：引擎不内嵌模型调用）。引擎只消费 declared 事件输出。
 *
 * 工作模式：poll（拉取新 resident_msg → 逐条调 DeclaredClassifier.declare →
 * 产出 declared 事件 → service.ingest 入库）。幂等键 = `a2-${textHash前12}-${promptV}`，
 * 同一段表达同一 prompt 版本不重复入库。
 *
 * 单人部署可在 MCP 内嵌模式下由 agent 壳启动；HTTP 模式作为独立进程轮询。
 * 无论哪种模式，引擎核心不碰模型调用——网关挂了引擎照常运转。
 */
import type { PothosService } from "../service.js";
import { DeclaredClassifier, sha256Text, toDeclaredEventPayload, type ModelTransport } from "./classifier.js";
import { parseDeclaredPayload } from "./contract.js";

export interface GatewayOpts {
  /** 轮询间隔 ms（poll 模式）；默认 0 = 不自动轮询，手动调 pollOnce */
  pollIntervalMs?: number;
  /** 已处理的 resident_msg 事件 id 上限（下次从这里继续） */
  lastProcessedId?: number;
}

export interface GatewayResult {
  processed: number;
  declared: number;
  skipped: number;
  failed: number;
  errors: Array<{ eventId: number; error: string }>;
}

export class DeclaredGateway {
  private readonly clf: DeclaredClassifier;
  private readonly svc: PothosService;
  private lastId: number;
  private readonly idempotencyPrefix: string;

  constructor(svc: PothosService, transport: ModelTransport, opts: GatewayOpts = {}) {
    this.svc = svc;
    this.clf = new DeclaredClassifier(transport, { promptV: opts.pollIntervalMs != null ? undefined : undefined });
    this.lastId = opts.lastProcessedId ?? 0;
    this.idempotencyPrefix = `a2-${this.clf.fingerprint.name}`;
  }

  /** 指纹（与 declared 事件的 model 指纹同源）。 */
  get fingerprint(): { name: string; promptV: string } {
    return this.clf.fingerprint;
  }

  /**
   * 拉取一批新 resident_msg → 逐条调分类器 → 产出 declared 事件。
   * 幂等：同一段表达（textHash）同一 prompt 版本不重复入库。
   */
  async pollOnce(batchSize = 50): Promise<GatewayResult> {
    const events = await this.svc.store.loadEvents(this.lastId);
    const residentMsgs = events
      .filter((e) => e.kind === "resident_msg")
      .slice(0, batchSize);

    let processed = 0, declared = 0, skipped = 0, failed = 0;
    const errors: Array<{ eventId: number; error: string }> = [];

    for (const ev of residentMsgs) {
      processed++;
      this.lastId = Math.max(this.lastId, ev.id);

      const text = typeof ev.payload["text"] === "string" ? (ev.payload["text"] as string) : "";
      if (!text) { skipped++; continue; }

      const textHash = sha256Text(text);
      const idemKey = `${this.idempotencyPrefix}-${textHash.slice(7, 19)}-${this.clf.fingerprint.promptV}`;

      try {
        const res = await this.clf.declare(text);
        if (!res.ok) {
          failed++;
          errors.push({ eventId: ev.id, error: `契约校验失败：${res.problems.join("; ")}` });
          continue;
        }
        const payload = toDeclaredEventPayload(res);
        // 网关产出的 declared 事件带 textHash（关联回 resident_msg 原文）
        await this.svc.ingest({
          kind: "declared",
          ts: this.svc.clock.now(),
          payload: { ...payload, textHash },
          idempotencyKey: idemKey,
        });
        declared++;
      } catch (e) {
        failed++;
        errors.push({ eventId: ev.id, error: String(e instanceof Error ? e.message : e) });
      }
    }

    return { processed, declared, skipped, failed, errors };
  }

  /**
   * 连续轮询直到追上事件流尾部。
   * 返回累计统计。每轮之间按 pollIntervalMs 间隔（0 = 不等待，一口气跑完）。
   */
  async catchUp(pollIntervalMs = 0): Promise<GatewayResult> {
    let acc: GatewayResult = { processed: 0, declared: 0, skipped: 0, failed: 0, errors: [] };
    for (;;) {
      const r = await this.pollOnce();
      acc = {
        processed: acc.processed + r.processed,
        declared: acc.declared + r.declared,
        skipped: acc.skipped + r.skipped,
        failed: acc.failed + r.failed,
        errors: [...acc.errors, ...r.errors],
      };
      if (r.processed === 0) break; // 追上尾部
      if (pollIntervalMs > 0) await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    return acc;
  }
}
