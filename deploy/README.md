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
