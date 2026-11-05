#!/bin/bash
# Partida e parada do nó (verax-node.service e, no standard, verax-wazuh.service) e a primeira configuração. Uso
# (root, na VM):
#   start.sh up          monta os arquivos de ambiente e sobe banco, papéis, migrations, API, worker e túnel
#   start.sh down        para tudo (os dados ficam em /var/lib/verax e nos volumes do Docker)
#   start.sh wazuh-up    perfil standard, depois do `up` (verax-wazuh.service): sobe o Wazuh (indexer e manager)
#   start.sh wazuh-down  para o indexer e o manager
#   start.sh bootstrap   primeiro admin, cliente e contas (variáveis BOOTSTRAP_*; ver docs/runbooks/no-verax.md)
#   start.sh customer-bootstrap
#                        modo cliente (CUSTOMER_MODE=true; verax-customer-bootstrap.service): o primeiro acesso do nó
#                        de cliente, com as entradas dos metadados da VM e as senhas gravadas no Secret Manager
#   start.sh render      só monta os arquivos de ambiente (o que o up faz antes de subir; usado pelo teste do pacote)
#
# Os arquivos de ambiente ficam em /run/verax (memória, só root): somem ao desligar e são montados de novo a cada
# partida. Segredos de fora (senha do e-mail, token do túnel e chave secreta do Turnstile) vêm do Secret Manager com
# a identidade da própria VM; os de dentro (senhas do banco, chaves da sessão e do CSRF e, no standard, as do Wazuh)
# foram gerados pelo install.sh e ficam em /var/lib/verax/secrets (0600, só root). A chave do cofre de credenciais (nó
# de cliente) foi gerada pelo install.sh direto no Secret Manager; as versões ativas dela passam pela memória (um
# arquivo numa pasta de /run/verax montada só leitura no worker), nunca por variável de ambiente. Nenhum valor é
# impresso.
set -euo pipefail
umask 077

# shellcheck source=/dev/null
source /etc/verax/node.conf

secrets=/var/lib/verax/secrets
run=/run/verax
# Memória dos contêineres por perfil do nó (NODE_PROFILE no node.conf; sem a linha, lean). O lean repete os valores de
# antes do perfil, que também são o padrão do compose.yaml (o CI confere); o standard é o nó de cliente, com 8 GB.
MEMORY_LEAN=(POSTGRES_MEM_LIMIT=256m POSTGRES_SHARED_BUFFERS=32MB API_MEM_LIMIT=320m API_HEAP_MB=192 WORKER_MEM_LIMIT=256m WORKER_HEAP_MB=160)
MEMORY_STANDARD=(POSTGRES_MEM_LIMIT=512m POSTGRES_SHARED_BUFFERS=128MB API_MEM_LIMIT=384m API_HEAP_MB=256 WORKER_MEM_LIMIT=512m WORKER_HEAP_MB=384)
# Wazuh só no perfil standard (PR-W1): o segundo arquivo do Compose e a cópia de infra/wazuh que o install.sh instala.
wazuh=/opt/verax/wazuh
standard() { [[ ${NODE_PROFILE:-lean} == standard ]]; }
# Agentes do Wazuh nas instâncias do cliente (WAZUH_AGENTS=true no node.conf; só no standard): o terceiro arquivo do
# Compose (as portas 1514 e 1515 do manager, a senha de registro para o gerador e a lista dos agentes para o worker) e o
# certificado do registro, emitido pelo install.sh. Sem a linha, nada muda: os arquivos de ambiente e o projeto do
# Compose são os de sempre.
agents() { [[ ${WAZUH_AGENTS:-false} == true ]]; }
agents_certs=/var/lib/verax/wazuh-agents
# Pasta das chaves privadas do cofre de credenciais, em /run/verax (memória): o compose.vault.yaml a monta só leitura
# no worker, em WORKER_VAULT_MOUNT, e o arquivo das chaves (WORKER_KEYS) fica dentro dela, no caminho WORKER_KEYS_MOUNT
# que o worker.env aponta (o CI confere que tudo bate). O volume é a pasta, e não o arquivo, porque a origem de um bind
# mount que não existe vira uma pasta criada pelo Docker ao subir o contêiner (um worker que o Docker reinicia depois
# de um reboot inesperado, antes desta partida, criaria uma pasta no lugar do arquivo e nunca mais leria chave), e
# porque um arquivo dentro de uma pasta montada pode ser trocado de uma vez (rename). Só o usuário do worker lê o
# arquivo (uid 1000, o `node` da imagem da API; scripts/test-api-image.sh confere na imagem).
WORKER_VAULT=$run/vault
WORKER_KEYS=$WORKER_VAULT/worker-keys
WORKER_VAULT_MOUNT=/run/vault
WORKER_KEYS_MOUNT=$WORKER_VAULT_MOUNT/worker-keys
WORKER_UID=1000
# Modo cliente (fase 3, CP-10; CUSTOMER_MODE=true no node.conf; sem a linha, false): o nó de cliente que o plano de
# controle cria, sem SSH. O `customer-bootstrap` lê dos metadados da VM as entradas do primeiro acesso, roda o
# node-bootstrap no modo customer e grava cada senha nova como versão de um segredo do Secret Manager; o worker publica o
# estado do nó nos guest attributes (NODE_STATUS e NODE_VERSION no worker.env). O nó da Verax não liga: nada disso roda,
# e os arquivos de ambiente saem como antes.
customer() { [[ ${CUSTOMER_MODE:-false} == true ]]; }
# Entradas do primeiro acesso: a chave nos metadados da instância (gravada pelo Terraform do tenant) e a variável do
# node-bootstrap que ela vira. É o único lugar do host com esses nomes; as três são obrigatórias. Nenhuma é segredo.
CUSTOMER_BOOTSTRAP_INPUTS=(
  verax-tenant-name=BOOTSTRAP_TENANT_NAME
  verax-admin-email=BOOTSTRAP_ADMIN_EMAIL
  verax-support-email=BOOTSTRAP_SUPPORT_EMAIL
)
# As senhas novas: cada uma é um arquivo `<nome>.json` (o JSON do contrato com o plano de controle) que o node-bootstrap
# deixa na pasta do tmpfs montada no contêiner dele, e o nome é o sufixo do segredo `<prefixo>-<nome>`: `admin-bootstrap`
# (o plano de controle revela uma vez ao cliente) e `support-bootstrap` (a conta de suporte da Verax, que só o
# responsável lê). A pasta é `$run/customer-bootstrap`, do usuário do contêiner (o `node` da imagem da API, o mesmo do
# worker), dentro de /run/verax (0700, só root).
CUSTOMER_SECRETS=(admin-bootstrap support-bootstrap)
CUSTOMER_PAYLOADS_MOUNT=/run/verax-bootstrap
BOOTSTRAP_UID=$WORKER_UID
# Servidor de metadados da VM e API do Secret Manager (o teste do pacote troca pelos falsos), e a versão instalada.
metadata_url=http://metadata.google.internal/computeMetadata/v1
secretmanager_url=https://secretmanager.googleapis.com/v1
images_env=/etc/verax/images.env
# Espera base entre as tentativas de gravar no Secret Manager, em segundos (cresce a cada tentativa).
retry_pause=5
compose() { # [--base] <argumentos do compose...>; --base: sem o compose.wazuh.yaml (a pilha da aplicação)
  local files=(-f /opt/verax/compose.yaml) env_files=(--env-file /etc/verax/images.env)
  if [[ ${1:-} == --base ]]; then
    shift
  elif standard; then
    files+=(-f /opt/verax/compose.wazuh.yaml)
    if agents; then files+=(-f /opt/verax/compose.wazuh-agents.yaml); fi
  fi
  # Com o cofre, o worker ganha o arquivo das chaves (compose.vault.yaml), também com --base (o worker é da pilha da
  # aplicação). Sem ele (o nó da Verax), os serviços são os de antes do cofre: os do compose.yaml (e os do Wazuh, no
  # standard).
  if [[ ${CREDENTIALS_VAULT:-false} == true ]]; then files+=(-f /opt/verax/compose.vault.yaml); fi
  # Antes do render (no `down` depois de um reboot), o arquivo da memória ainda não existe; o `down` não precisa dele.
  if [[ -f $run/memory.env ]]; then env_files+=(--env-file "$run/memory.env"); fi
  docker compose --project-directory /opt/verax "${files[@]}" "${env_files[@]}" "$@"
}

internal_secret() { cat "$secrets/$1"; }

# Segredo do Secret Manager, sem quebra de linha no fim; recusa valor com quebra no meio (quebraria o arquivo de
# ambiente e poderia injetar outra variável). Sai com 3 quando o cofre ainda não tem valor (NOT_FOUND) e com 1 em
# qualquer outro erro (permissão, rede, valor inválido), mostrando o motivo que o gcloud deu.
external_secret() {
  local value errors status=0
  errors=$(mktemp)
  value=$(gcloud secrets versions access latest --project "$VERAX_GCP_PROJECT" \
    --secret "$VERAX_SECRET_PREFIX-$1" 2>"$errors") || status=$?
  if ((status != 0)); then
    if grep -q 'NOT_FOUND' "$errors"; then
      echo "Segredo $VERAX_SECRET_PREFIX-$1 ainda sem valor no Secret Manager (ver docs/runbooks/no-verax.md)." >&2
      status=3
    else
      echo "Falha ao ler o segredo $VERAX_SECRET_PREFIX-$1 no Secret Manager:" >&2
      sed 's/^/  /' "$errors" >&2
      status=1
    fi
    rm -f "$errors"
    return "$status"
  fi
  rm -f "$errors"
  value=${value%$'\n'}
  if [[ -z $value || $value == *$'\n'* || $value == *$'\r'* ]]; then
    echo "Segredo $VERAX_SECRET_PREFIX-$1 vazio ou com quebra de linha." >&2
    return 1
  fi
  printf '%s' "$value"
}

# Os bits de uma chave privada RSA em PEM (o conteúdo de uma versão do cofre, em base64), ou falha se o conteúdo não
# for isso. A mesma régua do worker (credential-keys.ts): o PEM começa na linha BEGIN (o openssl aceitaria texto antes
# dela; o worker, não) e a chave é RSA, não RSA-PSS (o openssl imprime um módulo para as duas, e o worker recusa a PSS;
# só ela leva "PSS parameter" no texto). O "RSA " antes de "Private-Key" é do OpenSSL 1.1. Tudo em pipes: nada vai para
# o disco.
vault_key_bits() { # <base64 do PEM>
  local begin='^[[:space:]]*-----BEGIN (RSA )?PRIVATE KEY-----[[:space:]]*$' bits='^(RSA )?Private-Key: \(([0-9]+) bit'
  local first text
  first=$(printf '%s' "$1" | base64 -d 2>/dev/null | sed -n '/[^[:space:]]/{p;q}') || return 1
  [[ $first =~ $begin ]] || return 1
  text=$(printf '%s' "$1" | base64 -d 2>/dev/null | openssl pkey -noout -text 2>/dev/null) || return 1
  [[ $text == *$'\nmodulus:'* && $text != *'PSS parameter'* && $text =~ $bits ]] || return 1
  echo "${BASH_REMATCH[2]}"
}

# Chave do cofre de credenciais (fase 2; só com CREDENTIALS_VAULT=true no node.conf). Cada versão do segredo
# `<prefixo>-credentials-key` é uma versão da chave, o par RSA que o install.sh gerou na VM. O Secret Manager numera as
# versões em sequência e nunca reaproveita um número: a leitura vai da 1 até a primeira que não existe (NOT_FOUND), com
# a permissão de ler o segredo e sem a de listar as versões (cada versão que existe, em qualquer estado, custa uma
# leitura na partida). Versão desativada ou destruída (FAILED_PRECONDITION) fica de fora; a mais alta que abre é a
# corrente. O PEM não passa pelo shell: o gcloud entrega o conteúdo em base64, que segue assim para o worker.
#
# Cada versão ativa é conferida aqui como o worker vai conferir (PEM de chave privada RSA de 3072 a 4096 bits): uma que
# ele recusasse derrubaria só o worker, em laço, depois de a partida ter dito que deu certo. Então a partida para aqui,
# dizendo qual versão desativar.
#
# Preenche `vault_api` (só a chave pública corrente, para a API, que cifra) e `vault_worker` (o caminho do arquivo das
# privadas e a corrente, para o worker, o único que decifra), declaradas no render, e escreve o arquivo das privadas em
# WORKER_KEYS (tmpfs), na pasta que o compose.vault.yaml monta só leitura no worker. As privadas nunca vão por variável
# de ambiente: o Docker grava o ambiente de cada contêiner na configuração dele, em /var/lib/docker, que está no disco
# e nos snapshots; o conteúdo de um arquivo montado não vai para lá. Sem nenhuma versão ativa, avisa, deixa as duas
# listas vazias e o arquivo vazio: a API e o worker sobem sem o cofre. Qualquer outro erro (permissão, rede, conteúdo
# que não é chave) para a partida, e nada do cofre fica na memória (nem o arquivo da partida anterior).
credentials_vault() {
  local secret=$VERAX_SECRET_PREFIX-credentials-key version=1 data errors status bits keys=() current=''
  local disabled=() destroyed=()
  errors=$(mktemp)
  while :; do
    status=0
    data=$(gcloud secrets versions access "$version" --project "$VERAX_GCP_PROJECT" --secret "$secret" \
      --format='get(payload.data)' 2>"$errors") || status=$?
    if ((status == 0)); then
      # O base64 do gcloud usa o alfabeto da URL; o worker lê o comum. E, se o `=` do fim vier cortado, ele volta: o
      # `base64 -d` do nó (coreutils 9.1) recusa base64 sem o fim, e nenhuma versão passaria.
      data=${data//-/+}
      data=${data//_//}
      case $((${#data} % 4)) in
        2) data+='==' ;;
        3) data+='=' ;;
      esac
      if [[ ! $data =~ ^[A-Za-z0-9+/]+={0,2}$ ]]; then
        echo "Versão $version do segredo $secret fora do formato." >&2
        rm -f "$errors"
        discard_worker_keys
        return 1
      fi
      if ! bits=$(vault_key_bits "$data") || ((bits < 3072 || bits > 4096)); then
        echo "A versão $version do segredo $secret não é uma chave privada RSA de 3072 a 4096 bits em PEM, e o worker" \
          "não subiria com ela. Desative essa versão (gcloud secrets versions disable $version --secret $secret" \
          "--project $VERAX_GCP_PROJECT) e reinicie: sudo systemctl restart verax-node" >&2
        rm -f "$errors"
        discard_worker_keys
        return 1
      fi
      keys+=("$version:$data")
      current=$version
    elif grep -q 'NOT_FOUND' "$errors"; then
      break
    elif grep -q 'FAILED_PRECONDITION' "$errors"; then
      # Fora de uso. A mensagem do gcloud diz o estado ("is in DISABLED state" ou "is in DESTROYED state"): só a
      # desativada pode voltar, e o aviso sem versão ativa depende disso.
      if grep -q 'DISABLED' "$errors"; then disabled+=("$version"); else destroyed+=("$version"); fi
    else
      echo "Falha ao ler a versão $version do segredo $secret no Secret Manager:" >&2
      sed 's/^/  /' "$errors" >&2
      rm -f "$errors"
      discard_worker_keys
      return 1
    fi
    version=$((version + 1))
  done
  rm -f "$errors"
  if [[ -z $current ]]; then
    # Sem versão nenhuma (a 1 não existe), o install.sh gera a chave; com versões que existem, ele não mexe (a versão 1
    # decide), então o caminho é reativar a desativada mais recente ou, se só há destruídas, gravar uma versão nova.
    local remedy
    if ((version == 1)); then
      remedy="O segredo ainda não tem versão: rode o deploy de novo (o install.sh gera a chave na VM quando o cofre nunca teve uma)"
    elif ((${#disabled[@]})); then
      remedy="Toda versão que existe está desativada ou destruída: reative a desativada mais recente (gcloud secrets versions enable ${disabled[-1]} --secret $secret --project $VERAX_GCP_PROJECT)"
    else
      remedy="Toda versão que existe foi destruída (${destroyed[*]}): grave uma chave nova (docs/runbooks/no-verax.md; as credenciais precisam ser coladas de novo)"
    fi
    echo "AVISO: o cofre de credenciais ($secret) não tem nenhuma versão ativa: a API e o worker sobem sem ele, e o" \
      "token do Cloudflare não pode ser gravado nem lido. $remedy e reinicie:" \
      "sudo systemctl restart verax-node" >&2
    write_worker_keys
    return 0
  fi
  # A pública sai da privada corrente, num pipe (nada vai para o disco).
  local public
  public=$(printf '%s' "${keys[-1]#*:}" | base64 -d | openssl pkey -pubout 2>/dev/null | base64 -w0) || {
    echo "A versão $current do segredo $secret não é uma chave privada legível." >&2
    discard_worker_keys
    return 1
  }
  write_worker_keys "${keys[@]}"
  vault_api=("CREDENTIALS_PUBLIC_KEY=$public" "CREDENTIALS_KEY_VERSION=$current")
  vault_worker=("CREDENTIALS_PRIVATE_KEYS_FILE=$WORKER_KEYS_MOUNT" "CREDENTIALS_KEY_CURRENT=$current")
}

# O arquivo das chaves privadas do worker (WORKER_KEYS, na pasta WORKER_VAULT de /run/verax): uma linha
# `<versão>:<PEM em base64>` por versão ativa, 0400 e do usuário do worker, que é o único que o lê. Existe sempre que o
# cofre está ligado (vazio sem versão ativa). A pasta pode já existir: o Docker a cria (0755, de root) se o worker subir
# antes desta partida (reinício pelo Docker depois de um reboot inesperado), e o install acerta o modo e o dono dela
# (0750, de root e do grupo do worker, que só precisa atravessá-la). O arquivo nasce ao lado, 0600 de root pelo umask,
# e entra no lugar de uma vez (rename): um worker que o Docker esteja reiniciando nunca lê um arquivo pela metade. O
# `-T` recusa um destino que seja pasta, em vez de mover o arquivo para dentro dela.
write_worker_keys() { # [<versão>:<base64>...]
  local file
  install -d -m 0750 -o 0 -g "$WORKER_UID" "$WORKER_VAULT"
  rm -f "$WORKER_VAULT"/.worker-keys.*
  file=$(mktemp "$WORKER_VAULT/.worker-keys.XXXXXX")
  if (($#)); then printf '%s\n' "$@" >"$file"; fi
  chmod 0400 "$file"
  chown "$WORKER_UID:$WORKER_UID" "$file"
  mv -fT "$file" "$WORKER_KEYS"
}

# Nada do cofre fica na memória quando a leitura para no meio (nem o arquivo da partida anterior). A parada também o
# tira (`down`); um reboot, por ser tmpfs, idem.
discard_worker_keys() {
  rm -rf "$WORKER_VAULT"
}

database_url() { # <papel> <senha>
  printf 'postgresql://%s:%s@postgres:5432/verax?sslmode=verify-full&sslrootcert=/etc/verax/tls/ca.crt' "$1" "$2"
}

# Cada linha vira CHAVE='valor': entre aspas simples, o Compose lê o valor literalmente, sem interpretar `$` (uma senha
# com `$TOKEN` no meio chegaria trocada). Valor com aspa simples ou quebra de linha não cabe nesse formato: recusa.
write_env() { # <arquivo> <CHAVE=valor...>
  local file=$run/$1 line key value
  : >"$file"
  chmod 0600 "$file"
  for line in "${@:2}"; do
    key=${line%%=*}
    value=${line#*=}
    if [[ $value == *"'"* || $value == *$'\n'* || $value == *$'\r'* ]]; then
      echo "Valor de $key com aspa simples ou quebra de linha: não cabe no arquivo de ambiente." >&2
      return 1
    fi
    printf "%s='%s'\n" "$key" "$value" >>"$file"
  done
}

# Standard: as quatro senhas do Wazuh (admin do indexer, wazuh_filebeat do manager, wazuh-wui da API do manager e o
# usuário só leitura verax_api_read), geradas pelo install.sh. Conferidas antes de qualquer arquivo ser escrito: num
# nó que passou a standard sem rodar o install.sh de novo, a falta é dita com todas as letras, e nada sobe pela metade.
# Formato que todos os componentes aceitam e senhas diferentes entre si (scripts/lib-passwords.sh).
wazuh_passwords() {
  local name
  for name in wazuh-indexer-admin wazuh-indexer-filebeat wazuh-api wazuh-indexer-read; do
    if [[ ! -s $secrets/$name ]]; then
      echo "Falta $secrets/$name: o perfil standard precisa das senhas do Wazuh, que o install.sh gera. Rode o" \
        "deploy.sh (ou o install.sh na VM) de novo antes de subir o nó." >&2
      return 1
    fi
  done
  # shellcheck source=SCRIPTDIR/../../wazuh/scripts/lib-passwords.sh
  source "$wazuh/scripts/lib-passwords.sh"
  INDEXER_ADMIN_PASSWORD=$(internal_secret wazuh-indexer-admin)
  INDEXER_FILEBEAT_PASSWORD=$(internal_secret wazuh-indexer-filebeat)
  WAZUH_API_PASSWORD=$(internal_secret wazuh-api)
  INDEXER_API_READ_PASSWORD=$(internal_secret wazuh-indexer-read)
  check_wazuh_passwords INDEXER_ADMIN_PASSWORD INDEXER_FILEBEAT_PASSWORD WAZUH_API_PASSWORD INDEXER_API_READ_PASSWORD
}

# Agentes (WAZUH_AGENTS=true): o que o node.conf diz e o que o install.sh gerou, conferidos antes de qualquer arquivo
# ser escrito, nos mesmos formatos do install.sh. Preenche `agents_api` (para a API: o endereço, o cliente, as faixas
# liberadas, o limite, a CA do registro em base64 e a senha de registro, que só os administradores veem no painel) e
# `agents_worker` (o caminho da lista dos agentes e o cliente a quem eles pertencem), declaradas no render. A senha não
# vai para o worker nem para o manager por variável: o gerador a lê do arquivo, montado só leitura.
wazuh_agents() {
  local octet='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])' ipv4 cidr file enrollment ca
  ipv4="$octet(\\.$octet){3}"
  cidr="$ipv4/(1[6-9]|2[0-9]|3[0-2])"
  if ! standard; then
    echo 'WAZUH_AGENTS=true só no perfil standard: o Wazuh só existe nele (NODE_PROFILE em /etc/verax/node.conf).' >&2
    return 1
  fi
  if [[ ! ${WAZUH_AGENTS_ADDRESS:-} =~ ^$ipv4$ ]]; then
    echo 'WAZUH_AGENTS_ADDRESS inválido em /etc/verax/node.conf: use o IP fixo dos agentes, sem máscara.' >&2
    return 1
  fi
  if [[ ! ${WAZUH_AGENTS_TENANT:-} =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
    echo 'WAZUH_AGENTS_TENANT inválido em /etc/verax/node.conf: use o id do cliente do nó.' >&2
    return 1
  fi
  if [[ -n ${WAZUH_AGENTS_SOURCES:-} && ! $WAZUH_AGENTS_SOURCES =~ ^$cidr(,$cidr)*$ ]]; then
    echo 'WAZUH_AGENTS_SOURCES inválido em /etc/verax/node.conf: IPv4 de /16 a /32, separados por vírgula.' >&2
    return 1
  fi
  if [[ -n ${WAZUH_AGENTS_MAX:-} ]] && { [[ ! $WAZUH_AGENTS_MAX =~ ^[1-9][0-9]{0,2}$ ]] || ((WAZUH_AGENTS_MAX > 500)); }; then
    echo 'WAZUH_AGENTS_MAX inválido em /etc/verax/node.conf: use um inteiro de 1 a 500.' >&2
    return 1
  fi
  for file in "$secrets/wazuh-agents-enrollment" "$agents_certs/ca.crt" "$agents_certs/manager.crt" \
    "$agents_certs/manager.key"; do
    if [[ ! -s $file ]]; then
      echo "Falta $file: com WAZUH_AGENTS=true, o install.sh gera a senha de registro e o certificado dos agentes." \
        "Rode o deploy.sh (ou o install.sh na VM) de novo antes de subir o nó." >&2
      return 1
    fi
  done
  enrollment=$(internal_secret wazuh-agents-enrollment)
  if [[ ! $enrollment =~ ^[A-Za-z0-9]{32,64}$ ]]; then
    echo "A senha de registro dos agentes ($secrets/wazuh-agents-enrollment) deve ter de 32 a 64 letras e dígitos." >&2
    return 1
  fi
  ca=$(base64 -w0 "$agents_certs/ca.crt")
  agents_api=(WAZUH_AGENTS=true "WAZUH_AGENTS_ADDRESS=$WAZUH_AGENTS_ADDRESS" "WAZUH_AGENTS_TENANT=$WAZUH_AGENTS_TENANT")
  if [[ -n ${WAZUH_AGENTS_SOURCES:-} ]]; then agents_api+=("WAZUH_AGENTS_SOURCES=$WAZUH_AGENTS_SOURCES"); fi
  if [[ -n ${WAZUH_AGENTS_MAX:-} ]]; then agents_api+=("WAZUH_AGENTS_MAX=$WAZUH_AGENTS_MAX"); fi
  agents_api+=("WAZUH_AGENTS_CA=$ca" "WAZUH_AGENTS_ENROLLMENT_PASSWORD=$enrollment")
  agents_worker=(WAZUH_AGENTS_FILE=/run/wazuh-agents/agents.json "WAZUH_AGENTS_TENANT=$WAZUH_AGENTS_TENANT")
}

render() {
  case ${NODE_PROFILE:-lean} in
    lean | standard) ;;
    *)
      echo 'NODE_PROFILE inválido em /etc/verax/node.conf: use lean ou standard.' >&2
      return 1
      ;;
  esac
  if standard; then wazuh_passwords; fi
  local agents_api=() agents_worker=()
  case ${WAZUH_AGENTS:-false} in
    # O `|| return` deixa a parada explícita também quando o render roda num contexto sem `set -e` (o teste).
    true) wazuh_agents || return 1 ;;
    false) ;;
    *)
      echo 'WAZUH_AGENTS inválido em /etc/verax/node.conf: use true ou false.' >&2
      return 1
      ;;
  esac
  # Modo cliente: o worker publica o estado do nó nos guest attributes, com a versão instalada (o commit que o
  # install.sh grava em /etc/verax/images.env). Conferido antes de qualquer arquivo ser escrito. Sem a linha, nada muda.
  local node_status=() version
  case ${CUSTOMER_MODE:-false} in
    true)
      version=$(sed -n 's/^NODE_VERSION=//p' "$images_env" 2>/dev/null | tail -n 1) || version=''
      if [[ ! $version =~ ^[0-9a-f]{40}$ ]]; then
        echo "NODE_VERSION ausente ou fora do formato em $images_env: rode o deploy.sh (ou o install.sh na VM) de novo." >&2
        return 1
      fi
      node_status=(NODE_STATUS=true "NODE_VERSION=$version")
      ;;
    false) ;;
    *)
      echo 'CUSTOMER_MODE inválido em /etc/verax/node.conf: use true ou false.' >&2
      return 1
      ;;
  esac
  mkdir -p "$run"
  chmod 0700 "$run"
  if standard; then
    write_env memory.env "${MEMORY_STANDARD[@]}"
  else
    write_env memory.env "${MEMORY_LEAN[@]}"
  fi
  # O bootstrap.env existe sempre, vazio: o serviço `bootstrap` (perfil setup) o exige, e o `config --images` do
  # pull_images lê o projeto inteiro com esse perfil (sem o arquivo, o Compose recusa o projeto e nada é baixado). O
  # `start.sh bootstrap` o preenche só durante a execução.
  write_env bootstrap.env
  # Cada segredo numa atribuição própria. Lido direto num argumento (`write_env x "K=$(...)"`), uma falha passaria pelo
  # `set -e` sem parar nada, e o arquivo sairia com o valor vazio.
  local master migrator app session_key csrf_key
  master=$(internal_secret postgres-master)
  migrator=$(internal_secret postgres-migrator)
  app=$(internal_secret postgres-app)
  session_key=$(internal_secret better-auth-secret)
  csrf_key=$(internal_secret csrf-secret)
  # Standard: cada contêiner do Wazuh recebe só as senhas que usa (o security-init, as três que ele transforma em hash;
  # o manager, a do filebeat e a da API dele). A senha do admin do indexer não chega a nenhum contêiner que fica no
  # ar. A API e o worker leem o indexer do próprio nó com o usuário só leitura e a CA do volume público dos
  # certificados.
  local indexer=()
  if standard; then
    write_env wazuh-security.env "INDEXER_ADMIN_PASSWORD=$INDEXER_ADMIN_PASSWORD" \
      "INDEXER_FILEBEAT_PASSWORD=$INDEXER_FILEBEAT_PASSWORD" "INDEXER_API_READ_PASSWORD=$INDEXER_API_READ_PASSWORD"
    write_env wazuh-manager.env "INDEXER_PASSWORD=$INDEXER_FILEBEAT_PASSWORD" "API_PASSWORD=$WAZUH_API_PASSWORD"
    indexer=(INDEXER_URL=https://wazuh.indexer:9200 INDEXER_AUTH=node INDEXER_USERNAME=verax_api_read
      "INDEXER_PASSWORD=$INDEXER_API_READ_PASSWORD" INDEXER_CA_FILE=/etc/verax/wazuh/root-ca.pem)
  fi

  write_env postgres.env POSTGRES_USER=verax "POSTGRES_PASSWORD=$master" POSTGRES_DB=verax
  write_env db-bootstrap.env \
    DB_MASTER_USERNAME=verax "DB_MASTER_PASSWORD=$master" \
    "MIGRATOR_DATABASE_URL=$(database_url verax_migrator "$migrator")" \
    "DATABASE_URL=$(database_url verax_app "$app")"
  write_env migrate.env NODE_ENV=production "DATABASE_URL=$(database_url verax_migrator "$migrator")"
  # E-mail opcional: contas novas nascem com senha temporária. Só com MAIL_TRANSPORT=smtp a senha da caixa de envio
  # é lida do cofre (e passa a ser obrigatória).
  local mail=(MAIL_TRANSPORT=none "MAIL_FROM=$MAIL_FROM") smtp_password
  if [[ ${MAIL_TRANSPORT:-none} == smtp ]]; then
    smtp_password=$(external_secret smtp-password)
    mail=(MAIL_TRANSPORT=smtp "MAIL_FROM=$MAIL_FROM" "SMTP_HOST=$SMTP_HOST" "SMTP_PORT=$SMTP_PORT"
      "SMTP_USER=$SMTP_USER" "SMTP_PASSWORD=$smtp_password")
  fi
  # Plano do nó, o mesmo na API e no worker. Os ajustes só entram quando definidos no node.conf; a API e o worker
  # conferem a combinação na partida (no enterprise, os quatro são obrigatórios).
  local plan=("PLAN=${PLAN:?defina PLAN em /etc/verax/node.conf}") key
  for key in PLAN_MAX_CLOUD_ACCOUNTS PLAN_MAX_USERS PLAN_MONTHLY_GIB PLAN_HISTORY_DAYS; do
    if [[ -n ${!key:-} ]]; then plan+=("$key=${!key}"); fi
  done
  # Tópico do nó para o sink de um projeto GCP de cliente: Contas cloud monta o comando do sink com ele. É o nome que
  # o módulo do Terraform dá ao tópico de cada projeto (`<prefixo>-security-<projeto>`, no projeto do nó; o prefixo é
  # o mesmo dos cofres), sem o projeto no fim. Não é segredo. Um teste da API confere que os dois continuam iguais.
  # A API só aceita a variável no formato do módulo (as mesmas regras de project_id e name_prefix, que o install.sh
  # já confere): com um node.conf editado depois fora delas, a variável fica de fora e a API sobe mesmo assim, com
  # Contas cloud mostrando o comando com o tópico a preencher.
  local sink_topic=()
  if [[ $VERAX_GCP_PROJECT =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ && $VERAX_SECRET_PREFIX =~ ^[a-z][a-z0-9-]{3,18}$ ]]; then
    sink_topic=("GCP_SINK_TOPIC_PREFIX=projects/$VERAX_GCP_PROJECT/topics/$VERAX_SECRET_PREFIX-security-")
  else
    echo "AVISO: VERAX_GCP_PROJECT ou VERAX_SECRET_PREFIX fora do formato em /etc/verax/node.conf: a API sobe sem o" \
      "tópico do sink de projeto de cliente (Contas cloud mostra o comando com o tópico a preencher)." >&2
  fi
  # IP de saída do nó (o IP fixo do NAT, no perfil standard): Contas cloud o mostra como o `NodeEgressIps` da pilha do
  # papel de leitura da AWS e o filtro de IP recomendado para o token do Cloudflare. Não é segredo. Vai só no formato que o install.sh confere (IPv4 com /32, separados por
  # vírgula), o mesmo que a API aceita: com um node.conf editado depois fora dele, a variável fica de fora, com o aviso,
  # e a API sobe mesmo assim (a tela recomenda o filtro sem mostrar o IP).
  local egress=()
  if [[ -n ${NODE_EGRESS_IPS:-} ]]; then
    local octet='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
    local egress_ip="$octet(\\.$octet){3}/32"
    if [[ $NODE_EGRESS_IPS =~ ^$egress_ip(,$egress_ip)*$ ]]; then
      egress=("NODE_EGRESS_IPS=$NODE_EGRESS_IPS")
    else
      echo "AVISO: NODE_EGRESS_IPS fora do formato em /etc/verax/node.conf: a API sobe sem o IP de saída do nó" \
        "(Contas cloud recomenda o filtro de IP do token do Cloudflare sem mostrar o IP)." >&2
    fi
  fi
  # Papel de leitura sem chave da AWS (PR-V3'): o ID único da conta de serviço do nó no Google e o audience do token,
  # os valores que Contas cloud mostra para a pilha do cliente (com o IP de saída acima). Nenhum é segredo. Cada um vai
  # só quando o node.conf tem a linha, e só no formato que o install.sh, a API e o template aceitam (21 dígitos; https,
  # host em minúsculas e caminho sem curinga): fora dele, a variável fica de fora, com o aviso, e a API sobe mesmo
  # assim (sem o ID, a tela o pede à Verax; sem o audience, vale o padrão do template). Sem nenhum dos dois, o api.env
  # sai como antes.
  local aws_reader=()
  if [[ -n ${NODE_SA_UNIQUE_ID:-} ]]; then
    if [[ $NODE_SA_UNIQUE_ID =~ ^[0-9]{21}$ ]]; then
      aws_reader+=("NODE_SA_UNIQUE_ID=$NODE_SA_UNIQUE_ID")
    else
      echo "AVISO: NODE_SA_UNIQUE_ID fora do formato em /etc/verax/node.conf: a API sobe sem o ID da conta de serviço" \
        "do nó (Contas cloud não o mostra para a pilha da AWS)." >&2
    fi
  fi
  if [[ -n ${AWS_WEB_IDENTITY_AUDIENCE:-} ]]; then
    local audience_pattern='^https://[a-z0-9.-]+(/[A-Za-z0-9._-]+)*$'
    if ((${#AWS_WEB_IDENTITY_AUDIENCE} <= 256)) && [[ $AWS_WEB_IDENTITY_AUDIENCE =~ $audience_pattern ]]; then
      aws_reader+=("AWS_WEB_IDENTITY_AUDIENCE=$AWS_WEB_IDENTITY_AUDIENCE")
    else
      echo "AVISO: AWS_WEB_IDENTITY_AUDIENCE fora do formato em /etc/verax/node.conf: a API sobe com o audience" \
        "padrão do template." >&2
    fi
  fi
  # Turnstile (desafio no login e no "esqueci minha senha" do painel): a chave do site no node.conf é o interruptor.
  # Sem a linha, nada é lido e o api.env sai como sempre (o nó da Verax, enquanto não ligar). Com ela, a chave secreta
  # vem do cofre como o token do túnel: cofre ainda sem valor, o nó sobe sem o desafio e avisa; qualquer outro erro
  # para a partida. As duas chaves só entram juntas: a API recusa uma sem a outra.
  local turnstile=() turnstile_secret status=0
  if [[ -n ${TURNSTILE_SITE_KEY:-} ]]; then
    turnstile_secret=$(external_secret turnstile-secret-key) || status=$?
    if ((status == 3)); then
      echo "AVISO: TURNSTILE_SITE_KEY definida no node.conf, mas o cofre da chave secreta ainda não tem valor: o" \
        "login sobe sem o desafio do Turnstile. Grave a chave (docs/runbooks/no-verax.md) e reinicie:" \
        "sudo systemctl restart verax-node" >&2
    elif ((status != 0)); then
      return "$status"
    else
      turnstile=("TURNSTILE_SITE_KEY=$TURNSTILE_SITE_KEY" "TURNSTILE_SECRET_KEY=$turnstile_secret")
    fi
  fi
  # Cofre de credenciais: só no nó que tem o segredo `credentials-key` (CREDENTIALS_VAULT=true; sem a linha, false). O
  # nó da Verax não liga: nada é lido, e os arquivos de ambiente saem como antes. Vem depois do e-mail e do Turnstile:
  # uma falha na leitura deles para a partida antes de as chaves do worker irem para a memória.
  local vault_api=() vault_worker=()
  case ${CREDENTIALS_VAULT:-false} in
    true) credentials_vault ;;
    false) ;;
    *)
      echo 'CREDENTIALS_VAULT inválido em /etc/verax/node.conf: use true ou false.' >&2
      return 1
      ;;
  esac
  # TRUST_PROXY_HOPS=1: um proxy confiável na frente da API, o Cloudflare (o cloudflared só repassa).
  write_env api.env \
    NODE_ENV=production LOG_LEVEL=info PORT=3000 \
    "WEB_ORIGIN=$WEB_ORIGIN" "API_ORIGIN=$API_ORIGIN" \
    TRUST_PROXY_HOPS=1 \
    "BETTER_AUTH_SECRET=$session_key" \
    "CSRF_SECRET=$csrf_key" \
    "${mail[@]}" \
    "${plan[@]}" \
    "${indexer[@]}" \
    "${sink_topic[@]}" \
    "${egress[@]}" \
    "${aws_reader[@]}" \
    "${turnstile[@]}" \
    "${agents_api[@]}" \
    "${vault_api[@]}" \
    "DATABASE_URL=$(database_url verax_app "$app")"
  write_env worker.env \
    NODE_ENV=production LOG_LEVEL=info \
    "SYNC_SOURCES=$SYNC_SOURCES" SYNC_INTERVAL_SECONDS=60 \
    "${plan[@]}" \
    "${indexer[@]}" \
    "${agents_worker[@]}" \
    "${vault_worker[@]}" \
    "${node_status[@]}" \
    "DATABASE_URL=$(database_url verax_app "$app")"
  # Túnel: com o cofre ainda sem valor, o nó sobe sem o cloudflared (banco, API e coleta já rodam) e avisa; gravado o
  # token, `sudo systemctl restart verax-node` liga o túnel. Qualquer outro erro na leitura (permissão, rede, valor
  # inválido) para a partida, como nos outros segredos. O arquivo existe sempre (vazio sem o token): o Compose o exige.
  local tunnel
  status=0
  tunnel=$(external_secret cloudflare-tunnel-token) || status=$?
  if ((status == 3)); then
    write_env cloudflared.env
    echo "AVISO: sem o token do túnel, o nó sobe sem o cloudflared e o painel não alcança a API. Grave o token" \
      "(docs/runbooks/no-verax.md) e reinicie: sudo systemctl restart verax-node" >&2
  elif ((status != 0)); then
    return "$status"
  else
    write_env cloudflared.env "TUNNEL_TOKEN=$tunnel"
  fi
}

# Toda imagem do nó é fixada pelo digest (`imagem@sha256:...`): a que já está no disco é a definitiva, e só o que
# falta é baixado. Um `compose pull` a cada partida iria ao registro de cada imagem toda vez (as do Wazuh, no Docker
# Hub, anônimo e com limite por IP) e, com o registro fora do ar num reboot, pararia a partida antes de o banco subir.
pull_images() { # [--base]
  local images image
  # A lista primeiro, numa atribuição própria: um erro do Compose (um arquivo de ambiente que falte) para a partida com
  # o motivo no journal. Numa substituição de processo (`done < <(...)`), ele passaria em silêncio e nada seria baixado.
  images=$(compose "$@" --profile setup config --images) || return 1
  while read -r image; do
    [[ -n $image ]] || continue
    docker image inspect "$image" >/dev/null 2>&1 || docker pull --quiet "$image"
  done <<<"$images"
}

# Wazuh do perfil standard (verax-wazuh.service), depois da pilha da aplicação (o painel fica no ar antes; a tarefa
# `wazuh` do worker só registra o erro até o indexer subir). Mesma sequência do infra/wazuh/scripts/ci-test.sh:
# certificados (só na primeira vez), usuários do indexer com o hash das senhas, indexer, configuração de segurança,
# retenção e snapshot, configuração do manager, manager e o teste de fumaça. Os scripts do pacote chamam o Compose
# deste mesmo projeto pelas variáveis COMPOSE_*. Os arquivos de ambiente são os do `up` (o serviço exige o verax-node).
wazuh_up() {
  if ! standard; then
    echo 'O Wazuh só existe no perfil standard (NODE_PROFILE em /etc/verax/node.conf).' >&2
    return 2
  fi
  wazuh_passwords
  if [[ ! -f $run/memory.env || ! -f $run/wazuh-manager.env ]]; then
    echo "Arquivos de ambiente ausentes: o 'start.sh up' (verax-node.service) vem antes." >&2
    return 1
  fi
  # Os mesmos arquivos do compose(), com o dos agentes e o do cofre quando ligados: o projeto é um só.
  COMPOSE_FILE=/opt/verax/compose.yaml:/opt/verax/compose.wazuh.yaml
  if agents; then COMPOSE_FILE+=:/opt/verax/compose.wazuh-agents.yaml; fi
  if [[ ${CREDENTIALS_VAULT:-false} == true ]]; then COMPOSE_FILE+=:/opt/verax/compose.vault.yaml; fi
  export COMPOSE_FILE
  export COMPOSE_ENV_FILES=/etc/verax/images.env,$run/memory.env
  install -d -m 0700 "$run/wazuh-aws"
  pull_images
  compose --profile setup run --rm certs-init
  compose --profile setup run --rm security-init
  compose up --detach --wait --wait-timeout 600 wazuh.indexer
  bash "$wazuh/scripts/security-admin.sh"
  bash "$wazuh/scripts/configure-indexer.sh"
  /opt/verax/bin/wazuh-apply.sh
  compose up --detach --wait --wait-timeout 900 wazuh.manager
  # Com os agentes, o smoke test espera só a 1514 e a 1515 publicadas no manager e confere o registro (certificado do IP
  # dos agentes e senha errada recusada); sem eles, nenhuma porta.
  local agents_address=''
  if agents; then agents_address=$WAZUH_AGENTS_ADDRESS; fi
  INDEXER_ADMIN_PASSWORD=$INDEXER_ADMIN_PASSWORD INDEXER_FILEBEAT_PASSWORD=$INDEXER_FILEBEAT_PASSWORD \
    WAZUH_API_PASSWORD=$WAZUH_API_PASSWORD INDEXER_API_READ_PASSWORD=$INDEXER_API_READ_PASSWORD \
    WAZUH_AGENTS_ADDRESS=$agents_address bash "$wazuh/scripts/smoke-test.sh"
  # A guarda do metadata vale para o Wazuh (no molde do teste do EC2, infra/wazuh/scripts/bootstrap-host.sh): sem
  # resposta (000) no manager e no indexer. Se algum alcançar, os dois param e a partida falha.
  local service status
  for service in wazuh.manager wazuh.indexer; do
    status=$(compose exec -T "$service" curl -s -m 3 -o /dev/null -w '%{http_code}' -H 'Metadata-Flavor: Google' \
      http://169.254.169.254/computeMetadata/v1/instance/id || true)
    if [[ $status != 000 ]]; then
      echo "ERRO: $service alcança o servidor de metadados da VM (HTTP $status). O Wazuh foi parado." >&2
      compose stop wazuh.manager wazuh.indexer
      return 1
    fi
  done
  echo 'Wazuh no ar: manager e indexer sem acesso ao servidor de metadados.'
}

wazuh_down() {
  if standard; then compose stop wazuh.manager wazuh.indexer; fi
}

up() {
  # A guarda do metadata já está valendo desde antes do Docker (verax-metadata-guard.service); aqui ela é só
  # reafirmada, para uma partida sem reboot logo depois de uma atualização do script.
  /opt/verax/bin/metadata-guard.sh
  render
  # Só as imagens da aplicação: as do Wazuh ficam para o `wazuh-up`, e o painel não espera por elas.
  pull_images --base
  compose up --detach --wait postgres
  # Sequência do deploy, a mesma do teste da imagem no CI.
  compose --profile setup run --rm db-bootstrap
  compose --profile setup run --rm migrate
  compose --profile setup run --rm db-bootstrap
  compose up --detach --wait api
  compose up --detach worker
  if [[ -s $run/cloudflared.env ]]; then
    compose up --detach cloudflared
  else
    compose rm --stop --force cloudflared >/dev/null 2>&1 || true
  fi
}

# A parada tira as chaves do cofre da memória junto com os contêineres, mesmo que o Compose falhe (o resto de /run/verax,
# os arquivos de ambiente, fica e é reescrito na próxima partida, como sempre foi).
down() {
  local status=0
  compose down || status=$?
  discard_worker_keys
  return "$status"
}

bootstrap() {
  : "${BOOTSTRAP_ADMIN_EMAIL:?defina BOOTSTRAP_ADMIN_EMAIL}"
  render
  write_env bootstrap.env \
    "BOOTSTRAP_ADMIN_EMAIL=$BOOTSTRAP_ADMIN_EMAIL" \
    "BOOTSTRAP_ADMIN_NAME=${BOOTSTRAP_ADMIN_NAME:-Administrador Verax}" \
    "BOOTSTRAP_TENANT_NAME=${BOOTSTRAP_TENANT_NAME:-}" \
    "BOOTSTRAP_GCP_ACCOUNTS=${BOOTSTRAP_GCP_ACCOUNTS:-}" \
    "BOOTSTRAP_RENEW_ADMIN_PASSWORD=${BOOTSTRAP_RENEW_ADMIN_PASSWORD:-false}"
  # A senha temporária do admin sai em duas linhas marcadas da saída: elas vão para um arquivo só de root, e o resto
  # aparece na tela. Quem instala lê o arquivo pelo SSH e apaga (docs/runbooks/no-verax.md). Mesmo se o bootstrap
  # falhar depois de gerar a senha, as linhas marcadas nunca vão para a tela.
  local output status=0 secret_file=/root/verax-senha-temporaria
  output=$(compose --profile setup run --rm -T bootstrap) || status=$?
  # Vazio de novo, e não apagado: os dados do bootstrap saem da memória, e o arquivo continua existindo para o Compose
  # (o `wazuh-up` e o próximo `up` leem o projeto inteiro).
  write_env bootstrap.env
  grep -v '^VERAX_SENHA_TEMPORARIA' <<<"$output" || true
  if grep -q '^VERAX_SENHA_TEMPORARIA=' <<<"$output"; then
    (
      umask 077
      grep '^VERAX_SENHA_TEMPORARIA' <<<"$output" | sed 's/^VERAX_SENHA_TEMPORARIA=/Senha temporária: /; s/^VERAX_SENHA_TEMPORARIA_VALE_ATE=/Vale até (UTC): /' >"$secret_file"
    )
    echo "Senha temporária do administrador gravada em $secret_file (só root). Leia com: sudo cat $secret_file e depois apague com: sudo rm $secret_file"
  fi
  return "$status"
}

# Um atributo dos metadados da instância (o servidor de metadados é local: três tentativas). Sai com 3 quando a chave
# não existe (404) e com 1 em qualquer outro erro. Valor vazio, com quebra de linha ou maior que 254 caracteres é
# recusado. Nada aqui é segredo, mas o valor (um e-mail, o nome do cliente) não vai para a tela.
metadata_attribute() { # <chave>
  local response='' status attempt value
  for attempt in 1 2 3; do
    if response=$(curl -sS --max-time 5 -H 'Metadata-Flavor: Google' -w '\n%{http_code}' \
      "$metadata_url/instance/attributes/$1" 2>/dev/null); then
      break
    fi
    response=''
    if ((attempt < 3)); then sleep "$retry_pause"; fi
  done
  status=${response##*$'\n'}
  case $status in
    200) ;;
    404) return 3 ;;
    *)
      echo "Falha ao ler o metadado $1 da VM (HTTP ${status:-sem resposta})." >&2
      return 1
      ;;
  esac
  value=${response%$'\n'*}
  if [[ -z $value || $value == *$'\n'* || $value == *$'\r'* ]] || ((${#value} > 254)); then
    echo "Metadado $1 da VM vazio, com quebra de linha ou longo demais." >&2
    return 1
  fi
  printf '%s' "$value"
}

# O cabeçalho Authorization com o token da conta de serviço da VM (servidor de metadados), num arquivo da pasta dada
# (0600 pelo umask, no tmpfs): o token nunca passa por argumento de comando.
vm_token_header() { # <pasta>
  local token
  curl -sS --max-time 10 -o "$1/token.json" -H 'Metadata-Flavor: Google' \
    "$metadata_url/instance/service-accounts/default/token" 2>/dev/null || return 1
  token=$(sed -n 's/.*"access_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1/token.json")
  rm -f "$1/token.json"
  if [[ ! $token =~ ^[A-Za-z0-9._~+/=-]+$ ]] || ((${#token} < 16 || ${#token} > 4096)); then return 1; fi
  printf 'Authorization: Bearer %s\n' "$token" >"$1/auth"
}

# Grava o conteúdo como versão nova do segredo `<prefixo>-<nome>`, pela API REST do Secret Manager, com a identidade da
# VM. A VM só tem `secretVersionAdder` nesses segredos: grava e não lê de volta. O conteúdo vai para o corpo do pedido
# por um arquivo 0600 numa pasta de /run/verax (tmpfs, só root), nunca por argumento de comando (a lista de processos),
# variável de ambiente ou tela; o token, idem. Tenta de novo, até 5 vezes e com espera crescente, a falha de rede, o
# 429 e o 5xx (o pedido repetido depois de uma resposta perdida grava o mesmo conteúdo outra vez: a `latest` não muda);
# qualquer outro erro (permissão, segredo que não existe) para na hora. Do erro, só o código e o status do Google
# (`PERMISSION_DENIED`, `NOT_FOUND`), nunca o corpo.
secret_add_version() { # <nome> <conteúdo>
  local secret=$VERAX_SECRET_PREFIX-$1 work code reason attempt
  work=$(mktemp -d "$run/.secret-add.XXXXXX")
  { printf '{"payload":{"data":"'; printf '%s' "$2" | base64 -w0; printf '"}}'; } >"$work/body"
  for attempt in 1 2 3 4 5; do
    code=000
    if vm_token_header "$work"; then
      code=$(curl -sS --max-time 30 -o "$work/response" -w '%{http_code}' -X POST -H @"$work/auth" \
        -H 'Content-Type: application/json' --data-binary @"$work/body" \
        "$secretmanager_url/projects/$VERAX_GCP_PROJECT/secrets/$secret:addVersion" 2>/dev/null) || code=000
    fi
    case $code in
      200)
        rm -rf "$work"
        return 0
        ;;
      000 | 429 | 5??) ;;
      *) break ;;
    esac
    if ((attempt < 5)); then sleep $((retry_pause * attempt)); fi
  done
  reason=$(sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([A-Z_]*\)".*/\1/p' "$work/response" 2>/dev/null |
    head -n 1) || reason=''
  rm -rf "$work"
  echo "Falha ao gravar a versão do segredo $secret no Secret Manager (HTTP $code${reason:+, $reason})." >&2
  return 1
}

# As senhas que o node-bootstrap deixou na pasta, cada uma para o seu segredo; o arquivo sai só depois de o Secret
# Manager confirmar (numa falha, fica no tmpfs para a próxima execução). A pasta é do usuário do contêiner: um arquivo
# que não seja regular (um link para outro arquivo do host, por exemplo) ou fora do formato do contrato é recusado sem
# ser enviado.
push_customer_secrets() { # <pasta>
  local dir=$1 name file content
  local shape='^\{"email":"[^"]{3,254}","password":"[^"]{16,}","expiresAt":"[^"]{20,40}"\}$'
  for name in "${CUSTOMER_SECRETS[@]}"; do
    file=$dir/$name.json
    [[ -e $file || -L $file ]] || continue
    if [[ -L $file || ! -f $file ]]; then
      echo "$file não é um arquivo comum: nada foi gravado no Secret Manager. Apague-o e rode de novo." >&2
      return 1
    fi
    content=$(<"$file")
    if [[ ! $content =~ $shape ]] || ((${#content} > 1024)); then
      echo "$file fora do formato do contrato: nada foi gravado no Secret Manager." >&2
      return 1
    fi
    secret_add_version "$name" "$content" || return 1
    rm -f "$file"
    echo "Senha nova gravada no Secret Manager ($VERAX_SECRET_PREFIX-$name)."
  done
}

# Modo cliente: o primeiro acesso do nó (verax-customer-bootstrap.service, depois do verax-node). Lê dos metadados da VM
# o nome do cliente, o e-mail do administrador do cliente e o da conta de suporte, roda o node-bootstrap no modo
# customer (as entradas vão por variável de ambiente do `compose run`, nunca pelo bootstrap.env, que não aceita aspas
# simples num nome, nem por argumento) e grava cada senha nova no Secret Manager. Idempotente: depois da primeira vez,
# nenhuma senha sai, a não ser a pedido (BOOTSTRAP_RENEW_ADMIN_PASSWORD ou BOOTSTRAP_RENEW_SUPPORT_PASSWORD=true no
# ambiente de quem roda). Uma senha que não chegou ao cofre vai antes de qualquer outra: sem isso, o bootstrap não roda.
customer_bootstrap() {
  if ! customer; then
    echo 'O customer-bootstrap só existe no modo cliente (CUSTOMER_MODE=true em /etc/verax/node.conf).' >&2
    return 2
  fi
  if [[ ! -f $run/api.env || ! -f $run/bootstrap.env ]]; then
    echo "Arquivos de ambiente ausentes: o 'start.sh up' (verax-node.service) vem antes." >&2
    return 1
  fi
  local dir=$run/customer-bootstrap pair key variable value status inputs=() lock
  # Uma execução por vez: o serviço e quem roda à mão (o pedido de senha nova) não geram senha ao mesmo tempo.
  exec {lock}>"$run/.customer-bootstrap.lock"
  if ! flock -w 600 "$lock"; then
    echo 'Outro customer-bootstrap está rodando há mais de 10 minutos: tente de novo depois.' >&2
    return 1
  fi
  install -d -m 0700 -o "$BOOTSTRAP_UID" -g "$BOOTSTRAP_UID" "$dir"
  rm -f "$dir"/.*.tmp
  push_customer_secrets "$dir" || return 1
  for pair in "${CUSTOMER_BOOTSTRAP_INPUTS[@]}"; do
    key=${pair%%=*}
    variable=${pair#*=}
    status=0
    value=$(metadata_attribute "$key") || status=$?
    if ((status == 3)); then
      echo "Falta o metadado $key na VM: o Terraform do nó de cliente o grava." >&2
      return 1
    elif ((status != 0)); then
      return 1
    fi
    local -x "$variable=$value"
    inputs+=(-e "$variable")
  done
  local -x BOOTSTRAP_MODE=customer
  local -x BOOTSTRAP_RENEW_ADMIN_PASSWORD=${BOOTSTRAP_RENEW_ADMIN_PASSWORD:-false}
  local -x BOOTSTRAP_RENEW_SUPPORT_PASSWORD=${BOOTSTRAP_RENEW_SUPPORT_PASSWORD:-false}
  status=0
  compose --profile setup run --rm -T -v "$dir:$CUSTOMER_PAYLOADS_MOUNT" -e BOOTSTRAP_MODE \
    -e BOOTSTRAP_RENEW_ADMIN_PASSWORD -e BOOTSTRAP_RENEW_SUPPORT_PASSWORD "${inputs[@]}" bootstrap || status=$?
  # O que foi gerado vai para o cofre mesmo se o bootstrap falhou depois.
  push_customer_secrets "$dir" || return 1
  return "$status"
}

case ${1:-} in
  up) up ;;
  down) down ;;
  wazuh-up) wazuh_up ;;
  wazuh-down) wazuh_down ;;
  bootstrap) bootstrap ;;
  customer-bootstrap) customer_bootstrap ;;
  render) render ;;
  *)
    echo "Uso: start.sh up|down|wazuh-up|wazuh-down|bootstrap|customer-bootstrap|render" >&2
    exit 2
    ;;
esac
