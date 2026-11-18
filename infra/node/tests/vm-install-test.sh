#!/bin/bash
# Testes do instalador da VM própria do cliente (bin/verax-install.sh), sem root, sem Docker e sem nuvem. No CI:
#   bash infra/node/tests/vm-install-test.sh
#
# O instalador é o que o release publica: montado pelo scripts/node-release.sh installer num repositório git
# descartável, com uma chave de release P-256 gerada aqui (nenhuma chave privada fica no repositório nem sobrevive ao
# teste). O release do GitHub (com o redirecionamento) e o plano de controle (o registro do nó: claim e report) são o
# tests/fake-gcp.py, em HTTP no 127.0.0.1; o manifesto sai do node-release.sh e é conferido pelo verify-release.sh de
# verdade, embutido no instalador. O pacote é falso: os compose de verdade (as imagens de terceiros pelo digest) e um
# install.sh que anota o que recebeu e faz o papel do primeiro acesso (a senha temporária do administrador no arquivo
# que o start.sh grava no modo vm). O systemctl, o docker, o apt-get, o sysctl, o id, o uname, o nproc e o df são
# simulados; o /etc/os-release e o /proc/meminfo são arquivos do cenário. O instalador roda como na VM (um processo à
# parte), com as linhas dos caminhos e das esperas trocadas pelas do teste (o teste confere que cada uma existe uma vez
# só, e os valores de produção).
#
# Cenários: a instalação completa (o install.sh com os digests do manifesto, o node.conf byte a byte, o cofre local e
# as entradas do primeiro acesso, o claim com o host, o report `ready` com a senha e a cópia local apagada, nenhum
# segredo ou dado pessoal na saída); o instalador do repositório (sem release) e entrada inválida; sistema, arquitetura
# e tamanho fora do suportado (antes do registro) e abaixo do porte contratado (depois, com o aviso); pacote trocado,
# assinatura de outra chave e instalador fora do manifesto (antes do registro, que fica sem uso); código recusado;
# respostas do registro hostis ou fora do contrato (o aviso `claim_invalid`, nada instalado); o install.sh, o túnel e o
# report que falham; o plano de controle instável; a reinstalação com código novo; o --atualizar (versão nova com
# backup, mesma versão concluindo o report pendente, versão mais velha recusada); e a máquina que já é um nó da GCP.
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
repo_root=$(cd "$here/../.." && pwd)
scenario=ambiente

fail() {
  echo "FALHOU ($scenario): $*" >&2
  exit 1
}

[[ $(id -u) != 0 ]] || fail "rode como usuário comum"
for tool in curl jq openssl python3 tar gzip sha256sum flock base64 cmp git shred; do
  command -v "$tool" >/dev/null || fail "falta $tool"
done

work=$(readlink -f "$(mktemp -d)")
server=''
cleanup() {
  if [[ -n $server ]]; then kill "$server" 2>/dev/null || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

source_installer=$here/bin/verax-install.sh

# --- O instalador de produção: os valores que o teste troca ----------------------------------------------------------
for name in control_plane release_base download_proto etc_dir lib_dir opt_dir run_base os_release meminfo sysctl_dir \
  retry_pause poll_pause node_timeout wazuh_timeout customer_timeout tunnel_timeout; do
  [[ $(grep -c "^$name=" "$source_installer") == 1 ]] || fail "a linha $name= não aparece uma vez só no instalador"
done
grep -qx "download_proto='=https'" "$source_installer" || fail "o instalador baixa sem exigir HTTPS"
grep -qx 'control_plane=https://conta.veraxsistemas.com.br' "$source_installer" || fail "o plano de controle mudou"
grep -qx 'release_base=https://github.com/williandotdev/verax-control/releases/download' "$source_installer" ||
  fail "o release não é o deste repositório"
grep -qx "installer_release=''" "$source_installer" || fail "o instalador do repositório traz uma versão"
# Nada de eval ou source no instalador.
if grep -nE '^[^#]*\b(eval|source)\b' "$source_installer" >/dev/null; then fail "o instalador usa eval ou source"; fi

# --- Servidor falso (o release e o plano de controle) ----------------------------------------------------------------
gcp=$work/gcp
mkdir -p "$gcp/releases" "$gcp/enrollment"
python3 "$here/tests/fake-gcp.py" "$gcp" &
server=$!
for _ in $(seq 100); do
  [[ -s $gcp/port ]] && break
  sleep 0.1
done
[[ -s $gcp/port ]] || fail "o servidor falso não subiu"
base=http://127.0.0.1:$(cat "$gcp/port")

# --- Chaves e o instalador montado como no release -------------------------------------------------------------------
keys=$work/keys
mkdir -p "$keys"
openssl ecparam -name prime256v1 -genkey -noout -out "$keys/teste.key" 2>/dev/null
openssl ec -in "$keys/teste.key" -pubout -out "$keys/release-teste.pem" 2>/dev/null
openssl ecparam -name prime256v1 -genkey -noout -out "$keys/intrusa.key" 2>/dev/null

tag=node-v1.2.3
gitrepo=$work/repo
mkdir -p "$gitrepo/infra/node/bin" "$gitrepo/infra/node/keys"
cp "$source_installer" "$here/bin/verify-release.sh" "$gitrepo/infra/node/bin/"
cp "$keys/release-teste.pem" "$gitrepo/infra/node/keys/"
export GIT_AUTHOR_NAME=Teste GIT_AUTHOR_EMAIL=teste@exemplo.com.br GIT_COMMITTER_NAME=Teste
export GIT_COMMITTER_EMAIL=teste@exemplo.com.br GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
git -C "$gitrepo" init -q -b main
git -C "$gitrepo" add -A
git -C "$gitrepo" commit -q -m 'instalador de teste'
mkdir -p "$work/built"
(cd "$gitrepo" && bash "$repo_root/scripts/node-release.sh" installer "$(git rev-parse HEAD)" "$tag" \
  "$work/built/verax-install.sh")
built=$work/built/verax-install.sh
grep -qx "installer_release='$tag'" "$built" || fail "o instalador montado não traz a versão"

commit=$(printf 'c%.0s' {1..40})
api_digest=sha256:$(printf 'a%.0s' {1..64})
migrate_digest=sha256:$(printf 'b%.0s' {1..64})

# O pacote falso: os compose de verdade e um install.sh que anota o que recebeu, escreve o node.conf e o images.env
# como o de verdade e, no papel do verax-customer-bootstrap no modo vm, deixa a senha temporária do administrador no
# arquivo do start.sh (sem $root/no-password: a conta já existia). O `malicioso` cria o arquivo pwned.
build_package() { # <saída.tar.gz> [malicioso]
  local stage=$work/stage-$RANDOM
  mkdir -p "$stage/verax-node/bin"
  cp "$here"/compose*.yaml "$stage/verax-node/"
  if [[ ${2:-} == malicioso ]]; then
    # shellcheck disable=SC2016 # o simulado lê a variável quando roda
    printf '#!/bin/bash\ntouch "$VERAX_TEST_ROOT/pwned"\n' >"$stage/verax-node/bin/install.sh"
  else
    cat >"$stage/verax-node/bin/install.sh" <<'EOF'
#!/bin/bash
set -euo pipefail
root=$VERAX_TEST_ROOT
printf '%s\n' "$@" >"$root/install.args"
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
if [[ -n $config ]]; then cp "$config" "$root/etc/verax/node.conf"; fi
if [[ -e $root/install-fails ]]; then exit 1; fi
printf 'API_IMAGE=x\nMIGRATE_IMAGE=y\nNODE_VERSION=%s\nNODE_RELEASE=%s\n' "$version" "$release" >"$root/etc/verax/images.env"
if [[ ! -e $root/no-password ]]; then
  mkdir -p "$root/var/lib/verax/enrollment"
  printf '{"email":"admin@cliente-demo-a.example","password":"%s","expiresAt":"2026-11-25T12:00:00.000Z"}' \
    "$ADMIN_PASSWORD" >"$root/var/lib/verax/enrollment/admin-bootstrap.json"
fi
EOF
  fi
  tar -C "$stage" -czf "$1" verax-node
  rm -rf "$stage"
}

# Publica o release no servidor falso, com o instalador do cenário no manifesto. Opções: --key <chave> assina com outra
# chave; --jq <filtro> muda o manifesto antes de assinar; --swap-package troca o pacote publicado (depois do manifesto)
# por um que "invade" a VM.
publish() { # <instalador> [opções]
  local installer=$1 key=$keys/teste.key filter='.' swap=false dir pkg
  shift
  while (($#)); do
    case $1 in
      --key) key=$2; shift 2 ;;
      --jq) filter=$2; shift 2 ;;
      --swap-package) swap=true; shift ;;
      *) fail "opção de publish: $1" ;;
    esac
  done
  dir=$gcp/releases/$tag
  rm -rf "$dir"
  mkdir -p "$dir"
  pkg=$dir/verax-node.tar.gz
  build_package "$pkg"
  (cd "$repo_root" && bash scripts/node-release.sh manifest --commit "$commit" --release "$tag" \
    --api-digest "$api_digest" --migrate-digest "$migrate_digest" --package "$pkg" \
    --repository dono-teste/verax-teste --installer "$installer") |
    jq --arg url "$base/releases/download/$tag/verax-node.tar.gz" '.package.url = $url' | jq "$filter" \
    >"$dir/manifest.json"
  openssl dgst -sha256 -sign "$key" -out "$dir/manifest.json.sig" "$dir/manifest.json"
  if $swap; then build_package "$pkg" malicioso; fi
}

# --- Simulados -------------------------------------------------------------------------------------------------------
mkdir -p "$work/bin"
stub() {
  {
    # shellcheck disable=SC2016 # o simulado lê a variável quando roda, não quando é escrito
    printf '#!/bin/bash\nset -euo pipefail\nroot=$VERAX_TEST_ROOT\n'
    cat
  } >"$work/bin/$1"
  chmod +x "$work/bin/$1"
}
stub id <<'EOF'
if [[ ${1:-} == -u ]]; then echo 0; else /usr/bin/id "$@"; fi
EOF
stub uname <<'EOF'
cat "$root/arch" 2>/dev/null || echo x86_64
EOF
stub nproc <<'EOF'
cat "$root/cpus" 2>/dev/null || echo 2
EOF
# df -B1 --output=size: o tamanho do disco do cenário (padrão: 60 GiB).
stub df <<'EOF'
echo '1B-blocks'
cat "$root/disk" 2>/dev/null || echo 64424509440
EOF
# systemctl: o estado de cada serviço vem de $root/units/<unidade> (sem o arquivo, active).
stub systemctl <<'EOF'
echo "systemctl $*" >>"$root/systemctl.log"
if [[ $1 == show && $2 == -p && $3 == ActiveState && $4 == --value ]]; then
  if [[ -f $root/units/$5 ]]; then cat "$root/units/$5"; else echo active; fi
fi
EOF
# docker: o Docker já instalado (`compose version`) e o log do cloudflared (sem $root/no-tunnel, conectado).
stub docker <<'EOF'
echo "docker $*" >>"$root/docker.log"
if [[ " $* " == *' logs --no-color cloudflared '* ]]; then
  echo '2026-11-18T12:00:00Z INF Starting tunnel tunnelID=00000000-0000-0000-0000-000000000000'
  if [[ ! -e $root/no-tunnel ]]; then
    echo '2026-11-18T12:00:01Z INF Registered tunnel connection connIndex=0 location=gru01 protocol=quic'
  fi
fi
EOF
stub apt-get <<'EOF'
echo "apt-get $*" >>"$root/calls.log"
EOF
stub sysctl <<'EOF'
echo "sysctl $*" >>"$root/calls.log"
EOF

# --- Valores do cenário (fictícios) ----------------------------------------------------------------------------------
code=$(printf 'C%.0s' {1..40})abc
node_key=$(printf 'K%.0s' {1..40})xyz
tunnel_token=tunel-ficticio-de-teste-aaaaaaaaaaaaaaaaaaaa
smtp_password=senha-ficticia-da-caixa-de-envio
admin_password=Abcde-Fghij-Kmnop-Qrstu
admin_email=admin@cliente-demo-a.example
support_email=suporte@verax.example
# shellcheck disable=SC2016 # texto literal: o teste confere que ninguém o executa
tenant_name='Ação & "Filhos" $(touch pwned) D'\''Ávila Ltda.'

# O registro de um cliente válido; <filtro> muda a resposta.
claim_response() { # [filtro do jq]
  jq -n --arg tenant "$tenant_name" --arg admin "$admin_email" --arg support "$support_email" --arg tag "$tag" \
    --arg key "$node_key" --arg token "$tunnel_token" --arg smtp "$smtp_password" '{
      tenantId: "00000000-0000-4000-8000-000000000001", slug: "cliente-demo-a",
      apiOrigin: "https://api-cliente-demo-a.example.com", webOrigin: "https://cliente-demo-a.control.example.com",
      release: $tag, size: "P",
      nodeConf: [{name: "PLAN", value: "enterprise"}, {name: "PLAN_MAX_CLOUD_ACCOUNTS", value: "15"},
        {name: "PLAN_MONTHLY_GIB", value: "155"}, {name: "PLAN_HISTORY_DAYS", value: "90"},
        {name: "PLAN_MAX_USERS", value: "10"}, {name: "WAZUH_AGENTS", value: "false"}],
      tenantName: $tenant, adminEmail: $admin, adminName: "Ana", supportEmail: $support,
      mail: {host: "smtp.example.com", port: 465, user: "nao-responda@example.com", from: "nao-responda@example.com",
        password: $smtp},
      tunnelToken: $token, nodeKey: $key
    }' | jq "${1:-.}" >"$gcp/enrollment/claim.json"
}

expected_conf="# Escrito pelo verax-install.sh a partir do registro do nó (cliente cliente-demo-a, porte P), na versão $tag.
# Os segredos ficam no cofre local (/etc/verax/vault). Atualizar: sudo bash verax-install.sh --atualizar
NODE_PLATFORM=vm
IMAGES_REPOSITORY=ghcr.io/dono-teste/verax-teste
WEB_ORIGIN=https://cliente-demo-a.control.example.com
API_ORIGIN=https://api-cliente-demo-a.example.com
MAIL_TRANSPORT=smtp
MAIL_FROM=nao-responda@example.com
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_USER=nao-responda@example.com
SYNC_SOURCES=wazuh,cloudflare
PLAN=enterprise
PLAN_MAX_CLOUD_ACCOUNTS=15
PLAN_MAX_USERS=10
PLAN_MONTHLY_GIB=155
PLAN_HISTORY_DAYS=90
NODE_PROFILE=standard
CREDENTIALS_VAULT=true
WAZUH_AGENTS=false
CUSTOMER_MODE=true"

# Uma raiz nova por cenário: o instalador montado com os caminhos trocados, o release publicado com ele, o registro
# pronto para o código, o host de uma VM P com Debian 12 e o start.sh simulado do nó instalado (o `customer-bootstrap`
# com BOOTSTRAP_RENEW_ADMIN_PASSWORD=true gera a senha nova) e o backup.sh simulado.
root=''
new_root() { # [instalador de origem]
  local source=${1:-$built}
  root=$work/root-$RANDOM$RANDOM
  mkdir -p "$root/units" "$root/run" "$root/opt/verax/bin" "$root/var/lib/verax"
  : >"$root/calls.log"
  sed -e "s|^release_base=.*|release_base=$base/releases/download|" \
    -e "s|^download_proto=.*|download_proto='=http'|" \
    -e "s|^etc_dir=.*|etc_dir=$root/etc/verax|" \
    -e "s|^lib_dir=.*|lib_dir=$root/var/lib/verax|" \
    -e "s|^opt_dir=.*|opt_dir=$root/opt/verax|" \
    -e "s|^run_base=.*|run_base=$root/run|" \
    -e "s|^os_release=.*|os_release=$root/os-release|" \
    -e "s|^meminfo=.*|meminfo=$root/meminfo|" \
    -e "s|^sysctl_dir=.*|sysctl_dir=$root/etc/sysctl.d|" \
    -e 's|^retry_pause=.*|retry_pause=0|' -e 's|^poll_pause=.*|poll_pause=0|' \
    -e 's|^node_timeout=.*|node_timeout=1|' -e 's|^wazuh_timeout=.*|wazuh_timeout=1|' \
    -e 's|^customer_timeout=.*|customer_timeout=1|' -e 's|^tunnel_timeout=.*|tunnel_timeout=1|' \
    "$source" >"$root/verax-install.sh"
  # O instalador do repositório (sem release) não tem o que publicar: ele para antes da rede.
  if grep -q "^installer_release='node-" "$root/verax-install.sh"; then publish "$root/verax-install.sh"; fi
  printf 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\nVERSION_ID="12"\nVERSION_CODENAME=bookworm\n' \
    >"$root/os-release"
  printf 'MemTotal:        8148172 kB\nMemFree:         7000000 kB\n' >"$root/meminfo"
  rm -rf "$gcp/enrollment"
  mkdir -p "$gcp/enrollment"
  printf '%s' "$code" >"$gcp/enrollment/code"
  claim_response
  cat >"$root/opt/verax/bin/start.sh" <<'EOF'
#!/bin/bash
root=$VERAX_TEST_ROOT
echo "start.sh $* renew=${BOOTSTRAP_RENEW_ADMIN_PASSWORD:-}" >>"$root/calls.log"
if [[ $1 == customer-bootstrap && ${BOOTSTRAP_RENEW_ADMIN_PASSWORD:-} == true && ! -e $root/renew-fails ]]; then
  mkdir -p "$root/var/lib/verax/enrollment"
  printf '{"email":"admin@cliente-demo-a.example","password":"%s-nova","expiresAt":"2026-11-25T12:00:00.000Z"}' \
    "$ADMIN_PASSWORD" >"$root/var/lib/verax/enrollment/admin-bootstrap.json"
  exit 0
fi
exit 1
EOF
  cat >"$root/opt/verax/bin/backup.sh" <<'EOF'
#!/bin/bash
echo backup >>"$VERAX_TEST_ROOT/calls.log"
if [[ -e $VERAX_TEST_ROOT/backup-fails ]]; then exit 1; fi
EOF
  chmod +x "$root/opt/verax/bin/start.sh" "$root/opt/verax/bin/backup.sh"
  : >"$gcp/requests.log"
}

# Roda o instalador como na VM (num ambiente limpo). Devolve o código de saída; a saída fica em $root/out.
run_installer() { # [argumentos]
  local status=0
  (cd "$root" && env -i HOME="$root" PATH="$work/bin:$PATH" VERAX_TEST_ROOT="$root" ADMIN_PASSWORD="$admin_password" \
    bash "$root/verax-install.sh" --plano-de-controle "$base" "$@") >"$root/out" 2>&1 || status=$?
  return "$status"
}
install_with_code() { run_installer --codigo "$code"; }

claims() { grep -c '^POST /v1/node-enrollment/claim ' "$gcp/requests.log" || true; }
reports() { cat "$gcp/enrollment/reports.log" 2>/dev/null || true; }
installs() { grep -c '^install$' "$root/calls.log" || true; }

# Depois de toda execução: nenhum segredo nem dado pessoal na saída, nenhum `pwned`, a pasta de trabalho apagada.
common_checks() {
  local value
  for value in "$code" "$node_key" "$tunnel_token" "$smtp_password" "$admin_password" "$admin_email" "$support_email" \
    'Filhos'; do
    if grep -qF -- "$value" "$root/out"; then fail "a saída traz um segredo ou dado pessoal: $value"; fi
  done
  [[ ! -e $root/pwned && ! -e $work/pwned ]] || fail "um valor de fora foi executado"
  if compgen -G "$root/run/verax-install.*/" >/dev/null; then fail "a pasta de trabalho ficou"; fi
}
expect_error_report() { # <código>
  [[ $(reports) == "{\"status\":\"error\",\"code\":\"$1\"}" ]] || fail "aviso de erro esperado $1, veio: $(reports)"
}

# --- A instalação completa -------------------------------------------------------------------------------------------
scenario='instalação completa'
new_root
install_with_code || fail "o instalador falhou: $(cat "$root/out")"
common_checks
[[ $(installs) == 1 ]] || fail "install.sh rodou $(installs) vezes"
[[ $(tr '\n' ' ' <"$root/install.args") == "--version $commit --api-digest $api_digest --migrate-digest $migrate_digest --release $tag --config "* ]] ||
  fail "argumentos do install.sh: $(tr '\n' ' ' <"$root/install.args")"
[[ $(cat "$root/etc/verax/node.conf") == "$expected_conf" ]] || fail "node.conf: $(cat "$root/etc/verax/node.conf")"
vault=$root/etc/verax/vault
[[ $(cat "$vault/node-key") == "$node_key" && $(cat "$vault/cloudflare-tunnel-token") == "$tunnel_token" &&
  $(cat "$vault/smtp-password") == "$smtp_password" ]] || fail "cofre local com o conteúdo errado"
[[ $(stat -c %a "$vault") == 700 && $(stat -c %a "$vault/node-key" "$vault/cloudflare-tunnel-token" "$vault/smtp-password" | sort -u) == 600 ]] ||
  fail "modos do cofre local: $(stat -c '%n %a' "$vault" "$vault"/*)"
inputs=$root/etc/verax/customer
[[ $(cat "$inputs/verax-tenant-name") == "$tenant_name" && $(cat "$inputs/verax-admin-email") == "$admin_email" &&
  $(cat "$inputs/verax-support-email") == "$support_email" ]] || fail "entradas do primeiro acesso erradas"
[[ $(stat -c %a "$inputs/verax-tenant-name") == 600 ]] || fail "entradas do primeiro acesso fora do 0600"
jq -e --arg tag "$tag" '. == {release: $tag, host: {cpus: 2, memoryMb: 7957, diskGb: 60, os: "debian-12", arch: "x86_64"}}' \
  "$gcp/enrollment/claim-request.json" >/dev/null || fail "corpo do claim: $(cat "$gcp/enrollment/claim-request.json")"
expected_payload=$(printf '{"email":"admin@cliente-demo-a.example","password":"%s","expiresAt":"2026-11-25T12:00:00.000Z"}' \
  "$admin_password")
jq -e --arg tag "$tag" --arg payload "$expected_payload" \
  '. == {status: "ready", version: $tag, adminBootstrapPassword: $payload}' <<<"$(reports)" >/dev/null ||
  fail "report: $(reports)"
[[ ! -e $root/var/lib/verax/enrollment/admin-bootstrap.json ]] || fail "a cópia local da senha ficou"
[[ $(cat "$root/var/lib/verax/enrollment/ready") == "$tag" && ! -e $root/var/lib/verax/enrollment/pending ]] ||
  fail "estado do registro"
[[ $(cat "$root/etc/sysctl.d/90-verax.conf") == $'vm.max_map_count = 262144\nvm.swappiness = 1' ]] ||
  fail "ajuste do kernel"
grep -q 'sysctl --quiet --load=' "$root/calls.log" || fail "o sysctl não carregou o ajuste"
grep -q 'apt-get' "$root/calls.log" && fail "o apt rodou com tudo instalado"
# O claim antes do install.sh e o report depois: nenhum segredo nos argumentos do curl (o corpo e o cabeçalho vêm de
# arquivos).
[[ $(grep -c '^POST /v1/node-enrollment/' "$gcp/requests.log") == 2 ]] || fail "pedidos ao plano de controle: $(cat "$gcp/requests.log")"
grep -q 'Pronto: o Verax Control está no ar' "$root/out" || fail "sem a mensagem final: $(cat "$root/out")"

# --- Entrada inválida e o instalador sem release ---------------------------------------------------------------------
scenario='instalador do repositório (sem release embutido)'
new_root "$source_installer"
if run_installer --codigo "$code"; then fail "o instalador sem release rodou"; fi
grep -q 'não veio de um release' "$root/out" || fail "sem o motivo: $(cat "$root/out")"
[[ ! -s $gcp/requests.log ]] || fail "falou com a rede"

scenario='entrada inválida'
new_root
for args in "--codigo curto" "--codigo $code;touch-pwned" "" "--atualizar --codigo $code" "--outra" "--codigo"; do
  # shellcheck disable=SC2086 # os argumentos do cenário, separados por espaço de propósito
  if run_installer $args; then fail "aceitou: $args"; fi
  common_checks
done
if run_installer --codigo "$code" --plano-de-controle 'https://exemplo.com/caminho'; then fail "aceitou o plano de controle com caminho"; fi
[[ ! -s $gcp/requests.log ]] || fail "falou com a rede: $(cat "$gcp/requests.log")"

# --- O host (antes do registro: o código continua valendo) ----------------------------------------------------------
host_refused() { # <código> <descrição>
  scenario=$2
  if install_with_code; then fail "instalou"; fi
  common_checks
  grep -q "ERRO ($1)" "$root/out" || fail "sem o erro $1: $(cat "$root/out")"
  [[ $(claims) == 0 && -z $(reports) ]] || fail "falou com o plano de controle"
  [[ $(installs) == 0 ]] || fail "rodou o install.sh"
}
new_root
printf 'ID=ubuntu\nVERSION_ID="20.04"\nVERSION_CODENAME=focal\n' >"$root/os-release"
host_refused host_unsupported_os 'Ubuntu 20.04'
new_root
printf 'ID=centos\nVERSION_ID="9"\n' >"$root/os-release"
host_refused host_unsupported_os 'outro sistema'
new_root
echo aarch64 >"$root/arch"
host_refused host_unsupported_arch 'ARM'
new_root
echo 1 >"$root/cpus"
host_refused host_too_small 'uma vCPU'
new_root
printf 'MemTotal:        4000000 kB\n' >"$root/meminfo"
host_refused host_too_small '4 GB de memória'
new_root
echo 32212254720 >"$root/disk"
host_refused host_too_small 'disco de 30 GB'

scenario='Ubuntu 24.04 aceito'
new_root
printf 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n' >"$root/os-release"
install_with_code || fail "o instalador falhou: $(cat "$root/out")"
jq -e '.host.os == "ubuntu-24.04"' "$gcp/enrollment/claim-request.json" >/dev/null || fail "os no claim"

scenario='porte contratado maior que a VM (depois do registro, com o aviso)'
new_root
claim_response '.size = "M"'
if install_with_code; then fail "instalou"; fi
common_checks
expect_error_report host_below_size
grep -q 'o porte M pede 4 vCPU' "$root/out" || fail "sem a explicação: $(cat "$root/out")"
[[ $(installs) == 0 ]] || fail "rodou o install.sh"

# --- O release (antes do registro) ----------------------------------------------------------------------------------
release_refused() { # <código>
  if install_with_code; then fail "instalou"; fi
  common_checks
  grep -q "ERRO ($1)" "$root/out" || fail "sem o erro $1: $(cat "$root/out")"
  [[ $(claims) == 0 && -z $(reports) && $(installs) == 0 ]] || fail "seguiu depois do release recusado"
}
scenario='pacote trocado no release'
new_root
publish "$root/verax-install.sh" --swap-package
release_refused package_sha256_mismatch
scenario='manifesto assinado por outra chave'
new_root
publish "$root/verax-install.sh" --key "$keys/intrusa.key"
release_refused release_signature_invalid
scenario='o manifesto descreve outro instalador'
new_root
publish "$root/verax-install.sh" --jq ".installer.sha256 = \"$(printf 'f%.0s' {1..64})\""
release_refused installer_sha256_mismatch
scenario='manifesto sem o instalador (um release antigo)'
new_root
publish "$root/verax-install.sh" --jq 'del(.installer)'
release_refused installer_sha256_mismatch
scenario='manifesto de outra versão'
new_root
publish "$root/verax-install.sh" --jq '.release = "node-v1.2.4"'
release_refused release_manifest_invalid

# --- O registro ------------------------------------------------------------------------------------------------------
scenario='código recusado (já usado, vencido ou trocado)'
new_root
printf 'outro' >"$gcp/enrollment/code"
if install_with_code; then fail "instalou"; fi
common_checks
grep -q 'ERRO (claim_rejected)' "$root/out" || fail "sem o motivo: $(cat "$root/out")"
[[ -z $(reports) && $(installs) == 0 && ! -e $root/etc/verax/vault/node-key ]] || fail "seguiu sem registro"

scenario='plano de controle instável no claim e no report'
new_root
echo '503 429' >"$gcp/enrollment/fail-claim"
echo '502' >"$gcp/enrollment/fail-report"
install_with_code || fail "o instalador falhou: $(cat "$root/out")"
[[ $(claims) == 3 ]] || fail "tentativas do claim: $(claims)"
jq -e '.status == "ready"' <<<"$(reports)" >/dev/null || fail "report: $(reports)"

# Respostas do registro fora do contrato: o aviso claim_invalid, nada instalado, nenhum node.conf.
# shellcheck disable=SC2016 # os filtros do jq são texto literal
for filter in '.apiOrigin = "https://api.exemplo.com/$(touch pwned)"' '.webOrigin = .apiOrigin' \
  '.nodeConf += [{name: "SSO_ISSUER", value: "https://x.exemplo.com"}]' '.nodeConf[0].value = "interno"' \
  '.nodeConf += [{name: "PLAN", value: "enterprise"}]' '.nodeConf |= map(select(.name != "PLAN_MAX_USERS"))' \
  '.nodeConf[1].value = "15\nPLAN=interno"' '.tenantName = "linha\nquebrada"' '.tenantName = ""' \
  '.adminEmail = ("admin@cliente" + ([39] | implode) + " $(touch pwned).example")' '.supportEmail = .adminEmail' \
  '.mail.password = ("com" + ([39] | implode) + "aspa")' \
  '.mail.host = "smtp.example.com;touch pwned"' 'del(.mail.password)' '.mail.port = 99999' '.tunnelToken = "curto"' \
  '.size = "XL"' '.slug = "Cliente_Demo"' '.tenantId = "1"' 'del(.supportEmail)'; do
  scenario="registro fora do contrato: $filter"
  new_root
  claim_response "$filter"
  if install_with_code; then fail "instalou"; fi
  common_checks
  expect_error_report claim_invalid
  [[ $(installs) == 0 && ! -e $root/etc/verax/node.conf ]] || fail "seguiu com o registro inválido"
done

scenario='registro sem a chave do nó (não há como avisar)'
new_root
claim_response '.nodeKey = "curta"'
if install_with_code; then fail "instalou"; fi
common_checks
grep -q 'ERRO (claim_invalid)' "$root/out" || fail "sem o motivo"
[[ -z $(reports) ]] || fail "avisou sem a chave do nó"

scenario='registro de outra versão'
new_root
claim_response '.release = "node-v1.3.0"'
if install_with_code; then fail "instalou"; fi
common_checks
expect_error_report release_mismatch

scenario='e-mail do nó desligado e agentes no contrato'
new_root
claim_response '.mail = {from: "nao-responda@example.com", host: null, port: null, user: null, password: null}
  | .nodeConf = [{name: "PLAN", value: "profissional"}, {name: "WAZUH_AGENTS", value: "true"},
    {name: "WAZUH_AGENTS_MAX", value: "20"}]'
install_with_code || fail "o instalador falhou: $(cat "$root/out")"
for line in MAIL_TRANSPORT=none PLAN=profissional WAZUH_AGENTS=false; do
  grep -qx "$line" "$root/etc/verax/node.conf" || fail "node.conf sem $line: $(cat "$root/etc/verax/node.conf")"
done
! grep -q -e '^SMTP_' -e '^PLAN_' -e WAZUH_AGENTS_MAX "$root/etc/verax/node.conf" || fail "sobrou linha no node.conf"
[[ ! -e $root/etc/verax/vault/smtp-password ]] || fail "gravou a senha do e-mail sem o e-mail"
grep -q 'agentes do Wazuh' "$root/out" || fail "sem o aviso dos agentes"

# --- Falhas depois do registro: o aviso com o código -----------------------------------------------------------------
scenario='install.sh falha'
new_root
: >"$root/install-fails"
if install_with_code; then fail "instalou"; fi
common_checks
expect_error_report install_failed

scenario='verax-node não sobe'
new_root
echo failed >"$root/units/verax-node.service"
if install_with_code; then fail "instalou"; fi
expect_error_report node_start_failed

scenario='primeiro acesso falha'
new_root
echo failed >"$root/units/verax-customer-bootstrap.service"
if install_with_code; then fail "instalou"; fi
expect_error_report customer_bootstrap_failed

scenario='túnel não conecta'
new_root
: >"$root/no-tunnel"
if install_with_code; then fail "instalou"; fi
common_checks
expect_error_report tunnel_unreachable
[[ -f $root/var/lib/verax/enrollment/pending ]] || fail "o registro pendente sumiu"

scenario='report ready recusado: a senha fica, e o --atualizar conclui'
new_root
echo '500 500 500 500 500' >"$gcp/enrollment/fail-report"
if install_with_code; then fail "terminou sem o report"; fi
common_checks
grep -q 'ERRO (report_failed)' "$root/out" || fail "sem o motivo: $(cat "$root/out")"
[[ -f $root/var/lib/verax/enrollment/admin-bootstrap.json && -f $root/var/lib/verax/enrollment/pending ]] ||
  fail "a senha ou o pendente sumiram"
[[ -z $(reports) ]] || fail "report: $(reports)"
run_installer --atualizar || fail "o --atualizar falhou: $(cat "$root/out")"
common_checks
[[ $(installs) == 1 ]] || fail "o --atualizar na mesma versão reinstalou"
grep -q backup "$root/calls.log" && fail "o --atualizar na mesma versão fez backup"
jq -e --arg payload "$expected_payload" '.status == "ready" and .adminBootstrapPassword == $payload' <<<"$(reports)" \
  >/dev/null || fail "report: $(reports)"
[[ ! -e $root/var/lib/verax/enrollment/admin-bootstrap.json && -f $root/var/lib/verax/enrollment/ready ]] ||
  fail "estado depois do --atualizar"

# --- Reinstalação e atualização --------------------------------------------------------------------------------------
scenario='reinstalação com código novo (a conta já existe: senha nova a pedido)'
new_root
install_with_code || fail "a primeira instalação falhou: $(cat "$root/out")"
rm -f "$gcp/enrollment/claimed" "$gcp/enrollment/reports.log"
: >"$root/no-password"
install_with_code || fail "a reinstalação falhou: $(cat "$root/out")"
common_checks
grep -q 'start.sh customer-bootstrap renew=true' "$root/calls.log" || fail "não pediu a senha nova"
jq -e '.adminBootstrapPassword | fromjson | .password | endswith("-nova")' <<<"$(reports)" >/dev/null ||
  fail "report: $(reports)"

scenario='--atualizar para uma versão nova: backup antes, sem registro'
new_root
install_with_code || fail "a instalação falhou: $(cat "$root/out")"
sed -i 's/^NODE_RELEASE=.*/NODE_RELEASE=node-v1.2.2/' "$root/etc/verax/images.env"
rm -f "$gcp/enrollment/reports.log"
: >"$gcp/requests.log"
run_installer --atualizar || fail "o --atualizar falhou: $(cat "$root/out")"
common_checks
[[ $(grep -c -e '^backup$' -e '^install$' "$root/calls.log") == 3 ]] || fail "chamadas: $(cat "$root/calls.log")"
[[ $(grep -e '^backup$' -e '^install$' "$root/calls.log" | tail -n 2 | tr '\n' ' ') == 'backup install ' ]] ||
  fail "o backup não veio antes da instalação"
[[ $(tr '\n' ' ' <"$root/install.args") == "--version $commit --api-digest $api_digest --migrate-digest $migrate_digest --release $tag " ]] ||
  fail "argumentos do install.sh: $(tr '\n' ' ' <"$root/install.args")"
[[ $(claims) == 0 && -z $(reports) ]] || fail "o --atualizar falou com o registro"
grep -q "Atualizado de node-v1.2.2 para $tag" "$root/out" || fail "sem a mensagem: $(cat "$root/out")"

scenario='--atualizar com o backup falhando: nada muda'
new_root
install_with_code || fail "a instalação falhou"
sed -i 's/^NODE_RELEASE=.*/NODE_RELEASE=node-v1.2.2/' "$root/etc/verax/images.env"
: >"$root/backup-fails"
if run_installer --atualizar; then fail "atualizou sem backup"; fi
grep -q 'ERRO (backup_failed)' "$root/out" || fail "sem o motivo"
[[ $(installs) == 1 ]] || fail "rodou o install.sh sem backup"

scenario='--atualizar para uma versão mais velha'
new_root
install_with_code || fail "a instalação falhou"
sed -i 's/^NODE_RELEASE=.*/NODE_RELEASE=node-v1.3.0/' "$root/etc/verax/images.env"
if run_installer --atualizar; then fail "voltou de versão"; fi
grep -q 'ERRO (downgrade_refused)' "$root/out" || fail "sem o motivo: $(cat "$root/out")"

scenario='--atualizar sem instalação'
new_root
if run_installer --atualizar; then fail "atualizou o nada"; fi
grep -q 'ERRO (not_vm_install)' "$root/out" || fail "sem o motivo"

scenario='a máquina já é um nó da GCP'
new_root
mkdir -p "$root/etc/verax"
printf 'VERAX_GCP_PROJECT=projeto-do-no\nPLAN=interno\n' >"$root/etc/verax/node.conf"
if install_with_code; then fail "instalou por cima do nó da GCP"; fi
grep -q 'ERRO (not_vm_install)' "$root/out" || fail "sem o motivo"
[[ $(claims) == 0 ]] || fail "gastou o código"

echo 'vm-install-test: todos os cenários passaram.'
