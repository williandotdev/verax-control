import type { CaseQueueName, MitreCount } from '@verax/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { caseSetWhere } from './case-read-store.js';
import { VULNERABILITY_FINDING_SQL } from './vulnerability-finding.js';

/**
 * O SQL dos casos no resumo da situação, no radar e nos relatórios. As mesmas regras de `case-read-store.ts`: tudo em
 * `$queryRaw` com parâmetros, e todo comando leva o cliente, que o service tira da sessão (`PrismaService.scopeTenantId`).
 * Só contas e ids: as linhas que vão para a tela são lidas depois, pelo escopo do cliente.
 */
type Db = Pick<Prisma.TransactionClient, '$queryRaw'>;

// ---------------------------------------------------------------------------------------------------
// Casos pendentes (resumo da situação)
// ---------------------------------------------------------------------------------------------------

export interface PendingCasesRow {
  queue: CaseQueueName;
  /** Os casos por pior severidade pendente. */
  critical: number;
  high: number;
  medium: number;
  low: number;
  /** A abertura do caso pendente mais antigo, em milissegundos desde 1970. */
  oldestAt: number;
  /** Os casos com algum alerta alto ou crítico ainda em "novo", fora de incidente. */
  untriaged: number;
}

export interface PendingCases {
  /** Só as filas com caso pendente. */
  queues: PendingCasesRow[];
  /**
   * Todos os alertas altos ou críticos em "novo", em caso ou não, dentro ou fora de incidente: o que o semáforo olha. Fora
   * as vulnerabilidades (`vulnerability-finding.ts`), que são risco mapeado e ficam só nos casos da fila delas.
   */
  untriagedFindings: number;
  /** Deles, os que nenhum caso pendente cobre: ainda sem caso, ou dentro de um incidente. Também sem as vulnerabilidades. */
  uncovered: number;
}

/**
 * Os casos pendentes por fila, cada um pela pior severidade pendente dele, e o que falta validar, num comando só (um
 * retrato só do banco).
 *
 * As contas saem dos casos, sem ler alerta: com alertas novos e altos, o caso tem um alto em "novo" se não há nenhum em
 * análise, se não há nenhum médio ou baixo, ou se os altos são mais que os em análise. No que sobra (altos só o bastante
 * para estarem todos em análise), procura-se um pelo índice `(tenantId, caseId, ...)`. Os alertas fora dos casos saem do
 * índice da fila da atribuição (o predicado dela, com os valores escritos) e do índice do incidente.
 */
export async function pendingCases(db: Db, tenantId: string): Promise<PendingCases> {
  const [row] = await db.$queryRaw<PendingCases[]>`
    WITH pending AS MATERIALIZED (
      SELECT c."id", c."queue", c."openedAt", c."newCount" AS fresh, c."investigatingCount" AS held,
        c."pendingCritical" AS critical, c."pendingHigh" AS high, c."pendingMedium" AS medium, c."pendingLow" AS low
      FROM "AlertCase" AS c
      WHERE c."tenantId" = ${tenantId}::uuid AND c."queue" IN ('detection', 'vulnerability', 'posture')
        AND c."pending"
    ), judged AS MATERIALIZED (
      SELECT p.*, CASE
        WHEN p.fresh = 0 OR p.critical + p.high = 0 THEN false
        WHEN p.held = 0 OR p.medium + p.low = 0 OR p.critical + p.high > p.held THEN true
        ELSE EXISTS (
          SELECT 1 FROM "Finding" AS f
          WHERE f."tenantId" = ${tenantId}::uuid AND f."caseId" = p."id" AND f."incidentId" IS NULL
            AND f."status" = 'new' AND f."severity" IN ('critical', 'high')
        )
      END AS untriaged
      FROM pending AS p
    ), queues AS (
      SELECT j."queue",
        count(*) FILTER (WHERE j.critical > 0) AS critical,
        count(*) FILTER (WHERE j.critical = 0 AND j.high > 0) AS high,
        count(*) FILTER (WHERE j.critical + j.high = 0 AND j.medium > 0) AS medium,
        count(*) FILTER (WHERE j.critical + j.high + j.medium = 0 AND j.low > 0) AS low,
        min(j."openedAt") AS oldest,
        count(*) FILTER (WHERE j.untriaged) AS untriaged
      FROM judged AS j
      GROUP BY j."queue"
    )
    SELECT
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'queue', q."queue", 'critical', q.critical, 'high', q.high, 'medium', q.medium, 'low', q.low,
          'oldestAt', floor(extract(epoch FROM q.oldest) * 1000), 'untriaged', q.untriaged
        ))
        FROM queues AS q
      ), '[]'::jsonb) AS "queues",
      (
        SELECT count(*)::integer FROM "Finding" AS f
        WHERE f."tenantId" = ${tenantId}::uuid AND f."status" = 'new' AND f."severity" IN ('critical', 'high')
          AND NOT ${VULNERABILITY_FINDING_SQL}
      ) AS "untriagedFindings",
      (
        SELECT count(*)::integer FROM "Finding" AS f
        WHERE f."tenantId" = ${tenantId}::uuid
          AND f."caseId" IS NULL AND f."incidentId" IS NULL AND f."status" IN ('new', 'investigating')
          AND f."status" = 'new' AND f."severity" IN ('critical', 'high') AND NOT ${VULNERABILITY_FINDING_SQL}
      ) + (
        SELECT count(*)::integer FROM "Incident" AS i
        JOIN "Finding" AS f ON f."incidentId" = i."id" AND f."tenantId" = ${tenantId}::uuid
        WHERE i."tenantId" = ${tenantId}::uuid AND f."status" = 'new' AND f."severity" IN ('critical', 'high')
          AND NOT ${VULNERABILITY_FINDING_SQL}
      ) AS "uncovered"`;
  return row ?? { queues: [], untriagedFindings: 0, uncovered: 0 };
}

// ---------------------------------------------------------------------------------------------------
// Radar
// ---------------------------------------------------------------------------------------------------

export interface RadarCases {
  /** Os casos de detecção ativos na janela, todos. */
  total: number;
  /** Os alertas deles na janela, pelo horário do evento (o mesmo do radar). */
  alerts: number;
  /** Os do radar, os mais graves primeiro, com os alertas da janela e o incidente aberto mais grave de um alerta deles. */
  shown: { id: string; recent: number; openIncidentId: string | null }[];
}

/**
 * Os casos de detecção ativos na janela, com a mesma regra da lista (`caseSetWhere`: pelo horário do evento **ou** pelo da
 * chegada): o total bate com o da lista no mesmo período, e um alerta com data antiga não esconde o caso dele. Os alertas
 * da janela são contados pelo índice `(tenantId, caseId, occurredAt, id)`, sem ler as linhas deles.
 *
 * O mais grave é pela pior severidade pendente ou pela do incidente aberto em que há alerta do caso: um crítico confirmado
 * como incidente não tem mais nada pendente, e nem por isso fica atrás dos médios.
 */
export async function radarCases(
  db: Db,
  tenantId: string,
  { since, now, limit }: { since: Date; now: Date; limit: number },
): Promise<RadarCases> {
  const active = caseSetWhere(tenantId, {
    queue: 'detection',
    state: 'all',
    severity: null,
    source: null,
    accountId: null,
    tactic: null,
    technique: null,
    from: since,
    to: null,
    pattern: null,
    groupBy: null,
    group: null,
  });
  const [row] = await db.$queryRaw<RadarCases[]>`
    WITH ranked_incidents AS MATERIALIZED (
      SELECT i."id", i."firstSeenAt", CASE i."severity" WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2
        ELSE 1 END AS severity
      FROM "Incident" AS i WHERE i."tenantId" = ${tenantId}::uuid AND i."status" <> 'resolved'
    ), held AS MATERIALIZED (
      SELECT f."caseId", max(i.severity) AS severity,
        (array_agg(i."id" ORDER BY i.severity DESC, i."firstSeenAt" DESC, i."id"))[1] AS incident
      FROM (
        SELECT DISTINCT f."caseId", f."incidentId" FROM ranked_incidents AS i
        JOIN "Finding" AS f ON f."incidentId" = i."id"
        WHERE f."tenantId" = ${tenantId}::uuid AND f."caseId" IS NOT NULL
      ) AS f
      JOIN ranked_incidents AS i ON i."id" = f."incidentId"
      GROUP BY 1
    ), active AS MATERIALIZED (
      SELECT c."id", c."lastAlertAt", h.incident, greatest(
        COALESCE(h.severity, 0),
        CASE WHEN c."pendingCritical" > 0 THEN 4 WHEN c."pendingHigh" > 0 THEN 3 WHEN c."pendingMedium" > 0 THEN 2
          WHEN c."pendingLow" > 0 THEN 1 ELSE 0 END
      ) AS severity
      FROM "AlertCase" AS c LEFT JOIN held AS h ON h."caseId" = c."id"
      WHERE ${active}
    ), counted AS MATERIALIZED (
      SELECT a.*, (
        SELECT count(*) FROM "Finding" AS f
        WHERE f."tenantId" = ${tenantId}::uuid AND f."caseId" = a."id"
          AND f."occurredAt" BETWEEN ${since.toISOString()}::timestamptz AND ${now.toISOString()}::timestamptz
      ) AS recent
      FROM active AS a
    ), shown AS (
      SELECT c."id", c.recent, c.incident, row_number() OVER (ORDER BY c.severity DESC, c."lastAlertAt" DESC, c."id" DESC) AS position
      FROM counted AS c
      ORDER BY position
      LIMIT ${limit}::integer
    )
    SELECT (SELECT count(*)::integer FROM counted) AS "total",
      (SELECT COALESCE(sum(c.recent), 0)::integer FROM counted AS c) AS "alerts",
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', s."id", 'recent', s.recent, 'openIncidentId', s.incident)
          ORDER BY s.position)
        FROM shown AS s
      ), '[]'::jsonb) AS "shown"`;
  return row ?? { total: 0, alerts: 0, shown: [] };
}

// ---------------------------------------------------------------------------------------------------
// Relatórios
// ---------------------------------------------------------------------------------------------------

export interface CaseOutcomes {
  opened: number;
  treated: number;
  pending: number;
  medianMinutesToTreat: number | null;
}

/**
 * Os casos abertos no período (pelo relógio do servidor) e em que pé estão agora: `opened` é sempre `treated` mais
 * `pending`. O caso sem nenhum alerta guardado não entra, como na lista.
 *
 * O tempo até tratar vai da abertura até o último alerta dele sair de "novo" (`triagedAt`) ou entrar num incidente (a
 * abertura do incidente, ou a chegada do alerta, se ele veio depois): é a mesma marca do tempo até a validação, e o banco
 * não guarda outra. A mediana é por caso: uma operação que trata 20 mil alertas de um caso conta uma vez.
 */
export async function caseOutcomes(
  db: Db,
  tenantId: string,
  { from, to }: { from: Date; to: Date },
): Promise<CaseOutcomes> {
  const [row] = await db.$queryRaw<CaseOutcomes[]>`
    WITH opened AS MATERIALIZED (
      SELECT c."id", c."openedAt", c."pending"
      FROM "AlertCase" AS c
      WHERE c."tenantId" = ${tenantId}::uuid AND c."total" > 0
        AND c."openedAt" BETWEEN ${from.toISOString()}::timestamptz AND ${to.toISOString()}::timestamptz
    ), treated AS (
      SELECT max(
          CASE WHEN f."incidentId" IS NULL THEN f."triagedAt" ELSE greatest(i."createdAt", f."createdAt") END
        ) - o."openedAt" AS spent
      FROM opened AS o
      JOIN "Finding" AS f ON f."tenantId" = ${tenantId}::uuid AND f."caseId" = o."id"
      LEFT JOIN "Incident" AS i ON i."id" = f."incidentId" AND i."tenantId" = ${tenantId}::uuid
      WHERE NOT o."pending"
      GROUP BY o."id", o."openedAt"
    )
    SELECT (SELECT count(*)::integer FROM opened) AS "opened",
      (SELECT count(*)::integer FROM opened AS o WHERE NOT o."pending") AS "treated",
      (SELECT count(*)::integer FROM opened AS o WHERE o."pending") AS "pending",
      (
        SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY greatest(0, extract(epoch FROM t.spent) / 60)))
        FROM treated AS t WHERE t.spent IS NOT NULL
      ) AS "medianMinutesToTreat"`;
  return row ?? { opened: 0, treated: 0, pending: 0, medianMinutesToTreat: null };
}

export interface MitreWithCases {
  counts: MitreCount[];
  /** Os casos com alerta de cada tática no período. */
  cases: { tactic: string; cases: number }[];
}

/**
 * O mesmo que o relatório MITRE conta (os alertas do período por combinação de táticas e técnicas) e, na mesma leitura,
 * quantos casos têm alerta de cada tática. O alerta sem caso (tratado antes dos casos, esperado por exceção, à espera da
 * atribuição) conta só nos alertas.
 */
export async function mitreWithCases(
  db: Db,
  tenantId: string,
  { from, to }: { from: Date; to: Date },
): Promise<MitreWithCases> {
  const [row] = await db.$queryRaw<MitreWithCases[]>`
    WITH tallied AS MATERIALIZED (
      SELECT f."mitreTactics" AS tactics, COALESCE(f."mitreTechniques", '{}') AS techniques, f."caseId" AS case_id,
        count(*) AS total
      FROM "Finding" AS f
      WHERE f."tenantId" = ${tenantId}::uuid
        AND f."occurredAt" BETWEEN ${from.toISOString()}::timestamptz AND ${to.toISOString()}::timestamptz
        AND cardinality(f."mitreTactics") > 0
      GROUP BY 1, 2, 3
    ), combined AS (
      SELECT t.tactics, t.techniques, sum(t.total) AS total FROM tallied AS t GROUP BY 1, 2
    ), by_tactic AS (
      SELECT tactic.name, count(DISTINCT t.case_id) AS cases
      FROM tallied AS t CROSS JOIN unnest(t.tactics) AS tactic(name)
      WHERE t.case_id IS NOT NULL
      GROUP BY 1
    )
    SELECT
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'mitreTactics', c.tactics, 'mitreTechniques', c.techniques, 'count', c.total
        ))
        FROM combined AS c
      ), '[]'::jsonb) AS "counts",
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object('tactic', b.name, 'cases', b.cases)) FROM by_tactic AS b
      ), '[]'::jsonb) AS "cases"`;
  return row ?? { counts: [], cases: [] };
}
