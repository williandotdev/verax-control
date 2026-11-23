#!/bin/bash
# Testa o bin/wazuh-progress.sh (onboarding self-service da AWS: o sinal `progress` com os marcadores do módulo do
# Wazuh), sem root, sem Docker e sem o Wazuh. No CI: `bash infra/node/tests/wazuh-progress-test.sh`.
#
# O script roda como o systemd o roda (num processo à parte e num ambiente limpo), numa pasta temporária que faz o papel
# de /etc/verax, /run/verax e /opt/verax. O docker é simulado e anota cada chamada: o `ps` diz se o manager está no ar,
# e o `exec` roda o exportador de verdade (o programa que chega pela entrada padrão, com o python3 da máquina) sobre os
# bancos SQLite do cenário, criados aqui com as tabelas do módulo aws-s3 do Wazuh. O chown só anota; o install tira o
# dono (-o/-g), que pede root. O resto (mktemp, mv, head, wc, timeout) é o de verdade.
#
# O que é conferido: sem o Wazuh no ar, nada; com os bancos, o sinal traz o último objeto lido de cada fonte e o último
# evento de cada grupo, de uma vez (0440, grupo do worker, sem arquivo temporário), e os bancos ficam byte a byte como
# estavam; um banco travado ou ausente não é erro; a falha do exportador, uma saída grande demais ou fora do formato
# deixam o sinal anterior; o exportador recebe o programa do pacote pela entrada padrão, em modo isolado, sem montar nem
# copiar nada no contêiner.
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
exporter=$here/../wazuh/scripts/export-aws-progress.py

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

# O Docker do nó: o manager no ar (ou não) e o exportador dentro dele.
stub docker <<'EOF'
printf '%s\n' "$*" >>"$state/docker.log"
case " $* " in
  ' ps --quiet --filter label=com.docker.compose.project=verax --filter label=com.docker.compose.service=wazuh.manager ')
    if [[ -f $state/running ]]; then echo manager-id; fi ;;
  ' exec -i manager-id /var/ossec/framework/python/bin/python3 -I - /var/ossec/wodles/aws ')
    # O programa que chega pela entrada padrão, guardado para o cenário conferir que é o do pacote.
    cat >"$state/program.py"
    [[ ! -f $state/exec.fail ]] || { echo 'Error response from daemon (simulado)' >&2; exit 1; }
    if [[ -f $state/exec.output ]]; then
      cat "$state/exec.output"
    else
      python3 -I "$state/program.py" "$state/wodles"
    fi ;;
  *) echo "docker simulado: chamada inesperada: $*" >&2; exit 64 ;;
esac
EOF
stub chown <<'EOF'
printf 'chown %s\n' "$*" >>"$state/chown.log"
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

# Uma raiz nova por cenário: o node.conf de exemplo (sem comentários) com as linhas do cenário, o exportador do pacote
# em /opt/verax/wazuh/scripts e o script com os três caminhos trocados.
root='' state='' run=''
new_root() { # <CHAVE=valor...>
  root=$work/root-$RANDOM$RANDOM
  state=$root.state
  run=$root/run/verax
  mkdir -p "$root/etc/verax" "$root/opt/verax/wazuh/scripts" "$state/wodles" "$run"
  grep -v -e '^#' -e '^$' "$here/node.conf.example" >"$root/etc/verax/node.conf"
  local line
  for line in "$@"; do
    sed -i "/^${line%%=*}=/d" "$root/etc/verax/node.conf"
    echo "$line" >>"$root/etc/verax/node.conf"
  done
  cp "$exporter" "$root/opt/verax/wazuh/scripts/export-aws-progress.py"
  sed -e "s#/etc/verax/node.conf#$root/etc/verax/node.conf#g" -e "s#^run=/run/verax\$#run=$run#" \
    -e "s#^script=/opt/verax/#script=$root/opt/verax/#" "$here/bin/wazuh-progress.sh" >"$root/wazuh-progress.sh"
}

run_script() {
  local status=0
  env -i PATH="$work/bin:$PATH" VERAX_TEST_STATE="$state" "$BASH" "$root/wazuh-progress.sh" >"$state/out" 2>&1 ||
    status=$?
  return "$status"
}
code_of() { local status=0; run_script || status=$?; echo "$status"; }
listing() { find "$1" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort | paste -sd' ' -; }
mode() { stat -c %a "$1"; }
progress() { cat "$run/wazuh-signal/progress" 2>/dev/null || echo ausente; }
calls() { grep -c -- "$1" "$state/docker.log" 2>/dev/null || true; }
# O resumo de todos os arquivos da pasta dos bancos: nada pode mudar com a exportação.
fingerprint() { (cd "$state/wodles" && find . -type f -exec sha256sum {} + | LC_ALL=C sort | sha256sum | cut -c1-64); }

# Os bancos do módulo, com as tabelas dele (buckets_s3/aws_bucket.py e services/cloudwatchlogs.py do Wazuh 4.14.9).
ACCOUNT=111122223333
TRAIL_KEY="AWSLogs/$ACCOUNT/CloudTrail/sa-east-1/2026/11/23/${ACCOUNT}_CloudTrail_sa-east-1_20261123T1155Z_a.json.gz"
databases() {
  python3 - "$state/wodles" "$ACCOUNT" "$TRAIL_KEY" <<'EOF'
import sqlite3
import sys

directory, account, key = sys.argv[1:4]
s3 = sqlite3.connect(f"{directory}/s3_cloudtrail.db")
s3.execute("""CREATE TABLE cloudtrail (bucket_path 'text' NOT NULL, aws_account_id 'text' NOT NULL,
    aws_region 'text' NOT NULL, log_key 'text' NOT NULL, processed_date 'text' NOT NULL,
    created_date 'integer' NOT NULL, PRIMARY KEY (bucket_path, aws_account_id, aws_region, log_key))""")
s3.execute("INSERT INTO cloudtrail VALUES (?, ?, 'sa-east-1', ?, '2026-11-23 11:58:02', 20261123)",
           ("trilha-de-exemplo/", account, key))
s3.commit()
s3.close()
services = sqlite3.connect(f"{directory}/aws_services.db")
services.execute("""CREATE TABLE cloudwatch_logs (aws_region 'text' NOT NULL, aws_log_group 'text' NOT NULL,
    aws_log_stream 'text' NOT NULL, next_token 'text', start_time 'integer', end_time 'integer',
    PRIMARY KEY (aws_region, aws_log_group, aws_log_stream))""")
services.execute("INSERT INTO cloudwatch_logs VALUES ('sa-east-1', '/aws/lambda/cobranca', 'a', 't', 1, 1793527200000)")
services.commit()
services.close()
EOF
}
ISO='[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z'
EMPTY='"s3":\{"status":"missing","truncated":false,"entries":\[\]\},"cloudwatch":\{"status":"missing","truncated":false,"entries":\[\]\}'

echo "== wazuh-progress.sh: só no standard, e só com o Wazuh no ar"
new_root NODE_PROFILE=lean
expect "no lean, recusa sem chamar o Docker" '2 ausente' \
  "$(code_of) $([[ -f $state/docker.log ]] && echo chamado || echo ausente)"

new_root NODE_PROFILE=standard
touch "$state/running"
expect "sem a pasta dos profiles (o Wazuh não subiu desde a partida): nada a exportar, sem erro" 0 "$(code_of)"
expect "  sem chamar o Docker nem criar a pasta dos sinais" 'ausente ausente' \
  "$([[ -f $state/docker.log ]] && echo chamado || echo ausente) $([[ -e $run/wazuh-signal ]] && echo criada || echo ausente)"

mkdir -m 0700 "$run/wazuh-aws"
rm -f "$state/running"
expect "com o manager fora do ar: sem erro (o timer segue)" 0 "$(code_of)"
expect "  sem sinal e sem rodar nada no contêiner" 'ausente 0' "$(progress) $(calls ' exec ')"

echo "== wazuh-progress.sh: os marcadores do módulo viram o sinal do worker"
touch "$state/running"
expect "sem banco nenhum (o módulo nunca leu): exportado, com as duas partes vazias" 0 "$(code_of)"
expect "  o documento de uma linha, com a hora" "\\{\"version\":1,\"at\":\"$ISO\",$EMPTY\\}" "$(progress)"
expect "  e nenhum banco criado na pasta do módulo" '' "$(listing "$state/wodles")"

databases
before=$(fingerprint)
expect "com os bancos do módulo: exportado" 0 "$(code_of)"
expect "  o último objeto lido da trilha, com a conta, a região e a hora da leitura" 1 \
  "$(grep -c "{\"table\":\"cloudtrail\",\"bucketPath\":\"trilha-de-exemplo/\",\"accountId\":\"$ACCOUNT\",\"region\":\"sa-east-1\",\"flowLogId\":null,\"lastKey\":\"$TRAIL_KEY\",\"processedAt\":\"2026-11-23T11:58:02Z\",\"createdDate\":20261123,\"keys\":1}" "$run/wazuh-signal/progress")"
expect "  o último evento do grupo de logs" 1 \
  "$(grep -c '{"region":"sa-east-1","logGroup":"/aws/lambda/cobranca","endTime":1793527200000,"streams":1}' "$run/wazuh-signal/progress")"
expect "  uma linha só" 1 "$(wc -l <"$run/wazuh-signal/progress" | tr -d ' ')"
expect "  sinal 0440, do grupo do worker, na pasta 1770 dele" '440 1770' \
  "$(mode "$run/wazuh-signal/progress") $(mode "$run/wazuh-signal")"
expect "  cada sinal gravado passa ao root e ao grupo do worker (dois até aqui)" 2 \
  "$(grep -c '^chown 0:1000 ' "$state/chown.log")"
expect "  a pasta dos sinais do root e do grupo do worker" '[1-9][0-9]* [1-9][0-9]*' \
  "$(grep -c '^install -o 0$' "$state/install.log") $(grep -c '^install -g 1000$' "$state/install.log")"
expect "  nenhum arquivo temporário na pasta dos sinais" 'progress' "$(listing "$run/wazuh-signal")"
expect "  os bancos do módulo ficam byte a byte como estavam, sem arquivo novo" "$before aws_services.db s3_cloudtrail.db" \
  "$(fingerprint) $(listing "$state/wodles")"
expect "  o exportador é o do pacote, pela entrada padrão do contêiner" igual \
  "$(cmp -s "$state/program.py" "$exporter" && echo igual || echo diferente)"
expect "  só leitura no contêiner: nenhum cp, run, compose nem volume" 0 \
  "$(grep -c -E '(^| )(cp|run|compose|create|-v|--volume|--mount)( |$)' "$state/docker.log" || true)"
expect "  nada do que o exportador leu vai para o journal" 0 "$(grep -c -e trilha-de-exemplo -e cobranca "$state/out" || true)"

echo "== wazuh-progress.sh: um banco travado pelo módulo não é erro"
python3 - "$state/wodles/s3_cloudtrail.db" "$state/locked" <<'EOF' &
import os
import sqlite3
import sys
import time

connection = sqlite3.connect(sys.argv[1], isolation_level=None)
connection.execute("BEGIN EXCLUSIVE")
open(sys.argv[2], "w").close()
# Segura a trava até o cenário terminar (ele apaga o arquivo) ou por 60 s.
deadline = time.time() + 60
while os.path.exists(sys.argv[2]) and time.time() < deadline:
    time.sleep(0.1)
connection.execute("ROLLBACK")
EOF
locker=$!
for _ in $(seq 1 100); do [[ -f $state/locked ]] && break; sleep 0.1; done
expect "com o banco do S3 travado: exportado mesmo assim" 0 "$(code_of)"
expect "  a parte do S3 sai como travada, e a do CloudWatch Logs inteira" '1 1' \
  "$(grep -c '"s3":{"status":"locked","truncated":false,"entries":\[\]}' "$run/wazuh-signal/progress") $(grep -c '"cloudwatch":{"status":"ok"' "$run/wazuh-signal/progress")"
rm -f "$state/locked"
wait "$locker"
expect "solta a trava, a parte do S3 volta" 0 "$(code_of)"
expect "  com a leitura da trilha" 1 "$(grep -c '"s3":{"status":"ok","truncated":false,"entries":\[{"table":"cloudtrail"' "$run/wazuh-signal/progress")"

echo "== wazuh-progress.sh: o que não serve deixa o sinal anterior"
kept=$(progress)
touch "$state/exec.fail"
expect "o exportador falha no contêiner: erro" 1 "$(code_of)"
expect "  o sinal anterior fica, sem arquivo temporário" "igual progress" \
  "$([[ $(progress) == "$kept" ]] && echo igual || echo diferente) $(listing "$run/wazuh-signal")"
rm -f "$state/exec.fail"

printf '%s\n' '{"version":2,"at":"2026-11-23T12:00:00Z"}' >"$state/exec.output"
expect "uma versão que o worker não lê: erro" 1 "$(code_of)"
expect "  o sinal anterior fica" igual "$([[ $(progress) == "$kept" ]] && echo igual || echo diferente)"

printf '%s\n%s\n' '{"version":1,"at":"2026-11-23T12:00:00Z"}' 'segunda linha' >"$state/exec.output"
expect "mais de uma linha: erro" 1 "$(code_of)"
expect "  o sinal anterior fica" igual "$([[ $(progress) == "$kept" ]] && echo igual || echo diferente)"

: >"$state/exec.output"
expect "saída vazia: erro" 1 "$(code_of)"
expect "  o sinal anterior fica" igual "$([[ $(progress) == "$kept" ]] && echo igual || echo diferente)"

# Um documento maior que o teto (4 MiB): cortado pelo host, nunca gravado.
python3 -c 'import sys; sys.stdout.write("{\"version\":1,\"at\":\"x\",\"s3\":\"" + "a" * (4 * 1024 * 1024) + "\"}\n")' \
  >"$state/exec.output"
expect "um documento acima do teto: erro" 1 "$(code_of)"
expect "  com o motivo no journal, e o sinal anterior no lugar" '1 igual progress' \
  "$(grep -c 'passaram de 4194304 bytes' "$state/out") $([[ $(progress) == "$kept" ]] && echo igual || echo diferente) $(listing "$run/wazuh-signal")"
rm -f "$state/exec.output"

expect "de volta ao normal, o sinal é trocado" 0 "$(code_of)"
expect "  com a hora nova e as mesmas leituras" 1 "$(grep -c "\"lastKey\":\"$TRAIL_KEY\"" "$run/wazuh-signal/progress")"

if ((failures > 0)); then
  echo "$failures verificação(ões) falharam." >&2
  exit 1
fi
echo "wazuh-progress.sh: todas as verificações passaram."
