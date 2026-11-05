"""Gera a configuração do manager do Wazuh a partir das contas AWS conectadas (T4.4 a T4.6; fase 2, PR-V4': papel de
leitura sem chave).

Roda no serviço `manager-config` da compose (imagem do manager, sem rede), com o Python do próprio Wazuh. No nó de
cliente, quem o chama é o infra/node/bin/wazuh-apply.sh. Entrada (stdin): a lista JSON das contas que o CLI
`wazuh-sources` da API imprime. Nenhum valor dela é segredo: o nó entra no papel de cada conta com o token que o Google
assina para a conta de serviço dele, e não existe chave. Variável opcional VERAX_NODE_EGRESS_IPS: o IP de saída do nó
(o NODE_EGRESS_IPS do node.conf), para as regras locais do papel. Saídas, em volumes separados (o primeiro é copiado
inteiro para /var/ossec pelo init da imagem):

- <config>/etc/ossec.conf: o ossec.conf base do bundle mais o módulo aws-s3, com um bucket por fonte de cada conta.
  Cada bucket só é lido: `remove_from_bucket` fica em `no` (e o papel nega qualquer escrita nos logs);
- <config>/etc/rules/*.xml: as regras locais do bundle e as do papel de leitura (verax_reader_rules.xml, do modelo
  verax_reader_rules.xml.tmpl com o IP do nó), legíveis pelo usuário wazuh: o init da imagem as copia como root sem
  preservar o dono;
- <aws>/config: um profile por conta, que entra no papel verax-control-reader dela (AssumeRoleWithWebIdentity) com o
  token de /root/.aws/google-id-token, que o host renova na mesma pasta (infra/node/bin/aws-token.sh). Só as chaves de
  uma lista fixa: nunca `credential_process`, nunca chave de acesso. Não existe arquivo `credentials`.

O papel é sempre arn:aws:iam::<conta>:role/verax/verax-control-reader, derivado do ID: a entrada não escolhe papel.
Qualquer valor fora do formato para tudo, e nada é escrito pela metade. A saída padrão traz só o hash da configuração
que o manager lê ao subir (o ossec.conf e as regras), que o wazuh-apply.sh compara para decidir se reinicia o manager;
o resumo vai para a saída de erro. A ordem da lista não muda nada (as contas saem em ordem de ID), e um campo que só
vai para os profiles (a região) não muda o hash: o boto3 relê o /root/.aws/config a cada execução do módulo.

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

REQUIRED = {"accountId", "region", "onlyLogsAfter"}
BUCKET_FIELDS = (("cloudtrailBucket", "cloudtrail"), ("guarddutyBucket", "guardduty"), ("wafBucket", "waf"))
ALLOWED = REQUIRED | {field for field, _ in BUCKET_FIELDS}
# O limite de contas por nó fica bem abaixo disso (o plano do nó); acima, a lista é recusada inteira.
MAX_ACCOUNTS = 100

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


def validate(raw):
    try:
        sources = json.loads(raw)
    except json.JSONDecodeError as error:
        raise InvalidSources(f"JSON inválido: {error.msg}") from None
    if not isinstance(sources, list) or len(sources) > MAX_ACCOUNTS:
        raise InvalidSources(f"esperada uma lista com até {MAX_ACCOUNTS} contas")

    seen = set()
    for index, source in enumerate(sources):
        where = f"conta {index}"
        if not isinstance(source, dict):
            raise InvalidSources(f"{where}: esperado um objeto")
        unknown = set(source) - ALLOWED
        missing = REQUIRED - set(source)
        if unknown or missing:
            raise InvalidSources(f"{where}: campos desconhecidos {sorted(unknown)} ou faltando {sorted(missing)}")
        if not all(isinstance(value, str) for value in source.values()):
            raise InvalidSources(f"{where}: todos os valores devem ser texto")
        checks = (("accountId", ACCOUNT_ID), ("region", REGION), ("onlyLogsAfter", WAZUH_DATE))
        for field, pattern in checks:
            if not pattern.match(source[field]):
                raise InvalidSources(f"{where}: {field} fora do formato")
        account = source["accountId"]
        if account in seen:
            raise InvalidSources(f"conta {account} repetida")
        seen.add(account)
        buckets = [field for field, _ in BUCKET_FIELDS if field in source]
        if not buckets:
            raise InvalidSources(f"conta {account}: nenhum bucket informado")
        for field in buckets:
            if not BUCKET.match(source[field]):
                raise InvalidSources(f"conta {account}: {field} fora do formato")
        if "wafBucket" in source and not source["wafBucket"].startswith("aws-waf-logs-"):
            raise InvalidSources(f"conta {account}: wafBucket deve começar com aws-waf-logs-")
    # Em ordem de conta: a ordem da entrada não muda a configuração.
    return sorted(sources, key=lambda source: source["accountId"])


def node_egress_ips():
    """Os IPs de saída do nó, sem o /32, em ordem e sem repetir; vazio sem a variável."""
    raw = os.environ.get(EGRESS_VARIABLE, "")
    if not raw:
        return []
    items = raw.split(",")
    if len(items) > MAX_EGRESS_IPS or not all(EGRESS_IP.match(item) for item in items):
        raise InvalidSources(f"{EGRESS_VARIABLE} fora do formato (até {MAX_EGRESS_IPS} IPv4 com /32)")
    return sorted({item[: -len("/32")] for item in items})


def profile_name(account):
    return f"verax-{account}"


def date_order(wazuh_date):
    """A data do Wazuh (`2026-NOV-01`) como (ano, mês, dia), para comparar."""
    year, month, day = wazuh_date.split("-")
    return int(year), MONTHS.index(month), int(day)


def bucket_reads(sources):
    """Os blocos <bucket> do módulo, um por leitura, na ordem das contas (as fontes já vêm em ordem de ID).

    No CloudTrail, cada conta lê só a pasta AWSLogs/<conta> do bucket (`aws_account_id`): o mesmo bucket em duas contas
    são duas leituras diferentes, cada uma com o papel e o início da coleta da sua conta. O GuardDuty e o WAF são lidos
    inteiros (o export de um administrador delegado do GuardDuty fica na pasta dele, com os achados das contas membro):
    o mesmo bucket listado por mais de uma conta é lido uma vez só, pelo papel da conta de menor ID (o papel dela
    precisa ler o bucket) e a partir da data mais antiga entre elas. Assim, nenhum evento entra duas vezes. O mesmo
    bucket como fontes diferentes da mesma conta (trilha e GuardDuty juntos) são leituras de tipos diferentes.
    """
    reads = {}
    for source in sources:
        account = source["accountId"]
        for field, bucket_type in BUCKET_FIELDS:
            if field not in source:
                continue
            name = source[field]
            key = (bucket_type, name, account) if bucket_type == "cloudtrail" else (bucket_type, name)
            current = reads.get(key)
            if current is None:
                reads[key] = {"type": bucket_type, "name": name, "account": account, "after": source["onlyLogsAfter"]}
            elif date_order(source["onlyLogsAfter"]) < date_order(current["after"]):
                current["after"] = source["onlyLogsAfter"]
    return list(reads.values())


def render_wodle(sources):
    if not sources:
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
    for read in bucket_reads(sources):
        bucket_type, account = read["type"], read["account"]
        lines += [
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
    lines += ["  </wodle>", "</ossec_config>", ""]
    return "\n".join(lines)


def format_profile(name, pairs):
    """Um profile do /root/.aws/config, só com as chaves da lista e valores sem nada que o INI interprete."""
    if not PROFILE_NAME.match(name):
        raise InvalidSources("nome de profile fora do formato")
    lines = [f"[profile {name}]"]
    for key, value in pairs:
        if key not in PROFILE_KEYS:
            raise InvalidSources(f"chave fora da lista do profile: {key}")
        if not PROFILE_VALUE.match(value):
            raise InvalidSources(f"valor de {key} fora do formato")
        lines.append(f"{key} = {value}")
    return "\n".join(lines)


def profile_pairs(source):
    account = source["accountId"]
    return (
        ("role_arn", f"arn:aws:iam::{account}:{READER_ROLE}"),
        ("web_identity_token_file", TOKEN_FILE),
        ("role_session_name", SESSION_NAME),
        ("region", source["region"]),
        ("sts_regional_endpoints", "regional"),
        ("retry_mode", "standard"),
        ("max_attempts", "10"),
    )


def render_aws_config(sources):
    blocks = [format_profile(profile_name(source["accountId"]), profile_pairs(source)) for source in sources]
    return "\n\n".join(blocks) + "\n" if blocks else ""


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
        aws_config = render_aws_config(sources)
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
