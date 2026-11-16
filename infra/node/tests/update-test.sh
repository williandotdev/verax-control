#!/bin/bash
# Testes do atualizador da frota (bin/update.sh), sem root, sem Docker e sem nuvem. No CI:
#   bash infra/node/tests/update-test.sh
#
# O servidor de metadados, os guest attributes e o release do GitHub são o tests/fake-gcp.py, em HTTP no 127.0.0.1. Os
# releases são montados aqui, como no boot-install-test.sh: um pacote falso (os compose de verdade e um install.sh que
# anota o que recebeu, troca arquivos do nó e pode falhar), o manifesto pelo scripts/node-release.sh e a assinatura com
# uma chave P-256 gerada neste teste, conferida pelo bin/verify-release.sh de verdade com as chaves "instaladas" no nó
# (opt/verax/keys da raiz do cenário). O systemctl, o docker (pull, compose exec da API), o apt-get, o date (a janela de
# manutenção) e o backup.sh do nó instalado são simulados. O atualizador roda como na VM (um processo à parte), com as
# linhas dos caminhos e das esperas trocadas pelas do teste (o teste confere que cada uma existe uma vez só e os
# valores de produção).
#
# Cenários: sem pedido, nada (nem guest attribute); a atualização (o install.sh com os digests do manifesto e a versão,
# sem --config; as imagens baixadas antes; o backup antes de instalar; os guest attributes update-*); o mesmo pedido de
# novo sem baixar nada, e de novo depois de um reboot (só regrava o resultado); a assinatura de outra chave, o manifesto
# adulterado, o SHA-256 errado nos metadados e o pacote trocado; voltar de versão sem `rollback` (recusado) e com ele; a
# instalação que falha e a conferência que falha (a volta: os arquivos, o images.env e as unidades de antes, o nó
# reiniciado, `rolled_back`), e a volta que também não sobe (`rollback_failed`); a trava (um pedido por vez) e a
# instalação sem operador em andamento; a janela de manutenção; metadados hostis; o backup e o pull que falham; o GHCR
# de outro repositório; o nó já na versão; o nó do deploy.sh já no commit.
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$here/../.." && pwd)
updater=$here/bin/update.sh
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
holder=''
cleanup() {
  if [[ -n $holder ]]; then kill "$holder" 2>/dev/null || true; fi
  if [[ -n $server ]]; then kill "$server" 2>/dev/null || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

# --- O atualizador de produção: os valores que o teste troca -------------------------------------------------------
for name in metadata_url release_base download_proto etc_dir opt_dir units_dir state_dir boot_state_dir boot_lock \
  run_dir lock_file retry_pause attribute_pause health_pause health_tries window_tz; do
  [[ $(grep -c "^$name=" "$updater") == 1 ]] || fail "a linha $name= não aparece uma vez só no atualizador"
done
grep -qx "download_proto='=https'" "$updater" || fail "o atualizador baixa sem exigir HTTPS"
grep -qx 'release_base=https://github.com/williandotdev/verax-control/releases/download' "$updater" ||
  fail "o release não é o deste repositório"
grep -qx 'metadata_url=http://metadata.google.internal/computeMetadata/v1' "$updater" || fail "metadata_url mudou"
grep -qx 'window_tz=America/Sao_Paulo' "$updater" || fail "a janela não é no horário de Brasília"
if grep -nE '^[^#]*\b(eval|source)\b' "$updater" >/dev/null; then fail "o atualizador usa eval ou source"; fi

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

# --- Chaves e releases -------------------------------------------------------------------------------------------
keys=$work/keys
mkdir -p "$keys"
openssl ecparam -name prime256v1 -genkey -noout -out "$keys/teste.key" 2>/dev/null
openssl ec -in "$keys/teste.key" -pubout -out "$keys/release-teste.pem" 2>/dev/null
openssl ecparam -name prime256v1 -genkey -noout -out "$keys/intrusa.key" 2>/dev/null

api_digest=sha256:$(printf 'a%.0s' {1..64})
migrate_digest=sha256:$(printf 'b%.0s' {1..64})
old_commit=$(printf 'c%.0s' {1..40})

commit_of() { printf '%s' "$1" | sha1sum | cut -d' ' -f1; } # <tag>: um commit fictício por versão

# O pacote falso: os compose de verdade e um install.sh que anota o que recebeu, troca o marcador de /opt/verax, põe
# uma unidade nova no systemd e escreve o images.env como o de verdade. Falha com $root/install-fails.
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
version='' release=''
while (($#)); do
  case $1 in
    --version) version=$2 ;;
    --release) release=$2 ;;
  esac
  shift 2
done
echo novo >"$root/opt/verax/bin/marker"
echo novo >"$root/opt/verax/bin/so-na-nova.sh"
echo '[Unit]' >"$root/etc/systemd/system/verax-novo.timer"
ln -sf ../verax-novo.timer "$root/etc/systemd/system/timers.target.wants/verax-novo.timer"
printf 'API_IMAGE=x\nMIGRATE_IMAGE=y\nNODE_VERSION=%s\nNODE_RELEASE=%s\n' "$version" "$release" >"$root/etc/verax/images.env"
if [[ -e $root/install-fails ]]; then exit 1; fi
EOF
  fi
  tar -C "$stage" -czf "$1" verax-node
  rm -rf "$stage"
}

# Monta e publica um release no servidor falso. Opções: --key <chave> assina com outra; --tamper <sed> muda o manifesto
# depois de assinar; --swap-package troca o pacote publicado por outro (com um install.sh que "invade" a VM).
publish() { # <tag> [opções]
  local release=$1 key=$keys/teste.key tamper='' swap=false dir pkg
  shift
  while (($#)); do
    case $1 in
      --key) key=$2; shift 2 ;;
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
  (cd "$repo" && bash scripts/node-release.sh manifest --commit "$(commit_of "$release")" --release "$release" \
    --api-digest "$api_digest" --migrate-digest "$migrate_digest" --package "$pkg" \
    --repository dono-teste/verax-teste) |
    jq --arg url "$base/releases/download/$release/verax-node.tar.gz" '.package.url = $url' >"$dir/manifest.json"
  openssl dgst -sha256 -sign "$key" -out "$dir/manifest.json.sig" "$dir/manifest.json"
  if [[ -n $tamper ]]; then sed -i "$tamper" "$dir/manifest.json"; fi
  if $swap; then build_package "$pkg" malicioso; fi
}
package_sha() { jq -r .package.sha256 "$gcp/releases/$1/manifest.json"; } # <tag>

publish node-v1.3.0
publish node-v1.1.0
publish node-v1.4.0 --key "$keys/intrusa.key"
publish node-v1.5.0 --tamper 's/"schema": 1/"schema": 1, "extra": 1/'
publish node-v1.6.0 --swap-package
new_sha=$(package_sha node-v1.3.0)

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
# systemctl: o estado de cada serviço vem de $root/units/<unidade> (sem o arquivo, active). Com $root/restart-fails, o
# restart do verax-node falha.
stub systemctl <<'EOF'
echo "systemctl $*" >>"$root/systemctl.log"
if [[ $1 == show && $2 == -p && $3 == ActiveState && $4 == --value ]]; then
  if [[ -f $root/units/$5 ]]; then cat "$root/units/$5"; else echo active; fi
fi
if [[ $1 == restart && -e $root/restart-fails ]]; then exit 1; fi
EOF
stub apt-get <<'EOF'
echo "apt-get $*" >>"$root/calls.log"
EOF
# docker: o pull anota a imagem (falha com $root/pull-fails); o `compose ... exec -T api` responde com os códigos de
# $root/ready-codes, um por chamada (o último se repete; sem o arquivo, 0).
stub docker <<'EOF'
echo "docker $*" >>"$root/docker.log"
if [[ $1 == pull ]]; then
  if [[ -e $root/pull-fails ]]; then echo 'falha simulada no pull' >&2; exit 1; fi
  exit 0
fi
if [[ $1 == compose && " $* " == *' exec -T api '* ]]; then
  codes=($(cat "$root/ready-codes" 2>/dev/null || echo 0))
  code=${codes[0]}
  if ((${#codes[@]} > 1)); then printf '%s ' "${codes[@]:1}" >"$root/ready-codes"; fi
  exit "$code"
fi
EOF
# date: o horário de Brasília da janela vem de $root/now (HHMM); o resto, o date de verdade.
stub date <<'EOF'
if [[ $* == '+%H%M' && -f $root/now ]]; then cat "$root/now"; exit 0; fi
exec /usr/bin/date "$@"
EOF

request=frota-01JD0000000000000000000000-1
set_request() { # <versão> <sha> [id] [intenção] [janela]
  rm -rf "$gcp/attributes"
  mkdir -p "$gcp/attributes"
  printf '%s' "$1" >"$gcp/attributes/verax-node-release"
  printf '%s' "$2" >"$gcp/attributes/verax-node-release-sha256"
  printf '%s' "${3:-$request}" >"$gcp/attributes/verax-node-release-request"
  if [[ -n ${4:-} ]]; then printf '%s' "$4" >"$gcp/attributes/verax-node-release-intent"; fi
  if [[ -n ${5:-} ]]; then printf '%s' "$5" >"$gcp/attributes/verax-update-window"; fi
}
meta() { printf '%s' "$2" >"$gcp/attributes/$1"; } # <chave> <valor>

# Uma raiz nova por cenário: o nó instalado em node-v1.2.3 (perfil standard), com o verificador de verdade e a chave
# de teste em opt/verax, o backup.sh simulado e as unidades do systemd.
root=''
new_root() { # [deploy]: o nó instalado pelo deploy.sh (sem NODE_RELEASE)
  root=$work/root-$RANDOM$RANDOM
  local units=$root/etc/systemd/system
  mkdir -p "$root/etc/verax" "$root/opt/verax/bin" "$root/opt/verax/keys" "$root/var/lib/verax/boot" \
    "$root/run/lock" "$root/units" "$units/multi-user.target.wants" "$units/timers.target.wants" \
    "$units/verax-node.service.d"
  : >"$root/calls.log"
  : >"$root/docker.log"
  : >"$root/systemctl.log"
  cp "$here/bin/verify-release.sh" "$root/opt/verax/bin/"
  cp "$keys/release-teste.pem" "$root/opt/verax/keys/"
  echo antigo >"$root/opt/verax/bin/marker"
  cat >"$root/opt/verax/bin/backup.sh" <<'EOF'
#!/bin/bash
echo backup >>"$VERAX_TEST_ROOT/calls.log"
if [[ -e $VERAX_TEST_ROOT/backup-fails ]]; then echo 'falha simulada no backup' >&2; exit 1; fi
EOF
  chmod +x "$root/opt/verax/bin/backup.sh"
  echo '[Unit]' >"$units/verax-node.service"
  echo '[Unit]' >"$units/verax-backup.timer"
  echo '[Unit]' >"$units/verax-update.timer"
  echo '[Service]' >"$units/verax-node.service.d/wazuh.conf"
  ln -s ../verax-node.service "$units/multi-user.target.wants/verax-node.service"
  ln -s ../verax-backup.timer "$units/timers.target.wants/verax-backup.timer"
  ln -s ../verax-update.timer "$units/timers.target.wants/verax-update.timer"
  if [[ ${1:-} == deploy ]]; then
    printf 'API_IMAGE=x\nMIGRATE_IMAGE=y\nNODE_VERSION=%s\n' "$old_commit" >"$root/etc/verax/images.env"
  else
    printf 'API_IMAGE=x\nMIGRATE_IMAGE=y\nNODE_VERSION=%s\nNODE_RELEASE=node-v1.2.3\n' "$old_commit" \
      >"$root/etc/verax/images.env"
  fi
  cp "$root/etc/verax/images.env" "$root/images.env.before"
  printf 'VERAX_GCP_PROJECT=projeto-exemplo-nos\nIMAGES_REPOSITORY=us-east1-docker.pkg.dev/projeto-exemplo-imagens/verax-control\nNODE_PROFILE=standard\n' \
    >"$root/etc/verax/node.conf"
  sed -e "s|^metadata_url=.*|metadata_url=$base/computeMetadata/v1|" \
    -e "s|^release_base=.*|release_base=$base/releases/download|" \
    -e "s|^download_proto=.*|download_proto='=http'|" \
    -e "s|^etc_dir=.*|etc_dir=$root/etc/verax|" \
    -e "s|^opt_dir=.*|opt_dir=$root/opt/verax|" \
    -e "s|^units_dir=.*|units_dir=$root/etc/systemd/system|" \
    -e "s|^state_dir=.*|state_dir=$root/var/lib/verax/update|" \
    -e "s|^boot_state_dir=.*|boot_state_dir=$root/var/lib/verax/boot|" \
    -e "s|^boot_lock=.*|boot_lock=$root/run/verax-boot.lock|" \
    -e "s|^run_dir=.*|run_dir=$root/run/verax-update|" \
    -e "s|^lock_file=.*|lock_file=$root/run/lock/verax-update.lock|" \
    -e 's|^retry_pause=.*|retry_pause=0|' -e 's|^attribute_pause=.*|attribute_pause=0|' \
    -e 's|^health_pause=.*|health_pause=0|' -e 's|^health_tries=.*|health_tries=3|' \
    "$updater" >"$root/opt/verax/bin/update.sh"
  rm -rf "$gcp/guest-attributes"
  : >"$gcp/requests.log"
  : >"$gcp/guest-attributes.log"
}

# Roda o atualizador como o verax-update.service o roda. Devolve o código de saída; a saída fica em $root/out.
update() {
  local status=0
  echo "--- update" >>"$root/calls.log"
  : >"$gcp/requests.log"
  : >"$gcp/guest-attributes.log"
  (cd "$root" && env -i HOME="$root" PATH="$work/bin:$PATH" VERAX_TEST_ROOT="$root" \
    bash ${VERAX_TEST_TRACE:+-x} "$root/opt/verax/bin/update.sh") >"$root/out" 2>&1 || status=$?
  return "$status"
}

attr() { cat "$gcp/guest-attributes/verax/$1" 2>/dev/null || echo '<sem>'; } # <chave>
installs() { grep -c '^install$' "$root/calls.log" || true; }
backups() { grep -c '^backup$' "$root/calls.log" || true; }
pulls() { grep -c '^docker pull' "$root/docker.log" || true; }
downloads() { grep -c '^GET /\(releases\|objects\)/' "$gcp/requests.log" || true; }
writes() { grep -c '^\(PUT\|DELETE\) ' "$gcp/guest-attributes.log" || true; }

# Depois de toda execução: nada executado que veio de fora, só guest attributes update-* no espaço verax/ (o ready e o
# error são da instalação), nenhum pedido ao servidor de metadados sem Metadata-Flavor e a pasta de trabalho apagada.
common_checks() {
  local value
  [[ ! -e $root/pwned && ! -e $work/pwned ]] || fail "algo que veio de fora foi executado"
  for value in "$gcp"/guest-attributes/*/*; do
    [[ -e $value ]] || continue
    [[ $value == "$gcp"/guest-attributes/verax/update-* ]] || fail "guest attribute fora de verax/update-*: $value"
  done
  if grep '^GET /computeMetadata' "$gcp/requests.log" | grep -v 'flavor=Google$' >/dev/null; then
    fail "pedido ao servidor de metadados sem Metadata-Flavor"
  fi
  if compgen -G "$root/run/verax-update/work.*" >/dev/null; then fail "a pasta de trabalho ficou"; fi
}

# O nó intocado: os arquivos, o images.env e as unidades de antes, nenhum install.sh.
untouched() {
  [[ $(installs) == 0 ]] || fail "o install.sh rodou"
  [[ $(cat "$root/opt/verax/bin/marker") == antigo ]] || fail "o /opt/verax mudou"
  cmp -s "$root/etc/verax/images.env" "$root/images.env.before" || fail "o images.env mudou"
}

expect_failed() { # <código>
  [[ $(attr update-state) == failed ]] || fail "update-state: $(attr update-state) (esperava failed); $(cat "$root/out")"
  [[ $(attr update-error) == "$1" ]] || fail "update-error: $(attr update-error) (esperava $1); $(cat "$root/out")"
  [[ $(attr update-request) == "$request" ]] || fail "update-request: $(attr update-request)"
}

# --- Cenários ----------------------------------------------------------------------------------------------------

scenario='sem pedido'
new_root
rm -rf "$gcp/attributes"
mkdir -p "$gcp/attributes"
update || fail "saiu com erro sem pedido: $(cat "$root/out")"
[[ $(writes) == 0 && $(downloads) == 0 ]] || fail "gravou ou baixou sem pedido"
untouched
common_checks

scenario='pedido sem id'
new_root
set_request node-v1.3.0 "$new_sha"
rm -f "$gcp/attributes/verax-node-release-request"
update || fail "saiu com erro: $(cat "$root/out")"
[[ $(writes) == 0 && $(downloads) == 0 ]] || fail "gravou ou baixou sem o id do pedido"
untouched

scenario='atualização'
new_root
set_request node-v1.3.0 "$new_sha"
update || fail "a atualização falhou: $(cat "$root/out")"
[[ $(installs) == 1 ]] || fail "o install.sh não rodou uma vez"
expected_args=$(printf '%s\n' --version "$(commit_of node-v1.3.0)" --api-digest "$api_digest" \
  --migrate-digest "$migrate_digest" --release node-v1.3.0)
[[ $(cat "$root/install.args") == "$expected_args" ]] || fail "argumentos do install.sh: $(cat "$root/install.args")"
grep -q '^--config$' "$root/install.args" && fail "o atualizador mandou --config (o node.conf é o do nó)"
[[ $(attr update-state) == ok && $(attr update-release) == node-v1.3.0 && $(attr update-request) == "$request" ]] ||
  fail "guest attributes: $(attr update-state) $(attr update-release) $(attr update-request)"
[[ $(attr update-from) == node-v1.2.3 && $(attr update-error) == '<sem>' ]] ||
  fail "update-from/update-error: $(attr update-from) $(attr update-error)"
# As imagens pelo digest, do registro do node.conf (as do Verax) e as de terceiros do manifesto, antes do backup, e o
# backup antes do install.sh.
grep -qx "docker pull --quiet us-east1-docker.pkg.dev/projeto-exemplo-imagens/verax-control/api@$api_digest" \
  "$root/docker.log" || fail "a API não foi baixada pelo digest: $(cat "$root/docker.log")"
grep -qx "docker pull --quiet us-east1-docker.pkg.dev/projeto-exemplo-imagens/verax-control/migrate@$migrate_digest" \
  "$root/docker.log" || fail "as migrations não foram baixadas pelo digest"
third=$(jq -r '.thirdPartyImages | length' "$gcp/releases/node-v1.3.0/manifest.json")
[[ $(pulls) == $((third + 2)) ]] || fail "pulls: $(pulls), esperava $((third + 2))"
order=$(grep -E '^(backup|install)$' "$root/calls.log" | tr '\n' ' ')
[[ $order == 'backup install ' ]] || fail "ordem: $order"
grep -q 'exec -T api node -e' "$root/docker.log" || fail "a API não foi conferida"
[[ -f $root/var/lib/verax/update/previous.tar ]] || fail "a cópia da versão anterior não ficou"
grep -q '^state=ok$' "$root/var/lib/verax/update/status" || fail "o estado não ficou gravado"
# Estados na ordem, com o id do pedido só depois do estado novo.
states=$(sed -n 's|^PUT verax/update-state ||p' "$gcp/guest-attributes.log" | tr '\n' ' ')
[[ $states == 'accepted downloading verifying pulling backing_up installing checking ok ' ]] ||
  fail "estados: $states"
first_request=$(grep -n '^PUT verax/update-request' "$gcp/guest-attributes.log" | head -1 | cut -d: -f1)
first_state=$(grep -n '^PUT verax/update-state' "$gcp/guest-attributes.log" | head -1 | cut -d: -f1)
((first_state < first_request)) || fail "o id do pedido saiu antes do estado"
common_checks

scenario='o mesmo pedido de novo'
update || fail "saiu com erro: $(cat "$root/out")"
[[ $(downloads) == 0 && $(writes) == 0 && $(installs) == 1 ]] || fail "repetiu o pedido"

scenario='o mesmo pedido depois de um reboot'
rm -rf "$root/run/verax-update"
update || fail "saiu com erro: $(cat "$root/out")"
[[ $(downloads) == 0 && $(installs) == 1 ]] || fail "baixou ou instalou de novo"
[[ $(attr update-state) == ok && $(attr update-request) == "$request" ]] || fail "não regravou o resultado"
common_checks

scenario='assinatura de outra chave'
new_root
set_request node-v1.4.0 "$(package_sha node-v1.4.0)"
update && fail "aceitou a assinatura de outra chave"
expect_failed release_signature_invalid
[[ $(pulls) == 0 && $(backups) == 0 ]] || fail "baixou imagem ou fez backup"
untouched
common_checks

scenario='manifesto adulterado'
new_root
set_request node-v1.5.0 "$(package_sha node-v1.5.0)"
update && fail "aceitou o manifesto adulterado"
expect_failed release_signature_invalid
untouched

scenario='SHA-256 errado nos metadados'
new_root
set_request node-v1.3.0 "$(printf 'f%.0s' {1..64})"
update && fail "aceitou o SHA-256 errado"
expect_failed package_sha256_mismatch
untouched

scenario='pacote trocado no release'
new_root
set_request node-v1.6.0 "$(package_sha node-v1.6.0)"
update && fail "aceitou o pacote trocado"
expect_failed package_sha256_mismatch
untouched
common_checks

scenario='voltar de versão sem rollback'
new_root
set_request node-v1.1.0 "$(package_sha node-v1.1.0)"
update && fail "aceitou voltar de versão sem rollback"
expect_failed downgrade_refused
[[ $(downloads) == 0 ]] || fail "baixou antes de recusar"
untouched

scenario='voltar de versão com rollback'
new_root
set_request node-v1.1.0 "$(package_sha node-v1.1.0)" "$request" rollback
update || fail "a volta pedida falhou: $(cat "$root/out")"
[[ $(attr update-state) == ok && $(attr update-release) == node-v1.1.0 ]] || fail "não voltou: $(attr update-state)"
grep -qx 'node-v1.1.0' "$root/install.args" || fail "o install.sh não recebeu a versão antiga"

scenario='intenção fora do formato'
new_root
set_request node-v1.3.0 "$new_sha" "$request" 'rollback; touch pwned'
update && fail "aceitou a intenção fora do formato"
expect_failed metadata_invalid
untouched
common_checks

scenario='a instalação falha (volta)'
new_root
set_request node-v1.3.0 "$new_sha"
touch "$root/install-fails"
update && fail "saiu com sucesso numa instalação que falhou"
[[ $(attr update-state) == rolled_back && $(attr update-error) == install_failed ]] ||
  fail "estado: $(attr update-state) $(attr update-error); $(cat "$root/out")"
[[ $(cat "$root/opt/verax/bin/marker") == antigo && ! -e $root/opt/verax/bin/so-na-nova.sh ]] || fail "o /opt/verax não voltou"
cmp -s "$root/etc/verax/images.env" "$root/images.env.before" || fail "o images.env não voltou"
[[ ! -e $root/etc/systemd/system/verax-novo.timer && ! -e $root/etc/systemd/system/timers.target.wants/verax-novo.timer ]] ||
  fail "a unidade da versão nova ficou"
[[ -f $root/etc/systemd/system/verax-node.service.d/wazuh.conf && -L $root/etc/systemd/system/multi-user.target.wants/verax-node.service ]] ||
  fail "as unidades de antes não voltaram"
[[ -f $root/etc/systemd/system/verax-update.timer && -L $root/etc/systemd/system/timers.target.wants/verax-update.timer ]] ||
  fail "a volta mexeu nas unidades do atualizador"
grep -q '^systemctl stop verax-novo.timer$' "$root/systemctl.log" || fail "a unidade nova não parou"
grep -q '^systemctl restart verax-node.service$' "$root/systemctl.log" || fail "o nó não reiniciou na volta"
grep -q '^systemctl start verax-backup.timer$' "$root/systemctl.log" || fail "o timer de antes não voltou a contar"
grep -q '^state=rolled_back$' "$root/var/lib/verax/update/status" || fail "o estado não ficou gravado"
common_checks
rm -f "$root/install-fails"
update || fail "saiu com erro: $(cat "$root/out")"
[[ $(installs) == 1 ]] || fail "tentou o mesmo pedido de novo depois da volta"

scenario='a conferência falha (volta)'
new_root
set_request node-v1.3.0 "$new_sha"
printf '1 1 1 0' >"$root/ready-codes"
update && fail "saiu com sucesso com a API fora"
[[ $(attr update-state) == rolled_back && $(attr update-error) == health_failed ]] ||
  fail "estado: $(attr update-state) $(attr update-error)"
[[ $(cat "$root/opt/verax/bin/marker") == antigo && ! -e $root/opt/verax/bin/so-na-nova.sh ]] || fail "o /opt/verax não voltou"

scenario='a volta também não sobe'
new_root
set_request node-v1.3.0 "$new_sha"
echo 1 >"$root/ready-codes"
update && fail "saiu com sucesso"
[[ $(attr update-state) == rollback_failed && $(attr update-error) == health_failed ]] ||
  fail "estado: $(attr update-state) $(attr update-error)"

scenario='o verax-node não sobe'
new_root
set_request node-v1.3.0 "$new_sha"
touch "$root/install-fails"
echo failed >"$root/units/verax-node.service"
update && fail "saiu com sucesso"
[[ $(attr update-error) == node_start_failed && $(attr update-state) == rollback_failed ]] ||
  fail "estado: $(attr update-state) $(attr update-error)"

scenario='backup que falha'
new_root
set_request node-v1.3.0 "$new_sha"
touch "$root/backup-fails"
update && fail "instalou sem backup"
expect_failed backup_failed
untouched

scenario='pull que falha'
new_root
set_request node-v1.3.0 "$new_sha"
touch "$root/pull-fails"
update && fail "instalou sem as imagens"
expect_failed image_pull_failed
[[ $(backups) == 0 ]] || fail "fez backup antes das imagens"
untouched

scenario='GHCR de outro repositório'
new_root
set_request node-v1.3.0 "$new_sha"
sed -i 's|^IMAGES_REPOSITORY=.*|IMAGES_REPOSITORY=ghcr.io/outro-dono/outro-repo|' "$root/etc/verax/node.conf"
update && fail "aceitou o GHCR de outro repositório"
expect_failed images_repository_mismatch
untouched

scenario='GHCR do manifesto'
new_root
set_request node-v1.3.0 "$new_sha"
sed -i 's|^IMAGES_REPOSITORY=.*|IMAGES_REPOSITORY=ghcr.io/dono-teste/verax-teste|' "$root/etc/verax/node.conf"
update || fail "recusou o GHCR do manifesto: $(cat "$root/out")"
grep -qx "docker pull --quiet ghcr.io/dono-teste/verax-teste/api@$api_digest" "$root/docker.log" ||
  fail "a API não veio do GHCR"

scenario='trava: um pedido por vez'
new_root
set_request node-v1.3.0 "$new_sha"
mkdir -p "$root/run/lock"
flock -o "$root/run/lock/verax-update.lock" sleep 30 &
holder=$!
sleep 0.5
update || fail "saiu com erro com a trava ocupada: $(cat "$root/out")"
[[ $(downloads) == 0 && $(writes) == 0 ]] || fail "rodou com a trava ocupada"
kill "$holder" 2>/dev/null || true
wait "$holder" 2>/dev/null || true
holder=''
untouched

scenario='instalação sem operador em andamento'
new_root
set_request node-v1.3.0 "$new_sha"
echo node-v1.2.3 >"$root/var/lib/verax/boot/installing"
update || fail "saiu com erro: $(cat "$root/out")"
[[ $(attr update-state) == waiting_install && $(downloads) == 0 ]] || fail "não esperou: $(attr update-state)"
untouched
update || true
[[ $(writes) == 0 ]] || fail "regravou o mesmo estado de espera"
rm -f "$root/var/lib/verax/boot/installing"
touch "$root/run/verax-boot.lock"
flock -o "$root/run/verax-boot.lock" sleep 30 &
holder=$!
sleep 0.5
update || fail "saiu com erro: $(cat "$root/out")"
[[ $(downloads) == 0 ]] || fail "rodou com a instalação sem operador rodando"
kill "$holder" 2>/dev/null || true
wait "$holder" 2>/dev/null || true
holder=''
update || fail "não atualizou depois da instalação: $(cat "$root/out")"
[[ $(attr update-state) == ok ]] || fail "estado: $(attr update-state)"

scenario='nó ainda sem instalação'
new_root
set_request node-v1.3.0 "$new_sha"
rm -f "$root/etc/verax/images.env"
update || fail "saiu com erro: $(cat "$root/out")"
[[ $(attr update-state) == waiting_install ]] || fail "estado: $(attr update-state)"

scenario='janela de manutenção'
new_root
set_request node-v1.3.0 "$new_sha" "$request" '' 02:00-05:00
echo 1200 >"$root/now"
update || fail "saiu com erro fora da janela: $(cat "$root/out")"
[[ $(attr update-state) == waiting_window && $(downloads) == 0 ]] || fail "não esperou a janela: $(attr update-state)"
untouched
echo 0300 >"$root/now"
update || fail "não atualizou dentro da janela: $(cat "$root/out")"
[[ $(attr update-state) == ok ]] || fail "estado: $(attr update-state)"
# A janela que passa da meia-noite.
new_root
set_request node-v1.3.0 "$new_sha" "$request" '' 23:00-02:00
echo 0130 >"$root/now"
update || fail "não atualizou dentro da janela da madrugada: $(cat "$root/out")"
[[ $(attr update-state) == ok ]] || fail "estado: $(attr update-state)"

scenario='metadados hostis'
# shellcheck disable=SC2016 # texto literal: o teste confere que ninguém o executa
for value in 'node-v1.3.0; touch pwned' '$(touch pwned)' $'node-v1.3.0\n' 'node-v01.3.0' 'node-v1.3'; do
  new_root
  set_request node-v1.3.0 "$new_sha"
  meta verax-node-release "$value"
  update && fail "aceitou a versão $value"
  expect_failed metadata_invalid
  untouched
  common_checks
done
# shellcheck disable=SC2016 # texto literal: o teste confere que ninguém o executa
for value in $'frota\n1' 'frota 1' '-frota' '$(touch pwned)'; do
  new_root
  set_request node-v1.3.0 "$new_sha" "$value"
  update || fail "saiu com erro com um id hostil"
  [[ $(writes) == 0 && $(downloads) == 0 ]] || fail "usou o id $value"
  untouched
  common_checks
done
new_root
set_request node-v1.3.0 "$new_sha" "$request" '' '25:00-02:00'
update && fail "aceitou a janela fora do formato"
expect_failed metadata_invalid

scenario='o nó já está na versão'
new_root
set_request node-v1.2.3 "$(printf 'd%.0s' {1..64})"
update || fail "saiu com erro: $(cat "$root/out")"
[[ $(attr update-state) == ok && $(downloads) == 0 ]] || fail "baixou ou não respondeu ok"
untouched

scenario='nó do deploy.sh já no commit'
new_root deploy
publish node-v1.7.0
jq --arg c "$old_commit" '.version = $c' "$gcp/releases/node-v1.7.0/manifest.json" >"$work/m.json"
mv "$work/m.json" "$gcp/releases/node-v1.7.0/manifest.json"
openssl dgst -sha256 -sign "$keys/teste.key" -out "$gcp/releases/node-v1.7.0/manifest.json.sig" \
  "$gcp/releases/node-v1.7.0/manifest.json"
set_request node-v1.7.0 "$(package_sha node-v1.7.0)"
update || fail "saiu com erro: $(cat "$root/out")"
[[ $(attr update-state) == ok && $(attr update-from) == "$old_commit" ]] || fail "estado: $(attr update-state)"
untouched

scenario='nó do deploy.sh noutro commit'
new_root deploy
set_request node-v1.3.0 "$new_sha"
update || fail "não atualizou o nó do deploy.sh: $(cat "$root/out")"
[[ $(installs) == 1 && $(attr update-state) == ok ]] || fail "estado: $(attr update-state)"

echo 'update-test: todos os cenários passaram.'
