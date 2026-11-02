"""Roda o Prowler em cada conta conectada e grava o resultado OCSF no bucket da Verax (T4.7).

Tarefa do ECS Fargate disparada pelo EventBridge Scheduler (infra/terraform/modules/prowler). Para cada conta da
lista (segredo do Secrets Manager mantido pela API):

1. assume arn:aws:iam::<conta>:role/VeraxControlReadOnly com o ExternalId da conta (sessão de 1 hora);
2. roda o Prowler com essa credencial temporária, passada só no ambiente do processo do Prowler;
3. envia o JSON-OCSF para s3://<bucket>/<tenantId>/<conta>/<AAAA-MM-DD>/prowler-<horário>.ocsf.json com a credencial
   da própria tarefa: a credencial do cliente nunca escreve na conta da Verax.

Uma conta com erro não impede as outras, e a tarefa termina com erro se alguma falhou (alarme da T8.6). ExternalId e
credenciais nunca vão para o log nem para argumentos de processo.

Ambiente: PROWLER_TARGETS_SECRET_ARN, RESULTS_BUCKET e AWS_REGION.
"""

import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

PROWLER = "/home/prowler/.venv/bin/prowler"
ROLE_NAME = "VeraxControlReadOnly"
SESSION_NAME = "verax-control-prowler"
SESSION_SECONDS = 3600

TENANT_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
ACCOUNT_ID = re.compile(r"^[0-9]{12}$")
EXTERNAL_ID = re.compile(r"^[A-Za-z0-9+=,.@:/_-]{32,128}$")
REGION = re.compile(r"^[a-z]{2}(-gov)?-[a-z]+-[0-9]$")
BUCKET = re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")
REQUIRED = {"tenantId", "accountId", "externalId"}
ALLOWED = REQUIRED | {"regions"}
# Cabe no limite de 64 KB de um segredo do Secrets Manager com folga.
MAX_TARGETS = 200
MAX_REGIONS = 40
# O processo do Prowler herda só isto do ambiente da tarefa (nada de credencial da tarefa nem variável AWS_*).
INHERITED_ENV = ("PATH", "HOME", "LANG", "TMPDIR", "TZ")


class InvalidTargets(ValueError):
    pass


class ScanFailed(RuntimeError):
    pass


def log(message):
    print(f"[prowler-verax] {message}", flush=True)


def validate(raw):
    try:
        targets = json.loads(raw)
    except json.JSONDecodeError as error:
        raise InvalidTargets(f"JSON inválido: {error.msg}") from None
    if not isinstance(targets, list) or len(targets) > MAX_TARGETS:
        raise InvalidTargets(f"esperada uma lista com até {MAX_TARGETS} contas")
    seen = set()
    for index, target in enumerate(targets):
        where = f"conta {index}"
        if not isinstance(target, dict):
            raise InvalidTargets(f"{where}: esperado um objeto")
        unknown, missing = set(target) - ALLOWED, REQUIRED - set(target)
        if unknown or missing:
            raise InvalidTargets(f"{where}: campos desconhecidos {sorted(unknown)} ou faltando {sorted(missing)}")
        # O ExternalId nunca entra nas mensagens de erro.
        for field, pattern in (("tenantId", TENANT_ID), ("accountId", ACCOUNT_ID), ("externalId", EXTERNAL_ID)):
            if not isinstance(target[field], str) or not pattern.match(target[field]):
                raise InvalidTargets(f"{where}: {field} fora do formato")
        regions = target.get("regions", [])
        if not isinstance(regions, list) or len(regions) > MAX_REGIONS:
            raise InvalidTargets(f"{where}: regions deve ser uma lista com até {MAX_REGIONS} regiões")
        if not all(isinstance(region, str) and REGION.match(region) for region in regions):
            raise InvalidTargets(f"{where}: região fora do formato")
        if target["accountId"] in seen:
            raise InvalidTargets(f"conta {target['accountId']} repetida")
        seen.add(target["accountId"])
    return targets


def prowler_env(credentials, region):
    env = {name: os.environ[name] for name in INHERITED_ENV if name in os.environ}
    env.update(
        AWS_ACCESS_KEY_ID=credentials["AccessKeyId"],
        AWS_SECRET_ACCESS_KEY=credentials["SecretAccessKey"],
        AWS_SESSION_TOKEN=credentials["SessionToken"],
        AWS_DEFAULT_REGION=region,
        AWS_STS_REGIONAL_ENDPOINTS="regional",
    )
    return env


def scan(target, *, sts, s3, bucket, region, run, now, workdir):
    account = target["accountId"]
    response = sts.assume_role(
        RoleArn=f"arn:aws:iam::{account}:role/{ROLE_NAME}",
        RoleSessionName=SESSION_NAME,
        ExternalId=target["externalId"],
        DurationSeconds=SESSION_SECONDS,
    )
    output_dir = tempfile.mkdtemp(prefix=f"{account}-", dir=workdir)
    try:
        args = [
            PROWLER,
            "aws",
            "--output-formats",
            "json-ocsf",
            "--output-directory",
            output_dir,
            "--output-filename",
            "prowler",
            "--no-banner",
            "--no-color",
            "--ignore-exit-code-3",
        ]
        if target.get("regions"):
            args += ["--region", *target["regions"]]
        with tempfile.TemporaryFile(mode="w+", dir=workdir) as console:
            result = run(args, env=prowler_env(response["Credentials"], region), stdout=console, stderr=console)
            if result.returncode != 0:
                console.seek(0)
                tail = console.read()[-4000:]
                print(tail, file=sys.stderr)
                raise ScanFailed(f"o Prowler terminou com código {result.returncode}")
        report = os.path.join(output_dir, "prowler.ocsf.json")
        if not os.path.isfile(report):
            raise ScanFailed("o Prowler não gerou o relatório OCSF")
        key = f"{target['tenantId']}/{account}/{now:%Y-%m-%d}/prowler-{now:%Y%m%dT%H%M%SZ}.ocsf.json"
        # Sem cabeçalho de criptografia: vale a chave KMS padrão do bucket (com "aws:kms" sem chave, o S3 usaria a
        # chave gerenciada pela AWS).
        s3.upload_file(report, bucket, key, ExtraArgs={"ContentType": "application/json"})
        return key
    finally:
        shutil.rmtree(output_dir, ignore_errors=True)


def default_clients(region):
    import boto3  # na imagem do Prowler; os testes injetam clientes falsos

    session = boto3.session.Session(region_name=region)
    return session.client("secretsmanager"), session.client("sts"), session.client("s3")


def main(env=None, clients=None, run=subprocess.run, now=None):
    env = os.environ if env is None else env
    secret_arn, bucket, region = (env.get(name, "") for name in ("PROWLER_TARGETS_SECRET_ARN", "RESULTS_BUCKET", "AWS_REGION"))
    if not secret_arn or not BUCKET.match(bucket) or not REGION.match(region):
        log("ERRO: defina PROWLER_TARGETS_SECRET_ARN, RESULTS_BUCKET e AWS_REGION")
        return 2
    secrets, sts, s3 = clients or default_clients(region)
    try:
        raw = secrets.get_secret_value(SecretId=secret_arn)["SecretString"]
    except Exception as error:  # sem permissão, sem rede ou segredo inexistente
        log(f"ERRO: não foi possível ler a lista de contas ({type(error).__name__})")
        return 2
    try:
        targets = validate(raw)
    except InvalidTargets as error:
        log(f"ERRO: lista de contas: {error}")
        return 2
    now = now or datetime.datetime.now(datetime.timezone.utc)
    workdir = tempfile.mkdtemp(prefix="prowler-verax-")
    failures = 0
    try:
        for target in targets:
            account = target["accountId"]
            try:
                key = scan(target, sts=sts, s3=s3, bucket=bucket, region=region, run=run, now=now, workdir=workdir)
                log(f"conta {account}: ok ({key})")
            except Exception as error:  # uma conta com problema não impede as outras
                failures += 1
                detail = str(error).replace(target["externalId"], "***")
                log(f"conta {account}: falhou ({type(error).__name__}: {detail})")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    log(f"{len(targets) - failures} de {len(targets)} conta(s) analisada(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
