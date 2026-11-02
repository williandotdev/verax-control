#!/usr/bin/env python3
"""Diagnóstico somente leitura de uma conta AWS para o Verax Control.

Mostra de onde vêm os logs de segurança da conta e como eles estão configurados, sem alterar nada:
CloudTrail, GuardDuty, Security Hub, Inspector, IAM Access Analyzer, WAF, VPC Flow Logs, grupos do CloudWatch
Logs (com os limites de leitura da conta) e se a conta faz parte de uma organização.

Garantias:
- só chamadas de leitura (`get_`, `list_`, `describe_`, `batch_get_`): qualquer outra é recusada antes de sair
  daqui (`ReadOnlyClient`);
- no máximo 4 chamadas por segundo, para não disputar os limites da conta com outras ferramentas que já leem os
  logs;
- nenhum conteúdo de log é lido: só nomes, tamanhos e configurações.

Uso (no AWS CloudShell da conta, que já tem Python e boto3):
    python3 diagnostico_aws.py --regioes us-east-1
O resultado vai para um arquivo JSON. Ele traz o número da conta e nomes de recursos: compartilhe só por canal
privado.
"""

from __future__ import annotations

import argparse
import datetime
import json
import sys
import time
from typing import Any, Callable, Dict, List, Optional

READ_ONLY_PREFIXES = ("get_", "list_", "describe_", "batch_get_")
MIN_INTERVAL_SECONDS = 0.25
MAX_PAGES = 100


class ReadOnlyViolation(Exception):
    """Tentativa de chamada que não é de leitura."""


class Pacer:
    """Garante um intervalo mínimo entre chamadas à AWS."""

    def __init__(self, interval: float = MIN_INTERVAL_SECONDS, clock=time.monotonic, sleep=time.sleep):
        self._interval = interval
        self._clock = clock
        self._sleep = sleep
        self._last: Optional[float] = None

    def wait(self) -> None:
        now = self._clock()
        if self._last is not None and now - self._last < self._interval:
            self._sleep(self._interval - (now - self._last))
            now = self._clock()
        self._last = now


class ReadOnlyClient:
    """Envolve um cliente da AWS e só deixa passar chamadas de leitura, uma de cada vez."""

    def __init__(self, client: Any, name: str, pacer: Pacer, calls: List[str]):
        self._client = client
        self._name = name
        self._pacer = pacer
        self._calls = calls

    def __getattr__(self, operation: str) -> Callable[..., Any]:
        # Paginadores do boto3 chamariam a API sem passar por aqui; a paginação é feita à mão (`paginate`).
        if operation == "get_paginator" or not operation.startswith(READ_ONLY_PREFIXES):
            raise ReadOnlyViolation(f"{self._name}.{operation} não é uma chamada de leitura")
        method = getattr(self._client, operation)

        def call(**kwargs: Any) -> Any:
            self._pacer.wait()
            self._calls.append(f"{self._name}.{operation}")
            return method(**kwargs)

        return call


def error_code(error: Exception) -> Optional[str]:
    response = getattr(error, "response", None)
    if isinstance(response, dict):
        code = response.get("Error", {}).get("Code")
        return str(code) if code else None
    return None


def safely(action: Callable[[], Any]) -> Any:
    """Executa uma leitura; sem permissão ou serviço desligado viram registro, não interrupção."""
    try:
        return action()
    except ReadOnlyViolation:
        raise
    except Exception as error:  # noqa: BLE001 - cada falha da AWS vira um registro no diagnóstico
        return {"erro": error_code(error) or type(error).__name__}


def paginate(call: Callable[..., Dict[str, Any]], items: str, token_in: str, token_out: str, **kwargs: Any) -> List[Any]:
    results: List[Any] = []
    token = None
    for _ in range(MAX_PAGES):
        page = call(**kwargs, **({token_in: token} if token else {}))
        results.extend(page.get(items, []))
        token = page.get(token_out)
        if not token:
            break
    return results


class Diagnostico:
    def __init__(self, client_factory: Callable[[str, Optional[str]], Any], pacer: Optional[Pacer] = None):
        self._factory = client_factory
        self._pacer = pacer or Pacer()
        self.calls: List[str] = []

    def client(self, service: str, region: Optional[str] = None) -> ReadOnlyClient:
        return ReadOnlyClient(self._factory(service, region), service, self._pacer, self.calls)

    # --- Conta ---

    def identity(self) -> Dict[str, Any]:
        found = self.client("sts").get_caller_identity()
        return {"conta": found.get("Account"), "quem_executou": found.get("Arn")}

    def organization(self) -> Dict[str, Any]:
        result = safely(lambda: self.client("organizations").describe_organization())
        if isinstance(result, dict) and "erro" in result:
            if result["erro"] == "AWSOrganizationsNotInUseException":
                return {"em_organizacao": False}
            return result
        org = result.get("Organization", {})
        return {"em_organizacao": True, "conta_de_gestao": org.get("MasterAccountId")}

    def enabled_regions(self, home: str) -> List[str]:
        found = self.client("ec2", home).describe_regions(AllRegions=False)
        return sorted(region["RegionName"] for region in found.get("Regions", []))

    # --- Fontes globais ---

    def cloudtrail(self, home: str) -> Any:
        def read() -> List[Dict[str, Any]]:
            trails = self.client("cloudtrail", home).describe_trails(includeShadowTrails=True).get("trailList", [])
            result = []
            for trail in trails:
                status = safely(
                    lambda trail=trail: self.client("cloudtrail", trail.get("HomeRegion")).get_trail_status(
                        Name=trail["TrailARN"]
                    )
                )
                result.append(
                    {
                        "nome": trail.get("Name"),
                        "regiao_principal": trail.get("HomeRegion"),
                        "multirregiao": trail.get("IsMultiRegionTrail"),
                        "da_organizacao": trail.get("IsOrganizationTrail"),
                        "bucket": trail.get("S3BucketName"),
                        "prefixo": trail.get("S3KeyPrefix"),
                        "log_group": trail.get("CloudWatchLogsLogGroupArn"),
                        "chave_kms": trail.get("KmsKeyId"),
                        "gravando": status.get("IsLogging") if isinstance(status, dict) else None,
                    }
                )
            return result

        return safely(read)

    def bucket(self, name: str) -> Dict[str, Any]:
        s3 = self.client("s3")
        location = safely(lambda: s3.get_bucket_location(Bucket=name))
        encryption = safely(lambda: s3.get_bucket_encryption(Bucket=name))
        rules = encryption.get("ServerSideEncryptionConfiguration", {}).get("Rules", []) if "erro" not in encryption else []
        default = rules[0].get("ApplyServerSideEncryptionByDefault", {}) if rules else {}
        return {
            "regiao": (location.get("LocationConstraint") or "us-east-1") if "erro" not in location else location,
            "cifragem": default.get("SSEAlgorithm") or encryption.get("erro"),
            "chave_kms": default.get("KMSMasterKeyID"),
        }

    # --- Fontes por região ---

    def guardduty(self, region: str) -> Any:
        def read() -> List[Dict[str, Any]]:
            client = self.client("guardduty", region)
            detectors = []
            for detector_id in client.list_detectors().get("DetectorIds", []):
                detector = safely(lambda: client.get_detector(DetectorId=detector_id))
                destinations = safely(lambda: client.list_publishing_destinations(DetectorId=detector_id))
                detectors.append(
                    {
                        "status": detector.get("Status") if isinstance(detector, dict) else None,
                        "exporta_para": [
                            {"tipo": item.get("DestinationType"), "status": item.get("Status")}
                            for item in destinations.get("Destinations", [])
                        ]
                        if "erro" not in destinations
                        else destinations,
                        "destino_ids": [item.get("DestinationId") for item in destinations.get("Destinations", [])],
                        "detector": detector_id,
                    }
                )
            return detectors

        return safely(read)

    def securityhub(self, region: str) -> Any:
        found = safely(lambda: self.client("securityhub", region).describe_hub())
        if isinstance(found, dict) and "erro" in found:
            return {"ativo": False} if found["erro"] == "InvalidAccessException" else found
        return {"ativo": True}

    def inspector(self, region: str) -> Any:
        found = safely(lambda: self.client("inspector2", region).batch_get_account_status())
        if isinstance(found, dict) and "erro" in found:
            return found
        accounts = found.get("accounts", [])
        return {"status": accounts[0].get("state", {}).get("status") if accounts else None}

    def access_analyzer(self, region: str) -> Any:
        found = safely(lambda: self.client("accessanalyzer", region).list_analyzers())
        if isinstance(found, dict) and "erro" in found:
            return found
        return [{"nome": item.get("name"), "tipo": item.get("type")} for item in found.get("analyzers", [])]

    def waf(self, region: str, scope: str) -> Any:
        def read() -> List[Dict[str, Any]]:
            client = self.client("wafv2", region)
            acls = paginate(client.list_web_acls, "WebACLs", "NextMarker", "NextMarker", Scope=scope)
            result = []
            for acl in acls:
                logging = safely(lambda acl=acl: client.get_logging_configuration(ResourceArn=acl["ARN"]))
                if isinstance(logging, dict) and logging.get("erro") == "WAFNonexistentItemException":
                    destinations: Any = []
                elif isinstance(logging, dict) and "erro" in logging:
                    destinations = logging
                else:
                    destinations = logging.get("LoggingConfiguration", {}).get("LogDestinationConfigs", [])
                result.append({"nome": acl.get("Name"), "escopo": scope, "logs_vao_para": destinations})
            return result

        return safely(read)

    def flow_logs(self, region: str) -> Any:
        def read() -> List[Dict[str, Any]]:
            items = paginate(self.client("ec2", region).describe_flow_logs, "FlowLogs", "NextToken", "NextToken")
            return [
                {
                    "recurso": item.get("ResourceId"),
                    "trafego": item.get("TrafficType"),
                    "destino_tipo": item.get("LogDestinationType"),
                    "destino": item.get("LogGroupName") or item.get("LogDestination"),
                }
                for item in items
            ]

        return safely(read)

    def log_groups(self, region: str, details: bool) -> Any:
        def read() -> List[Dict[str, Any]]:
            client = self.client("logs", region)
            groups = paginate(client.describe_log_groups, "logGroups", "nextToken", "nextToken")
            result = []
            for group in groups:
                item = {
                    "nome": group.get("logGroupName"),
                    "retencao_dias": group.get("retentionInDays"),
                    "bytes_armazenados": group.get("storedBytes"),
                    "chave_kms": group.get("kmsKeyId"),
                }
                if details:
                    # A AWS permite até 2 subscription filters por grupo: saber quantos já existem importa antes de
                    # qualquer proposta de coleta por assinatura.
                    filters = safely(
                        lambda group=group: client.describe_subscription_filters(logGroupName=group["logGroupName"])
                    )
                    item["subscription_filters"] = (
                        len(filters.get("subscriptionFilters", [])) if "erro" not in filters else filters
                    )
                result.append(item)
            return result

        return safely(read)

    def log_quotas(self, region: str) -> Any:
        def read() -> Dict[str, Any]:
            client = self.client("service-quotas", region)
            quotas = paginate(client.list_service_quotas, "Quotas", "NextToken", "NextToken", ServiceCode="logs")
            wanted = ("GetLogEvents", "DescribeLogStreams", "FilterLogEvents", "DescribeLogGroups")
            return {
                quota.get("QuotaName"): quota.get("Value")
                for quota in quotas
                if any(name in (quota.get("QuotaName") or "") for name in wanted)
            }

        return safely(read)

    # --- Tudo ---

    def run(self, home: str, regions: Optional[List[str]], log_details: bool) -> Dict[str, Any]:
        selected = regions or self.enabled_regions(home)
        trails = self.cloudtrail(home)
        result: Dict[str, Any] = {
            "gerado_em": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            "conta": self.identity(),
            "organizacao": self.organization(),
            "cloudtrail": trails,
            "waf_cloudfront": self.waf("us-east-1", "CLOUDFRONT"),
            "regioes": {},
        }
        for region in selected:
            result["regioes"][region] = {
                "guardduty": self.guardduty(region),
                "security_hub": self.securityhub(region),
                "inspector": self.inspector(region),
                "access_analyzer": self.access_analyzer(region),
                "waf_regional": self.waf(region, "REGIONAL"),
                "vpc_flow_logs": self.flow_logs(region),
                "log_groups": self.log_groups(region, log_details),
                "limites_cloudwatch_logs": self.log_quotas(region),
            }
        buckets = sorted({trail["bucket"] for trail in trails if isinstance(trail, dict) and trail.get("bucket")}) if isinstance(trails, list) else []
        result["buckets_de_log"] = {name: self.bucket(name) for name in buckets}
        result["chamadas_feitas"] = len(self.calls)
        return result


def warnings(report: Dict[str, Any]) -> List[str]:
    """Pontos de atenção para quem vai ligar a coleta: nada aqui deve ser alterado sem decisão do cliente."""
    found = []
    org = report.get("organizacao", {})
    if org.get("em_organizacao"):
        found.append("A conta está numa organização: logs centralizados podem estar em outra conta (log archive).")
    regions = report.get("regioes", {})
    acls = as_list(report.get("waf_cloudfront"))
    for region in regions.values():
        acls += as_list(region.get("waf_regional"))
    for acl in acls:
        if isinstance(acl, dict) and acl.get("logs_vao_para"):
            found.append(
                f"WAF {acl['nome']}: já envia log para um destino. O WAF aceita um só destino por Web ACL; "
                "não alterar (ler de onde já está)."
            )
    for name, region in regions.items():
        for detector in as_list(region.get("guardduty")):
            if isinstance(detector, dict) and detector.get("exporta_para"):
                found.append(f"GuardDuty ({name}): já exporta findings; ler do destino atual, sem criar outro.")
        full = [
            group
            for group in as_list(region.get("log_groups"))
            if isinstance(group, dict) and isinstance(group.get("subscription_filters"), int)
            and group["subscription_filters"] >= 2
        ]
        if full:
            found.append(f"{name}: {len(full)} log group(s) já com 2 subscription filters (o máximo da AWS).")
    return found


def as_list(value: Any) -> List[Any]:
    """Seções que falharam viram `{"erro": ...}`; para os avisos, só listas interessam."""
    return list(value) if isinstance(value, list) else []


def summary(report: Dict[str, Any]) -> str:
    lines = [f"Conta {report['conta'].get('conta')} — {report.get('chamadas_feitas')} chamadas de leitura"]
    trails = report.get("cloudtrail")
    if isinstance(trails, list):
        lines.append(f"CloudTrail: {len(trails)} trilha(s)")
    for name, region in report.get("regioes", {}).items():
        groups = region.get("log_groups")
        if isinstance(groups, list) and groups:
            total = sum(group.get("bytes_armazenados") or 0 for group in groups)
            lines.append(f"{name}: {len(groups)} log group(s), {total / 1024 ** 3:.1f} GB armazenados")
    notes = warnings(report)
    if notes:
        lines.append("Pontos de atenção:")
        lines.extend(f"  - {note}" for note in notes)
    return "\n".join(lines)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Diagnóstico somente leitura da conta AWS (Verax Control).")
    parser.add_argument("--regioes", help="Regiões separadas por vírgula (padrão: todas as habilitadas).")
    parser.add_argument("--regiao-principal", default="us-east-1", help="Região usada nas chamadas globais.")
    parser.add_argument("--sem-detalhes-de-logs", action="store_true", help="Não conta subscription filters por grupo.")
    parser.add_argument("--saida", help="Arquivo JSON de saída.")
    args = parser.parse_args(argv)

    import boto3  # importado aqui: os testes rodam sem boto3

    session = boto3.Session()
    diagnostico = Diagnostico(lambda service, region: session.client(service, region_name=region or args.regiao_principal))
    regions = [item.strip() for item in args.regioes.split(",")] if args.regioes else None
    report = diagnostico.run(args.regiao_principal, regions, not args.sem_detalhes_de_logs)
    output = args.saida or f"diagnostico-verax-{report['conta'].get('conta')}.json"
    with open(output, "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2, default=str)
    print(summary(report))
    print(f"\nRelatório completo em {output}. Compartilhe só por canal privado.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
