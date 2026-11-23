#!/bin/bash
# Exporta até onde o Wazuh do nó já leu cada fonte da AWS (onboarding self-service; perfil standard): o sinal `progress`
# para o worker, que com ele mostra no painel o estado de cada fonte autorizada (aguardando eventos, coletando, parada).
# Roda no host, como root, pelo verax-wazuh-progress.timer, a cada 5 min (o intervalo do próprio módulo do Wazuh).
#
# O exportador (/opt/verax/wazuh/scripts/export-aws-progress.py, cópia de infra/wazuh/scripts) roda dentro do contêiner
# do manager, com o Python do próprio Wazuh, e só lê: abre para leitura os bancos SQLite em que o módulo aws-s3 guarda os
# marcadores (/var/ossec/wodles/aws, o volume manager-wodles) e imprime um documento JSON de uma linha. O programa
# chega pela entrada padrão (`python3 -I -`): nada é copiado para o contêiner, e nada é escrito nele.
#
# Por que o host, e não a API ou o worker: nenhum dos dois alcança o manager (a API não divide rede com ele, e o worker
# só lê os contadores da API dele), e o volume dos marcadores só é montado no manager. O host já fala com o contêiner
# pelo Docker (o wazuh-agents-export.sh faz o mesmo). A saída é tratada como entrada não confiável: o host só limita o
# tamanho, confere o começo do documento e troca o arquivo de uma vez; o worker confere cada campo.
#
# Sem a pasta /run/verax/wazuh-aws (o Wazuh não subiu desde a partida do nó) ou com o manager fora do ar, não faz nada,
# e o sinal anterior fica: o worker vê a hora dele e, passados 20 min, deixa de usá-lo. Nenhum segredo passa por aqui:
# só nomes de bucket, de objeto e de grupo de logs, e horários.
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
script=/opt/verax/wazuh/scripts/export-aws-progress.py
# O usuário do worker (o `node` da imagem da API), o mesmo WORKER_UID do start.sh: ele lê o sinal pelo grupo.
WORKER_UID=1000
# Teto do documento (WAZUH_PROGRESS_MAX_BYTES no worker): 5 mil leituras de bucket e 5 mil grupos ficam abaixo disso.
MAX_BYTES=4194304
# O exportador espera no máximo 2 s por banco travado; o teto cobre o contêiner lento.
TIMEOUT_SECONDS=60
PYTHON=/var/ossec/framework/python/bin/python3
WODLES=/var/ossec/wodles/aws

if [[ ! -d $run/wazuh-aws ]]; then
  echo "Sem $run/wazuh-aws (o Wazuh não está no ar): nada a exportar."
  exit 0
fi

container=$(docker ps --quiet --filter label=com.docker.compose.project=verax \
  --filter label=com.docker.compose.service=wazuh.manager)
if [[ -z $container ]]; then
  echo 'O manager do Wazuh está fora do ar: os marcadores da AWS não foram exportados.' >&2
  exit 0
fi

# A pasta é root:<grupo do worker> 1770: o worker grava nela o dele (`generation`), e o bit t impede que ele troque ou
# apague os do host.
install -d -m 1770 -o 0 -g "$WORKER_UID" "$signal"
file=$(mktemp "$signal/.progress.XXXXXX")
trap 'rm -f "$file"' EXIT

# -I: o Python isolado (sem a pasta atual nem variáveis do ambiente no caminho dos módulos). Um byte além do teto basta
# para saber que passou (o `head` então fecha o cano, e o código de saída do exportador não diz mais nada: o tamanho é
# conferido antes dele). O que o exportador escreve na saída de erro vem do contêiner e fica de fora do journal.
status=0
timeout "$TIMEOUT_SECONDS" docker exec -i "$container" "$PYTHON" -I - "$WODLES" <"$script" 2>/dev/null |
  head -c "$((MAX_BYTES + 1))" >"$file" || status=$?
if (($(wc -c <"$file") > MAX_BYTES)); then
  echo "Os marcadores da AWS passaram de $MAX_BYTES bytes e foram descartados: o sinal anterior fica." >&2
  exit 1
fi
if ((status != 0)); then
  echo 'O exportador dos marcadores da AWS falhou no manager: o sinal anterior fica.' >&2
  exit 1
fi
# Um documento de uma linha, com a versão que o worker lê. O resto é com o schema dele.
if [[ $(head -c 13 "$file") != '{"version":1,' || $(wc -l <"$file") != 1 ]]; then
  echo 'O exportador devolveu algo fora do formato: o sinal anterior fica.' >&2
  exit 1
fi

# O worker lê pelo grupo; o arquivo entra no lugar de uma vez (rename), e o worker nunca lê um pela metade.
chmod 0440 "$file"
chown "0:$WORKER_UID" "$file"
mv -fT "$file" "$signal/progress"
trap - EXIT
