#!/bin/bash
# Teste do `start.sh render` (os arquivos de ambiente que o nó monta em /run/verax), sem root, sem Docker e sem a GCP:
# o script roda numa pasta temporária que faz o papel de /etc/verax, /var/lib/verax/secrets e /run/verax, e o gcloud é
# simulado, com um cofre por arquivo. O que importa aqui é o api.env, byte a byte: o nó da Verax (sem TURNSTILE_SITE_KEY
# no node.conf) tem de sair exatamente como antes do Turnstile, e as duas chaves só entram juntas.
#
#   bash infra/node/tests/start-test.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
script=$here/../bin/start.sh

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
  echo "ERROR: (gcloud.secrets.versions.access) PERMISSION_DENIED: Permission 'secretmanager.versions.access' denied for resource 'projects/projeto-exemplo/secrets/$name/versions/latest' (or it may not exist)." >&2
  exit 1
fi
if [ ! -e "$VAULT/$name" ]; then
  echo "ERROR: (gcloud.secrets.versions.access) NOT_FOUND: Secret [projects/projeto-exemplo/secrets/$name] not found or has no versions." >&2
  exit 1
fi
cat "$VAULT/$name"
EOF
chmod +x "$work/bin/gcloud"

# Uma raiz nova por cenário: node.conf, as senhas internas (geradas pelo install.sh na VM) e o cofre do gcloud.
new_root() {
  scenario=$1
  root=$work/root-$2
  mkdir -p "$root/etc/verax" "$root/var/lib/verax/secrets" "$root/vault"
  cat >"$root/etc/verax/node.conf" <<'EOF'
VERAX_GCP_PROJECT=projeto-exemplo
VERAX_SECRET_PREFIX=verax-teste
IMAGES_REPOSITORY=us-east1-docker.pkg.dev/projeto-exemplo/verax-control
WEB_ORIGIN=https://painel.example
API_ORIGIN=https://api.example
MAIL_TRANSPORT=none
MAIL_FROM=nao-responda@example.com
SYNC_SOURCES=gcp
BACKUP_BUCKET=projeto-exemplo-verax-teste-backups
PLAN=interno
NODE_PROFILE=lean
EOF
  for secret in postgres-master postgres-migrator postgres-app better-auth-secret csrf-secret; do
    printf 'interno-%s' "$secret" >"$root/var/lib/verax/secrets/$secret"
  done
  printf 'token-do-tunel' >"$root/vault/verax-teste-cloudflare-tunnel-token"
  : >"$root/vault/log"
  # O script como ele roda na VM, com os três caminhos trocados pela raiz do cenário. O resto (o caminho da CA do
  # banco dentro da URL, por exemplo) fica como está.
  sed -e "s#/etc/verax/node.conf#$root/etc/verax/node.conf#g" \
    -e "s#/var/lib/verax/secrets#$root/var/lib/verax/secrets#g" \
    -e "s#=/run/verax\$#=$root/run/verax#" "$script" >"$root/start.sh"
}

# Roda o render como o systemd rodaria o up, num ambiente limpo. Devolve o código de saída.
render() {
  local code=0
  env -i PATH="$work/bin:$PATH" VAULT="$root/vault" "$BASH" "$root/start.sh" render >"$root/out" 2>&1 || code=$?
  return "$code"
}

api_env() { cat "$root/run/verax/api.env"; }

# O api.env do nó da Verax, como o start.sh o monta sem o Turnstile. Qualquer diferença aqui é uma mudança no nó no ar.
baseline=$(
  cat <<'EOF'
NODE_ENV='production'
LOG_LEVEL='info'
PORT='3000'
WEB_ORIGIN='https://painel.example'
API_ORIGIN='https://api.example'
TRUST_PROXY_HOPS='1'
BETTER_AUTH_SECRET='interno-better-auth-secret'
CSRF_SECRET='interno-csrf-secret'
MAIL_TRANSPORT='none'
MAIL_FROM='nao-responda@example.com'
PLAN='interno'
DATABASE_URL='postgresql://verax_app:interno-postgres-app@postgres:5432/verax?sslmode=verify-full&sslrootcert=/etc/verax/tls/ca.crt'
EOF
)

with_turnstile=$(
  cat <<'EOF'
NODE_ENV='production'
LOG_LEVEL='info'
PORT='3000'
WEB_ORIGIN='https://painel.example'
API_ORIGIN='https://api.example'
TRUST_PROXY_HOPS='1'
BETTER_AUTH_SECRET='interno-better-auth-secret'
CSRF_SECRET='interno-csrf-secret'
MAIL_TRANSPORT='none'
MAIL_FROM='nao-responda@example.com'
PLAN='interno'
TURNSTILE_SITE_KEY='1x00000000000000000000AA'
TURNSTILE_SECRET_KEY='segredo-ficticio-do-turnstile'
DATABASE_URL='postgresql://verax_app:interno-postgres-app@postgres:5432/verax?sslmode=verify-full&sslrootcert=/etc/verax/tls/ca.crt'
EOF
)

# --- Sem TURNSTILE_SITE_KEY (o nó da Verax hoje) -------------------------------------------------------------------
new_root "sem TURNSTILE_SITE_KEY no node.conf" sem-chave
render || fail "o render falhou: $(cat "$root/out")"
[ "$(api_env)" = "$baseline" ] || fail "o api.env mudou sem o Turnstile:
$(diff <(echo "$baseline") <(api_env) || true)"
grep -q 'turnstile' "$root/vault/log" && fail "leu o cofre do Turnstile sem a chave do site no node.conf"
[ "$(cat "$root/vault/log")" = "gcloud secrets versions access latest --project projeto-exemplo --secret verax-teste-cloudflare-tunnel-token" ] ||
  fail "chamadas ao gcloud diferentes das de antes: $(cat "$root/vault/log")"
[ "$(cat "$root/run/verax/cloudflared.env")" = "TUNNEL_TOKEN='token-do-tunel'" ] || fail "o cloudflared.env mudou"
grep -qi 'turnstile' "$root/out" && fail "avisou sobre o Turnstile sem a chave do site: $(cat "$root/out")"

# --- Chave do site no node.conf e cofre ainda sem valor ------------------------------------------------------------
new_root "chave do site sem a secreta no cofre" cofre-vazio
echo 'TURNSTILE_SITE_KEY=1x00000000000000000000AA' >>"$root/etc/verax/node.conf"
render || fail "o render deveria seguir sem o desafio: $(cat "$root/out")"
[ "$(api_env)" = "$baseline" ] || fail "uma chave só entrou no api.env:
$(diff <(echo "$baseline") <(api_env) || true)"
grep -q 'AVISO: TURNSTILE_SITE_KEY definida no node.conf, mas o cofre da chave secreta ainda não tem valor' "$root/out" ||
  fail "sem o aviso do cofre vazio: $(cat "$root/out")"
grep -q -- '--secret verax-teste-turnstile-secret-key' "$root/vault/log" || fail "não leu o cofre do Turnstile"

# --- Chave do site e chave secreta ---------------------------------------------------------------------------------
new_root "chave do site e secreta no cofre" ligado
echo 'TURNSTILE_SITE_KEY=1x00000000000000000000AA' >>"$root/etc/verax/node.conf"
printf 'segredo-ficticio-do-turnstile\n' >"$root/vault/verax-teste-turnstile-secret-key"
render || fail "o render falhou: $(cat "$root/out")"
[ "$(api_env)" = "$with_turnstile" ] || fail "as duas chaves não entraram como esperado:
$(diff <(echo "$with_turnstile") <(api_env) || true)"
grep -qi 'aviso' "$root/out" && fail "avisou com tudo configurado: $(cat "$root/out")"
grep -q 'segredo-ficticio' "$root/out" && fail "a chave secreta saiu na tela"
grep -q 'TURNSTILE' "$root/run/verax/worker.env" && fail "o worker não usa o Turnstile"

# --- Sem permissão no cofre (ou outro erro do gcloud): a partida para -----------------------------------------------
new_root "cofre sem permissão" negado
echo 'TURNSTILE_SITE_KEY=1x00000000000000000000AA' >>"$root/etc/verax/node.conf"
: >"$root/vault/verax-teste-turnstile-secret-key.denied"
if render; then fail "o render deveria parar com o erro do gcloud"; fi
grep -q 'Falha ao ler o segredo verax-teste-turnstile-secret-key' "$root/out" || fail "sem o motivo: $(cat "$root/out")"
grep -q 'PERMISSION_DENIED' "$root/out" || fail "sem a mensagem do gcloud: $(cat "$root/out")"
[ ! -e "$root/run/verax/api.env" ] || fail "escreveu o api.env mesmo com a falha"

# --- Valor com quebra de linha no meio: recusado, como nos outros cofres -------------------------------------------
new_root "chave secreta com quebra de linha" quebra
echo 'TURNSTILE_SITE_KEY=1x00000000000000000000AA' >>"$root/etc/verax/node.conf"
printf 'linha-um\nlinha-dois' >"$root/vault/verax-teste-turnstile-secret-key"
if render; then fail "o render deveria recusar o valor com quebra de linha"; fi
grep -q 'vazio ou com quebra de linha' "$root/out" || fail "sem a mensagem da quebra de linha: $(cat "$root/out")"

echo "start.sh render: todos os cenários passaram."
