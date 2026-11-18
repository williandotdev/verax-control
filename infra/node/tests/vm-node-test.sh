#!/bin/bash
# Testes do modo vm do pacote do nó (NODE_PLATFORM=vm, a VM própria do cliente), sem root e sem tocar na máquina nem
# na nuvem. No CI:
#   bash infra/node/tests/vm-node-test.sh
#
# O install.sh, o start.sh e o backup.sh rodam numa pasta temporária que faz o papel da raiz (/etc/verax, /opt/verax,
# /var/lib/verax, /run/verax e /etc/systemd/system viram caminhos dentro dela), com o pacote como o release o monta
# (infra/node mais os scripts do Wazuh, que o perfil standard usa; os do Wazuh que falam com os contêineres e o
# aws-token.sh são trocados por simulados que só anotam a chamada). Os comandos que mexem na máquina ou na nuvem
# (docker, systemctl, iptables, chown, id, gcloud e curl) são simulados e anotam cada chamada; o gcloud, o curl e o
# iptables falham sempre: no modo vm, nada pode chamá-los. O openssl, o base64 e o resto são os de verdade.
#
# Cenários: o install.sh (sem a guarda do metadata, sem o atualizador, sem o token do Google para a AWS, o verax-node de
# systemd/vm, a chave do cofre gerada no cofre local uma vez só, nenhum gcloud) e as recusas (célula, agentes, fonte
# gcp, imagens fora do GHCR, NODE_PLATFORM desconhecido); o start.sh up com os segredos do cofre local (o token do
# túnel, a senha do e-mail e a chave do cofre de credenciais, que chega ao worker só pelo arquivo do tmpfs), sem o estado
# nos guest attributes, sem o tópico do sink e sem o ID da conta de serviço; o cofre sem o token (sobe sem o túnel; o
# `tunnel` liga depois), com um arquivo aberto para outros, com quebra de linha ou com uma chave que não é RSA; o
# primeiro acesso com as entradas dos arquivos do instalador (a senha do administrador num arquivo só de root, a da
# conta de suporte descartada); o wazuh-up sem o token do Google e sem a conferência do metadata; e o backup local com
# retenção, sem bucket.
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
repo_root=$(cd "$here/../.." && pwd)
scenario=ambiente

fail() {
  echo "FALHOU ($scenario): $*" >&2
  exit 1
}

[[ $(id -u) != 0 ]] || fail "rode como usuário comum"
for tool in openssl base64 install sed grep; do
  command -v "$tool" >/dev/null || fail "falta $tool"
done
real_install=$(command -v install)

work=$(readlink -f "$(mktemp -d)")
trap 'rm -rf "$work"' EXIT
case $work in
  */etc/verax* | */opt/verax* | */var/lib/verax* | */run/verax* | */etc/systemd/*) fail "pasta temporária num caminho que o teste troca: $work" ;;
esac
mkdir -p "$work/bin"

stub() {
  {
    # shellcheck disable=SC2016 # o simulado lê a variável quando roda, não quando é escrito
    printf '#!/bin/bash\nset -euo pipefail\nstate=$VERAX_TEST_STATE\n'
    cat
  } >"$work/bin/$1"
  chmod +x "$work/bin/$1"
}
# No modo vm, nada fala com a GCP nem com o metadata, e não há guarda (iptables).
for tool in gcloud curl iptables iptables-restore; do
  stub "$tool" <<EOF
echo "$tool \$*" >>"\$state/proibido.log"
exit 1
EOF
done
# docker: anota. O `config --images` não lista nada; o pg_dump do backup imprime um dump; o `run` do bootstrap
# (primeiro acesso) anota o ambiente que o contêiner receberia e deixa na pasta montada as senhas do cenário.
stub docker <<'EOF'
printf 'docker %s\n' "$*" >>"$state/docker.log"
args=("$@")
if [[ " $* " == *' pg_dump '* ]]; then echo 'dump-de-teste'; exit 0; fi
if [[ ${args[-1]} == bootstrap && " $* " == *' run --rm -T '* ]]; then
  mount='' names=()
  for ((i = 0; i < ${#args[@]}; i++)); do
    case ${args[i]} in
      -v) mount=${args[i + 1]} ;;
      -e) names+=("${args[i + 1]}") ;;
    esac
  done
  for name in "${names[@]}"; do printf '%s=%s\n' "$name" "${!name-<ausente>}"; done >"$state/bootstrap-env"
  dir=${mount%%:*}
  printf '{"email":"admin@cliente-demo-a.example","password":"Abcde-Fghij-Kmnop-Qrstu","expiresAt":"2026-11-25T12:00:00.000Z"}' \
    >"$dir/admin-bootstrap.json"
  printf '{"email":"suporte@verax.example","password":"Vwxyz-Abcde-Fghij-Kmnop","expiresAt":"2026-11-25T12:00:00.000Z"}' \
    >"$dir/support-bootstrap.json"
fi
EOF
stub systemctl <<'EOF'
echo "systemctl $*" >>"$state/systemctl.log"
EOF
stub chown <<'EOF'
echo "chown $*" >>"$state/chown.log"
EOF
stub id <<'EOF'
echo 0
EOF
stub install <<EOF
args=()
while ((\$#)); do
  case \$1 in
    -o | -g) shift 2 ;;
    *) args+=("\$1"); shift ;;
  esac
done
exec "$real_install" "\${args[@]}"
EOF

# O pacote como o release o monta (node-release.sh package: infra/node e os scripts e a configuração do Wazuh), com os
# caminhos trocados. Os scripts que falam com os contêineres do Wazuh e o aws-token.sh viram simulados que anotam.
pkg=$work/pkg
cp -R "$here" "$pkg"
mkdir -p "$pkg/wazuh/config"
cp -R "$repo_root/infra/wazuh/scripts" "$pkg/wazuh/"
cp -R "$repo_root/infra/wazuh/config/indexer" "$repo_root/infra/wazuh/config/manager" "$pkg/wazuh/config/"
# shellcheck disable=SC2016 # o simulado lê a variável quando roda
simulated='#!/bin/bash\necho "%s" >>"$VERAX_TEST_STATE/wazuh.log"\n'
for script in security-admin.sh configure-indexer.sh init-api-users.sh smoke-test.sh; do
  # shellcheck disable=SC2059 # o formato é o simulado acima
  printf "$simulated" "$script" >"$pkg/wazuh/scripts/$script"
done
for script in aws-token.sh wazuh-apply.sh; do
  # shellcheck disable=SC2059 # idem
  printf "$simulated" "$script" >"$pkg/bin/$script"
done

root='' state=''
new_node() { # [CHAVE=valor...] (linhas a mais ou trocadas no node.conf)
  root=$work/root-$RANDOM$RANDOM
  state=$root.state
  mkdir -p "$state" "$root/tmp" "$root/etc/systemd/system"
  cp -R "$pkg" "$root/pkg"
  local file line
  for file in "$root/pkg/bin/install.sh" "$root/pkg/bin/start.sh" "$root/pkg/bin/backup.sh"; do
    sed -i -e "s#/etc/verax#$root/etc/verax#g" -e "s#/opt/verax#$root/opt/verax#g" \
      -e "s#/var/lib/verax#$root/var/lib/verax#g" -e "s#/run/verax#$root/run/verax#g" \
      -e "s#/etc/systemd/system#$root/etc/systemd/system#g" "$file"
  done
  # O node.conf que o verax-install.sh escreve.
  cat >"$root/node.conf" <<'EOF'
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
CUSTOMER_MODE=true
EOF
  for line in "$@"; do
    if grep -q "^${line%%=*}=" "$root/node.conf"; then
      sed -i "s|^${line%%=*}=.*|$line|" "$root/node.conf"
    else
      echo "$line" >>"$root/node.conf"
    fi
  done
  # O cofre local e as entradas do primeiro acesso, como o verax-install.sh os grava.
  mkdir -p "$root/etc/verax/vault" "$root/etc/verax/customer"
  chmod 0700 "$root/etc/verax/vault" "$root/etc/verax/customer"
  printf 'token-ficticio-do-tunel-0123456789abcdef' >"$root/etc/verax/vault/cloudflare-tunnel-token"
  printf 'senha-ficticia-da-caixa' >"$root/etc/verax/vault/smtp-password"
  printf '%s' "$(printf 'K%.0s' {1..43})" >"$root/etc/verax/vault/node-key"
  printf "Cliente Demo A D'Ávila \$HOME" >"$root/etc/verax/customer/verax-tenant-name"
  printf 'admin@cliente-demo-a.example' >"$root/etc/verax/customer/verax-admin-email"
  printf 'suporte@verax.example' >"$root/etc/verax/customer/verax-support-email"
  chmod 0600 "$root"/etc/verax/vault/* "$root"/etc/verax/customer/*
}

run() { # <install|start|backup> [argumentos...]
  local script=$1
  shift
  case $script in
    install)
      set -- --version "$(printf 'a%.0s' {1..40})" --api-digest "sha256:$(printf '1%.0s' {1..64})" \
        --migrate-digest "sha256:$(printf '2%.0s' {1..64})" --release node-v1.2.3 --config "$root/node.conf" "$@"
      script=$root/pkg/bin/install.sh
      ;;
    start) script=$root/opt/verax/bin/start.sh ;;
    backup) script=$root/opt/verax/bin/backup.sh ;;
  esac
  env -i PATH="$work/bin:$PATH" VERAX_TEST_STATE="$state" TMPDIR="$root/tmp" "${ENV_EXTRA[@]}" bash "$script" "$@" \
    >"$state/out" 2>&1
}
ENV_EXTRA=()

value_of() { # <arquivo de ambiente> <CHAVE>
  sed -n "s/^$2='\\(.*\\)'\$/\\1/p" "$root/run/verax/$1"
}
nothing_forbidden() {
  [[ ! -s $state/proibido.log ]] || fail "chamou o que não existe no modo vm: $(cat "$state/proibido.log")"
}

# --- install.sh --------------------------------------------------------------------------------------------------------
scenario='install.sh no modo vm'
new_node
run install || fail "install.sh falhou: $(cat "$state/out")"
nothing_forbidden
units=$root/etc/systemd/system
cmp -s "$units/verax-node.service" "$here/systemd/vm/verax-node.service" || fail "o verax-node não é o de systemd/vm"
! grep -qE '^(Requires|After|Wants)=.*metadata-guard' "$units/verax-node.service" || fail "o verax-node exige a guarda"
for unit in verax-metadata-guard.service verax-update.service verax-update.timer verax-aws-token.service \
  verax-aws-token.timer verax-tenant-bootstrap.path verax-wazuh-agents.timer; do
  [[ ! -e $units/$unit ]] || fail "instalou $unit"
done
for unit in verax-backup.service verax-backup.timer verax-wazuh.service verax-wazuh-alerts.timer \
  verax-wazuh-apply.path verax-wazuh-apply.timer verax-customer-bootstrap.service; do
  [[ -f $units/$unit ]] || fail "não instalou $unit"
done
grep -q -e 'metadata-guard' -e 'verax-update' -e 'verax-aws-token' "$state/systemctl.log" &&
  fail "ligou a guarda, o atualizador ou o token do Google: $(cat "$state/systemctl.log")"
grep -qx 'systemctl enable verax-node.service verax-backup.timer' "$state/systemctl.log" || fail "não ligou o nó e o backup"
key=$root/etc/verax/vault/credentials-key
grep -q 'Private-Key: (3072 bit' < <(openssl pkey -in "$key" -noout -text 2>/dev/null) || fail "a chave do cofre não é RSA-3072"
[[ $(stat -c %a "$key") == 600 && $(stat -c %a "$root/etc/verax/vault") == 700 ]] || fail "modos do cofre local"
grep -q 'Chave nova (RSA-3072) gravada no cofre local' "$state/out" || fail "sem o aviso da chave nova"
before=$(sha256sum "$key")
run install || fail "a segunda instalação falhou: $(cat "$state/out")"
[[ $(sha256sum "$key") == "$before" ]] || fail "a segunda instalação trocou a chave"
grep -q 'O cofre local já tem chave' "$state/out" || fail "a segunda instalação não disse que a chave existe"

for line in NODE_MODE=cell WAZUH_AGENTS=true SYNC_SOURCES=gcp,wazuh IMAGES_REPOSITORY=us-docker.pkg.dev/projeto/repo \
  NODE_PLATFORM=aws; do
  scenario="install.sh recusa ($line)"
  new_node "$line"
  if run install; then fail "instalou"; fi
  grep -q -e 'NODE_PLATFORM' -e 'NODE_MODE=cell' "$state/out" || fail "sem o motivo: $(cat "$state/out")"
  [[ ! -e $root/opt/verax/bin/start.sh ]] || fail "instalou os arquivos antes de recusar"
done

# --- start.sh up --------------------------------------------------------------------------------------------------------
scenario='start.sh up com o cofre local'
new_node
run install || fail "install.sh falhou: $(cat "$state/out")"
: >"$state/docker.log"
run start up || fail "start.sh up falhou: $(cat "$state/out")"
nothing_forbidden
[[ $(value_of cloudflared.env TUNNEL_TOKEN) == token-ficticio-do-tunel-0123456789abcdef ]] || fail "token do túnel"
[[ $(value_of api.env SMTP_PASSWORD) == senha-ficticia-da-caixa ]] || fail "senha do e-mail na API"
[[ $(value_of worker.env SMTP_PASSWORD) == senha-ficticia-da-caixa ]] || fail "senha do e-mail no worker"
[[ $(value_of api.env CREDENTIALS_KEY_VERSION) == 1 && $(value_of worker.env CREDENTIALS_KEY_CURRENT) == 1 ]] ||
  fail "versão da chave do cofre"
[[ $(value_of api.env CREDENTIALS_PUBLIC_KEY | base64 -d) == "$(openssl pkey -in "$root/etc/verax/vault/credentials-key" -pubout 2>/dev/null)" ]] ||
  fail "a pública não é a da chave do cofre local"
[[ $(cat "$root/run/verax/vault/worker-keys") == "1:$(base64 -w0 <"$root/etc/verax/vault/credentials-key")" ]] ||
  fail "o arquivo das chaves do worker não é a chave do cofre local"
! grep -q -e 'PRIVATE KEY' -e BEGIN -e "$(base64 -w0 <"$root/etc/verax/vault/credentials-key")"   "$root/run/verax/worker.env" "$root/run/verax/api.env" || fail "chave privada no ambiente"
for key_name in NODE_STATUS VERAX_NODE_COMMIT GCP_SINK_TOPIC_PREFIX NODE_SA_UNIQUE_ID; do
  ! grep -q "^$key_name=" "$root/run/verax/api.env" "$root/run/verax/worker.env" || fail "$key_name no ambiente"
done
[[ $(value_of worker.env SYNC_SOURCES) == wazuh,cloudflare ]] || fail "fontes do worker"
grep -q 'up --detach cloudflared' "$state/docker.log" || fail "o túnel não subiu"
# Sem a guarda: nenhuma chamada ao metadata-guard.sh (ele chamaria o iptables, proibido aqui).
nothing_forbidden

scenario='o ID da conta de serviço do Google não vale no modo vm'
new_node NODE_SA_UNIQUE_ID=123456789012345678901
run install || fail "install.sh falhou: $(cat "$state/out")"
run start up || fail "start.sh up falhou: $(cat "$state/out")"
grep -q 'NODE_SA_UNIQUE_ID não vale no modo vm' "$state/out" || fail "sem o aviso"
! grep -q NODE_SA_UNIQUE_ID "$root/run/verax/worker.env" || fail "o worker recebeu o ID"

scenario='cofre sem o token do túnel: sobe sem o túnel, e o start.sh tunnel liga depois'
new_node
run install || fail "install.sh falhou"
rm "$root/etc/verax/vault/cloudflare-tunnel-token"
: >"$state/docker.log"
run start up || fail "start.sh up falhou: $(cat "$state/out")"
[[ ! -s $root/run/verax/cloudflared.env ]] || fail "cloudflared.env com valor"
grep -q 'sem o token do túnel' "$state/out" || fail "sem o aviso"
! grep -q 'up --detach cloudflared' "$state/docker.log" || fail "o túnel subiu sem token"
status=0
run start tunnel || status=$?
[[ $status == 3 ]] || fail "o tunnel sem o token saiu com $status"
printf 'token-que-chegou-0123456789abcdefghij' >"$root/etc/verax/vault/cloudflare-tunnel-token"
chmod 0600 "$root/etc/verax/vault/cloudflare-tunnel-token"
run start tunnel || fail "o tunnel com o token falhou: $(cat "$state/out")"
[[ $(value_of cloudflared.env TUNNEL_TOKEN) == token-que-chegou-0123456789abcdefghij ]] || fail "token do túnel"
nothing_forbidden

cofre_recusado() { # <descrição> <comando de preparo>
  scenario="cofre local recusado: $1"
  new_node
  run install || fail "install.sh falhou"
  eval "$2" # o preparo do cenário, texto deste teste
  if run start up; then fail "subiu"; fi
  nothing_forbidden
}
# shellcheck disable=SC2016 # o preparo roda no eval do cenário
cofre_recusado 'senha do e-mail aberta para outros' 'chmod 0644 "$root/etc/verax/vault/smtp-password"'
grep -q 'não é um arquivo comum só do dono' "$state/out" || fail "sem o motivo: $(cat "$state/out")"
# shellcheck disable=SC2016 # o preparo roda no eval do cenário
cofre_recusado 'token com quebra de linha' 'printf "a\nb" >"$root/etc/verax/vault/cloudflare-tunnel-token"'
grep -q 'quebra de linha' "$state/out" || fail "sem o motivo: $(cat "$state/out")"
# shellcheck disable=SC2016 # o preparo roda no eval do cenário
cofre_recusado 'senha do e-mail que é um link' \
  'rm "$root/etc/verax/vault/smtp-password"; ln -s /etc/hostname "$root/etc/verax/vault/smtp-password"'
# shellcheck disable=SC2016 # o preparo roda no eval do cenário
cofre_recusado 'chave do cofre que não é RSA' \
  'openssl ecparam -name prime256v1 -genkey -noout -out "$root/etc/verax/vault/credentials-key" 2>/dev/null'
grep -q 'não é uma chave privada RSA' "$state/out" || fail "sem o motivo: $(cat "$state/out")"
[[ ! -e $root/run/verax/vault/worker-keys ]] || fail "deixou as chaves do worker na memória"
# shellcheck disable=SC2016 # o preparo roda no eval do cenário
cofre_recusado 'fonte gcp' 'sed -i "s/^SYNC_SOURCES=.*/SYNC_SOURCES=gcp,wazuh/" "$root/etc/verax/node.conf"'
grep -q 'NODE_PLATFORM=vm não aceita' "$state/out" || fail "sem o motivo: $(cat "$state/out")"

scenario='sem a chave do cofre: sobe sem o cofre, com o aviso'
new_node CREDENTIALS_VAULT=false
run install || fail "install.sh falhou"
sed -i 's/^CREDENTIALS_VAULT=.*/CREDENTIALS_VAULT=true/' "$root/etc/verax/node.conf"
run start up || fail "start.sh up falhou: $(cat "$state/out")"
grep -q 'o cofre de credenciais .* não tem chave' "$state/out" || fail "sem o aviso: $(cat "$state/out")"

# --- Primeiro acesso ----------------------------------------------------------------------------------------------------
scenario='customer-bootstrap com as entradas do instalador'
new_node
run install || fail "install.sh falhou"
run start up || fail "start.sh up falhou"
run start customer-bootstrap || fail "customer-bootstrap falhou: $(cat "$state/out")"
nothing_forbidden
grep -qxF "BOOTSTRAP_TENANT_NAME=Cliente Demo A D'Ávila \$HOME" "$state/bootstrap-env" ||
  fail "nome do cliente: $(cat "$state/bootstrap-env")"
for line in BOOTSTRAP_ADMIN_EMAIL=admin@cliente-demo-a.example BOOTSTRAP_SUPPORT_EMAIL=suporte@verax.example \
  BOOTSTRAP_MODE=customer; do
  grep -qx "$line" "$state/bootstrap-env" || fail "ambiente do bootstrap sem $line: $(cat "$state/bootstrap-env")"
done
out_file=$root/var/lib/verax/enrollment/admin-bootstrap.json
[[ $(cat "$out_file") == '{"email":"admin@cliente-demo-a.example","password":"Abcde-Fghij-Kmnop-Qrstu","expiresAt":"2026-11-25T12:00:00.000Z"}' ]] ||
  fail "senha do administrador: $(cat "$out_file" 2>/dev/null)"
[[ $(stat -c %a "$out_file") == 600 && $(stat -c %a "$root/var/lib/verax/enrollment") == 700 ]] || fail "modos da senha"
# A senha da conta de suporte não fica em lugar nenhum.
if grep -rq --exclude-dir=pkg 'Vwxyz-Abcde-Fghij-Kmnop' "$root"; then fail "a senha de suporte ficou"; fi
if grep -q -e 'Abcde-Fghij' -e 'Vwxyz-Abcde' "$state/out"; then fail "senha na saída"; fi

scenario='customer-bootstrap sem uma entrada'
new_node
run install || fail "install.sh falhou"
run start up || fail "start.sh up falhou"
rm "$root/etc/verax/customer/verax-support-email"
if run start customer-bootstrap; then fail "rodou sem a entrada"; fi
grep -q 'verax-support-email: o instalador' "$state/out" || fail "sem o motivo: $(cat "$state/out")"
nothing_forbidden

# --- Wazuh ---------------------------------------------------------------------------------------------------------------
scenario='wazuh-up sem o token do Google e sem a conferência do metadata'
new_node
run install || fail "install.sh falhou"
run start up || fail "start.sh up falhou"
: >"$state/docker.log"
run start wazuh-up || fail "wazuh-up falhou: $(cat "$state/out")"
nothing_forbidden
! grep -q aws-token "$state/wazuh.log" || fail "o token do Google foi pedido"
grep -q wazuh-apply.sh "$state/wazuh.log" || fail "a configuração do manager não foi aplicada"
! grep -q 169.254.169.254 "$state/docker.log" || fail "conferiu o metadata"

# --- Backup ------------------------------------------------------------------------------------------------------------
scenario='backup local com retenção'
new_node
run install || fail "install.sh falhou"
backups=$root/var/lib/verax/backups
touch -d '10 days ago' "$backups/verax-20261108T063000Z.dump"
touch -d '5 days ago' "$backups/verax-20261113T063000Z.dump"
run backup || fail "backup falhou: $(cat "$state/out")"
nothing_forbidden
[[ ! -e $backups/verax-20261108T063000Z.dump && -e $backups/verax-20261113T063000Z.dump ]] || fail "retenção de 7 dias"
[[ $(find "$backups" -name 'verax-*.dump' -newer "$backups/verax-20261113T063000Z.dump" -exec cat {} +) == dump-de-teste ]] ||
  fail "o dump novo"
grep -q 'Backup local:' "$state/out" || fail "sem a mensagem: $(cat "$state/out")"
echo 'BACKUP_RETENTION_DAYS=2' >>"$root/etc/verax/node.conf"
run backup || fail "backup falhou"
[[ ! -e $backups/verax-20261113T063000Z.dump ]] || fail "retenção de 2 dias"

echo 'vm-node-test: todos os cenários passaram.'
