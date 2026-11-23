"""Testes do gerador de configuração do manager (scripts/render-manager-config.py, T4.4 a T4.6, fase 2, PR-V4', e o
onboarding self-service da AWS: a lista das fontes autorizadas, no formato 2).

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

    def test_static_keys_profiles_only_have_region_and_retries_and_keep_the_host_credentials(self):
        """VM própria do cliente: sem papel nem token; as credenciais vêm do arquivo do host, que fica."""
        with tempfile.TemporaryDirectory() as root:
            aws_dir = pathlib.Path(root) / "aws"
            aws_dir.mkdir()
            # As sessões que o aws-token.sh do host escreve (valores fictícios no formato da AWS).
            host_credentials = "[verax-111122223333]\naws_access_key_id = ASIAEXEMPLO000000000\n"
            (aws_dir / "credentials").write_text(host_credentials, encoding="utf-8")
            with Run([account_a(), account_b()], root=root, env={"VERAX_AWS_STATIC_KEYS": "1"}) as run:
                self.assertEqual(run.code, 0)
                parser = configparser.ConfigParser(interpolation=None)
                parser.read_string(run.aws_config)
                self.assertEqual(
                    dict(parser["profile verax-111122223333"]),
                    {"region": "sa-east-1", "retry_mode": "standard", "max_attempts": "10"},
                )
                for forbidden in ("role_arn", "web_identity_token_file", "aws_secret_access_key", "credential_process"):
                    self.assertNotIn(forbidden, run.aws_config)
                self.assertEqual((aws_dir / "credentials").read_text(encoding="utf-8"), host_credentials)
                # O mesmo bucket e o mesmo profile no wodle: só a origem das credenciais muda.
                self.assertIn("<aws_profile>verax-111122223333</aws_profile>", run.ossec_conf)
            # Sem o modo, o arquivo que sobrou de outra configuração sai, como antes.
            with Run([account_a()], root=root) as run:
                self.assertEqual(run.code, 0)
                self.assertFalse((aws_dir / "credentials").exists())

    def test_static_keys_variable_only_accepts_0_or_1(self):
        with Run([account_a()], env={"VERAX_AWS_STATIC_KEYS": "sim"}) as run:
            self.assertEqual(run.code, 1)
            self.assertIn("VERAX_AWS_STATIC_KEYS", run.stderr)

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
                # As correlações por conta e as regras críticas (fase 2, PR-V7) vão como estão no bundle.
                for name in ("verax_aws_rules.xml", "verax_aws_critical_rules.xml"):
                    installed = run.config_dir / "etc" / "rules" / name
                    original = RULES_DIR / name
                    self.assertEqual(installed.read_text(encoding="utf-8"), original.read_text(encoding="utf-8"))
                self.assertEqual(
                    sorted(path.name for path in (run.config_dir / "etc" / "rules").iterdir()),
                    ["verax_aws_critical_rules.xml", "verax_aws_rules.xml", "verax_reader_rules.xml"],
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
                # Nada da pasta .prev nem do registro dos profiles vai para o manager: o init da imagem copia
                # <config>/*, que não pega o que começa com ponto.
                self.assertEqual(
                    sorted(path.name for path in back.config_dir.iterdir()), [".aws-config", ".prev", "etc"]
                )

    @staticmethod
    def referenced_profiles(conf):
        return set(re.findall(r"<aws_profile>([^<]+)</aws_profile>", conf))

    @staticmethod
    def defined_profiles(aws_config):
        parser = configparser.ConfigParser()
        parser.read_string(aws_config)
        return {section.removeprefix("profile ") for section in parser.sections()}

    def test_the_rollback_brings_back_the_profiles_of_a_shared_bucket(self):
        # A e B com o mesmo bucket do GuardDuty (lido pela A); a nova só com a B (o bucket passa ao profile da B, e o da
        # A sai). A volta precisa trazer o profile da A junto com o ossec.conf que o usa.
        shared = {"guarddutyBucket": "guardduty-da-organizacao"}
        with tempfile.TemporaryDirectory() as root:
            with Run([account_a(**shared), account_b(**shared)], root=root) as first:
                old_conf, old_profiles, old_hash = first.ossec_conf, first.aws_config, first.stdout
                token = first.aws_dir / "google-id-token"
                token.write_text("token.de.teste", encoding="utf-8")
            with Run([account_b(**shared)], root=root) as second:
                self.assertEqual(self.defined_profiles(second.aws_config), {"verax-444455556666"})
                self.assertEqual(
                    (second.config_dir / ".prev" / "aws-config").read_text(encoding="utf-8"), old_profiles
                )
                # O host renova o token enquanto isso.
                token.write_text("token.renovado", encoding="utf-8")
            with Run("", root=root, env={"VERAX_MANAGER_CONFIG_ROLLBACK": "1"}) as back:
                self.assertEqual(back.code, 0, back.stderr)
                self.assertEqual((back.ossec_conf, back.stdout), (old_conf, old_hash))
                self.assertEqual(back.aws_config, old_profiles)
                self.assertEqual((back.config_dir / ".aws-config").read_text(encoding="utf-8"), old_profiles)
                self.assertIn("verax-111122223333", self.referenced_profiles(back.ossec_conf))
                self.assertLessEqual(
                    self.referenced_profiles(back.ossec_conf), self.defined_profiles(back.aws_config)
                )
                # O token não é dos profiles: fica o que o host gravou por último.
                self.assertEqual(token.read_text(encoding="utf-8"), "token.renovado")
                if os.name != "nt":
                    self.assertEqual(stat.S_IMODE((back.aws_dir / "config").stat().st_mode), 0o600)

    def test_the_profiles_of_the_previous_config_survive_the_node_restart(self):
        # A pasta da AWS é memória: na partida do nó ela volta vazia, e os profiles da configuração de antes vêm do
        # registro no volume. Uma troca só de região (sem mudar o hash) também atualiza o registro.
        shared = {"wafBucket": "aws-waf-logs-da-organizacao"}
        with tempfile.TemporaryDirectory() as root:
            with Run([account_a(**shared), account_b(**shared)], root=root):
                pass
            with Run([account_a(**shared, region="us-east-2"), account_b(**shared)], root=root) as region:
                self.assertIn("sem mudança", region.stderr)
                self.assertFalse((region.config_dir / ".prev").exists())
                profiles = region.aws_config
                self.assertIn("region = us-east-2", profiles)
                (region.aws_dir / "config").unlink()
            with Run([account_b(**shared)], root=root):
                pass
            with Run("", root=root, env={"VERAX_MANAGER_CONFIG_ROLLBACK": "1"}) as back:
                self.assertEqual(back.code, 0, back.stderr)
                self.assertEqual(back.aws_config, profiles)
                self.assertLessEqual(
                    self.referenced_profiles(back.ossec_conf), self.defined_profiles(back.aws_config)
                )

    def test_a_previous_config_without_profiles_comes_back_without_the_new_ones(self):
        # Um volume de antes do registro: a configuração anterior volta sem os profiles da que falhou.
        with tempfile.TemporaryDirectory() as root:
            with Run([account_b()], root=root) as first:
                (first.config_dir / ".aws-config").unlink()
                token = first.aws_dir / "google-id-token"
                token.write_text("token.de.teste", encoding="utf-8")
            with Run([account_a(), account_b()], root=root) as second:
                self.assertFalse((second.config_dir / ".prev" / "aws-config").exists())
            with Run("", root=root, env={"VERAX_MANAGER_CONFIG_ROLLBACK": "1"}) as back:
                self.assertEqual(back.code, 0, back.stderr)
                self.assertFalse((back.aws_dir / "config").exists())
                self.assertFalse((back.config_dir / ".aws-config").exists())
                self.assertEqual(token.read_text(encoding="utf-8"), "token.de.teste")

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


FIXTURES = pathlib.Path(__file__).resolve().parent / "fixtures"
GOLDEN = FIXTURES / "golden"


def fixture(name):
    return (FIXTURES / name).read_text(encoding="utf-8")


def golden(name):
    return (GOLDEN / name).read_bytes().decode("utf-8")


def account_v2(account="111122223333", region="sa-east-1", s3=(), log_groups=()):
    return {"accountId": account, "region": region, "s3": list(s3), "logGroups": list(log_groups)}


def listed(*accounts):
    """A lista de agora (formato 2), como o CLI `wazuh-sources` a imprime."""
    return {"version": 2, "accounts": list(accounts)}


def legacy(kind, bucket, after="2026-NOV-01"):
    return {"type": kind, "bucket": bucket, "onlyLogsAfter": after, "legacy": True}


def trail(bucket="trilha-111122223333", regions=("sa-east-1",), after="2026-NOV-20", **extra):
    return {"type": "cloudtrail", "bucket": bucket, "onlyLogsAfter": after, "regions": list(regions), **extra}


def flow(bucket="fluxo-111122223333", regions=("sa-east-1",), after="2026-NOV-20", traffic="rejected", **extra):
    entry = {"type": "vpcflow", "bucket": bucket, "onlyLogsAfter": after, "regions": list(regions), "traffic": traffic}
    return {**entry, **extra}


def findings(bucket="achados-111122223333", regions=("sa-east-1",), after="2026-NOV-20", **extra):
    return {"type": "guardduty", "bucket": bucket, "onlyLogsAfter": after, "regions": list(regions), **extra}


def web_acl(name="painel", scope="sa-east-1", bucket="aws-waf-logs-painel", after="2026-NOV-20", **extra):
    return {"type": "waf", "bucket": bucket, "onlyLogsAfter": after, "webAcl": name, "scope": scope, **extra}


def groups(*names, region="sa-east-1", after="2026-NOV-20"):
    return {"region": region, "names": list(names), "onlyLogsAfter": after}


def blocks(conf, tag):
    """Os blocos <bucket> ou <service> do módulo, cada um como {etiqueta: valor} (mais `type` e o `discard`)."""
    found = []
    for kind, body in re.findall(rf'<{tag} type="(\w+)">(.*?)</{tag}>', conf, re.S):
        block = {"type": kind}
        for name, attributes, value in re.findall(r"<(\w+)((?: [^>]*)?)>([^<]*)</\1>", body):
            block[name] = f"{attributes.strip()} {value}".strip() if attributes else value
        found.append(block)
    return found


class GoldenLegacyTest(unittest.TestCase):
    """As contas só com os buckets do cadastro anterior: a configuração é, byte a byte, a que o gerador anterior escrevia.

    Os arquivos de `fixtures/golden/legacy-*` saíram do gerador de antes do onboarding self-service (o commit f74bb0ac),
    com as listas do formato anterior (`aws-sources.example.json` e `aws-sources.shared.v1.json`). As listas
    `*.v2.json` são as que a API imprime agora para as mesmas contas (o teste `wazuh-sources` da API confere isso).
    """

    CASES = (("example", "aws-sources.example.json"), ("shared", "aws-sources.shared.v1.json"))

    def test_the_legacy_accounts_render_exactly_as_before_in_both_formats(self):
        for name, previous in self.CASES:
            with self.subTest(name), Run(fixture(previous)) as before, Run(fixture(f"aws-sources.{name}.v2.json")) as now:
                self.assertEqual((before.code, now.code), (0, 0), now.stderr)
                wodle = golden(f"legacy-{name}.wodle.xml")
                self.assertEqual(before.ossec_conf, BASE_CONF + wodle)
                self.assertEqual(now.ossec_conf, BASE_CONF + wodle)
                profiles = golden(f"legacy-{name}.aws-config")
                self.assertEqual((before.aws_config, now.aws_config), (profiles, profiles))
                # O mesmo hash: trocar o formato da lista não reinicia o manager.
                self.assertEqual(before.stdout, now.stdout)

    def test_the_new_format_of_a_legacy_account_is_the_previous_one_field_by_field(self):
        for name, previous in self.CASES:
            with self.subTest(name):
                expected = []
                for account in sorted(json.loads(fixture(previous)), key=lambda item: item["accountId"]):
                    s3 = [
                        legacy(kind, account[field], account["onlyLogsAfter"])
                        for field, kind in render.V1_BUCKET_FIELDS
                        if field in account
                    ]
                    expected.append(account_v2(account["accountId"], account["region"], s3))
                self.assertEqual(json.loads(fixture(f"aws-sources.{name}.v2.json")), listed(*expected))


class SourceListTest(unittest.TestCase):
    """As fontes descobertas (onboarding self-service): cada tipo com os elementos dele, e nada que apague na origem."""

    def test_the_sample_with_every_element_renders_as_the_golden_file(self):
        with Run(fixture("aws-sources.sample.v2.json")) as run:
            self.assertEqual(run.code, 0, run.stderr)
            self.assertEqual(run.ossec_conf, BASE_CONF + golden("sample.wodle.xml"))
            ElementTree.fromstring(run.ossec_conf.split(BASE_CONF, 1)[1])
            self.assertIn("2 conta(s) AWS", run.stderr)
            self.assertEqual(
                [section.removeprefix("profile ") for section in self.sections(run.aws_config)],
                ["verax-111122223333", "verax-444455556666"],
            )

    @staticmethod
    def sections(aws_config):
        parser = configparser.ConfigParser(interpolation=None)
        parser.read_string(aws_config)
        return parser.sections()

    def test_nothing_is_ever_removed_at_the_origin(self):
        with Run(fixture("aws-sources.sample.v2.json")) as run:
            conf = run.ossec_conf
            buckets, services = blocks(conf, "bucket"), blocks(conf, "service")
            self.assertEqual((len(buckets), len(services)), (9, 4))
            # Em toda entrada, sem exceção, e sempre escrito (o padrão do módulo não é o que garante).
            self.assertEqual([block.get("remove_from_bucket") for block in buckets], ["no"] * 9)
            self.assertEqual([block.get("remove_log_streams") for block in services], ["no"] * 4)
            for forbidden in ("<remove_from_bucket>yes", "<remove_log_streams>yes", "<access_key>", "<secret_key>",
                              "<iam_role_arn>", "<external_id>", "<sts_endpoint>", "<service_endpoint>"):
                self.assertNotIn(forbidden, conf)

    def test_an_account_trail_reads_only_its_folder_and_regions(self):
        with Run(listed(account_v2(s3=[trail(regions=("us-east-1", "sa-east-1"))]))) as run:
            self.assertEqual(
                blocks(run.ossec_conf, "bucket"),
                [{
                    "type": "cloudtrail",
                    "name": "trilha-111122223333",
                    "aws_profile": "verax-111122223333",
                    "aws_account_id": "111122223333",
                    "regions": "sa-east-1,us-east-1",
                    "only_logs_after": "2026-NOV-20",
                    "remove_from_bucket": "no",
                }],
            )

    def test_an_organization_trail_carries_the_organization_id(self):
        with Run(listed(account_v2(s3=[trail(bucket="trilha-da-organizacao", organizationId="o-exemplo1234")]))) as run:
            [block] = blocks(run.ossec_conf, "bucket")
            self.assertEqual(block["aws_organization_id"], "o-exemplo1234")
            self.assertEqual((block["aws_account_id"], block["regions"]), ("111122223333", "sa-east-1"))
            self.assertNotIn("path", block)

    def test_flow_logs_drop_the_accepted_traffic_unless_the_source_asks_for_all(self):
        entries = [flow(), flow(bucket="fluxo-completo", traffic="all")]
        with Run(listed(account_v2(s3=entries))) as run:
            rejected, everything = blocks(run.ossec_conf, "bucket")
            self.assertEqual((rejected["type"], everything["type"]), ("vpcflow", "vpcflow"))
            self.assertEqual(rejected["discard_regex"], 'field="action" ACCEPT')
            self.assertNotIn("discard_regex", everything)
            for block in (rejected, everything):
                self.assertEqual((block["aws_account_id"], block["regions"]), ("111122223333", "sa-east-1"))

    def test_a_web_acl_is_read_by_its_exact_path_and_keeps_dropping_allowed_requests(self):
        entries = [web_acl(), web_acl("loja_2", scope="cloudfront"), web_acl("api", prefix="central/waf")]
        with Run(listed(account_v2(s3=entries))) as run:
            found = blocks(run.ossec_conf, "bucket")
            self.assertEqual(
                [block["path"] for block in found],
                [
                    # O caminho do log nativo do WAF no S3, derivado do código do módulo (não conferido com objetos de
                    # verdade): este teste fixa o que o gerador escreve.
                    "AWSLogs/111122223333/WAFLogs/cloudfront/loja_2/",
                    "AWSLogs/111122223333/WAFLogs/sa-east-1/painel/",
                    "central/waf/AWSLogs/111122223333/WAFLogs/sa-east-1/api/",
                ],
            )
            for block in found:
                self.assertEqual(block["discard_regex"], 'field="action" ALLOW')
                # O tipo `waf` do módulo ignora a conta e as regiões: tudo está no caminho.
                self.assertNotIn("aws_account_id", block)
                self.assertNotIn("regions", block)

    def test_a_guardduty_export_and_a_custom_prefix(self):
        entries = [findings(), trail(bucket="trilha-central", prefix="contas/producao")]
        with Run(listed(account_v2(s3=entries))) as run:
            first, second = blocks(run.ossec_conf, "bucket")
            self.assertEqual((first["type"], first["path"]), ("cloudtrail", "contas/producao/"))
            self.assertEqual((second["type"], second["aws_account_id"], second["regions"]),
                             ("guardduty", "111122223333", "sa-east-1"))
            self.assertNotIn("path", second)

    def test_log_groups_per_account_region_and_start_date(self):
        account = account_v2(log_groups=[
            groups("/aws/lambda/b", "/aws/lambda/a"),
            groups("/aws/rds/instance/banco/postgresql", after="2026-NOV-25"),
            groups("/aws/route53/exemplo.com.br", region="us-east-1"),
        ])
        other = account_v2("444455556666", "us-east-1", log_groups=[groups("/aws/eks/producao/cluster")])
        with Run(listed(other, account)) as run:
            self.assertEqual(run.code, 0, run.stderr)
            self.assertEqual(
                [
                    (block["aws_profile"], block["regions"], block["only_logs_after"], block["aws_log_groups"])
                    for block in blocks(run.ossec_conf, "service")
                ],
                [
                    ("verax-111122223333", "sa-east-1", "2026-NOV-20", "/aws/lambda/a,/aws/lambda/b"),
                    ("verax-111122223333", "sa-east-1", "2026-NOV-25", "/aws/rds/instance/banco/postgresql"),
                    ("verax-111122223333", "us-east-1", "2026-NOV-20", "/aws/route53/exemplo.com.br"),
                    ("verax-444455556666", "sa-east-1", "2026-NOV-20", "/aws/eks/producao/cluster"),
                ],
            )
            for block in blocks(run.ossec_conf, "service"):
                self.assertEqual(block["type"], "cloudwatchlogs")
                # Uma linha de log que se diz evento do módulo não vira alerta de bucket.
                self.assertEqual(block["discard_regex"], 'field="integration" ^aws$')
            # Só com grupos de logs, a conta também tem o profile dela.
            self.assertIn("[profile verax-444455556666]", run.aws_config)

    def test_long_log_group_lists_are_split_below_the_xml_limit_of_the_manager(self):
        names = [f"/aws/lambda/{'g' * 480}-{index:02d}" for index in range(render.MAX_LOG_GROUPS)]
        with Run(listed(account_v2(log_groups=[groups(*names)]))) as run:
            self.assertEqual(run.code, 0, run.stderr)
            services = blocks(run.ossec_conf, "service")
            self.assertGreater(len(services), 1)
            read = []
            for block in services:
                self.assertLessEqual(len(block["aws_log_groups"]), render.MAX_LOG_GROUPS_TEXT)
                read += block["aws_log_groups"].split(",")
            self.assertEqual(read, sorted(names))
            # O leitor de XML do Wazuh recusa o arquivo inteiro com um elemento de 20480 caracteres ou mais.
            self.assertLess(max(len(text) for text in re.findall(r">([^<]*)<", run.ossec_conf)), 20480)

    def test_the_order_of_the_list_does_not_change_the_config(self):
        entries = [trail(), flow(), findings(), web_acl(), legacy("cloudtrail", "trilha-antiga")]
        first = listed(account_v2(s3=entries, log_groups=[groups("/aws/a"), groups("/aws/b", after="2026-NOV-21")]),
                       account_v2("444455556666", "us-east-1", s3=[trail(bucket="outra-trilha")]))
        second = listed(account_v2("444455556666", "us-east-1", s3=[trail(bucket="outra-trilha")]),
                        account_v2(s3=entries[::-1],
                                   log_groups=[groups("/aws/b", after="2026-NOV-21"), groups("/aws/a")]))
        with Run(first) as one, Run(second) as two:
            self.assertEqual(one.code, 0, one.stderr)
            self.assertEqual(one.ossec_conf, two.ossec_conf)
            self.assertEqual(one.stdout, two.stdout)

    def test_a_new_source_changes_the_hash_and_a_repeated_read_does_not(self):
        with Run(listed(account_v2(s3=[flow()]))) as first:
            with Run(listed(account_v2(s3=[flow(), trail()]))) as added:
                self.assertNotEqual(first.stdout, added.stdout)
            # Outro flow log da mesma região no mesmo bucket é a mesma leitura: o manager nem reinicia.
            with Run(listed(account_v2(s3=[flow(), flow()]))) as repeated:
                self.assertEqual(first.stdout, repeated.stdout)


class ReadDedupeTest(unittest.TestCase):
    """A mesma leitura vinda de duas fontes sai uma vez só: nenhum evento entra duas vezes."""

    def test_identical_reads_are_merged_from_the_earliest_date(self):
        entries = [
            flow(regions=("sa-east-1",), after="2026-NOV-22"),
            flow(regions=("sa-east-1", "us-east-1"), after="2026-NOV-20"),
            flow(regions=("us-east-1",), after="2026-NOV-25", traffic="all"),
        ]
        with Run(listed(account_v2(s3=entries))) as run:
            found = blocks(run.ossec_conf, "bucket")
            self.assertEqual(
                [(block["regions"], block["only_logs_after"], "discard_regex" in block) for block in found],
                # us-east-1: a data mais antiga das duas fontes e, como uma pede tudo, sem o descarte.
                [("us-east-1", "2026-NOV-20", False), ("sa-east-1", "2026-NOV-20", True)],
            )

    def test_regions_with_the_same_date_share_one_block(self):
        entries = [trail(regions=("sa-east-1",)), trail(regions=("us-east-1", "eu-west-1"))]
        with Run(listed(account_v2(s3=entries))) as run:
            [block] = blocks(run.ossec_conf, "bucket")
            self.assertEqual(block["regions"], "eu-west-1,sa-east-1,us-east-1")

    def test_the_same_bucket_in_two_accounts_is_read_per_account_folder(self):
        shared = {"bucket": "trilha-da-organizacao", "organizationId": "o-exemplo1234"}
        with Run(listed(account_v2(s3=[trail(**shared)]),
                        account_v2("444455556666", "us-east-1", s3=[trail(**shared)]))) as run:
            self.assertEqual(
                [(block["aws_profile"], block["aws_account_id"]) for block in blocks(run.ossec_conf, "bucket")],
                [("verax-111122223333", "111122223333"), ("verax-444455556666", "444455556666")],
            )

    def test_a_read_already_done_by_the_legacy_bucket_is_not_repeated(self):
        entries = [
            legacy("cloudtrail", "trilha-antiga"),
            legacy("guardduty", "achados-antigos"),
            # A mesma pasta da conta que o cadastro anterior já lê, e o bucket que ele lê inteiro.
            trail(bucket="trilha-antiga"),
            findings(bucket="achados-antigos"),
            # Com prefixo ou com a organização, é outra pasta: sai.
            trail(bucket="trilha-antiga", organizationId="o-exemplo1234"),
            findings(bucket="achados-antigos", prefix="exportados"),
        ]
        # O bucket do GuardDuty do cadastro anterior de uma conta também cobre a pasta de outra conta nele.
        member = account_v2("444455556666", "us-east-1", s3=[findings(bucket="achados-antigos"), trail("trilha-antiga")])
        with Run(listed(account_v2(s3=entries), member)) as run:
            self.assertEqual(run.code, 0, run.stderr)
            self.assertEqual(
                [(block["type"], block["name"], block["aws_profile"], block.get("aws_organization_id"),
                  block.get("path"), block.get("regions")) for block in blocks(run.ossec_conf, "bucket")],
                [
                    ("cloudtrail", "trilha-antiga", "verax-111122223333", None, None, None),
                    ("guardduty", "achados-antigos", "verax-111122223333", None, None, None),
                    ("cloudtrail", "trilha-antiga", "verax-111122223333", "o-exemplo1234", None, "sa-east-1"),
                    ("guardduty", "achados-antigos", "verax-111122223333", None, "exportados/", "sa-east-1"),
                    # A outra conta lê a pasta dela na trilha (o cadastro anterior só lê a da primeira).
                    ("cloudtrail", "trilha-antiga", "verax-444455556666", None, None, "sa-east-1"),
                ],
            )

    def test_the_same_web_acl_twice_is_one_read(self):
        with Run(listed(account_v2(s3=[web_acl(after="2026-NOV-25"), web_acl(after="2026-NOV-21")]))) as run:
            [block] = blocks(run.ossec_conf, "bucket")
            self.assertEqual(block["only_logs_after"], "2026-NOV-21")


class InvalidSourceListTest(unittest.TestCase):
    """Qualquer valor fora da lista fechada do tipo dele recusa a lista inteira, e nada é escrito."""

    @staticmethod
    def with_entry(entry):
        return listed(account_v2(s3=[entry]))

    @staticmethod
    def with_groups(*entries):
        return listed(account_v2(log_groups=entries))

    def cases(self):
        many_groups = [f"/aws/lambda/funcao-{index}" for index in range(render.MAX_LOG_GROUPS + 1)]
        many_entries = [trail(bucket=f"trilha-{index:03d}") for index in range(render.MAX_S3_ENTRIES + 1)]
        return {
            "versão desconhecida": {"version": 3, "accounts": []},
            "versão como texto": {"version": "2", "accounts": []},
            "versão booleana": {"version": True, "accounts": []},
            "sem a versão": {"accounts": []},
            "campo a mais na raiz": {"version": 2, "accounts": [], "roleArn": "arn:aws:iam::111122223333:role/Admin"},
            "contas que não são lista": {"version": 2, "accounts": {}},
            "conta sem fonte": listed(account_v2()),
            "conta repetida": listed(account_v2(s3=[trail()]), account_v2(s3=[flow()])),
            "campo a mais na conta": listed({**account_v2(s3=[trail()]), "profile": "default"}),
            "contas demais": listed(*[account_v2(f"{n:012d}", s3=[trail()]) for n in range(101)]),
            "tipo de bucket desconhecido": self.with_entry(trail(type="custom")),
            "tipo que o módulo tem e a Verax não coleta": self.with_entry(trail(type="server_access")),
            "sem as regiões": self.with_entry({"type": "cloudtrail", "bucket": "trilha", "onlyLogsAfter": "2026-NOV-20"}),
            "regiões vazias": self.with_entry(trail(regions=())),
            "regiões como texto": self.with_entry({**trail(), "regions": "sa-east-1"}),
            "região repetida": self.with_entry(trail(regions=("sa-east-1", "sa-east-1"))),
            "região que o módulo não aceita": self.with_entry(trail(regions=("sa-east-1", "ap-southeast-6"))),
            "região de outra partição": self.with_entry(trail(regions=("cn-north-1",))),
            "XML numa região": self.with_entry(trail(regions=("sa-east-1</regions><remove_from_bucket>yes",))),
            "vírgula numa região": self.with_entry(trail(regions=("sa-east-1,us-east-1",))),
            "organização fora do formato": self.with_entry(trail(organizationId="o-ABC")),
            "XML na organização": self.with_entry(trail(organizationId="o-exemplo1234</aws_organization_id><x>")),
            "organização nos flow logs": self.with_entry(flow(organizationId="o-exemplo1234")),
            "prefixo com barra no começo": self.with_entry(trail(prefix="/central")),
            "prefixo com barra no fim": self.with_entry(trail(prefix="central/")),
            "prefixo que sobe de pasta": self.with_entry(trail(prefix="central/../outra")),
            "prefixo com XML": self.with_entry(trail(prefix="central</path><remove_from_bucket>yes")),
            "prefixo com espaço": self.with_entry(trail(prefix="minha pasta")),
            "prefixo longo demais": self.with_entry(trail(prefix="/".join(["p" * 64] * 5))),
            "apagar o que leu": self.with_entry(trail(removeFromBucket="yes")),
            "escolher o papel": self.with_entry(trail(iamRoleArn="arn:aws:iam::111122223333:role/Admin")),
            "flow logs sem o tráfego": self.with_entry({k: v for k, v in flow().items() if k != "traffic"}),
            "tráfego desconhecido": self.with_entry(flow(traffic="accepted")),
            "tráfego na trilha": self.with_entry(trail(traffic="all")),
            "WAF sem a Web ACL": self.with_entry({k: v for k, v in web_acl().items() if k != "webAcl"}),
            "Web ACL com barra (outro caminho)": self.with_entry(web_acl("painel/../../outro")),
            "Web ACL com XML": self.with_entry(web_acl("painel</path><remove_from_bucket>yes")),
            "Web ACL com espaço": self.with_entry(web_acl("meu painel")),
            "escopo que não é região": self.with_entry(web_acl(scope="global")),
            "escopo com barra": self.with_entry(web_acl(scope="sa-east-1/outro")),
            "WAF com regiões": self.with_entry(web_acl(regions=["sa-east-1"])),
            "bucket do WAF sem o prefixo": self.with_entry(web_acl(bucket="logs-do-waf")),
            "bucket com XML": self.with_entry(trail(bucket="x</name><name>outro")),
            "bucket com quebra de linha no fim": self.with_entry(trail(bucket="trilha\n")),
            "data fora do formato": self.with_entry(trail(after="2026-11-20")),
            "data com quebra de linha no fim": self.with_entry(trail(after="2026-NOV-20\n")),
            "legacy falso": self.with_entry({**legacy("cloudtrail", "trilha"), "legacy": False}),
            "legacy como texto": self.with_entry({**legacy("cloudtrail", "trilha"), "legacy": "true"}),
            "legacy num tipo que o cadastro não tem": self.with_entry(legacy("vpcflow", "fluxo")),
            "legacy com regiões": self.with_entry({**legacy("cloudtrail", "trilha"), "regions": ["sa-east-1"]}),
            "dois buckets do cadastro do mesmo tipo": listed(
                account_v2(s3=[legacy("cloudtrail", "trilha-a"), legacy("cloudtrail", "trilha-b")])
            ),
            "entradas de bucket demais": listed(account_v2(s3=many_entries)),
            "entrada que não é objeto": listed(account_v2(s3=["trilha"])),
            "s3 que não é lista": listed({**account_v2(), "s3": {"type": "cloudtrail"}}),
            "grupo com vírgula (dois grupos num nome)": self.with_groups(groups("/aws/a,/aws/b")),
            "grupo com cerquilha (o módulo recusa o argumento)": self.with_groups(groups("/aws/lambda/fila#1")),
            "grupo com XML": self.with_groups(groups("/aws/a</aws_log_groups><remove_log_streams>yes")),
            "grupo com espaço": self.with_groups(groups("meu grupo")),
            "grupo com quebra de linha": self.with_groups(groups("/aws/a\n/aws/b")),
            "grupo vazio": self.with_groups(groups("")),
            "grupo longo demais": self.with_groups(groups("/" + "g" * 512)),
            "sem grupo nenhum": self.with_groups(groups()),
            "grupo repetido na conta": self.with_groups(groups("/aws/a"), groups("/aws/a", after="2026-NOV-25")),
            "grupos demais": self.with_groups(groups(*many_groups)),
            "região dos grupos que o módulo não aceita": self.with_groups(groups("/aws/a", region="ap-southeast-6")),
            "apagar os streams": self.with_groups({**groups("/aws/a"), "removeLogStreams": "yes"}),
            "o mesmo grupo e região em duas contas": listed(
                account_v2(log_groups=[groups("/aws/lambda/cobranca")]),
                account_v2("444455556666", "us-east-1", log_groups=[groups("/aws/lambda/cobranca")]),
            ),
        }

    def test_invalid_lists_fail_without_writing(self):
        for label, sources in self.cases().items():
            with self.subTest(label), Run(sources) as run:
                self.assertEqual(run.code, 1)
                self.assertIn("ERRO", run.stderr)
                self.assertEqual(run.stdout, "")
                self.assertFalse(run.config_dir.exists())
                self.assertFalse(run.aws_dir.exists())

    def test_a_refused_list_leaves_the_current_config_as_it_is(self):
        with tempfile.TemporaryDirectory() as root:
            with Run(listed(account_v2(s3=[trail()])), root=root) as first:
                conf, profiles = first.ossec_conf, first.aws_config
            bad = listed(account_v2(s3=[trail()]), account_v2("444455556666", "us-east-1", s3=[web_acl("a b")]))
            with Run(bad, root=root) as second:
                self.assertEqual(second.code, 1)
                # Um valor recusado numa conta recusa a lista inteira: a outra conta também fica como estava.
                self.assertEqual((second.ossec_conf, second.aws_config), (conf, profiles))
                self.assertFalse((second.config_dir / ".prev").exists())

    def test_the_same_group_name_in_another_region_or_at_the_limit_is_accepted(self):
        names = [f"/aws/lambda/funcao-{index}" for index in range(render.MAX_LOG_GROUPS)]
        ok = listed(
            account_v2(log_groups=[groups(*names)]),
            account_v2("444455556666", "us-east-1", log_groups=[groups("/aws/lambda/funcao-0", region="us-east-1")]),
        )
        with Run(ok) as run:
            self.assertEqual(run.code, 0, run.stderr)
        entries = [trail(bucket=f"trilha-{index:03d}") for index in range(render.MAX_S3_ENTRIES)]
        with Run(listed(account_v2(s3=entries))) as run:
            self.assertEqual(run.code, 0, run.stderr)
            self.assertEqual(len(blocks(run.ossec_conf, "bucket")), render.MAX_S3_ENTRIES)

    def test_every_value_that_reaches_the_config_comes_from_a_closed_alphabet(self):
        """O que sai no ossec.conf, fora das etiquetas fixas, só tem os caracteres das listas fechadas de cada campo."""
        with Run(fixture("aws-sources.sample.v2.json")) as run:
            wodle = run.ossec_conf.split(BASE_CONF, 1)[1]
            values = re.findall(r"<(?:name|aws_profile|path|aws_organization_id|aws_account_id|regions|only_logs_after"
                                r"|aws_log_groups)>([^<]*)<", wodle)
            self.assertGreater(len(values), 40)
            for value in values:
                self.assertRegex(value, r"\A[A-Za-z0-9._/,-]+\Z")

    def test_the_regions_are_the_ones_of_the_module_in_the_image(self):
        # A lista de `aws_tools.ALL_REGIONS` do Wazuh 4.14.9: o scripts/test-aws-sources.sh confere com a imagem.
        self.assertEqual(len(render.WODLE_REGIONS), 35)
        self.assertEqual(len(set(render.WODLE_REGIONS)), 35)
        for region in render.WODLE_REGIONS:
            self.assertRegex(region, render.REGION)
            # O formato que o próprio módulo confere antes da lista dele.
            self.assertRegex(region, r"^([a-z]{2}(-gov)?)-([a-z]+)-\d$")


if __name__ == "__main__":
    unittest.main()
