"""Testes de segurança do template do usuário de leitura (verax-control-reader).

Leem o template com o parser do cfn-lint (mesmo venv do CI, sem dependência nova) e conferem o que o cliente aceita ao
criar a pilha: só o usuário sem chave e sem senha, o grupo e as duas políticas (a trilha e o export do GuardDuty só se
pedidos); o usuário só lê, só a partir do IP do nó, e nunca altera logs nem o próprio acesso.

Além das conferências no texto do template, um avaliador mínimo de políticas do IAM monta a pilha com parâmetros
fictícios e decide cada chamada com as duas políticas juntas (negação explícita, permissão e limite de permissões). As
mutações conferem que os testes pegam o que deveriam: sem o Deny de IP, com uma chave, com GetObject em qualquer
recurso e sem o limite de permissões.
"""

import copy
import ipaddress
import json
import pathlib
import re
import unittest

from cfnlint.decode import cfn_yaml
from test_connector import MUST_DENY as CONNECTOR_MUST_DENY
from test_connector import READ_ACTION
from test_connector import WAZUH_CALLS as CONNECTOR_WAZUH_CALLS
from test_connector import as_list, matches

HERE = pathlib.Path(__file__).resolve().parents[1]
TEMPLATE = HERE / "verax-control-reader.yaml"
POLICY_JSON = HERE / "verax-control-reader.policy.json"
README = HERE / "README.md"
INSTALL_SH = HERE.parents[0] / "node" / "bin" / "install.sh"

ACCOUNT = "111111111111"
USER_ARN = f"arn:aws:iam::{ACCOUNT}:user/verax/verax-control-reader"
NODE_IP = "203.0.113.10"
OTHER_IP = "198.51.100.7"
KMS_KEY = f"arn:aws:kms:sa-east-1:{ACCOUNT}:key/00000000-0000-0000-0000-000000000000"
BUCKETS = [
    f"arn:aws:s3:::trilha-{ACCOUNT}",
    f"arn:aws:s3:::guardduty-{ACCOUNT}",
    f"arn:aws:s3:::aws-waf-logs-{ACCOUNT}",
]
# Os valores fictícios da política mínima do plano (seção 2.3), os mesmos do verax-control-reader.policy.json.
EXAMPLE = {
    "NodeEgressIps": f"{NODE_IP}/32",
    "LogBucketArns": ",".join(BUCKETS),
    "LogKmsKeyArns": KMS_KEY,
}

# Chamadas do módulo aws-s3 do Wazuh: o subconjunto S3 das do conector, mais o GetBucketLocation (conferido no módulo
# 4.14.9) e o kms:Decrypt dos objetos com SSE-KMS (obrigatório no export do GuardDuty).
WAZUH_CALLS = {action for action in CONNECTOR_WAZUH_CALLS if action.startswith("s3:")} | {
    "s3:GetBucketLocation",
    "kms:Decrypt",
}
# Ativos e Postura (PR-14' e PR-15'): as chamadas do inventário de hoje (apps/api/src/inventory/collectors.ts) e as da
# postura nativa.
POSTURE_CALLS = {
    "iam:GetAccountSummary",
    "iam:GetAccountPasswordPolicy",
    "iam:ListUsers",
    "iam:ListAccessKeys",
    "iam:GetAccessKeyLastUsed",
    "iam:ListMFADevices",
    "iam:GetLoginProfile",
    "ec2:DescribeRegions",
    "ec2:DescribeInstances",
    "ec2:DescribeSecurityGroups",
    "ec2:GetEbsEncryptionByDefault",
    "s3:ListAllMyBuckets",
    "s3:GetBucketAcl",
    "s3:GetBucketPolicyStatus",
    "s3:GetBucketPublicAccessBlock",
    "s3:GetAccountPublicAccessBlock",
}
# Conferência da chave colada (PR-V3) e das fontes (PR-V5). O sts:GetCallerIdentity não passa por política.
VALIDATION_CALLS = {
    "iam:SimulatePrincipalPolicy",
    "iam:ListAccessKeys",
    "cloudtrail:DescribeTrails",
    "cloudtrail:GetTrailStatus",
    "guardduty:ListDetectors",
    "guardduty:GetDetector",
    "guardduty:ListPublishingDestinations",
    "guardduty:DescribePublishingDestination",
}
# O que o usuário nunca faz, nem do IP do nó: o mesmo do conector, mais mexer no próprio usuário e na própria chave
# (sem autorrevogação, D-12), no WAF, na trilha e no export.
MUST_DENY = CONNECTOR_MUST_DENY | {
    "iam:CreateAccessKey",
    "iam:DeleteAccessKey",
    "iam:UpdateAccessKey",
    "iam:CreateLoginProfile",
    "iam:UpdateLoginProfile",
    "iam:CreateUser",
    "iam:AttachUserPolicy",
    "iam:PutUserPolicy",
    "iam:PutUserPermissionsBoundary",
    "iam:DeleteUserPermissionsBoundary",
    "iam:AddUserToGroup",
    "iam:RemoveUserFromGroup",
    "iam:AttachGroupPolicy",
    "iam:CreatePolicyVersion",
    "iam:SetDefaultPolicyVersion",
    "sts:GetFederationToken",
    "wafv2:UpdateWebACL",
    "wafv2:DeleteWebACL",
    "cloudtrail:CreateTrail",
    "guardduty:CreatePublishingDestination",
}
# Fora do limite de permissões: nem com uma política de administrador anexada ao usuário.
OUTSIDE_BOUNDARY = {
    "secretsmanager:GetSecretValue",
    "ssm:GetParameter",
    "ec2:RunInstances",
    "lambda:InvokeFunction",
    "dynamodb:Scan",
    "iam:GenerateCredentialReport",
    "iam:GetCredentialReport",
    "s3:GetObjectAcl",
    "kms:CreateGrant",
    "kms:Encrypt",
}
# Conteúdo de log: só nos recursos informados ou criados pela pilha, nunca em "*" nem num curinga que alcance um bucket
# ou uma chave qualquer (os ARNs abaixo).
CONTENT_ACTIONS = {"s3:GetObject", "s3:ListBucket", "kms:Decrypt"}
ANY_RESOURCE = (
    "arn:aws:s3:::bucket-qualquer",
    "arn:aws:s3:::bucket-qualquer/x",
    f"arn:aws:kms:sa-east-1:{ACCOUNT}:key/x",
)
# Tipos que dariam ao usuário chave, senha ou outra credencial.
CREDENTIAL_TYPES = {"AWS::IAM::AccessKey", "AWS::IAM::ServiceSpecificCredential", "AWS::IAM::UserPolicy"}
PSEUDO = {"AWS::Partition": "aws", "AWS::AccountId": ACCOUNT, "AWS::Region": "sa-east-1"}
NO_VALUE = object()


def wildcard(pattern, value):
    """Casamento de recurso e de condição do IAM: * vale qualquer sequência (inclusive / e :), ? vale um caractere."""
    regex = "".join(".*" if c == "*" else "." if c == "?" else re.escape(c) for c in pattern)
    return re.fullmatch(regex, value, re.DOTALL) is not None


def statements(document):
    """Declarações de uma política do template, com as condicionais (Fn::If) no ramo em que existem."""
    for item in document["Statement"]:
        if isinstance(item, dict) and "Fn::If" in item:
            _, when_true, when_false = item["Fn::If"]
            assert when_false == {"Ref": "AWS::NoValue"}, "o ramo falso de uma declaração deve ser NoValue"
            yield when_true
        else:
            yield item


def managed_policies(template):
    return {
        name: resource
        for name, resource in template["Resources"].items()
        if resource["Type"] == "AWS::IAM::ManagedPolicy"
    }


def all_statements(template):
    return [s for p in managed_policies(template).values() for s in statements(p["Properties"]["PolicyDocument"])]


def is_unconditional_deny(statement):
    return (
        statement["Effect"] == "Deny"
        and statement.get("Resource") == "*"
        and "NotResource" not in statement
        and "Condition" not in statement
    )


# --- Conferências no texto do template (também usadas nas mutações) ---


def problems_no_key_or_password(template):
    found = []
    for name, resource in template["Resources"].items():
        if resource["Type"] in CREDENTIAL_TYPES:
            found.append(f"{name}: {resource['Type']}")
        if resource["Type"] == "AWS::IAM::User" and "LoginProfile" in resource.get("Properties", {}):
            found.append(f"{name}: LoginProfile")
    for name, output in template.get("Outputs", {}).items():
        text = json.dumps(output)
        if "SecretAccessKey" in text or any(
            f'"{param}"' in text for param, spec in template["Parameters"].items() if spec.get("NoEcho")
        ):
            found.append(f"saída {name}")
    return found


def problems_ip_deny(template):
    found = []
    expected = {
        "Sid": "SoDoNoDaVerax",
        "Effect": "Deny",
        "Action": "*",
        "Resource": "*",
        "Condition": {"NotIpAddress": {"aws:SourceIp": {"Ref": "NodeEgressIps"}}},
    }
    guardrails = managed_policies(template).get("GuardrailsPolicy")
    if guardrails is None or expected not in guardrails["Properties"]["PolicyDocument"]["Statement"]:
        found.append("sem o Deny incondicional de fora do IP do nó")
    parameter = template["Parameters"].get("NodeEgressIps", {})
    if "Default" in parameter or not parameter.get("AllowedPattern", "").endswith("/32$"):
        found.append("NodeEgressIps sem /32 obrigatório")
    group = template["Resources"].get("ReadersGroup", {}).get("Properties", {})
    if {"Ref": "GuardrailsPolicy"} not in group.get("ManagedPolicyArns", []):
        found.append("negações fora do grupo")
    return found


def problems_read_only(template):
    found = []
    own_user = {"Fn::Sub": "arn:${AWS::Partition}:iam::${AWS::AccountId}:user/verax/verax-control-reader"}
    for statement in all_statements(template):
        if statement["Effect"] != "Allow":
            continue
        sid = statement.get("Sid")
        if "NotAction" in statement or "NotResource" in statement:
            found.append(f"{sid}: NotAction ou NotResource num Allow")
            continue
        resources = as_list(statement["Resource"])
        for action in as_list(statement["Action"]):
            if action == "kms:Decrypt":
                service = statement.get("Condition", {})
                via = service.get("StringLike", service.get("StringEquals", {})).get("kms:ViaService")
                if via not in ("s3.*.amazonaws.com", {"Fn::Sub": "s3.${AWS::Region}.amazonaws.com"}):
                    found.append(f"{sid}: kms:Decrypt fora do S3")
            elif action == "iam:SimulatePrincipalPolicy":
                if statement["Resource"] != own_user:
                    found.append(f"{sid}: simulação de outro principal")
            elif not READ_ACTION.match(action):
                found.append(f"{sid}: {action} não é leitura")
            if action in CONTENT_ACTIONS and any(
                isinstance(r, str) and any(wildcard(r, probe) for probe in ANY_RESOURCE) for r in resources
            ):
                found.append(f"{sid}: {action} em qualquer recurso")
    return found


def problems_boundary(template):
    found = []
    user = template["Resources"].get("ReaderUser", {}).get("Properties", {})
    if user.get("PermissionsBoundary") != {"Ref": "ReaderPolicy"}:
        found.append("usuário sem o limite de permissões da política de leitura")
    if user.get("Groups") != [{"Ref": "ReadersGroup"}]:
        found.append("usuário fora do grupo, ou em outro grupo")
    for key in ("Policies", "ManagedPolicyArns"):
        if key in user:
            found.append(f"usuário com {key} próprio")
    return found


# --- A pilha montada com parâmetros fictícios e o avaliador de políticas ---


class Stack:
    """O template avaliado como o CloudFormation, com os parâmetros dados (padrões nos demais)."""

    def __init__(self, template, **values):
        self.template = template
        self.params = {}
        for name, spec in template["Parameters"].items():
            raw = values.pop(name, spec.get("Default"))
            if raw is None:
                raise ValueError(f"parâmetro obrigatório sem valor: {name}")
            raw = str(raw)
            items = [item.strip() for item in raw.split(",")] if spec["Type"] == "CommaDelimitedList" else [raw]
            for item in items:
                if "AllowedPattern" in spec and not re.fullmatch(spec["AllowedPattern"], item):
                    raise ValueError(f"{name} recusa {item!r}")
                if "AllowedValues" in spec and item not in spec["AllowedValues"]:
                    raise ValueError(f"{name} recusa {item!r}")
            self.params[name] = items if spec["Type"] == "CommaDelimitedList" else raw
        if values:
            raise ValueError(f"parâmetros desconhecidos: {sorted(values)}")
        for name, rule in template.get("Rules", {}).items():
            if "RuleCondition" in rule and not self.resolve(rule["RuleCondition"]):
                continue
            for assertion in rule["Assertions"]:
                if not self.resolve(assertion["Assert"]):
                    raise ValueError(f"regra {name}: {assertion['AssertDescription']}")
        self.conditions = {name: self.resolve(expr) for name, expr in template.get("Conditions", {}).items()}
        self.resources = {
            name: resource
            for name, resource in template["Resources"].items()
            if "Condition" not in resource or self.conditions[resource["Condition"]]
        }

    def resolve(self, node):
        if isinstance(node, list):
            return [value for value in (self.resolve(item) for item in node) if value is not NO_VALUE]
        if not isinstance(node, dict):
            return node
        if len(node) == 1:
            ((function, argument),) = node.items()
            if function == "Ref":
                return self.ref(argument)
            if function == "Condition":
                return self.conditions[argument] if hasattr(self, "conditions") else self.condition(argument)
            if function.startswith("Fn::"):
                return self.function(function, argument)
        resolved = {key: self.resolve(value) for key, value in node.items()}
        return {key: value for key, value in resolved.items() if value is not NO_VALUE}

    def condition(self, name):
        return self.resolve(self.template["Conditions"][name])

    def function(self, function, argument):
        if function == "Fn::If":
            name, when_true, when_false = argument
            return self.resolve(when_true if self.conditions[name] else when_false)
        if function == "Fn::Join":
            delimiter, values = argument
            return delimiter.join(self.resolve(values))
        if function == "Fn::Split":
            delimiter, value = argument
            return self.resolve(value).split(delimiter)
        if function == "Fn::Sub":
            return re.sub(r"\$\{([^}]+)\}", lambda m: self.substitute(m.group(1)), argument)
        if function == "Fn::GetAtt":
            return self.attribute(*argument)
        if function == "Fn::Equals":
            left, right = self.resolve(argument)
            return left == right
        if function == "Fn::Not":
            return not self.resolve(argument[0])
        if function == "Fn::And":
            return all(self.resolve(item) for item in argument)
        if function == "Fn::Or":
            return any(self.resolve(item) for item in argument)
        if function == "Fn::EachMemberIn":
            values, allowed = self.resolve(argument)
            return all(value in allowed for value in values)
        if function == "Fn::EachMemberEquals":
            values, expected = self.resolve(argument)
            return all(value == expected for value in values)
        if function == "Fn::Contains":
            values, expected = self.resolve(argument)
            return expected in values
        raise AssertionError(f"função sem suporte no teste: {function}")

    def substitute(self, name):
        if "." in name and not name.startswith("AWS::"):
            return self.attribute(*name.split(".", 1))
        return str(self.ref(name))

    def ref(self, name):
        if name == "AWS::NoValue":
            return NO_VALUE
        if name in PSEUDO:
            return PSEUDO[name]
        if name in self.params:
            return self.params[name]
        resource = self.live(name)
        props = resource.get("Properties", {})
        kind = resource["Type"]
        if kind == "AWS::IAM::ManagedPolicy":
            return f"arn:aws:iam::{ACCOUNT}:policy{props['Path']}{props['ManagedPolicyName']}"
        if kind in ("AWS::IAM::Group", "AWS::IAM::User", "AWS::S3::Bucket"):
            key = {"AWS::IAM::Group": "GroupName", "AWS::IAM::User": "UserName", "AWS::S3::Bucket": "BucketName"}
            return self.resolve(props[key[kind]])
        if kind == "AWS::KMS::Key":
            return "11111111-2222-3333-4444-555555555555"
        return name

    def attribute(self, name, attribute):
        resource = self.live(name)
        assert attribute == "Arn", attribute
        kind = resource["Type"]
        if kind == "AWS::S3::Bucket":
            return f"arn:aws:s3:::{self.ref(name)}"
        if kind == "AWS::KMS::Key":
            return f"arn:aws:kms:sa-east-1:{ACCOUNT}:key/{self.ref(name)}"
        if kind == "AWS::IAM::User":
            path = resource["Properties"]["Path"]
            return f"arn:aws:iam::{ACCOUNT}:user{path}{self.ref(name)}"
        raise AssertionError(f"atributo sem suporte no teste: {name}.{attribute}")

    def live(self, name):
        resource = self.template["Resources"][name]
        if hasattr(self, "resources") and name not in self.resources:
            raise AssertionError(f"referência a recurso que não existe nesta combinação: {name}")
        return resource

    def properties(self, name):
        return self.resolve(self.resources[name].get("Properties", {}))

    def policy_document(self, name):
        return self.properties(name)["PolicyDocument"]

    def documents_by_arn(self):
        return {
            self.ref(name): self.policy_document(name)
            for name, resource in self.resources.items()
            if resource["Type"] == "AWS::IAM::ManagedPolicy"
        }

    def user_policies(self, extra=()):
        """As políticas do usuário (grupos, anexadas e em linha) e o limite de permissões."""
        documents = self.documents_by_arn()
        user = self.properties("ReaderUser")
        groups = {
            self.ref(name): self.properties(name)
            for name, resource in self.resources.items()
            if resource["Type"] == "AWS::IAM::Group"
        }
        identity = [documents[arn] for group in user.get("Groups", []) for arn in groups[group]["ManagedPolicyArns"]]
        identity += [documents[arn] for arn in user.get("ManagedPolicyArns", [])]
        identity += [policy["PolicyDocument"] for policy in user.get("Policies", [])]
        identity += list(extra)
        boundary = documents.get(user["PermissionsBoundary"]) if "PermissionsBoundary" in user else None
        return identity, boundary

    def allows(self, action, resource="*", source_ip=NODE_IP, extra=(), **context):
        """Decide a chamada do usuário. As chaves do contexto vêm com _ no lugar do primeiro : (kms_ViaService)."""
        context = {"aws:SourceIp": source_ip, **{key.replace("_", ":", 1): value for key, value in context.items()}}
        identity, boundary = self.user_policies(extra)
        return decide(identity, boundary, action, resource, context)


def applies(statement, action, resource, context):
    if not matches(action, as_list(statement["Action"])):
        return False
    if "Resource" in statement and not any(wildcard(r, resource) for r in as_list(statement["Resource"])):
        return False
    if "NotResource" in statement and any(wildcard(r, resource) for r in as_list(statement["NotResource"])):
        return False
    for operator, entries in statement.get("Condition", {}).items():
        for key, expected in entries.items():
            if not holds(operator, context.get(key), as_list(expected)):
                return False
    return True


def holds(operator, value, expected):
    if operator == "NotIpAddress":
        # Operador negado: sem a chave no pedido, a condição vale (e a negação se aplica).
        return value is None or not any(ipaddress.ip_address(value) in ipaddress.ip_network(c) for c in expected)
    if operator == "StringLike":
        return value is not None and any(wildcard(pattern, value) for pattern in expected)
    if operator == "StringEquals":
        return value is not None and value in expected
    if operator == "DateLessThan":
        # ISO 8601 em UTC com o mesmo formato: a ordem do texto é a do tempo.
        return value is not None and any(value < limit for limit in expected)
    raise AssertionError(f"operador sem suporte no teste: {operator}")


def decide(identity, boundary, action, resource, context):
    """Negação explícita em qualquer política vence; senão, precisa de permissão na identidade e no limite."""
    every = [s for document in [*identity, *([boundary] if boundary else [])] for s in document["Statement"]]
    if any(s["Effect"] == "Deny" and applies(s, action, resource, context) for s in every):
        return False

    def allowed(documents):
        return any(
            s["Effect"] == "Allow" and applies(s, action, resource, context)
            for document in documents
            for s in document["Statement"]
        )

    return allowed(identity) and (boundary is None or allowed([boundary]))


ADMIN = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "*", "Resource": "*"}]}


def resource_for(action, bucket=BUCKETS[0]):
    """Um recurso plausível para cada chamada dos grupos."""
    if action == "s3:GetObject":
        return f"{bucket}/AWSLogs/{ACCOUNT}/CloudTrail/sa-east-1/2026/11/04/arquivo.json.gz"
    if action in {"s3:ListBucket", "s3:GetBucketLocation"}:
        return bucket
    if action == "kms:Decrypt":
        return KMS_KEY
    if action == "iam:SimulatePrincipalPolicy":
        return USER_ARN
    return "*"


class ReaderTemplateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.template = cfn_yaml.load(str(TEMPLATE))
        cls.resources = cls.template["Resources"]
        cls.parameters = cls.template["Parameters"]

    def stack(self, **values):
        return Stack(self.template, **{**EXAMPLE, **values})

    def statement(self, sid):
        found = [s for s in all_statements(self.template) if s.get("Sid") == sid]
        self.assertEqual(len(found), 1, sid)
        return found[0]

    def assert_pattern(self, parameter, valid, invalid):
        pattern = re.compile(self.parameters[parameter]["AllowedPattern"])
        for value in valid:
            self.assertTrue(pattern.fullmatch(value), f"{parameter} deveria aceitar {value!r}")
        for value in invalid:
            self.assertFalse(pattern.fullmatch(value), f"{parameter} deveria recusar {value!r}")

    # --- O que a pilha cria ---

    def test_by_default_only_the_user_the_group_and_the_two_policies(self):
        stack = Stack(self.template, NodeEgressIps=f"{NODE_IP}/32")
        self.assertEqual(set(stack.resources), {"ReaderPolicy", "GuardrailsPolicy", "ReadersGroup", "ReaderUser"})
        for name, resource in self.resources.items():
            if name not in stack.resources:
                with self.subTest(resource=name):
                    self.assertIn(resource["Condition"], {"CreatesTrail", "ExportsGuardDuty", "CreatesLogBucket"})
        self.assertEqual(self.parameters["CreateTrail"]["Default"], "false")
        self.assertEqual(self.parameters["EnableGuardDutyExport"]["Default"], "false")

    def test_no_access_key_password_or_secret_output(self):
        self.assertEqual(problems_no_key_or_password(self.template), [])
        self.assertEqual(
            set(self.template["Outputs"]),
            {"UserArn", "SecurityCredentialsUrl", "TrailBucketArn", "GuardDutyBucketArn", "LogsKeyArn"},
        )
        self.assertEqual(self.template["Outputs"]["UserArn"]["Value"], {"Fn::GetAtt": ["ReaderUser", "Arn"]})
        url = self.stack().resolve(self.template["Outputs"]["SecurityCredentialsUrl"]["Value"])
        self.assertEqual(
            url,
            "https://console.aws.amazon.com/iam/home#/users/details/verax-control-reader?section=security_credentials",
        )

    def test_user_group_and_policies_live_under_verax(self):
        self.assertEqual(problems_boundary(self.template), [])
        user = self.resources["ReaderUser"]["Properties"]
        self.assertEqual((user["UserName"], user["Path"]), ("verax-control-reader", "/verax/"))
        group = self.resources["ReadersGroup"]["Properties"]
        self.assertEqual((group["GroupName"], group["Path"]), ("VeraxControlReaders", "/verax/"))
        self.assertEqual(group["ManagedPolicyArns"], [{"Ref": "ReaderPolicy"}, {"Ref": "GuardrailsPolicy"}])
        names = {
            name: (resource["Properties"]["ManagedPolicyName"], resource["Properties"]["Path"])
            for name, resource in managed_policies(self.template).items()
        }
        self.assertEqual(
            names,
            {
                "ReaderPolicy": ("VeraxControlReader", "/verax/"),
                "GuardrailsPolicy": ("VeraxControlGuardrails", "/verax/"),
            },
        )
        self.assertEqual(self.stack().ref("ReaderUser"), "verax-control-reader")
        self.assertEqual(self.stack().attribute("ReaderUser", "Arn"), USER_ARN)

    def test_waf_is_never_touched_and_guardduty_is_never_enabled(self):
        types = {resource["Type"] for resource in self.resources.values()}
        self.assertFalse({t for t in types if t.startswith("AWS::WAF")})
        self.assertNotIn("AWS::GuardDuty::Detector", types)
        allowed = {a for s in all_statements(self.template) if s["Effect"] == "Allow" for a in as_list(s["Action"])}
        self.assertFalse({a for a in allowed if a.startswith("wafv2:")})

    # --- Parâmetros ---

    def test_node_egress_ips_are_required_and_only_slash_32(self):
        parameter = self.parameters["NodeEgressIps"]
        self.assertEqual(parameter["Type"], "CommaDelimitedList")
        self.assertNotIn("Default", parameter)
        self.assert_pattern(
            "NodeEgressIps",
            valid=["203.0.113.10/32", "192.0.2.1/32", "255.255.255.255/32", "10.0.0.1/32"],
            invalid=[
                "",
                "*",
                "203.0.113.10",
                "203.0.113.10/24",
                "203.0.113.10/31",
                "0.0.0.0/0",
                "203.0.113.256/32",
                "203.0.113.010/32",
                "2001:db8::1/128",
                "203.0.113.10/32,",
            ],
        )
        with self.assertRaisesRegex(ValueError, "obrigatório"):
            Stack(self.template)
        with self.assertRaisesRegex(ValueError, "NodeEgressIps"):
            Stack(self.template, NodeEgressIps="")
        # A regra também recusa a lista vazia, se o padrão do parâmetro deixar passar.
        rule = self.template["Rules"]["IpDoNoObrigatorio"]["Assertions"][0]["Assert"]
        stack = self.stack()
        self.assertTrue(stack.resolve(rule))
        for empty in ([""], []):
            with self.subTest(empty=empty):
                stack.params["NodeEgressIps"] = empty
                self.assertFalse(stack.resolve(rule))
        two = Stack(self.template, NodeEgressIps="203.0.113.10/32,198.51.100.20/32")
        self.assertTrue(two.allows("iam:ListUsers", source_ip="198.51.100.20"))

    def test_node_egress_ips_match_the_node_conf_check(self):
        # O install.sh confere o NODE_EGRESS_IPS com a mesma expressão: o IP que o nó aceita é o que a pilha aceita.
        octet = re.search(r"^octet='([^']+)'$", INSTALL_SH.read_text(encoding="utf-8"), re.MULTILINE).group(1)
        self.assertEqual(self.parameters["NodeEgressIps"]["AllowedPattern"], f"^{octet}(\\.{octet}){{3}}/32$")

    def test_log_sources_accept_only_exact_arns(self):
        self.assert_pattern(
            "LogBucketArns",
            valid=["", *BUCKETS, "arn:aws:s3:::findings.guardduty-1"],
            invalid=["*", "arn:aws:s3:::*", "arn:aws:s3:::bucket/*", "trilha-111111111111", "arn:aws:s3:::a*"],
        )
        self.assert_pattern(
            "LogKmsKeyArns",
            valid=["", KMS_KEY],
            invalid=["*", f"arn:aws:kms:sa-east-1:{ACCOUNT}:key/*", f"arn:aws:kms:sa-east-1:{ACCOUNT}:alias/x"],
        )
        for parameter in ("LogBucketArns", "LogKmsKeyArns"):
            with self.subTest(parameter=parameter):
                self.assertEqual(self.parameters[parameter]["Type"], "CommaDelimitedList")
                self.assertEqual(self.parameters[parameter]["Default"], "")

    def test_object_prefixes_are_exact_and_end_with_a_slash(self):
        self.assertEqual(self.parameters["LogObjectPrefix"]["Type"], "CommaDelimitedList")
        self.assertEqual(self.parameters["LogObjectPrefix"]["Default"], "")
        self.assert_pattern(
            "LogObjectPrefix",
            valid=["", f"AWSLogs/{ACCOUNT}/", f"trilhas/AWSLogs/o-exemplo123/{ACCOUNT}/"],
            invalid=[
                "*",
                "AWSLogs/*",
                f"AWSLogs/{ACCOUNT}",
                f"/AWSLogs/{ACCOUNT}/",
                "AWSLogs//",
                "${aws:username}/",
                "a b/",
                "AWSLogs/?/",
            ],
        )

    def test_lists_refuse_an_empty_item(self):
        # Uma vírgula sobrando num prefixo liberaria o bucket inteiro (arn:*:s3:::*/*).
        for parameter, value in (
            ("LogObjectPrefix", f"AWSLogs/{ACCOUNT}/,"),
            ("LogObjectPrefix", f",AWSLogs/{ACCOUNT}/"),
            ("LogBucketArns", f"{BUCKETS[0]},"),
            ("LogKmsKeyArns", f"{KMS_KEY},"),
        ):
            with self.subTest(parameter=parameter, value=value):
                with self.assertRaisesRegex(ValueError, f"ListasSemItemVazio: {parameter}"):
                    self.stack(**{parameter: value})
        self.stack(LogObjectPrefix=f"AWSLogs/{ACCOUNT}/,AWSLogs/o-exemplo123/{ACCOUNT}/")

    def test_session_revocation_takes_an_utc_instant(self):
        self.assertEqual(self.parameters["RevokeSessionsIssuedBefore"]["Default"], "")
        self.assert_pattern(
            "RevokeSessionsIssuedBefore",
            valid=["", "2026-11-04T18:00:00Z"],
            invalid=["2026-11-04", "2026-11-04T18:00:00", "2026-11-04T18:00:00-03:00", "2026-13-01T00:00:00Z", "*"],
        )

    def test_guardduty_export_requires_an_existing_detector(self):
        with self.assertRaisesRegex(ValueError, "ExportPrecisaDoDetector"):
            self.stack(EnableGuardDutyExport="true")
        stack = self.stack(EnableGuardDutyExport="true", GuardDutyDetectorId="a" * 32)
        self.assertEqual(stack.properties("GuardDutyExport")["DetectorId"], "a" * 32)
        self.assert_pattern("GuardDutyDetectorId", valid=["", "a" * 32], invalid=["*", "a" * 31, "A" * 32])

    # --- O que o usuário pode fazer ---

    def test_every_allow_only_reads(self):
        self.assertEqual(problems_read_only(self.template), [])

    def test_wazuh_posture_and_validation_calls_are_allowed_from_the_node(self):
        stack = self.stack()
        for group, calls in (("wazuh", WAZUH_CALLS), ("postura", POSTURE_CALLS), ("validação", VALIDATION_CALLS)):
            for action in sorted(calls):
                with self.subTest(group=group, action=action):
                    self.assertTrue(
                        stack.allows(action, resource_for(action), kms_ViaService="s3.sa-east-1.amazonaws.com")
                    )
        # Os três buckets e a chave informados, e nada além deles.
        for bucket in BUCKETS:
            with self.subTest(bucket=bucket):
                self.assertTrue(stack.allows("s3:GetObject", f"{bucket}/AWSLogs/{ACCOUNT}/x.json.gz"))
                self.assertTrue(stack.allows("s3:ListBucket", bucket))
        self.assertFalse(stack.allows("s3:GetObject", f"arn:aws:s3:::outro-bucket-{ACCOUNT}/x"))
        self.assertFalse(stack.allows("s3:ListBucket", f"arn:aws:s3:::outro-bucket-{ACCOUNT}"))
        other_key = KMS_KEY.replace("00000000-0000", "99999999-0000")
        self.assertFalse(stack.allows("kms:Decrypt", other_key, kms_ViaService="s3.sa-east-1.amazonaws.com"))
        # A chave só decifra pelo S3, e a simulação só vale para o próprio usuário.
        self.assertFalse(stack.allows("kms:Decrypt", KMS_KEY))
        self.assertFalse(stack.allows("kms:Decrypt", KMS_KEY, kms_ViaService="secretsmanager.sa-east-1.amazonaws.com"))
        self.assertFalse(stack.allows("iam:SimulatePrincipalPolicy", f"arn:aws:iam::{ACCOUNT}:user/admin"))

    def test_no_allowed_call_is_cancelled_by_an_unconditional_deny(self):
        denied = {a for s in all_statements(self.template) if is_unconditional_deny(s) for a in as_list(s["Action"])}
        allowed = {a for s in all_statements(self.template) if s["Effect"] == "Allow" for a in as_list(s["Action"])}
        clashes = {action for action in allowed if matches(action, denied)}
        self.assertFalse(clashes, f"ações liberadas e negadas ao mesmo tempo: {sorted(clashes)}")
        self.assertTrue(WAZUH_CALLS | POSTURE_CALLS | VALIDATION_CALLS <= allowed)

    def test_without_sources_nothing_of_log_content_is_readable(self):
        stack = Stack(self.template, NodeEgressIps=f"{NODE_IP}/32")
        for action in sorted(CONTENT_ACTIONS):
            with self.subTest(action=action):
                self.assertFalse(
                    stack.allows(action, resource_for(action), kms_ViaService="s3.sa-east-1.amazonaws.com")
                )
        self.assertTrue(stack.allows("iam:ListUsers"))

    def test_derived_object_arns_cover_exactly_the_informed_buckets(self):
        for count in (1, 2, 3):
            with self.subTest(count=count):
                stack = self.stack(LogBucketArns=",".join(BUCKETS[:count]))
                document = stack.policy_document("ReaderPolicy")
                by_sid = {s["Sid"]: s for s in document["Statement"]}
                self.assertEqual(by_sid["LerObjetosDeLog"]["Resource"], [f"{arn}/*" for arn in BUCKETS[:count]])
                self.assertEqual(by_sid["ListarBucketsDeLog"]["Resource"], BUCKETS[:count])

    # --- O que o usuário nunca faz ---

    def test_nothing_from_outside_the_node_ip(self):
        self.assertEqual(problems_ip_deny(self.template), [])
        stack = self.stack(CreateTrail="true", EnableGuardDutyExport="true", GuardDutyDetectorId="a" * 32)
        for action in sorted(WAZUH_CALLS | POSTURE_CALLS | VALIDATION_CALLS):
            with self.subTest(action=action):
                self.assertFalse(
                    stack.allows(
                        action, resource_for(action), source_ip=OTHER_IP, kms_ViaService="s3.sa-east-1.amazonaws.com"
                    )
                )
        # Uma faixa vizinha também fica de fora: o /32 é exato.
        self.assertFalse(stack.allows("iam:ListUsers", source_ip="203.0.113.11"))

    def test_log_destruction_and_escalation_are_denied_even_from_the_node(self):
        denied = {a for s in all_statements(self.template) if is_unconditional_deny(s) for a in as_list(s["Action"])}
        missing = {action for action in MUST_DENY if not matches(action, denied)}
        self.assertFalse(missing, f"ações sem negação explícita: {sorted(missing)}")
        # Com uma política de administrador anexada ao usuário, a negação continua valendo.
        stack = self.stack()
        for action in sorted(MUST_DENY):
            with self.subTest(action=action):
                self.assertFalse(stack.allows(action, USER_ARN, extra=[ADMIN]))

    def test_the_boundary_caps_any_policy_attached_later(self):
        stack = self.stack()
        for action in sorted(OUTSIDE_BOUNDARY):
            with self.subTest(action=action):
                self.assertFalse(stack.allows(action, "*", extra=[ADMIN]))
        self.assertFalse(stack.allows("s3:GetObject", f"arn:aws:s3:::outro-bucket-{ACCOUNT}/x", extra=[ADMIN]))
        # O que a leitura libera continua liberado.
        self.assertTrue(stack.allows("iam:ListUsers", extra=[ADMIN]))

    def test_the_connector_deny_lists_are_kept(self):
        connector = cfn_yaml.load(str(HERE / "verax-control-connector.yaml"))
        policies = connector["Resources"]["VeraxReadOnlyRole"]["Properties"]["Policies"]
        policy = next(p for p in policies if p["PolicyName"] == "NegarAlteracoes")
        expected = {s["Sid"]: s["Action"] for s in policy["PolicyDocument"]["Statement"]}
        for sid in ("NuncaAlterarLogs", "NuncaAmpliarOProprioAcesso"):
            with self.subTest(sid=sid):
                self.assertEqual(self.statement(sid)["Action"], expected[sid])

    # --- Opcionais ---

    def test_object_prefixes_limit_only_the_informed_buckets(self):
        # Trilha da organização (bucket compartilhado) e export do GuardDuty da própria conta, cada um com o seu layout.
        organization, own = f"AWSLogs/o-exemplo123/{ACCOUNT}/", f"AWSLogs/{ACCOUNT}/"
        stack = self.stack(LogObjectPrefix=f"{organization},{own}", CreateTrail="true")
        trail, guardduty = BUCKETS[0], BUCKETS[1]
        self.assertTrue(stack.allows("s3:GetObject", f"{trail}/{organization}CloudTrail/sa-east-1/x.json.gz"))
        self.assertTrue(stack.allows("s3:GetObject", f"{guardduty}/{own}GuardDuty/sa-east-1/x.jsonl.gz"))
        for key in ("AWSLogs/o-exemplo123/222222222222/CloudTrail/x.json.gz", "AWSLogs/222222222222/x", "x.json.gz"):
            with self.subTest(key=key):
                self.assertFalse(stack.allows("s3:GetObject", f"{trail}/{key}"))
        # Só o GetObject: o módulo do Wazuh lista o bucket a partir da raiz, e a listagem não leva o prefixo.
        self.assertTrue(stack.allows("s3:ListBucket", trail))
        # A trilha criada pela pilha é só desta conta e fica fora dos prefixos.
        created = f"arn:aws:s3:::verax-control-cloudtrail-{ACCOUNT}-sa-east-1"
        self.assertTrue(stack.allows("s3:GetObject", f"{created}/AWSLogs/{ACCOUNT}/CloudTrail/x.json.gz"))
        # Um prefixo só também funciona, e sem prefixo a negação nem existe.
        single = self.stack(LogObjectPrefix=organization)
        self.assertTrue(single.allows("s3:GetObject", f"{trail}/{organization}x.json.gz"))
        self.assertFalse(single.allows("s3:GetObject", f"{guardduty}/{own}x.json.gz"))
        sids = {s["Sid"] for s in self.stack().policy_document("GuardrailsPolicy")["Statement"]}
        self.assertNotIn("SoOsPrefixosInformados", sids)

    def test_session_revocation_denies_only_older_sessions(self):
        stack = self.stack(RevokeSessionsIssuedBefore="2026-11-04T18:00:00Z")
        self.assertFalse(stack.allows("iam:ListUsers", aws_TokenIssueTime="2026-11-04T17:59:59Z"))
        self.assertTrue(stack.allows("iam:ListUsers", aws_TokenIssueTime="2026-11-04T18:00:01Z"))
        # A chave de longa duração não tem aws:TokenIssueTime: só a exclusão dela no console a revoga.
        self.assertTrue(stack.allows("iam:ListUsers"))
        self.assertTrue(self.stack().allows("iam:ListUsers", aws_TokenIssueTime="2026-11-04T17:59:59Z"))

    def test_created_trail_and_export_are_readable_from_the_node(self):
        stack = Stack(
            self.template,
            NodeEgressIps=f"{NODE_IP}/32",
            CreateTrail="true",
            EnableGuardDutyExport="true",
            GuardDutyDetectorId="a" * 32,
        )
        key = f"arn:aws:kms:sa-east-1:{ACCOUNT}:key/11111111-2222-3333-4444-555555555555"
        for service in ("cloudtrail", "guardduty"):
            bucket = f"arn:aws:s3:::verax-control-{service}-{ACCOUNT}-sa-east-1"
            with self.subTest(bucket=bucket):
                self.assertTrue(stack.allows("s3:ListBucket", bucket))
                self.assertTrue(stack.allows("s3:GetBucketLocation", bucket))
                self.assertTrue(stack.allows("s3:GetObject", f"{bucket}/AWSLogs/{ACCOUNT}/x.json.gz"))
        self.assertTrue(stack.allows("kms:Decrypt", key, kms_ViaService="s3.sa-east-1.amazonaws.com"))
        self.assertFalse(stack.allows("kms:Decrypt", key, kms_ViaService="s3.us-east-1.amazonaws.com"))
        self.assertFalse(
            stack.allows("s3:GetObject", f"arn:aws:s3:::verax-control-access-logs-{ACCOUNT}-sa-east-1/cloudtrail/x")
        )
        only_trail = Stack(self.template, NodeEgressIps=f"{NODE_IP}/32", CreateTrail="true")
        self.assertNotIn("GuardDutyBucket", only_trail.resources)
        trail = f"arn:aws:s3:::verax-control-cloudtrail-{ACCOUNT}-sa-east-1"
        self.assertTrue(only_trail.allows("s3:ListBucket", trail))

    def test_created_buckets_are_private_encrypted_versioned_and_retained(self):
        buckets = {name: r for name, r in self.resources.items() if r["Type"] == "AWS::S3::Bucket"}
        self.assertEqual(set(buckets), {"AccessLogsBucket", "TrailBucket", "GuardDutyBucket"})
        logs_key = {"Fn::GetAtt": ["LogsKey", "Arn"]}
        for name, bucket in buckets.items():
            with self.subTest(bucket=name):
                props = bucket["Properties"]
                self.assertEqual((bucket["DeletionPolicy"], bucket["UpdateReplacePolicy"]), ("Retain", "Retain"))
                self.assertEqual(
                    props["PublicAccessBlockConfiguration"],
                    {
                        "BlockPublicAcls": True,
                        "BlockPublicPolicy": True,
                        "IgnorePublicAcls": True,
                        "RestrictPublicBuckets": True,
                    },
                )
                self.assertEqual(props["OwnershipControls"]["Rules"], [{"ObjectOwnership": "BucketOwnerEnforced"}])
                self.assertEqual(props["VersioningConfiguration"], {"Status": "Enabled"})
                self.assertEqual(
                    props["LifecycleConfiguration"]["Rules"][0]["ExpirationInDays"], {"Ref": "LogRetentionDays"}
                )
                encryption = props["BucketEncryption"]["ServerSideEncryptionConfiguration"][0]
                if name == "AccessLogsBucket":
                    # O log de acesso do S3 só é entregue com SSE-S3.
                    self.assertEqual(encryption["ServerSideEncryptionByDefault"], {"SSEAlgorithm": "AES256"})
                else:
                    self.assertEqual(
                        encryption["ServerSideEncryptionByDefault"],
                        {"SSEAlgorithm": "aws:kms", "KMSMasterKeyID": logs_key},
                    )
                    self.assertEqual(
                        props["LoggingConfiguration"]["DestinationBucketName"], {"Ref": "AccessLogsBucket"}
                    )
                policy = next(
                    r for r in self.resources.values()
                    if r["Type"] == "AWS::S3::BucketPolicy" and r["Properties"]["Bucket"] == {"Ref": name}
                )
                denies = [
                    s
                    for s in policy["Properties"]["PolicyDocument"]["Statement"]
                    if s["Effect"] == "Deny"
                    and s["Principal"] == "*"
                    and s.get("Condition", {}).get("Bool") == {"aws:SecureTransport": "false"}
                ]
                self.assertEqual(len(denies), 1)
        self.assertTrue(self.resources["LogsKey"]["Properties"]["EnableKeyRotation"])
        self.assertEqual(self.resources["LogsKey"]["DeletionPolicy"], "Retain")

    def test_created_trail_is_multi_region_validated_and_encrypted(self):
        trail = self.resources["Trail"]["Properties"]
        self.assertTrue(trail["IsMultiRegionTrail"])
        self.assertTrue(trail["IncludeGlobalServiceEvents"])
        self.assertTrue(trail["EnableLogFileValidation"])
        self.assertTrue(trail["IsLogging"])
        self.assertEqual(trail["KMSKeyId"], {"Fn::GetAtt": ["LogsKey", "Arn"]})
        statements_ = self.resources["TrailBucketPolicy"]["Properties"]["PolicyDocument"]["Statement"]
        for statement in statements_:
            if statement.get("Principal") == {"Service": "cloudtrail.amazonaws.com"}:
                arn = statement["Condition"]["StringEquals"]["aws:SourceArn"]["Fn::Sub"]
                self.assertTrue(arn.endswith(f":trail/{trail['TrailName']}"))

    def test_guardduty_exports_only_with_the_stack_key(self):
        export = self.resources["GuardDutyExport"]["Properties"]
        self.assertEqual(export["DetectorId"], {"Ref": "GuardDutyDetectorId"})
        self.assertEqual(export["DestinationProperties"]["KmsKeyArn"], {"Fn::GetAtt": ["LogsKey", "Arn"]})
        denies = [
            s
            for s in self.resources["GuardDutyBucketPolicy"]["Properties"]["PolicyDocument"]["Statement"]
            if s["Effect"] == "Deny" and s.get("Principal") == {"Service": "guardduty.amazonaws.com"}
        ]
        self.assertEqual(
            denies[0]["Condition"]["StringNotEquals"],
            {"s3:x-amz-server-side-encryption-aws-kms-key-id": {"Fn::GetAtt": ["LogsKey", "Arn"]}},
        )

    def test_policies_fit_the_managed_policy_size_limit(self):
        # Limite do IAM: 6.144 caracteres sem espaços. Com 10 buckets, 10 chaves e todos os opcionais ligados.
        stack = self.stack(
            LogBucketArns=",".join(f"arn:aws:s3:::bucket-de-log-com-nome-longo-{i:02d}-{ACCOUNT}" for i in range(10)),
            LogKmsKeyArns=",".join(KMS_KEY.replace("00000000-0000", f"000000{i:02d}-0000") for i in range(10)),
            LogObjectPrefix=f"AWSLogs/o-exemplo123/{ACCOUNT}/",
            CreateTrail="true",
            EnableGuardDutyExport="true",
            GuardDutyDetectorId="a" * 32,
            RevokeSessionsIssuedBefore="2026-11-04T18:00:00Z",
            NodeEgressIps="203.0.113.10/32,203.0.113.11/32",
        )
        for name in ("ReaderPolicy", "GuardrailsPolicy"):
            with self.subTest(policy=name):
                self.assertLess(len(json.dumps(stack.policy_document(name), separators=(",", ":"))), 6144)

    # --- O equivalente sem CloudFormation ---

    def test_policy_json_is_the_template_with_the_example_values(self):
        stack = self.stack()
        self.assertEqual(
            json.loads(POLICY_JSON.read_text(encoding="utf-8")),
            {
                "VeraxControlReader": stack.policy_document("ReaderPolicy"),
                "VeraxControlGuardrails": stack.policy_document("GuardrailsPolicy"),
            },
        )

    def test_readme_cli_creates_the_same_user_without_key_or_password(self):
        commands = [
            line.strip()
            for line in README.read_text(encoding="utf-8").splitlines()
            if line.strip().startswith("aws iam ")
        ]
        text = "\n".join(commands)
        for forbidden in ("create-access-key", "create-login-profile", "attach-user-policy", "put-user-policy"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, text)
        user = [c for c in commands if c.startswith("aws iam create-user")]
        self.assertEqual(len(user), 1)
        self.assertIn("--path /verax/", user[0])
        self.assertIn("--user-name verax-control-reader", user[0])
        self.assertIn('--permissions-boundary "arn:aws:iam::$conta:policy/verax/VeraxControlReader"', user[0])
        for name in ("VeraxControlReader", "VeraxControlGuardrails"):
            with self.subTest(policy=name):
                self.assertTrue(
                    any(
                        c.startswith("aws iam create-policy --path /verax/ --policy-name " + name)
                        and f"jq -c .{name} verax-control-reader.policy.json" in c
                        for c in commands
                    )
                )
                self.assertTrue(
                    any(
                        c.startswith("aws iam attach-group-policy --group-name VeraxControlReaders")
                        and c.endswith(f'policy/verax/{name}"')
                        for c in commands
                    )
                )
        self.assertIn("aws iam create-group --path /verax/ --group-name VeraxControlReaders", commands)
        self.assertIn(
            "aws iam add-user-to-group --group-name VeraxControlReaders --user-name verax-control-reader", commands
        )


class MutationTest(unittest.TestCase):
    """Cada mutação do plano derruba ao menos uma conferência."""

    @classmethod
    def setUpClass(cls):
        cls.template = cfn_yaml.load(str(TEMPLATE))

    def mutated(self):
        return copy.deepcopy(self.template)

    def test_without_the_ip_deny(self):
        template = self.mutated()
        document = template["Resources"]["GuardrailsPolicy"]["Properties"]["PolicyDocument"]
        document["Statement"] = [s for s in document["Statement"] if s.get("Sid") != "SoDoNoDaVerax"]
        self.assertTrue(problems_ip_deny(template))
        stack = Stack(template, **EXAMPLE)
        self.assertTrue(stack.allows("s3:GetObject", f"{BUCKETS[0]}/x.json.gz", source_ip=OTHER_IP))

    def test_with_an_access_key(self):
        template = self.mutated()
        template["Resources"]["Chave"] = {
            "Type": "AWS::IAM::AccessKey",
            "Properties": {"UserName": {"Ref": "ReaderUser"}},
        }
        template["Outputs"]["Segredo"] = {"Value": {"Fn::GetAtt": ["Chave", "SecretAccessKey"]}}
        self.assertEqual(len(problems_no_key_or_password(template)), 2)
        template = self.mutated()
        template["Resources"]["ReaderUser"]["Properties"]["LoginProfile"] = {"Password": {"Ref": "SenhaInicial"}}
        self.assertTrue(problems_no_key_or_password(template))

    def test_with_get_object_on_any_resource(self):
        template = self.mutated()
        for item in template["Resources"]["ReaderPolicy"]["Properties"]["PolicyDocument"]["Statement"]:
            if isinstance(item, dict) and "Fn::If" in item and item["Fn::If"][1].get("Sid") == "LerObjetosDeLog":
                item["Fn::If"][1]["Resource"] = "*"
        self.assertTrue(problems_read_only(template))
        stack = Stack(template, **EXAMPLE)
        self.assertTrue(stack.allows("s3:GetObject", f"arn:aws:s3:::outro-bucket-{ACCOUNT}/x"))
        # Variante: o ARN de todos os buckets em vez de "*".
        template = self.mutated()
        for item in template["Resources"]["ReaderPolicy"]["Properties"]["PolicyDocument"]["Statement"]:
            if isinstance(item, dict) and "Fn::If" in item and item["Fn::If"][1].get("Sid") == "LerObjetosDeLog":
                item["Fn::If"][1]["Resource"] = "arn:aws:s3:::*/*"
        self.assertTrue(problems_read_only(template))

    def test_without_the_boundary(self):
        template = self.mutated()
        del template["Resources"]["ReaderUser"]["Properties"]["PermissionsBoundary"]
        self.assertTrue(problems_boundary(template))
        stack = Stack(template, **EXAMPLE)
        self.assertTrue(stack.allows("secretsmanager:GetSecretValue", "*", extra=[ADMIN]))

    def test_with_a_write_action_or_a_decrypt_outside_s3(self):
        template = self.mutated()
        posture = next(
            s
            for s in template["Resources"]["ReaderPolicy"]["Properties"]["PolicyDocument"]["Statement"]
            if isinstance(s, dict) and s.get("Sid") == "PosturaEAtivos"
        )
        posture["Action"].append("s3:PutObject")
        self.assertTrue(problems_read_only(template))
        template = self.mutated()
        for item in template["Resources"]["ReaderPolicy"]["Properties"]["PolicyDocument"]["Statement"]:
            if isinstance(item, dict) and "Fn::If" in item and item["Fn::If"][1].get("Sid") == "DecifrarSoPeloS3":
                del item["Fn::If"][1]["Condition"]
        self.assertTrue(problems_read_only(template))


if __name__ == "__main__":
    unittest.main()
