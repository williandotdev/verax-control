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
#
# Regras críticas da AWS (verax_aws_critical_rules.xml, 100300 a 100324; fase 2, PR-V7), com os eventos no formato do
# json.dumps do módulo:
# 9. cada regra, com o caso que casa e os que não casam (outro valor, a tentativa negada, outro serviço com o mesmo
#    nome de evento), o nível e o MITRE; a regra de nível mais alto vale sobre a genérica (root) e sobre a do papel;
# 10. grupo de segurança: as portas de administração e de banco, cada uma com os vizinhos e uma faixa que a inclui;
# 11. o papel de leitura do nó não gera ruído: as leituras dele seguem no nível 0 (100200), e a escrita dele que de
#     fato aconteça não é silenciada;
# 12. guarda de versão: as regras críticas são filhas da mesma cadeia das do papel ou de outra regra crítica, e nenhum
#     padrão passa do tamanho que o XML do Wazuh aceita.
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
# Todas as regras locais, como o gerador as instala.
for rules_file in "$work"/rules/*.xml; do
  docker cp "$rules_file" "$NAME:/var/ossec/etc/rules/${rules_file##*/}"
done
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

# Por evento, "<regra> <nível> <MITRE>" (- sem MITRE; mais de uma técnica separadas por vírgula, sem espaço).
logtest_levels() {
  docker exec -i "$NAME" /var/ossec/bin/wazuh-logtest 2>&1 | awk '
    function flush() { if (rule != "") print rule, level, (mitre == "" ? "-" : mitre); rule = ""; level = ""; mitre = "" }
    /\*\*Phase 1:/ { flush() }
    /^[[:space:]]+id: / { rule = $2 }
    /^[[:space:]]+level: / { level = $2 }
    /^[[:space:]]+mitre\.id: / { mitre = substr($0, index($0, ": ") + 2); gsub(/ /, "", mitre) }
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

# --- regras críticas da AWS (verax_aws_critical_rules.xml) ---

# Os eventos como o módulo os entrega ao analysisd: o json.dumps do wodle (", " e ": "), as listas de um item já como o
# próprio item e o requestParameters ou o responseElements nulo como {"string": "None"}. Quem age (WHO), a origem
# (FROM), o erro (ERROR), outros campos (EXTRA) e o readOnly (READ_ONLY) vêm por variável, só na chamada.
NONE='{"string": "None"}'
critical_identity() { # <root|root-servico|usuario|sso|sessao>
  local root="\"type\": \"Root\", \"principalId\": \"$ACCOUNT_A\", \"arn\": \"arn:aws:iam::$ACCOUNT_A:root\", \"accountId\": \"$ACCOUNT_A\""
  case $1 in
    root) printf '{%s}' "$root" ;;
    root-servico) printf '{%s, "invokedBy": "support.amazonaws.com"}' "$root" ;;
    usuario) printf '{"type": "IAMUser", "principalId": "EXEMPLOPRINCIPAL", "arn": "arn:aws:iam::%s:user/dev", "accountId": "%s", "userName": "dev"}' \
      "$ACCOUNT_A" "$ACCOUNT_A" ;;
    sso) printf '{"type": "AssumedRole", "principalId": "EXEMPLOPRINCIPAL:dev", "arn": "arn:aws:sts::%s:assumed-role/AWSReservedSSO_Admin_0000000000000000/dev", "accountId": "%s"}' \
      "$ACCOUNT_A" "$ACCOUNT_A" ;;
    *) identity "$1" ;;
  esac
}
ct() { # <eventSource> <eventName> <requestParameters> [responseElements]
  local error=''
  if [[ -n ${ERROR:-} ]]; then error=", \"errorCode\": \"$ERROR\", \"errorMessage\": \"negado\""; fi
  printf '{"integration": "aws", "aws": {"log_info": {"aws_account_alias": "", "log_file": "AWSLogs/%s/CloudTrail/sa-east-1/2026/11/01/t.json.gz", "s3bucket": "trilha-%s"}, "eventVersion": "1.09", "userIdentity": %s, "eventTime": "2026-11-01T10:00:00Z", "eventSource": "%s", "eventName": "%s", "awsRegion": "sa-east-1", "sourceIPAddress": "%s", "userAgent": "aws-cli/2.17.0"%s%s, "requestParameters": %s, "responseElements": %s, "readOnly": %s, "eventType": "AwsApiCall", "managementEvent": true, "recipientAccountId": "%s", "source": "cloudtrail", "aws_account_id": "%s"}}\n' \
    "$ACCOUNT_A" "$ACCOUNT_A" "$(critical_identity "${WHO:-usuario}")" "$1" "$2" "${FROM:-$CUSTOMER_IP}" "$error" "${EXTRA:-}" \
    "$3" "${4:-$NONE}" "${READ_ONLY:-false}" "$ACCOUNT_A" "$ACCOUNT_A"
}
# Texto como valor JSON: a política vem como texto no CloudTrail (policyDocument), com aspas e quebras escapadas.
json_text() {
  local text=${1//\\/\\\\}
  text=${text//\"/\\\"}
  printf '"%s"' "${text//$'\n'/\\n}"
}
login() { # <identidade> <Success|Failure> <MFAUsed>
  WHO=$1 EXTRA=", \"additionalEventData\": {\"LoginTo\": \"https://console.aws.amazon.com/console/home\", \"MobileVersion\": \"No\", \"MFAUsed\": \"$3\"}" \
    ct signin.amazonaws.com ConsoleLogin "$NONE" "{\"ConsoleLogin\": \"$2\"}"
}
iam_policy() { # <eventName> <política> [outros campos do pedido]
  ct iam.amazonaws.com "$1" "{\"userName\": \"dev\", \"roleName\": \"app\", \"groupName\": \"devs\", \"policyName\": \"inline\"${3:-}, \"policyDocument\": $(json_text "$2")}"
}
trust() { # <eventName> <papel> <confiança>
  local field=policyDocument
  if [[ $1 == CreateRole ]]; then field=assumeRolePolicyDocument; fi
  ct iam.amazonaws.com "$1" "{\"roleName\": \"$2\", \"$field\": $(json_text "$3")}"
}
statement() { # <declarações, separadas por vírgula>
  printf '{\n  "Version": "2012-10-17",\n  "Statement": [%s]\n}' "$1"
}
bucket_policy() { # <declarações>: a política do bucket vem como objeto (uma declaração só já vira o objeto dela)
  ct s3.amazonaws.com PutBucketPolicy "{\"bucketPolicy\": {\"Version\": \"2012-10-17\", \"Statement\": $1}, \"bucketName\": \"dados\", \"Host\": \"dados.s3.amazonaws.com\", \"policy\": \"\"}"
}
sg_item() { # <protocolo> <de> <até> <faixa>: o item do pedido do AuthorizeSecurityGroupIngress
  printf '{"ipProtocol": "%s", "fromPort": %s, "toPort": %s, "groups": {}, "ipRanges": {"items": {"cidrIp": "%s"}}, "ipv6Ranges": {}, "prefixListIds": {}}' "$@"
}
sg_ingress() { # <itens> [resposta]
  ct ec2.amazonaws.com AuthorizeSecurityGroupIngress "{\"groupId\": \"sg-0exemplo\", \"ipPermissions\": {\"items\": $1}}" "${2:-}"
}
sg_open() { sg_ingress "$(sg_item tcp "$1" "$2" 0.0.0.0/0)"; } # <de> <até>: TCP aberto para a internet
sg_modify() { # <regra>: a regra do ModifySecurityGroupRules, com as chaves com maiúscula
  ct ec2.amazonaws.com ModifySecurityGroupRules "{\"ModifySecurityGroupRulesRequest\": {\"GroupId\": \"sg-0exemplo\", \"SecurityGroupRule\": {\"SecurityGroupRuleId\": \"sgr-0exemplo\", \"SecurityGroupRule\": $1, \"tag\": 1}}}"
}

echo "== Regras críticas: login no console e conta root (100300 a 100304 e 100324)"
check "root no console sem MFA: nível 12" '100301 12 T1078.004' "$(login root Success No)"
check "root no console com MFA: nível 10" '100300 10 T1078.004' "$(login root Success Yes)"
check "login da root com falha: a regra do Wazuh (80254)" '80254 5 -' "$(login root Failure No)"
check "usuário IAM no console sem MFA: nível 8" '100302 8 T1078.004' "$(login usuario Success No)"
check "usuário IAM no console com MFA: a regra do Wazuh" '80253 3 T1078' "$(login usuario Success Yes)"
check "login pelo SSO (AssumedRole) sem o MFA da AWS: fora" '80253 3 T1078' "$(login sso Success No)"
check "a root cria a própria chave de acesso: nível 12" '100303 12 T1098.001' "$(WHO=root ct iam.amazonaws.com CreateAccessKey "$NONE")"
check "a root cria a chave de um usuário IAM: nível 10" '100304 10 T1098.001' \
  "$(WHO=root ct iam.amazonaws.com CreateAccessKey '{"userName": "dev"}')"
check "a root tenta criar a chave e é negada: fica com o Wazuh" '80250 5 -' \
  "$(WHO=root ERROR=AccessDenied ct iam.amazonaws.com CreateAccessKey "$NONE")"
check "um serviço da AWS em nome da root (invokedBy): fora" '80202 3 -' \
  "$(WHO=root-servico ct iam.amazonaws.com CreateAccessKey "$NONE")"
check "usuário IAM cria a própria chave: fora" '80202 3 -' "$(ct iam.amazonaws.com CreateAccessKey "$NONE")"
check "a root altera a conta (cria um usuário): nível 10" '100324 10 T1078.004' \
  "$(WHO=root ct iam.amazonaws.com CreateUser '{"userName": "novo"}')"
check "a root só lê (readOnly true): fora" '80202 3 -' "$(WHO=root READ_ONLY=true ct iam.amazonaws.com ListUsers '{}')"
check "um serviço da AWS em nome da root altera a conta: fora" '80202 3 -' \
  "$(WHO=root-servico ct iam.amazonaws.com CreateUser '{"userName": "novo"}')"
check "a root para o CloudTrail: a regra específica (12) vale sobre a da root (10)" '100310 12 T1562.008' \
  "$(WHO=root ct cloudtrail.amazonaws.com StopLogging '{"name": "trilha"}')"
run_cases

echo "== Regras críticas: permissão de administrador e papel que qualquer conta assume (100305 a 100309)"
admin=$(statement '{"Effect": "Allow", "Action": "*", "Resource": "*"}')
check "AdministratorAccess anexada a um usuário: nível 12" '100305 12 T1098.003' \
  "$(ct iam.amazonaws.com AttachUserPolicy '{"userName": "dev", "policyArn": "arn:aws:iam::aws:policy/AdministratorAccess"}')"
check "IAMFullAccess anexada a um papel: nível 12" '100305 12 T1098.003' \
  "$(ct iam.amazonaws.com AttachRolePolicy '{"roleName": "app", "policyArn": "arn:aws:iam::aws:policy/IAMFullAccess"}')"
check "ReadOnlyAccess anexada a um grupo: fora" '80202 3 -' \
  "$(ct iam.amazonaws.com AttachGroupPolicy '{"groupName": "devs", "policyArn": "arn:aws:iam::aws:policy/ReadOnlyAccess"}')"
check "política do cliente com o nome AdministratorAccess (não é a da AWS): fora" '80202 3 -' \
  "$(ct iam.amazonaws.com AttachUserPolicy '{"userName": "dev", "policyArn": "arn:aws:iam::'"$ACCOUNT_A"':policy/AdministratorAccess"}')"
check "anexar a AdministratorAccess, negado: fica com o Wazuh" '80250 5 -' \
  "$(ERROR=AccessDenied ct iam.amazonaws.com AttachUserPolicy '{"userName": "dev", "policyArn": "arn:aws:iam::aws:policy/AdministratorAccess"}')"
check "política do usuário com Action e Resource \"*\": nível 12" '100306 12 T1098.003' "$(iam_policy PutUserPolicy "$admin")"
# shellcheck disable=SC2016 # o ${aws:username} é a variável da política da AWS, não do shell
check "política do papel com [\"*\"], com Condition e com \${aws:username} em outra declaração: nível 12" '100306 12 T1098.003' \
  "$(iam_policy PutRolePolicy "$(statement '{"Sid": "Proprio", "Effect": "Allow", "Action": "s3:*", "Resource": "arn:aws:s3:::dados/${aws:username}/*"},
    {"Sid": "Tudo", "Effect": "Allow", "Action": ["*"], "Resource": ["*"], "Condition": {"Bool": {"aws:MultiFactorAuthPresent": "true"}}}')")"
check "política do grupo com s3:* em \"*\": fora" '80202 3 -' \
  "$(iam_policy PutGroupPolicy "$(statement '{"Effect": "Allow", "Action": "s3:*", "Resource": "*"}')")"
check "Deny em tudo e Allow só de leitura, em declarações diferentes: fora" '80202 3 -' \
  "$(iam_policy PutUserPolicy "$(statement '{"Effect": "Deny", "Action": "*", "Resource": "*", "Condition": {"Bool": {"aws:SecureTransport": "false"}}}, {"Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::dados/*"}')")"
check "versão nova padrão com Action e Resource \"*\": nível 12" '100307 12 T1098.003' \
  "$(iam_policy CreatePolicyVersion "$admin" ', "policyArn": "arn:aws:iam::'"$ACCOUNT_A"':policy/app", "setAsDefault": true')"
check "versão nova que não vira a padrão: fora" '80202 3 -' \
  "$(iam_policy CreatePolicyVersion "$admin" ', "policyArn": "arn:aws:iam::'"$ACCOUNT_A"':policy/app", "setAsDefault": false')"
public_trust=$(statement '{"Effect": "Allow", "Principal": {"AWS": "*"}, "Action": "sts:AssumeRole"}')
check "confiança para {\"AWS\": \"*\"} sem Condition: nível 12" '100308 12 T1098.003' \
  "$(trust UpdateAssumeRolePolicy app "$public_trust")"
check "confiança para \"*\" com Condition (ExternalId): fora" '80202 3 -' \
  "$(trust UpdateAssumeRolePolicy app "$(statement '{"Effect": "Allow", "Principal": "*", "Action": "sts:AssumeRole", "Condition": {"StringEquals": {"sts:ExternalId": "exemplo"}}}')")"
check "confiança para outra conta: fora" '80202 3 -' \
  "$(trust UpdateAssumeRolePolicy app "$(statement '{"Effect": "Allow", "Principal": {"AWS": "arn:aws:iam::'"$ACCOUNT_B"':root"}, "Action": "sts:AssumeRole"}')")"
check "o papel da Verax aberto para qualquer conta: a crítica (12) vale sobre a do papel (5)" '100308 12 T1098.003' \
  "$(trust UpdateAssumeRolePolicy verax-control-reader "$public_trust")"
check "o papel da Verax com a confiança da pilha (Google, com Condition): só a do papel" '100204 5 -' \
  "$(trust UpdateAssumeRolePolicy verax-control-reader "$(statement '{"Effect": "Allow", "Principal": {"Federated": "accounts.google.com"}, "Action": "sts:AssumeRoleWithWebIdentity", "Condition": {"StringEquals": {"accounts.google.com:sub": "123456789012345678901"}}}')")"
check "papel criado com confiança para \"*\": nível 12" '100309 12 T1098.003' \
  "$(trust CreateRole publico "$(statement '{"Effect": "Allow", "Principal": "*", "Action": "sts:AssumeRole"}')")"
check "papel criado para um serviço da AWS: fora" '80202 3 -' \
  "$(trust CreateRole lambda "$(statement '{"Effect": "Allow", "Principal": {"Service": "lambda.amazonaws.com"}, "Action": "sts:AssumeRole"}')")"
run_cases

echo "== Regras críticas: CloudTrail e GuardDuty (100310 a 100313)"
check "StopLogging: nível 12" '100310 12 T1562.008' "$(ct cloudtrail.amazonaws.com StopLogging '{"name": "trilha"}')"
check "DeleteTrail (fora da lista do Wazuh): nível 12" '100310 12 T1562.008' "$(ct cloudtrail.amazonaws.com DeleteTrail '{"name": "trilha"}')"
check "StopEventDataStoreIngestion: nível 12" '100310 12 T1562.008' \
  "$(ct cloudtrail.amazonaws.com StopEventDataStoreIngestion '{"eventDataStore": "eds"}')"
check "StopLogging negado: fica com o Wazuh" '80250 5 -' "$(ERROR=AccessDenied ct cloudtrail.amazonaws.com StopLogging '{"name": "trilha"}')"
check "DeleteTrail negado (fora da lista do Wazuh): nível 0, como antes" '80200 0 -' \
  "$(ERROR=AccessDenied ct cloudtrail.amazonaws.com DeleteTrail '{"name": "trilha"}')"
check "UpdateTrail: fora" '80200 0 -' "$(ct cloudtrail.amazonaws.com UpdateTrail '{"name": "trilha"}')"
check "DeleteDetector: nível 12" '100311 12 T1562.001' "$(ct guardduty.amazonaws.com DeleteDetector '{"detectorId": "d0"}')"
check "lista de IPs confiáveis no GuardDuty: nível 12" '100311 12 T1562.001' \
  "$(ct guardduty.amazonaws.com CreateIPSet '{"detectorId": "d0", "name": "confiaveis", "format": "TXT", "activate": true}')"
check "a conta sai da administradora do GuardDuty: nível 12" '100311 12 T1562.001' \
  "$(ct guardduty.amazonaws.com DisassociateFromAdministratorAccount '{"detectorId": "d0"}')"
check "o destino da exportação muda: nível 12" '100311 12 T1562.001' \
  "$(ct guardduty.amazonaws.com UpdatePublishingDestination '{"detectorId": "d0", "destinationId": "x"}')"
check "detector desligado: nível 12" '100312 12 T1562.001' "$(ct guardduty.amazonaws.com UpdateDetector '{"detectorId": "d0", "enable": false}')"
check "detector ligado: fora" '80200 0 -' "$(ct guardduty.amazonaws.com UpdateDetector '{"detectorId": "d0", "enable": true}')"
check "filtro que arquiva sozinho: nível 12" '100313 12 T1562.001' \
  "$(ct guardduty.amazonaws.com CreateFilter '{"detectorId": "d0", "name": "silencio", "action": "ARCHIVE"}')"
check "filtro que só marca: fora" '80200 0 -' \
  "$(ct guardduty.amazonaws.com CreateFilter '{"detectorId": "d0", "name": "marca", "action": "NOOP"}')"
check "DeleteDetector negado: fora" '80200 0 -' "$(ERROR=AccessDenied ct guardduty.amazonaws.com DeleteDetector '{"detectorId": "d0"}')"
run_cases

echo "== Regras críticas: bucket S3 aberto ao público (100314)"
check "política com Principal \"*\" sem Condition: nível 12" '100314 12 T1530,T1537' \
  "$(bucket_policy '{"Sid": "Leitura {publica}", "Effect": "Allow", "Principal": "*", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::dados/*"}')"
check "Deny com Condition e Allow para {\"AWS\": [\"*\"]}: nível 12" '100314 12 T1530,T1537' \
  "$(bucket_policy '[{"Effect": "Deny", "Principal": "*", "Action": "s3:*", "Resource": "arn:aws:s3:::dados/*", "Condition": {"Bool": {"aws:SecureTransport": "false"}}}, {"Effect": "Allow", "Principal": {"AWS": ["*"]}, "Action": "s3:GetObject", "Resource": "arn:aws:s3:::dados/*"}]')"
check "Principal \"*\" com Condition (o VPC endpoint): fora" '80202 3 -' \
  "$(bucket_policy '{"Effect": "Allow", "Principal": "*", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::dados/*", "Condition": {"StringEquals": {"aws:SourceVpce": "vpce-0exemplo"}}}')"
check "política para outra conta: fora" '80202 3 -' \
  "$(bucket_policy '{"Effect": "Allow", "Principal": {"AWS": "arn:aws:iam::'"$ACCOUNT_B"':root"}, "Action": "s3:GetObject", "Resource": "arn:aws:s3:::dados/*"}')"
check "a mesma política pública, negada: fica com o Wazuh" '80250 5 -' \
  "$(ERROR=AccessDenied bucket_policy '{"Effect": "Allow", "Principal": "*", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::dados/*"}')"
check "ACL com leitura para AllUsers: nível 12" '100314 12 T1530,T1537' \
  "$(ct s3.amazonaws.com PutBucketAcl '{"bucketName": "dados", "AccessControlPolicy": {"AccessControlList": {"Grant": [{"Grantee": {"xsi:type": "CanonicalUser", "ID": "exemplo"}, "Permission": "FULL_CONTROL"}, {"Grantee": {"xsi:type": "Group", "URI": "http://acs.amazonaws.com/groups/global/AllUsers"}, "Permission": "READ"}]}, "Owner": {"ID": "exemplo"}}, "Host": "dados.s3.amazonaws.com", "acl": ""}')"
check "ACL pronta public-read: nível 12" '100314 12 T1530,T1537' \
  "$(ct s3.amazonaws.com PutBucketAcl '{"bucketName": "dados", "x-amz-acl": "public-read", "Host": "dados.s3.amazonaws.com", "acl": ""}')"
check "ACL para o grupo de entrega de logs do S3: fora" '80202 3 -' \
  "$(ct s3.amazonaws.com PutBucketAcl '{"bucketName": "dados", "AccessControlPolicy": {"AccessControlList": {"Grant": {"Grantee": {"xsi:type": "Group", "URI": "http://acs.amazonaws.com/groups/s3/LogDelivery"}, "Permission": "WRITE"}}}, "acl": ""}')"
run_cases

echo "== Regras críticas: grupo de segurança aberto para a internet (100315 a 100318)"
check "22 aberta (só o pedido): nível 12" '100317 12 T1562.007' "$(sg_open 22 22)"
check "faixa 20 a 25 inclui a 22: nível 12" '100317 12 T1562.007' "$(sg_open 20 25)"
check "faixa 23 a 25: nível 10" '100315 10 T1562.007' "$(sg_open 23 25)"
check "0 a 65535: nível 12" '100317 12 T1562.007' "$(sg_open 0 65535)"
check "8080 aberta: nível 10" '100315 10 T1562.007' "$(sg_open 8080 8080)"
check "443 aberta: fora" '80202 3 -' "$(sg_open 443 443)"
check "80 e 443 abertas, em dois itens: fora" '80202 3 -' \
  "$(sg_ingress "[$(sg_item tcp 80 80 0.0.0.0/0), $(sg_item tcp 443 443 0.0.0.0/0)]")"
check "faixa 80 a 443 (não é só a 80 nem só a 443): nível 10" '100315 10 T1562.007' "$(sg_open 80 443)"
check "22 para a rede interna e 443 para a internet: fora" '80202 3 -' \
  "$(sg_ingress "[$(sg_item tcp 22 22 10.0.0.0/8), $(sg_item tcp 443 443 0.0.0.0/0)]")"
check "22 com duas faixas, uma delas a internet: nível 12" '100317 12 T1562.007' \
  "$(sg_ingress '{"ipProtocol": "tcp", "fromPort": 22, "toPort": 22, "groups": {}, "ipRanges": {"items": [{"cidrIp": "10.0.0.0/8"}, {"cidrIp": "0.0.0.0/0", "description": "temporario {teste}"}]}, "ipv6Ranges": {}, "prefixListIds": {}}')"
check "22 para ::/0: nível 12" '100317 12 T1562.007' \
  "$(sg_ingress '{"ipProtocol": "tcp", "fromPort": 22, "toPort": 22, "groups": {}, "ipRanges": {}, "ipv6Ranges": {"items": {"cidrIpv6": "::/0"}}, "prefixListIds": {}}')"
check "todo o tráfego (-1): nível 12" '100316 12 T1562.007' \
  "$(sg_ingress '{"ipProtocol": "-1", "groups": {}, "ipRanges": {"items": {"cidrIp": "0.0.0.0/0"}}, "ipv6Ranges": {}, "prefixListIds": {}}')"
check "UDP 53 aberta: nível 10" '100315 10 T1562.007' "$(sg_ingress "$(sg_item udp 53 53 0.0.0.0/0)")"
check "ICMP aberto: fora" '80202 3 -' "$(sg_ingress "$(sg_item icmp 8 -1 0.0.0.0/0)")"
check "3306 aberta, com a resposta do CloudTrail (um item por faixa): nível 12" '100318 12 T1562.007' \
  "$(sg_ingress "$(sg_item tcp 3306 3306 0.0.0.0/0)" '{"requestId": "r0", "_return": true, "securityGroupRuleSet": {"items": {"groupOwnerId": "'"$ACCOUNT_A"'", "groupId": "sg-0exemplo", "securityGroupRuleId": "sgr-0exemplo", "isEgress": false, "ipProtocol": "tcp", "fromPort": 3306, "toPort": 3306, "cidrIpv4": "0.0.0.0/0"}}}')"
check "ModifySecurityGroupRules com a 5432 para a internet: nível 12" '100318 12 T1562.007' \
  "$(sg_modify '{"IpProtocol": "tcp", "FromPort": 5432, "ToPort": 5432, "CidrIpv4": "0.0.0.0/0", "Description": ""}')"
check "ModifySecurityGroupRules para a rede interna: fora" '80200 0 -' \
  "$(sg_modify '{"IpProtocol": "tcp", "FromPort": 5432, "ToPort": 5432, "CidrIpv4": "10.0.0.0/8", "Description": ""}')"
check "regra duplicada (erro): fica com o Wazuh" '80203 4 -' "$(ERROR=Client.InvalidPermission.Duplicate sg_open 22 22)"
for port in 22 445 2375 3389; do
  check "administração, $port aberta: nível 12" '100317 12 T1562.007' "$(sg_open "$port" "$port")"
  check "administração, faixa $((port - 1)) a $((port + 1)): nível 12" '100317 12 T1562.007' "$(sg_open $((port - 1)) $((port + 1)))"
  check "vizinha $((port - 1)): nível 10" '100315 10 T1562.007' "$(sg_open $((port - 1)) $((port - 1)))"
  check "vizinha $((port + 1)): nível 10" '100315 10 T1562.007' "$(sg_open $((port + 1)) $((port + 1)))"
done
for port in 1433 1521 3306 5432 6379 9200 11211 27017; do
  check "banco, $port aberta: nível 12" '100318 12 T1562.007' "$(sg_open "$port" "$port")"
  check "banco, faixa $((port - 1)) a $((port + 1)): nível 12" '100318 12 T1562.007' "$(sg_open $((port - 1)) $((port + 1)))"
  check "vizinha $((port - 1)): nível 10" '100315 10 T1562.007' "$(sg_open $((port - 1)) $((port - 1)))"
  check "vizinha $((port + 1)): nível 10" '100315 10 T1562.007' "$(sg_open $((port + 1)) $((port + 1)))"
done
run_cases

echo "== Regras críticas: snapshot público, domínio, organização e WAF (100319 a 100323)"
check "snapshot do EBS para o grupo all: nível 12" '100319 12 T1537' \
  "$(ct ec2.amazonaws.com ModifySnapshotAttribute '{"snapshotId": "snap-0exemplo", "createVolumePermission": {"add": {"items": {"group": "all"}}}, "attributeType": "CREATE_VOLUME_PERMISSION"}')"
check "snapshot do EBS para outra conta: fora" '80202 3 -' \
  "$(ct ec2.amazonaws.com ModifySnapshotAttribute '{"snapshotId": "snap-0exemplo", "createVolumePermission": {"add": {"items": {"userId": "'"$ACCOUNT_B"'"}}}, "attributeType": "CREATE_VOLUME_PERMISSION"}')"
check "snapshot do EBS deixa de ser público: fora" '80202 3 -' \
  "$(ct ec2.amazonaws.com ModifySnapshotAttribute '{"snapshotId": "snap-0exemplo", "createVolumePermission": {"remove": {"items": {"group": "all"}}}, "attributeType": "CREATE_VOLUME_PERMISSION"}')"
check "AMI pública (com outra conta junto): nível 12" '100319 12 T1537' \
  "$(ct ec2.amazonaws.com ModifyImageAttribute '{"imageId": "ami-0exemplo", "launchPermission": {"add": {"items": [{"userId": "'"$ACCOUNT_B"'"}, {"group": "all"}]}}, "attributeType": "launchPermission"}')"
check "snapshot do RDS público: nível 12" '100319 12 T1537' \
  "$(ct rds.amazonaws.com ModifyDBSnapshotAttribute '{"dBSnapshotIdentifier": "banco", "attributeName": "restore", "valuesToAdd": "all"}')"
check "snapshot de cluster do RDS público, com outra conta junto: nível 12" '100319 12 T1537' \
  "$(ct rds.amazonaws.com ModifyDBClusterSnapshotAttribute '{"dBClusterSnapshotIdentifier": "banco", "attributeName": "restore", "valuesToAdd": ["'"$ACCOUNT_B"'", "all"]}')"
check "snapshot de cluster do RDS para outra conta: fora" '80200 0 -' \
  "$(ct rds.amazonaws.com ModifyDBClusterSnapshotAttribute '{"dBClusterSnapshotIdentifier": "banco", "attributeName": "restore", "valuesToAdd": "'"$ACCOUNT_B"'"}')"
check "domínio destravado para transferência: nível 12" '100320 12 T1584.001' \
  "$(ct route53domains.amazonaws.com DisableDomainTransferLock '{"domainName": "exemplo.com.br"}')"
check "domínio passado para outra conta: nível 12" '100320 12 T1584.001' \
  "$(ct route53domains.amazonaws.com TransferDomainToAnotherAwsAccount '{"domainName": "exemplo.com.br", "accountId": "'"$ACCOUNT_B"'"}')"
check "registro DNS alterado no Route 53: fora" '80202 3 -' \
  "$(ct route53.amazonaws.com ChangeResourceRecordSets '{"hostedZoneId": "Z0EXEMPLO"}')"
check "a conta sai da organização: nível 12" '100321 12 T1484' "$(ct organizations.amazonaws.com LeaveOrganization "$NONE")"
check "SCP desanexada: nível 12" '100321 12 T1484' \
  "$(ct organizations.amazonaws.com DetachPolicy '{"policyId": "p-exemplo", "targetId": "'"$ACCOUNT_A"'"}')"
check "DeletePolicy do IAM (mesmo nome, outro serviço): fora" '80202 3 -' \
  "$(ct iam.amazonaws.com DeletePolicy '{"policyArn": "arn:aws:iam::'"$ACCOUNT_A"':policy/app"}')"
check "Web ACL apagada: nível 10" '100322 10 T1562.008' "$(ct wafv2.amazonaws.com DeleteWebACL '{"name": "painel", "scope": "REGIONAL"}')"
check "log do WAF desligado: nível 10" '100322 10 T1562.008' \
  "$(ct wafv2.amazonaws.com DeleteLoggingConfiguration '{"resourceArn": "arn:aws:wafv2:sa-east-1:'"$ACCOUNT_A"':regional/webacl/painel/0000"}')"
check "Web ACL desassociada (WAF clássico regional): nível 10" '100322 10 T1562.008' \
  "$(ct waf-regional.amazonaws.com DisassociateWebACL '{"resourceArn": "arn:aws:elasticloadbalancing:sa-east-1:'"$ACCOUNT_A"':loadbalancer/app/painel/0000"}')"
check "regras da Web ACL alteradas: nível 7" '100323 7 T1562.007' "$(ct wafv2.amazonaws.com UpdateWebACL '{"name": "painel", "scope": "REGIONAL"}')"
check "IPSet do WAF alterado: nível 7" '100323 7 T1562.007' "$(ct wafv2.amazonaws.com UpdateIPSet '{"name": "bloqueio", "scope": "REGIONAL"}')"
check "UpdateWebACL negado: fica com o Wazuh" '80250 5 -' \
  "$(ERROR=AccessDenied ct wafv2.amazonaws.com UpdateWebACL '{"name": "painel", "scope": "REGIONAL"}')"
check "Web ACL só lida: fora" '80200 0 -' "$(READ_ONLY=true ct wafv2.amazonaws.com GetWebACL '{"name": "painel", "scope": "REGIONAL"}')"
run_cases

echo "== Regras críticas: o papel de leitura do nó não gera ruído"
for call in 's3.amazonaws.com GetBucketPolicy {"bucketName": "dados"}' 'guardduty.amazonaws.com GetDetector {"detectorId": "d0"}' \
  'ec2.amazonaws.com DescribeSecurityGroups {}' 'wafv2.amazonaws.com GetWebACL {"name": "painel"}' \
  'cloudtrail.amazonaws.com GetEventSelectors {"trailName": "trilha"}'; do
  read -r service event parameters <<<"$call"
  check "o nó lê $event pelo IP dele: nível 0" '100200 0 -' "$(WHO=sessao FROM=$NODE_IP READ_ONLY=true ct "$service" "$event" "$parameters")"
done
check "o nó entra no papel pelo IP dele: nível 0" '100201 0 -' \
  "$(reader_event web "$NODE_IP" sts.amazonaws.com AssumeRoleWithWebIdentity "$assume")"
check "a sessão do nó, de outro IP, tenta apagar a trilha (negado): a do papel" '100202 12 T1078.004' \
  "$(WHO=sessao FROM=$ATTACKER_IP ERROR=AccessDenied ct cloudtrail.amazonaws.com DeleteTrail '{"name": "trilha"}')"
check "a sessão do nó abre um bucket ao público e consegue (a negação da pilha quebrada): não é silenciada" '100314 12 T1530,T1537' \
  "$(WHO=sessao FROM=$NODE_IP bucket_policy '{"Effect": "Allow", "Principal": "*", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::dados/*"}')"
check "o mesmo, de outro IP: empate no nível 12 com a 100202, vale a crítica (o arquivo dela vem antes)" '100314 12 T1530,T1537' \
  "$(WHO=sessao FROM=$ATTACKER_IP bucket_policy '{"Effect": "Allow", "Principal": "*", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::dados/*"}')"
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

echo "== Guarda de versão: as regras críticas são filhas da mesma cadeia ou de outra regra crítica"
# Cada regra crítica tem as mesmas mães das regras do papel (conferidas acima) ou refina uma regra crítica de antes
# no arquivo (o Wazuh só aceita mãe já carregada). Uma mãe fora disso derruba o teste.
critical=config/manager/rules/verax_aws_critical_rules.xml
critical_ids=$(grep -oE '<rule id="[0-9]+"' "$critical" | grep -oE '[0-9]+')
expect "os IDs são da faixa 100300 a 100399, sem repetição" "" \
  "$(grep -vxE '1003[0-9]{2}' <<<"$critical_ids"; sort <<<"$critical_ids" | uniq -d)"
unexpected=$(awk -v chain="${parents//<if_sid>/}" '
  /<rule id=/ { if (current != "") seen[current] = 1; match($0, /id="[0-9]+"/); current = substr($0, RSTART + 4, RLENGTH - 5) }
  /<if_sid>/ {
    value = $0; sub(/.*<if_sid>/, "", value); sub(/<\/if_sid>.*/, "", value)
    if (value != chain && !(value in seen)) print value
  }' "$critical")
expect "toda mãe é a cadeia ou uma regra crítica já declarada" "" "$unexpected"

echo "== Tamanho dos padrões (o XML do Wazuh recusa o conteúdo de um elemento com 2.048 caracteres ou mais)"
expect "nenhum padrão das regras locais passa de 2.047 caracteres" "" \
  "$(grep -noE '>[^<]{2048,}<' config/manager/rules/*.xml config/manager/rules/*.tmpl | cut -d: -f1,2)"

if ((failures > 0)); then
  echo "$failures verificação(ões) falharam."
  exit 1
fi
echo "Correlações da AWS separadas por conta e regras do papel de leitura e regras críticas no nível certo."
