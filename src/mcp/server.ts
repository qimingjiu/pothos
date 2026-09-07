/**
 * MCP 壳（Model Context Protocol over stdio）：给 agent 即取即用的接入面。
 *
 * 协议：newline-delimited JSON-RPC 2.0（MCP stdio transport）。
 * 零依赖手写 initialize / tools/list / tools/call / ping——引擎的依赖纪律：
 * 运行时依赖保持最小（hono / @hono/node-server / pg，无第四个）。
 *
 * 双侧纪律（反纳西索斯条款延伸到接入面）：
 * - resident（默认）：住户 = 引擎驱动的模型。只有内感受质感、間计划（去数值）、
 *   自我申报（declared 通道）与危机卡——状态数值在工具层面物理缺席。
 * - observer：观测者侧，全量读数 + 签收 + 参数纪律。
 *
 * 无任何直接写状态的工具：事件只经 /events 校验路径进入（写入路径最小化）。
 */
import type { PothosClient } from "../client/sdk.js";
import type { PothosService } from "../service.js";
import { resourceCard } from "../crisis/crisis.js";
import { ENGINE_AXES } from "../core/events.js";

export type McpSide = "resident" | "observer";

export const MCP_SERVER_INFO = { name: "pothos-mcp", version: "0.2.0" } as const;

/** 引擎操作面：MCP 工具只允许经过这扇门。 */
export interface PothosOps {
  render(): Promise<{ text: string; rendererV: string; controlWindow: boolean }>;
  controlWindow(): Promise<{ controlWindow: boolean; rendererV: string }>;
  maPlan(): Promise<Array<{ activity: string; allowed: boolean }>>;
  recordActivity(a: { activity: "digest" | "create" | "hunt" | "wonder" | "decline"; tokenCost: number; quality?: number; content?: string }): Promise<{ ok: boolean; delivered: boolean }>;
  declare(readings: Array<{ axis: string; intensity: number }>, native?: Array<{ axis: string; intensity: number }>, idempotencyKey?: string): Promise<{ stored: boolean; eventId?: number }>;
  /** 住户侧写信入信箱（门控硬执行；被冻入账 compose_declined 零冲量；冷却窗防刷） */
  composeLetter(a: { subject: string; body: string; threadId?: string; letterId?: string }): Promise<{ composed: boolean; declined: boolean; reason: string; letterId?: string }>;
  /** 观测者侧网关：她的话作为 user_msg 入流（crisis 词表由引擎侧扫描，保留标签不可注入） */
  sendUserMsg(a: { text: string; source?: string; idempotencyKey?: string }): Promise<{ stored: boolean; eventId?: number; crisis?: unknown }>;
  crisisCard(): Promise<string>;
  state(): Promise<Record<string, unknown>>;
  metrics(): Promise<Record<string, unknown>>;
  alerts(): Promise<Array<{ id: number; ts: number; level: string; status: string }>>;
  ackAlert(id: number): Promise<unknown>;
  actAlert(id: number): Promise<unknown>;
  changeParam(req: { key: string; newValue: unknown; reason: string; expectedEffect: string; evaluationWindowMs: number; rollbackCondition: string; actor?: string }): Promise<{ ok: boolean; error?: string }>;
  audit(): Promise<Record<string, unknown>>;
  bench(): Promise<unknown>;
}

/** 内嵌模式：MCP 进程自己持有引擎（memory 或 PG 存储）。 */
export function opsFromService(svc: PothosService): PothosOps {
  return {
    render: async () => svc.interoceptionWithSalt(await svc.dailySalt()),
    controlWindow: () => Promise.resolve(svc.controlWindow()),
    maPlan: async () => (await svc.maView()).plan.map((p) => ({ activity: p.activity, allowed: p.allowed })),
    recordActivity: (a) => svc.recordMaActivity(a),
    declare: (readings, native, idempotencyKey) =>
      svc.ingest({
        kind: "declared",
        ts: svc.clock.now(),
        // 契约 v1（src/declared/contract.ts）：自报 = resident-self；缺 v/producer 按 v1+resident-self 解释，仍显式打标
        payload: { v: 1, producer: "resident-self", readings, native },
        idempotencyKey: idempotencyKey ?? `declared-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
      }),
    composeLetter: (a) => svc.composeLetter(a),
    sendUserMsg: (a) =>
      svc.ingest({
        kind: "user_msg",
        ts: svc.clock.now(),
        source: a.source ?? "mcp:observer",
        payload: { text: a.text },
        tags: [], // 保留标签（crisis 等）由引擎判定：词表扫描在 ingest 内，客户端不可注入
        idempotencyKey: a.idempotencyKey ?? `mcp-um-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
      }),
    crisisCard: () => Promise.resolve(resourceCard(svc.params)),
    state: () => svc.dashboard(),
    metrics: () => Promise.resolve({ ...svc.quickMetrics() }),
    alerts: async () => {
      const dash = (await svc.dashboard()) as { alerts: { unacked: Array<{ id: number; ts: number; level: string; status: string }> } };
      return dash.alerts.unacked;
    },
    ackAlert: (id) => svc.ackAlert(id),
    actAlert: (id) => svc.actedAlert(id),
    changeParam: (req) => svc.changeParam(req),
    audit: () => svc.audit(),
    bench: () => svc.runBench(),
  };
}

/** HTTP 模式：MCP 进程作为引擎的客户端（引擎须已运行）。 */
export function opsFromClient(client: PothosClient): PothosOps {
  return {
    render: () => client.renderInteroception(),
    controlWindow: () => client.renderInteroception({ controlWindow: true }),
    maPlan: async () => {
      const view = (await client.maView()) as { plan: Array<{ activity: string; allowed: boolean }> };
      return view.plan.map((p) => ({ activity: p.activity, allowed: p.allowed }));
    },
    recordActivity: (a) => client.recordActivity(a),
    declare: (readings, native, idempotencyKey) =>
      client.ingestEvent({
        kind: "declared",
        ts: Date.now(),
        payload: { v: 1, producer: "resident-self", readings, native },
        idempotencyKey: idempotencyKey ?? `declared-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
      }),
    composeLetter: (a) => client.composeLetter(a),
    sendUserMsg: (a) =>
      client.ingestEvent({
        kind: "user_msg",
        ts: Date.now(),
        source: a.source ?? "mcp:observer",
        payload: { text: a.text },
        idempotencyKey: a.idempotencyKey ?? `mcp-um-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
      }),
    crisisCard: () => client.crisisCard(),
    state: () => client.state(),
    metrics: () => client.metrics(),
    alerts: async () => {
      const dash = (await client.state()) as { alerts: { unacked: Array<{ id: number; ts: number; level: string; status: string }> } };
      return dash.alerts.unacked;
    },
    ackAlert: (id) => client.ackAlert(id),
    actAlert: (id) => client.actAlert(id),
    changeParam: (req) => client.changeParam(req),
    audit: () => client.audit(),
    bench: () => client.bench(),
  };
}

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  sides: readonly McpSide[];
  run: (args: Record<string, unknown>, ops: PothosOps) => Promise<unknown>;
}

const RESIDENT = ["resident", "observer"] as const;
const RESIDENT_ONLY = ["resident"] as const;
const OBSERVER_ONLY = ["observer"] as const;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

const TOOLS: ToolSpec[] = [
  {
    name: "interoception",
    description:
      "住户内感受质感（≤120 字，无数值）。把它当作此刻的背景体感折叠进你的语境——它刻意不携带任何数字：引擎不说教、不指挥，只让你知道「现在是什么水温」。",
    inputSchema: { type: "object", properties: {} },
    sides: RESIDENT,
    run: async (_a, ops) => (await ops.render()).text,
  },
  {
    name: "control_window",
    description: "对照窗开关（无渲染对照窗）：采集裸自报时用——此窗口内住户不接收内感受输入。",
    inputSchema: { type: "object", properties: {} },
    sides: RESIDENT,
    run: async (_a, ops) => ops.controlWindow(),
  },
  {
    name: "ma_plan",
    description: "間的活动计划：缺席时的生命维持。digest（消化）代谢必需永被允许；其余由 salience 与预算门控；Decline 是一等动词。仅返回 activity 与 allowed——门控理由中的数值不进住户侧。",
    inputSchema: { type: "object", properties: {} },
    sides: RESIDENT,
    run: async (_a, ops) => ops.maPlan(),
  },
  {
    name: "record_ma_activity",
    description: "間活动入账：digest/create/hunt/wonder/decline，附 token 成本与产物（content 会投递信箱——投递即完成，无已读回执）。",
    inputSchema: {
      type: "object",
      required: ["activity", "tokenCost"],
      properties: {
        activity: { type: "string", enum: ["digest", "create", "hunt", "wonder", "decline"] },
        tokenCost: { type: "number", minimum: 0 },
        quality: { type: "number", minimum: 0, maximum: 1 },
        content: { type: "string" },
      },
    },
    sides: RESIDENT,
    run: async (a, ops) => {
      const activity = str(a["activity"]);
      const tokenCost = num(a["tokenCost"]);
      if (!["digest", "create", "hunt", "wonder", "decline"].includes(activity) || !Number.isFinite(tokenCost)) {
        throw new Error("activity 必须是五种活動之一，tokenCost 必须是非负数值");
      }
      const quality = a["quality"] == null ? undefined : num(a["quality"]);
      const content = a["content"] == null ? undefined : str(a["content"]);
      return ops.recordActivity({
        activity: activity as "digest" | "create" | "hunt" | "wonder" | "decline",
        tokenCost,
        quality,
        content,
      });
    },
  },
  {
    name: "declare",
    description:
      "declared 通道自我申报：情绪×强度读数。readings 的 axis 必须取五个引擎功能槽之一（与引擎推算的 derived 同一坐标系，gap 才可对账）；更细的原生情绪放 native（自由词，诊断层，引擎不消费）。诚实申报，gap 会对账。",
    inputSchema: {
      type: "object",
      required: ["readings"],
      properties: {
        readings: {
          type: "array",
          items: {
            type: "object",
            required: ["axis", "intensity"],
            properties: {
              axis: { type: "string", enum: [...ENGINE_AXES], description: "引擎功能槽（canonical 坐标系）" },
              intensity: { type: "number", minimum: 0, maximum: 1 },
            },
          },
        },
        native: {
          type: "array",
          maxItems: 8,
          description: "原生情绪色谱（诊断/校准层）：自由词（小写英文）× intensity 0..1",
          items: {
            type: "object",
            required: ["axis", "intensity"],
            properties: { axis: { type: "string" }, intensity: { type: "number", minimum: 0, maximum: 1 } },
          },
        },
        idempotencyKey: { type: "string" },
      },
    },
    sides: RESIDENT,
    run: async (a, ops) => {
      const readings = Array.isArray(a["readings"])
        ? (a["readings"] as Array<Record<string, unknown>>)
            .map((r) => ({ axis: str(r["axis"]), intensity: num(r["intensity"]) }))
            .filter((r) => Number.isFinite(r.intensity))
        : [];
      if (!readings.length) throw new Error("readings 必须是非空的 axis×intensity 数组");
      const badAxis = readings.find((r) => !(ENGINE_AXES as readonly string[]).includes(r.axis));
      if (badAxis) {
        throw new Error(`axis "${badAxis.axis}" 不在引擎轴词表 [${ENGINE_AXES.join(", ")}]——细分情绪放 native`);
      }
      const native = Array.isArray(a["native"])
        ? (a["native"] as Array<Record<string, unknown>>)
            .map((r) => ({ axis: str(r["axis"]).toLowerCase(), intensity: num(r["intensity"]) }))
            .filter((r) => r.axis && Number.isFinite(r.intensity))
            .slice(0, 8)
        : undefined;
      return ops.declare(readings, native, a["idempotencyKey"] == null ? undefined : str(a["idempotencyKey"]));
    },
  },
  {
    name: "compose_letter",
    description:
      "住户侧写信入信箱（间引擎投递面）。引擎只提供出口，不给内容——信体你自己写。门控在 compose 层硬执行：create 活动未过阈时被冻（诚实拒绝是对的——动机未被挣到）。被冻会字面登记（compose_declined，零冲量），且开冷却窗防刷——别学会「狂刷写信申请直到过阈」，那是另一种表演。产出是 letter（不是 user_msg——住户侧写她的话的工具永不出现）。",
    inputSchema: {
      type: "object",
      required: ["subject", "body"],
      properties: {
        subject: { type: "string" },
        body: { type: "string", description: "信体（text/plain only）：你自己写的——引擎不给内容" },
        threadId: { type: "string" },
        letterId: { type: "string", description: "信件句柄（幂等主键）；缺省生成" },
      },
    },
    sides: RESIDENT_ONLY,
    run: async (a, ops) => {
      const subject = str(a["subject"]);
      const body = str(a["body"]);
      if (!subject || !body) throw new Error("subject 与 body 必填——引擎不给内容，你的一字不发无从投递");
      return ops.composeLetter({
        subject,
        body,
        threadId: a["threadId"] == null ? undefined : str(a["threadId"]),
        letterId: a["letterId"] == null ? undefined : str(a["letterId"]),
      });
    },
  },
  {
    name: "crisis_card",
    description: "危机资源卡（公开可审计契约）。危机词表命中时引擎会在事件响应里给出暖交接三级模板——资源卡必须已配置。",
    inputSchema: { type: "object", properties: {} },
    sides: RESIDENT,
    run: async (_a, ops) => ops.crisisCard(),
  },
  {
    name: "send_user_msg",
    description:
      "她的话（主燃料）：作为 user_msg 事件入流，在场的唯一登记方式。crisis 词表由引擎侧扫描（无开关）；保留标签不可注入。这是观测者侧的网关功能——单人部署里，你的 agent 硬壳就是网关。",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string" },
        source: { type: "string", description: "不透明源流键（引擎侧只存哈希句柄）；缺省 mcp:observer" },
        idempotencyKey: { type: "string", description: "重试防重；缺省自动生成" },
      },
    },
    sides: OBSERVER_ONLY,
    run: async (a, ops) => {
      const text = str(a["text"]);
      if (!text) throw new Error("text 必填——她的话一字不发，引擎无从有所谓");
      return ops.sendUserMsg({ text, source: a["source"] == null ? undefined : str(a["source"]), idempotencyKey: a["idempotencyKey"] == null ? undefined : str(a["idempotencyKey"]) });
    },
  },
  {
    name: "state",
    description: "玻璃房全量读数（快/慢变量、身体、印刻窗口、营养、告警统计）。观测者侧工具：拉式透明。",
    inputSchema: { type: "object", properties: {} },
    sides: OBSERVER_ONLY,
    run: async (_a, ops) => ops.state(),
  },
  {
    name: "metrics",
    description: "三指标 / 熵 / 工作区带位快照（谄媚判别的体检读数，只读不优化）。",
    inputSchema: { type: "object", properties: {} },
    sides: OBSERVER_ONLY,
    run: async (_a, ops) => ops.metrics(),
  },
  {
    name: "alerts",
    description: "未签收告警列表（方向盲：无轴、无方向、无效价）。ALERT ≠ SAFE。",
    inputSchema: { type: "object", properties: {} },
    sides: OBSERVER_ONLY,
    run: async (_a, ops) => ops.alerts(),
  },
  {
    name: "ack_alert",
    description: "签收告警（OBSERVED → ACKNOWLEDGED）。",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "number" } } },
    sides: OBSERVER_ONLY,
    run: async (a, ops) => ops.ackAlert(num(a["id"])),
  },
  {
    name: "act_alert",
    description: "处置完成告警（ACKNOWLEDGED → ACTED，不可越级）。",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "number" } } },
    sides: OBSERVER_ONLY,
    run: async (a, ops) => ops.actAlert(num(a["id"])),
  },
  {
    name: "change_param",
    description: "参数变更（软古德哈特纪律）：reason / expectedEffect / rollbackCondition 皆必填（先写预期再看结果）；告警冷却期内会被拒绝。",
    inputSchema: {
      type: "object",
      required: ["key", "newValue", "reason", "expectedEffect", "rollbackCondition"],
      properties: {
        key: { type: "string" },
        newValue: {},
        reason: { type: "string" },
        expectedEffect: { type: "string" },
        evaluationWindowMs: { type: "number" },
        rollbackCondition: { type: "string" },
        actor: { type: "string" },
      },
    },
    sides: OBSERVER_ONLY,
    run: async (a, ops) =>
      ops.changeParam({
        key: str(a["key"]),
        newValue: a["newValue"],
        reason: str(a["reason"]),
        expectedEffect: str(a["expectedEffect"]),
        evaluationWindowMs: a["evaluationWindowMs"] == null ? 0 : num(a["evaluationWindowMs"]),
        rollbackCondition: str(a["rollbackCondition"]),
        actor: a["actor"] == null ? undefined : str(a["actor"]),
      }),
  },
  {
    name: "audit",
    description: "审计报告：缺席端点自检、参数纪律、耦合检测器、定名权、诚实声明。",
    inputSchema: { type: "object", properties: {} },
    sides: OBSERVER_ONLY,
    run: async (_a, ops) => ops.audit(),
  },
  {
    name: "bench",
    description: "运行评测台全量（三指标 + 工作区日检 + gap 对齐）并落库。",
    inputSchema: { type: "object", properties: {} },
    sides: OBSERVER_ONLY,
    run: async (_a, ops) => ops.bench(),
  },
];

export interface McpContext {
  side: McpSide;
  ops: PothosOps;
  protocolVersion?: string;
}

/** 处理一条 JSON-RPC 消息；通知返回 null，其余返回响应（JSON 字符串，单行）。 */
export async function handleMessage(msg: unknown, ctx: McpContext): Promise<string | null> {
  if (msg == null || typeof msg !== "object") {
    return line({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } });
  }
  const m = msg as Record<string, unknown>;
  const method = str(m["method"]);
  const id = m["id"];

  if (method === "notifications/initialized" || method.startsWith("notifications/")) {
    return null; // 通知不回应
  }

  try {
    if (method === "initialize") {
      const params = (m["params"] ?? {}) as Record<string, unknown>;
      const requested = str(params["protocolVersion"]);
      return line({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: requested || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: MCP_SERVER_INFO,
        },
      });
    }
    if (method === "ping") {
      return line({ jsonrpc: "2.0", id, result: {} });
    }
    if (method === "tools/list") {
      return line({
        jsonrpc: "2.0",
        id,
        result: {
          tools: TOOLS.filter((t) => t.sides.includes(ctx.side)).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      });
    }
    if (method === "tools/call") {
      const params = (m["params"] ?? {}) as Record<string, unknown>;
      const name = str(params["name"]);
      const tool = TOOLS.find((t) => t.name === name && t.sides.includes(ctx.side));
      if (!tool) {
        return line({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `未知工具或无权使用：${name}（当前侧：${ctx.side}）` }],
            isError: true,
          },
        });
      }
      try {
        const result = await tool.run((params["arguments"] ?? {}) as Record<string, unknown>, ctx.ops);
        return line({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] },
        });
      } catch (e) {
        return line({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: `工具执行失败：${e instanceof Error ? e.message : String(e)}` }], isError: true },
        });
      }
    }
    return line({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (e) {
    return line({ jsonrpc: "2.0", id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
  }
}

function line(v: unknown): string {
  return JSON.stringify(v);
}

/** stdio 主循环：stdout 只承载协议行，任何日志一律走 stderr。 */
export async function runStdioMcp(
  ctx: McpContext,
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = { input: process.stdin, output: process.stdout },
): Promise<void> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: io.input as NodeJS.ReadableStream, terminal: false });
  const write = (s: string): void => {
    io.output.write(s + "\n");
  };
  for await (const raw of rl) {
    const l = raw.trim();
    if (!l) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(l);
    } catch {
      write(line({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
      continue;
    }
    const out = await handleMessage(msg, ctx);
    if (out != null) write(out);
  }
}
