#!/usr/bin/env bash
# Confere a instalação do Wazuh (T4.2): TLS obrigatório, senhas novas aceitas, senhas padrão e usuários de
# demonstração recusados, e nenhuma porta publicada além do previsto. Roda no fim do deploy.sh e pode ser
# chamado sozinho, com as mesmas variáveis de senha.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${INDEXER_ADMIN_PASSWORD:?}" "${INDEXER_DASHBOARD_PASSWORD:?}" "${WAZUH_API_PASSWORD:?}"

failures=0
expect() { # <descrição> <esperado (regex)> <obtido>
  if [[ $3 =~ ^($2)$ ]]; then
    printf 'ok     %s\n' "$1"
  else
    printf 'FALHA  %s (esperado %s, obtido %s)\n' "$1" "$2" "$3"
    failures=$((failures + 1))
  fi
}

in_service() { docker compose exec -T "$@"; }

# Credenciais vão para o curl por stdin (-K -), nunca por argumento.
curl_as() { # <serviço> <usuário> <senha> <curl args...>
  local service=$1 user=$2 password=$3
  shift 3
  printf 'user = "%s:%s"\n' "$user" "$password" | in_service "$service" curl -s -K - "$@" || true
}

indexer_ca=/usr/share/wazuh-indexer/config/certs/root-ca.pem
indexer_url=https://wazuh.indexer:9200
indexer_code() { curl_as wazuh.indexer "$1" "$2" -o /dev/null -w '%{http_code}' --cacert "$indexer_ca" "$indexer_url$3"; }

echo "Indexer"
expect "admin com a senha nova" 200 "$(indexer_code admin "$INDEXER_ADMIN_PASSWORD" /)"
expect "kibanaserver com a senha nova" 200 "$(indexer_code kibanaserver "$INDEXER_DASHBOARD_PASSWORD" /)"
for default in admin:admin admin:SecretPassword kibanaserver:kibanaserver kibanaro:kibanaro logstash:logstash \
  readall:readall snapshotrestore:snapshotrestore; do
  expect "senha padrão recusada (${default%%:*})" 401 "$(indexer_code "${default%%:*}" "${default#*:}" /)"
done
# Chaves do primeiro nível do JSON: colapsa os objetos internos até sobrar {"usuário":X,...}.
top_level_keys() {
  local json
  json=$(cat)
  while [[ $json == *'{'*'{'* ]]; do json=$(sed -E 's/\{[^{}]*\}/X/g' <<<"$json"); done
  grep -oE '"[^"]+":X' <<<"$json" | cut -d'"' -f2 | sort | tr '\n' ' '
}
users=$(curl_as wazuh.indexer admin "$INDEXER_ADMIN_PASSWORD" --cacert "$indexer_ca" \
  "$indexer_url/_plugins/_security/api/internalusers" | top_level_keys)
expect "só admin e kibanaserver existem" 'admin kibanaserver ' "$users"
expect "HTTP sem TLS recusado" 000 "$(in_service wazuh.indexer curl -s -o /dev/null -w '%{http_code}' \
  http://wazuh.indexer:9200 || true)"
expect "TLS 1.1 recusado" 000 "$(in_service wazuh.indexer curl -s -o /dev/null -w '%{http_code}' --tls-max 1.1 \
  --cacert "$indexer_ca" "$indexer_url" || true)"

echo "API do manager"
api_code() {
  curl_as wazuh.manager "$1" "$2" -o /dev/null -w '%{http_code}' -X POST \
    --cacert /var/ossec/api/configuration/ssl/server.crt \
    "https://localhost:55000/security/user/authenticate"
}
expect "wazuh-wui com a senha nova" 200 "$(api_code wazuh-wui "$WAZUH_API_PASSWORD")"
expect "senha padrão recusada (wazuh-wui)" 401 "$(api_code wazuh-wui wazuh-wui)"
expect "senha padrão recusada (wazuh)" 401 "$(api_code wazuh wazuh)"

echo "Dashboard"
dashboard_ca=/usr/share/wazuh-dashboard/certs/root-ca.pem
expect "login do admin" 200 "$(curl_as wazuh.dashboard admin "$INDEXER_ADMIN_PASSWORD" -o /dev/null \
  -w '%{http_code}' --cacert "$dashboard_ca" https://wazuh.dashboard:5601/api/status)"
expect "HTTP sem TLS recusado" '000|400' "$(in_service wazuh.dashboard curl -s -o /dev/null -w '%{http_code}' \
  http://wazuh.dashboard:5601/api/status || true)"

echo "Portas publicadas no host"
published() { docker inspect --format '{{json .HostConfig.PortBindings}}' "$(docker compose ps -q "$1")"; }
expect "manager sem nenhuma porta" '\{\}' "$(published wazuh.manager)"
expect "dashboard só em 127.0.0.1" '.*"HostIp":"127\.0\.0\.1".*' "$(published wazuh.dashboard)"
expect "indexer só no endereço configurado" ".*\"HostIp\":\"${INDEXER_PUBLISH_ADDRESS:-127.0.0.1}\".*" \
  "$(published wazuh.indexer)"

if ((failures > 0)); then
  echo "$failures verificação(ões) falharam." >&2
  exit 1
fi
echo "Todas as verificações passaram."
