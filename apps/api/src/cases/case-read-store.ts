import type { CaseGrouping, CaseListQuery, CaseState, FindingSeverity, FindingStatus } from '@verax/shared';
import { Prisma } from '../generated/prisma/client.js';
import type { CaseCursorPosition } from './case-cursor.js';
import type { CaseSourceFilter } from './case-sources.js';
import type { TimelineCounts, TimelineWindow } from './case-timeline.js';

/**
 * O SQL da leitura dos casos. Tudo em `$queryRaw` com parâmetros, e todo comando leva o cliente, que o service tira da
 * sessão (`PrismaService.scopeTenantId`), nunca do pedido. Nenhum texto do pedido vira SQL: o filtro ausente é um
 * parâmetro nulo, que o banco descarta ao planejar.
 *
 * Aqui só se escolhem ids e se fazem contas; as linhas que vão para a tela são lidas depois, pelo escopo do cliente.
 */
type Db = Pick<Prisma.TransactionClient, '$queryRaw'>;

const iso = (at: Date | null): string | null => at?.toISOString() ?? null;

// ---------------------------------------------------------------------------------------------------
// Lista
// ---------------------------------------------------------------------------------------------------

/** Quais casos: os filtros da lista, sem a ordem e a página. */
export interface CaseSetFilter {
  queue: CaseListQuery['queue'] | null;
  state: CaseState;
  severity: FindingSeverity | null;
  source: CaseSourceFilter | null;
  accountId: string | null;
  tactic: string | null;
  technique: string | null;
  from: Date | null;
  to: Date | null;
  /** O padrão do `ILIKE`, com os curingas do texto já escapados. */
  pattern: string | null;
  groupBy: CaseGrouping | null;
  /** Null com `groupBy`: os casos sem esse valor. */
  group: string | null;
}

export interface CaseListFilter extends CaseSetFilter {
  sort: CaseListQuery['sort'];
  /** A lista de proteção do cliente, no tamanho das amostras. */
  protectedItems: readonly string[];
  limit: number;
  offset: number;
}

/**
 * O `WHERE` dos casos de um filtro (o caso é `c`), com tudo em parâmetro. É um só para a lista e para a triagem em massa
 * por filtro (`triage-store.ts`): o que a pessoa vê na lista é o que a operação alcança.
 *
 * A janela vale pelo horário do evento ou pelo da chegada no servidor: o horário do log é de quem escreve o log, e um
 * caso que acabou de receber alertas não pode sumir do "últimas 24 horas" porque eles vieram com data antiga.
 *
 * A busca junta os textos do caso num só, separados por quebra de linha (que a busca não aceita, então nada casa na
 * emenda), e compara com a regra de maiúsculas do próprio Postgres (`pg_c_utf8`): metade do tempo da do sistema.
 */
export function caseSetWhere(tenantId: string, filter: CaseSetFilter): Prisma.Sql {
  const { source, groupBy, group } = filter;
  const byPart = groupBy === 'package' || groupBy === 'resource' ? groupBy : null;
  const part =
    byPart === null ? null : JSON.stringify([{ name: byPart, ...(group !== null && { value: group }) }]);
  return Prisma.sql`c."tenantId" = ${tenantId}::uuid
        AND c."total" > 0
        AND (${filter.queue}::text IS NULL OR c."queue" = ${filter.queue}::text::"CaseQueue")
        AND (${filter.state}::text NOT IN ('pending', 'investigating') OR c."pending")
        AND (${filter.state}::text <> 'investigating' OR c."investigatingCount" > 0)
        AND (${filter.state}::text <> 'treated' OR NOT c."pending")
        AND (${filter.severity}::text IS NULL OR CASE ${filter.severity}::text
          WHEN 'critical' THEN c."pendingCritical" WHEN 'high' THEN c."pendingHigh"
          WHEN 'medium' THEN c."pendingMedium" WHEN 'low' THEN c."pendingLow" END > 0)
        AND (${filter.accountId}::text IS NULL OR c."accounts" @> ARRAY[${filter.accountId}::text])
        AND (${filter.tactic}::text IS NULL OR c."mitreTactics" @> ARRAY[${filter.tactic}::text])
        AND (${filter.technique}::text IS NULL OR c."mitreTechniques" @> ARRAY[${filter.technique}::text])
        AND (${iso(filter.from)}::timestamptz IS NULL
          OR greatest(c."lastSeenAt", c."lastAlertAt") >= ${iso(filter.from)}::timestamptz)
        AND (${iso(filter.to)}::timestamptz IS NULL
          OR least(c."firstSeenAt", c."openedAt") <= ${iso(filter.to)}::timestamptz)
        AND (${source?.source ?? null}::text IS NULL
          OR c."family" = ANY(${source?.families ?? []}::text[])
          OR (c."family" = ANY(${source?.onlyFamilies ?? []}::text[])
            AND c."ruleIds" && ${source?.onlyRules ?? []}::text[])
          OR (c."family" = ANY(${source?.besidesFamilies ?? []}::text[])
            AND NOT c."ruleIds" <@ ${source?.besidesRules ?? []}::text[])
          OR (c."family" = ${source?.rollupFamily ?? null}::text
            AND c."keyParts" @> ${source?.rollupPart ?? null}::jsonb))
        AND (${groupBy === 'account'}::boolean IS FALSE OR c."accounts"[1] = ${group}::text)
        AND (${part}::text IS NULL OR (c."keyParts" @> ${part}::jsonb) = ${group !== null}::boolean)
        AND (${filter.pattern}::text IS NULL
          OR concat_ws(chr(10), c."title", array_to_string(
              c."ruleIds" || c."accounts" || c."actors" || c."ips" || c."resources", chr(10)
            )) ILIKE ${filter.pattern}::text COLLATE "pg_c_utf8"
          OR (SELECT string_agg(p.value ->> 'value', chr(10)) FROM jsonb_array_elements(c."keyParts") AS p(value))
            ILIKE ${filter.pattern}::text COLLATE "pg_c_utf8")`;
}

/**
 * Os ids de uma página da lista, na ordem, e quantos casos batem com os filtros.
 *
 * Uma leitura só dos casos do cliente (pelo índice `(tenantId, queue, pending)`, quando há fila): as contagens não têm
 * índice de propósito (mudariam a cada alerta), então a ordem é feita em memória, só com as chaves dela.
 */
export async function caseListPage(
  db: Db,
  tenantId: string,
  filter: CaseListFilter,
): Promise<{ total: number; ids: string[] }> {
  const [row] = await db.$queryRaw<{ total: number; ids: string[] }[]>`
    WITH matched AS MATERIALIZED (
      SELECT c."id", c."lastAlertAt", c."total", c."newCount" + c."investigatingCount" AS waiting,
        CASE WHEN c."pendingCritical" > 0 THEN 4 WHEN c."pendingHigh" > 0 THEN 3 WHEN c."pendingMedium" > 0 THEN 2
          WHEN c."pendingLow" > 0 THEN 1 ELSE 0 END AS severity,
        (${filter.sort}::text = 'priority' AND cardinality(${[...filter.protectedItems]}::text[]) > 0 AND EXISTS (
          SELECT 1 FROM unnest(c."resources" || c."actors" || c."ips") AS s(value)
          WHERE s.value = ANY(${[...filter.protectedItems]}::text[])
        )) AS protected
      FROM "AlertCase" AS c
      WHERE ${caseSetWhere(tenantId, filter)}
    )
    SELECT (SELECT count(*)::integer FROM matched) AS total,
      ARRAY(
        SELECT m."id"::text FROM matched AS m
        ORDER BY
          CASE WHEN ${filter.sort}::text = 'priority' THEN m.severity END DESC NULLS LAST,
          CASE WHEN ${filter.sort}::text = 'priority' THEN m.protected END DESC NULLS LAST,
          CASE WHEN ${filter.sort}::text = 'volume' THEN m.waiting END DESC NULLS LAST,
          CASE WHEN ${filter.sort}::text = 'volume' THEN m."total" END DESC NULLS LAST,
          m."lastAlertAt" DESC, m."id" DESC
        LIMIT ${filter.limit}::integer OFFSET ${filter.offset}::integer
      ) AS ids`;
  return row ?? { total: 0, ids: [] };
}

// ---------------------------------------------------------------------------------------------------
// Grupos da fila de vulnerabilidades
// ---------------------------------------------------------------------------------------------------

export interface PendingCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export interface CaseGroupsFilter {
  by: CaseGrouping;
  state: 'pending' | 'investigating';
  severity: FindingSeverity | null;
  accountId: string | null;
  pattern: string | null;
  limit: number;
  offset: number;
}

/**
 * Os grupos dos casos pendentes da fila de vulnerabilidades. Saem só dos casos, sem ler alerta nenhum: nessa fila cada
 * caso é de um pacote, um recurso e uma conta, que estão na chave (`keyParts`) e na amostra de contas.
 */
export async function caseGroupsPage(
  db: Db,
  tenantId: string,
  filter: CaseGroupsFilter,
): Promise<{ total: number; items: ({ value: string | null; cases: number } & PendingCounts)[] }> {
  const [row] = await db.$queryRaw<
    { total: number; items: ({ value: string | null; cases: number } & PendingCounts)[] }[]
  >`
    WITH grouped AS MATERIALIZED (
      SELECT
        CASE WHEN ${filter.by}::text = 'account' THEN c."accounts"[1]
          ELSE jsonb_path_query_first(
            c."keyParts", '$[*] ? (@.name == $name).value', jsonb_build_object('name', ${filter.by}::text)
          ) #>> '{}'
        END AS value,
        count(*)::integer AS cases,
        sum(c."pendingCritical")::integer AS critical, sum(c."pendingHigh")::integer AS high,
        sum(c."pendingMedium")::integer AS medium, sum(c."pendingLow")::integer AS low
      FROM "AlertCase" AS c
      WHERE c."tenantId" = ${tenantId}::uuid AND c."queue" = 'vulnerability' AND c."pending"
        AND (${filter.state}::text <> 'investigating' OR c."investigatingCount" > 0)
        AND (${filter.severity}::text IS NULL OR CASE ${filter.severity}::text
          WHEN 'critical' THEN c."pendingCritical" WHEN 'high' THEN c."pendingHigh"
          WHEN 'medium' THEN c."pendingMedium" WHEN 'low' THEN c."pendingLow" END > 0)
        AND (${filter.accountId}::text IS NULL OR c."accounts" @> ARRAY[${filter.accountId}::text])
      GROUP BY 1
    ), named AS (
      SELECT g.* FROM grouped AS g
      WHERE ${filter.pattern}::text IS NULL OR g.value ILIKE ${filter.pattern}::text COLLATE "pg_c_utf8"
    ), page AS (
      SELECT n.*, row_number() OVER (
        ORDER BY
          CASE WHEN n.critical > 0 THEN 4 WHEN n.high > 0 THEN 3 WHEN n.medium > 0 THEN 2 WHEN n.low > 0 THEN 1
            ELSE 0 END DESC,
          n.critical DESC, n.high DESC, n.medium DESC, n.low DESC, n.cases DESC, n.value COLLATE "C" ASC NULLS LAST
      ) AS position
      FROM named AS n
      ORDER BY position
      LIMIT ${filter.limit}::integer OFFSET ${filter.offset}::integer
    )
    SELECT (SELECT count(*)::integer FROM named) AS total,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'value', p.value, 'cases', p.cases,
          'critical', p.critical, 'high', p.high, 'medium', p.medium, 'low', p.low
        ) ORDER BY p.position)
        FROM page AS p
      ), '[]'::jsonb) AS items`;
  return row ?? { total: 0, items: [] };
}

// ---------------------------------------------------------------------------------------------------
// Detalhe
// ---------------------------------------------------------------------------------------------------

export interface RareValueRow {
  value: string;
  count: number;
  /** Milissegundos desde 1970. */
  lastSeen: number;
}

export interface CaseAnalysisRow {
  alerts: number;
  stillActive: number;
  distinctIps: number;
  rareIps: RareValueRow[];
  distinctUsers: number;
  rareUsers: RareValueRow[];
  distinctGroups: number;
  groups: ({ value: string; total: number } & PendingCounts)[];
  incidents: { id: string; alerts: number }[];
  operationIds: string[];
}

export interface CaseAnalysisLimits {
  alerts: number;
  rare: number;
  groups: number;
  incidents: number;
  operations: number;
}

/**
 * O que sai dos alertas do caso, numa leitura só dos mais recentes (até `limits.alerts`): os valores raros, os subgrupos,
 * os incidentes, as operações em vigor e os resolvidos que a origem voltou a ver. Quem chama põe um prazo na transação.
 */
export async function caseAnalysis(
  db: Db,
  tenantId: string,
  caseId: string,
  limits: CaseAnalysisLimits,
): Promise<CaseAnalysisRow> {
  const [row] = await db.$queryRaw<CaseAnalysisRow[]>`
    WITH recent AS MATERIALIZED (
      SELECT f."sourceIp", f."actorUser", f."caseGroup", f."severity", f."incidentId", f."triageOpId", f."occurredAt",
        f."incidentId" IS NULL AND f."status" IN ('new', 'investigating') AS pending,
        f."incidentId" IS NULL AND f."status" = 'resolved' AND f."lastSeenAt" > f."triagedAt" AS still_active
      FROM "Finding" AS f
      WHERE f."tenantId" = ${tenantId}::uuid AND f."caseId" = ${caseId}::uuid
      ORDER BY f."occurredAt" DESC, f."id" DESC
      LIMIT ${limits.alerts}::integer
    ), ips AS MATERIALIZED (
      SELECT r."sourceIp" AS value, count(*)::integer AS count, max(r."occurredAt") AS last
      FROM recent AS r WHERE r."sourceIp" IS NOT NULL GROUP BY 1
    ), users AS MATERIALIZED (
      SELECT r."actorUser" AS value, count(*)::integer AS count, max(r."occurredAt") AS last
      FROM recent AS r WHERE r."actorUser" IS NOT NULL GROUP BY 1
    ), subgroups AS MATERIALIZED (
      SELECT r."caseGroup" AS value, count(*)::integer AS total,
        (count(*) FILTER (WHERE r.pending AND r."severity" = 'critical'))::integer AS critical,
        (count(*) FILTER (WHERE r.pending AND r."severity" = 'high'))::integer AS high,
        (count(*) FILTER (WHERE r.pending AND r."severity" = 'medium'))::integer AS medium,
        (count(*) FILTER (WHERE r.pending AND r."severity" = 'low'))::integer AS low
      FROM recent AS r WHERE r."caseGroup" IS NOT NULL GROUP BY 1
    )
    SELECT
      (SELECT count(*)::integer FROM recent) AS "alerts",
      (SELECT count(*)::integer FROM recent AS r WHERE r.still_active) AS "stillActive",
      (SELECT count(*)::integer FROM ips) AS "distinctIps",
      (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'value', v.value, 'count', v.count, 'lastSeen', floor(extract(epoch FROM v.last) * 1000)
        ) ORDER BY v.count, v.last DESC, v.value COLLATE "C"), '[]'::jsonb)
        FROM (SELECT i.* FROM ips AS i ORDER BY i.count, i.last DESC, i.value COLLATE "C"
          LIMIT ${limits.rare}::integer) AS v) AS "rareIps",
      (SELECT count(*)::integer FROM users) AS "distinctUsers",
      (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'value', v.value, 'count', v.count, 'lastSeen', floor(extract(epoch FROM v.last) * 1000)
        ) ORDER BY v.count, v.last DESC, v.value COLLATE "C"), '[]'::jsonb)
        FROM (SELECT u.* FROM users AS u ORDER BY u.count, u.last DESC, u.value COLLATE "C"
          LIMIT ${limits.rare}::integer) AS v) AS "rareUsers",
      (SELECT count(*)::integer FROM subgroups) AS "distinctGroups",
      (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'value', v.value, 'total', v.total,
          'critical', v.critical, 'high', v.high, 'medium', v.medium, 'low', v.low
        ) ORDER BY v.position), '[]'::jsonb)
        FROM (
          SELECT g.*, row_number() OVER (
            ORDER BY
              CASE WHEN g.critical > 0 THEN 4 WHEN g.high > 0 THEN 3 WHEN g.medium > 0 THEN 2 WHEN g.low > 0 THEN 1
                ELSE 0 END DESC,
              g.critical DESC, g.high DESC, g.medium DESC, g.low DESC, g.total DESC, g.value COLLATE "C"
          ) AS position
          FROM subgroups AS g
          ORDER BY position
          LIMIT ${limits.groups}::integer
        ) AS v) AS "groups",
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', v.id, 'alerts', v.alerts)
          ORDER BY v.alerts DESC, v.id), '[]'::jsonb)
        FROM (SELECT r."incidentId"::text AS id, count(*)::integer AS alerts FROM recent AS r
          WHERE r."incidentId" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${limits.incidents}::integer) AS v
      ) AS "incidents",
      ARRAY(
        SELECT DISTINCT r."triageOpId"::text FROM recent AS r WHERE r."triageOpId" IS NOT NULL
        ORDER BY 1 DESC LIMIT ${limits.operations}::integer
      ) AS "operationIds"`;
  if (row === undefined) throw new Error('a leitura dos alertas do caso não devolveu linha');
  return row;
}

/** Os ids dos casos anteriores, do mais recente para trás, pela ligação de cada um com o anterior. */
export async function previousCaseIds(
  db: Db,
  tenantId: string,
  previousCaseId: string,
  limit: number,
): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE chain AS (
      SELECT c."id", c."previousCaseId", 1 AS depth FROM "AlertCase" AS c
      WHERE c."tenantId" = ${tenantId}::uuid AND c."id" = ${previousCaseId}::uuid
      UNION ALL
      SELECT c."id", c."previousCaseId", chain.depth + 1
      FROM chain JOIN "AlertCase" AS c ON c."id" = chain."previousCaseId"
      WHERE c."tenantId" = ${tenantId}::uuid AND chain.depth < ${limit}::integer
    )
    SELECT chain."id"::text AS "id" FROM chain ORDER BY chain.depth`;
  return [...new Set(rows.map((row) => row.id))];
}

// ---------------------------------------------------------------------------------------------------
// Alertas do caso
// ---------------------------------------------------------------------------------------------------

export interface CaseFindingsFilter {
  after: CaseCursorPosition;
  status: FindingStatus | null;
  severity: FindingSeverity | null;
  group: string | null;
  limit: number;
}

/**
 * Os lugares de uma página dos alertas do caso, do mais recente para trás, pelo índice `(tenantId, caseId, occurredAt,
 * id)`. O horário e o id de um alerta nunca mudam: o alerta novo entra no lugar dele, sem empurrar os outros.
 */
export function caseFindingKeys(
  db: Db,
  tenantId: string,
  caseId: string,
  filter: CaseFindingsFilter,
): Promise<{ id: string; occurredAt: Date }[]> {
  return db.$queryRaw<{ id: string; occurredAt: Date }[]>`
    SELECT f."id"::text AS "id", f."occurredAt"
    FROM "Finding" AS f
    WHERE f."tenantId" = ${tenantId}::uuid AND f."caseId" = ${caseId}::uuid
      AND (f."occurredAt", f."id") < (${filter.after.at}::timestamptz, ${filter.after.id}::uuid)
      AND (${filter.status}::text IS NULL OR f."status" = ${filter.status}::text::"FindingStatus")
      AND (${filter.severity}::text IS NULL OR f."severity" = ${filter.severity}::text::"FindingSeverity")
      AND (${filter.group}::text IS NULL OR f."caseGroup" = ${filter.group}::text)
    ORDER BY f."occurredAt" DESC, f."id" DESC
    LIMIT ${filter.limit}::integer`;
}

// ---------------------------------------------------------------------------------------------------
// Linha do tempo
// ---------------------------------------------------------------------------------------------------

export interface TimelineRange {
  /** O alerta mais antigo e o mais recente antes do limite; null se não há. */
  oldest: Date | null;
  newest: Date | null;
  /** Há alerta no limite ou depois dele (horário no futuro). */
  beyond: boolean;
}

/** As pontas da linha do tempo, pelas pontas do índice. */
export async function timelineRange(
  db: Db,
  tenantId: string,
  caseId: string,
  cap: Date,
): Promise<TimelineRange> {
  const [row] = await db.$queryRaw<TimelineRange[]>`
    SELECT
      (SELECT f."occurredAt" FROM "Finding" AS f
        WHERE f."tenantId" = ${tenantId}::uuid AND f."caseId" = ${caseId}::uuid
          AND f."occurredAt" < ${cap.toISOString()}::timestamptz
        ORDER BY f."occurredAt", f."id" LIMIT 1) AS "oldest",
      (SELECT f."occurredAt" FROM "Finding" AS f
        WHERE f."tenantId" = ${tenantId}::uuid AND f."caseId" = ${caseId}::uuid
          AND f."occurredAt" < ${cap.toISOString()}::timestamptz
        ORDER BY f."occurredAt" DESC, f."id" DESC LIMIT 1) AS "newest",
      EXISTS (SELECT 1 FROM "Finding" AS f
        WHERE f."tenantId" = ${tenantId}::uuid AND f."caseId" = ${caseId}::uuid
          AND f."occurredAt" >= ${cap.toISOString()}::timestamptz) AS "beyond"`;
  return row ?? { oldest: null, newest: null, beyond: false };
}

/** As faixas com alerta. O passo é sempre de horas inteiras (24 no dia): Brasília não tem horário de verão. */
export function timelineCounts(
  db: Db,
  tenantId: string,
  caseId: string,
  window: TimelineWindow,
  cap: Date,
): Promise<TimelineCounts[]> {
  const until = new Date(Math.min(window.to.getTime(), cap.getTime()));
  return db.$queryRaw<TimelineCounts[]>`
    SELECT date_bin(make_interval(secs => ${window.stepMs / 1000}::integer), f."occurredAt",
        ${window.from.toISOString()}::timestamptz) AS "at",
      (count(*) FILTER (WHERE f."severity" = 'critical'))::integer AS "critical",
      (count(*) FILTER (WHERE f."severity" = 'high'))::integer AS "high",
      (count(*) FILTER (WHERE f."severity" = 'medium'))::integer AS "medium",
      (count(*) FILTER (WHERE f."severity" = 'low'))::integer AS "low"
    FROM "Finding" AS f
    WHERE f."tenantId" = ${tenantId}::uuid AND f."caseId" = ${caseId}::uuid
      AND f."occurredAt" >= ${window.from.toISOString()}::timestamptz
      AND f."occurredAt" < ${until.toISOString()}::timestamptz
    GROUP BY 1`;
}

// ---------------------------------------------------------------------------------------------------
// Situação
// ---------------------------------------------------------------------------------------------------

/** A chegada do alerta pendente mais antigo ainda sem caso, de qualquer severidade, pela ponta do índice da fila. */
export async function oldestUnassignedAt(db: Db, tenantId: string): Promise<Date | null> {
  const [row] = await db.$queryRaw<{ createdAt: Date }[]>`
    SELECT f."createdAt"
    FROM "Finding" AS f
    WHERE f."tenantId" = ${tenantId}::uuid
      AND f."caseId" IS NULL AND f."incidentId" IS NULL AND f."status" IN ('new', 'investigating')
    ORDER BY f."createdAt", f."id"
    LIMIT 1`;
  return row?.createdAt ?? null;
}
