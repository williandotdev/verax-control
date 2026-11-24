import type { FindingSeverity, Prisma } from '../generated/prisma/client.js';
import { CaseBatchError } from './case-errors.js';
import type { CaseKeyPart } from './case-key.js';
import { fanOutGroup, LIMITED_QUEUES, RecentOpenings } from './case-limits.js';
import type { BatchPlan, OpenCase, PlanFinding, PreviousCase } from './case-plan.js';

/**
 * O SQL da atribuição dos casos (`case-assign-job.ts`). Roda no cliente base, o do sistema (só ele grava casos), e por
 * isso todo comando leva o cliente: nas buscas, nas travas e nas gravações.
 */

/** Um lugar na fila de um cliente: a chegada e o id do último alerta lido. */
export interface OutboxCursor {
  at: string;
  id: string;
}
export const OUTBOX_START: OutboxCursor = { at: '-infinity', id: '00000000-0000-0000-0000-000000000000' };

/** A espera máxima por uma trava, até o fim da transação. */
export async function setLockTimeout(tx: Prisma.TransactionClient, milliseconds: number): Promise<void> {
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${milliseconds}ms`}, true)`;
}

/**
 * Um trecho da fila de um cliente. O predicado repete o do índice parcial `Finding_case_outbox_idx`, com os valores
 * escritos (em parâmetro, o Postgres não o usaria).
 */
export function readOutboxPage(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  tenantId: string,
  after: OutboxCursor,
  skip: readonly string[],
  limit: number,
): Promise<{ id: string; createdAt: Date }[]> {
  return db.$queryRaw<{ id: string; createdAt: Date }[]>`
    SELECT f."id"::text AS "id", f."createdAt"
    FROM "Finding" AS f
    WHERE f."tenantId" = ${tenantId}::uuid
      AND f."caseId" IS NULL AND f."incidentId" IS NULL AND f."status" IN ('new', 'investigating')
      AND (f."createdAt", f."id") > (${after.at}::timestamptz, ${after.id}::uuid)
      AND f."id" <> ALL(${[...skip]}::uuid[])
    ORDER BY f."createdAt", f."id"
    LIMIT ${limit}::integer`;
}

/** Trava as linhas do lote que ainda estão na fila (uma triagem em curso é pulada) e lê o que a chave e o plano usam. */
export async function lockOutboxRows(
  tx: Prisma.TransactionClient,
  tenantId: string,
  ids: readonly string[],
): Promise<PlanFinding[]> {
  return tx.$queryRaw<PlanFinding[]>`
    SELECT f."id"::text AS "id", f."createdAt", f."occurredAt", f."lastSeenAt", f."severity"::text AS "severity",
      f."accountId", f."logSource", f."ruleId", f."title", f."eventName", f."resource", f."actorUser",
      f."accessKeyId", f."sourceIp", f."caseGroup", f."mitreTactics", f."mitreTechniques"
    FROM "Finding" AS f
    WHERE f."id" = ANY(${[...ids]}::uuid[]) AND f."tenantId" = ${tenantId}::uuid
      AND f."caseId" IS NULL AND f."incidentId" IS NULL AND f."status" IN ('new', 'investigating')
    ORDER BY f."id"
    FOR UPDATE SKIP LOCKED`;
}

const OPEN_CASE_SELECT = {
  id: true,
  groupKey: true,
  queue: true,
  openedAt: true,
  lastAlertAt: true,
  firstSeenAt: true,
  lastSeenAt: true,
  noticedSeverity: true,
  recurrence: true,
  pending: true,
  legitimateCount: true,
  resolvedCount: true,
  incidentCount: true,
  incidentId: true,
  ruleIds: true,
  accounts: true,
  actors: true,
  ips: true,
  resources: true,
  mitreTactics: true,
  mitreTechniques: true,
} as const satisfies Prisma.AlertCaseSelect;

/**
 * Os casos abertos das chaves. Sem travar: quem muda as amostras e o selo é só esta tarefa, sob o lock do cliente; a
 * triagem de um alerta muda as contagens no meio, e o pior que pode acontecer é o alerta novo entrar num caso que acabou
 * de ser tratado (ele volta a ter pendência, à vista).
 */
export async function loadOpenCases(
  tx: Prisma.TransactionClient,
  tenantId: string,
  groupKeys: readonly string[],
  into: Map<string, OpenCase>,
): Promise<void> {
  if (groupKeys.length === 0) return;
  const rows = await tx.alertCase.findMany({
    where: { tenantId, openKey: { in: [...groupKeys] } },
    select: OPEN_CASE_SELECT,
  });
  const resting = rows.filter((row) => !row.pending && (row.incidentCount > 0 || row.incidentId !== null));
  const promoted = await casesInOpenIncident(
    tx,
    tenantId,
    resting.map((row) => row.id),
  );
  for (const { legitimateCount, resolvedCount, incidentCount, incidentId, ...row } of rows) {
    into.set(row.groupKey, {
      ...row,
      promoted: promoted.has(row.id),
      treated: legitimateCount + resolvedCount + incidentCount > 0 || incidentId !== null,
    });
  }
}

/** Dos casos dados, os que estão num incidente não resolvido: o do próprio caso ou o de um alerta dele. */
async function casesInOpenIncident(
  tx: Prisma.TransactionClient,
  tenantId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT c."id"::text AS "id" FROM "AlertCase" AS c
    WHERE c."id" = ANY(${[...ids]}::uuid[]) AND c."tenantId" = ${tenantId}::uuid
      AND (
        EXISTS (
          SELECT 1 FROM "Incident" AS i
          WHERE i."id" = c."incidentId" AND i."tenantId" = c."tenantId" AND i."status" <> 'resolved'
        )
        OR EXISTS (
          SELECT 1 FROM "Incident" AS i JOIN "Finding" AS f ON f."incidentId" = i."id"
          WHERE i."tenantId" = c."tenantId" AND i."status" <> 'resolved'
            AND f."tenantId" = c."tenantId" AND f."caseId" = c."id"
        )
      )`;
  return new Set(rows.map((row) => row.id));
}

/** O último caso selado de cada chave. */
export async function loadPreviousCases(
  tx: Prisma.TransactionClient,
  tenantId: string,
  groupKeys: readonly string[],
): Promise<Map<string, PreviousCase>> {
  // `bpchar`, o tipo da coluna: comparada com texto, ela não usaria o índice.
  const rows = await tx.$queryRaw<{ id: string; groupKey: string; recurrence: number }[]>`
    SELECT DISTINCT ON (c."groupKey") c."id"::text AS "id", c."groupKey"::text AS "groupKey", c."recurrence"
    FROM "AlertCase" AS c
    WHERE c."tenantId" = ${tenantId}::uuid AND c."groupKey" = ANY(${[...groupKeys]}::bpchar[])
      AND c."openKey" IS NULL
    ORDER BY c."groupKey", c."sealedAt" DESC, c."openedAt" DESC, c."id" DESC`;
  return new Map(rows.map(({ groupKey, ...previous }) => [groupKey, previous]));
}

/** As partes da chave gravadas, só para contar o fan-out (o que não for do formato não conta). */
function partsOf(value: Prisma.JsonValue): CaseKeyPart[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((part) =>
    typeof part === 'object' &&
    part !== null &&
    !Array.isArray(part) &&
    typeof part['name'] === 'string' &&
    typeof part['value'] === 'string'
      ? [{ name: part['name'], value: part['value'] }]
      : [],
  );
}

/** As aberturas das filas com limite, no período que o lote consulta. */
export async function loadOpenings(
  tx: Prisma.TransactionClient,
  tenantId: string,
  { after, until }: { after: Date; until: Date },
): Promise<RecentOpenings> {
  const rows = await tx.alertCase.findMany({
    where: { tenantId, queue: { in: [...LIMITED_QUEUES] }, openedAt: { gt: after, lte: until } },
    select: { queue: true, family: true, accounts: true, keyParts: true, openedAt: true },
  });
  return new RecentOpenings(
    rows.map((row) => ({
      queue: row.queue,
      openedAt: row.openedAt,
      // Um caso com rede na chave é de uma conta só.
      group: fanOutGroup(row.family, row.accounts[0] ?? '', partsOf(row.keyParts)),
    })),
  );
}

/** Grava o plano, com as linhas dos alertas já travadas. Qualquer diferença desfaz o lote inteiro. */
export async function writePlan(
  tx: Prisma.TransactionClient,
  tenantId: string,
  plan: BatchPlan,
  now: Date,
): Promise<void> {
  if (plan.created.length > 0) await insertCases(tx, tenantId, plan.created, now);
  const { assignments } = plan;
  // SQL direto: pelo Prisma, o `updatedAt` mudaria, e a retenção o lê como atividade.
  const assigned = await tx.$executeRaw`
    UPDATE "Finding" AS f
    SET "caseId" = v.case_id, "caseGroup" = COALESCE(NULLIF(v.case_group, ''), f."caseGroup")
    FROM unnest(
      ${assignments.map((row) => row.findingId)}::uuid[],
      ${assignments.map((row) => row.caseId)}::uuid[],
      ${assignments.map((row) => row.group ?? '')}::text[]
    ) AS v(id, case_id, case_group)
    WHERE f."id" = v.id AND f."tenantId" = ${tenantId}::uuid AND f."caseId" IS NULL`;
  if (assigned !== assignments.length) throw new CaseBatchError('alerta travado que não foi atribuído');
  // Daqui para baixo, só casos: a ordem das travas é alertas e depois casos.
  if (plan.touched.length > 0) await updateTouched(tx, tenantId, plan.touched);
  if (plan.sealed.length > 0) {
    const sealed = await tx.$executeRaw`
      UPDATE "AlertCase" AS c
      SET "openKey" = NULL, "sealedAt" = ${now.toISOString()}::timestamptz, "sealReason" = v.reason
      FROM unnest(
        ${plan.sealed.map((row) => row.id)}::uuid[], ${plan.sealed.map((row) => row.reason)}::text[]
      ) AS v(id, reason)
      WHERE c."id" = v.id AND c."tenantId" = ${tenantId}::uuid AND c."openKey" IS NOT NULL`;
    if (sealed !== plan.sealed.length) throw new CaseBatchError('caso a selar que já não estava aberto');
  }
  const replacing = plan.created.filter(({ state }) => state.kind === 'replaces').map(({ id }) => id);
  if (replacing.length > 0) {
    await tx.$executeRaw`
      UPDATE "AlertCase" SET "openKey" = "groupKey", "sealedAt" = NULL, "sealReason" = NULL
      WHERE "id" = ANY(${replacing}::uuid[]) AND "tenantId" = ${tenantId}::uuid`;
  }
}

/**
 * Os casos novos, num comando só (pelo Prisma, uma centena deles custaria dezenas de milissegundos com o lock do cliente
 * na mão). O que fica no lugar de outro nasce selado (ninguém o vê) e abre no fim, quando o outro já largou a chave.
 */
async function insertCases(
  tx: Prisma.TransactionClient,
  tenantId: string,
  created: BatchPlan['created'],
  now: Date,
): Promise<void> {
  const rows = JSON.stringify(
    created.map(({ state, ...row }) => ({
      ...row,
      openKey: state.kind === 'open' ? row.groupKey : null,
      sealedAt: state.kind === 'open' ? null : now,
      sealReason: state.kind === 'open' ? null : state.kind === 'sealed' ? state.reason : 'window',
    })),
  );
  await tx.$executeRaw`
    INSERT INTO "AlertCase" (
      "id", "tenantId", "queue", "keyVersion", "groupKey", "openKey", "family", "title", "keyParts",
      "previousCaseId", "recurrence", "anchorFindingId", "openedAt", "sealedAt", "sealReason",
      "firstSeenAt", "lastSeenAt", "lastAlertAt", "noticedSeverity",
      "ruleIds", "accounts", "actors", "ips", "resources", "mitreTactics", "mitreTechniques"
    )
    SELECT v."id", ${tenantId}::uuid, v."queue"::"CaseQueue", v."keyVersion", v."groupKey", v."openKey", v."family",
      v."title", v."keyParts", v."previousCaseId", v."recurrence", v."anchorFindingId", v."openedAt", v."sealedAt",
      v."sealReason", v."firstSeenAt", v."lastSeenAt", v."lastAlertAt", v."noticedSeverity"::"FindingSeverity",
      v."ruleIds", v."accounts", v."actors", v."ips", v."resources", v."mitreTactics", v."mitreTechniques"
    FROM jsonb_to_recordset(${rows}::jsonb) AS v(
      "id" uuid, "queue" text, "keyVersion" smallint, "groupKey" text, "openKey" text, "family" text, "title" text,
      "keyParts" jsonb, "previousCaseId" uuid, "recurrence" integer, "anchorFindingId" uuid, "openedAt" timestamptz,
      "sealedAt" timestamptz, "sealReason" text, "firstSeenAt" timestamptz, "lastSeenAt" timestamptz,
      "lastAlertAt" timestamptz, "noticedSeverity" text, "ruleIds" text[], "accounts" text[], "actors" text[],
      "ips" text[], "resources" text[], "mitreTactics" text[], "mitreTechniques" text[]
    )`;
}

/** O que os alertas do lote mudam nos casos que já existiam. As contagens são dos gatilhos. */
async function updateTouched(
  tx: Prisma.TransactionClient,
  tenantId: string,
  touched: BatchPlan['touched'],
): Promise<void> {
  const rows = JSON.stringify(touched);
  const updated = await tx.$executeRaw`
    UPDATE "AlertCase" AS c
    SET "firstSeenAt" = v."firstSeenAt", "lastSeenAt" = v."lastSeenAt", "lastAlertAt" = v."lastAlertAt",
      "noticedSeverity" = v."noticedSeverity"::"FindingSeverity",
      "ruleIds" = v."ruleIds", "accounts" = v."accounts", "actors" = v."actors", "ips" = v."ips",
      "resources" = v."resources", "mitreTactics" = v."mitreTactics", "mitreTechniques" = v."mitreTechniques"
    FROM jsonb_to_recordset(${rows}::jsonb) AS v(
      "id" uuid, "firstSeenAt" timestamptz, "lastSeenAt" timestamptz, "lastAlertAt" timestamptz,
      "noticedSeverity" text, "ruleIds" text[], "accounts" text[], "actors" text[], "ips" text[],
      "resources" text[], "mitreTactics" text[], "mitreTechniques" text[]
    )
    WHERE c."id" = v."id" AND c."tenantId" = ${tenantId}::uuid`;
  if (updated !== touched.length) throw new CaseBatchError('caso aberto que sumiu no lote');
}

/** O horário do alerta alto ou crítico mais antigo ainda sem caso, de um cliente (a vigia `case-watch`). */
export async function oldestUnassigned(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  tenantId: string,
): Promise<{ createdAt: Date; severity: FindingSeverity } | null> {
  const [row] = await db.$queryRaw<{ createdAt: Date; severity: FindingSeverity }[]>`
    SELECT f."createdAt", f."severity"::text AS "severity"
    FROM "Finding" AS f
    WHERE f."tenantId" = ${tenantId}::uuid
      AND f."caseId" IS NULL AND f."incidentId" IS NULL AND f."status" IN ('new', 'investigating')
      AND f."severity" IN ('critical', 'high')
    ORDER BY f."createdAt", f."id"
    LIMIT 1`;
  return row ?? null;
}
