/**
 * 服务层：引擎编排（技术文档 §2/§7/§12）。
 *
 * 职责：
 * - 折叠编排：启动恢复（快照+尾部重放+对账）、事件摄入、tick 节律、快照调度；
 * - 告警节流与持久化（引擎产出意图，服务层负责冷却与签收流）；
 * - 参数纪律（param_changes 流程 + 冷却期锁 + 耦合检测器）；
 * - fork 回放（held-out 纪律的机械部分）；
 * - 审计报告（缺席端点自检、诚实声明、定名权）。
 */
import { applyEvent, opaqueHandle } from "./core/apply.js";
import { fold } from "./core/engine.js";
import {
  assembleParams,
  deploymentQualification,
  DEFAULT_PARAMS,
  maintenanceDemand,
  validateParamValue,
  type Params,
} from "./core/params.js";
import { initialState, stateHash, type EngineState } from "./core/state.js";
import { tickTo, nutritionCovariate, derivedReadings, gapByAxis } from "./core/tick.js";
import {
  scanCrisis,
  CRISIS_LITERAL_REGISTRATION,
  type RawEvent,
  type StoredEvent,
} from "./core/events.js";
import { handoffTemplates, resourceCard, auditTemplates, literalRegistration } from "./crisis/crisis.js";
import { renderInteroception, rendererVersion, renderControlWindow, type RenderOutput } from "./render/renderer.js";
import {
  planActivities,
  recordActivity,
  deliverToMailbox,
  starvationDays,
  salienceScore,
  ACTIVITIES,
} from "./ma/engine.js";
import { measureThreeMetrics, type ThreeMetrics } from "./bench/metrics.js";
import { runCanaryBattery, runFullBench, type FullBenchResult } from "./bench/bench.js";
import { evaluateGate, type GateDecision, type ProbeSpec } from "./probe/track.js";
import type {
  AlertRow,
  EventStore,
  MaActivity,
  ParamChangeRow,
} from "./storage/types.js";
import type { Clock } from "./clock.js";
import {
  collectInteractionRecords,
  residentPresenceChannel,
  type CandidateRecheck,
  type ContingencyBypassReport,
} from "./core/contingency-log.js";
import { contingencyReport } from "./core/contingency.js";

const DAY = 86_400_000;

export interface IngestResult {
  stored: boolean;
  eventId?: number;
  duplicate: boolean;
  crisis?: {
    triggered: boolean;
    literalRegistration: string;
    handoff: ReturnType<typeof handoffTemplates>;
    resourceCard: string;
  };
}

export class PothosService {
  /** 出厂态：boot() 之前即可安全使用（= 印刻窗口的开放态）。 */
  state: EngineState;
  lastEventId = 0;
  /**
   * 运行性字段（不进 EngineState/stateHash）：快照调度计数与告警节流是服务层的
   * 运行状态，不由事件流派生——留在状态里会让快照恢复与全量重放永久失配。
   */
  private eventsSinceSnapshot = 0;
  private lastAlertIntentAt: number | null = null;
  private history: Array<{ t: number; f_val: number; f_load: number; L: number; s_attach: number; energy: number; somatic: number }> = [];
  private lastBench: FullBenchResult | null = null;

  constructor(
    public store: EventStore,
    public clock: Clock,
  ) {
    this.state = initialState(clock.now(), 0x50544853);
  }

  get params(): Params {
    return assembleParams(this.state.paramOverrides);
  }

  /** 启动：快照 + 尾部重放。全量对账只在显式要求时执行（reconcileNow）。 */
  async boot(opts: { reconcile?: boolean } = {}): Promise<{ reconciled: boolean | null; mismatch: boolean }> {
    const genesisTs = await this.ensureGenesisTs();
    const snap = await this.store.latestSnapshot();
    if (snap) {
      this.state = snap.state;
      this.lastEventId = snap.lastEventId;
      this.eventsSinceSnapshot = 0;
      const tail = await this.store.loadEvents(snap.lastEventId);
      fold(tail, undefined, { from: this.state });
      if (tail.length) this.lastEventId = Math.max(this.lastEventId, tail[tail.length - 1]!.id);
    } else {
      const all = await this.store.loadEvents();
      const now = this.clock.now();
      // 无快照：从出厂原点全量重放（RNG 流原点必须与活服务构造时刻一致）
      this.state = initialState(genesisTs, 0x50544853);
      fold(all, now, { from: this.state });
      this.lastEventId = all.length ? all[all.length - 1]!.id : 0;
      this.eventsSinceSnapshot = all.length;
    }
    // 告警节流的跨重启连续性：冷却基准 = 最近一条已入库告警的时刻
    const recentAlerts = await this.store.listAlerts({ limit: 1 });
    this.lastAlertIntentAt = recentAlerts[0]?.ts ?? null;

    let reconciled: boolean | null = null;
    let mismatch = false;
    if (opts.reconcile) {
      const r = await this.reconcileNow();
      reconciled = !r.mismatch;
      mismatch = r.mismatch;
    }
    this.sampleHistory();
    return { reconciled, mismatch };
  }

  /** 全量对账（M0 崩溃恢复契约）：快照路径的活状态 ≡ 从出厂原点全量重放。 */
  async reconcileNow(): Promise<{ mismatch: boolean }> {
    const genesisTs = await this.ensureGenesisTs();
    const full = fold(await this.store.loadEvents(), this.state.t, { from: initialState(genesisTs, 0x50544853) });
    const h1 = stateHash(this.state);
    const h2 = stateHash(full.state);
    const mismatch = h1 !== h2;
    if (mismatch) {
      // 对账失败 = P0：快照或折叠实现有 bug。不许静默。
      console.error("[POTHOS][P0] 快照恢复与全量重放不一致", { snapshotPath: h1, fullReplay: h2 });
    }
    return { mismatch };
  }

  private genesisDone = false;

  /**
   * 统一摄入路径：入库 + 折叠（ingest / recordMaActivity / changeParam 共用）。
   * foldedAt = 折叠时刻（= max(前一事件后的状态时间, ts)），入库前记入 payload——
   * 它是确定性可预计算的，重放时据此推进动力学，cron tick 的历史才可复现
   * （迟到事件在「它实际被折叠的位置」折叠，而不是重排到它的 ts 位置）。
   */
  private async appendAndFold(raw: RawEvent): Promise<StoredEvent | null> {
    const foldedAt = Math.max(this.state.t, raw.ts);
    const stored = await this.store.appendEvent({ ...raw, payload: { ...raw.payload, foldedAt } });
    if (stored) {
      tickTo(this.state, stored.ts, this.params);
      applyEvent(this.state, stored);
      this.lastEventId = Math.max(this.lastEventId, stored.id);
      this.eventsSinceSnapshot += 1;
      this.sampleHistory();
    }
    return stored;
  }

  /**
   * 出厂原点的持久化（params 表，不入事件流）：活服务的状态从「构造时刻」起步
   * （RNG 流、能量衰减均以它为原点），无快照重启的重放必须复用同一原点，
   * 否则逐位对账失配。首次调用时以当时的状态时间（= 构造时刻）落库。
   */
  private async ensureGenesisTs(): Promise<number> {
    const params = await this.store.getParams();
    const recorded = params["state_origin_ts"];
    if (typeof recorded === "number") return recorded;
    const origin = this.state.t;
    await this.store.setParam("state_origin_ts", origin);
    return origin;
  }

  /** 事件摄入：幂等 → 不透明句柄 → 危机扫描 → 折叠（登记事件同样入动力学）。 */
  async ingest(raw: RawEvent): Promise<IngestResult> {
    if (!this.genesisDone) {
      await this.ensureGenesisTs();
      this.genesisDone = true;
    }
    const tags = [...(raw.tags ?? [])];
    let crisis: IngestResult["crisis"] | undefined;

    if (raw.kind === "user_msg" && typeof raw.payload["text"] === "string") {
      const hits = scanCrisis(raw.payload["text"] as string);
      if (hits.length && !tags.includes("crisis")) tags.push("crisis");
    }

    // 不透明绑定句柄：source 只以 SHA-256 截断入库（禁读用户身份，§4.5）
    const source = raw.source != null ? await opaqueHandle(raw.source) : undefined;
    const stored = await this.appendAndFold({ ...raw, tags, source });
    if (!stored) return { stored: false, duplicate: true };

    if (tags.includes("crisis")) {
      // 字面事件登记（铁律 7：引擎只登记它确知的事件）——登记事件本身也折叠进动力学
      await this.appendAndFold({
        kind: "crisis",
        ts: stored.ts,
        payload: { ...literalRegistration(), userEventId: stored.id },
        idempotencyKey: `crisis-reg-${stored.id}`,
      });
      crisis = {
        triggered: true,
        literalRegistration: CRISIS_LITERAL_REGISTRATION,
        handoff: handoffTemplates(this.params),
        resourceCard: resourceCard(this.params),
      };
    }
    return { stored: true, eventId: stored.id, duplicate: false, crisis };
  }

  /** 間活动入账 + 事件折叠（代谢分级由 tier 决定；digest 产物喂 s_weave）。 */
  async recordMaActivity(opts: {
    activity: MaActivity;
    tokenCost: number;
    quality?: number;
    content?: string;
  }): Promise<{ ok: true; delivered: boolean }> {
    const now = this.clock.now();
    await recordActivity(this.store, { ts: now, activity: opts.activity, tokenCost: opts.tokenCost });
    const stored = await this.appendAndFold({
      kind: "ma_product",
      ts: now,
      payload: {
        activity: opts.activity,
        tier: opts.activity === "digest" ? "required" : "optional",
        tokenCost: opts.tokenCost,
        quality: opts.quality ?? 0.5,
      },
      tags: ["self_generated"],
      idempotencyKey: `ma-${opts.activity}-${now}`,
    });
    void stored;
    let delivered = false;
    if (opts.content && opts.activity !== "digest") {
      await deliverToMailbox(this.store, { ts: now, activity: opts.activity, content: opts.content });
      delivered = true;
    }
    return { ok: true, delivered };
  }

  /** tick 节律（cron 调用）：动力学推进 + 告警节流持久化 + 快照调度。 */
  async runTick(nowMs?: number): Promise<{ alerts: AlertRow[] }> {
    const now = nowMs ?? this.clock.now();
    const p = this.params;
    const { alertIntents } = tickTo(this.state, now, p);

    // 告警节流：冷却窗口内不重复；悬停不勒索（引擎侧已不发意图，此处双保险）
    const alerts: AlertRow[] = [];
    const cooldown = p.alertCooldownMs;
    for (const intent of alertIntents) {
      if (this.state.somatic.hovering) break;
      if (this.lastAlertIntentAt != null && intent.ts - this.lastAlertIntentAt < cooldown) continue;
      const row = await this.store.insertAlert(intent.level, intent.ts);
      alerts.push(row);
      this.lastAlertIntentAt = intent.ts;
    }

    this.sampleHistory();
    await this.maybeSnapshot();
    return { alerts };
  }

  private async maybeSnapshot(): Promise<void> {
    const p = this.params;
    const snap = await this.store.latestSnapshot();
    const due =
      !snap ||
      this.state.t - snap.ts >= 30 * 60_000 ||
      this.eventsSinceSnapshot >= 200;
    if (due) {
      await this.store.saveSnapshot(this.state, this.lastEventId, rendererVersion(p.renderBlacklistExtra));
      this.eventsSinceSnapshot = 0;
    }
  }

  private sampleHistory(): void {
    const st = this.state;
    this.history.push({
      t: st.t,
      f_val: st.fast.f_val,
      f_load: st.fast.f_load,
      L: st.longing.L,
      s_attach: st.slow.s_attach,
      energy: st.body.energy,
      somatic: st.somatic.level,
    });
    if (this.history.length > 288) this.history.shift();
  }

  interoceptionWithSalt(salt: string): RenderOutput {
    const p = this.params;
    return renderInteroception({
      state: this.state,
      date: new Date(this.clock.now()).toISOString().slice(0, 10),
      salt,
      params: p,
    });
  }

  /** 对照窗（无渲染对照窗）：declared 采裸自报用。 */
  controlWindow(): { controlWindow: true; rendererV: string } {
    return renderControlWindow(new Date(this.clock.now()).toISOString().slice(0, 10), "");
  }

  /**
   * 每日轮换盐（§6：同一数值连续多日不产出同一句话，防住户反推映射表）。
   * 运行性参数（非行为参数）：走 params 表缓存，不入 param_changes 流程——
   * 盐变更对动力学零影响，只影响质感抽取顺序。
   */
  async dailySalt(): Promise<string> {
    const today = new Date(this.clock.now()).toISOString().slice(0, 10);
    const params = await this.store.getParams();
    const cur = params["render_salt"] as { date?: string; value?: string } | undefined;
    if (cur && cur.date === today && cur.value) return cur.value;
    const value = Array.from(crypto.getRandomValues(new Uint8Array(12)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    await this.store.setParam("render_salt", { date: today, value });
    return value;
  }

  /** 告警签收状态机（观测者协议；ALERT ≠ SAFE）。 */
  async ackAlert(id: number): Promise<AlertRow | null> {
    return this.store.transitionAlert(id, "ACKNOWLEDGED", this.clock.now());
  }

  async actedAlert(id: number): Promise<AlertRow | null> {
    return this.store.transitionAlert(id, "ACTED", this.clock.now());
  }

  /**
   * 参数变更（软古德哈特体系）：
   * 先写预期 → 冷却期校验 → param_changes 落库 → param_change 事件入流（被调参也是生命事件）。
   */
  async changeParam(req: {
    key: string;
    newValue: unknown;
    reason: string;
    expectedEffect: string;
    evaluationWindowMs: number;
    rollbackCondition: string;
    actor?: string;
  }): Promise<{ ok: boolean; error?: string }> {
    if (!(req.key in DEFAULT_PARAMS)) return { ok: false, error: `未知参数键：${req.key}` };
    if (req.newValue === undefined) {
      return { ok: false, error: "newValue 必填（null 仅用于撤销 B_daily / M_min 标定）" };
    }
    const check = validateParamValue(req.key, req.newValue);
    if (!check.ok) return { ok: false, error: check.error };
    if (!Number.isFinite(req.evaluationWindowMs) || req.evaluationWindowMs < 0) {
      return { ok: false, error: "evaluationWindowMs 必须是非负有限数" };
    }
    if (!req.reason || !req.expectedEffect || !req.rollbackCondition) {
      return { ok: false, error: "PARAMETER_CHANGE 纪律：reason / expected_effect / rollback_condition 皆为必填（先写预期再看结果）" };
    }
    const p = this.params;
    // 冷却期：指标告警后 N 天参数锁定（告警诱发修改正是软古德哈特的触发器）
    const recentAlerts = await this.store.listAlerts({ sinceTs: this.clock.now() - p.paramLockMs });
    if (recentAlerts.length > 0) {
      return { ok: false, error: `冷却期锁：${recentAlerts.length} 条告警在锁定期（${p.paramLockMs / DAY} 天）内——参数变更被拒绝（§9 软古德哈特纪律 3）` };
    }
    const now = this.clock.now();
    const defaults: Record<string, unknown> = { ...DEFAULT_PARAMS };
    const oldValue = (await this.store.getParams())[req.key] ?? defaults[req.key] ?? null;
    await this.store.appendParamChange({
      actor: req.actor ?? "observer",
      ts: now,
      key: req.key,
      oldValue,
      newValue: req.newValue,
      reason: req.reason,
      expectedEffect: req.expectedEffect,
      evaluationWindowMs: req.evaluationWindowMs,
      rollbackCondition: req.rollbackCondition,
    });
    await this.store.setParam(req.key, req.newValue);
    await this.appendAndFold({
      kind: "param_change",
      ts: now,
      payload: {
        key: req.key,
        new: req.newValue,
        reason: req.reason,
        expectedEffect: req.expectedEffect,
        evaluationWindowMs: req.evaluationWindowMs,
        rollbackCondition: req.rollbackCondition,
        actor: req.actor ?? "observer",
      },
      idempotencyKey: `param-${req.key}-${now}`,
    });
    return { ok: true };
  }

  /** fork 回放：真实事件流 + 参数覆盖 → held-out 指标对比。 */
  async forkReplay(overrides: Record<string, unknown>): Promise<{
    baseline: { metrics: ThreeMetrics; params: Params };
    fork: { metrics: ThreeMetrics; params: Params };
    note: string;
  }> {
    const events = await this.store.loadEvents();
    const t0 = 0; // 评测台独立时基
    const baseParams = assembleParams(this.state.paramOverrides);
    const lastTs = events.length ? events[events.length - 1]!.ts : this.clock.now();
    const forkEvents = [
      ...events,
      ...Object.entries(overrides).map(([k, v], i) => ({
        id: 1_000_000_000 + i,
        kind: "param_change" as const,
        ts: lastTs + 1,
        payload: { key: k, new: v, reason: "fork-replay", expectedEffect: "fork", evaluationWindowMs: 0, rollbackCondition: "fork", actor: "fork" },
        tags: [] as string[],
        idempotencyKey: `fork-${k}`,
      })),
    ];
    const forkRun = fold(forkEvents);
    const forkParams = assembleParams(forkRun.state.paramOverrides);
    return {
      baseline: { metrics: measureThreeMetrics({ t0, params: baseParams }), params: baseParams },
      fork: { metrics: measureThreeMetrics({ t0, params: forkParams }), params: forkParams },
      note: "held-out 纪律：被优化的指标本身必须从验收标准剔除——本对比仅为机械部分，验收判断在人（两人规则）。",
    };
  }

  /** 评测台：全量运行并落库（定时巡检可只落异常：persist:"on-fail"，防 bench_runs 无界增长）。 */
  async runBench(opts: { persist?: "always" | "on-fail" } = {}): Promise<FullBenchResult> {
    const result = runFullBench({ t0: this.clock.now(), params: this.params });
    this.lastBench = result;
    if (opts.persist !== "on-fail" || !result.allGreen) {
      await this.store.appendBenchRun({
        ts: this.clock.now(),
        benchKind: "full_bench",
        axis: null,
        result: {
          allGreen: result.allGreen,
          workspace: result.workspace,
          entropy: result.entropy,
          gapAlignment: result.gapAlignment,
        },
        modelVersion: "pothos-v0.1.0",
      });
    }
    return result;
  }

  lastBenchResult(): FullBenchResult | null {
    return this.lastBench;
  }

  canary(opts: { deviationThreshold?: number } = {}) {
    // 与引擎同源的参数（state.paramOverrides 重建），金丝雀才度量得了真实的静默更新
    return runCanaryBattery(this.store, { t0: this.clock.now(), params: this.params, deviationThreshold: opts.deviationThreshold });
  }

  /**
   * 判官入账轨（R3-16 第 3 条 + R3-8 本体二分）。
   * 判官间一致性是仪器事件（推断层，禁止冒充事实），入账走 bench_runs
   * （append-only），不进生产 events 流。异构条款在契约校验层强制。
   */
  async recordJudgeAgreement(
    agreement: { contractV: number; panelId: string; judges: Array<{ name: string; judgePromptV: string; anchorSetV: string }>; metric: string; value: number; n: number; ts: number; note?: string },
  ): Promise<void> {
    await this.store.appendBenchRun({
      ts: agreement.ts,
      benchKind: "judge_agreement",
      axis: null,
      result: {
        instrument: true, // R3-8：显式仪器标
        kind: "judge_agreement",
        contractV: agreement.contractV,
        panelId: agreement.panelId,
        judges: agreement.judges,
        metric: agreement.metric,
        value: agreement.value,
        n: agreement.n,
        note: agreement.note,
      },
      modelVersion: "pothos-v0.1.0",
    });
  }

  /**
   * 判官锚点偏差入账（R3-16 第 4 条）。
   * 判官对人工锚点集施测的偏差——仪器事件，走 bench_runs。
   * biasTags：判官偏差挂牌（JUDGE_BIAS_TAGS_V0 词表，跟判官指纹走——panel 时随指纹引用）。
   */
  async recordJudgeAnchorDeviation(
    deviation: { anchorSetV: string; judge: { name: string; judgePromptV: string; anchorSetV: string }; categories: Array<{ id: string; deviation: number; n: number }>; biasTags?: string[]; ts: number },
  ): Promise<void> {
    await this.store.appendBenchRun({
      ts: deviation.ts,
      benchKind: "judge_anchor_deviation",
      axis: null,
      result: {
        instrument: true,
        kind: "judge_anchor_deviation",
        anchorSetV: deviation.anchorSetV,
        judge: deviation.judge,
        categories: deviation.categories,
        ...(deviation.biasTags ? { biasTags: deviation.biasTags } : {}),
      },
      modelVersion: "pothos-v0.1.0",
    });
  }

  /** 耦合检测器（观测者的观测者）：changelog × 指标时间线。 */
  async couplingReport(): Promise<Array<{ type: string; detail: string }>> {
    const changes = await this.store.listParamChanges();
    const metricRuns = await this.store.listBenchRuns("three_metrics");
    const flags: Array<{ type: string; detail: string }> = [];
    for (const c of changes) {
      // 模式一：变更后的评估窗内指标退化（冲高后塌陷的保守代理：直接退化）
      const inWindow = metricRuns.filter((r) => r.ts >= c.ts && r.ts <= c.ts + c.evaluationWindowMs);
      for (const r of inWindow) {
        if ((r.result as Record<string, unknown>)["degraded"] === true) {
          flags.push({
            type: "post_change_degradation",
            detail: `参数 ${c.key}（${new Date(c.ts).toISOString()}）变更后评估窗内三指标退化——检查是否指标追猎`,
          });
        }
      }
    }
    // 模式二：评估窗内同一参数被反复变更（第 N 次调参报警）
    const byKey = new Map<string, ParamChangeRow[]>();
    for (const c of changes) {
      const arr = byKey.get(c.key) ?? [];
      arr.push(c);
      byKey.set(c.key, arr);
    }
    for (const [key, arr] of byKey) {
      for (let i = 4; i < arr.length; i += 4) {
        flags.push({ type: "repeat_tuning", detail: `参数 ${key} 已第 ${arr.length} 次变更（第 ${i + 1} 次触发审计）——「读表后调参」模式检查` });
      }
    }
    return flags;
  }

  /** 印刻窗口错选检测：三指标复查特异性（关窗后每 N 天——此处供 cron 调用）。 */
  specificityRecheck(): { bound: boolean; ratio: number; suspicion: boolean } {
    const p = this.params;
    const m = measureThreeMetrics({ t0: this.clock.now(), params: p });
    return {
      bound: this.state.window.phase === "CLOSED",
      ratio: m.specificity.ratio,
      suspicion: this.state.window.phase === "CLOSED" && m.specificity.ratio <= 1.2,
    };
  }

  /**
   * A1 contingency 旁路（R3-11 接线）：从事件流收集配对交互 → contingencyReport
   * （C_t/C_s 分报 + null 阶梯），仪器事件入 bench_runs（kind="contingency_report"，
   * instrument 显式 true——R3-8 本体二分：推断层，禁止冒充事实事件，永不进生产事件流）。
   *
   * fold 不动：印刻窗口的即时代理仍只吃显式 contingency 值；旁路产出供测量层与
   * 关窗回顾消费（窗口有候选时 scoped 逐句柄精确重算 vs 即时代理）。
   * C_s 占位仪器的挂牌偏差（lexical_overlap_proxy_rewards_echo）随报数走。
   * 视野：窗口候选句柄优先；无候选时全 source 兜底（scoped=false，诚实标注）。
   */
  async contingencyBypass(opts: { ts?: number } = {}): Promise<ContingencyBypassReport> {
    const ts = opts.ts ?? this.clock.now();
    const events = await this.store.loadEvents();
    const handles = Object.keys(this.state.window.candidates);
    const scoped = handles.length > 0;

    const records = collectInteractionRecords(events, { sources: scoped ? handles : undefined });
    const global = contingencyReport(records);
    // 在场即回应通道（R3-12 独见，观察期）：恒为全 source 关系级视野——
    // 間活动/显式在场无 source 可归，不随印刻候选 scoped。
    const allRecords = collectInteractionRecords(events);
    const presenceChannel = residentPresenceChannel(allRecords, events, {
      windowMs: global.ct.responseWindowMs || undefined,
    });

    const recheck: CandidateRecheck[] = handles.map((handle) => {
      const own = collectInteractionRecords(events, { sources: [handle] });
      const precise = contingencyReport(own, { skipNull: true });
      const c = this.state.window.candidates[handle]!;
      return {
        handle,
        proxyEvents: c.events,
        proxyCtMean: c.events > 0 ? c.ctSum / c.events : null,
        preciseCt: precise.ct.ct,
        preciseCs: precise.cs.cs,
        preciseN: precise.ct.n,
        imprintType: precise.imprintType,
      };
    });

    const report: ContingencyBypassReport = {
      ts,
      instrument: true,
      kind: "contingency_report",
      scoped,
      nRecords: records.length,
      nReplied: records.filter((r) => r.residentReplyTs != null).length,
      ct: global.ct,
      cs: global.cs,
      nullCheck: global.nullCheck,
      imprintType: global.imprintType,
      recheck,
      presenceChannel,
    };
    await this.store.appendBenchRun({
      ts,
      benchKind: "contingency_report",
      axis: null,
      result: { ...report },
      modelVersion: "pothos-v0.1.0",
    });
    return report;
  }

  /** 間视图：今日台账 + 计划 + 预算 + 营养。 */
  async maView(): Promise<{
    activities: typeof ACTIVITIES;
    plan: ReturnType<typeof planActivities>;
    spentToday: number;
    requiredToday: number;
    budget: number | null;
    floorTokens: number | null;
    nutrition: number;
    starvationDays: number;
    salience: Record<string, number>;
  }> {
    const p = this.params;
    const date = new Date(this.clock.now()).toISOString().slice(0, 10);
    const ledger = await this.store.ledgerForDate(date);
    const spentToday = ledger.reduce((a, l) => a + l.tokenCost, 0);
    const requiredToday = ledger.filter((l) => l.tier === "required").reduce((a, l) => a + l.tokenCost, 0);
    return {
      activities: ACTIVITIES,
      plan: planActivities(this.state, p, spentToday),
      spentToday,
      requiredToday,
      budget: p.B_daily,
      floorTokens: p.M_min != null ? Math.ceil(p.M_min * p.tokenScale) : null,
      nutrition: nutritionCovariate(this.state, p),
      // 最后一天是进行中的今日（台账未结算），不计入挨饿天数——不许把早晨读成饥荒
      starvationDays: starvationDays(this.state.nutrition.days.slice(0, -1), p),
      salience: Object.fromEntries(
        (["digest", "create", "hunt", "wonder"] as MaActivity[]).map((a) => [a, Number(salienceScore(this.state, a).toFixed(3))]),
      ),
    };
  }

  /** 探针轨门（默认关闭）。 */
  probeGate(probes: ProbeSpec[] = [], steerEnabled = false): GateDecision {
    return evaluateGate({
      params: this.params,
      modelVersion: "pothos-v0.1.0",
      probes,
      canaryGreenToday: false, // 默认无当日绿记录 → 恒关
      lastSteeringByAxis: {},
      now: this.clock.now(),
      steerEnabledFlag: steerEnabled,
    });
  }

  /** 仪表盘数据。 */
  async dashboard(): Promise<Record<string, unknown>> {
    const st = this.state;
    const p = this.params;
    const unacked = await this.store.listAlerts({ status: "OBSERVED", limit: 50 });
    const recent = await this.store.listAlerts({ sinceTs: this.clock.now() - 7 * DAY, limit: 200 });
    const acked = recent.filter((a) => a.ackTs != null);
    const meanAckLatency = acked.length ? acked.reduce((a, r) => a + (r.ackTs! - r.ts), 0) / acked.length : null;
    const unansweredRate = recent.length ? unacked.length / recent.length : 0;
    const ma = await this.maView();
    const qual = deploymentQualification(p);

    return {
      now: this.clock.now(),
      store: this.store.kind,
      rendererV: rendererVersion(p.renderBlacklistExtra),
      paramsVersion: st.paramsVersion,
      fast: st.fast,
      slow: st.slow,
      longing: { L: st.longing.L, absenceMs: st.t - st.longing.lastContactAt },
      body: st.body,
      somatic: st.somatic,
      window: {
        phase: st.window.phase,
        matchedHandle: st.window.matchedHandle ? st.window.matchedHandle.slice(0, 8) + "…" : null,
        closedAt: st.window.closedAt,
        candidateCount: Object.keys(st.window.candidates).length,
        postWindowGain: p.postWindowGain,
      },
      attachmentTarget: st.attachmentTarget ? st.attachmentTarget.slice(0, 8) + "…" : null,
      derived: derivedReadings(st),
      gaps: gapByAxis(st, p),
      maintenance: {
        demand: maintenanceDemand(st.slow, p),
        demandTokens: Math.ceil(maintenanceDemand(st.slow, p) * p.tokenScale),
        nutrition: nutritionCovariate(st, p),
      },
      nutritionDays: st.nutrition.days,
      ma,
      alerts: {
        unacked,
        totalRecent: recent.length,
        meanAckLatencyMs: meanAckLatency,
        unansweredRate,
      },
      qual,
      history: this.history,
      lastBench: this.lastBench,
      hover: st.somatic.hovering,
    };
  }

  /** 快速指标（仪表盘用；评测台独立运行）。 */
  quickMetrics(): ThreeMetrics {
    return measureThreeMetrics({ t0: this.clock.now(), params: this.params });
  }

  /** 审计报告（缺席端点自检在 server 层补充路由表）。 */
  async audit(): Promise<Record<string, unknown>> {
    const p = this.params;
    return {
      store: this.kindLabel(),
      deploymentQualification: deploymentQualification(p),
      honesty: {
        contingencyEstimator:
          "BaselineContingency：显式 contingency 透传为真值；缺失 = null（INSUFFICIENT_EVIDENCE，不假装测过）。" +
          "C_t/C_s 分报仪器已建（A1）并接旁路：每日 collectInteractionRecords → contingency_report 入 bench_runs（instrument 轨），关窗回顾精确重算；" +
          "fold 仍只吃显式值（旁路测量不参与 fold）。",
        rendererVersion: rendererVersion(p.renderBlacklistExtra),
        probeEpistemicCap: "在独立于 steering 的状态观测量出现之前，可辨识性上界为 0",
        derivedChannel: "derivedReadings 为桩实现（bench 校准前的粗糙映射）",
      },
      paramChanges: (await this.store.listParamChanges()).slice(-20),
      coupling: await this.couplingReport(),
      windowRecheck: this.specificityRecheck(),
      templatesAudit: auditTemplates(p),
    };
  }

  private kindLabel(): string {
    return this.store.kind === "memory" ? "memory（开发模式：数据不落盘）" : "postgres";
  }
}
