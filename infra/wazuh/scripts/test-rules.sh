#!/usr/bin/env bash
# Testa as correlações da AWS por conta (config/manager/rules/verax_aws_rules.xml) no wazuh-logtest de um manager
# avulso, sem indexer, na mesma imagem da compose. Usado no CI (iac.yml) e localmente; precisa só de Docker.
#
# Um Wazuh atende todos os clientes, então eventos de contas diferentes não podem somar numa correlação:
# 1. logins com falha (80255), objetos apagados (80252) e bloqueios do WAF (80443) divididos entre duas contas não
#    disparam a correlação; completando o limite numa conta só, ela dispara com a conta certa;
# 2. a correlação genérica de falhas de autenticação (40111) não pega eventos da AWS;
# 3. guarda de versão: toda regra de frequência dos arquivos da AWS do Wazuh está tratada aqui ou é de uma fonte que
#    a Verax não coleta. Uma versão nova com outra correlação derruba o teste até ela ser avaliada.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=$(grep -m1 -oE 'wazuh/wazuh-manager:[^[:space:]]+' docker-compose.yml)
NAME="verax-rules-test-$$"
ACCOUNT_A=111122223333
ACCOUNT_B=444455556666
ATTACKER_IP=203.0.113.50

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

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
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

echo "== Manager avulso ($IMAGE)"
docker run -d --name "$NAME" \
  -v "$PWD/config/manager/rules/verax_aws_rules.xml:/var/ossec/etc/rules/verax_aws_rules.xml:ro" \
  "$IMAGE" >/dev/null
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

if ((failures > 0)); then
  echo "$failures verificação(ões) falharam."
  exit 1
fi
echo "Correlações da AWS separadas por conta."
