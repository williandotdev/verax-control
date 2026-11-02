#!/usr/bin/env bash
# Teste de ponta a ponta do bundle do Wazuh (T4.2), usado no CI (iac.yml) e localmente. Precisa de Docker e
# de ~6 GB livres. Apaga a instalação local `verax-wazuh` (volumes inclusive) no começo e no fim.
#
# 1. instalação nova com senhas aleatórias → smoke test;
# 2. rotação das três senhas → smoke test, e as senhas antigas recusadas;
# 3. filebeat do manager gravando no indexer com TLS verificado; dashboard com a senha atual da API;
# 4. cada volume de certificado só com as próprias chaves, e a chave da CA inexistente.
set -euo pipefail
cd "$(dirname "$0")/.."

random_password() {
  local value
  while :; do
    value="Vc-$(head -c 96 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)"
    if [[ $value =~ [a-z] && $value =~ [A-Z] && $value =~ [0-9] ]]; then
      printf '%s' "$value"
      return
    fi
  done
}

new_passwords() {
  INDEXER_ADMIN_PASSWORD=$(random_password)
  INDEXER_DASHBOARD_PASSWORD=$(random_password)
  WAZUH_API_PASSWORD=$(random_password)
  export INDEXER_ADMIN_PASSWORD INDEXER_DASHBOARD_PASSWORD WAZUH_API_PASSWORD
}

cleanup() { docker compose down -v --remove-orphans >/dev/null 2>&1 || true; }

failures=0
expect() { # <descrição> <esperado (regex)> <obtido>
  if [[ $3 =~ ^($2)$ ]]; then
    printf 'ok     %s\n' "$1"
  else
    printf 'FALHA  %s (esperado %s, obtido %s)\n' "$1" "$2" "$3"
    failures=$((failures + 1))
  fi
}

container() { docker compose ps -q "$1"; }

code_as() { # <serviço> <usuário> <senha> <curl args...>
  local service=$1 user=$2 password=$3
  shift 3
  printf 'user = "%s:%s"\n' "$user" "$password" |
    docker exec -i "$(container "$service")" curl -s -K - -o /dev/null -w '%{http_code}' "$@" || true
}

new_passwords
cleanup
trap cleanup EXIT

echo "== Instalação nova"
bash scripts/deploy.sh

old_admin=$INDEXER_ADMIN_PASSWORD old_dashboard=$INDEXER_DASHBOARD_PASSWORD old_api=$WAZUH_API_PASSWORD
new_passwords

echo "== Rotação das três senhas"
bash scripts/deploy.sh

echo "== Depois da rotação"
indexer_ca=/usr/share/wazuh-indexer/config/certs/root-ca.pem
expect "admin antigo recusado" 401 \
  "$(code_as wazuh.indexer admin "$old_admin" --cacert "$indexer_ca" https://wazuh.indexer:9200/)"
expect "kibanaserver antigo recusado" 401 \
  "$(code_as wazuh.indexer kibanaserver "$old_dashboard" --cacert "$indexer_ca" https://wazuh.indexer:9200/)"
expect "wazuh-wui antigo recusado" 401 \
  "$(code_as wazuh.manager wazuh-wui "$old_api" -X POST --cacert /var/ossec/api/configuration/ssl/server.crt \
    https://localhost:55000/security/user/authenticate)"

filebeat=$(docker exec "$(container wazuh.manager)" filebeat test output 2>&1 || true)
expect "filebeat verifica o certificado do indexer" 1 \
  "$(grep -c "server's certificate chain verification is enabled" <<<"$filebeat")"
expect "filebeat autentica no indexer" 1 "$(grep -c 'talk to server... OK' <<<"$filebeat")"

# A comparação acontece dentro do contêiner, com a variável dele: a senha não sai no log.
# shellcheck disable=SC2016 # expandido pelo bash do contêiner
expect "dashboard com a senha atual da API" match "$(docker exec "$(container wazuh.dashboard)" bash -c '
  f=/usr/share/wazuh-dashboard/data/wazuh/config/wazuh.yml
  [[ $(grep -c "^ *password:" "$f") == 1 ]] && grep -qx "      password: $API_PASSWORD" "$f" && echo match')"

echo "== Certificados"
# Pelo serviço certs-init, que monta os quatro volumes em /out (mesma imagem da compose).
volume_files() {
  # shellcheck disable=SC2016 # expandido pelo sh do contêiner
  docker compose run --rm --no-deps -T --entrypoint sh certs-init \
    -c 'cd "/out/$1" && for f in *; do printf "%s:%s:%s " "$f" "$(stat -c %u "$f")" "$(stat -c %a "$f")"; done' \
    sh "$1"
}
expect "indexer: só as próprias chaves" \
  'admin-key.pem:1000:400 admin.pem:1000:400 root-ca.pem:1000:400 wazuh.indexer-key.pem:1000:400 wazuh.indexer.pem:1000:400 ' \
  "$(volume_files indexer)"
expect "manager: só as próprias chaves" \
  'root-ca.pem:999:400 wazuh.manager-key.pem:999:400 wazuh.manager.pem:999:400 ' "$(volume_files manager)"
expect "dashboard: só as próprias chaves" \
  'root-ca.pem:1000:400 wazuh.dashboard-key.pem:1000:400 wazuh.dashboard.pem:1000:400 ' "$(volume_files dashboard)"
expect "público: só o certificado da CA" 'root-ca.pem:0:444 ' "$(volume_files public)"

if ((failures > 0)); then
  echo "$failures verificação(ões) falharam." >&2
  exit 1
fi
echo "Teste de ponta a ponta do Wazuh passou."
