#!/bin/bash
# Testes da chave do cofre de credenciais no pacote do nó (bin/install.sh e bin/start.sh), sem root e sem tocar na
# máquina nem na nuvem. Os dois scripts rodam numa pasta temporária que faz o papel da raiz: /etc/verax, /opt/verax,
# /var/lib/verax, /run/verax e /etc/systemd/system viram caminhos dentro dela. Os comandos que mexem na máquina ou na
# nuvem (gcloud, docker, systemctl, iptables, chown e id) são simulados e anotam cada chamada; o `install` tira só o
# dono (-o/-g), que pede root; o openssl, o base64, o grep e o resto são os de verdade.
#
# O gcloud simulado faz o papel do Secret Manager: guarda as versões do segredo `credentials-key` numa pasta, com o
# estado de cada uma, e responde como ele: NOT_FOUND depois da última versão, FAILED_PRECONDITION na desativada ou
# destruída e PERMISSION_DENIED quando o segredo não existe (a VM só tem permissão em cada segredo, então um segredo
# que não existe aparece assim). O conteúdo sai em base64 com o alfabeto da URL, como no `--format='get(payload.data)'`.
#
#   bash infra/node/tests/vault-test.sh
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)

fail() {
  echo "FALHOU ($scenario): $*" >&2
  exit 1
}

scenario="ambiente"
# Como root, um caminho esquecido na troca escreveria na máquina de verdade; como usuário comum, ele falha.
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

# Cada simulado anota a chamada em $state/<comando>.log.
stub() {
  {
    # shellcheck disable=SC2016 # o simulado lê a variável quando roda, não quando é escrito
    printf '#!/bin/bash\nset -euo pipefail\nstate=$VERAX_TEST_STATE\n'
    cat
  } >"$work/bin/$1"
  chmod +x "$work/bin/$1"
}

stub gcloud <<'EOF'
echo "gcloud $*" >>"$state/gcloud.log"
[[ $1 == auth ]] && exit 0
[[ $1 == secrets && $2 == versions ]] || { echo "gcloud simulado: comando inesperado: $*" >&2; exit 64; }
action=$3 version='' secret='' format='' data_file=''
shift 3
while (($#)); do
  case $1 in
    --project) shift 2 ;;
    --secret) secret=$2; shift 2 ;;
    --format=*) format=${1#--format=}; shift ;;
    --data-file=*) data_file=${1#--data-file=}; shift ;;
    -*) echo "gcloud simulado: opção inesperada $1" >&2; exit 64 ;;
    *) if [[ $action == add ]]; then secret=$1; else version=$1; fi; shift ;;
  esac
done
name=projects/123456789012/secrets/$secret
vault=$state/vault
if [[ $secret == *-credentials-key ]]; then
  if [[ -e $state/vault-missing ]]; then
    echo "ERROR: (gcloud.secrets.versions.$action) PERMISSION_DENIED: Permission 'secretmanager.versions.$action' denied for resource '$name' (or it may not exist)." >&2
    exit 1
  fi
  if [[ -e $state/vault-offline ]]; then
    echo "ERROR: (gcloud.secrets.versions.$action) There was a problem refreshing your current auth tokens: Connection reset." >&2
    exit 1
  fi
  if [[ $action == add ]]; then
    [[ $data_file == - ]] || { echo "gcloud simulado: o add só aceita --data-file=-" >&2; exit 64; }
    next=$(($(find "$vault" -maxdepth 1 -name '[0-9]*' ! -name '*.*' | wc -l) + 1))
    cat >"$vault/$next"
    echo enabled >"$vault/$next.state"
    echo "Created version [$next] of the secret [$secret]." >&2
    exit 0
  fi
  [[ $version =~ ^[1-9][0-9]*$ ]] || { echo "gcloud simulado: versão inesperada $version" >&2; exit 64; }
  if [[ ! -e $vault/$version ]]; then
    echo "ERROR: (gcloud.secrets.versions.access) NOT_FOUND: Secret Version [$name/versions/$version] not found." >&2
    exit 1
  fi
  status=$(cat "$vault/$version.state")
  if [[ $status != enabled ]]; then
    echo "ERROR: (gcloud.secrets.versions.access) FAILED_PRECONDITION: Secret Version [$name/versions/$version] is in ${status^^} state." >&2
    exit 1
  fi
  case $format in
    'get(payload.data)') base64 -w0 <"$vault/$version" | tr '+/' '-_'; echo ;;
    'value(name)') echo "$name/versions/$version" ;;
    *) echo "gcloud simulado: formato inesperado na chave do cofre: '$format'" >&2; exit 64 ;;
  esac
  exit 0
fi
# Os outros segredos do nó (túnel e e-mail) ficam sem valor: o nó sobe sem o túnel, como na primeira vez.
echo "ERROR: (gcloud.secrets.versions.access) NOT_FOUND: Secret [$name] not found or has no versions." >&2
exit 1
EOF

stub docker <<'EOF'
echo "docker $*" >>"$state/docker.log"
EOF
stub systemctl <<'EOF'
echo "systemctl $*" >>"$state/systemctl.log"
EOF
stub iptables <<'EOF'
echo "iptables $*" >>"$state/iptables.log"
# A regra ainda não existe: o -C falha e o script a insere.
[[ $1 != -C ]]
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

# Uma instalação nova: raiz vazia, o pacote copiado com os caminhos trocados e o node.conf do exemplo com o cofre como
# o cenário pede (`absent` tira a linha, como no node.conf do nó da Verax de antes do cofre).
root='' state=''
new_node() { # <CREDENTIALS_VAULT: absent | true | false | outro valor>
  root=$work/root-$RANDOM$RANDOM
  state=$root.state
  mkdir -p "$root" "$state/vault" "$root/tmp"
  cp -R "$here" "$root/pkg"
  local file
  for file in "$root/pkg/bin/install.sh" "$root/pkg/bin/start.sh"; do
    sed -i -e "s#/etc/verax#$root/etc/verax#g" -e "s#/opt/verax#$root/opt/verax#g" \
      -e "s#/var/lib/verax#$root/var/lib/verax#g" -e "s#/run/verax#$root/run/verax#g" \
      -e "s#/etc/systemd/system#$root/etc/systemd/system#g" "$file"
  done
  mkdir -p "$root/etc/systemd/system"
  sed -e 's/^VERAX_GCP_PROJECT=.*/VERAX_GCP_PROJECT=projeto-de-teste/' -e '/^CREDENTIALS_VAULT=/d' \
    "$here/node.conf.example" >"$root/node.conf"
  if [[ $1 != absent ]]; then echo "CREDENTIALS_VAULT=$1" >>"$root/node.conf"; fi
}

# Roda um script do pacote na raiz de teste; a saída fica em $state/out (stdout e stderr juntos).
run() { # <install|start> [argumentos...]
  local script=$1
  shift
  if [[ $script == install ]]; then
    set -- --version "$(printf 'a%.0s' {1..40})" --api-digest "sha256:$(printf '1%.0s' {1..64})" \
      --migrate-digest "sha256:$(printf '2%.0s' {1..64})" --config "$root/node.conf"
    script=$root/pkg/bin/install.sh
  else
    script=$root/opt/verax/bin/start.sh
  fi
  PATH=$work/bin:$PATH VERAX_TEST_STATE=$state TMPDIR=$root/tmp bash "$script" "$@" >"$state/out" 2>&1
}

value_of() { # <arquivo de ambiente> <CHAVE>: o valor entre as aspas simples que o write_env escreve
  sed -n "s/^$2='\\(.*\\)'\$/\\1/p" "$root/run/verax/$1"
}
keys_of() { # <arquivo de ambiente>: as chaves, em ordem
  sed 's/=.*//' "$root/run/verax/$1" | tr '\n' ' '
}
add_version() { # <estado>: uma versão nova da chave no "Secret Manager", fora do install.sh
  local next
  next=$(($(find "$state/vault" -maxdepth 1 -name '[0-9]*' ! -name '*.*' | wc -l) + 1))
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$state/vault/$next" 2>/dev/null
  echo "$1" >"$state/vault/$next.state"
}
vault_calls() { # quantas vezes o gcloud foi chamado para o segredo do cofre
  local calls
  calls=$(grep -c 'credentials-key' "$state/gcloud.log" 2>/dev/null) || true
  echo "${calls:-0}"
}

lean_api='NODE_ENV LOG_LEVEL PORT WEB_ORIGIN API_ORIGIN TRUST_PROXY_HOPS BETTER_AUTH_SECRET CSRF_SECRET MAIL_TRANSPORT MAIL_FROM PLAN DATABASE_URL '
lean_worker='NODE_ENV LOG_LEVEL SYNC_SOURCES SYNC_INTERVAL_SECONDS PLAN DATABASE_URL '

for setting in absent false; do
  scenario="nó da Verax (CREDENTIALS_VAULT $setting)"
  new_node "$setting"
  run install || fail "install.sh falhou: $(cat "$state/out")"
  run start up || fail "start.sh up falhou: $(cat "$state/out")"
  [[ $(vault_calls) == 0 ]] || fail "o cofre foi consultado: $(grep credentials-key "$state/gcloud.log")"
  [[ $(keys_of api.env) == "$lean_api" ]] || fail "api.env mudou: $(keys_of api.env)"
  [[ $(keys_of worker.env) == "$lean_worker" ]] || fail "worker.env mudou: $(keys_of worker.env)"
  ! grep -q 'credentials-key|cofre de credenciais' "$state/out" || fail "a saída fala do cofre: $(cat "$state/out")"
  grep -q 'compose --project-directory .* up --detach worker' "$state/docker.log" || fail "o worker não subiu"
done

scenario="nó de cliente, primeira instalação"
new_node true
run install || fail "install.sh falhou: $(cat "$state/out")"
[[ -f $state/vault/1 && ! -e $state/vault/2 ]] || fail "o install.sh não gravou exatamente a versão 1"
grep -q 'Private-Key: (3072 bit' < <(openssl pkey -in "$state/vault/1" -noout -text 2>/dev/null) ||
  fail "a versão 1 não é uma chave privada RSA-3072"
grep -q 'Chave nova (RSA-3072) gravada no cofre verax-node-credentials-key' "$state/out" || fail "sem o aviso da chave nova"
# A chave privada só existe no "Secret Manager": nenhuma linha dela na raiz do nó (disco e /tmp).
line=$(sed -n 5p "$state/vault/1")
! grep -rqF -- "$line" "$root" || fail "a chave privada foi para o disco: $(grep -rlF -- "$line" "$root")"
run install || fail "a segunda instalação falhou: $(cat "$state/out")"
[[ ! -e $state/vault/2 ]] || fail "a segunda instalação gerou outra chave"
grep -q 'já tem chave' "$state/out" || fail "a segunda instalação não disse que o cofre já tem chave"
run start up || fail "start.sh up falhou: $(cat "$state/out")"
[[ $(keys_of api.env) == "${lean_api% DATABASE_URL } CREDENTIALS_PUBLIC_KEY CREDENTIALS_KEY_VERSION DATABASE_URL " ]] ||
  fail "api.env: $(keys_of api.env)"
[[ $(keys_of worker.env) == "${lean_worker% DATABASE_URL } CREDENTIALS_PRIVATE_KEYS CREDENTIALS_KEY_CURRENT DATABASE_URL " ]] ||
  fail "worker.env: $(keys_of worker.env)"
[[ $(value_of api.env CREDENTIALS_KEY_VERSION) == 1 && $(value_of worker.env CREDENTIALS_KEY_CURRENT) == 1 ]] ||
  fail "versão corrente diferente de 1"
public=$(value_of api.env CREDENTIALS_PUBLIC_KEY | base64 -d)
[[ $public == "$(openssl pkey -in "$state/vault/1" -pubout 2>/dev/null)" ]] || fail "a pública não é a da versão 1"
[[ $(value_of worker.env CREDENTIALS_PRIVATE_KEYS) == "1:$(base64 -w0 <"$state/vault/1")" ]] ||
  fail "as privadas do worker não são a versão 1 em base64"
# A API nunca recebe a privada, nem em base64.
! grep -q 'PRIVATE' "$root/run/verax/api.env" || fail "api.env com PRIVATE"
! grep -q PRIVATE < <(value_of api.env CREDENTIALS_PUBLIC_KEY | base64 -d) || fail "api.env com chave privada"
[[ $(stat -c %a "$root/run/verax/worker.env") == 600 && $(stat -c %a "$root/run/verax/api.env") == 600 ]] ||
  fail "arquivos de ambiente fora do 0600"

scenario="rotação: versões desativadas e destruídas ficam de fora; a mais alta ativa é a corrente"
new_node true
add_version destroyed
add_version enabled
add_version disabled
add_version enabled
run install || fail "install.sh falhou: $(cat "$state/out")"
[[ ! -e $state/vault/5 ]] || fail "o install.sh gerou chave com a versão 1 destruída"
run start up || fail "start.sh up falhou: $(cat "$state/out")"
expected="2:$(base64 -w0 <"$state/vault/2"),4:$(base64 -w0 <"$state/vault/4")"
[[ $(value_of worker.env CREDENTIALS_PRIVATE_KEYS) == "$expected" ]] || fail "as privadas não são as versões 2 e 4"
[[ $(value_of worker.env CREDENTIALS_KEY_CURRENT) == 4 && $(value_of api.env CREDENTIALS_KEY_VERSION) == 4 ]] ||
  fail "a corrente não é a 4"
[[ $(value_of api.env CREDENTIALS_PUBLIC_KEY | base64 -d) == "$(openssl pkey -in "$state/vault/4" -pubout 2>/dev/null)" ]] ||
  fail "a pública não é a da versão 4"
# Da 1 à 5 (a primeira que não existe), uma leitura cada.
[[ $(vault_calls) == 6 ]] || fail "leituras do cofre: $(vault_calls) (1 do install.sh e 5 do start.sh)"

scenario="nenhuma versão ativa: a API e o worker sobem sem o cofre, com aviso"
new_node true
add_version disabled
run install || fail "install.sh falhou: $(cat "$state/out")"
[[ ! -e $state/vault/2 ]] || fail "o install.sh gerou chave com a versão 1 desativada"
run start up || fail "start.sh up falhou: $(cat "$state/out")"
grep -q 'AVISO: o cofre de credenciais (verax-node-credentials-key) não tem nenhuma versão ativa' "$state/out" ||
  fail "sem o aviso: $(cat "$state/out")"
[[ $(keys_of api.env) == "$lean_api" && $(keys_of worker.env) == "$lean_worker" ]] || fail "variáveis do cofre sem chave"
grep -q 'up --detach worker' "$state/docker.log" || fail "o worker não subiu"

scenario="segredo inexistente ou sem permissão: install.sh e start.sh param"
new_node true
: >"$state/vault-missing"
if run install; then fail "o install.sh seguiu sem o cofre"; fi
grep -q 'Falha ao ler o cofre verax-node-credentials-key' "$state/out" || fail "sem a mensagem: $(cat "$state/out")"
grep -q 'PERMISSION_DENIED' "$state/out" || fail "sem o motivo do gcloud"
grep -q 'restart verax-node' "$state/systemctl.log" 2>/dev/null && fail "o serviço subiu"
# O pacote já instalado (de uma instalação que deu certo antes) e o cofre que some: a partida para antes de subir.
rm "$state/vault-missing"
add_version enabled
run install || fail "install.sh falhou: $(cat "$state/out")"
: >"$state/vault-missing"
rm -f "$state/docker.log"
if run start up; then fail "o start.sh seguiu sem o cofre"; fi
grep -q 'Falha ao ler a versão 1 do segredo verax-node-credentials-key' "$state/out" ||
  fail "sem a mensagem: $(cat "$state/out")"
! grep -q ' up ' "$state/docker.log" 2>/dev/null || fail "o nó subiu sem o cofre"

scenario="rede fora do ar no meio da leitura: a partida para"
rm "$state/vault-missing"
: >"$state/vault-offline"
if run start up; then fail "o start.sh seguiu sem ler o cofre"; fi
grep -q 'Falha ao ler a versão 1' "$state/out" || fail "sem a mensagem: $(cat "$state/out")"

scenario="conteúdo que não é chave privada: a partida para"
new_node true
printf 'nao-e-uma-chave' >"$state/vault/1"
echo enabled >"$state/vault/1.state"
run install || fail "install.sh falhou: $(cat "$state/out")"
if run start up; then fail "o start.sh aceitou um conteúdo que não é chave"; fi
grep -q 'A versão 1 do segredo verax-node-credentials-key não é uma chave privada legível' "$state/out" ||
  fail "sem a mensagem: $(cat "$state/out")"

scenario="CREDENTIALS_VAULT inválido"
new_node sim
if run install; then fail "o install.sh aceitou CREDENTIALS_VAULT=sim"; fi
grep -q 'CREDENTIALS_VAULT inválido' "$state/out" || fail "sem a mensagem: $(cat "$state/out")"

echo "vault-test: todos os cenários passaram"
