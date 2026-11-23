"""Gera a configuração do manager do Wazuh a partir das contas AWS conectadas (T4.4 a T4.6; fase 2, PR-V4': papel de
leitura sem chave).

Roda no serviço `manager-config` da compose (imagem do manager, sem rede), com o Python do próprio Wazuh. No nó de
cliente, quem o chama é o infra/node/bin/wazuh-apply.sh. Entrada (stdin): a lista JSON das contas que o CLI
`wazuh-sources` da API imprime. Nenhum valor dela é segredo: o nó entra no papel de cada conta com o token que o Google
assina para a conta de serviço dele, e não existe chave. Variável opcional VERAX_NODE_EGRESS_IPS: o IP de saída do nó
(o NODE_EGRESS_IPS do node.conf), para as regras locais do papel. Saídas, em volumes separados (o primeiro é copiado
inteiro para /var/ossec pelo init da imagem):

- <config>/etc/ossec.conf: o ossec.conf base do bundle mais o módulo aws-s3, com um bucket por fonte de cada conta e um
  serviço `cloudwatchlogs` por conta e região. Tudo só é lido: `remove_from_bucket` e `remove_log_streams` ficam em
  `no`, escritos em toda entrada (e o papel nega qualquer escrita nos logs);
- <config>/etc/rules/*.xml: as regras locais do bundle e as do papel de leitura (verax_reader_rules.xml, do modelo
  verax_reader_rules.xml.tmpl com o IP do nó), legíveis pelo usuário wazuh: o init da imagem as copia como root sem
  preservar o dono;
- <aws>/config: um profile por conta, que entra no papel verax-control-reader dela (AssumeRoleWithWebIdentity) com o
  token de /root/.aws/google-id-token, que o host renova na mesma pasta (infra/node/bin/aws-token.sh). Só as chaves de
  uma lista fixa: nunca `credential_process`, nunca chave de acesso. Não existe arquivo `credentials`.

Na VM própria do cliente (NODE_PLATFORM=vm, com VERAX_AWS_STATIC_KEYS=1, que o wazuh-apply.sh passa), não há token do
Google: o profile de cada conta fica só com a região e as tentativas, e as credenciais vêm do arquivo `credentials` da
mesma pasta, que o host escreve (infra/node/bin/aws-token.sh: uma sessão de 1 hora da chave de leitura de cada conta,
com o mesmo nome de profile). O gerador nunca escreve nem lê esse arquivo, e nesse modo também não o apaga.

O papel é sempre arn:aws:iam::<conta>:role/verax/verax-control-reader, derivado do ID: a entrada não escolhe papel.
Qualquer valor fora do formato para tudo, e nada é escrito pela metade. A saída padrão traz só o hash da configuração
que o manager lê ao subir (o ossec.conf e as regras), que o wazuh-apply.sh compara para decidir se reinicia o manager;
o resumo vai para a saída de erro. A ordem da lista não muda nada (as contas saem em ordem de ID), e um campo que só
vai para os profiles (a região) não muda o hash: o boto3 relê o /root/.aws/config a cada execução do módulo.

A lista (onboarding self-service da AWS: as fontes que o cliente autorizou). Formato 2, um objeto com a versão:

    {"version": 2, "accounts": [{"accountId", "region", "s3": [...], "logGroups": [...]}]}

- `s3`: uma entrada por fonte lida de bucket. A do cadastro anterior (`"legacy": true`, com `type`, `bucket` e
  `onlyLogsAfter`) sai exatamente como sempre saiu: o CloudTrail só com a pasta da conta, o GuardDuty e o WAF lidos
  inteiros, um bucket repetido entre contas lido uma vez. As outras são as fontes descobertas, e nada nelas deixa o
  módulo listar o bucket à procura de contas ou regiões: `cloudtrail`, `vpcflow` e `guardduty` levam sempre
  `aws_account_id` e `regions` (e a trilha de organização, `aws_organization_id`); o `waf` leva o caminho de uma Web ACL
  (`AWSLogs/<conta>/WAFLogs/<região ou cloudfront>/<nome>/`), montado aqui dos campos conferidos (o tipo `waf` do módulo
  lê só o `path` e ignora conta e regiões). O `prefix` (antes de `AWSLogs/`) só existe nos buckets do cadastro anterior.
  O `vpcflow` com `"traffic": "rejected"` (o padrão do painel) descarta no módulo o tráfego aceito, como o WAF descarta
  o liberado: ele nem chega ao analysisd (nem ao medidor de uso). Cada entrada tem o próprio `only_logs_after`;
- `logGroups`: os grupos do CloudWatch Logs por região e início da coleta. O mesmo nome na mesma região em duas contas
  do nó é recusado: o marcador do módulo não tem a conta, e uma leitura apagaria o marcador da outra.
- Leituras iguais (o mesmo tipo, bucket, prefixo, conta e região vindos de duas fontes) saem uma vez só, desde a data
  mais antiga; a que o cadastro anterior já lê (a mesma pasta da conta no CloudTrail, o bucket inteiro no GuardDuty)
  não sai de novo.
- Tetos por conta: MAX_S3_ENTRIES entradas de bucket e MAX_LOG_GROUPS grupos. A lista do formato anterior (uma lista
  simples de contas com os três buckets) continua aceita, e dá a mesma configuração de antes: é a que uma API de versão
  anterior imprime durante uma atualização. Uma versão desconhecida é recusada.

Antes de trocar a configuração por uma diferente, a que estava fica em <config>/.prev, junto com os profiles que iam
com ela, numa troca só (o init da imagem copia <config>/*, e o * não pega o que começa com ponto). Os profiles que
acompanham a configuração de agora ficam também em <config>/.aws-config, no volume: a pasta da AWS é memória e some
na partida do nó, e a cópia em .prev precisa deles mesmo assim. Com VERAX_MANAGER_CONFIG_ROLLBACK=1, o gerador só
devolve a anterior ao lugar, com os profiles dela, e imprime o hash: é o que o wazuh-apply.sh faz quando o manager não
fica saudável com a nova. Sem os profiles de antes, um bucket lido por outra conta na configuração anterior (o
GuardDuty ou o WAF compartilhado) apontaria para um profile que não existe mais. O token do Google, na mesma pasta,
nunca é tocado: o host o renova sozinho.

Agentes nas instâncias do cliente (WAZUH_AGENTS=true no node.conf do nó; desligado por padrão). Só com as duas
variáveis do compose.wazuh-agents.yaml, VERAX_AGENTS_CONFIG (a pasta config/manager/agents) e VERAX_AGENTS_ENROLLMENT
(o arquivo da senha de registro do nó, só leitura), o gerador também:
- troca no ossec.conf os blocos <remote>, <auth>, <active-response> e <vulnerability-detection> pelos de
  agents/ossec-agents.conf (os que o ossec.conf base não tem entram no fim dele);
- escreve <config>/etc/authd.pass (a senha que o authd confere) e <config>/etc/shared/default/agent.conf (a configuração
  central dos agentes), que o init da imagem copia para /var/ossec.
Sem as variáveis, o ossec.conf sai como sempre e os dois arquivos saem do volume, se uma partida anterior os deixou.
A senha nunca entra numa mensagem de erro nem no hash.
"""

import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from xml.sax.saxutils import escape

ACCOUNT_ID = re.compile(r"^[0-9]{12}$")
# As regiões que a API aceita (isAwsRegion em packages/shared): país, qualificador da partição opcional, área e número.
REGION = re.compile(r"^[a-z]{2}(-(gov|iso|isob|isoe|isof))?-[a-z]{1,16}-[0-9]$")
BUCKET = re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")
RULE_FILE = re.compile(r"^[a-z0-9_]+\.xml$")
MONTHS = ("JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC")
WAZUH_DATE = re.compile(rf"^[0-9]{{4}}-({'|'.join(MONTHS)})-[0-3][0-9]$")

# A lista do formato anterior (uma lista simples): os campos de cada conta. Continua aceita (V1_*).
V1_REQUIRED = {"accountId", "region", "onlyLogsAfter"}
V1_BUCKET_FIELDS = (("cloudtrailBucket", "cloudtrail"), ("guarddutyBucket", "guardduty"), ("wafBucket", "waf"))
V1_ALLOWED = V1_REQUIRED | {field for field, _ in V1_BUCKET_FIELDS}
# O limite de contas por nó fica bem abaixo disso (o plano do nó); acima, a lista é recusada inteira.
MAX_ACCOUNTS = 100

# A lista de agora (WAZUH_SOURCES_VERSION em apps/api/src/aws/wazuh-sources.ts; o contrato confere os dois lados).
LIST_VERSION = 2
ACCOUNT_FIELDS = ("accountId", "region", "s3", "logGroups")
# Os tipos de bucket do módulo que a lista usa, na ordem em que as fontes descobertas saem, e os do cadastro anterior.
S3_TYPES = ("cloudtrail", "vpcflow", "guardduty", "waf")
LEGACY_TYPES = ("cloudtrail", "guardduty", "waf")
S3_REQUIRED = {"type", "bucket", "onlyLogsAfter"}
LOG_GROUPS_FIELDS = {"region", "names", "onlyLogsAfter"}
# O tráfego dos flow logs que entra: só o rejeitado (o aceito é descartado no módulo) ou tudo.
TRAFFIC = ("rejected", "all")
# Tetos por conta (AWS_MAX_AUTHORIZED_S3_SOURCES e AWS_MAX_AUTHORIZED_LOG_GROUPS em packages/shared).
MAX_S3_ENTRIES = 200
MAX_LOG_GROUPS = 50
MAX_REGIONS = 40
# As regiões que o módulo aws-s3 do Wazuh 4.14.9 aceita (aws_tools.ALL_REGIONS). Com qualquer outra em `regions`, o
# módulo para a leitura inteira daquela entrada (código 22), em todas as regiões: a lista com uma delas é recusada.
WODLE_REGIONS = (
    "af-south-1", "ap-east-1", "ap-east-2", "ap-northeast-1", "ap-northeast-2", "ap-northeast-3", "ap-south-1",
    "ap-south-2", "ap-southeast-1", "ap-southeast-2", "ap-southeast-3", "ap-southeast-4", "ap-southeast-5",
    "ap-southeast-7", "ca-central-1", "ca-west-1", "eu-central-1", "eu-central-2", "eu-north-1", "eu-south-1",
    "eu-south-2", "eu-west-1", "eu-west-2", "eu-west-3", "il-central-1", "me-central-1", "me-south-1", "mx-central-1",
    "sa-east-1", "us-east-1", "us-east-2", "us-gov-east-1", "us-gov-west-1", "us-west-1", "us-west-2",
)
ORGANIZATION_ID = re.compile(r"^o-[a-z0-9]{10,32}$")
# O nome de uma Web ACL (a API do WAF só aceita letras, números, hífen e sublinhado) e a "região" do caminho dos logs
# de uma Web ACL do CloudFront.
WEB_ACL = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
WAF_CLOUDFRONT = "cloudfront"
# O prefixo antes de `AWSLogs/`, sem barra nas pontas: até 8 pastas, cada uma só com letras, números, ponto, hífen e
# sublinhado, e 256 caracteres ao todo.
PREFIX_SEGMENT = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
MAX_PREFIX_SEGMENTS = 8
MAX_PREFIX = 256
# O nome de um grupo do CloudWatch Logs. A AWS aceita também `#`, que o módulo recusa (o argumento inteiro falha), e a
# vírgula é o separador da lista: só letras, números, ponto, hífen, sublinhado e barra.
LOG_GROUP = re.compile(r"^[A-Za-z0-9._/-]{1,512}$")
# O leitor de XML do Wazuh recusa o ossec.conf inteiro com um elemento de 20480 caracteres ou mais (conferido na 4.14.9
# com o `wazuh-modulesd -t`): os grupos de uma conta e região saem em quantos serviços forem precisos.
MAX_LOG_GROUPS_TEXT = 8000

# O papel de leitura da pilha (infra/cloudformation/verax-control-reader.yaml), o arquivo do token que o host renova (a
# pasta é montada em /root/.aws no manager) e o nome da sessão do Wazuh no CloudTrail do cliente.
READER_ROLE = "role/verax/verax-control-reader"
TOKEN_FILE = "/root/.aws/google-id-token"
SESSION_NAME = "verax-control-wazuh"
# As únicas chaves que um profile pode ter, nesta ordem: o papel e o token (o botocore usa o provedor de web identity e
# relê o arquivo a cada troca), o STS da região da conta (o global pode estar desligado em regiões opt-in) e o modo de
# repetição padrão, com até 10 tentativas (o throttling do S3 numa leitura grande). Os valores só podem ter letras,
# números e : / . _ -: nenhuma quebra de linha, `=`, `[` ou comentário entra no INI.
PROFILE_KEYS = (
    "role_arn",
    "web_identity_token_file",
    "role_session_name",
    "region",
    "sts_regional_endpoints",
    "retry_mode",
    "max_attempts",
)
PROFILE_VALUE = re.compile(r"^[A-Za-z0-9:/._-]+$")
# VM própria do cliente: as credenciais de cada profile vêm do arquivo `credentials` que o host renova (sessões da chave
# de leitura colada no painel), e o profile não entra em papel nenhum.
STATIC_KEYS_VARIABLE = "VERAX_AWS_STATIC_KEYS"
PROFILE_NAME = re.compile(r"^verax-[0-9]{12}$")

# IP de saída do nó (o NODE_EGRESS_IPS do node.conf): IPv4 com /32, até 4 (o limite do `NodeEgressIps` da pilha).
EGRESS_VARIABLE = "VERAX_NODE_EGRESS_IPS"
OCTET = r"(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])"
EGRESS_IP = re.compile(rf"^{OCTET}(\.{OCTET}){{3}}/32$")
MAX_EGRESS_IPS = 4
# As regras do papel de leitura: o modelo no bundle e o arquivo que o manager carrega. Sem o IP do nó, o bloco marcado
# sai inteiro (sem saber de onde o nó chama, toda sessão do papel pareceria vir de fora).
READER_RULES_TEMPLATE = "verax_reader_rules.xml.tmpl"
READER_RULES = "verax_reader_rules.xml"
EGRESS_MARKER = "@NODE_EGRESS_IPS@"
IP_RULES_BLOCK = re.compile(r"\n[ ]*<!-- verax:ip-rules -->\n.*?\n[ ]*<!-- /verax:ip-rules -->\n", re.S)
IP_RULES_TAGS = re.compile(r"\n[ ]*<!-- /?verax:ip-rules -->\n")

# Agentes: as variáveis do compose.wazuh-agents.yaml, os blocos do ossec.conf que o modo troca e o formato da senha de
# registro (a do install.sh: letras e dígitos, sem nada que precise de escape no comando de instalação).
AGENTS_CONFIG_VARIABLE = "VERAX_AGENTS_CONFIG"
AGENTS_ENROLLMENT_VARIABLE = "VERAX_AGENTS_ENROLLMENT"
AGENT_BLOCKS = ("remote", "auth", "active-response", "vulnerability-detection")
ENROLLMENT_FORMAT = re.compile(r"^[A-Za-z0-9]{32,64}$")
# Começo de um bloco de primeiro nível do ossec.conf: dois espaços de recuo e a etiqueta, com ou sem atributos.
BLOCK_START = re.compile(r"^  <([a-z][a-z_-]*)(?: [^<>]*)?>$")

# O volume da configuração: tudo o que fica em <config>/etc é deste gerador (o init da imagem copia para /var/ossec, e o
# manager nunca escreve de volta). Os caminhos são relativos a <config>.
OSSEC_CONF = os.path.join("etc", "ossec.conf")
RULES_DIR = os.path.join("etc", "rules")
AUTHD_PASS = os.path.join("etc", "authd.pass")
SHARED_AGENT_CONF = os.path.join("etc", "shared", "default", "agent.conf")
PREVIOUS = ".prev"
ROLLBACK_VARIABLE = "VERAX_MANAGER_CONFIG_ROLLBACK"
# Os profiles da AWS: o arquivo que o manager lê (na pasta da AWS) e o registro dos que acompanham a configuração de
# <config>/etc, no volume (na raiz e, na cópia, dentro de .prev). Nenhum é segredo nem entra no hash.
AWS_CONFIG = "config"
PROFILES_RECORD = ".aws-config"
PREVIOUS_PROFILES = "aws-config"


class InvalidSources(ValueError):
    pass


class InvalidAgentsConfig(ValueError):
    pass


def matches(pattern, value):
    """O valor é texto e casa inteiro com o padrão (`fullmatch`: o `$` sozinho aceitaria uma quebra de linha no fim)."""
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def check_fields(where, item, required, optional=frozenset()):
    if not isinstance(item, dict):
        raise InvalidSources(f"{where}: esperado um objeto")
    unknown = set(item) - set(required) - set(optional)
    missing = set(required) - set(item)
    if unknown or missing:
        raise InvalidSources(f"{where}: campos desconhecidos {sorted(unknown)} ou faltando {sorted(missing)}")


def check_format(where, item, field, pattern):
    if not matches(pattern, item[field]):
        raise InvalidSources(f"{where}: {field} fora do formato")
    return item[field]


def check_regions(where, value):
    """As regiões de uma leitura: de 1 a MAX_REGIONS, sem repetir, todas das que o módulo aceita. Saem em ordem."""
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_REGIONS:
        raise InvalidSources(f"{where}: regions deve ser uma lista com 1 a {MAX_REGIONS} regiões")
    if not all(matches(REGION, region) and region in WODLE_REGIONS for region in value):
        raise InvalidSources(f"{where}: região fora do formato ou que o módulo aws-s3 não aceita")
    if len(set(value)) != len(value):
        raise InvalidSources(f"{where}: região repetida")
    return tuple(sorted(value))


def check_prefix(where, entry):
    """O prefixo antes de `AWSLogs/`, ou None sem ele. Nunca `.` nem `..` como pasta."""
    if "prefix" not in entry:
        return None
    prefix = entry["prefix"]
    parts = prefix.split("/") if isinstance(prefix, str) else []
    valid = (
        0 < len(parts) <= MAX_PREFIX_SEGMENTS
        and len(prefix) <= MAX_PREFIX
        and all(matches(PREFIX_SEGMENT, part) and part not in (".", "..") for part in parts)
    )
    if not valid:
        raise InvalidSources(f"{where}: prefix fora do formato")
    return prefix


def validate_s3_entry(where, entry):
    """Uma entrada de bucket da lista, conferida campo a campo, no formato interno (todo campo presente)."""
    if not isinstance(entry, dict) or not S3_REQUIRED <= set(entry):
        raise InvalidSources(f"{where}: esperado um objeto com {sorted(S3_REQUIRED)}")
    kind = entry["type"]
    if kind not in S3_TYPES:
        raise InvalidSources(f"{where}: tipo de bucket desconhecido")
    bucket = check_format(where, entry, "bucket", BUCKET)
    after = check_format(where, entry, "onlyLogsAfter", WAZUH_DATE)
    if kind == "waf" and not bucket.startswith("aws-waf-logs-"):
        raise InvalidSources(f"{where}: o bucket do WAF deve começar com aws-waf-logs-")
    read = {
        "type": kind,
        "bucket": bucket,
        "after": after,
        "legacy": False,
        "regions": (),
        "organizationId": None,
        "prefix": None,
        "webAcl": None,
        "scope": None,
        "traffic": None,
    }
    if "legacy" in entry:
        # A do cadastro anterior: só o tipo, o bucket e a data, e só `true` (a ausência é a fonte descoberta).
        check_fields(where, entry, S3_REQUIRED | {"legacy"})
        if entry["legacy"] is not True or kind not in LEGACY_TYPES:
            raise InvalidSources(f"{where}: legacy só vale como true, nos tipos {', '.join(LEGACY_TYPES)}")
        read["legacy"] = True
        return read
    if kind == "waf":
        check_fields(where, entry, S3_REQUIRED | {"webAcl", "scope"}, {"prefix"})
        read["webAcl"] = check_format(where, entry, "webAcl", WEB_ACL)
        scope = entry["scope"]
        if scope != WAF_CLOUDFRONT and not matches(REGION, scope):
            raise InvalidSources(f"{where}: scope deve ser uma região ou {WAF_CLOUDFRONT}")
        read["scope"] = scope
    else:
        optional = {"prefix"} | ({"organizationId"} if kind == "cloudtrail" else set())
        required = S3_REQUIRED | {"regions"} | ({"traffic"} if kind == "vpcflow" else set())
        check_fields(where, entry, required, optional)
        read["regions"] = check_regions(where, entry["regions"])
        if "organizationId" in entry:
            read["organizationId"] = check_format(where, entry, "organizationId", ORGANIZATION_ID)
        if kind == "vpcflow":
            if entry["traffic"] not in TRAFFIC:
                raise InvalidSources(f"{where}: traffic deve ser {' ou '.join(TRAFFIC)}")
            read["traffic"] = entry["traffic"]
    read["prefix"] = check_prefix(where, entry)
    return read


def validate_log_groups(where, entry):
    check_fields(where, entry, LOG_GROUPS_FIELDS)
    region = check_format(where, entry, "region", REGION)
    if region not in WODLE_REGIONS:
        raise InvalidSources(f"{where}: região que o módulo aws-s3 não aceita")
    names = entry["names"]
    if not isinstance(names, list) or not names:
        raise InvalidSources(f"{where}: names deve ser uma lista com ao menos um grupo")
    if not all(matches(LOG_GROUP, name) for name in names):
        raise InvalidSources(f"{where}: nome de grupo de logs fora do formato")
    return {"region": region, "names": tuple(names), "after": check_format(where, entry, "onlyLogsAfter", WAZUH_DATE)}


def validate_account(where, account):
    """Uma conta da lista de agora, no formato interno: as entradas do cadastro anterior primeiro, na ordem dos tipos."""
    check_fields(where, account, ACCOUNT_FIELDS)
    account_id = check_format(where, account, "accountId", ACCOUNT_ID)
    region = check_format(where, account, "region", REGION)
    where = f"conta {account_id}"
    s3, groups = account["s3"], account["logGroups"]
    if not isinstance(s3, list) or not isinstance(groups, list):
        raise InvalidSources(f"{where}: s3 e logGroups devem ser listas")
    if not s3 and not groups:
        raise InvalidSources(f"{where}: nenhuma fonte informada")
    if len(s3) > MAX_S3_ENTRIES:
        raise InvalidSources(f"{where}: mais de {MAX_S3_ENTRIES} entradas de bucket")
    reads = [validate_s3_entry(f"{where}, bucket {index}", entry) for index, entry in enumerate(s3)]
    legacy = [read["type"] for read in reads if read["legacy"]]
    if len(set(legacy)) != len(legacy):
        raise InvalidSources(f"{where}: mais de um bucket do cadastro anterior do mesmo tipo")
    reads.sort(key=lambda read: (not read["legacy"], LEGACY_TYPES.index(read["type"]) if read["legacy"] else 0))
    log_groups = [validate_log_groups(f"{where}, grupos {index}", entry) for index, entry in enumerate(groups)]
    named = [(entry["region"], name) for entry in log_groups for name in entry["names"]]
    if len(named) > MAX_LOG_GROUPS:
        raise InvalidSources(f"{where}: mais de {MAX_LOG_GROUPS} grupos de logs")
    if len(set(named)) != len(named):
        raise InvalidSources(f"{where}: grupo de logs repetido")
    return {"accountId": account_id, "region": region, "s3": reads, "logGroups": log_groups}


def validate_v1(sources):
    """A lista do formato anterior, com as mesmas conferências de antes, já no formato interno (só o cadastro anterior)."""
    accounts = []
    for index, source in enumerate(sources):
        where = f"conta {index}"
        if not isinstance(source, dict):
            raise InvalidSources(f"{where}: esperado um objeto")
        unknown = set(source) - V1_ALLOWED
        missing = V1_REQUIRED - set(source)
        if unknown or missing:
            raise InvalidSources(f"{where}: campos desconhecidos {sorted(unknown)} ou faltando {sorted(missing)}")
        if not all(isinstance(value, str) for value in source.values()):
            raise InvalidSources(f"{where}: todos os valores devem ser texto")
        buckets = [
            {"type": kind, "bucket": source[field], "onlyLogsAfter": source["onlyLogsAfter"], "legacy": True}
            for field, kind in V1_BUCKET_FIELDS
            if field in source
        ]
        accounts.append({"accountId": source["accountId"], "region": source["region"], "s3": buckets, "logGroups": []})
    return accounts


def validate(raw):
    """A lista conferida, no formato interno e em ordem de conta (a ordem da entrada não muda a configuração)."""
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as error:
        raise InvalidSources(f"JSON inválido: {error.msg}") from None
    if isinstance(data, list):
        listed = validate_v1(data) if len(data) <= MAX_ACCOUNTS else None
    else:
        if not isinstance(data, dict) or set(data) != {"version", "accounts"}:
            raise InvalidSources("esperado um objeto com version e accounts")
        # `True == 1` no Python: a versão é o número inteiro, e só a de agora.
        if type(data["version"]) is not int or data["version"] != LIST_VERSION:
            raise InvalidSources(f"versão da lista desconhecida (este gerador lê a {LIST_VERSION})")
        listed = data["accounts"]
    if not isinstance(listed, list) or len(listed) > MAX_ACCOUNTS:
        raise InvalidSources(f"esperada uma lista com até {MAX_ACCOUNTS} contas")

    accounts = [validate_account(f"conta {index}", account) for index, account in enumerate(listed)]
    seen = set()
    groups = {}
    for account in accounts:
        account_id = account["accountId"]
        if account_id in seen:
            raise InvalidSources(f"conta {account_id} repetida")
        seen.add(account_id)
        # O marcador do módulo para o CloudWatch Logs é por região, grupo e stream, sem a conta: o mesmo nome na mesma
        # região em duas contas dividiria o marcador, e a limpeza de uma leitura apagaria o da outra.
        for entry in account["logGroups"]:
            for name in entry["names"]:
                other = groups.setdefault((entry["region"], name), account_id)
                if other != account_id:
                    raise InvalidSources(f"grupo de logs repetido nas contas {other} e {account_id}")
    return sorted(accounts, key=lambda account: account["accountId"])


def node_egress_ips():
    """Os IPs de saída do nó, sem o /32, em ordem e sem repetir; vazio sem a variável."""
    raw = os.environ.get(EGRESS_VARIABLE, "")
    if not raw:
        return []
    items = raw.split(",")
    if len(items) > MAX_EGRESS_IPS or not all(matches(EGRESS_IP, item) for item in items):
        raise InvalidSources(f"{EGRESS_VARIABLE} fora do formato (até {MAX_EGRESS_IPS} IPv4 com /32)")
    return sorted({item[: -len("/32")] for item in items})


def profile_name(account):
    return f"verax-{account}"


def date_order(wazuh_date):
    """A data do Wazuh (`2026-NOV-01`) como (ano, mês, dia), para comparar."""
    year, month, day = wazuh_date.split("-")
    return int(year), MONTHS.index(month), int(day)


def legacy_reads(accounts):
    """As leituras do cadastro anterior, uma por bloco <bucket>, na ordem das contas (que já vêm em ordem de ID).

    No CloudTrail, cada conta lê só a pasta AWSLogs/<conta> do bucket (`aws_account_id`): o mesmo bucket em duas contas
    são duas leituras diferentes, cada uma com o papel e o início da coleta da sua conta. O GuardDuty e o WAF são lidos
    inteiros (o export de um administrador delegado do GuardDuty fica na pasta dele, com os achados das contas membro):
    o mesmo bucket listado por mais de uma conta é lido uma vez só, pelo papel da conta de menor ID (o papel dela
    precisa ler o bucket) e a partir da data mais antiga entre elas. Assim, nenhum evento entra duas vezes. O mesmo
    bucket como fontes diferentes da mesma conta (trilha e GuardDuty juntos) são leituras de tipos diferentes.
    """
    reads = {}
    for account in accounts:
        account_id = account["accountId"]
        for entry in account["s3"]:
            if not entry["legacy"]:
                continue
            kind, name = entry["type"], entry["bucket"]
            key = (kind, name, account_id) if kind == "cloudtrail" else (kind, name)
            current = reads.get(key)
            if current is None:
                reads[key] = {"type": kind, "name": name, "account": account_id, "after": entry["after"]}
            elif date_order(entry["after"]) < date_order(current["after"]):
                current["after"] = entry["after"]
    return reads


def waf_path(account_id, entry):
    """O caminho dos logs de uma Web ACL no bucket, montado dos campos já conferidos, com a barra no fim."""
    head = f"{entry['prefix']}/" if entry["prefix"] else ""
    return f"{head}AWSLogs/{account_id}/WAFLogs/{entry['scope']}/{entry['webAcl']}/"


def source_reads(accounts, legacy):
    """As leituras das fontes descobertas, em ordem de conta, tipo, bucket e caminho.

    Cada uma é exata: a pasta da conta e as regiões (ou o caminho da Web ACL), sem o módulo listar o bucket à procura de
    contas e regiões. A mesma leitura (tipo, bucket, prefixo, organização, conta e região) vinda de duas fontes sai uma
    vez só, desde a data mais antiga (e, nos flow logs, com tudo se uma delas pede tudo): dois flow logs da mesma região
    no mesmo bucket são a mesma leitura. A que o cadastro anterior já faz não sai de novo: a pasta da conta no
    CloudTrail (sem prefixo nem organização) e o bucket inteiro no GuardDuty (sem prefixo).
    """
    by_region = {}
    web_acls = {}
    for account in accounts:
        account_id = account["accountId"]
        for entry in account["s3"]:
            if entry["legacy"]:
                continue
            kind, bucket, prefix = entry["type"], entry["bucket"], entry["prefix"] or ""
            if kind == "waf":
                key = (account_id, bucket, waf_path(account_id, entry))
                current = web_acls.get(key)
                if current is None or date_order(entry["after"]) < date_order(current):
                    web_acls[key] = entry["after"]
                continue
            organization = entry["organizationId"] or ""
            if not prefix and not organization and (
                (kind == "cloudtrail" and ("cloudtrail", bucket, account_id) in legacy)
                or (kind == "guardduty" and ("guardduty", bucket) in legacy)
            ):
                continue
            for region in entry["regions"]:
                key = (account_id, kind, bucket, prefix, organization, region)
                current = by_region.get(key)
                if current is None:
                    by_region[key] = {"after": entry["after"], "traffic": entry["traffic"]}
                    continue
                if date_order(entry["after"]) < date_order(current["after"]):
                    current["after"] = entry["after"]
                if entry["traffic"] == "all":
                    current["traffic"] = "all"

    # As regiões com a mesma data (e o mesmo tráfego) juntas num bloco só.
    grouped = {}
    for (account_id, kind, bucket, prefix, organization, region), value in by_region.items():
        key = (account_id, S3_TYPES.index(kind), bucket, prefix, organization, date_order(value["after"]),
               value["traffic"] or "")
        grouped.setdefault(key, {"after": value["after"], "regions": []})["regions"].append(region)
    reads = []
    for key in sorted(grouped):
        account_id, kind_index, bucket, prefix, organization, _, traffic = key
        reads.append({
            "type": S3_TYPES[kind_index],
            "name": bucket,
            "account": account_id,
            "after": grouped[key]["after"],
            "path": f"{prefix}/" if prefix else None,
            "organization": organization or None,
            "regions": sorted(grouped[key]["regions"]),
            "traffic": traffic or None,
        })
    for account_id, bucket, path in sorted(web_acls):
        reads.append({
            "type": "waf",
            "name": bucket,
            "account": account_id,
            "after": web_acls[(account_id, bucket, path)],
            "path": path,
            "organization": None,
            "regions": None,
            "traffic": None,
        })
    # Em ordem de conta e, dentro dela, de tipo (a ordenação é estável: o resto fica como está).
    reads.sort(key=lambda read: (read["account"], S3_TYPES.index(read["type"])))
    return reads


def log_group_services(accounts):
    """Os blocos <service type="cloudwatchlogs">: por conta, região e início da coleta, com os grupos em ordem.

    Grupos da mesma região autorizados em dias diferentes ficam em blocos separados: cada um começa na própria data, sem
    trazer o histórico do outro. Um bloco que passaria do tamanho que o XML do Wazuh aceita é dividido.
    """
    services = []
    for account in accounts:
        merged = {}
        for entry in account["logGroups"]:
            merged.setdefault((entry["region"], date_order(entry["after"]), entry["after"]), []).extend(entry["names"])
        for region, _, after in sorted(merged):
            chunk, size = [], 0
            for name in sorted(merged[(region, date_order(after), after)]):
                if chunk and size + 1 + len(name) > MAX_LOG_GROUPS_TEXT:
                    services.append({"account": account["accountId"], "region": region, "after": after, "names": chunk})
                    chunk, size = [], 0
                size += len(name) + (1 if chunk else 0)
                chunk.append(name)
            services.append({"account": account["accountId"], "region": region, "after": after, "names": chunk})
    return services


def render_legacy_bucket(read):
    """O bloco de uma leitura do cadastro anterior, linha a linha como sempre saiu."""
    bucket_type, account = read["type"], read["account"]
    lines = [
        f'    <bucket type="{bucket_type}">',
        f"      <name>{escape(read['name'])}</name>",
        f"      <aws_profile>{profile_name(account)}</aws_profile>",
    ]
    # Lê só a pasta AWSLogs/<conta> (o bucket pode ter logs de outras contas da organização).
    if bucket_type == "cloudtrail":
        lines.append(f"      <aws_account_id>{account}</aws_account_id>")
    lines += [
        f"      <only_logs_after>{read['after']}</only_logs_after>",
        # O bucket é do cliente: o módulo nunca apaga o que leu (o marcador de leitura fica no manager).
        "      <remove_from_bucket>no</remove_from_bucket>",
    ]
    # O WAF registra toda requisição: só as bloqueadas e as contadas interessam. As liberadas nem chegam ao
    # analysisd (nem ao medidor de uso).
    if bucket_type == "waf":
        lines.append('      <discard_regex field="action">ALLOW</discard_regex>')
    lines.append("    </bucket>")
    return lines


def render_source_bucket(read):
    """O bloco de uma fonte descoberta. Todo valor já passou pela lista fechada do tipo dele, e ainda assim é escapado."""
    bucket_type, account = read["type"], read["account"]
    lines = [
        f'    <bucket type="{bucket_type}">',
        f"      <name>{escape(read['name'])}</name>",
        f"      <aws_profile>{profile_name(account)}</aws_profile>",
    ]
    if read["path"]:
        lines.append(f"      <path>{escape(read['path'])}</path>")
    if bucket_type != "waf":
        # A pasta exata: AWSLogs/[<organização>/]<conta>/<serviço>/<região>/. O tipo `waf` do módulo só lê o `path`.
        if read["organization"]:
            lines.append(f"      <aws_organization_id>{escape(read['organization'])}</aws_organization_id>")
        lines += [
            f"      <aws_account_id>{account}</aws_account_id>",
            f"      <regions>{escape(','.join(read['regions']))}</regions>",
        ]
    lines += [
        f"      <only_logs_after>{read['after']}</only_logs_after>",
        "      <remove_from_bucket>no</remove_from_bucket>",
    ]
    if bucket_type == "waf":
        lines.append('      <discard_regex field="action">ALLOW</discard_regex>')
    # Flow logs: o tráfego aceito é a maior parte do volume e não diz nada sozinho. Por padrão, só o rejeitado entra.
    if bucket_type == "vpcflow" and read["traffic"] != "all":
        lines.append('      <discard_regex field="action">ACCEPT</discard_regex>')
    lines.append("    </bucket>")
    return lines


def render_log_groups(service):
    return [
        '    <service type="cloudwatchlogs">',
        f"      <aws_profile>{profile_name(service['account'])}</aws_profile>",
        f"      <aws_log_groups>{escape(','.join(service['names']))}</aws_log_groups>",
        f"      <regions>{service['region']}</regions>",
        f"      <only_logs_after>{service['after']}</only_logs_after>",
        # Os grupos são do cliente: o módulo nunca apaga um stream que leu.
        "      <remove_log_streams>no</remove_log_streams>",
        # Uma linha de log em JSON que se diz evento do próprio módulo (`"integration": "aws"`) é descartada: no
        # analysisd ela seria lida como um evento do CloudTrail ou do GuardDuty vindo de um bucket, e quem escreve no
        # grupo forjaria um alerta. O padrão explícito também tira o do módulo, que sem a opção descarta toda linha que
        # começa com "None".
        '      <discard_regex field="integration">^aws$</discard_regex>',
        "    </service>",
    ]


def render_wodle(accounts):
    legacy = legacy_reads(accounts)
    sources = source_reads(accounts, legacy)
    services = log_group_services(accounts)
    if not legacy and not sources and not services:
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
    for read in legacy.values():
        lines += render_legacy_bucket(read)
    for read in sources:
        lines += render_source_bucket(read)
    for service in services:
        lines += render_log_groups(service)
    lines += ["  </wodle>", "</ossec_config>", ""]
    return "\n".join(lines)


def format_profile(name, pairs):
    """Um profile do /root/.aws/config, só com as chaves da lista e valores sem nada que o INI interprete."""
    if not matches(PROFILE_NAME, name):
        raise InvalidSources("nome de profile fora do formato")
    lines = [f"[profile {name}]"]
    for key, value in pairs:
        if key not in PROFILE_KEYS:
            raise InvalidSources(f"chave fora da lista do profile: {key}")
        if not matches(PROFILE_VALUE, value):
            raise InvalidSources(f"valor de {key} fora do formato")
        lines.append(f"{key} = {value}")
    return "\n".join(lines)


def profile_pairs(source, static_keys=False):
    account = source["accountId"]
    retry = (
        ("region", source["region"]),
        ("retry_mode", "standard"),
        ("max_attempts", "10"),
    )
    if static_keys:
        return retry
    return (
        ("role_arn", f"arn:aws:iam::{account}:{READER_ROLE}"),
        ("web_identity_token_file", TOKEN_FILE),
        ("role_session_name", SESSION_NAME),
        ("region", source["region"]),
        ("sts_regional_endpoints", "regional"),
        ("retry_mode", "standard"),
        ("max_attempts", "10"),
    )


def render_aws_config(sources, static_keys=False):
    blocks = [
        format_profile(profile_name(source["accountId"]), profile_pairs(source, static_keys)) for source in sources
    ]
    return "\n\n".join(blocks) + "\n" if blocks else ""


def static_keys_mode():
    """VERAX_AWS_STATIC_KEYS=1 (VM própria do cliente) liga o modo da chave de leitura; qualquer outro valor é recusado."""
    value = os.environ.get(STATIC_KEYS_VARIABLE, "")
    if value not in ("", "0", "1"):
        raise InvalidSources(f"{STATIC_KEYS_VARIABLE} deve ser 0 ou 1")
    return value == "1"


def render_reader_rules(template, ips):
    """As regras do papel de leitura com o IP do nó; sem ele, sem o bloco das regras por IP."""
    if ips:
        alternation = "|".join(re.escape(ip) for ip in ips)
        text = IP_RULES_TAGS.sub("\n", template).replace(EGRESS_MARKER, alternation)
    else:
        text = IP_RULES_BLOCK.sub("\n", template)
    if EGRESS_MARKER in text or "verax:ip-rules" in text:
        raise InvalidSources(f"modelo {READER_RULES_TEMPLATE} com os marcadores fora do lugar")
    return text


def top_level_blocks(text):
    """Os blocos de primeiro nível do ossec.conf (dois espaços de recuo), por etiqueta, cada um com o texto exato."""
    blocks = {}
    lines = text.split("\n")
    index = 0
    while index < len(lines):
        match = BLOCK_START.match(lines[index])
        if not match:
            index += 1
            continue
        tag = match.group(1)
        try:
            end = lines.index(f"  </{tag}>", index + 1)
        except ValueError:
            raise InvalidAgentsConfig(f"bloco <{tag}> sem o fechamento no mesmo recuo") from None
        blocks.setdefault(tag, []).append("\n".join(lines[index : end + 1]))
        index = end + 1
    return blocks


def apply_agents(base, fragment):
    """O ossec.conf base com os blocos dos agentes: troca os que existem e acrescenta os outros no fim do bloco base."""
    wanted = top_level_blocks(fragment)
    if sorted(wanted) != sorted(AGENT_BLOCKS) or any(len(found) != 1 for found in wanted.values()):
        raise InvalidAgentsConfig(f"ossec-agents.conf deve ter um bloco de cada: {', '.join(AGENT_BLOCKS)}")
    present = top_level_blocks(base)
    result = base
    appended = []
    for tag in AGENT_BLOCKS:
        found = present.get(tag, [])
        if len(found) > 1:
            raise InvalidAgentsConfig(f"o ossec.conf base tem mais de um bloco <{tag}>")
        if found:
            result = result.replace(found[0], wanted[tag][0], 1)
        else:
            appended.append(wanted[tag][0])
    if appended:
        closing = result.rindex("\n</ossec_config>")
        result = result[:closing] + "\n\n" + "\n\n".join(appended) + result[closing:]
    return result


def read_agents_settings():
    """Modo dos agentes: (fragmento do ossec.conf, agent.conf, senha) ou None sem as variáveis do compose."""
    config_dir = os.environ.get(AGENTS_CONFIG_VARIABLE)
    enrollment = os.environ.get(AGENTS_ENROLLMENT_VARIABLE)
    if config_dir is None and enrollment is None:
        return None
    if not config_dir or not enrollment:
        raise InvalidAgentsConfig(f"{AGENTS_CONFIG_VARIABLE} e {AGENTS_ENROLLMENT_VARIABLE} andam juntas")
    try:
        with open(os.path.join(config_dir, "ossec-agents.conf"), encoding="utf-8") as file:
            fragment = file.read()
        with open(os.path.join(config_dir, "agent.conf"), encoding="utf-8") as file:
            agent_conf = file.read()
        with open(enrollment, encoding="utf-8") as file:
            password = file.read()
    except OSError as error:
        # Só o tipo do erro e qual arquivo: nunca o conteúdo.
        raise InvalidAgentsConfig(f"arquivo dos agentes ilegível ({type(error).__name__})") from None
    password = password.removesuffix("\n")
    if not ENROLLMENT_FORMAT.match(password):
        raise InvalidAgentsConfig("a senha de registro deve ter de 32 a 64 letras e dígitos")
    return fragment, agent_conf, password


def bundle_rules(rules_dir):
    """As regras locais do bundle (os .xml da pasta) e o modelo das regras do papel de leitura."""
    rules = {}
    for name in sorted(os.listdir(rules_dir)):
        if RULE_FILE.match(name) and name != READER_RULES:
            with open(os.path.join(rules_dir, name), encoding="utf-8") as file:
                rules[name] = file.read()
    try:
        with open(os.path.join(rules_dir, READER_RULES_TEMPLATE), encoding="utf-8") as file:
            template = file.read()
    except FileNotFoundError:
        raise InvalidSources(f"falta o modelo {READER_RULES_TEMPLATE} na pasta das regras") from None
    return rules, template


def mode_for(relative):
    """O ossec.conf e a senha de registro só para o root e o grupo wazuh; o resto (regras, agent.conf), legível."""
    return 0o640 if relative in (OSSEC_CONF, AUTHD_PASS) else 0o644


def read_tree(root):
    """Os arquivos de <root>/etc, pelo caminho relativo a <root>, com o conteúdo em bytes (vazio sem a pasta)."""
    files = {}
    for directory, _, names in os.walk(os.path.join(root, "etc")):
        for name in names:
            path = os.path.join(directory, name)
            with open(path, "rb") as file:
                files[os.path.relpath(path, root)] = file.read()
    return files


def tree_hash(files):
    """Hash do que o manager lê ao subir: todos os arquivos, menos a senha de registro (nada dela sai daqui)."""
    digest = hashlib.sha256()
    for relative in sorted(files, key=lambda path: path.replace(os.sep, "/")):
        if relative == AUTHD_PASS:
            continue
        content = files[relative]
        digest.update(f"{relative.replace(os.sep, '/')}\0{len(content)}\0".encode() + content)
    return digest.hexdigest()


def write_atomically(path, content, mode):
    directory = os.path.dirname(path)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    handle, temporary = tempfile.mkstemp(dir=directory)
    try:
        with os.fdopen(handle, "wb") as file:
            file.write(content if isinstance(content, bytes) else content.encode("utf-8"))
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    except BaseException:
        os.unlink(temporary)
        raise


def install_tree(config_dir, files, current):
    """Deixa <config>/etc exatamente com estes arquivos: grava os que mudaram e tira os que sobraram."""
    for relative, content in files.items():
        if current.get(relative) != content:
            write_atomically(os.path.join(config_dir, relative), content, mode_for(relative))
    for relative in set(current) - set(files):
        os.unlink(os.path.join(config_dir, relative))
    # Pastas que ficaram vazias (shared/default sem os agentes), das mais fundas para cima; a etc fica.
    etc = os.path.normpath(os.path.join(config_dir, "etc"))
    for directory, _, _ in os.walk(etc, topdown=False):
        if os.path.normpath(directory) != etc and not os.listdir(directory):
            os.rmdir(directory)


def read_optional(path):
    """O conteúdo em bytes, ou None sem o arquivo."""
    try:
        with open(path, "rb") as file:
            return file.read()
    except FileNotFoundError:
        return None


def install_profiles(config_dir, aws_dir, profiles):
    """Os profiles no arquivo que o manager lê e no registro do volume, cada um por troca atômica e só se mudou.

    None: não havia profiles com aquela configuração (um volume de antes do registro); os dois arquivos saem. Só o
    arquivo dos profiles: o token do Google, na mesma pasta, fica como está.
    """
    for path in (os.path.join(config_dir, PROFILES_RECORD), os.path.join(aws_dir, AWS_CONFIG)):
        if profiles is None:
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass
        elif read_optional(path) != profiles:
            write_atomically(path, profiles, 0o600)


def keep_previous(config_dir, current, profiles):
    """A configuração que estava, em <config>/.prev/etc, e os profiles dela, em <config>/.prev/aws-config (só root).

    A pasta é montada ao lado e trocada inteira de uma vez: a configuração e os profiles de antes sempre juntos, nunca
    misturados com os de uma troca anterior.
    """
    for name in os.listdir(config_dir):
        # O que sobrou de uma troca interrompida.
        if name.startswith(PREVIOUS + "-"):
            shutil.rmtree(os.path.join(config_dir, name), ignore_errors=True)
    staging = tempfile.mkdtemp(dir=config_dir, prefix=PREVIOUS + "-")
    try:
        for relative, content in current.items():
            write_atomically(os.path.join(staging, relative), content, 0o600)
        if profiles is not None:
            write_atomically(os.path.join(staging, PREVIOUS_PROFILES), profiles, 0o600)
        previous = os.path.join(config_dir, PREVIOUS)
        if os.path.isdir(previous):
            shutil.rmtree(previous)
        os.replace(staging, previous)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def rollback(config_dir, aws_dir):
    previous_dir = os.path.join(config_dir, PREVIOUS)
    previous = read_tree(previous_dir)
    if not previous:
        print("ERRO: não há configuração anterior para restaurar.", file=sys.stderr)
        return 1
    install_tree(config_dir, previous, read_tree(config_dir))
    install_profiles(config_dir, aws_dir, read_optional(os.path.join(previous_dir, PREVIOUS_PROFILES)))
    print(tree_hash(previous))
    print("Configuração anterior do manager restaurada, com os profiles da AWS dela.", file=sys.stderr)
    return 0


def remove_credentials_file(aws_dir):
    """Os profiles não usam o arquivo `credentials`: se um sobrou de outra versão, ele sai (só ele; o token fica)."""
    try:
        os.unlink(os.path.join(aws_dir, "credentials"))
        print("Arquivo credentials antigo removido da pasta da AWS.", file=sys.stderr)
    except FileNotFoundError:
        pass


def main(base_config, config_dir, aws_dir, rules_dir=None):
    if os.environ.get(ROLLBACK_VARIABLE) == "1":
        return rollback(config_dir, aws_dir)
    try:
        sources = validate(sys.stdin.read().strip() or "[]")
        ips = node_egress_ips()
        static_keys = static_keys_mode()
        aws_config = render_aws_config(sources, static_keys)
        rules = bundle_rules(rules_dir) if rules_dir else None
        reader_rules = render_reader_rules(rules[1], ips) if rules else None
    except InvalidSources as error:
        print(f"ERRO: lista de contas AWS: {error}", file=sys.stderr)
        return 1
    with open(base_config, encoding="utf-8") as file:
        base = file.read()
    # Tudo dos agentes é lido e conferido antes de qualquer escrita: um erro não deixa a configuração pela metade.
    try:
        agents = read_agents_settings()
        if agents is not None:
            base = apply_agents(base, agents[0])
    except InvalidAgentsConfig as error:
        print(f"ERRO: agentes: {error}", file=sys.stderr)
        return 1

    current = read_tree(config_dir)
    files = {OSSEC_CONF: (base.rstrip("\n") + "\n" + render_wodle(sources)).encode("utf-8")}
    if rules:
        # Regras não são segredo (estão no repositório), e o analysisd as lê como o usuário wazuh.
        for name, content in rules[0].items():
            files[os.path.join(RULES_DIR, name)] = content.encode("utf-8")
        files[os.path.join(RULES_DIR, READER_RULES)] = reader_rules.encode("utf-8")
    else:
        # Sem a pasta das regras, as que já estão no volume ficam como estão.
        files.update({path: content for path, content in current.items() if path.startswith(RULES_DIR + os.sep)})
    if agents is not None:
        # O authd roda como root e lê a senha; o agent.conf é lido pelo usuário wazuh.
        files[AUTHD_PASS] = (agents[2] + "\n").encode("utf-8")
        files[SHARED_AGENT_CONF] = agents[1].encode("utf-8")

    changed = current != files
    if changed:
        if current:
            # Os profiles que iam com a configuração de agora vêm do registro no volume, e não da pasta da AWS, que
            # some na partida do nó.
            keep_previous(config_dir, current, read_optional(os.path.join(config_dir, PROFILES_RECORD)))
        install_tree(config_dir, files, current)
    install_profiles(config_dir, aws_dir, aws_config.encode("utf-8"))
    # Na VM própria, o arquivo credentials é o do host (as sessões da chave de leitura): fica.
    if not static_keys:
        remove_credentials_file(aws_dir)
    # A raiz do volume nasce 0755; fechada, para só o root listar o diretório. Num diretório, o bit x é o de
    # entrar nele: 0700 (só o dono) é o mais restrito que funciona, ao contrário do que a regra supõe para arquivos.
    os.chmod(aws_dir, 0o700)  # nosemgrep: python.lang.security.audit.insecure-file-permissions.insecure-file-permissions
    print(tree_hash(files))
    details = [f"{len(sources)} conta(s) AWS"]
    if agents is not None:
        details.append("os agentes")
    if rules and not ips:
        details.append("sem o IP de saída do nó (só as regras de alteração do papel)")
    state = "trocada" if changed else "sem mudança"
    print(f"Configuração do manager {state}: {', '.join(details)}.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:5]))
