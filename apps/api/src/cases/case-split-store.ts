import type { Prisma } from '../generated/prisma/client.js';
import { SAMPLE_LIMITS, SAMPLE_VALUE_MAX } from './case-plan.js';

/**
 * O SQL de dividir um caso. Roda no cliente base (só o sistema grava casos), com o cliente da sessão em todo comando, e sob
 * o lock dos alertas do cliente: a atribuição, que também lê e grava casos, espera. A ordem das travas é a de sempre, os
 * alertas (todos de uma vez, por id) e só então os casos.
 */
type Tx = Prisma.TransactionClient;

/** Trava os alertas a tirar do caso: os da lista que são dele, ou os de um subgrupo. */
export async function lockSplitFindings(
  tx: Tx,
  tenantId: string,
  caseId: string,
  which: { ids: readonly string[] } | { group: string },
  limit: number,
): Promise<string[]> {
  const ids = 'ids' in which ? [...which.ids] : null;
  const group = 'group' in which ? which.group : null;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT f."id"::text AS "id"
    FROM "Finding" AS f
    WHERE f."tenantId" = ${tenantId}::uuid AND f."caseId" = ${caseId}::uuid
      AND (${ids}::uuid[] IS NULL OR f."id" = ANY(${ids}::uuid[]))
      AND (${group}::text IS NULL OR f."caseGroup" = ${group}::text)
    ORDER BY f."id"
    LIMIT ${limit}::integer
    FOR UPDATE`;
  return rows.map((row) => row.id);
}

/**
 * O caso novo: a chave, a fila, a família e o título do original, selado. A abertura é a do original (os limites de
 * abertura contam os casos por ela, e este não é uma chave nova), como a severidade já avisada e quantas vezes a chave
 * voltou. As contagens nascem zeradas: são dos gatilhos, quando os alertas entram. As amostras e os horários saem de
 * `refreshCaseFacts`.
 */
export async function insertSplitCase(
  tx: Tx,
  tenantId: string,
  split: { id: string; originalId: string; findingIds: readonly string[]; now: Date },
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "AlertCase" (
      "id", "tenantId", "queue", "keyVersion", "groupKey", "openKey", "family", "title", "keyParts", "previousCaseId",
      "recurrence", "anchorFindingId", "openedAt", "sealedAt", "sealReason", "firstSeenAt", "lastSeenAt", "lastAlertAt",
      "noticedSeverity"
    )
    SELECT ${split.id}::uuid, c."tenantId", c."queue", c."keyVersion", c."groupKey", NULL, c."family", c."title",
      c."keyParts", c."id", c."recurrence",
      (SELECT f."id" FROM "Finding" AS f
        WHERE f."id" = ANY(${[...split.findingIds]}::uuid[]) AND f."tenantId" = c."tenantId"
        ORDER BY f."createdAt", f."id" LIMIT 1),
      c."openedAt", ${split.now.toISOString()}::timestamptz, 'split', c."firstSeenAt", c."lastSeenAt", c."lastAlertAt",
      c."noticedSeverity"
    FROM "AlertCase" AS c
    WHERE c."id" = ${split.originalId}::uuid AND c."tenantId" = ${tenantId}::uuid`;
}

/** Passa os alertas, já travados, para o caso novo. O `updatedAt` deles não muda. */
export async function moveFindings(
  tx: Tx,
  tenantId: string,
  move: { from: string; to: string; ids: readonly string[] },
): Promise<number> {
  return tx.$executeRaw`
    UPDATE "Finding" SET "caseId" = ${move.to}::uuid
    WHERE "id" = ANY(${[...move.ids]}::uuid[]) AND "tenantId" = ${tenantId}::uuid AND "caseId" = ${move.from}::uuid`;
}

/**
 * Refaz, dos alertas que o caso tem agora, o que a atribuição vai juntando: os horários, o alerta que o abriu (se ele saiu)
 * e as amostras, na ordem de chegada e com os mesmos tetos. As contagens ficam de fora: são dos gatilhos.
 */
export async function refreshCaseFacts(tx: Tx, tenantId: string, caseId: string): Promise<void> {
  const limit = SAMPLE_LIMITS;
  await tx.$executeRaw`
    WITH rows AS MATERIALIZED (
      SELECT f."id", f."createdAt", f."occurredAt", f."lastSeenAt", f."ruleId", f."accountId", f."actorUser",
        f."accessKeyId", f."sourceIp", f."resource", f."mitreTactics", f."mitreTechniques"
      FROM "Finding" AS f
      WHERE f."tenantId" = ${tenantId}::uuid AND f."caseId" = ${caseId}::uuid
    ), facts AS (
      SELECT min(r."occurredAt") AS first_seen, greatest(max(r."occurredAt"), max(r."lastSeenAt")) AS last_seen,
        least(max(r."createdAt"), clock_timestamp()) AS last_alert, count(*) AS total
      FROM rows AS r
    ), samples AS (
      SELECT s.kind, left(s.value, ${SAMPLE_VALUE_MAX}::integer) AS value, min(s.at) AS at
      FROM (
        SELECT 'rule' AS kind, r."ruleId" AS value, r."createdAt" AS at FROM rows AS r
        UNION ALL SELECT 'account', r."accountId", r."createdAt" FROM rows AS r
        UNION ALL SELECT 'actor', r."actorUser", r."createdAt" FROM rows AS r
        UNION ALL SELECT 'access_key', r."accessKeyId", r."createdAt" FROM rows AS r
        UNION ALL SELECT 'ip', r."sourceIp", r."createdAt" FROM rows AS r
        UNION ALL SELECT 'resource', r."resource", r."createdAt" FROM rows AS r
        UNION ALL SELECT 'tactic', t.value, r."createdAt" FROM rows AS r CROSS JOIN unnest(r."mitreTactics") AS t(value)
        UNION ALL SELECT 'technique', t.value, r."createdAt"
          FROM rows AS r CROSS JOIN unnest(r."mitreTechniques") AS t(value)
      ) AS s
      WHERE btrim(s.value) <> ''
      GROUP BY 1, 2
    )
    UPDATE "AlertCase" AS c
    SET "firstSeenAt" = facts.first_seen, "lastSeenAt" = facts.last_seen, "lastAlertAt" = facts.last_alert,
      "anchorFindingId" = COALESCE(
        (SELECT r."id" FROM rows AS r WHERE r."id" = c."anchorFindingId"),
        (SELECT r."id" FROM rows AS r ORDER BY r."createdAt", r."id" LIMIT 1)
      ),
      "ruleIds" = ARRAY(SELECT s.value FROM samples AS s WHERE s.kind = 'rule'
        ORDER BY s.at, s.value LIMIT ${limit.ruleIds}::integer),
      "accounts" = ARRAY(SELECT s.value FROM samples AS s WHERE s.kind = 'account'
        ORDER BY s.at, s.value LIMIT ${limit.accounts}::integer),
      "actors" = ARRAY(SELECT s.value FROM samples AS s WHERE s.kind = 'actor'
        ORDER BY s.at, s.value LIMIT ${limit.actors}::integer),
      "accessKeys" = ARRAY(SELECT s.value FROM samples AS s WHERE s.kind = 'access_key'
        ORDER BY s.at, s.value LIMIT ${limit.accessKeys}::integer),
      "ips" = ARRAY(SELECT s.value FROM samples AS s WHERE s.kind = 'ip'
        ORDER BY s.at, s.value LIMIT ${limit.ips}::integer),
      "resources" = ARRAY(SELECT s.value FROM samples AS s WHERE s.kind = 'resource'
        ORDER BY s.at, s.value LIMIT ${limit.resources}::integer),
      "mitreTactics" = ARRAY(SELECT s.value FROM samples AS s WHERE s.kind = 'tactic'
        ORDER BY s.at, s.value LIMIT ${limit.mitreTactics}::integer),
      "mitreTechniques" = ARRAY(SELECT s.value FROM samples AS s WHERE s.kind = 'technique'
        ORDER BY s.at, s.value LIMIT ${limit.mitreTechniques}::integer)
    FROM facts
    WHERE c."id" = ${caseId}::uuid AND c."tenantId" = ${tenantId}::uuid AND facts.total > 0`;
}
