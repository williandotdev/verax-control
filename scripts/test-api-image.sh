#!/usr/bin/env bash
# Testa a imagem da API como ela roda no ECS (T8.2): produção, raiz só leitura, sem capabilities, sem ganho de
# privilégio, usuário sem privilégio e banco por TLS com o certificado conferido (sslmode=verify-full).
#
# Sobe, numa rede Docker isolada (sem internet), um PostgreSQL 18 com TLS e uma CA descartável, e confere:
# - a sequência do deploy: papéis de banco (conta mestra), migrations (papel das migrations, sem baixar nada:
#   Schema Engine embutido) e papéis de novo; a aplicação não cria tabelas nem apaga a auditoria;
# - /health responde; /health/ready conecta ao banco pelo TLS verificado;
# - a raiz do contêiner não aceita escrita e o processo não é root;
# - com uma CA que não assinou o certificado do banco, a API não fica pronta.
# Uso: scripts/test-api-image.sh [imagem da API] [imagem de migrations]
#      (padrão: verax-api:teste e verax-api-migrate:teste). Precisa de Docker. Limpa tudo no fim.
set -euo pipefail

image=${1:-verax-api:teste}
migrate_image=${2:-verax-api-migrate:teste}
pg_image=postgres:18-alpine@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5
# Mesma base do Dockerfile da API; o openssl vem do repositório assinado do Alpine, só para gerar os certificados.
tools_image=node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
run_id=verax-api-teste-$$
network=$run_id
certs=$run_id-certs
db=$run_id-db
api=$run_id-api

failures=0
expect() { # <descrição> <esperado (regex)> <obtido>
  if [[ $3 =~ ^($2)$ ]]; then
    printf 'ok     %s\n' "$1"
  else
    printf 'FALHA  %s (esperado %s, obtido %s)\n' "$1" "$2" "$3"
    failures=$((failures + 1))
  fi
}

cleanup() {
  docker rm -f "$api" "$api-errada" "$db" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker volume rm "$certs" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Senha descartável, só desta execução.
password=$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)

docker network create --internal "$network" >/dev/null
docker volume create "$certs" >/dev/null

echo "== CA e certificado do banco (descartáveis)"
docker run --rm -v "$certs:/certs" --entrypoint sh "$tools_image" -c '
  set -e
  apk add --no-cache --quiet openssl
  cd /certs
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=CA de teste" -keyout ca.key -out ca.pem 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN='"$db"'" -keyout server.key -out server.csr 2>/dev/null
  printf "subjectAltName=DNS:'"$db"'\n" > san.ext
  openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 1 -extfile san.ext -out server.crt 2>/dev/null
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=Outra CA" -keyout other.key -out other-ca.pem 2>/dev/null
  rm -f ca.key other.key server.csr san.ext
  chown 70:70 server.key server.crt && chmod 600 server.key
  chmod 644 ca.pem other-ca.pem'

echo "== PostgreSQL 18 com TLS"
docker run -d --name "$db" --network "$network" -v "$certs:/certs:ro" \
  -e POSTGRES_USER=verax -e POSTGRES_PASSWORD="$password" -e POSTGRES_DB=verax \
  "$pg_image" -c ssl=on -c ssl_cert_file=/certs/server.crt -c ssl_key_file=/certs/server.key \
  -c ssl_min_protocol_version=TLSv1.2 >/dev/null
for _ in {1..30}; do
  docker exec "$db" pg_isready -U verax -d verax >/dev/null 2>&1 && break
  sleep 2
done

# Senhas dos papéis da aplicação e das migrations (no deploy, gravadas pelo Terraform no Secrets Manager).
app_password=$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)
migrator_password=$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)

database_url() { # <papel> <senha> <arquivo da CA>
  printf 'postgresql://%s:%s@%s:5432/verax?sslmode=verify-full&sslrootcert=/certs/%s' "$1" "$2" "$db" "$3"
}

hardened() { # opções de execução iguais às da tarefa no ECS
  docker run --rm --network "$network" --read-only --tmpfs /tmp:rw,nosuid,size=64m --cap-drop ALL \
    --security-opt no-new-privileges:true -v "$certs:/certs:ro" "$@"
}

bootstrap() {
  hardened -e DB_MASTER_USERNAME=verax -e DB_MASTER_PASSWORD="$password" \
    -e MIGRATOR_DATABASE_URL="$(database_url verax_migrator "$migrator_password" ca.pem)" \
    -e DATABASE_URL="$(database_url verax_app "$app_password" ca.pem)" \
    "$image" node dist/cli/db-bootstrap.js >/dev/null
}

echo "== Papéis de banco, migrations e papéis de novo (sequência do deploy, rede sem internet)"
bootstrap
hardened -e DATABASE_URL="$(database_url verax_migrator "$migrator_password" ca.pem)" "$migrate_image" >/dev/null
bootstrap
applied=$(docker exec "$db" psql -U verax -d verax -tAc \
  "select count(*) from _prisma_migrations where finished_at is not null" 2>/dev/null || echo 0)
expect "migrations aplicadas pelo papel das migrations" '[1-9][0-9]*' "$applied"
expect "tabelas criadas pertencem ao papel das migrations" verax_migrator \
  "$(docker exec "$db" psql -U verax -d verax -tAc "select tableowner from pg_tables where tablename = 'AuditLog'")"
# Expurgo (PR-19): as funções SECURITY DEFINER rodam com o dono delas, que tem de ser o das tabelas.
expect "funções do expurgo pertencem ao papel das migrations" 'verax_migrator verax_migrator' \
  "$(docker exec "$db" psql -U verax -d verax -tAc "select string_agg(pg_get_userbyid(proowner)::text, ' ') \
    from pg_proc where proname in ('verax_purge_audit_log', 'verax_purge_finding_comments')")"
as_app() { # <SQL>: roda como o papel da aplicação, dentro do contêiner do banco
  docker exec -e PGPASSWORD="$app_password" "$db" psql -h 127.0.0.1 -U verax_app -d verax -tAc "$1" 2>&1 || true
}
expect "aplicação não cria tabelas" '.*permission denied.*' "$(as_app 'create table invasora (id int)')"
expect "aplicação não apaga a auditoria" '.*permission denied.*' "$(as_app 'delete from "AuditLog"')"
expect "aplicação não apaga os comentários dos achados" '.*permission denied.*' \
  "$(as_app 'delete from "FindingComment"')"
expect "o expurgo da auditoria recusa corte mais novo que o piso" '.*piso de 13 meses.*' \
  "$(as_app 'select * from verax_purge_audit_log(now(), 10)')"

# Segredos da autenticação (E2) só deste teste; em produção vêm do Secrets Manager.
auth_secret=$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 43)
csrf_secret=$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 43)

run_api() { # <nome> <arquivo da CA>
  docker run -d --name "$1" --network "$network" \
    --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --cap-drop ALL --security-opt no-new-privileges:true \
    -v "$certs:/certs:ro" \
    -e NODE_ENV=production -e WEB_ORIGIN=https://painel.exemplo.com.br -e TRUST_PROXY_HOPS=1 \
    -e API_ORIGIN=https://api.exemplo.com.br -e BETTER_AUTH_SECRET="$auth_secret" -e CSRF_SECRET="$csrf_secret" \
    -e MAIL_TRANSPORT=ses -e MAIL_FROM=nao-responda@exemplo.com.br -e AWS_REGION=sa-east-1 -e PLAN=interno \
    -e DATABASE_URL="$(database_url verax_app "$app_password" "$2")" \
    "$image" >/dev/null
}

# Requisição de dentro da rede isolada, pelo Node da própria imagem (a rede não tem saída para o host).
probe() { # <contêiner> <caminho>
  docker exec "$1" node -e "fetch('http://127.0.0.1:3000$2').then(r => console.log(r.status)).catch(() => console.log(0))"
}

echo "== API com a CA certa"
run_api "$api" ca.pem
for _ in {1..30}; do
  [[ $(probe "$api" /health 2>/dev/null || true) == 200 ]] && break
  sleep 2
done
expect "/health" 200 "$(probe "$api" /health)"
expect "/health/ready (banco por TLS verificado)" 200 "$(probe "$api" /health/ready)"
expect "processo sem root" 1000 "$(docker exec "$api" id -u)"
expect "raiz só leitura" 1 "$(docker exec "$api" sh -c 'touch /app/x 2>/dev/null && echo 0 || echo 1')"
# No nó, o arquivo das chaves do cofre é 0400 do WORKER_UID que o start.sh escreve, numa pasta do grupo dele: o usuário
# da imagem (que roda a API e o worker) tem de ser esse uid e esse gid, senão o worker não lê as chaves.
worker_uid=$(sed -n 's/^WORKER_UID=//p' "$(dirname "$0")/../infra/node/bin/start.sh")
expect "usuário e grupo da imagem são o WORKER_UID do start.sh do nó" "$worker_uid:$worker_uid" \
  "$(docker run --rm --entrypoint sh "$image" -c 'echo "$(id -u):$(id -g)"')"

if [[ ${RUN_ZAP:-0} == 1 ]]; then
  echo "== OWASP ZAP baseline na API (T8.7; risco alto reprova)"
  if bash "$(dirname "$0")/zap-baseline.sh" "http://$api:3000" "$network"; then
    expect "ZAP sem achado de risco alto" 0 0
  else
    expect "ZAP sem achado de risco alto" 0 1
  fi
fi

echo "== API com outra CA (certificado do banco não confere)"
run_api "$api-errada" other-ca.pem
sleep 15
expect "não fica pronta sem conferir o certificado" '0|503' "$(probe "$api-errada" /health/ready 2>/dev/null || echo 0)"

if ((failures > 0)); then
  echo "--- log da API (sem segredos: a URL do banco não é registrada)"
  docker logs "$api" 2>&1 | tail -20
  echo "$failures verificação(ões) falharam." >&2
  exit 1
fi
echo "Imagem da API aprovada."
