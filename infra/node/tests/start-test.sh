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
#    entram juntas. Os valores do papel de leitura sem chave da AWS (NODE_SA_UNIQUE_ID e AWS_WEB_IDENTITY_AUDIENCE)
#    entram depois do IP de saída e antes do Turnstile; sem eles, o api.env é o de referência, byte a byte.
# 3. Os agentes do Wazuh (WAZUH_AGENTS): desligados, o standard sai byte a byte como sem a linha; ligados, a API recebe
#    o endereço, o cliente, as faixas, o limite, a CA e a senha de registro (só ela), o worker o caminho da lista e o
#    cliente; no lean, sem o IP, o cliente, a senha ou o certificado, ou com um valor fora do formato, o render para
#    sem escrever nada. E o projeto do Compose (start.sh down, com o Docker simulado): o compose.wazuh-agents.yaml só
#    entra no standard com o interruptor.
# 4. A AWS sem chave no Wazuh (PR-V4'): a pasta dos sinais só no worker do standard (WAZUH_SIGNAL_DIR), e a parada tira
#    da memória o token do Google, os profiles e os sinais, sem apagar os arquivos de ambiente.
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

env_files() { [[ -d $run ]] || return 0; (cd "$run" && find . -maxdepth 1 -type f | sed 's|^\./||' | LC_ALL=C sort | tr '\n' ' '); }
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
expect "no lean, nada dos sinais do Wazuh no worker" 0 "$(grep -c WAZUH_SIGNAL_DIR "$run/worker.env" || true)"
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

echo "== IP de saída do nó: só na API, e só no formato que o install.sh e a API aceitam"
expect "sem a linha no node.conf (o exemplo), nada" 0 "$(grep -c NODE_EGRESS_IPS "$run/api.env" || true)"
render_with NODE_EGRESS_IPS=203.0.113.10/32,198.51.100.7/32
expect "a API recebe os IPs (o filtro de IP recomendado para o token do Cloudflare)" 1 \
  "$(grep -c "^NODE_EGRESS_IPS='203.0.113.10/32,198.51.100.7/32'$" "$run/api.env")"
expect "o worker não os recebe (não os usa)" 0 "$(grep -c NODE_EGRESS_IPS "$run/worker.env" || true)"
status=0
render_with NODE_EGRESS_IPS=203.0.113.10/24 || status=$?
expect "fora do formato: o render avisa e segue, sem a variável que a API recusaria" '0 0 1' \
  "$status $(grep -c NODE_EGRESS_IPS "$run/api.env" || true) $(grep -c 'NODE_EGRESS_IPS fora do formato' "$work/render.err")"

echo "== papel de leitura sem chave da AWS: o ID da conta de serviço do nó e o audience, só na API e só no formato"
render 2>"$work/render.err"
expect "sem as linhas no node.conf (o exemplo, só com elas comentadas), nada" 0 \
  "$(grep -c -e NODE_SA_UNIQUE_ID -e AWS_WEB_IDENTITY_AUDIENCE "$run/api.env" || true)"
expect "e nenhum aviso sobre elas" 0 "$(grep -c -e NODE_SA_UNIQUE_ID -e AWS_WEB_IDENTITY_AUDIENCE "$work/render.err" || true)"
render_with NODE_SA_UNIQUE_ID=123456789012345678901 AWS_WEB_IDENTITY_AUDIENCE=https://control.veraxsistemas.com.br/aws-reader
expect "a API recebe o ID da conta de serviço (o NodeServiceAccountId da pilha)" 1 \
  "$(grep -c "^NODE_SA_UNIQUE_ID='123456789012345678901'$" "$run/api.env")"
expect "a API recebe o audience (o Audience da pilha)" 1 \
  "$(grep -c "^AWS_WEB_IDENTITY_AUDIENCE='https://control.veraxsistemas.com.br/aws-reader'$" "$run/api.env")"
expect "o worker não os recebe (a conferência real, que os usa, vem no PR-V5')" 0 \
  "$(grep -c -e NODE_SA_UNIQUE_ID -e AWS_WEB_IDENTITY_AUDIENCE "$run/worker.env" || true)"
render_with NODE_SA_UNIQUE_ID=123456789012345678901
expect "só o ID: o audience fica de fora (vale o padrão do template)" '1 0' \
  "$(grep -c '^NODE_SA_UNIQUE_ID=' "$run/api.env") $(grep -c AWS_WEB_IDENTITY_AUDIENCE "$run/api.env" || true)"
for bad_id in 12345678901234567890 1234567890123456789012 conta-do-no@exemplo; do
  status=0
  render_with "NODE_SA_UNIQUE_ID=$bad_id" || status=$?
  expect "ID fora do formato ($bad_id): o render avisa e segue, sem a variável que a API recusaria" '0 0 1' \
    "$status $(grep -c NODE_SA_UNIQUE_ID "$run/api.env" || true) $(grep -c 'NODE_SA_UNIQUE_ID fora do formato' "$work/render.err")"
done
for bad_audience in http://control.veraxsistemas.com.br/aws-reader 'https://control.veraxsistemas.com.br/*' \
  https://Control.veraxsistemas.com.br https://control.veraxsistemas.com.br:8443/aws-reader \
  "https://control.veraxsistemas.com.br/$(printf 'a%.0s' {1..250})"; do
  status=0
  render_with "AWS_WEB_IDENTITY_AUDIENCE=$bad_audience" || status=$?
  expect "audience fora do formato (${bad_audience:0:60}): o render avisa e segue, sem a variável" '0 0 1' \
    "$status $(grep -c AWS_WEB_IDENTITY_AUDIENCE "$run/api.env" || true) $(grep -c 'AWS_WEB_IDENTITY_AUDIENCE fora do formato' "$work/render.err")"
done

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
expect "a pasta dos sinais do Wazuh só no worker (a que o compose.wazuh.yaml monta nele)" \
  "0 WAZUH_SIGNAL_DIR='/run/wazuh-signal'" \
  "$(grep -c WAZUH_SIGNAL_DIR "$run/api.env" || true) $(grep '^WAZUH_SIGNAL_DIR=' "$run/worker.env")"

echo "== agentes do Wazuh: desligados, os arquivos de ambiente do standard saem byte a byte como sem o interruptor"
# O standard de antes (sem a linha no node.conf) contra WAZUH_AGENTS=false: os mesmos arquivos, o mesmo conteúdo.
snapshot() { (cd "$run" && for file in $(find . -maxdepth 1 -type f | LC_ALL=C sort); do
  printf '## %s\n' "$file"
  cat "$file"
done); }
rm -rf "$run"
render_with WAZUH_AGENTS= 2>/dev/null
before=$(snapshot)
rm -rf "$run"
render_with WAZUH_AGENTS=false 2>/dev/null
expect "WAZUH_AGENTS=false dá exatamente o standard de sempre" 0 \
  "$(diff <(echo "$before") <(snapshot) | wc -l | tr -d ' ')"
expect "nenhuma variável dos agentes em arquivo nenhum" 0 "$(cat "$run"/*.env | grep -c '^WAZUH_AGENTS' || true)"
expect "api.env do standard: as variáveis de sempre, na ordem de sempre" \
  'NODE_ENV LOG_LEVEL PORT WEB_ORIGIN API_ORIGIN TRUST_PROXY_HOPS BETTER_AUTH_SECRET CSRF_SECRET MAIL_TRANSPORT MAIL_FROM PLAN INDEXER_URL INDEXER_AUTH INDEXER_USERNAME INDEXER_PASSWORD INDEXER_CA_FILE GCP_SINK_TOPIC_PREFIX DATABASE_URL' \
  "$(cut -d= -f1 "$run/api.env" | tr '\n' ' ' | sed 's/ $//')"
expect "worker.env do standard: as variáveis de sempre, na ordem de sempre" \
  'NODE_ENV LOG_LEVEL SYNC_SOURCES SYNC_INTERVAL_SECONDS PLAN INDEXER_URL INDEXER_AUTH INDEXER_USERNAME INDEXER_PASSWORD INDEXER_CA_FILE WAZUH_SIGNAL_DIR DATABASE_URL' \
  "$(cut -d= -f1 "$run/worker.env" | tr '\n' ' ' | sed 's/ $//')"

echo "== agentes do Wazuh: ligados no standard"
# O que o install.sh gera: a senha de registro (letras e dígitos) e o certificado do registro (aqui, só o conteúdo).
agents_certs=$work/agents
mkdir -p "$agents_certs"
for name in ca.crt manager.crt manager.key; do printf 'conteudo-de-%s\n' "$name" >"$agents_certs/$name"; done
enrollment=$(head -c 96 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-32)
printf '%s' "$enrollment" >"$secrets/wazuh-agents-enrollment"
tenant=018f2c1e-0000-7000-8000-00000000a001
agents_on=(WAZUH_AGENTS=true WAZUH_AGENTS_ADDRESS=203.0.113.10 "WAZUH_AGENTS_TENANT=$tenant")
rm -rf "$run"
status=0
render_with "${agents_on[@]}" WAZUH_AGENTS_SOURCES=198.51.100.0/28,192.0.2.15/32 WAZUH_AGENTS_MAX=40 || status=$?
expect "o render passa" 0 "$status"
expect "os mesmos arquivos do standard (nenhum arquivo de ambiente novo)" \
  'api.env bootstrap.env cloudflared.env db-bootstrap.env memory.env migrate.env postgres.env wazuh-manager.env wazuh-security.env worker.env ' \
  "$(env_files)"
expect "a API recebe o endereço, o cliente, as faixas, o limite, a CA em base64 e a senha, nessa ordem" \
  "WAZUH_AGENTS='true';WAZUH_AGENTS_ADDRESS='203.0.113.10';WAZUH_AGENTS_TENANT='$tenant';WAZUH_AGENTS_SOURCES='198.51.100.0/28,192.0.2.15/32';WAZUH_AGENTS_MAX='40';WAZUH_AGENTS_CA='$(base64 -w0 "$agents_certs/ca.crt")';WAZUH_AGENTS_ENROLLMENT_PASSWORD='$enrollment';" \
  "$(grep '^WAZUH_AGENTS' "$run/api.env" | tr '\n' ';')"
expect "o worker recebe só o caminho da lista e o cliente" \
  "WAZUH_AGENTS_FILE='/run/wazuh-agents/agents.json';WAZUH_AGENTS_TENANT='$tenant';" \
  "$(grep '^WAZUH_AGENTS' "$run/worker.env" | tr '\n' ';')"
expect "a senha de registro só no api.env (o manager a lê do arquivo, pelo gerador)" 'api.env' \
  "$(cd "$run" && grep -l -F "$enrollment" ./*.env | sed 's|^\./||' | tr '\n' ' ' | sed 's/ $//')"
expect "a senha de registro não sai na tela" 0 "$(grep -c -F "$enrollment" "$work/render.err" || true)"
rm -rf "$run"
render_with "${agents_on[@]}" 2>/dev/null
expect "sem as faixas e sem o limite, as duas linhas ficam de fora" 0 \
  "$(grep -cE '^WAZUH_AGENTS_(SOURCES|MAX)=' "$run/api.env" || true)"

echo "== agentes do Wazuh: o que o render recusa, sem escrever nada"
refused() { # <descrição> <trecho da mensagem> <CHAVE=valor...>
  local label=$1 message=$2 status=0
  shift 2
  rm -rf "$run"
  render_with "$@" || status=$?
  expect "$label: o render para" 1 "$status"
  expect "$label: a mensagem diz o motivo" 1 "$(grep -c -F "$message" "$work/render.err")"
  expect "$label: nenhum arquivo de ambiente" '' "$(env_files)"
}
refused "lean" 'WAZUH_AGENTS=true só no perfil standard' NODE_PROFILE=lean "${agents_on[@]}"
refused "valor que não é true nem false" 'WAZUH_AGENTS inválido' WAZUH_AGENTS=sim
refused "sem o IP dos agentes" 'WAZUH_AGENTS_ADDRESS inválido' WAZUH_AGENTS=true "WAZUH_AGENTS_TENANT=$tenant"
refused "IP com máscara" 'WAZUH_AGENTS_ADDRESS inválido' "${agents_on[@]}" WAZUH_AGENTS_ADDRESS=203.0.113.10/32
refused "sem o cliente" 'WAZUH_AGENTS_TENANT inválido' WAZUH_AGENTS=true WAZUH_AGENTS_ADDRESS=203.0.113.10
refused "faixa larga demais" 'WAZUH_AGENTS_SOURCES inválido' "${agents_on[@]}" WAZUH_AGENTS_SOURCES=0.0.0.0/0
refused "limite acima de 500" 'WAZUH_AGENTS_MAX inválido' "${agents_on[@]}" WAZUH_AGENTS_MAX=501
mv "$secrets/wazuh-agents-enrollment" "$work/enrollment.bak"
refused "sem a senha de registro (install.sh não rodou)" "Falta $secrets/wazuh-agents-enrollment" "${agents_on[@]}"
mv "$work/enrollment.bak" "$secrets/wazuh-agents-enrollment"
mv "$agents_certs/manager.key" "$work/key.bak"
refused "sem a chave do certificado do registro" "Falta $agents_certs/manager.key" "${agents_on[@]}"
mv "$work/key.bak" "$agents_certs/manager.key"
printf 'senha com espaço e aspas %s' "'" >"$secrets/wazuh-agents-enrollment"
refused "senha de registro fora do formato" 'deve ter de 32 a 64 letras e dígitos' "${agents_on[@]}"
expect "a senha fora do formato não sai na mensagem" 0 "$(grep -c 'senha com espaço' "$work/render.err" || true)"
printf '%s' "$enrollment" >"$secrets/wazuh-agents-enrollment"
NODE_PROFILE=standard

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

# --- Turnstile e IP de saída do nó juntos: ordem fixa no api.env (o IP antes das chaves do Turnstile) ---------------
new_root "Turnstile e IP de saída do nó" ligado-com-ip
node_conf TURNSTILE_SITE_KEY=1x00000000000000000000AA NODE_EGRESS_IPS=203.0.113.10/32
printf 'segredo-ficticio-do-turnstile\n' >"$root/vault/verax-node-turnstile-secret-key"
render_env || fail "o render falhou: $(cat "$root/out")"
egress_line="NODE_EGRESS_IPS='203.0.113.10/32'"
with_turnstile_and_egress=${with_turnstile/TURNSTILE_SITE_KEY=/$egress_line$'\n'TURNSTILE_SITE_KEY=}
[ "$(api_env)" = "$with_turnstile_and_egress" ] || fail "a ordem do api.env mudou:
$(diff <(echo "$with_turnstile_and_egress") <(api_env) || true)"
grep -qi 'aviso' "$root/out" && fail "avisou com tudo configurado: $(cat "$root/out")"

# --- Papel de leitura sem chave da AWS: os dois valores do nó logo depois do IP de saída, antes do Turnstile --------
# Sem as duas linhas, o api.env é o de referência acima, byte a byte (o primeiro cenário, com o node.conf de exemplo,
# em que elas só aparecem comentadas).
new_root "papel de leitura da AWS, IP de saída e Turnstile" papel-aws
node_conf TURNSTILE_SITE_KEY=1x00000000000000000000AA NODE_EGRESS_IPS=203.0.113.10/32 \
  NODE_SA_UNIQUE_ID=123456789012345678901 AWS_WEB_IDENTITY_AUDIENCE=https://control.veraxsistemas.com.br/aws-reader
printf 'segredo-ficticio-do-turnstile\n' >"$root/vault/verax-node-turnstile-secret-key"
render_env || fail "o render falhou: $(cat "$root/out")"
aws_reader_lines="NODE_SA_UNIQUE_ID='123456789012345678901'"$'\n'"AWS_WEB_IDENTITY_AUDIENCE='https://control.veraxsistemas.com.br/aws-reader'"
with_aws_reader=${with_turnstile_and_egress/TURNSTILE_SITE_KEY=/$aws_reader_lines$'\n'TURNSTILE_SITE_KEY=}
[ "$(api_env)" = "$with_aws_reader" ] || fail "o api.env com o papel da AWS saiu diferente:
$(diff <(echo "$with_aws_reader") <(api_env) || true)"
grep -qi 'aviso' "$root/out" && fail "avisou com tudo configurado: $(cat "$root/out")"
grep -q -e NODE_SA_UNIQUE_ID -e AWS_WEB_IDENTITY_AUDIENCE "$root/run/verax/worker.env" &&
  fail "o worker recebeu os valores do papel da AWS (só a API os usa neste PR)"
grep -q -e 'node-sa' -e 'aws' "$root/vault/log" && fail "leu um cofre por causa do papel da AWS: $(cat "$root/vault/log")"

# Só com os dois valores (sem o IP de saída nem o Turnstile): o resto do api.env continua o de referência.
new_root "só o papel de leitura da AWS" papel-aws-so
node_conf NODE_SA_UNIQUE_ID=123456789012345678901 AWS_WEB_IDENTITY_AUDIENCE=https://control.veraxsistemas.com.br/aws-reader
render_env || fail "o render falhou: $(cat "$root/out")"
only_aws_reader=${baseline/DATABASE_URL=/$aws_reader_lines$'\n'DATABASE_URL=}
[ "$(api_env)" = "$only_aws_reader" ] || fail "o api.env só com o papel da AWS saiu diferente:
$(diff <(echo "$only_aws_reader") <(api_env) || true)"

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

# --- Agentes do Wazuh: o projeto do Compose que o start.sh monta (start.sh down, com o Docker simulado) -----------
# O compose.wazuh-agents.yaml (as portas 1514 e 1515 do manager) só entra no standard com WAZUH_AGENTS=true; sem a
# linha, o projeto é o de sempre. No lean, o interruptor não traz o Wazuh (o render recusa a combinação, na parte 1).
cat >"$work/bin/docker" <<'EOF'
#!/bin/bash
echo "docker $*" >>"$VAULT/docker.log"
EOF
chmod +x "$work/bin/docker"
compose_files() { # <cenário> <pasta> <CHAVE=valor...>: os -f do `docker compose` que o `down` chamou
  new_root "$1" "$2"
  node_conf "${@:3}"
  env -i PATH="$work/bin:$PATH" VAULT="$root/vault" "$BASH" "$root/start.sh" down >"$root/out" 2>&1 ||
    fail "o down falhou: $(cat "$root/out")"
  grep -oE ' -f [^ ]+' "$root/vault/docker.log" | sed 's/^ -f //' | tr '\n' ' ' | sed 's/ $//'
}
[ "$(compose_files "standard sem os agentes" compose-standard NODE_PROFILE=standard)" = \
  "/opt/verax/compose.yaml /opt/verax/compose.wazuh.yaml" ] || fail "o projeto do standard mudou"
[ "$(compose_files "standard com WAZUH_AGENTS=false" compose-desligado NODE_PROFILE=standard WAZUH_AGENTS=false)" = \
  "/opt/verax/compose.yaml /opt/verax/compose.wazuh.yaml" ] || fail "WAZUH_AGENTS=false mudou o projeto"
[ "$(compose_files "standard com os agentes" compose-agentes NODE_PROFILE=standard WAZUH_AGENTS=true)" = \
  "/opt/verax/compose.yaml /opt/verax/compose.wazuh.yaml /opt/verax/compose.wazuh-agents.yaml" ] ||
  fail "o arquivo dos agentes não entrou no projeto"
[ "$(compose_files "agentes e cofre" compose-agentes-cofre NODE_PROFILE=standard WAZUH_AGENTS=true CREDENTIALS_VAULT=true)" = \
  "/opt/verax/compose.yaml /opt/verax/compose.wazuh.yaml /opt/verax/compose.wazuh-agents.yaml /opt/verax/compose.vault.yaml" ] ||
  fail "o projeto com os agentes e o cofre mudou"
[ "$(compose_files "lean com o interruptor" compose-lean NODE_PROFILE=lean WAZUH_AGENTS=true)" = \
  "/opt/verax/compose.yaml" ] || fail "o lean ganhou arquivo do Wazuh"
echo "ok     agentes: o projeto do Compose só muda com o interruptor, no standard"

# --- A parada tira da memória o token do Google, os profiles da AWS e os sinais do Wazuh (PR-V4') ---------------
new_root "parada com o Wazuh" parada-wazuh
node_conf NODE_PROFILE=standard
mkdir -p "$root/run/verax/wazuh-aws" "$root/run/verax/wazuh-signal" "$root/run/verax/wazuh-apply"
printf 'token.de.teste' >"$root/run/verax/wazuh-aws/google-id-token"
printf '[profile verax-111122223333]\n' >"$root/run/verax/wazuh-aws/config"
printf '{}\n' >"$root/run/verax/wazuh-signal/applied"
printf 'hash\n' >"$root/run/verax/wazuh-apply/running"
: >"$root/run/verax/api.env"
env -i PATH="$work/bin:$PATH" VAULT="$root/vault" "$BASH" "$root/start.sh" down >"$root/out" 2>&1 ||
  fail "o down falhou: $(cat "$root/out")"
for dir in wazuh-aws wazuh-signal wazuh-apply; do
  [ ! -e "$root/run/verax/$dir" ] || fail "o down deixou $dir na memória"
done
[ -e "$root/run/verax/api.env" ] || fail "o down apagou os arquivos de ambiente"
echo "ok     parada: o token, os profiles e os sinais do Wazuh saem da memória; os arquivos de ambiente ficam"
)

if ((failures > 0)); then
  echo "$failures verificação(ões) falharam." >&2
  exit 1
fi
echo "start.sh: todas as verificações passaram."
