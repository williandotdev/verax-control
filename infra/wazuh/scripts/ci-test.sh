#!/usr/bin/env bash
# Teste de ponta a ponta do Wazuh do nó de cliente (perfil standard; T4.2 a T4.9 e fase 2, PR-W1), usado no CI
# (iac.yml) e localmente. Sobe o Wazuh como o `start.sh up` do nó: o compose.yaml do nó mais o compose.wazuh.yaml, num
# pacote montado como o install.sh monta /opt/verax (os dois arquivos e a cópia de infra/wazuh), com as senhas em
# /run/verax e a mesma sequência do start.sh. O banco, a API e o worker não sobem (a imagem da API tem teste próprio).
#
# Precisa de Docker com uns 5 GB livres, de /run/verax gravável por quem roda (no CI, criado antes com sudo) e das
# faixas 172.30.54.0/24 e 172.30.55.0/24 livres no Docker. Usa um projeto próprio (verax-wazuh-ci), apagado com os
# volumes no começo e no fim. Nunca rode num nó: o teste recusa onde houver /etc/verax/node.conf.
#
# 1. instalação nova com senhas aleatórias e sem contas AWS → smoke test;
# 2. rotação das três senhas, agora com duas contas AWS de exemplo → smoke test, e as senhas antigas recusadas;
# 3. filebeat do manager gravando no indexer com TLS verificado;
# 4. contas AWS: módulo aws-s3 aceito pelo manager, um bucket por fonte com o profile da conta, profiles só para o
#    root (no diretório em memória do host, só leitura no manager), ExternalId fora do ossec.conf e do ambiente do
#    contêiner, correlações da AWS por conta instaladas (o efeito delas é testado no scripts/test-rules.sh);
# 5. cada volume de certificado só com as próprias chaves, e a chave da CA inexistente;
# 6. acesso como a API e o worker fazem (INDEXER_AUTH=node): da rede interna, pelo nome do serviço, com a CA do volume
#    público dos certificados;
# 7. retenção e backup: política de 30 dias ligada aos índices novos, 1 shard por índice de alertas, snapshot diário
#    guardado 7 dias e o teste de restauração (snapshot, índice apagado, restauração com e sem renomear, mesma contagem);
# 8. perfil do nó: limites de memória, CPU e processos, capabilities, log local, heap travado, redes (o indexer sem rota
#    para fora, o manager fora da rede do banco), ossec.conf do nó e a limpeza dos alertas antigos;
# 9. atualização do manager (UPGRADE_FROM → a versão da compose) com os mesmos volumes: o código dos módulos que a
#    imagem nova traz não fica escondido pelo volume dos wodles, e o marcador do módulo da AWS continua lá.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -e /etc/verax/node.conf ]]; then
  echo "ERRO: isto parece um nó do Verax Control (/etc/verax/node.conf): o teste apagaria arquivos de /run/verax." >&2
  exit 2
fi
if [[ ! -d /run/verax || ! -w /run/verax ]]; then
  echo "ERRO: /run/verax precisa existir e ser gravável por quem roda o teste (sudo install -d -o \"\$USER\" /run/verax)." >&2
  exit 2
fi

# Versão anterior do manager para o teste de atualização. Quando a compose subir de versão (Dependabot), esta passa a
# ser a que estava em produção.
UPGRADE_FROM=wazuh/wazuh-manager:4.14.8@sha256:412f665c77af5497780d29d0d9f069d7a169c5eca45e9a3a47a587d9cfc99b55

# shellcheck source=SCRIPTDIR/lib-passwords.sh
source scripts/lib-passwords.sh

# O pacote como o install.sh o instala em /opt/verax, e o Compose do projeto de teste para este script e para os
# scripts do pacote (as variáveis COMPOSE_*, como no start.sh).
stage=$(mktemp -d)
cp ../node/compose.yaml ../node/compose.wazuh.yaml "$stage/"
mkdir -p "$stage/wazuh/config"
cp -R scripts "$stage/wazuh/"
cp -R config/indexer config/manager "$stage/wazuh/config/"
bundle=$stage/wazuh
zeros=$(printf '0%.0s' {1..64})
printf 'API_IMAGE=exemplo/api@sha256:%s\nMIGRATE_IMAGE=exemplo/migrate@sha256:%s\n' "$zeros" "$zeros" >"$stage/images.env"
export COMPOSE_PROJECT_NAME=verax-wazuh-ci
export COMPOSE_FILE=$stage/compose.yaml:$stage/compose.wazuh.yaml
export COMPOSE_ENV_FILES=$stage/images.env
project=$COMPOSE_PROJECT_NAME

remove_project() { docker compose --profile setup down -v --remove-orphans >/dev/null 2>&1 || true; }
cleanup() {
  remove_project
  rm -f /run/verax/wazuh-security.env /run/verax/wazuh-manager.env
  # Criado pelo Docker como root; no CI fica para trás com a máquina, que é descartada.
  rm -rf /run/verax/wazuh-aws 2>/dev/null || true
  rm -rf "$stage"
}
remove_project
trap cleanup EXIT

failures=0
expect() { # <descrição> <esperado (regex)> <obtido>
  if [[ $3 =~ ^($2)$ ]]; then
    printf 'ok     %s\n' "$1"
  else
    printf 'FALHA  %s (esperado %s, obtido %s)\n' "$1" "$2" "$3"
    failures=$((failures + 1))
  fi
}

container() { docker compose ps -q "$1"; }

code_as() { # <serviço> <usuário> <senha> <curl args...>
  local service=$1 user=$2 password=$3
  shift 3
  printf 'user = "%s:%s"\n' "$user" "$password" |
    docker exec -i "$(container "$service")" curl -s -K - -o /dev/null -w '%{http_code}' "$@" || true
}

manager_file_count() { # <regex> <arquivo no manager>
  docker exec "$(container wazuh.manager)" grep -cE "$1" "$2" || true
}

new_passwords() {
  INDEXER_ADMIN_PASSWORD=$(new_wazuh_password)
  WAZUH_API_PASSWORD=$(new_wazuh_password)
  INDEXER_API_READ_PASSWORD=$(new_wazuh_password)
  export INDEXER_ADMIN_PASSWORD WAZUH_API_PASSWORD INDEXER_API_READ_PASSWORD
}

# Mesmo formato do write_env do start.sh: CHAVE='valor', só para quem roda.
write_env() { # <arquivo> <CHAVE=valor...>
  local file=/run/verax/$1 line
  : >"$file"
  chmod 0600 "$file"
  for line in "${@:2}"; do printf "%s='%s'\n" "${line%%=*}" "${line#*=}" >>"$file"; done
}

# A sequência do wazuh_up do start.sh. A diferença é a lista de contas: no nó, o wazuh-apply.sh manda a lista vazia
# (as chaves chegam no PR-V4); aqui, a do arquivo.
wazuh_up() { # <lista de contas AWS>
  check_wazuh_passwords INDEXER_ADMIN_PASSWORD WAZUH_API_PASSWORD INDEXER_API_READ_PASSWORD
  write_env wazuh-security.env \
    "INDEXER_ADMIN_PASSWORD=$INDEXER_ADMIN_PASSWORD" "INDEXER_API_READ_PASSWORD=$INDEXER_API_READ_PASSWORD"
  write_env wazuh-manager.env "INDEXER_PASSWORD=$INDEXER_ADMIN_PASSWORD" "API_PASSWORD=$WAZUH_API_PASSWORD"
  docker compose --profile setup run --rm certs-init
  docker compose --profile setup run --rm security-init
  docker compose up --detach --wait --wait-timeout 600 wazuh.indexer
  bash "$bundle/scripts/security-admin.sh"
  bash "$bundle/scripts/configure-indexer.sh"
  docker compose --profile setup run --rm -T manager-config <"$1"
  docker compose up --detach --wait --wait-timeout 900 wazuh.manager
  bash "$bundle/scripts/smoke-test.sh"
}

new_passwords
echo "== Instalação nova"
wazuh_up /dev/null
expect "sem contas, sem módulo aws-s3" 0 "$(manager_file_count '<wodle name="aws-s3">' /var/ossec/etc/ossec.conf)"

old_admin=$INDEXER_ADMIN_PASSWORD old_api=$WAZUH_API_PASSWORD old_api_read=$INDEXER_API_READ_PASSWORD
new_passwords

echo "== Rotação das três senhas, com duas contas AWS"
wazuh_up tests/fixtures/aws-sources.example.json

echo "== Depois da rotação"
indexer_ca=/usr/share/wazuh-indexer/config/certs/root-ca.pem
expect "admin antigo recusado" 401 \
  "$(code_as wazuh.indexer admin "$old_admin" --cacert "$indexer_ca" https://wazuh.indexer:9200/)"
expect "verax_api_read antigo recusado" 401 \
  "$(code_as wazuh.indexer verax_api_read "$old_api_read" --cacert "$indexer_ca" https://wazuh.indexer:9200/)"
expect "wazuh-wui antigo recusado" 401 \
  "$(code_as wazuh.manager wazuh-wui "$old_api" -X POST --cacert /var/ossec/api/configuration/ssl/server.crt \
    https://localhost:55000/security/user/authenticate)"

filebeat=$(docker exec "$(container wazuh.manager)" filebeat test output 2>&1 || true)
expect "filebeat verifica o certificado do indexer" 1 \
  "$(grep -c "server's certificate chain verification is enabled" <<<"$filebeat")"
expect "filebeat autentica no indexer" 1 "$(grep -c 'talk to server... OK' <<<"$filebeat")"

echo "== Acesso como a API e o worker (rede interna, nome do serviço e CA do volume público)"
indexer_image=$(docker inspect --format '{{.Config.Image}}' "$(container wazuh.indexer)")
indexer_ip=$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$(container wazuh.indexer)")
# Um contêiner só na rede interna, com a CA montada onde a API e o worker a leem (INDEXER_CA_FILE do start.sh).
as_app() { # <curl args...>
  printf 'user = "verax_api_read:%s"\n' "$INDEXER_API_READ_PASSWORD" |
    docker run --rm -i --network "${project}_wazuh" -v "${project}_certs-public:/etc/verax/wazuh:ro" \
      --entrypoint curl "$indexer_image" -s -K - -o /dev/null -w '%{http_code}' \
      --cacert /etc/verax/wazuh/root-ca.pem "$@" || true
}
expect "pelo nome do serviço, com a CA do volume público" 200 \
  "$(as_app 'https://wazuh.indexer:9200/wazuh-alerts-*/_search?size=0')"
expect "por outro nome, o TLS recusa" 000 \
  "$(as_app --resolve "outro-nome.exemplo.internal:9200:$indexer_ip" https://outro-nome.exemplo.internal:9200/)"

echo "== Contas AWS"
manager=$(container wazuh.manager)
expect "um bucket por fonte" 4 "$(manager_file_count '<bucket type="(cloudtrail|guardduty|waf)">' /var/ossec/etc/ossec.conf)"
expect "ExternalId fora do ossec.conf" 0 "$(manager_file_count 'exemplo-external-id' /var/ossec/etc/ossec.conf)"
expect "ExternalId fora do ambiente do contêiner" 0 \
  "$(docker inspect --format '{{json .Config.Env}}' "$manager" | grep -c 'exemplo-external-id' || true)"
expect "profiles só para o root" 'root:700 root:600' \
  "$(docker exec "$manager" stat -c '%U:%a' /root/.aws /root/.aws/config | tr '\n' ' ' | sed 's/ $//')"
expect "profiles no diretório em memória do host, só leitura no manager" '/run/verax/wazuh-aws:false' \
  "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/root/.aws"}}{{.Source}}:{{.RW}}{{end}}{{end}}' "$manager")"
expect "wazuh-modulesd (que lê os profiles) roda como root" root \
  "$(docker exec "$manager" ps -o user= -C wazuh-modulesd | head -n 1 | tr -d ' ')"
# O módulo roda ao subir; sem AWS, cada bucket falha na credencial, mas a análise mostra o profile usado.
for _ in {1..36}; do
  [[ $(manager_file_count 'aws-s3: INFO: Fetching logs finished' /var/ossec/logs/ossec.log) -ge 1 ]] && break
  sleep 5
done
expect "módulo AWS iniciado" '[1-9][0-9]*' "$(manager_file_count 'aws-s3: INFO: Module AWS started' /var/ossec/logs/ossec.log)"
expect "conta A: 3 buckets com o profile dela" 3 \
  "$(manager_file_count 'Executing Bucket Analysis.*Profile: verax-111122223333\)' /var/ossec/logs/ossec.log)"
expect "conta B: 1 bucket com o profile dela" 1 \
  "$(manager_file_count 'Executing Bucket Analysis.*Profile: verax-444455556666\)' /var/ossec/logs/ossec.log)"
# O efeito das regras (correlação só dentro da mesma conta) é testado no scripts/test-rules.sh; aqui, a instalação.
expect "correlações por conta instaladas como no repositório" "$(sha256sum <config/manager/rules/verax_aws_rules.xml | cut -c1-64)" \
  "$(docker exec "$manager" sha256sum /var/ossec/etc/rules/verax_aws_rules.xml | cut -c1-64)"
expect "analysisd carregou as regras" 0 "$(manager_file_count 'Error loading the rules' /var/ossec/logs/ossec.log)"
expect "analysisd rodando como wazuh" wazuh "$(docker exec "$manager" ps -o user= -C wazuh-analysisd | head -n 1 | tr -d ' ')"

echo "== Retenção e backup"
# shellcheck source=SCRIPTDIR/lib-indexer.sh
source "$bundle/scripts/lib-indexer.sh"
match_count() { grep -oE "$1" <<<"$response_body" | head -n 1 || true; }
indexer_admin GET /_plugins/_ism/policies/verax-retencao </dev/null
expect "política de retenção apaga com 30 dias" '"min_index_age":"30d"' "$(match_count '"min_index_age":"[^"]*"')"
indexer_admin GET /_plugins/_sm/policies/verax-diario </dev/null
expect "snapshot diário no repositório verax-snapshots" '"repository":"verax-snapshots"' \
  "$(match_count '"repository":"[^"]*"')"
expect "snapshots guardados por 7 dias" '"max_age":"7d"' "$(match_count '"max_age":"[^"]*"')"
expect "repositório de snapshots só do indexer" '1000:700' \
  "$(docker exec "$(container wazuh.indexer)" stat -c '%u:%a' /mnt/snapshots)"
test_index=wazuh-alerts-4.x-verax-teste
for n in 1 2 3; do
  indexer_admin PUT "/$test_index/_doc/$n?refresh=true" <<<"{\"rule\":{\"level\":5},\"teste\":$n}"
done
indexer_admin GET "/$test_index/_settings?flat_settings=true" </dev/null
expect "índice de alertas com 1 shard" '"index.number_of_shards":"1"' "$(match_count '"index.number_of_shards":"[^"]*"')"
expect "índice de alertas sem réplica" '"index.number_of_replicas":"0"' \
  "$(match_count '"index.number_of_replicas":"[^"]*"')"
# O ISM liga o índice à política de forma assíncrona, logo depois da criação: espera até 2 minutos.
for _ in {1..24}; do
  indexer_admin GET "/_plugins/_ism/explain/$test_index" </dev/null
  [[ -n $(match_count '"policy_id":"verax-retencao"') ]] && break
  sleep 5
done
expect "índice novo de alertas segue a retenção" '"policy_id":"verax-retencao"' "$(match_count '"policy_id":"[^"]*"')"
indexer_admin PUT '/_snapshot/verax-snapshots/teste-ci?wait_for_completion=true' \
  <<<"{\"indices\":\"$test_index\",\"include_global_state\":false}"
expect "snapshot criado" 200 "$response_code"
indexer_admin DELETE "/$test_index" </dev/null
expect "índice apagado" 200 "$response_code"
bash "$bundle/scripts/restore-snapshot.sh" teste-ci "$test_index" >/dev/null
indexer_admin GET "/$test_index/_count" </dev/null
expect "restaurado com as 3 mensagens" '"count":3' "$(match_count '"count":[0-9]+')"
bash "$bundle/scripts/restore-snapshot.sh" --rename latest "$test_index" >/dev/null
indexer_admin GET "/restaurado-$test_index/_count" </dev/null
expect "restauração renomeada a partir do último snapshot" '"count":3' "$(match_count '"count":[0-9]+')"
expect "restauração recusa índice aberto de mesmo nome" 1 \
  "$(bash "$bundle/scripts/restore-snapshot.sh" teste-ci "$test_index" >/dev/null 2>&1 && echo 0 || echo 1)"

echo "== Certificados"
# Pelo serviço certs-init, que monta os três volumes em /out (mesma imagem da compose).
volume_files() {
  # shellcheck disable=SC2016 # expandido pelo sh do contêiner
  docker compose --profile setup run --rm --no-deps -T --entrypoint sh certs-init \
    -c 'cd "/out/$1" && for f in *; do printf "%s:%s:%s " "$f" "$(stat -c %u "$f")" "$(stat -c %a "$f")"; done' \
    sh "$1"
}
expect "indexer: só as próprias chaves" \
  'admin-key.pem:1000:400 admin.pem:1000:400 root-ca.pem:1000:400 wazuh.indexer-key.pem:1000:400 wazuh.indexer.pem:1000:400 ' \
  "$(volume_files indexer)"
expect "manager: só as próprias chaves" \
  'root-ca.pem:999:400 wazuh.manager-key.pem:999:400 wazuh.manager.pem:999:400 ' "$(volume_files manager)"
expect "público: só o certificado da CA" 'root-ca.pem:0:444 ' "$(volume_files public)"

echo "== Perfil do nó"
indexer=$(container wazuh.indexer)
host_config() { docker inspect --format "{{.HostConfig.$1}}" "$2"; }
networks_of() { docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' "$1"; }
expect "indexer: 3 GiB de memória e 1,5 CPU" '3221225472 1500000000' \
  "$(host_config Memory "$indexer") $(host_config NanoCpus "$indexer")"
expect "manager: 1,5 GiB de memória e 1 CPU" '1610612736 1000000000' \
  "$(host_config Memory "$manager") $(host_config NanoCpus "$manager")"
expect "indexer: nenhuma capability" '\[ALL\] \[\]' "$(host_config CapDrop "$indexer") $(host_config CapAdd "$indexer")"
# O Docker guarda as capabilities acrescentadas no formato dele (prefixo CAP_, em ordem alfabética): a comparação
# normaliza o nome e a ordem.
caps_added() { docker inspect --format '{{range .HostConfig.CapAdd}}{{.}}{{"\n"}}{{end}}' "$1" | sed -e 's/^CAP_//' -e '/^$/d' | sort | tr '\n' ' '; }
expect "manager: todas as capabilities retiradas" '\[ALL\]' "$(host_config CapDrop "$manager")"
expect "manager: só as capabilities do init" 'CHOWN DAC_OVERRIDE FOWNER KILL SETGID SETUID SYS_CHROOT ' "$(caps_added "$manager")"
for service in wazuh.indexer wazuh.manager; do
  id=$(container "$service")
  expect "$service: limite de processos, sem ganho de privilégio e log local" '1024 \[no-new-privileges:true\] local' \
    "$(host_config PidsLimit "$id") $(host_config SecurityOpt "$id") $(host_config LogConfig.Type "$id")"
  # Para calibrar os limites no ensaio: o uso agora, sem carga.
  docker stats --no-stream --format "       uso de $service: {{.MemUsage}}, CPU {{.CPUPerc}}, {{.PIDs}} processos" "$id"
done
indexer_admin GET '/_nodes/_local/process?filter_path=nodes.*.process.mlockall' </dev/null
expect "indexer com o heap travado na memória" '"mlockall":true' "$(match_count '"mlockall":(true|false)')"
expect "indexer só na rede interna" "${project}_wazuh " "$(networks_of "$indexer")"
expect "rede interna sem saída" true "$(docker network inspect --format '{{.Internal}}' "${project}_wazuh")"
expect "indexer sem rota para fora" 0 "$(docker exec "$indexer" awk '$2 == "00000000"' /proc/net/route | wc -l)"
expect "manager nas redes interna e de saída, fora da rede do banco" "${project}_wazuh ${project}_wazuh-egress " \
  "$(networks_of "$manager")"
expect "só alertas de nível 5 para cima no indexer" 1 \
  "$(manager_file_count '<log_alert_level>5</log_alert_level>' /var/ossec/etc/ossec.conf)"
expect "sem alerts.log em texto" 1 "$(manager_file_count '<alerts_log>no</alerts_log>' /var/ossec/etc/ossec.conf)"
# Sem agentes: o remoted escuta só no loopback (sem o bloco <remote>, o wazuh-control não sobe nenhum daemon) e o authd
# não sobe. Fora do loopback, só a API do manager (55000, em IPv4 e IPv6), na rede interna. Os sockets em escuta
# (estado 0A) vêm de /proc/net/tcp e tcp6, com o endereço em hexadecimal: 127.x.x.x termina em 7F (também o
# 127.0.0.11 do DNS interno do Docker e o IPv4 mapeado em IPv6), e ::1 é 00...01000000.
listening=$(docker exec "$manager" sh -c "cat /proc/net/tcp /proc/net/tcp6 2>/dev/null" | awk '$4 == "0A" { print $2 }' | sort -u)
expect "remoted só no loopback (127.0.0.1:1514)" 1 "$(grep -c '^0100007F:05EA$' <<<"$listening" || true)"
expect "fora do loopback, o manager só escuta a API (55000)" D6D8 \
  "$(awk -F: '$1 !~ /7F$/ && $1 != "00000000000000000000000001000000" { print $2 }' <<<"$listening" | sort -u | tr '\n' ' ' | sed 's/ $//')"
# Limpeza dos alertas antigos (o script do timer do nó): só os .gz com mais de 7 dias saem.
# shellcheck disable=SC2016 # expandido pelo sh do contêiner
docker exec "$manager" sh -c 'd=/var/ossec/logs/alerts/1999/Jan && mkdir -p "$d" &&
  touch -d "8 days ago" "$d/ossec-alerts-01.json.gz" "$d/ossec-alerts-01.json" &&
  touch -d "6 days ago" "$d/ossec-alerts-03.json.gz"'
bash ../node/bin/wazuh-alerts-cleanup.sh
expect "alertas compactados com mais de 7 dias apagados; os outros ficam" 'ossec-alerts-01.json ossec-alerts-03.json.gz ' \
  "$(docker exec "$manager" sh -c 'cd /var/ossec/logs/alerts/1999/Jan && ls | tr "\n" " "')"

echo "== Atualização do manager ($UPGRADE_FROM → a versão da compose), com os mesmos volumes"
current_image=$(docker inspect --format '{{.Config.Image}}' "$manager")
old_version=${UPGRADE_FROM#*:}
old_version=v${old_version%@*}
new_version=$(docker run --rm --entrypoint /var/ossec/bin/wazuh-control "$current_image" info -v)
# Um manager instalado do zero na versão anterior: volumes novos, criados por ela.
docker compose rm --stop --force wazuh.manager >/dev/null
for volume in manager-api-configuration manager-etc manager-logs manager-queue manager-var-multigroups \
  manager-integrations manager-active-response manager-agentless manager-wodles filebeat-etc filebeat-var; do
  docker volume rm "${project}_$volume" >/dev/null
done
printf 'services:\n  wazuh.manager:\n    image: %s\n' "$UPGRADE_FROM" >"$stage/upgrade-from.yaml"
COMPOSE_FILE=$COMPOSE_FILE:$stage/upgrade-from.yaml docker compose up --detach --wait --wait-timeout 900 wazuh.manager
expect "manager na versão anterior" "$old_version" "$(docker exec "$(container wazuh.manager)" /var/ossec/bin/wazuh-control info -v)"
docker exec "$(container wazuh.manager)" sh -c 'echo marcador >/var/ossec/wodles/aws/verax-ci-marcador.db'
# A atualização como no nó: a compose com a imagem nova, os mesmos volumes.
docker compose up --detach --wait --wait-timeout 900 wazuh.manager
manager=$(container wazuh.manager)
expect "manager atualizado" "$new_version" "$(docker exec "$manager" /var/ossec/bin/wazuh-control info -v)"
expect "marcador do módulo da AWS mantido no volume" marcador \
  "$(docker exec "$manager" cat /var/ossec/wodles/aws/verax-ci-marcador.db)"
# O que a imagem traz para /var/ossec/wodles: a base (copiada na primeira partida) e a lista que o init copia a cada
# partida, que vale por cima. Cada arquivo tem de estar no volume igual ao da imagem; os que sobram da versão anterior
# não importam, e os bancos (*.db) são do volume.
image_wodles='cd /var/ossec/data_tmp/permanent/var/ossec/wodles && find . -type f ! -path "*/__pycache__/*" -exec sha256sum {} + &&
  cd /var/ossec/data_tmp/exclusion/var/ossec/wodles && find . -type f -exec sha256sum {} +'
wodles_of_image() { # <imagem>
  docker run --rm --entrypoint sh "$1" -c "$image_wodles" |
    awk '{ hash[$2] = $1 } END { for (file in hash) print hash[file], file }' | sort
}
expected=$(wodles_of_image "$current_image")
# shellcheck disable=SC2016 # expandido pelo sh do contêiner
installed=$(docker exec "$manager" sh -c \
  'cd /var/ossec/wodles && find . -type f ! -name "*.db" ! -path "*/__pycache__/*" -exec sha256sum {} +' |
  awk '{ print $1, $2 }' | sort)
hidden=$(comm -23 <(echo "$expected") <(echo "$installed"))
expect "código dos módulos igual ao da imagem nova (nada escondido pelo volume)" 0 "$(grep -c . <<<"$hidden" || true)"
if [[ -n $hidden ]]; then
  while read -r line; do echo "       diferente ou ausente no volume: $line"; done <<<"$hidden"
fi
# Sem nenhum arquivo diferente entre as duas versões, o teste acima não prova nada: fica registrado.
changed=$(comm -23 <(echo "$expected") <(wodles_of_image "$UPGRADE_FROM") | grep -c . || true)
echo "       $changed arquivo(s) dos módulos mudaram de $old_version para $new_version"

if ((failures > 0)); then
  echo "$failures verificação(ões) falharam." >&2
  exit 1
fi
echo "Teste de ponta a ponta do Wazuh do nó passou."
