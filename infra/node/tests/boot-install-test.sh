#!/bin/bash
# Testes da instalação sem operador (bin/boot-install.sh, PR-N7) e do script de boot do módulo que a chama
# (infra/gcp/modules/node/unattended.sh.tftpl), sem root, sem Docker e sem nuvem. No CI:
#   bash infra/node/tests/boot-install-test.sh
#
# O servidor de metadados, os guest attributes, o release do GitHub (com o redirecionamento) e o "checkip" são o
# tests/fake-gcp.py, em HTTP no 127.0.0.1. O release é montado aqui: um pacote falso (os compose de verdade e um
# install.sh que só anota o que recebeu), o manifesto pelo scripts/node-release.sh (o mesmo do workflow Versão do nó) e a
# assinatura com uma chave P-256 gerada neste teste (nenhuma chave privada fica no repositório nem sobrevive ao teste),
# conferida pelo bin/verify-release.sh de verdade. O systemctl, o apt-get, o gcloud (a consulta ao cofre da senha do
# e-mail), o script de preparo da VM e o start.sh do nó instalado são simulados. O instalador roda como na VM (um processo à parte), com as linhas dos caminhos e das
# esperas trocadas pelas do teste (o teste confere que cada uma existe uma vez só, e os valores de produção).
#
# Cenários: a primeira instalação (o install.sh com os digests do manifesto, o node.conf byte a byte, `verax/ready` e
# nenhum dado pessoal na saída); o boot seguinte sem baixar nada; a versão nova nos metadados não aplicada; o nó
# atualizado pelo deploy.sh e o instalado só por ele; a instalação que parou no meio; o install.sh e os serviços que
# falham; o preparo da VM que falha; metadados hostis (comando, aspas, quebra de linha, controle, fora do ASCII,
# formato, tamanho) e ausentes; SHA-256 errado nos metadados e pacote trocado no release; assinatura de outra chave,
# manifesto adulterado depois da assinatura, manifesto assinado de outra versão, sem digest ou com outras imagens de
# terceiros; o release fora do ar; o IP de saída que não vem; o túnel que chega depois (e o que não chega); o e-mail do
# nó (o node.conf com o SMTP, a senha que chega ao cofre depois ou não chega, metadados do SMTP hostis e pela metade); o
# GHCR; e o script de boot do módulo de ponta a ponta, com a trava de uma execução por vez.
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$here/../.." && pwd)
installer=$here/bin/boot-install.sh
wrapper=$repo/infra/gcp/modules/node/unattended.sh.tftpl
scenario=ambiente

fail() {
  echo "FALHOU ($scenario): $*" >&2
  exit 1
}

[[ $(id -u) != 0 ]] || fail "rode como usuário comum"
for tool in curl jq openssl python3 tar gzip sha256sum flock base64 cmp; do
  command -v "$tool" >/dev/null || fail "falta $tool"
done

work=$(readlink -f "$(mktemp -d)")
server=''
cleanup() {
  if [[ -n $server ]]; then kill "$server" 2>/dev/null || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

# --- O instalador de produção: os valores que o teste troca -------------------------------------------------------
# Cada linha trocada existe uma vez só (uma linha renomeada faria a troca não acontecer em silêncio), e os valores de
# produção são os esperados: só HTTPS, o release deste repositório e o servidor de metadados da VM.
for name in metadata_url release_base download_proto egress_ip_url etc_dir state_dir node_run opt_bin retry_pause \
  poll_pause tunnel_pause tunnel_tries mail_pause mail_tries attribute_pause node_timeout wazuh_timeout \
  customer_timeout; do
  [[ $(grep -c "^$name=" "$installer") == 1 ]] || fail "a linha $name= não aparece uma vez só no instalador"
done
grep -qx "download_proto='=https'" "$installer" || fail "o instalador baixa sem exigir HTTPS"
grep -qx 'release_base=https://github.com/williandotdev/verax-control/releases/download' "$installer" ||
  fail "o release não é o deste repositório"
grep -qx 'metadata_url=http://metadata.google.internal/computeMetadata/v1' "$installer" || fail "metadata_url mudou"
grep -qx 'egress_ip_url=https://checkip.amazonaws.com' "$installer" || fail "egress_ip_url mudou"
if ! grep -qx 'tunnel_pause=60' "$installer" || ! grep -qx 'tunnel_tries=60' "$installer"; then
  fail "a releitura do túnel não é a cada 60 s por 60 min"
fi
if ! grep -qx 'mail_pause=60' "$installer" || ! grep -qx 'mail_tries=60' "$installer"; then
  fail "a espera da senha do e-mail não é a cada 60 s por 60 min"
fi
# Nada de eval, source ou expansão de texto vindo de fora no instalador.
if grep -nE '^[^#]*\b(eval|source)\b' "$installer" | grep -v 'cmp -s' >/dev/null; then
  fail "o instalador usa eval ou source"
fi

# --- Servidor falso ----------------------------------------------------------------------------------------------
gcp=$work/gcp
mkdir -p "$gcp/attributes" "$gcp/releases"
python3 "$here/tests/fake-gcp.py" "$gcp" &
server=$!
for _ in $(seq 100); do
  [[ -s $gcp/port ]] && break
  sleep 0.1
done
[[ -s $gcp/port ]] || fail "o servidor falso não subiu"
base=http://127.0.0.1:$(cat "$gcp/port")

# --- Chaves e release --------------------------------------------------------------------------------------------
keys=$work/keys
mkdir -p "$keys/trust" "$keys/intrusa"
openssl ecparam -name prime256v1 -genkey -noout -out "$keys/teste.key" 2>/dev/null
openssl ec -in "$keys/teste.key" -pubout -out "$keys/trust/release-teste.pem" 2>/dev/null
openssl ecparam -name prime256v1 -genkey -noout -out "$keys/intrusa.key" 2>/dev/null

commit=$(printf 'c%.0s' {1..40})
api_digest=sha256:$(printf 'a%.0s' {1..64})
migrate_digest=sha256:$(printf 'b%.0s' {1..64})
tag=node-v1.2.3

# O pacote falso: os compose de verdade (as imagens de terceiros pelo digest) e um install.sh que anota o que recebeu
# e escreve o images.env como o de verdade. VERAX_TEST_ROOT é a raiz do cenário. O `malicioso` é o mesmo pacote com um
# install.sh que cria o arquivo pwned (o pacote trocado no release).
build_package() { # <saída.tar.gz> [malicioso]
  local stage=$work/stage-$RANDOM
  mkdir -p "$stage/verax-node/bin"
  cp "$here"/compose*.yaml "$stage/verax-node/"
  if [[ ${2:-} == malicioso ]]; then
    # shellcheck disable=SC2016 # o simulado lê a variável quando roda
    printf '#!/bin/bash\ntouch "$VERAX_TEST_ROOT/pwned"\n' >"$stage/verax-node/bin/install.sh"
    tar -C "$stage" -czf "$1" verax-node
    rm -rf "$stage"
    return
  fi
  cat >"$stage/verax-node/bin/install.sh" <<'EOF'
#!/bin/bash
set -euo pipefail
root=$VERAX_TEST_ROOT
printf '%s\n' "$@" >"$root/install.args"
printf 'APT_CONFIG=%s DEBIAN_FRONTEND=%s\n' "${APT_CONFIG:-}" "${DEBIAN_FRONTEND:-}" >"$root/install.env"
echo install >>"$root/calls.log"
version='' release='' config=''
while (($#)); do
  case $1 in
    --version) version=$2 ;;
    --release) release=$2 ;;
    --config) config=$2 ;;
  esac
  shift 2
done
mkdir -p "$root/etc/verax"
cp "$config" "$root/etc/verax/node.conf"
if [[ -e $root/install-fails ]]; then exit 1; fi
printf 'API_IMAGE=x\nMIGRATE_IMAGE=y\nNODE_VERSION=%s\nNODE_RELEASE=%s\n' "$version" "$release" >"$root/etc/verax/images.env"
EOF
  tar -C "$stage" -czf "$1" verax-node
  rm -rf "$stage"
}

# Monta e publica um release no servidor falso. Opções (depois da tag): --key <chave> assina com outra chave;
# --jq <filtro> muda o manifesto antes de assinar; --tamper <sed> muda depois; --swap-package troca o pacote publicado,
# depois do manifesto, por um pacote igual em tudo menos no install.sh, que "invade" a VM (cria o arquivo pwned).
publish() { # <tag> [opções]
  local release=$1 key=$keys/teste.key filter='.' tamper='' swap=false dir pkg
  shift
  while (($#)); do
    case $1 in
      --key) key=$2; shift 2 ;;
      --jq) filter=$2; shift 2 ;;
      --tamper) tamper=$2; shift 2 ;;
      --swap-package) swap=true; shift ;;
      *) fail "opção de publish: $1" ;;
    esac
  done
  dir=$gcp/releases/$release
  rm -rf "$dir"
  mkdir -p "$dir"
  pkg=$dir/verax-node.tar.gz
  build_package "$pkg"
  (cd "$repo" && bash scripts/node-release.sh manifest --commit "$commit" --release "$release" \
    --api-digest "$api_digest" --migrate-digest "$migrate_digest" --package "$pkg" \
    --repository dono-teste/verax-teste) |
    jq --arg url "$base/releases/download/$release/verax-node.tar.gz" '.package.url = $url' | jq "$filter" \
    >"$dir/manifest.json"
  openssl dgst -sha256 -sign "$key" -out "$dir/manifest.json.sig" "$dir/manifest.json"
  if [[ -n $tamper ]]; then sed -i "$tamper" "$dir/manifest.json"; fi
  if $swap; then build_package "$pkg" malicioso; fi
}
package_sha() { # <tag>: o SHA-256 que o manifesto do release diz
  jq -r .package.sha256 "$gcp/releases/$1/manifest.json"
}

publish "$tag"
good_sha=$(package_sha "$tag")
[[ $(sha256sum "$gcp/releases/$tag/verax-node.tar.gz" | cut -d' ' -f1) == "$good_sha" ]] || fail "o release de teste"

# --- Simulados ---------------------------------------------------------------------------------------------------
mkdir -p "$work/bin"
stub() {
  {
    # shellcheck disable=SC2016 # o simulado lê a variável quando roda, não quando é escrito
    printf '#!/bin/bash\nset -euo pipefail\nroot=$VERAX_TEST_ROOT\n'
    cat
  } >"$work/bin/$1"
  chmod +x "$work/bin/$1"
}
# systemctl: o estado de cada serviço vem de $root/units/<unidade> (sem o arquivo, active).
stub systemctl <<'EOF'
echo "systemctl $*" >>"$root/systemctl.log"
if [[ $1 == show && $2 == -p && $3 == ActiveState && $4 == --value ]]; then
  if [[ -f $root/units/$5 ]]; then cat "$root/units/$5"; else echo active; fi
fi
EOF
stub apt-get <<'EOF'
echo "apt-get $*" >>"$root/calls.log"
EOF
# gcloud: só a espera da senha do e-mail (`secrets versions access latest`). Responde com os códigos de
# $root/mail-codes, um por chamada (o último se repete; sem o arquivo, 0): 0 abre a versão, 3 é o cofre ainda sem versão
# (NOT_FOUND) e 1 é outro erro (PERMISSION_DENIED). Como o de verdade, com `--format=value(name)` imprime só o nome da
# versão; sem ele, imprimiria a senha (o teste confere que ela nunca aparece).
stub gcloud <<'EOF'
echo "gcloud $*" >>"$root/calls.log"
codes=($(cat "$root/mail-codes" 2>/dev/null || echo 0))
code=${codes[0]}
if ((${#codes[@]} > 1)); then printf '%s ' "${codes[@]:1}" >"$root/mail-codes"; fi
case $code in
  0)
    if [[ " $* " == *' --format=value(name) '* ]]; then
      echo 'projects/projeto-exemplo-nos/secrets/vx-demo-a-smtp-password/versions/1'
    else
      echo 'senha-ficticia-da-caixa-de-envio'
    fi
    ;;
  3)
    echo 'ERROR: (gcloud.secrets.versions.access) NOT_FOUND: Secret [projects/projeto-exemplo-nos/secrets/vx-demo-a-smtp-password] not found or has no versions.' >&2
    exit 1
    ;;
  *)
    echo "ERROR: (gcloud.secrets.versions.access) PERMISSION_DENIED: Permission 'secretmanager.versions.access' denied." >&2
    exit 1
    ;;
esac
EOF

# Os metadados de um nó de cliente válido (os do envs/tenant, fictícios). O nome do cliente e os e-mails são dados
# pessoais: o teste confere que nenhum aparece na saída nem nos guest attributes.
# shellcheck disable=SC2016 # texto literal: o teste confere que ninguém o executa
tenant_name='Ação & "Filhos" $(touch pwned) Ltda.'
admin_email=admin@cliente-demo-a.example.com
support_email=suporte@example.com
set_metadata() {
  rm -rf "$gcp/attributes" "$gcp/guest-attributes"
  mkdir -p "$gcp/attributes"
  local pair
  for pair in \
    verax-config-version=1 verax-node-profile=standard verax-secret-prefix=vx-demo-a "verax-node-version=$tag" \
    "verax-node-package-sha256=$good_sha" \
    verax-images-repository=us-east1-docker.pkg.dev/projeto-exemplo-imagens/verax-control \
    verax-web-origin=https://demo-a.control.example.com verax-api-origin=https://api-demo-a.example.com \
    verax-mail-from=nao-responda@example.com verax-smtp-host= verax-smtp-port= verax-smtp-user= \
    verax-plan=profissional verax-plan-max-cloud-accounts= \
    verax-plan-max-users= verax-plan-monthly-gib= verax-plan-history-days= verax-credentials-vault=true \
    verax-backup-bucket=projeto-exemplo-nos-vx-demo-a-backups verax-node-sa-unique-id=123456789012345678901 \
    "verax-tenant-name=$tenant_name" "verax-admin-email=$admin_email" "verax-support-email=$support_email"; do
    printf '%s' "${pair#*=}" >"$gcp/attributes/${pair%%=*}"
  done
  printf 'projeto-exemplo-nos' >"$gcp/project-id"
  printf '203.0.113.20\n' >"$gcp/checkip"
}
meta() { printf '%s' "$2" >"$gcp/attributes/$1"; } # <chave> <valor>

# Uma raiz nova por cenário: a pasta do script de boot (prepare.sh simulado, o verificador de verdade, a chave de
# teste e o instalador com as linhas trocadas) e o start.sh simulado do nó instalado.
root=''
new_root() {
  root=$work/root-$RANDOM$RANDOM
  mkdir -p "$root/boot/trust/bin" "$root/boot/trust/keys" "$root/opt/verax/bin" "$root/run/verax" "$root/units" \
    "$root/var/lib/verax"
  : >"$root/calls.log"
  cp "$here/bin/verify-release.sh" "$root/boot/trust/bin/"
  cp "$keys/trust/release-teste.pem" "$root/boot/trust/keys/"
  cat >"$root/boot/prepare.sh" <<'EOF'
echo prepare >>"$VERAX_TEST_ROOT/calls.log"
if [[ -e $VERAX_TEST_ROOT/prepare-fails ]]; then echo 'falha simulada no preparo' >&2; exit 1; fi
EOF
  sed -e "s|^metadata_url=.*|metadata_url=$base/computeMetadata/v1|" \
    -e "s|^release_base=.*|release_base=$base/releases/download|" \
    -e "s|^download_proto=.*|download_proto='=http'|" \
    -e "s|^egress_ip_url=.*|egress_ip_url=$base/checkip|" \
    -e "s|^etc_dir=.*|etc_dir=$root/etc/verax|" \
    -e "s|^state_dir=.*|state_dir=$root/var/lib/verax/boot|" \
    -e "s|^node_run=.*|node_run=$root/run/verax|" \
    -e "s|^opt_bin=.*|opt_bin=$root/opt/verax/bin|" \
    -e 's|^retry_pause=.*|retry_pause=0|' -e 's|^poll_pause=.*|poll_pause=0|' -e 's|^tunnel_pause=.*|tunnel_pause=0|' \
    -e 's|^tunnel_tries=.*|tunnel_tries=3|' -e 's|^attribute_pause=.*|attribute_pause=0|' \
    -e 's|^mail_pause=.*|mail_pause=0|' -e 's|^mail_tries=.*|mail_tries=3|' \
    -e 's|^node_timeout=.*|node_timeout=1|' -e 's|^wazuh_timeout=.*|wazuh_timeout=1|' \
    -e 's|^customer_timeout=.*|customer_timeout=1|' \
    "$installer" >"$root/boot/boot-install.sh"
  # start.sh do nó: `tunnel` responde com os códigos de $root/tunnel-codes, um por chamada (o último se repete); com
  # 0, grava o cloudflared.env. O `up` do install.sh já gravou o cloudflared.env (com o token) por padrão.
  cat >"$root/opt/verax/bin/start.sh" <<'EOF'
#!/bin/bash
root=$VERAX_TEST_ROOT
echo "start.sh $*" >>"$root/calls.log"
codes=($(cat "$root/tunnel-codes" 2>/dev/null || echo 0))
code=${codes[0]}
if ((${#codes[@]} > 1)); then printf '%s ' "${codes[@]:1}" >"$root/tunnel-codes"; fi
if ((code == 0)); then printf "TUNNEL_TOKEN='t'\n" >"$root/run/verax/cloudflared.env"; fi
if ((code == 1)); then echo 'Falha ao ler o segredo vx-demo-a-cloudflare-tunnel-token no Secret Manager:' >&2; fi
exit "$code"
EOF
  chmod +x "$root/opt/verax/bin/start.sh"
  printf "TUNNEL_TOKEN='t'\n" >"$root/run/verax/cloudflared.env"
  : >"$gcp/requests.log"
  : >"$gcp/guest-attributes.log"
}

# Roda o instalador como o script de boot o roda. Devolve o código de saída; a saída (stdout e stderr) fica em
# $root/out.
boot() {
  local status=0
  echo "--- boot" >>"$root/calls.log"
  : >"$gcp/requests.log"
  : >"$gcp/guest-attributes.log"
  (cd "$root" && env -i HOME="$root" PATH="$work/bin:$PATH" VERAX_TEST_ROOT="$root" \
    bash "$root/boot/boot-install.sh" --boot-dir "$root/boot" --profile standard) >"$root/out" 2>&1 || status=$?
  return "$status"
}

attr() { cat "$gcp/guest-attributes/verax/$1" 2>/dev/null || echo '<sem>'; } # <chave>
installs() { grep -c '^install$' "$root/calls.log" || true; }
downloads() { grep -c '^GET /\(releases\|objects\)/' "$gcp/requests.log" || true; }

# Depois de toda execução: nenhum dado pessoal na saída nem nos guest attributes, nenhum `pwned` (nada dos metadados
# foi interpretado), só `ready` e `error` no espaço verax/, nenhum pedido ao servidor de metadados sem
# Metadata-Flavor, a pasta de trabalho apagada e no máximo 3 gravações de guest attribute.
common_checks() {
  local value
  for value in "$admin_email" "$support_email" 'Filhos' 'nao-responda@example.com' 'avisos@verax.example' \
    'senha-ficticia-da-caixa-de-envio'; do
    if grep -qF "$value" "$root/out" || grep -rqF "$value" "$gcp/guest-attributes" 2>/dev/null; then
      fail "a saída ou um guest attribute traz um valor dos metadados: $value"
    fi
  done
  [[ ! -e $root/pwned && ! -e $root/boot/pwned && ! -e $work/pwned ]] || fail "um valor dos metadados foi executado"
  for value in "$gcp"/guest-attributes/*/*; do
    [[ -e $value ]] || continue
    [[ $value == "$gcp"/guest-attributes/verax/ready || $value == "$gcp"/guest-attributes/verax/error ]] ||
      fail "guest attribute fora de verax/ready e verax/error: $value"
  done
  if grep '^GET /computeMetadata' "$gcp/requests.log" | grep -qv 'flavor=Google$'; then
    fail "pedido ao servidor de metadados sem Metadata-Flavor"
  fi
  if compgen -G "$root/boot/work.*" >/dev/null; then fail "a pasta de trabalho ficou"; fi
  (($(wc -l <"$gcp/guest-attributes.log") <= 3)) || fail "gravações demais de guest attributes"
}
expect_ready() { # <versão>
  common_checks
  [[ $(attr ready) == "$1" ]] || fail "verax/ready é $(attr ready), esperado $1 (saída: $(cat "$root/out"))"
  [[ $(attr error) == '<sem>' ]] || fail "verax/error ficou: $(attr error)"
}
expect_error() { # <código>
  common_checks
  [[ $(attr error) == "$1" ]] || fail "verax/error é $(attr error), esperado $1 (saída: $(cat "$root/out"))"
  [[ $(attr ready) == '<sem>' ]] || fail "verax/ready com erro: $(attr ready)"
}

expected_conf=$(
  cat <<EOF
# Escrito pela instalação sem operador (boot-install.sh) a partir dos metadados da VM, no release $tag.
# A atualização é pelo deploy.sh, com este mesmo arquivo.
VERAX_GCP_PROJECT=projeto-exemplo-nos
VERAX_SECRET_PREFIX=vx-demo-a
IMAGES_REPOSITORY=us-east1-docker.pkg.dev/projeto-exemplo-imagens/verax-control
WEB_ORIGIN=https://demo-a.control.example.com
API_ORIGIN=https://api-demo-a.example.com
MAIL_TRANSPORT=none
MAIL_FROM=nao-responda@example.com
SYNC_SOURCES=gcp,wazuh,cloudflare
BACKUP_BUCKET=projeto-exemplo-nos-vx-demo-a-backups
PLAN=profissional
NODE_PROFILE=standard
NODE_EGRESS_IPS=203.0.113.20/32
NODE_SA_UNIQUE_ID=123456789012345678901
CREDENTIALS_VAULT=true
WAZUH_AGENTS=false
CUSTOMER_MODE=true
EOF
)

# --- Primeira instalação ----------------------------------------------------------------------------------------
scenario="primeira instalação"
set_metadata
new_root
boot || fail "saiu com erro: $(cat "$root/out")"
expect_ready "$tag"
[[ $(installs) == 1 ]] || fail "o install.sh rodou $(installs) vezes"
expected_args=$(printf '%s\n' --version "$commit" --api-digest "$api_digest" --migrate-digest "$migrate_digest" \
  --release "$tag" --config)
[[ $(head -n 9 "$root/install.args") == "$expected_args" && $(wc -l <"$root/install.args") == 10 ]] ||
  fail "argumentos do install.sh: $(cat "$root/install.args")"
# O node.conf vem da pasta de trabalho do boot (na memória, 0700), não de um caminho de fora.
[[ $(sed -n 10p "$root/install.args") == "$root"/boot/work.*/node.conf ]] || fail "--config fora da pasta do boot"
[[ $(cat "$root/etc/verax/node.conf") == "$expected_conf" ]] || fail "node.conf: $(cat "$root/etc/verax/node.conf")"
grep -q '^APT_CONFIG=.*/apt.conf DEBIAN_FRONTEND=noninteractive$' "$root/install.env" ||
  fail "o install.sh rodou sem a espera da trava do apt: $(cat "$root/install.env")"
[[ $(cat "$root/var/lib/verax/boot/installed") == "$tag" && ! -e $root/var/lib/verax/boot/installing ]] ||
  fail "o marcador da instalação"
[[ $(stat -c %a "$root/var/lib/verax/boot") == 700 ]] || fail "a pasta do estado não é 0700"
# O node.conf lido com `source` (como o install.sh e o start.sh o leem) dá os valores literais.
(
  set -u
  # shellcheck source=/dev/null
  source "$root/etc/verax/node.conf"
  [[ $MAIL_FROM == nao-responda@example.com && $WEB_ORIGIN == https://demo-a.control.example.com &&
    $NODE_EGRESS_IPS == 203.0.113.20/32 && $CUSTOMER_MODE == true && -z ${PLAN_MAX_USERS:-} ]]
) || fail "o node.conf lido com source não dá os valores"
# Os guest attributes: os dois apagados antes de tudo, e só no fim o ready.
[[ $(cat "$gcp/guest-attributes.log") == "$(printf 'DELETE verax/ready \nDELETE verax/error \nPUT verax/ready %s' "$tag")" ]] ||
  fail "ordem dos guest attributes: $(cat "$gcp/guest-attributes.log")"
# O release veio pelo redirecionamento, o manifesto e a assinatura antes do pacote; a ordem: preparo, apt nenhum (o jq
# já existe), install.sh.
[[ $(grep -c '^GET /objects/' "$gcp/requests.log") == 3 ]] || fail "o release não veio pelo redirecionamento"
[[ $(grep -oE '^GET /objects/[^ ]+' "$gcp/requests.log" | tr '\n' ' ') == "GET /objects/$tag/manifest.json GET /objects/$tag/manifest.json.sig GET /objects/$tag/verax-node.tar.gz " ]] ||
  fail "ordem dos downloads: $(grep -oE '^GET /objects/[^ ]+' "$gcp/requests.log")"
grep -q 'Assinatura do manifesto conferida (OK release-teste)' "$root/out" || fail "a assinatura não foi conferida"
# Sem o e-mail do nó, o cofre da senha nem é consultado.
! grep -q '^gcloud' "$root/calls.log" || fail "consultou o cofre da senha do e-mail sem o e-mail ligado"

# --- Boot seguinte -------------------------------------------------------------------------------------------------
scenario="boot seguinte: nada é baixado nem instalado"
boot || fail "saiu com erro: $(cat "$root/out")"
expect_ready "$tag"
[[ $(installs) == 1 && $(downloads) == 0 ]] || fail "instalou ou baixou de novo"
[[ $(grep -c '^prepare$' "$root/calls.log") == 2 ]] || fail "o preparo da VM não rodou de novo (swap a cada boot)"

scenario="versão nova nos metadados: não é aplicada"
meta verax-node-version node-v1.3.0
publish node-v1.3.0
meta verax-node-package-sha256 "$(package_sha node-v1.3.0)"
boot || fail "saiu com erro: $(cat "$root/out")"
expect_ready "$tag"
[[ $(installs) == 1 && $(downloads) == 0 ]] || fail "aplicou a versão nova sozinho"
grep -q "Os metadados pedem node-v1.3.0 e o nó está em $tag: a atualização não é automática" "$root/out" ||
  fail "não avisou da versão pedida: $(cat "$root/out")"

scenario="atualizado pelo deploy.sh: verax/ready é o commit"
printf 'API_IMAGE=x\nMIGRATE_IMAGE=y\nNODE_VERSION=%s\n' "$(printf 'd%.0s' {1..40})" >"$root/etc/verax/images.env"
boot || fail "saiu com erro: $(cat "$root/out")"
expect_ready "$(printf 'd%.0s' {1..40})"
[[ $(installs) == 1 ]] || fail "reinstalou"

scenario="images.env sumiu depois da instalação"
rm "$root/etc/verax/images.env"
if boot; then fail "seguiu sem o images.env"; fi
expect_error install_state_invalid

# --- Instalado só pelo deploy.sh, e a instalação que parou no meio -----------------------------------------------
scenario="nó instalado pelo deploy.sh (sem marcador): a instalação não mexe"
set_metadata
new_root
mkdir -p "$root/etc/verax"
printf 'NODE_VERSION=%s\n' "$commit" >"$root/etc/verax/images.env"
boot || fail "saiu com erro: $(cat "$root/out")"
expect_ready "$commit"
[[ $(installs) == 0 && $(downloads) == 0 ]] || fail "instalou num nó do deploy.sh"

scenario="instalação que parou no meio (marcador installing): instala de novo"
mkdir -p "$root/var/lib/verax/boot"
echo "$tag" >"$root/var/lib/verax/boot/installing"
boot || fail "saiu com erro: $(cat "$root/out")"
expect_ready "$tag"
[[ $(installs) == 1 ]] || fail "não reinstalou"

# --- Falhas do install.sh, dos serviços e do preparo ---------------------------------------------------------------
scenario="install.sh falha: install_failed, e o boot seguinte tenta de novo"
new_root
touch "$root/install-fails"
if boot; then fail "seguiu com o install.sh falhando"; fi
expect_error install_failed
[[ -e $root/var/lib/verax/boot/installing && ! -e $root/var/lib/verax/boot/installed ]] || fail "marcadores"
rm "$root/install-fails"
boot || fail "a nova tentativa falhou: $(cat "$root/out")"
expect_ready "$tag"
[[ $(installs) == 2 ]] || fail "não tentou de novo"

scenario="install.sh falha com o verax-node em failed: node_start_failed"
new_root
touch "$root/install-fails"
echo failed >"$root/units/verax-node.service"
if boot; then fail "seguiu"; fi
expect_error node_start_failed

scenario="install.sh falha com o verax-wazuh em failed: wazuh_start_failed"
new_root
touch "$root/install-fails"
echo failed >"$root/units/verax-wazuh.service"
if boot; then fail "seguiu"; fi
expect_error wazuh_start_failed

scenario="primeiro acesso do cliente falhou de vez"
new_root
echo failed >"$root/units/verax-customer-bootstrap.service"
if boot; then fail "seguiu"; fi
expect_error customer_bootstrap_failed

scenario="primeiro acesso do cliente que não termina no prazo"
new_root
echo activating >"$root/units/verax-customer-bootstrap.service"
if boot; then fail "seguiu"; fi
expect_error customer_bootstrap_failed

scenario="verax-node que não sobe no boot seguinte"
new_root
boot || fail "a instalação falhou: $(cat "$root/out")"
echo failed >"$root/units/verax-node.service"
if boot; then fail "seguiu"; fi
expect_error node_start_failed
rm "$root/units/verax-node.service"
boot || fail "a volta falhou"
expect_ready "$tag"

scenario="preparo da VM falha: nada é baixado"
new_root
touch "$root/prepare-fails"
if boot; then fail "seguiu"; fi
expect_error prepare_failed
[[ $(downloads) == 0 && $(installs) == 0 ]] || fail "baixou ou instalou sem a VM preparada"

# --- Túnel -------------------------------------------------------------------------------------------------------
scenario="túnel: o token chega na terceira leitura"
new_root
: >"$root/run/verax/cloudflared.env"
echo '3 3 0' >"$root/tunnel-codes"
boot || fail "saiu com erro: $(cat "$root/out")"
expect_ready "$tag"
[[ $(grep -c '^start.sh tunnel$' "$root/calls.log") == 3 ]] || fail "leituras do túnel: $(grep -c '^start.sh tunnel$' "$root/calls.log")"

scenario="túnel: uma leitura falha e a seguinte sobe"
new_root
: >"$root/run/verax/cloudflared.env"
echo '1 0' >"$root/tunnel-codes"
boot || fail "saiu com erro: $(cat "$root/out")"
expect_ready "$tag"
grep -q 'a leitura do cofre do túnel falhou (saída 1)' "$root/out" || fail "não avisou da falha"

scenario="túnel: o token não chega no prazo"
new_root
: >"$root/run/verax/cloudflared.env"
echo 3 >"$root/tunnel-codes"
if boot; then fail "seguiu sem o túnel"; fi
expect_error tunnel_token_missing
[[ $(grep -c '^start.sh tunnel$' "$root/calls.log") == 3 ]] || fail "não tentou as 3 vezes do teste"

# --- E-mail do nó ----------------------------------------------------------------------------------------------------
# Com as três chaves `verax-smtp-*`, o node.conf liga o SMTP (a senha fica no cofre, nunca no arquivo nem na saída), e
# a instalação espera a senha chegar ao cofre antes de rodar o install.sh (o start.sh não subiria sem ela).
set_smtp() { # <servidor> <porta> <usuário>
  meta verax-smtp-host "$1"
  meta verax-smtp-port "$2"
  meta verax-smtp-user "$3"
}
expected_conf_smtp=${expected_conf/MAIL_TRANSPORT=none/MAIL_TRANSPORT=smtp}
expected_conf_smtp=${expected_conf_smtp/MAIL_FROM=nao-responda@example.com/MAIL_FROM=nao-responda@example.com
SMTP_HOST=smtp.caixa-exemplo.example
SMTP_PORT=587
SMTP_USER=avisos@verax.example}
mail_probe='gcloud secrets versions access latest --project projeto-exemplo-nos --secret vx-demo-a-smtp-password --format=value(name)'

scenario="e-mail do nó: o node.conf com o SMTP, e a senha conferida no cofre antes do install.sh"
set_metadata
set_smtp smtp.caixa-exemplo.example 587 avisos@verax.example
new_root
boot || fail "saiu com erro: $(cat "$root/out")"
expect_ready "$tag"
[[ $(cat "$root/etc/verax/node.conf") == "$expected_conf_smtp" ]] || fail "node.conf: $(cat "$root/etc/verax/node.conf")"
[[ $(grep '^gcloud' "$root/calls.log") == "$mail_probe" ]] || fail "consulta ao cofre: $(grep '^gcloud' "$root/calls.log")"
[[ $(grep -E '^(gcloud|install)' "$root/calls.log" | tr '\n' ' ') == "$mail_probe install " ]] ||
  fail "o cofre não foi conferido antes do install.sh: $(cat "$root/calls.log")"
(
  set -u
  # shellcheck source=/dev/null
  source "$root/etc/verax/node.conf"
  [[ $MAIL_TRANSPORT == smtp && $SMTP_HOST == smtp.caixa-exemplo.example && $SMTP_PORT == 587 &&
    $SMTP_USER == avisos@verax.example && -z ${SMTP_PASSWORD:-} ]]
) || fail "o node.conf lido com source não dá o SMTP"
grep -qi 'senha\|password' "$root/etc/verax/node.conf" && fail "o node.conf leva a senha"

scenario="e-mail do nó: o boot seguinte não consulta o cofre de novo (o start.sh lê a senha na partida)"
: >"$root/calls.log"
boot || fail "saiu com erro: $(cat "$root/out")"
expect_ready "$tag"
! grep -q '^gcloud' "$root/calls.log" || fail "consultou o cofre num nó já instalado"

scenario="e-mail do nó: a senha chega na terceira leitura"
new_root
echo '3 3 0' >"$root/mail-codes"
boot || fail "saiu com erro: $(cat "$root/out")"
expect_ready "$tag"
[[ $(grep -c '^gcloud' "$root/calls.log") == 3 && $(installs) == 1 ]] || fail "leituras: $(grep -c '^gcloud' "$root/calls.log")"
grep -q 'Esperando a senha da caixa de envio' "$root/out" || fail "não avisou da espera"

scenario="e-mail do nó: uma leitura falha (permissão) e a seguinte abre"
new_root
echo '1 0' >"$root/mail-codes"
boot || fail "saiu com erro: $(cat "$root/out")"
expect_ready "$tag"
grep -q 'a leitura do cofre da senha da caixa de envio falhou (saída 1)' "$root/out" || fail "não avisou da falha"

scenario="e-mail do nó: a senha não chega no prazo (smtp_password_missing, nada instalado)"
new_root
echo 3 >"$root/mail-codes"
if boot; then fail "seguiu sem a senha"; fi
expect_error smtp_password_missing
[[ $(grep -c '^gcloud' "$root/calls.log") == 3 && $(installs) == 0 ]] || fail "tentou de menos ou instalou"
[[ -e $root/var/lib/verax/boot/installing && ! -e $root/var/lib/verax/boot/installed ]] || fail "marcadores"
# O boot seguinte tenta de novo, e a senha agora está lá.
echo 0 >"$root/mail-codes"
boot || fail "a nova tentativa falhou: $(cat "$root/out")"
expect_ready "$tag"
[[ $(installs) == 1 ]] || fail "não instalou na nova tentativa"

scenario="e-mail do nó: a porta 465 e um usuário que não é e-mail"
set_metadata
set_smtp smtp.caixa-exemplo.example 465 apikey
new_root
boot || fail "saiu com erro: $(cat "$root/out")"
expect_ready "$tag"
if ! grep -qx 'SMTP_PORT=465' "$root/etc/verax/node.conf" || ! grep -qx 'SMTP_USER=apikey' "$root/etc/verax/node.conf"; then
  fail "node.conf: $(cat "$root/etc/verax/node.conf")"
fi

# Cada valor fora do formato, com os outros dois válidos, e uma chave sem as outras: metadata_invalid antes de
# qualquer download, sem node.conf e sem consultar o cofre.
# shellcheck disable=SC2016 # os valores são texto literal: o teste confere que nada deles é executado
smtp_hostile=(
  'verax-smtp-host=SMTP.caixa-exemplo.example'
  'verax-smtp-host=smtp.caixa-exemplo.example:587'
  'verax-smtp-host=smtp.caixa-exemplo.example;touch pwned'
  'verax-smtp-host=$(touch pwned).example'
  'verax-smtp-host=localhost'
  'verax-smtp-host=-smtp.caixa-exemplo.example'
  "verax-smtp-host=smtp.caixa-exemplo.example"$'\n'"SMTP_HOST=smtp.intruso.example"
  "verax-smtp-host=smtp.caixa-exemplo.example"$'\n'
  "verax-smtp-host=$(printf 'a%.0s' {1..250}).example"
  'verax-smtp-port=0'
  'verax-smtp-port=65536'
  'verax-smtp-port=0587'
  'verax-smtp-port=587 '
  'verax-smtp-port=99999'
  "verax-smtp-user=o'neil@verax.example"
  'verax-smtp-user=avisos verax'
  'verax-smtp-user=-avisos'
  'verax-smtp-user=avisos@verax.example`id`'
  "verax-smtp-user=$(printf 'a%.0s' {1..255})"
)
for case in "${smtp_hostile[@]}"; do
  key=${case%%=*}
  value=${case#*=}
  scenario="e-mail do nó hostil: $key=$(printf '%q' "$value" | head -c 80)"
  set_metadata
  set_smtp smtp.caixa-exemplo.example 587 avisos@verax.example
  meta "$key" "$value"
  new_root
  if boot; then fail "aceitou"; fi
  expect_error metadata_invalid
  [[ $(downloads) == 0 && $(installs) == 0 && ! -e $root/etc/verax/node.conf ]] || fail "baixou, instalou ou escreveu"
  ! grep -q '^gcloud' "$root/calls.log" || fail "consultou o cofre"
done
for keep in verax-smtp-host verax-smtp-port verax-smtp-user; do
  scenario="e-mail do nó pela metade: só $keep"
  set_metadata
  set_smtp smtp.caixa-exemplo.example 587 avisos@verax.example
  for key in verax-smtp-host verax-smtp-port verax-smtp-user; do
    if [[ $key != "$keep" ]]; then meta "$key" ''; fi
  done
  new_root
  if boot; then fail "aceitou"; fi
  expect_error metadata_invalid
  [[ $(downloads) == 0 && $(installs) == 0 ]] || fail "baixou ou instalou"
done

# --- Metadados hostis e ausentes ------------------------------------------------------------------------------------
# Cada caso: a chave e o valor; o instalador para com metadata_invalid antes de baixar qualquer coisa, sem rodar o
# install.sh nem escrever o node.conf, e nada do valor é executado.
nl=$'\n'
cr=$'\r'
tab=$'\t'
# shellcheck disable=SC2016 # os valores são texto literal: o teste confere que nada deles é executado
hostile=(
  "verax-web-origin=https://x.example.com\$(touch $work/pwned)"
  'verax-web-origin=https://x.example.com;touch pwned'
  'verax-web-origin=https://x.example.com`touch pwned`'
  'verax-web-origin=http://demo-a.control.example.com'
  'verax-web-origin=https://demo-a.control.example.com/caminho'
  'verax-web-origin=https://Demo-A.control.example.com'
  'verax-web-origin=https://ação.example.com'
  "verax-web-origin=https://demo-a.control.example.com${nl}PLAN=interno"
  "verax-web-origin=https://demo-a.control.example.com$cr"
  "verax-web-origin=https://$(printf 'a%.0s' {1..300}).example.com"
  'verax-api-origin=https://demo-a.control.example.com'
  "verax-mail-from=o'neil@example.com"
  'verax-mail-from=$(id)@example.com'
  'verax-mail-from=nao responda@example.com'
  'verax-mail-from=.nao@example.com'
  'verax-mail-from=nao..responda@example.com'
  'verax-mail-from=Verax <nao-responda@example.com>'
  'verax-images-repository=us-east1-docker.pkg.dev/projeto-exemplo-imagens/verax;touch pwned'
  'verax-images-repository=docker.io/library/verax'
  'verax-images-repository=ghcr.io/dono/repo/extra'
  'verax-plan=interno'
  "verax-plan=essencial${nl}PLAN=interno"
  "verax-plan=essencial$tab"
  "verax-plan=essencial$nl"
  'verax-plan-max-users=0'
  'verax-plan-max-users=1e3'
  'verax-plan-max-users=-1'
  'verax-plan-max-users=1234567'
  'verax-plan-history-days=30 dias'
  'verax-node-version=node-v1.2'
  'verax-node-version=v1.2.3'
  'verax-node-version=node-v1.2.3/../../x'
  'verax-node-version=node-v01.2.3'
  "verax-node-package-sha256=$(printf 'A%.0s' {1..64})"
  'verax-node-package-sha256=abc'
  'verax-secret-prefix=VX-DEMO'
  'verax-secret-prefix=vx_demo'
  'verax-secret-prefix=vx-demo-a-nome-longo-demais'
  'verax-credentials-vault=yes'
  'verax-backup-bucket=Bucket-Errado'
  'verax-backup-bucket=b'
  'verax-node-sa-unique-id=12345678901234567890'
  'verax-node-sa-unique-id=12345678901234567890a'
  'verax-config-version=2'
  'verax-node-profile=lean'
  'project-id=Projeto-Exemplo'
)
for case in "${hostile[@]}"; do
  key=${case%%=*}
  value=${case#*=}
  scenario="metadado hostil: $key=$(printf '%q' "$value" | head -c 80)"
  set_metadata
  if [[ $key == project-id ]]; then printf '%s' "$value" >"$gcp/project-id"; else meta "$key" "$value"; fi
  new_root
  if boot; then fail "aceitou"; fi
  expect_error metadata_invalid
  [[ $(downloads) == 0 && $(installs) == 0 && ! -e $root/etc/verax/node.conf ]] || fail "baixou, instalou ou escreveu"
done

scenario="plano enterprise sem os quatro limites"
set_metadata
meta verax-plan enterprise
meta verax-plan-max-cloud-accounts 15
meta verax-plan-max-users 20
meta verax-plan-monthly-gib 60
new_root
if boot; then fail "aceitou"; fi
expect_error metadata_invalid

scenario="plano enterprise com os quatro limites"
meta verax-plan-history-days 365
new_root
boot || fail "saiu com erro: $(cat "$root/out")"
expect_ready "$tag"
for line in PLAN=enterprise PLAN_MAX_CLOUD_ACCOUNTS=15 PLAN_MAX_USERS=20 PLAN_MONTHLY_GIB=60 PLAN_HISTORY_DAYS=365; do
  grep -qx "$line" "$root/etc/verax/node.conf" || fail "$line não foi para o node.conf"
done

for key in verax-plan verax-support-email verax-tenant-name verax-node-sa-unique-id verax-config-version \
  verax-smtp-host; do
  scenario="metadado ausente: $key"
  set_metadata
  rm "$gcp/attributes/$key"
  new_root
  if boot; then fail "aceitou"; fi
  expect_error metadata_missing
  [[ $(downloads) == 0 && $(installs) == 0 ]] || fail "baixou ou instalou"
done

scenario="e-mail do administrador vazio"
set_metadata
meta verax-admin-email ''
new_root
if boot; then fail "aceitou"; fi
expect_error metadata_missing

# --- Release: hash, assinatura, manifesto, pacote ------------------------------------------------------------------
scenario="SHA-256 dos metadados diferente do manifesto: o pacote nem é baixado"
set_metadata
meta verax-node-package-sha256 "$(printf '0%.0s' {1..64})"
new_root
if boot; then fail "aceitou"; fi
expect_error package_sha256_mismatch
grep -q "GET /objects/$tag/verax-node.tar.gz" "$gcp/requests.log" && fail "baixou o pacote"
[[ $(installs) == 0 ]] || fail "instalou"

scenario="pacote trocado no release depois do manifesto"
publish node-v2.0.0 --swap-package
set_metadata
meta verax-node-version node-v2.0.0
meta verax-node-package-sha256 "$(package_sha node-v2.0.0)"
new_root
if boot; then fail "aceitou"; fi
expect_error package_sha256_mismatch
[[ $(installs) == 0 ]] || fail "instalou"

scenario="manifesto assinado por outra chave"
publish node-v2.0.1 --key "$keys/intrusa.key"
set_metadata
meta verax-node-version node-v2.0.1
meta verax-node-package-sha256 "$(package_sha node-v2.0.1)"
new_root
if boot; then fail "aceitou"; fi
expect_error release_signature_invalid
grep -q 'GET /objects/node-v2.0.1/verax-node.tar.gz' "$gcp/requests.log" && fail "baixou o pacote"

scenario="manifesto adulterado depois da assinatura (o digest da API)"
publish node-v2.0.2 --tamper "s/$api_digest/sha256:$(printf 'e%.0s' {1..64})/"
set_metadata
meta verax-node-version node-v2.0.2
meta verax-node-package-sha256 "$(package_sha node-v2.0.2)"
new_root
if boot; then fail "aceitou"; fi
expect_error release_signature_invalid

scenario="manifesto assinado de outra versão"
publish node-v2.0.3 --jq '.release = "node-v9.9.9"'
set_metadata
meta verax-node-version node-v2.0.3
meta verax-node-package-sha256 "$(package_sha node-v2.0.3)"
new_root
if boot; then fail "aceitou"; fi
expect_error release_manifest_invalid

scenario="manifesto assinado com a API sem digest"
publish node-v2.0.4 --jq '.images.api = "ghcr.io/dono-teste/verax-teste/api:latest"'
set_metadata
meta verax-node-version node-v2.0.4
meta verax-node-package-sha256 "$(package_sha node-v2.0.4)"
new_root
if boot; then fail "aceitou"; fi
expect_error release_manifest_invalid

scenario="manifesto assinado com o commit fora do formato"
publish node-v2.0.5 --jq '.version = "main"'
set_metadata
meta verax-node-version node-v2.0.5
meta verax-node-package-sha256 "$(package_sha node-v2.0.5)"
new_root
if boot; then fail "aceitou"; fi
expect_error release_manifest_invalid

# Um campo com quebra de linha no fim passaria pela expressão depois que o `$(...)` a cortasse: recusado antes.
scenario="manifesto assinado com quebra de linha no fim do commit"
publish node-v2.0.8 --jq ".version = \"$commit\\n\""
set_metadata
meta verax-node-version node-v2.0.8
meta verax-node-package-sha256 "$(package_sha node-v2.0.8)"
new_root
if boot; then fail "aceitou"; fi
expect_error release_manifest_invalid

scenario="manifesto assinado com outras imagens de terceiros que as dos compose"
publish node-v2.0.6 --jq ".thirdPartyImages += [\"postgres:17@sha256:$(printf 'f%.0s' {1..64})\"]"
set_metadata
meta verax-node-version node-v2.0.6
meta verax-node-package-sha256 "$(package_sha node-v2.0.6)"
new_root
if boot; then fail "aceitou"; fi
expect_error package_invalid
[[ $(installs) == 0 ]] || fail "instalou"

scenario="assinatura ausente no release"
publish node-v2.0.7
rm "$gcp/releases/node-v2.0.7/manifest.json.sig"
set_metadata
meta verax-node-version node-v2.0.7
meta verax-node-package-sha256 "$(package_sha node-v2.0.7)"
new_root
if boot; then fail "aceitou"; fi
expect_error release_download_failed

scenario="release que não existe"
set_metadata
meta verax-node-version node-v7.7.7
new_root
if boot; then fail "aceitou"; fi
expect_error release_download_failed

# --- IP de saída ---------------------------------------------------------------------------------------------------
scenario="IP de saída fora do formato"
set_metadata
printf '<html>erro</html>' >"$gcp/checkip"
new_root
if boot; then fail "aceitou"; fi
expect_error egress_ip_unknown
[[ $(installs) == 0 ]] || fail "instalou sem o IP"

# --- GHCR no lugar do Artifact Registry ----------------------------------------------------------------------------
scenario="GHCR do próprio manifesto"
set_metadata
meta verax-images-repository ghcr.io/dono-teste/verax-teste
new_root
boot || fail "saiu com erro: $(cat "$root/out")"
expect_ready "$tag"
grep -qx 'IMAGES_REPOSITORY=ghcr.io/dono-teste/verax-teste' "$root/etc/verax/node.conf" || fail "node.conf"

scenario="GHCR de outro repositório"
set_metadata
meta verax-images-repository ghcr.io/outro-dono/verax-teste
new_root
if boot; then fail "aceitou"; fi
expect_error metadata_invalid
[[ $(installs) == 0 ]] || fail "instalou"

# --- Script de boot do módulo, de ponta a ponta ----------------------------------------------------------------------
# O modelo com as cinco interpolações trocadas como o Terraform as troca (o teste do módulo confere que ele leva os
# arquivos do pacote), a pasta do boot na raiz do cenário.
render_wrapper() { # <saída>
  local prepare installer_b64 verifier keys_line
  prepare=$(base64 -w0 "$root/boot/prepare.sh")
  installer_b64=$(base64 -w0 "$root/boot/boot-install.sh")
  verifier=$(base64 -w0 "$here/bin/verify-release.sh")
  keys_line="release-teste.pem $(base64 -w0 "$keys/trust/release-teste.pem")"
  # shellcheck disable=SC2016 # os padrões são o texto literal do modelo
  sed -e 's|\${node_profile}|standard|' -e "s|\${prepare}|$prepare|" -e "s|\${installer}|$installer_b64|" \
    -e "s|\${verifier}|$verifier|" -e "s|\${release_keys}|$keys_line|" \
    -e "s|^boot=/run/verax-boot\$|boot=$root/run/verax-boot|" "$wrapper" >"$1"
  # shellcheck disable=SC2016 # o padrão é o texto literal do modelo
  if grep -q '\${' "$1"; then fail "sobrou interpolação no modelo"; fi
}

scenario="script de boot do módulo, de ponta a ponta"
set_metadata
new_root
render_wrapper "$root/unattended.sh"
status=0
(cd "$root" && env -i HOME="$root" PATH="$work/bin:$PATH" VERAX_TEST_ROOT="$root" bash "$root/unattended.sh") \
  >"$root/out" 2>&1 || status=$?
((status == 0)) || fail "saiu com $status: $(cat "$root/out")"
expect_ready "$tag"
[[ $(cat "$root/etc/verax/node.conf") == "$expected_conf" ]] || fail "node.conf"
[[ $(stat -c %a "$root/run/verax-boot") == 700 ]] || fail "a pasta do boot não é 0700"
cmp -s "$root/run/verax-boot/trust/bin/verify-release.sh" "$here/bin/verify-release.sh" || fail "o verificador"
cmp -s "$root/run/verax-boot/trust/keys/release-teste.pem" "$keys/trust/release-teste.pem" || fail "a chave"

scenario="script de boot do módulo: uma execução por vez"
: >"$gcp/guest-attributes.log"
touch "$root/run/verax-boot/marca"
(
  flock -n 9 || exit 1
  status=0
  env -i HOME="$root" PATH="$work/bin:$PATH" VERAX_TEST_ROOT="$root" bash "$root/unattended.sh" >"$root/out" 2>&1 ||
    status=$?
  ((status == 0)) || exit 2
  [[ -e $root/run/verax-boot/marca ]] || exit 3
) 9>"$root/run/verax-boot.lock" || fail "a segunda execução mexeu na primeira (saída $?): $(cat "$root/out")"
grep -q 'já está rodando' "$root/out" || fail "não avisou: $(cat "$root/out")"
[[ ! -s $gcp/guest-attributes.log ]] || fail "a segunda execução mexeu nos guest attributes"

# Um nome de chave que sairia da pasta das chaves (../../boot-install.sh) trocaria o instalador antes do exec: recusado,
# e nada roda.
scenario="script de boot do módulo com uma chave fora do formato"
new_root
render_wrapper "$root/unattended.sh"
# shellcheck disable=SC2016 # o simulado lê a variável quando roda
intruder=$(printf '#!/bin/bash\ntouch "$VERAX_TEST_ROOT/pwned"\n' | base64 -w0)
sed -i "s|^release-teste.pem .*|../../boot-install.sh $intruder|" "$root/unattended.sh"
if (cd "$root" && env -i HOME="$root" PATH="$work/bin:$PATH" VERAX_TEST_ROOT="$root" bash "$root/unattended.sh") \
  >"$root/out" 2>&1; then
  fail "aceitou a chave"
fi
grep -q 'chave de release fora do formato' "$root/out" || fail "sem a mensagem: $(cat "$root/out")"
[[ ! -e $root/pwned ]] || fail "o instalador foi trocado e executado"
! grep -q '^prepare$' "$root/calls.log" || fail "o instalador rodou depois da chave recusada"

echo "boot-install-test: todos os cenários passaram."
