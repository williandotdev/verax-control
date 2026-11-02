#!/usr/bin/env bash
# Chamadas à API do indexer como administrador (T4.9), para os scripts de retenção, snapshot e restauração.
# Autenticação pelo certificado admin, que só o contêiner do indexer tem: nenhuma senha passa por aqui.

# indexer_admin <método> <caminho>: o corpo, se houver, vem da entrada padrão (use </dev/null sem corpo).
# Define response_code (HTTP) e response_body.
indexer_admin() {
  local certs=/usr/share/wazuh-indexer/config/certs output
  output=$(docker compose exec -T wazuh.indexer curl -s -X "$1" \
    --cacert "$certs/root-ca.pem" --cert "$certs/admin.pem" --key "$certs/admin-key.pem" \
    -H 'Content-Type: application/json' --data-binary @- -w '\n%{http_code}' "https://wazuh.indexer:9200$2")
  response_code=${output##*$'\n'}
  response_body=${output%$'\n'*}
}

# require_ok <descrição>: falha se a última resposta não for 200 ou 201.
require_ok() {
  if [[ ! ${response_code:-} =~ ^20[01]$ ]]; then
    echo "ERRO: $1 (HTTP ${response_code:-sem resposta})" >&2
    echo "${response_body:-}" >&2
    exit 1
  fi
}
