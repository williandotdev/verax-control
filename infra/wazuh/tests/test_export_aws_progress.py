"""Testes do exportador dos marcadores do módulo da AWS (scripts/export-aws-progress.py, onboarding self-service).

Só biblioteca padrão: rodam no CI (iac.yml) e localmente com `python3 -m unittest discover -s infra/wazuh/tests`. Os
bancos são criados com os mesmos `CREATE TABLE` do módulo aws-s3 do Wazuh 4.14.9 (buckets_s3/aws_bucket.py,
buckets_s3/vpcflow.py e services/cloudwatchlogs.py), e as contas são as de exemplo da documentação da AWS.
"""

import contextlib
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from unittest import mock

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "export-aws-progress.py"
spec = importlib.util.spec_from_file_location("export_aws_progress", SCRIPT)
progress = importlib.util.module_from_spec(spec)
spec.loader.exec_module(progress)

ACCOUNT_A = "111122223333"
ACCOUNT_B = "444455556666"
NOW = datetime(2026, 11, 23, 12, 0, 0, tzinfo=timezone.utc)

# As tabelas como o módulo as cria.
LOGS_TABLE = """
    CREATE TABLE {table} (
        bucket_path 'text' NOT NULL,
        aws_account_id 'text' NOT NULL,
        aws_region 'text' NOT NULL,
        log_key 'text' NOT NULL,
        processed_date 'text' NOT NULL,
        created_date 'integer' NOT NULL,
        PRIMARY KEY (bucket_path, aws_account_id, aws_region, log_key));"""
FLOW_TABLE = """
    CREATE TABLE vpcflow (
        bucket_path 'text' NOT NULL,
        aws_account_id 'text' NOT NULL,
        aws_region 'text' NOT NULL,
        flow_log_id 'text' NOT NULL,
        log_key 'text' NOT NULL,
        processed_date 'text' NOT NULL,
        created_date 'integer' NOT NULL,
        PRIMARY KEY (bucket_path, aws_account_id, aws_region, flow_log_id, log_key));"""
CUSTOM_TABLE = """
    CREATE TABLE {table} (
        bucket_path 'text' NOT NULL,
        aws_account_id 'text' NOT NULL,
        log_key 'text' NOT NULL,
        processed_date 'text' NOT NULL,
        created_date 'integer' NOT NULL,
        PRIMARY KEY (bucket_path, aws_account_id, log_key));"""
METADATA_TABLE = "CREATE TABLE metadata (key 'text' NOT NULL, value 'text' NOT NULL, PRIMARY KEY (key, value));"
CLOUDWATCH_TABLE = """
    CREATE TABLE cloudwatch_logs (
        aws_region 'text' NOT NULL,
        aws_log_group 'text' NOT NULL,
        aws_log_stream 'text' NOT NULL,
        next_token 'text',
        start_time 'integer',
        end_time 'integer',
        PRIMARY KEY (aws_region, aws_log_group, aws_log_stream));"""


# Uma linha de cada tabela, com as colunas na ordem em que o módulo as cria.
INSERTS = {
    "cloudtrail": "INSERT INTO cloudtrail VALUES (?, ?, ?, ?, ?, ?)",
    "vpcflow": "INSERT INTO vpcflow VALUES (?, ?, ?, ?, ?, ?, ?)",
    "guardduty": "INSERT INTO guardduty VALUES (?, ?, ?, ?, ?)",
    "waf": "INSERT INTO waf VALUES (?, ?, ?, ?, ?)",
}


def trail_key(account, region, stamp, suffix="a"):
    day = f"{stamp[:4]}/{stamp[4:6]}/{stamp[6:8]}"
    return f"AWSLogs/{account}/CloudTrail/{region}/{day}/{account}_CloudTrail_{region}_{stamp}_{suffix}.json.gz"


class Wodles:
    """A pasta dos bancos do módulo, num diretório temporário."""

    def __init__(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = pathlib.Path(self.dir.name)

    def cleanup(self):
        self.dir.cleanup()

    def s3(self, statements=(), rows=()):
        """Cria o s3_cloudtrail.db com as tabelas pedidas e as linhas `(tabela, valores)`."""
        connection = sqlite3.connect(self.path / "s3_cloudtrail.db")
        connection.execute(METADATA_TABLE)
        connection.execute("INSERT INTO metadata VALUES ('version', '4.14.9')")
        for statement in statements:
            connection.execute(statement)
        for table, values in rows:
            connection.execute(INSERTS[table], values)
        connection.commit()
        connection.close()

    def services(self, rows=(), table=True):
        connection = sqlite3.connect(self.path / "aws_services.db")
        connection.execute(METADATA_TABLE)
        if table:
            connection.execute(CLOUDWATCH_TABLE)
            connection.executemany("INSERT INTO cloudwatch_logs VALUES (?, ?, ?, ?, ?, ?)", rows)
        connection.commit()
        connection.close()

    def export(self):
        return progress.export(str(self.path), NOW)

    def snapshot(self):
        """O nome, o tamanho e o resumo de cada arquivo da pasta: nada pode mudar com a exportação."""
        return {
            item.name: (item.stat().st_size, hashlib.sha256(item.read_bytes()).hexdigest())
            for item in sorted(self.path.iterdir())
        }


class ExportTest(unittest.TestCase):
    def setUp(self):
        self.wodles = Wodles()
        self.addCleanup(self.wodles.cleanup)

    def all_tables(self):
        return (
            LOGS_TABLE.format(table="cloudtrail"),
            FLOW_TABLE,
            CUSTOM_TABLE.format(table="guardduty"),
            CUSTOM_TABLE.format(table="waf"),
        )

    def test_the_last_object_of_each_read_with_when_it_was_processed(self):
        older = trail_key(ACCOUNT_A, "sa-east-1", "20261123T1100Z")
        newer = trail_key(ACCOUNT_A, "sa-east-1", "20261123T1155Z")
        other = trail_key(ACCOUNT_A, "us-east-1", "20261122T2355Z")
        organization = (
            f"AWSLogs/o-exemplo1234/{ACCOUNT_B}/CloudTrail/us-east-1/2026/11/23/"
            f"{ACCOUNT_B}_CloudTrail_us-east-1_20261123T1150Z_b.json.gz"
        )
        flow = (
            f"AWSLogs/{ACCOUNT_A}/vpcflowlogs/sa-east-1/2026/11/23/"
            f"{ACCOUNT_A}_vpcflowlogs_sa-east-1_fl-0123456789abcdef0_20261123T1150Z_c.log.gz"
        )
        finding = f"AWSLogs/{ACCOUNT_A}/GuardDuty/sa-east-1/2026/11/22/achado.jsonl.gz"
        web_acl = f"AWSLogs/{ACCOUNT_A}/WAFLogs/sa-east-1/painel/2026/11/23/11/50/log.gz"
        self.wodles.s3(
            self.all_tables(),
            [
                ("cloudtrail", ("trilha/", ACCOUNT_A, "sa-east-1", older, "2026-11-23 11:05:10", 20261123)),
                ("cloudtrail", ("trilha/", ACCOUNT_A, "sa-east-1", newer, "2026-11-23 11:58:02", 20261123)),
                ("cloudtrail", ("trilha/", ACCOUNT_A, "us-east-1", other, "2026-11-23 00:03:00", 20261122)),
                ("cloudtrail", ("trilha-da-organizacao/", ACCOUNT_B, "us-east-1", organization,
                                "2026-11-23 11:57:00", 20261123)),
                ("vpcflow", ("fluxo/rede/", ACCOUNT_A, "sa-east-1", "fl-0123456789abcdef0", flow,
                             "2026-11-23 11:56:00", 20261123)),
                ("guardduty", ("achados/", ACCOUNT_A, finding, "2026-11-22 15:00:00", 20261122)),
                ("waf", (f"aws-waf-logs-painel/AWSLogs/{ACCOUNT_A}/WAFLogs/sa-east-1/painel/", ACCOUNT_A, web_acl,
                         "2026-11-23 11:55:00", 20261123)),
            ],
        )
        document = self.wodles.export()
        self.assertEqual((document["version"], document["at"]), (1, "2026-11-23T12:00:00Z"))
        self.assertEqual((document["s3"]["status"], document["s3"]["truncated"]), ("ok", False))
        self.assertEqual(
            document["s3"]["entries"],
            # As lidas mais recentemente primeiro.
            [
                {"table": "cloudtrail", "bucketPath": "trilha/", "accountId": ACCOUNT_A, "region": "sa-east-1",
                 "flowLogId": None, "lastKey": newer, "processedAt": "2026-11-23T11:58:02Z", "createdDate": 20261123,
                 "keys": 2},
                {"table": "cloudtrail", "bucketPath": "trilha-da-organizacao/", "accountId": ACCOUNT_B,
                 "region": "us-east-1", "flowLogId": None, "lastKey": organization,
                 "processedAt": "2026-11-23T11:57:00Z", "createdDate": 20261123, "keys": 1},
                {"table": "vpcflow", "bucketPath": "fluxo/rede/", "accountId": ACCOUNT_A, "region": "sa-east-1",
                 "flowLogId": "fl-0123456789abcdef0", "lastKey": flow, "processedAt": "2026-11-23T11:56:00Z",
                 "createdDate": 20261123, "keys": 1},
                {"table": "waf",
                 "bucketPath": f"aws-waf-logs-painel/AWSLogs/{ACCOUNT_A}/WAFLogs/sa-east-1/painel/",
                 "accountId": ACCOUNT_A, "region": None, "flowLogId": None, "lastKey": web_acl,
                 "processedAt": "2026-11-23T11:55:00Z", "createdDate": 20261123, "keys": 1},
                {"table": "cloudtrail", "bucketPath": "trilha/", "accountId": ACCOUNT_A, "region": "us-east-1",
                 "flowLogId": None, "lastKey": other, "processedAt": "2026-11-23T00:03:00Z", "createdDate": 20261122,
                 "keys": 1},
                {"table": "guardduty", "bucketPath": "achados/", "accountId": ACCOUNT_A, "region": None,
                 "flowLogId": None, "lastKey": finding, "processedAt": "2026-11-22T15:00:00Z",
                 "createdDate": 20261122, "keys": 1},
            ],
        )
        self.assertEqual(document["cloudwatch"], {"status": "missing", "truncated": False, "entries": []})

    def test_log_groups_with_the_latest_event_and_the_stream_count(self):
        self.wodles.services([
            ("sa-east-1", "/aws/lambda/cobranca", "2026/11/23/[1]a", "token", 1793520000000, 1793527200000),
            ("sa-east-1", "/aws/lambda/cobranca", "2026/11/23/[1]b", "token", 1793520000000, 1793530800000),
            # O módulo olhou o stream e ainda não leu evento: sem horário.
            ("sa-east-1", "/aws/rds/instance/banco/postgresql", "banco", None, None, None),
            # Uma versão antiga do módulo gravava o texto "None".
            ("us-east-1", "/aws/route53/exemplo.com.br", "consultas", None, "None", "None"),
        ])
        document = self.wodles.export()
        self.assertEqual(document["cloudwatch"]["status"], "ok")
        self.assertEqual(
            sorted(document["cloudwatch"]["entries"], key=lambda entry: (entry["region"], entry["logGroup"])),
            [
                {"region": "sa-east-1", "logGroup": "/aws/lambda/cobranca", "endTime": 1793530800000, "streams": 2},
                {"region": "sa-east-1", "logGroup": "/aws/rds/instance/banco/postgresql", "endTime": None,
                 "streams": 1},
                {"region": "us-east-1", "logGroup": "/aws/route53/exemplo.com.br", "endTime": None, "streams": 1},
            ],
        )
        self.assertEqual(document["s3"]["status"], "missing")

    def test_missing_databases_and_tables_are_empty_parts_not_errors(self):
        # Sem banco nenhum (o módulo nunca rodou): as duas partes vazias, e nenhum banco é criado.
        self.assertEqual(
            self.wodles.export(),
            {
                "version": 1,
                "at": "2026-11-23T12:00:00Z",
                "s3": {"status": "missing", "truncated": False, "entries": []},
                "cloudwatch": {"status": "missing", "truncated": False, "entries": []},
            },
        )
        self.assertEqual(list(self.wodles.path.iterdir()), [])
        # Com os bancos e sem as tabelas (só a de metadados do módulo): lidos, sem linhas.
        self.wodles.s3()
        self.wodles.services(table=False)
        document = self.wodles.export()
        self.assertEqual(document["s3"], {"status": "ok", "truncated": False, "entries": []})
        self.assertEqual(document["cloudwatch"], {"status": "ok", "truncated": False, "entries": []})

    def test_a_table_of_another_shape_is_left_out_and_the_others_are_read(self):
        self.wodles.s3(
            (
                "CREATE TABLE cloudtrail (bucket_path 'text', outra 'text');",
                CUSTOM_TABLE.format(table="guardduty"),
            ),
            [("guardduty", ("achados/", ACCOUNT_A, "AWSLogs/x/2026/11/22/a.jsonl.gz", "2026-11-22 15:00:00", 20261122))],
        )
        document = self.wodles.export()
        self.assertEqual(document["s3"]["status"], "ok")
        self.assertEqual([entry["table"] for entry in document["s3"]["entries"]], ["guardduty"])

    def test_a_database_locked_by_the_module_is_reported_and_the_other_part_is_read(self):
        self.wodles.s3(self.all_tables(),
                       [("cloudtrail", ("trilha/", ACCOUNT_A, "sa-east-1",
                                        trail_key(ACCOUNT_A, "sa-east-1", "20261123T1155Z"), "2026-11-23 11:58:02",
                                        20261123))])
        self.wodles.services([("sa-east-1", "/aws/lambda/cobranca", "a", None, 1, 1793527200000)])
        writer = sqlite3.connect(self.wodles.path / "s3_cloudtrail.db", isolation_level=None)
        self.addCleanup(writer.close)
        writer.execute("BEGIN EXCLUSIVE")
        with mock.patch.object(progress, "BUSY_TIMEOUT_SECONDS", 0.05):
            document = self.wodles.export()
        self.assertEqual(document["s3"], {"status": "locked", "truncated": False, "entries": []})
        self.assertEqual(len(document["cloudwatch"]["entries"]), 1)
        writer.execute("ROLLBACK")
        self.assertEqual(self.wodles.export()["s3"]["status"], "ok")

    def test_a_write_in_progress_does_not_block_the_read_of_what_is_committed(self):
        key = trail_key(ACCOUNT_A, "sa-east-1", "20261123T1100Z")
        self.wodles.s3(self.all_tables(),
                       [("cloudtrail", ("trilha/", ACCOUNT_A, "sa-east-1", key, "2026-11-23 11:05:10", 20261123))])
        # O módulo com uma transação aberta (ele só confirma no fim da leitura do bucket): o que já está gravado é lido.
        writer = sqlite3.connect(self.wodles.path / "s3_cloudtrail.db", isolation_level=None)
        self.addCleanup(writer.close)
        writer.execute("BEGIN")
        writer.execute(
            "INSERT INTO cloudtrail VALUES (?, ?, ?, ?, ?, ?)",
            ("trilha/", ACCOUNT_A, "sa-east-1", trail_key(ACCOUNT_A, "sa-east-1", "20261123T1155Z"),
             "2026-11-23 11:58:02", 20261123),
        )
        with mock.patch.object(progress, "BUSY_TIMEOUT_SECONDS", 0.05):
            document = self.wodles.export()
        self.assertEqual(document["s3"]["status"], "ok")
        self.assertEqual([entry["lastKey"] for entry in document["s3"]["entries"]], [key])
        writer.execute("COMMIT")

    def test_a_file_that_is_not_a_database_is_an_error_of_that_part_only(self):
        (self.wodles.path / "s3_cloudtrail.db").write_bytes(b"isto nao e um banco" * 100)
        self.wodles.services([("sa-east-1", "/aws/lambda/cobranca", "a", None, 1, 1793527200000)])
        document = self.wodles.export()
        self.assertEqual(document["s3"], {"status": "error", "truncated": False, "entries": []})
        self.assertEqual(document["cloudwatch"]["status"], "ok")

    def test_nothing_is_written_to_the_module_folder(self):
        self.wodles.s3(self.all_tables(),
                       [("cloudtrail", ("trilha/", ACCOUNT_A, "sa-east-1",
                                        trail_key(ACCOUNT_A, "sa-east-1", "20261123T1155Z"), "2026-11-23 11:58:02",
                                        20261123))])
        self.wodles.services([("sa-east-1", "/aws/lambda/cobranca", "a", None, 1, 1793527200000)])
        before = self.wodles.snapshot()
        for _ in range(3):
            self.wodles.export()
        # Os mesmos arquivos, byte a byte, e nenhum arquivo novo (nem diário, nem WAL).
        self.assertEqual(self.wodles.snapshot(), before)
        self.assertEqual(sorted(before), ["aws_services.db", "s3_cloudtrail.db"])

    def test_the_connection_is_read_only(self):
        self.wodles.s3(self.all_tables())
        connection = progress.connect(str(self.wodles.path / "s3_cloudtrail.db"))
        self.addCleanup(connection.close)
        for statement in ("DELETE FROM cloudtrail", "DROP TABLE cloudtrail", "CREATE TABLE x (y)",
                          "INSERT INTO metadata VALUES ('a', 'b')"):
            with self.subTest(statement), self.assertRaises(sqlite3.OperationalError):
                connection.execute(statement)
        # O banco que não existe não é criado.
        with self.assertRaises(sqlite3.OperationalError):
            progress.connect(str(self.wodles.path / "nao-existe.db"))
        self.assertFalse((self.wodles.path / "nao-existe.db").exists())

    def test_rows_out_of_format_are_left_out(self):
        good = trail_key(ACCOUNT_A, "sa-east-1", "20261123T1155Z")
        self.wodles.s3(
            self.all_tables(),
            [
                ("cloudtrail", ("trilha/", ACCOUNT_A, "sa-east-1", good, "2026-11-23 11:58:02", 20261123)),
                ("cloudtrail", ("trilha/", "conta-errada", "sa-east-1", good, "2026-11-23 11:58:02", 20261123)),
                ("cloudtrail", ("trilha/", ACCOUNT_B, "sa-east-1; rm -rf /", good, "2026-11-23 11:58:02", 20261123)),
                ("cloudtrail", ("trilha/", ACCOUNT_B, "us-east-1", "chave\ncom quebra", "2026-11-23 11:58:02",
                                20261123)),
                ("cloudtrail", ("trilha/", ACCOUNT_B, "us-east-2", "k" * 1025, "2026-11-23 11:58:02", 20261123)),
                ("cloudtrail", ("trilha/", ACCOUNT_B, "eu-west-1", good, "ontem", 20261123)),
                ("vpcflow", ("fluxo/", ACCOUNT_A, "sa-east-1", "nao-e-um-flow-log", good, "2026-11-23 11:58:02",
                             20261123)),
                ("guardduty", ("b" * 1201, ACCOUNT_A, good, "2026-11-23 11:58:02", 20261123)),
            ],
        )
        self.wodles.services([
            ("sa-east-1", "/aws/lambda/cobranca", "a", None, 1, 1793527200000),
            ("regiao errada", "/aws/lambda/outra", "a", None, 1, 1793527200000),
            ("sa-east-1", "g" * 513, "a", None, 1, 1793527200000),
            ("us-east-1", "/aws/lambda/negativo", "a", None, 1, -5),
        ])
        document = self.wodles.export()
        self.assertEqual([(entry["accountId"], entry["region"]) for entry in document["s3"]["entries"]],
                         [(ACCOUNT_A, "sa-east-1")])
        self.assertEqual(
            sorted((entry["logGroup"], entry["endTime"]) for entry in document["cloudwatch"]["entries"]),
            [("/aws/lambda/cobranca", 1793527200000), ("/aws/lambda/negativo", None)],
        )

    def test_the_output_is_capped_and_says_when_it_was_cut(self):
        rows = [
            ("cloudtrail", (f"trilha-{index:02d}/", ACCOUNT_A, "sa-east-1",
                            trail_key(ACCOUNT_A, "sa-east-1", "20261123T1155Z"),
                            f"2026-11-23 11:{index:02d}:00", 20261123))
            for index in range(12)
        ]
        self.wodles.s3(self.all_tables(), rows)
        self.wodles.services([("sa-east-1", f"/aws/lambda/funcao-{index:02d}", "a", None, 1, 1793527200000 + index)
                              for index in range(12)])
        with mock.patch.object(progress, "MAX_ENTRIES", 5):
            document = self.wodles.export()
        self.assertEqual((len(document["s3"]["entries"]), document["s3"]["truncated"]), (5, True))
        # Ficam as lidas mais recentemente.
        self.assertEqual([entry["bucketPath"] for entry in document["s3"]["entries"]],
                         [f"trilha-{index:02d}/" for index in (11, 10, 9, 8, 7)])
        self.assertEqual((len(document["cloudwatch"]["entries"]), document["cloudwatch"]["truncated"]), (5, True))
        self.assertEqual(document["cloudwatch"]["entries"][0]["logGroup"], "/aws/lambda/funcao-11")

    def test_main_prints_one_ascii_line_and_only_the_summary_to_stderr(self):
        self.wodles.s3(self.all_tables(),
                       [("guardduty", ("achados/", ACCOUNT_A, "AWSLogs/x/2026/11/22/achado-ção.jsonl.gz",
                                       "2026-11-22 15:00:00", 20261122))])
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = progress.main([str(self.wodles.path)])
        self.assertEqual(code, 0)
        output = stdout.getvalue()
        self.assertTrue(output.startswith('{"version":1,"at":"'))
        self.assertEqual(output.count("\n"), 1)
        self.assertTrue(output.isascii())
        document = json.loads(output)
        self.assertEqual(document["s3"]["entries"][0]["lastKey"], "AWSLogs/x/2026/11/22/achado-ção.jsonl.gz")
        self.assertIn("s3 ok (1), cloudwatch missing (0)", stderr.getvalue())
        self.assertNotIn("achado", stderr.getvalue())

    def test_main_refuses_extra_arguments_without_printing_a_document(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = progress.main([str(self.wodles.path), "outra"])
        self.assertEqual((code, stdout.getvalue()), (2, ""))

    @unittest.skipIf(os.name == "nt", "permissões POSIX")
    def test_a_database_the_reader_cannot_open_is_an_error_not_a_crash(self):
        self.wodles.s3(self.all_tables())
        path = self.wodles.path / "s3_cloudtrail.db"
        path.chmod(0o000)
        self.addCleanup(path.chmod, 0o600)
        if os.access(path, os.R_OK):
            self.skipTest("o usuário do teste lê qualquer arquivo (root)")
        self.assertEqual(self.wodles.export()["s3"]["status"], "error")


if __name__ == "__main__":
    unittest.main()
