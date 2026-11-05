#!/usr/bin/env bash
# Testa, num manager avulso da mesma imagem do nó e sem rede, os profiles que o gerador escreve para as contas AWS (fase
# 2, PR-V4': papel de leitura sem chave), pelo caminho que o módulo aws-s3 do Wazuh usa de verdade e sem chamar a AWS.
# Usado no CI (iac.yml) e localmente; precisa só de Docker. Os arquivos entram nos contêineres por `docker cp`.
#
# 1. o gerador (render-manager-config.py) com as contas de exemplo (tests/fixtures/aws-sources.example.json) e um IP de
#    documentação: o /root/.aws/config, sem arquivo `credentials`;
# 2. com um token de exemplo no lugar do que o host renova (infra/node/bin/aws-token.sh), o boto3 da imagem (o botocore
#    que o Wazuh fixa), para cada conta:
#    - o profile usa o provedor de web identity (`method`), mesmo com AWS_ROLE_ARN e AWS_WEB_IDENTITY_TOKEN_FILE de
#      outro papel no ambiente (com o profile explícito, o botocore as ignora);
#    - a configuração que o próprio módulo monta para o cliente (default_config) lê a região e as repetições do profile;
#    - a troca no STS, interceptada antes do envio (e sem rede, nada sairia de qualquer jeito): o STS da região da
#      conta, sem assinatura, com o papel derivado da conta, a sessão verax-control-wazuh e o token do arquivo;
#    - o S3 assina com a credencial de sessão que voltou, e nenhuma outra troca acontece.
# Uma atualização do Wazuh que mude o boto3 ou o jeito de o módulo montar a sessão derruba este teste.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=$(grep -m1 -oE 'wazuh/wazuh-manager:[^[:space:]]+' docker-compose.yml)
PYTHON=/var/ossec/framework/python/bin/python3
RENDER="verax-aws-profile-render-$$"
CHECK="verax-aws-profile-check-$$"

work=$(mktemp -d)
cleanup() {
  docker rm -f "$RENDER" "$CHECK" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

echo "== Profiles gerados ($IMAGE)"
mkdir -p "$work/render-in/verax"
cp scripts/render-manager-config.py config/manager/ossec.conf "$work/render-in/verax/"
cp -R config/manager/rules "$work/render-in/verax/"
docker create --name "$RENDER" -i --network none -e VERAX_NODE_EGRESS_IPS=203.0.113.10/32 --entrypoint "$PYTHON" \
  "$IMAGE" /verax/render-manager-config.py /verax/ossec.conf /out/config /out/aws /verax/rules >/dev/null
docker cp "$work/render-in/verax" "$RENDER:/verax"
docker start -ai "$RENDER" <tests/fixtures/aws-sources.example.json >/dev/null
docker cp "$RENDER:/out/aws" "$work/aws"
files=$(find "$work/aws" -mindepth 1 -maxdepth 1 -printf '%f ')
if [[ $files != 'config ' ]]; then
  echo "FALHA  só o config na pasta da AWS (obtido: $files)"
  exit 1
fi
echo "ok     só o config na pasta da AWS, sem credentials"

# Um token no formato do Google (três partes em base64 da URL), montado aqui: nenhum token fica no repositório.
segment() { printf '%s' "$1" | base64 | tr -d '=\n' | tr '+/' '-_'; }
printf '%s.%s.%s' "$(segment '{"alg":"RS256","typ":"JWT"}')" "$(segment '{"sub":"123456789012345678901"}')" \
  "$(segment 'assinatura-de-exemplo')" >"$work/aws/google-id-token"

cat >"$work/check_profile.py" <<'EOF'
"""Os profiles das contas como o módulo aws-s3 os usa, sem rede (scripts/test-aws-profile.sh)."""

import sys
import urllib.parse

import boto3
import botocore
from botocore.awsrequest import AWSResponse

sys.path.insert(0, "/var/ossec/data_tmp/exclusion/var/ossec/wodles/aws")
import wazuh_integration  # noqa: E402 (o módulo do Wazuh, do caminho da imagem)

ACCOUNTS = (("111122223333", "sa-east-1"), ("444455556666", "us-east-1"))
# Credencial de sessão de mentira, devolvida pelo STS interceptado (prefixo DEMO: nunca o formato de uma chave real).
ACCESS = "DEMOACCESSKEYEXEMPLO"
SESSION_TOKEN = "exemplo-token-de-sessao-ficticio"
STS_RESPONSE = f"""<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <AssumeRoleWithWebIdentityResult>
    <Credentials><AccessKeyId>{ACCESS}</AccessKeyId><SecretAccessKey>exemplo-ficticio</SecretAccessKey>
      <SessionToken>{SESSION_TOKEN}</SessionToken><Expiration>2099-01-01T00:00:00Z</Expiration></Credentials>
  </AssumeRoleWithWebIdentityResult>
</AssumeRoleWithWebIdentityResponse>""".encode()
LIST_RESPONSE = b"""<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>b</Name><KeyCount>0</KeyCount>
<MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>"""

failures = 0


def expect(label, expected, got):
    global failures
    if expected == got:
        print(f"ok     {label}")
    else:
        print(f"FALHA  {label} (esperado {expected!r}, obtido {got!r})")
        failures += 1


class Raw:
    def __init__(self, data):
        self.data = data

    def stream(self, **_):
        yield self.data


def text(value):
    return value.decode() if isinstance(value, bytes) else value


def answer(calls, body):
    """Responde a chamada interceptada antes do envio (nada sai do contêiner) e a anota."""
    return lambda request, **_: calls.append(request) or AWSResponse(request.url, 200, {}, Raw(body))


with open("/root/.aws/google-id-token", encoding="utf-8") as file:
    token = file.read()
print(f"       boto3 {boto3.__version__}, botocore {botocore.__version__}")

for account, region in ACCOUNTS:
    profile = f"verax-{account}"
    print(f"-- {profile}")
    session = boto3.Session(profile_name=profile)
    credentials = session.get_credentials()
    expect("provedor de web identity, apesar das variáveis de outro papel", "assume-role-with-web-identity",
           credentials.method)

    config = wazuh_integration.WazuhIntegration.default_config(profile=profile)
    expect("região do profile no cliente do módulo", region, config.get("region_name"))
    expect("repetições do profile no cliente do módulo", {"max_attempts": 10, "mode": "standard"},
           config["config"].retries)

    sts, s3 = [], []
    session._session.register("before-send.sts.AssumeRoleWithWebIdentity", answer(sts, STS_RESPONSE))
    session._session.register("before-send.s3.ListObjectsV2", answer(s3, LIST_RESPONSE))
    frozen = credentials.get_frozen_credentials()
    expect("uma troca no STS", 1, len(sts))
    request = sts[0]
    fields = urllib.parse.parse_qs(text(request.body))
    expect("STS da região da conta", f"https://sts.{region}.amazonaws.com/", request.url)
    expect("troca sem assinatura (o token é a prova)", False, "Authorization" in request.headers)
    expect("AssumeRoleWithWebIdentity", ["AssumeRoleWithWebIdentity"], fields.get("Action"))
    role = f"arn:aws:iam::{account}:role/verax/verax-control-reader"
    expect("papel derivado da conta", [role], fields.get("RoleArn"))
    expect("sessão do Wazuh", ["verax-control-wazuh"], fields.get("RoleSessionName"))
    expect("token do arquivo que o host renova", [token], fields.get("WebIdentityToken"))
    expect("credencial de sessão devolvida", ACCESS, frozen.access_key)

    session.client("s3").list_objects_v2(Bucket="trilha-de-exemplo", MaxKeys=1)
    expect("uma leitura no S3", 1, len(s3))
    expect("S3 assinado com a credencial de sessão", True,
           f"Credential={ACCESS}/" in text(s3[0].headers.get("Authorization", "")))
    expect("token da sessão no S3", SESSION_TOKEN, text(s3[0].headers.get("X-Amz-Security-Token")))
    expect("nenhuma troca a mais no STS", 1, len(sts))

sys.exit(1 if failures else 0)
EOF

echo "== boto3 da imagem com os profiles (sem rede)"
docker create --name "$CHECK" --network none \
  -e AWS_ROLE_ARN=arn:aws:iam::777788889999:role/outro-papel -e AWS_WEB_IDENTITY_TOKEN_FILE=/tmp/outro-token \
  --entrypoint "$PYTHON" "$IMAGE" /verax/check_profile.py >/dev/null
mkdir -p "$work/check-in/verax"
cp "$work/check_profile.py" "$work/check-in/verax/"
docker cp "$work/check-in/verax" "$CHECK:/verax"
docker cp "$work/aws" "$CHECK:/root/.aws"
docker start -a "$CHECK"
echo "Profiles da AWS: o módulo do Wazuh entra no papel com o token do host."
