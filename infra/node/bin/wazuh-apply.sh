#!/bin/bash
# Gera a configuração do manager do Wazuh no nó de cliente (perfil standard): o ossec.conf do nó, as regras locais e os
# arquivos da AWS em /run/verax/wazuh-aws (memória, só root), pelo job `manager-config` do compose.wazuh.yaml, sem rede.
# Roda como root, chamado pelo `start.sh up` antes de subir o manager.
#
# No PR-W1 a lista de contas AWS é sempre vazia: o manager sobe sem o módulo aws-s3. A entrega das chaves pelo cofre
# (wazuh-sources), a recarga do manager quando o ossec.conf muda e o sinal para o worker entram no PR-V4.
set -euo pipefail
umask 077

# shellcheck source=/dev/null
source /etc/verax/node.conf
if [[ ${NODE_PROFILE:-lean} != standard ]]; then
  echo 'O Wazuh só existe no perfil standard (NODE_PROFILE em /etc/verax/node.conf).' >&2
  exit 2
fi

run=/run/verax
install -d -m 0700 "$run/wazuh-aws"
env_files=(--env-file /etc/verax/images.env)
if [[ -f $run/memory.env ]]; then env_files+=(--env-file "$run/memory.env"); fi
# Com os agentes (WAZUH_AGENTS=true), o compose.wazuh-agents.yaml dá ao gerador a pasta dos agentes e a senha de
# registro (só leitura): o ossec.conf sai com o registro ligado, mais o authd.pass e o agent.conf do grupo default.
files=(-f /opt/verax/compose.yaml -f /opt/verax/compose.wazuh.yaml)
if [[ ${WAZUH_AGENTS:-false} == true ]]; then files+=(-f /opt/verax/compose.wazuh-agents.yaml); fi
docker compose --project-directory /opt/verax "${files[@]}" \
  "${env_files[@]}" --profile setup run --rm -T manager-config </dev/null
