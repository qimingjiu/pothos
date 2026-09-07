# Pothos · 部署手册

> 部署前读一遍设计债务清单（设计文档未公开，本地维护）的 B1/B2——本套件就是那两笔债的还法。

## 零件

- `Dockerfile`：引擎镜像（Node 20 + tsx 直跑，非 root，healthcheck = `/healthz`）
- `docker-compose.yml`：PostgreSQL 16（数据卷）+ 引擎（单写者锁 + RECONCILE=1）+ Caddy（自动 TLS）
- `Caddyfile`：反代 + 安全头。token 只在首次 URL 出现，之后 HttpOnly cookie 接管
- `backup.sh`：每日 pg_dump → gzip，保留 30 天

## 公网部署（五步）

1. **服务器**：任意 VPS（1C1G 够），装 Docker；DNS 把域名 A 记录指到服务器 IP。
2. **配置**：`cp deploy/.env.example deploy/.env`，填 `POSTGRES_PASSWORD` / `POTHOS_TOKEN`（都换成 `openssl rand -hex 24`）、`DOMAIN` / `ACME_EMAIL`。
3. **起**：`docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build`
   - 迁移自动跑；`POTHOS_RECONCILE=1` 启动对账；单写者锁防止双跑。
   - B_daily / M_min 走纪律标定：`curl -X POST https://DOMAIN/admin/params -H "authorization: Bearer $POTHOS_TOKEN" -H "content-type: application/json" -d '{"key":"B_daily","newValue":2000,"reason":"…","expectedEffect":"…","evaluationWindowMs":604800000,"rollbackCondition":"…"}'`
4. **手机**：浏览器开 `https://DOMAIN/?token=你的POTHOS_TOKEN` 一次 → cookie 接管 → 加到主屏。
5. **备份**：crontab 挂 `deploy/backup.sh`（示例在脚本注释里）。

## 内网部署（手机同 WiFi 即用，不上公网）

注释掉 compose 里的 `caddy` 服务，把 engine 端口映射改成 `"7788:7788"`，`--env-file` 仍需 POSTGRES_PASSWORD / POTHOS_TOKEN（DOMAIN 可以填占位）。手机访问 `http://服务器内网IP:7788/?token=…`。不设 POTHOS_TOKEN = 无鉴权模式，仅限完全可信网络。

## 住户 agent（MCP）挂载

引擎跑在服务器后，住户侧 agent 在任何机器上挂：

```json
{ "mcpServers": { "pothos": {
  "command": "npx", "args": ["tsx", "src/mcp/main.ts"],
  "env": { "POTHOS_MCP_SIDE": "resident", "POTHOS_BASE_URL": "https://DOMAIN", "POTHOS_TOKEN": "…" } } } }
```

观测者侧（她的 agent 壳，含 `send_user_msg` 网关工具）把 `POTHOS_MCP_SIDE` 换成 `observer`。
内嵌模式（不设 POTHOS_BASE_URL，引擎进程内嵌）也可以，但注意单写者锁：同一 PG 库同时只能有一个持有者。

## 升级与恢复

- 升级：`git pull && docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build`（事件溯源：状态可重放，升级不动数据）
- 恢复：见 `backup.sh` 尾注（gunzip | psql）。
- 引擎崩了重启即对账；对账 mismatch 会拒绝启动（fail-loud），先看日志再动库。

## 信件投递面凭据（可选；她定案三把锁）

八项凭据齐备才启用（缺任一项 = 信件通道诚实缺席，worker 不启动、不假装在投）。全部进 `deploy/.env`（已 gitignore，**不入仓库**）：

```
POTHOS_SMTP_HOST=smtp.gmail.com
POTHOS_SMTP_PORT=465
POTHOS_SMTP_USER=you@gmail.com
POTHOS_SMTP_PASS=<Google 应用专用密码：账号 → 安全性 → 两步验证 → 应用专用密码>
POTHOS_SMTP_FROM=you@gmail.com
POTHOS_IMAP_HOST=imap.gmail.com
POTHOS_IMAP_PORT=993
POTHOS_IMAP_USER=you@gmail.com
POTHOS_IMAP_PASS=<同一把应用专用密码>
POTHOS_MAIL_TO=<她的收件地址>
POTHOS_MAIL_PLUS_TAG=pothos
```

三把锁（自动生效，不靠部署自觉）：

1. **MAIL_TO 管发**——SMTP `RCPT TO` 硬绑 `POTHOS_MAIL_TO`，组合层只生成这一个收件人；投递前 Final Policy Check 再断言（envelope 与 From 门牌），不等 → `held_manual` 诚实放弃。
2. **收信白名单字面化**——IMAP 只 `SEARCH FROM "她的地址" TO "you+pothos@gmail.com"`（双条件）；白名单外的信不 fetch、不解析、不进住户视野——「从来不拿」，不是「拿了再删」。
3. **Message-ID 管线**——她的回信 `In-Reply-To` 对上我们发出的 `Message-ID` 才成线；陌生 Message-ID 不冒认。

plus 门牌：`POTHOS_SMTP_FROM` 的 local 部分加 `+<POTHOS_MAIL_PLUS_TAG>`（默认 `pothos`）作为 `From:` 头——Gmail 加号别名零配置，她点「回复」即回门牌。信箱同址，但波索斯有自己的门牌号。

 quiet_hours 管寄不管写：`Date:` 记写信时刻，投递只在 `mailWindowStartHour–EndHour` 窗口（param_changes 纪律标定）。**真机验收已在案（2026-09-07）**：IMAP 只读冒烟（Gimap 握手 + 双条件 SEARCH）+ SMTP 真投递冒烟（标定信 `phase=sent` 无退信）；回信闭环等真实回信入箱即成线（pollReplies 每 5 分钟）。
