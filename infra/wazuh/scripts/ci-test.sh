#!/usr/bin/env bash
# Teste de ponta a ponta do Wazuh do nó de cliente (perfil standard; T4.2 a T4.9 e fase 2, PR-W1), usado no CI
# (iac.yml) e localmente. Sobe o Wazuh como o `start.sh up` do nó: o compose.yaml do nó mais o compose.wazuh.yaml, num
# pacote montado como o install.sh monta /opt/verax (os dois arquivos e a cópia de infra/wazuh), com as senhas em
# /run/verax e a mesma sequência do start.sh. O banco, a API e o worker não sobem (a imagem da API tem teste próprio).
#
# Precisa de Docker com uns 5 GB livres, de /run/verax gravável por quem roda (no CI, criado antes com sudo) e das
# faixas das redes do Wazuh (172.30.54.0/24, 172.30.55.0/24 e 172.30.56.0/24) livres no Docker. Usa um projeto
# próprio (verax-wazuh-ci), apagado com os volumes no começo e no fim. Nunca rode num nó: o teste recusa onde houver
# /etc/verax/node.conf.
#
# 1. instalação nova com senhas aleatórias e sem contas AWS → o usuário verax_stats da API do manager
#    (init-api-users.sh) → smoke test;
# 2. rotação das cinco senhas, agora com duas contas AWS de exemplo → smoke test, e as senhas antigas recusadas;
# 3. filebeat do manager gravando no indexer com TLS verificado e com o usuário wazuh_filebeat (só escrita): um alerta
#    posto no alerts.json chega ao índice do dia pelo pipeline do módulo, com o template do Wazuh instalado por ele;
# 4. contas AWS sem chave (fase 2, PR-V4'): módulo aws-s3 aceito pelo manager, um bucket por fonte com o profile da
#    conta, só leitura (remove_from_bucket no), profiles de web identity (papel derivado, token do Google do host, sem
#    chave nem credential_process) só para o root (no diretório em memória do host, só leitura no manager), o boto3 do
#    manager com o provedor de web identity, as correlações por conta e as regras do papel de leitura (com o IP do nó)
#    instaladas e carregadas (o efeito delas é testado no scripts/test-rules.sh). Nenhum token é posto na pasta: o
#    módulo falha ao ler o arquivo do token, antes de qualquer chamada à AWS;
# 5. cada volume de certificado só com as próprias chaves, e a chave da CA inexistente;
# 6. acesso como a API e o worker fazem (INDEXER_AUTH=node): da rede `wazuh-read`, pelo nome do serviço, com a CA do
#    volume público dos certificados; e à API do manager como o worker faz (PR-V6): da rede `wazuh`, pelo nome
#    wazuh.manager, com a mesma CA e o verax_stats, que lê os contadores do analysisd; da rede da API (`wazuh-read`), o
#    manager não é alcançado;
# 7. retenção e backup: política de 30 dias ligada aos índices novos, 1 shard por índice de alertas, snapshot diário
#    guardado 7 dias e o teste de restauração (snapshot, índice apagado, restauração com e sem renomear, mesma contagem);
# 8. perfil do nó: limites de memória, CPU e processos, capabilities, log local, heap travado, tempo de parada, redes
#    (o indexer só nas internas e sem rota para fora, o manager fora da rede do banco e sem alcançar a rede da API),
#    ossec.conf do nó e a limpeza dos alertas antigos;
# 9. atualização do manager (UPGRADE_FROM → a versão da compose) com os mesmos volumes: o código que a imagem nova traz
#    para os volumes persistentes (wodles, integrations, active-response/bin e agentless) não fica escondido por eles,
#    e o marcador do módulo da AWS continua lá.
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
  INDEXER_FILEBEAT_PASSWORD=$(new_wazuh_password)
  WAZUH_API_PASSWORD=$(new_wazuh_password)
  INDEXER_API_READ_PASSWORD=$(new_wazuh_password)
  WAZUH_STATS_PASSWORD=$(new_wazuh_password)
  export INDEXER_ADMIN_PASSWORD INDEXER_FILEBEAT_PASSWORD WAZUH_API_PASSWORD INDEXER_API_READ_PASSWORD WAZUH_STATS_PASSWORD
}

# Mesmo formato do write_env do start.sh: CHAVE='valor', só para quem roda.
write_env() { # <arquivo> <CHAVE=valor...>
  local file=/run/verax/$1 line
  : >"$file"
  chmod 0600 "$file"
  for line in "${@:2}"; do printf "%s='%s'\n" "${line%%=*}" "${line#*=}" >>"$file"; done
}

# A sequência do wazuh_up do start.sh. A diferença é a lista de contas: no nó, o wazuh-apply.sh a lê do banco (o CLI
# wazuh-sources); aqui, a do arquivo, com um IP de saída de documentação para as regras do papel de leitura.
wazuh_up() { # <lista de contas AWS>
  check_wazuh_passwords INDEXER_ADMIN_PASSWORD INDEXER_FILEBEAT_PASSWORD WAZUH_API_PASSWORD INDEXER_API_READ_PASSWORD \
    WAZUH_STATS_PASSWORD
  write_env wazuh-security.env "INDEXER_ADMIN_PASSWORD=$INDEXER_ADMIN_PASSWORD" \
    "INDEXER_FILEBEAT_PASSWORD=$INDEXER_FILEBEAT_PASSWORD" "INDEXER_API_READ_PASSWORD=$INDEXER_API_READ_PASSWORD"
  write_env wazuh-manager.env "INDEXER_PASSWORD=$INDEXER_FILEBEAT_PASSWORD" "API_PASSWORD=$WAZUH_API_PASSWORD"
  docker compose --profile setup run --rm certs-init
  docker compose --profile setup run --rm security-init
  docker compose up --detach --wait --wait-timeout 600 wazuh.indexer
  bash "$bundle/scripts/security-admin.sh"
  bash "$bundle/scripts/configure-indexer.sh"
  docker compose --profile setup run --rm -T -e VERAX_NODE_EGRESS_IPS=203.0.113.10/32 manager-config <"$1"
  docker compose up --detach --wait --wait-timeout 900 wazuh.manager
  bash "$bundle/scripts/init-api-users.sh"
  bash "$bundle/scripts/smoke-test.sh"
}

new_passwords
echo "== Instalação nova"
wazuh_up /dev/null
expect "sem contas, sem módulo aws-s3" 0 "$(manager_file_count '<wodle name="aws-s3">' /var/ossec/etc/ossec.conf)"

old_admin=$INDEXER_ADMIN_PASSWORD old_filebeat=$INDEXER_FILEBEAT_PASSWORD old_api=$WAZUH_API_PASSWORD
old_api_read=$INDEXER_API_READ_PASSWORD old_stats=$WAZUH_STATS_PASSWORD
new_passwords

echo "== Rotação das cinco senhas, com duas contas AWS"
wazuh_up tests/fixtures/aws-sources.example.json

echo "== Depois da rotação"
indexer_ca=/usr/share/wazuh-indexer/config/certs/root-ca.pem
expect "admin antigo recusado" 401 \
  "$(code_as wazuh.indexer admin "$old_admin" --cacert "$indexer_ca" https://wazuh.indexer:9200/)"
expect "wazuh_filebeat antigo recusado" 401 \
  "$(code_as wazuh.indexer wazuh_filebeat "$old_filebeat" --cacert "$indexer_ca" https://wazuh.indexer:9200/)"
expect "verax_api_read antigo recusado" 401 \
  "$(code_as wazuh.indexer verax_api_read "$old_api_read" --cacert "$indexer_ca" https://wazuh.indexer:9200/)"
# A API do manager com o par do manager, da CA do nó (manager-api-tls.sh): conferida pelo nome wazuh.manager.
manager_api_tls=(--cacert /etc/ssl/verax/root-ca.pem --resolve wazuh.manager:55000:127.0.0.1)
expect "wazuh-wui antigo recusado" 401 \
  "$(code_as wazuh.manager wazuh-wui "$old_api" -X POST "${manager_api_tls[@]}" \
    https://wazuh.manager:55000/security/user/authenticate)"
expect "verax_stats antigo recusado" 401 \
  "$(code_as wazuh.manager verax_stats "$old_stats" -X POST "${manager_api_tls[@]}" \
    https://wazuh.manager:55000/security/user/authenticate)"

echo "== Filebeat do manager: usuário só de escrita, TLS verificado e um alerta de ponta a ponta"
manager=$(container wazuh.manager)
filebeat=$(docker exec "$manager" filebeat test output 2>&1 || true)
expect "filebeat verifica o certificado do indexer" 1 \
  "$(grep -c "server's certificate chain verification is enabled" <<<"$filebeat")"
expect "filebeat autentica no indexer" 1 "$(grep -c 'talk to server... OK' <<<"$filebeat")"
expect "filebeat configurado com o usuário wazuh_filebeat, e não com o admin" "username: 'wazuh_filebeat'" \
  "$(docker exec "$manager" grep -oE "^  username: '[a-z_]+'" /etc/filebeat/filebeat.yml | sed 's/^ *//')"
expect "a senha do admin do indexer não está no ambiente do manager" 0 \
  "$(docker inspect --format '{{json .Config.Env}}' "$manager" | grep -c "$INDEXER_ADMIN_PASSWORD" || true)"
# shellcheck source=SCRIPTDIR/lib-indexer.sh
source "$bundle/scripts/lib-indexer.sh"
match_count() { grep -oE "$1" <<<"$response_body" | head -n 1 || true; }
# Um alerta de nível 5 posto no alerts.json (o que o analysisd grava) tem de aparecer no índice do dia: o caminho
# inteiro do filebeat com o usuário só de escrita (bulk, criação do índice e pipeline). O filebeat só abre a conexão
# com o indexer quando tem o que enviar (um manager sem agentes e com corte no nível 5 pode ficar minutos sem alerta):
# é este alerta que força a conexão, e só depois dele o template e o pipeline existem.
alert_marker="verax-ci-$(date -u +%s)"
alert=$(printf '{"timestamp":"%s","rule":{"level":5,"description":"Verax CI: alerta de teste","id":"999999","firedtimes":1,"mail":false,"groups":["verax-ci"]},"agent":{"id":"000","name":"wazuh.manager"},"manager":{"name":"wazuh.manager"},"id":"%s.1","decoder":{"name":"json"},"data":{"verax_ci":"%s"},"location":"verax-ci"}' \
  "$(date -u +%Y-%m-%dT%H:%M:%S.000+0000)" "$(date -u +%s)" "$alert_marker")
docker exec "$manager" sh -c "printf '%s\n' '$alert' >>/var/ossec/logs/alerts/alerts.json"
for _ in {1..36}; do
  indexer_admin GET "/wazuh-alerts-4.x-*/_count?q=data.verax_ci:$alert_marker" </dev/null
  [[ $(match_count '"count":[0-9]+') == '"count":1' ]] && break
  sleep 5
done
expect "alerta do alerts.json indexado pelo filebeat no índice do dia" '"count":1' "$(match_count '"count":[0-9]+')"
# O que o filebeat instalou ao conectar, com as permissões do wazuh_filebeat: o template legado do Wazuh e o pipeline
# de ingestão do módulo (o índice do dia vem do `date_index_name` dele).
indexer_admin GET /_template/wazuh </dev/null
expect "template wazuh instalado pelo filebeat" 200 "$response_code"
indexer_admin GET /_ingest/pipeline/filebeat-7.10.2-wazuh-alerts-pipeline </dev/null
expect "pipeline do módulo wazuh instalado pelo filebeat" 200 "$response_code"
# O harvester de inventário do manager (4.14.9) sobe mesmo com o bloco <indexer> desligado e tenta criar um template
# wazuh-states-inventory-* por tipo com a credencial do keystore, a do filebeat: tem de falhar (um aviso por índice a
# cada partida, nada indexado). Se um dia conseguir, o usuário do filebeat ganhou permissão demais.
expect "o harvester do manager não consegue iniciar o conector com o usuário do filebeat" 0 \
  "$(manager_file_count 'IndexerConnector initialized successfully' /var/ossec/logs/ossec.log)"
# Quantas vezes ele tentou é um detalhe da 4.14.9 (uma versão nova pode honrar o <indexer> desligado e nem tentar):
# fica registrado, sem ser exigido. As sentinelas são a de cima e a de baixo: nenhum conector iniciado, nenhum índice.
echo "       tentativas do harvester registradas no log: $(manager_file_count 'IndexerConnector initialization failed' /var/ossec/logs/ossec.log)"
indexer_admin GET '/_cat/indices/wazuh-states-*?h=index' </dev/null
expect "nenhum índice wazuh-states-* criado pelo manager" '' "${response_body//[[:space:]]/}"

echo "== Acesso como a API e o worker (redes wazuh-read e wazuh, nome do serviço e CA do volume público)"
indexer_image=$(docker inspect --format '{{.Config.Image}}' "$(container wazuh.indexer)")
indexer_ip_of() { # <rede>
  docker inspect --format "{{(index .NetworkSettings.Networks \"$1\").IPAddress}}" "$(container wazuh.indexer)"
}
indexer_ip=$(indexer_ip_of "${project}_wazuh-read")
# Um contêiner só na rede da API, com a CA montada onde a API e o worker a leem (INDEXER_CA_FILE do start.sh).
as_app() { # <curl args...>
  printf 'user = "verax_api_read:%s"\n' "$INDEXER_API_READ_PASSWORD" |
    docker run --rm -i --network "${project}_wazuh-read" -v "${project}_certs-public:/etc/verax/wazuh:ro" \
      --entrypoint curl "$indexer_image" -s -K - -o /dev/null -w '%{http_code}' \
      --cacert /etc/verax/wazuh/root-ca.pem "$@" || true
}
expect "pelo nome do serviço, com a CA do volume público" 200 \
  "$(as_app 'https://wazuh.indexer:9200/wazuh-alerts-*/_search?size=0')"
expect "por outro nome, o TLS recusa" 000 \
  "$(as_app --resolve "outro-nome.exemplo.internal:9200:$indexer_ip" https://outro-nome.exemplo.internal:9200/)"
# A API do manager como o worker a chama (tarefa wazuh-usage, PR-V6): da rede `wazuh`, pelo nome wazuh.manager, com a CA
# do volume público e o verax_stats (as credenciais e o token vão pela entrada padrão do curl).
manager_ip=$(docker inspect --format "{{(index .NetworkSettings.Networks \"${project}_wazuh\").IPAddress}}" \
  "$(container wazuh.manager)")
on_network() { # <rede> <curl args...>: o corpo da resposta, do curl num contêiner só nessa rede
  local network=$1
  shift
  docker run --rm -i --network "${project}_$network" -v "${project}_certs-public:/etc/verax/wazuh:ro" \
    --entrypoint curl "$indexer_image" -s -m 10 -K - --cacert /etc/verax/wazuh/root-ca.pem "$@" || true
}
stats_token=$(printf 'user = "verax_stats:%s"\n' "$WAZUH_STATS_PASSWORD" |
  on_network wazuh -X POST 'https://wazuh.manager:55000/security/user/authenticate?raw=true')
expect "worker: o verax_stats entra pelo nome do serviço, com a CA do volume público" 1 \
  "$([[ $stats_token =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]] && echo 1 || echo 0)"
expect "worker: lê os contadores do analysisd" '.*"name": ?"wazuh-analysisd".*"bytes": ?\{"received": ?[0-9]+\}.*' \
  "$(printf 'header = "Authorization: Bearer %s"\n' "$stats_token" |
    on_network wazuh 'https://wazuh.manager:55000/manager/daemons/stats?daemons_list=wazuh-analysisd')"
expect "worker: por outro nome, o TLS recusa" 000 \
  "$(printf '' | on_network wazuh -o /dev/null -w '%{http_code}' --resolve "outro-nome.exemplo.internal:55000:$manager_ip" \
    https://outro-nome.exemplo.internal:55000/)"
# A API do Verax Control fica só na `wazuh-read`: dali, o manager não existe (nem pelo nome, nem pelo endereço).
expect "da rede da API, o manager não é alcançado pelo nome" 000 \
  "$(printf '' | on_network wazuh-read -o /dev/null -w '%{http_code}' https://wazuh.manager:55000/)"
expect "da rede da API, o manager não é alcançado pelo endereço" 000 \
  "$(printf '' | on_network wazuh-read -o /dev/null -w '%{http_code}' --resolve "wazuh.manager:55000:$manager_ip" \
    https://wazuh.manager:55000/)"

echo "== Contas AWS (papel de leitura sem chave)"
expect "um bucket por fonte" 4 "$(manager_file_count '<bucket type="(cloudtrail|guardduty|waf)">' /var/ossec/etc/ossec.conf)"
expect "todo bucket só lido (remove_from_bucket no)" 4 \
  "$(manager_file_count '<remove_from_bucket>no</remove_from_bucket>' /var/ossec/etc/ossec.conf)"
expect "nenhuma chave nem papel no ossec.conf" 0 \
  "$(manager_file_count '<(access_key|secret_key|iam_role_arn|external_id)>' /var/ossec/etc/ossec.conf)"
expect "profiles com o papel derivado de cada conta e o token do host" '2 2' \
  "$(manager_file_count '^role_arn = arn:aws:iam::[0-9]{12}:role/verax/verax-control-reader$' /root/.aws/config) $(
    manager_file_count '^web_identity_token_file = /root/.aws/google-id-token$' /root/.aws/config)"
expect "nenhuma chave nem credential_process nos profiles, e nenhum arquivo credentials" '0 ausente' \
  "$(manager_file_count 'credential_process|aws_access_key_id|aws_secret_access_key|external_id' /root/.aws/config) $(
    docker exec "$manager" test -e /root/.aws/credentials && echo presente || echo ausente)"
# O provedor só é montado: a credencial seria buscada na primeira chamada (e, sem o token, nem isso).
expect "o boto3 do manager entra no papel pelo provedor de web identity" assume-role-with-web-identity \
  "$(docker exec "$manager" /var/ossec/framework/python/bin/python3 -c \
    'import boto3; print(boto3.Session(profile_name="verax-111122223333").get_credentials().method)' 2>/dev/null || true)"
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
expect "regras críticas da AWS instaladas como no repositório" \
  "$(sha256sum <config/manager/rules/verax_aws_critical_rules.xml | cut -c1-64)" \
  "$(docker exec "$manager" sha256sum /var/ossec/etc/rules/verax_aws_critical_rules.xml | cut -c1-64)"
expect "regras do papel de leitura com o IP do nó (as duas do próprio nó e as duas de fora dele)" 4 \
  "$(manager_file_count '203\\.0\\.113\\.10' /var/ossec/etc/rules/verax_reader_rules.xml)"
expect "analysisd carregou as regras" 0 "$(manager_file_count 'Error loading the rules' /var/ossec/logs/ossec.log)"
expect "analysisd rodando como wazuh" wazuh "$(docker exec "$manager" ps -o user= -C wazuh-analysisd | head -n 1 | tr -d ' ')"

echo "== Retenção e backup"
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
  expect "$service: 60 s para parar antes do SIGKILL" 60 "$(docker inspect --format '{{.Config.StopTimeout}}' "$id")"
  # Para calibrar os limites no ensaio: o uso agora, sem carga.
  docker stats --no-stream --format "       uso de $service: {{.MemUsage}}, CPU {{.CPUPerc}}, {{.PIDs}} processos" "$id"
done
indexer_admin GET '/_nodes/_local/process?filter_path=nodes.*.process.mlockall' </dev/null
expect "indexer com o heap travado na memória" '"mlockall":true' "$(match_count '"mlockall":(true|false)')"
expect "indexer só nas redes internas (manager de um lado, API e worker do outro)" \
  "${project}_wazuh ${project}_wazuh-read " "$(networks_of "$indexer")"
for network in wazuh wazuh-read; do
  expect "rede $network sem saída" true "$(docker network inspect --format '{{.Internal}}' "${project}_$network")"
done
expect "indexer sem rota para fora" 0 "$(docker exec "$indexer" awk '$2 == "00000000"' /proc/net/route | wc -l)"
expect "manager nas redes interna e de saída, fora da rede do banco e da rede da API" \
  "${project}_wazuh ${project}_wazuh-egress " "$(networks_of "$manager")"
# O manager não chega à rede da API (wazuh-read): o Docker isola uma rede bridge da outra, e o único caminho dele
# para fora é a wazuh-egress. Sem isso, um manager comprometido falaria com a API por dentro, fora do Cloudflare.
expect "manager não alcança a rede da API (indexer pelo endereço da wazuh-read)" 000 \
  "$(docker exec "$manager" curl -s -m 3 -o /dev/null -w '%{http_code}' -k "https://$indexer_ip:9200/" || true)"
expect "manager alcança o indexer pela rede dele (wazuh)" 401 \
  "$(docker exec "$manager" curl -s -m 3 -o /dev/null -w '%{http_code}' -k "https://$(indexer_ip_of "${project}_wazuh"):9200/" || true)"
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
# Os volumes persistentes que guardam código da imagem (permanent_data.env dela): wodles, integrations,
# active-response/bin e agentless. Para cada um, o que a imagem traz: a base (copiada na primeira partida) e a lista
# que o init copia a cada partida, que vale por cima. Cada arquivo tem de estar no volume igual ao da imagem; os que
# sobram da versão anterior não importam, e os arquivos de estado (os bancos *.db dos wodles) são do volume.
files_of_image() { # <imagem> <diretório sob /var/ossec>
  # shellcheck disable=SC2016 # expandido pelo sh do contêiner
  docker run --rm --entrypoint sh "$1" -c 'for base in permanent exclusion; do
      dir="/var/ossec/data_tmp/$base/var/ossec/$1"
      [ -d "$dir" ] && cd "$dir" && find . -type f ! -path "*/__pycache__/*" -exec sha256sum {} +
    done; true' sh "$2" |
    awk '{ hash[$2] = $1 } END { for (file in hash) print hash[file], file }' | sort
}
for dir in wodles integrations active-response/bin agentless; do
  expected=$(files_of_image "$current_image" "$dir")
  # shellcheck disable=SC2016 # expandido pelo sh do contêiner
  installed=$(docker exec "$manager" sh -c \
    'cd "/var/ossec/$1" && find . -type f ! -name "*.db" ! -path "*/__pycache__/*" -exec sha256sum {} +' sh "$dir" |
    awk '{ print $1, $2 }' | sort)
  hidden=$(comm -23 <(echo "$expected") <(echo "$installed"))
  expect "$dir: código igual ao da imagem nova (nada escondido pelo volume)" 0 "$(grep -c . <<<"$hidden" || true)"
  if [[ -n $hidden ]]; then
    while read -r line; do echo "       diferente ou ausente no volume: $line"; done <<<"$hidden"
  fi
  # Sem nenhum arquivo diferente entre as duas versões, o teste acima não prova nada: fica registrado.
  changed=$(comm -23 <(echo "$expected") <(files_of_image "$UPGRADE_FROM" "$dir") | grep -c . || true)
  echo "       $dir: $changed arquivo(s) mudaram de $old_version para $new_version"
done

if ((failures > 0)); then
  echo "$failures verificação(ões) falharam." >&2
  exit 1
fi
echo "Teste de ponta a ponta do Wazuh do nó passou."
