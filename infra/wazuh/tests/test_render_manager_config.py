"""Testes do gerador de configuração do manager (scripts/render-manager-config.py, T4.4 a T4.6).

Só biblioteca padrão: rodam no CI (iac.yml) e localmente com `python3 -m unittest discover -s infra/wazuh/tests`.
Os IDs de conta são os de exemplo da documentação da AWS.
"""

import importlib.util
import io
import json
import os
import pathlib
import secrets
import stat
import string
import tempfile
import unittest
from unittest import mock

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "render-manager-config.py"
RULES_DIR = pathlib.Path(__file__).resolve().parents[1] / "config" / "manager" / "rules"
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
                self.code = render.main(str(self.base), str(self.config_dir), str(self.aws_dir), str(RULES_DIR))
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

    def test_local_rules_go_with_the_config_even_without_accounts(self):
        for sources in ([account_a()], []):
            with self.subTest(accounts=len(sources)), Run(sources) as run:
                installed = run.config_dir / "etc" / "rules" / "verax_aws_rules.xml"
                original = RULES_DIR / "verax_aws_rules.xml"
                self.assertEqual(installed.read_text(encoding="utf-8"), original.read_text(encoding="utf-8"))
                if os.name != "nt":
                    # O init da imagem copia como root sem preservar o dono; o analysisd lê como wazuh.
                    self.assertEqual(stat.S_IMODE(installed.stat().st_mode), 0o644)

    def test_correlations_are_split_by_account(self):
        rules = (RULES_DIR / "verax_aws_rules.xml").read_text(encoding="utf-8")
        for rule_id, field in (("80252", "aws.aws_account_id"), ("80255", "aws.aws_account_id"), ("80443", "aws.webaclId")):
            with self.subTest(rule=rule_id):
                block = rules.split(f'<rule id="{rule_id}"', 1)[1].split("</rule>", 1)[0]
                self.assertIn('overwrite="yes"', block)
                self.assertIn(f"<same_field>{field}</same_field>", block)

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


AGENTS_DIR = pathlib.Path(__file__).resolve().parents[1] / "config" / "manager" / "agents"
BASE_OSSEC_CONF = pathlib.Path(__file__).resolve().parents[1] / "config" / "manager" / "ossec.conf"
# Gerada na hora, letras e dígitos como a do install.sh: nunca uma senha real.
ENROLLMENT = "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(32))


class AgentsRun:
    """O main() com o ossec.conf do nó; no modo dos agentes quando a senha é informada (as variáveis do compose)."""

    def __init__(self, enrollment=None, config_dir=None, keep_dir=None):
        self.enrollment = enrollment
        self.agents_dir = config_dir or AGENTS_DIR
        self.keep_dir = keep_dir

    def __enter__(self):
        self.dir = self.keep_dir or tempfile.TemporaryDirectory()
        root = pathlib.Path(self.dir.name)
        self.config_dir, self.aws_dir = root / "config", root / "aws"
        env = {}
        if self.enrollment is not None:
            secret = root / "agents-enrollment"
            secret.write_text(self.enrollment, encoding="utf-8")
            env = {"VERAX_AGENTS_CONFIG": str(self.agents_dir), "VERAX_AGENTS_ENROLLMENT": str(secret)}
        with mock.patch.dict(os.environ, env), mock.patch("sys.stdin", io.StringIO("[]")):
            with mock.patch("sys.stderr") as stderr, mock.patch("sys.stdout"):
                self.code = render.main(str(BASE_OSSEC_CONF), str(self.config_dir), str(self.aws_dir), str(RULES_DIR))
        self.stderr = "".join(call.args[0] for call in stderr.write.call_args_list)
        return self

    def __exit__(self, *exc):
        if self.keep_dir is None:
            self.dir.cleanup()

    @property
    def ossec_conf(self):
        return (self.config_dir / "etc" / "ossec.conf").read_text(encoding="utf-8")

    def block(self, tag):
        return render.top_level_blocks(self.ossec_conf).get(tag, [])


class AgentsTest(unittest.TestCase):
    def test_without_the_switch_the_node_config_is_the_same_as_always(self):
        with AgentsRun() as run:
            self.assertEqual(run.code, 0)
            self.assertEqual(run.ossec_conf, BASE_OSSEC_CONF.read_text(encoding="utf-8"))
            self.assertFalse((run.config_dir / "etc" / "authd.pass").exists())
            self.assertFalse((run.config_dir / "etc" / "shared").exists())

    def test_registration_only_with_the_password_and_the_node_certificate(self):
        with AgentsRun(ENROLLMENT) as run:
            self.assertEqual(run.code, 0, run.stderr)
            [auth] = run.block("auth")
            self.assertIn("<disabled>no</disabled>", auth)
            self.assertIn("<use_password>yes</use_password>", auth)
            self.assertIn("<port>1515</port>", auth)
            self.assertIn("<ssl_manager_cert>/etc/ssl/verax-agents/manager.crt</ssl_manager_cert>", auth)
            self.assertIn("<ssl_manager_key>/etc/ssl/verax-agents/manager.key</ssl_manager_key>", auth)
            self.assertIn("<ssl_auto_negotiate>no</ssl_auto_negotiate>", auth)
            [remote] = run.block("remote")
            self.assertIn("<connection>secure</connection>", remote)
            self.assertIn("<port>1514</port>", remote)
            self.assertIn("<protocol>tcp</protocol>", remote)
            self.assertNotIn("<local_ip>", remote)
            self.assertIn("<allow_higher_versions>no</allow_higher_versions>", remote)
            authd_pass = run.config_dir / "etc" / "authd.pass"
            self.assertEqual(authd_pass.read_text(encoding="utf-8"), ENROLLMENT + "\n")
            if os.name != "nt":
                self.assertEqual(stat.S_IMODE(authd_pass.stat().st_mode), 0o640)
            # A senha só no authd.pass: nunca no ossec.conf nem na saída.
            self.assertNotIn(ENROLLMENT, run.ossec_conf)
            self.assertNotIn(ENROLLMENT, run.stderr)

    def test_active_response_off_and_no_command_anywhere(self):
        with AgentsRun(ENROLLMENT) as run:
            [active_response] = run.block("active-response")
            self.assertIn("<disabled>yes</disabled>", active_response)
            self.assertNotIn("<command>", run.ossec_conf)
            agent_conf = (run.config_dir / "etc" / "shared" / "default" / "agent.conf").read_text(encoding="utf-8")
            self.assertEqual(agent_conf, (AGENTS_DIR / "agent.conf").read_text(encoding="utf-8"))
            for forbidden in ("<command>", "<full_command>", 'wodle name="command"', "<localfile>"):
                self.assertNotIn(forbidden, agent_conf)
            for expected in ("<syscheck>", '<wodle name="syscollector">', "<sca>", "<client_buffer>"):
                self.assertIn(expected, agent_conf)

    def test_vulnerability_detection_from_the_inventory_without_indexing_states(self):
        with AgentsRun(ENROLLMENT) as run:
            [detection] = run.block("vulnerability-detection")
            self.assertIn("<enabled>yes</enabled>", detection)
            self.assertIn("<index-status>no</index-status>", detection)
            # A conexão do manager com o indexer continua desligada (só o filebeat grava, com o usuário de escrita).
            [indexer] = run.block("indexer")
            self.assertIn("<enabled>no</enabled>", indexer)

    def test_only_the_agent_blocks_change(self):
        base = render.top_level_blocks(BASE_OSSEC_CONF.read_text(encoding="utf-8"))
        with AgentsRun(ENROLLMENT) as run:
            rendered = render.top_level_blocks(run.ossec_conf)
            for tag in set(base) | set(rendered):
                with self.subTest(tag=tag):
                    if tag in render.AGENT_BLOCKS:
                        self.assertEqual(len(rendered[tag]), 1)
                    else:
                        self.assertEqual(rendered[tag], base[tag])

    def test_switching_off_removes_the_password_and_the_agent_conf(self):
        keep = tempfile.TemporaryDirectory()
        try:
            with AgentsRun(ENROLLMENT, keep_dir=keep) as run:
                self.assertTrue((run.config_dir / "etc" / "authd.pass").exists())
            with AgentsRun(keep_dir=keep) as run:
                self.assertEqual(run.code, 0)
                self.assertFalse((run.config_dir / "etc" / "authd.pass").exists())
                self.assertFalse((run.config_dir / "etc" / "shared").exists())
                self.assertEqual(run.ossec_conf, BASE_OSSEC_CONF.read_text(encoding="utf-8"))
        finally:
            keep.cleanup()

    def test_bad_password_or_half_configuration_writes_nothing(self):
        for label, password in (("curta", "abc123"), ("com espaço", "a" * 20 + " " + "b" * 20), ("vazia", "")):
            with self.subTest(label), AgentsRun(password) as run:
                self.assertEqual(run.code, 1)
                self.assertIn("ERRO: agentes", run.stderr)
                self.assertFalse(run.config_dir.exists())
                if password:
                    self.assertNotIn(password, run.stderr)
        for env in ({"VERAX_AGENTS_CONFIG": str(AGENTS_DIR)}, {"VERAX_AGENTS_ENROLLMENT": "/nao/existe"}):
            with self.subTest(env=env), tempfile.TemporaryDirectory() as directory:
                with mock.patch.dict(os.environ, env), mock.patch("sys.stdin", io.StringIO("[]")):
                    with mock.patch("sys.stderr") as stderr:
                        code = render.main(str(BASE_OSSEC_CONF), f"{directory}/config", f"{directory}/aws")
                self.assertEqual(code, 1)
                self.assertIn("andam juntas", "".join(call.args[0] for call in stderr.write.call_args_list))

    def test_fragment_must_have_each_agent_block_once(self):
        fragment = (AGENTS_DIR / "ossec-agents.conf").read_text(encoding="utf-8")
        cases = (
            ("sem o auth", fragment.replace("  <auth>", "  <!-- auth", 1).replace("  </auth>", "  -->", 1)),
            ("bloco a mais", fragment.replace("</ossec_config>", "  <global>\n  </global>\n</ossec_config>")),
        )
        for label, text in cases:
            with self.subTest(label), tempfile.TemporaryDirectory() as directory:
                broken = pathlib.Path(directory)
                (broken / "agent.conf").write_text("<agent_config/>\n", encoding="utf-8")
                (broken / "ossec-agents.conf").write_text(text, encoding="utf-8")
                with AgentsRun(ENROLLMENT, config_dir=broken) as run:
                    self.assertEqual(run.code, 1)
                    self.assertFalse(run.config_dir.exists())


if __name__ == "__main__":
    unittest.main()
