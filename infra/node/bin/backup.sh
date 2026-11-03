#!/bin/bash
# Backup diário do banco do nó (verax-backup.timer): dump no formato do pg_dump, enviado ao bucket de backups com a
# identidade da VM (ela só cria e lê objetos; não apaga nada no bucket, onde a retenção é do próprio bucket). As
# cópias locais ficam 2 dias, para uma restauração rápida sem baixar.
set -euo pipefail
umask 077

# shellcheck source=/dev/null
source /etc/verax/node.conf

dir=/var/lib/verax/backups
mkdir -p "$dir"
file="$dir/verax-$(date -u +%Y%m%dT%H%M%SZ).dump"

docker compose --project-directory /opt/verax -f /opt/verax/compose.yaml --env-file /etc/verax/images.env \
  exec -T postgres pg_dump -U verax -d verax --format=custom >"$file"
gcloud storage cp --quiet "$file" "gs://$BACKUP_BUCKET/postgres/$(basename "$file")"
find "$dir" -name 'verax-*.dump' -mtime +2 -delete
echo "Backup enviado: $(basename "$file")"
