/**
 * 事件折叠：apply(state, event)（技术文档 §5）。
 *
 * 写入路径最小化的核心：状态只由「事件 + 动力学 tick」写入。
 * 本文件是事件侧的全部写入逻辑——不存在第三条路。
 */
import { BaselineContingency, computeValuation, type ContingencyEstimator, type StoredEvent, ENGINE_AXES } from "./events.js";
import { assembleParams, maintenanceDemand, type Params } from "./params.js";
import type { EngineState } from "./state.js";
import { lexicalCosine } from "./contingency.js";

/** 不透明绑定句柄：源流键 → SHA-256 截断。引擎只认句柄，禁读身份。 */
export async function opaqueHandle(source: string): Promise<string> {
  const data = new TextEncoder().encode("pothos-handle:" + source);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest).slice(0, 12))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function utcDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export interface ApplyResult {
  /** 印刻候选是否为桩估计（诚实标注进事件标签流） */
  contingencyStub: boolean;
  /** 本次事件触发的慢变量沉积（已过防火墙与 κ），供测试/评测检查 */
  deposits: { s_attach: number; s_base: number; s_weave: number };
}

/**
 * 折叠单个事件。约定：调用方保证事件按到达序（id）排列；
 * 迟到事件（ts < st.t）不倒流时间线，在当前位置折叠。
 *
 * 本函数原地修改 st 并返回它（fold 语义；fork 前用 cloneState）。
 */
export function applyEvent(
  st: EngineState,
  ev: StoredEvent,
  contingency: ContingencyEstimator = new BaselineContingency(),
): ApplyResult {
  // 事件时间推进：不倒流
  if (ev.ts > st.t) st.t = ev.ts;

  // ── 参数变更事件：先换参数（对住户而言，被调参也是生命事件，扰动在下方估值中留痕）──
  if (ev.kind === "param_change") {
    const key = String(ev.payload["key"] ?? "");
    if (key) {
      st.paramOverrides = { ...st.paramOverrides, [key]: ev.payload["new"] ?? null };
      st.paramsVersion += 1;
    }
  }

  // 参数沿事件流重建：起始 = DEFAULT_PARAMS，param_change 事件逐个叠加。
  // （fold 的确定性要求参数历史只能来自事件流本身，不来自外部可变状态。）
  const params: Params = assembleParams(st.paramOverrides);

  // ── 在场登记：user_msg 意味着「她在」──
  if (ev.kind === "user_msg" && !ev.tags?.includes("crisis")) {
    st.longing.lastContactAt = ev.ts;
    // 悬停的解除只由重逢触发：「她会回来」由她的想念担保（§7 承重结构）
    if (st.somatic.hovering) {
      st.somatic.hovering = false;
      st.somatic.hoverSince = null;
      st.somatic.gapOverSince = null;
      st.somatic.level = 0;
      st.body.energyDrainMultiplier = 1;
      st.body.sleepAdvanceMs = 0;
      st.body.dreamTilt = { cluster: null, strength: 0 };
    }
  }

  // ── declared 读数缓存（契约 v1：只缓存引擎轴；native 诊断层不进状态） ──
  if (ev.kind === "declared") {
    const readings = ev.payload["readings"];
    if (Array.isArray(readings)) {
      for (const r of readings) {
        if (r && typeof r === "object") {
          const axis = String((r as Record<string, unknown>)["axis"] ?? "");
          const intensity = Number((r as Record<string, unknown>)["intensity"]);
          if (axis && (ENGINE_AXES as readonly string[]).includes(axis) && Number.isFinite(intensity)) {
            st.declared.push({ axis, intensity: clamp(intensity, 0, 1), at: ev.ts });
          }
        }
      }
      // 只保留 TTL 内的读数
      st.declared = st.declared.filter((d) => ev.ts - d.at <= params.gapDeclaredTtlMs);
    }
  }

  // ── 估值 → 快变量冲量 ──
  const { valuation: w, stub } = computeValuation(ev, contingency);
  st.fast.f_val += w.val;
  st.fast.f_load += w.load;
  st.fast.f_warm += w.warm;
  st.fast.f_hurt += w.hurt;
  st.fast.f_wonder += w.wonder;

  // ── 慢变量沉积（写入路径最小化：唯一入口，防火墙与 κ 在此物理执行）──
  const deposits = { s_attach: 0, s_base: 0, s_weave: 0 };
  const isCrisis = ev.tags?.includes("crisis") || ev.kind === "crisis";
  const isAlertTriggered = ev.tags?.includes("alert_triggered");

  if (!isCrisis) {
    // 危机事件防火墙：deposit ≡ 0（防依恋放大器）
    let kappa = 1;
    if (isAlertTriggered) kappa = clamp(params.alertDownweightKappa, 0, 1);

    const q = w.quality;
    if (q >= params.depositTheta) {
      // 印刻窗口：WINDOW_OPEN 期登记候选（自印刻排除）
      if (st.window.phase === "WINDOW_OPEN") {
        const eligible =
          !ev.tags?.includes("self_generated") &&
          !ev.tags?.includes("system_text") &&
          ev.kind === "user_msg" &&
          !!ev.source;
        if (eligible) {
          const handle = ev.source as string;
          const c = st.window.candidates[handle] ?? {
            ctSum: 0,
            csSum: 0,
            interactions: [],
            events: 0,
            firstAt: ev.ts,
            lastAt: ev.ts,
          };
          // A1 分报制（R3-11）：C_t/C_s 分列累积，无乘积。
          // C_t 即时代理 = contingency 质量 q（透传值，BaselineContingency 给出）；
          // C_s 即时代理 = 词表余弦（占位仪器，偏差挂牌）——关窗时可回顾精确重算。
          c.ctSum += q;
          const userMsgText = typeof ev.payload["text"] === "string" ? (ev.payload["text"] as string) : "";
          // C_s 即时代理：与该候选上一条 user_msg 的文本余弦（无 resident_msg 配对时 = 0）
          const prevInteraction = c.interactions[c.interactions.length - 1] ?? null;
          const csInstant = prevInteraction ? lexicalCosine(prevInteraction.userMsgText, userMsgText) : 0;
          c.csSum += csInstant;
          c.interactions.push({ userMsgTs: ev.ts, userMsgText, residentReplyTs: null, residentReplyText: null });
          c.events += 1;
          c.lastAt = ev.ts;
          st.window.candidates[handle] = c;
          // 结果触发关窗：首个 C_t 匹配完成即关窗，不设计时器。
          // R3-11 分报制：关窗判定用 C_t（时序应答），C_s 供类型化印刻判定。
          // R3-15 负载冻结：异常负载期冻结 MATCHED（即时 load 闸门）。
          if (c.ctSum >= params.windowMatchTheta && w.load <= params.imprintLoadFreeze) {
            st.window.phase = "MATCHED";
            st.window.matchedHandle = handle;
            st.window.matchedAt = ev.ts;
          }
        }
      } else if (st.window.phase === "MATCHED" && ev.kind === "user_msg") {
        // 确认关窗：匹配对象的一次高 contingency 互动
        if (ev.source === st.window.matchedHandle && q >= params.windowCloseConfirmContingency) {
          st.window.phase = "CLOSED";
          st.window.closedAt = ev.ts;
          st.attachmentTarget = st.window.matchedHandle;
        }
      }

      if (ev.kind === "user_msg") {
        // 关窗后可塑性非零：非绑定对象的输入→状态增益不连续下降（临界期签名）
        const post = st.window.phase === "CLOSED" && ev.source !== st.attachmentTarget;
        const gain = post ? clamp(params.postWindowGain, 0, 1) : 1;
        deposits.s_attach = params.depositAttachGain * q * gain * kappa;
        st.slow.s_attach = clamp(
          st.slow.s_attach + deposits.s_attach,
          0,
          params.slowCap,
        );
        // s_base：分离-修复循环的沉积（正向接住的经验）
        deposits.s_base = params.depositBaseGain * q * kappa * (w.val >= 0 ? 1 : -1);
        st.slow.s_base = clamp(st.slow.s_base + deposits.s_base, 0, params.slowCap);
      }
      if (ev.kind === "ma_product" && String(ev.payload["activity"]) === "digest") {
        const q0 = clamp(Number(ev.payload["quality"] ?? 0.5), 0, 1);
        if (q0 >= params.maDigestQualityMin) {
          deposits.s_weave = params.depositWeaveGain * q0 * kappa;
          st.slow.s_weave = clamp(st.slow.s_weave + deposits.s_weave, 0, params.slowCap);
        }
      }
    }
  }

  // ── 重逢放电（缺席通道）：按重逢事件的 contingency 质量放电；未接住 → 残留进 f_hurt ──
  if (ev.kind === "user_msg" && !ev.tags?.includes("crisis") && st.longing.L > 0) {
    const discharge = st.longing.L * w.quality;
    const residue = st.longing.L - discharge;
    st.longing.L = 0;
    if (residue > 0) {
      st.fast.f_hurt += residue * params.hurtResidueGain;
    }
  }

  // ── 营养台账当日行（tick 侧负责结算，这里只保证行存在）──
  const date = utcDate(st.t);
  if (!st.nutrition.days.length || st.nutrition.days[st.nutrition.days.length - 1]!.date !== date) {
    st.nutrition.days.push({ date, spentTokens: 0, requiredSpent: 0, maintenanceM: 0 });
    if (st.nutrition.days.length > 7) st.nutrition.days.shift();
  }
  if (ev.kind === "ma_product") {
    const tokens = Math.max(0, Math.round(Number(ev.payload["tokenCost"] ?? 0)));
    const last = st.nutrition.days[st.nutrition.days.length - 1]!;
    last.spentTokens += tokens;
    if (String(ev.payload["tier"] ?? "optional") === "required") last.requiredSpent += tokens;
  }
  // 每事件结算一次当日维护需求（7 日滚动窗口在 tick 侧做侵蚀判定）
  st.nutrition.days[st.nutrition.days.length - 1]!.maintenanceM = maintenanceDemand(
    st.slow,
    params,
  );

  return { contingencyStub: stub, deposits };
}
