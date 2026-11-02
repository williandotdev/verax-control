#!/usr/bin/env bash
# Teste de ponta a ponta do bundle do Wazuh (T4.2), usado no CI (iac.yml) e localmente. Precisa de Docker e
# de ~6 GB livres. Apaga a instalação local `verax-wazuh` (volumes inclusive) no começo e no fim.
#
# 1. instalação nova com senhas aleatórias e sem contas AWS → smoke test;
# 2. rotação das três senhas, agora com duas contas AWS de exemplo → smoke test, e as senhas antigas recusadas;
# 3. filebeat do manager gravando no indexer com TLS verificado; dashboard com a senha atual da API;
# 4. contas AWS: módulo aws-s3 aceito pelo manager, um bucket por fonte com o profile da conta, profiles só para
#    o root, ExternalId fora do ossec.conf e do ambiente do contêiner, manager no IP fixo;
# 5. cada volume de certificado só com as próprias chaves, e a chave da CA inexistente.
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

manager_file_count() { # <regex> <arquivo no manager>
  docker exec "$(container wazuh.manager)" grep -cE "$1" "$2" || true
}

echo "== Instalação nova"
bash scripts/deploy.sh
expect "sem contas, sem módulo aws-s3" 0 "$(manager_file_count '<wodle name="aws-s3">' /var/ossec/etc/ossec.conf)"

old_admin=$INDEXER_ADMIN_PASSWORD old_dashboard=$INDEXER_DASHBOARD_PASSWORD old_api=$WAZUH_API_PASSWORD
new_passwords
export WAZUH_AWS_SOURCES_FILE=tests/fixtures/aws-sources.example.json

echo "== Rotação das três senhas, com duas contas AWS"
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

echo "== Contas AWS"
manager=$(container wazuh.manager)
expect "manager no IP fixo (o único que alcança a credencial da instância)" 172.30.250.10 \
  "$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$manager")"
expect "um bucket por fonte" 4 "$(manager_file_count '<bucket type="(cloudtrail|guardduty|waf)">' /var/ossec/etc/ossec.conf)"
expect "ExternalId fora do ossec.conf" 0 "$(manager_file_count 'exemplo-external-id' /var/ossec/etc/ossec.conf)"
expect "ExternalId fora do ambiente do contêiner" 0 \
  "$(docker inspect --format '{{json .Config.Env}}' "$manager" | grep -c 'exemplo-external-id' || true)"
expect "profiles só para o root" 'root:700 root:600' \
  "$(docker exec "$manager" stat -c '%U:%a' /root/.aws /root/.aws/config | tr '\n' ' ' | sed 's/ $//')"
expect "wazuh-modulesd (que lê os profiles) roda como root" root \
  "$(docker exec "$manager" ps -o user= -C wazuh-modulesd | head -n 1 | tr -d ' ')"
# O módulo roda ao subir; sem AWS, cada bucket falha na credencial, mas a análise mostra o profile usado.
for _ in {1..36}; do
  [[ $(manager_file_count 'aws-s3: INFO: Fetching logs finished' /var/ossec/logs/ossec.log) -ge 1 ]] && break
  sleep 5
done
expect "módulo AWS iniciado" '[1-9][0-9]*' "$(manager_file_count 'aws-s3: INFO: Module AWS started' /var/ossec/logs/ossec.log)"
expect "conta A: 3 buckets com o profile dela" 3 \
  "$(manager_file_count 'Executing Bucket Analysis.*Profile: verax-111122223333\)' /var/ossec/logs/ossec.log)"
expect "conta B: 1 bucket com o profile dela" 1 \
  "$(manager_file_count 'Executing Bucket Analysis.*Profile: verax-444455556666\)' /var/ossec/logs/ossec.log)"

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
