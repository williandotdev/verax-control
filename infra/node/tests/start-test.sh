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
#    entram depois do IP de saída e antes do Turnstile; sem eles, o api.env é o de referência, byte a byte. O worker.env
#    recebe o IP e os dois valores depois do indexer (PR-V5'); sem as linhas, também sai byte a byte como antes. Sem o
#    e-mail, o worker.env é o de referência; com o SMTP, ganha o bloco do e-mail da API e a origem do painel (PR-16).
# 3. Os agentes do Wazuh (WAZUH_AGENTS): desligados, o standard sai byte a byte como sem a linha; ligados, a API recebe
#    o endereço, o cliente, as faixas, o limite, a CA e a senha de registro (só ela), o worker o caminho da lista e o
#    cliente; no lean, sem o IP, o cliente, a senha ou o certificado, ou com um valor fora do formato, o render para
#    sem escrever nada. E o projeto do Compose (start.sh down, com o Docker simulado): o compose.wazuh-agents.yaml só
#    entra no standard com o interruptor.
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

echo "== IP de saída do nó: na API e no worker, e só no formato que o install.sh, a API e o worker aceitam"
expect "sem a linha no node.conf (o exemplo), nada" 0 \
  "$(cat "$run/api.env" "$run/worker.env" | grep -c NODE_EGRESS_IPS || true)"
render_with NODE_EGRESS_IPS=203.0.113.10/32,198.51.100.7/32
expect "a API recebe os IPs (o filtro de IP recomendado para o token do Cloudflare)" 1 \
  "$(grep -c "^NODE_EGRESS_IPS='203.0.113.10/32,198.51.100.7/32'$" "$run/api.env")"
expect "o worker também (o aws:SourceIp da simulação da permissão demais, PR-V5')" 1 \
  "$(grep -c "^NODE_EGRESS_IPS='203.0.113.10/32,198.51.100.7/32'$" "$run/worker.env")"
status=0
render_with NODE_EGRESS_IPS=203.0.113.10/24 || status=$?
expect "fora do formato: o render avisa e segue, sem a variável que a API e o worker recusariam" '0 0 1' \
  "$status $(cat "$run/api.env" "$run/worker.env" | grep -c NODE_EGRESS_IPS || true) $(grep -c 'NODE_EGRESS_IPS fora do formato' "$work/render.err")"

echo "== papel de leitura sem chave da AWS: o ID da conta de serviço do nó e o audience, na API e no worker, só no formato"
render 2>"$work/render.err"
expect "sem as linhas no node.conf (o exemplo, só com elas comentadas), nada" 0 \
  "$(cat "$run/api.env" "$run/worker.env" | grep -c -e NODE_SA_UNIQUE_ID -e AWS_WEB_IDENTITY_AUDIENCE || true)"
expect "e nenhum aviso sobre elas" 0 "$(grep -c -e NODE_SA_UNIQUE_ID -e AWS_WEB_IDENTITY_AUDIENCE "$work/render.err" || true)"
render_with NODE_SA_UNIQUE_ID=123456789012345678901 AWS_WEB_IDENTITY_AUDIENCE=https://control.veraxsistemas.com.br/aws-reader
expect "a API recebe o ID da conta de serviço (o NodeServiceAccountId da pilha)" 1 \
  "$(grep -c "^NODE_SA_UNIQUE_ID='123456789012345678901'$" "$run/api.env")"
expect "a API recebe o audience (o Audience da pilha)" 1 \
  "$(grep -c "^AWS_WEB_IDENTITY_AUDIENCE='https://control.veraxsistemas.com.br/aws-reader'$" "$run/api.env")"
expect "o worker recebe os dois (a conferência real da conexão, PR-V5')" 2 \
  "$(grep -c -e "^NODE_SA_UNIQUE_ID='123456789012345678901'$" \
    -e "^AWS_WEB_IDENTITY_AUDIENCE='https://control.veraxsistemas.com.br/aws-reader'$" "$run/worker.env")"
render_with NODE_SA_UNIQUE_ID=123456789012345678901
expect "só o ID: o audience fica de fora (vale o padrão do template)" '1 0' \
  "$(grep -c '^NODE_SA_UNIQUE_ID=' "$run/api.env") $(grep -c AWS_WEB_IDENTITY_AUDIENCE "$run/api.env" || true)"
for bad_id in 12345678901234567890 1234567890123456789012 conta-do-no@exemplo; do
  status=0
  render_with "NODE_SA_UNIQUE_ID=$bad_id" || status=$?
  expect "ID fora do formato ($bad_id): o render avisa e segue, sem a variável que a API e o worker recusariam" '0 0 1' \
    "$status $(cat "$run/api.env" "$run/worker.env" | grep -c NODE_SA_UNIQUE_ID || true) $(grep -c 'NODE_SA_UNIQUE_ID fora do formato' "$work/render.err")"
done
for bad_audience in http://control.veraxsistemas.com.br/aws-reader 'https://control.veraxsistemas.com.br/*' \
  https://Control.veraxsistemas.com.br https://control.veraxsistemas.com.br:8443/aws-reader \
  "https://control.veraxsistemas.com.br/$(printf 'a%.0s' {1..250})"; do
  status=0
  render_with "AWS_WEB_IDENTITY_AUDIENCE=$bad_audience" || status=$?
  expect "audience fora do formato (${bad_audience:0:60}): o render avisa e segue, sem a variável" '0 0 1' \
    "$status $(cat "$run/api.env" "$run/worker.env" | grep -c AWS_WEB_IDENTITY_AUDIENCE || true) $(grep -c 'AWS_WEB_IDENTITY_AUDIENCE fora do formato' "$work/render.err")"
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
  'NODE_ENV LOG_LEVEL SYNC_SOURCES SYNC_INTERVAL_SECONDS PLAN INDEXER_URL INDEXER_AUTH INDEXER_USERNAME INDEXER_PASSWORD INDEXER_CA_FILE DATABASE_URL' \
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
worker_env() { cat "$root/run/verax/worker.env"; }

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

# O worker.env do nó da Verax, como o start.sh o monta com o node.conf de exemplo. Sem as linhas do papel de leitura
# da AWS, ele não muda (PR-V5').
worker_baseline=$(
  cat <<'EOF'
NODE_ENV='production'
LOG_LEVEL='info'
SYNC_SOURCES='gcp'
SYNC_INTERVAL_SECONDS='60'
PLAN='interno'
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
[ "$(worker_env)" = "$worker_baseline" ] || fail "o worker.env mudou sem as linhas do papel da AWS:
$(diff <(echo "$worker_baseline") <(worker_env) || true)"
[ ! -s "$root/out" ] || fail "o render avisou algo com tudo no lugar: $(cat "$root/out")"
grep -q 'turnstile' "$root/vault/log" && fail "leu o cofre do Turnstile sem a chave do site no node.conf"
[ "$(cat "$root/vault/log")" = "gcloud secrets versions access latest --project projeto-do-no --secret verax-node-cloudflare-tunnel-token" ] ||
  fail "chamadas ao gcloud diferentes das de antes: $(cat "$root/vault/log")"
[ "$(cat "$root/run/verax/cloudflared.env")" = "TUNNEL_TOKEN='token-do-tunel'" ] || fail "o cloudflared.env mudou"

# --- Avisos por e-mail (PR-16): o worker.env -----------------------------------------------------------------------
# Sem o e-mail (MAIL_TRANSPORT=none, o node.conf de exemplo do cenário acima), o worker.env é o de referência, byte a
# byte (conferido acima). Com o SMTP, o worker recebe o mesmo bloco da API e a origem do painel (o link dos avisos),
# logo antes do plano; a senha da caixa vai só para a API e o worker, e o api.env só troca o bloco do e-mail.
new_root "e-mail ligado (SMTP)" smtp
node_conf MAIL_TRANSPORT=smtp SMTP_HOST=smtp.exemplo.com SMTP_PORT=465 SMTP_USER=nao-responda@exemplo.com.br
printf 'senha-ficticia-da-caixa\n' >"$root/vault/verax-node-smtp-password"
render_env || fail "o render falhou: $(cat "$root/out")"
mail_lines="MAIL_TRANSPORT='smtp'
MAIL_FROM='nao-responda@exemplo.com.br'
SMTP_HOST='smtp.exemplo.com'
SMTP_PORT='465'
SMTP_USER='nao-responda@exemplo.com.br'
SMTP_PASSWORD='senha-ficticia-da-caixa'"
api_with_mail=${baseline/MAIL_TRANSPORT=\'none\'$'\n'MAIL_FROM=\'nao-responda@exemplo.com.br\'/$mail_lines}
[ "$(api_env)" = "$api_with_mail" ] || fail "o api.env com o SMTP saiu diferente:
$(diff <(echo "$api_with_mail") <(api_env) || true)"
worker_with_mail=${worker_baseline/PLAN=/$mail_lines$'\n'WEB_ORIGIN=\'https://cliente.control.exemplo.com.br\'$'\n'PLAN=}
[ "$(worker_env)" = "$worker_with_mail" ] || fail "o worker.env com o SMTP saiu diferente:
$(diff <(echo "$worker_with_mail") <(worker_env) || true)"
[ "$(cd "$root/run/verax" && grep -l -F 'senha-ficticia-da-caixa' ./*.env | LC_ALL=C sort | tr '\n' ' ')" = \
  "./api.env ./worker.env " ] || fail "a senha da caixa foi para outro arquivo de ambiente"
grep -q 'senha-ficticia' "$root/out" && fail "a senha da caixa saiu na tela"
grep -q -- '--secret verax-node-smtp-password' "$root/vault/log" || fail "não leu o cofre da senha da caixa"
echo "ok     avisos por e-mail: o worker.env sem o e-mail é o de antes; com o SMTP, o bloco da API e a origem do painel"

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
# O worker recebe o IP e os dois valores na mesma ordem, depois do plano (e do indexer, no standard), e nada do
# Turnstile.
worker_with_aws_reader=${worker_baseline/DATABASE_URL=/$egress_line$'\n'$aws_reader_lines$'\n'DATABASE_URL=}
[ "$(worker_env)" = "$worker_with_aws_reader" ] || fail "o worker.env com o papel da AWS saiu diferente:
$(diff <(echo "$worker_with_aws_reader") <(worker_env) || true)"
grep -q -e 'node-sa' -e 'aws' "$root/vault/log" && fail "leu um cofre por causa do papel da AWS: $(cat "$root/vault/log")"

# Só com os dois valores (sem o IP de saída nem o Turnstile): o resto do api.env continua o de referência.
new_root "só o papel de leitura da AWS" papel-aws-so
node_conf NODE_SA_UNIQUE_ID=123456789012345678901 AWS_WEB_IDENTITY_AUDIENCE=https://control.veraxsistemas.com.br/aws-reader
render_env || fail "o render falhou: $(cat "$root/out")"
only_aws_reader=${baseline/DATABASE_URL=/$aws_reader_lines$'\n'DATABASE_URL=}
[ "$(api_env)" = "$only_aws_reader" ] || fail "o api.env só com o papel da AWS saiu diferente:
$(diff <(echo "$only_aws_reader") <(api_env) || true)"
worker_only_aws_reader=${worker_baseline/DATABASE_URL=/$aws_reader_lines$'\n'DATABASE_URL=}
[ "$(worker_env)" = "$worker_only_aws_reader" ] || fail "o worker.env só com o papel da AWS saiu diferente:
$(diff <(echo "$worker_only_aws_reader") <(worker_env) || true)"

# E-mail (PR-16) e papel de leitura da AWS (PR-V5') juntos: no worker.env, o bloco do e-mail e a origem do painel antes
# do plano, o IP e os dois valores do papel antes do banco; no api.env, o bloco do e-mail no lugar de sempre.
new_root "e-mail e papel de leitura da AWS" smtp-papel-aws
node_conf MAIL_TRANSPORT=smtp SMTP_HOST=smtp.exemplo.com SMTP_PORT=465 SMTP_USER=nao-responda@exemplo.com.br \
  NODE_EGRESS_IPS=203.0.113.10/32 NODE_SA_UNIQUE_ID=123456789012345678901 \
  AWS_WEB_IDENTITY_AUDIENCE=https://control.veraxsistemas.com.br/aws-reader
printf 'senha-ficticia-da-caixa\n' >"$root/vault/verax-node-smtp-password"
render_env || fail "o render falhou: $(cat "$root/out")"
api_mail_aws=${api_with_mail/DATABASE_URL=/$egress_line$'\n'$aws_reader_lines$'\n'DATABASE_URL=}
[ "$(api_env)" = "$api_mail_aws" ] || fail "o api.env com o e-mail e o papel da AWS saiu diferente:
$(diff <(echo "$api_mail_aws") <(api_env) || true)"
worker_mail_aws=${worker_with_mail/DATABASE_URL=/$egress_line$'\n'$aws_reader_lines$'\n'DATABASE_URL=}
[ "$(worker_env)" = "$worker_mail_aws" ] || fail "o worker.env com o e-mail e o papel da AWS saiu diferente:
$(diff <(echo "$worker_mail_aws") <(worker_env) || true)"

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
)

echo "== Modo cliente (CUSTOMER_MODE): primeiro acesso pelos metadados da VM, senhas no Secret Manager e o worker.env"
# Com o start.sh rodando como na VM (`start.sh render` e `start.sh customer-bootstrap`, processos à parte, ambiente
# limpo), um servidor de metadados e um Secret Manager falsos de verdade, em HTTP no 127.0.0.1 (tests/fake-gcp.py), e o
# curl de verdade (por um invólucro que anota os argumentos de cada chamada). O Docker é simulado: o `compose run` do
# bootstrap anota os argumentos e o ambiente que o contêiner receberia e deixa na pasta montada os arquivos que o
# node-bootstrap deixaria. As senhas e o token são fictícios; o teste confere que nenhum deles aparece na tela, nos
# argumentos de comando (a lista de processos) nem em arquivo do /run/verax fora da pasta das senhas.
(
script=$PWD/bin/start.sh
example=$PWD/node.conf.example
fake_gcp=$PWD/tests/fake-gcp.py

# O cenário em curso fica em `step`, e não em `scenario` (o das outras partes, cada uma no próprio subshell).
fail() {
  echo "FALHOU ($step): $*" >&2
  exit 1
}

step=ambiente
command -v python3 >/dev/null || fail 'falta python3'
work=$(readlink -f "$(mktemp -d)")
server_pid=''
trap 'if [[ -n $server_pid ]]; then kill "$server_pid" 2>/dev/null || true; fi; rm -rf "$work"' EXIT
mkdir -p "$work/bin"

state=$work/gcp
mkdir -p "$state/attributes" "$state/fail" "$state/deny"
python3 "$fake_gcp" "$state" 2>"$work/gcp.err" &
server_pid=$!
for _ in $(seq 100); do
  if [[ -s $state/port ]]; then break; fi
  sleep 0.1
done
[[ -s $state/port ]] || fail "o servidor falso não subiu: $(cat "$work/gcp.err")"
port=$(<"$state/port")

# Valores fictícios. As senhas seguem o formato da senha temporária; o token é o do servidor falso.
admin_password=Abcde-Fghij-Kmnop-Qrstu
support_password=Vwxyz-Abcde-Fghij-Kmnop
token=ya29.token-ficticio-do-teste-0123456789
commit=0123456789abcdef0123456789abcdef01234567
tenant_name="Cliente Demo A D'Ávila \$HOME \"Ltda\""
# O corpo do pedido leva o JSON em base64: ele também não pode aparecer fora do corpo.
payload='{"email":"%s","password":"%s","expiresAt":"2026-11-07T12:00:00.000Z"}'
# shellcheck disable=SC2059 # o formato é o modelo do JSON acima, definido aqui
admin_b64=$(printf "$payload" admin@cliente-demo-a.example "$admin_password" | base64 -w0)
# shellcheck disable=SC2059 # idem
support_b64=$(printf "$payload" suporte@verax.example "$support_password" | base64 -w0)

real_curl=$(command -v curl)
cat >"$work/bin/curl" <<EOF
#!/bin/bash
printf '%s\n' "\$*" >>"$state/curl-argv.log"
exec "$real_curl" "\$@"
EOF
# Secret Manager pelo gcloud (o render lê o cofre do túnel): nenhum cofre tem valor.
cat >"$work/bin/gcloud" <<'EOF'
#!/bin/bash
echo "ERROR: (gcloud.secrets.versions.access) NOT_FOUND: Secret not found or has no versions." >&2
exit 1
EOF
# Sem root: o `install` de verdade, sem o dono (-o/-g).
real_install=$(command -v install)
cat >"$work/bin/install" <<EOF
#!/bin/bash
args=()
while ((\$#)); do
  case \$1 in
    -o | -g) shift 2 ;;
    *) args+=("\$1"); shift ;;
  esac
done
exec "$real_install" "\${args[@]}"
EOF
# O Docker: só o `compose ... run --rm -T ... bootstrap` do modo cliente. Anota os argumentos e o ambiente que o
# contêiner receberia (os nomes pedidos com -e, com o valor do ambiente de quem chamou) e, pelo comportamento do
# cenário ($STATE/behavior), deixa os arquivos na pasta montada com -v.
cat >"$work/bin/docker" <<'EOF'
#!/bin/bash
set -euo pipefail
printf 'docker %s\n' "$*" >>"$STATE/docker.log"
args=("$@")
[[ " $* " == *' run --rm -T '* && ${args[-1]} == bootstrap ]] || { echo "docker simulado: chamada inesperada: $*" >&2; exit 2; }
mount='' names=()
for ((i = 0; i < ${#args[@]}; i++)); do
  case ${args[i]} in
    -v) mount=${args[i + 1]} ;;
    -e) names+=("${args[i + 1]}") ;;
  esac
done
for name in "${names[@]}"; do printf '%s=%s\n' "$name" "${!name-<ausente>}"; done >"$STATE/bootstrap-env"
dir=${mount%%:*}
[[ ${mount#*:} == /run/verax-bootstrap && -d $dir ]] || { echo "docker simulado: montagem inesperada: $mount" >&2; exit 2; }
write() { printf '{"email":"%s","password":"%s","expiresAt":"2026-11-07T12:00:00.000Z"}' "$2" "$3" >"$dir/$1.json"; }
case $(cat "$STATE/behavior") in
  both)
    write admin-bootstrap admin@cliente-demo-a.example "$ADMIN_PASSWORD"
    write support-bootstrap suporte@verax.example "$SUPPORT_PASSWORD"
    echo 'Senhas para o Secret Manager: admin-bootstrap, support-bootstrap.'
    ;;
  admin) write admin-bootstrap admin@cliente-demo-a.example "$ADMIN_PASSWORD" ;;
  admin-then-fail)
    write admin-bootstrap admin@cliente-demo-a.example "$ADMIN_PASSWORD"
    echo 'Falha no bootstrap do nó de cliente (Error).' >&2
    exit 1
    ;;
  symlink) ln -s "$STATE/../alvo-do-link" "$dir/admin-bootstrap.json" ;;
  garbage) printf '{"email":"admin@cliente-demo-a.example","senha":"%s"}' "$ADMIN_PASSWORD" >"$dir/admin-bootstrap.json" ;;
  none) echo 'Nenhuma senha nova: nada para gravar no Secret Manager.' ;;
esac
EOF
chmod +x "$work/bin/curl" "$work/bin/gcloud" "$work/bin/install" "$work/bin/docker"
# O alvo do link do cenário `symlink`: um arquivo do host, no formato do contrato, que nunca pode ir para o Secret
# Manager (só a recusa do link o segura).
printf '{"email":"outro@verax.example","password":"segredo-interno-que-nao-pode-sair","expiresAt":"2026-11-07T12:00:00.000Z"}' \
  >"$work/alvo-do-link"

# Uma raiz nova por cenário: o node.conf de exemplo (sem comentários, com as linhas do cenário), as senhas internas, o
# images.env com a versão e o start.sh com os caminhos e os dois endereços trocados (e sem espera entre as tentativas).
new_root() { # <cenário> <pasta> [CHAVE=valor...]
  step=$1
  root=$work/root-$2
  mkdir -p "$root/etc/verax" "$root/var/lib/verax/secrets"
  grep -v -e '^#' -e '^$' "$example" >"$root/etc/verax/node.conf"
  local secret line
  for secret in postgres-master postgres-migrator postgres-app better-auth-secret csrf-secret; do
    printf 'interno-%s' "$secret" >"$root/var/lib/verax/secrets/$secret"
  done
  printf 'API_IMAGE=exemplo/api@sha256:%064d\nNODE_VERSION=%s\n' 0 "$commit" >"$root/etc/verax/images.env"
  for line in "${@:3}"; do
    if grep -q "^${line%%=*}=" "$root/etc/verax/node.conf"; then
      sed -i "s|^${line%%=*}=.*|$line|" "$root/etc/verax/node.conf"
    else
      echo "$line" >>"$root/etc/verax/node.conf"
    fi
  done
  sed -e "s#/etc/verax/node.conf#$root/etc/verax/node.conf#g" \
    -e "s#/var/lib/verax/secrets#$root/var/lib/verax/secrets#g" \
    -e "s#=/run/verax\$#=$root/run/verax#" \
    -e "s#^images_env=/etc/verax/images.env\$#images_env=$root/etc/verax/images.env#" \
    -e "s#^metadata_url=.*#metadata_url=http://127.0.0.1:$port/computeMetadata/v1#" \
    -e "s#^secretmanager_url=.*#secretmanager_url=http://127.0.0.1:$port/v1#" \
    -e 's#^retry_pause=.*#retry_pause=0#' "$script" >"$root/start.sh"
  : >"$state/docker.log"
  : >"$state/requests.log"
  : >"$state/curl-argv.log"
  rm -rf "$state/secrets" "$state/bootstrap-env"
  rm -f "$state"/fail/* "$state"/deny/*
}

# O start.sh como o systemd o roda, num ambiente limpo. Devolve o código de saída; a saída vai para $root/out.
start() { # <comando> [CHAVE=valor...]
  local code=0
  env -i PATH="$work/bin:$PATH" STATE="$state" ADMIN_PASSWORD="$admin_password" \
    SUPPORT_PASSWORD="$support_password" "${@:2}" "$BASH" "$root/start.sh" "$1" >"$root/out" 2>&1 || code=$?
  return "$code"
}

metadata() { # <chave> <valor>
  printf '%s' "$2" >"$state/attributes/$1"
}
versions() { # <segredo>: quantas versões o Secret Manager falso tem
  find "$state/secrets/verax-node-$1" -type f 2>/dev/null | wc -l | tr -d ' '
}
version_content() { # <segredo> <n>
  cat "$state/secrets/verax-node-$1/$2"
}
pending() { (cd "$root/run/verax/customer-bootstrap" 2>/dev/null && find . -maxdepth 1 -type f | sed 's|^\./||' | LC_ALL=C sort | tr '\n' ' '); }
# Nada que saiu (tela, argumentos de comando, o que o servidor recebeu fora do corpo) traz senha ou token, e nenhum
# arquivo do /run/verax fora da pasta das senhas tem senha ou token.
no_secret_leaks() {
  local file
  for file in "$root/out" "$state/curl-argv.log" "$state/docker.log" "$state/requests.log"; do
    if grep -q -F -e "$admin_password" -e "$support_password" -e "$token" -e "$admin_b64" -e "$support_b64" "$file"; then
      fail "senha ou token em $(basename "$file"): $(cat "$file")"
    fi
  done
  if grep -rq -F -e "$admin_password" -e "$support_password" -e "$token" -e "$admin_b64" -e "$support_b64" \
    "$root/run/verax" --exclude-dir=customer-bootstrap; then
    fail "senha ou token em arquivo do /run/verax fora da pasta das senhas"
  fi
}

metadata verax-tenant-name "$tenant_name"
metadata verax-admin-email admin@cliente-demo-a.example
metadata verax-support-email suporte@verax.example

# --- O nó da Verax (sem CUSTOMER_MODE): nada do modo cliente ------------------------------------------------------
new_root "nó da Verax: worker.env sem o estado do nó" verax
start render || fail "o render falhou: $(cat "$root/out")"
grep -q -e NODE_STATUS -e NODE_VERSION "$root/run/verax/worker.env" && fail "o worker.env ganhou o estado do nó"
verax_worker=$(cat "$root/run/verax/worker.env")
verax_api=$(cat "$root/run/verax/api.env")
if start customer-bootstrap; then fail "o customer-bootstrap rodou fora do modo cliente"; fi
grep -q 'só existe no modo cliente' "$root/out" || fail "sem o motivo: $(cat "$root/out")"
[[ ! -s $state/requests.log && ! -s $state/docker.log ]] || fail "falou com o metadata ou com o Docker fora do modo cliente"
new_root "CUSTOMER_MODE=false: byte a byte como sem a linha" verax-false CUSTOMER_MODE=false
start render || fail "o render falhou: $(cat "$root/out")"
[[ "$(cat "$root/run/verax/worker.env")" == "$verax_worker" && "$(cat "$root/run/verax/api.env")" == "$verax_api" ]] ||
  fail "CUSTOMER_MODE=false mudou os arquivos de ambiente"

# --- Modo cliente: o worker.env ganha o estado do nó; o api.env fica como está ------------------------------------
new_root "modo cliente: render" render CUSTOMER_MODE=true
start render || fail "o render falhou: $(cat "$root/out")"
[[ "$(cat "$root/run/verax/api.env")" == "$verax_api" ]] || fail "o api.env mudou no modo cliente"
status_lines="NODE_STATUS='true'"$'\n'"NODE_VERSION='$commit'"
expected_worker=${verax_worker/DATABASE_URL=/$status_lines$'\n'DATABASE_URL=}
[[ "$(cat "$root/run/verax/worker.env")" == "$expected_worker" ]] ||
  fail "worker.env inesperado: $(diff <(echo "$expected_worker") "$root/run/verax/worker.env" || true)"
# Com os valores do nó de cliente da conferência da AWS (PR-V5'), o worker.env inteiro, byte a byte: o IP de saída e o
# papel de leitura depois do plano, o estado do nó logo antes do banco.
new_root "modo cliente: worker.env com o papel de leitura da AWS" render-aws CUSTOMER_MODE=true \
  NODE_EGRESS_IPS=203.0.113.10/32 NODE_SA_UNIQUE_ID=123456789012345678901 \
  AWS_WEB_IDENTITY_AUDIENCE=https://control.veraxsistemas.com.br/aws-reader
start render || fail "o render falhou: $(cat "$root/out")"
expected_worker=$(
  cat <<EOF
NODE_ENV='production'
LOG_LEVEL='info'
SYNC_SOURCES='gcp'
SYNC_INTERVAL_SECONDS='60'
PLAN='interno'
NODE_EGRESS_IPS='203.0.113.10/32'
NODE_SA_UNIQUE_ID='123456789012345678901'
AWS_WEB_IDENTITY_AUDIENCE='https://control.veraxsistemas.com.br/aws-reader'
NODE_STATUS='true'
NODE_VERSION='$commit'
DATABASE_URL='postgresql://verax_app:interno-postgres-app@postgres:5432/verax?sslmode=verify-full&sslrootcert=/etc/verax/tls/ca.crt'
EOF
)
[[ "$(cat "$root/run/verax/worker.env")" == "$expected_worker" ]] ||
  fail "worker.env inesperado: $(diff <(echo "$expected_worker") "$root/run/verax/worker.env" || true)"
for bad in CUSTOMER_MODE=sim versao-fora-do-formato sem-images-env; do
  new_root "modo cliente: o render recusa ($bad)" "render-recusa-${bad%%=*}" CUSTOMER_MODE=true
  case $bad in
    versao-fora-do-formato) printf 'NODE_VERSION=v1\n' >"$root/etc/verax/images.env" ;;
    sem-images-env) rm "$root/etc/verax/images.env" ;;
    *) sed -i "s|^CUSTOMER_MODE=.*|$bad|" "$root/etc/verax/node.conf" ;;
  esac
  if start render; then fail "o render deveria parar"; fi
  grep -q -e 'CUSTOMER_MODE inválido' -e 'NODE_VERSION ausente ou fora do formato' "$root/out" ||
    fail "sem o motivo: $(cat "$root/out")"
  [[ ! -e $root/run/verax/worker.env ]] || fail "escreveu arquivo de ambiente mesmo parando"
done

# --- Primeira vez: as duas senhas, cada uma no seu segredo --------------------------------------------------------
new_root "modo cliente: primeira vez" primeira CUSTOMER_MODE=true
start render || fail "o render falhou: $(cat "$root/out")"
echo both >"$state/behavior"
start customer-bootstrap || fail "o customer-bootstrap falhou: $(cat "$root/out")"
[[ "$(versions admin-bootstrap) $(versions support-bootstrap)" == '1 1' ]] ||
  fail "versões: $(versions admin-bootstrap) $(versions support-bootstrap)"
[[ "$(version_content admin-bootstrap 1)" == "{\"email\":\"admin@cliente-demo-a.example\",\"password\":\"$admin_password\",\"expiresAt\":\"2026-11-07T12:00:00.000Z\"}" ]] ||
  fail "conteúdo da versão do admin-bootstrap: $(version_content admin-bootstrap 1)"
[[ "$(version_content support-bootstrap 1)" == *"\"password\":\"$support_password\""* ]] || fail "conteúdo do support-bootstrap"
[[ -z $(pending) ]] || fail "arquivo de senha ficou na pasta: $(pending)"
[[ $(stat -c %a "$root/run/verax/customer-bootstrap") == 700 ]] || fail "pasta das senhas sem 0700"
grep -q 'Senha nova gravada no Secret Manager (verax-node-admin-bootstrap)' "$root/out" || fail "sem o aviso: $(cat "$root/out")"
# As entradas chegam ao contêiner pelo ambiente, inteiras (aspas, apóstrofo e cifrão), e nunca pelos argumentos.
expected_env=$(printf '%s\n' BOOTSTRAP_MODE=customer BOOTSTRAP_RENEW_ADMIN_PASSWORD=false \
  BOOTSTRAP_RENEW_SUPPORT_PASSWORD=false "BOOTSTRAP_TENANT_NAME=$tenant_name" \
  BOOTSTRAP_ADMIN_EMAIL=admin@cliente-demo-a.example BOOTSTRAP_SUPPORT_EMAIL=suporte@verax.example)
[[ "$(cat "$state/bootstrap-env")" == "$expected_env" ]] || fail "ambiente do contêiner: $(cat "$state/bootstrap-env")"
grep -q -F -e 'cliente-demo-a' -e "D'Ávila" "$state/docker.log" && fail "valor dos metadados nos argumentos do Docker"
grep -q -F -- "-v $root/run/verax/customer-bootstrap:/run/verax-bootstrap " "$state/docker.log" ||
  fail "montagem: $(cat "$state/docker.log")"
grep -q -F "D'Ávila" "$root/out" && fail "o nome do cliente saiu na tela"
grep -q 'admin@cliente-demo-a.example' "$root/out" && fail "o e-mail saiu na tela"
[[ ! -s $root/run/verax/bootstrap.env ]] || fail "o bootstrap.env recebeu as entradas"
# Cada pedido com o cabeçalho certo; o Secret Manager, com o token da VM e uma versão por segredo.
grep -q 'flavor=None' "$state/requests.log" && fail "pedido ao metadata sem Metadata-Flavor"
[[ $(grep -c '^POST /v1/projects/projeto-do-no/secrets/verax-node-admin-bootstrap:addVersion authorized=True content-type=application/json$' "$state/requests.log") == 1 ]] ||
  fail "pedidos: $(cat "$state/requests.log")"
grep -q 'authorized=False' "$state/requests.log" && fail "pedido sem o token da VM"
no_secret_leaks

# --- De novo: nenhuma senha nova, nenhuma versão nova ------------------------------------------------------------
step="modo cliente: de novo, nada novo"
: >"$state/requests.log"
echo none >"$state/behavior"
start customer-bootstrap || fail "o customer-bootstrap falhou: $(cat "$root/out")"
[[ "$(versions admin-bootstrap) $(versions support-bootstrap)" == '1 1' ]] || fail "versão nova sem senha nova"
grep -q 'addVersion' "$state/requests.log" && fail "chamou o Secret Manager sem senha nova"
grep -q 'Senha nova gravada' "$root/out" && fail "disse que gravou"

# --- Pedido explícito de senha nova: passa para o contêiner --------------------------------------------------------
step="modo cliente: senha nova a pedido"
echo admin >"$state/behavior"
start customer-bootstrap BOOTSTRAP_RENEW_ADMIN_PASSWORD=true || fail "falhou: $(cat "$root/out")"
grep -qx 'BOOTSTRAP_RENEW_ADMIN_PASSWORD=true' "$state/bootstrap-env" || fail "o pedido não chegou ao contêiner"
[[ "$(versions admin-bootstrap) $(versions support-bootstrap)" == '2 1' ]] || fail "versões depois do pedido"
no_secret_leaks

# --- Falha que passa (503 e 429): tenta de novo e grava uma versão só ------------------------------------------------
new_root "modo cliente: Secret Manager instável" instavel CUSTOMER_MODE=true
start render || fail "o render falhou: $(cat "$root/out")"
echo both >"$state/behavior"
printf '503 429' >"$state/fail/verax-node-admin-bootstrap"
start customer-bootstrap || fail "deveria passar depois das novas tentativas: $(cat "$root/out")"
[[ "$(versions admin-bootstrap) $(versions support-bootstrap)" == '1 1' ]] || fail "versões depois das novas tentativas"
[[ $(grep -c 'verax-node-admin-bootstrap:addVersion' "$state/requests.log") == 3 ]] ||
  fail "tentativas: $(cat "$state/requests.log")"
no_secret_leaks

# --- Sem permissão no segredo de suporte: o do admin vai, o de suporte fica no tmpfs e vai na próxima ---------------
new_root "modo cliente: sem permissão no segredo de suporte" negado CUSTOMER_MODE=true
start render || fail "o render falhou: $(cat "$root/out")"
echo both >"$state/behavior"
: >"$state/deny/verax-node-support-bootstrap"
if start customer-bootstrap; then fail "deveria falhar sem a permissão"; fi
grep -q 'Falha ao gravar a versão do segredo verax-node-support-bootstrap no Secret Manager (HTTP 403, PERMISSION_DENIED)' "$root/out" ||
  fail "sem o motivo: $(cat "$root/out")"
[[ $(grep -c 'verax-node-support-bootstrap:addVersion' "$state/requests.log") == 1 ]] || fail "repetiu um 403"
[[ "$(versions admin-bootstrap) $(versions support-bootstrap)" == '1 0' ]] || fail "versões com o 403"
[[ $(pending) == 'support-bootstrap.json ' ]] || fail "a senha de suporte deveria esperar no tmpfs: $(pending)"
[[ $(stat -c %a "$root/run/verax/customer-bootstrap/support-bootstrap.json") == 600 ]] ||
  fail "arquivo da senha sem 0600"
no_secret_leaks
# Enquanto ela não é gravada, o bootstrap nem roda (nenhuma senha nova antes da pendente).
: >"$state/docker.log"
if start customer-bootstrap; then fail "deveria falhar de novo"; fi
[[ ! -s $state/docker.log ]] || fail "rodou o bootstrap com senha pendente"
# Permissão corrigida: a pendente vai primeiro, depois o bootstrap roda (sem senha nova).
rm -f "$state/deny/verax-node-support-bootstrap"
echo none >"$state/behavior"
start customer-bootstrap || fail "deveria gravar a pendente: $(cat "$root/out")"
[[ "$(versions admin-bootstrap) $(versions support-bootstrap)" == '1 1' ]] || fail "a pendente não foi gravada"
[[ "$(version_content support-bootstrap 1)" == *"\"password\":\"$support_password\""* ]] || fail "conteúdo da pendente"
[[ -s $state/docker.log && -z $(pending) ]] || fail "depois da pendente, o bootstrap roda e a pasta fica vazia"
no_secret_leaks

# --- O bootstrap falhou depois de gerar a senha do admin: ela vai para o cofre, e a saída é de erro ------------------
new_root "modo cliente: bootstrap falhou no meio" meio CUSTOMER_MODE=true
start render || fail "o render falhou: $(cat "$root/out")"
echo admin-then-fail >"$state/behavior"
if start customer-bootstrap; then fail "deveria devolver a falha do bootstrap"; fi
[[ "$(versions admin-bootstrap) $(versions support-bootstrap)" == '1 0' ]] || fail "a senha gerada não foi gravada"
[[ -z $(pending) ]] || fail "sobrou arquivo: $(pending)"
no_secret_leaks

# --- Metadado que falta: nada roda -----------------------------------------------------------------------------------
new_root "modo cliente: sem o e-mail de suporte nos metadados" sem-metadado CUSTOMER_MODE=true
start render || fail "o render falhou: $(cat "$root/out")"
mv "$state/attributes/verax-support-email" "$work/support-email"
echo both >"$state/behavior"
if start customer-bootstrap; then fail "deveria parar sem o metadado"; fi
grep -q 'Falta o metadado verax-support-email na VM' "$root/out" || fail "sem o motivo: $(cat "$root/out")"
[[ ! -s $state/docker.log && "$(versions admin-bootstrap)" == 0 ]] || fail "rodou sem o metadado"
mv "$work/support-email" "$state/attributes/verax-support-email"

# --- Arquivo que não é do contrato ou não é arquivo comum: recusado, nada enviado ------------------------------------
for behavior in symlink garbage; do
  new_root "modo cliente: arquivo recusado ($behavior)" "recusa-$behavior" CUSTOMER_MODE=true
  start render || fail "o render falhou: $(cat "$root/out")"
  echo "$behavior" >"$state/behavior"
  if start customer-bootstrap; then fail "deveria recusar o arquivo"; fi
  grep -q -e 'não é um arquivo comum' -e 'fora do formato do contrato' "$root/out" || fail "sem o motivo: $(cat "$root/out")"
  grep -q 'addVersion' "$state/requests.log" && fail "enviou o arquivo recusado"
  grep -q 'segredo-interno-que-nao-pode-sair' "$root/out" && fail "o conteúdo do alvo do link saiu na tela"
  no_secret_leaks
done

echo "ok     modo cliente: todos os cenários passaram"
)

if ((failures > 0)); then
  echo "$failures verificação(ões) falharam." >&2
  exit 1
fi
echo "start.sh: todas as verificações passaram."
