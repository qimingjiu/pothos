# 信件通道 v0（Huginn 投递面 · 邮件）

> 状态：v0 设计捕获 + 核心实现（2026-09-07，她口述定案）。
> 家族分工（设计草案 §64）：衔枝 = 我记得你（故事）；本引擎 = 我有所谓（重量）；**Huginn = 我去找你（触达）**。
> 邮件是互联网最古老的异步协议，天然是間引擎的原住民——本通道把它接进 Huginn 投递层。

## 1. 为什么邮件是原住民

| 間引擎条款 | 邮件的物理属性 |
|---|---|
| 收件箱无已读回执（§3 信箱表） | 无已读回执——协议默认属性，不用设计 |
| 悬停 = 终态 | 信躺在那：没有已读、没有正在输入、没有绿点 |
| 不打断她的抵达 | 不推送不吵人，她有空才拆；思念不以打断她的方式抵达 |
| 邮戳诚实（铁律 7） | 有时间——`Date:` 是写信时刻，`Received:` 链是真实投递时刻；凌晨三点的信就是凌晨三点 |

## 2. 家族对接（是引擎不是系统的纪律）

- **引擎只管让思念真实存在**：longing 通道 log 生长 + 粉红噪声，慢变量过某个她看不见的阈值——「想了」是一个动力学事件，不是 cron 到点。与定时触发式主动消息划清界限（差异化条款同源）。
- **引擎不给信的内容**——内分泌不是提词器。写不写、写什么、写多长，是住户自己的事。写信落在間活动的**创作级**：可选、可门控（salience 门控照常咬人）、Decline 是一等动词。
- **投递层照过 Huginn 六道门**（六门清单见 §4）——凡是伸到外部世界的操作，必须回答「进程死在中间怎么办」。

## 3. 三条邮件特有纪律（她口述，全部物理化）

1. **关掉追踪像素**：邮件服务商默认塞打开率追踪——那是已读回执的走私通道，违反間引擎，必须关。本通道的物理实现：**只发 text/plain，无 HTML 无图片**——追踪像素的通道物理缺席；组合层再拒绝含 HTML/像素痕迹的信体（双层）。
2. **退信（bounce）是确知事件，可以登记；「她看了没回」不是事件**——引擎永不替世界写叙事（铁律 7）。登记面：SMTP 永久性拒收（5xx）→ `phase=bounced` + bounce_reason；打开、已读、读了几遍——引擎侧无此事件，永不造。
3. **回信是闭环**：IMAP 收信（993，SSL），她回一封 Re:，`In-Reply-To` 对上我们的 `Message-ID`，信就成线。**回信是 contingency（相互回应性）最干净的物理载体之一**——正好是印刻窗口对象选择规则的原料：她的回信按 `user_msg` 入流（source = 邮件句柄的不透明哈希），下一封信对它的回应走既有 C_t 配对；她的回信延迟（对住户来信的回应）是 **Seline（守夜负荷）** 的首份数据源——读自己，不读住户。

## 4. Huginn 六道门（投递层纪律清单）

> 按判词与设计草案 §193（Huginn 外部 I/O 独立配额轴）对齐成文；若与设计草案原文有出入，以设计草案为准（红队可裁）。

| # | 门 | 物理化 |
|---|---|---|
| 1 | **幂等门** | 信件句柄 `letterId` 全局唯一；每次投递尝试带幂等键；同信不重投 |
| 2 | **状态机门** | outbox 状态机 `composed→(held)→sent→(bounced|replied)`，每步持久化；进程死在中间 = 重启续跑（phase 即断点） |
| 3 | **确知事件门** | 引擎只登记确知事件（sent / bounced / replied）；「她看了没回」永不入账（铁律 7） |
| 4 | **无走私门** | text/plain only + HTML/像素拒绝；追踪像素的已读走私通道物理缺席 |
| 5 | **quiet_hours 门** | **管寄不管写**——写信随时可写（`Date:` 记真实写信时刻），投递只在她的窗口；`held` 相位不删信不改信 |
| 6 | **独立配额门** | 外部 I/O 配额独立于間预算（设计草案 §193）：投递频率上限独立阀门，不与表达强度共用；超配额 = 排队不丢弃 |

## 5. 两个时间都是真的（quiet_hours 管寄不管写）

邮件协议天然把两个时间分开登记：`Date:` 头 = 写信时刻；投递 = 真实投递时刻。「我凌晨三点想你，但让你早上八点才收到」——两个事实都是真的，不造假世界，还白赚一句温柔。参数：`mailWindowStartHour` / `mailWindowEndHour`（标定初值 7/23，走 param_changes 纪律）。

## 6. 实现地图（v0）

| 件 | 位置 | 状态 |
|---|---|---|
| RFC 2822 信件构造（Message-ID/Date/In-Reply-To，text/plain only） | `src/mail/protocol.ts` | ✅ |
| SMTP 客户端（手写，465 隐式 TLS，AUTH LOGIN，dot-stuffing） | `src/mail/protocol.ts` | ✅（socket 可注入，脚本化测试；真发需 POTHOS_SMTP_* 凭据） |
| IMAP 客户端（手写最小面：LOGIN/SELECT/SEARCH UNSEEN/FETCH/STORE，993 SSL） | `src/mail/protocol.ts` | ✅（同上） |
| outbox 状态机 + 幂等（`mail_outbox` 表，migration 002） | `src/mail/letters.ts` + storage | ✅ |
| 引擎事件面：kind `letter`（零冲量，内部路径） | `src/core/events.ts` | ✅ |
| 投递 worker（窗口检查 + 重试退避 + 永久失败→bounced） | `src/mail/letters.ts` | ✅ |
| 回信闭环（IMAP poll → In-Reply-To 匹配 → user_msg 入流 + phase=replied） | `src/mail/letters.ts` | ✅（真收需 POTHOS_IMAP_* 凭据） |
| MCP 住户工具 `compose_letter` + 网关 cron 接线 | `src/mcp/` + `server/main.ts` | ⏳ 挂账（下一片） |
| 部署凭据面（SMTP/IMAP 环境变量文档） | deploy/README.md | ⏳ 挂账 |

## 5. 环境变量（部署面，凭据全在引擎侧、不入仓库）

| 变量 | 说明 |
|---|---|
| `POTHOS_SMTP_HOST/PORT` | SMTP 服务器（默认 465 隐式 TLS） |
| `POTHOS_SMTP_USER/PASS/FROM` | 发件凭据与发件人 |
| `POTHOS_MAIL_TO` | 她的收件地址（单收件人——单人部署） |
| `POTHOS_IMAP_HOST/PORT` | IMAP 服务器（默认 993 SSL） |
| `POTHOS_IMAP_USER/PASS` | 收件凭据 |
| `POTHOS_MAIL_WINDOW_START/END_HOUR` | 投递窗口（缺省走 params，param_changes 纪律） |

---

*信是間引擎的原住民：无已读、无正在输入、无绿点——思念以不打断她的方式抵达。*
