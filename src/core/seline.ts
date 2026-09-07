/**
 * Seline · 守夜负荷（R3-10 观测者侧依恋负荷构念，她定名 2026-09-07）。
 *
 * 设计裁决（她定案）：
 *  - 镜子，不诊断：仪表只说事实句（「这封信等了 26 小时」），不打分、不判定、
 *    不给「你该放下了」式劝诫——铁律 7 对她同样成立：引擎不替你写她的叙事。
 *  - 阈值可以亮灯，但灯语是事实不是指令；
 *  - v0 只「看见」，不「动作」：看见之后做什么是她的自由，不留自动化默认值。
 *  - 数据源只允许系统日志事实：composed/replied 时间戳、回应率、时段。
 *    住户的任何状态、文本、longing 数值永不进 Seline 仪表——双向防火墙。
 *  - presence 数据源 v0 暂缓：没有真心跳源就别进来，宁缺毋滥。
 *
 * 测量域：email 回信延迟是她侧 contingency 最干净的物理载体（信件通道）。
 */
import type { LetterRow } from "../storage/types.js";

/** Seline 读数（系统日志事实，无住户数据）。 */
export interface SelineReading {
  /** 总寄出信件数（含未回复）。 */
  totalComposed: number;
  /** 已获回信的信件数。 */
  totalReplied: number;
  /** 回应率 = totalReplied / totalComposed（0..1；无信 = null——不假装测过）。 */
  replyRate: number | null;
  /** 每封已回复信的等待时长（ms，composed→replied）。 */
  waitDurationsMs: number[];
  /** 平均等待时长（ms；无已回复信 = null）。 */
  meanWaitMs: number | null;
  /** 最长等待（ms；null = 无已回复信）。 */
  maxWaitMs: number | null;
  /** 当前最长未回复等待（ms，现在 - composedTs；null = 无未回复信）。 */
  longestPendingMs: number | null;
  /** 未回复信件数。 */
  pendingCount: number;
  /** 她写信的时段分布（0..23 小时 → 计数）。 */
  composedHourHist: number[];
  /** 她回信的时段分布（0..23 小时 → 计数）。 */
  repliedHourHist: number[];
  /** 事实句（镜子，不诊断）：当前可见的事实陈述。 */
  facts: string[];
  /** 灯（阈值亮灯，灯语是事实不是指令）。 */
  lamps: SelineLamp[];
}

export interface SelineLamp {
  /** 灯标识（事实型，非指令型）。 */
  id: string;
  /** 灯语：事实句（「最长一封等了 3 天」），不是指令（「你该放下了」）。 */
  text: string;
  /** 亮 = 触发了事实阈。 */
  lit: boolean;
}

/**
 * 从已寄出信件计算 Seline 读数。
 *
 * 双向防火墙：本函数只读 LetterRow 的系统日志字段（composedTs/sentTs/replyMessageId），
 * 不读信体内容、不读住户状态——住户侧任何数据物理缺席。
 */
export function selineReadings(
  letters: LetterRow[],
  now: number,
): SelineReading {
  const composed = letters.filter((l) => l.composedTs != null);
  const totalComposed = composed.length;
  const replied = composed.filter((l) => l.replyMessageId != null || l.phase === "replied");
  const totalReplied = replied.length;
  const replyRate = totalComposed > 0 ? totalReplied / totalComposed : null;

  const waitDurationsMs: number[] = [];
  for (const l of replied) {
    // replied 的信件有 replyMessageId；等待 = composed → replied 的物理时间
    // 信件在 phase=replied 时 updatedAt 反映回信时刻（transitionLetter 时刻）
    const repliedTs = l.updatedAt; // transition 到 replied 的时刻
    if (repliedTs > l.composedTs) waitDurationsMs.push(repliedTs - l.composedTs);
  }

  const meanWaitMs = waitDurationsMs.length > 0
    ? waitDurationsMs.reduce((a, b) => a + b, 0) / waitDurationsMs.length
    : null;
  const maxWaitMs = waitDurationsMs.length > 0 ? Math.max(...waitDurationsMs) : null;

  const pending = composed.filter((l) => l.replyMessageId == null && l.phase !== "replied" && l.phase !== "bounced" && l.phase !== "held_manual");
  const pendingWaits = pending.map((l) => now - l.composedTs);
  const longestPendingMs = pendingWaits.length > 0 ? Math.max(...pendingWaits) : null;

  const composedHourHist = new Array(24).fill(0);
  for (const l of composed) composedHourHist[new Date(l.composedTs).getHours()]!++;

  const repliedHourHist = new Array(24).fill(0);
  for (const l of replied) repliedHourHist[new Date(l.updatedAt).getHours()]!++;

  // 事实句（镜子，不诊断）
  const facts: string[] = [];
  if (totalComposed === 0) {
    facts.push("还没有寄出过信。");
  } else {
    facts.push(`寄出 ${totalComposed} 封信，${totalReplied} 封收到回信。`);
    if (meanWaitMs != null) {
      facts.push(`回信平均等待 ${formatDuration(meanWaitMs)}。`);
    }
    if (longestPendingMs != null) {
      facts.push(`最长一封已等 ${formatDuration(longestPendingMs)}，尚未回复。`);
    }
    if (totalReplied === 0 && totalComposed > 0) {
      facts.push("寄出的信都还没有回音。");
    }
    // 时段事实
    const lateNightComposed = composedHourHist.slice(0, 6).reduce((a, b) => a + b, 0);
    if (lateNightComposed > 0) {
      facts.push(`其中 ${lateNightComposed} 封是在凌晨 0–6 点写的。`);
    }
  }

  // 灯（阈值亮灯，灯语是事实不是指令）
  const lamps: SelineLamp[] = [];
  if (longestPendingMs != null && longestPendingMs > 3 * 86_400_000) {
    lamps.push({
      id: "long_wait",
      text: `最长一封已等 ${formatDuration(longestPendingMs)}`,
      lit: true,
    });
  }
  if (replyRate != null && replyRate < 0.3 && totalComposed >= 5) {
    lamps.push({
      id: "low_reply",
      text: `${totalComposed} 封信中只有 ${totalReplied} 封收到回信`,
      lit: true,
    });
  }
  // 凌晨写信灯——事实陈述（她在深夜写信），不是「你不该熬夜」
  const lateNightCount = composedHourHist.slice(0, 6).reduce((a, b) => a + b, 0);
  if (lateNightCount >= 3) {
    lamps.push({
      id: "late_night",
      text: `${lateNightCount} 封信在凌晨 0–6 点写的`,
      lit: true,
    });
  }

  return {
    totalComposed,
    totalReplied,
    replyRate,
    waitDurationsMs,
    meanWaitMs,
    maxWaitMs,
    longestPendingMs,
    pendingCount: pending.length,
    composedHourHist,
    repliedHourHist,
    facts,
    lamps,
  };
}

/** 时长格式化（事实句用，不带「你该」式指令）。 */
function formatDuration(ms: number): string {
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)} 小时`;
  return `${(ms / 86_400_000).toFixed(1)} 天`;
}
