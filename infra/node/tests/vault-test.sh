#!/bin/bash
# Testes da chave do cofre de credenciais no pacote do nó (bin/install.sh e bin/start.sh), sem root e sem tocar na
# máquina nem na nuvem. Os dois scripts rodam numa pasta temporária que faz o papel da raiz: /etc/verax, /opt/verax,
# /var/lib/verax, /run/verax e /etc/systemd/system viram caminhos dentro dela. Os comandos que mexem na máquina ou na
# nuvem (gcloud, docker, systemctl, iptables, iptables-restore, chown e id) são simulados e anotam cada chamada; o
# `install` tira só o dono (-o/-g), que pede root; o openssl, o base64, o grep e o resto são os de verdade.
#
# O gcloud simulado faz o papel do Secret Manager: guarda as versões do segredo `credentials-key` numa pasta, com o
# estado de cada uma, e responde como ele: NOT_FOUND depois da última versão, FAILED_PRECONDITION na desativada ou
# destruída e PERMISSION_DENIED quando o segredo não existe (a VM só tem permissão em cada segredo, então um segredo
# que não existe aparece assim). O conteúdo sai em base64 com o alfabeto da URL, como no `--format='get(payload.data)'`.
#
# As chaves privadas chegam ao worker pelo arquivo /run/verax/vault/worker-keys (a pasta é montada nele pelo
# compose.vault.yaml), nunca pelo worker.env: o ambiente de um contêiner fica gravado no disco, na configuração do
# Docker. Os cenários conferem isso, e também que o nó da Verax (sem CREDENTIALS_VAULT, ou false) não lê nada, não ganha
# a pasta nem o compose.vault.yaml e escreve os mesmos arquivos de ambiente de antes.
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
    'get(payload.data)')
      data=$(base64 -w0 <"$vault/$version" | tr '+/' '-_')
      # Sem o `=` do fim, como um gcloud que o cortasse entregaria (o start.sh o repõe).
      if [[ -e $state/vault-unpadded ]]; then data=${data%%=*}; fi
      echo "$data" ;;
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
# A regra ainda não existe: o -C falha e o script a insere; o -D (da regra antiga, só de NODE_SUBNET) não tem o que
# tirar.
[[ $1 != -C && $1 != -D ]]
EOF
# A guarda do metadata (bin/metadata-guard.sh, que o `start.sh up` reafirma) troca o conteúdo da cadeia numa transação
# do iptables-restore; tests/metadata-guard-test.sh a testa de verdade, num espaço de nomes de rede próprio.
stub iptables-restore <<'EOF'
echo "iptables-restore $*" >>"$state/iptables.log"
cat >>"$state/iptables.log"
EOF
stub chown <<'EOF'
echo "chown $*" >>"$state/chown.log"
EOF
stub id <<'EOF'
echo 0
EOF
stub install <<EOF
echo "install \$*" >>"\$state/install.log"
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
worker_keys() { # o arquivo das chaves privadas que o worker lê
  cat "$root/run/verax/vault/worker-keys"
}
key64() { # <versão>: o conteúdo da versão como o worker o recebe (o PEM em base64)
  base64 -w0 <"$state/vault/$1"
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

# O tópico do sink de projeto de cliente (GCP_SINK_TOPIC_PREFIX) vai para a API em todo nó cujo projeto e prefixo
# estejam no formato do módulo (os do node.conf de exemplo estão); tests/start-test.sh cobre os casos fora dele.
lean_api='NODE_ENV LOG_LEVEL PORT WEB_ORIGIN API_ORIGIN TRUST_PROXY_HOPS BETTER_AUTH_SECRET CSRF_SECRET MAIL_TRANSPORT MAIL_FROM PLAN GCP_SINK_TOPIC_PREFIX DATABASE_URL '
lean_worker='NODE_ENV LOG_LEVEL SYNC_SOURCES SYNC_INTERVAL_SECONDS PLAN DATABASE_URL '
# O que o install.sh e o start.sh dizem quando o cofre entra em cena (o nó da Verax não pode dizer nada disso).
vault_words='credentials-key|cofre de credenciais'
# Onde o worker lê o arquivo das chaves: a pasta /run/verax/vault montada só leitura no worker pelo compose.vault.yaml
# (a origem é a pasta, não o arquivo: ver o comentário dele), e o arquivo dentro dela, que o worker.env precisa apontar.
vault_mount=$(sed -n 's#^ *- /run/verax/vault:\(/[^:]*\):ro$#\1#p' "$here/compose.vault.yaml")
[[ -n $vault_mount ]] || fail "compose.vault.yaml sem o volume só leitura da pasta das chaves no worker"
keys_mount=$vault_mount/worker-keys

for setting in absent false; do
  scenario="nó da Verax (CREDENTIALS_VAULT $setting)"
  new_node "$setting"
  run install || fail "install.sh falhou: $(cat "$state/out")"
  ! grep -qE "$vault_words" "$state/out" || fail "o install.sh fala do cofre: $(cat "$state/out")"
  run start up || fail "start.sh up falhou: $(cat "$state/out")"
  ! grep -qE "$vault_words" "$state/out" || fail "o start.sh fala do cofre: $(cat "$state/out")"
  [[ $(vault_calls) == 0 ]] || fail "o cofre foi consultado: $(grep credentials-key "$state/gcloud.log")"
  [[ $(keys_of api.env) == "$lean_api" ]] || fail "api.env mudou: $(keys_of api.env)"
  [[ $(keys_of worker.env) == "$lean_worker" ]] || fail "worker.env mudou: $(keys_of worker.env)"
  [[ ! -e $root/run/verax/vault ]] || fail "a pasta das chaves do worker existe sem o cofre"
  ! grep -q 'compose.vault.yaml' "$state/docker.log" ||
    fail "o compose.vault.yaml entrou sem o cofre: $(grep 'compose.vault.yaml' "$state/docker.log")"
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
[[ -f $root/opt/verax/compose.vault.yaml && $(stat -c %a "$root/opt/verax/compose.vault.yaml") == 640 ]] ||
  fail "o compose.vault.yaml não foi instalado em /opt/verax com 0640"
run install || fail "a segunda instalação falhou: $(cat "$state/out")"
[[ ! -e $state/vault/2 ]] || fail "a segunda instalação gerou outra chave"
grep -q 'já tem chave' "$state/out" || fail "a segunda instalação não disse que o cofre já tem chave"
run start up || fail "start.sh up falhou: $(cat "$state/out")"
[[ $(keys_of api.env) == "${lean_api% DATABASE_URL } CREDENTIALS_PUBLIC_KEY CREDENTIALS_KEY_VERSION DATABASE_URL " ]] ||
  fail "api.env: $(keys_of api.env)"
[[ $(keys_of worker.env) == "${lean_worker% DATABASE_URL } CREDENTIALS_PRIVATE_KEYS_FILE CREDENTIALS_KEY_CURRENT DATABASE_URL " ]] ||
  fail "worker.env: $(keys_of worker.env)"
[[ $(value_of api.env CREDENTIALS_KEY_VERSION) == 1 && $(value_of worker.env CREDENTIALS_KEY_CURRENT) == 1 ]] ||
  fail "versão corrente diferente de 1"
public=$(value_of api.env CREDENTIALS_PUBLIC_KEY | base64 -d)
[[ $public == "$(openssl pkey -in "$state/vault/1" -pubout 2>/dev/null)" ]] || fail "a pública não é a da versão 1"
# As privadas vão ao worker por arquivo (0400, do usuário do worker) numa pasta (0750, de root e do grupo do worker)
# montada nele; o worker.env aponta o arquivo no caminho em que ele o vê.
[[ $(value_of worker.env CREDENTIALS_PRIVATE_KEYS_FILE) == "$keys_mount" ]] ||
  fail "o worker.env aponta para $(value_of worker.env CREDENTIALS_PRIVATE_KEYS_FILE), e o compose monta a pasta em $vault_mount"
[[ $(worker_keys) == "1:$(key64 1)" ]] || fail "o arquivo das chaves do worker não é a versão 1 em base64"
[[ $(stat -c %a "$root/run/verax/vault/worker-keys") == 400 ]] || fail "arquivo das chaves fora do 0400"
[[ $(stat -c %a "$root/run/verax/vault") == 750 ]] || fail "pasta das chaves fora do 0750"
grep -q "^install -d -m 0750 -o 0 -g 1000 $root/run/verax/vault\$" "$state/install.log" ||
  fail "a pasta das chaves não é de root e do grupo do worker: $(cat "$state/install.log")"
grep -q "^chown 1000:1000 $root/run/verax/vault/\\.worker-keys\\.[A-Za-z0-9]*\$" "$state/chown.log" ||
  fail "o arquivo das chaves não passou ao usuário do worker antes de entrar no lugar: $(cat "$state/chown.log")"
[[ $(ls -A "$root/run/verax/vault") == worker-keys ]] || fail "sobra na pasta das chaves: $(ls -A "$root/run/verax/vault")"
# A chave, no formato em que o worker a lê, está só nesse arquivo: não no worker.env (que vira o ambiente do contêiner
# e vai para o disco, na configuração do Docker), não no api.env e em nenhum outro lugar da raiz.
[[ $(grep -rlF -- "$(key64 1)" "$root") == "$root/run/verax/vault/worker-keys" ]] ||
  fail "a chave privada está fora do arquivo do worker: $(grep -rlF -- "$(key64 1)" "$root")"
# A API nunca recebe a privada, nem em base64.
! grep -q 'PRIVATE' "$root/run/verax/api.env" || fail "api.env com PRIVATE"
! grep -q PRIVATE < <(value_of api.env CREDENTIALS_PUBLIC_KEY | base64 -d) || fail "api.env com chave privada"
[[ $(stat -c %a "$root/run/verax/worker.env") == 600 && $(stat -c %a "$root/run/verax/api.env") == 600 ]] ||
  fail "arquivos de ambiente fora do 0600"
# O compose.vault.yaml entra em toda chamada do Compose, depois do compose.yaml: na partida e na parada.
compose_files="-f $root/opt/verax/compose.yaml -f $root/opt/verax/compose.vault.yaml"
grep -q "compose --project-directory $root/opt/verax $compose_files .* up --detach worker" "$state/docker.log" ||
  fail "o worker subiu sem o compose.vault.yaml: $(grep 'up --detach worker' "$state/docker.log")"
run start down || fail "start.sh down falhou: $(cat "$state/out")"
grep -q "compose --project-directory $root/opt/verax $compose_files .* down\$" "$state/docker.log" ||
  fail "a parada sem o compose.vault.yaml: $(grep ' down$' "$state/docker.log")"
# A parada tira as chaves da memória; os arquivos de ambiente ficam, como sempre.
[[ ! -e $root/run/verax/vault ]] || fail "a pasta das chaves sobreviveu à parada"
[[ -f $root/run/verax/worker.env ]] || fail "a parada apagou o worker.env"

scenario="a pasta das chaves já existe (o Docker a criou ao reiniciar o worker antes da partida) e tem sobras"
# Depois de um reboot inesperado, o Docker reinicia o worker antes do verax-node.service e cria a origem do bind mount
# que falta: /run/verax/vault, 0755 e de root, vazia. Uma partida que falhou no meio também pode deixar o arquivo
# anterior e um temporário. A partida acerta a pasta, troca o arquivo de uma vez e não deixa sobra.
new_node true
add_version enabled
run install || fail "install.sh falhou: $(cat "$state/out")"
mkdir -p "$root/run/verax/vault"
chmod 0755 "$root/run/verax/vault"
printf 'de-antes' >"$root/run/verax/vault/worker-keys"
chmod 0400 "$root/run/verax/vault/worker-keys"
: >"$root/run/verax/vault/.worker-keys.sobra"
run start up || fail "start.sh up falhou com a pasta já criada: $(cat "$state/out")"
[[ $(worker_keys) == "1:$(key64 1)" ]] || fail "o arquivo das chaves não foi trocado: $(worker_keys)"
[[ $(stat -c %a "$root/run/verax/vault") == 750 && $(stat -c %a "$root/run/verax/vault/worker-keys") == 400 ]] ||
  fail "modo da pasta ou do arquivo errado: $(stat -c %a "$root/run/verax/vault" "$root/run/verax/vault/worker-keys")"
[[ $(ls -A "$root/run/verax/vault") == worker-keys ]] || fail "sobra na pasta das chaves: $(ls -A "$root/run/verax/vault")"
grep -q 'up --detach worker' "$state/docker.log" || fail "o worker não subiu"

scenario="base64 do gcloud sem o = do fim: o start.sh o repõe, e o worker recebe o base64 completo"
new_node true
add_version enabled
# Um PEM cujo tamanho não é múltiplo de 3 termina em `=` no base64 (uma quebra de linha a mais no fim não muda a chave).
if (($(stat -c %s "$state/vault/1") % 3 == 0)); then echo >>"$state/vault/1"; fi
[[ $(key64 1) == *= ]] || fail "o cenário precisa de um base64 com = no fim"
: >"$state/vault-unpadded"
run install || fail "install.sh falhou: $(cat "$state/out")"
run start up || fail "start.sh up falhou com o base64 sem o fim: $(cat "$state/out")"
[[ $(worker_keys) == "1:$(key64 1)" ]] || fail "o arquivo das chaves não tem o base64 completo da versão 1"
[[ $(value_of api.env CREDENTIALS_PUBLIC_KEY | base64 -d) == "$(openssl pkey -in "$state/vault/1" -pubout 2>/dev/null)" ]] ||
  fail "a pública não é a da versão 1"

scenario="rotação: versões desativadas e destruídas ficam de fora; a mais alta ativa é a corrente"
new_node true
add_version destroyed
add_version enabled
add_version disabled
add_version enabled
run install || fail "install.sh falhou: $(cat "$state/out")"
[[ ! -e $state/vault/5 ]] || fail "o install.sh gerou chave com a versão 1 destruída"
run start up || fail "start.sh up falhou: $(cat "$state/out")"
[[ $(worker_keys) == "2:$(key64 2)"$'\n'"4:$(key64 4)" ]] || fail "o arquivo das chaves não tem as versões 2 e 4"
[[ $(value_of worker.env CREDENTIALS_KEY_CURRENT) == 4 && $(value_of api.env CREDENTIALS_KEY_VERSION) == 4 ]] ||
  fail "a corrente não é a 4"
[[ $(value_of api.env CREDENTIALS_PUBLIC_KEY | base64 -d) == "$(openssl pkey -in "$state/vault/4" -pubout 2>/dev/null)" ]] ||
  fail "a pública não é a da versão 4"
# Da 1 à 5 (a primeira que não existe), uma leitura cada.
[[ $(vault_calls) == 6 ]] || fail "leituras do cofre: $(vault_calls) (1 do install.sh e 5 do start.sh)"

scenario="muitas versões: o Secret Manager não reaproveita número, então nenhum limite conta as destruídas"
new_node true
add_version enabled
for ((n = 2; n <= 100; n++)); do
  cp "$state/vault/1" "$state/vault/$n"
  echo destroyed >"$state/vault/$n.state"
done
echo destroyed >"$state/vault/1.state"
add_version enabled
[[ -f $state/vault/101 ]] || fail "o cenário não chegou à versão 101"
run install || fail "install.sh falhou: $(cat "$state/out")"
run start up || fail "start.sh up falhou com 101 versões: $(cat "$state/out")"
[[ $(value_of worker.env CREDENTIALS_KEY_CURRENT) == 101 && $(worker_keys) == "101:$(key64 101)" ]] ||
  fail "a corrente não é a 101, ou o arquivo tem outra coisa"
[[ $(vault_calls) == 103 ]] || fail "leituras do cofre: $(vault_calls) (1 do install.sh e 102 do start.sh)"

scenario="nenhuma versão ativa: a API e o worker sobem sem o cofre, com aviso que leva à saída certa"
new_node true
add_version disabled
run install || fail "install.sh falhou: $(cat "$state/out")"
[[ ! -e $state/vault/2 ]] || fail "o install.sh gerou chave com a versão 1 desativada"
run start up || fail "start.sh up falhou: $(cat "$state/out")"
grep -q 'AVISO: o cofre de credenciais (verax-node-credentials-key) não tem nenhuma versão ativa' "$state/out" ||
  fail "sem o aviso: $(cat "$state/out")"
# O install.sh não mexe num cofre que já tem versão (a 1 decide). Desativada, o gcloud diz "DISABLED": a saída é
# reativá-la (com o número), não gravar outra chave.
grep -q 'reative a desativada mais recente (gcloud secrets versions enable 1 --secret verax-node-credentials-key' "$state/out" ||
  fail "o aviso não diz como reativar a versão 1: $(cat "$state/out")"
! grep -q 'grave uma chave nova' "$state/out" || fail "o aviso manda gravar outra chave com a 1 só desativada: $(cat "$state/out")"
! grep -q 'install.sh' "$state/out" || fail "o aviso manda rodar o install.sh, que não geraria chave: $(cat "$state/out")"
[[ $(keys_of api.env) == "$lean_api" && $(keys_of worker.env) == "$lean_worker" ]] || fail "variáveis do cofre sem chave"
# O arquivo que o worker lê na pasta montada existe, vazio, e o worker sobe.
[[ -f $root/run/verax/vault/worker-keys && ! -s $root/run/verax/vault/worker-keys ]] || fail "o arquivo das chaves deveria existir vazio"
[[ $(stat -c %a "$root/run/verax/vault/worker-keys") == 400 ]] || fail "arquivo das chaves fora do 0400"
grep -q 'up --detach worker' "$state/docker.log" || fail "o worker não subiu"
# Versão destruída ("DESTROYED"): reativar não dá, e o aviso não pode sugerir; a saída é a chave nova.
echo destroyed >"$state/vault/1.state"
run start up || fail "start.sh up falhou com a versão 1 destruída: $(cat "$state/out")"
grep -q 'foi destruída (1): grave uma chave nova (docs/runbooks/no-verax.md' "$state/out" ||
  fail "sem a saída para a versão destruída: $(cat "$state/out")"
! grep -q 'enable' "$state/out" || fail "o aviso manda reativar uma versão destruída: $(cat "$state/out")"
# A 1 destruída e a 2 desativada: a 2 volta com um enable.
add_version disabled
run start up || fail "start.sh up falhou com a 1 destruída e a 2 desativada: $(cat "$state/out")"
grep -q 'gcloud secrets versions enable 2 --secret verax-node-credentials-key' "$state/out" ||
  fail "o aviso não manda reativar a 2: $(cat "$state/out")"
! grep -q 'grave uma chave nova' "$state/out" || fail "o aviso manda gravar outra chave com a 2 só desativada: $(cat "$state/out")"
rm -f "$state/vault/2" "$state/vault/2.state"

scenario="segredo sem versão nenhuma (recriado): o aviso manda rodar o deploy, cujo install.sh gera a chave"
rm -f "$state/vault/1" "$state/vault/1.state"
run start up || fail "start.sh up falhou: $(cat "$state/out")"
grep -q 'não tem nenhuma versão ativa' "$state/out" || fail "sem o aviso: $(cat "$state/out")"
grep -q 'rode o deploy de novo (o install.sh gera a chave' "$state/out" || fail "o aviso não aponta o install.sh: $(cat "$state/out")"
! grep -q 'reative' "$state/out" || fail "o aviso manda reativar uma versão que não existe"
run install || fail "install.sh falhou: $(cat "$state/out")"
[[ -f $state/vault/1 ]] || fail "o install.sh não gerou a chave: $(cat "$state/out")"
grep -q 'Chave nova' "$state/out" || fail "o install.sh não disse que gerou a chave: $(cat "$state/out")"

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

scenario="rede fora do ar no meio da leitura: a partida para, e as chaves da partida anterior saem da memória"
rm "$state/vault-missing"
run start up || fail "start.sh up falhou: $(cat "$state/out")"
[[ -s $root/run/verax/vault/worker-keys ]] || fail "a partida anterior não deixou o arquivo das chaves"
: >"$state/vault-offline"
if run start up; then fail "o start.sh seguiu sem ler o cofre"; fi
grep -q 'Falha ao ler a versão 1' "$state/out" || fail "sem a mensagem: $(cat "$state/out")"
[[ ! -e $root/run/verax/vault ]] || fail "a pasta das chaves ficou na memória depois da partida que falhou"

refused='não é uma chave privada RSA de 3072 a 4096 bits em PEM'
scenario="conteúdo que não é chave privada na versão corrente: a partida para"
new_node true
printf 'nao-e-uma-chave' >"$state/vault/1"
echo enabled >"$state/vault/1.state"
run install || fail "install.sh falhou: $(cat "$state/out")"
if run start up; then fail "o start.sh aceitou um conteúdo que não é chave"; fi
grep -q "A versão 1 do segredo verax-node-credentials-key $refused" "$state/out" || fail "sem a mensagem: $(cat "$state/out")"

scenario="versão antiga que o worker recusaria: a partida para antes de subir e diz qual versão desativar"
# O worker só sobe se toda versão ativa for uma chave privada RSA de 3072 a 4096 bits em PEM; a corrente válida (3)
# não basta. Cada conteúdo abaixo na versão 2 passaria pelo openssl da versão corrente (menos o lixo), e o worker
# cairia em laço depois de a partida ter dito que deu certo. A RSA-PSS é a mais parecida: o openssl imprime o módulo e
# os bits como para a RSA, mas o worker a recusa (asymmetricKeyType 'rsa-pss').
new_node true
add_version enabled
add_version enabled
add_version enabled
run install || fail "install.sh falhou: $(cat "$state/out")"
run start up || fail "start.sh up falhou com as três versões válidas: $(cat "$state/out")"
[[ -s $root/run/verax/vault/worker-keys ]] || fail "a partida não escreveu o arquivo das chaves"
for bad in lixo rsa-2048 rsa-pss ec-p256 chave-publica texto-antes-do-begin; do
  case $bad in
    lixo) printf 'nao-e-uma-chave' >"$state/vault/2" ;;
    rsa-2048) openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$state/vault/2" 2>/dev/null ;;
    rsa-pss) openssl genpkey -algorithm RSA-PSS -pkeyopt rsa_keygen_bits:3072 -out "$state/vault/2" 2>/dev/null ;;
    ec-p256) openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$state/vault/2" 2>/dev/null ;;
    chave-publica) openssl pkey -in "$state/vault/1" -pubout -out "$state/vault/2" 2>/dev/null ;;
    texto-antes-do-begin) { echo 'chave do cofre'; cat "$state/vault/1"; } >"$state/vault/2" ;;
  esac
  rm -f "$state/docker.log"
  if run start up; then fail "o start.sh aceitou a versão 2 ($bad)"; fi
  grep -q "A versão 2 do segredo verax-node-credentials-key $refused" "$state/out" ||
    fail "sem a mensagem ($bad): $(cat "$state/out")"
  grep -q 'gcloud secrets versions disable 2 --secret verax-node-credentials-key' "$state/out" ||
    fail "sem a saída ($bad): $(cat "$state/out")"
  ! grep -q ' up ' "$state/docker.log" 2>/dev/null || fail "o nó subiu com a versão 2 ($bad)"
  # A partida que para não deixa chave na memória, nem a da partida anterior.
  [[ ! -e $root/run/verax/vault ]] || fail "a pasta das chaves ficou na memória depois da partida que parou ($bad)"
done
# De volta a uma chave válida (de 4096 bits, o máximo que o worker aceita): as três versões vão para o worker.
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out "$state/vault/2" 2>/dev/null
run start up || fail "start.sh up falhou com a versão 2 de 4096 bits: $(cat "$state/out")"
[[ $(worker_keys) == "1:$(key64 1)"$'\n'"2:$(key64 2)"$'\n'"3:$(key64 3)" ]] || fail "o arquivo das chaves não tem as versões 1, 2 e 3"
[[ $(value_of worker.env CREDENTIALS_KEY_CURRENT) == 3 ]] || fail "a corrente não é a 3"

scenario="CREDENTIALS_VAULT inválido"
new_node sim
if run install; then fail "o install.sh aceitou CREDENTIALS_VAULT=sim"; fi
grep -q 'CREDENTIALS_VAULT inválido' "$state/out" || fail "sem a mensagem: $(cat "$state/out")"

echo "vault-test: todos os cenários passaram"
