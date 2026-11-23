"""Testes de segurança do template do papel de leitura (verax-control-reader).

Leem o template com o parser do cfn-lint (mesmo venv do CI, sem dependência nova) e conferem o que o cliente aceita ao
criar a pilha: só o papel, sem chave, e as duas políticas (a trilha e o export do GuardDuty só se pedidos); só o nó do
Verax Control entra no papel, com o token que o Google assina para a conta de serviço dele, pedido com o audience da
Verax e só a partir do IP de saída do nó; o papel só lê, só desse IP, e nunca altera logs nem o próprio acesso.

Modelo 2: a descoberta e a postura valem sempre, e três autorizações do cliente (parâmetros true/false) somam, cada
uma, só as declarações dela: os logs que a AWS grava no S3 em AWSLogs/<conta>/, os achados de segurança e os grupos do
CloudWatch Logs com a etiqueta verax-control = leitura. As etiquetas do papel dizem a versão do modelo e o que foi
autorizado. Toda ação liberada está numa lista exata de leitura.

Além das conferências no texto do template, um avaliador mínimo de políticas do IAM monta a pilha com parâmetros
fictícios e decide cada chamada com as duas políticas juntas (negação explícita, permissão e limite de permissões) e
cada pedido de entrada no papel com a política de confiança. As mutações conferem que os testes pegam o que deveriam:
sem o Deny de IP, com um usuário e uma chave, com GetObject em qualquer recurso, sem o limite de permissões, cada
condição da confiança tirada, afrouxada ou trocada, e cada declaração de uma autorização afrouxada.
"""

import copy
import ipaddress
import itertools
import json
import pathlib
import re
import unittest

from cfnlint.decode import cfn_yaml
from test_connector import MUST_DENY as CONNECTOR_MUST_DENY
from test_connector import WAZUH_CALLS as CONNECTOR_WAZUH_CALLS
from test_connector import as_list, matches

HERE = pathlib.Path(__file__).resolve().parents[1]
TEMPLATE = HERE / "verax-control-reader.yaml"
POLICY_JSON = HERE / "verax-control-reader.policy.json"
README = HERE / "README.md"
INSTALL_SH = HERE.parents[0] / "node" / "bin" / "install.sh"
# A conferência diária do worker, que simula no próprio papel uma amostra de ações fora da política.
CHECKER_TS = HERE.parents[1] / "apps" / "api" / "src" / "aws" / "web-identity-checker.ts"

ACCOUNT = "111111111111"
STACK_NAME = "verax-control-reader"
ROLE_ARN = f"arn:aws:iam::{ACCOUNT}:role/verax/verax-control-reader"
GOOGLE = "accounts.google.com"
WEB_IDENTITY = "sts:AssumeRoleWithWebIdentity"
# O audience fixo do Verax Control: o padrão do parâmetro Audience e o que o nó pede ao Google. É uma constante do
# produto, igual para todo cliente (README, "Para quem mantém estes templates").
AUDIENCE = "https://control.veraxsistemas.com.br/aws-reader"
# IDs únicos fictícios de contas de serviço do Google (21 dígitos): a do nó deste cliente e a do nó de outro cliente.
NODE_SA = "123456789012345678901"
OTHER_SA = "109876543210987654321"
NODE_IP = "203.0.113.10"
OTHER_IP = "198.51.100.7"
KMS_KEY = f"arn:aws:kms:sa-east-1:{ACCOUNT}:key/00000000-0000-0000-0000-000000000000"
# Uma chave multirregião (mrk- e 32 hexadecimais), comum em landing zones.
KMS_MRK = f"arn:aws:kms:sa-east-1:{ACCOUNT}:key/mrk-1234abcd12ab34cd56ef1234567890ab"
BUCKETS = [
    f"arn:aws:s3:::trilha-{ACCOUNT}",
    f"arn:aws:s3:::guardduty-{ACCOUNT}",
    f"arn:aws:s3:::aws-waf-logs-{ACCOUNT}",
]
# O nó (os valores que o painel mostra) e os logs do exemplo: os mesmos do verax-control-reader.policy.json.
NODE = {"NodeServiceAccountId": NODE_SA, "NodeEgressIps": f"{NODE_IP}/32"}
EXAMPLE = {**NODE, "LogBucketArns": ",".join(BUCKETS), "LogKmsKeyArns": KMS_KEY}

# As três autorizações do cliente: o parâmetro, a condição do template, o nome na etiqueta do papel e as declarações
# que cada uma soma à política de leitura (e só ela). A descoberta vale sempre e não tem parâmetro.
CAPABILITIES = {
    "ReadAwsServiceLogs": {
        "condition": "ReadsServiceLogs",
        "tag": "service-logs",
        "sids": {
            "LerLogsDaAwsDestaConta",
            "ListarLogsDaAwsDestaConta",
            "VerPrimeiroNivelDosBuckets",
            "DecifrarLogsDaAwsSoPeloS3",
        },
        "actions": {"s3:GetObject", "s3:ListBucket", "kms:Decrypt"},
    },
    "ReadSecurityFindings": {
        "condition": "ReadsFindings",
        "tag": "findings",
        "sids": {"LerAchadosDeSeguranca"},
        "actions": {
            "access-analyzer:GetFinding",
            "access-analyzer:ListFindings",
            "guardduty:GetFindings",
            "guardduty:ListFindings",
            "inspector2:ListCoverage",
            "inspector2:ListFindings",
            "securityhub:GetEnabledStandards",
            "securityhub:GetFindings",
        },
    },
    "ReadTaggedLogGroups": {
        "condition": "ReadsLogGroups",
        "tag": "log-groups",
        "sids": {"LerGruposDeLogEtiquetados"},
        "actions": {"logs:DescribeLogStreams", "logs:FilterLogEvents", "logs:GetLogEvents"},
    },
}
ALL_OFF = dict.fromkeys(CAPABILITIES, "false")
# As declarações que existem com qualquer combinação: a descoberta e a postura.
ALWAYS_SIDS = {"AutoInspecao", "ValidarFontes", "PosturaEAtivos", "DescobrirFontes"}
# A etiqueta dos grupos do CloudWatch Logs que o cliente autoriza (a mesma do painel, AWS_LOG_GROUP_TAG).
LOG_GROUP_TAG = ("verax-control", "leitura")
TEMPLATE_VERSION = "2"
# O que o IAM aceita no valor de uma etiqueta (API_Tag): letras, números, espaço e _ . : / = + - @. Vírgula, não.
IAM_TAG_VALUE = re.compile(r"[\w .:/=+\-@]{0,256}")

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
# Conferência do papel e das fontes (a checagem do worker, PR-V5'). O sts:GetCallerIdentity não passa por política. O
# iam:GetRole é do modelo 2: o nó lê as etiquetas do próprio papel.
VALIDATION_CALLS = {
    "iam:GetRole",
    "iam:SimulatePrincipalPolicy",
    "cloudtrail:DescribeTrails",
    "cloudtrail:GetTrailStatus",
    "guardduty:ListDetectors",
    "guardduty:GetDetector",
    "guardduty:ListPublishingDestinations",
    "guardduty:DescribePublishingDestination",
}
# A descoberta das fontes (modelo 2): só configuração, em toda a conta.
DISCOVERY_CALLS = {
    "access-analyzer:ListAnalyzers",
    "cloudtrail:GetEventSelectors",
    "config:DescribeConfigurationRecorders",
    "config:DescribeConfigurationRecorderStatus",
    "config:DescribeDeliveryChannels",
    "ec2:DescribeFlowLogs",
    "ec2:DescribeVpcs",
    "elasticloadbalancing:DescribeLoadBalancers",
    "elasticloadbalancing:DescribeLoadBalancerAttributes",
    "inspector2:BatchGetAccountStatus",
    "logs:DescribeLogGroups",
    "logs:ListTagsForResource",
    "rds:DescribeDBInstances",
    "rds:DescribeDBClusters",
    "s3:GetBucketLocation",
    "s3:GetEncryptionConfiguration",
    "securityhub:DescribeHub",
    "wafv2:GetLoggingConfiguration",
    "wafv2:ListLoggingConfigurations",
    "wafv2:ListWebACLs",
}
# Tudo o que as duas políticas liberam, com todas as autorizações, os buckets adicionais e os criados pela pilha: a
# lista exata, ação por ação e sem curinga. Uma ação nova no template só passa se entrar aqui, à vista de quem revisa.
# Nenhuma escreve, cria, apaga ou altera nada: Describe, Get, List e BatchGet de configuração; a leitura de objetos,
# de eventos de log e de achados; o Decrypt (só pelo S3) e a simulação das próprias permissões.
ALLOWED_ACTIONS = frozenset(
    {
        "access-analyzer:GetFinding",
        "access-analyzer:ListAnalyzers",
        "access-analyzer:ListFindings",
        "cloudtrail:DescribeTrails",
        "cloudtrail:GetEventSelectors",
        "cloudtrail:GetTrailStatus",
        "config:DescribeConfigurationRecorderStatus",
        "config:DescribeConfigurationRecorders",
        "config:DescribeDeliveryChannels",
        "ec2:DescribeFlowLogs",
        "ec2:DescribeInstances",
        "ec2:DescribeRegions",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeVpcs",
        "ec2:GetEbsEncryptionByDefault",
        "elasticloadbalancing:DescribeLoadBalancerAttributes",
        "elasticloadbalancing:DescribeLoadBalancers",
        "guardduty:DescribePublishingDestination",
        "guardduty:GetDetector",
        "guardduty:GetFindings",
        "guardduty:ListDetectors",
        "guardduty:ListFindings",
        "guardduty:ListPublishingDestinations",
        "iam:GetAccessKeyLastUsed",
        "iam:GetAccountPasswordPolicy",
        "iam:GetAccountSummary",
        "iam:GetLoginProfile",
        "iam:GetRole",
        "iam:ListAccessKeys",
        "iam:ListMFADevices",
        "iam:ListUsers",
        "iam:SimulatePrincipalPolicy",
        "inspector2:BatchGetAccountStatus",
        "inspector2:ListCoverage",
        "inspector2:ListFindings",
        "kms:Decrypt",
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams",
        "logs:FilterLogEvents",
        "logs:GetLogEvents",
        "logs:ListTagsForResource",
        "rds:DescribeDBClusters",
        "rds:DescribeDBInstances",
        "s3:GetAccountPublicAccessBlock",
        "s3:GetBucketAcl",
        "s3:GetBucketLocation",
        "s3:GetBucketPolicyStatus",
        "s3:GetBucketPublicAccessBlock",
        "s3:GetEncryptionConfiguration",
        "s3:GetObject",
        "s3:ListAllMyBuckets",
        "s3:ListBucket",
        "securityhub:DescribeHub",
        "securityhub:GetEnabledStandards",
        "securityhub:GetFindings",
        "wafv2:GetLoggingConfiguration",
        "wafv2:ListLoggingConfigurations",
        "wafv2:ListWebACLs",
    }
)
# Verbos que nunca aparecem numa ação liberada, nem com o nome certo na lista acima (segunda trava).
WRITE_VERB = re.compile(
    r":(Accept|Add|Apply|Archive|Associate|Attach|Cancel|Create|Delete|Detach|Disable|Disassociate|Enable|Import|"
    r"Invite|Modify|Pass|Put|Remove|Reset|Restore|Run|Send|Set|Start|Stop|Tag|Untag|Update|Upload|Batch(?!Get))"
)
# O que o papel nunca faz, nem do IP do nó: o mesmo do conector, mais mexer no próprio papel (a confiança, o limite e as
# políticas), criar usuário, chave ou provedor de identidade, assumir outro papel, e mexer no WAF, na trilha e no export.
MUST_DENY = CONNECTOR_MUST_DENY | {
    "iam:UpdateAssumeRolePolicy",
    "iam:UpdateRole",
    "iam:DeleteRole",
    "iam:DetachRolePolicy",
    "iam:DeleteRolePolicy",
    "iam:PutRolePermissionsBoundary",
    "iam:DeleteRolePermissionsBoundary",
    "iam:CreateRole",
    "iam:CreateUser",
    "iam:CreateAccessKey",
    "iam:CreateLoginProfile",
    "iam:CreateOpenIDConnectProvider",
    "iam:CreatePolicyVersion",
    "iam:SetDefaultPolicyVersion",
    "sts:AssumeRoleWithWebIdentity",
    "sts:GetFederationToken",
    "wafv2:UpdateWebACL",
    "wafv2:DeleteWebACL",
    "cloudtrail:CreateTrail",
    "guardduty:CreatePublishingDestination",
    # Modelo 2: as outras fontes que a descoberta enxerga e os serviços de achados (NuncaAlterarOutrasFontes), a
    # etiqueta que daria leitura de um grupo de log e as etiquetas do próprio papel.
    "logs:TagResource",
    "logs:TagLogGroup",
    "logs:UntagResource",
    "ec2:CreateFlowLogs",
    "ec2:DeleteFlowLogs",
    "config:DeleteConfigurationRecorder",
    "config:DeleteDeliveryChannel",
    "config:PutConfigurationRecorder",
    "config:PutDeliveryChannel",
    "config:StartConfigurationRecorder",
    "config:StopConfigurationRecorder",
    "elasticloadbalancing:ModifyLoadBalancerAttributes",
    "securityhub:EnableSecurityHub",
    "securityhub:BatchEnableStandards",
    "securityhub:BatchDisableStandards",
    "securityhub:BatchImportFindings",
    "securityhub:CreateInsight",
    "securityhub:CreateAutomationRule",
    "securityhub:UpdateFindings",
    "securityhub:DeleteInsight",
    "securityhub:TagResource",
    "inspector2:Enable",
    "inspector2:Disable",
    "inspector2:CreateFilter",
    "inspector2:DeleteFilter",
    "inspector2:UpdateConfiguration",
    "inspector2:BatchUpdateMemberEc2DeepInspectionStatus",
    "inspector2:CancelFindingsReport",
    "access-analyzer:CreateAnalyzer",
    "access-analyzer:DeleteAnalyzer",
    "access-analyzer:CreateArchiveRule",
    "access-analyzer:ApplyArchiveRule",
    "access-analyzer:UpdateFindings",
    "access-analyzer:StartResourceScan",
    "wafv2:CreateWebACL",
    "wafv2:AssociateWebACL",
    "wafv2:DisassociateWebACL",
    "wafv2:TagResource",
    "iam:TagRole",
    "iam:UntagRole",
}
# Fora do limite de permissões: nem com uma política de administrador anexada ao papel.
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
    # Leituras de conteúdo que o modelo 2 não dá: a consulta do Logs Insights (que leria qualquer grupo), versões
    # antigas de objeto, o log dos bancos e os dados deles.
    "logs:StartQuery",
    "logs:GetQueryResults",
    "logs:GetLogRecord",
    "logs:StartLiveTail",
    "s3:GetObjectVersion",
    "s3:ListBucketVersions",
    "rds:DownloadDBLogFilePortion",
    "rds-data:ExecuteStatement",
    "iam:ListRoles",
    "wafv2:GetWebACL",
}
# Conteúdo: objetos, eventos de log e achados. Fora das declarações de cada autorização (que são comparadas inteiras
# com EXPECTED_CAPABILITY_STATEMENTS), os objetos e o Decrypt só existem nos recursos informados ou criados pela
# pilha, nunca em "*" nem num curinga que alcance um bucket ou uma chave qualquer (os ARNs abaixo); os eventos de log e
# os achados, em declaração nenhuma.
CONTENT_ACTIONS = {"s3:GetObject", "s3:ListBucket", "kms:Decrypt"}
CAPABILITY_ONLY_ACTIONS = (
    CAPABILITIES["ReadSecurityFindings"]["actions"] | CAPABILITIES["ReadTaggedLogGroups"]["actions"]
)
ANY_RESOURCE = (
    "arn:aws:s3:::bucket-qualquer",
    "arn:aws:s3:::bucket-qualquer/x",
    f"arn:aws:kms:sa-east-1:{ACCOUNT}:key/x",
)
# As declarações das três autorizações, como o template as escreve: o recurso e a condição exatos de cada uma.
OWN_LOGS = "AWSLogs/${AWS::AccountId}/*"
ORGANIZATION_LOGS = "AWSLogs/o-*/${AWS::AccountId}/*"
ANY_BUCKET = {"Fn::Sub": "arn:${AWS::Partition}:s3:::*"}
EXPECTED_CAPABILITY_STATEMENTS = {
    "LerLogsDaAwsDestaConta": {
        "Sid": "LerLogsDaAwsDestaConta",
        "Effect": "Allow",
        "Action": "s3:GetObject",
        "Resource": [
            {"Fn::Sub": f"arn:${{AWS::Partition}}:s3:::*/{OWN_LOGS}"},
            {"Fn::Sub": f"arn:${{AWS::Partition}}:s3:::*/{ORGANIZATION_LOGS}"},
        ],
    },
    "ListarLogsDaAwsDestaConta": {
        "Sid": "ListarLogsDaAwsDestaConta",
        "Effect": "Allow",
        "Action": "s3:ListBucket",
        "Resource": ANY_BUCKET,
        "Condition": {"StringLike": {"s3:prefix": [{"Fn::Sub": OWN_LOGS}, {"Fn::Sub": ORGANIZATION_LOGS}]}},
    },
    "VerPrimeiroNivelDosBuckets": {
        "Sid": "VerPrimeiroNivelDosBuckets",
        "Effect": "Allow",
        "Action": "s3:ListBucket",
        "Resource": ANY_BUCKET,
        "Condition": {"StringEquals": {"s3:delimiter": "/", "s3:prefix": ["", "AWSLogs", "AWSLogs/"]}},
    },
    "DecifrarLogsDaAwsSoPeloS3": {
        "Sid": "DecifrarLogsDaAwsSoPeloS3",
        "Effect": "Allow",
        "Action": "kms:Decrypt",
        "Resource": "*",
        "Condition": {"StringLike": {"kms:ViaService": "s3.*.amazonaws.com"}},
    },
    "LerAchadosDeSeguranca": {
        "Sid": "LerAchadosDeSeguranca",
        "Effect": "Allow",
        "Resource": "*",
        "Action": sorted(CAPABILITIES["ReadSecurityFindings"]["actions"]),
    },
    "LerGruposDeLogEtiquetados": {
        "Sid": "LerGruposDeLogEtiquetados",
        "Effect": "Allow",
        "Action": sorted(CAPABILITIES["ReadTaggedLogGroups"]["actions"]),
        "Resource": [
            {"Fn::Sub": "arn:${AWS::Partition}:logs:*:${AWS::AccountId}:log-group:*"},
            {"Fn::Sub": "arn:${AWS::Partition}:logs:*:${AWS::AccountId}:log-group:*:*"},
        ],
        "Condition": {"StringEquals": {f"aws:ResourceTag/{LOG_GROUP_TAG[0]}": LOG_GROUP_TAG[1]}},
    },
}
# Tipos que dariam a alguém uma chave, uma senha ou outra credencial de longa duração, ou um usuário onde pendurá-las.
USER_OR_KEY_TYPES = {
    "AWS::IAM::User",
    "AWS::IAM::AccessKey",
    "AWS::IAM::ServiceSpecificCredential",
    "AWS::IAM::UserPolicy",
    "AWS::IAM::UserToGroupAddition",
    "AWS::IAM::Group",
    "AWS::IAM::GroupPolicy",
}
# Uma saída cujo nome ou valor lembre um segredo.
SECRET_WORDS = re.compile(r"secret|password|senha|token|credential|accesskey", re.IGNORECASE)
# A confiança inteira, condição por condição, como o template a escreve: só valores dos parâmetros validados.
TRUST_CONDITION = {
    "StringEquals": {
        f"{GOOGLE}:aud": {"Ref": "NodeServiceAccountId"},
        f"{GOOGLE}:sub": {"Ref": "NodeServiceAccountId"},
        f"{GOOGLE}:oaud": {"Ref": "Audience"},
    },
    "IpAddress": {"aws:SourceIp": {"Fn::Split": [",", {"Ref": "NodeEgressIps"}]}},
}
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


def conditional_statements(document):
    """As declarações de uma política com a condição do template de que cada uma depende (None: existe sempre)."""
    for item in document["Statement"]:
        if isinstance(item, dict) and "Fn::If" in item:
            condition, when_true, _ = item["Fn::If"]
            yield condition, when_true
        else:
            yield None, item


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


def trust_statements(template):
    role = template["Resources"].get("ReaderRole", {}).get("Properties", {})
    return role.get("AssumeRolePolicyDocument", {}).get("Statement", [])


# --- O token do Google, como a AWS o lê ---


def google_token(sub=NODE_SA, audience=AUDIENCE):
    """Os campos de um ID token que o Google assina para uma conta de serviço: azp e sub são o ID único dela, e aud é o
    audience que ela pediu ao metadata (format=standard: sem o projeto nem a VM)."""
    return {"iss": "https://accounts.google.com", "aud": audience, "azp": sub, "sub": sub}


def web_identity_context(token, source_ip):
    """As chaves que a AWS monta para a troca do token do Google: accounts.google.com:aud vem do azp, quando ele existe,
    e o aud do token vira accounts.google.com:oaud."""
    return {
        "aws:SourceIp": source_ip,
        f"{GOOGLE}:aud": token.get("azp") or token["aud"],
        f"{GOOGLE}:oaud": token["aud"],
        f"{GOOGLE}:sub": token["sub"],
    }


# --- Conferências no texto do template (também usadas nas mutações) ---


def problems_no_user_or_key(template):
    """Nenhum usuário, chave ou senha na pilha, nenhuma política pendurada num usuário ou grupo, nenhum parâmetro
    secreto e nenhuma saída que lembre um segredo."""
    found = []
    for name, resource in template["Resources"].items():
        if resource["Type"] in USER_OR_KEY_TYPES:
            found.append(f"{name}: {resource['Type']}")
        if resource["Type"] == "AWS::IAM::ManagedPolicy":
            for key in ("Users", "Groups"):
                if key in resource["Properties"]:
                    found.append(f"{name}: anexada a {key}")
    for name, spec in template["Parameters"].items():
        if spec.get("NoEcho"):
            found.append(f"parâmetro secreto {name}")
    for name, output in template.get("Outputs", {}).items():
        if SECRET_WORDS.search(name) or SECRET_WORDS.search(json.dumps(output["Value"])):
            found.append(f"saída {name}")
    return found


def problems_trust(template):
    """Só o Google, só a troca do token, e as quatro condições exatas (aud, sub e oaud em StringEquals, IP do nó)."""
    found = []
    trust = trust_statements(template)
    if not trust:
        found.append("papel sem política de confiança")
    for statement in trust:
        sid = statement.get("Sid")
        if statement.get("Effect") != "Allow" or "NotPrincipal" in statement or "NotAction" in statement:
            found.append(f"{sid}: declaração fora do formato")
        if statement.get("Principal") != {"Federated": GOOGLE}:
            found.append(f"{sid}: outro principal além do Google")
        if statement.get("Action") != WEB_IDENTITY:
            found.append(f"{sid}: outra ação além da troca do token")
        if statement.get("Condition") != TRUST_CONDITION:
            found.append(f"{sid}: condições diferentes de aud, sub e oaud exatos e do IP do nó")
    account = template["Parameters"].get("NodeServiceAccountId", {})
    if "Default" in account or account.get("AllowedPattern") != "^[0-9]{21}$":
        found.append("NodeServiceAccountId sem os 21 dígitos obrigatórios")
    audience = template["Parameters"].get("Audience", {})
    pattern = audience.get("AllowedPattern", "")
    if audience.get("Default") != AUDIENCE or not pattern or any(
        re.fullmatch(pattern, probe) for probe in ("", "*", "https://*", f"{AUDIENCE}*", "http://exemplo.example")
    ):
        found.append("Audience diferente da constante do Verax Control, ou aceitando curinga")
    return found


def problems_role(template):
    """Um papel só, com nome, caminho e sessão fixos, preso ao limite e só com as duas políticas da pilha."""
    found = []
    roles = sorted(name for name, r in template["Resources"].items() if r["Type"] == "AWS::IAM::Role")
    if roles != ["ReaderRole"]:
        found.append(f"papéis na pilha: {roles}")
    role = template["Resources"].get("ReaderRole", {}).get("Properties", {})
    if (role.get("RoleName"), role.get("Path")) != ("verax-control-reader", "/verax/"):
        found.append("papel fora do nome e do caminho fixos: o ARN deixaria de sair só do ID da conta")
    if role.get("MaxSessionDuration") != 3600:
        found.append("sessão diferente de 1 hora")
    if role.get("PermissionsBoundary") != {"Ref": "ReaderPolicy"}:
        found.append("papel sem o limite de permissões da política de leitura")
    if role.get("ManagedPolicyArns") != [{"Ref": "ReaderPolicy"}, {"Ref": "GuardrailsPolicy"}]:
        found.append("papel sem as duas políticas da pilha, ou com outra")
    if "Policies" in role:
        found.append("papel com política em linha")
    for name, policy in managed_policies(template).items():
        if "Roles" in policy["Properties"]:
            found.append(f"{name}: anexada a outro papel")
    return found


def problems_ip_deny(template):
    found = []
    # A condição inteira: fora do IP do nó, e só a chamada feita direto com a sessão (aws:ViaAWSService falso). A chave
    # está sempre no pedido, então o Bool vale como está escrito; nenhuma outra chave nem outro operador.
    expected = {
        "Sid": "SoDoNoDaVerax",
        "Effect": "Deny",
        "Action": "*",
        "Resource": "*",
        "Condition": {
            "NotIpAddress": {"aws:SourceIp": {"Fn::Split": [",", {"Ref": "NodeEgressIps"}]}},
            "Bool": {"aws:ViaAWSService": "false"},
        },
    }
    guardrails = managed_policies(template).get("GuardrailsPolicy")
    if guardrails is None or expected not in guardrails["Properties"]["PolicyDocument"]["Statement"]:
        found.append("sem o Deny de toda chamada direta de fora do IP do nó")
    parameter = template["Parameters"].get("NodeEgressIps", {})
    if "Default" in parameter or not parameter.get("AllowedPattern", "").endswith("/32){0,3}$"):
        found.append("NodeEgressIps sem /32 obrigatório")
    role = template["Resources"].get("ReaderRole", {}).get("Properties", {})
    if {"Ref": "GuardrailsPolicy"} not in role.get("ManagedPolicyArns", []):
        found.append("negações fora do papel")
    return found


def problems_read_only(template):
    """Toda ação liberada está na lista exata de leitura, e cada uma no alcance dela: o Decrypt só pelo S3, a leitura
    das etiquetas e a simulação só no próprio papel, e o conteúdo (objetos, eventos de log e achados) só nas
    declarações das autorizações, iguais às esperadas, ou nos recursos informados e criados pela pilha."""
    found = []
    own_role = {"Fn::Sub": "arn:${AWS::Partition}:iam::${AWS::AccountId}:role/verax/verax-control-reader"}
    for statement in all_statements(template):
        if statement["Effect"] != "Allow":
            continue
        sid = statement.get("Sid")
        if "NotAction" in statement or "NotResource" in statement:
            found.append(f"{sid}: NotAction ou NotResource num Allow")
            continue
        if sid in EXPECTED_CAPABILITY_STATEMENTS and statement != EXPECTED_CAPABILITY_STATEMENTS[sid]:
            found.append(f"{sid}: diferente da declaração esperada da autorização")
        resources = as_list(statement["Resource"])
        for action in as_list(statement["Action"]):
            if action not in ALLOWED_ACTIONS or WRITE_VERB.search(action):
                found.append(f"{sid}: {action} não está na lista de leitura")
            if action == "kms:Decrypt":
                service = statement.get("Condition", {})
                via = service.get("StringLike", service.get("StringEquals", {})).get("kms:ViaService")
                if via not in ("s3.*.amazonaws.com", {"Fn::Sub": "s3.${AWS::Region}.amazonaws.com"}):
                    found.append(f"{sid}: kms:Decrypt fora do S3")
            if action in {"iam:SimulatePrincipalPolicy", "iam:GetRole"} and statement["Resource"] != own_role:
                found.append(f"{sid}: {action} em outro principal")
            if sid in EXPECTED_CAPABILITY_STATEMENTS:
                continue
            if action in CAPABILITY_ONLY_ACTIONS:
                found.append(f"{sid}: {action} fora da declaração da autorização")
            if action in CONTENT_ACTIONS and any(
                isinstance(r, str) and any(wildcard(r, probe) for probe in ANY_RESOURCE) for r in resources
            ):
                found.append(f"{sid}: {action} em qualquer recurso")
    return found


def problems_capabilities(template):
    """Cada autorização é um parâmetro true/false, ligado por padrão, e as declarações dela (e só elas) dependem da
    condição dela; as da descoberta não dependem de nenhuma; e as etiquetas do papel dizem o modelo e o que foi
    autorizado."""
    found = []
    reader = managed_policies(template).get("ReaderPolicy", {}).get("Properties", {}).get("PolicyDocument")
    by_sid = {s.get("Sid"): condition for condition, s in conditional_statements(reader)} if reader else {}
    for sid in ALWAYS_SIDS:
        if by_sid.get(sid, "ausente") is not None:
            found.append(f"{sid}: a descoberta não pode depender de uma condição")
    for parameter, capability in CAPABILITIES.items():
        spec = template["Parameters"].get(parameter, {})
        if (spec.get("Type"), spec.get("AllowedValues"), spec.get("Default")) != ("String", ["true", "false"], "true"):
            found.append(f"{parameter}: não é um parâmetro true/false ligado por padrão")
        expected = {"Fn::Equals": [{"Ref": parameter}, "true"]}
        if template.get("Conditions", {}).get(capability["condition"]) != expected:
            found.append(f"{capability['condition']}: não é o parâmetro {parameter} igual a true")
        behind = {sid for sid, condition in by_sid.items() if condition == capability["condition"]}
        if behind != capability["sids"]:
            found.append(f"{parameter}: as declarações que dependem dela são {sorted(behind)}")
    tags = template["Resources"].get("ReaderRole", {}).get("Properties", {}).get("Tags")
    pieces = ["discovery"] + [
        {"Fn::If": [capability["condition"], f" {capability['tag']}", ""]} for capability in CAPABILITIES.values()
    ]
    if tags != [
        {"Key": "verax-control:template", "Value": TEMPLATE_VERSION},
        {"Key": "verax-control:capabilities", "Value": {"Fn::Join": ["", pieces]}},
    ]:
        found.append("papel sem as etiquetas do modelo e do que foi autorizado")
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
        if kind == "AWS::IAM::Role":
            return self.resolve(props["RoleName"])
        if kind == "AWS::S3::Bucket":
            # Sem BucketName, o CloudFormation gera <pilha>-<id lógico em minúsculas>-<sufixo aleatório>.
            if "BucketName" in props:
                return self.resolve(props["BucketName"])
            return f"{STACK_NAME}-{name.lower()}-1a2b3c4d5e6f"
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
        if kind == "AWS::IAM::Role":
            path = resource["Properties"]["Path"]
            return f"arn:aws:iam::{ACCOUNT}:role{path}{self.ref(name)}"
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

    def role_policies(self, extra=()):
        """As políticas do papel (anexadas e em linha) e o limite de permissões."""
        documents = self.documents_by_arn()
        role = self.properties("ReaderRole")
        identity = [documents[arn] for arn in role.get("ManagedPolicyArns", [])]
        identity += [policy["PolicyDocument"] for policy in role.get("Policies", [])]
        identity += list(extra)
        boundary = documents.get(role["PermissionsBoundary"]) if "PermissionsBoundary" in role else None
        return identity, boundary

    def allows(self, action, resource="*", source_ip=NODE_IP, extra=(), **context):
        """Decide uma chamada feita com a sessão do papel. As chaves do contexto vêm com _ no lugar do primeiro :
        (kms_ViaService). A chamada é direta (aws:ViaAWSService falso, que a AWS sempre põe no pedido), a menos que o
        teste diga o contrário."""
        context = {
            "aws:SourceIp": source_ip,
            "aws:ViaAWSService": "false",
            **{key.replace("_", ":", 1): value for key, value in context.items()},
        }
        identity, boundary = self.role_policies(extra)
        return decide(identity, boundary, action, resource, context)

    def lists(self, bucket, prefix=None, delimiter=None, **context):
        """Decide uma listagem do bucket (ListObjectsV2) com o prefixo e o separador do pedido: o S3 só põe no pedido
        as chaves s3:prefix e s3:delimiter dos parâmetros que vieram."""
        if prefix is not None:
            context["s3_prefix"] = prefix
        if delimiter is not None:
            context["s3_delimiter"] = delimiter
        return self.allows("s3:ListBucket", f"arn:aws:s3:::{bucket}", **context)

    def reads_log_group(self, action, arn, tag=None, **context):
        """Decide a leitura de um grupo de log (ou de um stream dele) com a etiqueta verax-control que o grupo tem."""
        if tag is not None:
            context[f"aws_ResourceTag/{LOG_GROUP_TAG[0]}"] = tag
        return self.allows(action, arn, **context)

    def assumes(self, kind, principal, action, context):
        """Decide a entrada no papel pela política de confiança, como o STS: uma negação vence, e é preciso uma
        permissão. Quem chega pela federação não tem política de identidade na AWS."""
        trust = self.properties("ReaderRole")["AssumeRolePolicyDocument"]["Statement"]
        hits = [s for s in trust if principal_matches(s, kind, principal) and applies(s, action, "*", context)]
        return any(s["Effect"] == "Allow" for s in hits) and not any(s["Effect"] == "Deny" for s in hits)

    def node_assumes(self, token=None, source_ip=NODE_IP):
        """O nó troca o token do Google pela sessão do papel (AssumeRoleWithWebIdentity)."""
        token = google_token() if token is None else token
        return self.assumes("Federated", GOOGLE, WEB_IDENTITY, web_identity_context(token, source_ip))


def principal_matches(statement, kind, principal):
    assert "NotPrincipal" not in statement, "NotPrincipal sem suporte no teste"
    declared = statement["Principal"]
    if declared == "*":
        return True
    return any(value in ("*", principal) for value in as_list(declared.get(kind, [])))


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
    if operator == "IpAddress":
        return value is not None and any(ipaddress.ip_address(value) in ipaddress.ip_network(c) for c in expected)
    if operator == "NotIpAddress":
        # Operador negado: sem a chave no pedido, a condição vale (e a negação se aplica).
        return value is None or not any(ipaddress.ip_address(value) in ipaddress.ip_network(c) for c in expected)
    if operator == "StringLike":
        return value is not None and any(wildcard(pattern, value) for pattern in expected)
    if operator == "StringEquals":
        # Um valor vazio na política ("") só casa com a chave presente e vazia no pedido.
        return value is not None and value in expected
    if operator == "Bool":
        # Sem a chave no pedido, a condição não vale.
        return value is not None and str(value).lower() in {str(item).lower() for item in expected}
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
    if action in {"iam:SimulatePrincipalPolicy", "iam:GetRole"}:
        return ROLE_ARN
    return "*"


def log_group(name="/aws/lambda/pedidos", region="sa-east-1", account=ACCOUNT):
    return f"arn:aws:logs:{region}:{account}:log-group:{name}"


def combinations():
    """As oito combinações das três autorizações."""
    for values in itertools.product(("true", "false"), repeat=len(CAPABILITIES)):
        yield dict(zip(CAPABILITIES, values))


def readme_block(language, after):
    """O primeiro bloco de código da linguagem dada depois do título indicado, no README."""
    text = README.read_text(encoding="utf-8").split(after, 1)[1]
    return re.search(rf"```{language}\n(.*?)\n```", text, re.DOTALL).group(1)


class ReaderTemplateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.template = cfn_yaml.load(str(TEMPLATE))
        cls.resources = cls.template["Resources"]
        cls.parameters = cls.template["Parameters"]

    def stack(self, **values):
        """A pilha do exemplo: o nó, os três buckets adicionais com a chave e as três autorizações (ligadas por
        padrão)."""
        return Stack(self.template, **{**EXAMPLE, **values})

    def legacy(self, **values):
        """A pilha do exemplo sem nenhuma autorização: do conteúdo, só os buckets adicionais informados (o modelo 1)."""
        return Stack(self.template, **{**EXAMPLE, **ALL_OFF, **values})

    def node_only(self, **values):
        """Só o nó: nenhum bucket adicional, nada criado pela pilha, e as autorizações dadas (ligadas por padrão)."""
        return Stack(self.template, **{**NODE, **values})

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

    def assert_rule_refuses_empty(self, parameter):
        """A regra NoDaVeraxObrigatorio recusa o parâmetro vazio, se o padrão dele deixar passar."""
        stack = self.stack()
        assertions = self.template["Rules"]["NoDaVeraxObrigatorio"]["Assertions"]
        rule = next(a["Assert"] for a in assertions if {"Ref": parameter} in a["Assert"]["Fn::Not"][0]["Fn::Equals"])
        self.assertTrue(stack.resolve(rule))
        stack.params[parameter] = ""
        self.assertFalse(stack.resolve(rule))

    # --- O que a pilha cria ---

    def test_by_default_only_the_role_and_the_two_policies(self):
        stack = Stack(self.template, **NODE)
        self.assertEqual(set(stack.resources), {"ReaderPolicy", "GuardrailsPolicy", "ReaderRole"})
        for name, resource in self.resources.items():
            if name not in stack.resources:
                with self.subTest(resource=name):
                    self.assertIn(resource["Condition"], {"CreatesTrail", "ExportsGuardDuty", "CreatesLogBucket"})
        self.assertEqual(self.parameters["CreateTrail"]["Default"], "false")
        self.assertEqual(self.parameters["EnableGuardDutyExport"]["Default"], "false")

    def test_no_user_key_or_secret_anywhere(self):
        self.assertEqual(problems_no_user_or_key(self.template), [])
        self.assertEqual(
            set(self.template["Outputs"]),
            {"RoleArn", "TrailBucketArn", "GuardDutyBucketArn", "LogsKeyArn", "AccessLogsBucketArn"},
        )
        self.assertFalse([name for name, spec in self.parameters.items() if spec.get("NoEcho")])

    def test_role_and_policies_live_under_verax_with_a_predictable_arn(self):
        self.assertEqual(problems_role(self.template), [])
        # O ARN sai só do ID da conta (o painel nunca o pede), e é o que a saída da pilha mostra.
        stack = self.stack()
        self.assertEqual(stack.ref("ReaderRole"), "verax-control-reader")
        self.assertEqual(stack.attribute("ReaderRole", "Arn"), ROLE_ARN)
        self.assertEqual(self.template["Outputs"]["RoleArn"]["Value"], {"Fn::GetAtt": ["ReaderRole", "Arn"]})
        self.assertEqual(stack.resolve(self.template["Outputs"]["RoleArn"]["Value"]), ROLE_ARN)
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

    def test_template_fits_the_create_stack_body(self):
        # O console ("Upload a template file") e a CLI mandam o arquivo no TemplateBody, que vai até 51.200 bytes:
        # acima disso, o cliente precisaria de um bucket só para o template.
        self.assertLess(TEMPLATE.stat().st_size, 51200)

    def test_waf_is_never_touched_and_guardduty_is_never_enabled(self):
        types = {resource["Type"] for resource in self.resources.values()}
        self.assertFalse({t for t in types if t.startswith("AWS::WAF")})
        self.assertNotIn("AWS::GuardDuty::Detector", types)
        # Do WAF, o papel só enxerga as Web ACLs e para onde vai o log de cada uma (a descoberta): nem as regras.
        allowed = {a for s in all_statements(self.template) if s["Effect"] == "Allow" for a in as_list(s["Action"])}
        self.assertEqual(
            {a for a in allowed if a.startswith("wafv2:")},
            {"wafv2:GetLoggingConfiguration", "wafv2:ListLoggingConfigurations", "wafv2:ListWebACLs"},
        )
        self.assertEqual(
            {a for a in allowed if a.startswith("guardduty:")} - CAPABILITIES["ReadSecurityFindings"]["actions"],
            {a for a in VALIDATION_CALLS if a.startswith("guardduty:")},
        )

    # --- Quem entra no papel ---

    def test_the_trust_has_the_four_exact_conditions(self):
        self.assertEqual(problems_trust(self.template), [])
        (statement,) = self.stack().properties("ReaderRole")["AssumeRolePolicyDocument"]["Statement"]
        self.assertEqual(
            statement,
            {
                "Sid": "SoONoDaVerax",
                "Effect": "Allow",
                "Principal": {"Federated": GOOGLE},
                "Action": WEB_IDENTITY,
                "Condition": {
                    "StringEquals": {f"{GOOGLE}:aud": NODE_SA, f"{GOOGLE}:sub": NODE_SA, f"{GOOGLE}:oaud": AUDIENCE},
                    "IpAddress": {"aws:SourceIp": [f"{NODE_IP}/32"]},
                },
            },
        )

    def test_only_the_node_token_from_the_node_ip_enters(self):
        stack = self.stack()
        self.assertTrue(stack.node_assumes())
        without_azp = {key: value for key, value in google_token().items() if key != "azp"}
        for case, token, source_ip in (
            ("token de outra conta de serviço", google_token(sub=OTHER_SA), NODE_IP),
            ("token do nó para outro destino", google_token(audience="https://outro-servico.example"), NODE_IP),
            ("token do nó vazado, usado de outro IP", google_token(), OTHER_IP),
            ("token do nó, do IP vizinho", google_token(), "203.0.113.11"),
            ("token com o sub do nó e o azp de outra conta", {**google_token(), "azp": OTHER_SA}, NODE_IP),
            ("token com o azp do nó e outro sub", {**google_token(), "sub": OTHER_SA}, NODE_IP),
            # Sem azp, a AWS lê o aud do próprio aud do token: é o audience, e não o ID da conta de serviço.
            ("token sem azp", without_azp, NODE_IP),
        ):
            with self.subTest(case=case):
                self.assertFalse(stack.node_assumes(token, source_ip))

    def test_another_customer_node_never_enters(self):
        # Confused deputy, sem ExternalId: o cliente A cadastra no painel dele a conta AWS do cliente B. O nó de A chega
        # com o token da conta de serviço de A, do IP de A, e o papel de B (que confia só no nó de B) recusa. O token é
        # assinado pelo Google, e o sub não se forja; nem a partir do IP de B o token de A entra.
        customer_b = self.stack(NodeServiceAccountId=OTHER_SA, NodeEgressIps="198.51.100.20/32")
        self.assertTrue(customer_b.node_assumes(google_token(sub=OTHER_SA), "198.51.100.20"))
        self.assertFalse(customer_b.node_assumes(google_token(sub=NODE_SA), NODE_IP))
        self.assertFalse(customer_b.node_assumes(google_token(sub=NODE_SA), "198.51.100.20"))

    def test_only_web_identity_from_google(self):
        stack = self.stack()
        context = web_identity_context(google_token(), NODE_IP)
        for kind, principal, action in (
            ("Federated", "cognito-identity.amazonaws.com", WEB_IDENTITY),
            ("Federated", "www.amazon.com", WEB_IDENTITY),
            ("Federated", "graph.facebook.com", WEB_IDENTITY),
            ("Federated", f"arn:aws:iam::{ACCOUNT}:saml-provider/Empresa", "sts:AssumeRoleWithSAML"),
            ("Federated", GOOGLE, "sts:AssumeRole"),
            ("AWS", f"arn:aws:iam::{ACCOUNT}:root", "sts:AssumeRole"),
            ("AWS", "arn:aws:iam::222222222222:root", "sts:AssumeRole"),
            ("Service", "ec2.amazonaws.com", "sts:AssumeRole"),
        ):
            with self.subTest(principal=principal, action=action):
                self.assertFalse(stack.assumes(kind, principal, action, context))

    # --- Parâmetros ---

    def test_node_service_account_id_is_required_and_has_21_digits(self):
        parameter = self.parameters["NodeServiceAccountId"]
        self.assertEqual(parameter["Type"], "String")
        self.assertNotIn("Default", parameter)
        self.assert_pattern(
            "NodeServiceAccountId",
            valid=[NODE_SA, OTHER_SA],
            invalid=[
                "",
                "*",
                NODE_SA[:-1],
                f"{NODE_SA}1",
                f"{NODE_SA[:-1]}a",
                f" {NODE_SA}",
                f"{NODE_SA},{OTHER_SA}",
                "verax-homolog@projeto-exemplo.iam.gserviceaccount.com",
            ],
        )
        with self.assertRaisesRegex(ValueError, "obrigatório sem valor: NodeServiceAccountId"):
            Stack(self.template, NodeEgressIps=f"{NODE_IP}/32")
        self.assert_rule_refuses_empty("NodeServiceAccountId")

    def test_audience_is_the_verax_constant(self):
        parameter = self.parameters["Audience"]
        self.assertEqual(parameter["Type"], "String")
        self.assertEqual(parameter["Default"], AUDIENCE)
        self.assert_pattern(
            "Audience",
            valid=[AUDIENCE, "https://exemplo.example/aws"],
            invalid=[
                "",
                "*",
                "https://*",
                f"{AUDIENCE}*",
                f"{AUDIENCE}/",
                AUDIENCE.replace("https://", "http://"),
                AUDIENCE.replace("control", "Control"),
                "https://exemplo.example/a b",
                NODE_SA,
            ],
        )
        self.assert_rule_refuses_empty("Audience")
        # A mesma constante no exemplo sem CloudFormation e no README.
        trust = json.loads(POLICY_JSON.read_text(encoding="utf-8"))["AssumeRolePolicyDocument"]
        self.assertEqual(trust["Statement"][0]["Condition"]["StringEquals"][f"{GOOGLE}:oaud"], AUDIENCE)
        self.assertIn(f"`{AUDIENCE}`", README.read_text(encoding="utf-8"))

    def test_node_egress_ips_are_required_from_one_to_four_and_only_slash_32(self):
        parameter = self.parameters["NodeEgressIps"]
        self.assertEqual(parameter["Type"], "String")
        self.assertNotIn("Default", parameter)
        four = ",".join(f"203.0.113.{i}/32" for i in range(1, 5))
        self.assert_pattern(
            "NodeEgressIps",
            valid=["203.0.113.10/32", "192.0.2.1/32", "255.255.255.255/32", "10.0.0.1/32", four],
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
                ",203.0.113.10/32",
                "203.0.113.10/32,,198.51.100.20/32",
                "203.0.113.10/32, 198.51.100.20/32",
                f"{four},203.0.113.5/32",
                "203.0.113.10/32,0.0.0.0/0",
            ],
        )
        with self.assertRaisesRegex(ValueError, "obrigatório sem valor: NodeEgressIps"):
            Stack(self.template, NodeServiceAccountId=NODE_SA)
        with self.assertRaisesRegex(ValueError, "NodeEgressIps"):
            Stack(self.template, NodeServiceAccountId=NODE_SA, NodeEgressIps="")
        self.assert_rule_refuses_empty("NodeEgressIps")
        # Com dois IPs, os dois entram no papel e leem; um terceiro, não.
        two = self.stack(NodeEgressIps="203.0.113.10/32,198.51.100.20/32")
        for source_ip in (NODE_IP, "198.51.100.20"):
            with self.subTest(source_ip=source_ip):
                self.assertTrue(two.node_assumes(source_ip=source_ip))
                self.assertTrue(two.allows("iam:ListUsers", source_ip=source_ip))
        self.assertFalse(two.node_assumes(source_ip=OTHER_IP))
        self.assertFalse(two.allows("iam:ListUsers", source_ip=OTHER_IP))

    def test_node_egress_ips_match_the_node_conf_check(self):
        # O install.sh confere cada IP do NODE_EGRESS_IPS com a mesma expressão: o IP que o nó aceita é o que a pilha
        # aceita (a pilha só limita a 4).
        script = INSTALL_SH.read_text(encoding="utf-8")
        octet = re.search(r"^octet='([^']+)'$", script, re.MULTILINE).group(1)
        self.assertIn('egress_ip="$octet(\\\\.$octet){3}/32"', script)
        ip = f"{octet}(\\.{octet}){{3}}/32"
        self.assertEqual(self.parameters["NodeEgressIps"]["AllowedPattern"], f"^{ip}(,{ip}){{0,3}}$")

    def test_log_sources_accept_only_exact_arns(self):
        self.assert_pattern(
            "LogBucketArns",
            valid=["", *BUCKETS, "arn:aws:s3:::findings.guardduty-1"],
            invalid=["*", "arn:aws:s3:::*", "arn:aws:s3:::bucket/*", "trilha-111111111111", "arn:aws:s3:::a*"],
        )
        # Chave comum (UUID) ou multirregião (mrk- e 32 hexadecimais); nada de curinga, alias ou id fora do formato.
        self.assert_pattern(
            "LogKmsKeyArns",
            valid=["", KMS_KEY, KMS_MRK],
            invalid=[
                "*",
                f"arn:aws:kms:sa-east-1:{ACCOUNT}:key/*",
                f"arn:aws:kms:sa-east-1:{ACCOUNT}:alias/x",
                f"arn:aws:kms:sa-east-1:{ACCOUNT}:key/mrk-*",
                KMS_MRK[:-1],
                KMS_MRK.replace("mrk-", "MRK-"),
                f"arn:aws:kms:sa-east-1:{ACCOUNT}:key/{'0' * 36}",
            ],
        )
        stack = self.stack(LogKmsKeyArns=f"{KMS_KEY},{KMS_MRK}")
        self.assertTrue(stack.allows("kms:Decrypt", KMS_MRK, kms_ViaService="s3.sa-east-1.amazonaws.com"))
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

    def test_guardduty_export_requires_an_existing_detector(self):
        with self.assertRaisesRegex(ValueError, "ExportPrecisaDoDetector"):
            self.stack(EnableGuardDutyExport="true")
        stack = self.stack(EnableGuardDutyExport="true", GuardDutyDetectorId="a" * 32)
        self.assertEqual(stack.properties("GuardDutyExport")["DetectorId"], "a" * 32)
        self.assert_pattern("GuardDutyDetectorId", valid=["", "a" * 32], invalid=["*", "a" * 31, "A" * 32])

    # --- O que o papel pode fazer ---

    def test_every_allow_only_reads(self):
        self.assertEqual(problems_read_only(self.template), [])

    def test_wazuh_posture_and_validation_calls_are_allowed_from_the_node(self):
        # Sem nenhuma autorização (o modelo 1): os buckets adicionais informados, a postura, a validação e a descoberta.
        stack = self.legacy()
        for group, calls in (
            ("wazuh", WAZUH_CALLS),
            ("postura", POSTURE_CALLS),
            ("validação", VALIDATION_CALLS),
            ("descoberta", DISCOVERY_CALLS),
        ):
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
        # A chave só decifra pelo S3, e a simulação só vale para o próprio papel.
        self.assertFalse(stack.allows("kms:Decrypt", KMS_KEY))
        self.assertFalse(stack.allows("kms:Decrypt", KMS_KEY, kms_ViaService="secretsmanager.sa-east-1.amazonaws.com"))
        # A simulação e a leitura das etiquetas só valem para o próprio papel.
        for action in ("iam:SimulatePrincipalPolicy", "iam:GetRole"):
            for other in ("user/admin", "role/admin", "role/verax/outro", "role/verax-control-reader"):
                with self.subTest(action=action, other=other):
                    self.assertFalse(stack.allows(action, f"arn:aws:iam::{ACCOUNT}:{other}"))

    def test_no_allowed_call_is_cancelled_by_an_unconditional_deny(self):
        denied = {a for s in all_statements(self.template) if is_unconditional_deny(s) for a in as_list(s["Action"])}
        allowed = {a for s in all_statements(self.template) if s["Effect"] == "Allow" for a in as_list(s["Action"])}
        clashes = {action for action in allowed if matches(action, denied)}
        self.assertFalse(clashes, f"ações liberadas e negadas ao mesmo tempo: {sorted(clashes)}")
        self.assertTrue(WAZUH_CALLS | POSTURE_CALLS | VALIDATION_CALLS | DISCOVERY_CALLS <= allowed)
        for capability in CAPABILITIES.values():
            self.assertTrue(capability["actions"] <= allowed)

    def test_every_allowed_action_is_in_the_exact_read_list(self):
        # Nos dois sentidos: nada liberado fora da lista, e nada na lista que o template não use (uma ação tirada do
        # template sai da lista também). Nenhum curinga numa ação liberada, e nenhum verbo de escrita.
        allowed = {a for s in all_statements(self.template) if s["Effect"] == "Allow" for a in as_list(s["Action"])}
        self.assertEqual(allowed, set(ALLOWED_ACTIONS))
        self.assertFalse({action for action in allowed if "*" in action or "?" in action})
        self.assertFalse({action for action in allowed if WRITE_VERB.search(action)})
        self.assertEqual(
            set(ALLOWED_ACTIONS),
            WAZUH_CALLS
            | POSTURE_CALLS
            | VALIDATION_CALLS
            | DISCOVERY_CALLS
            | set().union(*(capability["actions"] for capability in CAPABILITIES.values())),
        )
        # O mesmo na pilha montada, com tudo ligado: o que a política de leitura diz é o que a lista diz.
        stack = self.stack(CreateTrail="true", EnableGuardDutyExport="true", GuardDutyDetectorId="a" * 32)
        document = stack.policy_document("ReaderPolicy")
        self.assertEqual({s["Effect"] for s in document["Statement"]}, {"Allow"})
        self.assertEqual({a for s in document["Statement"] for a in as_list(s["Action"])}, set(ALLOWED_ACTIONS))
        # A política de negação não libera nada.
        self.assertEqual({s["Effect"] for s in stack.policy_document("GuardrailsPolicy")["Statement"]}, {"Deny"})

    def test_without_any_authorization_nothing_of_content_is_readable(self):
        # Só o nó, com as três autorizações desligadas: nenhum objeto, nenhuma listagem de bucket, nenhum Decrypt,
        # nenhum evento de log e nenhum achado. A descoberta e a postura continuam.
        stack = self.node_only(**ALL_OFF)
        for action in sorted(CONTENT_ACTIONS):
            with self.subTest(action=action):
                self.assertFalse(
                    stack.allows(action, resource_for(action), kms_ViaService="s3.sa-east-1.amazonaws.com")
                )
        self.assertFalse(stack.allows("s3:GetObject", f"arn:aws:s3:::qualquer/AWSLogs/{ACCOUNT}/CloudTrail/x.json.gz"))
        self.assertFalse(stack.lists("qualquer", prefix="", delimiter="/"))
        self.assertFalse(stack.lists("qualquer", prefix=f"AWSLogs/{ACCOUNT}/CloudTrail/"))
        for action in sorted(CAPABILITIES["ReadSecurityFindings"]["actions"]):
            with self.subTest(action=action):
                self.assertFalse(stack.allows(action))
        for action in sorted(CAPABILITIES["ReadTaggedLogGroups"]["actions"]):
            with self.subTest(action=action):
                self.assertFalse(stack.reads_log_group(action, log_group(), tag=LOG_GROUP_TAG[1]))
        self.assertEqual(
            {s["Sid"] for s in stack.policy_document("ReaderPolicy")["Statement"]},
            ALWAYS_SIDS,
        )
        for action in sorted(POSTURE_CALLS | VALIDATION_CALLS | DISCOVERY_CALLS):
            with self.subTest(action=action):
                self.assertTrue(stack.allows(action, resource_for(action)))

    def test_derived_object_arns_cover_exactly_the_informed_buckets(self):
        for count in (1, 2, 3):
            with self.subTest(count=count):
                stack = self.stack(LogBucketArns=",".join(BUCKETS[:count]))
                document = stack.policy_document("ReaderPolicy")
                by_sid = {s["Sid"]: s for s in document["Statement"]}
                self.assertEqual(by_sid["LerObjetosDeLog"]["Resource"], [f"{arn}/*" for arn in BUCKETS[:count]])
                self.assertEqual(by_sid["ListarBucketsDeLog"]["Resource"], BUCKETS[:count])

    def test_listed_kms_keys_only_enter_without_the_service_logs_authorization(self):
        # Com a autorização dos logs da AWS, o Decrypt pelo S3 já vale para a chave de qualquer objeto que o papel lê:
        # a lista de chaves não se repete na política (que fica longe do limite de tamanho). Sem ela, só as da lista.
        on = {s["Sid"] for s in self.stack().policy_document("ReaderPolicy")["Statement"]}
        self.assertIn("DecifrarLogsDaAwsSoPeloS3", on)
        self.assertNotIn("DecifrarSoPeloS3", on)
        off = self.stack(ReadAwsServiceLogs="false")
        by_sid = {s["Sid"]: s for s in off.policy_document("ReaderPolicy")["Statement"]}
        self.assertNotIn("DecifrarLogsDaAwsSoPeloS3", by_sid)
        self.assertEqual(by_sid["DecifrarSoPeloS3"]["Resource"], [KMS_KEY])
        for stack in (self.stack(), off):
            self.assertTrue(stack.allows("kms:Decrypt", KMS_KEY, kms_ViaService="s3.sa-east-1.amazonaws.com"))
            self.assertFalse(stack.allows("kms:Decrypt", KMS_KEY))

    def test_excess_permission_sample_stays_outside_the_policy(self):
        # A amostra que o worker simula uma vez por dia no próprio papel (web-identity-checker.ts): cada ação, no
        # recurso da amostra, do IP do nó e sem nenhuma outra chave no contexto. Com tudo autorizado, nenhuma é
        # permitida; se uma passasse, toda conta conectada ganharia o aviso de permissão demais.
        source = CHECKER_TS.read_text(encoding="utf-8")
        block = re.search(r"export const EXCESS_PERMISSION_SAMPLE = \[(.*?)\] as const;", source, re.DOTALL).group(1)
        sample = re.findall(r"'([a-z0-9-]+:[A-Za-z0-9]+)'", block)
        resource = re.search(r"export const EXCESS_PERMISSION_RESOURCE =\s*'([^']+)';", source).group(1)
        self.assertGreaterEqual(len(sample), 10)
        self.assertIn("kms:Decrypt", sample)
        self.assertIn("s3:GetObject", sample)
        everything = self.stack(CreateTrail="true", EnableGuardDutyExport="true", GuardDutyDetectorId="a" * 32)
        for stack in (everything, self.stack(), self.node_only(), self.legacy()):
            for action in sample:
                with self.subTest(action=action):
                    self.assertFalse(stack.allows(action, resource))
        # E a simulação continua liberada, só no próprio papel.
        self.assertTrue(everything.allows("iam:SimulatePrincipalPolicy", ROLE_ARN))

    # --- As três autorizações do cliente ---

    def test_capabilities_are_three_switches_on_by_default(self):
        self.assertEqual(problems_capabilities(self.template), [])
        for parameter in CAPABILITIES:
            for value in ("", "yes", "True", "1"):
                with self.subTest(parameter=parameter, value=value):
                    with self.assertRaisesRegex(ValueError, parameter):
                        self.node_only(**{parameter: value})
        # No console, as três ficam num grupo só, e todo parâmetro tem grupo e rótulo.
        interface = self.template["Metadata"]["AWS::CloudFormation::Interface"]
        groups = [group["Parameters"] for group in interface["ParameterGroups"]]
        self.assertIn(list(CAPABILITIES), groups)
        self.assertEqual(sorted(name for group in groups for name in group), sorted(self.parameters))
        self.assertEqual(set(interface["ParameterLabels"]), set(self.parameters))

    def test_each_capability_adds_exactly_its_statements(self):
        for capabilities in combinations():
            with self.subTest(**capabilities):
                stack = self.node_only(**capabilities)
                on = [CAPABILITIES[name] for name, value in capabilities.items() if value == "true"]
                document = stack.policy_document("ReaderPolicy")
                self.assertEqual(
                    {s["Sid"] for s in document["Statement"]},
                    ALWAYS_SIDS | set().union(*(capability["sids"] for capability in on)),
                )
                self.assertEqual(
                    {a for s in document["Statement"] for a in as_list(s["Action"])},
                    POSTURE_CALLS
                    | VALIDATION_CALLS
                    | DISCOVERY_CALLS
                    | set().union(*(capability["actions"] for capability in on)),
                )
                # As negações não dependem do que foi autorizado.
                self.assertEqual(
                    [s["Sid"] for s in stack.policy_document("GuardrailsPolicy")["Statement"]],
                    [
                        "SoDoNoDaVerax",
                        "NuncaAlterarLogs",
                        "NuncaAlterarOutrasFontes",
                        "NuncaTrocarAsPropriasEtiquetas",
                        "NuncaAmpliarOProprioAcesso",
                    ],
                )
        # Cada declaração de uma autorização chega à política como o template a escreve, com a conta desta pilha.
        by_sid = {s["Sid"]: s for s in self.node_only().policy_document("ReaderPolicy")["Statement"]}
        self.assertEqual(
            by_sid["LerLogsDaAwsDestaConta"]["Resource"],
            [f"arn:aws:s3:::*/AWSLogs/{ACCOUNT}/*", f"arn:aws:s3:::*/AWSLogs/o-*/{ACCOUNT}/*"],
        )
        self.assertEqual(
            by_sid["ListarLogsDaAwsDestaConta"]["Condition"],
            {"StringLike": {"s3:prefix": [f"AWSLogs/{ACCOUNT}/*", f"AWSLogs/o-*/{ACCOUNT}/*"]}},
        )
        self.assertEqual(
            by_sid["VerPrimeiroNivelDosBuckets"]["Condition"],
            {"StringEquals": {"s3:delimiter": "/", "s3:prefix": ["", "AWSLogs", "AWSLogs/"]}},
        )
        self.assertEqual(
            by_sid["LerGruposDeLogEtiquetados"]["Resource"],
            [f"arn:aws:logs:*:{ACCOUNT}:log-group:*", f"arn:aws:logs:*:{ACCOUNT}:log-group:*:*"],
        )
        self.assertEqual(
            by_sid["LerGruposDeLogEtiquetados"]["Condition"],
            {"StringEquals": {"aws:ResourceTag/verax-control": "leitura"}},
        )

    def test_service_logs_read_only_this_account_under_awslogs(self):
        stack = self.node_only(ReadSecurityFindings="false", ReadTaggedLogGroups="false")
        bucket = "arn:aws:s3:::um-bucket-que-ninguem-informou"
        for key in (
            f"AWSLogs/{ACCOUNT}/CloudTrail/sa-east-1/2026/11/04/{ACCOUNT}_CloudTrail_sa-east-1_x.json.gz",
            f"AWSLogs/{ACCOUNT}/vpcflowlogs/sa-east-1/2026/11/04/x.log.gz",
            f"AWSLogs/{ACCOUNT}/WAFLogs/sa-east-1/loja/2026/11/04/10/00/x.log.gz",
            f"AWSLogs/{ACCOUNT}/GuardDuty/sa-east-1/2026/11/04/x.jsonl.gz",
            f"AWSLogs/{ACCOUNT}/elasticloadbalancing/sa-east-1/2026/11/04/x.log.gz",
            f"AWSLogs/{ACCOUNT}/Config/sa-east-1/2026/11/4/ConfigHistory/x.json.gz",
            f"AWSLogs/o-exemplo123/{ACCOUNT}/CloudTrail/sa-east-1/2026/11/04/x.json.gz",
            # Um prefixo próprio antes de AWSLogs: o objeto é legível, mas a pasta não é listável (abaixo); para o
            # coletor ler um bucket assim, ele vai em LogBucketArns.
            f"empresa/AWSLogs/{ACCOUNT}/CloudTrail/sa-east-1/x.json.gz",
        ):
            with self.subTest(readable=key):
                self.assertTrue(stack.allows("s3:GetObject", f"{bucket}/{key}"))
        for key in (
            # Os logs de outra conta no mesmo bucket, na pasta dela ou na da organização.
            "AWSLogs/222222222222/CloudTrail/sa-east-1/x.json.gz",
            "AWSLogs/o-exemplo123/222222222222/CloudTrail/sa-east-1/x.json.gz",
            # Um ID que só começa ou termina igual, a pasta sem a barra e outro uso de maiúsculas.
            f"AWSLogs/{ACCOUNT}0/CloudTrail/x.json.gz",
            f"AWSLogs/9{ACCOUNT}/CloudTrail/x.json.gz",
            f"AWSLogs/o-exemplo123/9{ACCOUNT}/CloudTrail/x.json.gz",
            f"AWSLogs/{ACCOUNT}",
            f"awslogs/{ACCOUNT}/CloudTrail/x.json.gz",
            f"AWSLogs-{ACCOUNT}/x.json.gz",
            f"AWSLogs/x-exemplo123/{ACCOUNT}/CloudTrail/x.json.gz",
            # O resto do bucket.
            f"{ACCOUNT}/x.json.gz",
            "financeiro/folha.csv",
            "backup.sql",
        ):
            with self.subTest(unreadable=key):
                self.assertFalse(stack.allows("s3:GetObject", f"{bucket}/{key}"))
        # O limite que o comentário do template declara: o * do IAM casa com a /, e um objeto com o caminho desta conta
        # mais adiante no nome também passa. Os logs gravados pela AWS nunca têm esse formato.
        self.assertTrue(stack.allows("s3:GetObject", f"{bucket}/AWSLogs/222222222222/x/AWSLogs/{ACCOUNT}/y"))
        # Nenhuma outra leitura de objeto, nem com uma política de administrador anexada ao papel.
        for action in ("s3:GetObjectVersion", "s3:GetObjectAcl", "s3:GetObjectTagging", "s3:PutObject"):
            with self.subTest(action=action):
                self.assertFalse(stack.allows(action, f"{bucket}/AWSLogs/{ACCOUNT}/x.json.gz", extra=[ADMIN]))
        # O KMS: a chave de qualquer objeto que o papel lê, mas só quando quem pede é o S3.
        other_account_key = "arn:aws:kms:us-east-1:222222222222:key/99999999-0000-0000-0000-000000000000"
        for key in (KMS_KEY, KMS_MRK, other_account_key):
            with self.subTest(key=key):
                self.assertTrue(stack.allows("kms:Decrypt", key, kms_ViaService="s3.us-east-1.amazonaws.com"))
                self.assertFalse(stack.allows("kms:Decrypt", key))
                self.assertFalse(stack.allows("kms:Decrypt", key, kms_ViaService="ec2.us-east-1.amazonaws.com"))
                for action in ("kms:Encrypt", "kms:GenerateDataKey", "kms:ReEncryptFrom", "kms:CreateGrant"):
                    self.assertFalse(stack.allows(action, key, kms_ViaService="s3.us-east-1.amazonaws.com"))
        # Desligada, nada disso.
        off = self.node_only(ReadAwsServiceLogs="false")
        self.assertFalse(off.allows("s3:GetObject", f"{bucket}/AWSLogs/{ACCOUNT}/CloudTrail/x.json.gz"))
        self.assertFalse(off.allows("kms:Decrypt", KMS_KEY, kms_ViaService="s3.us-east-1.amazonaws.com"))

    def test_service_logs_list_only_the_account_folders_and_the_first_level(self):
        stack = self.node_only(ReadSecurityFindings="false", ReadTaggedLogGroups="false")
        bucket = "um-bucket-que-ninguem-informou"
        # O que o Wazuh pede com a conta e a região configuradas: o prefixo exato, com ou sem separador.
        for prefix in (
            f"AWSLogs/{ACCOUNT}/CloudTrail/sa-east-1/",
            f"AWSLogs/{ACCOUNT}/CloudTrail/sa-east-1/2026/11/04/",
            f"AWSLogs/{ACCOUNT}/vpcflowlogs/sa-east-1/",
            f"AWSLogs/{ACCOUNT}/WAFLogs/sa-east-1/loja/",
            f"AWSLogs/{ACCOUNT}/",
            f"AWSLogs/o-exemplo123/{ACCOUNT}/CloudTrail/sa-east-1/",
        ):
            with self.subTest(prefix=prefix):
                self.assertTrue(stack.lists(bucket, prefix=prefix))
                self.assertTrue(stack.lists(bucket, prefix=prefix, delimiter="/"))
        # O check_bucket do Wazuh (Prefix="" e Delimiter="/") e a sonda do GuardDuty (Prefix="AWSLogs"): só o primeiro
        # nível do bucket e o da pasta AWSLogs, sempre com o separador.
        for prefix in ("", "AWSLogs", "AWSLogs/"):
            with self.subTest(first_level=prefix):
                self.assertTrue(stack.lists(bucket, prefix=prefix, delimiter="/"))
                # Sem o separador, a mesma listagem desceria o bucket inteiro (ou a pasta AWSLogs de todas as contas).
                self.assertFalse(stack.lists(bucket, prefix=prefix))
                self.assertFalse(stack.lists(bucket, prefix=prefix, delimiter="|"))
                self.assertFalse(stack.lists(bucket, prefix=prefix, delimiter=""))
        for case, arguments in (
            ("o bucket inteiro, sem prefixo nem separador", {}),
            # Sem o parâmetro prefix, a chave s3:prefix não vem no pedido, e o StringEquals com "" não casa.
            ("só o separador, sem o parâmetro do prefixo", {"delimiter": "/"}),
            ("outra pasta da raiz", {"prefix": "financeiro/", "delimiter": "/"}),
            ("a pasta de outra conta", {"prefix": "AWSLogs/222222222222/", "delimiter": "/"}),
            ("a pasta de outra conta, sem separador", {"prefix": "AWSLogs/222222222222/CloudTrail/"}),
            ("a pasta da organização (as contas dela)", {"prefix": "AWSLogs/o-exemplo123/", "delimiter": "/"}),
            ("a pasta de outra conta na organização", {"prefix": "AWSLogs/o-exemplo123/222222222222/"}),
            ("a pasta desta conta sem a barra", {"prefix": f"AWSLogs/{ACCOUNT}", "delimiter": "/"}),
            ("um ID que só começa igual", {"prefix": f"AWSLogs/{ACCOUNT}0/"}),
            ("um prefixo próprio antes de AWSLogs", {"prefix": f"empresa/AWSLogs/{ACCOUNT}/CloudTrail/"}),
            ("um prefixo próprio, primeiro nível", {"prefix": "empresa/", "delimiter": "/"}),
        ):
            with self.subTest(case=case):
                self.assertFalse(stack.lists(bucket, **arguments))
        # A listagem de versões é outra ação, fora da política.
        self.assertFalse(
            stack.allows("s3:ListBucketVersions", f"arn:aws:s3:::{bucket}", s3_prefix="", s3_delimiter="/")
        )
        # Desligada, nenhuma listagem; e a região e a cifragem do bucket continuam, pela descoberta.
        off = self.node_only(ReadAwsServiceLogs="false")
        self.assertFalse(off.lists(bucket, prefix="", delimiter="/"))
        self.assertFalse(off.lists(bucket, prefix=f"AWSLogs/{ACCOUNT}/CloudTrail/sa-east-1/"))
        for action in ("s3:GetBucketLocation", "s3:GetEncryptionConfiguration"):
            self.assertTrue(off.allows(action, f"arn:aws:s3:::{bucket}"))

    def test_log_groups_are_read_only_with_the_customer_tag(self):
        stack = self.node_only(ReadAwsServiceLogs="false", ReadSecurityFindings="false")
        group = log_group()
        stream = f"{group}:log-stream:2026/11/04/[$LATEST]0123456789abcdef"
        # As duas formas que a AWS usa para o grupo (com e sem o :* do fim) e o stream dele.
        calls = (
            ("logs:DescribeLogStreams", group),
            ("logs:DescribeLogStreams", f"{group}:*"),
            ("logs:FilterLogEvents", group),
            ("logs:FilterLogEvents", f"{group}:*"),
            ("logs:GetLogEvents", stream),
        )
        for action, arn in calls:
            with self.subTest(action=action, arn=arn):
                self.assertTrue(stack.reads_log_group(action, arn, tag="leitura"))
                # Sem a etiqueta, com outro valor ou com outra chave: nada.
                self.assertFalse(stack.reads_log_group(action, arn))
                for value in ("", "Leitura", "leitura ", "sim", "*"):
                    self.assertFalse(stack.reads_log_group(action, arn, tag=value))
                self.assertFalse(stack.allows(action, arn, **{"aws_ResourceTag/verax": "leitura"}))
                # Um grupo de outra conta, mesmo com a etiqueta.
                other = arn.replace(ACCOUNT, "222222222222")
                self.assertFalse(stack.reads_log_group(action, other, tag="leitura"))
        # Em qualquer região da conta.
        self.assertTrue(stack.reads_log_group("logs:FilterLogEvents", log_group(region="us-east-1"), tag="leitura"))
        # Os nomes e as etiquetas de todos os grupos vêm da descoberta, com ou sem etiqueta: só metadados.
        for action in ("logs:DescribeLogGroups", "logs:ListTagsForResource"):
            self.assertTrue(stack.allows(action, group))
        # Outras leituras de conteúdo de log não existem, nem num grupo etiquetado e com uma política de administrador.
        for action in (
            "logs:StartQuery",
            "logs:GetQueryResults",
            "logs:GetLogRecord",
            "logs:StartLiveTail",
            "logs:Unmask",
            "logs:CreateExportTask",
            "logs:PutSubscriptionFilter",
        ):
            with self.subTest(action=action):
                self.assertFalse(stack.reads_log_group(action, group, tag="leitura", extra=[ADMIN]))
        # O papel não se autoriza: etiquetar um grupo é negado, com qualquer política anexada.
        for action in ("logs:TagResource", "logs:TagLogGroup", "logs:UntagResource"):
            with self.subTest(action=action):
                self.assertFalse(stack.allows(action, group, extra=[ADMIN]))
        # Desligada, nem com a etiqueta.
        off = self.node_only(ReadTaggedLogGroups="false")
        for action, arn in calls:
            with self.subTest(off=action, arn=arn):
                self.assertFalse(off.reads_log_group(action, arn, tag="leitura"))
        self.assertTrue(off.allows("logs:DescribeLogGroups"))

    def test_security_findings_are_read_and_never_changed(self):
        stack = self.node_only(ReadAwsServiceLogs="false", ReadTaggedLogGroups="false")
        for action in sorted(CAPABILITIES["ReadSecurityFindings"]["actions"]):
            with self.subTest(action=action):
                self.assertTrue(stack.allows(action))
        for action in (
            "guardduty:ArchiveFindings",
            "guardduty:UnarchiveFindings",
            "guardduty:UpdateFindingsFeedback",
            "guardduty:CreateSampleFindings",
            "guardduty:CreateDetector",
            "securityhub:BatchUpdateFindings",
            "securityhub:BatchImportFindings",
            "securityhub:UpdateFindings",
            "securityhub:EnableSecurityHub",
            "inspector2:CreateFindingsReport",
            "inspector2:Enable",
            "access-analyzer:UpdateFindings",
            "access-analyzer:CreateAnalyzer",
        ):
            with self.subTest(action=action):
                self.assertFalse(stack.allows(action, extra=[ADMIN]))
        # Desligada, nenhum achado; saber se cada serviço está ativo continua, pela descoberta.
        off = self.node_only(ReadSecurityFindings="false")
        for action in sorted(CAPABILITIES["ReadSecurityFindings"]["actions"]):
            with self.subTest(off=action):
                self.assertFalse(off.allows(action))
        for action in (
            "guardduty:ListDetectors",
            "securityhub:DescribeHub",
            "inspector2:BatchGetAccountStatus",
            "access-analyzer:ListAnalyzers",
        ):
            self.assertTrue(off.allows(action))

    def test_updating_a_stack_of_the_first_template_keeps_what_it_read(self):
        # Uma pilha do modelo 1 atualizada com este arquivo: os parâmetros dela não mudam (os novos entram com o
        # padrão), e tudo o que o papel lia continua legível: os buckets informados, a chave e as conferências.
        for stack in (self.stack(), self.stack(LogObjectPrefix=f"AWSLogs/{ACCOUNT}/")):
            for bucket in BUCKETS:
                with self.subTest(bucket=bucket):
                    self.assertTrue(stack.allows("s3:ListBucket", bucket))
                    self.assertTrue(stack.allows("s3:GetBucketLocation", bucket))
                    self.assertTrue(stack.allows("s3:GetObject", f"{bucket}/AWSLogs/{ACCOUNT}/CloudTrail/x.json.gz"))
            self.assertTrue(stack.allows("kms:Decrypt", KMS_KEY, kms_ViaService="s3.sa-east-1.amazonaws.com"))
            for action in sorted(POSTURE_CALLS | VALIDATION_CALLS):
                with self.subTest(action=action):
                    self.assertTrue(stack.allows(action, resource_for(action)))
        # Os parâmetros do modelo 1 continuam todos, com o mesmo tipo e o mesmo padrão.
        first_template = (
            ("NodeServiceAccountId", "String", None),
            ("NodeEgressIps", "String", None),
            ("Audience", "String", AUDIENCE),
            ("LogBucketArns", "CommaDelimitedList", ""),
            ("LogKmsKeyArns", "CommaDelimitedList", ""),
            ("LogObjectPrefix", "CommaDelimitedList", ""),
            ("CreateTrail", "String", "false"),
            ("EnableGuardDutyExport", "String", "false"),
            ("GuardDutyDetectorId", "String", ""),
            ("LogRetentionDays", "Number", 365),
        )
        for name, kind, default in first_template:
            with self.subTest(parameter=name):
                self.assertEqual(self.parameters[name]["Type"], kind)
                self.assertEqual(self.parameters[name].get("Default"), default)
        self.assertEqual(set(self.parameters) - set(CAPABILITIES), {name for name, _, _ in first_template})

    # --- O que o papel nunca faz ---

    def test_nothing_from_outside_the_node_ip(self):
        # Também com as credenciais da sessão vazadas: o Deny de IP vale para a sessão, não só para a entrada.
        self.assertEqual(problems_ip_deny(self.template), [])
        stack = self.stack(CreateTrail="true", EnableGuardDutyExport="true", GuardDutyDetectorId="a" * 32)
        for action in sorted(ALLOWED_ACTIONS):
            with self.subTest(action=action):
                context = {"kms_ViaService": "s3.sa-east-1.amazonaws.com"}
                if action.startswith("logs:"):
                    context[f"aws_ResourceTag/{LOG_GROUP_TAG[0]}"] = LOG_GROUP_TAG[1]
                resource = log_group() if action in CAPABILITIES["ReadTaggedLogGroups"]["actions"] else None
                resource = resource or resource_for(action)
                self.assertTrue(stack.allows(action, resource, **context))
                self.assertFalse(stack.allows(action, resource, source_ip=OTHER_IP, **context))
        # As leituras do S3 que a autorização dos logs da AWS dá, também só do IP do nó.
        own = f"AWSLogs/{ACCOUNT}/CloudTrail/sa-east-1/"
        self.assertTrue(stack.allows("s3:GetObject", f"arn:aws:s3:::qualquer/{own}x.json.gz"))
        self.assertFalse(stack.allows("s3:GetObject", f"arn:aws:s3:::qualquer/{own}x.json.gz", source_ip=OTHER_IP))
        self.assertTrue(stack.lists("qualquer", prefix=own))
        self.assertFalse(stack.lists("qualquer", prefix=own, source_ip=OTHER_IP))
        # Uma faixa vizinha também fica de fora: o /32 é exato.
        self.assertFalse(stack.allows("iam:ListUsers", source_ip="203.0.113.11"))

    def test_only_a_service_acting_for_the_role_escapes_the_ip_deny(self):
        # A sessão de acesso encaminhada: o S3, de um IP da AWS, pede ao KMS para decifrar o objeto que o papel leu. A
        # AWS marca esse pedido com aws:ViaAWSService verdadeiro, e a negação de IP não o alcança; o que o libera é a
        # política de leitura, só pelo S3.
        stack = self.stack()
        aws_ip = "198.51.100.200"
        fas = {"source_ip": aws_ip, "aws_ViaAWSService": "true"}
        self.assertTrue(stack.allows("kms:Decrypt", KMS_KEY, kms_ViaService="s3.sa-east-1.amazonaws.com", **fas))
        # A mesma chamada feita direto com a sessão, de fora do IP do nó: negada.
        self.assertFalse(
            stack.allows("kms:Decrypt", KMS_KEY, kms_ViaService="s3.sa-east-1.amazonaws.com", source_ip=aws_ip)
        )
        # A exceção não libera nada por si: outro serviço em nome do papel só passa no que a leitura já permite.
        self.assertFalse(stack.allows("kms:Decrypt", KMS_KEY, kms_ViaService="rds.sa-east-1.amazonaws.com", **fas))
        self.assertFalse(stack.allows("kms:Decrypt", KMS_KEY, **fas))
        for action in sorted(OUTSIDE_BOUNDARY | MUST_DENY):
            with self.subTest(action=action):
                self.assertFalse(stack.allows(action, ROLE_ARN, extra=[ADMIN], **fas))
        # A chamada inicial continua presa ao IP do nó: de outro IP, ninguém chega a acionar o S3.
        self.assertFalse(
            stack.allows("s3:GetObject", f"{BUCKETS[0]}/AWSLogs/{ACCOUNT}/x.json.gz", source_ip=OTHER_IP)
        )
        # Sem a chave no pedido (a AWS sempre a põe), a negação de IP não se aplicaria: o teste fixa o operador Bool,
        # e a conferência do texto (problems_ip_deny) fixa a condição inteira.
        statement = self.statement("SoDoNoDaVerax")
        self.assertEqual(set(statement["Condition"]), {"NotIpAddress", "Bool"})
        self.assertEqual(statement["Condition"]["Bool"], {"aws:ViaAWSService": "false"})

    def test_log_destruction_and_escalation_are_denied_even_from_the_node(self):
        denied = {a for s in all_statements(self.template) if is_unconditional_deny(s) for a in as_list(s["Action"])}
        missing = {action for action in MUST_DENY if not matches(action, denied)}
        self.assertFalse(missing, f"ações sem negação explícita: {sorted(missing)}")
        # Com uma política de administrador anexada ao papel, a negação continua valendo.
        stack = self.stack()
        for action in sorted(MUST_DENY):
            with self.subTest(action=action):
                self.assertFalse(stack.allows(action, ROLE_ARN, extra=[ADMIN]))

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

    def test_revoke_active_sessions_cuts_only_older_sessions(self):
        # "Revoke active sessions", no console do IAM, grava no papel a política AWSRevokeOlderSessions: nega tudo à
        # sessão emitida antes do clique. A sessão seguinte (o nó entra de novo, se o papel continuar) passa.
        revoke = {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Effect": "Deny",
                    "Action": ["*"],
                    "Resource": ["*"],
                    "Condition": {"DateLessThan": {"aws:TokenIssueTime": "2026-11-04T18:00:00Z"}},
                }
            ],
        }
        stack = self.stack()
        self.assertFalse(stack.allows("iam:ListUsers", extra=[revoke], aws_TokenIssueTime="2026-11-04T17:59:59Z"))
        self.assertTrue(stack.allows("iam:ListUsers", extra=[revoke], aws_TokenIssueTime="2026-11-04T18:00:01Z"))
        self.assertTrue(stack.node_assumes())

    # --- Opcionais ---

    def test_object_prefixes_limit_only_the_informed_buckets(self):
        # Sem a autorização dos logs da AWS (o modelo 1): trilha da organização (bucket compartilhado) e export do
        # GuardDuty da própria conta, cada um com o seu layout.
        organization, own = f"AWSLogs/o-exemplo123/{ACCOUNT}/", f"AWSLogs/{ACCOUNT}/"
        stack = self.legacy(LogObjectPrefix=f"{organization},{own}", CreateTrail="true")
        trail, guardduty = BUCKETS[0], BUCKETS[1]
        self.assertTrue(stack.allows("s3:GetObject", f"{trail}/{organization}CloudTrail/sa-east-1/x.json.gz"))
        self.assertTrue(stack.allows("s3:GetObject", f"{guardduty}/{own}GuardDuty/sa-east-1/x.jsonl.gz"))
        for key in ("AWSLogs/o-exemplo123/222222222222/CloudTrail/x.json.gz", "AWSLogs/222222222222/x", "x.json.gz"):
            with self.subTest(key=key):
                self.assertFalse(stack.allows("s3:GetObject", f"{trail}/{key}"))
        # Só o GetObject: o módulo do Wazuh lista o bucket a partir da raiz, e a listagem não leva o prefixo.
        self.assertTrue(stack.allows("s3:ListBucket", trail))
        # A trilha criada pela pilha é só desta conta e fica fora dos prefixos.
        created = stack.attribute("TrailBucket", "Arn")
        self.assertTrue(stack.allows("s3:GetObject", f"{created}/AWSLogs/{ACCOUNT}/CloudTrail/x.json.gz"))
        # Um prefixo só também funciona, e sem prefixo a negação nem existe.
        single = self.legacy(LogObjectPrefix=organization)
        self.assertTrue(single.allows("s3:GetObject", f"{trail}/{organization}x.json.gz"))
        self.assertFalse(single.allows("s3:GetObject", f"{guardduty}/{own}x.json.gz"))
        sids = {s["Sid"] for s in self.stack().policy_document("GuardrailsPolicy")["Statement"]}
        self.assertNotIn("SoOsPrefixosInformados", sids)

    def test_object_prefixes_never_take_away_the_logs_of_this_account(self):
        # Com a autorização dos logs da AWS, os prefixos estreitam só os buckets adicionais: o que está em
        # AWSLogs/<esta conta>/, em qualquer bucket, continua legível. Um bucket central com um prefixo próprio antes
        # de AWSLogs (o caso do LogBucketArns) e, ao lado, a trilha da conta num bucket que ninguém informou.
        central = "arn:aws:s3:::logs-centrais"
        custom = f"empresa/AWSLogs/{ACCOUNT}/"
        stack = self.node_only(LogBucketArns=central, LogObjectPrefix=custom)
        sids = {s["Sid"] for s in stack.policy_document("GuardrailsPolicy")["Statement"]}
        self.assertIn("SoOsPrefixosInformados", sids)
        self.assertTrue(stack.allows("s3:GetObject", f"{central}/{custom}CloudTrail/sa-east-1/x.json.gz"))
        for key in (
            f"AWSLogs/{ACCOUNT}/CloudTrail/sa-east-1/2026/11/04/x.json.gz",
            f"AWSLogs/{ACCOUNT}/vpcflowlogs/sa-east-1/2026/11/04/x.log.gz",
            f"AWSLogs/o-exemplo123/{ACCOUNT}/CloudTrail/sa-east-1/2026/11/04/x.json.gz",
        ):
            with self.subTest(key=key):
                self.assertTrue(stack.allows("s3:GetObject", f"arn:aws:s3:::trilha-que-ninguem-informou/{key}"))
                self.assertTrue(stack.allows("s3:GetObject", f"{central}/{key}"))
        # O que os prefixos tiram do bucket adicional continua tirado: os logs de outra conta e o resto do bucket.
        for key in (
            "empresa/AWSLogs/222222222222/CloudTrail/sa-east-1/x.json.gz",
            "AWSLogs/222222222222/CloudTrail/sa-east-1/x.json.gz",
            "AWSLogs/o-exemplo123/222222222222/CloudTrail/sa-east-1/x.json.gz",
            "financeiro/folha.csv",
        ):
            with self.subTest(key=key):
                self.assertFalse(stack.allows("s3:GetObject", f"{central}/{key}"))
        # Sem a autorização, a exceção some junto: a negação volta a ser só a dos prefixos.
        off = self.node_only(LogBucketArns=central, LogObjectPrefix=custom, ReadAwsServiceLogs="false")
        self.assertTrue(off.allows("s3:GetObject", f"{central}/{custom}CloudTrail/sa-east-1/x.json.gz"))
        self.assertFalse(off.allows("s3:GetObject", f"{central}/AWSLogs/{ACCOUNT}/CloudTrail/sa-east-1/x.json.gz"))
        deny = next(
            s for s in off.policy_document("GuardrailsPolicy")["Statement"] if s["Sid"] == "SoOsPrefixosInformados"
        )
        self.assertEqual(deny["NotResource"], [f"arn:*:s3:::*/{custom}*"])
        deny = next(
            s for s in stack.policy_document("GuardrailsPolicy")["Statement"] if s["Sid"] == "SoOsPrefixosInformados"
        )
        self.assertEqual(
            deny["NotResource"],
            [
                f"arn:*:s3:::*/{custom}*",
                f"arn:aws:s3:::*/AWSLogs/{ACCOUNT}/*",
                f"arn:aws:s3:::*/AWSLogs/o-*/{ACCOUNT}/*",
            ],
        )

    def test_created_trail_and_export_are_readable_from_the_node(self):
        # Sem a autorização dos logs da AWS, para conferir o que as declarações dos recursos criados dão sozinhas.
        stack = Stack(
            self.template,
            **NODE,
            **ALL_OFF,
            CreateTrail="true",
            EnableGuardDutyExport="true",
            GuardDutyDetectorId="a" * 32,
        )
        key = f"arn:aws:kms:sa-east-1:{ACCOUNT}:key/11111111-2222-3333-4444-555555555555"
        for name in ("TrailBucket", "GuardDutyBucket"):
            bucket = stack.attribute(name, "Arn")
            with self.subTest(bucket=name):
                self.assertTrue(stack.allows("s3:ListBucket", bucket))
                self.assertTrue(stack.allows("s3:GetBucketLocation", bucket))
                self.assertTrue(stack.allows("s3:GetObject", f"{bucket}/AWSLogs/{ACCOUNT}/x.json.gz"))
        self.assertTrue(stack.allows("kms:Decrypt", key, kms_ViaService="s3.sa-east-1.amazonaws.com"))
        self.assertFalse(stack.allows("kms:Decrypt", key, kms_ViaService="s3.us-east-1.amazonaws.com"))
        access_logs = stack.attribute("AccessLogsBucket", "Arn")
        self.assertFalse(stack.allows("s3:GetObject", f"{access_logs}/cloudtrail/x"))
        self.assertFalse(stack.allows("s3:ListBucket", access_logs))
        only_trail = Stack(self.template, **NODE, **ALL_OFF, CreateTrail="true")
        self.assertNotIn("GuardDutyBucket", only_trail.resources)
        self.assertTrue(only_trail.allows("s3:ListBucket", only_trail.attribute("TrailBucket", "Arn")))
        # Com a autorização, o bucket de log de acesso continua fora: nada nele fica em AWSLogs/<conta>/.
        on = Stack(self.template, **NODE, CreateTrail="true")
        self.assertFalse(on.allows("s3:GetObject", f"{on.attribute('AccessLogsBucket', 'Arn')}/cloudtrail/x"))
        self.assertTrue(
            on.allows("s3:GetObject", f"{on.attribute('TrailBucket', 'Arn')}/AWSLogs/{ACCOUNT}/CloudTrail/x.json.gz")
        )

    def test_created_buckets_have_generated_names_and_only_they_write_access_logs(self):
        # Os buckets ficam na conta (Retain) quando a opção é desligada ou a pilha apagada: com um nome fixo, religar
        # a opção ou recriar a pilha falharia porque o bucket já existe. O nome é gerado pelo CloudFormation, e a
        # política do bucket de log de acesso aponta o ARN exato de cada bucket criado (como no exemplo da AWS).
        for name, resource in self.resources.items():
            if resource["Type"] == "AWS::S3::Bucket":
                with self.subTest(bucket=name):
                    self.assertNotIn("BucketName", resource["Properties"])
        export = {"EnableGuardDutyExport": "true", "GuardDutyDetectorId": "a" * 32}
        for options, created in (
            ({"CreateTrail": "true"}, ["TrailBucket"]),
            (export, ["GuardDutyBucket"]),
            ({"CreateTrail": "true", **export}, ["TrailBucket", "GuardDutyBucket"]),
        ):
            with self.subTest(created=created):
                stack = self.stack(**options)
                statement = next(
                    s
                    for s in stack.policy_document("AccessLogsBucketPolicy")["Statement"]
                    if s["Sid"] == "LogDeAcessoDosBucketsDaPilha"
                )
                self.assertEqual(statement["Principal"], {"Service": "logging.s3.amazonaws.com"})
                self.assertEqual(statement["Action"], "s3:PutObject")
                self.assertEqual(
                    statement["Condition"],
                    {
                        "StringEquals": {"aws:SourceAccount": ACCOUNT},
                        "ArnEquals": {"aws:SourceArn": [stack.attribute(name, "Arn") for name in created]},
                    },
                )
                self.assertEqual(
                    stack.resolve(self.template["Outputs"]["AccessLogsBucketArn"]["Value"]),
                    stack.attribute("AccessLogsBucket", "Arn"),
                )

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
        # Limite do IAM: 6.144 caracteres sem espaços. Com 10 buckets adicionais, 10 chaves, 4 IPs e todos os opcionais
        # ligados, em cada combinação das autorizações (sem a dos logs da AWS, a lista de chaves entra na política).
        sizes = {}
        for capabilities in combinations():
            stack = self.stack(
                **capabilities,
                LogBucketArns=",".join(
                    f"arn:aws:s3:::bucket-de-log-com-nome-longo-{i:02d}-{ACCOUNT}" for i in range(10)
                ),
                LogKmsKeyArns=",".join(KMS_KEY.replace("00000000-0000", f"000000{i:02d}-0000") for i in range(10)),
                LogObjectPrefix=f"AWSLogs/o-exemplo123/{ACCOUNT}/",
                CreateTrail="true",
                EnableGuardDutyExport="true",
                GuardDutyDetectorId="a" * 32,
                NodeEgressIps=",".join(f"203.0.113.{i}/32" for i in range(1, 5)),
            )
            for name in ("ReaderPolicy", "GuardrailsPolicy"):
                with self.subTest(policy=name, **capabilities):
                    size = len(json.dumps(stack.policy_document(name), separators=(",", ":")))
                    sizes[name] = max(size, sizes.get(name, 0))
                    self.assertLess(size, 6144)
            # A confiança tem um limite próprio (2.048 caracteres por padrão).
            trust = stack.properties("ReaderRole")["AssumeRolePolicyDocument"]
            self.assertLess(len(json.dumps(trust, separators=(",", ":"))), 2048)
        # Folga para um nome de bucket mais longo ou uma ação a mais: a maior política fica a mais de 500 caracteres
        # do limite. Se este número cair, é hora de enxugar (ou dividir a política), não de subir o limite do teste.
        self.assertLess(max(sizes.values()), 6144 - 500)
        # Com os padrões (só o nó e as três autorizações), a política de leitura tem menos da metade do limite.
        default = self.node_only()
        self.assertLess(len(json.dumps(default.policy_document("ReaderPolicy"), separators=(",", ":"))), 3072)

    def test_role_tags_fit_what_iam_accepts(self):
        # O valor de uma etiqueta do IAM não aceita vírgula (API_Tag): a lista vai separada por espaço. Até 256
        # caracteres, nenhuma chave começando com aws: e a descoberta sempre presente.
        for capabilities in combinations():
            with self.subTest(**capabilities):
                role = self.node_only(**capabilities).properties("ReaderRole")
                tags = {tag["Key"]: tag["Value"] for tag in role["Tags"]}
                self.assertEqual(set(tags), {"verax-control:template", "verax-control:capabilities"})
                self.assertEqual(tags["verax-control:template"], TEMPLATE_VERSION)
                granted = ["discovery"] + [
                    capability["tag"]
                    for parameter, capability in CAPABILITIES.items()
                    if capabilities[parameter] == "true"
                ]
                self.assertEqual(tags["verax-control:capabilities"], " ".join(granted))
                for key, value in tags.items():
                    self.assertTrue(IAM_TAG_VALUE.fullmatch(value), value)
                    self.assertTrue(IAM_TAG_VALUE.fullmatch(key), key)
                    self.assertNotIn(",", value)
                    self.assertFalse(key.startswith("aws:"))

    # --- O equivalente sem CloudFormation ---

    def test_policy_json_is_the_template_with_the_example_values(self):
        stack = self.stack()
        self.assertEqual(
            json.loads(POLICY_JSON.read_text(encoding="utf-8")),
            {
                "AssumeRolePolicyDocument": stack.properties("ReaderRole")["AssumeRolePolicyDocument"],
                "VeraxControlReader": stack.policy_document("ReaderPolicy"),
                "VeraxControlGuardrails": stack.policy_document("GuardrailsPolicy"),
            },
        )

    def test_readme_shows_the_same_trust(self):
        trust = json.loads(POLICY_JSON.read_text(encoding="utf-8"))["AssumeRolePolicyDocument"]
        self.assertEqual(json.loads(readme_block("json", "## Quem entra no papel")), trust)

    def test_readme_cli_creates_the_same_role_without_user_or_key(self):
        commands = [
            line.strip()
            for line in README.read_text(encoding="utf-8").splitlines()
            if line.strip().startswith("aws iam ")
        ]
        text = "\n".join(commands)
        for forbidden in (
            "create-user",
            "create-access-key",
            "create-login-profile",
            "create-group",
            "add-user-to-group",
            "attach-user-policy",
            "put-user-policy",
            "put-role-policy",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, text)
        role = [c for c in commands if c.startswith("aws iam create-role")]
        self.assertEqual(len(role), 1)
        for part in (
            "--path /verax/",
            "--role-name verax-control-reader",
            "--max-session-duration 3600",
            '--permissions-boundary "arn:aws:iam::$conta:policy/verax/VeraxControlReader"',
            '--assume-role-policy-document "$(jq -c .AssumeRolePolicyDocument verax-control-reader.policy.json)"',
        ):
            with self.subTest(part=part):
                self.assertIn(part, role[0])
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
                        c.startswith("aws iam attach-role-policy --role-name verax-control-reader")
                        and c.endswith(f'policy/verax/{name}"')
                        for c in commands
                    )
                )

    def test_readme_terraform_example_creates_the_same_role(self):
        hcl = readme_block("hcl", "### Com Terraform")
        for forbidden in ("aws_iam_user", "aws_iam_access_key", "aws_iam_group", "StringLike", "*"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, hcl)
        for pattern in (
            r'name\s*=\s*"verax-control-reader"',
            r'path\s*=\s*"/verax/"',
            r"max_session_duration\s*=\s*3600",
            r"permissions_boundary\s*=\s*aws_iam_policy\.verax_control_reader\.arn",
            r'Principal\s*=\s*\{\s*Federated\s*=\s*"accounts\.google\.com"\s*\}',
            r'Action\s*=\s*"sts:AssumeRoleWithWebIdentity"',
            rf'"accounts\.google\.com:aud"\s*=\s*"{NODE_SA}"',
            rf'"accounts\.google\.com:sub"\s*=\s*"{NODE_SA}"',
            rf'"accounts\.google\.com:oaud"\s*=\s*"{re.escape(AUDIENCE)}"',
            rf'IpAddress\s*=\s*\{{\s*"aws:SourceIp"\s*=\s*\["{re.escape(NODE_IP)}/32"\]\s*\}}',
            r'jsondecode\(file\("\$\{path\.module\}/verax-control-reader\.policy\.json"\)\)',
        ):
            with self.subTest(pattern=pattern):
                self.assertRegex(hcl, pattern)
        for name in ("VeraxControlReader", "VeraxControlGuardrails"):
            with self.subTest(policy=name):
                self.assertRegex(hcl, rf'name\s*=\s*"{name}"')
                self.assertIn(f"jsonencode(local.verax.{name})", hcl)
        self.assertEqual(hcl.count("aws_iam_role_policy_attachment"), 1)

    def test_readme_names_the_sts_call_the_ip_deny_cannot_stop(self):
        # O GetCallerIdentity não passa por política ("You cannot use policies to control authentication
        # operations"): o README não pode prometer que nada responde de fora do IP do nó.
        text = README.read_text(encoding="utf-8")
        section = text.split("### O que o papel nunca faz", 1)[1].split("\n## ", 1)[0]
        self.assertIn("`sts:GetCallerIdentity`", section)

    def test_readme_never_asks_for_a_key(self):
        text = README.read_text(encoding="utf-8")
        reader_part = text.split("## Conector com papel e ExternalId (obsoleto)", 1)[0]
        for forbidden in ("Create access key", "Access key ID", "Secret access key", "SecurityCredentialsUrl", "AKIA"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, reader_part)

    def test_readme_explains_what_each_authorization_gives(self):
        text = README.read_text(encoding="utf-8")
        section = text.split("## O que cada permissão libera", 1)[1].split("\n## ", 1)[0]
        for parameter in CAPABILITIES:
            with self.subTest(parameter=parameter):
                self.assertIn(f"`{parameter}`", section)
        # A nota honesta do primeiro nível dos buckets, a etiqueta dos grupos de log e como revogar.
        self.assertIn("primeiro nível", section)
        self.assertIn("AWSLogs/<conta>/", section)
        tag = f"{LOG_GROUP_TAG[0]}={LOG_GROUP_TAG[1]}"
        self.assertIn(f"aws logs tag-resource --resource-arn <arn do log group> --tags {tag}", section)
        untag = f"aws logs untag-resource --resource-arn <arn do log group> --tag-keys {LOG_GROUP_TAG[0]}"
        self.assertIn(untag, section)
        self.assertIn("### Como revogar", section)
        # Toda ação liberada aparece no README, pelo nome: o cliente lê a lista inteira antes de criar a pilha.
        reader_part = text.split("## Conector com papel e ExternalId (obsoleto)", 1)[0]
        missing = {action for action in ALLOWED_ACTIONS if f"`{action}`" not in reader_part}
        self.assertFalse(missing, f"ações liberadas que o README não cita: {sorted(missing)}")

    def test_readme_deploy_example_is_accepted_by_the_template(self):
        # O comando de exemplo do README, com os valores fictícios: todo parâmetro existe e todo valor passa.
        block = readme_block("sh", "**Pela CLI**")
        overrides = dict(re.findall(r"^\s+([A-Za-z]+)=(\S+?)(?: \\)?$", block, re.MULTILINE))
        self.assertTrue({"NodeServiceAccountId", "NodeEgressIps", *CAPABILITIES} <= set(overrides))
        stack = Stack(self.template, **overrides)
        self.assertTrue(stack.node_assumes())


class MutationTest(unittest.TestCase):
    """Cada mutação derruba ao menos uma conferência, e o avaliador mostra o efeito dela."""

    @classmethod
    def setUpClass(cls):
        cls.template = cfn_yaml.load(str(TEMPLATE))

    def mutated(self):
        return copy.deepcopy(self.template)

    def trust(self, template):
        return trust_statements(template)[0]

    def test_without_the_ip_deny(self):
        template = self.mutated()
        document = template["Resources"]["GuardrailsPolicy"]["Properties"]["PolicyDocument"]
        document["Statement"] = [s for s in document["Statement"] if s.get("Sid") != "SoDoNoDaVerax"]
        self.assertTrue(problems_ip_deny(template))
        # Credenciais da sessão vazadas serviriam de outro IP.
        stack = Stack(template, **EXAMPLE)
        self.assertTrue(stack.allows("s3:GetObject", f"{BUCKETS[0]}/x.json.gz", source_ip=OTHER_IP))

    def test_with_a_user_and_an_access_key(self):
        template = self.mutated()
        template["Resources"]["Usuario"] = {
            "Type": "AWS::IAM::User",
            "Properties": {"UserName": "verax-control-reader"},
        }
        template["Resources"]["Chave"] = {
            "Type": "AWS::IAM::AccessKey",
            "Properties": {"UserName": {"Ref": "Usuario"}},
        }
        template["Outputs"]["Segredo"] = {"Value": {"Fn::GetAtt": ["Chave", "SecretAccessKey"]}}
        self.assertEqual(len(problems_no_user_or_key(template)), 3)
        # A política de leitura pendurada num usuário que já existe, sem criá-lo.
        template = self.mutated()
        template["Resources"]["ReaderPolicy"]["Properties"]["Users"] = ["admin"]
        self.assertTrue(problems_no_user_or_key(template))
        # Um parâmetro secreto e uma saída que o devolve.
        template = self.mutated()
        template["Parameters"]["Senha"] = {"Type": "String", "NoEcho": True}
        template["Outputs"]["Senha"] = {"Value": {"Ref": "Senha"}}
        self.assertEqual(len(problems_no_user_or_key(template)), 2)

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
        del template["Resources"]["ReaderRole"]["Properties"]["PermissionsBoundary"]
        self.assertTrue(problems_role(template))
        stack = Stack(template, **EXAMPLE)
        self.assertTrue(stack.allows("secretsmanager:GetSecretValue", "*", extra=[ADMIN]))

    def test_role_with_a_longer_session_another_arn_or_an_inline_policy(self):
        for key, value in (
            ("MaxSessionDuration", 43200),
            ("Path", "/"),
            ("RoleName", "verax-reader"),
            ("Policies", [{"PolicyName": "Extra", "PolicyDocument": ADMIN}]),
            ("ManagedPolicyArns", [{"Ref": "ReaderPolicy"}]),
        ):
            with self.subTest(key=key):
                template = self.mutated()
                template["Resources"]["ReaderRole"]["Properties"][key] = value
                self.assertTrue(problems_role(template))

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

    def test_trust_without_each_condition(self):
        attacks = {
            # Sem o sub: um token com o azp do nó e outro sub entraria (a AWS não exige o sub do Google).
            f"{GOOGLE}:sub": {**google_token(), "sub": OTHER_SA},
            # Sem o aud: um token com o sub do nó e o azp de outra conta entraria.
            f"{GOOGLE}:aud": {**google_token(), "azp": OTHER_SA},
            # Sem o oaud: um token que o nó emitiu para outro destino serviria aqui.
            f"{GOOGLE}:oaud": google_token(audience="https://outro-servico.example"),
        }
        for key, token in attacks.items():
            with self.subTest(key=key):
                self.assertFalse(Stack(self.template, **EXAMPLE).node_assumes(token))
                template = self.mutated()
                del self.trust(template)["Condition"]["StringEquals"][key]
                self.assertTrue(problems_trust(template))
                self.assertTrue(Stack(template, **EXAMPLE).node_assumes(token))
        # Sem o IP: o token do nó, vazado, entraria de qualquer lugar por até 1 hora.
        template = self.mutated()
        del self.trust(template)["Condition"]["IpAddress"]
        self.assertTrue(problems_trust(template))
        self.assertTrue(Stack(template, **EXAMPLE).node_assumes(google_token(), OTHER_IP))

    def test_trust_with_a_wildcard(self):
        # StringLike com curinga no sub e no aud: qualquer conta de serviço do Google entraria do IP do nó.
        template = self.mutated()
        condition = self.trust(template)["Condition"]
        condition["StringLike"] = {f"{GOOGLE}:sub": "*", f"{GOOGLE}:aud": "*"}
        for key in (f"{GOOGLE}:sub", f"{GOOGLE}:aud"):
            del condition["StringEquals"][key]
        self.assertTrue(problems_trust(template))
        self.assertTrue(Stack(template, **EXAMPLE).node_assumes(google_token(sub=OTHER_SA)))
        # Um valor fixo no lugar do parâmetro validado (o curinga, aqui, nem casaria no StringEquals).
        for key in (f"{GOOGLE}:sub", f"{GOOGLE}:oaud"):
            with self.subTest(key=key):
                template = self.mutated()
                self.trust(template)["Condition"]["StringEquals"][key] = "*"
                self.assertTrue(problems_trust(template))
        # O IP inteiro da internet.
        template = self.mutated()
        self.trust(template)["Condition"]["IpAddress"]["aws:SourceIp"] = "0.0.0.0/0"
        self.assertTrue(problems_trust(template))
        self.assertTrue(Stack(template, **EXAMPLE).node_assumes(google_token(), OTHER_IP))

    def test_trust_with_another_principal_or_action(self):
        # Uma segunda declaração para outra conta AWS, com o AssumeRole comum.
        template = self.mutated()
        other = "arn:aws:iam::222222222222:root"
        trust_statements(template).append(
            {"Sid": "OutraConta", "Effect": "Allow", "Principal": {"AWS": other}, "Action": "sts:AssumeRole"}
        )
        self.assertTrue(problems_trust(template))
        self.assertTrue(
            Stack(template, **EXAMPLE).assumes("AWS", other, "sts:AssumeRole", {"aws:SourceIp": OTHER_IP})
        )
        # Outro provedor ao lado do Google, qualquer principal, e outra ação ao lado da troca do token.
        for key, value in (
            ("Principal", {"Federated": [GOOGLE, "cognito-identity.amazonaws.com"]}),
            ("Principal", {"Federated": GOOGLE, "AWS": other}),
            ("Principal", "*"),
            ("Action", [WEB_IDENTITY, "sts:AssumeRole"]),
            ("Action", "sts:*"),
        ):
            with self.subTest(key=key, value=value):
                template = self.mutated()
                self.trust(template)[key] = value
                self.assertTrue(problems_trust(template))

    def test_console_wizard_audience_pitfall(self):
        # O assistente "Web identity / Google" do console grava o audience pedido ao Google em accounts.google.com:aud.
        # No token de uma conta de serviço, a AWS lê essa chave do azp (o ID da conta): o papel nunca aceitaria o nó.
        template = self.mutated()
        self.trust(template)["Condition"]["StringEquals"][f"{GOOGLE}:aud"] = {"Ref": "Audience"}
        self.assertTrue(problems_trust(template))
        self.assertFalse(Stack(template, **EXAMPLE).node_assumes())

    def test_parameters_loosened(self):
        for parameter, key, value in (
            ("NodeServiceAccountId", "AllowedPattern", "^.*$"),
            ("NodeServiceAccountId", "Default", NODE_SA),
            ("Audience", "Default", "https://outro.example/aws"),
            ("Audience", "AllowedPattern", "^.*$"),
        ):
            with self.subTest(parameter=parameter, key=key):
                template = self.mutated()
                template["Parameters"][parameter][key] = value
                self.assertTrue(problems_trust(template))
        template = self.mutated()
        template["Parameters"]["NodeEgressIps"]["AllowedPattern"] = "^.*$"
        self.assertTrue(problems_ip_deny(template))

    # --- Modelo 2: a negação de IP, as autorizações e as etiquetas ---

    def reader_item(self, template, sid):
        """A lista de declarações da política de leitura, a posição da declaração com o Sid dado e ela mesma (o ramo
        verdadeiro do Fn::If, quando depende de uma condição)."""
        items = template["Resources"]["ReaderPolicy"]["Properties"]["PolicyDocument"]["Statement"]
        for index, item in enumerate(items):
            statement = item["Fn::If"][1] if isinstance(item, dict) and "Fn::If" in item else item
            if statement.get("Sid") == sid:
                return items, index, statement
        raise AssertionError(f"declaração ausente: {sid}")

    def ip_deny(self, template):
        document = template["Resources"]["GuardrailsPolicy"]["Properties"]["PolicyDocument"]
        return next(s for s in document["Statement"] if isinstance(s, dict) and s.get("Sid") == "SoDoNoDaVerax")

    def test_ip_deny_with_the_service_exception_changed(self):
        service_call = {
            "source_ip": "198.51.100.200",
            "aws_ViaAWSService": "true",
            "kms_ViaService": "s3.sa-east-1.amazonaws.com",
        }
        self.assertTrue(Stack(self.template, **EXAMPLE).allows("kms:Decrypt", KMS_KEY, **service_call))
        # Sem a exceção: a negação pegaria também o S3 pedindo ao KMS, em nome do papel, o objeto que o nó leu.
        template = self.mutated()
        del self.ip_deny(template)["Condition"]["Bool"]
        self.assertTrue(problems_ip_deny(template))
        self.assertFalse(Stack(template, **EXAMPLE).allows("kms:Decrypt", KMS_KEY, **service_call))
        # Invertida: a negação só valeria para o serviço, e a sessão vazada serviria de qualquer IP.
        template = self.mutated()
        self.ip_deny(template)["Condition"]["Bool"] = {"aws:ViaAWSService": "true"}
        self.assertTrue(problems_ip_deny(template))
        self.assertTrue(Stack(template, **EXAMPLE).allows("iam:ListUsers", source_ip=OTHER_IP))
        # Outra chave ao lado, que estreitaria a negação (só valeria sem TLS, por exemplo).
        template = self.mutated()
        self.ip_deny(template)["Condition"]["Bool"]["aws:SecureTransport"] = "false"
        self.assertTrue(problems_ip_deny(template))
        self.assertTrue(
            Stack(template, **EXAMPLE).allows("iam:ListUsers", source_ip=OTHER_IP, aws_SecureTransport="true")
        )

    def test_service_logs_statements_loosened(self):
        bucket = "um-bucket-qualquer"
        own = f"arn:aws:s3:::{bucket}/AWSLogs/{ACCOUNT}/CloudTrail/x.json.gz"
        self.assertTrue(Stack(self.template, **NODE).allows("s3:GetObject", own))
        # Todos os objetos de todos os buckets.
        template = self.mutated()
        *_, statement = self.reader_item(template, "LerLogsDaAwsDestaConta")
        statement["Resource"] = "arn:aws:s3:::*/*"
        self.assertTrue(problems_read_only(template))
        self.assertTrue(Stack(template, **NODE).allows("s3:GetObject", f"arn:aws:s3:::{bucket}/financeiro/folha.csv"))
        # A pasta AWSLogs de qualquer conta (sem o ID desta).
        template = self.mutated()
        *_, statement = self.reader_item(template, "LerLogsDaAwsDestaConta")
        statement["Resource"] = [{"Fn::Sub": "arn:${AWS::Partition}:s3:::*/AWSLogs/*"}]
        self.assertTrue(problems_read_only(template))
        self.assertTrue(
            Stack(template, **NODE).allows("s3:GetObject", f"arn:aws:s3:::{bucket}/AWSLogs/222222222222/x.json.gz")
        )
        # A listagem sem a condição do prefixo: o bucket inteiro.
        template = self.mutated()
        *_, statement = self.reader_item(template, "ListarLogsDaAwsDestaConta")
        del statement["Condition"]
        self.assertTrue(problems_read_only(template))
        self.assertTrue(Stack(template, **NODE).lists(bucket))
        # O primeiro nível sem o separador: a mesma listagem desceria o bucket inteiro.
        template = self.mutated()
        *_, statement = self.reader_item(template, "VerPrimeiroNivelDosBuckets")
        del statement["Condition"]["StringEquals"]["s3:delimiter"]
        self.assertTrue(problems_read_only(template))
        self.assertTrue(Stack(template, **NODE).lists(bucket, prefix=""))
        # O primeiro nível com um prefixo a mais: a pasta de outra conta.
        template = self.mutated()
        *_, statement = self.reader_item(template, "VerPrimeiroNivelDosBuckets")
        statement["Condition"]["StringEquals"]["s3:prefix"].append("AWSLogs/222222222222/")
        self.assertTrue(problems_read_only(template))
        # O Decrypt sem o S3 no meio: qualquer chave, direto no KMS.
        template = self.mutated()
        *_, statement = self.reader_item(template, "DecifrarLogsDaAwsSoPeloS3")
        del statement["Condition"]
        self.assertTrue(problems_read_only(template))
        self.assertTrue(Stack(template, **NODE).allows("kms:Decrypt", KMS_KEY))

    def test_log_group_statement_loosened(self):
        group = log_group()
        self.assertFalse(Stack(self.template, **NODE).reads_log_group("logs:FilterLogEvents", group))
        # Sem a condição da etiqueta: todo grupo de log da conta.
        template = self.mutated()
        *_, statement = self.reader_item(template, "LerGruposDeLogEtiquetados")
        del statement["Condition"]
        self.assertTrue(problems_read_only(template))
        self.assertTrue(Stack(template, **NODE).reads_log_group("logs:FilterLogEvents", group))
        # Qualquer valor na etiqueta.
        template = self.mutated()
        *_, statement = self.reader_item(template, "LerGruposDeLogEtiquetados")
        statement["Condition"] = {"StringLike": {"aws:ResourceTag/verax-control": "*"}}
        self.assertTrue(problems_read_only(template))
        self.assertTrue(Stack(template, **NODE).reads_log_group("logs:FilterLogEvents", group, tag="nao"))
        # Grupos de qualquer conta, ou uma leitura a mais (a consulta do Logs Insights).
        template = self.mutated()
        *_, statement = self.reader_item(template, "LerGruposDeLogEtiquetados")
        statement["Resource"] = "*"
        self.assertTrue(problems_read_only(template))
        template = self.mutated()
        *_, statement = self.reader_item(template, "LerGruposDeLogEtiquetados")
        statement["Action"].append("logs:StartQuery")
        self.assertTrue(problems_read_only(template))

    def test_findings_statement_with_a_write(self):
        for action in ("guardduty:ArchiveFindings", "securityhub:BatchUpdateFindings", "inspector2:Enable"):
            with self.subTest(action=action):
                template = self.mutated()
                *_, statement = self.reader_item(template, "LerAchadosDeSeguranca")
                statement["Action"].append(action)
                self.assertTrue(problems_read_only(template))

    def test_discovery_with_content_a_write_or_another_role(self):
        for action in (
            "logs:GetLogEvents",
            "logs:StartQuery",
            "guardduty:GetFindings",
            "s3:GetObject",
            "s3:ListBucket",
            "kms:Decrypt",
            "ec2:CreateFlowLogs",
            "wafv2:PutLoggingConfiguration",
            "rds:DownloadDBLogFilePortion",
            "iam:GetRole",
            "s3:Get*",
        ):
            with self.subTest(action=action):
                template = self.mutated()
                *_, statement = self.reader_item(template, "DescobrirFontes")
                statement["Action"].append(action)
                self.assertTrue(problems_read_only(template))
        # A leitura das etiquetas em qualquer papel da conta.
        template = self.mutated()
        *_, statement = self.reader_item(template, "AutoInspecao")
        statement["Resource"] = "*"
        self.assertTrue(problems_read_only(template))
        self.assertTrue(Stack(template, **NODE).allows("iam:GetRole", f"arn:aws:iam::{ACCOUNT}:role/admin"))

    def test_capability_that_no_longer_depends_on_its_switch(self):
        probes = {
            "ReadAwsServiceLogs": lambda stack: stack.allows(
                "s3:GetObject", f"arn:aws:s3:::um-bucket/AWSLogs/{ACCOUNT}/CloudTrail/x.json.gz"
            ),
            "ReadSecurityFindings": lambda stack: stack.allows("guardduty:GetFindings"),
            "ReadTaggedLogGroups": lambda stack: stack.reads_log_group(
                "logs:FilterLogEvents", log_group(), tag=LOG_GROUP_TAG[1]
            ),
        }
        sids = {
            "ReadAwsServiceLogs": "LerLogsDaAwsDestaConta",
            "ReadSecurityFindings": "LerAchadosDeSeguranca",
            "ReadTaggedLogGroups": "LerGruposDeLogEtiquetados",
        }
        for parameter, probe in probes.items():
            with self.subTest(parameter=parameter):
                off = {parameter: "false"}
                self.assertFalse(probe(Stack(self.template, **NODE, **off)))
                # A declaração fora do Fn::If: desligar a autorização não tiraria a leitura.
                template = self.mutated()
                items, index, statement = self.reader_item(template, sids[parameter])
                items[index] = statement
                self.assertTrue(problems_capabilities(template))
                self.assertTrue(probe(Stack(template, **NODE, **off)))
                # A condição invertida: a leitura valeria justamente com a autorização desligada.
                template = self.mutated()
                condition = CAPABILITIES[parameter]["condition"]
                template["Conditions"][condition] = {"Fn::Equals": [{"Ref": parameter}, "false"]}
                self.assertTrue(problems_capabilities(template))
                self.assertTrue(probe(Stack(template, **NODE, **off)))
                # O padrão desligado, ou um valor livre no lugar de true e false.
                for key, value in (("Default", "false"), ("AllowedValues", ["true", "false", "sim"])):
                    template = self.mutated()
                    template["Parameters"][parameter][key] = value
                    self.assertTrue(problems_capabilities(template))
        # Uma declaração sob a condição de outra autorização.
        template = self.mutated()
        items, index, _ = self.reader_item(template, "LerAchadosDeSeguranca")
        items[index]["Fn::If"][0] = "ReadsLogGroups"
        self.assertTrue(problems_capabilities(template))
        # Uma declaração da descoberta que passa a depender de uma autorização.
        template = self.mutated()
        items, index, statement = self.reader_item(template, "DescobrirFontes")
        items[index] = {"Fn::If": ["ReadsFindings", statement, {"Ref": "AWS::NoValue"}]}
        self.assertTrue(problems_capabilities(template))

    def test_role_tags_changed(self):
        def tags(template):
            return template["Resources"]["ReaderRole"]["Properties"]["Tags"]

        # Com vírgula, o IAM recusa a etiqueta (e a pilha inteira).
        template = self.mutated()
        tags(template)[1]["Value"]["Fn::Join"][1][1]["Fn::If"][1] = ",service-logs"
        self.assertTrue(problems_capabilities(template))
        value = Stack(template, **NODE).properties("ReaderRole")["Tags"][1]["Value"]
        self.assertFalse(IAM_TAG_VALUE.fullmatch(value))
        # Sem a descoberta, com outra versão, com a autorização errada na lista, ou sem etiqueta nenhuma.
        for change in (
            lambda template: tags(template)[1]["Value"]["Fn::Join"][1].pop(0),
            lambda template: tags(template)[0].update(Value="1"),
            lambda template: tags(template)[1]["Value"]["Fn::Join"][1][1]["Fn::If"].__setitem__(0, "ReadsFindings"),
            lambda template: tags(template).pop(),
            lambda template: template["Resources"]["ReaderRole"]["Properties"].pop("Tags"),
        ):
            template = self.mutated()
            change(template)
            self.assertTrue(problems_capabilities(template))


if __name__ == "__main__":
    unittest.main()
