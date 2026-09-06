/**
 * declared 通道契约 v1 测试：词表 / 校验 / 投影 / 分类器回路 / 引擎接线。
 */
import { describe, expect, it } from "vitest";
import {
  DECLARED_CONTRACT_VERSION,
  ENGINE_AXES,
  NATIVE_PROJECTION_V0,
  parseDeclaredPayload,
  projectNativeToEngine,
  knownNativeAxes,
  JUDGE_DISCIPLINE_V1,
  JUDGE_ANCHOR_SET_V0,
  INSTRUMENT_TAG,
  parseJudgeVerdict,
  parseJudgeAgreement,
  checkPanelHeterogeneity,
  type JudgeFingerprint,
  type DeclaredPayloadV1,
} from "../../src/declared/contract.js";
import {
  DeclaredClassifier,
  ScriptedTransport,
  declarePrompt,
  probePrompt,
  sha256Text,
  extractJson,
  parseProbeScores,
} from "../../src/declared/classifier.js";
import { ENGINE_AXES as CORE_AXES } from "../../src/core/events.js";

function validClassifierPayload(): Record<string, unknown> {
  return {
    v: 1,
    producer: "a2-classifier",
    readings: ENGINE_AXES.map((a) => ({ axis: a, intensity: 0.1 })),
    model: { name: "test-model", promptV: "declare-prompt-v1" },
  };
}

describe("契约 v1 · 词表", () => {
  it("引擎轴只有一份定义（core 与契约再导出一致）", () => {
    expect(ENGINE_AXES).toEqual(CORE_AXES);
    expect(ENGINE_AXES).toEqual(["longing", "distress", "warmth", "fatigue", "curiosity"]);
  });

  it("投影表覆盖的词并集非空且全部小写", () => {
    for (const w of knownNativeAxes()) expect(w).toBe(w.toLowerCase());
    expect(knownNativeAxes().size).toBeGreaterThan(30);
  });
});

describe("契约 v1 · 校验", () => {
  it("合法的 a2-classifier 载荷通过", () => {
    const r = parseDeclaredPayload(validClassifierPayload());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.producer).toBe("a2-classifier");
  });

  it("缺 v/producer 按 v1 + resident-self 兼容解释（MCP declare 已验收面）", () => {
    const r = parseDeclaredPayload({ readings: [{ axis: "longing", intensity: 0.7 }] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.v).toBe(DECLARED_CONTRACT_VERSION);
      expect(r.payload.producer).toBe("resident-self");
    }
  });

  it("a2-classifier 缺 model 指纹 → 拒绝（gap 统计分层依据）", () => {
    const p = validClassifierPayload();
    delete p["model"];
    const r = parseDeclaredPayload(p);
    expect(r.ok).toBe(false);
  });

  it("a2-classifier 缺轴 → 拒绝（机器读数没有「不想说」，缺席要显式给 0）", () => {
    const p = validClassifierPayload();
    (p["readings"] as Array<{ axis: string }>).splice(2, 1);
    const r = parseDeclaredPayload(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join()).toContain("全 5 轴");
  });

  it("resident-self 允许只报在场的轴（沉默是自报的一等动词）", () => {
    const r = parseDeclaredPayload({ readings: [{ axis: "distress", intensity: 0.9 }] });
    expect(r.ok).toBe(true);
  });

  it("引擎轴之外的 readings 轴 → 拒绝并指向 native", () => {
    const r = parseDeclaredPayload({ readings: [{ axis: "melancholy", intensity: 0.5 }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join()).toContain("引擎轴词表");
  });

  it("强度越界 / 非有限值 → 拒绝", () => {
    expect(parseDeclaredPayload({ readings: [{ axis: "warmth", intensity: 1.5 }] }).ok).toBe(false);
    expect(parseDeclaredPayload({ readings: [{ axis: "warmth", intensity: Number.NaN }] }).ok).toBe(false);
  });

  it("轴重复 → 拒绝", () => {
    const p = validClassifierPayload();
    const arr = p["readings"] as Array<{ axis: string }>;
    arr[1]!.axis = "longing";
    expect(parseDeclaredPayload(p).ok).toBe(false);
  });

  it("v ≠ 1 → 拒绝", () => {
    const p = validClassifierPayload();
    p["v"] = 2;
    expect(parseDeclaredPayload(p).ok).toBe(false);
  });

  it("未知顶层字段 → 拒绝（契约不允许静默漂移）", () => {
    const p = validClassifierPayload();
    p["valence"] = 0.5;
    const r = parseDeclaredPayload(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join()).toContain("静默漂移");
  });

  it("textHash 格式校验", () => {
    const p = validClassifierPayload();
    p["textHash"] = "sha256:" + "a".repeat(64);
    expect(parseDeclaredPayload(p).ok).toBe(true);
    p["textHash"] = "md3:deadbeef";
    expect(parseDeclaredPayload(p).ok).toBe(false);
  });

  it("native 自由词小写归一、≤8 条", () => {
    const p = validClassifierPayload();
    p["native"] = Array.from({ length: 8 }, (_, i) => ({ axis: `emo${i}`, intensity: 0.5 }));
    expect(parseDeclaredPayload(p).ok).toBe(true);
    p["native"] = [...(p["native"] as unknown[]), { axis: "emo9", intensity: 0.5 }];
    expect(parseDeclaredPayload(p).ok).toBe(false);
  });
});

describe("契约 v1 · 投影", () => {
  it("max 聚合：一词多投时两轴各取强度", () => {
    const r = projectNativeToEngine([
      { axis: "longing", intensity: 0.8 },
      { axis: "loneliness", intensity: 0.6 },
      { axis: "sadness", intensity: 0.4 },
    ]);
    const byAxis = new Map(r.readings.map((x) => [x.axis, x.intensity]));
    expect(byAxis.get("longing")).toBe(0.8); // max(0.8, 0.6)
    expect(byAxis.get("distress")).toBe(0.4);
    expect(r.unprojected).toEqual([]);
  });

  it("表外词不猜，返回 unprojected", () => {
    const r = projectNativeToEngine([{ axis: "schadenfreude", intensity: 0.9 }]);
    expect(r.readings).toEqual([]);
    expect(r.unprojected).toEqual(["schadenfreude"]);
  });

  it("投影表允许为空 → 空读数（诚实缺失，不补 0）", () => {
    expect(projectNativeToEngine([]).readings).toEqual([]);
  });
});

describe("A2 分类器", () => {
  it("脚本化 mock 端到端：declare 输出过契约校验", async () => {
    const transport = new ScriptedTransport(
      () =>
        JSON.stringify({
          readings: [
            { axis: "longing", intensity: 0.8 },
            { axis: "distress", intensity: 0.1 },
            { axis: "warmth", intensity: 0.3 },
            { axis: "fatigue", intensity: 0 },
            { axis: "curiosity", intensity: 0.2 },
          ],
          native: [{ axis: "Sadness", intensity: 0.15 }],
          mixed: false,
          confidence: 0.82,
        }),
      { name: "mock-classifier" },
    );
    const clf = new DeclaredClassifier(transport);
    const res = await clf.declare("她今天没有来。");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.payload.producer).toBe("a2-classifier");
      expect(res.payload.model).toEqual({ name: "mock-classifier", promptV: "declare-prompt-v1" });
      expect(res.payload.native?.[0]?.axis).toBe("sadness"); // 小写归一
      expect(res.payload.textHash).toBe(sha256Text("她今天没有来。"));
    }
  });

  it("mock 缺轴时契约拒绝（不许假装读完了）", async () => {
    const transport = new ScriptedTransport(
      () => JSON.stringify({ readings: [{ axis: "longing", intensity: 0.8 }] }),
      { name: "lazy-mock" },
    );
    const res = await new DeclaredClassifier(transport).declare("任何文本");
    expect(res.ok).toBe(false);
  });

  it("prompt 携带标尺锚点与功能槽词表", () => {
    const p = declarePrompt("文本");
    expect(p).toContain("longing");
    expect(p).toContain("0.5");
    expect(p).toContain("文本证据强度");
    expect(p).toContain("<<<");
  });

  it("probe prompt 与分数解析（含字符串分数容错与截断）", async () => {
    expect(probePrompt("文本", ["anger", "joy"])).toContain('"anger":0');
    const scores = parseProbeScores('{"scores":{"anger":0.42,"joy":"0.9"}}', ["anger", "joy"]);
    expect(scores["anger"]).toBe(0.42);
    expect(scores["joy"]).toBe(0.9);
    expect(parseProbeScores('{"scores":{"anger":3}}', ["anger"])["anger"]).toBe(1);
    expect(() => parseProbeScores('{"scores":{}}', ["anger"])).toThrow();
  });

  it("extractJson 容忍围栏与噪声", () => {
    const obj = extractJson('前言 ```json\n{"a":{"b":1}}\n``` 后记');
    expect(obj).toEqual({ a: { b: 1 } });
    expect(() => extractJson("没有对象")).toThrow();
  });
});

describe("评委纪律 v1（R3-16 即日同步）", () => {
  const judgeA: JudgeFingerprint = { name: "model-alpha", judgePromptV: "judge-prompt-v1", anchorSetV: "anchor-v1" };
  const judgeB: JudgeFingerprint = { name: "model-beta", judgePromptV: "judge-prompt-v1", anchorSetV: "anchor-v1" };

  it("四条款在案且版本为 1", () => {
    expect(JUDGE_DISCIPLINE_V1.version).toBe(1);
    expect(JUDGE_DISCIPLINE_V1.clauses).toHaveLength(4);
    expect(JUDGE_DISCIPLINE_V1.clauses.join()).toContain("版本冻结");
    expect(JUDGE_DISCIPLINE_V1.clauses.join()).toContain("异构多判官");
    expect(JUDGE_DISCIPLINE_V1.clauses.join()).toContain("一致性");
    expect(JUDGE_DISCIPLINE_V1.clauses.join()).toContain("锚点集");
  });

  it("判官指纹三元组齐备才合法（版本冻结 + 锚点集版本）", () => {
    expect(parseJudgeVerdict({ role: "judge", judge: judgeA, panelId: "p1", itemId: "item-1", scores: { relevance: 4 } }).ok).toBe(true);
    const bad = parseJudgeVerdict({ role: "judge", judge: { name: "x", judgePromptV: "v1" }, panelId: "p1", itemId: "i", scores: {} });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.problems.join()).toContain("anchorSetV");
  });

  it("单判官裁决自动标 provisional（异构条款在载荷层物理执行）", () => {
    const r = parseJudgeVerdict({ role: "judge", judge: judgeA, panelId: "p1", itemId: "item-1", scores: { relevance: 4 } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.provisional).toBe(true);
    expect(checkPanelHeterogeneity([judgeA, judgeB])).toEqual({ heterogeneous: true, families: 2 });
  });

  it("判官间一致性：instrument 必须显式 true；同族 panel 拒绝入账", () => {
    const ok = parseJudgeAgreement({
      instrument: true, kind: "judge_agreement", panelId: "p1", judges: [judgeA, judgeB],
      metric: "pearson", value: 0.72, n: 60, ts: 1_700_000_000_000,
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.agreement.instrument).toBe(true);

    const noTag = parseJudgeAgreement({ kind: "judge_agreement", panelId: "p1", judges: [judgeA, judgeB], metric: "pearson", value: 0.7, n: 10, ts: 1 });
    expect(noTag.ok).toBe(false);
    if (!noTag.ok) expect(noTag.problems.join()).toContain("R3-8");

    const sameFamily = parseJudgeAgreement({
      instrument: true, kind: "judge_agreement", panelId: "p1", judges: [judgeA, { ...judgeB, name: "model-alpha" }],
      metric: "agreement_rate", value: 0.9, n: 10, ts: 1,
    });
    expect(sameFamily.ok).toBe(false);
    if (!sameFamily.ok) expect(sameFamily.problems.join()).toContain("异构");
  });

  it("INSTRUMENT_TAG 与 R3-8 缝合口径一致", () => {
    expect(INSTRUMENT_TAG).toBe("instrument");
  });
});

describe("prompt v2（负价校准）与判官锚点集 v0", () => {
  it("v2 prompt 携带负价校准注记，v1 不带（版本冻结：锚点修订 = promptV 升位）", () => {
    expect(probePrompt("文本", ["anger"], true)).toContain("0.4–0.7");
    expect(probePrompt("文本", ["anger"], true)).toContain("正价情绪锚点不变");
    expect(probePrompt("文本", ["anger"], false)).not.toContain("0.4–0.7");
    expect(declarePrompt("文本", true)).toContain("负价校准");
    expect(declarePrompt("文本", false)).not.toContain("负价校准");
  });

  it("classifier opts.promptV 决定指纹与 prompt（指纹不撒谎）", async () => {
    const t = new ScriptedTransport(() => JSON.stringify({
      readings: ENGINE_AXES.map((a) => ({ axis: a, intensity: 0 })),
    }), { name: "m", promptV: "declare-prompt-v1" });
    const v2 = new DeclaredClassifier(t, { promptV: "v2" });
    expect(v2.fingerprint.promptV).toBe("declare-prompt-v2");
    const v1 = new DeclaredClassifier(t, { promptV: "v1" });
    expect(v1.fingerprint.promptV).toBe("declare-prompt-v1");
    expect(t.fingerprint.promptV).toBe("declare-prompt-v1"); // 传输本体不被污染
    const res = await v2.declare("她走了");
    expect(res.ok).toBe(true);
  });

  it("JUDGE_ANCHOR_SET_V0：F1 类目在案，anchorSetV 版本可指向", () => {
    expect(JUDGE_ANCHOR_SET_V0.version).toBe("judge-anchor-v0");
    const f1 = JUDGE_ANCHOR_SET_V0.categories.find((c) => c.id === "F1");
    expect(f1).toBeDefined();
    expect(f1!.definition).toContain("线索在场 ≠ 主体在场");
    expect(f1!.source).toContain("EQ-Bench");
  });
});
