#!/bin/bash
# Testes da montagem dos arquivos de ambiente do start.sh (../bin/start.sh, função `render`), sem root, sem Docker e
# sem a GCP. Uma pasta temporária faz o papel de /etc/verax, /var/lib/verax e /run/verax; o gcloud é simulado (nenhum
# cofre tem valor, como numa VM recém-criada), e o despacho do fim do script (`case`) fica de fora: o teste chama o
# `render` direto. O que depende do Docker (subir os contêineres) fica para a VM.
#
#   bash tests/start-test.sh
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

cat >"$work/bin/gcloud" <<'EOF'
#!/bin/bash
echo "ERROR: (gcloud.secrets.versions.access) NOT_FOUND: Secret Version [latest] not found or has no versions." >&2
exit 1
EOF
chmod +x "$work/bin/gcloud"

# Uma raiz nova para cada cenário, com os segredos internos que o install.sh gera e o script com os caminhos fixos
# trocados pela raiz e sem o `case` do fim.
new_root() {
  scenario=$1
  root=$work/root-$2
  mkdir -p "$root/etc/verax" "$root/var/lib/verax/secrets"
  local name
  for name in postgres-master postgres-migrator postgres-app better-auth-secret csrf-secret; do
    echo "segredo-$name" >"$root/var/lib/verax/secrets/$name"
  done
  sed -e "s#/etc/verax#$root/etc/verax#g" -e "s#/var/lib/verax#$root/var/lib/verax#g" \
    -e "s#/run/verax#$root/run/verax#g" -e '/^case \${1:-} in$/,$d' "$script" >"$root/start-functions.sh"
}

# O node.conf de exemplo, com as linhas dadas no lugar das do exemplo.
node_conf() { # <CHAVE=valor...>
  local line
  grep -v -e '^#' -e '^$' "$example" >"$root/etc/verax/node.conf"
  for line in "$@"; do
    sed -i "s|^${line%%=*}=.*|$line|" "$root/etc/verax/node.conf"
  done
}

# Roda o `render` como o `up` faz, num processo à parte. Devolve o código de saída dele.
render_env() {
  local code=0
  (
    PATH=$work/bin:$PATH
    # shellcheck source=/dev/null
    source "$root/start-functions.sh"
    render
  ) >"$root/out" 2>&1 || code=$?
  return "$code"
}

api_env() { echo "$root/run/verax/api.env"; }
has_topic() { grep -q GCP_SINK_TOPIC_PREFIX "$(api_env)"; }

# --- node.conf de exemplo: o tópico vai para a API ---------------------------------------------------------------------
new_root "node.conf de exemplo" exemplo
node_conf
render_env || fail "o render falhou: $(cat "$root/out")"
grep -qxF "GCP_SINK_TOPIC_PREFIX='projects/projeto-do-no/topics/verax-node-security-'" "$(api_env)" ||
  fail "o api.env não tem o tópico do sink montado do projeto e do prefixo: $(grep -v SECRET "$(api_env)")"
! grep -q GCP_SINK_TOPIC_PREFIX "$root/run/verax/worker.env" || fail "o tópico foi para o worker, que não o usa"
grep -q 'sem o cloudflared' "$root/out" || fail "sem o aviso do túnel com o cofre vazio: $(cat "$root/out")"

# --- Prefixo fora do formato: a API sobe sem o tópico ------------------------------------------------------------------
new_root "prefixo fora do formato" prefixo
node_conf VERAX_SECRET_PREFIX=Verax_Node
render_env || fail "o render deveria avisar e seguir: $(cat "$root/out")"
! has_topic || fail "escreveu um tópico que a API recusaria"
grep -q 'VERAX_GCP_PROJECT ou VERAX_SECRET_PREFIX fora do formato' "$root/out" || fail "sem o aviso: $(cat "$root/out")"
grep -qxF "PLAN='interno'" "$(api_env)" || fail "o resto do api.env não ficou como antes"

# --- Projeto fora do formato ------------------------------------------------------------------------------------------
new_root "projeto fora do formato" projeto
node_conf VERAX_GCP_PROJECT=123456789012
render_env || fail "o render deveria avisar e seguir: $(cat "$root/out")"
! has_topic || fail "escreveu um tópico que a API recusaria"

echo "start.sh: todos os cenários passaram."
