import { scopeToTenant } from '../common/prisma/tenant-scope.js';
import type { FindingSeverity, Prisma } from '../generated/prisma/client.js';
import { type CorrelationKey, incidentRiskScore } from './correlation.js';
import {
  INCIDENT_SUMMARY_LIMITS,
  incidentFindingSelect,
  type IncidentSummaryData,
  incidentSummaryData,
  mergeIncidentSummary,
  protectedItemsOf,
} from './incident-summary.js';

/** Até aqui, os alertas do incidente são resumidos em memória; além disso, no banco. */
export const SUMMARY_IN_MEMORY_MAX = 500;

interface SummaryRow {
  total: number;
  severity: FindingSeverity | null;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
  touchesProtected: boolean;
  privileged: boolean;
  keys: CorrelationKey[];
  accounts: string[];
  resources: string[];
  mitreTactics: string[];
  mitreTechniques: string[];
}

/**
 * O mesmo resumo de `incidentSummaryData`, feito pelo banco sem trazer os alertas. Os textos são comparados e ordenados
 * byte a byte (`COLLATE "C"`), como em `sortedUnique`. Null se o incidente não tem alerta. O lock dos alertas do cliente
 * é de quem chama.
 */
export async function aggregateIncidentSummary(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  tenantId: string,
  incidentId: string,
  protectedItems: ReadonlySet<string>,
): Promise<IncidentSummaryData | null> {
  const items = [...protectedItems];
  const limits = INCIDENT_SUMMARY_LIMITS;
  const [row] = await db.$queryRaw<SummaryRow[]>`
    WITH rows AS MATERIALIZED (
      SELECT f."occurredAt", f."severity", f."actorUser" COLLATE "C" AS "actorUser", f."actorType",
        f."accessKeyId" COLLATE "C" AS "accessKeyId", f."sourceIp" COLLATE "C" AS "sourceIp",
        f."resource" COLLATE "C" AS "resource", f."accountId" COLLATE "C" AS "accountId", f."mitreTactics",
        f."mitreTechniques"
      FROM "Finding" AS f
      WHERE f."incidentId" = ${incidentId}::uuid AND f."tenantId" = ${tenantId}::uuid
    ), keys AS (
      SELECT 'user:' || r."actorUser" AS value FROM rows AS r WHERE r."actorUser" IS NOT NULL
      UNION SELECT 'key:' || r."accessKeyId" FROM rows AS r WHERE r."accessKeyId" IS NOT NULL
      UNION SELECT 'ip:' || r."sourceIp" FROM rows AS r WHERE r."sourceIp" IS NOT NULL
      UNION SELECT 'resource:' || r."resource" FROM rows AS r WHERE r."resource" IS NOT NULL
    )
    SELECT
      count(*)::integer AS "total",
      CASE WHEN bool_or(r."severity" = 'critical') THEN 'critical' WHEN bool_or(r."severity" = 'high') THEN 'high'
        WHEN bool_or(r."severity" = 'medium') THEN 'medium' WHEN count(*) > 0 THEN 'low' END AS "severity",
      min(r."occurredAt") AS "firstSeenAt",
      max(r."occurredAt") AS "lastSeenAt",
      COALESCE(bool_or(
        COALESCE(r."resource" = ANY(${items}::text[]), false) OR COALESCE(r."actorUser" = ANY(${items}::text[]), false)
        OR COALESCE(r."accessKeyId" = ANY(${items}::text[]), false)
      ), false) AS "touchesProtected",
      COALESCE(bool_or(
        COALESCE(r."actorType" = 'Root', false) OR COALESCE(right(r."actorUser", 5) = ':root', false)
        OR COALESCE(r."actorUser" ~ '(^|[^A-Za-z])[Aa][Dd][Mm][Ii][Nn]', false)
      ), false) AS "privileged",
      ARRAY(SELECT k.value FROM keys AS k ORDER BY k.value COLLATE "C" LIMIT ${limits.keys}::integer) AS "keys",
      ARRAY(SELECT DISTINCT a."accountId" FROM rows AS a ORDER BY 1 LIMIT ${limits.accounts}::integer) AS "accounts",
      ARRAY(SELECT DISTINCT a."resource" FROM rows AS a WHERE a."resource" IS NOT NULL
        ORDER BY 1 LIMIT ${limits.resources}::integer) AS "resources",
      ARRAY(SELECT DISTINCT t.value COLLATE "C" FROM rows AS a CROSS JOIN unnest(a."mitreTactics") AS t(value)
        ORDER BY 1 LIMIT ${limits.mitreTactics}::integer) AS "mitreTactics",
      ARRAY(SELECT DISTINCT t.value COLLATE "C" FROM rows AS a CROSS JOIN unnest(a."mitreTechniques") AS t(value)
        ORDER BY 1 LIMIT ${limits.mitreTechniques}::integer) AS "mitreTechniques"
    FROM rows AS r`;
  if (row === undefined || row.severity === null || row.firstSeenAt === null || row.lastSeenAt === null) {
    return null;
  }
  const { total, severity, firstSeenAt, lastSeenAt, touchesProtected, privileged, ...lists } = row;
  return {
    severity,
    riskScore: incidentRiskScore({
      // O volume para de somar no sexto alerta: não é preciso uma lista do tamanho do incidente.
      severities: Array.from({ length: Math.min(total, 6) }, () => severity),
      touchesProtected,
      privilegedIdentity: privileged,
    }),
    findingCount: total,
    firstSeenAt,
    lastSeenAt,
    ...lists,
  };
}

/**
 * Recalcula e grava o resumo de um incidente a partir dos alertas dele agora. Quem chama já tem o lock dos alertas do
 * cliente e a linha do incidente travada.
 */
export async function resummarizeIncident(
  tx: Prisma.TransactionClient,
  tenantId: string,
  incidentId: string,
  inMemoryMax: number = SUMMARY_IN_MEMORY_MAX,
): Promise<IncidentSummaryData> {
  const db = scopeToTenant(tx, tenantId);
  const protectedItems = await loadProtectedItems(db);
  // Um a mais que o teto basta para saber que não cabem.
  const findings = await db.finding.findMany({
    where: { incidentId },
    select: incidentFindingSelect,
    take: inMemoryMax + 1,
  });
  const data =
    findings.length > inMemoryMax
      ? await aggregateIncidentSummary(tx, tenantId, incidentId, protectedItems)
      : incidentSummaryData(findings, protectedItems);
  if (data === null) throw new RangeError('incidente sem achados');
  await db.incident.update({ where: { id: incidentId }, data, select: { id: true } });
  return data;
}

async function loadProtectedItems(db: Prisma.TransactionClient): Promise<Set<string>> {
  return protectedItemsOf(await db.protectedResource.findMany({ select: { type: true, identifier: true } }));
}

const SUMMARY_SELECT = {
  severity: true,
  riskScore: true,
  findingCount: true,
  firstSeenAt: true,
  lastSeenAt: true,
  keys: true,
  accounts: true,
  resources: true,
  mitreTactics: true,
  mitreTechniques: true,
} as const satisfies Prisma.IncidentSelect;

/**
 * O resumo do incidente que acabou de ganhar alertas (a triagem em massa, lote a lote). Num incidente pequeno, refaz tudo;
 * num grande, junta o resumo dele com o dos alertas novos, sem reler os outros: o custo é o do lote, e não o do incidente.
 * As mesmas travas de `resummarizeIncident`.
 */
export async function addToIncidentSummary(
  tx: Prisma.TransactionClient,
  tenantId: string,
  incidentId: string,
  addedIds: readonly string[],
  inMemoryMax: number = SUMMARY_IN_MEMORY_MAX,
): Promise<IncidentSummaryData> {
  const db = scopeToTenant(tx, tenantId);
  const current = await db.incident.findUniqueOrThrow({ where: { id: incidentId }, select: SUMMARY_SELECT });
  if (current.findingCount + addedIds.length <= inMemoryMax) {
    return resummarizeIncident(tx, tenantId, incidentId, inMemoryMax);
  }
  const added = await db.finding.findMany({
    where: { id: { in: [...addedIds] }, incidentId },
    select: incidentFindingSelect,
  });
  const merged = mergeIncidentSummary(current, incidentSummaryData(added, await loadProtectedItems(db)));
  if (merged === null) return resummarizeIncident(tx, tenantId, incidentId, inMemoryMax);
  await db.incident.update({ where: { id: incidentId }, data: merged, select: { id: true } });
  return merged;
}

/**
 * O incidente que acabou de perder alertas, no meio de um desfazer. Tirar não se junta: num incidente pequeno, refaz; num
 * grande, só a contagem acompanha, e quem desfaz refaz o resto no fim (`resummarizeIncident`).
 */
export async function removeFromIncidentSummary(
  tx: Prisma.TransactionClient,
  tenantId: string,
  incidentId: string,
  removed: number,
  inMemoryMax: number = SUMMARY_IN_MEMORY_MAX,
): Promise<void> {
  const db = scopeToTenant(tx, tenantId);
  const { findingCount } = await db.incident.update({
    where: { id: incidentId },
    data: { findingCount: { decrement: removed } },
    select: { findingCount: true },
  });
  if (findingCount <= inMemoryMax) await resummarizeIncident(tx, tenantId, incidentId, inMemoryMax);
}
