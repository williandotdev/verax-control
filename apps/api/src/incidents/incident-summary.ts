import type { Prisma } from '../generated/prisma/client.js';
import {
  type CorrelationKey,
  highestSeverity,
  type IncidentFinding,
  incidentRiskScore,
  riskFlags,
  sortedUnique,
  summarizeIncident,
} from './correlation.js';

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

/** O contrato aceita até 200 chaves e recursos, 50 contas e técnicas e 20 táticas por incidente. */
export const INCIDENT_SUMMARY_LIMITS = {
  keys: 200,
  accounts: 50,
  resources: 200,
  mitreTactics: 20,
  mitreTechniques: 50,
} as const;

/**
 * Os campos de resumo do incidente (severidade, nota de risco, período, chaves, contas, recursos e MITRE) a partir dos
 * alertas dele, recalculados a cada mudança (promover, anexar, remover). Cortados nos limites do contrato. O incidente
 * com muitos alertas é resumido no banco, com o mesmo resultado (`incident-summary-store.ts`).
 */
export function incidentSummaryData(
  findings: readonly IncidentFindingRow[],
  protectedItems: ReadonlySet<string>,
) {
  const summary = summarizeIncident(findings.map(toIncidentFinding), protectedItems);
  const limits = INCIDENT_SUMMARY_LIMITS;
  return {
    severity: summary.severity,
    riskScore: summary.riskScore,
    findingCount: summary.findingCount,
    firstSeenAt: new Date(summary.firstSeenAt),
    lastSeenAt: new Date(summary.lastSeenAt),
    keys: summary.keys.slice(0, limits.keys),
    accounts: summary.accounts.slice(0, limits.accounts),
    resources: summary.resources.slice(0, limits.resources),
    mitreTactics: summary.mitreTactics.slice(0, limits.mitreTactics),
    mitreTechniques: summary.mitreTechniques.slice(0, limits.mitreTechniques),
  };
}
export type IncidentSummaryData = ReturnType<typeof incidentSummaryData>;

/** O resumo guardado do incidente: as chaves são texto no banco. */
export type StoredIncidentSummary = Omit<IncidentSummaryData, 'keys'> & { keys: string[] };

/**
 * O resumo de um incidente depois de ganhar alertas, só do resumo dele e do dos alertas novos: o mesmo que sairia de todos
 * os alertas. Vale porque tudo no resumo só cresce ao anexar: as listas guardam os menores valores (os menores da união
 * saem dos menores de cada lado), e a nota diz as parcelas dela, menos no teto, de onde não sai. Com a mesma lista de
 * proteção de antes. Null se a nota guardada não é desta conta: aí se refaz dos alertas.
 */
export function mergeIncidentSummary(
  current: StoredIncidentSummary,
  added: IncidentSummaryData,
): IncidentSummaryData | null {
  const limits = INCIDENT_SUMMARY_LIMITS;
  const findingCount = current.findingCount + added.findingCount;
  const severity = highestSeverity([current.severity, added.severity]);
  let riskScore = 100;
  if (current.riskScore < 100 && added.riskScore < 100) {
    const before = riskFlags(current.riskScore, current.severity, current.findingCount);
    const extra = riskFlags(added.riskScore, added.severity, added.findingCount);
    if (before === null || extra === null) return null;
    riskScore = incidentRiskScore({
      // O volume para de somar no sexto alerta.
      severities: Array.from({ length: Math.min(findingCount, 6) }, () => severity),
      touchesProtected: before.touchesProtected || extra.touchesProtected,
      privilegedIdentity: before.privilegedIdentity || extra.privilegedIdentity,
    });
  }
  const union = <T extends string>(a: readonly T[], b: readonly T[], limit: number): T[] =>
    sortedUnique([...a, ...b]).slice(0, limit);
  return {
    severity,
    riskScore,
    findingCount,
    firstSeenAt: current.firstSeenAt < added.firstSeenAt ? current.firstSeenAt : added.firstSeenAt,
    lastSeenAt: current.lastSeenAt > added.lastSeenAt ? current.lastSeenAt : added.lastSeenAt,
    keys: union(current.keys as CorrelationKey[], added.keys, limits.keys),
    accounts: union(current.accounts, added.accounts, limits.accounts),
    resources: union(current.resources, added.resources, limits.resources),
    mitreTactics: union(current.mitreTactics, added.mitreTactics, limits.mitreTactics),
    mitreTechniques: union(current.mitreTechniques, added.mitreTechniques, limits.mitreTechniques),
  };
}
