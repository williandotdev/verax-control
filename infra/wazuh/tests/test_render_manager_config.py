"""Testes do gerador de configuração do manager (scripts/render-manager-config.py, T4.4 a T4.6 e fase 2, PR-V4').

Só biblioteca padrão: rodam no CI (iac.yml) e localmente com `python3 -m unittest discover -s infra/wazuh/tests`.
Os IDs de conta são os de exemplo da documentação da AWS; os IPs, os de documentação (RFC 5737).
"""

import configparser
import importlib.util
import io
import json
import os
import pathlib
import re
import secrets
import stat
import string
import tempfile
import unittest
import xml.etree.ElementTree as ElementTree
from unittest import mock

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "render-manager-config.py"
RULES_DIR = pathlib.Path(__file__).resolve().parents[1] / "config" / "manager" / "rules"
spec = importlib.util.spec_from_file_location("render_manager_config", SCRIPT)
render = importlib.util.module_from_spec(spec)
spec.loader.exec_module(render)

BASE_CONF = "<ossec_config>\n  <global/>\n</ossec_config>\n"
NODE_IP = "203.0.113.10"
OTHER_NODE_IP = "198.51.100.20"
HEX64 = re.compile(r"^[0-9a-f]{64}$")


def account_a(**overrides):
    source = {
        "accountId": "111122223333",
        "region": "sa-east-1",
        "onlyLogsAfter": "2026-NOV-01",
        "cloudtrailBucket": "verax-control-cloudtrail-111122223333-sa-east-1",
        "guarddutyBucket": "verax-control-guardduty-111122223333-sa-east-1",
        "wafBucket": "aws-waf-logs-verax-control-111122223333-sa-east-1",
    }
    source.update(overrides)
    return source


def account_b(**overrides):
    source = {
        "accountId": "444455556666",
        "region": "us-east-1",
        "onlyLogsAfter": "2026-OCT-15",
        "cloudtrailBucket": "trilha-existente-444455556666",
    }
    source.update(overrides)
    return source


class Run:
    """Executa o main() num diretório temporário (ou num que persiste entre execuções), com as contas na entrada."""

    def __init__(self, sources, egress=f"{NODE_IP}/32", root=None, env=None):
        """egress=None: sem a variável no ambiente (o wazuh-apply.sh de um nó sem NODE_EGRESS_IPS manda vazia)."""
        self.raw = sources if isinstance(sources, str) else json.dumps(sources)
        self.env = {**({} if egress is None else {"VERAX_NODE_EGRESS_IPS": egress}), **(env or {})}
        self.root = root

    def __enter__(self):
        self.dir = None if self.root else tempfile.TemporaryDirectory()
        root = pathlib.Path(self.root or self.dir.name)
        self.base = root / "ossec.conf"
        self.base.write_text(BASE_CONF, encoding="utf-8")
        self.config_dir, self.aws_dir = root / "config", root / "aws"
        stdout = io.StringIO()
        environment = {key: value for key, value in os.environ.items() if key != "VERAX_NODE_EGRESS_IPS"}
        with mock.patch.dict(os.environ, {**environment, **self.env}, clear=True), \
                mock.patch("sys.stdin", io.StringIO(self.raw)):
            with mock.patch("sys.stderr") as stderr, mock.patch("sys.stdout", stdout):
                self.code = render.main(str(self.base), str(self.config_dir), str(self.aws_dir), str(RULES_DIR))
        self.stdout = stdout.getvalue()
        self.stderr = "".join(call.args[0] for call in stderr.write.call_args_list)
        return self

    def __exit__(self, *exc):
        if self.dir:
            self.dir.cleanup()

    @property
    def ossec_conf(self):
        return (self.config_dir / "etc" / "ossec.conf").read_text(encoding="utf-8")

    @property
    def aws_config(self):
        return (self.aws_dir / "config").read_text(encoding="utf-8")

    @property
    def reader_rules(self):
        return (self.config_dir / "etc" / "rules" / "verax_reader_rules.xml").read_text(encoding="utf-8")


class ValidSourcesTest(unittest.TestCase):
    def test_one_bucket_per_source_with_the_account_profile(self):
        with Run([account_a(), account_b()]) as run:
            self.assertEqual(run.code, 0, run.stderr)
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
            ElementTree.fromstring(conf.split(BASE_CONF, 1)[1])

    def test_buckets_are_only_read_and_the_waf_drops_allowed_requests(self):
        with Run([account_a(), account_b()]) as run:
            conf = run.ossec_conf
            # Todo bucket, sem exceção, nunca tem o objeto lido apagado.
            self.assertEqual(conf.count("<bucket "), 4)
            self.assertEqual(conf.count("<remove_from_bucket>no</remove_from_bucket>"), 4)
            self.assertNotIn("<remove_from_bucket>yes", conf)
            waf = conf.split('<bucket type="waf">', 1)[1].split("</bucket>", 1)[0]
            self.assertIn('<discard_regex field="action">ALLOW</discard_regex>', waf)
            self.assertEqual(conf.count("<discard_regex"), 1)

    def test_no_key_and_no_role_in_the_manager_config(self):
        with Run([account_a(), account_b()]) as run:
            for forbidden in ("<access_key>", "<secret_key>", "<iam_role_arn>", "<external_id>", "<sts_endpoint>"):
                self.assertNotIn(forbidden, run.ossec_conf)

    def test_profiles_enter_the_derived_role_with_the_host_token(self):
        with Run([account_a(), account_b()]) as run:
            parser = configparser.ConfigParser(interpolation=None)
            parser.read_string(run.aws_config)
            self.assertEqual(parser.sections(), ["profile verax-111122223333", "profile verax-444455556666"])
            for section, account, region in (
                ("profile verax-111122223333", "111122223333", "sa-east-1"),
                ("profile verax-444455556666", "444455556666", "us-east-1"),
            ):
                self.assertEqual(
                    dict(parser[section]),
                    {
                        "role_arn": f"arn:aws:iam::{account}:role/verax/verax-control-reader",
                        "web_identity_token_file": "/root/.aws/google-id-token",
                        "role_session_name": "verax-control-wazuh",
                        "region": region,
                        "sts_regional_endpoints": "regional",
                        "retry_mode": "standard",
                        "max_attempts": "10",
                    },
                )
            for forbidden in ("credential_process", "credential_source", "external_id", "aws_access_key_id",
                              "aws_secret_access_key", "source_profile"):
                self.assertNotIn(forbidden, run.aws_config)
            # Sem arquivo `credentials`: só o config e o que o host põe na pasta.
            self.assertEqual(sorted(path.name for path in run.aws_dir.iterdir()), ["config"])

    @unittest.skipIf(os.name == "nt", "permissões POSIX")
    def test_files_are_not_world_readable(self):
        with Run([account_a()]) as run:
            self.assertEqual(stat.S_IMODE(run.aws_dir.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE((run.aws_dir / "config").stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE((run.config_dir / "etc" / "ossec.conf").stat().st_mode), 0o640)
            for rule in (run.config_dir / "etc" / "rules").iterdir():
                # O init da imagem copia como root sem preservar o dono; o analysisd lê como wazuh.
                self.assertEqual(stat.S_IMODE(rule.stat().st_mode), 0o644, rule.name)

    def test_local_rules_go_with_the_config_even_without_accounts(self):
        for sources in ([account_a()], []):
            with self.subTest(accounts=len(sources)), Run(sources) as run:
                installed = run.config_dir / "etc" / "rules" / "verax_aws_rules.xml"
                original = RULES_DIR / "verax_aws_rules.xml"
                self.assertEqual(installed.read_text(encoding="utf-8"), original.read_text(encoding="utf-8"))
                self.assertEqual(
                    sorted(path.name for path in (run.config_dir / "etc" / "rules").iterdir()),
                    ["verax_aws_rules.xml", "verax_reader_rules.xml"],
                )

    def test_correlations_are_split_by_account(self):
        rules = (RULES_DIR / "verax_aws_rules.xml").read_text(encoding="utf-8")
        cases = (("80252", "aws.aws_account_id"), ("80255", "aws.aws_account_id"), ("80443", "aws.webaclId"))
        for rule_id, field in cases:
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

    def test_only_the_hash_of_the_manager_config_goes_to_stdout(self):
        with Run([account_a(), account_b()]) as run:
            self.assertRegex(run.stdout, r"^[0-9a-f]{64}\n$")
            self.assertEqual(run.stdout.strip(), render.tree_hash(render.read_tree(str(run.config_dir))))
            self.assertIn("2 conta(s) AWS", run.stderr)


class ReaderRulesTest(unittest.TestCase):
    def test_the_node_ip_goes_into_the_ip_rules(self):
        with Run([account_a()], egress=f"{NODE_IP}/32,{OTHER_NODE_IP}/32") as run:
            rules = run.reader_rules
            ElementTree.fromstring(rules)
            ids = re.findall(r'<rule id="(\d+)"', rules)
            self.assertEqual(ids, ["100200", "100201", "100202", "100203", "100204", "100205"])
            # Os IPs em ordem, escapados para a regex, nas duas regras do próprio nó e nas duas de fora dele.
            alternation = r"198\.51\.100\.20|203\.0\.113\.10"
            self.assertEqual(rules.count(f"^(?:{alternation})$"), 2)
            self.assertEqual(rules.count(f"^(?!(?:{alternation})$)[0-9A-Fa-f:.]+$"), 2)
            self.assertNotIn("@NODE_EGRESS_IPS@", rules)
            self.assertNotIn("verax:ip-rules", rules)
            outside = rules.split('<rule id="100202"', 1)[1].split("</rule>", 1)[0]
            self.assertIn('level="12"', outside)
            self.assertIn("<id>T1078.004</id>", outside)

    def test_without_the_node_ip_only_the_role_change_rules(self):
        for egress in ("", None):
            with self.subTest(egress=egress), Run([account_a()], egress=egress) as run:
                self.assertEqual(run.code, 0)
                rules = run.reader_rules
                ElementTree.fromstring(rules)
                self.assertEqual(re.findall(r'<rule id="(\d+)"', rules), ["100204", "100205"])
                self.assertIn("sem o IP de saída do nó", run.stderr)

    def test_a_different_node_ip_changes_the_hash(self):
        with Run([account_a()]) as first, Run([account_a()], egress=f"{OTHER_NODE_IP}/32") as second:
            self.assertNotEqual(first.stdout, second.stdout)

    def test_the_ip_order_does_not_matter(self):
        with Run([account_a()], egress=f"{NODE_IP}/32,{OTHER_NODE_IP}/32") as first:
            with Run([account_a()], egress=f"{OTHER_NODE_IP}/32,{NODE_IP}/32") as second:
                self.assertEqual(first.stdout, second.stdout)


class HashTest(unittest.TestCase):
    """O hash decide se o wazuh-apply.sh reinicia o manager: só o que o manager lê ao subir pode mudá-lo."""

    def test_order_and_profile_only_fields_keep_the_hash(self):
        with Run([account_a(), account_b()]) as first:
            with Run([account_b(), account_a()]) as reordered:
                self.assertEqual(first.stdout, reordered.stdout)
                self.assertEqual(first.aws_config, reordered.aws_config)
            # A região só vai para o profile (o boto3 relê o arquivo a cada execução do módulo): sem reinício.
            with Run([account_a(region="us-east-2"), account_b()]) as region:
                self.assertEqual(first.stdout, region.stdout)
                self.assertNotEqual(first.aws_config, region.aws_config)

    def test_a_new_bucket_or_account_changes_the_hash(self):
        with Run([account_b()]) as first:
            with Run([account_b(wafBucket="aws-waf-logs-exemplo")]) as bucket:
                self.assertNotEqual(first.stdout, bucket.stdout)
            with Run([account_a(), account_b()]) as account:
                self.assertNotEqual(first.stdout, account.stdout)


class SharedBucketsTest(unittest.TestCase):
    """O mesmo bucket em mais de uma conta (ou de uma fonte): cada evento entra uma vez só."""

    @staticmethod
    def buckets(conf):
        """Cada <bucket> como (tipo, nome, profile, contas filtradas, início)."""
        blocks = re.findall(r'<bucket type="(\w+)">(.*?)</bucket>', conf, re.S)

        def tag(body, name):
            found = re.search(rf"<{name}>([^<]*)</{name}>", body)
            return found.group(1) if found else None

        return [
            (kind, tag(body, "name"), tag(body, "aws_profile"), tag(body, "aws_account_id"), tag(body, "only_logs_after"))
            for kind, body in blocks
        ]

    def test_guardduty_and_waf_shared_by_two_accounts_are_read_once(self):
        shared = {"guarddutyBucket": "guardduty-da-organizacao", "wafBucket": "aws-waf-logs-da-organizacao"}
        sources = [account_b(**shared), account_a(**shared, onlyLogsAfter="2026-DEC-01")]
        with Run(sources) as run:
            reads = self.buckets(run.ossec_conf)
            # Uma leitura de cada, pelo papel da conta de menor ID, desde a data mais antiga entre as duas.
            self.assertEqual(
                [read for read in reads if read[0] != "cloudtrail"],
                [
                    ("guardduty", "guardduty-da-organizacao", "verax-111122223333", None, "2026-OCT-15"),
                    ("waf", "aws-waf-logs-da-organizacao", "verax-111122223333", None, "2026-OCT-15"),
                ],
            )
            # As duas contas seguem com o profile delas (a leitura do CloudTrail de cada uma).
            self.assertIn("[profile verax-444455556666]", run.aws_config)

    def test_a_cloudtrail_bucket_shared_by_two_accounts_is_read_per_account_folder(self):
        trail = {"cloudtrailBucket": "trilha-da-organizacao"}
        with Run([account_a(**trail), account_b(**trail)]) as run:
            self.assertEqual(
                [read for read in self.buckets(run.ossec_conf) if read[0] == "cloudtrail"],
                [
                    ("cloudtrail", "trilha-da-organizacao", "verax-111122223333", "111122223333", "2026-NOV-01"),
                    ("cloudtrail", "trilha-da-organizacao", "verax-444455556666", "444455556666", "2026-OCT-15"),
                ],
            )

    def test_one_bucket_as_two_sources_of_the_same_account_is_read_as_each_type(self):
        with Run([account_b(guarddutyBucket="trilha-existente-444455556666")]) as run:
            self.assertEqual(
                [(kind, name) for kind, name, *_ in self.buckets(run.ossec_conf)],
                [("cloudtrail", "trilha-existente-444455556666"), ("guardduty", "trilha-existente-444455556666")],
            )

    def test_the_reader_does_not_depend_on_the_input_order(self):
        shared = {"wafBucket": "aws-waf-logs-da-organizacao"}
        with Run([account_a(**shared), account_b(**shared)]) as first, \
                Run([account_b(**shared), account_a(**shared)]) as second:
            self.assertEqual(first.stdout, second.stdout)


class AtomicAndRollbackTest(unittest.TestCase):
    def test_same_input_writes_nothing_and_keeps_no_previous(self):
        with tempfile.TemporaryDirectory() as root:
            with Run([account_a()], root=root) as run:
                ossec = run.config_dir / "etc" / "ossec.conf"
                before = ossec.stat()
            with Run([account_a()], root=root) as again:
                self.assertEqual(again.code, 0)
                after = ossec.stat()
                self.assertEqual((before.st_ino, before.st_mtime_ns), (after.st_ino, after.st_mtime_ns))
                self.assertIn("sem mudança", again.stderr)
                self.assertFalse((again.config_dir / ".prev").exists())

    def test_a_change_keeps_the_previous_config_and_the_rollback_brings_it_back(self):
        with tempfile.TemporaryDirectory() as root:
            with Run([account_b()], root=root) as first:
                old_conf, old_hash = first.ossec_conf, first.stdout
            with Run([account_a(), account_b()], root=root) as second:
                self.assertNotEqual(second.stdout, old_hash)
                previous = second.config_dir / ".prev" / "etc" / "ossec.conf"
                self.assertEqual(previous.read_text(encoding="utf-8"), old_conf)
                if os.name != "nt":
                    self.assertEqual(stat.S_IMODE((second.config_dir / ".prev").stat().st_mode), 0o700)
            # A volta: só a configuração anterior no lugar, e o hash dela na saída.
            with Run("", root=root, env={"VERAX_MANAGER_CONFIG_ROLLBACK": "1"}) as back:
                self.assertEqual(back.code, 0, back.stderr)
                self.assertEqual(back.ossec_conf, old_conf)
                self.assertEqual(back.stdout, old_hash)
                # Nada da pasta .prev vai para o manager: o init da imagem copia <config>/*.
                self.assertEqual(sorted(path.name for path in back.config_dir.iterdir()), [".prev", "etc"])

    def test_rollback_without_a_previous_config_fails(self):
        with tempfile.TemporaryDirectory() as root:
            with Run("", root=root, env={"VERAX_MANAGER_CONFIG_ROLLBACK": "1"}) as run:
                self.assertEqual(run.code, 1)
                self.assertIn("não há configuração anterior", run.stderr)

    def test_a_failed_write_leaves_the_current_config_and_no_temporary_file(self):
        with tempfile.TemporaryDirectory() as root:
            with Run([account_b()], root=root) as first:
                old_conf = first.ossec_conf
            real_replace = os.replace

            def failing_replace(source, target):
                if str(target).endswith("ossec.conf"):
                    raise OSError("disco cheio (simulado)")
                return real_replace(source, target)

            with mock.patch("os.replace", side_effect=failing_replace), self.assertRaises(OSError):
                with Run([account_a(), account_b()], root=root):
                    pass
            etc = pathlib.Path(root) / "config" / "etc"
            self.assertEqual((etc / "ossec.conf").read_text(encoding="utf-8"), old_conf)
            self.assertEqual(sorted(path.name for path in etc.iterdir()), ["ossec.conf", "rules"])

    def test_leftovers_are_removed_and_the_token_is_kept(self):
        with tempfile.TemporaryDirectory() as root:
            with Run([account_a()], root=root) as run:
                stray = run.config_dir / "etc" / "rules" / "regra_antiga.xml"
                stray.write_text("<group/>", encoding="utf-8")
                (run.aws_dir / "credentials").write_text("[default]\n", encoding="utf-8")
                (run.aws_dir / "google-id-token").write_text("token.de.teste", encoding="utf-8")
            with Run([account_a()], root=root) as again:
                self.assertFalse(stray.exists())
                self.assertFalse((again.aws_dir / "credentials").exists())
                self.assertEqual((again.aws_dir / "google-id-token").read_text(encoding="utf-8"), "token.de.teste")


class InvalidSourcesTest(unittest.TestCase):
    CASES = {
        "não é lista": {"accountId": "111122223333"},
        "JSON quebrado": "[{",
        "conta com 11 dígitos": [account_a(accountId="11112222333")],
        "XML no nome do bucket": [account_a(cloudtrailBucket="x</name><name>outro")],
        "bucket do WAF sem o prefixo": [account_a(wafBucket="verax-waf-111122223333")],
        "conta repetida": [account_a(), account_a()],
        "campo desconhecido (escolher o papel)": [account_a(roleArn="arn:aws:iam::111122223333:role/Admin")],
        "ExternalId do conector antigo": [account_a(externalId="exemplo-external-id-conta-a-0000000000")],
        "credential_process como campo": [account_a(credential_process="/bin/sh -c id")],
        "chave de acesso": [account_a(accessKeyId="DEMOEXEMPLO0000000000")],
        "quebra de linha na região (injeção no profile)": [
            account_a(region="sa-east-1\ncredential_process = /bin/sh -c id")
        ],
        "seção nova na região (injeção no profile)": [account_a(region="sa-east-1\n[profile verax-444455556666]")],
        "sem bucket": [{k: v for k, v in account_a().items() if not k.endswith("Bucket")}],
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
                self.assertEqual(run.stdout, "")
                self.assertFalse(run.config_dir.exists())
                self.assertFalse(run.aws_dir.exists())

    def test_invalid_node_ip_fails_without_writing(self):
        for egress in (NODE_IP, f"{NODE_IP}/24", f"{NODE_IP}/32,", "203.0.113.256/32", f"{NODE_IP}/32\n<rule>",
                       ",".join(f"203.0.113.{n}/32" for n in range(1, 6))):
            with self.subTest(egress=egress), Run([account_a()], egress=egress) as run:
                self.assertEqual(run.code, 1)
                self.assertIn("VERAX_NODE_EGRESS_IPS", run.stderr)
                self.assertFalse(run.config_dir.exists())

    def test_profile_keys_come_only_from_the_list(self):
        for pairs in ((("credential_process", "/bin/sh"),), (("aws_secret_access_key", "x"),), (("role_arn", "a\nb"),),
                      (("region", "sa-east-1 ; x"),), (("region", ""),)):
            with self.subTest(pairs=pairs), self.assertRaises(render.InvalidSources):
                render.format_profile("verax-111122223333", pairs)
        with self.assertRaises(render.InvalidSources):
            render.format_profile("default", (("region", "sa-east-1"),))

    def test_missing_rules_template_fails_without_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            rules = pathlib.Path(directory) / "rules"
            rules.mkdir()
            (rules / "verax_aws_rules.xml").write_text("<group/>", encoding="utf-8")
            base = pathlib.Path(directory) / "ossec.conf"
            base.write_text(BASE_CONF, encoding="utf-8")
            with mock.patch("sys.stdin", io.StringIO("[]")), mock.patch("sys.stderr") as stderr:
                code = render.main(str(base), f"{directory}/config", f"{directory}/aws", str(rules))
            self.assertEqual(code, 1)
            self.assertIn("verax_reader_rules.xml.tmpl", "".join(call.args[0] for call in stderr.write.call_args_list))
            self.assertFalse((pathlib.Path(directory) / "config").exists())


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
        stdout = io.StringIO()
        with mock.patch.dict(os.environ, env), mock.patch("sys.stdin", io.StringIO("[]")):
            with mock.patch("sys.stderr") as stderr, mock.patch("sys.stdout", stdout):
                self.code = render.main(str(BASE_OSSEC_CONF), str(self.config_dir), str(self.aws_dir), str(RULES_DIR))
        self.stdout = stdout.getvalue()
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
            self.assertNotIn(ENROLLMENT, run.stdout)

    def test_the_password_does_not_change_the_hash(self):
        other = "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(32))
        with AgentsRun(ENROLLMENT) as first, AgentsRun(other) as second:
            self.assertRegex(first.stdout.strip(), HEX64)
            self.assertEqual(first.stdout, second.stdout)

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
