#!/bin/bash
# Testa o bin/start.sh sem root, sem Docker e sem a GCP, em duas partes. No CI: `bash infra/node/tests/start-test.sh`.
#
# 1. Os arquivos de ambiente que o `render` escreve nos dois perfis (com o tópico do sink de projeto de cliente só
#    quando o projeto e o prefixo do node.conf seguem o formato do módulo), o `bootstrap` e o `pull_images`, com o
#    Compose e o Docker simulados e um gcloud de mentira no PATH (nenhum cofre tem valor, como numa VM recém-criada). O
#    script é carregado inteiro (com o node.conf.example no lugar de /etc/verax/node.conf e sem a chamada do fim), então
#    é o código do nó que roda aqui; o write_env, o external_secret, o wazuh_passwords e o lib-passwords.sh são os de
#    verdade.
# 2. O Turnstile no api.env, byte a byte. O script roda como o systemd o roda (`start.sh render`, num processo à parte
#    e num ambiente limpo), numa pasta temporária que faz o papel de /etc/verax, /var/lib/verax/secrets e /run/verax,
#    com o gcloud simulado (um cofre por arquivo). Sem TURNSTILE_SITE_KEY no node.conf, o nó da Verax sai exatamente
#    como antes do Turnstile (e o cofre nem é lido); com a chave do site, a chave secreta vem do cofre, e as duas só
#    entram juntas.
set -euo pipefail
cd "$(dirname "$0")/.."

failures=0
expect() { # <descrição> <esperado (regex)> <obtido>
  if [[ $3 =~ ^($2)$ ]]; then
    printf 'ok     %s\n' "$1"
  else
    printf 'FALHA  %s (esperado %s, obtido %s)\n' "$1" "$2" "$3"
    failures=$((failures + 1))
  fi
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# O node.conf de exemplo, sem os comentários: o teste prende o exemplo ao formato do módulo (projeto e prefixo).
grep -v -e '^#' -e '^$' node.conf.example >"$work/node.conf"
# Secret Manager: o gcloud responde NOT_FOUND para todo cofre (o do túnel ainda sem valor); o render escreve o
# cloudflared.env vazio e avisa.
mkdir -p "$work/bin"
cat >"$work/bin/gcloud" <<'EOF'
#!/bin/bash
echo "ERROR: (gcloud.secrets.versions.access) NOT_FOUND: Secret Version [latest] not found or has no versions." >&2
exit 1
EOF
chmod +x "$work/bin/gcloud"
PATH=$work/bin:$PATH

# O start.sh como está, com o node.conf de teste e sem o `case` do fim: só as funções e as variáveis dele.
# shellcheck source=SCRIPTDIR/../bin/start.sh
source <(sed -e "s|^source /etc/verax/node.conf\$|source '$work/node.conf'|" -e '/^case \${1:-} in$/,$d' bin/start.sh)

# Os caminhos do nó viram pastas de teste; o pacote do Wazuh é o do repositório.
secrets=$work/secrets
run=$work/run
wazuh=$PWD/../wazuh
mkdir -p "$secrets"
for name in postgres-master postgres-migrator postgres-app better-auth-secret csrf-secret; do
  printf 'segredo-%s' "$name" >"$secrets/$name"
done
# shellcheck source=SCRIPTDIR/../../wazuh/scripts/lib-passwords.sh
source ../wazuh/scripts/lib-passwords.sh
for name in wazuh-indexer-admin wazuh-indexer-filebeat wazuh-api wazuh-indexer-read; do
  value=$(new_wazuh_password)
  printf '%s' "$value" >"$secrets/$name"
done

# Compose e Docker: cada chamada fica anotada. O `config --images` devolve a lista do teste (ou falha, como com um
# arquivo de ambiente ausente); o `run` do bootstrap guarda o arquivo que o contêiner veria naquele momento.
calls=$work/calls
: >"$calls"
compose() {
  printf 'compose %s\n' "$*" >>"$calls"
  case " $* " in
    *' config --images ')
      if [[ -n ${COMPOSE_FALHA:-} ]]; then
        echo 'env file /run/verax/exemplo.env not found' >&2
        return 1
      fi
      printf '%s\n' "${COMPOSE_IMAGES[@]}"
      ;;
    *' run --rm -T bootstrap ')
      cp "$run/bootstrap.env" "$work/bootstrap-durante.env"
      echo 'Administrador criado.'
      ;;
    *)
      echo "compose simulado: chamada inesperada: $*" >&2
      return 1
      ;;
  esac
}
docker() {
  printf 'docker %s\n' "$*" >>"$calls"
  case "$1 $2" in
    'image inspect') [[ $3 == *presente* ]] ;;
    'pull --quiet') ;;
    *)
      echo "docker simulado: chamada inesperada: $*" >&2
      return 1
      ;;
  esac
}

env_files() { (cd "$run" && find . -maxdepth 1 -type f | sed 's|^\./||' | LC_ALL=C sort | tr '\n' ' '); }
file_size() { wc -c <"$1" | tr -d ' '; }
# O render num processo à parte, com as variáveis dadas no lugar das do node.conf (como um node.conf editado depois
# da instalação). Devolve o código de saída dele; a saída de erro vai para $work/render.err.
render_with() { # <CHAVE=valor...>
  local status=0
  (
    for line in "$@"; do export "${line?}"; done
    render
  ) 2>"$work/render.err" || status=$?
  return "$status"
}

echo "== lean: os arquivos de ambiente do render"
NODE_PROFILE=lean
render 2>"$work/render.err"
expect "os arquivos que o compose.yaml exige, mais o memory.env" \
  'api.env bootstrap.env cloudflared.env db-bootstrap.env memory.env migrate.env postgres.env worker.env ' "$(env_files)"
expect "bootstrap.env vazio (o serviço bootstrap o exige, e o pull_images lê o projeto com o perfil setup)" 0 \
  "$(file_size "$run/bootstrap.env")"
expect "cloudflared.env vazio com o cofre sem valor (o gcloud respondeu NOT_FOUND), e o aviso" '0 1' \
  "$(file_size "$run/cloudflared.env") $(grep -c 'sem o token do túnel.*sem o cloudflared' "$work/render.err")"
expect "memória do lean" 1 "$(grep -c "^POSTGRES_MEM_LIMIT='256m'$" "$run/memory.env")"
expect "no lean, nada do indexer na API nem no worker" 0 "$(cat "$run/api.env" "$run/worker.env" | grep -c INDEXER_ || true)"
expect "valores entre aspas simples (o Compose não interpreta \$)" 1 "$(grep -c "^PLAN='interno'$" "$run/api.env")"

echo "== o tópico do sink de projeto de cliente: só na API, montado do projeto e do prefixo do node.conf de exemplo"
expect "a API recebe o tópico no formato do módulo (<prefixo>-security-, no projeto do nó)" 1 \
  "$(grep -c "^GCP_SINK_TOPIC_PREFIX='projects/projeto-do-no/topics/verax-node-security-'$" "$run/api.env")"
expect "o worker não o recebe (não o usa)" 0 "$(grep -c GCP_SINK_TOPIC_PREFIX "$run/worker.env" || true)"

echo "== prefixo fora do formato do módulo: a API sobe sem o tópico, com o aviso"
status=0
render_with VERAX_SECRET_PREFIX=Verax_Node || status=$?
expect "o render avisa e segue" 0 "$status"
expect "nenhum tópico que a API recusaria" 0 "$(grep -c GCP_SINK_TOPIC_PREFIX "$run/api.env" || true)"
expect "o aviso diz qual é o problema" 1 \
  "$(grep -c 'VERAX_GCP_PROJECT ou VERAX_SECRET_PREFIX fora do formato' "$work/render.err")"
expect "o resto do api.env fica como antes" 1 "$(grep -c "^PLAN='interno'$" "$run/api.env")"

echo "== projeto fora do formato do módulo: idem"
status=0
render_with VERAX_GCP_PROJECT=123456789012 || status=$?
expect "o render avisa e segue" 0 "$status"
expect "nenhum tópico que a API recusaria" 0 "$(grep -c GCP_SINK_TOPIC_PREFIX "$run/api.env" || true)"
expect "o aviso" 1 "$(grep -c 'fora do formato' "$work/render.err")"

echo "== lean: pull_images --base baixa só a imagem que falta"
COMPOSE_IMAGES=('exemplo/api@sha256:presente' '' 'postgres:18-alpine@sha256:falta' 'exemplo/api@sha256:presente')
: >"$calls"
pull_images --base
expect "a lista vem do Compose com o perfil setup e só o compose.yaml (--base)" 1 \
  "$(grep -c '^compose --base --profile setup config --images$' "$calls")"
expect "cada imagem é conferida no disco (a linha vazia é ignorada)" 3 "$(grep -c '^docker image inspect ' "$calls")"
expect "só a que falta é baixada" 'docker pull --quiet postgres:18-alpine@sha256:falta' \
  "$(grep '^docker pull' "$calls" | tr '\n' ';' | sed 's/;$//')"

echo "== pull_images: um erro do Compose para a partida, com o motivo"
: >"$calls"
status=0
COMPOSE_FALHA=1 pull_images 2>"$work/pull.err" || status=$?
expect "pull_images devolve 1" 1 "$status"
expect "o motivo do Compose vai para a saída de erro" 1 "$(grep -c 'not found' "$work/pull.err")"
expect "nenhuma imagem conferida nem baixada" 0 "$(grep -c '^docker ' "$calls" || true)"

echo "== bootstrap: o bootstrap.env é preenchido só durante a execução e volta a ficar vazio"
: >"$calls"
BOOTSTRAP_ADMIN_EMAIL=admin@exemplo.test BOOTSTRAP_TENANT_NAME='Cliente Demo A' bootstrap >"$work/bootstrap.out" 2>/dev/null
expect "o contêiner do bootstrap recebe o e-mail do administrador" 1 \
  "$(grep -c "^BOOTSTRAP_ADMIN_EMAIL='admin@exemplo.test'$" "$work/bootstrap-durante.env")"
expect "depois, o arquivo existe e está vazio (o Compose o exige no wazuh-up e no próximo up)" '0 0' \
  "$(file_size "$run/bootstrap.env") $(grep -c 'BOOTSTRAP_' "$run/bootstrap.env" || true)"
expect "a saída do bootstrap chega à tela" 1 "$(grep -c 'Administrador criado' "$work/bootstrap.out")"

echo "== standard: os arquivos do Wazuh e as variáveis do indexer na API e no worker"
rm -rf "$run"
NODE_PROFILE=standard
render 2>/dev/null
expect "os arquivos do lean mais wazuh-security.env e wazuh-manager.env" \
  'api.env bootstrap.env cloudflared.env db-bootstrap.env memory.env migrate.env postgres.env wazuh-manager.env wazuh-security.env worker.env ' \
  "$(env_files)"
expect "bootstrap.env vazio também no standard" 0 "$(file_size "$run/bootstrap.env")"
expect "memória do standard" 1 "$(grep -c "^POSTGRES_MEM_LIMIT='512m'$" "$run/memory.env")"
expect "API e worker leem o indexer do nó com o usuário só leitura" 2 \
  "$(cat "$run/api.env" "$run/worker.env" | grep -c "^INDEXER_USERNAME='verax_api_read'$")"
expect "a senha do admin do indexer só vai para o security-init" 'wazuh-security.env' \
  "$(cd "$run" && grep -l '^INDEXER_ADMIN_PASSWORD=' ./*.env | sed 's|^\./||' | tr '\n' ' ' | sed 's/ $//')"
expect "o manager recebe a senha do filebeat e a da API dele, e nada mais" "INDEXER_PASSWORD API_PASSWORD" \
  "$(cut -d= -f1 "$run/wazuh-manager.env" | tr '\n' ' ' | sed 's/ $//')"
expect "o tópico do sink também no standard, só na API" '1 0' \
  "$(grep -c GCP_SINK_TOPIC_PREFIX "$run/api.env") $(grep -c GCP_SINK_TOPIC_PREFIX "$run/worker.env" || true)"

echo "== Turnstile: o api.env byte a byte, com o start.sh rodando como na VM (start.sh render)"
# Num subshell, com a própria raiz, o próprio gcloud (um cofre por arquivo) e as próprias funções; para no primeiro
# erro. O node.conf de cada cenário é o node.conf.example, com as linhas do cenário trocadas.
(
script=$PWD/bin/start.sh
example=$PWD/node.conf.example

fail() {
  echo "FALHOU ($scenario): $*" >&2
  exit 1
}

work=$(readlink -f "$(mktemp -d)")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

# O gcloud simulado: `secrets versions access latest --project P --secret NOME` lê o arquivo $VAULT/NOME. Sem o arquivo,
# responde como o Secret Manager a um cofre sem versão (NOT_FOUND); com `NOME.denied`, como sem permissão. Cada
# chamada fica anotada em $VAULT/log.
cat >"$work/bin/gcloud" <<'EOF'
#!/bin/bash
set -euo pipefail
echo "gcloud $*" >>"$VAULT/log"
[ "$1 $2 $3 $4" = "secrets versions access latest" ] || { echo "gcloud simulado: comando inesperado: $*" >&2; exit 2; }
name=${*: -1}
if [ -e "$VAULT/$name.denied" ]; then
  echo "ERROR: (gcloud.secrets.versions.access) PERMISSION_DENIED: Permission 'secretmanager.versions.access' denied for resource 'projects/projeto-do-no/secrets/$name/versions/latest' (or it may not exist)." >&2
  exit 1
fi
if [ ! -e "$VAULT/$name" ]; then
  echo "ERROR: (gcloud.secrets.versions.access) NOT_FOUND: Secret [projects/projeto-do-no/secrets/$name] not found or has no versions." >&2
  exit 1
fi
cat "$VAULT/$name"
EOF
chmod +x "$work/bin/gcloud"

# Uma raiz nova por cenário: o node.conf de exemplo (sem os comentários), as senhas internas (geradas pelo install.sh na
# VM) e o cofre do gcloud, só com o token do túnel gravado. O script fica como ele roda na VM, com os três caminhos
# trocados pela raiz do cenário; o resto (o caminho da CA do banco dentro da URL, por exemplo) fica como está.
new_root() { # <cenário> <pasta>
  scenario=$1
  root=$work/root-$2
  mkdir -p "$root/etc/verax" "$root/var/lib/verax/secrets" "$root/vault"
  grep -v -e '^#' -e '^$' "$example" >"$root/etc/verax/node.conf"
  local secret
  for secret in postgres-master postgres-migrator postgres-app better-auth-secret csrf-secret; do
    printf 'interno-%s' "$secret" >"$root/var/lib/verax/secrets/$secret"
  done
  printf 'token-do-tunel' >"$root/vault/verax-node-cloudflare-tunnel-token"
  : >"$root/vault/log"
  sed -e "s#/etc/verax/node.conf#$root/etc/verax/node.conf#g" \
    -e "s#/var/lib/verax/secrets#$root/var/lib/verax/secrets#g" \
    -e "s#=/run/verax\$#=$root/run/verax#" "$script" >"$root/start.sh"
}

# Troca linhas do node.conf do cenário, ou acrescenta as que o exemplo só tem comentadas (TURNSTILE_SITE_KEY).
node_conf() { # <CHAVE=valor...>
  local conf=$root/etc/verax/node.conf line
  for line in "$@"; do
    if grep -q "^${line%%=*}=" "$conf"; then
      sed -i "s|^${line%%=*}=.*|$line|" "$conf"
    else
      echo "$line" >>"$conf"
    fi
  done
}

# Roda o render como o systemd rodaria o up, num ambiente limpo. Devolve o código de saída.
render_env() {
  local code=0
  env -i PATH="$work/bin:$PATH" VAULT="$root/vault" "$BASH" "$root/start.sh" render >"$root/out" 2>&1 || code=$?
  return "$code"
}

api_env() { cat "$root/run/verax/api.env"; }

# O api.env do nó da Verax, como o start.sh o monta com o node.conf de exemplo e sem o Turnstile. Qualquer diferença
# aqui é uma mudança no nó no ar.
baseline=$(
  cat <<'EOF'
NODE_ENV='production'
LOG_LEVEL='info'
PORT='3000'
WEB_ORIGIN='https://cliente.control.exemplo.com.br'
API_ORIGIN='https://api-cliente.exemplo.com.br'
TRUST_PROXY_HOPS='1'
BETTER_AUTH_SECRET='interno-better-auth-secret'
CSRF_SECRET='interno-csrf-secret'
MAIL_TRANSPORT='none'
MAIL_FROM='nao-responda@exemplo.com.br'
PLAN='interno'
GCP_SINK_TOPIC_PREFIX='projects/projeto-do-no/topics/verax-node-security-'
DATABASE_URL='postgresql://verax_app:interno-postgres-app@postgres:5432/verax?sslmode=verify-full&sslrootcert=/etc/verax/tls/ca.crt'
EOF
)

with_turnstile=$(
  cat <<'EOF'
NODE_ENV='production'
LOG_LEVEL='info'
PORT='3000'
WEB_ORIGIN='https://cliente.control.exemplo.com.br'
API_ORIGIN='https://api-cliente.exemplo.com.br'
TRUST_PROXY_HOPS='1'
BETTER_AUTH_SECRET='interno-better-auth-secret'
CSRF_SECRET='interno-csrf-secret'
MAIL_TRANSPORT='none'
MAIL_FROM='nao-responda@exemplo.com.br'
PLAN='interno'
GCP_SINK_TOPIC_PREFIX='projects/projeto-do-no/topics/verax-node-security-'
TURNSTILE_SITE_KEY='1x00000000000000000000AA'
TURNSTILE_SECRET_KEY='segredo-ficticio-do-turnstile'
DATABASE_URL='postgresql://verax_app:interno-postgres-app@postgres:5432/verax?sslmode=verify-full&sslrootcert=/etc/verax/tls/ca.crt'
EOF
)

# --- Sem TURNSTILE_SITE_KEY (o nó da Verax hoje) -------------------------------------------------------------------
new_root "sem TURNSTILE_SITE_KEY no node.conf" sem-chave
render_env || fail "o render falhou: $(cat "$root/out")"
[ "$(api_env)" = "$baseline" ] || fail "o api.env mudou sem o Turnstile:
$(diff <(echo "$baseline") <(api_env) || true)"
[ ! -s "$root/out" ] || fail "o render avisou algo com tudo no lugar: $(cat "$root/out")"
grep -q 'turnstile' "$root/vault/log" && fail "leu o cofre do Turnstile sem a chave do site no node.conf"
[ "$(cat "$root/vault/log")" = "gcloud secrets versions access latest --project projeto-do-no --secret verax-node-cloudflare-tunnel-token" ] ||
  fail "chamadas ao gcloud diferentes das de antes: $(cat "$root/vault/log")"
[ "$(cat "$root/run/verax/cloudflared.env")" = "TUNNEL_TOKEN='token-do-tunel'" ] || fail "o cloudflared.env mudou"

# --- Chave do site no node.conf e cofre ainda sem valor ------------------------------------------------------------
new_root "chave do site sem a secreta no cofre" cofre-vazio
node_conf TURNSTILE_SITE_KEY=1x00000000000000000000AA
render_env || fail "o render deveria seguir sem o desafio: $(cat "$root/out")"
[ "$(api_env)" = "$baseline" ] || fail "uma chave só entrou no api.env:
$(diff <(echo "$baseline") <(api_env) || true)"
grep -q 'AVISO: TURNSTILE_SITE_KEY definida no node.conf, mas o cofre da chave secreta ainda não tem valor' "$root/out" ||
  fail "sem o aviso do cofre vazio: $(cat "$root/out")"
grep -q -- '--secret verax-node-turnstile-secret-key' "$root/vault/log" || fail "não leu o cofre do Turnstile"

# --- Chave do site e chave secreta ---------------------------------------------------------------------------------
new_root "chave do site e secreta no cofre" ligado
node_conf TURNSTILE_SITE_KEY=1x00000000000000000000AA
printf 'segredo-ficticio-do-turnstile\n' >"$root/vault/verax-node-turnstile-secret-key"
render_env || fail "o render falhou: $(cat "$root/out")"
[ "$(api_env)" = "$with_turnstile" ] || fail "as duas chaves não entraram como esperado:
$(diff <(echo "$with_turnstile") <(api_env) || true)"
grep -qi 'aviso' "$root/out" && fail "avisou com tudo configurado: $(cat "$root/out")"
grep -q 'segredo-ficticio' "$root/out" && fail "a chave secreta saiu na tela"
grep -q 'TURNSTILE' "$root/run/verax/worker.env" && fail "o worker não usa o Turnstile"

# --- Sem permissão no cofre (ou outro erro do gcloud): a partida para -----------------------------------------------
new_root "cofre sem permissão" negado
node_conf TURNSTILE_SITE_KEY=1x00000000000000000000AA
: >"$root/vault/verax-node-turnstile-secret-key.denied"
if render_env; then fail "o render deveria parar com o erro do gcloud"; fi
grep -q 'Falha ao ler o segredo verax-node-turnstile-secret-key' "$root/out" || fail "sem o motivo: $(cat "$root/out")"
grep -q 'PERMISSION_DENIED' "$root/out" || fail "sem a mensagem do gcloud: $(cat "$root/out")"
[ ! -e "$root/run/verax/api.env" ] || fail "escreveu o api.env mesmo com a falha"

# --- Valor com quebra de linha no meio: recusado, como nos outros cofres -------------------------------------------
new_root "chave secreta com quebra de linha" quebra
node_conf TURNSTILE_SITE_KEY=1x00000000000000000000AA
printf 'linha-um\nlinha-dois' >"$root/vault/verax-node-turnstile-secret-key"
if render_env; then fail "o render deveria recusar o valor com quebra de linha"; fi
grep -q 'vazio ou com quebra de linha' "$root/out" || fail "sem a mensagem da quebra de linha: $(cat "$root/out")"

echo "ok     Turnstile: todos os cenários passaram"
)

if ((failures > 0)); then
  echo "$failures verificação(ões) falharam." >&2
  exit 1
fi
echo "start.sh: todas as verificações passaram."
