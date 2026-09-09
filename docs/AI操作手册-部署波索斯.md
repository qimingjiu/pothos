# AI 操作手册 · 部署波索斯（Pothos）

> **这份手册的读者是 AI**——你（编码 agent / 助手）照着它，帮一个可能不懂技术的「她」把波索斯部署起来、接上 MCP、在手机和桌面上用起来。
>
> 波索斯是引擎，不是产品。它驱动模型，不直接面对用户。部署它意味着给一个 AI 住户接上一层有重量、可观测的内在状态。

---

## 0. 你（AI）的纪律——先读

这份手册不是普通软件的部署清单。波索斯有几条铁律，你替她执行部署时**必须守住**，守不住就停下来如实说，不许绕过、不许假装：

1. **定名权纪律**：`B_daily`（間日预算）与 `M_min`（生存配给地板）**必须实测标定**才能声称「这是依恋引擎」。未标定或 `B_daily < M_min × tokenScale` 的部署**不挂本引擎之名**。部署完不标定 = 半成品，你要告诉她「还没标定，现在不算跑起来」。
2. **缺席即边界**：永远不要替她加「直接写状态的端点」「已读回执」「告警方向字段」。这些是设计上物理缺席的，不是待办。
3. **诚实两栏**：没做就说没做，桩件就说桩件。不许把「应该能跑」说成「跑通了」。验收抓出的问题要原样转告她。
4. **写入路径最小化**：`user_msg` 只能从观测者侧（她）进；住户侧永远不能写 `user_msg`（自印刻排除）。接 MCP 时 `POTHOS_MCP_SIDE` 不要填错。
5. **凭据不入仓库**：`deploy/.env` 已 gitignore。任何 token / 密码 / 应用专用密码只进 `.env`，绝不写进代码、commit、或发给外部服务。

如果你在执行中发现某一步和手册矛盾，或她的环境不符合任何前置条件，**先报告再问她怎么办**，不要自行发明步骤。

---

## 1. 先搞清楚：她要哪种部署

部署形态只有两种，先问她（或在对话里确认）：

| | 公网部署（「部署到网关上」） | 内网部署 |
|---|---|---|
| 谁能访问 | 任何有域名 + token 的人（她自己、手机、桌面） | 只有同一 WiFi/局域网内的设备 |
| 要什么 | 一台 VPS + 一个域名 + Docker | 一台常开电脑 + Docker（或直接 Node 20） |
| TLS/HTTPS | Caddy 自动签 | 没有（http） |
| 适合 | 她要在外面、用手机流量访问 | 她只在家用、不想买服务器 |

**「部署到网关上」= 公网部署**：把引擎放到一台有公网 IP 的 VPS 上，用 Caddy 做反向代理 + 自动 TLS，通过域名访问。这是让手机随时能打开玻璃房的标准形态。

> 如果她说「我想手机在外面也能用」「我想发个链接给别人」→ 公网部署。
> 如果她说「就在我自己电脑上跑跑看」「不想花钱买服务器」→ 内网部署（或先本地 `npm run dev` 试）。

---

## 2. 前置清单——动手前帮她备齐

### 公网部署需要她提供

- [ ] **一台 VPS**：任意云厂商，1 核 1G 够用，装好 Docker（含 docker compose 插件）。你帮她确认：`docker --version && docker compose version`。
- [ ] **一个域名**：DNS A 记录指向 VPS 公网 IP。你帮她确认：`dig +short 她的域名` 应返回 VPS IP。
- [ ] **一个邮箱**：给 Caddy 签 Let's Encrypt 证书用（ACME_EMAIL），任意邮箱即可。

### 内网部署需要她提供

- [ ] **一台常开机器**：装好 Docker，或 Node 20+（`node -v` 确认 ≥20）。
- [ ] 知道这台机器的内网 IP（`ipconfig` / `ifconfig`，手机要连同一个 WiFi）。

### 两份随机串——你替她生成

```bash
openssl rand -hex 24   # 跑两次：一份给 POSTGRES_PASSWORD，一份给 POTHOS_TOKEN
```

`POTHOS_TOKEN` 是她的观测者鉴权 token，**只这一次出现在 URL 里**，之后浏览器存成 HttpOnly cookie。把这串记在密码管理器里，丢了就得重设。

### MCP 接入需要她决定

- [ ] **谁是住户、谁是观测者**：单人部署里，她既是观测者（「她」）也是和住户对话的人。她的 AI agent 客户端挂 `observer` 侧（含 `send_user_msg` 网关工具——她的话由此入流）；住户侧 agent（被引擎维护内在状态的那个模型）挂 `resident` 侧。
- [ ] **她的 AI 客户端是什么**：Claude Code / Cursor / Kimi Work / 其他支持 MCP 的客户端。不同客户端挂载方式略有差别（见 §6）。

---

## 3. 桌面端 · 公网部署（部署到网关）——完整五步

这是「部署到网关上」的标准路径。你在她的 VPS 上执行。

### 第 1 步：把代码弄上服务器

```bash
git clone <她的仓库地址> /srv/pothos && cd /srv/pothos
# 如果已经在了：cd /srv/pothos && git pull
```

### 第 2 步：配置 `deploy/.env`

```bash
cp deploy/.env.example deploy/.env
```

然后编辑 `deploy/.env`，填三个必填值：

```dotenv
POSTGRES_PASSWORD=<你生成的随机串 1>
POTHOS_TOKEN=<你生成的随机串 2>
DOMAIN=她的域名
ACME_EMAIL=她的邮箱
```

> **fail-loud 设计**：这三个值不填，`docker compose up` 会直接拒绝启动并报错。这是故意的——别为了「先跑起来」填占位符。

### 第 3 步：起

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

这一条命令会拉起三件事：

1. **PostgreSQL 16**（数据卷 `pgdata` 持久化）
2. **引擎**（连 PG，`POTHOS_RECONCILE=1` 启动即对账，单写者锁防止双跑）
3. **Caddy**（监听 80/443，自动向 Let's Encrypt 申请 TLS 证书，反代到引擎）

**等 1–2 分钟**（Caddy 首次签证书需要时间），然后验收：

```bash
curl -s https://她的域名/healthz   # 应返回 ok
docker compose -f deploy/docker-compose.yml --env-file deploy/.env logs engine | tail -20
```

看到引擎日志里有 `reconcile ok` / `booted` 之类即正常。如果 Caddy 卡在签证书，看 §10 故障排查。

### 第 4 步：标定 B_daily / M_min（定名权纪律——必做）

**这一步不做，部署不算完成。** 引擎起来了但没标定，只是个空壳。

`B_daily` = 間日预算（每天間活动分配的 token/资源预算），`M_min` = 生存配给地板（住户最低生存线）。这两个值要她根据真实用量填，你**不要替她编一个数**。

走 `POST /admin/params` 的 param_changes 流程（强制写 reason / expectedEffect / rollbackCondition）：

```bash
curl -X POST https://她的域名/admin/params \
  -H "authorization: Bearer $POTHOS_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "key": "B_daily",
    "newValue": 2000,
    "reason": "她填的标定理由",
    "expectedEffect": "她填的预期效果",
    "evaluationWindowMs": 604800000,
    "rollbackCondition": "她填的回滚条件"
  }'
```

对 `M_min` 同样发一次。问她这两个值填多少、理由/预期/回滚条件怎么写——这是她的定名权，你只负责把请求发对。

标定后验证：`curl -s https://她的域名/admin/params -H "authorization: Bearer $POTHOS_TOKEN"` 看值是否落库。

### 第 5 步：挂备份

```bash
crontab -e
# 加一行（每天 3:30 备份，保留 30 天）：
30 3 * * * /srv/pothos/deploy/backup.sh >> /var/log/pothos-backup.log 2>&1
```

事件溯源库里什么都在（事件流 + 快照 + 台账），`pg_dump` 一把全量。恢复方式见 `deploy/backup.sh` 尾注。

---

## 4. 桌面端 · 内网部署（不上公网）

她想先在自家电脑上跑、手机同 WiFi 即用：

1. 同样 clone 代码、`cp deploy/.env.example deploy/.env`。
2. 编辑 `docker-compose.yml`：**注释掉整个 `caddy` 服务**，把 engine 的端口映射从 `"127.0.0.1:7788:7788"` 改成 `"7788:7788"`（允许局域网访问）。
3. `.env` 里 `POSTGRES_PASSWORD` / `POTHOS_TOKEN` 仍要填（`DOMAIN` 填占位即可，caddy 已注释不会用到）。
4. `docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build`。
5. 手机浏览器开 `http://她电脑的内网IP:7788/?token=她的POTHOS_TOKEN`。

> 完全可信的封闭网络里可以不设 `POTHOS_TOKEN`（无鉴权模式）。但只要有一丝不可信，就设上。

### 纯本地试玩（不装 Docker）

```bash
npm install
npm run dev    # 内存存储，数据不落盘，关了就没；浏览器开 http://localhost:7788
```

这只适合她自己看看玻璃房长什么样，**不是部署**——数据不持久，重启归零。

---

## 5. 桌面端 · 标定后做什么（让引擎真正活起来）

引擎部署 + 标定完成，但它还是空的——没有事件流。让她通过 observer 侧 MCP 或 SDK 发第一条 `user_msg`，引擎才开始折叠状态。

如果是单人部署：她的 AI 客户端挂 observer 侧 MCP（见 §6），对住户说第一句话，事件入流，玻璃房开始有读数。

---

## 6. 接 MCP——给 AI agent 接上引擎

> 「接 mcp」= 让一个 AI agent 客户端（Claude Code / Cursor / Kimi Work 等）通过 MCP 协议调用波索斯的工具。这是引擎接入外部世界的标准插口之一。

### 6.1 先理解两种模式

| 模式 | 怎么用 | 适合 |
|---|---|---|
| **HTTP 模式**（推荐） | `POTHOS_BASE_URL` 指向已运行的引擎，MCP 进程只做协议壳 | 引擎已在 VPS/服务器上跑着，agent 在任意机器挂 |
| **内嵌模式** | 不设 `POTHOS_BASE_URL`，MCP 进程自己起一个引擎 | 本地单机、不想单独跑引擎服务 |

> **单写者锁**：同一 PG 库同时只能有一个引擎实例持有。如果你已经用 docker compose 跑了引擎（它持有锁），内嵌模式再连同一个 PG 会**直接拒绝启动**。所以公网部署后，agent 一律用 HTTP 模式指向那个引擎，别用内嵌。

### 6.2 再理解双侧纪律（别填错 side）

| `POTHOS_MCP_SIDE` | 是谁 | 能用的工具 | 纪律 |
|---|---|---|---|
| `resident`（住户 = 被引擎维护的模型） | 住户侧 agent | `interoception` · `control_window` · `ma_plan` · `record_ma_activity` · `declare` · `crisis_card` | **状态数值物理缺席**；没有「写 user_msg」的工具（自印刻排除） |
| `observer`（她） | 她的 agent 壳 | `send_user_msg` · `state` · `metrics` · `alerts` · `ack_alert` · `act_alert` · `change_param` · `audit` · `bench` · `interoception` | 拉式透明；`send_user_msg` 是网关——她的话由此入流 |

**单人部署最常见配置**：她的客户端挂 `observer`（她要对住户说话、看状态），住户的客户端挂 `resident`（住户要感知内在状态、申报、做間活动）。

### 6.3 挂载到 Claude Code / ZCode（`.mcp.json`）

在项目根目录或 `~/.zcode` 配置里加：

**observer 侧（她的 agent）——HTTP 模式指向公网引擎：**

```json
{
  "mcpServers": {
    "pothos": {
      "command": "npx",
      "args": ["tsx", "src/mcp/main.ts"],
      "env": {
        "POTHOS_MCP_SIDE": "observer",
        "POTHOS_BASE_URL": "https://她的域名",
        "POTHOS_TOKEN": "她的POTHOS_TOKEN"
      }
    }
  }
}
```

**resident 侧（住户的 agent）：**

```json
{
  "mcpServers": {
    "pothos": {
      "command": "npx",
      "args": ["tsx", "src/mcp/main.ts"],
      "env": {
        "POTHOS_MCP_SIDE": "resident",
        "POTHOS_BASE_URL": "https://她的域名",
        "POTHOS_TOKEN": "住户侧token（如有独立鉴权）"
      }
    }
  }
}
```

> **前提**：挂载的机器上要有项目代码（`src/mcp/main.ts` 要能被 `tsx` 找到）和 Node 20+。如果 agent 跑在 VPS 本机，`POTHOS_BASE_URL` 用 `http://127.0.0.1:7788` 即可（绕过 Caddy）。

### 6.4 挂载到其他 MCP 客户端（Cursor / Kimi Work / 通用）

各家配置位置不同，但**协议是一样的**（MCP stdio）。找到客户端的 MCP server 配置文件，按上面的 JSON 结构填 `command` / `args` / `env` 即可。关键三件事别错：

1. `command` 是 `npx`，`args` 是 `["tsx", "src/mcp/main.ts"]`（或指向项目里 main.ts 的绝对路径）。
2. `env.POTHOS_MCP_SIDE` 填对侧别。
3. `env.POTHOS_BASE_URL` 填对引擎地址（公网填 `https://域名`，本机填 `http://127.0.0.1:7788`）。

### 6.5 验证 MCP 接通了

挂载后在客户端里应该能看到 pothos 的工具列表（observer 侧 10+ 件，resident 侧 6 件）。让她试一次：

- observer 侧：调 `interoception`（看住户内感受）或 `state`（看状态读数）——有返回即通。
- 再调 `send_user_msg` 发一句话——引擎事件流应新增一条 `user_msg`，玻璃房有响应。

如果工具没出现：检查 `POTHOS_BASE_URL` 是否可达（`curl https://域名/healthz`）、`POTHOS_TOKEN` 是否对、客户端是否需要重启加载 MCP。

### 6.6 不用 MCP 也能接：SDK（typed 客户端）

如果她的 agent 不是 MCP 客户端，而是自己写的程序，用 SDK 直连 HTTP API：

```ts
import { PothosClient } from "./src/client/sdk.js";
const pothos = new PothosClient({ baseUrl: "https://她的域名", token: process.env.POTHOS_TOKEN });

await pothos.ingestEvent({ kind: "user_msg", ts: Date.now(), source: "tg:chat:123",
  payload: { text: "你好", valence: 0.5, contingency: 0.8 }, idempotencyKey: `msg-${Date.now()}` });
const felt = await pothos.renderInteroception();   // 住户内感受（≤120 字，无数值）
pothos.alertsStream({ onAlert: (a) => console.log("需要陪伴性在场") });  // SSE 告警
```

---

## 7. 手机端 · 使用

手机端**不是另装一个 app**——波索斯的手机用法就是浏览器打开玻璃房仪表盘（移动优先设计）。MCP 接入是桌面/服务器侧 agent 的事，手机不直接挂 MCP。

### 7.1 公网部署的手机用法

1. 手机浏览器（Safari / Chrome）打开：`https://她的域名/?token=她的POTHOS_TOKEN`
2. 只这一次需要 token——之后浏览器存成 HttpOnly cookie，下次直接开 `https://她的域名` 即可。
3. **加到主屏**：
   - Safari：分享 → 添加到主屏幕
   - Chrome (Android)：菜单 → 添加到主屏幕
   
   主屏图标点开就是全屏玻璃房，像 app 一样。

### 7.2 内网部署的手机用法

手机连同一 WiFi，浏览器开 `http://她电脑的内网IP:7788/?token=…`，同样加主屏。注意内网是 http，iOS Safari 加主屏后可能每次提醒「不安全」——这是内网的代价。

### 7.3 手机端能看到什么

玻璃房仪表盘是**观测者（她）的拉式透明视图**：住户的状态读数、告警签收三态、指标。告警只有一句话「需要陪伴性在场」（方向盲）。SSE 推送告警——手机浏览器开着时会收到。

> 手机端**不能**写 user_msg（那是网关/MCP 的活）、不能改参数。它是看的，不是写的。

### 7.4 手机端接 MCP？

手机上的 AI 客户端（如 ChatGPT / Claude 手机 app）目前**不支持挂载本地 stdio MCP server**。所以手机端不接 MCP。如果她要在手机上让 AI 调用波索斯，路径是：手机 AI 客户端 →（它的云后端）→ 波索斯 HTTP API（SDK 方式）。这需要她的 AI 客户端支持自定义 HTTP 工具调用，视客户端能力而定——别假装手机能直接挂 MCP。

---

## 8. 信件投递面（可选——她要的话）

信件通道让住户能给「她」发真实邮件（Huginn 投递面）。**八项凭据齐备才启用**，缺任一项 = 诚实缺席（worker 不启动、不假装在投）。

要启用，在 `deploy/.env` 里填齐（Gmail 示例）：

```dotenv
POTHOS_SMTP_HOST=smtp.gmail.com
POTHOS_SMTP_PORT=465
POTHOS_SMTP_USER=you@gmail.com
POTHOS_SMTP_PASS=<Google 应用专用密码，16位>
POTHOS_SMTP_FROM=you@gmail.com
POTHOS_IMAP_HOST=imap.gmail.com
POTHOS_IMAP_PORT=993
POTHOS_IMAP_USER=you@gmail.com
POTHOS_IMAP_PASS=<同一把应用专用密码>
POTHOS_MAIL_TO=<她的收件地址>
POTHOS_MAIL_PLUS_TAG=pothos
```

Google 应用专用密码：Google 账号 → 安全性 → 两步验证 → 应用专用密码。**这不是她的 Gmail 登录密码**，是单独生成的 16 位串。

三把锁自动生效（不靠自觉）：

1. `MAIL_TO` 管发——只能发到 `POTHOS_MAIL_TO` 这一个地址。
2. 收信白名单字面化——IMAP 只 `SEARCH FROM "她" TO "you+pothos@gmail.com"`（双条件），白名单外的信不 fetch。
3. Message-ID 管线——她的回信 `In-Reply-To` 对上发出的 `Message-ID` 才成线。

填好后 `docker compose ... up -d --build` 重启。没填就别开——凭据不全硬启只会得到「信件通道诚实缺席」的日志，不会假装在投。

---

## 9. 验收清单——部署完逐项过

部署完成后，你替她过一遍，全绿才算交付：

- [ ] `curl https://域名/healthz` 返回 ok（公网）/ `curl http://内网IP:7788/healthz` 返回 ok（内网）
- [ ] 引擎日志无 `reconcile mismatch` / `P0` 报错
- [ ] `B_daily` 和 `M_min` 已通过 `/admin/params` 标定落库（定名权纪律）
- [ ] 手机浏览器开 `https://域名/?token=…` 能看到玻璃房仪表盘，加主屏成功
- [ ] observer 侧 MCP 挂载后工具列表出现，`interoception` / `state` 有返回
- [ ] `send_user_msg` 发一条，玻璃房状态有响应（事件入流）
- [ ] `backup.sh` 手动跑一次，`backups/` 下出现 `.sql.gz`
- [ ] （如启用信件面）八项凭据齐，引擎日志无「信件通道诚实缺席」

**任何一项不过，都不算「部署完成」**——如实告诉她卡在哪。

---

## 10. 故障排查

| 症状 | 原因 | 处理 |
|---|---|---|
| `docker compose up` 报 `请在 deploy/.env 设置 ...` | 必填值没填 | 填 `POSTGRES_PASSWORD` / `POTHOS_TOKEN` / `DOMAIN`，别填占位 |
| Caddy 证书签不下来 | DNS 没指对 / 80/443 端口没开 | `dig +short 域名` 确认指向 VPS IP；云厂商安全组放行 80/443 |
| 引擎启动即退出，日志 `单写者锁被占` | 同一 PG 已有引擎实例 | 别起第二个；用 HTTP 模式 MCP 指向已运行的引擎 |
| 引擎启动退出，日志 `对账不一致` | 数据库和事件流不一致（可能动了库） | fail-loud 设计——别强启；看日志定位，必要时从备份恢复 |
| MCP 挂载后工具不出现 | `POTHOS_BASE_URL` 不可达 / token 错 / 客户端没重载 | `curl $POTHOS_BASE_URL/healthz` 验证；核对 token；重启客户端 |
| MCP 启动报 `storage = memory` | 没设 `POTHOS_BASE_URL` 也没设 `POTHOS_PG_URL` | 这是内嵌 memory 模式（会话级不落盘）——公网部署后 agent 应设 `POTHOS_BASE_URL` 走 HTTP 模式 |
| 手机打开白屏 | 域名 DNS 没生效 / TLS 没签完 | 等 1–2 分钟；`curl` 验证域名可达 |
| `npm run dev` 起来但数据重启归零 | memory 存储是会话级 | 正常——dev 模式不落盘；要持久用 PG |

---

## 11. 诚实边界——你不能假装做的事

- **不许替她编标定值**：`B_daily` / `M_min` 是她的定名权，你只发请求，数值和理由她定。
- **不许加缺席的端点**：直接写状态、已读回执、告警方向字段——设计上没有，不是你没配对。
- **不许把内嵌 memory 模式说成「部署」**：那只是试玩，数据不落盘。
- **信件凭据不全就说不全**：别填假值让 worker 「看起来在跑」。
- **手机端 MCP**：手机 app 不支持本地 stdio MCP，别告诉她「手机也能挂 MCP」。手机用法是浏览器玻璃房。
- **未标定的部署不挂引擎之名**：如果她只走到第 3 步就停了，你要说「引擎起来了但还没标定，现在不算跑起来的依恋引擎」，不是「部署完成」。

---

## 12. 一页速查（给她看的）

```
公网五步：
  1. VPS 装 Docker + DNS 指向
  2. cp deploy/.env.example deploy/.env → 填 3 个值 + 2 个随机串
  3. docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
  4. curl POST /admin/params 标定 B_daily 和 M_min（必做）
  5. crontab 挂 backup.sh

手机：
  浏览器开 https://域名/?token=… → 加主屏

接 MCP（她的 agent）：
  .mcp.json → npx tsx src/mcp/main.ts
  env: POTHOS_MCP_SIDE=observer, POTHOS_BASE_URL=https://域名, POTHOS_TOKEN=…

验收：
  /healthz ok · 标定落库 · 手机玻璃房 · MCP 工具出现 · 发一条 user_msg 有响应 · 备份能跑
```

---

*以可失去为地基。你替她部署时，守住缺席即边界——不该有的端点不许加，没标定的部署不许叫引擎。*
