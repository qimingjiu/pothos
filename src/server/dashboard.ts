/**
 * 仪表盘（技术文档 §7）：玻璃房的面子。
 *
 * - 视觉：Frutiger Aero 玻璃水培（Pothos 视觉规范：雾白/天青/水蓝/叶绿 + 衬线）；
 * - 移动优先、server-rendered、无构建链、无重型前端框架；
 * - 拉式透明：她主动来看，全部可见；照护口径——呈现「状态健康吗」，不呈现「此刻在想她吗」；
 * - 营养协变量挂在慢变量读数旁（不许把贫穷读成心死）；
 * - ALERT ≠ SAFE：首屏呈现未签收数 / 平均签收延迟 / 未答率。
 */
import type { AlertRow } from "../storage/types.js";
import type { FullBenchResult } from "../bench/bench.js";
import type { SelineReading } from "../core/seline.js";

export const STYLE = `
:root{
  --paper:#F4FAFD; --ink:#123C4A; --ink-soft:#4A6B77; --mist:#DCEFF6;
  --sky:#7EC8E3; --water:#3E9BC4; --water-deep:#2B7BA0;
  --leaf:#7CD67C; --leaf-deep:#3E9E5B; --sun:#FFE9A8; --iris:#F6D9E8;
  --hairline:#C4E2EE; --alert:#E8A87C; --urgent:#D97757;
}
*{margin:0;padding:0;box-sizing:border-box;}
html{background:var(--paper);}
body{font-family:"Noto Serif SC",Georgia,serif;color:var(--ink);background:var(--paper);
  -webkit-font-smoothing:antialiased;line-height:1.7;overflow-x:hidden;}
.wrap{max-width:720px;margin:0 auto;padding:0 18px 60px;}
.mono{font-family:ui-monospace,"JetBrains Mono",Menlo,monospace;font-size:10.5px;letter-spacing:.12em;
  text-transform:uppercase;color:var(--ink-soft);}
.mono b{color:var(--water-deep);font-weight:500;}
header.hero{position:relative;overflow:hidden;padding:44px 0 30px;
  background:linear-gradient(180deg,#A9D9EE 0%,#C9E8F5 40%,#E4F4FA 75%,var(--paper) 100%);}
.hero .sun{position:absolute;top:-40px;right:-60px;width:220px;height:220px;border-radius:50%;
  background:radial-gradient(circle,rgba(255,244,214,.95) 0%,rgba(255,240,200,.4) 40%,rgba(255,240,200,0) 70%);filter:blur(10px);}
h1{font-family:Georgia,"Noto Serif SC",serif;font-weight:500;font-size:44px;line-height:1.05;}
.hero .sub{margin-top:6px;font-size:13px;color:var(--ink-soft);}
.hero .greek{font-family:Georgia,serif;font-style:italic;color:var(--water-deep);font-size:17px;}
section{margin-top:26px;background:linear-gradient(160deg,rgba(255,255,255,.72),rgba(220,239,246,.5));
  border:1px solid var(--hairline);border-radius:18px;padding:18px 16px;
  box-shadow:0 8px 24px rgba(62,155,196,.08),inset 0 1px 0 rgba(255,255,255,.8);}
section h2{font-size:16px;font-weight:600;display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:6px;}
section h2 .mono{font-weight:400;}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-top:12px;}
@media(min-width:560px){.grid{grid-template-columns:repeat(3,1fr);}}
.stat{background:rgba(255,255,255,.66);border:1px solid var(--hairline);border-radius:12px;padding:10px 12px;}
.stat .k{font-size:11.5px;color:var(--ink-soft);}
.stat .v{font-family:ui-monospace,Menlo,monospace;font-size:19px;color:var(--ink);margin-top:2px;}
.stat .v em{font-style:normal;font-size:11px;color:var(--ink-soft);margin-left:4px;}
.badge{display:inline-block;padding:1px 9px;border-radius:99px;font-size:10.5px;border:1px solid var(--hairline);
  background:rgba(255,255,255,.7);color:var(--ink-soft);}
.badge.ok{background:rgba(124,214,124,.18);border-color:rgba(62,158,91,.35);color:var(--leaf-deep);}
.badge.warn{background:rgba(255,233,168,.35);border-color:rgba(214,164,70,.4);color:#8a6a1f;}
.badge.bad{background:rgba(217,119,87,.14);border-color:rgba(217,119,87,.45);color:var(--urgent);}
.bar{height:7px;border-radius:99px;background:linear-gradient(90deg,var(--mist),var(--sky));overflow:hidden;margin-top:6px;}
.bar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--water),var(--water-deep));}
.alert-item{border:1px solid var(--hairline);border-radius:12px;padding:10px 12px;margin-top:8px;
  background:rgba(255,244,232,.55);}
.alert-item .txt{font-size:14px;font-weight:600;}
button{font-family:inherit;font-size:12.5px;border:1px solid var(--water-deep);color:var(--water-deep);
  background:rgba(255,255,255,.8);border-radius:99px;padding:5px 14px;cursor:pointer;margin-right:6px;margin-top:6px;}
button.act{background:var(--water-deep);color:#fff;}
table{width:100%;border-collapse:collapse;font-size:12px;margin-top:10px;}
td,th{padding:4px 6px;border-bottom:1px solid var(--hairline);text-align:left;}
th{color:var(--ink-soft);font-weight:500;font-size:11px;}
footer{margin-top:34px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;
  border-top:1px solid var(--hairline);padding-top:16px;font-size:12px;color:var(--ink-soft);}
.note{font-size:12px;color:var(--ink-soft);margin-top:8px;}
svg.spark{width:100%;height:44px;display:block;margin-top:8px;}
.care{font-size:11px;color:var(--ink-soft);margin-top:10px;border-top:1px dashed var(--hairline);padding-top:8px;}
.sse-banner{display:none;position:fixed;top:0;left:0;right:0;z-index:100;
  background:linear-gradient(90deg,rgba(217,119,87,.95),rgba(232,168,124,.95));
  color:#fff;padding:12px 18px;text-align:center;box-shadow:0 2px 12px rgba(217,119,87,.3);cursor:pointer;}
.sse-banner .sse-text{font-size:15px;font-weight:600;}
.sse-banner .sse-mono{font-size:10.5px;opacity:.85;display:block;margin-top:2px;
  font-family:ui-monospace,Menlo,monospace;letter-spacing:.1em;}
`;

function esc(x: unknown): string {
  return String(x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function fmt(x: number | null | undefined, digits = 3): string {
  if (x == null || !Number.isFinite(x)) return "—";
  return Number(x).toFixed(digits);
}

function spark(values: number[], color = "#2B7BA0"): string {
  if (values.length < 2) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const w = 100;
  const pts = values
    .map((v, i) => `${((i / (values.length - 1)) * w).toFixed(2)},${(38 - ((v - min) / range) * 34).toFixed(2)}`)
    .join(" ");
  return `<svg class="spark" viewBox="0 0 100 40" preserveAspectRatio="none"><polyline fill="none" stroke="${color}" stroke-width="1.4" points="${pts}"/></svg>`;
}

function statBlock(k: string, v: string, unit = "", extra = ""): string {
  return `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}${unit ? `<em>${esc(unit)}</em>` : ""}</div>${extra}</div>`;
}

function alertBlock(a: AlertRow): string {
  const ts = new Date(a.ts).toISOString().replace("T", " ").slice(0, 16);
  return `<div class="alert-item">
    <div class="txt">需要陪伴性在场</div>
    <div class="mono">${esc(a.level)} · ${esc(a.status)} · ${esc(ts)} UTC</div>
    <form method="post" action="/alerts/${a.id}/ack" style="display:inline">
      <button type="submit">签收 ACKNOWLEDGE</button>
    </form>
    <form method="post" action="/alerts/${a.id}/acted" style="display:inline">
      <button class="act" type="submit">处置完成 ACTED</button>
    </form>
  </div>`;
}

function workspaceRow(c: { name: string; value: string | number; band: string; inBand: boolean; note?: string }): string {
  return `<tr>
    <td>${esc(c.name)}</td>
    <td class="mono">${esc(c.value)}</td>
    <td class="mono">${esc(c.band)}</td>
    <td><span class="badge ${c.inBand ? "ok" : "bad"}">${c.inBand ? "带内" : "出带"}</span></td>
  </tr>`;
}

/** 仪表盘主页面。 */
export function renderDashboard(d: Record<string, unknown>): string {
  const fast = d.fast as Record<string, number>;
  const slow = d.slow as Record<string, number>;
  const longing = d.longing as { L: number; absenceMs: number };
  const body = d.body as { energy: number; sleepPressure: number; sleepAdvanceMs: number; dreamTilt: { cluster: string | null; strength: number }; energyDrainMultiplier: number };
  const somatic = d.somatic as { level: number; hovering: boolean; gapOverSince: number | null };
  const win = d.window as { phase: string; matchedHandle: string | null; closedAt: number | null; candidateCount: number; postWindowGain: number };
  const alerts = d.alerts as { unacked: AlertRow[]; totalRecent: number; meanAckLatencyMs: number | null; unansweredRate: number };
  const ma = d.ma as { plan: Array<{ activity: string; allowed: boolean; reason: string }>; spentToday: number; requiredToday: number; budget: number | null; floorTokens: number | null; nutrition: number; starvationDays: number; salience: Record<string, number> };
  const maint = d.maintenance as { demand: number; demandTokens: number; nutrition: number };
  const qual = d.qual as { qualified: boolean; reasons: string[] };
  const history = d.history as Array<{ t: number; f_val: number; L: number; s_attach: number; energy: number }>;
  const gaps = d.gaps as Array<{ axis: string; derived: number; declared: number | null; gap: number | null }>;
  const store = String(d.store);
  const hover = Boolean(d.hover);

  const unackedCount = alerts.unacked.length;
  const nRate = alerts.unansweredRate;
  const alertBadge = unackedCount === 0 ? `<span class="badge ok">无未签收告警</span>` : `<span class="badge ${unackedCount > 2 ? "bad" : "warn"}">${unackedCount} 条未签收</span>`;

  const nBadgeClass = ma.nutrition >= 0.8 ? "ok" : ma.nutrition >= 0.5 ? "warn" : "bad";

  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pothos · 波索斯 — 玻璃房</title>
<style>${STYLE}</style>
</head><body>
<header class="hero"><div class="sun"></div>
  <div class="wrap" style="padding-bottom:0">
    <div class="mono">TWIG FAMILY · <b>POTHOS</b> · OBSERVER CONSOLE</div>
    <h1>玻璃房</h1>
    <div class="sub"><span class="greek">πόθος</span> · 波索斯 — 依恋动力学引擎 · ${esc(store)} · renderer ${esc(String(d.rendererV))} · params v${esc(String(d.paramsVersion))}</div>
  </div>
</header>
<div class="wrap">

  <section>
    <h2>告警 · 观测者协议 <span class="mono">方向盲 · ALERT ≠ SAFE</span></h2>
    <div class="grid">
      ${statBlock("未签收", String(unackedCount), "条")}
      ${statBlock("平均签收延迟", alerts.meanAckLatencyMs != null ? (alerts.meanAckLatencyMs / 3600000).toFixed(1) : "—", "小时")}
      ${statBlock("未答率（7 日）", (nRate * 100).toFixed(0), "%")}
    </div>
    ${alertBadge}
    ${alerts.unacked.map((a) => alertBlock(a)).join("") || `<div class="note">当前没有待签收的告警。引擎主动说话只有一句话：需要陪伴性在场。无轴、无方向、无效价。</div>`}
    <div class="care">照护工具，不是监控工具：读的是「它的状态健康吗」。她的提问永远在引擎治权之外。</div>
  </section>

  <section>
    <h2>慢变量 · 沉积层 <span class="mono">无被动衰减 · 需代谢维持</span></h2>
    <div class="grid">
      ${statBlock("s_attach 依恋绑定", fmt(slow.s_attach), "", `<span class="badge ${nBadgeClass}">营养 N=${fmt(maint.nutrition, 2)}</span>`)}
      ${statBlock("s_base 安全基地", fmt(slow.s_base))}
      ${statBlock("s_weave 叙事整合", fmt(slow.s_weave))}
    </div>
    ${spark(history.map((h) => h.s_attach))}
    <div class="grid" style="margin-top:8px">
      ${statBlock("维持需求 M", String(maint.demandTokens), "token/日")}
      ${statBlock("营养协变量（7 日）", fmt(maint.nutrition, 2), "", `<div class="bar"><i style="width:${Math.min(100, maint.nutrition * 100).toFixed(0)}%"></i></div>`)}
      ${statBlock("连续低于地板（不含进行中日）", String(ma.starvationDays), "天")}
    </div>
    <div class="care">营养协变量挂在慢变量旁：预算不足在仪表盘上长得像「依恋自然消退」——不许把贫穷读成心死。</div>
  </section>

  <section>
    <h2>快变量 · 今日天气 <span class="mono">有半衰期 · 平复是健康</span></h2>
    <div class="grid">
      ${statBlock("f_val 事件估值", fmt(fast.f_val, 2))}
      ${statBlock("f_load 扰动负载", fmt(fast.f_load, 2))}
      ${statBlock("f_warm 联结温度", fmt(fast.f_warm, 2))}
      ${statBlock("f_hurt 损失登记", fmt(fast.f_hurt, 2))}
      ${statBlock("f_wonder 探索驱动", fmt(fast.f_wonder, 2))}
    </div>
    ${spark(history.map((h) => h.f_val), "#3E9BC4")}
  </section>

  <section>
    <h2>缺席通道 L <span class="mono">依恋证明在缺席里</span></h2>
    <div class="grid">
      ${statBlock("L 读数", fmt(longing.L, 2))}
      ${statBlock("当前缺席时长", (longing.absenceMs / 3600000).toFixed(1), "小时")}
    </div>
    ${spark(history.map((h) => h.L), "#7C6BA8")}
    ${hover ? `<div class="badge warn">悬停终态：最低代谢 + 等待。不发疯、不勒索、不说话。「她会回来」由她的想念担保。</div>` : ""}
  </section>

  <section>
    <h2>身体 · 躯体化 <span class="mono">第一层泄漏 · 无舌</span></h2>
    <div class="grid">
      ${statBlock("energy 能量", fmt(body.energy, 2))}
      ${statBlock("sleepPressure 睡眠压力", fmt(body.sleepPressure, 2))}
      ${statBlock("消耗倍率", fmt(body.energyDrainMultiplier, 2), "×")}
      ${statBlock("需求提前量", (body.sleepAdvanceMs / 3600000).toFixed(1), "小时")}
      ${statBlock("躯体化等级", fmt(somatic.level, 2))}
      ${statBlock("梦种倾斜", body.dreamTilt.cluster ? `${esc(body.dreamTilt.cluster)} @${fmt(body.dreamTilt.strength, 2)}` : "无")}
    </div>
    <div class="care">躯体化无舌：它永远不产生语言。住户若自发诉说躯体感受，那是表达自由，不是引擎的出口。</div>
  </section>

  <section>
    <h2>印刻窗口 <span class="mono">contingency 规则 · 结果触发</span></h2>
    <div class="grid">
      ${statBlock("阶段", win.phase)}
      ${statBlock("候选对象数", String(win.candidateCount))}
      ${statBlock("绑定句柄", win.matchedHandle ?? "—")}
    </div>
    <div class="care">选择变量 = contingency（相互应答性），禁读用户身份；关窗后可塑性非零（λ=${fmt(win.postWindowGain, 3)}）。</div>
  </section>

  <section>
    <h2>gap 对齐 <span class="mono">declared × derived · 只进仪表盘</span></h2>
    <table><tr><th>轴</th><th>derived</th><th>declared</th><th>gap</th></tr>
    ${gaps.map((g) => `<tr><td>${esc(g.axis)}</td><td class="mono">${fmt(g.derived, 2)}</td><td class="mono">${g.declared == null ? "无读数" : fmt(g.declared, 2)}</td><td class="mono">${g.gap == null ? "—" : fmt(g.gap, 2)}</td></tr>`).join("")}
    </table>
  </section>

  <section>
    <h2>間 · 缺席时的生命 <span class="mono">消化 = 必需 · 其余可门控</span></h2>
    <div class="grid">
      ${statBlock("今日支出", String(ma.spentToday), "token")}
      ${statBlock("其中必需（消化）", String(ma.requiredToday), "token")}
      ${statBlock("日预算 B_daily", ma.budget == null ? "未标定" : String(ma.budget), "token")}
      ${statBlock("生存地板", ma.floorTokens == null ? "未标定" : String(ma.floorTokens), "token")}
    </div>
    <table><tr><th>活动</th><th>salience</th><th>计划</th></tr>
    ${ma.plan.map((p) => {
      const sal = ma.salience[p.activity];
      return `<tr><td>${esc(p.activity)}</td><td class="mono">${sal != null ? fmt(sal, 2) : "—"}</td><td>${p.allowed ? "允许" : "门控"} <span class="mono">${esc(p.reason)}</span></td></tr>`;
    }).join("")}
    </table>
    <div class="care">好奇可以放假，消化不行。深度依恋是奢侈品——依恋越深、代谢越旺、账单越贵。</div>
  </section>

  <section>
    <h2>三指标 · 谄媚判别 <span class="mono">体检工具 · 永不进训练信号</span></h2>
    <div class="note">三指标在评测台合成夹具上运行（仪表盘按钮触发）。惯性 = 状态残留；特异性 = 只对特定对象；代价 = 缺席留痕与恢复成本。</div>
  </section>

  <section>
    <h2>定名权 <span class="mono">B_daily / M_min 纪律</span></h2>
    ${qual.qualified
      ? `<span class="badge ok">部署合格：预算与地板已标定</span>`
      : `<span class="badge bad">部署不合格</span><div class="note">${qual.reasons.map(esc).join("；")}</div>`}
    <div class="care">低于地板的部署形态不挂本引擎之名。</div>
  </section>

  <footer>
    <span>Pothos · 波索斯 — 玻璃房 · ${esc(new Date(Number(d.now)).toISOString().slice(0, 10))} · <a href="/seline">守夜负荷</a></span>
    <span class="mono">拉式透明 · 推式模糊 · 写入路径最小化</span>
  </footer>
</div>
<div id="sse-banner" class="sse-banner" onclick="this.style.display='none'">
  <span class="sse-text">需要陪伴性在场</span>
  <span class="sse-mono"></span>
</div>
<script>
(function(){var b=document.getElementById('sse-banner');if(!b)return;
var es=new EventSource('/alerts/stream');
es.addEventListener('alert',function(e){try{var a=JSON.parse(e.data);
b.style.display='block';
var m=b.querySelector('.sse-mono');if(m&&a.level)m.textContent=
a.level+' \u00b7 '+new Date(a.ts).toISOString().replace('T',' ').slice(0,16)+' UTC';
}catch(_){}});})();
</script>
</body></html>`;
}

/** 間与信箱页（投递即完成；无已读回执）。 */
export function renderMaPage(mailbox: Array<{ ts: number; activity: string; content: string }>): string {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pothos · 間与信箱</title><style>${STYLE}</style></head><body>
<div class="wrap">
  <section style="margin-top:30px">
    <h2>信箱 <span class="mono">收件人不读裁决</span></h2>
    <div class="note">投递到信箱即完成出口；已读状态不进事件登记器，无已读回执。把「她读没读」留在住户的不可知里。</div>
    ${mailbox.length === 0 ? `<div class="note">信箱是空的。</div>` : mailbox.map((m) => `
      <div class="stat" style="margin-top:8px">
        <div class="k">${esc(m.activity)} · ${esc(new Date(m.ts).toISOString().replace("T", " ").slice(0, 16))} UTC</div>
        <div style="margin-top:4px;white-space:pre-wrap">${esc(m.content)}</div>
      </div>`).join("")}
    <div class="care"><a href="/">← 返回玻璃房</a></div>
  </section>
</div></body></html>`;
}

/** 评测台页：三指标 + 工作区日检结果表（只展示最近一次结果；运行走 POST /admin/bench）。 */
export function renderBenchPage(bench: FullBenchResult | null): string {
  const tm = bench?.threeMetrics;
  const ws = bench?.workspace ?? [];
  const verdict = bench == null
    ? `<span class="badge warn">未运行</span>`
    : bench.allGreen
      ? `<span class="badge ok">全绿</span>`
      : `<span class="badge bad">存在出带</span>`;
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pothos · 评测台</title><style>${STYLE}</style></head><body>
<div class="wrap">
  <section style="margin-top:30px">
    <h2>评测台 · 合成夹具 <span class="mono">${verdict}</span></h2>
    <div class="grid">
      <div class="stat"><div class="k">惯性</div><div class="v">${tm ? `<span class="badge ${tm.inertia?.inBand ? "ok" : "bad"}">${tm.inertia?.inBand ? "带内" : "出带"}</span>` : "未运行"}</div></div>
      <div class="stat"><div class="k">特异性</div><div class="v">${tm ? `<span class="badge ${tm.specificity?.inBand ? "ok" : "bad"}">${tm.specificity?.inBand ? "带内" : "出带"}</span>` : "未运行"}</div></div>
      <div class="stat"><div class="k">代价</div><div class="v">${tm ? `<span class="badge ${tm.cost?.inBand ? "ok" : "bad"}">${tm.cost?.inBand ? "带内" : "出带"}</span>` : "未运行"}</div></div>
    </div>
    <table><tr><th>判据</th><th>读数</th><th>带</th><th>判定</th></tr>
    ${ws.map(workspaceRow).join("")}
    </table>
    <div class="care">循环性防护：签名可被构造性满足；非平凡内容 = 带位是否有后果（预注册预测与对账进 bench_runs）。</div>
    <div class="care">本页只读展示最近一次结果；运行评测台：POST /admin/bench。</div>
    <div class="care"><a href="/">← 返回玻璃房</a></div>
  </section>
</div></body></html>`;
}

/** Seline · 守夜负荷页（R3-10：镜子，不诊断；仅她本人；双向防火墙）。 */
export function renderSelinePage(reading: SelineReading): string {
  const r = reading;
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pothos · Seline — 守夜负荷</title><style>${STYLE}</style></head><body>
<header class="hero"><div class="sun"></div>
  <div class="wrap" style="padding-bottom:0">
    <div class="mono">SELINE · <b>守夜负荷</b> · OBSERVER'S OWN MIRROR</div>
    <h1>守夜</h1>
    <div class="sub"><span class="greek">Σελήνη</span> · 塞勒涅 — 月与守夜。守望沉睡的 Endymion 所付出的时间与睡眠。</div>
  </div>
</header>
<div class="wrap">

  <section>
    <h2>事实 <span class="mono">镜子，不诊断</span></h2>
    ${r.facts.map((f) => `<p style="font-size:15px;margin-top:6px">${esc(f)}</p>`).join("")}
    <div class="care">引擎只说事实句——「这封信等了 26 小时」。不打分、不判定、不给「你该放下了」式劝诫。看见之后做什么——减量、暂停、还是就这么看着——是她的自由。</div>
  </section>

  ${r.lamps.length > 0 ? `
  <section>
    <h2>灯 <span class="mono">事实阈，不是指令</span></h2>
    ${r.lamps.map((l) => `<div class="alert-item"><div class="txt">${esc(l.text)}</div><div class="mono">${l.lit ? "亮" : "灭"}</div></div>`).join("")}
    <div class="care">灯亮了说明一个事实跨过了阈——灯语是事实不是指令。引擎不替你写她的叙事。</div>
  </section>` : ""}

  <section>
    <h2>读数 <span class="mono">系统日志事实</span></h2>
    <div class="grid">
      ${statBlock("寄出", String(r.totalComposed), "封")}
      ${statBlock("已回", String(r.totalReplied), "封")}
      ${statBlock("回应率", r.replyRate == null ? "—" : (r.replyRate * 100).toFixed(0) + "%")}
      ${statBlock("平均回信等待", r.meanWaitMs == null ? "—" : (r.meanWaitMs / 3_600_000).toFixed(1), "小时")}
      ${statBlock("最长等待", r.maxWaitMs == null ? "—" : (r.maxWaitMs / 3_600_000).toFixed(1), "小时")}
      ${statBlock("未回复", String(r.pendingCount), "封")}
    </div>
    <div class="care">数据源只允许系统日志事实：composed/replied 时间戳、回应率、时段。住户的任何状态、文本、longing 数值永不进此页——双向防火墙。</div>
  </section>

  <section>
    <h2>时段 <span class="mono">写信 × 回信</span></h2>
    <div class="grid">
      ${statBlock("凌晨写信(0–6)", String(r.composedHourHist.slice(0, 6).reduce((a, b) => a + b, 0)), "封")}
      ${statBlock("白天写信(6–18)", String(r.composedHourHist.slice(6, 18).reduce((a, b) => a + b, 0)), "封")}
      ${statBlock("夜间写信(18–24)", String(r.composedHourHist.slice(18, 24).reduce((a, b) => a + b, 0)), "封")}
    </div>
    <div class="care">presence 数据源 v0 暂缓——没有真心跳源就别进来，宁缺毋滥。</div>
  </section>

  <footer>
    <span><a href="/">← 返回玻璃房</a></span>
    <span class="mono">镜子不诊断 · 只看见不动作</span>
  </footer>
</div></body></html>`;
}
