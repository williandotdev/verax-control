#!/usr/bin/env bash
# Testa, na mesma imagem do manager do nó e sem rede, o que o onboarding self-service da AWS entrega ao Wazuh: a
# configuração que o gerador escreve para as fontes autorizadas e os marcadores que o exportador lê de volta. Nada chama
# a AWS. Usado localmente e no CI (iac.yml); precisa só de Docker. Os arquivos entram nos contêineres por `docker cp`.
#
# 1. o gerador (render-manager-config.py), com o Python do Wazuh e o ossec.conf do nó, sobre a lista de exemplo com todo
#    elemento novo (tests/fixtures/aws-sources.sample.v2.json): trilha de conta e de organização, flow logs (só o
#    rejeitado e tudo), export do GuardDuty, WAF por Web ACL (regional e do CloudFront), grupos do CloudWatch Logs, e os
#    buckets do cadastro anterior;
# 2. o leitor de configuração do próprio Wazuh (`wazuh-modulesd -t`) aceita o ossec.conf gerado, e recusa o mesmo
#    arquivo com uma etiqueta que o módulo aws-s3 não conhece (a prova de que a conferência olha o módulo). No limite,
#    com 50 grupos de nome longo, o arquivo continua aceito (o gerador divide o que passaria do tamanho que o XML do
#    Wazuh lê);
# 3. cada <bucket> e <service> gerado, com os argumentos que o módulo recebe, passa pelos validadores do próprio módulo
#    (aws_tools: nome do bucket, prefixo, regiões, data, grupos de logs) e pela lista de regiões dele;
# 4. as regiões que o gerador aceita são exatamente as do módulo (aws_tools.ALL_REGIONS), e o cabeçalho com que o módulo
#    entrega os eventos ao analysisd é o que o sync dos alertas do CloudWatch Logs procura (`location`);
# 5. os marcadores: o código do próprio módulo (as classes dos buckets e a do CloudWatch Logs, sem rede) cria os bancos
#    e grava um objeto lido de cada tipo; o exportador (export-aws-progress.py), com o Python do Wazuh, lê de volta cada
#    um, sem alterar os bancos.
# Uma atualização do Wazuh que mude as opções do módulo, os validadores dele ou as tabelas dos marcadores derruba este
# teste.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=$(grep -m1 -oE 'wazuh/wazuh-manager:[^[:space:]]+' docker-compose.yml)
PYTHON=/var/ossec/framework/python/bin/python3
RENDER="verax-aws-sources-render-$$"
CHECK="verax-aws-sources-check-$$"

work=$(mktemp -d)
cleanup() {
  docker rm -f "$RENDER" "$CHECK" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

failures=0
expect() { # <descrição> <esperado> <obtido>
  if [[ $2 == "$3" ]]; then
    printf 'ok     %s\n' "$1"
  else
    printf 'FALHA  %s\n       esperado: %s\n       obtido:   %s\n' "$1" "$2" "$3"
    failures=$((failures + 1))
  fi
}

mkdir -p "$work/render-in/verax"
cp scripts/render-manager-config.py config/manager/ossec.conf "$work/render-in/verax/"
cp -R config/manager/rules "$work/render-in/verax/"
render() { # <lista> <pasta de saída>: o ossec.conf gerado, em <pasta>/ossec.conf
  docker rm -f "$RENDER" >/dev/null 2>&1 || true
  docker create --name "$RENDER" -i --network none -e VERAX_NODE_EGRESS_IPS=203.0.113.10/32 --entrypoint "$PYTHON" \
    "$IMAGE" /verax/render-manager-config.py /verax/ossec.conf /out/config /out/aws /verax/rules >/dev/null
  docker cp "$work/render-in/verax" "$RENDER:/verax"
  docker start -ai "$RENDER" <"$1" >/dev/null
  mkdir -p "$2"
  docker cp "$RENDER:/out/config/etc/ossec.conf" "$2/ossec.conf"
}

echo "== Configuração gerada para as fontes autorizadas ($IMAGE)"
render tests/fixtures/aws-sources.sample.v2.json "$work/sample"
expect "o módulo aws-s3 na configuração" 1 "$(grep -c '<wodle name="aws-s3">' "$work/sample/ossec.conf")"
expect "os buckets e os serviços da lista de exemplo" '9 4' \
  "$(grep -c '<bucket type=' "$work/sample/ossec.conf") $(grep -c '<service type="cloudwatchlogs">' "$work/sample/ossec.conf")"
expect "nada é apagado na origem: o \`no\` em todo bucket e em todo serviço" '9 4 0' \
  "$(grep -c '<remove_from_bucket>no</remove_from_bucket>' "$work/sample/ossec.conf") $(grep -c '<remove_log_streams>no</remove_log_streams>' "$work/sample/ossec.conf") $(grep -c -E 'remove_(from_bucket|log_streams)>yes' "$work/sample/ossec.conf" || true)"

# O limite: 50 grupos de nome longo numa conta e região (25 mil caracteres de nomes).
names=''
long_name=$(printf 'g%.0s' {1..480})
for index in $(seq -w 0 49); do names+="${names:+,}\"/aws/lambda/$long_name-$index\""; done
account='"accountId":"111122223333","region":"sa-east-1","s3":[]'
groups="{\"region\":\"sa-east-1\",\"names\":[$names],\"onlyLogsAfter\":\"2026-NOV-20\"}"
printf '{"version":2,"accounts":[{%s,"logGroups":[%s]}]}\n' "$account" "$groups" >"$work/limit.json"
render "$work/limit.json" "$work/limit"
# A mesma configuração com uma etiqueta que o módulo não tem: o leitor do Wazuh tem de recusar.
sed 's#<remove_log_streams>no</remove_log_streams>#<remove_log_streams>no</remove_log_streams><etiqueta_desconhecida>x</etiqueta_desconhecida>#' \
  "$work/sample/ossec.conf" >"$work/unknown.conf"

cat >"$work/check.sh" <<'EOF'
#!/bin/sh
# O leitor de configuração do Wazuh sobre cada arquivo: imprime "<nome> <código de saída> <linhas de erro>".
cp /var/ossec/data_tmp/exclusion/var/ossec/etc/internal_options.conf /var/ossec/etc/internal_options.conf
# O código do módulo no lugar em que o init da imagem o põe a cada partida (a pasta dos marcadores).
cp -a /var/ossec/data_tmp/exclusion/var/ossec/wodles/. /var/ossec/wodles/
for name in sample limit unknown; do
  cp "/check/$name.conf" /var/ossec/etc/ossec.conf
  status=0
  /var/ossec/bin/wazuh-modulesd -t >"/tmp/$name.log" 2>&1 || status=$?
  echo "$name $status $(grep -c -E 'ERROR|CRITICAL' "/tmp/$name.log")"
done
grep -o "No such child tag 'etiqueta_desconhecida' of service at module 'aws-s3'" /tmp/unknown.log | head -n 1
EOF

cat >"$work/check_module.py" <<'EOF'
"""O que o gerador e o exportador combinam com o módulo aws-s3 da imagem, sem rede (scripts/test-aws-sources.sh)."""

import importlib.util
import json
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ElementTree
from unittest import mock

WODLE = "/var/ossec/wodles/aws"
sys.path.insert(0, WODLE)
sys.path.insert(0, os.path.join(WODLE, "buckets_s3"))
sys.path.insert(0, os.path.join(WODLE, "services"))
import aws_tools  # noqa: E402 (o módulo do Wazuh, do caminho da imagem)
import wazuh_integration  # noqa: E402

failures = 0


def expect(label, expected, got):
    global failures
    if expected == got:
        print(f"ok     {label}")
    else:
        print(f"FALHA  {label}\n       esperado: {expected!r}\n       obtido:   {got!r}")
        failures += 1


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


render = load("/check/render-manager-config.py", "render_manager_config")

print("== As regiões e o cabeçalho do módulo")
expect("as regiões do gerador são as do módulo (aws_tools.ALL_REGIONS)", sorted(aws_tools.ALL_REGIONS),
       sorted(render.WODLE_REGIONS))
expect("o cabeçalho dos eventos que o módulo entrega ao analysisd", "1:Wazuh-AWS:", wazuh_integration.MESSAGE_HEADER)

print("== Cada entrada gerada, pelos validadores do próprio módulo")
with open("/check/sample.conf", encoding="utf-8") as file:
    text = file.read()
wodle = ElementTree.fromstring(text[text.index("<ossec_config>\n  <!-- Gerado por") :]).find("wodle")
# As opções do ossec.conf e o argumento que o módulo recebe por cada uma (wm_aws.c da 4.14.9).
OPTIONS = {
    "name": "--bucket",
    "aws_profile": "--aws_profile",
    "path": "--trail_prefix",
    "aws_organization_id": "--aws_organization_id",
    "aws_account_id": "--aws_account_id",
    "regions": "--regions",
    "only_logs_after": "--only_logs_after",
    "aws_log_groups": "--aws_log_groups",
}
checked = 0
for entry in wodle:
    if entry.tag not in ("bucket", "service"):
        continue
    kind = entry.get("type")
    argv = ["aws-s3", "--service", kind] if entry.tag == "service" else ["aws-s3", "--type", kind]
    for child in entry:
        if child.tag in OPTIONS:
            argv += [OPTIONS[child.tag], child.text]
        elif child.tag == "discard_regex":
            argv += ["--discard-field", child.get("field"), "--discard-regex", child.text]
        elif child.tag in ("remove_from_bucket", "remove_log_streams"):
            # `no`: o módulo não recebe o argumento que apaga (--remove, --remove-log-streams).
            assert child.text == "no", child.text
        else:
            raise AssertionError(f"opção sem argumento conhecido: {child.tag}")
    with mock.patch.object(sys, "argv", argv):
        try:
            options = aws_tools.get_script_arguments()
        except SystemExit:
            expect(f"argumentos aceitos: {' '.join(argv)}", "aceito", "recusado")
            continue
    problems = [region for region in options.regions if region not in aws_tools.ALL_REGIONS]
    if options.deleteFile or options.deleteLogStreams:
        problems.append("apaga na origem")
    if entry.tag == "bucket" and kind != "waf" and "legacy" not in argv:
        # A leitura exata: com a conta e as regiões, o módulo não lista o bucket à procura delas.
        named = entry.find("regions") is not None
        if named and not (options.aws_account_id and options.regions):
            problems.append("sem a conta ou as regiões")
    expect(f"{entry.tag} {kind}: aceito pelo módulo ({len(argv)} argumentos)", [], problems)
    checked += 1
expect("todas as entradas conferidas", 13, checked)

print("== Os marcadores gravados pelo código do módulo, lidos pelo exportador")
import aws_bucket  # noqa: E402
import cloudtrail  # noqa: E402
import cloudwatchlogs  # noqa: E402
import guardduty  # noqa: E402
import vpcflow  # noqa: E402
import waf  # noqa: E402

ACCOUNT = "111122223333"


class Caller:
    """O STS de mentira dos tipos que perguntam a conta de quem lê (nada sai do contêiner)."""

    def get_caller_identity(self):
        return {"Account": ACCOUNT}


COMMON = dict(reparse=False, access_key=None, secret_key=None, profile=None, iam_role_arn=None,
              only_logs_after="20261101", skip_on_error=True, account_alias="", suffix="", delete_file=False,
              aws_organization_id=None, region="sa-east-1", discard_field=None, discard_regex=None, sts_endpoint=None,
              service_endpoint=None, iam_role_duration=None)
trail_key = f"AWSLogs/{ACCOUNT}/CloudTrail/sa-east-1/2026/11/23/{ACCOUNT}_CloudTrail_sa-east-1_20261123T1155Z_a.json.gz"
flow_key = (f"AWSLogs/{ACCOUNT}/vpcflowlogs/sa-east-1/2026/11/23/"
            f"{ACCOUNT}_vpcflowlogs_sa-east-1_fl-0123456789abcdef0_20261123T1150Z_b.log.gz")
finding_key = f"AWSLogs/{ACCOUNT}/GuardDuty/sa-east-1/2026/11/23/achado.jsonl.gz"
waf_path = f"AWSLogs/{ACCOUNT}/WAFLogs/sa-east-1/painel/"
waf_key = f"{waf_path}2026/11/23/11/50/{ACCOUNT}_waflogs_sa-east-1_painel_20261123T1150Z_c.log.gz"

# O que os construtores do módulo perguntam à AWS fica de mentira: a conta de quem lê (o STS, nos tipos `guardduty` e
# `waf` e no CloudWatch Logs) e a sondagem do bucket do GuardDuty. O resto é o código do módulo, como ele roda.
with mock.patch.object(wazuh_integration.WazuhIntegration, "get_sts_client", lambda self, *a, **k: Caller()), \
        mock.patch.object(guardduty.AWSGuardDutyBucket, "check_guardduty_type", lambda self: True):
    buckets = (
        (cloudtrail.AWSCloudTrailBucket(bucket="trilha-de-exemplo", prefix="", **COMMON), trail_key, {}),
        (vpcflow.AWSVPCFlowBucket(bucket="fluxo-de-exemplo", prefix="rede/", **COMMON), flow_key,
         {"flow_log_id": "fl-0123456789abcdef0"}),
        (guardduty.AWSGuardDutyBucket(bucket="achados-de-exemplo", prefix="", **COMMON), finding_key, {}),
        (waf.AWSWAFBucket(bucket="aws-waf-logs-exemplo", prefix=waf_path, **COMMON), waf_key, {}),
    )
    directory = os.path.dirname(buckets[0][0].db_path)
    for bucket, key, extra in buckets:
        bucket.init_db(bucket.sql_create_table.format(table_name=bucket.db_table_name))
        bucket.mark_complete(ACCOUNT, "sa-east-1", {"Key": key}, **extra)
        bucket.db_connector.commit()
        bucket.db_connector.close()
    logs = cloudwatchlogs.AWSCloudWatchLogs(reparse=False, access_key=None, secret_key=None, profile=None,
                                            iam_role_arn=None, only_logs_after="20261101", account_alias="",
                                            region="sa-east-1", aws_log_groups="/aws/lambda/cobranca",
                                            remove_log_streams=False)
logs.init_db(logs.sql_cloudwatch_create_table.format(table_name=logs.db_table_name))
logs.save_data_db("/aws/lambda/cobranca", "2026/11/23/[1]a", {"token": "t", "start_time": 1793520000000,
                                                               "end_time": 1793527200000})
logs.close_db()
expect("os bancos do módulo na pasta dele", ["aws_services.db", "s3_cloudtrail.db"],
       sorted(name for name in os.listdir(directory) if name.endswith(".db")))


def fingerprint():
    return {name: os.path.getsize(os.path.join(directory, name)) for name in sorted(os.listdir(directory))}


before = fingerprint()
# Como o host o roda: o programa pela entrada padrão, em modo isolado.
with open("/check/export-aws-progress.py", "rb") as program:
    result = subprocess.run([sys.executable, "-I", "-", directory], stdin=program, capture_output=True, check=False)
expect("o exportador termina sem erro", 0, result.returncode)
document = json.loads(result.stdout)
expect("as duas partes lidas", ("ok", "ok"), (document["s3"]["status"], document["cloudwatch"]["status"]))
entries = {entry["table"]: entry for entry in document["s3"]["entries"]}
expect("um marcador de cada tipo de bucket", ["cloudtrail", "guardduty", "vpcflow", "waf"], sorted(entries))
expect("a trilha: a pasta, a conta, a região e o objeto", ("trilha-de-exemplo/", ACCOUNT, "sa-east-1", trail_key),
       tuple(entries["cloudtrail"][field] for field in ("bucketPath", "accountId", "region", "lastKey")))
expect("os flow logs: o prefixo, a região e o flow log",
       ("fluxo-de-exemplo/rede/", "sa-east-1", "fl-0123456789abcdef0", flow_key),
       tuple(entries["vpcflow"][field] for field in ("bucketPath", "region", "flowLogId", "lastKey")))
expect("o GuardDuty: a pasta e a conta, sem região", ("achados-de-exemplo/", ACCOUNT, None, finding_key),
       tuple(entries["guardduty"][field] for field in ("bucketPath", "accountId", "region", "lastKey")))
expect("o WAF: o caminho da Web ACL no bucket_path", (f"aws-waf-logs-exemplo/{waf_path}", ACCOUNT, waf_key),
       tuple(entries["waf"][field] for field in ("bucketPath", "accountId", "lastKey")))
expect("a hora da leitura no formato do sinal", True,
       all(re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", entry["processedAt"]) for entry in entries.values()))
expect("o dia do objeto como o módulo o guarda", 20261123, entries["cloudtrail"]["createdDate"])
expect("o grupo de logs: o último evento e os streams",
       [{"region": "sa-east-1", "logGroup": "/aws/lambda/cobranca", "endTime": 1793527200000, "streams": 1}],
       document["cloudwatch"]["entries"])
expect("os bancos ficam como estavam, sem arquivo novo", before, fingerprint())

sys.exit(1 if failures else 0)
EOF

echo "== O leitor de configuração do Wazuh e o módulo aws-s3 da imagem"
docker create --name "$CHECK" --network none --entrypoint /bin/sh "$IMAGE" -c \
  "sh /check/check.sh && $PYTHON /check/check_module.py" >/dev/null
mkdir -p "$work/check"
cp "$work/sample/ossec.conf" "$work/check/sample.conf"
cp "$work/limit/ossec.conf" "$work/check/limit.conf"
cp "$work/unknown.conf" "$work/check/unknown.conf"
cp "$work/check.sh" "$work/check_module.py" scripts/render-manager-config.py scripts/export-aws-progress.py "$work/check/"
docker cp "$work/check" "$CHECK:/check"
status=0
docker start -a "$CHECK" >"$work/check.out" 2>"$work/check.err" || status=$?
expect "wazuh-modulesd -t aceita a configuração de exemplo, sem erro" 'sample 0 0' "$(sed -n 1p "$work/check.out")"
expect "wazuh-modulesd -t aceita a configuração com 50 grupos de nome longo" 'limit 0 0' "$(sed -n 2p "$work/check.out")"
expect "wazuh-modulesd -t recusa uma etiqueta que o módulo não conhece" 'unknown 1' \
  "$(sed -n 3p "$work/check.out" | cut -d' ' -f1,2)"
expect "  e diz qual" "No such child tag 'etiqueta_desconhecida' of service at module 'aws-s3'" \
  "$(sed -n 4p "$work/check.out")"
sed -n '5,$p' "$work/check.out"
if ((status != 0)); then
  echo "FALHA  a conferência com o módulo da imagem terminou com o código $status" >&2
  tail -n 20 "$work/check.err" >&2
  failures=$((failures + 1))
fi

if ((failures > 0)); then
  echo "$failures verificação(ões) falharam." >&2
  exit 1
fi
echo 'As fontes da AWS no Wazuh do nó: todas as verificações passaram.'
