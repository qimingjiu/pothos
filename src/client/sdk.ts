/**
 * Pothos SDK：零依赖 typed 客户端（Node 20+ 全局 fetch）。
 *
 * 引擎是 HTTP 薄层 + 本地服务；本客户端是外部系统（网关、住户侧 agent、
 * 观测者控制台）的即取即用入口。错误以 PothosApiError 抛出（含状态码与响应体）。
 */
export class PothosApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = "PothosApiError";
  }
}

export interface IngestResponse {
  stored: boolean;
  eventId?: number;
  duplicate: boolean;
  crisis?: {
    triggered: boolean;
    literalRegistration: string;
    handoff: unknown;
    resourceCard: string;
  };
}

export interface AlertRowLike {
  id: number;
  ts: number;
  level: string;
  status: string;
  ackTs: number | null;
  actedTs: number | null;
}

/** SSE 载荷来自网络：派发前做运行时校验，不合形的事件丢弃（不把垃圾递给回调）。 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isAlertRowLike(v: unknown): v is AlertRowLike {
  return (
    isRecord(v) &&
    typeof v["id"] === "number" &&
    typeof v["ts"] === "number" &&
    typeof v["level"] === "string" &&
    typeof v["status"] === "string" &&
    (v["ackTs"] === null || typeof v["ackTs"] === "number") &&
    (v["actedTs"] === null || typeof v["actedTs"] === "number")
  );
}

function isHelloInfo(v: unknown): v is { rendererV: string; now: number } {
  return isRecord(v) && typeof v["rendererV"] === "string" && typeof v["now"] === "number";
}

export interface RenderOutputLike {
  text: string;
  rendererV: string;
  controlWindow: boolean;
}

export interface ChangeParamRequest {
  key: string;
  newValue: unknown;
  reason: string;
  expectedEffect: string;
  evaluationWindowMs: number;
  rollbackCondition: string;
  actor?: string;
}

export interface PothosClientOptions {
  baseUrl: string;
  /** 观测者鉴权 token（引擎设置了 POTHOS_TOKEN 时必填） */
  token?: string;
  fetchImpl?: typeof fetch;
}

export class PothosClient {
  constructor(private opts: PothosClientOptions) {}

  private async req<T>(method: string, path: string, body?: unknown, allowStatus: number[] = []): Promise<T> {
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(this.opts.baseUrl.replace(/\/$/, "") + path, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok && !allowStatus.includes(res.status)) {
      const text = await res.text().catch(() => "");
      throw new PothosApiError(res.status, `${method} ${path} → ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  }

  private async reqText(path: string): Promise<string> {
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(this.opts.baseUrl.replace(/\/$/, "") + path, {
      headers: this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {},
    });
    if (!res.ok) throw new PothosApiError(res.status, `GET ${path} → ${res.status}`);
    return res.text();
  }

  // ── 健康与元信息 ──
  health(): Promise<{ ok: boolean; store: string }> {
    return this.req("GET", "/healthz");
  }

  // ── 事件摄入（幂等键必填）──
  ingestEvent(ev: {
    kind: "user_msg" | "resident_msg" | "world" | "declared";
    ts: number;
    payload?: Record<string, unknown>;
    tags?: string[];
    source?: string;
    idempotencyKey: string;
  }): Promise<IngestResponse> {
    return this.req("POST", "/events", ev);
  }

  // ── 观测者读数（数值层——只该被「她」看到）──
  state(): Promise<Record<string, unknown>> {
    return this.req("GET", "/state");
  }

  metrics(): Promise<Record<string, unknown>> {
    return this.req("GET", "/metrics");
  }

  maView(): Promise<Record<string, unknown>> {
    return this.req("GET", "/ma/view");
  }

  audit(): Promise<Record<string, unknown>> {
    return this.req("GET", "/admin/audit");
  }

  // ── 渲染层（住户内感受，无数值）──
  renderInteroception(opts: { controlWindow?: boolean } = {}): Promise<RenderOutputLike> {
    return this.req("GET", "/render/interoception" + (opts.controlWindow ? "?control_window=1" : ""));
  }

  crisisCard(): Promise<string> {
    return this.reqText("/crisis/card");
  }

  // ── 告警签收状态机 ──
  ackAlert(id: number): Promise<AlertRowLike> {
    return this.req("POST", `/alerts/${id}/ack`);
  }

  actAlert(id: number): Promise<AlertRowLike> {
    return this.req("POST", `/alerts/${id}/acted`);
  }

  // ── 間与参数纪律 ──
  recordActivity(a: {
    activity: "digest" | "create" | "hunt" | "wonder" | "decline";
    tokenCost: number;
    quality?: number;
    content?: string;
  }): Promise<{ ok: true; delivered: boolean }> {
    return this.req("POST", "/ma/activity", a);
  }

  /** 422（纪律拒绝）不抛错——{ok:false,error} 原样返回，先写预期的纪律由调用方读 error。 */
  changeParam(req: ChangeParamRequest): Promise<{ ok: boolean; error?: string }> {
    return this.req("POST", "/admin/params", req, [422]);
  }

  forkReplay(overrides: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.req("POST", "/admin/fork-replay", { overrides });
  }

  bench(): Promise<Record<string, unknown>> {
    return this.req("POST", "/admin/bench");
  }

  canary(): Promise<{ deviation: number; action: string }> {
    return this.req("POST", "/admin/canary");
  }

  probeGate(): Promise<Record<string, unknown>> {
    return this.req("GET", "/admin/probe-gate");
  }

  /**
   * 告警推送流（SSE，单向只读）。返回取消函数。
   * 引擎主动说话只有一句话：需要陪伴性在场。没有客户端可写通道——缺席即边界。
   */
  alertsStream(handlers: {
    onHello?: (info: { rendererV: string; now: number }) => void;
    onAlert?: (alert: AlertRowLike) => void;
    onError?: (e: unknown) => void;
  }): { close: () => void } {
    const f = this.opts.fetchImpl ?? fetch;
    const ctrl = new AbortController();
    void (async () => {
      try {
        const res = await f(this.opts.baseUrl.replace(/\/$/, "") + "/alerts/stream", {
          headers: this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {},
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) throw new PothosApiError(res.status, `GET /alerts/stream → ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let eventName = "";
        const dispatch = (name: string, data: string): void => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            return; // ping 等非 JSON 载荷
          }
          try {
            if (name === "alert" && isAlertRowLike(parsed)) handlers.onAlert?.(parsed);
            else if (name === "hello" && isHelloInfo(parsed)) handlers.onHello?.(parsed);
          } catch {
            /* 回调异常不中断流 */
          }
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, "");
            buf = buf.slice(nl + 1);
            if (line.startsWith("event:")) {
              eventName = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              dispatch(eventName, line.slice(5).trim());
              eventName = "";
            } else if (line === "") {
              eventName = ""; // 事件边界
            }
          }
        }
      } catch (e) {
        if (!ctrl.signal.aborted) handlers.onError?.(e);
      }
    })();
    return { close: () => ctrl.abort() };
  }
}
