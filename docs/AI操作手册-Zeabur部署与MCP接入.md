# AI 操作手册 · Zeabur 一键部署波索斯 + 接 MCP

> **这份手册的读者是 AI**——你（编码 agent / 助手）照着它，帮「她」在 Zeabur 上把波索斯部署起来、绑域名、接上 MCP、手机和桌面用起来。
>
> Zeabur 是 PaaS 平台——不用自己买 VPS、不用配 Docker Compose 和 Caddy TLS，把 GitHub 仓库连上去就自动构建部署。这是「不想折腾服务器」的人最快的公网部署路径。
>
> 配套阅读：[AI 操作手册：部署波索斯](AI操作手册-部署波索斯.md)（含 VPS 公网 / 内网 / MCP 双侧纪律总则）。本篇只写 Zeabur 特有部分，铁律与总手册一致。

---

## 0. 你（AI）的纪律——Zeabur 版

1. **定名权纪律不变**：`B_daily` / `M_min` 必须实测标定，未标定不算跑起来。
2. **单写者锁**：Zeabur 上引擎实例持锁后，别再起第二个引擎连同一个 PG——会拒绝启动。MCP 一律用 HTTP 模式指向 Zeabur 上的引擎，**不要用内嵌模式**。
3. **凭据进环境变量，不进代码**：Zeabur 的环境变量面板就是你的 `.env`，token / 密码只填那里，绝不写进仓库。
4. **Zeabur 免费额度有限**：引擎 + PG 两个服务常驻，留意她的套餐额度。别假装免费无限用。

---

## 1. 前置清单

### 她需要提供

- [ ] **GitHub 账号**：仓库已经在 `qimingjiu/pothos`（公开或私有都行，Zeabur 都能连）。
- [ ] **Zeabur 账号**：用 GitHub 登录 [zeabur.com](https://zeabur.com)。
- [ ] **自定义域名（可选）**：Zeabur 会免费给一个 `xxx.zeabur.app` 域名，够用；想要自己的域名就准备好 DNS 解析。

### 你替她生成的

```bash
openssl rand -hex 24   # 跑两次：一份给 PG 密码，一份给 POTHOS_TOKEN
```

---

## 2. 部署五步（Zeabur 控制台操作）

### 第 1 步：创建项目

登录 Zeabur → 新建项目 → 选择区域（当前可用：阿里云香港 `server-6a91ecacaf37eeef8fb27aa9`）。

### 第 2 步：部署引擎服务（从 GitHub 源码构建）

1. 项目里「添加服务」→ **Git / GitHub** → 授权并选择 `qimingjiu/pothos` 仓库。
2. Zeabur 会自动检测到 `package.json`，构建命令默认 `npm install`，启动命令需要手动设为：

   ```
   npx tsx src/server/main.ts
   ```

   > Zeabur 的 Node 运行时可能默认跑 `npm start`，但本仓库的 `start` 脚本就是 `tsx src/server/main.ts`，所以通常自动识别即可。若启动失败，检查是否缺 `tsx`——因为生产依赖里已含 `tsx`（非 devDependency），`npm ci` 会装上。

3. **暴露端口**：引擎监听 `7788`。在服务的「网络 / Networking」面板里：
   - 添加暴露端口 `7788`（HTTP 类型）。
   - Zeabur 会自动分配一个 `xxx.zeabur.app` 域名。
   - 想用自己的域名：在「域名 / Domains」里绑自定义域名，按提示去 DNS 加 CNAME 记录。

### 第 3 步：部署 PostgreSQL 服务

1. 同项目里「添加服务」→ **预构建 / Marketplace** → 搜索 **PostgreSQL**（选官方 `B20CX0` 模板，标准 PG 16）。
2. 部署后 Zeabur 会自动生成连接凭据。在 PG 服务的「变量 / Variables」面板找到：
   - `DATABASE_URL`（完整连接串，形如 `postgresql://user:pass@host:port/dbname`）

   > 波索斯的 `PostgresStore.fromEnv()` 同时认 `POTHOS_PG_URL` 和 `DATABASE_URL`，所以直接用 Zeabur 给的 `DATABASE_URL` 即可，无需额外拼。

3. **关键——把 PG 连接串传给引擎**：在**引擎服务**的「变量 / Variables」面板添加：

   | 变量名 | 值 |
   |---|---|
   | `DATABASE_URL` | （从 PG 服务的变量复制过来，或用 Zeabur 的 `${服务名.DATABASE_URL}` 引用语法） |
   | `POTHOS_TOKEN` | 你生成的随机串 |
   | `POTHOS_RECONCILE` | `1` |

   > Zeabur 支持服务间变量引用：填 `${PostgreSQL.DATABASE_URL}` 就能自动引用 PG 服务的连接串，不用手动复制。

4. 引擎服务重启后会自动：连 PG → 跑迁移（`migrations/001_init.sql` + `002_mail.sql`）→ 持有单写者锁 → `RECONCILE=1` 启动对账。

### 第 4 步：验收引擎跑起来了

```bash
curl https://她的域名.zeabur.app/healthz   # 应返回 ok
```

在 Zeabur 引擎服务的「日志 / Logs」面板看启动日志，应有：
- `[POTHOS] storage = postgres`
- `[POTHOS] 玻璃房已开：http://localhost:7788`
- 无 `reconcile mismatch` / `单写者锁被占` 报错

### 第 5 步：标定 B_daily / M_min（定名权纪律——必做）

```bash
curl -X POST https://她的域名.zeabur.app/admin/params \
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

对 `M_min` 同样发一次。**这步不做，部署不算完成。** 问她数值和理由怎么写——这是她的定名权。

---

## 3. 手机端使用

和总手册一致——手机不装 app，浏览器开玻璃房：

1. 手机浏览器打开 `https://她的域名.zeabur.app/?token=她的POTHOS_TOKEN`
2. cookie 接管后，以后直接开 `https://她的域名.zeabur.app`
3. 加到主屏（Safari：分享 → 添加到主屏幕；Chrome：菜单 → 添加到主屏幕）

Zeabur 默认给 HTTPS，手机访问没有证书问题——这是比自建 VPS 省心的地方。

---

## 4. 接 MCP——指向 Zeabur 上的引擎

引擎已经在 Zeabur 跑着了，她的 AI 客户端在任何机器上挂 MCP，一律用 **HTTP 模式**指向 Zeabur 域名。

### 4.1 observer 侧（她的 agent——含 send_user_msg 网关工具）

```json
{
  "mcpServers": {
    "pothos": {
      "command": "npx",
      "args": ["tsx", "src/mcp/main.ts"],
      "env": {
        "POTHOS_MCP_SIDE": "observer",
        "POTHOS_BASE_URL": "https://她的域名.zeabur.app",
        "POTHOS_TOKEN": "她的POTHOS_TOKEN"
      }
    }
  }
}
```

### 4.2 resident 侧（住户的 agent——无数值出镜）

```json
{
  "mcpServers": {
    "pothos": {
      "command": "npx",
      "args": ["tsx", "src/mcp/main.ts"],
      "env": {
        "POTHOS_MCP_SIDE": "resident",
        "POTHOS_BASE_URL": "https://她的域名.zeabur.app",
        "POTHOS_TOKEN": "住户侧token"
      }
    }
  }
}
```

### 4.3 前提与验证

- 挂 MCP 的机器上要有项目代码（`src/mcp/main.ts`）和 Node 20+。
- `POTHOS_BASE_URL` 填 Zeabur 给的域名（含 `https://`）。
- 挂载后在客户端应看到 pothos 工具列表。调一次 `interoception` 或 `state` 有返回即通；`send_user_msg` 发一条，玻璃房有响应即事件入流。

> **不要在 Zeabur 上再起一个内嵌模式 MCP 服务连同一个 PG**——单写者锁会拒绝。MCP 进程跑在她本地机器上，HTTP 指向 Zeabur 引擎即可。

---

## 5. 信件投递面（可选）

如果要启用信件通道，在 Zeabur 引擎服务的「变量」面板加齐八项凭据（缺任一项 = 诚实缺席）：

```
POTHOS_SMTP_HOST=smtp.gmail.com
POTHOS_SMTP_PORT=465
POTHOS_SMTP_USER=you@gmail.com
POTHOS_SMTP_PASS=<16位应用专用密码>
POTHOS_SMTP_FROM=you@gmail.com
POTHOS_IMAP_HOST=imap.gmail.com
POTHOS_IMAP_PORT=993
POTHOS_IMAP_USER=you@gmail.com
POTHOS_IMAP_PASS=<同一把应用专用密码>
POTHOS_MAIL_TO=<她的收件地址>
POTHOS_MAIL_PLUS_TAG=pothos
```

加齐后重启引擎服务。别填假值——凭据不全只会在日志里记「信件通道诚实缺席」，不会假装在投。

---

## 6. 备份

Zeabur 的 PG 服务自带数据持久化，但**没有自动备份**。两个选择：

1. **定期手动导出**：Zeabur PG 服务面板 → 连接信息里有外部连接串 → 本地跑 `pg_dump` 存到安全位置。
2. **挂一个 PGBackWeb 服务**（Zeabur 模板 `PISFJX`）：同项目里加这个服务，连到你的 PG，用 web UI 设定备份计划。

> 事件溯源库里什么都在。丢了 PG = 丢了整个住户的状态历史。务必备份。

---

## 7. 升级

Zeabur 连的是 GitHub 仓库——`git push` 到 main 分支后，Zeabur 默认会自动重新构建部署。事件溯源设计保证升级不动数据（状态 = fold(events)，可重放）。

如果她不想每次 push 都自动部署：在 Zeabur 服务设置里关掉自动部署，改成手动触发。

---

## 8. 故障排查（Zeabur 专属）

| 症状 | 原因 | 处理 |
|---|---|---|
| 引擎启动日志 `storage = memory` | `DATABASE_URL` 没传进引擎服务 | 在引擎服务变量面板加 `DATABASE_URL`（用 `${PostgreSQL.DATABASE_URL}` 引用） |
| 引擎日志 `单写者锁被占` | 同一 PG 已有引擎实例 | 别起第二个；确认只有一个引擎服务连这个 PG |
| 引擎日志 `对账不一致` | 数据库与事件流不一致 | fail-loud——别强启重启；查日志，必要时重建 PG 服务（数据会丢，有备份就恢复） |
| `curl /healthz` 不通 | 端口没暴露 / 域名没生成 | 引擎服务网络面板确认暴露了 7788 端口（HTTP 类型） |
| 自定义域名访问不了 | DNS CNAME 没加 / 没生效 | 按 Zeabur 域名面板提示加 CNAME，等 DNS 生效 |
| 构建失败 `tsx not found` | 依赖没装全 | 确认构建命令是 `npm ci`（非 `npm ci --omit=dev`），或改用 `npm install`；`tsx` 在生产依赖里 |
| 启动报 `POTHOS_TOKEN 未设` | 公网暴露没设鉴权 | 引擎服务变量面板加 `POTHOS_TOKEN`（随机串） |

---

## 9. Zeabur vs 自建 VPS——帮她选

| | Zeabur | 自建 VPS（deploy/ 套件） |
|---|---|---|
| 上手 | 连 GitHub 即部署，零运维 | 要买服务器、装 Docker、配 DNS |
| TLS/HTTPS | 自动 | Caddy 自动签 |
| 域名 | 免费送 `xxx.zeabur.app` | 自己买 |
| 费用 | 按套餐（两个服务常驻要留意额度） | VPS 月费（1C1G 很便宜） |
| 备份 | 要自己配（pg_dump 或 PGBackWeb） | `backup.sh` + crontab 一行搞定 |
| 数据控制权 | 数据在 Zeabur 托管的 PG 里 | 数据在自己服务器上 |
| 适合 | 不想折腾、快速上线 | 要完全自控、长期跑 |

---

## 10. 一页速查（给她看的）

```
Zeabur 部署五步：
  1. zeabur.com 新建项目（选香港区域）
  2. 添加服务 → GitHub → 选 pothos 仓库 → 启动命令 npx tsx src/server/main.ts
  3. 添加服务 → Marketplace → PostgreSQL（标准 PG 16）
  4. 引擎服务变量：DATABASE_URL=${PostgreSQL.DATABASE_URL} + POTHOS_TOKEN + POTHOS_RECONCILE=1
  5. 暴露 7788 端口 → 拿到 zeabur.app 域名 → curl /healthz 验证

标定（必做）：
  curl -X POST https://域名/admin/params ... 标定 B_daily 和 M_min

手机：
  浏览器开 https://域名.zeabur.app/?token=… → 加主屏

接 MCP：
  .mcp.json → npx tsx src/mcp/main.ts
  env: POTHOS_MCP_SIDE=observer, POTHOS_BASE_URL=https://域名.zeabur.app, POTHOS_TOKEN=…
```

---

*Zeabur 替你省了 Docker 和 TLS 的活，但定名权纪律和缺席边界一行都不能松。*
