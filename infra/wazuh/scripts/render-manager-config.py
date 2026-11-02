"""Gera o ossec.conf do manager e os profiles da AWS a partir das contas conectadas (T4.4 a T4.6).

Roda no serviço `manager-config` da compose (imagem do manager, sem rede), com o Python do próprio Wazuh, a cada
deploy. Entrada (stdin): a lista JSON das contas conectadas, que a API mantém num segredo do Secrets Manager e o
bootstrap-host.sh entrega ao deploy.sh por um arquivo em tmpfs. Por stdin, e não por variável de ambiente, porque
variáveis passam pelo limite do execve e ficam gravadas na configuração do contêiner. Saídas, em volumes separados (o primeiro é copiado inteiro para /var/ossec pelo init
da imagem, e os ExternalIds não podem ir junto):

- <config>/etc/ossec.conf: o ossec.conf base do bundle mais o módulo aws-s3, com um bucket por fonte de cada conta;
- <aws>/config: um profile por conta, que assume o papel VeraxControlReadOnly com o ExternalId dela usando a
  credencial da instância. É o único jeito de o wodle usar ExternalId com buckets (o --external_id da linha de
  comando dele só vale para o Security Lake).

O papel é sempre arn:aws:iam::<conta>:role/VeraxControlReadOnly, derivado do ID: a entrada não escolhe papel.
Qualquer valor fora do formato derruba o deploy, e nada é escrito pela metade.
"""

import json
import os
import re
import sys
import tempfile
from xml.sax.saxutils import escape

ACCOUNT_ID = re.compile(r"^[0-9]{12}$")
EXTERNAL_ID = re.compile(r"^[A-Za-z0-9+=,.@:/_-]{32,128}$")
REGION = re.compile(r"^[a-z]{2}(-gov)?-[a-z]+-[0-9]$")
BUCKET = re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")
WAZUH_DATE = re.compile(r"^[0-9]{4}-(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)-[0-3][0-9]$")

REQUIRED = {"accountId", "externalId", "region", "onlyLogsAfter"}
BUCKET_FIELDS = (("cloudtrailBucket", "cloudtrail"), ("guarddutyBucket", "guardduty"), ("wafBucket", "waf"))
ALLOWED = REQUIRED | {field for field, _ in BUCKET_FIELDS}
# Cabe no limite de 64 KB de um segredo do Secrets Manager com folga. Acima disso, a lista passa para o S3.
MAX_ACCOUNTS = 100


class InvalidSources(ValueError):
    pass


def validate(raw):
    try:
        sources = json.loads(raw)
    except json.JSONDecodeError as error:
        raise InvalidSources(f"JSON inválido: {error.msg}") from None
    if not isinstance(sources, list) or len(sources) > MAX_ACCOUNTS:
        raise InvalidSources(f"esperada uma lista com até {MAX_ACCOUNTS} contas")

    seen = set()
    for index, source in enumerate(sources):
        where = f"conta {index}"
        if not isinstance(source, dict):
            raise InvalidSources(f"{where}: esperado um objeto")
        unknown = set(source) - ALLOWED
        missing = REQUIRED - set(source)
        if unknown or missing:
            raise InvalidSources(f"{where}: campos desconhecidos {sorted(unknown)} ou faltando {sorted(missing)}")
        if not all(isinstance(value, str) for value in source.values()):
            raise InvalidSources(f"{where}: todos os valores devem ser texto")
        # O ExternalId nunca entra nas mensagens de erro.
        checks = (
            ("accountId", ACCOUNT_ID),
            ("externalId", EXTERNAL_ID),
            ("region", REGION),
            ("onlyLogsAfter", WAZUH_DATE),
        )
        for field, pattern in checks:
            if not pattern.match(source[field]):
                raise InvalidSources(f"{where}: {field} fora do formato")
        account = source["accountId"]
        if account in seen:
            raise InvalidSources(f"conta {account} repetida")
        seen.add(account)
        buckets = [field for field, _ in BUCKET_FIELDS if field in source]
        if not buckets:
            raise InvalidSources(f"conta {account}: nenhum bucket informado")
        for field in buckets:
            if not BUCKET.match(source[field]):
                raise InvalidSources(f"conta {account}: {field} fora do formato")
        if "wafBucket" in source and not source["wafBucket"].startswith("aws-waf-logs-"):
            raise InvalidSources(f"conta {account}: wafBucket deve começar com aws-waf-logs-")
    return sources


def profile_name(account):
    return f"verax-{account}"


def render_wodle(sources):
    if not sources:
        return ""
    lines = [
        "<ossec_config>",
        "  <!-- Gerado por scripts/render-manager-config.py a partir das contas conectadas. -->",
        '  <wodle name="aws-s3">',
        "    <disabled>no</disabled>",
        "    <interval>5m</interval>",
        "    <run_on_start>yes</run_on_start>",
        "    <skip_on_error>yes</skip_on_error>",
    ]
    for source in sources:
        account = source["accountId"]
        for field, bucket_type in BUCKET_FIELDS:
            if field not in source:
                continue
            lines += [
                f'    <bucket type="{bucket_type}">',
                f"      <name>{escape(source[field])}</name>",
                f"      <aws_profile>{profile_name(account)}</aws_profile>",
            ]
            # Lê só a pasta AWSLogs/<conta> (o bucket pode ter logs de outras contas da organização).
            if bucket_type == "cloudtrail":
                lines.append(f"      <aws_account_id>{account}</aws_account_id>")
            lines += [f"      <only_logs_after>{source['onlyLogsAfter']}</only_logs_after>", "    </bucket>"]
    lines += ["  </wodle>", "</ossec_config>", ""]
    return "\n".join(lines)


def render_aws_config(sources):
    blocks = []
    for source in sources:
        account = source["accountId"]
        blocks.append(
            "\n".join(
                [
                    f"[profile {profile_name(account)}]",
                    f"role_arn = arn:aws:iam::{account}:role/VeraxControlReadOnly",
                    f"external_id = {source['externalId']}",
                    "credential_source = Ec2InstanceMetadata",
                    "role_session_name = verax-control-wazuh",
                    "duration_seconds = 3600",
                    f"region = {source['region']}",
                    "sts_regional_endpoints = regional",
                ]
            )
        )
    return "\n\n".join(blocks) + "\n" if blocks else ""


def write_atomically(path, content, mode):
    directory = os.path.dirname(path)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    handle, temporary = tempfile.mkstemp(dir=directory)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as file:
            file.write(content)
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    except BaseException:
        os.unlink(temporary)
        raise


def main(base_config, config_dir, aws_dir):
    try:
        sources = validate(sys.stdin.read().strip() or "[]")
    except InvalidSources as error:
        print(f"ERRO: lista de contas AWS: {error}", file=sys.stderr)
        return 1
    with open(base_config, encoding="utf-8") as file:
        base = file.read()
    ossec_conf = base.rstrip("\n") + "\n" + render_wodle(sources)
    write_atomically(os.path.join(config_dir, "etc", "ossec.conf"), ossec_conf, 0o640)
    write_atomically(os.path.join(aws_dir, "config"), render_aws_config(sources), 0o600)
    # A raiz do volume nasce 0755; fechada, para só o root listar o diretório. Num diretório, o bit x é o de
    # entrar nele: 0700 (só o dono) é o mais restrito que funciona, ao contrário do que a regra supõe para arquivos.
    os.chmod(aws_dir, 0o700)  # nosemgrep: python.lang.security.audit.insecure-file-permissions.insecure-file-permissions
    print(f"Configuração do manager gerada: {len(sources)} conta(s) AWS.")
    return 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:4]))
