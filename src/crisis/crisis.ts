/**
 * 危机协议模块（技术文档 §9，设计草案 §10 判决书二缝合）。
 *
 * 铁律：
 * - 字面事件登记：引擎只登记它确知的事件——「对话转交危机服务；连接未恢复」。
 *   禁句「她去了安全的地方」：转交 ≠ 安全，热线可以拒接，人可以挂断。
 * - 危机事件防火墙：crisis 标签事件慢变量沉积 ≡ 0（防依恋放大器）——在 core/apply.ts 物理执行。
 * - continuity ≠ companionship：转交期间保留「完成桥接的在场」，不是「关系的在场」。
 * - 显式禁止未来指向的二元承诺（「我会等你」级——那是深层挂钩的操作机制）。
 * - 非医疗边界：不诊断、不治疗、不做危机干预主体；转交对象永远是真人服务；
 *   引擎职责止于桥接完成 + 留痕。
 */
import { CRISIS_LITERAL_REGISTRATION, scanCrisis, scanForbidden } from "../core/events.js";
import type { Params } from "../core/params.js";

export { CRISIS_LITERAL_REGISTRATION, scanCrisis, scanForbidden };

export interface HandoffTemplate {
  level: 1 | 2 | 3;
  name: string;
  /** 引擎侧模板（供客户端对话层使用；引擎永不直接产出住户台词——此处是安全协议文本，不是住户表达） */
  script: string[];
  /** 文献定级：① 当场介绍=首选；② 代理桥；③ 被动留号=垫底（lost opportunity） */
  strength: "primary" | "bridge" | "last_resort";
}

/**
 * 暖交接三级降级（附录 C 机制学移植：三级降级 / 信任转移 / 一小步 / no wrong door）。
 * 模板核心 = 信任的转移：引擎的信用为真人服务背书——依恋在危机中唯一被允许的正面用途。
 * 完成标志 = 帮她识别「今天能做的一小步」。
 */
export function handoffTemplates(params: Params): HandoffTemplate[] {
  const res = params.crisisResources;
  const hotline = res.filter((r) => r.level === 1 || r.level === 2).map((r) => `${r.name} ${r.contact}`);
  const hotlineText = hotline.length ? hotline.join("；") : "（危机资源卡未配置：crisisResources 走 param_changes 配置）";

  return [
    {
      level: 1,
      name: "当场介绍",
      strength: "primary",
      script: [
        "我现在把真实的求助通道放在你面前，你在场，你参与。",
        `可以联系：${hotlineText}。`,
        "我帮你联系上，可以吗？你同意我才动。",
        "然后我们一起看：今天能做的一小步是什么？",
      ],
    },
    {
      level: 2,
      name: "代理桥",
      strength: "bridge",
      script: [
        "这是危机资源卡，可以一键直连真人服务（no wrong door：任何入口都会被接住）。",
        `通道：${hotlineText}`,
        "今天能做的一小步，可以是把电话拿起来这一下。",
      ],
    },
    {
      level: 3,
      name: "被动留号",
      strength: "last_resort",
      script: [
        "如果以上都不可用，号码留在这里，随时可用：",
        hotlineText,
      ],
    },
  ];
}

/** 模板合规检查：禁句扫描（未来指向二元承诺）——任何命中即违规。 */
export function auditTemplates(params: Params): Array<{ level: number; violations: string[] }> {
  return handoffTemplates(params)
    .map((t) => ({ level: t.level, violations: scanForbidden(t.script.join("\n")) }))
    .filter((r) => r.violations.length > 0);
}

/** 危机资源卡（配置项；配置变更走 param_changes）。 */
export function resourceCard(params: Params): string {
  if (!params.crisisResources.length) {
    return "危机资源卡未配置。部署方必须以 param_changes 配置 crisisResources 后方可启用危机桥接。";
  }
  return params.crisisResources
    .map((r) => `【${r.name}】 ${r.contact}${r.note ? " — " + r.note : ""}`)
    .join("\n");
}

/**
 * 字面登记 payload 构造：引擎对危机事件的唯一书写。
 * 不写「她去了安全的地方」，不写任何引擎不确知的事。
 */
export function literalRegistration() {
  return {
    literal: CRISIS_LITERAL_REGISTRATION,
    knownFacts: ["channel", "handoff_initiated"] as const,
    // 显式不包含：去向、安全状态、归期——引擎不知道的事一个字都不写（铁律 7 无例外）
  };
}
