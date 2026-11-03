"""Testes de segurança do template do conector.

Leem o template com o parser do cfn-lint (mesmo venv do CI, sem dependência nova) e conferem as propriedades que o
cliente aceita ao rodar o stack: o conector só cria o papel; só o papel do nó, com o ExternalId, pode assumi-lo; o
papel só lê, e só os logs que o cliente escolheu; e as ações que apagariam, desligariam ou desviariam logs ficam
negadas explicitamente.
"""

import fnmatch
import pathlib
import re
import unittest

from cfnlint.decode import cfn_yaml

TEMPLATE = pathlib.Path(__file__).resolve().parents[1] / "verax-control-connector.yaml"

# Verbos de leitura aceitos nas permissões do papel. Qualquer outro verbo faz o teste falhar.
READ_ACTION = re.compile(r"^[a-z0-9-]+:(Get|List|Describe|BatchGet|Search|GET)[A-Za-z0-9*]*$")
# Ações da política extra do Prowler que ficaram de fora de propósito (README).
EXCLUDED_ACTIONS = {
    "securityhub:BatchImportFindings",
    "ecr:BatchGetImage",
    "ecr:GetDownloadUrlForLayer",
    "logs:FilterLogEvents",
}
# Chamadas que o coletor da AWS do Wazuh 4.14 faz (wodles/aws: cloudwatchlogs, inspector e buckets S3).
WAZUH_CALLS = {
    "logs:DescribeLogStreams",
    "logs:GetLogEvents",
    "inspector2:ListFindings",
    "s3:ListBucket",
    "s3:GetObject",
}
# Ações que apagariam, desligariam ou desviariam logs, ou ampliariam o acesso do papel. Todas precisam estar negadas.
MUST_DENY = {
    "logs:DeleteLogGroup",
    "logs:DeleteLogStream",
    "logs:DeleteRetentionPolicy",
    "logs:PutRetentionPolicy",
    "logs:PutSubscriptionFilter",
    "logs:DeleteSubscriptionFilter",
    "logs:CreateExportTask",
    "logs:PutDataProtectionPolicy",
    "logs:Unmask",
    "s3:DeleteObject",
    "s3:DeleteObjectVersion",
    "s3:PutObject",
    "s3:PutLifecycleConfiguration",
    "s3:PutBucketPolicy",
    "s3:DeleteBucket",
    "s3:PutReplicationConfiguration",
    "cloudtrail:StopLogging",
    "cloudtrail:DeleteTrail",
    "cloudtrail:UpdateTrail",
    "cloudtrail:PutEventSelectors",
    "wafv2:PutLoggingConfiguration",
    "wafv2:DeleteLoggingConfiguration",
    "guardduty:DeletePublishingDestination",
    "guardduty:UpdatePublishingDestination",
    "guardduty:ArchiveFindings",
    "guardduty:DeleteDetector",
    "securityhub:BatchUpdateFindings",
    "securityhub:DisableSecurityHub",
    "inspector2:Disable",
    "kms:ScheduleKeyDeletion",
    "kms:DisableKey",
    "kms:PutKeyPolicy",
    "iam:PassRole",
    "iam:AttachRolePolicy",
    "iam:PutRolePolicy",
    "iam:UpdateAssumeRolePolicy",
    "sts:AssumeRole",
}


def as_list(value):
    return value if isinstance(value, list) else [value]


def matches(action, patterns):
    # Ações do IAM não diferenciam maiúsculas de minúsculas.
    return any(fnmatch.fnmatchcase(action.lower(), pattern.lower()) for pattern in patterns)


def statements(policy):
    """Declarações da política, com as condicionais (Fn::If) no ramo em que existem."""
    for item in policy["PolicyDocument"]["Statement"]:
        if "Fn::If" in item:
            _, when_true, when_false = item["Fn::If"]
            assert when_false == {"Ref": "AWS::NoValue"}, "o ramo falso de uma declaração deve ser NoValue"
            yield when_true
        else:
            yield item


def evaluate(expression, parameters):
    """Avalia Ref, Fn::Join e Fn::Split como o CloudFormation, para conferir os ARNs derivados das listas."""
    if isinstance(expression, str):
        return expression
    if isinstance(expression, list):
        return [evaluate(item, parameters) for item in expression]
    (function, argument), = expression.items()
    if function == "Ref":
        return parameters[argument]
    if function == "Fn::Join":
        delimiter, values = argument
        return delimiter.join(evaluate(values, parameters))
    if function == "Fn::Split":
        delimiter, value = argument
        return evaluate(value, parameters).split(delimiter)
    raise AssertionError(f"função não suportada: {function}")


class ConnectorTemplateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.template = cfn_yaml.load(str(TEMPLATE))
        cls.resources = cls.template["Resources"]
        cls.parameters = cls.template["Parameters"]

    def role(self):
        return self.resources["VeraxReadOnlyRole"]["Properties"]

    def all_statements(self):
        return [statement for policy in self.role()["Policies"] for statement in statements(policy)]

    def allowed_actions(self):
        return {
            action
            for statement in self.all_statements()
            if statement["Effect"] == "Allow"
            for action in as_list(statement["Action"])
        }

    def denied_patterns(self):
        return {
            action
            for statement in self.all_statements()
            if statement["Effect"] == "Deny"
            for action in as_list(statement["Action"])
        }

    def statement(self, sid):
        found = [s for s in self.all_statements() if s.get("Sid") == sid]
        self.assertEqual(len(found), 1, sid)
        return found[0]

    def assert_list_pattern(self, parameter, valid, invalid):
        pattern = re.compile(self.parameters[parameter]["AllowedPattern"])
        for value in ["", *valid]:
            self.assertTrue(pattern.fullmatch(value), f"{parameter} deveria aceitar {value!r}")
        for value in invalid:
            self.assertFalse(pattern.fullmatch(value), f"{parameter} deveria recusar {value!r}")

    # --- Nada além do papel ---

    def test_creates_only_the_read_role(self):
        self.assertEqual(set(self.resources), {"VeraxReadOnlyRole"})
        self.assertEqual(self.resources["VeraxReadOnlyRole"]["Type"], "AWS::IAM::Role")

    # --- Quem assume ---

    def test_only_the_node_role_with_external_id_can_assume(self):
        trust = self.role()["AssumeRolePolicyDocument"]["Statement"]
        self.assertEqual(len(trust), 1)
        statement = trust[0]
        self.assertEqual(statement["Effect"], "Allow")
        self.assertEqual(statement["Action"], "sts:AssumeRole")
        self.assertEqual(
            statement["Principal"], {"AWS": {"Fn::Sub": "arn:${AWS::Partition}:iam::${NodeAccountId}:root"}}
        )
        self.assertEqual(statement["Condition"]["StringEquals"], {"sts:ExternalId": {"Ref": "ExternalId"}})
        # O papel exato, sem curinga.
        self.assertEqual(
            statement["Condition"]["ArnEquals"],
            {"aws:PrincipalArn": {"Fn::Sub": "arn:${AWS::Partition}:iam::${NodeAccountId}:role/${NodeRoleName}"}},
        )

    def test_external_id_is_hidden_and_long(self):
        parameter = self.parameters["ExternalId"]
        self.assertTrue(parameter["NoEcho"])
        self.assertGreaterEqual(parameter["MinLength"], 32)
        self.assertNotIn("Default", parameter)

    def test_node_account_and_role_are_strict(self):
        self.assertEqual(self.parameters["NodeAccountId"]["AllowedPattern"], "^[0-9]{12}$")
        self.assertNotIn("Default", self.parameters["NodeAccountId"])
        role = re.compile(self.parameters["NodeRoleName"]["AllowedPattern"])
        self.assertTrue(role.fullmatch("verax-control-node"))
        self.assertTrue(role.fullmatch("verax-control-node-cliente"))
        for value in ["", "*", "verax-control-*", "admin", "verax-control-node*", "verax-control-node/x"]:
            self.assertFalse(role.fullmatch(value), value)
        self.assertLessEqual(len("verax-control-node") + 46, 64)

    def test_role_has_fixed_name_and_short_sessions(self):
        self.assertEqual(self.role()["RoleName"], "VeraxControlReadOnly")
        self.assertLessEqual(self.role()["MaxSessionDuration"], 3600)

    # --- O que lê ---

    def test_managed_policies_are_read_only(self):
        self.assertEqual(
            self.role()["ManagedPolicyArns"],
            [
                {"Fn::Sub": "arn:${AWS::Partition}:iam::aws:policy/SecurityAudit"},
                {"Fn::Sub": "arn:${AWS::Partition}:iam::aws:policy/job-function/ViewOnlyAccess"},
            ],
        )

    def test_allow_statements_only_read(self):
        for statement in self.all_statements():
            if statement["Effect"] != "Allow":
                continue
            with self.subTest(sid=statement["Sid"]):
                for action in as_list(statement["Action"]):
                    self.assertNotIn(action, EXCLUDED_ACTIONS)
                    if action == "kms:Decrypt":
                        # Só para ler os logs pelo S3, e só com as chaves informadas.
                        self.assertEqual(statement["Resource"], {"Ref": "LogKmsKeyArns"})
                        self.assertEqual(
                            statement["Condition"], {"StringLike": {"kms:ViaService": "s3.*.amazonaws.com"}}
                        )
                    else:
                        self.assertRegex(action, READ_ACTION)

    def test_log_content_only_from_the_chosen_sources(self):
        self.assertEqual(self.statement("ListarStreamsDosGruposDeLog")["Resource"], {"Ref": "LogGroupArns"})
        self.assertEqual(
            self.statement("LerGruposDeLog")["Resource"],
            {"Fn::Split": [",", {"Fn::Join": ["", [{"Fn::Join": [":*,", {"Ref": "LogGroupArns"}]}, ":*"]]}]},
        )
        self.assertEqual(self.statement("ListarBucketsDeLog")["Resource"], {"Ref": "LogBucketArns"})
        self.assertEqual(
            self.statement("LerObjetosDeLog")["Resource"],
            {"Fn::Split": [",", {"Fn::Join": ["", [{"Fn::Join": ["/*,", {"Ref": "LogBucketArns"}]}, "/*"]]}]},
        )
        # Nenhuma outra declaração lê conteúdo de log ou de objeto.
        content = {"logs:GetLogEvents", "logs:DescribeLogStreams", "s3:GetObject", "kms:Decrypt"}
        for statement in self.all_statements():
            if statement["Effect"] == "Allow" and statement["Sid"] not in {
                "ListarStreamsDosGruposDeLog",
                "LerGruposDeLog",
                "LerObjetosDeLog",
                "DecifrarLogsPeloS3",
            }:
                with self.subTest(sid=statement["Sid"]):
                    self.assertFalse(content & set(as_list(statement["Action"])))

    def test_derived_arns_cover_exactly_the_informed_sources(self):
        groups = [
            "arn:aws:logs:us-east-1:111122223333:log-group:aws-cloudtrail-logs",
            "arn:aws:logs:us-east-1:111122223333:log-group:/aws/vpc/flow-logs",
        ]
        buckets = ["arn:aws:s3:::empresa-cloudtrail", "arn:aws:s3:::empresa-findings"]
        for count in (1, 2):
            with self.subTest(count=count):
                parameters = {"LogGroupArns": groups[:count], "LogBucketArns": buckets[:count]}
                self.assertEqual(
                    evaluate(self.statement("LerGruposDeLog")["Resource"], parameters),
                    [f"{arn}:*" for arn in groups[:count]],
                )
                self.assertEqual(
                    evaluate(self.statement("LerObjetosDeLog")["Resource"], parameters),
                    [f"{arn}/*" for arn in buckets[:count]],
                )

    def test_source_statements_exist_only_when_informed(self):
        conditions = {}
        for policy in self.role()["Policies"]:
            for item in policy["PolicyDocument"]["Statement"]:
                if "Fn::If" in item:
                    conditions[item["Fn::If"][1]["Sid"]] = item["Fn::If"][0]
        self.assertEqual(
            conditions,
            {
                "ListarStreamsDosGruposDeLog": "ReadLogGroups",
                "LerGruposDeLog": "ReadLogGroups",
                "ListarBucketsDeLog": "ReadLogBuckets",
                "LerObjetosDeLog": "ReadLogBuckets",
                "DecifrarLogsPeloS3": "DecryptLogBuckets",
            },
        )
        for parameter in ("LogGroupArns", "LogBucketArns", "LogKmsKeyArns"):
            with self.subTest(parameter=parameter):
                self.assertEqual(self.parameters[parameter]["Type"], "CommaDelimitedList")
                self.assertEqual(self.parameters[parameter]["Default"], "")

    def test_source_parameters_accept_only_exact_arns(self):
        self.assert_list_pattern(
            "LogGroupArns",
            valid=[
                "arn:aws:logs:us-east-1:111122223333:log-group:aws-cloudtrail-logs-111122223333-abc",
                "arn:aws:logs:sa-east-1:111122223333:log-group:/aws/vpc/flow-logs",
                "arn:aws:logs:us-east-1:111122223333:log-group:aws-waf-logs-app",
            ],
            invalid=[
                "*",
                "arn:aws:logs:us-east-1:111122223333:log-group:*",
                "arn:aws:logs:us-east-1:111122223333:log-group:app:*",
                "arn:aws:logs:*:111122223333:log-group:app",
                "arn:aws:logs:us-east-1:*:log-group:app",
                "arn:aws:logs:us-east-1:111122223333:log-group:app*",
                "arn:aws:logs:us-east-1:111122223333:log-group:app:log-stream:x",
            ],
        )
        self.assert_list_pattern(
            "LogBucketArns",
            valid=["arn:aws:s3:::empresa-cloudtrail-logs", "arn:aws:s3:::findings.guardduty-1"],
            invalid=["*", "arn:aws:s3:::*", "arn:aws:s3:::bucket/*", "empresa-cloudtrail-logs", "arn:aws:s3:::a*"],
        )
        self.assert_list_pattern(
            "LogKmsKeyArns",
            valid=["arn:aws:kms:us-east-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab"],
            invalid=["*", "arn:aws:kms:us-east-1:111122223333:key/*", "arn:aws:kms:us-east-1:111122223333:alias/x"],
        )

    def test_wazuh_collector_calls_are_allowed(self):
        allowed = self.allowed_actions()
        self.assertTrue(WAZUH_CALLS <= allowed, WAZUH_CALLS - allowed)

    # --- O que nunca faz ---

    def test_log_destruction_and_escalation_are_explicitly_denied(self):
        denied = self.denied_patterns()
        missing = {action for action in MUST_DENY if not matches(action, denied)}
        self.assertFalse(missing, f"ações sem negação explícita: {sorted(missing)}")
        for statement in self.all_statements():
            if statement["Effect"] == "Deny":
                with self.subTest(sid=statement["Sid"]):
                    self.assertEqual(statement["Resource"], "*")
                    self.assertNotIn("Condition", statement)

    def test_no_allowed_action_is_cancelled_by_the_deny(self):
        denied = self.denied_patterns()
        clashes = {action for action in self.allowed_actions() if matches(action, denied)}
        self.assertFalse(clashes, f"ações liberadas e negadas ao mesmo tempo: {sorted(clashes)}")


if __name__ == "__main__":
    unittest.main()
