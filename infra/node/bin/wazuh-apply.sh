#!/bin/bash
# Aplica a configuração do manager do Wazuh no nó de cliente (perfil standard; fase 2, PR-V4'). A lista das contas AWS
# conectadas, lida do banco pelo CLI `wazuh-sources` (imagem da API, ambiente do worker, rede `verax`), vai para o
# gerador (job `manager-config`, imagem do manager, sem rede), que escreve o ossec.conf do nó, as regras locais e os
# profiles da AWS em /run/verax/wazuh-aws (memória, só root). Nenhum valor é segredo: não existe chave da AWS, e o token
# do Google (aws-token.sh) nunca passa por aqui.
#
# Roda como root, uma execução de cada vez (flock): pelo `start.sh wazuh-up`, antes de subir o manager; pelo
# verax-wazuh-apply.path, quando o worker grava uma `generation` nova (contas, buckets ou o início da coleta mudaram); e
# pelo verax-wazuh-apply.timer, a cada 15 min, que cobre um sinal perdido. Sem a pasta /run/verax/wazuh-aws (o Wazuh
# não subiu desde a partida do nó, ou o nó parou), não faz nada.
#
# Só reinicia o manager quando o hash da configuração que ele lê ao subir (o gerador o imprime) não é o da que ele roda,
# e só o manager: o banco, a API, o worker e o indexer seguem no ar. Espera o healthcheck por até 180 s; sem ele, a
# configuração anterior volta ao lugar (o gerador a guardou em .prev), o manager reinicia com ela, e a que falhou não é
# tentada de novo enquanto for a mesma. Um manager parado nunca é ligado aqui: ele lê a configuração ao subir.
#
# No fim, o sinal sem segredo para o worker: /run/verax/wazuh-signal/applied, com a geração (o SHA-256 da lista, o mesmo
# que o worker calcula; null se a lista nem chegou), ok ou error e a hora. Com error, o worker marca as contas AWS com
# `wazuh_apply_failed`.
set -euo pipefail
umask 077

# shellcheck source=/dev/null
source /etc/verax/node.conf
if [[ ${NODE_PROFILE:-lean} != standard ]]; then
  echo 'O Wazuh só existe no perfil standard (NODE_PROFILE em /etc/verax/node.conf).' >&2
  exit 2
fi

run=/run/verax
signal=$run/wazuh-signal
# Estado do host (só root): o hash da configuração que o manager roda, o da última que o derrubou e a trava.
state=$run/wazuh-apply
# O usuário do worker (o `node` da imagem da API), o mesmo WORKER_UID do start.sh: ele lê o sinal pelo grupo.
WORKER_UID=1000
HEALTH_TIMEOUT=180

if [[ ! -d $run/wazuh-aws ]]; then
  echo "Sem $run/wazuh-aws (o Wazuh não está no ar): nada a aplicar."
  exit 0
fi
install -d -m 0700 "$state"
install -d -m 1770 -o 0 -g "$WORKER_UID" "$signal"
exec 9>"$state/lock"
flock 9

env_files=(--env-file /etc/verax/images.env)
if [[ -f $run/memory.env ]]; then env_files+=(--env-file "$run/memory.env"); fi
# Com os agentes (WAZUH_AGENTS=true), o compose.wazuh-agents.yaml dá ao gerador a pasta dos agentes e a senha de
# registro (só leitura): o ossec.conf sai com o registro ligado, mais o authd.pass e o agent.conf do grupo default.
files=(-f /opt/verax/compose.yaml -f /opt/verax/compose.wazuh.yaml)
if [[ ${WAZUH_AGENTS:-false} == true ]]; then files+=(-f /opt/verax/compose.wazuh-agents.yaml); fi
# O projeto inteiro, como o do start.sh: com o cofre, o compose.vault.yaml também (só muda o worker).
if [[ ${CREDENTIALS_VAULT:-false} == true ]]; then files+=(-f /opt/verax/compose.vault.yaml); fi
compose() { docker compose --project-directory /opt/verax "${files[@]}" "${env_files[@]}" "$@"; }

# O IP de saída do nó vai para as regras do papel de leitura (o gerador confere de novo). Fora do formato do install.sh,
# fica de fora, com o aviso: as regras saem sem a parte por IP.
octet='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
egress_ip="$octet(\\.$octet){3}/32"
egress=''
if [[ -n ${NODE_EGRESS_IPS:-} ]]; then
  if [[ $NODE_EGRESS_IPS =~ ^$egress_ip(,$egress_ip){0,3}$ ]]; then
    egress=$NODE_EGRESS_IPS
  else
    echo 'AVISO: NODE_EGRESS_IPS fora do formato em /etc/verax/node.conf: as regras do papel de leitura saem sem o' \
      'IP do nó.' >&2
  fi
fi

# O sinal para o worker: troca atômica, legível pelo grupo dele, sem segredo.
signal_applied() { # <geração, ou vazio> <ok|error>
  local file generation=null
  if [[ -n $1 ]]; then generation="\"$1\""; fi
  file=$(mktemp "$signal/.applied.XXXXXX")
  printf '{"generation":%s,"status":"%s","at":"%s"}\n' "$generation" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$file"
  chmod 0440 "$file"
  chown "0:$WORKER_UID" "$file"
  mv -fT "$file" "$signal/applied"
}

manager_running() { [[ -n $(compose ps --status running --quiet wazuh.manager) ]]; }

# O healthcheck do compose (a API do manager no ar), até HEALTH_TIMEOUT segundos depois do reinício.
manager_healthy() {
  local container health deadline=$((SECONDS + HEALTH_TIMEOUT))
  while ((SECONDS < deadline)); do
    container=$(compose ps --quiet wazuh.manager)
    health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container" 2>/dev/null ||
      true)
    if [[ $health == healthy ]]; then return 0; fi
    sleep 5
  done
  return 1
}

rollback() { # imprime o hash da configuração que voltou (nada, se não havia anterior)
  compose --profile setup run --rm -T -e VERAX_MANAGER_CONFIG_ROLLBACK=1 manager-config </dev/null || true
}

# A lista numa variável, antes do gerador: um erro do CLI (o banco fora do ar) para aqui. Num cano direto, o gerador
# leria a entrada vazia como "nenhuma conta" e tiraria todas do manager.
status=0
sources=$(compose --profile setup run --rm -T wazuh-sources </dev/null) || status=$?
if ((status != 0)); then
  echo 'ERRO: a lista das contas AWS não veio do banco (wazuh-sources): a configuração do manager fica como está.' >&2
  signal_applied '' error
  exit 1
fi
# A geração é o SHA-256 da lista como o CLI a imprime (sem a quebra de linha do fim): o worker calcula a mesma.
generation=$(printf '%s' "$sources" | sha256sum | cut -c1-64)

hash=$(printf '%s\n' "$sources" |
  compose --profile setup run --rm -T -e "VERAX_NODE_EGRESS_IPS=$egress" manager-config) || status=$?
if ((status != 0)) || [[ ! $hash =~ ^[0-9a-f]{64}$ ]]; then
  echo 'ERRO: o gerador recusou a lista das contas AWS: a configuração do manager fica como está.' >&2
  signal_applied "$generation" error
  exit 1
fi

running=$(cat "$state/running" 2>/dev/null || true)
failed=$(cat "$state/failed" 2>/dev/null || true)
if [[ $hash == "$failed" ]]; then
  # A mesma configuração que já derrubou o manager: a anterior volta ao lugar, sem reiniciar (é a que ele roda).
  rollback >/dev/null
  echo 'ERRO: a configuração nova é a mesma que já derrubou o manager: ele segue com a anterior.' >&2
  signal_applied "$generation" error
  exit 1
fi
if ! manager_running; then
  # Parado (o wazuh-up o sobe em seguida, ou alguém o parou): ele lê esta configuração quando subir.
  printf '%s\n' "$hash" >"$state/running"
  signal_applied "$generation" ok
  echo 'Configuração do manager pronta para a próxima partida dele.'
  exit 0
fi
if [[ $hash == "$running" ]]; then
  signal_applied "$generation" ok
  exit 0
fi

echo 'Configuração do manager nova: reiniciando só o manager.'
compose restart wazuh.manager
if manager_healthy; then
  printf '%s\n' "$hash" >"$state/running"
  rm -f "$state/failed"
  signal_applied "$generation" ok
  echo 'Manager saudável com a configuração nova.'
  exit 0
fi

echo "ERRO: o manager não ficou saudável em $HEALTH_TIMEOUT s com a configuração nova: voltando a anterior." >&2
printf '%s\n' "$hash" >"$state/failed"
previous=$(rollback)
compose restart wazuh.manager
if [[ $previous =~ ^[0-9a-f]{64}$ ]] && manager_healthy; then
  printf '%s\n' "$previous" >"$state/running"
  echo 'Manager saudável de novo, com a configuração anterior.' >&2
else
  rm -f "$state/running"
  echo 'ERRO: o manager também não ficou saudável com a configuração anterior: veja o journal do verax-wazuh.' >&2
fi
signal_applied "$generation" error
exit 1
