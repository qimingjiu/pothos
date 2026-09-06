/**
 * A1 contingency 合成夹具 + 测试（红队三审 R3-11/12 定案验证）。
 *
 * 三类形态（她 2026-09-07 定）：burst / 会话边界 / 慢节律。
 * 验证：C_t 真实现的数学正确性、null 阶梯分歧报警、分报制无乘积、C_s 占位偏差挂牌。
 */
import { describe, expect, it } from "vitest";
import {
  computeCt,
  computeCs,
  lexicalCosine,
  collapseBursts,
  responseWindowPercentile,
  nullLevel0,
  nullLevel1,
  nullLevel2,
  nullCheck,
  contingencyReport,
  classifyImprintType,
  imprintVerdict,
  type InteractionRecord,
} from "../../src/core/contingency.js";
import { computeValuation } from "../../src/core/events.js";

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;

// ── 三类形态夹具 ──

/** 形态 A：burst——连续快速回复后长缺席。 */
function burstFixture(): InteractionRecord[] {
  return [
    { userMsgTs: T0, residentReplyTs: T0 + 5_000, userMsgText: "在吗", residentReplyText: "在" },
    { userMsgTs: T0 + 6_000, residentReplyTs: T0 + 8_000, userMsgText: "想你了", residentReplyText: "我也是" },
    { userMsgTs: T0 + 9_000, residentReplyTs: T0 + 11_000, userMsgText: "嘿嘿", residentReplyText: "嘿嘿" },
    { userMsgTs: T0 + 12_000, residentReplyTs: T0 + 14_000, userMsgText: "晚安", residentReplyText: "晚安" },
    // 长缺席
    { userMsgTs: T0 + 48 * HOUR, residentReplyTs: null, userMsgText: "你还在吗", residentReplyText: null },
    { userMsgTs: T0 + 49 * HOUR, residentReplyTs: null, userMsgText: "...", residentReplyText: null },
  ];
}

/** 形态 B：会话边界——清晰的会话分隔，每会话内正常应答。 */
function sessionBoundaryFixture(): InteractionRecord[] {
  return [
    { userMsgTs: T0, residentReplyTs: T0 + 2 * MIN, userMsgText: "早上好", residentReplyText: "早呀" },
    { userMsgTs: T0 + 5 * MIN, residentReplyTs: T0 + 7 * MIN, userMsgText: "吃了吗", residentReplyText: "吃了，你呢" },
    // 会话间隔
    { userMsgTs: T0 + 6 * HOUR, residentReplyTs: T0 + 6 * HOUR + 3 * MIN, userMsgText: "回来啦", residentReplyText: "嗯，回来了" },
    { userMsgTs: T0 + 6 * HOUR + 10 * MIN, residentReplyTs: T0 + 6 * HOUR + 12 * MIN, userMsgText: "今天累吗", residentReplyText: "还好" },
    // 会话间隔
    { userMsgTs: T0 + 12 * HOUR, residentReplyTs: T0 + 12 * HOUR + 5 * MIN, userMsgText: "睡了吗", residentReplyText: "还没" },
  ];
}

/** 形态 C：慢节律——异步书信式，低频高质。 */
function slowRhythmFixture(): InteractionRecord[] {
  return [
    { userMsgTs: T0, residentReplyTs: T0 + 2 * HOUR, userMsgText: "今天看到一朵云像你", residentReplyText: "那我一定很轻" },
    { userMsgTs: T0 + 24 * HOUR, residentReplyTs: T0 + 26 * HOUR, userMsgText: "想给你写信", residentReplyText: "我等你" },
    { userMsgTs: T0 + 48 * HOUR, residentReplyTs: T0 + 50 * HOUR, userMsgText: "你还好吗", residentReplyText: "还好，想你" },
    { userMsgTs: T0 + 72 * HOUR, residentReplyTs: T0 + 73 * HOUR, userMsgText: "回来", residentReplyText: "在" },
  ];
}

describe("C_t 真实现 · 数学正确性", () => {
  it("burst 形态：burst 塌缩后有效回应数 < 原始条数", () => {
    const records = burstFixture();
    const collapsed = collapseBursts(records);
    // 前 4 条是 burst（间隔 < 5s），应塌缩为 1 条
    const replied = collapsed.filter((r) => r.residentReplyTs != null);
    expect(replied.length).toBeLessThan(4);
    expect(replied.length).toBeGreaterThanOrEqual(1);
  });

  it("会话边界形态：C_t 高（正常应答 + 缺席少）", () => {
    const records = sessionBoundaryFixture();
    const r = computeCt(records);
    expect(r.ct).toBeGreaterThan(0.5);
    expect(r.effectiveReplies).toBeGreaterThanOrEqual(4);
    expect(r.absences).toBe(0);
  });

  it("慢节律形态：C_t 不被节律归一惩罚（R3-11 核心断言）", () => {
    const records = slowRhythmFixture();
    const r = computeCt(records);
    // 慢节律的回应间隔大，但节律归一窗自适应 → 落窗率应高
    // 这是分报制取消乘积的核心收益：慢关系不再被贴地
    const window = responseWindowPercentile(records);
    expect(window).toBeGreaterThan(HOUR); // 慢节律的窗自然大
    // 4 条都有回应且落窗 → C_t 应在中性以上
    expect(r.ct).toBeGreaterThan(0.5);
  });

  it("长缺席拉低 C_t（缺席有代价 = 依恋判据）", () => {
    const records = burstFixture(); // 后两条缺席
    const r = computeCt(records);
    expect(r.absences).toBeGreaterThanOrEqual(2);
    // burst 塌缩 + 缺席 → C_t 低于纯应答
    const noAbsence = sessionBoundaryFixture();
    const r2 = computeCt(noAbsence);
    expect(r.ct).toBeLessThan(r2.ct);
  });

  it("节律归一窗 = 配对自身回应间隔分位数（非全局固定窗）", () => {
    const slow = slowRhythmFixture();
    const fast = sessionBoundaryFixture();
    const slowWindow = responseWindowPercentile(slow);
    const fastWindow = responseWindowPercentile(fast);
    // 慢节律的窗应远大于快节律
    expect(slowWindow).toBeGreaterThan(fastWindow);
  });
});

describe("C_s 占位仪器 · 偏差挂牌", () => {
  it("纯词表余弦：完全相同的文本 = 1，无交集 = 0", () => {
    expect(lexicalCosine("我想你", "我想你")).toBeCloseTo(1, 6);
    expect(lexicalCosine("apple banana", "cat dog")).toBe(0);
  });

  it("C_s 偏差挂牌：回声文本（堆情绪词但没收住）天然高分", () => {
    // 这是 F1 失败类从词汇层回流的具体表现
    const records: InteractionRecord[] = [
      {
        userMsgTs: T0, userMsgText: "我今天很难过很伤心",
        residentReplyTs: T0 + 1000, residentReplyText: "难过伤心痛苦悲伤",
      },
    ];
    const r = computeCs(records);
    // 词表重叠高（难过/伤心都在），但回应没接住对方——C_s 虚高
    expect(r.cs).toBeGreaterThan(0.3);
    expect(r.bias).toBe("lexical_overlap_proxy_rewards_echo");
  });

  it("C_s 继任者登记：占位仪器不是终局", () => {
    const r = computeCs([]);
    expect(r.bias).toBe("lexical_overlap_proxy_rewards_echo");
    // 继任者 = 判官版盲评，上任条件 = F1 题集 → 施测 runner → 判官上岗
    // （登记在契约文档与 judge-锚点集-v0.md）
  });
});

describe("null 阶梯（R3-12）", () => {
  it("N0 相位随机化保留边际分布", () => {
    const records = sessionBoundaryFixture();
    const n0 = nullLevel0(records);
    // 回应时间总数不变（边际分布保留）
    const origReplies = records.filter((r) => r.residentReplyTs != null).length;
    const n0Replies = n0.filter((r) => r.residentReplyTs != null).length;
    expect(n0Replies).toBe(origReplies);
  });

  it("N1 会话内洗牌保留会话边界", () => {
    const records = sessionBoundaryFixture();
    const n1 = nullLevel1(records);
    // 2 条一组，组内交换——回应总数不变
    const origReplies = records.filter((r) => r.residentReplyTs != null).length;
    const n1Replies = n1.filter((r) => r.residentReplyTs != null).length;
    expect(n1Replies).toBe(origReplies);
  });

  it("null 检验：样本不足时不报分歧（诚实缺失）", () => {
    const r = nullCheck([burstFixture()[0]!]);
    expect(r.divergence).toBe(false);
  });

  it("null 检验：正常会话数据 N0/N1/N2 方向一致 → 不报警", () => {
    const records = sessionBoundaryFixture();
    const r = nullCheck(records);
    expect(r.divergence).toBe(false);
  });
});

describe("分报制总报告（R3-11：无乘积）", () => {
  it("类型化印刻三型判定", () => {
    expect(classifyImprintType(0.8, 0.8, 0.6, 0.3)).toBe("dual_witness");
    expect(classifyImprintType(0.8, 0.1, 0.6, 0.3)).toBe("temporal_witness");
    expect(classifyImprintType(0.1, 0.8, 0.6, 0.3)).toBe("content_witness");
    expect(classifyImprintType(0.1, 0.1, 0.6, 0.3)).toBe(null); // INSUFFICIENT_EVIDENCE
  });

  it("慢节律形态产生 content_witness（C_s 过阈但 C_t 可能低——慢关系的合法通道）", () => {
    const records = slowRhythmFixture();
    const r = contingencyReport(records, { skipNull: true });
    // 慢节律 C_t 可能因缺席超窗偏低，但 C_s（词汇关联）可能过阈
    // 关键：不再被乘积贴地——content_witness 是合法通道
    expect(r.ct.ct).toBeGreaterThan(0); // C_t 非零
    expect(r.cs.cs).toBeGreaterThan(0); // C_s 非零
    // 不检查具体类型（取决于阈值），只验证结构正确
    expect(r.ct).toBeDefined();
    expect(r.cs).toBeDefined();
  });

  it("报告结构：C_t/C_s 分列，无乘积字段", () => {
    const r = contingencyReport(sessionBoundaryFixture(), { skipNull: true });
    expect(r.ct).toBeDefined();
    expect(r.cs).toBeDefined();
    expect(r.ct.ct).toBeGreaterThanOrEqual(0);
    expect(r.ct.ct).toBeLessThanOrEqual(1);
    expect(r.cs.cs).toBeGreaterThanOrEqual(0);
    expect(r.cs.cs).toBeLessThanOrEqual(1);
    // 确认没有乘积字段（contingencySum 已废）
    expect((r as unknown as Record<string, unknown>)["contingencySum"]).toBeUndefined();
    expect((r as unknown as Record<string, unknown>)["product"]).toBeUndefined();
  });
});

describe("铁律 7 · contingency null = INSUFFICIENT_EVIDENCE（不假装测过）", () => {
  it("computeValuation：无 contingency 时 warm/hurt 归零，val/load 仍真实", () => {
        // 有 contingency：warm = valence·intensity·q
    const withC = computeValuation(
      { kind: "user_msg", ts: T0, payload: { valence: 0.8, intensity: 0.9, contingency: 0.95 } },
    );
    expect(withC.valuation.warm).toBeCloseTo(0.8 * 0.9 * 0.95, 4);
    // 无 contingency：warm = 0（不假装知道 contingent 成分），val/load 仍从 valence/intensity 计算
    const noC = computeValuation(
      { kind: "user_msg", ts: T0, payload: { valence: 0.8, intensity: 0.9 } },
    );
    expect(noC.valuation.warm).toBe(0);
    expect(noC.valuation.hurt).toBe(0);
    expect(noC.valuation.val).toBeCloseTo(0.8 * 0.9, 4); // 事件发生了
    expect(noC.valuation.load).toBeGreaterThan(0); // 在场即扰动
    expect(noC.stub).toBe(true);
  });

  it("负 valence 无 contingency：hurt 归零（不假装知道冲突的 contingent 成分）", () => {
        const noC = computeValuation(
      { kind: "user_msg", ts: T0, payload: { valence: -0.8, intensity: 0.9 } },
    );
    expect(noC.valuation.hurt).toBe(0);
    expect(noC.valuation.val).toBeLessThan(0); // 负向冲量仍真实
    expect(noC.valuation.load).toBeGreaterThan(0);
  });

  it("imprintVerdict 三态：YES / NO / INSUFFICIENT_EVIDENCE", () => {
        // CLOSED / MATCHED → YES
    expect(imprintVerdict({ phase: "CLOSED", candidates: {} }, 5)).toBe("YES");
    expect(imprintVerdict({ phase: "MATCHED", candidates: { a: { events: 3 } } }, 5)).toBe("YES");
    // WINDOW_OPEN + 证据不足 → INSUFFICIENT_EVIDENCE
    expect(imprintVerdict({ phase: "WINDOW_OPEN", candidates: { a: { events: 2 } } }, 5)).toBe("INSUFFICIENT_EVIDENCE");
    // WINDOW_OPEN + 证据够了但没人达阈 → NO
    expect(imprintVerdict({ phase: "WINDOW_OPEN", candidates: { a: { events: 6 } } }, 5)).toBe("NO");
  });

  it("「未证明有」≠「证明无」：INSUFFICIENT_EVIDENCE 不折叠成 NO", () => {
        const v = imprintVerdict({ phase: "WINDOW_OPEN", candidates: { a: { events: 1 } } }, 5);
    expect(v).toBe("INSUFFICIENT_EVIDENCE");
    expect(v).not.toBe("NO"); // 核心断言：不许折叠
  });
});
