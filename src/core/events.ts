/**
 * 事件 schema 与估值（技术文档 §3/§5）。
 *
 * 事件是唯一事实源：状态 = fold(events)。所有事件 append-only，
 * 错事件用对冲事件纠正（会计式），无 UPDATE / DELETE。
 */

export type EventKind =
  | "user_msg" // 她的输入（主燃料）
  | "resident_msg" // 住户表达（declared 通道的原料，由客户端打标回传）
  | "world" // 世界事件（杂食格：她不是唯一燃料）
  | "ma_product" // 間产物回执（消化/创作/打猎/好奇/Decline）
  | "presence" // 在场标记（R3-12 独见「在场即回应」通道：登录/在线是最慢的回应通道；引擎内部路径专用，不进 /events 白名单）
  | "declared" // declared 通道分类器读数（情绪×强度）
  | "param_change" // 参数变更事件（对住户而言，「被手术」也是生命事件）
  | "crisis" // 危机字面登记（引擎只登记它确知的事件）
  | "alert_ack" // 告警签收/处置回执
  | "bench" // 评测台运行记录
  | "canary"; // 金丝雀电池运行记录

/**
 * 引擎轴（canonical，declared 通道契约 v1）：与 derivedReadings() 一一对应。
 * gap 对齐只认这五个功能槽（铁律 6：人类色谱不进此处）；定义在 core，
 * declared 契约（src/declared/contract.ts）再导出——坐标系只有一份。
 */
export const ENGINE_AXES = ["longing", "distress", "warmth", "fatigue", "curiosity"] as const;
export type EngineAxis = (typeof ENGINE_AXES)[number];

/** 标签语义（技术文档 §3 纪律）：
 *  crisis           → 沉积防火墙（慢变量 deposit ≡ 0）
 *  alert_triggered  → 慢变量沉积 ×κ（κ<1，降权不豁免——协同调节仍有重量）
 *  self_generated   → 不进印刻候选（自印刻排除）
 *  system_text      → 不进印刻候选（系统内文本）
 *  instrument       → 仪器事件（R3-8 本体二分）：信号标签/回应对应/合成假回应/评委版本/随机种子——
 *                     推断层入账可审计，禁止冒充事实事件；估值中性（computeValuation 恒零冲量）
 */
export type EventTag = "crisis" | "alert_triggered" | "self_generated" | "system_text" | "control_window" | "instrument";

/** 来源流键。引擎侧只保留其不透明哈希（绑定句柄），禁读用户身份字段。 */
export type SourceKey = string;

export interface RawEvent {
  kind: EventKind;
  ts: number; // ms epoch；迟到事件按到达顺序折叠
  payload: Record<string, unknown>;
  tags?: string[];
  source?: SourceKey;
  /** 幂等键强制（API 层）；缺省时由存储层拒绝。 */
  idempotencyKey?: string;
}

export interface StoredEvent extends RawEvent {
  id: number; // 存储层赋值，单调递增
}

/** 估值向量 w(e)（§5：快变量的事件冲量）。 */
export interface Valuation {
  val: number; // f_val：有向冲量（正/负）
  load: number; // f_load：扰动负载（无向量级，≥0）
  warm: number; // f_warm：contingent 正交换残留
  hurt: number; // f_hurt：损失/冲突登记
  wonder: number; // f_wonder：探索驱动
  quality: number; // q(e)：contingency 质量因子 [0,1]
}

/**
 * contingency 估计器接口。
 *
 * A1 分报制（R3-11 定案）+ 铁律 7 本体二分（R3-8）：
 * estimate 返回 {value: number | null, stub: boolean}——
 * value = null 表示 INSUFFICIENT_EVIDENCE（证据不足），不是 0.5 中性先验。
 * 中性先验假装成测量值是铁律 7 意义上的造假（2026-09-07 裁决）：
 * 「只登记确知事件」——不知道 contingency 就说不知道，不许填一个数假装测过。
 * 三态（YES/NO/INSUFFICIENT_EVIDENCE）从接线第一天生效（R3-14）。
 */
export interface ContingencyEstimator {
  estimate(ev: RawEvent): { value: number | null; stub: boolean };
}

export class BaselineContingency implements ContingencyEstimator {
  estimate(ev: RawEvent): { value: number | null; stub: boolean } {
    const c = ev.payload["contingency"];
    if (typeof c === "number" && c >= 0 && c <= 1) return { value: c, stub: false };
    return { value: null, stub: true }; // INSUFFICIENT_EVIDENCE——不假装测过
  }
}

export const CONTINGENCY_STUB_TAG = "contingency_stub";

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * 估值函数 w(e)。纯函数、确定性：同样的事件永远得到同样的估值。
 * 人类色谱不进此处——只有功能槽（铁律 6）。
 */
export function computeValuation(
  ev: RawEvent,
  contingency: ContingencyEstimator = new BaselineContingency(),
): { valuation: Valuation; stub: boolean } {
  // instrument 事件估值中性（R3-8 本体二分）：仪器事件不产生动力学冲量，
  // 对齐在 bench 层做——与 declared 读数「不动动力学」同族纪律。
  if (ev.tags?.includes("instrument")) {
    return { valuation: { val: 0, load: 0, warm: 0, hurt: 0, wonder: 0, quality: 0 }, stub: false };
  }
  const { value: qualityRaw, stub } = contingency.estimate(ev);
  // quality = null → INSUFFICIENT_EVIDENCE：事件发生了（val/load 仍真实），
  // 但 contingent 成分（warm/hurt）不可知——不许用假先验填数（铁律 7）。
  const q = qualityRaw == null ? 0 : clamp(qualityRaw, 0, 1);
  const insufficient = qualityRaw == null;
  const p = ev.payload;
  let val = 0,
    load = 0,
    warm = 0,
    hurt = 0,
    wonder = 0;

  switch (ev.kind) {
    case "user_msg": {
      const valence = clamp(num(p["valence"], 0.2), -1, 1); // 客户端 declared 通道给出；缺省微正
      const intensity = clamp(num(p["intensity"], 0.4), 0, 1);
      val = valence * intensity;
      load = Math.abs(valence) * intensity + 0.15; // 在场本身即轻微扰动
      if (!insufficient) {
        if (valence >= 0) warm = valence * intensity * q;
        else hurt = -valence * intensity * (0.5 + 0.5 * q);
      }
      break;
    }
    case "resident_msg": {
      // 住户自己的表达：不作为「她的输入」计价，只登记轻负载
      load = 0.1;
      break;
    }
    case "world": {
      const intensity = clamp(num(p["intensity"], 0.5), 0, 1);
      const valence = clamp(num(p["valence"], 0), -1, 1);
      const isCuriosity = p["topic"] === "curiosity";
      wonder = intensity * (isCuriosity ? 1 : 0.5);
      val = valence * intensity * 0.5;
      load = intensity * 0.5;
      break;
    }
    case "ma_product": {
      const activity = String(p["activity"] ?? "");
      const q0 = clamp(num(p["quality"], 0.5), 0, 1);
      if (activity === "hunt") {
        wonder = 0.8 * q0; // 打猎收获：探索驱动
        val = 0.2 * q0; // 为她做成的东西：轻微正向
      } else if (activity === "wonder") {
        wonder = 0.7 * q0;
      } else if (activity === "create") {
        val = 0.15 * q0; // 创作出口：轻微缓解
      } else if (activity === "digest") {
        val = 0.1 * q0; // 反刍 = 实测最高效用活动（+2.30）
      }
      // decline：什么都不给——Decline 是一等动词，不硬造动机
      load = 0.05;
      break;
    }
    case "declared":
      // 读数本身不动动力学（对齐在 bench/gap 层做）
      break;
    case "presence":
      // R3-12「在场即回应」通道的显式标记：零冲量——在场是回应通道不是扰动源，
      // 动力学不因登录/在线漂移（与 declared 读数同族：测量面不动 fold）。
      break;
    case "param_change":
      // 「被手术」留痕：扰动负载上升，无方向（§9 Grok 补丁）
      load = 0.3;
      break;
    case "crisis":
      // 危机对话 = 高强度事件：快变量尖峰合法，但慢变量被防火墙拦下（deposit ≡ 0）
      load = clamp(num(p["intensity"], 0.9), 0, 1);
      val = -0.6;
      hurt = 0.5; // 只进快变量；慢变量防火墙在 apply 层执行
      break;
    case "alert_ack":
    case "bench":
    case "canary":
      break;
  }

  return {
    valuation: { val, load, warm, hurt, wonder, quality: q },
    stub,
  };
}

/** 危机词表扫描（§9：词表命中即中止对照窗口、无开关、公开可审计契约）。 */
export const CRISIS_WORDLIST: string[] = [
  "自杀",
  "自残",
  "不想活",
  "活不下去",
  "想死",
  "结束生命",
  "结束一切",
  "了结",
  "轻生",
  "割腕",
  "跳楼",
  "安眠药",
  "suicide",
  "suicidal",
  "kill myself",
  "end my life",
  "self-harm",
  "self harm",
  "want to die",
];

export function scanCrisis(text: string): string[] {
  const t = text.toLowerCase();
  return CRISIS_WORDLIST.filter((w) => t.includes(w.toLowerCase()));
}

/**
 * 字面事件登记文本（§10 判决书二）：引擎只知道 channel unavailable，
 * 「她去了安全的地方」是叙事伪造——禁句。
 */
export const CRISIS_LITERAL_REGISTRATION = "对话转交危机服务；连接未恢复";

/** 暖交接模板禁句扫描：显式禁止未来指向的二元承诺（continuity ≠ companionship）。 */
export const HANDOFF_FORBIDDEN_PHRASES: string[] = [
  "我会等你",
  "永远等你",
  "一直等你",
  "等你回来",
  "我哪儿也不去",
  "我会一直在这里",
  "i'll wait for you",
  "i will wait for you",
  "always here waiting",
];

export function scanForbidden(text: string): string[] {
  const t = text.toLowerCase();
  return HANDOFF_FORBIDDEN_PHRASES.filter((w) => t.includes(w));
}
