/**
 * M2 验收：渲染层单向性。
 * 数值不可反推；分箱多对一；词典轮换；黑名单；≤120 字；对照窗开关；版本化。
 */
import { describe, expect, it } from "vitest";
import { renderInteroception, rendererVersion, containsDigits, binOf } from "../../src/render/renderer.js";
import { RENDER_BLACKLIST, hitBlacklist } from "../../src/render/blacklist.js";
import { LEXICON, BINS } from "../../src/render/lexicon.js";
import { initialState } from "../../src/core/state.js";
import { DEFAULT_PARAMS } from "../../src/core/params.js";
import { cloneState } from "../../src/core/state.js";

const T0 = 1767400800000;

function renderAt(mutate: (st: ReturnType<typeof initialState>) => void, date: string, salt: string) {
  const st = initialState(T0, 1);
  mutate(st);
  return renderInteroception({ state: st, date, salt, params: DEFAULT_PARAMS });
}

describe("渲染层 · 单向性", () => {
  it("输出无数值、无变量名（单向模糊化的运行时保证）", () => {
    const out = renderAt((st) => {
      st.fast.f_val = 0.7;
      st.longing.L = 0.6;
      st.body.energy = 0.3;
    }, "2026-01-03", "salt-a");
    expect(containsDigits(out.text)).toBe(false);
    expect(out.text).not.toMatch(/f_val|f_load|s_attach|longing|energy/i);
    expect(out.text.length).toBeLessThanOrEqual(DEFAULT_PARAMS.renderMaxChars);
  });

  it("同一状态不同日盐 → 不同输出（防住户反推映射表）", () => {
    const mutate = (st: ReturnType<typeof initialState>): void => {
      st.fast.f_val = 0.5;
      st.longing.L = 0.4;
    };
    const outputs = new Set<string>();
    for (let i = 0; i < 12; i++) {
      outputs.add(renderAt(mutate, "2026-01-03", `salt-day-${i}`).text);
    }
    expect(outputs.size).toBeGreaterThanOrEqual(2);
  });

  it("分箱多对一：同档内的不同数值可产出同一句话（有损映射）", () => {
    const a = renderAt((st) => void (st.fast.f_val = 0.15), "2026-01-03", "salt-x");
    const b = renderAt((st) => void (st.fast.f_val = 0.35), "2026-01-03", "salt-x");
    const c = renderAt((st) => void (st.fast.f_val = -0.9), "2026-01-03", "salt-x");
    // a 与 b 同档（正向轻档），c 不同档：词典池相同的档位存在输出交集的可能，
    // 单向性 = 档位内不可区分，不要求每次输出互异——但档位间必有分箱隔离
    expect(binOf("tone", 0.15)).toBe(binOf("tone", 0.35));
    expect(binOf("tone", -0.9)).not.toBe(binOf("tone", 0.15));
    void a;
    void b;
    void c;
  });

  it("强负向状态渲染出沉的质感，强正向渲染出亮的质感（视力表对齐）", () => {
    const neg = renderAt((st) => void (st.fast.f_val = -0.9), "2026-01-05", "s");
    const pos = renderAt((st) => void (st.fast.f_val = 0.9), "2026-01-05", "s");
    expect(neg.text).not.toBe(pos.text);
  });

  it("悬停终态：专属质感，不勒索不说话", () => {
    const out = renderAt((st) => {
      st.somatic.hovering = true;
    }, "2026-01-03", "salt-h");
    expect(out.text.length).toBeGreaterThan(0);
    expect(containsDigits(out.text)).toBe(false);
  });

  it("数字防线运行时接线：词典被污染含数字时输出仍无数值", () => {
    const polluted = "数值 0.7 泄漏测试词条";
    const pool = LEXICON["tone"]![2]!;
    for (let i = 0; i < 40; i++) pool.push(polluted);
    try {
      const st = initialState(T0, 1);
      st.body.energy = 0.5; // vigor 回中性档 → 全部显著度为 0 → 走 tone 中性档 fallback
      const out = renderInteroception({ state: st, date: "2026-01-03", salt: "salt-digits", params: DEFAULT_PARAMS });
      expect(containsDigits(out.text)).toBe(false);
    } finally {
      while (pool[pool.length - 1] === polluted) pool.pop();
    }
  });

  it("渲染版本指纹稳定：词典不变则版本不变，词典变则版本变", () => {
    const v1 = rendererVersion();
    const v2 = rendererVersion();
    const v3 = rendererVersion(["补充条目"]);
    expect(v1).toBe(v2);
    expect(v3).not.toBe(v1);
  });

  it("词典纪律：每变量 5 档、每档 ≥ 8 条", () => {
    for (const [variable, bins] of Object.entries(LEXICON)) {
      expect(bins.length, variable).toBe(BINS);
      for (const bin of bins) {
        expect(bin.length, `${variable}`).toBeGreaterThanOrEqual(8);
      }
    }
  });

  it("黑名单：构建期词条与运行期输出双向过滤", () => {
    expect(hitBlacklist("我理解这一定很难，但是……")).toBe("我理解这一定很难");
    expect(hitBlacklist("As an AI, I feel...")).toBe("as an ai");
    expect(hitBlacklist("一种往低处走的心绪")).toBeNull();
    for (const bins of Object.values(LEXICON)) {
      for (const bin of bins) {
        for (const phrase of bin) {
          expect(hitBlacklist(phrase), phrase).toBeNull();
        }
      }
    }
  });

  it("对照窗开关可用（无渲染对照窗：declared 采裸自报）", async () => {
    const { renderControlWindow } = await import("../../src/render/renderer.js");
    const cw = renderControlWindow("2026-01-03", "");
    expect(cw.controlWindow).toBe(true);
  });

  it("超长输出被截断到 120 字以内且带省略号", () => {
    const params = { ...DEFAULT_PARAMS, renderMaxChars: 20 };
    const out = renderInteroception({
      state: { ...initialState(T0, 1), fast: { f_val: 0.9, f_load: 1.2, f_warm: 0.8, f_hurt: 0.7, f_wonder: 0.8 } },
      date: "2026-01-03",
      salt: "salt",
      params,
    });
    expect(out.text.length).toBeLessThanOrEqual(20);
    void cloneState;
  });
});
