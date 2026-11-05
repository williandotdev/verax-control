#!/usr/bin/env bash
# Testa as regras locais da AWS no wazuh-logtest de um manager avulso, sem indexer e sem rede, na mesma imagem da
# compose. Usado no CI (iac.yml) e localmente; precisa só de Docker. Os arquivos entram no contêiner por `docker cp`.
#
# Correlações por conta (config/manager/rules/verax_aws_rules.xml). Um Wazuh atende todos os clientes, então eventos
# de contas diferentes não podem somar numa correlação:
# 1. logins com falha (80255), objetos apagados (80252) e bloqueios do WAF (80443) divididos entre duas contas não
#    disparam a correlação; completando o limite numa conta só, ela dispara com a conta certa;
# 2. a correlação genérica de falhas de autenticação (40111) não pega eventos da AWS;
# 3. guarda de versão: toda regra de frequência dos arquivos da AWS do Wazuh está tratada aqui ou é de uma fonte que
#    a Verax não coleta. Uma versão nova com outra correlação derruba o teste até ela ser avaliada.
#
# Papel de leitura (verax_reader_rules.xml, que o render-manager-config.py gera do modelo com o IP de saída do nó; fase
# 2, PR-V4'), com os eventos como o módulo aws-s3 os entrega:
# 4. a leitura do próprio nó e a entrada dele no papel, vindas do IP do nó: nível 0 (100200 e 100201), também quando o
#    evento desce pela cadeia de erro do Wazuh (80202, 80203, 80250); uma escrita da própria sessão não é silenciada;
# 5. a mesma sessão ou a entrada no papel de outro IP: nível 12 com MITRE T1078.004 (100202 e 100203), também acima da
#    regra de alteração do papel; uma chamada que um serviço da AWS faz em nome da sessão (origem sem IP) não;
# 6. alterar o papel ou as políticas da pilha: nível 5 (100204 e 100205); outro papel ou outra política, não;
# 7. sem o IP do nó, só as regras de alteração (nenhuma leitura do nó vira nível 12);
# 8. guarda de versão: as mães das regras do papel são a cadeia do CloudTrail do Wazuh, nem mais nem menos.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=$(grep -m1 -oE 'wazuh/wazuh-manager:[^[:space:]]+' docker-compose.yml)
NAME="verax-rules-test-$$"
RENDER="verax-rules-render-$$"
ACCOUNT_A=111122223333
ACCOUNT_B=444455556666
ATTACKER_IP=203.0.113.50
# IPs de saída do nó (RFC 5737), como o NODE_EGRESS_IPS do node.conf.
NODE_IP=203.0.113.10
NODE_IP_2=198.51.100.20

# Correlações dos arquivos da AWS do Wazuh e o motivo de cada uma estar resolvida.
declare -A KNOWN_FREQUENCY_RULES=(
  [80252]="separada por conta em verax_aws_rules.xml"
  [80255]="separada por conta em verax_aws_rules.xml"
  [80443]="separada por Web ACL em verax_aws_rules.xml"
  [80369]="logs de acesso do S3: fonte não coletada (render-manager-config.py)"
  [80371]="logs de acesso do S3: fonte não coletada (render-manager-config.py)"
  [99021]="Amazon Security Lake: fonte não coletada"
  [99027]="Amazon Security Lake: fonte não coletada"
)
AWS_RULE_FILES=(0350-amazon_rules.xml 0990-amazon-security-lake_rules.xml 0998-aws-security-hub-rules.xml)

failures=0
expect() { # <descrição> <esperado> <obtido>
  if [[ $2 == "$3" ]]; then
    printf 'ok     %s\n' "$1"
  else
    printf 'FALHA  %s\n       esperado: %s\n       obtido:   %s\n' "$1" "$2" "$3"
    failures=$((failures + 1))
  fi
}

work=$(mktemp -d)
cleanup() {
  docker rm -f "$NAME" "$RENDER" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# --- eventos como o módulo aws-s3 os entrega ao analysisd ---

login_failure() { # <conta>
  printf '{"integration":"aws","aws":{"log_info":{"aws_account_alias":"","log_file":"AWSLogs/%s/CloudTrail/sa-east-1/2026/11/01/t.json.gz","s3bucket":"trilha-%s"},"eventVersion":"1.08","userIdentity":{"type":"IAMUser","accountId":"%s","userName":"usuario"},"eventTime":"2026-11-01T10:00:00Z","eventSource":"signin.amazonaws.com","eventName":"ConsoleLogin","awsRegion":"us-east-1","sourceIPAddress":"%s","responseElements":{"ConsoleLogin":"Failure"},"eventType":"AwsConsoleSignIn","recipientAccountId":"%s","source":"cloudtrail","aws_account_id":"%s"}}\n' \
    "$1" "$1" "$1" "$ATTACKER_IP" "$1" "$1"
}

delete_objects() { # <conta>
  printf '{"integration":"aws","aws":{"log_info":{"aws_account_alias":"","log_file":"AWSLogs/%s/CloudTrail/sa-east-1/2026/11/01/t.json.gz","s3bucket":"trilha-%s"},"eventVersion":"1.08","userIdentity":{"type":"IAMUser","accountId":"%s","userName":"usuario"},"eventTime":"2026-11-01T10:00:00Z","eventSource":"s3.amazonaws.com","eventName":"DeleteObjects","awsRegion":"sa-east-1","sourceIPAddress":"%s","requestParameters":{"bucketName":"dados-%s"},"eventType":"AwsApiCall","recipientAccountId":"%s","source":"cloudtrail","aws_account_id":"%s"}}\n' \
    "$1" "$1" "$1" "$ATTACKER_IP" "$1" "$1" "$1"
}

waf_block() { # <conta>
  printf '{"integration":"aws","aws":{"log_info":{"aws_account_alias":"","log_file":"waf/2026/11/01/w.gz","s3bucket":"aws-waf-logs-%s"},"timestamp":1793527200000,"formatVersion":1,"webaclId":"arn:aws:wafv2:sa-east-1:%s:regional/webacl/painel/0000","terminatingRuleId":"AWS-AWSManagedRulesCommonRuleSet","terminatingRuleType":"MANAGED_RULE_GROUP","action":"BLOCK","httpSourceName":"ALB","httpRequest":{"clientIp":"%s","country":"BR","headers":{"Host":"app.exemplo"},"uri":"/login","args":"","httpVersion":"HTTP/1.1","httpMethod":"POST","requestId":"1-0000"},"source":"waf"}}\n' \
    "$1" "$1" "$ATTACKER_IP"
}

repeat() { # <n> <gerador> <conta>
  local i
  for ((i = 0; i < $1; i++)); do "$2" "$3"; done
}

# Cada execução do wazuh-logtest é uma sessão própria: as correlações valem só dentro dela. Imprime, por evento,
# "<regra> <conta>" (a conta vem de aws.aws_account_id ou do ARN da Web ACL).
logtest() {
  docker exec -i "$NAME" /var/ossec/bin/wazuh-logtest 2>&1 | awk '
    function flush() { if (rule != "") print rule, account; rule = ""; account = "-" }
    /\*\*Phase 1:/ { flush() }
    /^[[:space:]]+aws\.aws_account_id: / { account = $2 }
    /^[[:space:]]+aws\.webaclId: / { split($2, arn, ":"); account = arn[5] }
    /^[[:space:]]+id: / { rule = $2 }
    END { flush() }' | tr -d "'"
}

fired() { # <regra> <saída do logtest>: contas em que a regra disparou, em ordem
  awk -v rule="$1" '$1 == rule { print $2 }' <<<"$2" | paste -sd' ' -
}

# As regras como o gerador as escreve para o manager, com o IP de saída do nó dado (vazio: sem a variável no node.conf).
mkdir -p "$work/render-in/verax"
cp scripts/render-manager-config.py config/manager/ossec.conf "$work/render-in/verax/"
cp -R config/manager/rules "$work/render-in/verax/"
render_rules() { # <VERAX_NODE_EGRESS_IPS> <pasta de saída>
  docker rm -f "$RENDER" >/dev/null 2>&1 || true
  docker create --name "$RENDER" -i --network none -e "VERAX_NODE_EGRESS_IPS=$1" \
    --entrypoint /var/ossec/framework/python/bin/python3 "$IMAGE" \
    /verax/render-manager-config.py /verax/ossec.conf /out/config /out/aws /verax/rules >/dev/null
  docker cp "$work/render-in/verax" "$RENDER:/verax"
  echo '[]' | docker start -ai "$RENDER" >/dev/null
  docker cp "$RENDER:/out/config/etc/rules" "$2"
}
render_rules "$NODE_IP/32,$NODE_IP_2/32" "$work/rules"
render_rules '' "$work/rules-sem-ip"

echo "== Manager avulso ($IMAGE)"
docker create --name "$NAME" --network none "$IMAGE" >/dev/null
docker cp "$work/rules/verax_aws_rules.xml" "$NAME:/var/ossec/etc/rules/verax_aws_rules.xml"
docker cp "$work/rules/verax_reader_rules.xml" "$NAME:/var/ossec/etc/rules/verax_reader_rules.xml"
docker start "$NAME" >/dev/null
for _ in $(seq 1 90); do
  docker exec "$NAME" test -S /var/ossec/queue/sockets/logtest 2>/dev/null && break
  sleep 2
done
docker exec "$NAME" test -S /var/ossec/queue/sockets/logtest || {
  echo "O wazuh-logtest não ficou disponível." >&2
  docker logs --tail 50 "$NAME" >&2
  exit 1
}

echo "== Logins com falha no console (80255: 6 em 360 s)"
out=$({ repeat 3 login_failure $ACCOUNT_A; repeat 3 login_failure $ACCOUNT_B; } | logtest)
expect "3 + 3 em contas diferentes: sem correlação" "" "$(fired 80255 "$out")"
expect "cada evento é uma falha de login (80254)" 6 "$(awk '$1 == 80254' <<<"$out" | wc -l | tr -d ' ')"
expect "a correlação genérica (40111) não pega eventos da AWS" "" "$(fired 40111 "$out")"
out=$({ repeat 3 login_failure $ACCOUNT_A; repeat 3 login_failure $ACCOUNT_B; repeat 3 login_failure $ACCOUNT_A; } | logtest)
expect "6 na mesma conta: correlação na conta A" "$ACCOUNT_A" "$(fired 80255 "$out")"

echo "== Objetos apagados no S3 (80252: 22 em 600 s)"
out=$({ repeat 11 delete_objects $ACCOUNT_A; repeat 11 delete_objects $ACCOUNT_B; } | logtest)
expect "11 + 11 em contas diferentes: sem correlação" "" "$(fired 80252 "$out")"
# A 80251 descende da 80202, que só aceita eventos da lista aws-eventnames. Sem o DeleteObjects na lista (caso do
# 4.14.9), a correlação não dispara em conta nenhuma; a sobrescrita vale quando uma versão nova o incluir.
if docker exec "$NAME" grep -q '^DeleteObjects:' /var/ossec/etc/lists/amazon/aws-eventnames; then
  expect "cada evento é um DeleteObjects (80251)" 22 "$(awk '$1 == 80251' <<<"$out" | wc -l | tr -d ' ')"
  out=$({ repeat 11 delete_objects $ACCOUNT_B; repeat 11 delete_objects $ACCOUNT_A; repeat 11 delete_objects $ACCOUNT_B; } | logtest)
  expect "22 na mesma conta: correlação na conta B" "$ACCOUNT_B" "$(fired 80252 "$out")"
else
  expect "DeleteObjects fora da lista aws-eventnames: 80251 inalcançável" 0 "$(awk '$1 == 80251' <<<"$out" | wc -l | tr -d ' ')"
fi

echo "== Bloqueios do WAF do mesmo IP (80443: 8 em 120 s)"
out=$({ repeat 4 waf_block $ACCOUNT_A; repeat 4 waf_block $ACCOUNT_B; } | logtest)
expect "4 + 4 em Web ACLs de contas diferentes: sem correlação" "" "$(fired 80443 "$out")"
expect "cada evento é um bloqueio (80442)" 8 "$(awk '$1 == 80442' <<<"$out" | wc -l | tr -d ' ')"
out=$({ repeat 4 waf_block $ACCOUNT_A; repeat 4 waf_block $ACCOUNT_B; repeat 4 waf_block $ACCOUNT_A; } | logtest)
expect "8 na mesma Web ACL: correlação na conta A" "$ACCOUNT_A" "$(fired 80443 "$out")"

echo "== Guarda de versão: correlações nos arquivos da AWS do Wazuh"
found=$(docker exec "$NAME" sh -c "cd /var/ossec/ruleset/rules && cat ${AWS_RULE_FILES[*]}" |
  grep -oE '<rule id="[0-9]+"[^>]*frequency=' | sed -E 's/^<rule id="([0-9]+)".*/\1/' | sort -u | paste -sd' ' -)
known=$(printf '%s\n' "${!KNOWN_FREQUENCY_RULES[@]}" | sort -u | paste -sd' ' -)
expect "toda correlação da AWS foi avaliada" "$known" "$found"

# --- papel de leitura (verax_reader_rules.xml) ---

# Quem chama, como o CloudTrail registra: a sessão do papel (o nó, ou quem tiver a credencial dela), a mesma sessão
# por um serviço da AWS (o KMS chamado pelo S3), a entrada no papel com o token do Google e um usuário do cliente.
CUSTOMER_IP=198.51.100.77
ROLE_ARN="arn:aws:iam::$ACCOUNT_A:role/verax/verax-control-reader"
identity() { # <sessao|servico|web|usuario>
  local session="\"type\":\"AssumedRole\",\"principalId\":\"EXEMPLOPRINCIPAL:verax-control-wazuh\",\"arn\":\"arn:aws:sts::$ACCOUNT_A:assumed-role/verax-control-reader/verax-control-wazuh\",\"accountId\":\"$ACCOUNT_A\",\"sessionContext\":{\"sessionIssuer\":{\"type\":\"Role\",\"arn\":\"$ROLE_ARN\",\"userName\":\"verax-control-reader\"}}"
  case $1 in
    sessao) printf '{%s}' "$session" ;;
    servico) printf '{%s,"invokedBy":"s3.amazonaws.com"}' "$session" ;;
    web) printf '{"type":"WebIdentityUser","principalId":"accounts.google.com:123456789012345678901:123456789012345678901","userName":"123456789012345678901","identityProvider":"accounts.google.com"}' ;;
    usuario) printf '{"type":"IAMUser","accountId":"%s","userName":"admin-do-cliente","arn":"arn:aws:iam::%s:user/admin-do-cliente"}' "$ACCOUNT_A" "$ACCOUNT_A" ;;
  esac
}
reader_event() { # <identidade> <origem> <eventSource> <eventName> <requestParameters> [errorCode]
  local error=''
  if [[ -n ${6:-} ]]; then error=",\"errorCode\":\"$6\",\"errorMessage\":\"negado\""; fi
  printf '{"integration":"aws","aws":{"log_info":{"aws_account_alias":"","log_file":"AWSLogs/%s/CloudTrail/sa-east-1/2026/11/01/t.json.gz","s3bucket":"trilha-%s"},"eventVersion":"1.08","userIdentity":%s,"eventTime":"2026-11-01T10:00:00Z","eventSource":"%s","eventName":"%s","awsRegion":"sa-east-1","sourceIPAddress":"%s","requestParameters":%s%s,"eventType":"AwsApiCall","recipientAccountId":"%s","source":"cloudtrail","aws_account_id":"%s"}}\n' \
    "$ACCOUNT_A" "$ACCOUNT_A" "$(identity "$1")" "$3" "$4" "$2" "$5" "$error" "$ACCOUNT_A" "$ACCOUNT_A"
}
assume='{"roleArn":"'"$ROLE_ARN"'","roleSessionName":"verax-control-wazuh"}'
role='{"roleName":"verax-control-reader"}'

# Por evento, "<regra> <nível> <MITRE>" (- sem MITRE).
logtest_levels() {
  docker exec -i "$NAME" /var/ossec/bin/wazuh-logtest 2>&1 | awk '
    function flush() { if (rule != "") print rule, level, (mitre == "" ? "-" : mitre); rule = ""; level = ""; mitre = "" }
    /\*\*Phase 1:/ { flush() }
    /^[[:space:]]+id: / { rule = $2 }
    /^[[:space:]]+level: / { level = $2 }
    /^[[:space:]]+mitre\.id: / { mitre = $2 }
    END { flush() }' | tr -d "'[]"
}

# <descrição> <resultado esperado> <evento>: os eventos vão juntos para uma sessão do logtest, na ordem.
cases=()
check() { cases+=("$1|$2|$3"); }
run_cases() {
  local out index=0 entry
  out=$(for entry in "${cases[@]}"; do printf '%s\n' "${entry##*|}"; done | logtest_levels)
  for entry in "${cases[@]}"; do
    index=$((index + 1))
    IFS='|' read -r description expected _ <<<"$entry"
    expect "$description" "$expected" "$(sed -n "${index}p" <<<"$out")"
  done
  cases=()
}

echo "== Papel de leitura: o nó, de dentro e de fora do IP dele, e as alterações do papel (100200 a 100205)"
check "leitura do nó pelo IP dele: nível 0" '100200 0 -' "$(reader_event sessao "$NODE_IP" s3.amazonaws.com GetObject '{"bucketName":"trilha"}')"
check "leitura do nó pelo segundo IP dele: nível 0" '100200 0 -' "$(reader_event sessao "$NODE_IP_2" s3.amazonaws.com ListObjects '{"bucketName":"trilha"}')"
check "leitura negada do nó, pela cadeia de erro do Wazuh (80250): nível 0" '100200 0 -' \
  "$(reader_event sessao "$NODE_IP" iam.amazonaws.com ListUsers '{}' AccessDenied)"
check "o nó entra no papel com o token, pelo IP dele: nível 0" '100201 0 -' \
  "$(reader_event web "$NODE_IP" sts.amazonaws.com AssumeRoleWithWebIdentity "$assume")"
check "a sessão do nó usada de outro IP: nível 12, T1078.004" '100202 12 T1078.004' \
  "$(reader_event sessao "$ATTACKER_IP" s3.amazonaws.com GetObject '{"bucketName":"trilha"}')"
check "o token do nó usado de outro IP (recusado pela confiança): nível 12, T1078.004" '100203 12 T1078.004' \
  "$(reader_event web "$ATTACKER_IP" sts.amazonaws.com AssumeRoleWithWebIdentity "$assume" AccessDenied)"
check "a sessão alterando o papel de outro IP: o nível 12 vale sobre o de alteração" '100202 12 T1078.004' \
  "$(reader_event sessao "$ATTACKER_IP" iam.amazonaws.com DeleteRole "$role" AccessDenied)"
check "um serviço da AWS em nome da sessão (origem sem IP): não é nível 12" '80200 0 -' \
  "$(reader_event servico s3.amazonaws.com kms.amazonaws.com Decrypt '{}')"
check "escrita da própria sessão pelo IP do nó (negada): não é silenciada" '100204 5 -' \
  "$(reader_event sessao "$NODE_IP" iam.amazonaws.com UpdateAssumeRolePolicy "$role" AccessDenied)"
check "o cliente troca a confiança do papel: nível 5" '100204 5 -' \
  "$(reader_event usuario "$CUSTOMER_IP" iam.amazonaws.com UpdateAssumeRolePolicy "$role")"
check "o cliente troca o limite de permissões do papel: nível 5" '100204 5 -' \
  "$(reader_event usuario "$CUSTOMER_IP" iam.amazonaws.com PutRolePermissionsBoundary "$role")"
check "o cliente muda a política de negação da pilha: nível 5" '100205 5 -' \
  "$(reader_event usuario "$CUSTOMER_IP" iam.amazonaws.com CreatePolicyVersion \
    '{"policyArn":"arn:aws:iam::'"$ACCOUNT_A"':policy/verax/VeraxControlGuardrails"}')"
check "o cliente troca a confiança de outro papel: fora das regras do papel" '80202 3 -' \
  "$(reader_event usuario "$CUSTOMER_IP" iam.amazonaws.com UpdateAssumeRolePolicy '{"roleName":"outro-papel"}')"
run_cases

echo "== Papel de leitura sem o IP do nó no node.conf: só as regras de alteração"
docker cp "$work/rules-sem-ip/verax_reader_rules.xml" "$NAME:/var/ossec/etc/rules/verax_reader_rules.xml"
check "leitura do nó: fora das regras do papel" '80200 0 -' \
  "$(reader_event sessao "$NODE_IP" s3.amazonaws.com GetObject '{"bucketName":"trilha"}')"
check "a sessão de outro IP: sem o IP do nó, nenhum nível 12" '80200 0 -' \
  "$(reader_event sessao "$ATTACKER_IP" s3.amazonaws.com GetObject '{"bucketName":"trilha"}')"
check "a alteração do papel continua" '100204 5 -' \
  "$(reader_event usuario "$CUSTOMER_IP" iam.amazonaws.com UpdateAssumeRolePolicy "$role")"
run_cases

echo "== Guarda de versão: as mães das regras do papel são a cadeia do CloudTrail do Wazuh"
# As regras da cadeia (as de grupo aws_cloudtrail, sem as de frequência) e as mães declaradas no modelo, menos a base
# do módulo (80200). Uma versão nova do Wazuh com outra regra nessa cadeia derruba o teste até o modelo ser revisto.
chain=$(docker exec "$NAME" cat /var/ossec/ruleset/rules/0350-amazon_rules.xml | awk '
  /<rule id=/ { match($0, /id="[0-9]+"/); id = substr($0, RSTART + 4, RLENGTH - 5); frequency = ($0 ~ /frequency=/) }
  /<group>.*aws_cloudtrail/ && !frequency { print id }' | sort -u | paste -sd' ' -)
template=config/manager/rules/verax_reader_rules.xml.tmpl
parents=$(grep -oE '<if_sid>[^<]+' "$template" | sort -u)
expect "as seis regras com as mesmas mães" '6 1' "$(grep -c '<if_sid>' "$template") $(grep -c . <<<"$parents")"
expect "as mães são a base do módulo e a cadeia do CloudTrail" "$chain" \
  "$(tr ',' '\n' <<<"${parents//<if_sid>/}" | tr -d ' ' | grep -vx 80200 | sort -u | paste -sd' ' -)"

if ((failures > 0)); then
  echo "$failures verificação(ões) falharam."
  exit 1
fi
echo "Correlações da AWS separadas por conta e regras do papel de leitura no nível certo."
