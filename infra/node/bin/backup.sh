#!/bin/bash
# Backup diário do banco do nó (verax-backup.timer): dump no formato do pg_dump, enviado ao bucket de backups com a
# identidade da VM (ela só cria e lê objetos; não apaga nada no bucket, onde a retenção é do próprio bucket). As
# cópias locais ficam 2 dias, para uma restauração rápida sem baixar.
# No modo vm (NODE_PLATFORM=vm, a VM própria do cliente) não há bucket: o dump fica só na VM, por BACKUP_RETENTION_DAYS
# dias (padrão 7; de 1 a 365).
set -euo pipefail
umask 077

# shellcheck source=/dev/null
source /etc/verax/node.conf

dir=/var/lib/verax/backups
mkdir -p "$dir"
file="$dir/verax-$(date -u +%Y%m%dT%H%M%SZ).dump"

docker compose --project-directory /opt/verax -f /opt/verax/compose.yaml --env-file /etc/verax/images.env \
  exec -T postgres pg_dump -U verax -d verax --format=custom >"$file"
if [[ ${NODE_PLATFORM:-gcp} == vm ]]; then
  retention=${BACKUP_RETENTION_DAYS:-7}
  if [[ ! $retention =~ ^[1-9][0-9]{0,2}$ ]] || ((retention > 365)); then
    echo 'AVISO: BACKUP_RETENTION_DAYS inválido em /etc/verax/node.conf (use de 1 a 365): valendo 7 dias.' >&2
    retention=7
  fi
  find "$dir" -name 'verax-*.dump' -mtime +"$retention" -delete
  echo "Backup local: $(basename "$file") (guardado por $retention dias em $dir)."
  exit 0
fi
gcloud storage cp --quiet "$file" "gs://$BACKUP_BUCKET/postgres/$(basename "$file")"
find "$dir" -name 'verax-*.dump' -mtime +2 -delete
echo "Backup enviado: $(basename "$file")"
