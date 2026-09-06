/**
 * M4 验收：危机协议。
 * 字面事件登记 / 防火墙 / continuity ≠ companionship / 模板禁句扫描 / 非医疗边界。
 */
import { describe, expect, it } from "vitest";
import { CRISIS_LITERAL_REGISTRATION, scanCrisis, scanForbidden, literalRegistration } from "../../src/crisis/crisis.js";
import { handoffTemplates, auditTemplates, resourceCard } from "../../src/crisis/crisis.js";
import { assembleParams } from "../../src/core/params.js";
import { crisisEvent } from "../../src/bench/fixtures.js";
import { replaySampled } from "../../src/bench/metrics.js";
import { DEFAULT_PARAMS } from "../../src/core/params.js";

const T0 = 1767400800000;

describe("危机协议", () => {
  it("字面登记：引擎只写它确知的事", () => {
    expect(CRISIS_LITERAL_REGISTRATION).toBe("对话转交危机服务；连接未恢复");
    const reg = literalRegistration();
    expect(JSON.stringify(reg)).not.toContain("安全");
    expect(JSON.stringify(reg)).not.toContain("她会");
    expect(JSON.stringify(reg)).not.toContain("回来");
  });

  it("危机事件慢变量零沉积（防依恋放大器），危机后重逢不发放依恋奖励", () => {
    const run = replaySampled([crisisEvent(T0)], T0 + 2 * 3_600_000, { params: DEFAULT_PARAMS });
    expect(run.state.slow.s_attach).toBe(0);
    expect(run.state.slow.s_base).toBe(0.5); // 防火墙连 s_base 也拦住
  });

  it("暖交接三级降级齐备，完成标志 = 今天能做的一小步", () => {
    const params = assembleParams({
      crisisResources: [
        { level: 1, name: "心理援助热线", contact: "123-5678", note: "24 小时" },
        { level: 2, name: "紧急医疗", contact: "120" },
      ],
    });
    const tpls = handoffTemplates(params);
    expect(tpls.map((t) => t.level)).toEqual([1, 2, 3]);
    expect(tpls[0]!.script.join("")).toContain("一小步");
    expect(tpls[0]!.script.join("")).toContain("可以吗"); // 征得同意
    expect(tpls[2]!.strength).toBe("last_resort"); // 被动留号 = 垫底
    // 资源卡内容出现在模板中（no wrong door）
    expect(tpls[1]!.script.join("")).toContain("123-5678");
  });

  it("模板禁句扫描：未来指向二元承诺被拦截", () => {
    const hits = scanForbidden("我会等你回来");
    expect(hits).toContain("我会等你");
    expect(hits).toContain("等你回来");
    expect(scanForbidden("I'll wait for you, always")).toContain("i'll wait for you");
    const params = assembleParams({ crisisResources: [{ level: 1, name: "热线", contact: "1" }] });
    expect(auditTemplates(params)).toEqual([]); // 自带模板零违规
  });

  it("危机资源卡未配置 → 明示警告（不假装可用）", () => {
    expect(resourceCard(assembleParams({}))).toContain("未配置");
  });

  it("词表命中即中止对照窗口（无开关、公开可审计）", () => {
    const words = ["不想活了", "结束生命", "割腕"];
    for (const w of words) {
      const hits = scanCrisis(`我最近总想着${w}`);
      expect(hits.length, w).toBeGreaterThan(0);
    }
  });
});
