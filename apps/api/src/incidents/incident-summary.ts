import type { Prisma } from '../generated/prisma/client.js';
import { type IncidentFinding, summarizeIncident } from './correlation.js';

/** Os campos do alerta (achado) que o resumo do incidente usa. */
export const incidentFindingSelect = {
  id: true,
  tenantId: true,
  occurredAt: true,
  severity: true,
  actorUser: true,
  actorType: true,
  accessKeyId: true,
  sourceIp: true,
  resource: true,
  accountId: true,
  mitreTactics: true,
  mitreTechniques: true,
} as const satisfies Prisma.FindingSelect;

export type IncidentFindingRow = Prisma.FindingGetPayload<{ select: typeof incidentFindingSelect }>;

export function toIncidentFinding(row: IncidentFindingRow): IncidentFinding {
  return { ...row, occurredAt: row.occurredAt.toISOString() };
}

/**
 * Itens da lista de proteção (T3.4) no formato dos campos do achado: o identificador como foi cadastrado e, para
 * bucket, instância e security group, também como `tipo:id` (`s3:`, `ec2:`, `sg:`), que é como o recurso aparece
 * no achado.
 */
export function protectedItemsOf(items: readonly { type: string; identifier: string }[]): Set<string> {
  const set = new Set<string>();
  for (const { type, identifier } of items) {
    set.add(identifier);
    if (type === 's3_bucket') set.add(`s3:${identifier}`);
    if (type === 'ec2_instance') set.add(`ec2:${identifier}`);
    if (type === 'security_group') set.add(`sg:${identifier}`);
  }
  return set;
}

/**
 * Os campos de resumo do incidente (severidade, nota de risco, período, chaves, contas, recursos e MITRE) a partir dos
 * alertas dele, recalculados a cada mudança (promover, anexar, remover). Cortados nos limites do contrato.
 */
export function incidentSummaryData(
  findings: readonly IncidentFindingRow[],
  protectedItems: ReadonlySet<string>,
) {
  const summary = summarizeIncident(findings.map(toIncidentFinding), protectedItems);
  return {
    severity: summary.severity,
    riskScore: summary.riskScore,
    findingCount: summary.findingCount,
    firstSeenAt: new Date(summary.firstSeenAt),
    lastSeenAt: new Date(summary.lastSeenAt),
    // O contrato aceita até 200 chaves e recursos e 50 contas por incidente.
    keys: summary.keys.slice(0, 200),
    accounts: summary.accounts.slice(0, 50),
    resources: summary.resources.slice(0, 200),
    mitreTactics: summary.mitreTactics.slice(0, 20),
    mitreTechniques: summary.mitreTechniques.slice(0, 50),
  };
}
