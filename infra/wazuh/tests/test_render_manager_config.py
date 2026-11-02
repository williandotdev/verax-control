"""Testes do gerador de configuração do manager (scripts/render-manager-config.py, T4.4 a T4.6).

Só biblioteca padrão: rodam no CI (iac.yml) e localmente com `python3 -m unittest discover -s infra/wazuh/tests`.
Os IDs de conta são os de exemplo da documentação da AWS.
"""

import importlib.util
import io
import json
import os
import pathlib
import stat
import tempfile
import unittest
from unittest import mock

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "render-manager-config.py"
spec = importlib.util.spec_from_file_location("render_manager_config", SCRIPT)
render = importlib.util.module_from_spec(spec)
spec.loader.exec_module(render)

EXTERNAL_ID_A = "exemplo-external-id-conta-a-0000000000"
EXTERNAL_ID_B = "exemplo-external-id-conta-b-0000000000"
BASE_CONF = "<ossec_config>\n  <global/>\n</ossec_config>\n"


def account_a(**overrides):
    source = {
        "accountId": "111122223333",
        "externalId": EXTERNAL_ID_A,
        "region": "sa-east-1",
        "onlyLogsAfter": "2026-NOV-01",
        "cloudtrailBucket": "verax-control-cloudtrail-111122223333-sa-east-1",
        "guarddutyBucket": "verax-control-guardduty-111122223333-sa-east-1",
        "wafBucket": "aws-waf-logs-verax-control-111122223333-sa-east-1",
    }
    source.update(overrides)
    return source


def account_b():
    return {
        "accountId": "444455556666",
        "externalId": EXTERNAL_ID_B,
        "region": "us-east-1",
        "onlyLogsAfter": "2026-OCT-15",
        "cloudtrailBucket": "trilha-existente-444455556666",
    }


class Run:
    """Executa o main() num diretório temporário, com a lista de contas na entrada padrão."""

    def __init__(self, sources):
        self.raw = sources if isinstance(sources, str) else json.dumps(sources)

    def __enter__(self):
        self.dir = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.dir.name)
        self.base = root / "ossec.conf"
        self.base.write_text(BASE_CONF, encoding="utf-8")
        self.config_dir, self.aws_dir = root / "config", root / "aws"
        with mock.patch("sys.stdin", io.StringIO(self.raw)):
            with mock.patch("sys.stderr") as stderr:
                self.code = render.main(str(self.base), str(self.config_dir), str(self.aws_dir))
        self.stderr = "".join(call.args[0] for call in stderr.write.call_args_list)
        return self

    def __exit__(self, *exc):
        self.dir.cleanup()

    @property
    def ossec_conf(self):
        return (self.config_dir / "etc" / "ossec.conf").read_text(encoding="utf-8")

    @property
    def aws_config(self):
        return (self.aws_dir / "config").read_text(encoding="utf-8")


class ValidSourcesTest(unittest.TestCase):
    def test_one_bucket_per_source_with_the_account_profile(self):
        with Run([account_a(), account_b()]) as run:
            self.assertEqual(run.code, 0)
            conf = run.ossec_conf
            self.assertTrue(conf.startswith(BASE_CONF))
            self.assertEqual(conf.count('<wodle name="aws-s3">'), 1)
            self.assertEqual(conf.count('<bucket type="cloudtrail">'), 2)
            self.assertEqual(conf.count('<bucket type="guardduty">'), 1)
            self.assertEqual(conf.count('<bucket type="waf">'), 1)
            self.assertEqual(conf.count("<aws_profile>verax-111122223333</aws_profile>"), 3)
            self.assertEqual(conf.count("<aws_profile>verax-444455556666</aws_profile>"), 1)
            # A pasta da conta só é fixada no CloudTrail (nos outros, o wodle descobre a conta pelo papel assumido).
            self.assertEqual(conf.count("<aws_account_id>"), 2)
            self.assertIn("<only_logs_after>2026-OCT-15</only_logs_after>", conf)
            self.assertNotIn(EXTERNAL_ID_A, conf)

    def test_profiles_assume_the_fixed_role_with_the_external_id(self):
        with Run([account_a(), account_b()]) as run:
            config = run.aws_config
            self.assertIn("[profile verax-111122223333]", config)
            self.assertIn("role_arn = arn:aws:iam::111122223333:role/VeraxControlReadOnly", config)
            self.assertIn(f"external_id = {EXTERNAL_ID_A}", config)
            self.assertIn("role_arn = arn:aws:iam::444455556666:role/VeraxControlReadOnly", config)
            self.assertIn(f"external_id = {EXTERNAL_ID_B}", config)
            self.assertEqual(config.count("credential_source = Ec2InstanceMetadata"), 2)
            self.assertEqual(config.count("duration_seconds = 3600"), 2)

    @unittest.skipIf(os.name == "nt", "permissões POSIX")
    def test_files_are_not_world_readable(self):
        with Run([account_a()]) as run:
            self.assertEqual(stat.S_IMODE((run.aws_dir / "config").stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE((run.config_dir / "etc" / "ossec.conf").stat().st_mode), 0o640)

    def test_no_accounts_means_no_wodle_and_no_profiles(self):
        for raw in ("[]", ""):
            with self.subTest(raw=raw), Run(raw) as run:
                self.assertEqual(run.code, 0)
                self.assertEqual(run.ossec_conf, BASE_CONF)
                self.assertEqual(run.aws_config, "")


class InvalidSourcesTest(unittest.TestCase):
    CASES = {
        "não é lista": {"accountId": "111122223333"},
        "JSON quebrado": "[{",
        "conta com 11 dígitos": [account_a(accountId="11112222333")],
        "ExternalId curto": [account_a(externalId="curto")],
        "quebra de linha no ExternalId (injeção no profile)": [
            account_a(externalId=EXTERNAL_ID_A + "\nrole_arn = arn:aws:iam::444455556666:role/Admin")
        ],
        "XML no nome do bucket": [account_a(cloudtrailBucket="x</name><name>outro")],
        "bucket do WAF sem o prefixo": [account_a(wafBucket="verax-waf-111122223333")],
        "conta repetida": [account_a(), account_a()],
        "campo desconhecido (escolher o papel)": [account_a(roleArn="arn:aws:iam::111122223333:role/Admin")],
        "sem bucket": [
            {k: v for k, v in account_a().items() if not k.endswith("Bucket")}
        ],
        "valor que não é texto": [account_a(accountId=111122223333)],
        "data fora do formato do Wazuh": [account_a(onlyLogsAfter="2026-11-01")],
        "região inválida": [account_a(region="sa-east-1; rm -rf /")],
        "contas demais": [account_a(accountId=f"{n:012d}") for n in range(101)],
    }

    def test_invalid_input_fails_without_writing(self):
        for label, sources in self.CASES.items():
            with self.subTest(label), Run(sources) as run:
                self.assertEqual(run.code, 1)
                self.assertIn("ERRO", run.stderr)
                self.assertFalse(run.config_dir.exists())
                self.assertFalse(run.aws_dir.exists())

    def test_error_messages_never_include_the_external_id(self):
        for sources in ([account_a(), account_a()], [account_a(region="x")], [account_a(externalId=EXTERNAL_ID_A + "!")]):
            with Run(sources) as run:
                self.assertEqual(run.code, 1)
                self.assertNotIn(EXTERNAL_ID_A, run.stderr)


if __name__ == "__main__":
    unittest.main()
