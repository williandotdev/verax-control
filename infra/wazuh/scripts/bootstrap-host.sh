#!/usr/bin/env bash
# Prepara o EC2 do Wazuh e roda o deploy (T4.2). Amazon Linux 2023, como root, a partir do bundle em
# /opt/verax-wazuh. Chamado pelo user_data na primeira subida e pelo documento SSM `<nome>-wazuh-apply` nas
# seguintes (infra/terraform/modules/wazuh). Idempotente.
#
# Entradas (ambiente): WAZUH_SECRET_ARN, WAZUH_API_READ_SECRET_ARN, WAZUH_AWS_SOURCES_SECRET_ARN,
# INDEXER_CA_PARAMETER, DATA_VOLUME_ID, AWS_REGION, CONTAINER_LOG_GROUP, INDEXER_HEAP, INDEXER_EXTRA_SANS e
# INDEXER_PUBLISH_ADDRESS.
# Nada aqui imprime senha nem ExternalId; o log vai para /var/log/cloud-init-output.log ou para o histórico do SSM.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."

: "${WAZUH_SECRET_ARN:?}" "${WAZUH_API_READ_SECRET_ARN:?}" "${WAZUH_AWS_SOURCES_SECRET_ARN:?}"
: "${INDEXER_CA_PARAMETER:?}" "${DATA_VOLUME_ID:?}" "${AWS_REGION:?}" "${CONTAINER_LOG_GROUP:?}"

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

log "Credencial da instância só para o manager"
# Com hop limit 2 (necessário para o manager assumir os papéis dos clientes), qualquer contêiner alcançaria o
# IMDS. Este filtro libera só o IP fixo do manager (docker-compose.yml) e é reaplicado a cada partida do Docker.
cat >/usr/local/sbin/verax-imds-guard <<'EOF'
#!/bin/bash
set -euo pipefail
imds=169.254.169.254/32
manager=172.30.250.10/32
iptables -C DOCKER-USER -d "$imds" -j DROP 2>/dev/null || iptables -I DOCKER-USER 1 -d "$imds" -j DROP
iptables -C DOCKER-USER -s "$manager" -d "$imds" -j RETURN 2>/dev/null ||
  iptables -I DOCKER-USER 1 -s "$manager" -d "$imds" -j RETURN
EOF
chmod 0755 /usr/local/sbin/verax-imds-guard
cat >/etc/systemd/system/verax-imds-guard.service <<'EOF'
[Unit]
Description=Verax Control: só o manager do Wazuh alcança o IMDS
After=docker.service
Requires=docker.service
PartOf=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/verax-imds-guard

[Install]
WantedBy=docker.service
EOF
chmod 0644 /etc/systemd/system/verax-imds-guard.service
systemctl daemon-reload
systemctl enable -q verax-imds-guard
systemctl restart verax-imds-guard

log "Contas AWS conectadas (Secrets Manager)"
# Em tmpfs, só para o root, e apagado ao sair: a lista tem os ExternalIds.
sources_dir=$(mktemp -d /run/verax-wazuh.XXXXXX)
trap 'rm -rf "$sources_dir"' EXIT
aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$WAZUH_AWS_SOURCES_SECRET_ARN" \
  --query SecretString --output text >"$sources_dir/aws-sources.json"
export WAZUH_AWS_SOURCES_FILE=$sources_dir/aws-sources.json

log "Senhas (Secrets Manager)"
# Direto para o ambiente deste processo: nunca em arquivo nem em argumento de comando.
secret=$(aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$WAZUH_SECRET_ARN" \
  --query SecretString --output text)
INDEXER_ADMIN_PASSWORD=$(jq -er .indexer_admin <<<"$secret")
INDEXER_DASHBOARD_PASSWORD=$(jq -er .indexer_dashboard <<<"$secret")
WAZUH_API_PASSWORD=$(jq -er .wazuh_api <<<"$secret")
# O usuário de leitura da API tem segredo próprio: a API lê só esse, nunca as senhas de administração.
secret=$(aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$WAZUH_API_READ_SECRET_ARN" \
  --query SecretString --output text)
INDEXER_API_READ_PASSWORD=$(jq -er .password <<<"$secret")
unset secret
export INDEXER_ADMIN_PASSWORD INDEXER_DASHBOARD_PASSWORD WAZUH_API_PASSWORD INDEXER_API_READ_PASSWORD
export INDEXER_HEAP=${INDEXER_HEAP:-4g}
# Nome DNS privado do indexer no certificado e publicação da porta 9200 (só no endereço liberado pelo Terraform:
# 127.0.0.1 enquanto nenhum security group da API estiver autorizado).
export INDEXER_EXTRA_SANS=${INDEXER_EXTRA_SANS:-} INDEXER_PUBLISH_ADDRESS=${INDEXER_PUBLISH_ADDRESS:-127.0.0.1}

log "Deploy"
bash scripts/deploy.sh

log "Conferindo o filtro do IMDS"
imds_status() {
  docker exec "$1" curl -s -m 3 -o /dev/null -w '%{http_code}' -X PUT \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token || true
}
if [[ $(imds_status verax-wazuh-wazuh.indexer-1) != 000 || $(imds_status verax-wazuh-wazuh.dashboard-1) != 000 ]]; then
  log "ERRO: indexer ou dashboard alcançam o IMDS"
  exit 1
fi
if [[ $(imds_status verax-wazuh-wazuh.manager-1) != 200 ]]; then
  log "ERRO: o manager não alcança o IMDS (sem ele, não lê as contas dos clientes)"
  exit 1
fi

log "Publicando o certificado da CA do Wazuh"
# Público (só o certificado, nunca a chave): a API valida o TLS do indexer contra ele.
ca=$(docker exec verax-wazuh-wazuh.indexer-1 cat /usr/share/wazuh-indexer/config/certs/root-ca.pem)
aws ssm put-parameter --region "$AWS_REGION" --name "$INDEXER_CA_PARAMETER" --type String --overwrite \
  --value "$ca" >/dev/null
log "Concluído"
