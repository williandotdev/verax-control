#!/bin/bash
# Testa o bin/aws-token.sh e o bin/wazuh-apply.sh (fase 2, PR-V4': a AWS sem chave no Wazuh do nó), sem root, sem
# Docker e sem a GCP. No CI: `bash infra/node/tests/wazuh-apply-test.sh`.
#
# Os dois scripts rodam como o systemd os roda (num processo à parte e num ambiente limpo), numa pasta temporária que faz
# o papel de /etc/verax e /run/verax. Os comandos que mexem na máquina ou na nuvem são simulados e anotam cada chamada:
# o curl faz o papel do servidor de metadados (responde o token do arquivo do cenário, ou falha); o docker, o do
# Compose (o CLI wazuh-sources imprime a lista do cenário, o gerador lê a entrada e imprime o hash do cenário, o manager
# está ou não no ar e fica ou não saudável depois do reinício); o chown só anota; o install tira o dono (-o/-g), que
# pede root; o sleep espera um décimo de segundo. O resto (sha256sum, mktemp, mv, flock, date) é o de verdade.
#
# aws-token.sh: o token do metadata vai para a pasta do manager por troca atômica, 0600, nunca para a saída; o sinal
# sem segredo para o worker só com a hora; o audience do node.conf (ou o padrão da pilha); sem a pasta, nada; com o
# metadata fora do ar ou um token fora do formato, o token anterior e o sinal ficam como estavam.
#
# wazuh-apply.sh: a lista do CLI vai inteira para o gerador, com o IP de saída do node.conf; a geração é o SHA-256
# dela; o manager só reinicia quando o hash muda e está no ar; sem o healthcheck, a configuração anterior volta e o
# manager reinicia com ela, e a mesma configuração não é tentada outra vez; um erro do CLI nunca vira "nenhuma conta";
# o sinal `applied` diz ok ou error com a geração. Num cenário, o gerador é o de verdade (python3): a volta traz os
# profiles da AWS junto com a configuração, e o token do Google fica como o host o deixou.
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)

failures=0
expect() { # <descrição> <esperado (regex)> <obtido>
  if [[ $3 =~ ^($2)$ ]]; then
    printf 'ok     %s\n' "$1"
  else
    printf 'FALHA  %s (esperado %s, obtido %s)\n' "$1" "$2" "$3"
    failures=$((failures + 1))
  fi
}

# Como root, um caminho esquecido na troca escreveria na máquina de verdade; como usuário comum, ele falha.
if [[ $(id -u) == 0 ]]; then
  echo 'Rode como usuário comum.' >&2
  exit 2
fi
real_install=$(command -v install)
real_sleep=$(command -v sleep)

work=$(readlink -f "$(mktemp -d)")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

stub() {
  {
    # shellcheck disable=SC2016 # o simulado lê a variável quando roda, não quando é escrito
    printf '#!/bin/bash\nset -euo pipefail\nstate=$VERAX_TEST_STATE\n'
    cat
  } >"$work/bin/$1"
  chmod +x "$work/bin/$1"
}

# O servidor de metadados: o token do cenário ($state/metadata), ou a falha do curl (sem o arquivo).
stub curl <<'EOF'
printf '%s\n' "$*" >>"$state/curl.log"
[[ -f $state/metadata ]] || { echo 'curl: (7) Failed to connect to metadata.google.internal' >&2; exit 7; }
cat "$state/metadata"
EOF
# O Compose e o Docker do nó.
stub docker <<'EOF'
printf '%s\n' "$*" >>"$state/docker.log"
case " $* " in
  *' run --rm -T wazuh-sources '*)
    [[ ! -f $state/sources.fail ]] || { echo 'Error: P1001 (simulado)' >&2; exit 1; }
    cat "$state/sources" ;;
  # O gerador: o hash do cenário, ou o gerador de verdade ($state/generator, com o volume numa pasta do cenário e a
  # pasta dos profiles do nó simulado).
  *' VERAX_MANAGER_CONFIG_ROLLBACK=1 manager-config '*)
    echo rollback >>"$state/events"
    if [[ -x $state/generator ]]; then
      VERAX_MANAGER_CONFIG_ROLLBACK=1 "$state/generator" </dev/null
    else
      cat "$state/previous" 2>/dev/null || true
    fi ;;
  *' run --rm -T -e VERAX_NODE_EGRESS_IPS='*' manager-config '*)
    cat >"$state/render.in"
    printf '%s\n' "$*" | grep -oE 'VERAX_NODE_EGRESS_IPS=[^ ]*' >"$state/render.egress"
    [[ ! -f $state/render.fail ]] || { echo 'ERRO: lista de contas AWS (simulado)' >&2; exit 1; }
    if [[ -x $state/generator ]]; then
      VERAX_NODE_EGRESS_IPS=$(cut -d= -f2- "$state/render.egress") "$state/generator" <"$state/render.in"
    else
      cat "$state/hash"
    fi ;;
  *' ps --status running --quiet wazuh.manager '*)
    if [[ -f $state/running ]]; then echo manager-id; fi ;;
  *' ps --quiet wazuh.manager '*)
    echo manager-id ;;
  *' restart wazuh.manager '*)
    echo restart >>"$state/events"
    # A saúde depois de cada reinício: a próxima linha de $state/health.seq.
    head -n 1 "$state/health.seq" >"$state/health"
    sed -i 1d "$state/health.seq" ;;
  ' inspect '*)
    cat "$state/health" 2>/dev/null || true ;;
  *) echo "docker simulado: chamada inesperada: $*" >&2; exit 64 ;;
esac
EOF
stub chown <<'EOF'
printf 'chown %s\n' "$*" >>"$state/chown.log"
EOF
stub sleep <<EOF
exec "$real_sleep" 0.1
EOF
stub install <<EOF
args=()
while ((\$#)); do
  case \$1 in
    -o | -g) printf 'install %s %s\n' "\$1" "\$2" >>"\$state/install.log"; shift 2 ;;
    *) args+=("\$1"); shift ;;
  esac
done
exec "$real_install" "\${args[@]}"
EOF

# Uma raiz nova por cenário: o node.conf de exemplo (sem comentários) com as linhas do cenário, e os dois scripts com
# /etc/verax/node.conf e /run/verax trocados. HEALTH_TIMEOUT de 1 s: o laço do healthcheck termina logo.
root='' state='' run=''
new_root() { # <CHAVE=valor...>
  root=$work/root-$RANDOM$RANDOM
  state=$root.state
  run=$root/run/verax
  mkdir -p "$root/etc/verax" "$state" "$run"
  grep -v -e '^#' -e '^$' "$here/node.conf.example" >"$root/etc/verax/node.conf"
  local line
  for line in "$@"; do
    sed -i "/^${line%%=*}=/d" "$root/etc/verax/node.conf"
    echo "$line" >>"$root/etc/verax/node.conf"
  done
  for script in aws-token wazuh-apply; do
    sed -e "s#/etc/verax/node.conf#$root/etc/verax/node.conf#g" -e "s#^run=/run/verax\$#run=$run#" \
      -e 's#^HEALTH_TIMEOUT=180$#HEALTH_TIMEOUT=1#' "$here/bin/$script.sh" >"$root/$script.sh"
  done
  : >"$state/events"
}

# Roda um dos scripts; a saída (stdout e stderr) vai para $state/out, e o código de saída é devolvido.
run_script() { # <aws-token|wazuh-apply>
  local status=0
  env -i PATH="$work/bin:$PATH" VERAX_TEST_STATE="$state" "$BASH" "$root/$1.sh" >"$state/out" 2>&1 || status=$?
  return "$status"
}
code_of() { local status=0; run_script "$1" || status=$?; echo "$status"; }
same() { if [[ $1 == "$2" ]]; then echo igual; else echo "diferente: $2"; fi; } # texto literal, sem regex
listing() { find "$1" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort | paste -sd' ' -; }
mode() { stat -c %a "$1"; }
applied() { cat "$run/wazuh-signal/applied" 2>/dev/null || echo ausente; }
events() { tr '\n' ' ' <"$state/events" | sed 's/ $//'; }

# Um token no formato do Google (três partes em base64 da URL), montado aqui: nenhum token fica no repositório.
segment() { printf '%s' "$1" | base64 | tr -d '=\n' | tr '+/' '-_'; }
TOKEN=$(segment '{"alg":"RS256"}').$(segment '{"sub":"123456789012345678901"}').$(segment 'assinatura')
OTHER_TOKEN=$(segment '{"alg":"RS256"}').$(segment '{"sub":"outro"}').$(segment 'outra')
ISO='[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z'

echo "== aws-token.sh"
new_root NODE_PROFILE=lean
expect "no lean, recusa sem chamar o metadata" '2 ausente' \
  "$(code_of aws-token) $([[ -f $state/curl.log ]] && echo chamado || echo ausente)"

new_root NODE_PROFILE=standard
printf '%s' "$TOKEN" >"$state/metadata"
expect "sem a pasta dos profiles (o Wazuh fora do ar): nada a renovar, sem erro" '0' "$(code_of aws-token)"
expect "  e sem chamar o metadata nem criar a pasta" 'ausente ausente' \
  "$([[ -f $state/curl.log ]] && echo chamado || echo ausente) $([[ -e $run/wazuh-aws ]] && echo criada || echo ausente)"

# A pasta como o Docker a cria ao restaurar o manager depois de um reboot (0755).
mkdir -m 0755 "$run/wazuh-aws"
expect "renovado" 0 "$(code_of aws-token)"
expect "o token na pasta que o manager monta, igual ao do metadata" "$TOKEN" "$(cat "$run/wazuh-aws/google-id-token")"
expect "token 0600 e pasta fechada de novo (0700)" '600 700' "$(mode "$run/wazuh-aws/google-id-token") $(mode "$run/wazuh-aws")"
expect "nenhum arquivo temporário na pasta" 'google-id-token' "$(listing "$run/wazuh-aws")"
expect "o token nunca sai na saída" 0 "$(grep -c "$TOKEN" "$state/out" || true)"
expect "o audience padrão da pilha e o formato standard, com o cabeçalho do metadata" 1 \
  "$(grep -c -- '-H Metadata-Flavor: Google -G --data-urlencode audience=https://control.veraxsistemas.com.br/aws-reader --data-urlencode format=standard http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity' "$state/curl.log")"
expect "o sinal para o worker, só com a hora" "\\{\"tokenAt\":\"$ISO\"\\}" "$(cat "$run/wazuh-signal/aws-token")"
expect "sinal 0440, do grupo do worker, na pasta 1770 dele" '440 1770' \
  "$(mode "$run/wazuh-signal/aws-token") $(mode "$run/wazuh-signal")"
expect "o sinal passa ao root e ao grupo do worker" 1 "$(grep -c '^chown 0:1000 ' "$state/chown.log")"
expect "a pasta dos sinais do root e do grupo do worker" '1 1' \
  "$(grep -c '^install -o 0$' "$state/install.log") $(grep -c '^install -g 1000$' "$state/install.log")"

echo "== aws-token.sh: o metadata fora do ar ou um token fora do formato não estragam o que está lá"
signal_before=$(cat "$run/wazuh-signal/aws-token")
rm -f "$state/metadata"
expect "metadata fora do ar: erro" 1 "$(code_of aws-token)"
expect "  o token anterior fica" "$TOKEN" "$(cat "$run/wazuh-aws/google-id-token")"
expect "  o sinal fica (o worker vê o token envelhecer)" igual \
  "$(same "$signal_before" "$(cat "$run/wazuh-signal/aws-token")")"
for bad in '<html>erro</html>' 'duas.partes' "$TOKEN.quarta" "$(printf 'a%.0s' {1..9000}).b.c"; do
  printf '%s' "$bad" >"$state/metadata"
  expect "token fora do formato (${bad:0:12}…): recusado, o anterior fica" "1 $TOKEN" \
    "$(code_of aws-token) $(cat "$run/wazuh-aws/google-id-token")"
done
expect "nenhum arquivo temporário depois das falhas" 'google-id-token' "$(listing "$run/wazuh-aws")"

echo "== aws-token.sh: o audience do node.conf"
new_root NODE_PROFILE=standard AWS_WEB_IDENTITY_AUDIENCE=https://aws.verax.example/reader
mkdir -p "$run/wazuh-aws"
printf '%s' "$OTHER_TOKEN" >"$state/metadata"
expect "renovado com o audience do nó" '0 1' \
  "$(code_of aws-token) $(grep -c -- '--data-urlencode audience=https://aws.verax.example/reader ' "$state/curl.log")"
for audience in 'http://aws.verax.example' 'https://AWS.verax.example' 'https://aws.verax.example/*' \
  "https://aws.verax.example/$(printf 'x%.0s' {1..250})"; do
  new_root NODE_PROFILE=standard "AWS_WEB_IDENTITY_AUDIENCE=$audience"
  mkdir -p "$run/wazuh-aws"
  printf '%s' "$TOKEN" >"$state/metadata"
  expect "audience fora do formato (${audience:0:30}): recusado sem chamar o metadata" '2 ausente' \
    "$(code_of aws-token) $([[ -f $state/curl.log ]] && echo chamado || echo ausente)"
done

echo "== wazuh-apply.sh"
SOURCES='[{"accountId":"111122223333","region":"sa-east-1","onlyLogsAfter":"2026-NOV-01","cloudtrailBucket":"trilha-111122223333"}]'
GENERATION=$(printf '%s' "$SOURCES" | sha256sum | cut -c1-64)
HASH_A=$(printf 'a%.0s' {1..64})
HASH_B=$(printf 'b%.0s' {1..64})
scenario() { # <CHAVE=valor...>: o nó com o Wazuh no ar desde o wazuh-up (a pasta dos profiles existe)
  new_root NODE_PROFILE=standard NODE_EGRESS_IPS=203.0.113.10/32 "$@"
  mkdir -p "$run/wazuh-aws"
  printf '%s\n' "$SOURCES" >"$state/sources"
  printf '%s\n' "$HASH_A" >"$state/hash"
  : >"$state/health.seq"
}

new_root NODE_PROFILE=lean
expect "no lean, recusa" 2 "$(code_of wazuh-apply)"
new_root NODE_PROFILE=standard
expect "sem a pasta dos profiles (o Wazuh fora do ar): nada a aplicar, sem chamar o Compose" '0 ausente' \
  "$(code_of wazuh-apply) $([[ -f $state/docker.log ]] && echo chamado || echo ausente)"

scenario
expect "manager parado: aplicada para a próxima partida dele, sem reiniciar nada" '0 ' "$(code_of wazuh-apply) $(events)"
expect "a lista inteira do CLI na entrada do gerador" igual "$(same "$SOURCES" "$(cat "$state/render.in")")"
expect "o IP de saída do node.conf para as regras do papel" 'VERAX_NODE_EGRESS_IPS=203.0.113.10/32' \
  "$(cat "$state/render.egress")"
expect "o hash fica como o da configuração do manager" "$HASH_A" "$(cat "$run/wazuh-apply/running")"
expect "applied: ok com a geração (o SHA-256 da lista)" "\\{\"generation\":\"$GENERATION\",\"status\":\"ok\",\"at\":\"$ISO\"\\}" \
  "$(applied)"
expect "applied 0440 na pasta 1770; o estado do host 0700" '440 1770 700' \
  "$(mode "$run/wazuh-signal/applied") $(mode "$run/wazuh-signal") $(mode "$run/wazuh-apply")"
expect "nenhum arquivo temporário na pasta dos sinais" 'applied' "$(listing "$run/wazuh-signal")"

touch "$state/running"
expect "manager no ar com a mesma configuração: nada reinicia" '0 ' "$(code_of wazuh-apply) $(events)"

printf '%s\n' "$HASH_B" >"$state/hash"
echo healthy >"$state/health.seq"
expect "configuração nova: só o manager reinicia, uma vez, e fica saudável" '0 restart' "$(code_of wazuh-apply) $(events)"
expect "o hash novo vira o da configuração do manager; applied ok" "$HASH_B ok" \
  "$(cat "$run/wazuh-apply/running") $(applied | grep -oE '"status":"[a-z]+"' | cut -d'"' -f4)"
expect "o reinício é só do manager" 1 "$(grep -c ' restart wazuh.manager$' "$state/docker.log")"

echo "== wazuh-apply.sh: o manager não fica saudável com a configuração nova"
scenario
touch "$state/running"
mkdir -p "$run/wazuh-apply"
printf '%s\n' "$HASH_A" >"$run/wazuh-apply/running"
printf '%s\n' "$HASH_B" >"$state/hash"
printf '%s\n' "$HASH_A" >"$state/previous"
printf 'unhealthy\nhealthy\n' >"$state/health.seq"
expect "erro: a anterior volta ao lugar e o manager reinicia com ela" '1 restart rollback restart' \
  "$(code_of wazuh-apply) $(events)"
expect "a configuração que derrubou o manager fica marcada; a que roda é a anterior" "$HASH_B $HASH_A" \
  "$(cat "$run/wazuh-apply/failed") $(cat "$run/wazuh-apply/running")"
expect "applied: error com a geração" "\\{\"generation\":\"$GENERATION\",\"status\":\"error\",\"at\":\"$ISO\"\\}" "$(applied)"
: >"$state/events"
expect "a mesma configuração de novo: a anterior volta, sem reiniciar" '1 rollback' "$(code_of wazuh-apply) $(events)"
expect "  e o applied continua error" error "$(applied | grep -oE '"status":"[a-z]+"' | cut -d'"' -f4)"
printf '%s\n' "$(printf 'c%.0s' {1..64})" >"$state/hash"
echo healthy >"$state/health.seq"
: >"$state/events"
expect "uma configuração diferente é tentada, e a marca da que falhou sai" '0 restart ausente' \
  "$(code_of wazuh-apply) $(events) $([[ -f $run/wazuh-apply/failed ]] && echo marcada || echo ausente)"

echo "== wazuh-apply.sh com o gerador de verdade: a volta traz os profiles da AWS junto com a configuração"
# A e B com o mesmo bucket do GuardDuty (lido pelo profile da A); a lista nova só com a B, e o manager não fica
# saudável. A configuração anterior volta com os profiles dela (o bucket precisa do profile da A), nos dois caminhos da
# volta: depois do reinício e na mesma configuração tentada de novo (sem reiniciar: o manager que roda a anterior relê
# os profiles a cada execução do módulo). O token do Google, renovado pelo host no meio, nunca é tocado.
command -v python3 >/dev/null || { echo 'falta python3 (o gerador de verdade)' >&2; exit 2; }
SHARED='"guarddutyBucket":"guardduty-da-organizacao"'
SOURCES_A='{"accountId":"111122223333","region":"sa-east-1","onlyLogsAfter":"2026-NOV-01",'$SHARED'}'
SOURCES_B='{"accountId":"444455556666","region":"us-east-1","onlyLogsAfter":"2026-OCT-15",'$SHARED'}'
scenario
cat >"$state/generator" <<EOF
#!/bin/bash
exec python3 "$here/../wazuh/scripts/render-manager-config.py" "$here/../wazuh/config/manager/ossec.conf" \\
  "$state/volume" "$run/wazuh-aws" "$here/../wazuh/config/manager/rules"
EOF
chmod +x "$state/generator"
touch "$state/running"
printf '[%s,%s]\n' "$SOURCES_A" "$SOURCES_B" >"$state/sources"
echo healthy >"$state/health.seq"
expect "A e B: aplicada com o gerador de verdade" '0 restart' "$(code_of wazuh-apply) $(events)"
profiles_ab=$(cat "$run/wazuh-aws/config")
running_ab=$(cat "$run/wazuh-apply/running")
expect "  os profiles da A e da B" '2' "$(grep -c '^\[profile verax-' "$run/wazuh-aws/config")"
printf 'token.de.teste\n' >"$run/wazuh-aws/google-id-token"
printf '[%s]\n' "$SOURCES_B" >"$state/sources"
printf 'unhealthy\nhealthy\n' >"$state/health.seq"
: >"$state/events"
printf 'token.renovado\n' >"$run/wazuh-aws/google-id-token"
expect "só a B, e o manager não fica saudável: a anterior volta" '1 restart rollback restart' \
  "$(code_of wazuh-apply) $(events)"
expect "  com os profiles dela (os da A e da B), e o hash dela roda" 'igual igual' \
  "$(same "$profiles_ab" "$(cat "$run/wazuh-aws/config")") $(same "$running_ab" "$(cat "$run/wazuh-apply/running")")"
expect "  o bucket compartilhado volta ao profile da A, que existe" 'verax-111122223333 1' \
  "$(grep -oE '<aws_profile>verax-111122223333</aws_profile>' "$state/volume/etc/ossec.conf" | sed 's/<[^>]*>//g') $(
    grep -c '^\[profile verax-111122223333\]$' "$run/wazuh-aws/config")"
expect "  o token que o host renovou fica" 'token.renovado' "$(cat "$run/wazuh-aws/google-id-token")"
: >"$state/events"
expect "a mesma lista de novo: a anterior volta sem reiniciar, de novo com os profiles dela" '1 rollback igual' \
  "$(code_of wazuh-apply) $(events) $(same "$profiles_ab" "$(cat "$run/wazuh-aws/config")")"
expect "  e o token segue o do host" 'token.renovado' "$(cat "$run/wazuh-aws/google-id-token")"

echo "== wazuh-apply.sh: o CLI ou o gerador falham, e a configuração fica como está"
scenario
touch "$state/running" "$state/sources.fail"
expect "CLI sem o banco: erro, sem chamar o gerador nem reiniciar" '1  ausente' \
  "$(code_of wazuh-apply) $(events) $([[ -f $state/render.in ]] && echo chamado || echo ausente)"
expect "applied: error sem geração (a lista nem chegou)" "\\{\"generation\":null,\"status\":\"error\",\"at\":\"$ISO\"\\}" \
  "$(applied)"
scenario
touch "$state/running" "$state/render.fail"
expect "gerador recusa a lista: erro, sem reiniciar" '1 ' "$(code_of wazuh-apply) $(events)"
expect "applied: error com a geração da lista recusada" "\\{\"generation\":\"$GENERATION\",\"status\":\"error\",\"at\":\"$ISO\"\\}" \
  "$(applied)"
scenario
touch "$state/running"
printf 'saída que não é hash\n' >"$state/hash"
expect "saída do gerador que não é um hash: erro, sem reiniciar" '1 ' "$(code_of wazuh-apply) $(events)"

echo "== wazuh-apply.sh: o projeto do Compose e o IP de saída do node.conf"
scenario NODE_EGRESS_IPS=203.0.113.10/24
expect "IP de saída fora do formato: aviso, e as regras sem o IP" '0 VERAX_NODE_EGRESS_IPS= 1' \
  "$(code_of wazuh-apply) $(cat "$state/render.egress") $(grep -c 'AVISO: NODE_EGRESS_IPS fora do formato' "$state/out")"
scenario WAZUH_AGENTS=true CREDENTIALS_VAULT=true
code_of wazuh-apply >/dev/null
expect "com os agentes e o cofre, os arquivos do projeto do start.sh" \
  '-f /opt/verax/compose.yaml -f /opt/verax/compose.wazuh.yaml -f /opt/verax/compose.wazuh-agents.yaml -f /opt/verax/compose.vault.yaml' \
  "$(head -n 1 "$state/docker.log" | grep -oE '(-f [^ ]+ ?)+' | sed 's/ $//')"

if ((failures > 0)); then
  echo "$failures verificação(ões) falharam." >&2
  exit 1
fi
echo "aws-token.sh e wazuh-apply.sh: todas as verificações passaram."
