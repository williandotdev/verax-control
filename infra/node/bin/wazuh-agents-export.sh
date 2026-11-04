#!/bin/bash
# Lista dos agentes do Wazuh para o painel (WAZUH_AGENTS=true no node.conf). A cada minuto (verax-wazuh-agents.timer),
# pede à API do manager, de dentro do contêiner dele, os agentes registrados, só com os campos que o painel mostra, e
# grava a resposta em /run/verax/wazuh-agents/agents.json (memória do host). A pasta é montada só leitura no worker
# (compose.wazuh-agents.yaml), que confere o formato com o schema dele e guarda os agentes no banco, no cliente do nó.
#
# Por que o host, e não a API ou o worker: nenhum dos dois divide rede com o manager, que processa log de fora como
# root (e agora também o que chega das instâncias do cliente). O host já fala com o contêiner do manager pelo Docker
# (o start.sh e o smoke test fazem o mesmo); a resposta é tratada como entrada não confiável por quem a lê: o host só
# limita o tamanho e troca o arquivo de uma vez, o worker valida cada campo. A data da lista é a do arquivo, que só o
# host escreve.
#
# A senha do wazuh-wui (a API do manager) vai pela entrada padrão do curl (-K -), nunca por argumento; o token também.
# Nada é impresso além do erro, sem a resposta da API.
set -euo pipefail
umask 077

node_conf=/etc/verax/node.conf
secrets=/var/lib/verax/secrets
out=/run/verax/wazuh-agents
# O usuário do worker (o `node` da imagem da API), o mesmo WORKER_UID do start.sh.
WORKER_UID=1000
# Teto da resposta: 500 agentes com os campos abaixo ficam em torno de 250 KB.
MAX_BYTES=4194304
# Os campos que o painel mostra; o resto da resposta da API (chave do agente, caminhos, configuração) fica de fora.
FIELDS=id,name,ip,registerIP,os.name,os.version,os.platform,version,status,lastKeepAlive,dateAdd,group
# A lista sem o próprio manager (id 000), em ordem de id, no máximo 500 (o painel limita o nó a menos que isso).
QUERY="select=$FIELDS&limit=500&sort=%2Bid&q=id%21%3D000"
API=https://localhost:55000
API_CA=/var/ossec/api/configuration/ssl/server.crt

manager_container() {
  docker ps --quiet --filter label=com.docker.compose.project=verax \
    --filter label=com.docker.compose.service=wazuh.manager
}

manager_exec() { # <comando...>, no contêiner do manager, com a entrada padrão
  docker exec -i "$container" "$@"
}

export_agents() {
  local password token file
  container=$(manager_container)
  if [[ -z $container ]]; then
    echo 'O manager do Wazuh está fora do ar: a lista dos agentes não foi atualizada.' >&2
    return 1
  fi
  password=$(cat "$secrets/wazuh-api")
  token=$(printf 'user = "wazuh-wui:%s"\n' "$password" |
    manager_exec curl -sS -m 20 --fail -K - --cacert "$API_CA" -X POST "$API/security/user/authenticate?raw=true") || {
    echo 'A API do manager recusou o login do wazuh-wui ou não respondeu.' >&2
    return 1
  }
  # O token vem do manager: só entra na configuração do curl se for um JWT, sem aspas nem quebra de linha.
  if [[ ! $token =~ ^[A-Za-z0-9_.-]+$ ]]; then
    echo 'A API do manager devolveu um token fora do formato.' >&2
    return 1
  fi
  install -d -m 0750 -o 0 -g "$WORKER_UID" "$out"
  file=$(mktemp "$out/.agents.XXXXXX")
  if ! printf 'header = "Authorization: Bearer %s"\n' "$token" |
    manager_exec curl -sS -m 30 --fail -K - --cacert "$API_CA" --max-filesize "$MAX_BYTES" "$API/agents?$QUERY" |
    head -c "$((MAX_BYTES + 1))" >"$file"; then
    rm -f "$file"
    echo 'A API do manager não devolveu a lista dos agentes.' >&2
    return 1
  fi
  if (($(wc -c <"$file") > MAX_BYTES)); then
    rm -f "$file"
    echo "A lista dos agentes passou de $MAX_BYTES bytes e foi descartada." >&2
    return 1
  fi
  # O worker lê pelo grupo; o arquivo entra no lugar de uma vez (rename), e o worker nunca lê um pela metade.
  chmod 0440 "$file"
  chown "0:$WORKER_UID" "$file"
  mv -fT "$file" "$out/agents.json"
}

main() {
  # shellcheck source=/dev/null
  source "$node_conf"
  # Sem o interruptor (desligado depois de ligado), a lista sai da memória e nada é pedido ao manager.
  if [[ ${WAZUH_AGENTS:-false} != true ]]; then
    rm -rf "$out"
    return 0
  fi
  export_agents
}

main "$@"
