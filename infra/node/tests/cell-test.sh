#!/bin/bash
# Testa a célula compartilhada no pacote do nó (NODE_MODE=cell; CE-04) sem root, sem Docker e sem a GCP. No CI:
# `bash infra/node/tests/cell-test.sh`.
#
# O start.sh roda como o systemd o roda (processos à parte, ambiente limpo), numa raiz temporária que faz o papel de
# /etc/verax, /var/lib/verax/secrets e /run/verax, com um servidor de metadados e um Secret Manager falsos de verdade
# (tests/fake-gcp.py, em HTTP no 127.0.0.1), o curl de verdade (por um invólucro que anota os argumentos) e o Docker
# simulado (anota os argumentos e o ambiente que o contêiner do bootstrap receberia e deixa na pasta montada o arquivo
# que o node-bootstrap deixaria). As senhas e o token são fictícios.
#
# 1. Os arquivos de ambiente: o nó dedicado sai byte a byte igual com e sem NODE_MODE=dedicated; na célula, a API recebe o
#    modo, o domínio e o subdomínio da equipe no lugar do plano, sem o tópico do sink pelo nome do projeto e sem o ID da
#    conta de serviço da VM (com o aviso); o worker recebe o modo e as pastas dos pedidos. O render recusa, sem escrever
#    nada, o PLAN e os ajustes, o perfil lean, o CUSTOMER_MODE, os agentes do Wazuh e o domínio ou o subdomínio fora do
#    formato. O projeto do Compose ganha o compose.cell.yaml só na célula.
# 2. O primeiro administrador de cada cliente (`tenant-bootstrap` e `tenant-bootstrap-pending`): o pedido do worker vira a
#    chamada do bootstrap no modo cell-tenant, só por variável de ambiente; a senha vai para o cofre do cliente
#    (`vxt-<subdomínio>-admin-bootstrap`) e nunca para a tela, os argumentos de comando ou outro arquivo; o pedido sai e a
#    resposta é `ok`. Pedido fora do formato (link, grande demais, subdomínio, e-mail, linha a mais) é recusado sem
#    chamar o Docker; a senha que não chegou ao cofre vai antes de tudo na tentativa seguinte, no cofre do subdomínio
#    que o host guardou.
# 3. A adoção do cliente do nó que vira célula (`cell-adopt`): o subdomínio da equipe por padrão na célula, obrigatório no
#    dedicado.
set -euo pipefail
cd "$(dirname "$0")/.."

script=$PWD/bin/start.sh
example=$PWD/node.conf.example
fake_gcp=$PWD/tests/fake-gcp.py
wazuh_dir=$(cd ../wazuh && pwd)

step=ambiente
fail() {
  echo "FALHOU ($step): $*" >&2
  exit 1
}
ok() { printf 'ok     %s\n' "$step"; }

command -v python3 >/dev/null || fail 'falta python3'
work=$(readlink -f "$(mktemp -d)")
server_pid=''
trap 'if [[ -n $server_pid ]]; then kill "$server_pid" 2>/dev/null || true; fi; rm -rf "$work"' EXIT
mkdir -p "$work/bin"

state=$work/gcp
mkdir -p "$state/attributes" "$state/fail" "$state/deny"
python3 "$fake_gcp" "$state" 2>"$work/gcp.err" &
server_pid=$!
for _ in $(seq 100); do
  if [[ -s $state/port ]]; then break; fi
  sleep 0.1
done
[[ -s $state/port ]] || fail "o servidor falso não subiu: $(cat "$work/gcp.err")"
port=$(<"$state/port")

admin_password=Abcde-Fghij-Kmnop-Qrstu
token=ya29.token-ficticio-do-teste-0123456789
tenant_a=0190a8c0-0000-7000-8000-00000000000a
tenant_b=0190a8c0-0000-7000-8000-00000000000b
email_a=admin@cliente-celula-a.example
admin_b64=$(printf '{"email":"%s","password":"%s","expiresAt":"2026-11-07T12:00:00.000Z"}' "$email_a" "$admin_password" |
  base64 -w0)

real_curl=$(command -v curl)
cat >"$work/bin/curl" <<EOF
#!/bin/bash
printf '%s\n' "\$*" >>"$state/curl-argv.log"
exec "$real_curl" "\$@"
EOF
# Secret Manager pelo gcloud (o render lê o cofre do túnel): nenhum cofre tem valor.
cat >"$work/bin/gcloud" <<'EOF'
#!/bin/bash
echo "ERROR: (gcloud.secrets.versions.access) NOT_FOUND: Secret not found or has no versions." >&2
exit 1
EOF
# Sem root: o `install` de verdade, sem o dono (-o/-g).
real_install=$(command -v install)
cat >"$work/bin/install" <<EOF
#!/bin/bash
args=()
while ((\$#)); do
  case \$1 in
    -o | -g) shift 2 ;;
    *) args+=("\$1"); shift ;;
  esac
done
exec "$real_install" "\${args[@]}"
EOF
# O Docker: o `compose ... down` e o `compose ... run --rm -T ... bootstrap`. Anota os argumentos e, no bootstrap, o
# ambiente que o contêiner receberia (os nomes pedidos com -e, com o valor do ambiente de quem chamou) e, pelo
# comportamento do cenário ($STATE/behavior), deixa o arquivo na pasta montada com -v.
cat >"$work/bin/docker" <<'EOF'
#!/bin/bash
set -euo pipefail
printf 'docker %s\n' "$*" >>"$STATE/docker.log"
args=("$@")
[[ ${args[-1]} == down ]] && exit 0
[[ " $* " == *' run --rm -T '* && ${args[-1]} == bootstrap ]] || { echo "docker simulado: chamada inesperada: $*" >&2; exit 2; }
mount='' names=()
for ((i = 0; i < ${#args[@]}; i++)); do
  case ${args[i]} in
    -v) mount=${args[i + 1]} ;;
    -e) names+=("${args[i + 1]}") ;;
  esac
done
for name in "${names[@]}"; do printf '%s=%s\n' "$name" "${!name-<ausente>}"; done >"$STATE/bootstrap-env"
[[ -z $mount ]] && exit 0
dir=${mount%%:*}
[[ ${mount#*:} == /run/verax-bootstrap && -d $dir ]] || { echo "docker simulado: montagem inesperada: $mount" >&2; exit 2; }
write() { printf '{"email":"%s","password":"%s","expiresAt":"2026-11-07T12:00:00.000Z"}' "$1" "$ADMIN_PASSWORD" >"$dir/$2.json"; }
case $(cat "$STATE/behavior") in
  admin)
    write "$BOOTSTRAP_ADMIN_EMAIL" admin-bootstrap
    echo 'Senhas para o Secret Manager: admin-bootstrap.'
    ;;
  admin-then-fail)
    write "$BOOTSTRAP_ADMIN_EMAIL" admin-bootstrap
    echo 'Falha no primeiro acesso do cliente da célula (Error).' >&2
    exit 1
    ;;
  support) write suporte@verax.example support-bootstrap ;;
  refuse)
    echo 'O plano do cliente ainda não chegou à célula.' >&2
    exit 1
    ;;
  none) echo 'Nenhuma senha nova: nada para gravar no Secret Manager.' ;;
esac
EOF
chmod +x "$work/bin/curl" "$work/bin/gcloud" "$work/bin/install" "$work/bin/docker"

# Uma raiz nova por cenário: o node.conf de exemplo (sem comentários) no perfil standard, com as linhas do cenário
# (`-CHAVE` tira a linha), as senhas internas (as do Wazuh no formato do pacote), o images.env e o start.sh com os
# caminhos e os dois endereços trocados (e sem espera entre as tentativas).
# shellcheck source=SCRIPTDIR/../../wazuh/scripts/lib-passwords.sh
source "$wazuh_dir/scripts/lib-passwords.sh"
# As senhas do Wazuh, as mesmas em todo cenário (os arquivos de ambiente de dois cenários são comparados byte a byte).
declare -A wazuh_passwords=()
for secret in wazuh-indexer-admin wazuh-indexer-filebeat wazuh-api wazuh-indexer-read wazuh-api-stats; do
  wazuh_passwords[$secret]=$(new_wazuh_password)
done
new_root() { # <cenário> <pasta> [CHAVE=valor | -CHAVE...]
  step=$1
  root=$work/root-$2
  mkdir -p "$root/etc/verax" "$root/var/lib/verax/secrets"
  grep -v -e '^#' -e '^$' "$example" >"$root/etc/verax/node.conf"
  sed -i 's|^NODE_PROFILE=.*|NODE_PROFILE=standard|' "$root/etc/verax/node.conf"
  local secret line
  for secret in postgres-master postgres-migrator postgres-app better-auth-secret csrf-secret; do
    printf 'interno-%s' "$secret" >"$root/var/lib/verax/secrets/$secret"
  done
  for secret in wazuh-indexer-admin wazuh-indexer-filebeat wazuh-api wazuh-indexer-read wazuh-api-stats; do
    printf '%s' "${wazuh_passwords[$secret]}" >"$root/var/lib/verax/secrets/$secret"
  done
  printf 'API_IMAGE=exemplo/api@sha256:%064d\nNODE_VERSION=%064d\n' 0 0 >"$root/etc/verax/images.env"
  for line in "${@:3}"; do
    if [[ $line == -* ]]; then
      sed -i "/^${line#-}=/d" "$root/etc/verax/node.conf"
    elif grep -q "^${line%%=*}=" "$root/etc/verax/node.conf"; then
      sed -i "s|^${line%%=*}=.*|$line|" "$root/etc/verax/node.conf"
    else
      echo "$line" >>"$root/etc/verax/node.conf"
    fi
  done
  sed -e "s#/etc/verax/node.conf#$root/etc/verax/node.conf#g" \
    -e "s#/var/lib/verax/secrets#$root/var/lib/verax/secrets#g" \
    -e "s#=/run/verax\$#=$root/run/verax#" \
    -e "s#^wazuh=/opt/verax/wazuh\$#wazuh=$wazuh_dir#" \
    -e "s#^images_env=/etc/verax/images.env\$#images_env=$root/etc/verax/images.env#" \
    -e "s#^metadata_url=.*#metadata_url=http://127.0.0.1:$port/computeMetadata/v1#" \
    -e "s#^secretmanager_url=.*#secretmanager_url=http://127.0.0.1:$port/v1#" \
    -e 's#^retry_pause=.*#retry_pause=0#' "$script" >"$root/start.sh"
  : >"$state/docker.log"
  : >"$state/requests.log"
  : >"$state/curl-argv.log"
  rm -rf "$state/secrets" "$state/bootstrap-env"
  rm -f "$state"/fail/* "$state"/deny/*
}

# O start.sh como o systemd o roda, num ambiente limpo. Devolve o código de saída; a saída vai para $root/out.
start() { # <comando> [argumento] [CHAVE=valor...]
  local code=0 args=("$1")
  shift
  if [[ $# -gt 0 && $1 != *=* ]]; then
    args+=("$1")
    shift
  fi
  env -i PATH="$work/bin:$PATH" STATE="$state" ADMIN_PASSWORD="$admin_password" "$@" \
    "$BASH" "$root/start.sh" "${args[@]}" >"$root/out" 2>&1 || code=$?
  return "$code"
}

n=0
cell_conf=(NODE_MODE=cell CELL_DOMAIN=exemplo.com.br CELL_STAFF_SLUG=verax -PLAN)
env_files() { (cd "$root/run/verax" 2>/dev/null && find . -maxdepth 1 -type f -name '*.env' | sed 's|^\./||' | LC_ALL=C sort | tr '\n' ' '); }

# --- 1. Os arquivos de ambiente ---------------------------------------------------------------------------------------
new_root "dedicado: byte a byte igual com NODE_MODE=dedicated" dedicado
start render || fail "o render falhou: $(cat "$root/out")"
dedicated_api=$(cat "$root/run/verax/api.env")
dedicated_worker=$(cat "$root/run/verax/worker.env")
grep -q -e NODE_MODE -e CELL_ -e TENANT_BOOTSTRAP <<<"$dedicated_api$dedicated_worker" && fail "o dedicado ganhou variável da célula"
new_root "dedicado: byte a byte igual com NODE_MODE=dedicated" dedicado-explicito NODE_MODE=dedicated
start render || fail "o render falhou: $(cat "$root/out")"
[[ "$(cat "$root/run/verax/api.env")" == "$dedicated_api" && "$(cat "$root/run/verax/worker.env")" == "$dedicated_worker" ]] ||
  fail "NODE_MODE=dedicated mudou os arquivos de ambiente"
ok

new_root "célula: o modo no lugar do plano, sem o tópico pelo nome do projeto" celula "${cell_conf[@]}"
start render || fail "o render falhou: $(cat "$root/out")"
cell_lines="NODE_MODE='cell'
CELL_DOMAIN='exemplo.com.br'
CELL_STAFF_SLUG='verax'"
expected_api=${dedicated_api/PLAN=\'interno\'/$cell_lines}
expected_api=$(grep -v '^GCP_SINK_TOPIC_PREFIX=' <<<"$expected_api")
[[ "$(cat "$root/run/verax/api.env")" == "$expected_api" ]] ||
  fail "api.env inesperado: $(diff <(echo "$expected_api") "$root/run/verax/api.env" || true)"
worker_lines="NODE_MODE='cell'
TENANT_BOOTSTRAP_DIR='/run/tenant-bootstrap'
TENANT_BOOTSTRAP_STATUS_DIR='/run/tenant-bootstrap-status'"
expected_worker=${dedicated_worker/PLAN=\'interno\'/$worker_lines}
[[ "$(cat "$root/run/verax/worker.env")" == "$expected_worker" ]] ||
  fail "worker.env inesperado: $(diff <(echo "$expected_worker") "$root/run/verax/worker.env" || true)"
# Os destinos do worker.env são os do compose.cell.yaml.
grep -qx '      - /run/verax/tenant-bootstrap:/run/tenant-bootstrap' compose.cell.yaml || fail "o compose.cell.yaml não monta a pasta dos pedidos"
grep -qx '      - /run/verax/tenant-bootstrap-status:/run/tenant-bootstrap-status:ro' compose.cell.yaml ||
  fail "o compose.cell.yaml não monta a pasta de estado só leitura"
ok

new_root "célula: o ID da conta de serviço da VM fica de fora, com o aviso" celula-sa "${cell_conf[@]}" \
  NODE_SA_UNIQUE_ID=123456789012345678901 AWS_WEB_IDENTITY_AUDIENCE=https://control.exemplo.com.br/aws-reader
start render || fail "o render falhou: $(cat "$root/out")"
grep -q NODE_SA_UNIQUE_ID "$root/run/verax/api.env" "$root/run/verax/worker.env" && fail "o ID da conta de serviço da VM entrou"
grep -q "NODE_SA_UNIQUE_ID não vale na célula" "$root/out" || fail "sem o aviso: $(cat "$root/out")"
grep -q "^AWS_WEB_IDENTITY_AUDIENCE=" "$root/run/verax/api.env" || fail "o audience saiu junto"
ok

refusals=(
  "PLAN=interno|não aceita PLAN"
  "PLAN_MAX_USERS=5|não aceita PLAN_MAX_USERS"
  "NODE_PROFILE=lean|só no perfil standard"
  "CUSTOMER_MODE=true|não usa o CUSTOMER_MODE"
  "WAZUH_AGENTS=true|não tem os agentes do Wazuh"
  "CELL_DOMAIN=Exemplo.com.br|CELL_DOMAIN inválido"
  "CELL_DOMAIN=exemplo.com.br.|CELL_DOMAIN inválido"
  "CELL_DOMAIN=exemplo|CELL_DOMAIN inválido"
  "-CELL_DOMAIN|CELL_DOMAIN inválido"
  "CELL_STAFF_SLUG=Verax|CELL_STAFF_SLUG inválido"
  "CELL_STAFF_SLUG=ab|CELL_STAFF_SLUG inválido"
  "CELL_STAFF_SLUG=ab--cd|CELL_STAFF_SLUG inválido"
  "-CELL_STAFF_SLUG|CELL_STAFF_SLUG inválido"
  "NODE_MODE=celula|NODE_MODE inválido"
)
for case_ in "${refusals[@]}"; do
  line=${case_%%|*}
  new_root "célula: o render recusa ($line) sem escrever nada" "recusa-$((++n))" "${cell_conf[@]}" "$line"
  if start render; then fail "o render deveria parar"; fi
  grep -q -F "${case_#*|}" "$root/out" || fail "sem o motivo: $(cat "$root/out")"
  [[ -z $(env_files) ]] || fail "escreveu arquivo de ambiente mesmo parando: $(env_files)"
  ok
done

new_root "projeto do Compose: o compose.cell.yaml só na célula" compose-dedicado
start down || fail "o down falhou: $(cat "$root/out")"
grep -q compose.cell.yaml "$state/docker.log" && fail "o dedicado somou o compose.cell.yaml"
new_root "projeto do Compose: o compose.cell.yaml só na célula" compose-celula "${cell_conf[@]}"
start down || fail "o down falhou: $(cat "$root/out")"
grep -q -- '-f /opt/verax/compose.wazuh.yaml -f /opt/verax/compose.cell.yaml ' "$state/docker.log" ||
  fail "a célula não somou o compose.cell.yaml: $(cat "$state/docker.log")"
ok

# --- 2. O primeiro administrador de cada cliente -----------------------------------------------------------------------
versions() { # <segredo>: quantas versões o Secret Manager falso tem
  find "$state/secrets/$1" -type f 2>/dev/null | wc -l | tr -d ' '
}
request() { # <id> <conteúdo>
  mkdir -p "$root/run/verax/tenant-bootstrap"
  printf '%s' "$2" >"$root/run/verax/tenant-bootstrap/$1"
}
status_of() { cat "$root/run/verax/tenant-bootstrap-status/$1" 2>/dev/null || echo '<sem resposta>'; }
pending_request() { [[ -e $root/run/verax/tenant-bootstrap/$1 ]]; }
no_secret_leaks() {
  local file
  for file in "$root/out" "$state/curl-argv.log" "$state/docker.log" "$state/requests.log"; do
    if grep -q -F -e "$admin_password" -e "$token" -e "$admin_b64" "$file"; then
      fail "senha ou token em $(basename "$file"): $(cat "$file")"
    fi
  done
  if grep -rq -F -e "$admin_password" -e "$token" -e "$admin_b64" "$root/run/verax" --exclude-dir=tenant-bootstrap-payloads; then
    fail "senha ou token em arquivo do /run/verax fora da pasta das senhas"
  fi
  grep -q -F "$email_a" "$root/out" "$state/docker.log" && fail "o e-mail saiu na tela ou nos argumentos do Docker"
  return 0
}

new_root "tenant-bootstrap: fora da célula, recusado" tb-dedicado
start render || fail "o render falhou: $(cat "$root/out")"
code=0
start tenant-bootstrap "$tenant_a" || code=$?
[[ $code == 2 ]] || fail "saída $code: $(cat "$root/out")"
grep -q 'só existe na célula' "$root/out" || fail "sem o motivo: $(cat "$root/out")"
[[ ! -s $state/docker.log ]] || fail "chamou o Docker fora da célula"
ok

new_root "tenant-bootstrap: o pedido vira a conta, e a senha vai para o cofre do cliente" tb "${cell_conf[@]}"
start render || fail "o render falhou: $(cat "$root/out")"
request "$tenant_a" $'slug=cliente-a\nemail='"$email_a"$'\n'
echo admin >"$state/behavior"
start tenant-bootstrap "$tenant_a" || fail "falhou: $(cat "$root/out")"
[[ $(versions vxt-cliente-a-admin-bootstrap) == 1 ]] || fail "versões: $(versions vxt-cliente-a-admin-bootstrap)"
[[ "$(cat "$state/secrets/vxt-cliente-a-admin-bootstrap/1")" == "{\"email\":\"$email_a\",\"password\":\"$admin_password\",\"expiresAt\":\"2026-11-07T12:00:00.000Z\"}" ]] ||
  fail "conteúdo da versão: $(cat "$state/secrets/vxt-cliente-a-admin-bootstrap/1")"
[[ $(grep -c '^POST /v1/projects/projeto-do-no/secrets/vxt-cliente-a-admin-bootstrap:addVersion authorized=True' "$state/requests.log") == 1 ]] ||
  fail "pedidos: $(cat "$state/requests.log")"
expected_env=$(printf '%s\n' BOOTSTRAP_MODE=cell-tenant "BOOTSTRAP_TENANT_ID=$tenant_a" BOOTSTRAP_TENANT_SLUG=cliente-a \
  "BOOTSTRAP_ADMIN_EMAIL=$email_a" BOOTSTRAP_RENEW_ADMIN_PASSWORD=false)
[[ "$(cat "$state/bootstrap-env")" == "$expected_env" ]] || fail "ambiente do contêiner: $(cat "$state/bootstrap-env")"
grep -q -F -- "-v $root/run/verax/tenant-bootstrap-payloads/$tenant_a:/run/verax-bootstrap " "$state/docker.log" ||
  fail "montagem: $(cat "$state/docker.log")"
grep -q -- '-f /opt/verax/compose.cell.yaml' "$state/docker.log" || fail "o bootstrap rodou fora do projeto da célula"
pending_request "$tenant_a" && fail "o pedido atendido ficou na pasta"
[[ $(status_of "$tenant_a") == ok ]] || fail "resposta: $(status_of "$tenant_a")"
[[ $(stat -c %a "$root/run/verax/tenant-bootstrap") == 1770 ]] || fail "pasta dos pedidos sem 1770"
[[ $(stat -c %a "$root/run/verax/tenant-bootstrap-status") == 755 ]] || fail "pasta das respostas sem 0755"
[[ $(stat -c %a "$root/run/verax/tenant-bootstrap-payloads") == 700 ]] || fail "pasta das senhas sem 0700"
[[ -z $(find "$root/run/verax/tenant-bootstrap-payloads" -mindepth 1) ]] || fail "sobrou arquivo na pasta das senhas"
no_secret_leaks
ok

step="tenant-bootstrap-pending: todos os pedidos, só os nomes no formato de id"
: >"$state/docker.log"
request "$tenant_a" $'slug=cliente-a\nemail='"$email_a"
request "$tenant_b" $'email=admin@cliente-celula-b.example\nslug=cliente-b\n'
request ".$tenant_b.tmp" 'slug=cliente-c'
request nao-e-id 'slug=cliente-d'
start tenant-bootstrap-pending || fail "falhou: $(cat "$root/out")"
[[ "$(versions vxt-cliente-a-admin-bootstrap) $(versions vxt-cliente-b-admin-bootstrap)" == '2 1' ]] ||
  fail "versões: $(versions vxt-cliente-a-admin-bootstrap) $(versions vxt-cliente-b-admin-bootstrap)"
[[ $(grep -c ' bootstrap$' "$state/docker.log") == 2 ]] || fail "chamadas: $(cat "$state/docker.log")"
if ! pending_request ".$tenant_b.tmp" || ! pending_request nao-e-id; then fail "apagou o que não é pedido"; fi
[[ "$(status_of "$tenant_a") $(status_of "$tenant_b")" == 'ok ok' ]] || fail "respostas"
no_secret_leaks
ok

bad_requests=(
  "subdomínio fora do formato|slug=Cliente-A"$'\n'"email=$email_a"
  "subdomínio com -- na 3ª posição|slug=ab--cd"$'\n'"email=$email_a"
  "sem o subdomínio|email=$email_a"
  "e-mail fora do formato|slug=cliente-a"$'\n'"email=sem-arroba"
  "e-mail com espaço|slug=cliente-a"$'\n'"email=a b@exemplo.com"
  "linha a mais|slug=cliente-a"$'\n'"email=$email_a"$'\n'"PATH=/tmp"
  "subdomínio repetido|slug=cliente-a"$'\n'"slug=cliente-b"$'\n'"email=$email_a"
)
for case_ in "${bad_requests[@]}"; do
  new_root "tenant-bootstrap: pedido recusado sem chamar o Docker (${case_%%|*})" "tb-recusa-$((++n))" "${cell_conf[@]}"
  start render || fail "o render falhou: $(cat "$root/out")"
  : >"$state/docker.log"
  request "$tenant_a" "${case_#*|}"
  if start tenant-bootstrap "$tenant_a"; then fail "deveria recusar"; fi
  grep -q 'nada foi feito' "$root/out" || fail "sem o motivo: $(cat "$root/out")"
  [[ ! -s $state/docker.log ]] || fail "chamou o Docker"
  [[ $(status_of "$tenant_a") == error ]] || fail "resposta: $(status_of "$tenant_a")"
  pending_request "$tenant_a" || fail "o pedido recusado saiu da pasta"
  grep -q -F -e "$email_a" -e 'sem-arroba' "$root/out" && fail "valor do pedido na tela"
  ok
done

new_root "tenant-bootstrap: pedido que é um link, ou grande demais" tb-link "${cell_conf[@]}"
start render || fail "o render falhou: $(cat "$root/out")"
printf 'slug=cliente-a\nemail=%s\n' "$email_a" >"$work/alvo"
mkdir -p "$root/run/verax/tenant-bootstrap"
ln -s "$work/alvo" "$root/run/verax/tenant-bootstrap/$tenant_a"
if start tenant-bootstrap "$tenant_a"; then fail "seguiu o link"; fi
grep -q 'não é um arquivo comum' "$root/out" || fail "sem o motivo: $(cat "$root/out")"
rm "$root/run/verax/tenant-bootstrap/$tenant_a"
request "$tenant_a" "slug=cliente-a"$'\n'"email=$email_a"$'\n'"$(printf 'x%.0s' {1..600})"
if start tenant-bootstrap "$tenant_a"; then fail "aceitou o pedido grande"; fi
grep -q 'passa de 512 bytes' "$root/out" || fail "sem o motivo: $(cat "$root/out")"
[[ ! -s $state/docker.log ]] || fail "chamou o Docker"
ok

new_root "tenant-bootstrap: o contêiner recusa (o plano ainda não chegou): o pedido fica, a resposta é error" tb-plano "${cell_conf[@]}"
start render || fail "o render falhou: $(cat "$root/out")"
request "$tenant_a" $'slug=cliente-a\nemail='"$email_a"
echo refuse >"$state/behavior"
if start tenant-bootstrap "$tenant_a"; then fail "deveria falhar"; fi
pending_request "$tenant_a" || fail "o pedido saiu"
[[ $(status_of "$tenant_a") == error ]] || fail "resposta: $(status_of "$tenant_a")"
[[ $(versions vxt-cliente-a-admin-bootstrap) == 0 ]] || fail "gravou sem senha"
ok

new_root "tenant-bootstrap: a senha que não chegou ao cofre vai antes, no cofre do subdomínio guardado" tb-pendente "${cell_conf[@]}"
start render || fail "o render falhou: $(cat "$root/out")"
request "$tenant_a" $'slug=cliente-a\nemail='"$email_a"
echo admin >"$state/behavior"
: >"$state/deny/vxt-cliente-a-admin-bootstrap"
if start tenant-bootstrap "$tenant_a"; then fail "deveria falhar sem permissão no cofre"; fi
grep -q 'PERMISSION_DENIED' "$root/out" || fail "sem o motivo: $(cat "$root/out")"
[[ -f $root/run/verax/tenant-bootstrap-payloads/$tenant_a/admin-bootstrap.json ]] || fail "a senha não ficou para a próxima"
[[ $(status_of "$tenant_a") == error ]] || fail "resposta: $(status_of "$tenant_a")"
# O pedido muda de subdomínio no meio (o worker comprometido): a senha pendente vai para o cofre do subdomínio que o host
# guardou, e o pedido novo é conferido no banco pelo contêiner.
rm "$state/deny/vxt-cliente-a-admin-bootstrap"
request "$tenant_a" $'slug=cliente-x\nemail='"$email_a"
echo none >"$state/behavior"
: >"$state/docker.log"
start tenant-bootstrap "$tenant_a" || fail "falhou: $(cat "$root/out")"
[[ "$(versions vxt-cliente-a-admin-bootstrap) $(versions vxt-cliente-x-admin-bootstrap)" == '1 0' ]] ||
  fail "a senha pendente foi para outro cofre"
grep -qx 'BOOTSTRAP_TENANT_SLUG=cliente-x' "$state/bootstrap-env" || fail "o contêiner não recebeu o subdomínio do pedido"
[[ $(status_of "$tenant_a") == ok ]] || fail "resposta: $(status_of "$tenant_a")"
no_secret_leaks
ok

new_root "tenant-bootstrap: o contêiner falha depois de gerar a senha: ela vai para o cofre, e o pedido fica" tb-falha "${cell_conf[@]}"
start render || fail "o render falhou: $(cat "$root/out")"
request "$tenant_a" $'slug=cliente-a\nemail='"$email_a"
echo admin-then-fail >"$state/behavior"
if start tenant-bootstrap "$tenant_a"; then fail "deveria falhar"; fi
[[ $(versions vxt-cliente-a-admin-bootstrap) == 1 ]] || fail "a senha gerada não foi para o cofre"
pending_request "$tenant_a" || fail "o pedido saiu"
[[ $(status_of "$tenant_a") == error ]] || fail "resposta"
no_secret_leaks
ok

new_root "tenant-bootstrap: nada de conta de suporte na célula" tb-suporte "${cell_conf[@]}"
start render || fail "o render falhou: $(cat "$root/out")"
request "$tenant_a" $'slug=cliente-a\nemail='"$email_a"
echo support >"$state/behavior"
if start tenant-bootstrap "$tenant_a"; then fail "aceitou a senha de suporte"; fi
grep -q 'support-bootstrap.json não existe na célula' "$root/out" || fail "sem o motivo: $(cat "$root/out")"
[[ ! -d $state/secrets ]] || fail "gravou no Secret Manager"
ok

new_root "tenant-bootstrap: id fora do formato" tb-id "${cell_conf[@]}"
start render || fail "o render falhou: $(cat "$root/out")"
for bad in '' ../etc/passwd 0190A8C0-0000-7000-8000-00000000000A; do
  code=0
  start tenant-bootstrap "$bad" || code=$?
  [[ $code == 2 ]] || fail "id '$bad': saída $code"
done
ok

# --- 3. A adoção do cliente do nó que vira célula --------------------------------------------------------------------
new_root "cell-adopt: na célula, o subdomínio da equipe por padrão" adopt-celula "${cell_conf[@]}"
start render || fail "o render falhou: $(cat "$root/out")"
echo none >"$state/behavior"
start cell-adopt || fail "falhou: $(cat "$root/out")"
[[ "$(cat "$state/bootstrap-env")" == $'BOOTSTRAP_MODE=cell-adopt\nBOOTSTRAP_TENANT_SLUG=verax' ]] ||
  fail "ambiente do contêiner: $(cat "$state/bootstrap-env")"
ok

new_root "cell-adopt: no dedicado (antes da troca), o subdomínio é obrigatório" adopt-dedicado
start render || fail "o render falhou: $(cat "$root/out")"
code=0
start cell-adopt || code=$?
[[ $code == 2 ]] || fail "saída $code sem o subdomínio"
for bad in Verax ab ab--cd; do
  code=0
  start cell-adopt "$bad" || code=$?
  [[ $code == 2 ]] || fail "aceitou o subdomínio $bad"
done
[[ ! -s $state/docker.log ]] || fail "chamou o Docker"
start cell-adopt verax || fail "falhou: $(cat "$root/out")"
grep -qx 'BOOTSTRAP_TENANT_SLUG=verax' "$state/bootstrap-env" || fail "ambiente do contêiner: $(cat "$state/bootstrap-env")"
grep -q compose.cell.yaml "$state/docker.log" && fail "o dedicado somou o compose.cell.yaml"
ok

echo 'célula: todas as verificações passaram.'
