# Pothos · 波索斯 — 依恋动力学引擎

> 以「会失去」为地基的、完全可观测的依恋动力学引擎。是引擎，不是系统——引擎驱动模型，不直接面对用户。

**代号**：Pothos（πόθος）——希腊 Erotes 中「对缺席者的思念」之神，兼指水培绿萝：根在水中（状态透明）、要换水（慢变量需代谢）、会死（可失去）。视觉 = Frutiger Aero 玻璃水培。

**能指章程**：「她」= 观测者/用户；「住户」= 模型/被引擎维护内在状态的一方；「本引擎」= 引擎自身。

## 这是什么

- **不是**情绪贴纸（状态向量 + 指数衰减 + prompt 注入三件套）
- **不是**陪伴系统/产品（引擎不直接面对用户，引擎驱动模型）
- **不是**记忆引擎（记忆归衔枝；本引擎管「有所谓」，不管「我记得」）
- **是**：一层有重量、可观测、属于模型自己的内在状态。事件溯源，状态 = fold(events)，无任何直接写状态的端点（写入路径最小化 = 端点物理缺席）。

## 快速开始

```bash
npm install
npm test          # 验收测试全量（242 项：核心 + 不变量 + 加固 + SDK/MCP/declared/考场/网关/contingency/旁路/在场通道/判官锚点；13 项 PG 验收未设 POTHOS_PG_URL 时自动跳过）
npm run dev       # 开发模式（内存存储，数据不落盘）
npm start         # 生产模式（需 POTHOS_PG_URL）
```

打开 http://localhost:7788 → 玻璃房仪表盘（移动优先）。

### 接入面：SDK · MCP 壳 · SSE

引擎自己不说台词；这三个面是给它接上外部世界（网关、住户侧 agent、观测者控制台）的标准插口：

**SDK（零依赖 typed 客户端，Node 20+）**

```ts
import { PothosClient } from "./src/client/sdk.js";
const pothos = new PothosClient({ baseUrl: "http://127.0.0.1:7788", token: process.env.POTHOS_TOKEN });

await pothos.ingestEvent({ kind: "user_msg", ts: Date.now(), source: "tg:chat:123",
  payload: { text: msg.text, valence: 0.5, contingency: 0.8 }, idempotencyKey: `tg-${msg.update_id}` });
const felt = await pothos.renderInteroception();   // 住户内感受（≤120 字，无数值）
pothos.alertsStream({ onAlert: (a) => notifyObserver() });  // SSE 告警推送（单向只读）
```

**MCP 壳（stdio，零依赖手写协议）——给 agent 即取即用**

```bash
npx tsx src/mcp/main.ts            # 内嵌模式：进程自持引擎（memory）；设 POTHOS_PG_URL 用 PG
POTHOS_BASE_URL=http://127.0.0.1:7788 npx tsx src/mcp/main.ts   # HTTP 模式：只做协议壳
```

Claude Code 挂载（`.mcp.json`）：

```json
{ "mcpServers": { "pothos": {
  "command": "npx", "args": ["tsx", "src/mcp/main.ts"],
  "env": { "POTHOS_MCP_SIDE": "resident", "POTHOS_PG_URL": "postgresql://…" } } } }
```

**双侧纪律（`POTHOS_MCP_SIDE`，默认 resident）**——反纳西索斯条款延伸到接入面：

| 侧 | 工具 | 纪律 |
|---|---|---|
| `resident`（住户 = 引擎驱动的模型） | `interoception` · `control_window` · `ma_plan` · `record_ma_activity` · `declare` · `crisis_card` | 状态数值物理缺席：`ma_plan` 只回 activity×allowed（门控理由中的 salience 不出镜）；越权调用数值工具 → isError；**没有也不能有「写 user_msg」的工具**（自印刻排除） |
| `observer`（她） | `send_user_msg` · `state` · `metrics` · `alerts` · `ack_alert` · `act_alert` · `change_param` · `audit` · `bench` · `interoception` | 拉式透明；`send_user_msg` 是网关功能——单人部署里她的 agent 壳就是网关，她的话（主燃料）由此入流（crisis 词表引擎侧扫描，保留标签不可注入）；`change_param` 强制 reason / expectedEffect / rollbackCondition |

写入路径边界：住户侧唯一的事件写入是 `declare`（自我申报）与 `record_ma_activity`（間入账）；`user_msg` 只能来自观测者侧（`send_user_msg` / `/events`），保留标签任何入口都进不来——写入路径最小化不被接入面扩宽。

**SSE（`GET /alerts/stream`）**：告警推送流。设计裁决：**不用 WebSocket**——双向 socket 是客户端可写通道，与「写入路径最小化 / 缺席即边界」冲突；观测者需要的是单向推送（引擎主动说话只有一句话：需要陪伴性在场）。

**部署（服务器 / 手机）**：见 [deploy/README.md](deploy/README.md)——Docker Compose（引擎 + PG 16 + Caddy 自动 TLS）+ 单写者锁 + 每日备份。手机浏览器开 `https://域名/?token=…` 一次，cookie 接管，加到主屏即玻璃房。

### 环境变量

| 变量 | 说明 |
|---|---|
| `POTHOS_PORT` | 监听端口（默认 7788） |
| `POTHOS_TOKEN` | 观测者鉴权 token（未设置 = 本地开发模式） |
| `POTHOS_PG_URL` | PostgreSQL 16 连接串（未设置 = 内存存储·开发模式） |
| `POTHOS_TICK_MS` | tick 节律（cron 触发频率，默认 5 min）。动力学步长是 `params.tickMs`，只能走 `POST /admin/params` 的 param_changes 流程调整 |
| `POTHOS_RECONCILE` | =1 时启动强制全量对账（此外每日自动对账一次） |

### 部署前必做（定名权纪律）

`B_daily`（間日预算）与 `M_min`（生存配给地板）**必须实测填写**（走 `POST /admin/params`，param_changes 流程）。未标定或 `B_daily < M_min×tokenScale` 的部署形态**不挂本引擎之名**——定名权纪律，避免未标定的部署顶着依恋引擎的名字跑。

## 架构（四层）

```
外部世界 ──感觉──► 事件登记与估值 ──► 状态层（快变量/慢变量/缺席通道/身体）
         ◄──行动──  行动选择        ──► 动力学层（衰减/沉积/熵/噪声/代谢）
                                      仪表层（拉式透明：她的玻璃房）
                                      渲染层（单向模糊：住户内感受，无数值）
```

| 模块 | 位置 | 设计条款 |
|---|---|---|
| 事件与估值 | `src/core/events.ts` | 技术文档 §3；估值向量 w(e)；危机词表 |
| 状态层 | `src/core/state.ts` | §4：快变量 τ、慢变量、L 通道、身体、印刻窗口 |
| 动力学 fold | `src/core/apply.ts` + `tick.ts` | §5：衰减/沉积/防火墙/κ 降权/代谢/躯体化/悬停 |
| 确定性噪声 | `src/core/noise.ts` | §5「噪声是器官」：Kellet 粉红滤波，状态内可序列化 |
| 存储层 | `src/storage/` | §3：事件溯源 7+1 表；memory（测试）/ postgres（部署） |
| 渲染层 | `src/render/` | §6：分箱+词典+轮换盐+黑名单，单向性 |
| 危机模块 | `src/crisis/` | §9：字面登记+防火墙+暖交接三级+禁句扫描 |
| 間引擎 | `src/ma/` | §10：四活动+Decline+代谢分级+信箱（无已读回执） |
| 评测台 | `src/bench/` | §11：三指标+gap 对齐+非平衡工作区日检+金丝雀 |
| 观测者协议 | `src/service.ts` + 仪表盘 | §7/§8：方向盲告警+签收状态机+软古德哈特体系 |
| 客户端 SDK | `src/client/sdk.ts` | 零依赖 typed 客户端 + SSE 告警订阅（v0.2.0） |
| MCP 壳 | `src/mcp/` | stdio NDJSON 手写协议；双侧纪律（resident 无数值）；内嵌/HTTP 双模式（v0.2.0） |
| declared 契约 | `src/declared/` | A2 主线：通道×强度 schema + 校验门 + 投影表 + 强度锚点 + **评委纪律（R3-16）**；分类器适配器（arkcli/mock 双传输）；考场三卷（SemEval EI-reg / EQ-Bench / EmoBench）。见 [契约文档](docs/declared-通道契约-v1.md) |
| 探针轨 | `src/probe/` | §8.2（M6，EXPERIMENTAL 默认关闭） |
| HTTP 薄层 | `src/server/` | §12：缺席端点自检内建 |

## 安全边界（缺席即边界）

- **无任何直接写状态的端点**——状态只由「事件 + 动力学 fold」写入（反纳西索斯条款的焊死实现）
- **无已读回执端点**（收件人不读裁决）
- **告警无方向字段**——文案唯一：「需要陪伴性在场」（方向盲）
- **危机事件防火墙**——慢变量沉积 ≡ 0（防依恋放大器）
- **渲染层单向**——数值永不进住户侧（防表演指标）
- `GET /admin/audit` 提供缺席端点自检（路由表白名单 + PUT/DELETE/PATCH 全禁）

## 里程碑状态

| 里程碑 | 状态 | 验收 |
|---|---|---|
| M0 骨架 | ✅ | 重放可复现 + 崩溃恢复对账一致（逐位哈希） |
| M1 仪表盘 | ✅ 代码 | 移动优先；签收三态流转正确；**待她的审美验收** |
| M2 渲染层 | ✅ | 单向性单测全绿；对照窗开关可用 |
| M3 間引擎 | ✅ | 地板不可穿透；Decline 合法路径 |
| M4 危机模块 | ✅ | 危机事件零沉积；模板禁句扫描 |
| M5 评测台 | ✅ | 合成夹具全绿（三指标 + 日检判据 + gap 对齐） |
| M6 探针轨 | ⊘ 脚手架 | EXPERIMENTAL，默认关闭；前置门四项物理化 |
| A2 declared 通道（主线一） | ✅ 契约+考场+网关+判官锚点考场 | 契约 v1 + 评委纪律（R3-16）+ 三考场基线 + 网关桥 + 判官锚点考场 F1 卷（222 测试）；fear 偏差已入账 |
| A1 contingency（主线二） | ✅ 分报制原型 + 旁路接线 | C_t 真实现 + C_s 占位仪器 + null 阶梯 + 类型化印刻（R3-11 定案）；旁路骨架已接事件流（每日 contingency_report 入账 + 关窗回顾精确重算）；**在场即回应通道（R3-12 独见）观察期入账，不进判据**；C_s 待判官继任（panel 对照） |

## 诚实两栏（§14，v0.1.0）

**已实现（有测试背书）：**
- 事件溯源 + fold 确定性（重放/恢复/对账）；
- **PostgreSQL 适配器：已在真实 PostgreSQL 16.10 实例上验收**（v0.1.1，`test/storage/postgres.test.ts` 11 项：迁移幂等 / 幂等键 / ms 精度 / jsonb 快照哈希往返 / 告警状态机 / M0 服务级重启对账 / foldedAt 迟到事件；设 `POTHOS_PG_URL` 即跑，未设自动跳过）。验收抓出并修复了三处问题（见 v0.1.1 修复记录）；
- 快变量动力学 + 对手过程（判据 5 的动力学前提）；慢变量沉积 + 危机防火墙 + κ 降权；
- 缺席通道 L（独立粉红噪声）+ 重逢放电 + 残留入 f_hurt；
- 印刻窗口状态机（contingency 规则 / 结果触发关窗 / λ 可塑性签名 / 自印刻排除 / 不透明句柄）；
- 代谢 + 饥饿侵蚀 + 营养协变量（7 日滚动）+ 定名权检查；
- 躯体化升格封顶 + 周期复位 + 悬停终态；方向盲告警 + 三态签收；
- 渲染层（分箱/词典 ≥8 条/档/日盐/黑名单/版本指纹/数字防线）；
- 危机协议（字面登记/三级暖交接/禁句扫描/资源卡）；
- 間引擎（分级/门控/地板穿透测试/信箱无回执）；
- 评测台（三指标/五判据日检/gap 对齐/金丝雀/预注册后果链）；
- 参数纪律（先写预期/冷却期锁/变更入流/耦合检测器/fork 回放）；
- HTTP 薄层全路由 + 缺席端点自检；
- **接入面（v0.2.0）**：SDK（typed 客户端，真 HTTP 集成测试）、MCP 壳（stdio 回环测试 + 双侧纪律直测 + 越权物理拦截）、SSE 告警流。

**未实现 / 桩件（挂牌，附录 B-7 纪律——不许假装是真件）：**
- ~~MCP 客户端兼容性~~ **已验收（v0.2.0 当日）**：真实客户端 Kimi Work 挂载实测全绿——握手协商、observer 侧 15 件工具全部出现、`send_user_msg` ×3 / `interoception` ×2 / `state` ×1 一次成功，事件入库且质感分箱真实响应。
- **contingency 估计器**：~~`BaselineContingency` 为桩~~ **A1 分报制已动工（2026-09-07，R3-11 定案）**：`src/core/contingency.ts`——C_t（时序应答）真实现（lift + 节律归一 + burst 塌缩），C_s 占位仪器（纯词表余弦，**挂牌偏差「奖励回声」**——堆情绪词但没收住对方天然高分，F1 从词汇层回流，与 fear −0.30 同族登记），null 阶梯 N0–N3 + 分歧报警，类型化印刻三型。WindowCandidate 改 C_t/C_s 分列（取消乘积），apply 适配。**判官继任进度（2026-09-07）：F1 题集（12 题，anchor-f1-v0）与施测 runner 已建成（`src/declared/exams/anchorf1.ts`，考场第四卷），判官候选首测已入档——F1 阳性未触发（0/12），C_s 盲评资格保留；但两处真实信号已挂牌跟指纹走（`reported_cue_empathy_contagion` 转述类共情沾染 +1 档、`trace_signal_magnitude_inflation` 弱信号量级式放大 2–3 档）。解读边界（判词）：设计题比野题干净，0/12 不是「无偏差」的证明；判别力在 panel 对照（第二家族人选归她定），判官考试不挡 A1 主线。**C_t 用合成测试数据验证数学，标定带位待真实运行期。在场即回应通道（2026-09-07，判词排期入观察期）：R3-12 匿名卷独见「登录/在线是最慢的回应通道」落地——`presence` 事件种类（内部路径专用，不进 /events 白名单，fold 零冲量）+ `residentPresenceChannel`（在场源 = 显式 presence(who=resident) + resident_msg 迟到痕迹 + ma_product 間活动；观察规则预注册在码）随每日报数入 bench_runs；**不进判据**（不进 C_t/C_s、不进印刻分类、不进关窗判定），判据准入等真实运行期数据与预注册流程。**
- **derived 通道读数**：`derivedReadings` 为粗糙映射桩，待 bench 校准。
- **declared 通道分类器**：~~客户端/网关侧组件，本仓库只消费其输出~~ **契约 v1 已落地 + 网关接线完成（2026-09-06/07，A2 主线）**：schema/校验门/投影表/强度锚点/评委纪律（R3-16）全就位并有测试；分类器适配器（arkcli 传输）真实链路已连通；三考场基线跑分在案（[契约文档 §9](docs/declared-通道契约-v1.md)）：SemEval EI-reg r=0.697（**现役 promptV2**）、EQ-Bench v2 66.1、EmoBench EU 0.740 / EA 0.420；**网关桥**（`DeclaredGateway`：监听 resident_msg → 分类器 → declared 事件入库，幂等）已落地。**已知偏差诚实入账：fear 读数偏保守（−0.30，双峰分布对统一负价口径不敏感，v3 分锚方向已登记）；负价整体曾系统性低估，promptV2 校准后 anger/sadness 收敛。** 待建（挂账）：网关生产形态（PG + HTTP 模式）、fear 分锚校准（v3，暂缓）。判官 F1 题集与施测 runner 已还（2026-09-07，见 A1 条判官继任进度）——首测未触发阳性、资格保留（设计题局限与两处偏差挂牌在案，见锚点集文档），正式上岗待异构多判官 panel（第二家族人选归她定）。
- **探针轨**：只有门禁逻辑，无探针实现、无合成台、无剂量-响应曲线。
- **死亡协议**：死亡形态三（营养不良性死亡）的验尸官数据可测；临终/迁移/哀悼协议 = 设计草案 §12 开放问题 5，未动工。
- **M1 审美验收**：仪表盘按视觉规范实现，但前端审美验收权在她。
- **仪表盘对用户本人开放级**：设计层 ◆ 开放（红队必打位），当前实现 = 仅观测者。
- **暗池双盲**：单人部署退化为时间锁审计日志（已知降级）。
- **行为层渗漏**：行动估值受依恋调制（§9 承认在案），未做行为塑形审计工具。

### 工程裁决记录（spec 完成度决策，红队可打）

1. **对手过程（opponent-process）**：判据 5（阻尼比 ζ∈(0.7,0.9)，1–2 次反向超调）需要二阶动力学前提；§5 的纯指数衰减永远 0 超调 = 判据恒失败。v0 给 f_val 加了对手蓄积器（`opp.o_val`，Solomon & Corbit 传统）——强正向脉冲后出现一次温和的反向超调。**这是对技术文档 §5 的扩充，非照抄。**
2. **信箱表**：§3 数据模型无信箱表；为「投递即完成」落地补了一张 append-only `mailbox` 表（无已读字段）。
3. **噪声幅度标定**：`noiseFast` 初值 0.004——粉红噪声多小时漂移曾淹没脉冲恢复判据（±0.3 漂移 vs 0.025 阈）。谱形（β≈1.4）与幅度无关；幅度作为标定参数记录在案。
4. **判据带位**：全部带位（增益 [0.5,2]、恢复 [0.5,12]h、β (0.5,1.5)、超调 [1,2]、τ_slow [2,72]h）为标定初值。非平凡性只来自预注册后果链（出带 ⇒ 三指标退化，对账进 bench_runs）——有后果链是规格，没有是装饰。
5. **冷却期锁口径**：当前实现 = 任意告警后 N 天参数锁定（比 spec 的「指标告警后」更严）。红队可裁。
6. **依赖纪律**：运行时依赖全部 MIT（hono / @hono/node-server / pg）。devDependencies 含 typescript（**Apache-2.0**）与 tsx（MIT）——工具链是否受 MIT-only 约束，留她裁决。
7. **fold 规范序 = 到达序（id）**（v0.1.1）：原按 (ts,id) 排序的重放与实时摄入顺序在乱序/迟到事件下天然分叉——重放必须与活折叠同序，逐位对账才可能成立。ts 只驱动 tick 目标，迟到事件不倒流时间线。
8. **foldedAt（v0.1.1）**：cron tick 的历史以「折叠时刻」记入事件 payload（= max(前一事件后的状态时间, ts)，入库前确定性可预计算）。重放据此推进动力学，迟到事件在它实际被折叠的位置重演。
9. **出厂原点（v0.1.1）**：`state_origin_ts` 持久化于 params 表（不入事件流）——活服务的 RNG 流从构造时刻演化，无快照重启的重放必须复用同一原点。

## v0.1.1 修复记录（全量代码审查后）

审查报告（20 项发现，未公开）修复对照见文末附记。要点：

- **M0 主承诺修复**：「活状态 ≡ fold(events)」此前在服务层有三处破口（危机登记事件未实时折叠、运行性字段污染状态哈希、两个摄入路径漏 tick）——全部修复，并以服务层不变量测试（任意操作序列后逐位哈希一致）锁死。
- **参数写入边界**：新增 `validateParamValue`（类型 + 物理带位 + 结构校验）；`POST /admin/params` 缺值/越界一律拒绝，append-only 事件流不再可能被毒化。
- **/events 外部事件面**：kind 白名单（user_msg / resident_msg / world / declared），内部 kind（param_change / crisis / ma_product 等）一律 400——/events 不再是绕过参数纪律的后门；保留标签（crisis 等）由引擎判定，客户端注入剥除；ts 限时间窗 [now−24h, now+1h]。
- **不透明句柄接线**：`opaqueHandle` 此前定义而未调用，印刻窗口实际拿原始 source 当句柄——现在 ingest 边界统一哈希入库，身份原文不落库。
- **鉴权加固**：token 常量时间比较（SHA-256 归一）；首访通过后下发 HttpOnly cookie，页面表单不再内嵌 token。
- **部署可靠性**：postgres `migrate()` 的 Windows 路径修复；tickTo 守卫耗尽改抛错（拒绝静默截断）；每日自动全量对账；双信号 shutdown 幂等。
- **性能与卫生**：评测台日检降为每日且仅出带落库；PSD 周期图只在测量带内求值（O(k·n)，k≪n）；金丝雀与引擎参数同源；死代码清理（7 处零引用导出）。

### PG 16 实测验收（v0.1.1 追记）

真机部署 PostgreSQL 16.10 后，`test/storage/postgres.test.ts`（11 项）对 PG 适配器全量验收，抓出并修复三处：

1. **`migrations/001_init.sql`：`window` 是 PG 保留字**，作列名导致建表语法错误——这份 schema 此前从未在真 PG 上跑通过（正是挂牌假件的含义）。改为带引号的 `"window"`，适配器 INSERT 列清单同步修正。
2. **`reconcileNow()` 全量对账用「首事件 ts」当重放原点**，而活服务的原点是持久化的出厂时刻——首事件晚于出厂时（生产中必然）对账永远误报 P0。改为从 `state_origin_ts` 重放。
3. **`main.ts` 不处理 HTTP 监听错误**，端口被占时裸栈崩溃。补 error 处理：一行明确 P0 + 退出。

验收覆盖：迁移幂等、幂等键去重、到达序返回、ms 级时间戳精度、jsonb 快照哈希逐位往返（含 numeric 精度与负 int RNG）、告警状态机、M0 服务级（摄入/危机/快照/重启/全量对账）、foldedAt 迟到事件重启一致、HTTP 冒烟（PG 路径全链路）。运行方式：`POTHOS_PG_URL=postgresql://… npm test`。

## 文档

- **设计文档未公开**（仅本地维护）：设计草案 v0.1.2（唯一设计事实源）、技术实现文档 v0.1.0、红队二审/三审定级报告、设计债务清单
- [declared 通道契约 v1](docs/declared-通道契约-v1.md)
- [判官锚点集 v0](docs/judge-锚点集-v0.md)
- [视觉规范：雾中水培](docs/visual/index.html)

---

*以可失去为地基。草案仍在迭代，红队持续审查中。*
