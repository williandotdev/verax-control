#!/usr/bin/env bash
# Testa a API do manager do nó com o certificado da CA própria e o usuário verax_stats (fase 2, PR-V6), num manager
# avulso da mesma imagem do nó, sem rede e sem porta publicada (tudo pelo loopback de dentro do contêiner, com
# `docker exec`). Usado no CI (iac.yml) e localmente; precisa só de Docker. Os arquivos entram e saem dos contêineres por
# `docker cp`, sem bind mount.
#
# 1. os certificados pelo init-certs.sh (a mesma imagem, sem rede), como o job certs-init;
# 2. um manager de antes deste PR (sem o manager-api-tls.sh): a API sobe com o certificado autoassinado dela, que a CA
#    do nó não confere. Com o script em /entrypoint-scripts e o par do manager em /etc/ssl/verax (o que os dois Compose
#    montam), a partida seguinte troca o certificado: a API confere com a CA e o nome wazuh.manager, e outro nome ou
#    outra CA são recusados. Um par que não confere (a chave de outro certificado, outra CA, outro nome) não entra;
# 3. o init-api-users.sh: cria a política, o papel e o usuário; rodado de novo, nada muda (um de cada, os mesmos
#    vínculos); o verax_stats lê os contadores do analysisd e é recusado fora do manager:read (cluster, regras, reiniciar
#    o manager); outra senha é trocada (a antiga recusada); um papel e uma política a mais, a política alargada e o
#    run_as ligado são desfeitos; com a senha errada do wazuh-wui, nada muda; nenhuma senha na saída;
# 4. o contrato da tarefa wazuh-usage: a resposta dos contadores tem a partida do analysisd, os bytes recebidos e os
#    eventos do módulo da AWS, e um evento no formato do módulo (o cabeçalho 1:Wazuh-AWS: na fila do analysisd) conta
#    em modules_breakdown.aws e nos bytes. Com STATS_SAMPLE, a resposta é gravada nesse arquivo.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=$(grep -m1 -oE 'wazuh/wazuh-manager:[^[:space:]]+' docker-compose.yml)
CERTS="verax-api-certs-$$"
MANAGER="verax-api-manager-$$"
API=https://wazuh.manager:55000
CA=/etc/ssl/verax/root-ca.pem
PYTHON=/var/ossec/framework/python/bin/python3

# shellcheck source=SCRIPTDIR/lib-passwords.sh
source scripts/lib-passwords.sh

failures=0
expect() { # <descrição> <esperado (regex)> <obtido>
  if [[ $3 =~ ^($2)$ ]]; then
    printf 'ok     %s\n' "$1"
  else
    printf 'FALHA  %s (esperado %s, obtido %s)\n' "$1" "$2" "$3"
    failures=$((failures + 1))
  fi
}

work=$(mktemp -d)
cleanup() {
  docker rm -f "$CERTS" "$MANAGER" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

api_password=$(new_wazuh_password)
stats_password=$(new_wazuh_password)
stats_rotated=$(new_wazuh_password)

echo "== Certificados ($IMAGE)"
docker create --name "$CERTS" --network none --user root --entrypoint /bin/bash "$IMAGE" /verax/init-certs.sh >/dev/null
mkdir -p "$work/certs-in/verax"
cp scripts/init-certs.sh "$work/certs-in/verax/"
(cd "$work/certs-in" && tar --mode=u=rwX,go=rX -cf - verax) | docker cp - "$CERTS:/"
docker start -a "$CERTS" >/dev/null
docker cp "$CERTS:/out/manager" "$work/manager-certs"
expect "par do manager emitido" 'root-ca.pem wazuh.manager-key.pem wazuh.manager.pem ' \
  "$(cd "$work/manager-certs" && find . -type f | sed 's|^\./||' | LC_ALL=C sort | tr '\n' ' ')"

echo "== Manager de antes (sem o manager-api-tls.sh)"
docker create --name "$MANAGER" --network none --hostname wazuh.manager -e API_USERNAME=wazuh-wui \
  -e "API_PASSWORD=$api_password" "$IMAGE" >/dev/null
mkdir -p "$work/manager-in/etc/ssl"
cp -R "$work/manager-certs" "$work/manager-in/etc/ssl/verax"
(cd "$work/manager-in" && tar --mode=u=rwX,go=rX -cf - etc) | docker cp - "$MANAGER:/"

# O wazuh-control sai com erro enquanto algum daemon não roda (o clusterd e o maild nunca rodam aqui): a saída é lida
# inteira, e não pelo código. A API é a última a subir (uns 2 a 3 min na primeira partida), e o processo aparece antes
# de a porta abrir: a espera vai até a 55000 (D6D8) escutar, pelo /proc/net/tcp (a imagem não traz ss nem netstat).
wait_api() {
  local status='' listening=''
  for _ in $(seq 1 150); do
    status=$(docker exec "$MANAGER" /var/ossec/bin/wazuh-control status 2>/dev/null || true)
    # shellcheck disable=SC2016 # expandido pelo awk do contêiner
    listening=$(docker exec "$MANAGER" awk '$4 == "0A" && $2 ~ /:D6D8$/' /proc/net/tcp /proc/net/tcp6 2>/dev/null || true)
    grep -q 'wazuh-apid is running' <<<"$status" && [[ -n $listening ]] && return 0
    sleep 2
  done
  return 1
}
in_manager() { docker exec -i "$MANAGER" "$@"; }
on_manager() { docker exec "$MANAGER" "$@"; }
# tls_code [curl args...] [URL]: o código HTTP pelo loopback, com o nome resolvido para 127.0.0.1 (000: TLS recusado).
tls_code() {
  on_manager curl -s -m 10 -o /dev/null -w '%{http_code}' --resolve wazuh.manager:55000:127.0.0.1 \
    --resolve outro-nome.exemplo.internal:55000:127.0.0.1 "$@" || true
}
docker start "$MANAGER" >/dev/null
wait_api || expect "API do manager no ar" 'no ar' 'fora'
expect "API com o certificado autoassinado dela: a CA do nó não confere" 000 "$(tls_code --cacert "$CA" "$API/")"

echo "== Com o manager-api-tls.sh (a partida seguinte)"
mkdir -p "$work/script-in/entrypoint-scripts"
cp scripts/manager-api-tls.sh "$work/script-in/entrypoint-scripts/verax-api-tls.sh"
(cd "$work/script-in" && tar --mode=u=rw,go=r -cf - entrypoint-scripts) | docker cp - "$MANAGER:/"
docker restart "$MANAGER" >/dev/null
wait_api || expect "API do manager no ar depois da troca" 'no ar' 'fora'
expect "a API confere com a CA do nó e o nome wazuh.manager (401 sem login)" 401 "$(tls_code --cacert "$CA" "$API/")"
expect "outro nome: o TLS recusa" 000 "$(tls_code --cacert "$CA" https://outro-nome.exemplo.internal:55000/)"
expect "outra CA (a do authd): o TLS recusa" 000 "$(tls_code --cacert /var/ossec/etc/sslmanager.cert "$API/")"
expect "o certificado da API é o do manager, da CA do nó" "$(sha256sum <"$work/manager-certs/wazuh.manager.pem" | cut -c1-64)" \
  "$(on_manager sha256sum /var/ossec/api/configuration/ssl/server.crt | cut -c1-64)"
expect "certificado e chave da API do usuário wazuh, 0400" 'wazuh:400 wazuh:400' \
  "$(on_manager stat -c '%U:%a' /var/ossec/api/configuration/ssl/server.crt /var/ossec/api/configuration/ssl/server.key |
    tr '\n' ' ' | sed 's/ $//')"
expect "o init da imagem rodou o script na partida" 1 \
  "$(docker logs "$MANAGER" 2>&1 | grep -c 'verax-api-tls: a API do manager usa o certificado de wazuh.manager' || true)"

# Um par que não confere não entra: o script para, diz o motivo e deixa o certificado de antes. Cada caso troca um
# arquivo de /etc/ssl/verax por um gerado na hora e roda o script como o init roda (root, bash).
tamper() { # <descrição> <motivo esperado> <comandos no manager>
  local output code=0 before after
  before=$(on_manager sha256sum /var/ossec/api/configuration/ssl/server.crt /var/ossec/api/configuration/ssl/server.key)
  on_manager sh -c "set -e; cp -a /etc/ssl/verax /tmp/verax-ok; cd /tmp; $3"
  output=$(on_manager bash /entrypoint-scripts/verax-api-tls.sh 2>&1) || code=$?
  after=$(on_manager sha256sum /var/ossec/api/configuration/ssl/server.crt /var/ossec/api/configuration/ssl/server.key)
  on_manager sh -c 'rm -rf /etc/ssl/verax && mv /tmp/verax-ok /etc/ssl/verax'
  expect "$1: recusado sem tocar no certificado da API" "1 .*($2).* igual" \
    "$code $(tr '\n' ' ' <<<"$output") $([[ $before == "$after" ]] && echo igual || echo trocado)"
}
v=/etc/ssl/verax
tamper "chave de outro certificado" 'a chave não é a do certificado' \
  "openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out $v/wazuh.manager-key.pem 2>/dev/null"
tamper "certificado de outra CA" 'não confere com a CA' \
  "openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=wazuh.manager -addext subjectAltName=DNS:wazuh.manager \
    -keyout $v/wazuh.manager-key.pem -out $v/wazuh.manager.pem 2>/dev/null"
# Uma CA inteira trocada, com um par dela para outro nome: confere com a CA, mas não vale para wazuh.manager.
tamper "par de outro nome" 'não vale para o nome wazuh.manager' \
  "openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=ca-de-teste -keyout ca.key -out $v/root-ca.pem 2>/dev/null
    openssl req -newkey rsa:2048 -nodes -subj /CN=outro-nome -keyout $v/wazuh.manager-key.pem -out par.csr 2>/dev/null
    printf 'extendedKeyUsage=serverAuth\nsubjectAltName=DNS:outro-nome\n' >par.ext
    openssl x509 -req -in par.csr -CA $v/root-ca.pem -CAkey ca.key -CAcreateserial -days 1 -extfile par.ext \
      -out $v/wazuh.manager.pem 2>/dev/null"
tamper "par ausente" "falta $v/wazuh.manager.pem" "rm $v/wazuh.manager.pem"
expect "a API segue conferindo com a CA depois das recusas" 401 "$(tls_code --cacert "$CA" "$API/")"

echo "== init-api-users.sh"
# O script do nó como está, sem a chamada do fim, com o contêiner do teste no lugar do Compose.
# shellcheck source=SCRIPTDIR/init-api-users.sh
source <(sed '$d' scripts/init-api-users.sh)
manager_exec() { docker exec -i "$MANAGER" "$@"; }
init_users() { # <senha do wazuh-wui> <senha do verax_stats>: a saída (padrão e erro) e o código
  local output code=0
  output=$(WAZUH_API_PASSWORD=$1 WAZUH_STATS_PASSWORD=$2 main 2>&1) || code=$?
  printf '%s %s' "$code" "$(tr '\n' ' ' <<<"$output" | sed 's/ $//')"
}
# Token de um usuário (a senha e o token vão pela entrada padrão do curl, -K -); vazio quando recusado.
token_of() { # <usuário> <senha>
  printf 'user = "%s:%s"\n' "$1" "$2" | in_manager curl -s -m 10 -K - --fail --cacert "$CA" \
    --resolve wazuh.manager:55000:127.0.0.1 -X POST "$API/security/user/authenticate?raw=true" || true
}
as_token() { # <token> <método> <caminho> [-o arquivo]: o código HTTP; o corpo vai para a saída de erro, descartado
  printf 'header = "Authorization: Bearer %s"\n' "$1" | in_manager curl -s -m 10 -K - -o /dev/null \
    -w '%{http_code}' --cacert "$CA" --resolve wazuh.manager:55000:127.0.0.1 -X "$2" "$API$3" || true
}
body_as() { # <token> <caminho>: o corpo da resposta
  printf 'header = "Authorization: Bearer %s"\n' "$1" | in_manager curl -s -m 10 -K - --cacert "$CA" \
    --resolve wazuh.manager:55000:127.0.0.1 "$API$2" || true
}
send_as() { # <token> <método> <caminho> [corpo JSON]: o código HTTP
  local body=()
  if [[ -n ${4:-} ]]; then body=(-H 'Content-Type: application/json' --data-binary "$4"); fi
  printf 'header = "Authorization: Bearer %s"\n' "$1" | in_manager curl -s -m 10 -K - -o /dev/null -w '%{http_code}' \
    --cacert "$CA" --resolve wazuh.manager:55000:127.0.0.1 -X "$2" "${body[@]}" "$API$3" || true
}
# O estado do RBAC como o wazuh-wui vê: quantos de cada nome, os vínculos e a política.
# shellcheck disable=SC2016 # o programa é Python, lido pelo manager
rbac_state() {
  local admin
  admin=$(token_of wazuh-wui "$api_password")
  {
    body_as "$admin" '/security/policies?limit=500'
    echo
    body_as "$admin" '/security/roles?limit=500'
    echo
    body_as "$admin" '/security/users?limit=500'
    echo
  } | in_manager "$PYTHON" -c '
import json, sys
policies, roles, users = (json.loads(line)["data"]["affected_items"] for line in sys.stdin if line.strip())
policy = [p for p in policies if p["name"] == "verax_stats_manager_read"]
role = [r for r in roles if r["name"] == "verax_stats"]
user = [u for u in users if u["username"] == "verax_stats"]
print(len(policy), len(role), len(user), end=" ")
if policy and role and user:
    p, r, u = policy[0], role[0], user[0]
    print(r["policies"] == [p["id"]], u["roles"] == [r["id"]], u["allow_run_as"], not r["rules"],
          sorted(p["policy"]["actions"]), p["policy"]["resources"], p["policy"]["effect"], end="")
'
}
exact_state="1 1 1 True True False True \['manager:read'\] \['\*:\*:\*'\] allow"

expect "primeira vez: cria a política, o papel e o usuário, e liga os três" \
  '0 init-api-users: verax_stats só com manager:read \(política criada; papel criado; política ligada ao papel; usuário criado; papel ligado ao usuário\)\.' \
  "$(init_users "$api_password" "$stats_password")"
expect "um de cada, só manager:read, sem run_as" "$exact_state" "$(rbac_state)"
second=$(init_users "$api_password" "$stats_password")
expect "segunda vez: nada muda" '0 init-api-users: verax_stats só com manager:read \(nada mudou\)\.' "$second"
expect "segunda vez: ainda um de cada" "$exact_state" "$(rbac_state)"

stats=$(token_of verax_stats "$stats_password")
expect "verax_stats entra" 1 "$([[ -n $stats ]] && echo 1 || echo 0)"
expect "verax_stats lê os contadores do analysisd" 200 \
  "$(as_token "$stats" GET '/manager/daemons/stats?daemons_list=wazuh-analysisd')"
expect "verax_stats recusado no estado do cluster" 403 "$(as_token "$stats" GET /cluster/status)"
expect "verax_stats recusado nas regras" 403 "$(as_token "$stats" GET '/rules?limit=1')"
expect "verax_stats recusado ao reiniciar o manager" 403 "$(as_token "$stats" PUT /manager/restart)"
expect "verax_stats recusado ao criar usuário" 403 \
  "$(send_as "$stats" POST /security/users '{"username":"verax-intruso","password":"Intruso.Senha-0000000000000000AAaa"}')"

echo "== Senha nova do verax_stats"
expect "senha trocada" '0 init-api-users: verax_stats só com manager:read \(senha trocada\)\.' \
  "$(init_users "$api_password" "$stats_rotated")"
expect "senha antiga recusada" 0 "$(token_of verax_stats "$stats_password" | grep -c . || true)"
expect "senha nova aceita" 1 "$([[ -n $(token_of verax_stats "$stats_rotated") ]] && echo 1 || echo 0)"

echo "== Alterações por fora, desfeitas"
admin=$(token_of wazuh-wui "$api_password")
user_id=$(body_as "$admin" '/security/users?limit=500' | in_manager "$PYTHON" -c '
import json, sys
users = json.load(sys.stdin)["data"]["affected_items"]
print([u["id"] for u in users if u["username"] == "verax_stats"][0])')
role_id=$(body_as "$admin" '/security/roles?limit=500' | in_manager "$PYTHON" -c '
import json, sys
print([r["id"] for r in json.load(sys.stdin)["data"]["affected_items"] if r["name"] == "verax_stats"][0])')
policy_id=$(body_as "$admin" '/security/policies?limit=500' | in_manager "$PYTHON" -c '
import json, sys
print([p["id"] for p in json.load(sys.stdin)["data"]["affected_items"] if p["name"] == "verax_stats_manager_read"][0])')
send_as "$admin" POST /security/policies \
  '{"name":"verax-ci-a-mais","policy":{"actions":["agent:read"],"resources":["agent:id:*"],"effect":"allow"}}' >/dev/null
extra_policy=$(body_as "$admin" '/security/policies?limit=500' | in_manager "$PYTHON" -c '
import json, sys
print([p["id"] for p in json.load(sys.stdin)["data"]["affected_items"] if p["name"] == "verax-ci-a-mais"][0])')
expect "política a mais ligada ao papel" 200 \
  "$(send_as "$admin" POST "/security/roles/$role_id/policies?policy_ids=$extra_policy")"
expect "administrador ligado ao usuário" 200 "$(send_as "$admin" POST "/security/users/$user_id/roles?role_ids=1")"
expect "run_as ligado" 200 "$(send_as "$admin" PUT "/security/users/$user_id/run_as?allow_run_as=true")"
expect "política alargada" 200 "$(send_as "$admin" PUT "/security/policies/$policy_id" \
  '{"policy":{"actions":["manager:read","manager:restart"],"resources":["*:*:*"],"effect":"allow"}}')"
expect "desfeito pelo script" \
  '0 init-api-users: verax_stats só com manager:read \(política refeita; política a mais tirada do papel; run_as desligado; papel a mais tirado do usuário\)\.' \
  "$(init_users "$api_password" "$stats_rotated")"
expect "de volta a um de cada, só manager:read, sem run_as" "$exact_state" "$(rbac_state)"

echo "== Erros"
wrong=$(init_users "Errada.Senha-do-wazuh-wui-000000000AAaa" "$stats_password")
expect "wazuh-wui com a senha errada: para sem mudar nada" '1 init-api-users: a API do manager recusou o login do wazuh-wui' \
  "$wrong"
expect "a senha do verax_stats continua a de antes" 1 \
  "$([[ -n $(token_of verax_stats "$stats_rotated") ]] && echo 1 || echo 0)"
outputs="$second $wrong"
for secret in "$api_password" "$stats_password" "$stats_rotated"; do
  expect "nenhuma senha na saída" 0 "$(grep -cF "$secret" <<<"$outputs" || true)"
done

echo "== Contrato da tarefa wazuh-usage"
stats=$(token_of verax_stats "$stats_rotated")
counters() { # a partida do analysisd, os bytes recebidos e os eventos do módulo da AWS
  body_as "$stats" '/manager/daemons/stats?daemons_list=wazuh-analysisd' | tee "$work/stats.json" | in_manager "$PYTHON" -c '
import json, sys
item = json.load(sys.stdin)["data"]["affected_items"][0]
metrics = item["metrics"]
print(item["name"], item["uptime"], metrics["bytes"]["received"],
      metrics["events"]["received_breakdown"]["decoded_breakdown"]["modules_breakdown"]["aws"])'
}
read -r name started bytes events <<<"$(counters)"
expect "contadores do wazuh-analysisd, com a partida em ISO 8601" 'wazuh-analysisd [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}\+00:00' \
  "$name $started"
# Três eventos como o módulo da AWS os envia (wodles/aws/wazuh_integration.py: o cabeçalho na fila do analysisd).
on_manager "$PYTHON" -c '
import json, socket
event = {"integration": "aws", "aws": {"source": "cloudtrail", "eventName": "DescribeInstances", "awsRegion": "sa-east-1"}}
message = ("1:Wazuh-AWS:" + json.dumps(event)).encode()
sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
sock.connect("/var/ossec/queue/sockets/queue")
for _ in range(3):
    sock.send(message)
sock.close()'
sleep 3
read -r _ started_after bytes_after events_after <<<"$(counters)"
expect "três eventos do módulo da AWS contados" 3 "$((events_after - events))"
expect "os bytes deles contados (o analysisd soma tudo o que recebe)" 1 "$((bytes_after - bytes >= 3 * 100 ? 1 : 0))"
expect "a mesma partida do analysisd" igual "$([[ $started == "$started_after" ]] && echo igual || echo "$started_after")"
if [[ -n ${STATS_SAMPLE:-} ]]; then cp "$work/stats.json" "$STATS_SAMPLE"; fi

if ((failures > 0)); then
  echo "$failures verificação(ões) falharam." >&2
  docker logs --tail 40 "$MANAGER" >&2 || true
  exit 1
fi
echo "API do manager com a CA do nó e o verax_stats: todas as verificações passaram."
