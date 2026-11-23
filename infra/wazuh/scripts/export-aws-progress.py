"""Exporta até onde o módulo aws-s3 do Wazuh já leu cada fonte da AWS (onboarding self-service).

Só leitura. Roda dentro do contêiner do manager, com o Python do próprio Wazuh, chamado pelo host a cada 5 min
(infra/node/bin/wazuh-progress.sh, pelo verax-wazuh-progress.timer): o programa chega pela entrada padrão
(`python3 -I - <pasta>`), e a saída padrão é um documento JSON de uma linha, que o host grava, de uma vez, no sinal
`progress` da pasta que o worker lê (/run/verax/wazuh-signal). O worker confere cada campo de novo
(apps/api/src/aws/wazuh-progress.ts) e, com ele, mostra no painel o estado de cada fonte: é a prova de que o Wazuh leu.

O que é lido: os bancos SQLite em que o próprio módulo guarda os marcadores, na pasta dele
(/var/ossec/wodles/aws, o volume manager-wodles):

- s3_cloudtrail.db: uma tabela por tipo de bucket (`cloudtrail`, `vpcflow`, `guardduty` e `waf`), uma linha por objeto
  lido. Daqui sai, por tabela, `bucket_path`, conta e região (os flow logs, também o ID do flow log; o GuardDuty e o WAF
  não guardam a região): o último objeto lido (a maior chave, que é a que o módulo usa como marcador), quando o módulo
  leu pela última vez, o dia do objeto mais recente e quantas linhas há;
- aws_services.db: a tabela `cloudwatch_logs`, uma linha por região, grupo e stream. Daqui sai, por região e grupo, o
  horário do evento mais recente lido (`end_time`, em milissegundos) e quantos streams o módulo já olhou.

Garantias:

- cada banco é aberto só para leitura (`file:...?mode=ro` e `PRAGMA query_only`): este programa não cria, não altera e
  não trava banco nenhum, e o módulo segue gravando neles sem saber dele;
- o banco que ainda não existe (`missing`), que o módulo está gravando (`locked`) ou que não abre (`error`) não é um
  erro: a parte dele sai vazia, com o motivo, e a outra sai inteira. A tabela que ainda não existe é só uma tabela sem
  linhas. O worker então não muda o estado de nenhuma fonte por falta de informação;
- a saída é limitada: no máximo MAX_ENTRIES grupos por parte, os lidos mais recentemente primeiro (com
  `truncated: true` quando corta), e um nome maior que o da AWS fica de fora. Só nomes de bucket, de objeto e de grupo
  de logs e horários: nenhum conteúdo de log, nenhuma credencial, nada do token do Google (a pasta dele nem é lida).

Uso: `export-aws-progress.py [<pasta dos bancos>]` (o padrão é /var/ossec/wodles/aws). Sai com 0 e o documento na
saída padrão; com outro código, nada foi impresso.
"""

import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone
from urllib.parse import quote

VERSION = 1
DEFAULT_DIR = "/var/ossec/wodles/aws"
S3_DATABASE = "s3_cloudtrail.db"
SERVICES_DATABASE = "aws_services.db"
# As tabelas do módulo que a Verax usa, as colunas que identificam uma leitura em cada uma (além de `bucket_path` e da
# conta) e a consulta de cada uma, escrita inteira: nenhum texto de fora (nem montado aqui) entra numa consulta. O único
# parâmetro é o teto de linhas.
S3_TABLES = (
    (
        "cloudtrail",
        ("aws_region",),
        "SELECT bucket_path, aws_account_id, aws_region, "
        "MAX(log_key), MAX(processed_date), MAX(created_date), COUNT(*) "
        "FROM cloudtrail GROUP BY bucket_path, aws_account_id, aws_region "
        "ORDER BY MAX(processed_date) DESC LIMIT ?",
    ),
    (
        "vpcflow",
        ("aws_region", "flow_log_id"),
        "SELECT bucket_path, aws_account_id, aws_region, flow_log_id, "
        "MAX(log_key), MAX(processed_date), MAX(created_date), COUNT(*) "
        "FROM vpcflow GROUP BY bucket_path, aws_account_id, aws_region, flow_log_id "
        "ORDER BY MAX(processed_date) DESC LIMIT ?",
    ),
    (
        "guardduty",
        (),
        "SELECT bucket_path, aws_account_id, "
        "MAX(log_key), MAX(processed_date), MAX(created_date), COUNT(*) "
        "FROM guardduty GROUP BY bucket_path, aws_account_id "
        "ORDER BY MAX(processed_date) DESC LIMIT ?",
    ),
    (
        "waf",
        (),
        "SELECT bucket_path, aws_account_id, "
        "MAX(log_key), MAX(processed_date), MAX(created_date), COUNT(*) "
        "FROM waf GROUP BY bucket_path, aws_account_id "
        "ORDER BY MAX(processed_date) DESC LIMIT ?",
    ),
)
LOG_GROUPS_TABLE = "cloudwatch_logs"
# O `end_time` que não é número (o módulo grava o texto "None" numa versão antiga) não conta.
LOG_GROUPS_QUERY = (
    "SELECT aws_region, aws_log_group, "
    "MAX(CASE WHEN typeof(end_time) = 'integer' THEN end_time END), COUNT(*) "
    "FROM cloudwatch_logs GROUP BY aws_region, aws_log_group "
    "ORDER BY 3 DESC LIMIT ?"
)
# O teto de linhas de cada parte (WAZUH_PROGRESS_MAX_ENTRIES no worker) e o tempo que a leitura espera um banco travado.
MAX_ENTRIES = 5000
BUSY_TIMEOUT_SECONDS = 2

ACCOUNT_ID = re.compile(r"[0-9]{12}")
REGION = re.compile(r"[a-z]{2}(-[a-z]{1,16}){1,3}-[0-9]")
FLOW_LOG_ID = re.compile(r"fl-[0-9a-f]{8,32}")
# `DATETIME('now')` do SQLite, em UTC.
PROCESSED = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}")
# Os limites da própria AWS: a chave de um objeto e o nome de um grupo de logs.
MAX_KEY = 1024
MAX_BUCKET_PATH = 1200
MAX_LOG_GROUP = 512
MAX_END_TIME = 8_640_000_000_000_000


def text(value, limit, pattern=None):
    """O valor como texto curto e sem caractere de controle (e no formato, se houver um); None fora disso."""
    if not isinstance(value, str) or not 0 < len(value) <= limit:
        return None
    if any(ord(char) < 0x20 or 0x7F <= ord(char) <= 0x9F for char in value):
        return None
    if pattern is not None and pattern.fullmatch(value) is None:
        return None
    return value


def connect(path):
    """O banco só para leitura. O que não existe não é criado: `mode=ro` falha, e a parte sai como `missing`."""
    connection = sqlite3.connect(f"file:{quote(path)}?mode=ro", uri=True, timeout=BUSY_TIMEOUT_SECONDS)
    connection.execute("PRAGMA query_only = ON")
    return connection


def is_locked(error):
    message = str(error).lower()
    return "locked" in message or "busy" in message


def read_database(path, read):
    """O que `read` tirou do banco, com o estado da leitura: (status, linhas, cortada)."""
    if not os.path.isfile(path):
        return "missing", [], False
    try:
        connection = connect(path)
    except sqlite3.Error as error:
        return ("locked" if is_locked(error) else "error"), [], False
    try:
        entries, truncated = read(connection)
        return "ok", entries, truncated
    except sqlite3.OperationalError as error:
        return ("locked" if is_locked(error) else "error"), [], False
    except sqlite3.Error:
        return "error", [], False
    finally:
        connection.close()


def table_exists(connection, name):
    row = connection.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)).fetchone()
    return row is not None


def s3_entry(table, extra, row):
    """Uma leitura do S3 conferida campo a campo; None para a linha que não serve."""
    bucket_path, account, *rest = row
    values = dict(zip(extra, rest[: len(extra)]))
    last_key, processed, created, keys = rest[len(extra) :]
    entry = {
        "table": table,
        "bucketPath": text(bucket_path, MAX_BUCKET_PATH),
        "accountId": text(account, 12, ACCOUNT_ID),
        "region": None,
        "flowLogId": None,
        "lastKey": text(last_key, MAX_KEY),
        "processedAt": None,
        "createdDate": created if isinstance(created, int) and 19_700_101 <= created <= 99_991_231 else None,
        "keys": keys if isinstance(keys, int) and keys >= 0 else 0,
    }
    if "aws_region" in extra:
        entry["region"] = text(values["aws_region"], 32, REGION)
        if entry["region"] is None:
            return None
    if "flow_log_id" in extra:
        entry["flowLogId"] = text(values["flow_log_id"], 64, FLOW_LOG_ID)
        if entry["flowLogId"] is None:
            return None
    processed = text(processed, 19, PROCESSED)
    if processed is not None:
        entry["processedAt"] = processed.replace(" ", "T") + "Z"
    if None in (entry["bucketPath"], entry["accountId"], entry["lastKey"], entry["processedAt"]):
        return None
    return entry


def read_s3(connection):
    """As leituras de cada tabela, as mais recentes primeiro; no máximo MAX_ENTRIES ao todo."""
    entries = []
    for table, extra, query in S3_TABLES:
        if not table_exists(connection, table):
            continue
        try:
            rows = connection.execute(query, (MAX_ENTRIES + 1,)).fetchall()
        except sqlite3.OperationalError as error:
            if is_locked(error):
                raise
            # Uma tabela com outras colunas (outra versão do módulo): fica de fora, e as outras entram.
            continue
        for row in rows:
            entry = s3_entry(table, extra, row)
            if entry is not None:
                entries.append(entry)
    entries.sort(key=lambda entry: entry["processedAt"], reverse=True)
    return entries[:MAX_ENTRIES], len(entries) > MAX_ENTRIES


def read_log_groups(connection):
    """Por região e grupo: o evento mais recente lido e os streams que o módulo já olhou."""
    if not table_exists(connection, LOG_GROUPS_TABLE):
        return [], False
    entries = []
    for region, group, end_time, streams in connection.execute(LOG_GROUPS_QUERY, (MAX_ENTRIES + 1,)).fetchall():
        entry = {
            "region": text(region, 32, REGION),
            "logGroup": text(group, MAX_LOG_GROUP),
            "endTime": end_time if isinstance(end_time, int) and 0 <= end_time <= MAX_END_TIME else None,
            "streams": streams if isinstance(streams, int) and streams >= 0 else 0,
        }
        if entry["region"] is not None and entry["logGroup"] is not None:
            entries.append(entry)
    return entries[:MAX_ENTRIES], len(entries) > MAX_ENTRIES


def export(directory, now=None):
    """O documento do sinal `progress`: as duas partes, cada uma com o estado da leitura do banco dela."""
    moment = now or datetime.now(timezone.utc)
    document = {"version": VERSION, "at": moment.strftime("%Y-%m-%dT%H:%M:%SZ")}
    parts = (("s3", S3_DATABASE, read_s3), ("cloudwatch", SERVICES_DATABASE, read_log_groups))
    for name, database, read in parts:
        status, entries, truncated = read_database(os.path.join(directory, database), read)
        document[name] = {"status": status, "truncated": truncated, "entries": entries}
    return document


def main(arguments):
    if len(arguments) > 1:
        print("uso: export-aws-progress.py [<pasta dos bancos do módulo>]", file=sys.stderr)
        return 2
    directory = arguments[0] if arguments else DEFAULT_DIR
    document = export(directory)
    # Uma linha só, só ASCII: o host confere o começo e o tamanho antes de trocar o arquivo.
    sys.stdout.write(json.dumps(document, separators=(",", ":"), ensure_ascii=True) + "\n")
    summary = ", ".join(
        f"{name} {document[name]['status']} ({len(document[name]['entries'])})" for name in ("s3", "cloudwatch")
    )
    print(f"Marcadores do módulo da AWS exportados: {summary}.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
