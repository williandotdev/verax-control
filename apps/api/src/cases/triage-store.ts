import { z } from 'zod';
import { lockTenantFindings } from '../alerts/finding-store.js';
import { type FindingSeverity, type FindingStatus, Prisma } from '../generated/prisma/client.js';
import { type CaseSetFilter, caseSetWhere, protectedCaseWhere } from './case-read-store.js';
import { setLockTimeout } from './case-store.js';

/**
 * O SQL da triagem em massa. Roda no cliente base (o SQL com parâmetros não passa pelo escopo), então todo comando leva o
 * cliente, que vem da sessão (requisição) ou da própria operação (worker), nunca do corpo do pedido.
 *
 * Ordem das travas, a mesma de todo o projeto: o lock dos alertas do cliente (`lockTenantFindings`, de quem chama), a
 * linha da operação, a do incidente, as dos alertas (`FOR UPDATE`, todas do lote de uma vez, por id) e só então os casos,
 * pelos gatilhos. As contagens dos casos são sempre dos gatilhos.
 */
type Tx = Prisma.TransactionClient;

/** O espaço dos locks transacionais da triagem (a forma de dois números não se mistura com a de `lockTenantFindings`). */
const TRIAGE_LOCK_SPACE = 20_261_202;

/**
 * Um pedido de triagem em massa por cliente de cada vez: a conferência do `requestId`, das cotas e da fila não corre com a
 * de outro pedido. Vem sempre antes do lock dos alertas, e o worker não o toma: congelar um conjunto grande não faz os
 * coletores esperarem.
 */
export async function lockTenantTriage(tx: Tx, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${TRIAGE_LOCK_SPACE}::int4, hashtext(${tenantId}))`;
}

/** Prazos de cada comando até o fim da transação: a espera por uma trava e o comando inteiro. Sem JIT. */
export async function setTriageTimeouts(tx: Tx, lockMs: number, statementMs: number): Promise<void> {
  await tx.$executeRaw`
    SELECT set_config('lock_timeout', ${`${lockMs}ms`}, true), set_config('statement_timeout', ${`${statementMs}ms`}, true),
      set_config('jit', 'off', true)`;
}

/** Com o lock dos alertas do cliente na mão, a espera máxima por uma linha presa (uma triagem em curso). */
export const ROW_LOCK_TIMEOUT_MS = 1_000;

/**
 * O lock dos alertas do cliente, numa requisição. A espera por ele segue o prazo da transação; daqui em diante, nenhuma
 * espera por linha é longa, porque os coletores estão esperando por este lock.
 */
export async function lockFindingsBriefly(tx: Tx, tenantId: string): Promise<void> {
  await lockTenantFindings(tx, tenantId);
  await setLockTimeout(tx, ROW_LOCK_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------------------------------
// O alvo gravado
// ---------------------------------------------------------------------------------------------------

/** Por que a operação parou; o contrato tem os valores (`TRIAGE_STOPS`). */
const stopSchema = z.string().max(32).nullable().catch(null);

/**
 * O que o motor guarda junto do pedido, em `TriageOperation.target`: `run` (o andamento, pequeno) e `ids` (o conjunto
 * congelado, na ordem dos lotes, que sai quando a operação termina). O resto do JSON é o pedido, como a API o validou.
 */
const runSchema = z.object({
  excludedCritical: z.number().int().min(0).catch(0),
  /** O alerta que abriu o incidente (`promote`): fica nele quando a operação é desfeita. */
  anchorId: z.string().nullable().catch(null),
  /** No desfazer: o estado da operação desfeita antes dele (volta, se o desfazer for cancelado sem mudar nada). */
  previousState: z.string().nullable().catch(null),
  /** Os alertas que o banco não deixou gravar, para o "continuar". */
  failed: z.array(z.string()).catch([]),
  stop: stopSchema,
  /** No desfazer de um `promote`: o incidente foi resolvido no fim. */
  incidentResolved: z.boolean().nullable().catch(null),
});
export type TriageRun = z.infer<typeof runSchema>;

export const EMPTY_RUN: TriageRun = {
  excludedCritical: 0,
  anchorId: null,
  previousState: null,
  failed: [],
  stop: null,
  incidentResolved: null,
};

/** O `run` do alvo gravado. O que não for do formato vale como o começo: nunca lança. */
export function runOf(target: unknown): TriageRun {
  const run = typeof target === 'object' && target !== null && 'run' in target ? target.run : undefined;
  const parsed = runSchema.safeParse(run);
  return parsed.success ? parsed.data : EMPTY_RUN;
}

// ---------------------------------------------------------------------------------------------------
// Congelar o conjunto
// ---------------------------------------------------------------------------------------------------

/** Os alertas que uma operação alcança, antes do corte. */
export type TriageScope =
  | { kind: 'cases'; caseIds: readonly string[]; group: string | null }
  | { kind: 'findings'; findingIds: readonly string[] }
  | { kind: 'filter'; filter: CaseSetFilter };

function scopeWhere(tenantId: string, scope: TriageScope): Prisma.Sql {
  switch (scope.kind) {
    case 'cases':
      return Prisma.sql`f."caseId" = ANY(${[...scope.caseIds]}::uuid[])
        AND (${scope.group}::text IS NULL OR f."caseGroup" = ${scope.group}::text)`;
    case 'findings':
      return Prisma.sql`f."id" = ANY(${[...scope.findingIds]}::uuid[])`;
    case 'filter':
      return Prisma.sql`f."caseId" IN (
        SELECT c."id" FROM "AlertCase" AS c WHERE ${caseSetWhere(tenantId, scope.filter)}
      )`;
  }
}

export interface FreezeInput {
  id: string;
  tenantId: string;
  requestId: string;
  action: 'status' | 'promote' | 'attach';
  status: FindingStatus | null;
  incidentId: string | null;
  includeCritical: boolean;
  cutoffAt: Date;
  expectedCount: number;
  reason: string | null;
  createdById: string;
  undoUntil: Date;
  now: Date;
  /** O pedido, como vai para a coluna. */
  request: object;
  scope: TriageScope;
  /** O caso de que o alerta que o abriu vem primeiro (`promote` de um caso só). */
  anchorCaseId: string | null;
  max: number;
}

export interface Frozen {
  /** Passa de `max` em um quando o alvo é grande demais: quem chama desfaz. */
  matched: number;
  excludedCritical: number;
  cases: number;
  counts: { status: FindingStatus; severity: FindingSeverity; count: number }[];
}

/**
 * Cria a operação com o conjunto congelado, num comando só (um retrato só do banco): os alertas do alvo que chegaram até
 * `cutoffAt` e estão pendentes, os piores primeiro. O predicado de pendente é o mesmo do índice da fila dos casos.
 */
export async function freezeOperation(tx: Tx, input: FreezeInput): Promise<Frozen> {
  const { tenantId } = input;
  const at = input.now.toISOString();
  const [row] = await tx.$queryRaw<Frozen[]>`
    WITH chosen AS MATERIALIZED (
      SELECT f."id", f."severity", f."status", f."createdAt", f."caseId"
      FROM "Finding" AS f
      WHERE f."tenantId" = ${tenantId}::uuid
        AND f."createdAt" <= ${input.cutoffAt.toISOString()}::timestamptz
        AND f."incidentId" IS NULL AND f."status" IN ('new', 'investigating')
        AND (${input.status}::text IS NULL OR f."status"::text <> ${input.status}::text)
        AND ${scopeWhere(tenantId, input.scope)}
    ), kept AS MATERIALIZED (
      SELECT k.*, row_number() OVER (
        ORDER BY
          COALESCE(k."id" = (
            SELECT c."anchorFindingId" FROM "AlertCase" AS c
            WHERE c."id" = ${input.anchorCaseId}::uuid AND c."tenantId" = ${tenantId}::uuid
          ), false) DESC,
          CASE k."severity" WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
          k."createdAt", k."id"
      ) AS position
      FROM chosen AS k
      WHERE ${input.includeCritical}::boolean OR k."severity" <> 'critical'
      ORDER BY position
      LIMIT ${input.max + 1}::integer
    ), counted AS MATERIALIZED (
      SELECT
        (SELECT count(*)::integer FROM kept) AS matched,
        (SELECT count(*)::integer FROM chosen AS k
          WHERE NOT ${input.includeCritical}::boolean AND k."severity" = 'critical') AS excluded,
        (SELECT count(DISTINCT k."caseId")::integer FROM kept AS k) AS cases,
        (SELECT COALESCE(jsonb_agg(jsonb_build_object('status', g."status", 'severity', g."severity", 'count', g.n)
            ORDER BY g."status", g."severity"), '[]'::jsonb)
          FROM (SELECT k."status", k."severity", count(*)::integer AS n FROM kept AS k GROUP BY 1, 2) AS g) AS counts
    ), stored AS (
      INSERT INTO "TriageOperation" (
        "id", "tenantId", "requestId", "action", "target", "status", "incidentId", "includeCritical", "cutoffAt",
        "expectedCount", "reason", "state", "matched", "createdById", "undoUntil", "createdAt", "updatedAt"
      )
      SELECT ${input.id}::uuid, ${tenantId}::uuid, ${input.requestId}::uuid, ${input.action}::text,
        ${JSON.stringify(input.request)}::jsonb || jsonb_build_object(
          'run', jsonb_build_object('excludedCritical', c.excluded),
          'ids', COALESCE((SELECT jsonb_agg(k."id" ORDER BY k.position) FROM kept AS k), '[]'::jsonb)
        ),
        ${input.status}::text::"FindingStatus", ${input.incidentId}::uuid, ${input.includeCritical}::boolean,
        ${input.cutoffAt.toISOString()}::timestamptz, ${input.expectedCount}::integer, ${input.reason}::text, 'queued',
        c.matched, ${input.createdById}::text, ${input.undoUntil.toISOString()}::timestamptz, ${at}::timestamptz,
        ${at}::timestamptz
      FROM counted AS c
      RETURNING 1
    )
    SELECT c.matched AS "matched", c.excluded AS "excludedCritical", c.cases AS "cases", c.counts AS "counts"
    FROM counted AS c, stored`;
  if (row === undefined) throw new Error('a operação não foi gravada');
  return row;
}

interface SeverityTally {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export interface FilterPreview extends SeverityTally {
  cases: number;
  protectedCases: number;
  new: number;
  investigating: number;
  /** Os pendentes novos e em análise, por severidade; null sem `byStatus`. */
  byStatus: { new: SeverityTally; investigating: SeverityTally } | null;
}

/**
 * O que um filtro alcança agora, pelas contagens dos casos. Com `byStatus`, também os novos e os em análise por severidade:
 * o caso que só tem de um dos dois diz pelas contagens; no que tem dos dois, os alertas dele são lidos (quem chama põe um
 * prazo). Um comando só: as contas são do mesmo retrato do banco.
 */
export async function previewFilter(
  db: Pick<Tx, '$queryRaw'>,
  tenantId: string,
  filter: CaseSetFilter,
  { protectedItems, byStatus }: { protectedItems: readonly string[]; byStatus: boolean },
): Promise<FilterPreview> {
  const [row] = await db.$queryRaw<FilterPreview[]>`
    WITH matched AS MATERIALIZED (
      SELECT c."id", c."newCount" AS fresh, c."investigatingCount" AS held, c."pendingCritical" AS critical,
        c."pendingHigh" AS high, c."pendingMedium" AS medium, c."pendingLow" AS low,
        ${protectedCaseWhere(protectedItems)} AS protected
      FROM "AlertCase" AS c
      WHERE ${caseSetWhere(tenantId, filter)}
    ), tallied AS (
      SELECT CASE WHEN m.held = 0 THEN 'new' ELSE 'investigating' END AS status,
        sum(m.critical) AS critical, sum(m.high) AS high, sum(m.medium) AS medium, sum(m.low) AS low
      FROM matched AS m WHERE ${byStatus}::boolean AND (m.held = 0 OR m.fresh = 0)
      GROUP BY 1
      UNION ALL
      SELECT f."status"::text,
        count(*) FILTER (WHERE f."severity" = 'critical'), count(*) FILTER (WHERE f."severity" = 'high'),
        count(*) FILTER (WHERE f."severity" = 'medium'), count(*) FILTER (WHERE f."severity" = 'low')
      FROM matched AS m
      JOIN "Finding" AS f ON f."tenantId" = ${tenantId}::uuid AND f."caseId" = m."id"
      WHERE ${byStatus}::boolean AND m.held > 0 AND m.fresh > 0
        AND f."incidentId" IS NULL AND f."status" IN ('new', 'investigating')
      GROUP BY 1
    ), statuses AS (
      SELECT jsonb_object_agg(s.status, (
        SELECT jsonb_build_object(
          'critical', COALESCE(sum(t.critical), 0), 'high', COALESCE(sum(t.high), 0),
          'medium', COALESCE(sum(t.medium), 0), 'low', COALESCE(sum(t.low), 0)
        )
        FROM tallied AS t WHERE t.status = s.status
      )) AS by_status
      FROM (VALUES ('new'), ('investigating')) AS s(status)
    )
    SELECT count(*)::integer AS "cases",
      (count(*) FILTER (WHERE m.protected))::integer AS "protectedCases",
      COALESCE(sum(m.fresh), 0)::integer AS "new",
      COALESCE(sum(m.held), 0)::integer AS "investigating",
      COALESCE(sum(m.critical), 0)::integer AS "critical",
      COALESCE(sum(m.high), 0)::integer AS "high",
      COALESCE(sum(m.medium), 0)::integer AS "medium",
      COALESCE(sum(m.low), 0)::integer AS "low",
      CASE WHEN ${byStatus}::boolean THEN (SELECT s.by_status FROM statuses AS s) END AS "byStatus"
    FROM matched AS m`;
  if (row === undefined) throw new Error('a contagem do filtro não devolveu linha');
  return row;
}

/**
 * Quem pediu operações no cliente desde `since`, do pedido mais recente para trás. O nome vem da pessoa: quem foi excluído
 * não aparece.
 */
export function operationAuthors(
  db: Pick<Tx, '$queryRaw'>,
  tenantId: string,
  since: Date,
  limit: number,
): Promise<{ id: string; name: string }[]> {
  return db.$queryRaw<{ id: string; name: string }[]>`
    SELECT u."id", u."name"
    FROM (
      SELECT o."createdById" AS author, max(o."createdAt") AS last
      FROM "TriageOperation" AS o
      WHERE o."tenantId" = ${tenantId}::uuid AND o."createdAt" >= ${since.toISOString()}::timestamptz
        AND o."createdById" IS NOT NULL
      GROUP BY 1
      ORDER BY last DESC, author
      LIMIT ${limit}::integer
    ) AS recent
    JOIN "User" AS u ON u."id" = recent.author
    ORDER BY recent.last DESC, recent.author`;
}

// ---------------------------------------------------------------------------------------------------
// A operação
// ---------------------------------------------------------------------------------------------------

export interface LockedOperation {
  id: string;
  tenantId: string;
  action: string;
  status: FindingStatus | null;
  incidentId: string | null;
  includeCritical: boolean;
  cutoffAt: Date;
  state: string;
  cursor: string | null;
  matched: number;
  changed: number;
  skipped: number;
  undoOfId: string | null;
  undoUntil: Date | null;
  reason: string | null;
  createdById: string | null;
  run: TriageRun;
}

/** A operação do cliente, com a linha travada até o fim da transação. Sem o conjunto congelado, que pode ser grande. */
export async function lockOperation(
  tx: Tx,
  tenantId: string,
  operationId: string,
): Promise<LockedOperation | null> {
  const [row] = await tx.$queryRaw<(Omit<LockedOperation, 'run'> & { target: unknown })[]>`
    SELECT o."id"::text AS "id", o."tenantId"::text AS "tenantId", o."action", o."status"::text AS "status",
      o."incidentId"::text AS "incidentId", o."includeCritical", o."cutoffAt", o."state", o."cursor", o."matched",
      o."changed", o."skipped", o."undoOfId"::text AS "undoOfId", o."undoUntil", o."reason", o."createdById",
      o."target" - 'ids' AS "target"
    FROM "TriageOperation" AS o
    WHERE o."id" = ${operationId}::uuid AND o."tenantId" = ${tenantId}::uuid
    FOR UPDATE`;
  if (row === undefined) return null;
  const { target, ...operation } = row;
  return { ...operation, run: runOf(target) };
}

/** Um trecho do conjunto congelado, e um a mais, que diz se há outro. */
export async function frozenSlice(
  tx: Tx,
  tenantId: string,
  operationId: string,
  offset: number,
  limit: number,
): Promise<{ ids: string[]; more: boolean }> {
  const [row] = await tx.$queryRaw<{ ids: string[] }[]>`
    SELECT jsonb_path_query_array(
      o."target", '$.ids[$from to $until]',
      jsonb_build_object('from', ${offset}::integer, 'until', ${offset + limit}::integer)
    ) AS "ids"
    FROM "TriageOperation" AS o
    WHERE o."id" = ${operationId}::uuid AND o."tenantId" = ${tenantId}::uuid`;
  const ids = row?.ids ?? [];
  return { ids: ids.slice(0, limit), more: ids.length > limit };
}

/** O próximo trecho dos alertas que uma operação mudou, pela ordem do id (o desfazer). */
export async function itemSlice(
  tx: Tx,
  tenantId: string,
  operationId: string,
  after: string | null,
  limit: number,
): Promise<{ ids: string[]; more: boolean }> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT i."findingId"::text AS "id"
    FROM "TriageOperationItem" AS i
    WHERE i."operationId" = ${operationId}::uuid AND i."tenantId" = ${tenantId}::uuid
      AND (${after}::uuid IS NULL OR i."findingId" > ${after}::uuid)
    ORDER BY i."findingId"
    LIMIT ${limit + 1}::integer`;
  return { ids: rows.slice(0, limit).map((row) => row.id), more: rows.length > limit };
}

export interface OperationProgress {
  state: string;
  cursor: string | null;
  changed: number;
  skipped: number;
  now: Date;
}

/** O andamento depois de um lote. O alvo, que pode ser grande, não é regravado. */
export async function saveProgress(
  tx: Tx,
  tenantId: string,
  operationId: string,
  progress: OperationProgress,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "TriageOperation"
    SET "state" = ${progress.state}::text, "cursor" = ${progress.cursor}::text, "changed" = ${progress.changed}::integer,
      "skipped" = ${progress.skipped}::integer, "updatedAt" = ${progress.now.toISOString()}::timestamptz
    WHERE "id" = ${operationId}::uuid AND "tenantId" = ${tenantId}::uuid`;
}

/** O `run` da operação; com `keepIds` falso, o conjunto congelado sai (ninguém mais precisa dele). */
export async function saveRun(
  tx: Tx,
  tenantId: string,
  operationId: string,
  run: TriageRun,
  { keepIds, undoUntil }: { keepIds: boolean; undoUntil?: Date | null },
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "TriageOperation"
    SET "target" = (CASE WHEN ${keepIds}::boolean THEN "target" ELSE "target" - 'ids' END)
        || jsonb_build_object('run', ${JSON.stringify(run)}::jsonb),
      "undoUntil" = CASE WHEN ${undoUntil !== undefined}::boolean THEN ${undoUntil?.toISOString() ?? null}::timestamptz
        ELSE "undoUntil" END
    WHERE "id" = ${operationId}::uuid AND "tenantId" = ${tenantId}::uuid`;
}

/** Põe de volta na fila o que faltou: os que falharam e o resto do conjunto, do lugar em que parou. */
export async function requeueRest(
  tx: Tx,
  tenantId: string,
  operationId: string,
  offset: number,
  run: TriageRun,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "TriageOperation"
    SET "target" = "target" || jsonb_build_object(
      'run', ${JSON.stringify({ ...run, failed: [], stop: null })}::jsonb,
      'ids', ${JSON.stringify(run.failed)}::jsonb || jsonb_path_query_array(
        "target", '$.ids[$from to last]', jsonb_build_object('from', ${offset}::integer)
      )
    )
    WHERE "id" = ${operationId}::uuid AND "tenantId" = ${tenantId}::uuid`;
}

// ---------------------------------------------------------------------------------------------------
// Os alertas
// ---------------------------------------------------------------------------------------------------

/** Trava as linhas de um lote, por id. Espera uma triagem em curso nelas (o prazo é o `lock_timeout` da transação). */
export async function lockFindings(tx: Tx, tenantId: string, ids: readonly string[]): Promise<void> {
  await tx.$executeRaw`
    SELECT 1 FROM "Finding"
    WHERE "id" = ANY(${[...ids]}::uuid[]) AND "tenantId" = ${tenantId}::uuid
    ORDER BY "id" FOR UPDATE`;
}

/** O que ainda vale de um lote já travado: chegou até o corte, pendente, fora de incidente, crítico só se pedido. */
function stillActionable(
  operation: Pick<LockedOperation, 'tenantId' | 'cutoffAt' | 'includeCritical'>,
  ids: readonly string[],
): Prisma.Sql {
  return Prisma.sql`f."id" = ANY(${[...ids]}::uuid[]) AND f."tenantId" = ${operation.tenantId}::uuid
        AND f."createdAt" <= ${operation.cutoffAt.toISOString()}::timestamptz
        AND f."incidentId" IS NULL AND f."status" IN ('new', 'investigating')
        AND (${operation.includeCritical}::boolean OR f."severity" <> 'critical')`;
}

/** Os ids de um lote já travado que ainda valem, na ordem dada. */
export async function actionableIds(
  tx: Tx,
  operation: Pick<LockedOperation, 'tenantId' | 'cutoffAt' | 'includeCritical'>,
  ids: readonly string[],
): Promise<string[]> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT f."id"::text AS "id" FROM "Finding" AS f WHERE ${stillActionable(operation, ids)}`;
  const valid = new Set(rows.map((row) => row.id));
  return ids.filter((id) => valid.has(id));
}

/**
 * Muda o status de um lote já travado. O item de cada alerta (o que ele era) e a mudança são o mesmo comando, e só muda o
 * alerta cujo item acabou de nascer: um alerta não é mudado duas vezes pela mesma operação, aconteça o que acontecer.
 *
 * `triagedAt`, como na triagem de um alerta só: a primeira saída de "novo" marca a data, e as seguintes não a mudam. O
 * `updatedAt` muda de propósito: é atividade de uma pessoa, que a retenção lê.
 */
export async function applyStatus(
  tx: Tx,
  operation: LockedOperation,
  ids: readonly string[],
  now: Date,
): Promise<number> {
  const at = now.toISOString();
  return tx.$executeRaw`
    WITH taken AS (
      INSERT INTO "TriageOperationItem" ("tenantId", "operationId", "findingId", "previousStatus", "previousTriagedAt",
        "previousIncidentId", "createdAt")
      SELECT f."tenantId", ${operation.id}::uuid, f."id", f."status", f."triagedAt", f."incidentId", clock_timestamp()
      FROM "Finding" AS f
      WHERE ${stillActionable(operation, ids)} AND f."status" <> ${operation.status}::text::"FindingStatus"
      ON CONFLICT DO NOTHING
      RETURNING "findingId"
    )
    UPDATE "Finding" AS f
    SET "status" = ${operation.status}::text::"FindingStatus",
      "triagedAt" = CASE WHEN f."status" = 'new' AND f."triagedAt" IS NULL AND ${operation.status}::text <> 'new'
        THEN ${at}::timestamptz ELSE f."triagedAt" END,
      "triageOpId" = ${operation.id}::uuid,
      "updatedAt" = ${at}::timestamptz
    FROM taken AS t
    WHERE f."id" = t."findingId" AND f."tenantId" = ${operation.tenantId}::uuid`;
}

/**
 * Anexa um lote já travado ao incidente da operação. O status do alerta não muda, como no anexar de um por um. Devolve os
 * que entraram.
 */
export async function applyAttach(
  tx: Tx,
  operation: LockedOperation,
  ids: readonly string[],
  now: Date,
): Promise<string[]> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    WITH taken AS (
      INSERT INTO "TriageOperationItem" ("tenantId", "operationId", "findingId", "previousStatus", "previousTriagedAt",
        "previousIncidentId", "createdAt")
      SELECT f."tenantId", ${operation.id}::uuid, f."id", f."status", f."triagedAt", f."incidentId", clock_timestamp()
      FROM "Finding" AS f
      WHERE ${stillActionable(operation, ids)}
      ON CONFLICT DO NOTHING
      RETURNING "findingId"
    )
    UPDATE "Finding" AS f
    SET "incidentId" = ${operation.incidentId}::uuid, "triageOpId" = ${operation.id}::uuid,
      "updatedAt" = ${now.toISOString()}::timestamptz
    FROM taken AS t
    WHERE f."id" = t."findingId" AND f."tenantId" = ${operation.tenantId}::uuid
    RETURNING f."id"::text AS "id"`;
  return rows.map((row) => row.id);
}

/** Os itens dos alertas que abrem o incidente (`promote`), antes de ele existir. As linhas já estão travadas. */
export async function takeItems(tx: Tx, operation: LockedOperation, ids: readonly string[]): Promise<number> {
  return tx.$executeRaw`
    INSERT INTO "TriageOperationItem" ("tenantId", "operationId", "findingId", "previousStatus", "previousTriagedAt",
      "previousIncidentId", "createdAt")
    SELECT f."tenantId", ${operation.id}::uuid, f."id", f."status", f."triagedAt", f."incidentId", clock_timestamp()
    FROM "Finding" AS f
    WHERE ${stillActionable(operation, ids)}
    ON CONFLICT DO NOTHING`;
}

/** Marca os alertas que abriram o incidente com a operação. */
export async function markTaken(tx: Tx, operation: LockedOperation, ids: readonly string[]): Promise<void> {
  await tx.$executeRaw`
    UPDATE "Finding" AS f SET "triageOpId" = ${operation.id}::uuid
    FROM "TriageOperationItem" AS i
    WHERE i."operationId" = ${operation.id}::uuid AND i."findingId" = f."id" AND i."tenantId" = f."tenantId"
      AND f."id" = ANY(${[...ids]}::uuid[]) AND f."tenantId" = ${operation.tenantId}::uuid`;
}

/**
 * Do lote já travado, os alertas que o desfazer pode devolver: a operação ainda é a última que mexeu neles, e eles estão
 * como ela deixou. O que alguém mudou depois (o status à mão, o incidente, outra operação) fica como está.
 */
export async function revertibleIds(
  tx: Tx,
  undone: Pick<LockedOperation, 'id' | 'tenantId' | 'status' | 'incidentId'>,
  ids: readonly string[],
  keep: string | null,
): Promise<string[]> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT f."id"::text AS "id"
    FROM "Finding" AS f
    WHERE f."id" = ANY(${[...ids]}::uuid[]) AND f."tenantId" = ${undone.tenantId}::uuid
      AND f."triageOpId" = ${undone.id}::uuid
      AND f."incidentId" IS NOT DISTINCT FROM ${undone.incidentId}::uuid
      AND (${undone.status}::text IS NULL OR f."status"::text = ${undone.status}::text)
      AND f."id" IS DISTINCT FROM ${keep}::uuid
    ORDER BY f."id"`;
  return rows.map((row) => row.id);
}

/** Há no incidente algum alerta além destes? O incidente nunca fica sem nenhum. */
export async function hasOtherAlerts(
  tx: Tx,
  tenantId: string,
  incidentId: string,
  ids: readonly string[],
): Promise<boolean> {
  const [row] = await tx.$queryRaw<{ found: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM "Finding" AS f
      WHERE f."incidentId" = ${incidentId}::uuid AND f."tenantId" = ${tenantId}::uuid
        AND f."id" <> ALL(${[...ids]}::uuid[])
    ) AS "found"`;
  return row?.found ?? false;
}

/**
 * Devolve os alertas ao que eram antes da operação. Como no `applyStatus`, o item do desfazer e a devolução são o mesmo
 * comando. O incidente de antes é sempre nenhum: só entra em operação o alerta fora de incidente.
 */
export async function revert(
  tx: Tx,
  undo: Pick<LockedOperation, 'id' | 'tenantId'>,
  undoneId: string,
  ids: readonly string[],
  now: Date,
): Promise<number> {
  return tx.$executeRaw`
    WITH taken AS (
      INSERT INTO "TriageOperationItem" ("tenantId", "operationId", "findingId", "previousStatus", "previousTriagedAt",
        "previousIncidentId", "createdAt")
      SELECT f."tenantId", ${undo.id}::uuid, f."id", f."status", f."triagedAt", f."incidentId", clock_timestamp()
      FROM "Finding" AS f
      WHERE f."id" = ANY(${[...ids]}::uuid[]) AND f."tenantId" = ${undo.tenantId}::uuid
      ON CONFLICT DO NOTHING
      RETURNING "findingId"
    )
    UPDATE "Finding" AS f
    SET "status" = i."previousStatus", "triagedAt" = i."previousTriagedAt", "incidentId" = NULL,
      "triageOpId" = ${undo.id}::uuid, "updatedAt" = ${now.toISOString()}::timestamptz
    FROM taken AS t
    JOIN "TriageOperationItem" AS i
      ON i."operationId" = ${undoneId}::uuid AND i."findingId" = t."findingId" AND i."tenantId" = ${undo.tenantId}::uuid
    WHERE f."id" = t."findingId" AND f."tenantId" = ${undo.tenantId}::uuid`;
}

/** Quantos alertas de um lote a operação já mudou (o "continuar" do desfazer relê do começo). */
export async function countItems(
  tx: Tx,
  tenantId: string,
  operationId: string,
  ids: readonly string[],
): Promise<number> {
  return tx.triageOperationItem.count({ where: { operationId, tenantId, findingId: { in: [...ids] } } });
}

// ---------------------------------------------------------------------------------------------------
// Incidente e casos
// ---------------------------------------------------------------------------------------------------

/** O incidente do cliente, com a linha travada. */
export async function lockIncident(
  tx: Tx,
  tenantId: string,
  incidentId: string,
): Promise<{ status: string; severity: FindingSeverity } | null> {
  const [row] = await tx.$queryRaw<{ status: string; severity: FindingSeverity }[]>`
    SELECT i."status"::text AS "status", i."severity"::text AS "severity"
    FROM "Incident" AS i
    WHERE i."id" = ${incidentId}::uuid AND i."tenantId" = ${tenantId}::uuid
    FOR UPDATE`;
  return row ?? null;
}

/** Encerra o incidente que o desfazer deixou só com o alerta que o abriu. */
export async function resolveIncident(
  tx: Tx,
  tenantId: string,
  incidentId: string,
  now: Date,
): Promise<boolean> {
  const at = now.toISOString();
  const count = await tx.$executeRaw`
    UPDATE "Incident"
    SET "status" = 'resolved', "resolvedAt" = ${at}::timestamptz, "updatedAt" = ${at}::timestamptz
    WHERE "id" = ${incidentId}::uuid AND "tenantId" = ${tenantId}::uuid AND "status" <> 'resolved'`;
  return count === 1;
}

/**
 * Os casos promovidos inteiros apontam para o incidente. O que já aponta para outro, ainda aberto, fica como está. Com o
 * lock dos alertas do cliente, depois de mexer nos alertas.
 */
export async function pointCasesAt(
  tx: Tx,
  tenantId: string,
  operationId: string,
  incidentId: string,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "AlertCase" AS c SET "incidentId" = ${incidentId}::uuid
    WHERE c."tenantId" = ${tenantId}::uuid
      AND c."id" IN (
        SELECT f."caseId"
        FROM "TriageOperation" AS o
        CROSS JOIN jsonb_array_elements_text(o."target" -> 'ids') AS t(id)
        JOIN "Finding" AS f ON f."id" = t.id::uuid AND f."tenantId" = o."tenantId"
        WHERE o."id" = ${operationId}::uuid AND o."tenantId" = ${tenantId}::uuid
      )
      AND NOT EXISTS (
        SELECT 1 FROM "Incident" AS i
        WHERE i."id" = c."incidentId" AND i."tenantId" = c."tenantId" AND i."status" <> 'resolved'
      )`;
}

export async function unpointCases(tx: Tx, tenantId: string, incidentId: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE "AlertCase" SET "incidentId" = NULL
    WHERE "tenantId" = ${tenantId}::uuid AND "incidentId" = ${incidentId}::uuid`;
}

/**
 * Depois de devolver alertas, que voltam pendentes: o caso deles que tinha sido selado por estar tratado reabre, se ninguém
 * está aberto com a chave dele (um por chave, o selado por último). Com um sucessor aberto, os alertas voltam a ele como
 * pendentes e ele continua selado e listado: os alertas seguintes da chave são do sucessor. Sob o lock dos alertas do
 * cliente, que a atribuição também toma: nenhum caso abre com a chave no meio.
 */
export async function reopenCases(tx: Tx, tenantId: string, findingIds: readonly string[]): Promise<number> {
  return tx.$executeRaw`
    WITH back AS (
      SELECT DISTINCT ON (c."groupKey") c."id"
      FROM "AlertCase" AS c
      WHERE c."tenantId" = ${tenantId}::uuid
        AND c."id" IN (
          SELECT f."caseId" FROM "Finding" AS f
          WHERE f."id" = ANY(${[...findingIds]}::uuid[]) AND f."tenantId" = ${tenantId}::uuid
        )
        AND c."openKey" IS NULL AND c."sealReason" = 'treated'
        AND NOT EXISTS (
          SELECT 1 FROM "AlertCase" AS o WHERE o."tenantId" = c."tenantId" AND o."openKey" = c."groupKey"
        )
      ORDER BY c."groupKey", c."sealedAt" DESC, c."id" DESC
    )
    UPDATE "AlertCase" AS c SET "openKey" = c."groupKey", "sealedAt" = NULL, "sealReason" = NULL
    FROM back
    WHERE c."id" = back."id" AND c."tenantId" = ${tenantId}::uuid`;
}
