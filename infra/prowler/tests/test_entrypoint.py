"""Testes do entrypoint do Prowler agendado (T4.7).

Só biblioteca padrão, com STS, S3, Secrets Manager e o processo do Prowler simulados: rodam no CI (iac.yml) e
localmente com `python3 -m unittest discover -s infra/prowler/tests`. Contas de exemplo da documentação da AWS.
"""

import datetime
import importlib.util
import io
import json
import os
import pathlib
import unittest
from contextlib import redirect_stderr, redirect_stdout
from types import SimpleNamespace
from unittest import mock

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "entrypoint.py"
spec = importlib.util.spec_from_file_location("prowler_entrypoint", SCRIPT)
entrypoint = importlib.util.module_from_spec(spec)
spec.loader.exec_module(entrypoint)

TENANT_A = "0192f0c1-7a1b-7c2d-8e3f-4a5b6c7d8e9f"
TENANT_B = "0192f0c1-7a1b-7c2d-9e3f-4a5b6c7d8e90"
EXTERNAL_A = "exemplo-external-id-conta-a-0000000000"
EXTERNAL_B = "exemplo-external-id-conta-b-0000000000"
NOW = datetime.datetime(2026, 11, 2, 6, 0, 5, tzinfo=datetime.timezone.utc)
ENV = {
    "PROWLER_TARGETS_SECRET_ARN": "arn:aws:secretsmanager:sa-east-1:111122223333:secret:alvos",
    "RESULTS_BUCKET": "verax-control-production-prowler-111122223333",
    "AWS_REGION": "sa-east-1",
}


def targets():
    return [
        {"tenantId": TENANT_A, "accountId": "111122223333", "externalId": EXTERNAL_A},
        {"tenantId": TENANT_B, "accountId": "444455556666", "externalId": EXTERNAL_B, "regions": ["sa-east-1", "us-east-1"]},
    ]


class FakeSecrets:
    def __init__(self, value):
        self.value = value

    def get_secret_value(self, SecretId):
        return {"SecretString": self.value if isinstance(self.value, str) else json.dumps(self.value)}


class FakeSts:
    def __init__(self, deny=()):
        self.calls, self.deny = [], set(deny)

    def assume_role(self, **kwargs):
        self.calls.append(kwargs)
        account = kwargs["RoleArn"].split(":")[4]
        if account in self.deny:
            raise PermissionError(f"AccessDenied ao assumir {kwargs['RoleArn']} com {kwargs['ExternalId']}")
        return {"Credentials": {"AccessKeyId": f"ASIA{account}", "SecretAccessKey": "s" * 40, "SessionToken": "t" * 80}}


class FakeS3:
    def __init__(self):
        self.uploads = []

    def upload_file(self, path, bucket, key, ExtraArgs):
        with open(path, encoding="utf-8") as file:
            self.uploads.append({"bucket": bucket, "key": key, "body": file.read(), "extra": ExtraArgs})


class FakeProwler:
    """Grava o relatório no diretório pedido e devolve o código configurado."""

    def __init__(self, codes=None, write_report=True):
        self.calls, self.codes, self.write_report = [], codes or {}, write_report

    def __call__(self, args, env, stdout, stderr):
        self.calls.append({"args": args, "env": env})
        account = env["AWS_ACCESS_KEY_ID"][4:]
        output_dir = args[args.index("--output-directory") + 1]
        if self.write_report:
            with open(os.path.join(output_dir, "prowler.ocsf.json"), "w", encoding="utf-8") as file:
                file.write(json.dumps([{"cloud": {"account": {"uid": account}}}]))
        stdout.write("linha de log do prowler\n")
        return SimpleNamespace(returncode=self.codes.get(account, 0))


def run_main(value, sts=None, prowler=None, env=ENV):
    sts, s3, prowler = sts or FakeSts(), FakeS3(), prowler or FakeProwler()
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = entrypoint.main(env=env, clients=(FakeSecrets(value), sts, s3), run=prowler, now=NOW)
    return SimpleNamespace(code=code, sts=sts, s3=s3, prowler=prowler, output=out.getvalue() + err.getvalue())


class ScanTest(unittest.TestCase):
    def test_assumes_the_fixed_role_with_the_external_id(self):
        result = run_main(targets())
        self.assertEqual(result.code, 0)
        self.assertEqual(
            result.sts.calls[0],
            {
                "RoleArn": "arn:aws:iam::111122223333:role/VeraxControlReadOnly",
                "RoleSessionName": "verax-control-prowler",
                "ExternalId": EXTERNAL_A,
                "DurationSeconds": 3600,
            },
        )
        self.assertEqual(result.sts.calls[1]["RoleArn"], "arn:aws:iam::444455556666:role/VeraxControlReadOnly")

    def test_results_go_to_tenant_account_and_date(self):
        result = run_main(targets())
        keys = [upload["key"] for upload in result.s3.uploads]
        self.assertEqual(
            keys,
            [
                f"{TENANT_A}/111122223333/2026-11-02/prowler-20261102T060005Z.ocsf.json",
                f"{TENANT_B}/444455556666/2026-11-02/prowler-20261102T060005Z.ocsf.json",
            ],
        )
        self.assertTrue(all(upload["bucket"] == ENV["RESULTS_BUCKET"] for upload in result.s3.uploads))
        self.assertIn("444455556666", result.s3.uploads[1]["body"])
        # Sem cabeçalho de criptografia: vale a chave KMS padrão do bucket.
        self.assertEqual(result.s3.uploads[0]["extra"], {"ContentType": "application/json"})

    def test_customer_credentials_only_in_the_prowler_environment(self):
        task_env = {
            "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI": "/v2/credentials/da-tarefa",
            "AWS_ACCESS_KEY_ID": "AKIADATAREFA",
            "PROWLER_TARGETS_SECRET_ARN": ENV["PROWLER_TARGETS_SECRET_ARN"],
        }
        with mock.patch.dict(os.environ, task_env):
            result = run_main(targets())
        for call in result.prowler.calls:
            self.assertNotIn("PROWLER_TARGETS_SECRET_ARN", call["env"])
            self.assertNotEqual(call["env"]["AWS_ACCESS_KEY_ID"], "AKIADATAREFA")
            joined = " ".join(call["args"])
            self.assertNotIn(EXTERNAL_A, joined)
            self.assertNotIn("ASIA", joined)
            self.assertTrue(call["env"]["AWS_ACCESS_KEY_ID"].startswith("ASIA"))
            # Nada da credencial da própria tarefa chega ao Prowler.
            self.assertFalse(any(name.startswith("AWS_CONTAINER") for name in call["env"]))
            self.assertEqual(call["args"][:4], [entrypoint.PROWLER, "aws", "--output-formats", "json-ocsf"])
            self.assertIn("--ignore-exit-code-3", call["args"])

    def test_regions_are_passed_only_when_listed(self):
        result = run_main(targets())
        self.assertNotIn("--region", result.prowler.calls[0]["args"])
        args = result.prowler.calls[1]["args"]
        self.assertEqual(args[args.index("--region") + 1 :], ["sa-east-1", "us-east-1"])

    def test_one_failing_account_does_not_stop_the_others(self):
        result = run_main(targets(), sts=FakeSts(deny={"111122223333"}))
        self.assertEqual(result.code, 1)
        self.assertEqual(len(result.s3.uploads), 1)
        self.assertIn("conta 111122223333: falhou", result.output)
        self.assertIn("1 de 2 conta(s) analisada(s)", result.output)

    def test_prowler_error_or_missing_report_fails_the_account(self):
        for prowler in (FakeProwler(codes={"111122223333": 1}), FakeProwler(write_report=False)):
            with self.subTest(prowler=prowler.codes or "sem relatório"):
                result = run_main(targets()[:1], prowler=prowler)
                self.assertEqual(result.code, 1)
                self.assertEqual(result.s3.uploads, [])

    def test_external_id_never_logged(self):
        result = run_main(targets(), sts=FakeSts(deny={"111122223333", "444455556666"}))
        self.assertNotIn(EXTERNAL_A, result.output)
        self.assertNotIn(EXTERNAL_B, result.output)
        self.assertIn("***", result.output)

    def test_no_targets_is_a_successful_empty_run(self):
        result = run_main([])
        self.assertEqual(result.code, 0)
        self.assertEqual(result.sts.calls, [])


class InvalidInputTest(unittest.TestCase):
    CASES = {
        "JSON quebrado": "[{",
        "não é lista": {"tenantId": TENANT_A},
        "tenant fora do formato": [dict(targets()[0], tenantId="../outro-cliente")],
        "conta com 11 dígitos": [dict(targets()[0], accountId="11112222333")],
        "ExternalId curto": [dict(targets()[0], externalId="curto")],
        "campo desconhecido (escolher o papel)": [dict(targets()[0], roleArn="arn:aws:iam::111122223333:role/Admin")],
        "região com comando": [dict(targets()[0], regions=["sa-east-1; rm -rf /"])],
        "conta repetida": [targets()[0], dict(targets()[0], tenantId=TENANT_B)],
        "contas demais": [dict(targets()[0], accountId=f"{n:012d}") for n in range(201)],
    }

    def test_invalid_targets_scan_nothing(self):
        for label, value in self.CASES.items():
            with self.subTest(label):
                result = run_main(value)
                self.assertEqual(result.code, 2)
                self.assertEqual(result.sts.calls, [])
                self.assertNotIn(EXTERNAL_A, result.output)

    def test_unreadable_target_list(self):
        class BrokenSecrets:
            def get_secret_value(self, SecretId):
                raise ConnectionError("sem rede")

        out = io.StringIO()
        with redirect_stdout(out):
            code = entrypoint.main(env=ENV, clients=(BrokenSecrets(), FakeSts(), FakeS3()), run=FakeProwler(), now=NOW)
        self.assertEqual(code, 2)
        self.assertIn("não foi possível ler a lista de contas (ConnectionError)", out.getvalue())

    def test_missing_configuration(self):
        for missing in ENV:
            with self.subTest(missing=missing):
                env = {k: v for k, v in ENV.items() if k != missing}
                self.assertEqual(run_main(targets(), env=env).code, 2)


if __name__ == "__main__":
    unittest.main()
