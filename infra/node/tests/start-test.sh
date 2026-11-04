#!/bin/bash
# Testa o bin/start.sh sem root, sem Docker e sem a GCP: os arquivos de ambiente que o `render` escreve nos dois perfis
# (com o tópico do sink de projeto de cliente só quando o projeto e o prefixo do node.conf seguem o formato do módulo),
# o `bootstrap` e o `pull_images`, com o Compose e o Docker simulados e um gcloud de mentira no PATH (nenhum cofre tem
# valor, como numa VM recém-criada). O script é carregado inteiro (com o node.conf.example no lugar de
# /etc/verax/node.conf e sem a chamada do fim), então é o código do nó que roda aqui; o write_env, o external_secret,
# o wazuh_passwords e o lib-passwords.sh são os de verdade. No CI: `bash infra/node/tests/start-test.sh`.
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

if ((failures > 0)); then
  echo "$failures verificação(ões) falharam." >&2
  exit 1
fi
echo "start.sh: todas as verificações passaram."
