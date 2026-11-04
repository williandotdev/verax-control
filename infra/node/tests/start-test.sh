#!/bin/bash
# Testes do `start.sh render` (os arquivos de ambiente que o nó monta em /run/verax), sem root, sem Docker e sem a GCP:
# o script roda como o systemd o roda, numa pasta temporária que faz o papel de /etc/verax, /var/lib/verax/secrets e
# /run/verax, com o gcloud simulado (um cofre por arquivo). O node.conf de cada cenário é o node.conf.example, com as
# linhas do cenário trocadas. O que importa aqui é o api.env, byte a byte:
#   - o tópico do sink de projeto de cliente só vai para a API com o projeto e o prefixo do node.conf no formato do
#     módulo do Terraform; fora dele, a API sobe sem o tópico, e o render avisa;
#   - sem TURNSTILE_SITE_KEY no node.conf, o nó da Verax sai exatamente como antes do Turnstile (e o cofre nem é lido);
#     com a chave do site, a chave secreta vem do cofre, e as duas só entram juntas.
# O que depende do Docker (subir os contêineres) fica para a VM.
#
#   bash infra/node/tests/start-test.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
script=$here/../bin/start.sh
example=$here/../node.conf.example

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
has_topic() { grep -q GCP_SINK_TOPIC_PREFIX "$root/run/verax/api.env"; }

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

# --- node.conf de exemplo numa VM recém-criada (nenhum cofre com valor): o tópico do sink vai para a API -----------
new_root "node.conf de exemplo, cofres vazios" exemplo
rm "$root/vault/verax-node-cloudflare-tunnel-token"
render_env || fail "o render falhou: $(cat "$root/out")"
grep -qxF "GCP_SINK_TOPIC_PREFIX='projects/projeto-do-no/topics/verax-node-security-'" "$root/run/verax/api.env" ||
  fail "o api.env não tem o tópico do sink montado do projeto e do prefixo: $(api_env | grep -v SECRET)"
! grep -q GCP_SINK_TOPIC_PREFIX "$root/run/verax/worker.env" || fail "o tópico foi para o worker, que não o usa"
grep -q 'sem o cloudflared' "$root/out" || fail "sem o aviso do túnel com o cofre vazio: $(cat "$root/out")"
! grep -q 'fora do formato' "$root/out" || fail "avisou sobre o formato com o node.conf de exemplo: $(cat "$root/out")"

# --- Prefixo fora do formato: a API sobe sem o tópico ----------------------------------------------------------------
new_root "prefixo fora do formato" prefixo
node_conf VERAX_SECRET_PREFIX=Verax_Node
render_env || fail "o render deveria avisar e seguir: $(cat "$root/out")"
! has_topic || fail "escreveu um tópico que a API recusaria"
grep -q 'VERAX_GCP_PROJECT ou VERAX_SECRET_PREFIX fora do formato' "$root/out" || fail "sem o aviso: $(cat "$root/out")"
grep -qxF "PLAN='interno'" "$root/run/verax/api.env" || fail "o resto do api.env não ficou como antes"

# --- Projeto fora do formato ------------------------------------------------------------------------------------------
new_root "projeto fora do formato" projeto
node_conf VERAX_GCP_PROJECT=123456789012
render_env || fail "o render deveria avisar e seguir: $(cat "$root/out")"
! has_topic || fail "escreveu um tópico que a API recusaria"
grep -q 'VERAX_GCP_PROJECT ou VERAX_SECRET_PREFIX fora do formato' "$root/out" || fail "sem o aviso: $(cat "$root/out")"

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

echo "start.sh render: todos os cenários passaram."
