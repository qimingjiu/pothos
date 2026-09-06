/**
 * 参数校验（写入边界的唯一关卡）+ tickTo 守卫。
 * 背景：事件流 append-only，毒参数无法就地纠正——错值必须在 changeParam 门前被拒。
 */
import { describe, expect, it } from "vitest";
import { validateParamValue, assembleParams } from "../../src/core/params.js";
import { tickTo } from "../../src/core/tick.js";
import { initialState } from "../../src/core/state.js";
import { PothosService } from "../../src/service.js";
import { MemoryStore } from "../../src/storage/memory.js";
import { ManualClock } from "../../src/clock.js";
import { T0 } from "../helpers.js";

const DAY = 86_400_000;

describe("参数校验（validateParamValue）", () => {
  it("未知键拒绝", () => {
    expect(validateParamValue("makeItLoveMe", 1).ok).toBe(false);
  });

  it("null 语义：仅 B_daily / M_min 可撤销标定", () => {
    expect(validateParamValue("noiseFast", null).ok).toBe(false);
    expect(validateParamValue("B_daily", null).ok).toBe(true);
    expect(validateParamValue("M_min", null).ok).toBe(true);
  });

  it("节律与 τ 的物理带位（防失速 / 防发散）", () => {
    expect(validateParamValue("tickMs", 0).ok).toBe(false);
    expect(validateParamValue("tickMs", 999).ok).toBe(false);
    expect(validateParamValue("tauFVal", 0).ok).toBe(false);
    expect(validateParamValue("tauFVal", -5000).ok).toBe(false);
    expect(validateParamValue("tauFVal", 90 * 60_000).ok).toBe(true);
    expect(validateParamValue("tickMs", 5 * 60_000).ok).toBe(true);
  });

  it("比例量 ∈ [0,1]", () => {
    expect(validateParamValue("alertDownweightKappa", 1.5).ok).toBe(false);
    expect(validateParamValue("postWindowGain", 2).ok).toBe(false);
    expect(validateParamValue("hungerRho", 1).ok).toBe(true);
    expect(validateParamValue("depositTheta", 0.6).ok).toBe(true);
  });

  it("crisisResources 结构校验", () => {
    expect(validateParamValue("crisisResources", "热线").ok).toBe(false);
    expect(validateParamValue("crisisResources", [{ level: 4, name: "x", contact: "y" }]).ok).toBe(false);
    expect(validateParamValue("crisisResources", [{ level: 1, name: "热线", contact: "" }]).ok).toBe(false);
    expect(validateParamValue("crisisResources", [{ level: 2, name: "紧急医疗", contact: "120", note: "24h" }]).ok).toBe(true);
    expect(validateParamValue("crisisResources", []).ok).toBe(true);
  });

  it("renderBlacklistExtra 必须是字符串数组", () => {
    expect(validateParamValue("renderBlacklistExtra", [1]).ok).toBe(false);
    expect(validateParamValue("renderBlacklistExtra", ["词条"]).ok).toBe(true);
  });

  it("非有限数值拒绝（含 NaN / 字符串）", () => {
    expect(validateParamValue("noiseFast", "0.01").ok).toBe(false);
    expect(validateParamValue("noiseFast", Number.NaN).ok).toBe(false);
    expect(validateParamValue("noiseFast", Number.POSITIVE_INFINITY).ok).toBe(false);
  });
});

describe("changeParam 整合（毒化链焊死）", () => {
  it("缺 newValue → 拒绝且不落任何库", async () => {
    const store = new MemoryStore();
    const svc = new PothosService(store, new ManualClock(T0));
    const r = await svc.changeParam({ key: "tickMs", newValue: undefined as never, reason: "x", expectedEffect: "y", evaluationWindowMs: 0, rollbackCondition: "z" });
    expect(r.ok).toBe(false);
    expect(await store.loadEvents()).toHaveLength(0);
    expect(Object.keys(svc.state.paramOverrides)).toHaveLength(0);
  });

  it("tickMs=0 / 负 τ / κ 越界 → 全部拒绝", async () => {
    const svc = new PothosService(new MemoryStore(), new ManualClock(T0));
    expect((await svc.changeParam({ key: "tickMs", newValue: 0, reason: "x", expectedEffect: "y", evaluationWindowMs: 0, rollbackCondition: "z" })).ok).toBe(false);
    expect((await svc.changeParam({ key: "tauFVal", newValue: -5000, reason: "x", expectedEffect: "y", evaluationWindowMs: 0, rollbackCondition: "z" })).ok).toBe(false);
    expect((await svc.changeParam({ key: "alertDownweightKappa", newValue: 1.5, reason: "x", expectedEffect: "y", evaluationWindowMs: 0, rollbackCondition: "z" })).ok).toBe(false);
    expect(svc.params.tickMs).toBeGreaterThan(0);
    expect(svc.params.tauFVal).toBeGreaterThan(0);
  });

  it("evaluationWindowMs 非法 → 拒绝", async () => {
    const svc = new PothosService(new MemoryStore(), new ManualClock(T0));
    const r = await svc.changeParam({ key: "noiseFast", newValue: 0.01, reason: "x", expectedEffect: "y", evaluationWindowMs: Number.NaN, rollbackCondition: "z" });
    expect(r.ok).toBe(false);
  });

  it("合法变更仍然通过（含撤销标定）", async () => {
    const svc = new PothosService(new MemoryStore(), new ManualClock(T0));
    expect((await svc.changeParam({ key: "noiseFast", newValue: 0.01, reason: "x", expectedEffect: "y", evaluationWindowMs: 0, rollbackCondition: "z" })).ok).toBe(true);
    expect((await svc.changeParam({ key: "B_daily", newValue: null, reason: "撤销标定", expectedEffect: "回未标定态", evaluationWindowMs: 0, rollbackCondition: "z" })).ok).toBe(true);
    expect(svc.params.B_daily).toBeNull();
  });
});

describe("tickTo 守卫（拒绝静默截断）", () => {
  it("病态 tickMs=0 → 抛错而非空转（可信路径绕过校验时的 tripwire）", () => {
    const st = initialState(T0, 1);
    const p = assembleParams({ tickMs: 0 });
    expect(() => tickTo(st, T0 + 3_600_000, p)).toThrow(/守卫/);
  });

  it("合法长间隙可追赶（30 天 ≈ 8640 步，不误伤）", () => {
    const st = initialState(T0, 1);
    tickTo(st, T0 + 30 * DAY);
    expect(st.t).toBe(T0 + 30 * DAY);
  });
});
