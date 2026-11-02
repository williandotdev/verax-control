"""Testes do diagnóstico somente leitura: nenhuma chamada de escrita sai, falhas viram registro, e os avisos
apontam o que não pode ser alterado no ambiente do cliente. Rodam sem boto3 (clientes falsos)."""

import importlib.util
import pathlib
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "diagnostico_aws.py"
spec = importlib.util.spec_from_file_location("diagnostico_aws", SCRIPT)
diag = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diag)


class AwsError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class FakeClient:
    """Responde a operações conhecidas; uma resposta pode ser lista (páginas) ou exceção."""

    def __init__(self, responses):
        self._responses = {name: list(value) if isinstance(value, list) else [value] for name, value in responses.items()}

    def __getattr__(self, operation):
        if operation not in self._responses:
            raise AttributeError(operation)

        def call(**_kwargs):
            pages = self._responses[operation]
            value = pages.pop(0) if len(pages) > 1 else pages[0]
            if isinstance(value, Exception):
                raise value
            return value

        return call


ACL = "arn:aws:wafv2:us-east-1:111122223333:regional/webacl/api/abc"

RESPONSES = {
    "sts": {"get_caller_identity": {"Account": "111122223333", "Arn": "arn:aws:iam::111122223333:user/leitor"}},
    "organizations": {"describe_organization": AwsError("AWSOrganizationsNotInUseException")},
    "ec2": {
        "describe_regions": {"Regions": [{"RegionName": "us-east-1"}]},
        "describe_flow_logs": {
            "FlowLogs": [
                {"ResourceId": "vpc-1", "TrafficType": "ALL", "LogDestinationType": "cloud-watch-logs", "LogGroupName": "fluxo"}
            ]
        },
    },
    "cloudtrail": {
        "describe_trails": {
            "trailList": [
                {
                    "Name": "principal",
                    "TrailARN": "arn:aws:cloudtrail:us-east-1:111122223333:trail/principal",
                    "HomeRegion": "us-east-1",
                    "S3BucketName": "trilha-logs",
                    "CloudWatchLogsLogGroupArn": "arn:aws:logs:us-east-1:111122223333:log-group:trilha",
                }
            ]
        },
        "get_trail_status": {"IsLogging": True},
    },
    "s3": {
        "get_bucket_location": {"LocationConstraint": None},
        "get_bucket_encryption": {
            "ServerSideEncryptionConfiguration": {
                "Rules": [{"ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "aws:kms", "KMSMasterKeyID": "k"}}]
            }
        },
    },
    "guardduty": {
        "list_detectors": {"DetectorIds": ["d1"]},
        "get_detector": {"Status": "ENABLED"},
        "list_publishing_destinations": {"Destinations": [{"DestinationId": "x", "DestinationType": "S3", "Status": "PUBLISHING"}]},
    },
    "securityhub": {"describe_hub": {"HubArn": "hub"}},
    "inspector2": {"batch_get_account_status": AwsError("AccessDeniedException")},
    "accessanalyzer": {"list_analyzers": {"analyzers": [{"name": "conta", "type": "ACCOUNT"}]}},
    "wafv2": {
        "list_web_acls": {"WebACLs": [{"Name": "api", "ARN": ACL}]},
        "get_logging_configuration": {"LoggingConfiguration": {"LogDestinationConfigs": ["arn:aws:logs:...:aws-waf-logs-api"]}},
    },
    "logs": {
        # Duas páginas: a paginação manual precisa juntar as duas.
        "describe_log_groups": [
            {"logGroups": [{"logGroupName": "trilha", "storedBytes": 2 * 1024**3}], "nextToken": "p2"},
            {"logGroups": [{"logGroupName": "aplicacao", "retentionInDays": 30}]},
        ],
        "describe_subscription_filters": {"subscriptionFilters": [{}, {}]},
    },
    "service-quotas": {
        "list_service_quotas": {
            "Quotas": [
                {"QuotaName": "GetLogEvents throttle limit in transactions per second", "Value": 25.0},
                {"QuotaName": "PutLogEvents throttle limit", "Value": 5000.0},
            ]
        }
    },
}


class NoWait(diag.Pacer):
    def __init__(self):
        super().__init__(interval=0, clock=lambda: 0.0, sleep=lambda _seconds: None)


def run_report(regions=("us-east-1",), overrides=None):
    clients = {}
    overrides = overrides or {}

    def factory(service, region):
        responses = overrides.get((service, region), RESPONSES[service])
        clients.setdefault((service, region), FakeClient(responses))
        return clients[(service, region)]

    diagnostico = diag.Diagnostico(factory, NoWait())
    return diagnostico, diagnostico.run("us-east-1", list(regions), log_details=True)


class ReadOnlyTest(unittest.TestCase):
    def test_todas_as_chamadas_sao_de_leitura(self):
        diagnostico, _report = run_report()
        self.assertGreater(len(diagnostico.calls), 10)
        for call in diagnostico.calls:
            operation = call.split(".", 1)[1]
            self.assertTrue(operation.startswith(diag.READ_ONLY_PREFIXES), call)

    def test_escrita_e_recusada_antes_de_chegar_a_aws(self):
        sent = []

        class Recorder:
            def __getattr__(self, name):
                sent.append(name)
                return lambda **_kwargs: None

        client = diag.ReadOnlyClient(Recorder(), "logs", NoWait(), [])
        for operation in ("delete_log_stream", "put_logging_configuration", "put_subscription_filter", "get_paginator"):
            with self.assertRaises(diag.ReadOnlyViolation):
                getattr(client, operation)
        self.assertEqual(sent, [])

    def test_intervalo_minimo_entre_chamadas(self):
        now = [0.0]
        slept = []
        pacer = diag.Pacer(interval=0.25, clock=lambda: now[0], sleep=lambda seconds: (slept.append(seconds), now.__setitem__(0, now[0] + seconds)))
        pacer.wait()
        now[0] += 0.1
        pacer.wait()
        self.assertEqual(len(slept), 1)
        self.assertAlmostEqual(slept[0], 0.15)


class ReportTest(unittest.TestCase):
    def setUp(self):
        _diagnostico, self.report = run_report()
        self.region = self.report["regioes"]["us-east-1"]

    def test_paginacao_junta_as_paginas(self):
        self.assertEqual([group["nome"] for group in self.region["log_groups"]], ["trilha", "aplicacao"])

    def test_falha_vira_registro_sem_interromper(self):
        self.assertEqual(self.region["inspector"], {"erro": "AccessDeniedException"})
        self.assertEqual(self.report["organizacao"], {"em_organizacao": False})

    def test_le_configuracao_sem_ler_conteudo_de_log(self):
        self.assertEqual(self.report["cloudtrail"][0]["bucket"], "trilha-logs")
        self.assertEqual(self.report["buckets_de_log"]["trilha-logs"]["cifragem"], "aws:kms")
        self.assertEqual(self.region["vpc_flow_logs"][0]["destino"], "fluxo")
        self.assertEqual(self.region["limites_cloudwatch_logs"], {"GetLogEvents throttle limit in transactions per second": 25.0})
        self.assertNotIn("get_log_events", " ".join(_diagnostico_calls()))

    def test_avisos_do_que_nao_pode_ser_alterado(self):
        notes = "\n".join(diag.warnings(self.report))
        self.assertIn("WAF api: já envia log", notes)
        self.assertIn("GuardDuty (us-east-1): já exporta", notes)
        self.assertIn("2 subscription filters", notes)

    def test_trilha_de_regiao_unica_fora_da_principal_aparece(self):
        regional = {
            "describe_trails": {
                "trailList": [
                    {"Name": "so-sp", "TrailARN": "arn:aws:cloudtrail:sa-east-1:111122223333:trail/so-sp", "HomeRegion": "sa-east-1"},
                    # A multirregional aparece em todas as regiões e deve contar uma vez.
                    RESPONSES["cloudtrail"]["describe_trails"]["trailList"][0],
                ]
            },
            "get_trail_status": {"IsLogging": True},
        }
        _diagnostico, report = run_report(("us-east-1", "sa-east-1"), {("cloudtrail", "sa-east-1"): regional})
        self.assertEqual(sorted(trail["nome"] for trail in report["cloudtrail"]), ["principal", "so-sp"])

    def test_paginacao_alem_do_teto_vira_erro_explicito(self):
        endless = {"describe_log_groups": {"logGroups": [{"logGroupName": "g"}], "nextToken": "mais"}}
        original = diag.MAX_PAGES
        diag.MAX_PAGES = 3
        try:
            _diagnostico, report = run_report(overrides={("logs", "us-east-1"): endless})
        finally:
            diag.MAX_PAGES = original
        self.assertEqual(report["regioes"]["us-east-1"]["log_groups"], {"erro": "PaginacaoIncompleta"})

    def test_resumo(self):
        text = diag.summary(self.report)
        self.assertIn("Conta 111122223333", text)
        self.assertIn("us-east-1: 2 log group(s), 2.0 GB", text)


def _diagnostico_calls():
    diagnostico, _report = run_report()
    return diagnostico.calls


if __name__ == "__main__":
    unittest.main()
