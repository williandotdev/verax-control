import { AWS_FINDING_RULES } from '../aws/findings/finding-rules.js';
import { type CaseQueue, type FindingSeverity, Prisma } from '../generated/prisma/client.js';
import type { NoticeSeverity } from '../notifications/finding-notices.js';
import {
  CASE_FALLBACK_WINDOW_MS,
  CASE_GROWTH_FACTOR,
  CASE_GROWTH_LOOKBACK_MS,
  CASE_GROWTH_WINDOW_MS,
  CASE_NOTICE_MEMORY_MS,
  CASE_NOTICE_REARM_MS,
  CASE_SKIP,
  type DetectionFacts,
  type GrowthFacts,
} from './case-notice-policy.js';
import type { CaseNoticeEpoch } from './case-notice-regime.js';

/**
 * O SQL dos avisos por caso. Roda no cliente base (só o sistema grava casos), com o cliente em todo comando, e só lê casos,
 * alertas, incidentes e avisos. Nada do evento sai daqui: ids, severidades, horários e contagens.
 *
 * A severidade é um enum do banco na ordem `critical`, `high`, `medium`, `low`: "pior ou igual" é `<=`.
 */
type Db = Pick<Prisma.TransactionClient, '$queryRaw'>;
type Tx = Prisma.TransactionClient;

const at = (moment: Date): Prisma.Sql => Prisma.sql`${moment.toISOString()}::timestamptz`;
const before = (now: Date, milliseconds: number): Prisma.Sql => at(new Date(now.getTime() - milliseconds));

/** O alerta `f` está pendente: novo ou em análise, fora de incidente. */
const PENDING = Prisma.sql`f."incidentId" IS NULL AND f."status" IN ('new', 'investigating')`;

/**
 * O aviso `n` ainda não chegou a ninguém e nunca foi tentado: pode ser trocado por outro. O status vai como texto de propósito:
 * quem procura o aviso de um alerta ou de um caso usa o índice do alerta ou do caso, e nunca o da fila, que o banco acharia
 * melhor com as estatísticas de antes de uma rajada (e leria a fila inteira a cada alerta).
 */
const INTACT = Prisma.sql`n."status"::text = 'pending' AND n."attempts" = 0 AND cardinality(n."deliveredUserIds") = 0
      AND cardinality(n."digestedUserIds") = 0 AND n."escalationDelivery" IS NULL`;

/** O aviso `n` é o do alerta `f`, alerta por alerta (`finding:<id>`, a chave de `alertNotices`). */
const OF_ALERT = Prisma.sql`n."findingId" = f."id" AND n."tenantId" = f."tenantId" AND n."caseId" IS NULL
      AND n."dedupeKey" = 'finding:' || f."id"::text`;

/** O aviso `n` foi trocado ou deixou de valer antes de chegar a alguém: sozinho, ele não prova que alguém foi avisado. */
const UNSAID = Prisma.sql`n."status"::text = 'skipped'
        AND COALESCE(n."lastError", '') IN (${CASE_SKIP.treated}, ${CASE_SKIP.byCase})`;

/**
 * O aviso de caso `n` vale como aviso dado: na fila, enviado, ou pulado por falta de quem receba. O que foi pulado porque o
 * caso já estava tratado (ou foi trocado por outro) não chegou a ninguém, e o que falhou em todas as tentativas é refeito
 * depois de um tempo.
 */
const stands = (now: Date): Prisma.Sql => Prisma.sql`NOT (${UNSAID})
      AND NOT (n."status" = 'failed' AND n."updatedAt" < ${before(now, CASE_NOTICE_REARM_MS)})`;

export interface NoticeContext {
  tenantId: string;
  now: Date;
  epoch: CaseNoticeEpoch;
  /**
   * O aviso de um alerta que está na fila, intacto, vale como aviso dado? Não, com os avisos por caso (ele é trocado pelo do
   * caso); sim, na devolução ao aviso por alerta (ele vai sair).
   */
  pendingCounts: boolean;
}

/**
 * O alerta `f`, do caso `k`, já foi avisado a alguém, de algum jeito:
 * - o incidente para onde o caso foi promovido veio depois dele, e tem o próprio aviso;
 * - o aviso dele, alerta por alerta, já não está intacto na fila e foi de severidade igual ou pior;
 * - é do passado: chegou antes dos avisos por caso, e não mudou depois (o caso já marcado não precisa disso), e não há
 *   aviso dele que ficou sem sair;
 * - passou do tempo em que se sabe;
 * - voltou de um incidente por um desfazer: o incidente já tinha avisado.
 *
 * O aviso do próprio caso fica de fora: quem o compara é `detectionFacts`.
 */
function announced({ now, epoch, pendingCounts }: NoticeContext): Prisma.Sql {
  return Prisma.sql`(
        COALESCE(f."createdAt" <= k.incident_at, false)
        OR f."createdAt" < ${before(now, CASE_NOTICE_MEMORY_MS)}
        OR (
          f."createdAt" < ${at(epoch.mark)} AND (k.told OR f."updatedAt" < ${at(epoch.mark)})
          AND NOT EXISTS (
            SELECT 1 FROM "Notification" AS n
            WHERE ${OF_ALERT} AND ((${UNSAID}) OR (NOT ${pendingCounts}::boolean AND ${INTACT}))
          )
        )
        OR EXISTS (
          SELECT 1 FROM "Notification" AS n
          WHERE ${OF_ALERT} AND n."severity" <= f."severity"
            AND NOT (${UNSAID}) AND (${pendingCounts}::boolean OR NOT (${INTACT}))
        )
        OR EXISTS (
          SELECT 1 FROM "TriageOperation" AS o
          JOIN "TriageOperation" AS u ON u."id" = o."undoOfId" AND u."tenantId" = o."tenantId"
          WHERE o."id" = f."triageOpId" AND o."tenantId" = f."tenantId" AND o."action" = 'undo'
            AND u."action" IN ('promote', 'attach')
        )
      )`;
}

// ---------------------------------------------------------------------------------------------------
// Detecção
// ---------------------------------------------------------------------------------------------------

/**
 * Os casos de detecção pendentes que podem ter o que avisar, um trecho por vez: a pior severidade pendente passa da avisada,
 * chegou alerta depois da virada, ou um aviso dele deixou de valer antes de sair. Pelo índice `(tenantId, queue, pending)`.
 */
export async function detectionPage(
  db: Db,
  { tenantId, epoch }: NoticeContext,
  after: string | null,
  limit: number,
): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT c."id"::text AS "id"
    FROM "AlertCase" AS c
    WHERE c."tenantId" = ${tenantId}::uuid AND c."queue" = 'detection' AND c."pending"
      AND (c."pendingCritical" > 0 OR c."pendingHigh" > 0)
      AND (
        c."noticedSeverity" IS NULL
        OR c."noticedSeverity" > (CASE WHEN c."pendingCritical" > 0 THEN 'critical' ELSE 'high' END)::"FindingSeverity"
        OR c."lastAlertAt" >= ${at(epoch.mark)}
        OR EXISTS (
          SELECT 1 FROM "Notification" AS n
          WHERE n."caseId" = c."id" AND n."tenantId" = c."tenantId" AND ${UNSAID}
        )
      )
      AND (${after}::uuid IS NULL OR c."id" > ${after}::uuid)
    ORDER BY c."id"
    LIMIT ${limit}::integer`;
  return rows.map((row) => row.id);
}

/** Os casos de detecção de `ids` ainda pendentes (`k`), com a pior severidade e os avisos que valem (`s`). */
function detectionCases({ tenantId, now }: NoticeContext, ids: readonly string[]): Prisma.Sql {
  return Prisma.sql`
    WITH RECURSIVE k AS MATERIALIZED (
      SELECT c."id", c."tenantId", c."anchorFindingId" AS anchor, c."noticedSeverity" AS noticed,
        c."lastAlertAt" AS last_alert, c."previousCaseId" AS previous, c."sealReason" AS seal, c."sealedAt" AS sealed_at,
        c."total", c."investigatingCount" AS investigating, w.worst,
        COALESCE(c."noticedSeverity" <= w.worst, false) AS told, i."createdAt" AS incident_at
      FROM "AlertCase" AS c
      CROSS JOIN LATERAL (
        SELECT (CASE WHEN c."pendingCritical" > 0 THEN 'critical' ELSE 'high' END)::"FindingSeverity" AS worst
      ) AS w
      LEFT JOIN "Incident" AS i ON i."id" = c."incidentId" AND i."tenantId" = c."tenantId"
      WHERE c."tenantId" = ${tenantId}::uuid AND c."id" = ANY(${[...ids]}::uuid[]) AND c."queue" = 'detection'
        AND c."pending" AND (c."pendingCritical" > 0 OR c."pendingHigh" > 0)
    ), chain AS (
      -- O caso dividido herda os avisos que o original tinha até a divisão.
      SELECT k."id" AS case_id, k."id" AS member, k.previous, k.seal, k.sealed_at, 'infinity'::timestamptz AS until,
        0 AS depth
      FROM k
      UNION ALL
      SELECT h.case_id, p."id", p."previousCaseId", p."sealReason", p."sealedAt", least(h.until, h.sealed_at), h.depth + 1
      FROM chain AS h
      JOIN "AlertCase" AS p ON p."id" = h.previous AND p."tenantId" = ${tenantId}::uuid
      WHERE h.seal = 'split' AND h.depth < 10
    ), s AS MATERIALIZED (
      SELECT k."id" AS case_id, max(v."createdAt") FILTER (WHERE v."severity" <= k.worst) AS worst_at,
        max(v."createdAt") AS any_at, max(v."createdAt") FILTER (WHERE v.growth) AS growth_at
      FROM k
      LEFT JOIN LATERAL (
        SELECT n."severity", n."createdAt", n."dedupeKey" LIKE 'case:%:growth:%' AS growth
        FROM chain AS h
        JOIN "Notification" AS n ON n."caseId" = h.member AND n."tenantId" = ${tenantId}::uuid
        WHERE h.case_id = k."id" AND n."createdAt" <= h.until AND n."dedupeKey" LIKE 'case:%' AND ${stands(now)}
      ) AS v ON true
      GROUP BY k."id"
    )`;
}

/** Os alertas pendentes da pior severidade do caso `k`. */
const WORST_OF_CASE = Prisma.sql`f."tenantId" = k."tenantId" AND f."caseId" = k."id" AND f."severity" = k.worst
          AND ${PENDING}`;

/** O alerta do aviso de um caso: o que o abriu, se ainda está nele; senão, o primeiro pendente da pior severidade. */
const NOTICE_FINDING = Prisma.sql`COALESCE(
        (SELECT f."id" FROM "Finding" AS f
          WHERE f."id" = k.anchor AND f."tenantId" = k."tenantId" AND f."caseId" = k."id"),
        (SELECT f."id" FROM "Finding" AS f WHERE ${WORST_OF_CASE} ORDER BY f."createdAt", f."id" LIMIT 1)
      )::text`;

export interface DetectionRow extends Omit<DetectionFacts, 'waiting'> {
  id: string;
  /** O alerta do aviso (`NOTICE_FINDING`), se pedido. */
  findingId: string | null;
}

/**
 * O que decide o aviso de cada caso e, com `withFinding`, o alerta dele. O `OFFSET 0` deixa cada conta ser feita uma vez: a do
 * que é novo só é feita se a do que já foi avisado não resolve.
 */
export function detectionFacts(
  db: Db,
  context: NoticeContext,
  ids: readonly string[],
  { withFinding }: { withFinding: boolean },
): Promise<DetectionRow[]> {
  const elsewhere = announced(context);
  return db.$queryRaw<DetectionRow[]>`
    ${detectionCases(context, ids)}
    SELECT k."id"::text AS "id", k.worst::text AS "worst", k.noticed::text AS "noticed", o.told AS "told",
      r.fresh AS "fresh", CASE WHEN ${withFinding}::boolean THEN ${NOTICE_FINDING} END AS "findingId"
    FROM k
    JOIN s ON s.case_id = k."id"
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN NOT k.told THEN false
        WHEN k.last_alert < s.worst_at THEN true
        WHEN EXISTS (
          SELECT 1 FROM "Finding" AS f WHERE ${WORST_OF_CASE} AND f."createdAt" <= s.worst_at
        ) THEN true
        ELSE EXISTS (SELECT 1 FROM "Finding" AS f WHERE ${WORST_OF_CASE} AND ${elsewhere})
      END AS told
      OFFSET 0
    ) AS o
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN o.told THEN false
        ELSE EXISTS (SELECT 1 FROM "Finding" AS f WHERE ${WORST_OF_CASE} AND NOT ${elsewhere})
      END AS fresh
      OFFSET 0
    ) AS r
    ORDER BY k."id"`;
}

export interface GrowthRow extends GrowthFacts {
  id: string;
  worst: NoticeSeverity;
  findingId: string | null;
}

/** O que mudou nos casos (os já avisados, para quem chama) que receberam alerta há pouco, depois do último aviso deles. */
export function growthFacts(db: Db, context: NoticeContext, ids: readonly string[]): Promise<GrowthRow[]> {
  const { now, epoch } = context;
  return db.$queryRaw<GrowthRow[]>`
    ${detectionCases(context, ids)}
    SELECT g."id"::text AS "id", g.worst::text AS "worst", g."total" AS "total", g.growth_at AS "lastGrowthAt",
      (SELECT ${NOTICE_FINDING} FROM k WHERE k."id" = g."id") AS "findingId",
      (SELECT count(*)::integer FROM (
        SELECT 1 FROM "Finding" AS f
        WHERE f."tenantId" = g."tenantId" AND f."caseId" = g."id"
          AND f."createdAt" <= greatest(g.since, ${before(now, CASE_GROWTH_WINDOW_MS)})
        LIMIT g."total" / ${CASE_GROWTH_FACTOR}::integer + 1
      ) AS e) AS "earlier",
      (
        EXISTS (
          SELECT 1 FROM "Finding" AS f
          WHERE f."tenantId" = g."tenantId" AND f."caseId" = g."id" AND f."createdAt" <= g.since
        )
        AND EXISTS (
          SELECT t.tactic FROM "Finding" AS f CROSS JOIN unnest(f."mitreTactics") AS t(tactic)
          WHERE f."tenantId" = g."tenantId" AND f."caseId" = g."id" AND f."createdAt" > g.since AND ${PENDING}
          EXCEPT
          SELECT t.tactic FROM "Finding" AS f CROSS JOIN unnest(f."mitreTactics") AS t(tactic)
          WHERE f."tenantId" = g."tenantId" AND f."caseId" = g."id" AND f."createdAt" <= g.since
        )
      ) AS "newTactic",
      (g.investigating > 0 AND EXISTS (
        SELECT 1 FROM "Finding" AS f
        WHERE f."tenantId" = g."tenantId" AND f."caseId" = g."id" AND f."incidentId" IS NULL AND f."status" = 'new'
          AND f."severity" = 'critical'
          AND f."createdAt" > greatest(g.since, (
            SELECT min(a."triagedAt") FROM "Finding" AS a
            WHERE a."tenantId" = g."tenantId" AND a."caseId" = g."id" AND a."incidentId" IS NULL
              AND a."status" = 'investigating'
          ))
      )) AS "newCritical"
    FROM (
      SELECT k.*, s.growth_at, COALESCE(s.any_at, ${at(epoch.activatedAt)}) AS since
      FROM k JOIN s ON s.case_id = k."id"
      WHERE k.last_alert > ${before(now, CASE_GROWTH_LOOKBACK_MS)}
        AND k.last_alert > COALESCE(s.any_at, ${at(epoch.activatedAt)})
      OFFSET 0
    ) AS g
    ORDER BY g."id"`;
}

// ---------------------------------------------------------------------------------------------------
// Vulnerabilidade e postura
// ---------------------------------------------------------------------------------------------------

/** Um caso de vulnerabilidade ou postura com crítico pendente além do que foi avisado. */
export interface CriticalCase {
  id: string;
  /** O crítico pendente mais antigo que ninguém avisou; null se todos já foram (a virada). */
  findingId: string | null;
}

/** Os casos de vulnerabilidade e postura com crítico pendente ainda não avisado pelo caso, um trecho por vez. */
export function criticalCases(
  db: Db,
  context: NoticeContext,
  after: string | null,
  limit: number,
  ids: readonly string[] | null = null,
): Promise<CriticalCase[]> {
  const only = ids === null ? null : [...ids];
  return db.$queryRaw<CriticalCase[]>`
    WITH k AS MATERIALIZED (
      SELECT c."id", c."tenantId", false AS told, i."createdAt" AS incident_at
      FROM "AlertCase" AS c
      LEFT JOIN "Incident" AS i ON i."id" = c."incidentId" AND i."tenantId" = c."tenantId"
      WHERE c."tenantId" = ${context.tenantId}::uuid AND c."queue" IN ('vulnerability', 'posture') AND c."pending"
        AND c."pendingCritical" > 0
        AND (${only}::uuid[] IS NULL OR c."id" = ANY(${only}::uuid[]))
        AND (c."noticedSeverity" IS DISTINCT FROM 'critical' OR ${only}::uuid[] IS NOT NULL)
        AND (${after}::uuid IS NULL OR c."id" > ${after}::uuid)
      ORDER BY c."id"
      LIMIT ${limit}::integer
    )
    SELECT k."id"::text AS "id", u."id"::text AS "findingId"
    FROM k
    LEFT JOIN LATERAL (
      SELECT f."id" FROM "Finding" AS f
      WHERE f."tenantId" = k."tenantId" AND f."caseId" = k."id" AND f."severity" = 'critical' AND ${PENDING}
        AND NOT ${announced(context)}
      ORDER BY f."createdAt", f."id"
      LIMIT 1
    ) AS u ON true
    ORDER BY k."id"`;
}

/** Os críticos pendentes de vulnerabilidade e postura que nunca foram avisados, para avisar um a um (a devolução). */
export function unannouncedCriticals(
  db: Db,
  context: NoticeContext,
  limit: number,
): Promise<{ id: string; severity: FindingSeverity }[]> {
  return db.$queryRaw<{ id: string; severity: FindingSeverity }[]>`
    WITH k AS MATERIALIZED (
      SELECT c."id", c."tenantId", false AS told, i."createdAt" AS incident_at
      FROM "AlertCase" AS c
      LEFT JOIN "Incident" AS i ON i."id" = c."incidentId" AND i."tenantId" = c."tenantId"
      WHERE c."tenantId" = ${context.tenantId}::uuid AND c."queue" IN ('vulnerability', 'posture') AND c."pending"
        AND c."pendingCritical" > 0 AND c."noticedSeverity" IS DISTINCT FROM 'critical'
    )
    SELECT f."id"::text AS "id", f."severity"::text AS "severity"
    FROM k
    JOIN "Finding" AS f ON f."tenantId" = k."tenantId" AND f."caseId" = k."id"
    WHERE f."severity" = 'critical' AND ${PENDING}
      AND NOT EXISTS (SELECT 1 FROM "Notification" AS n WHERE ${OF_ALERT})
      AND NOT ${announced(context)}
    ORDER BY f."createdAt", f."id"
    LIMIT ${limit}::integer`;
}

/** O resumo diário tem o que dizer? O pior caso com alerta alto ou crítico pendente e, com `since`, se há novidade. */
export async function dailyContent(
  db: Db,
  tenantId: string,
  { since, until }: { since: Date | null; until: Date },
): Promise<{ caseId: string; findingId: string } | null> {
  const [row] = await db.$queryRaw<{ caseId: string; findingId: string }[]>`
    WITH k AS MATERIALIZED (
      SELECT c."id", c."tenantId", c."pendingCritical", c."pendingHigh", c."lastAlertAt", c."openedAt"
      FROM "AlertCase" AS c
      WHERE c."tenantId" = ${tenantId}::uuid AND c."queue" IN ('vulnerability', 'posture') AND c."pending"
        AND (c."pendingCritical" > 0 OR c."pendingHigh" > 0)
    )
    SELECT w."id"::text AS "caseId", f."id"::text AS "findingId"
    FROM (SELECT * FROM k ORDER BY k."pendingCritical" DESC, k."pendingHigh" DESC, k."id" LIMIT 1) AS w
    CROSS JOIN LATERAL (
      SELECT f."id" FROM "Finding" AS f
      WHERE f."tenantId" = w."tenantId" AND f."caseId" = w."id" AND ${PENDING}
      ORDER BY f."severity", f."createdAt", f."id"
      LIMIT 1
    ) AS f
    WHERE EXISTS (
      SELECT 1 FROM k
      WHERE (k."lastAlertAt" <= ${at(until)} AND (${since === null}::boolean OR k."lastAlertAt" > ${at(since ?? until)}))
        OR (k."openedAt" <= ${at(until)} AND (${since === null}::boolean OR k."openedAt" > ${at(since ?? until)}))
    )`;
  return row ?? null;
}

// ---------------------------------------------------------------------------------------------------
// A virada: os avisos alerta por alerta que estão na fila
// ---------------------------------------------------------------------------------------------------

/** O aviso do caso de detecção `c` (ou do original de que ele foi dividido) que cobre o aviso de alerta `w`. */
const coveredByCase = (now: Date): Prisma.Sql => Prisma.sql`EXISTS (
        SELECT 1 FROM (
          SELECT m.* FROM "Notification" AS m
          WHERE m."tenantId" = c."tenantId" AND m."severity" <= w."severity" AND m."dedupeKey" LIKE 'case:%'
            AND m."caseId" IN (c."id", CASE WHEN c."sealReason" = 'split' THEN c."previousCaseId" END)
          OFFSET 0
        ) AS n
        WHERE ${stands(now)}
      )`;

/** O aviso imediato de vulnerabilidade e postura que cobre o aviso de alerta `w`. */
const coveredByCritical = (criticalAt: Date | null): Prisma.Sql =>
  criticalAt === null
    ? Prisma.sql`false`
    : Prisma.sql`(c."noticedSeverity" = 'critical' AND w."createdAt" <= ${at(criticalAt)})`;

/**
 * Os avisos de alerta na fila, com o alerta e o caso dele. Na prática, poucos ou nenhum: só na virada. A fila é lida primeiro
 * (`OFFSET 0`), e o resto são buscas por chave, sem depender do que o banco acha que há nela.
 */
const waitingNotices = (tenantId: string): Prisma.Sql => Prisma.sql`(
        SELECT n."id", n."tenantId", n."findingId", n."severity", n."createdAt" FROM "Notification" AS n
        WHERE n."status" = 'pending' AND n."tenantId" = ${tenantId}::uuid AND n."caseId" IS NULL
          AND n."dedupeKey" LIKE 'finding:%' AND n."kind" IN ('critical_finding', 'high_finding') AND ${INTACT}
        OFFSET 0
      ) AS w
      CROSS JOIN LATERAL (
        SELECT f.* FROM "Finding" AS f WHERE f."id" = w."findingId" AND f."tenantId" = w."tenantId" OFFSET 0
      ) AS f
      CROSS JOIN LATERAL (
        SELECT c.* FROM "AlertCase" AS c WHERE c."id" = f."caseId" AND c."tenantId" = f."tenantId" OFFSET 0
      ) AS c`;

/** O aviso de alerta `w`, do alerta pendente `f` do caso `c`, que nenhum aviso de caso cobre. */
const uncovered = (now: Date, criticalAt: Date | null): Prisma.Sql => Prisma.sql`CASE
        WHEN c."queue" = 'detection' THEN NOT ${coveredByCase(now)}
        ELSE w."severity" = 'critical' AND NOT ${coveredByCritical(criticalAt)}
      END`;

/**
 * Os casos com aviso de um alerta na fila, intacto, que nenhum aviso de caso cobre: um aviso do caso troca todos. Na
 * vulnerabilidade e na postura, só os críticos (os altos saem como antes, e o resumo diário vem depois).
 */
export function waitingCases(
  db: Db,
  { tenantId, now }: Pick<NoticeContext, 'tenantId' | 'now'>,
  criticalAt: Date | null,
  limit: number,
): Promise<{ id: string; queue: CaseQueue }[]> {
  return db.$queryRaw<{ id: string; queue: CaseQueue }[]>`
    SELECT DISTINCT c."id"::text AS "id", c."queue"::text AS "queue"
    FROM ${waitingNotices(tenantId)}
    WHERE ${PENDING} AND ${uncovered(now, criticalAt)}
    LIMIT ${limit}::integer`;
}

/**
 * Destes casos de detecção, os que ainda estão assim, com o lock do cliente na mão: de cada caso, os alertas pendentes e, de
 * cada um, o aviso dele, até achar um. Os `OFFSET 0` prendem essa ordem: começando pela fila de avisos, que na virada é longa,
 * levaria um segundo por trecho.
 */
export async function stillWaiting(
  db: Db,
  { tenantId, now }: Pick<NoticeContext, 'tenantId' | 'now'>,
  ids: readonly string[],
): Promise<Set<string>> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT c."id"::text AS "id"
    FROM "AlertCase" AS c
    CROSS JOIN LATERAL (
      SELECT 1
      FROM (
        SELECT f."id", f."tenantId" FROM "Finding" AS f
        WHERE f."tenantId" = c."tenantId" AND f."caseId" = c."id" AND ${PENDING}
        OFFSET 0
      ) AS f
      WHERE EXISTS (
        SELECT 1 FROM (
          SELECT n."severity" FROM "Notification" AS n WHERE ${OF_ALERT} AND ${INTACT} OFFSET 0
        ) AS w
        WHERE NOT ${coveredByCase(now)}
        OFFSET 0
      )
      LIMIT 1
    ) AS one
    WHERE c."tenantId" = ${tenantId}::uuid AND c."id" = ANY(${[...ids]}::uuid[]) AND c."queue" = 'detection'`;
  return new Set(rows.map((row) => row.id));
}

/**
 * Tira da fila os avisos de alerta que não precisam mais sair, um lote por vez: o caso do alerta já tem o aviso dele (ou
 * entrou no aviso imediato), alguém tratou o alerta depois do aviso, ou o incidente para onde ele foi já avisou. O alerta
 * que subiu de severidade já tratado, ou já num incidente, não é de caso nenhum: o aviso dele fica.
 */
export async function skipWaiting(
  db: Pick<Tx, '$queryRaw' | '$executeRaw'>,
  { tenantId, now }: Pick<NoticeContext, 'tenantId' | 'now'>,
  criticalAt: Date | null,
  limit: number,
): Promise<number> {
  const chosen = await db.$queryRaw<{ id: string; reason: string }[]>`
    SELECT r."id"::text AS "id", r.reason AS "reason"
    FROM (
      SELECT w."id", CASE
        WHEN f."incidentId" IS NOT NULL THEN
          CASE WHEN i."createdAt" >= w."createdAt" THEN ${CASE_SKIP.byIncident}::text END
        WHEN f."status" NOT IN ('new', 'investigating') THEN
          CASE WHEN f."triagedAt" >= w."createdAt" THEN ${CASE_SKIP.treated}::text END
        WHEN c."queue" = 'detection' THEN
          CASE WHEN ${coveredByCase(now)} THEN ${CASE_SKIP.byCase}::text END
        WHEN w."severity" = 'critical' AND ${coveredByCritical(criticalAt)} THEN ${CASE_SKIP.byCase}::text
      END AS reason
      FROM ${waitingNotices(tenantId)}
      LEFT JOIN LATERAL (
        SELECT i."createdAt" FROM "Incident" AS i WHERE i."id" = f."incidentId" AND i."tenantId" = f."tenantId" OFFSET 0
      ) AS i ON true
    ) AS r
    WHERE r.reason IS NOT NULL
    LIMIT ${limit}::integer`;
  if (chosen.length === 0) return 0;
  await db.$executeRaw`
    UPDATE "Notification" AS n
    SET "status" = 'skipped', "lastError" = v.reason, "updatedAt" = ${at(now)}
    FROM unnest(${chosen.map((row) => row.id)}::uuid[], ${chosen.map((row) => row.reason)}::text[]) AS v(id, reason)
    WHERE n."id" = v.id AND n."tenantId" = ${tenantId}::uuid AND ${INTACT}`;
  return chosen.length;
}

// ---------------------------------------------------------------------------------------------------
// O que ainda não tem caso
// ---------------------------------------------------------------------------------------------------

/**
 * Os alertas que são sempre de vulnerabilidade ou de postura, pelas colunas (a chave, que decide a fila, é de
 * `case-key.ts`; um teste confere que as duas concordam). Na dúvida, fica de fora daqui: é detecção.
 */
const QUIET_QUEUES = Prisma.sql`(f."logSource" IN ('inspector', 'access_analyzer')
        OR (f."logSource" = 'security_hub' AND f."ruleId" = ${AWS_FINDING_RULES.securityHubControl.id}))`;

/**
 * Os alertas altos e críticos ainda sem caso, que chegaram depois da virada e antes de `until` e nunca foram avisados: os
 * críticos primeiro. O alto de vulnerabilidade e de postura só entra com `quiet` (o que ele tem, com caso, é o resumo
 * diário). Pelo índice da fila dos casos (`Finding_case_outbox_idx`), com o predicado dele.
 */
export function unassignedUnnoticed(
  db: Db,
  { tenantId, epoch }: Pick<NoticeContext, 'tenantId' | 'epoch'>,
  until: Date,
  { quiet, limit }: { quiet: boolean; limit: number },
): Promise<{ id: string; severity: FindingSeverity }[]> {
  return db.$queryRaw<{ id: string; severity: FindingSeverity }[]>`
    SELECT f."id"::text AS "id", f."severity"::text AS "severity"
    FROM "Finding" AS f
    WHERE f."tenantId" = ${tenantId}::uuid
      AND f."caseId" IS NULL AND f."incidentId" IS NULL AND f."status" IN ('new', 'investigating')
      AND f."createdAt" >= ${at(epoch.mark)} AND f."createdAt" <= ${at(until)}
      AND (f."severity" = 'critical' OR (f."severity" = 'high' AND (${quiet}::boolean OR NOT ${QUIET_QUEUES})))
      AND NOT EXISTS (SELECT 1 FROM "Notification" AS n WHERE ${OF_ALERT})
    ORDER BY f."severity", f."createdAt", f."id"
    LIMIT ${limit}::integer`;
}

/**
 * A rede de segurança: com a decisão dos casos falhando, os alertas altos e críticos de casos de detecção que chegaram até
 * `until` (e há no máximo um dia) e de que ninguém avisou, nem alerta por alerta, nem por um aviso do caso. De propósito uma
 * consulta simples, sem nada da decisão que pode ter falhado: na dúvida, avisa de novo.
 */
export function unnoticedOfCases(
  db: Db,
  { tenantId, epoch, now }: Pick<NoticeContext, 'tenantId' | 'epoch' | 'now'>,
  until: Date,
  limit: number,
): Promise<{ id: string; severity: FindingSeverity }[]> {
  return db.$queryRaw<{ id: string; severity: FindingSeverity }[]>`
    SELECT f."id"::text AS "id", f."severity"::text AS "severity"
    FROM "Finding" AS f
    JOIN "AlertCase" AS c ON c."id" = f."caseId" AND c."tenantId" = f."tenantId"
    WHERE f."tenantId" = ${tenantId}::uuid AND ${PENDING} AND f."severity" IN ('critical', 'high')
      AND c."queue" = 'detection'
      AND f."createdAt" >= greatest(${at(epoch.mark)}, ${before(now, CASE_FALLBACK_WINDOW_MS)})
      AND f."createdAt" <= ${at(until)}
      AND NOT EXISTS (SELECT 1 FROM "Notification" AS n WHERE ${OF_ALERT})
      AND NOT EXISTS (
        SELECT 1 FROM "Notification" AS n
        WHERE n."caseId" = c."id" AND n."tenantId" = c."tenantId" AND n."severity" <= f."severity"
          AND NOT (${UNSAID})
      )
    ORDER BY f."severity", f."createdAt", f."id"
    LIMIT ${limit}::integer`;
}

// ---------------------------------------------------------------------------------------------------
// Na entrega
// ---------------------------------------------------------------------------------------------------

/** O aviso `n` já chegou a alguém. */
const REACHED = Prisma.sql`(cardinality(n."deliveredUserIds") + cardinality(n."digestedUserIds") > 0
        OR n."escalationDelivery" IS NOT DISTINCT FROM 'sent')`;

/**
 * Fecha, sem e-mail, os avisos de caso na fila que deixaram de valer: o caso saiu na retenção, foi promovido a um incidente
 * depois do aviso, ou não tem mais alerta pendente da severidade do aviso. O que já chegou a alguém numa tentativa fecha
 * como enviado. Devolve os fechados.
 */
export async function skipStaleCaseNotices(
  db: Db,
  now: Date,
  { ids, limit }: { ids: readonly string[] | null; limit: number },
): Promise<{ id: string; status: 'sent' | 'skipped' }[]> {
  const only = ids === null ? null : [...ids];
  const chosen = await db.$queryRaw<{ id: string; reason: string }[]>`
    SELECT r."id"::text AS "id", r.reason AS "reason"
    FROM (
      SELECT n."id", CASE
        WHEN c."id" IS NULL THEN ${CASE_SKIP.gone}::text
        WHEN i."status" <> 'resolved' AND i."createdAt" >= n."createdAt" THEN ${CASE_SKIP.byIncident}::text
        WHEN c."pendingCritical" = 0 AND (n."severity" = 'critical' OR c."pendingHigh" = 0) THEN
          CASE WHEN c."incidentCount" > 0 AND EXISTS (
            SELECT 1 FROM "Finding" AS f
            JOIN "Incident" AS p ON p."id" = f."incidentId" AND p."tenantId" = f."tenantId"
            WHERE f."tenantId" = c."tenantId" AND f."caseId" = c."id" AND p."createdAt" >= n."createdAt"
          ) THEN ${CASE_SKIP.byIncident}::text ELSE ${CASE_SKIP.treated}::text END
      END AS reason
      FROM "Notification" AS n
      LEFT JOIN "AlertCase" AS c ON c."id" = n."caseId" AND c."tenantId" = n."tenantId"
      LEFT JOIN "Incident" AS i ON i."id" = c."incidentId" AND i."tenantId" = c."tenantId"
      WHERE n."status" = 'pending' AND n."caseId" IS NOT NULL
        AND (${only}::uuid[] IS NULL OR n."id" = ANY(${only}::uuid[]))
    ) AS r
    WHERE r.reason IS NOT NULL
    LIMIT ${limit}::integer`;
  if (chosen.length === 0) return [];
  return db.$queryRaw<{ id: string; status: 'sent' | 'skipped' }[]>`
    UPDATE "Notification" AS n
    SET "status" = (CASE WHEN ${REACHED} THEN 'sent' ELSE 'skipped' END)::"NotificationStatus",
      "lastError" = CASE WHEN ${REACHED} THEN NULL ELSE v.reason END,
      "sentAt" = CASE WHEN ${REACHED} THEN ${at(now)} ELSE n."sentAt" END,
      "updatedAt" = ${at(now)}
    FROM unnest(${chosen.map((row) => row.id)}::uuid[], ${chosen.map((row) => row.reason)}::text[]) AS v(id, reason)
    WHERE n."id" = v.id AND n."status"::text = 'pending'
    RETURNING n."id"::text AS "id", n."status"::text AS "status"`;
}

/** As contagens de uma fila para o resumo diário e para o aviso imediato. */
export interface QueueCounts {
  queue: CaseQueue;
  cases: number;
  criticalCases: number;
  critical: number;
  high: number;
}

/** Os casos pendentes com alerta alto ou crítico, por fila de vulnerabilidade e postura. */
export function queueCounts(db: Db, tenantId: string): Promise<QueueCounts[]> {
  return db.$queryRaw<QueueCounts[]>`
    SELECT c."queue"::text AS "queue", count(*)::integer AS "cases",
      (count(*) FILTER (WHERE c."pendingCritical" > 0))::integer AS "criticalCases",
      COALESCE(sum(c."pendingCritical"), 0)::integer AS "critical",
      COALESCE(sum(c."pendingHigh"), 0)::integer AS "high"
    FROM "AlertCase" AS c
    WHERE c."tenantId" = ${tenantId}::uuid AND c."queue" IN ('vulnerability', 'posture') AND c."pending"
      AND (c."pendingCritical" > 0 OR c."pendingHigh" > 0)
    GROUP BY c."queue"
    ORDER BY c."queue"`;
}

/** Um caso numa lista de e-mail: o título do dicionário e as contagens. */
export interface ListedCase {
  id: string;
  queue: CaseQueue;
  title: string;
  critical: number;
  high: number;
}

/** Os piores casos de vulnerabilidade e postura, ou os críticos que receberam alerta por último. */
export function listedCases(
  db: Db,
  tenantId: string,
  which: 'worst' | 'latest_critical',
  limit: number,
): Promise<ListedCase[]> {
  const latest = which === 'latest_critical';
  return db.$queryRaw<ListedCase[]>`
    SELECT c."id"::text AS "id", c."queue"::text AS "queue", c."title", c."pendingCritical" AS "critical",
      c."pendingHigh" AS "high"
    FROM "AlertCase" AS c
    WHERE c."tenantId" = ${tenantId}::uuid AND c."queue" IN ('vulnerability', 'posture') AND c."pending"
      AND (c."pendingCritical" > 0 OR (c."pendingHigh" > 0 AND NOT ${latest}::boolean))
    ORDER BY CASE WHEN ${latest}::boolean THEN c."lastAlertAt" END DESC,
      c."pendingCritical" DESC, c."pendingHigh" DESC, c."lastAlertAt" DESC, c."id"
    LIMIT ${limit}::integer`;
}
