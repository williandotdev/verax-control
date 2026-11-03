#!/bin/bash
# Partida e parada do nó (verax-node.service) e a primeira configuração. Uso (root, na VM):
#   start.sh up          monta os arquivos de ambiente e sobe banco, papéis, migrations, API, worker e túnel
#   start.sh down        para tudo (os dados ficam em /var/lib/verax)
#   start.sh bootstrap   primeiro admin, cliente e contas (variáveis BOOTSTRAP_*; ver docs/runbooks/no-verax.md)
#
# Os arquivos de ambiente ficam em /run/verax (memória, só root): somem ao desligar e são montados de novo a cada
# partida. Segredos de fora (senha do e-mail e token do túnel) vêm do Secret Manager com a identidade da própria VM;
# os de dentro (senhas do banco, chaves da sessão e do CSRF) foram gerados pelo install.sh e ficam em
# /var/lib/verax/secrets (0600, só root). Nenhum valor é impresso.
set -euo pipefail
umask 077

# shellcheck source=/dev/null
source /etc/verax/node.conf

secrets=/var/lib/verax/secrets
run=/run/verax
compose() {
  docker compose --project-directory /opt/verax -f /opt/verax/compose.yaml --env-file /etc/verax/images.env "$@"
}

internal_secret() { cat "$secrets/$1"; }

# Segredo do Secret Manager, sem quebra de linha no fim; recusa valor com quebra no meio (quebraria o arquivo de
# ambiente e poderia injetar outra variável).
external_secret() {
  local value
  value=$(gcloud secrets versions access latest --project "$VERAX_GCP_PROJECT" \
    --secret "$VERAX_SECRET_PREFIX-$1" 2>/dev/null) || {
    echo "Segredo $VERAX_SECRET_PREFIX-$1 sem valor no Secret Manager (ver docs/runbooks/no-verax.md)." >&2
    return 1
  }
  value=${value%$'\n'}
  if [[ -z $value || $value == *$'\n'* || $value == *$'\r'* ]]; then
    echo "Segredo $VERAX_SECRET_PREFIX-$1 vazio ou com quebra de linha." >&2
    return 1
  fi
  printf '%s' "$value"
}

database_url() { # <papel> <senha>
  printf 'postgresql://%s:%s@postgres:5432/verax?sslmode=verify-full&sslrootcert=/etc/verax/tls/ca.crt' "$1" "$2"
}

write_env() { # <arquivo> <linhas...>
  printf '%s\n' "${@:2}" >"$run/$1"
  chmod 0600 "$run/$1"
}

render() {
  mkdir -p "$run"
  chmod 0700 "$run"
  local master migrator app
  master=$(internal_secret postgres-master)
  migrator=$(internal_secret postgres-migrator)
  app=$(internal_secret postgres-app)

  write_env postgres.env POSTGRES_USER=verax "POSTGRES_PASSWORD=$master" POSTGRES_DB=verax
  write_env db-bootstrap.env \
    DB_MASTER_USERNAME=verax "DB_MASTER_PASSWORD=$master" \
    "MIGRATOR_DATABASE_URL=$(database_url verax_migrator "$migrator")" \
    "DATABASE_URL=$(database_url verax_app "$app")"
  write_env migrate.env NODE_ENV=production "DATABASE_URL=$(database_url verax_migrator "$migrator")"
  # TRUST_PROXY_HOPS=1: um proxy confiável na frente da API, o Cloudflare (o cloudflared só repassa).
  write_env api.env \
    NODE_ENV=production LOG_LEVEL=info PORT=3000 \
    "WEB_ORIGIN=$WEB_ORIGIN" "API_ORIGIN=$API_ORIGIN" \
    TRUST_PROXY_HOPS=1 \
    "BETTER_AUTH_SECRET=$(internal_secret better-auth-secret)" \
    "CSRF_SECRET=$(internal_secret csrf-secret)" \
    MAIL_TRANSPORT=smtp "MAIL_FROM=$MAIL_FROM" \
    "SMTP_HOST=$SMTP_HOST" "SMTP_PORT=$SMTP_PORT" "SMTP_USER=$SMTP_USER" \
    "SMTP_PASSWORD=$(external_secret smtp-password)" \
    "DATABASE_URL=$(database_url verax_app "$app")"
  write_env worker.env \
    NODE_ENV=production LOG_LEVEL=info \
    "SYNC_SOURCES=$SYNC_SOURCES" SYNC_INTERVAL_SECONDS=60 \
    "DATABASE_URL=$(database_url verax_app "$app")"
  write_env cloudflared.env "TUNNEL_TOKEN=$(external_secret cloudflare-tunnel-token)"
}

up() {
  render
  compose pull --quiet
  compose up --detach --wait postgres
  # Sequência do deploy, a mesma do teste da imagem no CI.
  compose --profile setup run --rm db-bootstrap
  compose --profile setup run --rm migrate
  compose --profile setup run --rm db-bootstrap
  compose up --detach --wait api
  compose up --detach worker cloudflared
}

bootstrap() {
  : "${BOOTSTRAP_ADMIN_EMAIL:?defina BOOTSTRAP_ADMIN_EMAIL}"
  render
  write_env bootstrap.env \
    "BOOTSTRAP_ADMIN_EMAIL=$BOOTSTRAP_ADMIN_EMAIL" \
    "BOOTSTRAP_ADMIN_NAME=${BOOTSTRAP_ADMIN_NAME:-Administrador Verax}" \
    "BOOTSTRAP_TENANT_NAME=${BOOTSTRAP_TENANT_NAME:-}" \
    "BOOTSTRAP_GCP_ACCOUNTS=${BOOTSTRAP_GCP_ACCOUNTS:-}"
  compose --profile setup run --rm bootstrap
  rm -f "$run/bootstrap.env"
}

case ${1:-} in
  up) up ;;
  down) compose down ;;
  bootstrap) bootstrap ;;
  *)
    echo "Uso: start.sh up|down|bootstrap" >&2
    exit 2
    ;;
esac
