#!/usr/bin/env bash
# Prepara o EC2 do Wazuh e roda o deploy (T4.2). Amazon Linux 2023, como root, a partir do bundle em
# /opt/verax-wazuh. Chamado pelo user_data na primeira subida e pelo documento SSM `<nome>-wazuh-apply` nas
# seguintes (infra/terraform/modules/wazuh). Idempotente.
#
# Entradas (ambiente): WAZUH_SECRET_ARN, DATA_VOLUME_ID, AWS_REGION, CONTAINER_LOG_GROUP e INDEXER_HEAP.
# Nada aqui imprime senha; o log vai para /var/log/cloud-init-output.log ou para o histórico do SSM.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."

: "${WAZUH_SECRET_ARN:?}" "${DATA_VOLUME_ID:?}" "${AWS_REGION:?}" "${CONTAINER_LOG_GROUP:?}"

readonly compose_version=v5.6.1
readonly compose_sha256=47737f4236e6d3ccea7291995203f8f018058783b4c3a9469119811a0b5db8c0
readonly compose_plugin=/usr/local/lib/docker/cli-plugins/docker-compose
readonly data_dir=/data

log() { printf '[bootstrap] %s\n' "$*"; }

log "Pacotes"
dnf -y -q install docker jq xfsprogs
if [[ ! -x $compose_plugin ]] || ! sha256sum --check --strict --status <<<"$compose_sha256  $compose_plugin"; then
  download=$(mktemp)
  curl -fsSL --proto '=https' --tlsv1.2 -o "$download" \
    "https://github.com/docker/compose/releases/download/$compose_version/docker-compose-linux-x86_64"
  sha256sum --check --strict --quiet <<<"$compose_sha256  $download"
  install -D -m 0755 "$download" "$compose_plugin"
  rm -f "$download"
fi

log "Disco de dados ($DATA_VOLUME_ID)"
device=/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${DATA_VOLUME_ID//-/}
for _ in {1..60}; do
  [[ -e $device ]] && break
  sleep 5
done
if [[ ! -e $device ]]; then
  log "ERRO: o volume de dados não apareceu em 5 minutos"
  exit 1
fi
# Só formata disco vazio: numa reaplicação, ou depois de trocar a instância, os dados continuam.
if ! blkid "$device" >/dev/null; then mkfs.xfs -q -L wazuh-data "$device"; fi
grep -q '^LABEL=wazuh-data ' /etc/fstab ||
  echo "LABEL=wazuh-data $data_dir xfs defaults,noatime,nofail 0 2" >>/etc/fstab
install -d -m 0711 "$data_dir"
mountpoint -q "$data_dir" || mount "$data_dir"

log "Kernel e Docker"
echo 'vm.max_map_count = 262144' >/etc/sysctl.d/90-wazuh.conf
sysctl -q -p /etc/sysctl.d/90-wazuh.conf
install -d -m 0755 /etc/docker
# Dados do Docker (volumes do Wazuh inclusive) no disco de dados; logs dos contêineres no CloudWatch.
cat >/etc/docker/daemon.json.new <<EOF
{
  "data-root": "$data_dir/docker",
  "live-restore": true,
  "log-driver": "awslogs",
  "log-opts": {
    "awslogs-region": "$AWS_REGION",
    "awslogs-group": "$CONTAINER_LOG_GROUP",
    "tag": "{{.Name}}"
  }
}
EOF
if cmp -s /etc/docker/daemon.json.new /etc/docker/daemon.json; then
  rm -f /etc/docker/daemon.json.new
else
  mv /etc/docker/daemon.json.new /etc/docker/daemon.json
  if systemctl is-active -q docker; then systemctl restart docker; fi
fi
systemctl enable -q --now docker

log "Senhas (Secrets Manager)"
# Direto para o ambiente deste processo: nunca em arquivo nem em argumento de comando.
secret=$(aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$WAZUH_SECRET_ARN" \
  --query SecretString --output text)
INDEXER_ADMIN_PASSWORD=$(jq -er .indexer_admin <<<"$secret")
INDEXER_DASHBOARD_PASSWORD=$(jq -er .indexer_dashboard <<<"$secret")
WAZUH_API_PASSWORD=$(jq -er .wazuh_api <<<"$secret")
unset secret
export INDEXER_ADMIN_PASSWORD INDEXER_DASHBOARD_PASSWORD WAZUH_API_PASSWORD
export INDEXER_HEAP=${INDEXER_HEAP:-4g}

log "Deploy"
bash scripts/deploy.sh
log "Concluído"
