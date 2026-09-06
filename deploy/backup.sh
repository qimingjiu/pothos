#!/usr/bin/env bash
# Pothos 每日备份：事件流 + 快照 + 全部台账（事件溯源库里什么都在）。
# crontab 示例（服务器上）：30 3 * * * /srv/pothos/deploy/backup.sh >> /var/log/pothos-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p backups

docker compose -f docker-compose.yml --env-file .env exec -T db \
  pg_dump -U pothos --no-owner pothos | gzip > "backups/pothos-$(date +%F).sql.gz"

# 保留 30 天
find backups -name 'pothos-*.sql.gz' -mtime +30 -delete
echo "backup ok: backups/pothos-$(date +%F).sql.gz"

# 恢复（手动）：
#   gunzip -c backups/pothos-YYYY-MM-DD.sql.gz | \
#     docker compose -f docker-compose.yml --env-file .env exec -T db psql -U pothos -d pothos
