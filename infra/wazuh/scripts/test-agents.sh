#!/usr/bin/env bash
# Testa o manager com os agentes ligados (WAZUH_AGENTS=true no node.conf) num manager avulso da mesma imagem do nó, sem
# rede e sem porta publicada (tudo pelo loopback de dentro do contêiner, com `docker exec`). Usado no CI (iac.yml) e
# localmente; precisa só de Docker. Os arquivos entram e saem dos contêineres por `docker cp`, sem bind mount.
#
# 1. o certificado do registro (infra/node/bin/wazuh-agents-certs.sh): emitido para o IP dos agentes, com a CA
#    descartada, mantido quando roda de novo com o mesmo IP e refeito, com uma CA nova, quando o IP muda;
# 2. o gerador (render-manager-config.py) no modo dos agentes, com a senha de registro: ossec.conf com o registro só
#    por senha e com o certificado do nó, resposta ativa desligada, authd.pass e o agent.conf do grupo default;
# 3. o manager sobe com essa configuração (remoted e authd no ar, escutando 1514 e 1515), a configuração passa no teste
#    de cada daemon e o agent.conf no verify-agent-conf, sem comando remoto;
# 4. o registro pela porta 1515, como o agente faz: o certificado confere com a CA e o IP dos agentes (e não com outro
#    IP); sem senha, com a senha errada ou num grupo que não existe, recusado; com a senha certa, registrado;
# 5. a lista dos agentes pelo infra/node/bin/wazuh-agents-export.sh, com a API do manager e o usuário wazuh-wui (o TLS
#    conferido com a CA do nó e o nome wazuh.manager, como no Compose: o par do init-certs.sh em /etc/ssl/verax e o
#    manager-api-tls.sh em /entrypoint-scripts): só os campos que o painel mostra, sem o manager, sem a chave do agente,
#    legível pelo grupo do worker.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=$(grep -m1 -oE 'wazuh/wazuh-manager:[^[:space:]]+' docker-compose.yml)
# Endereços da documentação (RFC 5737): o IP fixo dos agentes e um que não é o dele.
ADDRESS=203.0.113.10
OTHER_ADDRESS=198.51.100.7
CERTS="verax-agents-certs-$$"
NODE_CERTS="verax-agents-node-certs-$$"
RENDER="verax-agents-render-$$"
MANAGER="verax-agents-manager-$$"

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
  docker rm -f "$CERTS" "$NODE_CERTS" "$RENDER" "$MANAGER" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# Senha de registro como o install.sh a gera (letras e dígitos, 32) e a do wazuh-wui no formato do lib-passwords.sh.
enrollment=''
until [[ ${#enrollment} -ge 32 ]]; do
  enrollment+=$(head -c 64 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9')
done
enrollment=${enrollment:0:32}
api_password=$(new_wazuh_password)

echo "== Certificado do registro ($IMAGE)"
mkdir -p "$work/certs-in/verax"
cp ../node/bin/wazuh-agents-certs.sh "$work/certs-in/verax/"
# O IP de cada rodada vai num arquivo do contêiner (o comando dele é fixo; o `$(...)` é do shell do contêiner). O
# script roda pelo bash: no repositório ele não tem o bit de execução (na VM, o install.sh o instala com 0750).
# shellcheck disable=SC2016
docker create --name "$CERTS" --network none --entrypoint /bin/bash "$IMAGE" \
  -c 'bash /verax/wazuh-agents-certs.sh /out "$(cat /verax/address)" && openssl x509 -in /out/ca.crt -noout -fingerprint' \
  >/dev/null
certs_for() { # <IP>: a saída do script e a impressão digital da CA
  printf '%s' "$1" >"$work/certs-in/verax/address"
  docker cp "$work/certs-in/verax/address" "$CERTS:/verax/address"
  docker start -a "$CERTS"
}
# Os arquivos entram com o modo do git (0644, sem execução), também no Windows, onde o `docker cp` de um arquivo .sh
# o marcaria como executável e esconderia a diferença (foi o que passou aqui e falhou no CI).
(cd "$work/certs-in" && tar --mode=u=rw,go=r -cf - verax) | docker cp - "$CERTS:/"
first=$(certs_for "$OTHER_ADDRESS")
expect "emitido na primeira vez" '.*emitido para 198\.51\.100\.7.*' "$first"
second=$(certs_for "$OTHER_ADDRESS")
expect "mantido na segunda, com o mesmo IP" '.*já emitido para 198\.51\.100\.7.*' "$second"
expect "a mesma CA" "$(tail -1 <<<"$first")" "$(tail -1 <<<"$second")"
third=$(certs_for "$ADDRESS")
expect "outro IP: emitido de novo" '.*emitido para 203\.0\.113\.10 \(CA nova.*' "$third"
[[ $(tail -1 <<<"$third") != "$(tail -1 <<<"$first")" ]] || expect "outro IP: CA nova" 'nova' 'a mesma'
docker cp "$CERTS:/out" "$work/certs"
expect "só a CA, o certificado e a chave do manager (a chave da CA não fica)" 'ca.crt manager.crt manager.key ' \
  "$(cd "$work/certs" && find . -type f | sed 's|^\./||' | LC_ALL=C sort | tr '\n' ' ')"

echo "== Gerador no modo dos agentes"
mkdir -p "$work/render-in/verax"
cp scripts/render-manager-config.py config/manager/ossec.conf "$work/render-in/verax/"
cp -R config/manager/rules config/manager/agents "$work/render-in/verax/"
printf '%s' "$enrollment" >"$work/render-in/verax/agents-enrollment"
docker create --name "$RENDER" -i --network none \
  -e VERAX_AGENTS_CONFIG=/verax/agents -e VERAX_AGENTS_ENROLLMENT=/verax/agents-enrollment \
  --entrypoint /var/ossec/framework/python/bin/python3 "$IMAGE" \
  /verax/render-manager-config.py /verax/ossec.conf /out/config /out/aws /verax/rules >/dev/null
docker cp "$work/render-in/verax" "$RENDER:/verax"
echo '[]' | docker start -ai "$RENDER" >/dev/null
docker cp "$RENDER:/out/config" "$work/config"
conf=$work/config/etc/ossec.conf
expect "registro só com senha e com o certificado do nó" 3 \
  "$(grep -cE '<use_password>yes</use_password>|<ssl_manager_cert>/etc/ssl/verax-agents/manager.crt</ssl_manager_cert>|<disabled>no</disabled>' <(sed -n '/<auth>/,/<\/auth>/p' "$conf"))"
expect "remoted fora do loopback (o Docker publica a porta)" 0 "$(grep -c '<local_ip>' "$conf" || true)"
expect "resposta ativa desligada" 1 "$(sed -n '/<active-response>/,/<\/active-response>/p' "$conf" | grep -c '<disabled>yes</disabled>')"
expect "nenhum <command> no manager" 0 "$(grep -c '<command>' "$conf" || true)"
expect "um bloco de cada" '1 1 1 1' "$(for tag in remote auth active-response vulnerability-detection; do
  grep -c "^  <$tag>" "$conf"
done | tr '\n' ' ' | sed 's/ $//')"
expect "authd.pass com a senha" "$enrollment" "$(cat "$work/config/etc/authd.pass")"
expect "agent.conf do grupo default" 1 "$(grep -c '<wodle name="syscollector">' "$work/config/etc/shared/default/agent.conf")"

echo "== Manager com os agentes (sem rede)"
# Os certificados do nó (init-certs.sh, como o job certs-init) e o script que põe o par do manager na API.
docker create --name "$NODE_CERTS" --network none --user root --entrypoint /bin/bash "$IMAGE" /verax/init-certs.sh \
  >/dev/null
mkdir -p "$work/node-certs-in/verax"
cp scripts/init-certs.sh "$work/node-certs-in/verax/"
(cd "$work/node-certs-in" && tar --mode=u=rw,go=r -cf - verax) | docker cp - "$NODE_CERTS:/"
docker start -a "$NODE_CERTS" >/dev/null
docker cp "$NODE_CERTS:/out/manager" "$work/node-certs"
mkdir -p "$work/manager-in/etc/ssl" "$work/manager-in/entrypoint-scripts"
cp -R "$work/node-certs" "$work/manager-in/etc/ssl/verax"
cp scripts/manager-api-tls.sh "$work/manager-in/entrypoint-scripts/verax-api-tls.sh"
docker create --name "$MANAGER" --network none --hostname wazuh.manager -e API_USERNAME=wazuh-wui \
  -e "API_PASSWORD=$api_password" "$IMAGE" >/dev/null
docker cp "$work/config" "$MANAGER:/wazuh-config-mount"
docker cp "$work/certs" "$MANAGER:/etc/ssl/verax-agents"
(cd "$work/manager-in" && tar --mode=u=rwX,go=rX -cf - etc entrypoint-scripts) | docker cp - "$MANAGER:/"
docker start "$MANAGER" >/dev/null
# O wazuh-control sai com erro enquanto algum daemon não roda (o clusterd e o maild nunca rodam aqui): a saída é lida
# inteira, e não pelo código. A API do manager é a última a subir (uns 2 a 3 min na primeira partida).
status=''
for _ in $(seq 1 150); do
  status=$(docker exec "$MANAGER" /var/ossec/bin/wazuh-control status 2>/dev/null || true)
  grep -q 'wazuh-apid is running' <<<"$status" && break
  sleep 2
done
expect "authd no ar" 1 "$(grep -c 'wazuh-authd is running' <<<"$status")"
expect "remoted no ar" 1 "$(grep -c 'wazuh-remoted is running' <<<"$status")"
expect "API do manager no ar" 1 "$(grep -c 'wazuh-apid is running' <<<"$status")"
# Portas em escuta, de /proc/net/tcp (a imagem não traz ss nem netstat): 05EA = 1514 e 05EB = 1515, em 0.0.0.0.
listening=$(docker exec "$MANAGER" awk '$4 == "0A" { print $2 }' /proc/net/tcp | LC_ALL=C sort -u | tr '\n' ' ')
expect "remoted (1514) e authd (1515) em todas as interfaces do contêiner" '.*00000000:05EA 00000000:05EB.*' "$listening"
expect "authd roda como root (lê a chave e o authd.pass, 0600 e 0640 de root)" root \
  "$(docker exec "$MANAGER" ps -o user= -C wazuh-authd | sort -u | tr -d ' ')"
for daemon in wazuh-analysisd wazuh-remoted wazuh-authd wazuh-modulesd; do
  code=0
  docker exec "$MANAGER" "/var/ossec/bin/$daemon" -t >/dev/null 2>&1 || code=$?
  expect "configuração aceita ($daemon -t)" 0 "$code"
done
verify=$(docker exec "$MANAGER" /var/ossec/bin/verify-agent-conf -f /var/ossec/etc/shared/default/agent.conf 2>&1 || true)
expect "agent.conf aceito (verify-agent-conf), sem aviso" 'verify-agent-conf: OK' \
  "$(grep -v '^$' <<<"$verify" | tr '\n' ' ' | sed 's/ *$//')"
expect "agent.conf sem comando remoto (command, full_command ou wodle command)" 0 \
  "$(docker exec "$MANAGER" grep -cE '<command>|<full_command>|wodle name="command"' /var/ossec/etc/shared/default/agent.conf || true)"

echo "== Registro pela porta 1515, como o agente faz"
tls() { # <IP conferido> <mensagem do agente>: a resposta do authd (ou o erro do TLS)
  printf '%s\n' "$2" | docker exec -i "$MANAGER" timeout 10 openssl s_client -quiet \
    -connect 127.0.0.1:1515 -CAfile /etc/ssl/verax-agents/ca.crt -verify_ip "$1" -verify_return_error 2>&1 || true
}
expect "certificado confere com a CA e o IP dos agentes" '.*verify return:1.*' \
  "$(tls "$ADDRESS" "OSSEC A:'sonda-tls'" | tr '\n' ' ')"
expect "outro IP: o agente recusa o manager" '.*(verify error|IP address mismatch).*' \
  "$(tls "$OTHER_ADDRESS" "OSSEC A:'sonda-ip'" | tr '\n' ' ')"
expect "sem senha: recusado" '.*ERROR: Invalid password.*' "$(tls "$ADDRESS" "OSSEC A:'sem-senha'" | tr '\n' ' ')"
expect "senha errada: recusado" '.*ERROR: Invalid password.*' \
  "$(tls "$ADDRESS" "OSSEC PASS: senha-errada-000000000000000000 OSSEC A:'senha-errada'" | tr '\n' ' ')"
expect "grupo que não existe: recusado" '.*ERROR: Invalid group.*' \
  "$(tls "$ADDRESS" "OSSEC PASS: $enrollment OSSEC A:'grupo-errado' G:'inexistente'" | tr '\n' ' ')"
expect "senha certa no grupo default: registrado" ".*OSSEC K:'001 instancia-teste any .*" \
  "$(tls "$ADDRESS" "OSSEC PASS: $enrollment OSSEC A:'instancia-teste' G:'default'" | tr '\n' ' ')"

echo "== Lista dos agentes (wazuh-agents-export.sh)"
# O script do nó como está, sem a chamada do fim, com as pastas do teste e o contêiner do teste no lugar do Compose.
mkdir -p "$work/secrets" "$work/export"
printf '%s' "$api_password" >"$work/secrets/wazuh-api"
# shellcheck source=SCRIPTDIR/../../node/bin/wazuh-agents-export.sh
source <(sed '$d' ../node/bin/wazuh-agents-export.sh)
secrets=$work/secrets
out=$work/export
WORKER_UID=$(id -u)
manager_container() { echo "$MANAGER"; }
# Sem root no teste: a pasta e o dono do arquivo ficam com quem roda.
install() { mkdir -p "${@: -1}"; }
chown() { :; }
export_agents
list=$(cat "$work/export/agents.json")
expect "resposta da API com um agente (sem o manager)" '.*"total_affected_items": ?1,.*' "$list"
expect "o agente registrado, nunca conectado" '.*"status": ?"never_connected".*' "$list"
expect "o nome do agente" '.*"name": ?"instancia-teste".*' "$list"
expect "sem a chave do agente nem outros campos" 0 "$(grep -cE '"key"|"configSum"|"mergedSum"|"manager"' <<<"$list" || true)"
expect "sem o manager (000)" 0 "$(grep -cE '"id": ?"000"' <<<"$list" || true)"
printf '%s\n' "$list" >"${AGENTS_SAMPLE:-/dev/null}"

if ((failures > 0)); then
  echo "$failures verificação(ões) falharam." >&2
  docker logs --tail 40 "$MANAGER" >&2 || true
  exit 1
fi
echo "Manager com os agentes: todas as verificações passaram."
