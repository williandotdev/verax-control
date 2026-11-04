"""Gera o ossec.conf do manager e os profiles da AWS a partir das contas conectadas (T4.4 a T4.6).

Roda no serviço `manager-config` da compose (imagem do manager, sem rede), com o Python do próprio Wazuh, a cada
deploy. Entrada (stdin): a lista JSON das contas conectadas, que a API mantém num segredo do Secrets Manager e o
bootstrap-host.sh entrega ao deploy.sh por um arquivo em tmpfs. Por stdin, e não por variável de ambiente, porque
variáveis passam pelo limite do execve e ficam gravadas na configuração do contêiner. Saídas, em volumes separados (o primeiro é copiado inteiro para /var/ossec pelo init
da imagem, e os ExternalIds não podem ir junto):

- <config>/etc/ossec.conf: o ossec.conf base do bundle mais o módulo aws-s3, com um bucket por fonte de cada conta;
- <config>/etc/rules/*.xml: as regras locais do bundle (correlações da AWS separadas por conta), legíveis pelo
  usuário wazuh: o init da imagem as copia como root sem preservar o dono;
- <aws>/config: um profile por conta, que assume o papel VeraxControlReadOnly com o ExternalId dela usando a
  credencial da instância. É o único jeito de o wodle usar ExternalId com buckets (o --external_id da linha de
  comando dele só vale para o Security Lake).

O papel é sempre arn:aws:iam::<conta>:role/VeraxControlReadOnly, derivado do ID: a entrada não escolhe papel.
Qualquer valor fora do formato derruba o deploy, e nada é escrito pela metade.

Agentes nas instâncias do cliente (WAZUH_AGENTS=true no node.conf do nó; desligado por padrão). Só com as duas
variáveis do compose.wazuh-agents.yaml, VERAX_AGENTS_CONFIG (a pasta config/manager/agents) e VERAX_AGENTS_ENROLLMENT
(o arquivo da senha de registro do nó, só leitura), o gerador também:
- troca no ossec.conf os blocos <remote>, <auth>, <active-response> e <vulnerability-detection> pelos de
  agents/ossec-agents.conf (os que o ossec.conf base não tem entram no fim dele);
- escreve <config>/etc/authd.pass (a senha que o authd confere) e <config>/etc/shared/default/agent.conf (a configuração
  central dos agentes), que o init da imagem copia para /var/ossec.
Sem as variáveis, o ossec.conf sai como sempre e os dois arquivos saem do volume, se uma partida anterior os deixou.
A senha nunca entra numa mensagem de erro.
"""

import json
import os
import re
import sys
import tempfile
from xml.sax.saxutils import escape

ACCOUNT_ID = re.compile(r"^[0-9]{12}$")
EXTERNAL_ID = re.compile(r"^[A-Za-z0-9+=,.@:/_-]{32,128}$")
REGION = re.compile(r"^[a-z]{2}(-gov)?-[a-z]+-[0-9]$")
BUCKET = re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")
RULE_FILE = re.compile(r"^[a-z0-9_]+\.xml$")
WAZUH_DATE = re.compile(r"^[0-9]{4}-(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)-[0-3][0-9]$")

REQUIRED = {"accountId", "externalId", "region", "onlyLogsAfter"}
BUCKET_FIELDS = (("cloudtrailBucket", "cloudtrail"), ("guarddutyBucket", "guardduty"), ("wafBucket", "waf"))
ALLOWED = REQUIRED | {field for field, _ in BUCKET_FIELDS}
# Cabe no limite de 64 KB de um segredo do Secrets Manager com folga. Acima disso, a lista passa para o S3.
MAX_ACCOUNTS = 100

# Agentes: as variáveis do compose.wazuh-agents.yaml, os blocos do ossec.conf que o modo troca e o formato da senha de
# registro (a do install.sh: letras e dígitos, sem nada que precise de escape no comando de instalação).
AGENTS_CONFIG_VARIABLE = "VERAX_AGENTS_CONFIG"
AGENTS_ENROLLMENT_VARIABLE = "VERAX_AGENTS_ENROLLMENT"
AGENT_BLOCKS = ("remote", "auth", "active-response", "vulnerability-detection")
ENROLLMENT_FORMAT = re.compile(r"^[A-Za-z0-9]{32,64}$")
# Começo de um bloco de primeiro nível do ossec.conf: dois espaços de recuo e a etiqueta, com ou sem atributos.
BLOCK_START = re.compile(r"^  <([a-z][a-z_-]*)(?: [^<>]*)?>$")
AUTHD_PASS = os.path.join("etc", "authd.pass")
SHARED_AGENT_CONF = os.path.join("etc", "shared", "default", "agent.conf")


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
        # O ExternalId nunca entra nas mensagens de erro.
        checks = (
            ("accountId", ACCOUNT_ID),
            ("externalId", EXTERNAL_ID),
            ("region", REGION),
            ("onlyLogsAfter", WAZUH_DATE),
        )
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
    return sources


def profile_name(account):
    return f"verax-{account}"


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
    for source in sources:
        account = source["accountId"]
        for field, bucket_type in BUCKET_FIELDS:
            if field not in source:
                continue
            lines += [
                f'    <bucket type="{bucket_type}">',
                f"      <name>{escape(source[field])}</name>",
                f"      <aws_profile>{profile_name(account)}</aws_profile>",
            ]
            # Lê só a pasta AWSLogs/<conta> (o bucket pode ter logs de outras contas da organização).
            if bucket_type == "cloudtrail":
                lines.append(f"      <aws_account_id>{account}</aws_account_id>")
            lines += [f"      <only_logs_after>{source['onlyLogsAfter']}</only_logs_after>", "    </bucket>"]
    lines += ["  </wodle>", "</ossec_config>", ""]
    return "\n".join(lines)


def render_aws_config(sources):
    blocks = []
    for source in sources:
        account = source["accountId"]
        blocks.append(
            "\n".join(
                [
                    f"[profile {profile_name(account)}]",
                    f"role_arn = arn:aws:iam::{account}:role/VeraxControlReadOnly",
                    f"external_id = {source['externalId']}",
                    "credential_source = Ec2InstanceMetadata",
                    "role_session_name = verax-control-wazuh",
                    "duration_seconds = 3600",
                    f"region = {source['region']}",
                    "sts_regional_endpoints = regional",
                ]
            )
        )
    return "\n\n".join(blocks) + "\n" if blocks else ""


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


def remove_agents_files(config_dir):
    """Sem os agentes, a senha e o agent.conf de uma partida anterior saem do volume da configuração."""
    for relative in (AUTHD_PASS, SHARED_AGENT_CONF):
        try:
            os.unlink(os.path.join(config_dir, relative))
        except FileNotFoundError:
            pass
    for relative in (os.path.join("etc", "shared", "default"), os.path.join("etc", "shared")):
        try:
            os.rmdir(os.path.join(config_dir, relative))
        except (FileNotFoundError, OSError):
            pass


def write_atomically(path, content, mode):
    directory = os.path.dirname(path)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    handle, temporary = tempfile.mkstemp(dir=directory)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as file:
            file.write(content)
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    except BaseException:
        os.unlink(temporary)
        raise


def copy_local_rules(rules_dir, config_dir):
    names = sorted(name for name in os.listdir(rules_dir) if RULE_FILE.match(name))
    for name in names:
        with open(os.path.join(rules_dir, name), encoding="utf-8") as file:
            content = file.read()
        # Regras não são segredo (estão no repositório), e o analysisd as lê como o usuário wazuh.
        write_atomically(os.path.join(config_dir, "etc", "rules", name), content, 0o644)
    return names


def main(base_config, config_dir, aws_dir, rules_dir=None):
    try:
        sources = validate(sys.stdin.read().strip() or "[]")
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
    ossec_conf = base.rstrip("\n") + "\n" + render_wodle(sources)
    write_atomically(os.path.join(config_dir, "etc", "ossec.conf"), ossec_conf, 0o640)
    if rules_dir:
        copy_local_rules(rules_dir, config_dir)
    if agents is None:
        remove_agents_files(config_dir)
    else:
        # O authd roda como root e lê a senha; o agent.conf é lido pelo usuário wazuh (o init da imagem copia por cima
        # do arquivo que já existe, mantendo o dono e o modo dele).
        write_atomically(os.path.join(config_dir, AUTHD_PASS), agents[2] + "\n", 0o640)
        write_atomically(os.path.join(config_dir, SHARED_AGENT_CONF), agents[1], 0o644)
    write_atomically(os.path.join(aws_dir, "config"), render_aws_config(sources), 0o600)
    # A raiz do volume nasce 0755; fechada, para só o root listar o diretório. Num diretório, o bit x é o de
    # entrar nele: 0700 (só o dono) é o mais restrito que funciona, ao contrário do que a regra supõe para arquivos.
    os.chmod(aws_dir, 0o700)  # nosemgrep: python.lang.security.audit.insecure-file-permissions.insecure-file-permissions
    with_agents = " e os agentes" if agents else ""
    print(f"Configuração do manager gerada: {len(sources)} conta(s) AWS{with_agents}.")
    return 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:5]))
