#!/bin/bash
# Renova o token do Google que o manager do Wazuh troca, no STS da AWS de cada cliente, pela sessão do papel de leitura
# (fase 2, PR-V4'; docs/ARQUITETURA.md, "Por que papel sem chave"). Roda no host, como root: pelo
# verax-aws-token.timer (30 s depois do boot e a cada 10 min) e pelo `start.sh wazuh-up`, antes de o manager subir. Só
# no perfil standard. Sem a pasta /run/verax/wazuh-aws (o Wazuh ainda não subiu, ou o nó parou), não faz nada.
#
# O host pede o token ao servidor de metadados com a identidade da VM: a guarda do metadata só filtra o tráfego dos
# contêineres, e nenhum contêiner do Wazuh alcança o metadata. O token vale até 1 hora e vai para
# /run/verax/wazuh-aws/google-id-token (memória, 0600, root), a pasta que o manager monta só leitura em /root/.aws: o
# profile de cada conta (render-manager-config.py) aponta para ele, e o botocore relê o arquivo a cada troca no STS. A
# troca é atômica (rename na mesma pasta): o manager nunca lê um token pela metade. Renovar a cada 10 min deixa ao menos
# 50 min de folga (cinco falhas seguidas) antes de a coleta parar; uma falha mantém o token anterior até ele vencer.
# Nada é impresso além do erro, e nunca o token: ele não passa por argumento nem por arquivo fora da pasta.
#
# Depois, o sinal sem segredo para o worker: /run/verax/wazuh-signal/aws-token, só com a hora ({"tokenAt": ...}). Com o
# token parado há mais de 40 min, o worker marca as contas AWS conectadas com `aws_token_stale` (tarefa wazuh-config).
#
# Na VM própria do cliente (NODE_PLATFORM=vm), não há identidade do Google: no lugar do token, o job `aws-sessions`
# (imagem da API, ambiente do worker, o banco, o cofre de credenciais e o STS; compose.wazuh.yaml) troca a chave de
# leitura de cada conta AWS que o manager lê (a que o admin colou no painel) por uma sessão de 1 hora (GetSessionToken)
# e imprime o arquivo `credentials` dos profiles, com os mesmos nomes dos do `config`. A chave de longo prazo nunca sai
# do job: só a sessão chega à pasta do manager, conferida linha a linha e trocada de uma vez (0600). O mesmo timer, a
# mesma folga e o mesmo sinal para o worker.
set -euo pipefail
umask 077

# shellcheck source=/dev/null
source /etc/verax/node.conf
if [[ ${NODE_PROFILE:-lean} != standard ]]; then
  echo 'O Wazuh só existe no perfil standard (NODE_PROFILE em /etc/verax/node.conf).' >&2
  exit 2
fi

run=/run/verax
dir=$run/wazuh-aws
signal=$run/wazuh-signal
# O usuário do worker (o `node` da imagem da API), o mesmo WORKER_UID do start.sh: ele lê o sinal pelo grupo.
WORKER_UID=1000
# O padrão do parâmetro Audience da pilha (AWS_READER_AUDIENCE em packages/shared): sem a linha no node.conf, vale ele.
DEFAULT_AUDIENCE=https://control.veraxsistemas.com.br/aws-reader
IDENTITY_URL=http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity
# Um ID token do Google tem pouco mais de 1 KB; o teto só recusa uma resposta absurda.
MAX_TOKEN_BYTES=8192

if [[ ! -d $dir ]]; then
  echo "Sem $dir (o Wazuh não está no ar): nada a renovar."
  exit 0
fi

# O sinal para o worker, sem segredo. A pasta é root:<grupo do worker> 1770: o worker grava nela o dele (`generation`),
# e o bit t impede que ele troque ou apague os do host.
signal_renewed() {
  local file
  install -d -m 1770 -o 0 -g "$WORKER_UID" "$signal"
  file=$(mktemp "$signal/.aws-token.XXXXXX")
  printf '{"tokenAt":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$file"
  chmod 0440 "$file"
  chown "0:$WORKER_UID" "$file"
  mv -fT "$file" "$signal/aws-token"
}

if [[ ${NODE_PLATFORM:-gcp} == vm ]]; then
  # O mesmo projeto do Compose do start.sh e do wazuh-apply.sh (o cofre, quando ligado, só muda o worker).
  files=(-f /opt/verax/compose.yaml -f /opt/verax/compose.wazuh.yaml)
  if [[ ${CREDENTIALS_VAULT:-false} == true ]]; then files+=(-f /opt/verax/compose.vault.yaml); fi
  env_files=(--env-file /etc/verax/images.env)
  if [[ -f $run/memory.env ]]; then env_files+=(--env-file "$run/memory.env"); fi
  # Numa variável, antes de tocar no arquivo: um erro do job (o banco ou o STS fora) mantém as sessões anteriores.
  sessions=$(docker compose --project-directory /opt/verax "${files[@]}" "${env_files[@]}" \
    --profile setup run --rm -T aws-sessions </dev/null) || {
    echo 'As sessões da AWS não vieram do job aws-sessions: as anteriores ficam até vencer (1 hora).' >&2
    exit 1
  }
  # Cada linha no formato do arquivo credentials, e nada mais: o nome do profile (o do config), a chave temporária
  # (ASIA), o segredo e o token da sessão. Um teto para 100 contas.
  if ((${#sessions} > 1048576)); then
    echo 'O job aws-sessions devolveu um arquivo grande demais: as sessões anteriores ficam até vencer.' >&2
    exit 1
  fi
  while IFS= read -r line; do
    [[ -z $line || $line =~ ^\[verax-[0-9]{12}\]$ || $line =~ ^aws_access_key_id\ =\ ASIA[A-Z0-9]{16}$ ||
      $line =~ ^aws_secret_access_key\ =\ [A-Za-z0-9/+]{40}$ ||
      $line =~ ^aws_session_token\ =\ [A-Za-z0-9/+=]{16,4096}$ ]] || {
      echo 'O job aws-sessions devolveu uma linha fora do formato: as sessões anteriores ficam até vencer.' >&2
      exit 1
    }
  done <<<"$sessions"
  chmod 0700 "$dir"
  file=$(mktemp "$dir/.credentials.XXXXXX")
  if [[ -n $sessions ]]; then printf '%s\n' "$sessions" >"$file"; fi
  # 0600 pelo umask; o rename troca o arquivo de uma vez (o manager monta a pasta, e não o arquivo).
  mv -fT "$file" "$dir/credentials"
  signal_renewed
  exit 0
fi

audience=${AWS_WEB_IDENTITY_AUDIENCE:-$DEFAULT_AUDIENCE}
# O formato do install.sh, do start.sh, da API e do template (o AllowedPattern do Audience).
if ((${#audience} > 256)) || [[ ! $audience =~ ^https://[a-z0-9.-]+(/[A-Za-z0-9._-]+)*$ ]]; then
  echo 'AWS_WEB_IDENTITY_AUDIENCE inválido em /etc/verax/node.conf: use https://<host>[/<caminho>], sem curinga.' >&2
  exit 2
fi

# format=standard: o token não leva o projeto nem o nome da VM (a AWS não tem condição para esses campos).
token=$(curl -sS --fail --max-time 5 --retry 2 -H 'Metadata-Flavor: Google' -G \
  --data-urlencode "audience=$audience" --data-urlencode format=standard "$IDENTITY_URL") || {
  echo 'O servidor de metadados não entregou o token do Google: o anterior fica até vencer (1 hora).' >&2
  exit 1
}
if ((${#token} > MAX_TOKEN_BYTES)) || [[ ! $token =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]]; then
  echo 'O servidor de metadados devolveu um token fora do formato: o anterior fica até vencer.' >&2
  exit 1
fi

# A pasta pode ter sido criada pelo Docker (0755) ao restaurar o manager depois de um reboot: fechada de novo.
chmod 0700 "$dir"
file=$(mktemp "$dir/.google-id-token.XXXXXX")
printf '%s' "$token" >"$file"
# 0600 pelo umask; o rename troca o arquivo de uma vez (o manager monta a pasta, e não o arquivo).
mv -fT "$file" "$dir/google-id-token"

signal_renewed
