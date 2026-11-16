#!/bin/bash
# Atualizador do nó (frota): aplica no próprio host a versão que o plano de controle pediu nos metadados da VM. Roda
# como root, fora dos contêineres, pelo verax-update.timer (a cada 5 min), igual em célula e em nó dedicado: sem SSH,
# sem porta de entrada, sem credencial nova. O plano de controle só escreve o pedido; quem decide se instala é o host,
# com as chaves que ele já tem.
#
# O pedido (metadados da instância, gravados pelo cp-worker com `instances.setMetadata`; o Terraform os ignora):
#   verax-node-release         a versão desejada (node-vX.Y.Z)
#   verax-node-release-sha256  o SHA-256 do pacote dessa versão (o do manifesto assinado, conferido de novo aqui)
#   verax-node-release-request o id do pedido (a rodada da frota e a tentativa): o mesmo pedido nunca roda duas vezes
#   verax-node-release-intent  upgrade (padrão) ou rollback: só com rollback uma versão mais antiga é aceita
#   verax-update-window        opcional, HH:MM-HH:MM no horário de Brasília: fora da janela, o pedido espera
#
# O que ele faz com um pedido novo, nesta ordem, e para no primeiro problema sem ter mexido no nó:
#  1. confere cada valor dos metadados (formato e tamanho) e recusa voltar de versão sem `rollback`;
#  2. baixa do release do GitHub o manifesto e a assinatura e confere a assinatura com o verificador e as chaves que o
#     host JÁ tem (/opt/verax/bin/verify-release.sh e /opt/verax/keys, copiados para a memória antes de tudo), nunca
#     com as do pacote novo; só então lê o manifesto (a versão, o commit, os digests e o SHA-256 do pacote, que tem de
#     ser o dos metadados);
#  3. baixa o pacote, confere o SHA-256, os caminhos e as imagens de terceiros dos compose (as do manifesto, pelo digest);
#  4. baixa as imagens pelo digest (o Verax do IMAGES_REPOSITORY do node.conf, terceiros da origem);
#  5. faz o backup do banco (o backup.sh de todo dia) e guarda o que está instalado (/opt/verax, o images.env e as
#     unidades do systemd do nó): é a versão anterior, para a volta;
#  6. roda o install.sh do pacote novo com os digests do manifesto e espera o nó ficar de pé (verax-node, o Wazuh no
#     standard e a API respondendo /health/ready);
#  7. se a instalação ou a conferência falham, volta o que guardou, reinicia o nó e confere de novo: `rolled_back`
#     (ou `rollback_failed`, se nem a anterior subir).
# O banco não volta: as migrations só andam para a frente e são aditivas, a regra do repositório para a volta de versão
# do nó (docs/runbooks/no-verax.md). O backup do passo 5 é o ponto de restauração manual.
#
# O andamento vai para os guest attributes do espaço verax/ (o plano de controle lê com getGuestAttributes, CP-10):
# update-state, update-release, update-request, update-from e update-error (só códigos e versões; nenhum valor dos
# metadados além deles). Um pedido por vez (flock) e nunca durante a instalação sem operador (a trava e o marcador
# `installing` do boot-install.sh). Nada que vem dos metadados ou do manifesto é interpretado pelo shell.
set -euo pipefail
umask 077
export LC_ALL=C
PATH=${PATH:+$PATH:}/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Onde o atualizador lê e escreve (o teste troca estas linhas pelos falsos dele).
metadata_url=http://metadata.google.internal/computeMetadata/v1
release_base=https://github.com/williandotdev/verax-control/releases/download
download_proto='=https'
etc_dir=/etc/verax
opt_dir=/opt/verax
units_dir=/etc/systemd/system
state_dir=/var/lib/verax/update
boot_state_dir=/var/lib/verax/boot
boot_lock=/run/verax-boot.lock
run_dir=/run/verax-update
lock_file=/run/lock/verax-update.lock
# Esperas, em segundos: entre tentativas de rede, entre gravações de guest attributes (até 3 por segundo e 10 por minuto
# por VM, somadas às do worker) e entre conferências do nó depois da instalação (60 vezes: 10 min).
retry_pause=5
attribute_pause=1
health_pause=10
health_tries=60
# O fuso da janela de manutenção.
window_tz=America/Sao_Paulo

re_release='^node-v(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$'
re_sha='^[0-9a-f]{64}$'
re_commit='^[0-9a-f]{40}$'
re_request='^[A-Za-z0-9][A-Za-z0-9-]{0,79}$'
re_intent='^(upgrade|rollback)$'
re_window='^([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$'
re_artifact_registry='^[a-z0-9-]+-docker\.pkg\.dev/[a-z][a-z0-9-]{4,28}[a-z0-9]/[a-z0-9-]{1,63}$'
re_ghcr='^ghcr\.io/[a-z0-9-]{1,39}/[a-z0-9._-]{1,100}$'
re_third_party='^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(/[a-z0-9]+([._-][a-z0-9]+)*)*(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[0-9a-f]{64}$'
re_code='^[a-z][a-z0-9_]{0,39}$'

work=''
manifest_file=''
# O pedido (metadados) e o que o manifesto conferido diz.
want_release='' want_sha='' want_request='' want_intent='' want_window=''
rel_commit='' rel_api_digest='' rel_migrate_digest=''
# A versão instalada antes deste pedido (o release, ou o commit de um nó instalado pelo deploy.sh).
from_version='' from_release='' from_commit=''
images_repository='' standard=false

log() { echo "verax-update: $*"; }

# Guest attribute `verax/<chave>`. Só versões, o id do pedido, o estado e o código de erro.
attribute() { # put <chave> <valor> | delete <chave>
  local method=PUT code args=(-sS --max-time 10 -o /dev/null -w '%{http_code}' -H 'Metadata-Flavor: Google')
  if [[ $1 == put ]]; then
    args+=(-X PUT --data-binary "$3")
  else
    method=DELETE
    args+=(-X DELETE)
  fi
  code=$(curl "${args[@]}" "$metadata_url/instance/guest-attributes/verax/$2" 2>/dev/null) || code=000
  sleep "$attribute_pause"
  if [[ $code == 200 || $code == 204 || ($method == DELETE && $code == 404) ]]; then return 0; fi
  log "AVISO: o guest attribute verax/$2 não foi gravado ($method, HTTP $code)." >&2
  return 1
}

# O estado deste pedido: no arquivo (sobrevive ao reboot) e no guest attribute. O erro só vai com os estados de falha.
status_line() { # <estado> [código]
  printf 'request=%s\nrelease=%s\nstate=%s\nerror=%s\nfrom=%s\n' "$want_request" "$want_release" "$1" "${2:-}" \
    "$from_version" >"$state_dir/status.tmp"
  mv -f "$state_dir/status.tmp" "$state_dir/status"
}
report() { # <estado> [código]
  status_line "$@"
  attribute put update-state "$1" || true
  if [[ -n ${2:-} ]]; then attribute put update-error "$2" || true; fi
  printf '%s %s\n' "$want_request" "$1" >"$run_dir/reported"
}

# O começo de um pedido: o estado antes do id, para o plano de controle nunca ver o id novo com o estado do anterior.
report_accepted() {
  status_line accepted
  attribute put update-state accepted || true
  attribute delete update-error || true
  attribute put update-release "$want_release" || true
  attribute put update-from "${from_version:-none}" || true
  attribute put update-request "$want_request" || true
  printf '%s accepted\n' "$want_request" >"$run_dir/reported"
}

# O que já foi gravado nos guest attributes neste boot (o arquivo é do tmpfs: depois de um reboot, grava de novo).
reported() { cat "$run_dir/reported" 2>/dev/null || true; }
ensure_accepted() {
  [[ $(reported) == "$want_request "* ]] || report_accepted
}
report_once() { # <estado>
  ensure_accepted
  [[ $(reported) == "$want_request $1" ]] || report "$1"
}

# Para o pedido sem ter mexido no nó.
fail() { # <código> <mensagem>
  log "ERRO ($1): $2" >&2
  ensure_accepted
  report failed "$1"
  exit 1
}

# Um valor dos metadados num arquivo da pasta de trabalho, nunca numa linha de comando. 3: a chave não existe (404).
metadata_get() { # <caminho> <arquivo>
  local code attempt
  for attempt in 1 2 3; do
    code=$(curl -sS --max-time 5 --max-filesize 4096 -o "$2" -w '%{http_code}' -H 'Metadata-Flavor: Google' \
      "$metadata_url/$1" 2>/dev/null) || code=000
    case $code in
      200) return 0 ;;
      404) return 3 ;;
    esac
    if ((attempt < 3)); then sleep "$retry_pause"; fi
  done
  return 1
}

# Lê um metadado do pedido e confere: só ASCII visível, até <máximo> bytes e casando com a expressão. Ausente: o valor
# padrão (vazio). Devolve 3 se a chave não existe e não há padrão; 4 se o valor está fora do formato; 1 sem resposta.
read_request_key() { # <variável> <chave> <expressão> <máximo> [padrão]
  local file=$work/metadata-$2 status=0 value
  metadata_get "instance/attributes/$2" "$file" || status=$?
  if ((status == 3)); then
    if (($# >= 5)); then
      printf -v "$1" '%s' "$5"
      return 0
    fi
    return 3
  fi
  ((status == 0)) || return 1
  if (($(tr -d '\040-\176' <"$file" | wc -c) > 0 || $(wc -c <"$file") > $4)); then return 4; fi
  value=$(<"$file")
  if [[ -z $value && $# -ge 5 ]]; then
    printf -v "$1" '%s' "$5"
    return 0
  fi
  [[ $value =~ $3 ]] || return 4
  printf -v "$1" '%s' "$value"
}

download() { # <url> <arquivo> <máximo em bytes>
  curl -fsSL --proto "$download_proto" --proto-redir "$download_proto" --connect-timeout 20 --max-time 900 \
    --retry 5 --retry-delay "$retry_pause" --retry-all-errors --max-filesize "$3" -o "$2" "$1" 2>"$work/curl.err"
}

ensure_jq() {
  local attempt
  command -v jq >/dev/null && return 0
  for attempt in 1 2 3; do
    if apt-get -o DPkg::Lock::Timeout=300 update -qq &&
      DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y -qq jq >/dev/null; then
      return 0
    fi
    if ((attempt < 3)); then sleep $((retry_pause * 4)); fi
  done
  return 1
}

# Uma linha `CHAVE=valor` de um arquivo de configuração, sem `source` (nada do arquivo é executado aqui).
conf_value() { # <arquivo> <chave>
  { sed -n "s/^$2=//p" "$1" 2>/dev/null || true; } | tail -n 1 | tr -d '\r'
}

# A versão instalada, do images.env que o install.sh grava: o release (NODE_RELEASE) quando veio de um release; senão,
# só o commit (NODE_VERSION, o nó instalado pelo deploy.sh).
read_installed() {
  local file=$etc_dir/images.env
  [[ -f $file ]] || return 1
  from_commit=$(conf_value "$file" NODE_VERSION)
  from_release=$(conf_value "$file" NODE_RELEASE)
  [[ $from_commit =~ $re_commit ]] || return 1
  [[ $from_release =~ $re_release ]] || from_release=''
  from_version=${from_release:-$from_commit}
}

# -1, 0 ou 1: a ordem de duas versões node-vX.Y.Z.
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

# Dentro da janela de manutenção (horário de Brasília)? Sem janela, sempre. A janela pode passar da meia-noite.
in_window() {
  [[ -n $want_window ]] || return 0
  local now start end
  now=$(TZ=$window_tz date +%H%M)
  start=${want_window%-*}
  end=${want_window#*-}
  start=$((10#${start/:/}))
  end=$((10#${end/:/}))
  now=$((10#$now))
  if ((start <= end)); then
    ((now >= start && now < end))
  else
    ((now >= start || now < end))
  fi
}

# Texto não vazio só de ASCII visível (a mesma regra do boot-install.sh).
jq_visible='(type == "string" and length > 0 and all(explode[]; . >= 32 and . < 127))'
manifest_field() { # <caminho do jq>
  jq -er "$1 | select($jq_visible)" "$manifest_file" 2>/dev/null || echo ''
}

# As imagens de terceiros dos compose do pacote (a mesma leitura do boot-install.sh e do node-release.sh).
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

# Baixa e confere o release pedido; deixa o pacote em $work/package/verax-node.
fetch_release() {
  local dir=$work/release base=$release_base/$want_release status=0 api_ref migrate_ref package
  install -d -m 0700 "$dir" "$work/package"
  if ! download "$base/manifest.json" "$dir/manifest.json" 65536 ||
    ! download "$base/manifest.json.sig" "$dir/manifest.json.sig" 1024; then
    fail release_download_failed "o manifesto ou a assinatura de $want_release não baixaram: $(head -c 300 "$work/curl.err")"
  fi
  report verifying
  # A assinatura antes de qualquer leitura, com o verificador e as chaves do pacote JÁ instalado (a cópia da memória).
  bash "$run_dir/trust/bin/verify-release.sh" "$dir/manifest.json" "$dir/manifest.json.sig" "$run_dir/trust/keys" \
    >"$work/verify.out" 2>&1 || status=$?
  case $status in
    0) log "Assinatura do manifesto conferida ($(head -c 200 "$work/verify.out"))." ;;
    1) fail release_signature_invalid "a assinatura do manifesto de $want_release não fecha com as chaves instaladas." ;;
    *) fail release_verifier_failed "o verificador do manifesto falhou: $(head -c 300 "$work/verify.out")" ;;
  esac

  manifest_file=$dir/manifest.json
  jq -e ".schema == 1 and .kind == \"verax-node-release\"
    and (.thirdPartyImages | type == \"array\" and length > 0 and all(.[]; $jq_visible))" \
    "$manifest_file" >/dev/null 2>&1 || fail release_manifest_invalid "o manifesto de $want_release está fora do formato."
  [[ $(manifest_field .release) == "$want_release" ]] ||
    fail release_manifest_invalid "o manifesto baixado não é o de $want_release."
  rel_commit=$(manifest_field .version)
  [[ $rel_commit =~ $re_commit ]] || fail release_manifest_invalid "o manifesto de $want_release não traz o commit."
  [[ $(manifest_field .package.url) == "$base/verax-node.tar.gz" ]] ||
    fail release_manifest_invalid "o pacote do manifesto não é o do release $want_release."
  [[ $(manifest_field .package.sha256) == "$want_sha" ]] ||
    fail package_sha256_mismatch "o SHA-256 do pedido não é o do manifesto assinado de $want_release."
  api_ref=$(manifest_field .images.api)
  migrate_ref=$(manifest_field .images.migrate)
  [[ $api_ref =~ ^ghcr\.io/[a-z0-9-]{1,39}/[a-z0-9._-]{1,100}/api@(sha256:[0-9a-f]{64})$ ]] ||
    fail release_manifest_invalid "a imagem da API no manifesto não está fixada pelo digest."
  rel_api_digest=${BASH_REMATCH[1]}
  [[ $migrate_ref =~ ^ghcr\.io/[a-z0-9-]{1,39}/[a-z0-9._-]{1,100}/migrate@(sha256:[0-9a-f]{64})$ ]] ||
    fail release_manifest_invalid "a imagem das migrations no manifesto não está fixada pelo digest."
  rel_migrate_digest=${BASH_REMATCH[1]}
  # Do GHCR, só o repositório do próprio manifesto.
  if [[ $images_repository == ghcr.io/* && $api_ref != "$images_repository/api@"* ]]; then
    fail images_repository_mismatch "o IMAGES_REPOSITORY do nó aponta para outro repositório do GHCR que não o do manifesto."
  fi

  package=$dir/verax-node.tar.gz
  download "$base/verax-node.tar.gz" "$package" 67108864 ||
    fail release_download_failed "o pacote de $want_release não baixou: $(head -c 300 "$work/curl.err")"
  [[ $(sha256sum "$package" | cut -d' ' -f1) == "$want_sha" ]] ||
    fail package_sha256_mismatch "o pacote baixado não tem o SHA-256 do manifesto assinado de $want_release."
  tar -tzf "$package" >"$work/package.list" 2>/dev/null || fail package_invalid "o pacote de $want_release não abre."
  if grep -qvE '^verax-node(/[A-Za-z0-9._-]+)*/?$' "$work/package.list" ||
    grep -qE '(^|/)\.\.?(/|$)' "$work/package.list"; then
    fail package_invalid "o pacote de $want_release tem caminho fora de verax-node/."
  fi
  tar -xzf "$package" -C "$work/package" --no-same-owner || fail package_invalid "o pacote de $want_release não abre."
  [[ -f $work/package/verax-node/bin/install.sh ]] || fail package_invalid "o pacote de $want_release não tem o install.sh."
  compose_third_party "$work/package/verax-node" >"$work/compose-images" ||
    fail package_invalid "os compose do pacote não abrem."
  jq -r '.thirdPartyImages[]' "$manifest_file" | sort -u >"$work/manifest-images"
  if grep -qvE "$re_third_party" "$work/compose-images" ||
    ! cmp -s "$work/compose-images" "$work/manifest-images"; then
    fail package_invalid "as imagens de terceiros dos compose não são as do manifesto, todas pelo digest."
  fi
}

# As imagens antes de tocar no nó: um registro fora do ar para aqui, com o nó como estava.
pull_images() {
  local ref third
  mapfile -t third <"$work/manifest-images"
  for ref in "$images_repository/api@$rel_api_digest" "$images_repository/migrate@$rel_migrate_digest" "${third[@]}"; do
    docker pull --quiet "$ref" >/dev/null 2>"$work/pull.err" ||
      fail image_pull_failed "a imagem $ref não baixou: $(head -c 300 "$work/pull.err")"
  done
}

# As unidades do systemd do nó (os arquivos, as pastas de complemento e os links de ativação), menos as do próprio
# atualizador: a volta nunca mexe nele. Caminhos sem a barra do começo, para o tar com -C /.
node_units() {
  find "$units_dir" -mindepth 1 -maxdepth 2 -name 'verax-*' ! -name 'verax-update.*' 2>/dev/null |
    sed 's|^/||' | sort
}

# O que está instalado agora: a versão anterior, para a volta.
snapshot() {
  {
    printf '%s\n' "${opt_dir#/}" "${etc_dir#/}/images.env"
    node_units
  } >"$state_dir/previous.list"
  tar -C / -cpf "$state_dir/previous.tar.tmp" -T "$state_dir/previous.list" 2>"$work/snapshot.err" || return 1
  mv -f "$state_dir/previous.tar.tmp" "$state_dir/previous.tar"
}

unit_state() { systemctl show -p ActiveState --value "$1" 2>/dev/null || echo unknown; }

# A API respondendo /health/ready de dentro do contêiner (a API não tem porta no host), pelo Compose do nó.
api_ready() {
  docker compose --project-directory "$opt_dir" -f "$opt_dir/compose.yaml" --env-file "$etc_dir/images.env" \
    exec -T api node -e \
    "fetch('http://127.0.0.1:3000/health/ready').then((r) => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))" \
    >/dev/null 2>&1
}

# O nó de pé: o verax-node ativo, o Wazuh no standard e a API pronta. Até $health_tries conferências.
node_healthy() {
  local try node wazuh
  for ((try = 1; try <= health_tries; try++)); do
    node=$(unit_state verax-node.service)
    wazuh=active
    if $standard; then wazuh=$(unit_state verax-wazuh.service); fi
    if [[ $node == failed ]]; then return 1; fi
    if [[ $node == active && $wazuh == active ]] && api_ready; then return 0; fi
    if ((try < health_tries)); then sleep "$health_pause"; fi
  done
  return 1
}

# A volta: o que estava instalado antes deste pedido, por cima do que a versão nova deixou, e o nó de pé de novo.
rollback() { # <código da falha>
  local cause=$1 unit name
  log "Voltando para $from_version (a falha foi $cause)." >&2
  report rolling_back "$cause"
  [[ -f $state_dir/previous.tar ]] || { report rollback_failed "$cause"; exit 1; }
  # As unidades que a versão nova trouxe e a anterior não tinha param antes de sair.
  node_units >"$work/units.now"
  while IFS= read -r unit; do
    name=${unit##*/}
    if [[ $unit != */*.wants/* && $name == *.* ]] && ! grep -qxF "$unit" "$state_dir/previous.list"; then
      systemctl stop "$name" >/dev/null 2>&1 || true
    fi
  done <"$work/units.now"
  while IFS= read -r unit; do rm -rf "${unit:?}"; done < <(sed 's|^|/|' "$work/units.now")
  rm -rf "${opt_dir:?}"
  if ! tar -C / -xpf "$state_dir/previous.tar" 2>"$work/restore.err"; then
    log "A cópia anterior não voltou: $(head -c 300 "$work/restore.err")" >&2
    report rollback_failed "$cause"
    exit 1
  fi
  systemctl daemon-reload || true
  if ! systemctl restart verax-node.service; then
    report rollback_failed "$cause"
    exit 1
  fi
  if $standard; then systemctl start verax-wazuh.service || true; fi
  # Os timers e os .path que a versão anterior tinha ligados voltam a contar.
  while IFS= read -r unit; do
    name=${unit##*/}
    if [[ $unit == */*.wants/* && ($name == *.timer || $name == *.path) ]]; then
      systemctl start "$name" >/dev/null 2>&1 || true
    fi
  done <"$state_dir/previous.list"
  if node_healthy; then
    log "Nó de volta em $from_version."
    report rolled_back "$cause"
  else
    report rollback_failed "$cause"
  fi
  exit 1
}

# O pedido novo, do começo ao fim.
apply_request() {
  local order
  ensure_accepted
  if [[ -n $from_release ]]; then
    order=$(compare_releases "$want_release" "$from_release")
    if ((order < 0)) && [[ $want_intent != rollback ]]; then
      fail downgrade_refused "o nó está em $from_release e o pedido é $want_release, mais antiga, sem rollback."
    fi
  fi
  if ! in_window; then
    log "Fora da janela de manutenção ($want_window, horário de Brasília): o pedido espera."
    report_once waiting_window
    exit 0
  fi
  ensure_jq || fail dependencies_failed "o jq não instalou pelo apt."
  report downloading
  fetch_release
  # Um nó instalado pelo deploy.sh (sem release) já no commit da versão: nada a instalar.
  if [[ -z $from_release && $from_commit == "$rel_commit" ]]; then
    log "O nó já está no commit de $want_release."
    finish_ok
    return
  fi
  report pulling
  pull_images
  report backing_up
  "$opt_dir/bin/backup.sh" >"$work/backup.out" 2>&1 ||
    fail backup_failed "o backup do banco antes da atualização falhou: $(tail -c 300 "$work/backup.out")"
  snapshot || fail snapshot_failed "a cópia do que está instalado falhou: $(head -c 300 "$work/snapshot.err")"

  report installing
  log "Instalando $want_release (commit $rel_commit) sobre $from_version."
  if ! DEBIAN_FRONTEND=noninteractive bash "$work/package/verax-node/bin/install.sh" --version "$rel_commit" \
    --api-digest "$rel_api_digest" --migrate-digest "$rel_migrate_digest" --release "$want_release"; then
    if [[ $(unit_state verax-node.service) == failed ]]; then rollback node_start_failed; fi
    rollback install_failed
  fi
  report checking
  node_healthy || rollback health_failed
  finish_ok
}

finish_ok() {
  report ok
  attribute delete update-error || true
  log "Nó em $want_release."
}

main() {
  # Roda de uma cópia na memória, com o verificador e as chaves de agora: o install.sh troca /opt/verax no meio do
  # caminho, e o bash lê o script aos poucos.
  if [[ ${1:-} != --from-run-dir ]]; then
    install -d -m 0700 "$run_dir" "$run_dir/trust" "$run_dir/trust/bin"
    rm -rf "$run_dir/trust/keys"
    install -d -m 0700 "$run_dir/trust/keys"
    install -m 0700 "$0" "$run_dir/update.sh"
    if [[ -f $opt_dir/bin/verify-release.sh ]]; then
      install -m 0700 "$opt_dir/bin/verify-release.sh" "$run_dir/trust/bin/verify-release.sh"
    fi
    shopt -s nullglob
    local key
    for key in "$opt_dir"/keys/release-*.pem; do install -m 0600 "$key" "$run_dir/trust/keys/"; done
    shopt -u nullglob
    # O rastro do bash (-x), se ligado, segue na cópia.
    local options=()
    if [[ $- == *x* ]]; then options+=(-x); fi
    exec bash "${options[@]}" "$run_dir/update.sh" --from-run-dir
  fi

  # Um pedido por vez.
  install -d -m 0755 "$(dirname "$lock_file")"
  exec 9>"$lock_file"
  flock -n 9 || exit 0

  work=$(mktemp -d "$run_dir/work.XXXXXX")
  trap 'rm -rf "$work"' EXIT
  install -d -m 0700 "$state_dir"

  # Sem pedido nos metadados, nada a fazer (e nada é gravado: o nó da Verax e o nó sem guest attributes ficam quietos).
  local status=0
  read_request_key want_release verax-node-release "$re_release" 24 || status=$?
  case $status in
    0) ;;
    3) exit 0 ;;
    1) log 'O servidor de metadados não respondeu: tentando na próxima rodada.' >&2; exit 0 ;;
    *) want_release='' ;;
  esac
  local request_status=0
  read_request_key want_request verax-node-release-request "$re_request" 80 || request_status=$?
  if ((request_status == 1)); then exit 0; fi
  # Um pedido sem id não tem como ser respondido: fica quieto até o plano de controle gravar um.
  ((request_status == 0)) || { log 'Pedido sem id válido (verax-node-release-request): ignorado.' >&2; exit 0; }

  read_installed || true

  # O mesmo pedido de antes: só garante que o resultado está nos guest attributes (uma vez por boot).
  local last_request last_state last_error
  last_request=$(conf_value "$state_dir/status" request)
  last_state=$(conf_value "$state_dir/status" state)
  last_error=$(conf_value "$state_dir/status" error)
  if [[ $last_request == "$want_request" && $last_state =~ ^(ok|failed|rolled_back|rollback_failed)$ ]]; then
    if [[ $(cat "$run_dir/reported" 2>/dev/null) != "$want_request $last_state" ]]; then
      want_release=$(conf_value "$state_dir/status" release)
      from_version=$(conf_value "$state_dir/status" from)
      [[ $last_error =~ $re_code ]] || last_error=''
      report_accepted
      report "$last_state" "$last_error"
    fi
    exit 0
  fi

  if ((status != 0)); then fail metadata_invalid 'o metadado verax-node-release está fora do formato.'; fi
  local key_status=0
  read_request_key want_sha verax-node-release-sha256 "$re_sha" 64 || key_status=$?
  case $key_status in
    0) ;;
    1) exit 0 ;;
    3) fail metadata_invalid 'falta o metadado verax-node-release-sha256.' ;;
    *) fail metadata_invalid 'o metadado verax-node-release-sha256 está fora do formato.' ;;
  esac
  key_status=0
  read_request_key want_intent verax-node-release-intent "$re_intent" 16 upgrade || key_status=$?
  case $key_status in
    0) ;;
    1) exit 0 ;;
    *) fail metadata_invalid 'o metadado verax-node-release-intent está fora do formato (upgrade ou rollback).' ;;
  esac
  key_status=0
  read_request_key want_window verax-update-window "$re_window" 16 '' || key_status=$?
  case $key_status in
    0) ;;
    1) exit 0 ;;
    *) fail metadata_invalid 'o metadado verax-update-window está fora do formato (HH:MM-HH:MM).' ;;
  esac

  # Nunca durante a instalação sem operador (nem a do primeiro boot, nem uma que parou no meio).
  if [[ ! -f $etc_dir/images.env || -f $boot_state_dir/installing ]]; then
    log 'A instalação do nó não terminou: o pedido espera.'
    report_once waiting_install
    exit 0
  fi
  if [[ -e $boot_lock ]]; then
    exec 8>>"$boot_lock"
    if ! flock -n 8; then
      log 'A instalação sem operador está rodando: o pedido espera.'
      exit 0
    fi
  fi

  [[ -n $from_version ]] || fail install_state_invalid "o $etc_dir/images.env do nó está fora do formato."
  images_repository=$(conf_value "$etc_dir/node.conf" IMAGES_REPOSITORY)
  [[ $images_repository =~ $re_artifact_registry|$re_ghcr ]] ||
    fail install_state_invalid "o IMAGES_REPOSITORY do $etc_dir/node.conf está fora do formato."
  if [[ $(conf_value "$etc_dir/node.conf" NODE_PROFILE) == standard ]]; then standard=true; fi

  # Já na versão pedida (um pedido repetido depois de um sucesso, ou a volta que o nó já fez): só o resultado.
  if [[ -n $from_release && $from_release == "$want_release" ]]; then
    ensure_accepted
    finish_ok
    exit 0
  fi
  apply_request
}

main "$@"
