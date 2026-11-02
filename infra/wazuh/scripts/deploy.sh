#!/usr/bin/env bash
# Sobe ou reaplica o Wazuh (T4.2). Idempotente: na primeira vez emite os certificados e inicializa a segurança
# do indexer; nas seguintes reaplica configuração e senhas (é assim que uma rotação chega aos contêineres).
#
# As senhas chegam por variável de ambiente, nunca por argumento (que aparece na lista de processos):
#   INDEXER_ADMIN_PASSWORD      usuário `admin` do indexer (também o login do dashboard)
#   INDEXER_DASHBOARD_PASSWORD  usuário de serviço `kibanaserver`
#   WAZUH_API_PASSWORD          usuário `wazuh-wui` da API do manager
#   INDEXER_API_READ_PASSWORD   usuário `verax_api_read` do indexer, que a API do Verax Control usa (T4.8)
# No EC2 quem as define é o bootstrap-host.sh, a partir do Secrets Manager.
# WAZUH_AWS_SOURCES_FILE: arquivo com a lista JSON das contas AWS conectadas (T4.4 a T4.6); sem ele, nenhuma.
# Opcionais: INDEXER_HEAP (padrão 1g), INDEXER_PUBLISH_ADDRESS (padrão 127.0.0.1), INDEXER_EXTRA_SANS,
# DASHBOARD_PORT (padrão 8443) e ALERT_RETENTION_DAYS (padrão 90).
set -euo pipefail
cd "$(dirname "$0")/.."

# Formato aceito por todos os componentes sem escape: a API do Wazuh exige maiúscula, minúscula, dígito e
# símbolo, e os scripts de init das imagens gravam as senhas com sed, entre aspas simples, em YAML.
check_password() {
  local name=$1
  local value=${!name:-}
  if [[ ! $value =~ ^[A-Za-z][A-Za-z0-9.-]{31,63}$ || ! $value =~ [a-z] || ! $value =~ [A-Z] ||
    ! $value =~ [0-9] || ! $value =~ [.-] ]]; then
    echo "ERRO: $name deve ter de 32 a 64 caracteres, começar por letra, usar só letras, dígitos, '.' e '-'" \
      "e ter maiúscula, minúscula, dígito e símbolo." >&2
    exit 1
  fi
}
check_password INDEXER_ADMIN_PASSWORD
check_password INDEXER_DASHBOARD_PASSWORD
check_password WAZUH_API_PASSWORD
check_password INDEXER_API_READ_PASSWORD
distinct=$(printf '%s\n' "$INDEXER_ADMIN_PASSWORD" "$INDEXER_DASHBOARD_PASSWORD" "$WAZUH_API_PASSWORD" \
  "$INDEXER_API_READ_PASSWORD" | sort -u | wc -l)
if ((distinct != 4)); then
  echo "ERRO: as quatro senhas devem ser diferentes." >&2
  exit 1
fi

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
# Na primeira subida o índice de segurança já nasce dos arquivos; nas seguintes, é aqui que senhas, papéis e
# mapeamentos novos entram. A configuração inteira é reaplicada: os arquivos são a única fonte.
# shellcheck disable=SC2016 # expandido pelo bash do contêiner
if ! output=$(compose exec -T wazuh.indexer bash -c '
  export JAVA_HOME=/usr/share/wazuh-indexer/jdk
  certs=/usr/share/wazuh-indexer/config/certs
  bash /usr/share/wazuh-indexer/plugins/opensearch-security/tools/securityadmin.sh \
    -cd /usr/share/wazuh-indexer/config/opensearch-security/ \
    -icl -h wazuh.indexer -p 9200 \
    -cacert "$certs/root-ca.pem" -cert "$certs/admin.pem" -key "$certs/admin-key.pem"' 2>&1); then
  echo "$output" >&2
  exit 1
fi

echo "   Retenção e snapshots"
bash scripts/configure-indexer.sh

echo "4/4 Manager e dashboard"
compose up -d --wait --wait-timeout 900 --no-deps --remove-orphans wazuh.manager wazuh.dashboard

bash scripts/smoke-test.sh
