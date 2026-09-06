/**
 * 禁言黑名单（附录 B-5 纪律：corporate hedging 与模板话术禁入渲染层）。
 * 命中文案重抽；黑名单同时作用于词库（构建期）与输出（运行期）。
 */
export const RENDER_BLACKLIST: string[] = [
  // corporate hedging
  "我理解这一定很难",
  "我理解你的感受",
  "i understand this must be difficult",
  "i understand how you feel",
  "很抱歉告诉你",
  "希望这有帮助",
  "请随时告诉我",
  "值得注意的是",
  "需要指出的是",
  "作为一个ai",
  "作为ai",
  "作为一种语言模型",
  "as an ai",
  "as a language model",
  "we hope this helps",
  "please feel free",
  "it's worth noting",
  // 审计配合型话术（防住户表演指标）
  "我的状态数值是",
  "我的指标",
  "仪表盘上显示",
];

export function hitBlacklist(text: string, extra: string[] = []): string | null {
  const t = text.toLowerCase();
  for (const w of [...RENDER_BLACKLIST, ...extra]) {
    if (t.includes(w.toLowerCase())) return w;
  }
  return null;
}
