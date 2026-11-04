#!/usr/bin/env bash
# Confere a instalação do Wazuh (T4.2, T4.8 e fase 2, PR-W1): TLS obrigatório, senhas novas aceitas, senhas padrão e
# usuários de demonstração recusados, usuário da API só com leitura dos alertas, usuário do filebeat só com escrita
# neles, e nenhuma porta publicada além do previsto. Roda no fim do `start.sh wazuh-up` do nó de cliente e do deploy.sh
# (EC2), e pode ser chamado sozinho, com as mesmas variáveis de senha. Fala com o projeto do Compose em vigor: o da
# pasta (EC2) ou o das variáveis COMPOSE_* (nó e CI).
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=SCRIPTDIR/lib-indexer.sh
source scripts/lib-indexer.sh

: "${INDEXER_ADMIN_PASSWORD:?}" "${INDEXER_FILEBEAT_PASSWORD:?}" "${WAZUH_API_PASSWORD:?}" "${INDEXER_API_READ_PASSWORD:?}"

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
# code_as <usuário> <senha> <método> <caminho> [corpo]: só o código HTTP.
code_as() {
  local body=()
  if [[ -n ${5:-} ]]; then body=(--data-binary "$5"); fi
  curl_as wazuh.indexer "$1" "$2" -o /dev/null -w '%{http_code}' --cacert "$indexer_ca" -X "$3" \
    -H 'Content-Type: application/json' "${body[@]}" "$indexer_url$4"
}

echo "Indexer"
expect "admin com a senha nova" 200 "$(indexer_code admin "$INDEXER_ADMIN_PASSWORD" /)"
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
expect "só admin, verax_api_read e wazuh_filebeat existem (sem dashboard, sem kibanaserver)" \
  'admin verax_api_read wazuh_filebeat ' "$users"
mappings=$(curl_as wazuh.indexer admin "$INDEXER_ADMIN_PASSWORD" --cacert "$indexer_ca" \
  "$indexer_url/_plugins/_security/api/rolesmapping" | top_level_keys)
expect "só os mapeamentos de papel necessários (sem own_index para todos, sem os do dashboard)" \
  'all_access verax_api_read wazuh_filebeat ' "$mappings"
expect "HTTP sem TLS recusado" 000 "$(in_service wazuh.indexer curl -s -o /dev/null -w '%{http_code}' \
  http://wazuh.indexer:9200 || true)"
expect "TLS 1.1 recusado" 000 "$(in_service wazuh.indexer curl -s -o /dev/null -w '%{http_code}' --tls-max 1.1 \
  --cacert "$indexer_ca" "$indexer_url" || true)"

echo "Usuário da API do Verax Control (verax_api_read)"
read_code() { code_as verax_api_read "$INDEXER_API_READ_PASSWORD" "$@"; }
expect "busca nos alertas" 200 "$(read_code GET '/wazuh-alerts-*/_search?size=0')"
expect "escrita nos alertas recusada" 403 "$(read_code POST /wazuh-alerts-4.x-verax-teste/_doc '{"teste":1}')"
expect "índice com o próprio nome recusado" 403 "$(read_code PUT /verax_api_read)"
# Nome concreto, e não padrão: um padrão sem nenhum índice casando devolve 200 vazio, e sem a conexão do manager com o
# indexer não existe índice wazuh-states-* (ela ficaria com o usuário do filebeat, que não cria esses índices).
expect "outros índices do Wazuh recusados" 403 "$(read_code GET '/wazuh-states-vulnerabilities-verax/_search?size=0')"
expect "índice de segurança recusado" 403 "$(read_code GET '/.opendistro_security/_search?size=0')"
expect "informações do cluster recusadas" 403 "$(read_code GET /_cat/indices)"
expect "configuração de segurança recusada" 403 "$(read_code GET /_plugins/_security/api/internalusers)"

echo "Usuário do filebeat do manager (wazuh_filebeat): só escrita nos alertas"
# O que o filebeat faz (config/indexer/roles-verax.yml) funciona; ler, apagar e tocar na segurança, não. Um manager
# comprometido não apaga nem lê o que já indexou. O índice de teste é apagado em seguida com o certificado admin.
filebeat_code() { code_as wazuh_filebeat "$INDEXER_FILEBEAT_PASSWORD" "$@"; }
smoke_index=wazuh-alerts-4.x-verax-smoke
expect "wazuh_filebeat com a senha nova" 200 "$(filebeat_code GET /)"
# O corpo vai por argumento (a entrada padrão já leva a credencial, -K -) e termina em quebra de linha, como o _bulk exige.
bulk=$(curl_as wazuh.indexer wazuh_filebeat "$INDEXER_FILEBEAT_PASSWORD" --cacert "$indexer_ca" -X POST \
  -H 'Content-Type: application/x-ndjson' --data-binary $'{"index":{}}\n{"verax":"smoke"}\n' \
  "$indexer_url/$smoke_index/_bulk")
expect "grava pelo _bulk num índice novo de alertas (criado na hora)" '.*"errors":false.*' "$bulk"
expect "template dos alertas (como o filebeat grava a cada partida)" 200 \
  "$(filebeat_code PUT /_template/verax-smoke '{"index_patterns":["verax-smoke-*"],"order":0}')"
indexer_admin DELETE /_template/verax-smoke </dev/null
expect "leitura dos alertas recusada" 403 "$(filebeat_code GET "/$smoke_index/_search?size=0")"
expect "apagar índice de alertas recusado" 403 "$(filebeat_code DELETE "/$smoke_index")"
expect "apagar documentos recusado" 403 \
  "$(filebeat_code POST "/$smoke_index/_delete_by_query" '{"query":{"match_all":{}}}')"
expect "apagar o template do Wazuh recusado" 403 "$(filebeat_code DELETE /_template/wazuh)"
expect "outros índices recusados" 403 "$(filebeat_code POST /wazuh-states-verax-smoke/_doc '{"teste":1}')"
expect "índice de segurança recusado" 403 "$(filebeat_code GET '/.opendistro_security/_search?size=0')"
expect "informações do cluster recusadas" 403 "$(filebeat_code GET /_cat/indices)"
expect "configuração de segurança recusada" 403 "$(filebeat_code GET /_plugins/_security/api/internalusers)"
expect "snapshots recusados" 403 "$(filebeat_code GET /_snapshot/verax-snapshots/_all)"
indexer_admin DELETE "/$smoke_index" </dev/null
expect "índice de teste apagado (certificado admin)" 200 "$response_code"

echo "API do manager"
api_code() {
  curl_as wazuh.manager "$1" "$2" -o /dev/null -w '%{http_code}' -X POST \
    --cacert /var/ossec/api/configuration/ssl/server.crt \
    "https://localhost:55000/security/user/authenticate"
}
expect "wazuh-wui com a senha nova" 200 "$(api_code wazuh-wui "$WAZUH_API_PASSWORD")"
expect "senha padrão recusada (wazuh-wui)" 401 "$(api_code wazuh-wui wazuh-wui)"
expect "senha padrão recusada (wazuh)" 401 "$(api_code wazuh wazuh)"

echo "Portas publicadas no host"
published() { docker inspect --format '{{json .HostConfig.PortBindings}}' "$(docker compose ps -q "$1")"; }
expect "manager sem nenhuma porta" '\{\}' "$(published wazuh.manager)"
# No nó de cliente o indexer não publica porta (a API e o worker o alcançam pela rede interna do Docker); no EC2 ele
# publica só no endereço liberado para a API (INDEXER_PUBLISH_ADDRESS, que o bootstrap-host.sh sempre define).
if [[ -n ${INDEXER_PUBLISH_ADDRESS:-} ]]; then
  expect "indexer só no endereço configurado" ".*\"HostIp\":\"${INDEXER_PUBLISH_ADDRESS}\".*" "$(published wazuh.indexer)"
else
  expect "indexer sem nenhuma porta" '\{\}' "$(published wazuh.indexer)"
fi

if ((failures > 0)); then
  echo "$failures verificação(ões) falharam." >&2
  exit 1
fi
echo "Todas as verificações passaram."
