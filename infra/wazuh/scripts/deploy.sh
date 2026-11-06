#!/usr/bin/env bash
# Sobe ou reaplica o Wazuh do EC2 (T4.2; caminho legado: o nó de cliente da fase 2 usa infra/node/compose.wazuh.yaml e
# o start.sh). Idempotente: na primeira vez emite os certificados e inicializa a segurança do indexer; nas seguintes
# reaplica configuração e senhas (é assim que uma rotação chega aos contêineres).
#
# As senhas chegam por variável de ambiente, nunca por argumento (que aparece na lista de processos):
#   INDEXER_ADMIN_PASSWORD      usuário `admin` do indexer (só o smoke test a usa; os scripts usam o certificado)
#   INDEXER_FILEBEAT_PASSWORD   usuário `wazuh_filebeat` do indexer (o filebeat do manager grava os alertas com ele)
#   WAZUH_API_PASSWORD          usuário `wazuh-wui` da API do manager
#   INDEXER_API_READ_PASSWORD   usuário `verax_api_read` do indexer, que a API do Verax Control usa (T4.8)
# No EC2 quem as define é o bootstrap-host.sh, a partir do Secrets Manager.
# WAZUH_AWS_SOURCES_FILE: arquivo com a lista JSON das contas AWS conectadas (T4.4 a T4.6); sem ele, nenhuma.
# Opcionais: INDEXER_HEAP (padrão 1g), INDEXER_PUBLISH_ADDRESS (padrão 127.0.0.1), INDEXER_EXTRA_SANS e
# ALERT_RETENTION_DAYS (padrão 30).
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=SCRIPTDIR/lib-passwords.sh
source scripts/lib-passwords.sh
check_wazuh_passwords INDEXER_ADMIN_PASSWORD INDEXER_FILEBEAT_PASSWORD WAZUH_API_PASSWORD INDEXER_API_READ_PASSWORD

compose() { docker compose --progress quiet "$@"; }

sources_file=${WAZUH_AWS_SOURCES_FILE:-/dev/null}

echo "1/4 Certificados, segurança do indexer e configuração do manager"
# `run --rm`: os jobs de init não ficam parados guardando as senhas no ambiente do contêiner.
compose run --rm --no-deps certs-init
compose run --rm --no-deps security-init
# A lista de contas (com os ExternalIds) vai pela entrada padrão, nunca por variável ou argumento.
compose run --rm --no-deps -T manager-config <"$sources_file"
# Hash da configuração do manager como rótulo: se ela mudou, a compose recria o contêiner, que relê o ossec.conf
# e as regras locais.
WAZUH_MANAGER_CONFIG_HASH=$(cat config/manager/ossec.conf config/manager/rules/*.xml scripts/render-manager-config.py \
  "$sources_file" |
  sha256sum | cut -c1-16)
export WAZUH_MANAGER_CONFIG_HASH

echo "2/4 Indexer"
compose up -d --wait --wait-timeout 600 --no-deps wazuh.indexer

echo "3/4 Configuração de segurança aplicada no indexer"
bash scripts/security-admin.sh

echo "   Retenção e snapshots"
bash scripts/configure-indexer.sh

echo "4/4 Manager"
compose up -d --wait --wait-timeout 900 --no-deps --remove-orphans wazuh.manager

bash scripts/smoke-test.sh
