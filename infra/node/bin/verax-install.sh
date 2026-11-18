#!/bin/bash
# Instalador do Verax Control na VM própria do cliente (NODE_PLATFORM=vm; docs/runbooks/instalacao-no-cliente.md). Vai
# como asset do release `node-vX.Y.Z`, com o SHA-256 no manifesto assinado (campo `installer`), e o console mostra o
# comando:
#   curl -fsSLo verax-install.sh https://github.com/williandotdev/verax-control/releases/download/<release>/verax-install.sh \
#     && echo "<sha256 do instalador>  verax-install.sh" | sha256sum -c - \
#     && sudo bash verax-install.sh --codigo <código de uso único>
# Uso (root):
#   verax-install.sh --codigo <código>   instala o nó (ou reinstala, com um código novo gerado no console)
#   verax-install.sh --atualizar         leva a instalação desta VM à versão deste instalador (com backup antes) e
#                                        conclui um registro que tenha ficado pela metade
#   --plano-de-controle <url>            outro plano de controle (só para testes)
#
# A instalação, nesta ordem:
#  1. confere o host: Debian 12 ou Ubuntu 22.04/24.04, x86_64, root e o mínimo do porte P (o menor);
#  2. instala o jq e o Docker (o repositório oficial da Docker com a chave conferida, como o install.sh do nó da GCP) e
#     ajusta o kernel para o indexer do Wazuh;
#  3. baixa o manifesto da versão deste instalador e a assinatura e confere com o verificador (bin/verify-release.sh) e
#     as chaves públicas de release EMBUTIDOS neste arquivo quando o release foi montado (scripts/node-release.sh
#     installer), nunca baixados;
#  4. baixa o pacote e confere o SHA-256, os caminhos e as imagens de terceiros, como o boot-install.sh;
#  5. troca o código pelo registro do nó (POST /v1/node-enrollment/claim) e confere o mínimo do porte contratado;
#  6. grava o node.conf, o cofre local (/etc/verax/vault) e as entradas do primeiro acesso (/etc/verax/customer);
#  7. roda o install.sh do pacote com os digests do manifesto;
#  8. espera o nó, o Wazuh, o primeiro acesso e o túnel e entrega a senha temporária do administrador ao plano de
#     controle (POST /v1/node-enrollment/report, `ready`); depois, apaga a cópia local da senha;
#  9. numa falha depois do registro, avisa o plano de controle com um código curto (`error`).
# A VM só faz conexões de saída: nada abre porta de entrada. Nada que vem da rede é interpretado pelo shell: cada valor
# passa por uma expressão regular antes de ir para o node.conf (que o install.sh e o start.sh leem com `source`), e os
# textos livres (o nome do cliente e as senhas) vão do jq direto para um arquivo. Nenhum segredo (o código, a chave do
# nó, o token do túnel, as senhas) vai para a tela ou para argumento de comando.
set -euo pipefail
umask 077
export LC_ALL=C
PATH=${PATH:+$PATH:}/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# --- Embutido no release (scripts/node-release.sh installer) --------------------------------------------------------
# A versão deste instalador, o verificador do manifesto e as chaves públicas de release do commit da versão. Na cópia
# do repositório ficam vazios, e o instalador recusa rodar.
installer_release=''
embedded_verifier() {
  base64 -d <<'VERAX_VERIFIER'
VERAX_VERIFIER
}
# Uma chave por linha: o nome do arquivo e a chave pública em base64 (o formato do script de boot do módulo do nó).
embedded_keys() {
  cat <<'VERAX_RELEASE_KEYS'
VERAX_RELEASE_KEYS
}

# --- Onde o instalador fala e escreve (o teste troca estas linhas pelos falsos dele) --------------------------------
# A API pública do plano de controle (o site `conta` do Firebase Hosting, que repassa ao cp-public).
control_plane=https://conta.veraxsistemas.com.br
release_base=https://github.com/williandotdev/verax-control/releases/download
download_proto='=https'
etc_dir=/etc/verax
lib_dir=/var/lib/verax
opt_dir=/opt/verax
run_base=/run
os_release=/etc/os-release
meminfo=/proc/meminfo
sysctl_dir=/etc/sysctl.d
# Esperas, em segundos: entre tentativas de rede, entre consultas ao systemd e os prazos de cada serviço (acima do
# TimeoutStartSec de cada um) e do túnel.
retry_pause=5
poll_pause=10
node_timeout=1500
wazuh_timeout=2700
customer_timeout=1500
tunnel_timeout=900

# O cofre local e as entradas do primeiro acesso (os mesmos caminhos do start.sh) e o estado do registro.
vault_dir=$etc_dir/vault
customer_inputs=$etc_dir/customer
enrollment=$lib_dir/enrollment

# Mínimos de cada porte. O P é o nó standard da GCP (e2-standard-2: 2 vCPU, 8 GB de memória, disco de 60 GB); o M e o
# G dobram o anterior (o M é o plano B da e2-standard-4). A memória e o disco com folga para o que o sistema reserva
# (o MemTotal de uma VM de 8 GB fica abaixo de 8192 MiB, e o sistema de arquivos de um disco de 60 GB, abaixo de 60 GiB).
declare -A min_cpus=([P]=2 [M]=4 [G]=8)
declare -A min_memory_mb=([P]=7500 [M]=15000 [G]=30000)
declare -A min_disk_gb=([P]=55 [M]=110 [G]=220)

# Formatos (os do boot-install.sh, do node-release.sh e do contrato do registro).
re_release='^node-v(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$'
re_sha='^[0-9a-f]{64}$'
re_commit='^[0-9a-f]{40}$'
re_secret_token='^[A-Za-z0-9_-]{43}$'
# O id do cliente no plano de controle é um ULID (`ULID_PATTERN` do control-plane): 26 caracteres do alfabeto de Crockford.
re_tenant_id='^[0-9A-HJKMNP-TV-Z]{26}$'
re_slug='^[a-z][a-z0-9-]{1,14}[a-z0-9]$'
re_label='[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
re_origin="^https://$re_label(\\.$re_label)+\$"
re_mail='^[A-Za-z0-9_+.-]*[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$'
re_smtp_host="^$re_label(\\.$re_label)+\$"
re_smtp_port='^[1-9][0-9]{0,4}$'
re_smtp_user='^[A-Za-z0-9][A-Za-z0-9@._+-]{0,253}$'
re_limit='^[1-9][0-9]{0,5}$'
# O token do túnel do Cloudflare: base64 de um JSON.
re_tunnel_token='^[A-Za-z0-9+/=_-]{32,4096}$'
re_error_code='^[a-z][a-z0-9_]{0,39}$'
re_third_party='^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(/[a-z0-9]+([._-][a-z0-9]+)*)*(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[0-9a-f]{64}$'
# O que pode ir para uma linha do node.conf: a última barreira antes do `source` do install.sh e do start.sh.
re_conf_line='^[A-Z][A-Z0-9_]*=[A-Za-z0-9@._+:/,-]*$'
# Texto não vazio só de ASCII visível, pelos códigos dos caracteres (a regra do boot-install.sh).
jq_visible='(type == "string" and length > 0 and all(explode[]; . >= 32 and . < 127))'

mode='' enrollment_code='' work='' node_key='' report_errors=false error_reported=false
os_id='' os_version='' os_codename='' host_cpus=0 host_memory_mb=0 host_disk_gb=0
manifest_file='' rel_commit='' rel_api_digest='' rel_migrate_digest='' images_repository='' package_dir=''

log() { echo "verax-install: $*"; }

usage() {
  echo 'Uso: sudo bash verax-install.sh --codigo <código> | --atualizar [--plano-de-controle <url>]' >&2
  exit 2
}

# Para tudo. Depois do registro (na instalação), avisa o plano de controle com o código.
fail() { # <código> <mensagem>
  log "ERRO ($1): $2" >&2
  if $report_errors && [[ -n $node_key ]]; then
    report_error "$1"
    error_reported=true
  fi
  exit 1
}

on_exit() {
  local status=$?
  if ((status != 0)) && $report_errors && ! $error_reported && [[ -n $node_key ]]; then
    report_error unexpected_error
  fi
  if [[ -n $work ]]; then rm -rf "$work"; fi
}

# --- Plano de controle -----------------------------------------------------------------------------------------------

# POST de JSON, com o corpo (e o cabeçalho de autorização, se houver) lido de arquivo: nada vai para argumento de
# comando. A resposta vai para <saída>; o código HTTP (000 sem resposta), para a variável `http_code`.
cp_post() { # <caminho> <arquivo do corpo> <saída> [arquivo do cabeçalho]
  local args=(-sS --proto "$download_proto" --connect-timeout 20 --max-time 60 --max-filesize 65536 -o "$3"
    -D "$work/cp-headers" -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H 'Accept: application/json'
    --data-binary "@$2")
  if (($# >= 4)); then args+=(-H "@$4"); fi
  : >"$work/cp-headers"
  http_code=$(curl "${args[@]}" "$control_plane$1" 2>/dev/null) || http_code=000
}

# A espera antes da próxima tentativa: no 429, o Retry-After do plano de controle (em segundos, até 300); fora dele,
# uma espera que cresce a cada tentativa.
retry_wait() { # <tentativa>
  local after
  after=$(sed -n 's/^[Rr]etry-[Aa]fter:[[:space:]]*\([0-9]\{1,3\}\)[[:space:]]*$/\1/p' "$work/cp-headers" | head -n 1)
  if [[ $http_code == 429 && -n $after ]] && ((10#$after <= 300)); then
    sleep "$((10#$after))"
  else
    sleep $((retry_pause * $1))
  fi
}

# O cabeçalho de autorização com a chave do nó, num arquivo da pasta de trabalho (tmpfs, 0600).
auth_header() {
  printf 'Authorization: Bearer %s\n' "$node_key" >"$work/auth"
}

# O aviso de erro ao plano de controle (só o código). Melhor esforço: uma falha aqui não muda a saída.
report_error() { # <código>
  local attempt
  [[ $1 =~ $re_error_code ]] || return 0
  auth_header
  printf '{"status":"error","code":"%s"}' "$1" >"$work/report-error.json"
  for attempt in 1 2 3; do
    cp_post /v1/node-enrollment/report "$work/report-error.json" "$work/report-error.out" "$work/auth"
    case $http_code in
      200 | 204) return 0 ;;
      000 | 429 | 5??) ;;
      *) break ;;
    esac
    if ((attempt < 3)); then retry_wait "$attempt"; fi
  done
  log "AVISO: o plano de controle não recebeu o aviso de erro (HTTP $http_code)." >&2
}

# --- Host ------------------------------------------------------------------------------------------------------------

# O sistema, a arquitetura e o tamanho da VM. Fora dos sistemas aceitos, para antes de mexer em qualquer coisa.
read_host() {
  local mem_kb disk_bytes
  os_id=$(sed -n 's/^ID=//p' "$os_release" 2>/dev/null | tr -d '"' | head -n 1) || os_id=''
  os_version=$(sed -n 's/^VERSION_ID=//p' "$os_release" 2>/dev/null | tr -d '"' | head -n 1) || os_version=''
  os_codename=$(sed -n 's/^VERSION_CODENAME=//p' "$os_release" 2>/dev/null | tr -d '"' | head -n 1) || os_codename=''
  case $os_id-$os_version in
    debian-12 | ubuntu-22.04 | ubuntu-24.04) ;;
    *) fail host_unsupported_os 'sistema não suportado: use Debian 12 ou Ubuntu 22.04 ou 24.04.' ;;
  esac
  [[ $os_codename =~ ^[a-z]{3,20}$ ]] || fail host_unsupported_os 'o /etc/os-release não traz o VERSION_CODENAME.'
  [[ $(uname -m) == x86_64 ]] || fail host_unsupported_arch 'arquitetura não suportada: use x86_64 (amd64).'
  host_cpus=$(nproc)
  mem_kb=$(awk '/^MemTotal:/ { print $2; exit }' "$meminfo")
  # O disco que guarda o Docker e os dados do nó (/var/lib).
  disk_bytes=$(df -B1 --output=size "${lib_dir%/*}" | awk 'NR == 2 { print $1 }')
  [[ $host_cpus =~ ^[0-9]{1,4}$ && $mem_kb =~ ^[0-9]{1,12}$ && $disk_bytes =~ ^[0-9]{1,16}$ ]] ||
    fail host_unknown 'não foi possível ler o tamanho da VM (CPU, memória ou disco).'
  host_memory_mb=$((mem_kb / 1024))
  host_disk_gb=$((disk_bytes / 1073741824))
}

# A VM cabe no porte? <porte> é P, M ou G.
fits() { # <porte>
  ((host_cpus >= ${min_cpus[$1]} && host_memory_mb >= ${min_memory_mb[$1]} && host_disk_gb >= ${min_disk_gb[$1]}))
}
size_message() { # <porte>
  printf 'o porte %s pede %s vCPU, %s MiB de memória e %s GiB de disco em /var/lib; esta VM tem %s vCPU, %s MiB e %s GiB.' \
    "$1" "${min_cpus[$1]}" "${min_memory_mb[$1]}" "${min_disk_gb[$1]}" "$host_cpus" "$host_memory_mb" "$host_disk_gb"
}

# Pacotes do sistema (o jq lê o manifesto e o registro), pelo apt, com espera pela trava e 5 tentativas.
apt_install() { # <pacote...>
  local attempt
  for attempt in 1 2 3 4 5; do
    if apt-get -o DPkg::Lock::Timeout=300 update -qq &&
      DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y -qq "$@" >/dev/null; then
      return 0
    fi
    if ((attempt < 5)); then sleep $((retry_pause * 4)); fi
  done
  return 1
}
ensure_tools() {
  local missing=()
  command -v jq >/dev/null || missing+=(jq)
  command -v openssl >/dev/null || missing+=(openssl)
  if ((${#missing[@]} > 0)); then
    log "Instalando ${missing[*]}."
    apt_install ca-certificates "${missing[@]}" || fail dependencies_failed 'o apt não instalou o jq ou o openssl.'
  fi
}

# O Docker Engine pelo repositório oficial da Docker, com a chave conferida pela impressão digital publicada: o mesmo
# jeito do install.sh do nó da GCP, com o repositório da distribuição desta VM (debian ou ubuntu; a chave é a mesma).
ensure_docker() {
  local key=9DC858229FC7DD38854AE2D88D81803C0EBFCD88 got
  if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then return 0; fi
  log 'Instalando o Docker Engine (repositório oficial, chave conferida).'
  if ! command -v gpg >/dev/null; then
    apt_install ca-certificates gnupg || fail dependencies_failed 'o apt não instalou o gnupg.'
  fi
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL --proto '=https' --retry 5 --retry-all-errors "https://download.docker.com/linux/$os_id/gpg" \
    -o "$work/docker.asc" || fail docker_install_failed 'a chave do repositório da Docker não baixou.'
  got=$(gpg --show-keys --with-colons "$work/docker.asc" | awk -F: '/^fpr:/ { print $10; exit }')
  [[ $got == "$key" ]] || fail docker_install_failed "chave do repositório da Docker inesperada: $got"
  gpg --dearmor <"$work/docker.asc" >/etc/apt/keyrings/docker.gpg
  chmod 0644 /etc/apt/keyrings/docker.gpg
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$os_id $os_codename stable" \
    >/etc/apt/sources.list.d/docker.list
  chmod 0644 /etc/apt/sources.list.d/docker.list
  apt_install docker-ce docker-ce-cli containerd.io docker-compose-plugin ||
    fail docker_install_failed 'o apt não instalou o Docker (um docker.io do sistema instalado antes conflita: remova-o).'
  systemctl enable --now docker >/dev/null
}

# O indexer do Wazuh (OpenSearch) exige vm.max_map_count de 262144; o swap só em último caso (o script de boot do nó da
# GCP faz o mesmo).
tune_kernel() {
  install -d -m 0755 "$sysctl_dir"
  printf 'vm.max_map_count = 262144\nvm.swappiness = 1\n' >"$sysctl_dir/90-verax.conf"
  chmod 0644 "$sysctl_dir/90-verax.conf"
  sysctl --quiet --load="$sysctl_dir/90-verax.conf"
}

# --- Release ---------------------------------------------------------------------------------------------------------

# O verificador e as chaves embutidos, numa pasta só desta execução.
write_trust() {
  local name data
  install -d -m 0700 "$work/trust" "$work/trust/bin" "$work/trust/keys"
  embedded_verifier >"$work/trust/bin/verify-release.sh"
  while read -r name data; do
    [[ -n $name ]] || continue
    if [[ ! $name =~ ^release-[A-Za-z0-9._-]+\.pem$ || ! $data =~ ^[A-Za-z0-9+/]+=*$ ]]; then
      fail installer_invalid 'chave de release fora do formato no instalador.'
    fi
    base64 -d <<<"$data" >"$work/trust/keys/$name"
  done < <(embedded_keys)
  if [[ ! -s $work/trust/bin/verify-release.sh ]] || ! compgen -G "$work/trust/keys/release-*.pem" >/dev/null; then
    fail installer_invalid 'o instalador não traz o verificador ou as chaves de release.'
  fi
}

# Baixa um arquivo do release só por HTTPS, inclusive nos redirecionamentos, com teto de tamanho.
download() { # <url> <arquivo> <máximo em bytes>
  curl -fsSL --proto "$download_proto" --proto-redir "$download_proto" --connect-timeout 20 --max-time 900 \
    --retry 5 --retry-delay "$retry_pause" --retry-all-errors --max-filesize "$3" -o "$2" "$1" 2>"$work/curl.err"
}

manifest_field() { # <caminho do jq>
  jq -er "$1 | select($jq_visible)" "$manifest_file" 2>/dev/null || echo ''
}

# As imagens de terceiros dos compose do pacote (a leitura do boot-install.sh e do node-release.sh).
compose_third_party() { # <pasta do pacote>
  local ref
  # shellcheck disable=SC2016 # os padrões são o texto literal do compose
  sed -nE 's/^[[:space:]]*image:[[:space:]]*//p' "$1"/compose*.yaml |
    sed -E 's/[[:space:]]+#.*$//; s/^["'\'']//; s/["'\'']?[[:space:]]*$//' |
    while IFS= read -r ref; do
      case $ref in
        '${API_IMAGE:?}' | '${MIGRATE_IMAGE:?}') ;;
        *) printf '%s\n' "$ref" ;;
      esac
    done | sort -u
}

# Baixa o release deste instalador, confere tudo e deixa o pacote pronto em $package_dir. Preenche rel_commit,
# rel_api_digest, rel_migrate_digest e images_repository.
fetch_release() {
  local dir=$work/release base=$release_base/$installer_release status=0 api_ref migrate_ref package sha self
  install -d -m 0700 "$dir" "$work/package"
  log "Baixando o manifesto de $installer_release."
  if ! download "$base/manifest.json" "$dir/manifest.json" 65536 ||
    ! download "$base/manifest.json.sig" "$dir/manifest.json.sig" 1024; then
    fail release_download_failed "o manifesto ou a assinatura não baixaram: $(head -c 300 "$work/curl.err")"
  fi
  # A assinatura antes de qualquer leitura do manifesto, com o verificador e as chaves embutidos.
  bash "$work/trust/bin/verify-release.sh" "$dir/manifest.json" "$dir/manifest.json.sig" "$work/trust/keys" \
    >"$work/verify.out" 2>&1 || status=$?
  case $status in
    0) log "Assinatura do manifesto conferida ($(head -c 200 "$work/verify.out"))." ;;
    1) fail release_signature_invalid 'a assinatura do manifesto não fecha com as chaves de release do instalador.' ;;
    *) fail release_verifier_failed "o verificador do manifesto falhou: $(head -c 300 "$work/verify.out")" ;;
  esac

  manifest_file=$dir/manifest.json
  jq -e ".schema == 1 and .kind == \"verax-node-release\"
    and (.thirdPartyImages | type == \"array\" and length > 0 and all(.[]; $jq_visible))" \
    "$manifest_file" >/dev/null 2>&1 || fail release_manifest_invalid 'o manifesto está fora do formato.'
  [[ $(manifest_field .release) == "$installer_release" ]] ||
    fail release_manifest_invalid "o manifesto baixado não é o de $installer_release."
  # Este arquivo é o instalador que o manifesto assinado descreve.
  self=${BASH_SOURCE[0]}
  sha=$(sha256sum "$self" 2>/dev/null | cut -d' ' -f1) || sha=''
  [[ $(manifest_field .installer.name) == verax-install.sh && $(manifest_field .installer.sha256) == "$sha" ]] ||
    fail installer_sha256_mismatch 'este instalador não tem o SHA-256 do manifesto assinado: baixe-o de novo do release.'
  rel_commit=$(manifest_field .version)
  [[ $rel_commit =~ $re_commit ]] || fail release_manifest_invalid 'o manifesto não traz o commit.'
  [[ $(manifest_field .package.url) == "$base/verax-node.tar.gz" ]] ||
    fail release_manifest_invalid 'o pacote do manifesto não é o deste release.'
  sha=$(manifest_field .package.sha256)
  [[ $sha =~ $re_sha ]] || fail release_manifest_invalid 'o manifesto não traz o SHA-256 do pacote.'
  api_ref=$(manifest_field .images.api)
  migrate_ref=$(manifest_field .images.migrate)
  [[ $api_ref =~ ^(ghcr\.io/[a-z0-9-]{1,39}/[a-z0-9._-]{1,100})/api@(sha256:[0-9a-f]{64})$ ]] ||
    fail release_manifest_invalid 'a imagem da API no manifesto não está fixada pelo digest.'
  images_repository=${BASH_REMATCH[1]}
  rel_api_digest=${BASH_REMATCH[2]}
  [[ $migrate_ref == "$images_repository/migrate@"* && $migrate_ref =~ @(sha256:[0-9a-f]{64})$ ]] ||
    fail release_manifest_invalid 'a imagem das migrations no manifesto não está fixada pelo digest.'
  rel_migrate_digest=${BASH_REMATCH[1]}

  log "Baixando o pacote de $installer_release."
  package=$dir/verax-node.tar.gz
  download "$base/verax-node.tar.gz" "$package" 67108864 ||
    fail release_download_failed "o pacote não baixou: $(head -c 300 "$work/curl.err")"
  [[ $(sha256sum "$package" | cut -d' ' -f1) == "$sha" ]] ||
    fail package_sha256_mismatch 'o pacote baixado não tem o SHA-256 do manifesto assinado.'
  # Conferido o hash, o conteúdo é o do release. Ainda assim, só nomes dentro de verax-node/.
  tar -tzf "$package" >"$work/package.list" 2>/dev/null || fail package_invalid 'o pacote não abre.'
  if grep -qvE '^verax-node(/[A-Za-z0-9._-]+)*/?$' "$work/package.list" ||
    grep -qE '(^|/)\.\.?(/|$)' "$work/package.list"; then
    fail package_invalid 'o pacote tem caminho fora de verax-node/.'
  fi
  tar -xzf "$package" -C "$work/package" --no-same-owner || fail package_invalid 'o pacote não abre.'
  package_dir=$work/package/verax-node
  [[ -f $package_dir/bin/install.sh ]] || fail package_invalid 'o pacote não tem o install.sh.'
  # Toda imagem de terceiro dos compose é uma do manifesto, pelo digest, e vice-versa.
  compose_third_party "$package_dir" >"$work/compose-images" || fail package_invalid 'os compose do pacote não abrem.'
  jq -r '.thirdPartyImages[]' "$manifest_file" | sort -u >"$work/manifest-images"
  if grep -qvE "$re_third_party" "$work/compose-images" || ! cmp -s "$work/compose-images" "$work/manifest-images"; then
    fail package_invalid 'as imagens de terceiros dos compose não são as do manifesto, todas pelo digest.'
  fi
}

# --- Registro --------------------------------------------------------------------------------------------------------

# Um campo de texto (ou número inteiro) da resposta do registro, só ASCII visível; vazio se faltar ou estiver fora.
claim_field() { # <caminho do jq>
  jq -er "$1 | if type == \"number\" and . == floor then tostring else . end | select($jq_visible)" \
    "$work/claim.json" 2>/dev/null || echo ''
}

# Grava um arquivo do cofre local (0600) de uma vez. O valor já foi conferido; o printf é interno do bash (o valor não
# vai para argumento de comando).
write_vault() { # <nome> <valor>
  install -d -m 0700 "$vault_dir"
  printf '%s' "$2" >"$vault_dir/.$1.tmp"
  chmod 0600 "$vault_dir/.$1.tmp"
  mv -f "$vault_dir/.$1.tmp" "$vault_dir/$1"
}

# Um texto livre da resposta (o nome do cliente, a senha da caixa de envio) direto do jq para o arquivo, de uma vez.
write_from_claim() { # <caminho do jq> <arquivo>
  jq -j "$1" "$work/claim.json" >"$2.tmp"
  chmod 0600 "$2.tmp"
  mv -f "$2.tmp" "$2"
}

# Troca o código pelo registro. 404 (código desconhecido, vencido ou usado) e 409 (o contrato pede outra versão; o
# código continua valendo) param sem aviso: ainda não há chave do nó. A rede fora do ar, o limite por IP (com o
# Retry-After) e o 5xx tentam de novo, até 5 vezes.
claim() {
  local attempt
  printf '{"code":"%s","release":"%s","host":{"cpus":%d,"memoryMb":%d,"diskGb":%d,"os":"%s","arch":"x86_64"}}' \
    "$enrollment_code" "$installer_release" "$host_cpus" "$host_memory_mb" "$host_disk_gb" "$os_id-$os_version" \
    >"$work/claim-body.json"
  enrollment_code=''
  log 'Registrando o nó no plano de controle.'
  for attempt in 1 2 3 4 5; do
    cp_post /v1/node-enrollment/claim "$work/claim-body.json" "$work/claim.json"
    case $http_code in
      200) break ;;
      404)
        rm -f "$work/claim-body.json"
        fail claim_rejected 'o código não vale (já usado, vencido ou trocado por um novo): gere outro código no console e rode o comando novo.'
        ;;
      409)
        rm -f "$work/claim-body.json"
        fail release_mismatch "o contrato pede outra versão que não a $installer_release deste instalador: copie o comando do console de novo (o código continua valendo)."
        ;;
      000 | 429 | 5??) ;;
      *) break ;;
    esac
    if ((attempt < 5)); then retry_wait "$attempt"; fi
  done
  rm -f "$work/claim-body.json"
  [[ $http_code == 200 ]] || fail claim_failed "o plano de controle não registrou o nó (HTTP $http_code)."
  jq -e 'type == "object"' "$work/claim.json" >/dev/null 2>&1 || fail claim_failed 'a resposta do registro não é JSON.'
  # A chave do nó primeiro: com ela, toda falha daqui em diante vai para o plano de controle.
  node_key=$(claim_field .nodeKey)
  if [[ ! $node_key =~ $re_secret_token ]]; then
    node_key=''
    fail claim_invalid 'a resposta do registro não traz a chave do nó.'
  fi
  report_errors=true
  write_vault node-key "$node_key"
}

# Confere a resposta do registro inteira e grava o cofre, as entradas do primeiro acesso e o node.conf (em <arquivo>).
apply_claim() { # <arquivo do node.conf>
  local tenant_id slug api_origin web_origin release size tunnel_token admin_email support_email
  local mail_from smtp_host smtp_port smtp_user smtp_password=false name value line plan=''
  local -A conf=()
  tenant_id=$(claim_field .tenantId)
  slug=$(claim_field .slug)
  api_origin=$(claim_field .apiOrigin)
  web_origin=$(claim_field .webOrigin)
  release=$(claim_field .release)
  size=$(claim_field .size)
  tunnel_token=$(claim_field .tunnelToken)
  admin_email=$(claim_field .adminEmail)
  support_email=$(claim_field .supportEmail)
  [[ $tenant_id =~ $re_tenant_id ]] || fail claim_invalid 'tenantId fora do formato.'
  [[ $slug =~ $re_slug && ${slug:2:2} != '--' ]] || fail claim_invalid 'slug fora do formato.'
  if [[ ! $api_origin =~ $re_origin || ! $web_origin =~ $re_origin || $api_origin == "$web_origin" ]] ||
    ((${#api_origin} > 261 || ${#web_origin} > 261)); then
    fail claim_invalid 'apiOrigin ou webOrigin fora do formato.'
  fi
  [[ $release == "$installer_release" ]] ||
    fail release_mismatch "o contrato pede a versão ${release:-?}, e este instalador é a $installer_release: use o comando do console."
  [[ $size =~ ^[PMG]$ ]] || fail claim_invalid 'size fora do formato.'
  fits "$size" || fail host_below_size "$(size_message "$size")"
  [[ $tunnel_token =~ $re_tunnel_token ]] || fail claim_invalid 'tunnelToken fora do formato.'
  for value in "$admin_email" "$support_email"; do
    if [[ ! $value =~ $re_mail || $value == .* || $value == *..* ]] || ((${#value} > 254)); then
      fail claim_invalid 'adminEmail ou supportEmail fora do formato.'
    fi
  done
  [[ ${admin_email,,} != "${support_email,,}" ]] || fail claim_invalid 'adminEmail e supportEmail são iguais.'
  # O nome do cliente: texto livre (com acento), de 1 a 120 caracteres e até 254 bytes, sem caractere de controle.
  jq -e '.tenantName | type == "string" and length >= 1 and length <= 120 and utf8bytelength <= 254
    and all(explode[]; . >= 32 and . != 127)' "$work/claim.json" >/dev/null 2>&1 ||
    fail claim_invalid 'tenantName fora do formato.'

  # O e-mail do nó: o remetente sempre; o servidor, a porta, o usuário e a senha, os quatro ou nenhum. Sem o e-mail do
  # nó, o plano de controle manda `mail: null`: MAIL_TRANSPORT=none, e o remetente (que o nó exige, mas não usa sem
  # SMTP) é um endereço do host do painel.
  if jq -e '.mail == null' "$work/claim.json" >/dev/null 2>&1; then
    mail_from=nao-responda@${web_origin#https://}
  else
    jq -e '.mail | type == "object"' "$work/claim.json" >/dev/null 2>&1 || fail claim_invalid 'mail fora do formato.'
    mail_from=$(claim_field .mail.from)
  fi
  smtp_host=$(claim_field .mail.host)
  smtp_port=$(claim_field .mail.port)
  smtp_user=$(claim_field .mail.user)
  if [[ ! $mail_from =~ $re_mail || $mail_from == .* || $mail_from == *..* ]] || ((${#mail_from} > 254)); then
    fail claim_invalid 'mail.from fora do formato.'
  fi
  if jq -e '.mail.password | type == "string" and length > 0' "$work/claim.json" >/dev/null 2>&1; then
    smtp_password=true
  fi
  if [[ -n $smtp_host || -n $smtp_port || -n $smtp_user ]] || $smtp_password; then
    if ! $smtp_password || [[ ! $smtp_host =~ $re_smtp_host || ! $smtp_port =~ $re_smtp_port ]] ||
      [[ ! $smtp_user =~ $re_smtp_user ]] || ((${#smtp_host} > 253 || 10#$smtp_port > 65535)); then
      fail claim_invalid 'mail.host, mail.port, mail.user e mail.password vão juntos e no formato.'
    fi
    # A senha vai para um arquivo de ambiente entre aspas simples (o write_env do start.sh): ASCII visível, sem aspa.
    jq -e '.mail.password | length <= 256 and all(explode[]; . >= 32 and . < 127 and . != 39)' "$work/claim.json" \
      >/dev/null 2>&1 || fail claim_invalid 'mail.password fora do formato.'
  fi

  # O plano (nodeLimitsEnv do plano de controle): só os nomes conhecidos, cada um uma vez e no formato. Os agentes do
  # Wazuh pedem portas de entrada, que a VM própria não abre: ficam desligados.
  jq -e '.nodeConf | type == "array" and length <= 16
    and all(.[]; type == "object" and (.name | type == "string") and (.value | type == "string"))' \
    "$work/claim.json" >/dev/null 2>&1 || fail claim_invalid 'nodeConf fora do formato.'
  jq -r '.nodeConf[] | [.name, .value] | @tsv' "$work/claim.json" >"$work/node-conf.tsv"
  while IFS=$'\t' read -r name value; do
    case $name in
      PLAN) [[ $value =~ ^(essencial|profissional|enterprise)$ ]] || fail claim_invalid 'PLAN fora do formato.' ;;
      PLAN_MAX_CLOUD_ACCOUNTS | PLAN_MAX_USERS | PLAN_MONTHLY_GIB | PLAN_HISTORY_DAYS | WAZUH_AGENTS_MAX)
        [[ $value =~ $re_limit ]] || fail claim_invalid "$name fora do formato."
        ;;
      WAZUH_AGENTS)
        [[ $value =~ ^(true|false)$ ]] || fail claim_invalid 'WAZUH_AGENTS fora do formato.'
        if [[ $value == true ]]; then
          log 'AVISO: o contrato tem agentes do Wazuh, que pedem portas de entrada: na VM própria, ficam desligados.' >&2
        fi
        ;;
      *) fail claim_invalid 'nodeConf com um nome desconhecido.' ;;
    esac
    [[ -z ${conf[$name]+x} ]] || fail claim_invalid "nodeConf repete $name."
    conf[$name]=$value
  done <"$work/node-conf.tsv"
  plan=${conf[PLAN]:-}
  [[ -n $plan ]] || fail claim_invalid 'nodeConf sem o PLAN.'
  if [[ $plan == enterprise ]]; then
    for name in PLAN_MAX_CLOUD_ACCOUNTS PLAN_MAX_USERS PLAN_MONTHLY_GIB PLAN_HISTORY_DAYS; do
      [[ -n ${conf[$name]:-} ]] || fail claim_invalid "o plano enterprise precisa de $name."
    done
  fi

  # Conferido tudo, os arquivos. O cofre: o token do túnel e, com o e-mail ligado, a senha da caixa de envio.
  write_vault cloudflare-tunnel-token "$tunnel_token"
  if $smtp_password; then
    install -d -m 0700 "$vault_dir"
    write_from_claim .mail.password "$vault_dir/smtp-password"
  else
    rm -f "$vault_dir/smtp-password"
  fi
  # As entradas do primeiro acesso (o start.sh as lê como lia dos metadados da VM, com os mesmos nomes).
  install -d -m 0700 "$customer_inputs"
  write_from_claim .tenantName "$customer_inputs/verax-tenant-name"
  printf '%s' "$admin_email" >"$customer_inputs/verax-admin-email"
  printf '%s' "$support_email" >"$customer_inputs/verax-support-email"

  local lines=(
    NODE_PLATFORM=vm
    "IMAGES_REPOSITORY=$images_repository"
    "WEB_ORIGIN=$web_origin"
    "API_ORIGIN=$api_origin"
  )
  if $smtp_password; then
    lines+=(MAIL_TRANSPORT=smtp "MAIL_FROM=$mail_from" "SMTP_HOST=$smtp_host" "SMTP_PORT=$smtp_port"
      "SMTP_USER=$smtp_user")
  else
    lines+=(MAIL_TRANSPORT=none "MAIL_FROM=$mail_from")
  fi
  lines+=("SYNC_SOURCES=wazuh,cloudflare" "PLAN=$plan")
  for name in PLAN_MAX_CLOUD_ACCOUNTS PLAN_MAX_USERS PLAN_MONTHLY_GIB PLAN_HISTORY_DAYS; do
    if [[ -n ${conf[$name]:-} ]]; then lines+=("$name=${conf[$name]}"); fi
  done
  lines+=(NODE_PROFILE=standard CREDENTIALS_VAULT=true WAZUH_AGENTS=false CUSTOMER_MODE=true)
  {
    echo "# Escrito pelo verax-install.sh a partir do registro do nó (cliente $slug, porte $size), na versão $installer_release."
    echo '# Os segredos ficam no cofre local (/etc/verax/vault). Atualizar: sudo bash verax-install.sh --atualizar'
  } >"$1"
  for line in "${lines[@]}"; do
    [[ $line =~ $re_conf_line ]] || fail claim_invalid "uma linha do node.conf saiu fora do formato (${line%%=*})."
    printf '%s\n' "$line" >>"$1"
  done
  log "Registro aceito: cliente $slug, porte $size."
}

# --- Nó --------------------------------------------------------------------------------------------------------------

unit_state() { systemctl show -p ActiveState --value "$1" 2>/dev/null || echo unknown; }

# Espera um serviço do nó ficar ativo (o install.sh já o pôs para subir). `failed` é o fim.
wait_unit() { # <unidade> <prazo em segundos>
  local deadline=$((SECONDS + $2)) state
  while :; do
    state=$(unit_state "$1")
    case $state in
      active) return 0 ;;
      failed) return 1 ;;
    esac
    if ((SECONDS >= deadline)); then return 1; fi
    sleep "$poll_pause"
  done
}

# O túnel conectado: o cloudflared diz "Registered tunnel connection" quando a primeira conexão com o Cloudflare fecha.
wait_tunnel() {
  local deadline=$((SECONDS + tunnel_timeout))
  while :; do
    if grep -q 'Registered tunnel connection' < <(docker compose --project-directory "$opt_dir" \
      -f "$opt_dir/compose.yaml" --env-file "$etc_dir/images.env" logs --no-color cloudflared 2>/dev/null); then
      return 0
    fi
    if ((SECONDS >= deadline)); then return 1; fi
    sleep "$poll_pause"
  done
}

# O install.sh do pacote conferido, com os digests do manifesto. [--config <arquivo>] só na instalação.
run_install() { # [argumentos extras do install.sh]
  log "Instalando $installer_release (commit $rel_commit)."
  if ! DEBIAN_FRONTEND=noninteractive bash "$package_dir/bin/install.sh" --version "$rel_commit" \
    --api-digest "$rel_api_digest" --migrate-digest "$rel_migrate_digest" --release "$installer_release" "$@"; then
    if [[ $(unit_state verax-node.service) == failed ]]; then fail node_start_failed 'o verax-node não subiu.'; fi
    if [[ $(unit_state verax-wazuh.service) == failed ]]; then fail wazuh_start_failed 'o verax-wazuh não subiu.'; fi
    fail install_failed 'o install.sh falhou (o motivo está logo acima).'
  fi
}

wait_node() {
  log 'Esperando o nó, o Wazuh, o primeiro acesso e o túnel.'
  wait_unit verax-node.service "$node_timeout" || fail node_start_failed 'o verax-node não subiu.'
  wait_unit verax-wazuh.service "$wazuh_timeout" || fail wazuh_start_failed 'o verax-wazuh não subiu.'
  wait_unit verax-customer-bootstrap.service "$customer_timeout" ||
    fail customer_bootstrap_failed 'o primeiro acesso (verax-customer-bootstrap) falhou.'
  wait_tunnel || fail tunnel_unreachable 'o túnel do Cloudflare não conectou (a VM alcança o Cloudflare nas portas 443 e 7844?).'
}

# O fim do registro (só com o marcador `pending`): a senha temporária do administrador vai ao plano de controle, e a
# cópia local sai. Sem o arquivo da senha (uma reinstalação: a conta já existia, e o primeiro acesso não gera senha sem
# pedido), pede uma senha nova.
finish_enrollment() {
  local file=$enrollment/admin-bootstrap.json attempt
  [[ -f $enrollment/pending ]] || return 0
  if [[ ! -e $file ]]; then
    log 'Gerando a senha temporária do administrador.'
    BOOTSTRAP_RENEW_ADMIN_PASSWORD=true "$opt_dir/bin/start.sh" customer-bootstrap >"$work/renew.out" 2>&1 ||
      fail customer_bootstrap_failed "o primeiro acesso não gerou a senha: $(tail -c 300 "$work/renew.out")"
  fi
  [[ -f $file && ! -L $file ]] || fail admin_password_missing 'a senha temporária do administrador não foi gerada.'
  # O arquivo que o primeiro acesso grava (o contrato do cofre `admin-bootstrap`, o JSON que o nó da GCP grava no Secret
  # Manager). Ao plano de controle vai só a senha: ele monta o JSON do cofre (o e-mail e o prazo são dele).
  jq -e 'type == "object" and (keys == ["email", "expiresAt", "password"])
    and (.password | type == "string" and length >= 16 and length <= 256)' "$file" >/dev/null 2>&1 ||
    fail admin_password_missing 'o arquivo da senha temporária está fora do formato.'
  [[ -n $node_key ]] || fail report_failed 'a chave do nó não está no cofre local: gere um código novo no console.'
  # A senha vai do arquivo para o corpo pelo jq: nunca por argumento de comando.
  jq --arg version "$installer_release" '{status: "ready", version: $version, adminBootstrapPassword: .password}' \
    "$file" >"$work/report-ready.json"
  auth_header
  for attempt in 1 2 3 4 5; do
    cp_post /v1/node-enrollment/report "$work/report-ready.json" "$work/report-ready.out" "$work/auth"
    case $http_code in
      200 | 204) break ;;
      000 | 429 | 5??) ;;
      *) break ;;
    esac
    if ((attempt < 5)); then retry_wait "$attempt"; fi
  done
  rm -f "$work/report-ready.json"
  if [[ $http_code != 200 && $http_code != 204 ]]; then
    # O nó está no ar: nada de aviso de erro. A senha fica no arquivo (só root) para a próxima tentativa.
    report_errors=false
    if [[ $http_code == 401 ]]; then
      log 'ERRO (report_failed): o plano de controle não reconhece a chave deste nó (um código novo foi gerado no' \
        'console depois desta instalação): rode o comando novo do console.' >&2
    else
      log "ERRO (report_failed): o plano de controle não recebeu o aviso de pronto (HTTP $http_code). Rode de novo:" \
        'sudo bash verax-install.sh --atualizar' >&2
    fi
    exit 1
  fi
  shred -u "$file" 2>/dev/null || rm -f "$file"
  rm -f "$enrollment/pending"
  printf '%s\n' "$installer_release" >"$enrollment/ready"
  log 'Senha temporária entregue ao plano de controle e apagada desta VM.'
}

# -1, 0 ou 1: a ordem de duas versões node-vX.Y.Z (a do update.sh).
compare_releases() { # <a> <b>
  local a=${1#node-v} b=${2#node-v} i x y
  IFS=. read -r -a x <<<"$a"
  IFS=. read -r -a y <<<"$b"
  for i in 0 1 2; do
    if ((10#${x[i]} < 10#${y[i]})); then echo -1; return; fi
    if ((10#${x[i]} > 10#${y[i]})); then echo 1; return; fi
  done
  echo 0
}

# Uma linha `CHAVE=valor` de um arquivo, sem `source`.
conf_value() { # <arquivo> <chave>
  { sed -n "s/^$2=//p" "$1" 2>/dev/null || true; } | tail -n 1 | tr -d '\r'
}

# A chave do nó do cofre local (para concluir um registro pendente na atualização).
read_node_key() {
  local value=''
  if [[ -f $vault_dir/node-key ]]; then value=$(<"$vault_dir/node-key"); fi
  if [[ $value =~ $re_secret_token ]]; then node_key=$value; fi
}

install_node() {
  local conf=$work/node.conf
  if [[ -f $etc_dir/node.conf && $(conf_value "$etc_dir/node.conf" NODE_PLATFORM) != vm ]]; then
    fail not_vm_install "esta máquina já tem um nó do Verax Control que não é de VM própria ($etc_dir/node.conf)."
  fi
  read_host
  fits P || fail host_too_small "$(size_message P)"
  ensure_tools
  ensure_docker
  tune_kernel
  write_trust
  fetch_release
  claim
  apply_claim "$conf"
  # Um registro novo pede uma senha nova: a de uma tentativa anterior não vale mais.
  install -d -m 0700 "$enrollment"
  rm -f "$enrollment/admin-bootstrap.json" "$enrollment/ready"
  printf '%s\n' "$installer_release" >"$enrollment/pending"
  run_install --config "$conf"
  wait_node
  finish_enrollment
  log "Pronto: o Verax Control está no ar nesta VM ($installer_release). O administrador recebe o acesso por e-mail."
}

update_node() {
  local installed order
  [[ -f $etc_dir/node.conf && $(conf_value "$etc_dir/node.conf" NODE_PLATFORM) == vm ]] ||
    fail not_vm_install 'esta VM não tem uma instalação do Verax Control feita por este instalador: use --codigo.'
  installed=$(conf_value "$etc_dir/images.env" NODE_RELEASE)
  [[ $installed =~ $re_release ]] || fail install_state_invalid "o $etc_dir/images.env não traz a versão instalada."
  read_node_key
  order=$(compare_releases "$installer_release" "$installed")
  if ((order < 0)); then
    fail downgrade_refused "a VM está em $installed, mais nova que este instalador ($installer_release)."
  fi
  read_host
  ensure_tools
  if ((order > 0)); then
    write_trust
    fetch_release
    [[ $(conf_value "$etc_dir/node.conf" IMAGES_REPOSITORY) == "$images_repository" ]] ||
      fail install_state_invalid 'o IMAGES_REPOSITORY do node.conf não é o do manifesto.'
    log 'Backup do banco antes da atualização.'
    "$opt_dir/bin/backup.sh" >"$work/backup.out" 2>&1 ||
      fail backup_failed "o backup do banco falhou; nada foi mudado: $(tail -c 300 "$work/backup.out")"
    run_install
    wait_node
    log "Atualizado de $installed para $installer_release."
  else
    log "A VM já está em $installer_release."
  fi
  finish_enrollment
}

main() {
  local lock
  while (($#)); do
    case $1 in
      --codigo)
        (($# >= 2)) || usage
        [[ -z $mode ]] || usage
        mode=install
        enrollment_code=$2
        shift 2
        ;;
      --atualizar)
        [[ -z $mode ]] || usage
        mode=update
        shift
        ;;
      --plano-de-controle)
        (($# >= 2)) || usage
        control_plane=$2
        shift 2
        ;;
      *) usage ;;
    esac
  done
  [[ -n $mode ]] || usage
  if [[ $mode == install && ! $enrollment_code =~ $re_secret_token ]]; then
    echo 'O código tem 43 caracteres (letras, números, - e _): copie o comando do console de novo.' >&2
    exit 2
  fi
  # Só a origem, sem caminho. O protocolo é o do download_proto: HTTPS em produção.
  [[ $control_plane =~ ^https?://[a-z0-9.-]+(:[0-9]{1,5})?$ ]] || { echo 'Plano de controle inválido.' >&2; exit 2; }
  [[ $installer_release =~ $re_release ]] ||
    { echo 'Este instalador não veio de um release (falta a versão embutida): baixe-o do release do GitHub.' >&2; exit 2; }
  [[ $(id -u) == 0 ]] || { echo 'Rode como root: sudo bash verax-install.sh ...' >&2; exit 2; }

  # Uma execução por vez.
  exec {lock}>"$run_base/verax-install.lock"
  flock -n "$lock" || { echo 'Outro verax-install.sh está rodando nesta VM.' >&2; exit 1; }
  work=$(mktemp -d "$run_base/verax-install.XXXXXX")
  trap on_exit EXIT

  if [[ $mode == install ]]; then install_node; else update_node; fi
}

main "$@"
