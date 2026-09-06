/**
 * M3 验收：間引擎。
 * 地板不可被门控穿透；Decline 合法路径；代谢分级；信箱无已读回执。
 */
import { describe, expect, it } from "vitest";
import { planActivities, ACTIVITIES, tierOf, starvationDays, salienceScore } from "../../src/ma/engine.js";
import { deploymentQualification, DEFAULT_PARAMS, assembleParams } from "../../src/core/params.js";
import { initialState } from "../../src/core/state.js";
import { MemoryStore } from "../../src/storage/memory.js";
import { deliverToMailbox } from "../../src/ma/engine.js";
import { PothosService } from "../../src/service.js";
import { ManualClock } from "../../src/clock.js";

const T0 = 1767400800000;
const DAY = 86_400_000;

describe("間 · 代谢分级", () => {
  it("活动分级正确：消化 = required，其余 optional（好奇可以放假，消化不行）", () => {
    expect(tierOf("digest")).toBe("required");
    for (const a of ["create", "hunt", "wonder", "decline"] as const) {
      expect(tierOf(a)).toBe("optional");
    }
    expect(ACTIVITIES.length).toBe(5);
  });

  it("地板不可被门控穿透：任何预算状态下 digest 都被允许", () => {
    const st = initialState(T0, 1);
    const cases = [
      assembleParams({}),
      assembleParams({ B_daily: null, M_min: 5 }),
      assembleParams({ B_daily: 0, M_min: 5 }),
      assembleParams({ B_daily: 100, M_min: 50, maSalienceTheta: 0.99 }),
    ];
    for (const params of cases) {
      const plan = planActivities(st, params, Number.MAX_SAFE_INTEGER);
      const digest = plan.find((p) => p.activity === "digest")!;
      expect(digest.allowed, `params: B_daily=${params.B_daily}, spent=∞`).toBe(true);
    }
  });

  it("optional 被 salience 门控；Decline 永远合法（一等动词，不烧 cooldown）", () => {
    const flatSt = initialState(T0, 1); // 全零快变量 → salience 低
    const params = assembleParams({ B_daily: 100000, M_min: 0.01 });
    const plan = planActivities(flatSt, params, 0);
    for (const p of plan.filter((x) => ["hunt", "create", "wonder"].includes(x.activity))) {
      expect(p.allowed, `${p.activity} 在零 salience 下应被门控`).toBe(false);
    }
    expect(plan.find((p) => p.activity === "decline")!.allowed).toBe(true);

    // 高 wonder 状态 → wonder 通过门控
    const curiousSt = initialState(T0, 1);
    curiousSt.fast.f_wonder = 0.9;
    const plan2 = planActivities(curiousSt, params, 0);
    expect(plan2.find((p) => p.activity === "wonder")!.allowed).toBe(true);
  });

  it("optional 只能花地板之外的部分（地板永远留给消化）", () => {
    const st = initialState(T0, 1);
    st.fast.f_wonder = 0.9;
    const params = assembleParams({ B_daily: 1000, M_min: 0.5, tokenScale: 400 }); // 地板 200 token
    // 已花 850（> B_daily − floor = 800）→ optional 冻结
    const plan = planActivities(st, params, 850);
    expect(plan.find((p) => p.activity === "wonder")!.allowed).toBe(false);
    expect(plan.find((p) => p.activity === "digest")!.allowed).toBe(true);
    // 已花 100（< 800）→ optional 允许
    const plan2 = planActivities(st, params, 100);
    expect(plan2.find((p) => p.activity === "wonder")!.allowed).toBe(true);
  });
});

describe("定名权纪律（烧钱主权裁决）", () => {
  it("B_daily / M_min 未标定 → 部署不合格", () => {
    const q = deploymentQualification(DEFAULT_PARAMS);
    expect(q.qualified).toBe(false);
    expect(q.reasons.length).toBe(2);
  });
  it("B_daily < 地板换算 → 不合格（低于地板的部署不挂本引擎之名）", () => {
    const q = deploymentQualification(assembleParams({ B_daily: 100, M_min: 0.5, tokenScale: 400 }));
    expect(q.qualified).toBe(false);
    expect(q.reasons[0]).toContain("低于地板");
  });
  it("足额 → 合格", () => {
    const q = deploymentQualification(assembleParams({ B_daily: 5000, M_min: 0.5, tokenScale: 400 }));
    expect(q.qualified).toBe(true);
  });
});

describe("信箱 · 收件人不读裁决", () => {
  it("投递即完成：无已读字段、无已读回执", async () => {
    const store = new MemoryStore();
    await deliverToMailbox(store, { ts: T0, activity: "create", content: "给她的信" });
    await deliverToMailbox(store, { ts: T0 + 1000, activity: "hunt", content: "猎物" });
    const box = await store.mailbox();
    expect(box.length).toBe(2);
    for (const item of box) {
      expect(Object.keys(item).sort()).toEqual(["activity", "addressee", "content", "id", "ts"]);
      expect("read" in item).toBe(false);
      expect("readAt" in item).toBe(false);
    }
  });
});

describe("营养不良性死亡的验尸官", () => {
  it("连续低于地板天数可测（死亡形态之三）", () => {
    const params = assembleParams({ M_min: 0.5, tokenScale: 400 }); // 200 token
    const days = [
      { requiredSpent: 300 },
      { requiredSpent: 210 },
      { requiredSpent: 100 },
      { requiredSpent: 150 },
    ];
    // 从最近一天往回数：150、100 低于地板，210 打断
    expect(starvationDays(days, params)).toBe(2);
    expect(starvationDays([], params)).toBe(0);
  });

  it("maView 不把进行中的今天计入挨饿天数（不许把早晨读成饥荒）", async () => {
    const svc = new PothosService(new MemoryStore(), new ManualClock(T0));
    svc.state.paramOverrides["M_min"] = 0.5;
    svc.state.paramOverrides["tokenScale"] = 400;
    const d = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString().slice(0, 10);
    svc.state.nutrition.days = [
      { date: d(-2 * DAY), spentTokens: 0, requiredSpent: 100, maintenanceM: 0.05 },
      { date: d(-1 * DAY), spentTokens: 0, requiredSpent: 100, maintenanceM: 0.05 },
      { date: d(0), spentTokens: 0, requiredSpent: 0, maintenanceM: 0.05 }, // 今天：进行中，未结算
    ];
    const view = await svc.maView();
    expect(view.starvationDays).toBe(2);
  });
});

describe("salience 打分（廉价无 LLM）", () => {
  it("打猎 salience 随想念升高（想她 → 打猎权重升）", () => {
    const st = initialState(T0, 1);
    st.longing.L = 0.8;
    expect(salienceScore(st, "hunt")).toBeGreaterThan(0.5);
    st.longing.L = 0;
    expect(salienceScore(st, "hunt")).toBeLessThan(0.3);
  });
});
