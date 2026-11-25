import {
  ForbiddenException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  hasPermission,
  isMassTriageRole,
  MAX_ACTIVE_TRIAGE_OPERATIONS,
  MAX_INCIDENT_FINDINGS_PER_REQUEST,
  MAX_TRIAGE_ALERTS,
  MAX_TRIAGE_AUTHORS,
  MAX_UNDO_ALL_OPERATIONS,
  type Paginated,
  TRIAGE_ALERTS_PER_DAY,
  TRIAGE_ALERTS_PER_OPERATION,
  TRIAGE_AUTHORS_DAYS,
  TRIAGE_EMPTY_CODE,
  TRIAGE_INCIDENT_RESOLVED_CODE,
  TRIAGE_NOT_ACTIVE_CODE,
  TRIAGE_NOT_RESUMABLE_CODE,
  TRIAGE_NOT_UNDOABLE_CODE,
  TRIAGE_QUEUE_FULL_CODE,
  TRIAGE_QUOTA_CODE,
  TRIAGE_REASON_REQUIRED_CODE,
  TRIAGE_REQUEST_REUSED_CODE,
  TRIAGE_SCOPE_CHANGED_CODE,
  TRIAGE_STILL_ACTIVE_CODE,
  TRIAGE_SYNC_ALERTS,
  TRIAGE_TOO_LARGE_CODE,
  TRIAGE_UNDO_EXPIRED_CODE,
  type TriageAuthors,
  type TriageFilter,
  type TriageOperationCreate,
  type TriageOperationDetail,
  type TriageOperationListQuery,
  type TriagePreview,
  triageScopeChanged,
  type TriageUndo,
} from '@verax/shared';
import { randomUUID } from 'node:crypto';
import { AuditContext } from '../common/audit/audit-context.service.js';
import { AuditService } from '../common/audit/audit.service.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { ApiError } from '../common/http/api-error.js';
import { toPaginated, toPrismaPage } from '../common/http/pagination.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { IncidentsService } from '../incidents/incidents.service.js';
import { PlanService } from '../plan/plan.service.js';
import { boundedRead } from './case-bounded.js';
import { sqlStateOf } from './case-errors.js';
import { caseSetFilter } from './case-filter.js';
import { uuidV7 } from './case-plan.js';
import { caseProtectedItems } from './case-protected.js';
import { casesOperable } from './cases-mode.js';
import {
  ACTIVE_STATES,
  runTriageBatch,
  settleIncident,
  TRIAGE_BATCH,
  undoDeadline,
} from './triage-engine.js';
import {
  actionableIds,
  EMPTY_RUN,
  freezeOperation,
  frozenSlice,
  type Frozen,
  type LockedOperation,
  lockFindings,
  lockFindingsBriefly,
  lockIncident,
  lockOperation,
  lockTenantTriage,
  markTaken,
  operationAuthors,
  pointCasesAt,
  previewFilter,
  requeueRest,
  saveProgress,
  saveRun,
  setTriageTimeouts,
  takeItems,
  type TriageScope,
} from './triage-store.js';
import {
  FORWARD_ACTIONS,
  mayManage,
  needsIncidentWrite,
  type OperationDetailRow,
  operationDetailSelect,
  RESUMABLE_STATES,
  resumeDeadline,
  toOperationDetail,
  UNDOABLE_STATES,
} from './triage-view.js';

/** Os limites da triagem em massa e o relógio dela. */
export interface TriageLimits {
  syncAlerts: number;
  maxAlerts: number;
  maxActive: number;
  alertsPerOperation: number;
  alertsPerDay: number;
  /** O prazo, no banco, de ler os alertas na prévia de um filtro. */
  previewTimeoutMs: number;
  now: () => Date;
}
export const DEFAULT_TRIAGE_LIMITS: TriageLimits = {
  syncAlerts: TRIAGE_SYNC_ALERTS,
  maxAlerts: MAX_TRIAGE_ALERTS,
  maxActive: MAX_ACTIVE_TRIAGE_OPERATIONS,
  alertsPerOperation: TRIAGE_ALERTS_PER_OPERATION,
  alertsPerDay: TRIAGE_ALERTS_PER_DAY,
  previewTimeoutMs: 1_500,
  now: () => new Date(),
};
/** Os limites, como provider (os testes usam menores e outro relógio). */
export const TRIAGE_LIMITS = Symbol('TRIAGE_LIMITS');

const DAY_MS = 24 * 60 * 60 * 1000;
/** Prazos de um comando na requisição, que tem 15 s: a espera por uma trava e o comando inteiro. */
const LOCK_TIMEOUT_MS = 3_000;
const STATEMENT_TIMEOUT_MS = 6_000;
/** Os SQLSTATE de quem esperou demais (trava, prazo do comando) ou caiu num deadlock: tente de novo. */
const BUSY: ReadonlySet<string | null> = new Set(['55P03', '57014', '40P01']);

const NOT_FOUND = 'Operação não encontrada';
const CASE_NOT_FOUND = 'Caso não encontrado';
const FINDING_NOT_FOUND = 'Alerta não encontrado';
const INCIDENT_NOT_FOUND = 'Incidente não encontrado';

/** A resposta de um pedido e o status dela: 201 feita na hora, 202 na fila, 200 o pedido repetido. */
export interface TriageAnswer {
  status: HttpStatus;
  operation: TriageOperationDetail;
}

const conflict = (message: string, code: string, details?: Record<string, number>): ApiError =>
  new ApiError(HttpStatus.CONFLICT, message, code, details);

/**
 * Triagem em massa do cliente da sessão. O pedido vale pela regra inteira aqui (papel, cota, motivo, tamanho, conjunto
 * congelado); os lotes são do motor (`triage-engine.ts`), o mesmo na requisição e no worker (`triage-ops-job.ts`).
 *
 * Todo id do corpo (casos, alertas, incidente, operação) só vale dentro do cliente da sessão: o de outro cliente é 404,
 * igual a um que não existe, e nada muda.
 */
@Injectable()
export class TriageOperationsService {
  private readonly logger = new Logger(TriageOperationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditContext,
    private readonly auditService: AuditService,
    private readonly incidents: IncidentsService,
    private readonly plan: PlanService,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'CASES_MODE'>,
    @Inject(TRIAGE_LIMITS) private readonly limits: TriageLimits,
  ) {}

  // -------------------------------------------------------------------------------------------------
  // Leitura
  // -------------------------------------------------------------------------------------------------

  async list(auth: RequestAuth, query: TriageOperationListQuery): Promise<Paginated<TriageOperationDetail>> {
    const where: Prisma.TriageOperationWhereInput = {
      ...(query.state === 'active' && { state: { in: [...ACTIVE_STATES] } }),
      ...(query.state === 'finished' && { state: { notIn: [...ACTIVE_STATES] } }),
      ...(query.authorId !== undefined && { createdById: query.authorId }),
    };
    const db = this.prisma.scoped();
    const [rows, total] = await Promise.all([
      db.triageOperation.findMany({
        where,
        select: operationDetailSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...toPrismaPage(query),
      }),
      db.triageOperation.count({ where }),
    ]);
    return toPaginated(await this.details(auth, rows), total, query);
  }

  async get(auth: RequestAuth, id: string): Promise<TriageOperationDetail> {
    const row = await this.prisma
      .scoped()
      .triageOperation.findUnique({ where: { id }, select: operationDetailSelect });
    const [detail] = row === null ? [] : await this.details(auth, [row]);
    if (detail === undefined) throw new ApiError(HttpStatus.NOT_FOUND, NOT_FOUND);
    return detail;
  }

  /**
   * O que um filtro da lista de casos alcança agora. Os novos e os em análise por severidade podem pedir a leitura dos
   * alertas: passou do prazo, a prévia vem sem eles.
   */
  async preview(filter: TriageFilter): Promise<TriagePreview> {
    const tenantId = this.prisma.scopeTenantId();
    const set = caseSetFilter(filter, this.limits.now());
    const protectedItems = [...(await caseProtectedItems(this.prisma.scoped()))];
    const read = (db: Pick<Prisma.TransactionClient, '$queryRaw'>, byStatus: boolean) =>
      previewFilter(db, tenantId, set, { protectedItems, byStatus });
    const found =
      (await boundedRead(this.prisma, this.limits.previewTimeoutMs, (tx) => read(tx, true))) ??
      (await read(this.prisma.db(), false));
    const { cases, protectedCases, critical, high, medium, low, byStatus } = found;
    return {
      cases,
      alerts: found.new + found.investigating,
      new: found.new,
      investigating: found.investigating,
      pending: { critical, high, medium, low },
      protectedCases,
      ...(byStatus !== null && { byStatus }),
    };
  }

  /** Quem pediu operações nos últimos 30 dias, para o filtro do histórico. */
  async authors(): Promise<TriageAuthors> {
    const since = new Date(this.limits.now().getTime() - TRIAGE_AUTHORS_DAYS * DAY_MS);
    // Uma a mais que o teto: diz se há outras.
    const found = await operationAuthors(
      this.prisma.db(),
      this.prisma.scopeTenantId(),
      since,
      MAX_TRIAGE_AUTHORS + 1,
    );
    return { items: found.slice(0, MAX_TRIAGE_AUTHORS), truncated: found.length > MAX_TRIAGE_AUTHORS };
  }

  private async details(
    auth: RequestAuth,
    rows: readonly OperationDetailRow[],
  ): Promise<TriageOperationDetail[]> {
    if (rows.length === 0) return [];
    const tenantId = this.prisma.scopeTenantId();
    // Sem o conjunto congelado, que pode ter dezenas de milhares de ids.
    const targets = await this.prisma.db().$queryRaw<{ id: string; target: unknown }[]>`
      SELECT o."id"::text AS "id", o."target" - 'ids' AS "target"
      FROM "TriageOperation" AS o
      WHERE o."tenantId" = ${tenantId}::uuid AND o."id" = ANY(${rows.map((row) => row.id)}::uuid[])`;
    const byId = new Map(targets.map((row) => [row.id, row.target]));
    const viewer = {
      role: auth.role,
      userId: auth.userId,
      operating: casesOperable(this.config.CASES_MODE),
    };
    const now = this.limits.now();
    return rows.flatMap((row) => toOperationDetail(row, byId.get(row.id), viewer, now) ?? []);
  }

  // -------------------------------------------------------------------------------------------------
  // Pedido
  // -------------------------------------------------------------------------------------------------

  create(auth: RequestAuth, input: TriageOperationCreate): Promise<TriageAnswer> {
    if (input.action === 'undo_all_of') return this.busy(() => this.undoAllOf(auth, input));
    return this.busy(() => this.request(auth, input));
  }

  private async request(
    auth: RequestAuth,
    input: Exclude<TriageOperationCreate, { action: 'undo_all_of' }>,
  ): Promise<TriageAnswer> {
    const { tx, db, tenantId, now } = this.begin('triage.bulk.request');
    if (needsIncidentWrite(input.action) && !hasPermission(auth.role, 'incidents:write')) {
      throw new ForbiddenException();
    }
    await this.assertFilterWithinPlan(input.target);
    await lockTenantTriage(tx, tenantId);
    const request: RequestColumns = {
      action: input.action,
      status: input.action === 'status' ? input.status : null,
      // Ao promover, o incidente ainda não existe.
      incidentId: input.action === 'attach' ? input.incidentId : null,
      includeCritical: input.includeCritical,
      expectedCount: input.expectedCount,
      reason: input.reason ?? null,
      target: input.target,
    };
    const repeated = await this.repeated(auth, tenantId, input.requestId, request);
    if (repeated !== null) return repeated;
    if (input.action === 'attach') await this.assertOpenIncident(db, input.incidentId);
    const scope = await this.scopeOf(db, input.target, now);

    const id = uuidV7(now.getTime());
    const frozen = await freezeOperation(tx, {
      ...request,
      id,
      tenantId,
      requestId: input.requestId,
      action: input.action,
      cutoffAt: now,
      createdById: auth.userId,
      undoUntil: undoDeadline(now),
      now,
      request: input.target,
      scope,
      anchorCaseId: scope.kind === 'cases' && scope.caseIds.length === 1 ? (scope.caseIds[0] ?? null) : null,
      max: this.limits.maxAlerts,
    });
    this.assertScope(input, frozen);
    await this.assertQuota(auth, db, frozen, now);
    const sync = frozen.matched <= this.limits.syncAlerts;
    if (!sync) await this.assertQueue(db);

    if (input.action === 'promote') await this.openIncident(auth, tx, tenantId, id, scope, sync, now);
    if (sync) await this.runHere(tx, tenantId, id, now);
    this.audit.describe({
      resourceId: id,
      before: { alerts: frozen.counts, cases: frozen.cases },
      after: {
        action: input.action,
        ...(input.action === 'status' && { status: input.status }),
        ...(input.action === 'attach' && { incidentId: input.incidentId }),
        target: auditTarget(input.target),
        cutoffAt: now.toISOString(),
        expectedCount: input.expectedCount,
        matched: frozen.matched,
        includeCritical: input.includeCritical,
        excludedCritical: frozen.excludedCritical,
        reason: input.reason ?? null,
        sync,
      },
    });
    return { status: sync ? HttpStatus.CREATED : HttpStatus.ACCEPTED, operation: await this.get(auth, id) };
  }

  /** O histórico do plano vale para o filtro da operação como para o da lista. */
  private async assertFilterWithinPlan(target: object): Promise<void> {
    if (!('filter' in target)) return;
    const filter = target.filter as TriageFilter;
    await this.plan.assertPeriodWithinHistory(filter.period);
    await this.plan.assertRangeWithinHistory(filter.from);
  }

  /** O alvo, conferido no cliente da sessão: um id de fora recusa o pedido inteiro, sem dizer qual. */
  private async scopeOf(
    db: Prisma.TransactionClient,
    target: Exclude<TriageOperationCreate, { action: 'undo_all_of' }>['target'],
    now: Date,
  ): Promise<TriageScope> {
    if ('filter' in target) return { kind: 'filter', filter: caseSetFilter(target.filter, now) };
    if ('findingIds' in target) {
      const found = await db.finding.count({ where: { id: { in: target.findingIds } } });
      if (found !== target.findingIds.length) throw new ApiError(HttpStatus.NOT_FOUND, FINDING_NOT_FOUND);
      return { kind: 'findings', findingIds: target.findingIds };
    }
    const found = await db.alertCase.count({ where: { id: { in: target.caseIds } } });
    if (found !== target.caseIds.length) throw new ApiError(HttpStatus.NOT_FOUND, CASE_NOT_FOUND);
    return { kind: 'cases', caseIds: target.caseIds, group: target.group ?? null };
  }

  private assertScope(
    input: Exclude<TriageOperationCreate, { action: 'undo_all_of' }>,
    { matched, excludedCritical }: Frozen,
  ): void {
    if (matched > this.limits.maxAlerts) {
      throw conflict(
        `São alertas demais para uma operação (o máximo é ${this.limits.maxAlerts}). Estreite o filtro.`,
        TRIAGE_TOO_LARGE_CODE,
        { max: this.limits.maxAlerts },
      );
    }
    if (matched === 0) {
      throw conflict(
        excludedCritical > 0
          ? 'Só há alertas críticos pendentes no alvo. Confirme que eles entram.'
          : 'Não há alerta pendente no alvo.',
        TRIAGE_EMPTY_CODE,
        { count: 0, excludedCritical },
      );
    }
    if (triageScopeChanged(input.expectedCount, matched)) {
      throw conflict(
        `O alvo mudou: agora são ${matched} alertas. Confira e confirme de novo.`,
        TRIAGE_SCOPE_CHANGED_CODE,
        { count: matched, excludedCritical },
      );
    }
    if (
      input.action === 'status' &&
      (input.status === 'legitimate' || input.status === 'resolved') &&
      matched > 1 &&
      input.reason === undefined
    ) {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        'Explique o motivo para marcar mais de um alerta como legítimo ou resolvido.',
        TRIAGE_REASON_REQUIRED_CODE,
      );
    }
  }

  /** Os limites de quem não administra. A operação do pedido já está gravada, e entra na soma. */
  private async assertQuota(
    auth: RequestAuth,
    db: Prisma.TransactionClient,
    { matched }: Frozen,
    now: Date,
  ): Promise<void> {
    if (isMassTriageRole(auth.role)) return;
    const { alertsPerOperation, alertsPerDay } = this.limits;
    if (matched > alertsPerOperation) {
      throw new ApiError(
        HttpStatus.FORBIDDEN,
        `Acima de ${alertsPerOperation} alertas de uma vez, só um administrador.`,
        TRIAGE_QUOTA_CODE,
        { limit: alertsPerOperation, count: matched },
      );
    }
    const { _sum } = await db.triageOperation.aggregate({
      where: {
        createdById: auth.userId,
        action: { in: [...FORWARD_ACTIONS] },
        createdAt: { gt: new Date(now.getTime() - DAY_MS) },
      },
      _sum: { matched: true },
    });
    const total = _sum.matched ?? 0;
    if (total > alertsPerDay) {
      throw new ApiError(
        HttpStatus.FORBIDDEN,
        `Passou do limite de ${alertsPerDay} alertas em 24 horas. Peça a um administrador.`,
        TRIAGE_QUOTA_CODE,
        { limit: alertsPerDay, count: total },
      );
    }
  }

  private async assertQueue(db: Prisma.TransactionClient, adding = 0): Promise<void> {
    const active = await db.triageOperation.count({ where: { state: { in: [...ACTIVE_STATES] } } });
    if (active + adding > this.limits.maxActive) {
      throw conflict(
        'Já há operações demais na fila. Espere uma terminar ou cancele uma.',
        TRIAGE_QUEUE_FULL_CODE,
        { limit: this.limits.maxActive },
      );
    }
  }

  private async assertOpenIncident(db: Prisma.TransactionClient, id: string): Promise<void> {
    const incident = await db.incident.findUnique({ where: { id }, select: { status: true } });
    if (incident === null) throw new ApiError(HttpStatus.NOT_FOUND, INCIDENT_NOT_FOUND);
    if (incident.status === 'resolved') throw incidentResolved();
  }

  /**
   * Abre o incidente da operação, com o alerta que abriu o caso (ou o pior) e até 49 dos piores: o mesmo caminho e o mesmo
   * limite de promover alertas à mão, com um aviso só. O resto do conjunto entra nos lotes.
   */
  private async openIncident(
    auth: RequestAuth,
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    scope: TriageScope,
    sync: boolean,
    now: Date,
  ): Promise<void> {
    await lockFindingsBriefly(tx, tenantId);
    const operation = await this.lockOwn(tx, tenantId, id);
    const first = MAX_INCIDENT_FINDINGS_PER_REQUEST;
    const { ids } = await frozenSlice(
      tx,
      tenantId,
      id,
      0,
      sync ? Math.max(first, this.limits.syncAlerts) : first,
    );
    // Todas as linhas que esta transação vai mudar, antes do primeiro comando que muda alerta.
    await lockFindings(tx, tenantId, ids);
    const head = ids.slice(0, first);
    const valid = await actionableIds(tx, operation, head);
    const anchorId = valid[0];
    if (anchorId === undefined) {
      throw conflict('Não há mais alerta pendente no alvo.', TRIAGE_EMPTY_CODE, { count: 0 });
    }
    await takeItems(tx, operation, valid);
    const incident = await this.incidents.open(auth, { findingIds: valid });
    await markTaken(tx, operation, valid);
    await tx.triageOperation.updateMany({
      where: { id, tenantId },
      data: {
        incidentId: incident.id,
        cursor: String(head.length),
        changed: valid.length,
        skipped: head.length - valid.length,
        updatedAt: now,
      },
    });
    await saveRun(tx, tenantId, id, { ...operation.run, anchorId }, { keepIds: true });
    const wholeCases = scope.kind === 'filter' || (scope.kind === 'cases' && scope.group === null);
    if (wholeCases) await pointCasesAt(tx, tenantId, id, incident.id);
    this.audit.also(incident.details);
  }

  /** A operação inteira, na própria requisição. */
  private async runHere(
    tx: Prisma.TransactionClient,
    tenantId: string,
    operationId: string,
    now: Date,
  ): Promise<void> {
    await lockFindingsBriefly(tx, tenantId);
    for (;;) {
      const outcome = await runTriageBatch(tx, this.auditService, {
        tenantId,
        operationId,
        limit: TRIAGE_BATCH,
        now,
      });
      if (outcome.finished) return;
    }
  }

  /**
   * O pedido que já chegou (`requestId`): a operação que ele criou. O mesmo id num pedido diferente, ou de outra pessoa, é
   * 409. Null se ele é novo.
   */
  private async repeated(
    auth: RequestAuth,
    tenantId: string,
    requestId: string,
    request: RequestColumns,
  ): Promise<TriageAnswer | null> {
    const [row] = await this.prisma.db().$queryRaw<{ id: string; same: boolean }[]>`
      SELECT o."id"::text AS "id",
        o."action" = ${request.action}::text
          AND o."status"::text IS NOT DISTINCT FROM ${request.status}::text
          AND (o."action" = 'promote' OR o."incidentId" IS NOT DISTINCT FROM ${request.incidentId}::uuid)
          AND o."includeCritical" = ${request.includeCritical}::boolean
          AND o."expectedCount" = ${request.expectedCount}::integer
          AND o."reason" IS NOT DISTINCT FROM ${request.reason}::text
          AND o."createdById" IS NOT DISTINCT FROM ${auth.userId}::text
          AND o."target" - 'ids' - 'run' = ${JSON.stringify(request.target)}::jsonb AS "same"
      FROM "TriageOperation" AS o
      WHERE o."tenantId" = ${tenantId}::uuid AND o."requestId" = ${requestId}::uuid`;
    if (row === undefined) return null;
    if (!row.same) throw requestReused();
    this.audit.describe({ action: 'triage.bulk.replay', resourceId: row.id });
    return { status: HttpStatus.OK, operation: await this.get(auth, row.id) };
  }

  // -------------------------------------------------------------------------------------------------
  // Cancelar, continuar e desfazer
  // -------------------------------------------------------------------------------------------------

  /**
   * Para uma operação na fila ou em curso, ou desiste de uma que parou antes do fim (no desfazer, a operação dele volta ao
   * que era). O que os lotes já fizeram fica, e pode ser desfeito no prazo.
   */
  cancel(auth: RequestAuth, id: string): Promise<TriageOperationDetail> {
    return this.busy(async () => {
      const { tx, tenantId, now } = this.begin('triage.bulk.cancel', id);
      // A ordem dos lotes: o lock dos alertas antes da linha da operação. Espera, no máximo, o lote em curso.
      await lockFindingsBriefly(tx, tenantId);
      const operation = await this.lockManaged(auth, tx, tenantId, id);
      if (![...ACTIVE_STATES, ...RESUMABLE_STATES].includes(operation.state)) {
        throw conflict('A operação já terminou.', TRIAGE_NOT_ACTIVE_CODE);
      }
      await this.cancelLocked(tx, operation, now);
      this.audit.describe({
        before: { state: operation.state },
        after: {
          state: 'canceled',
          matched: operation.matched,
          changed: operation.changed,
          skipped: operation.skipped,
        },
      });
      return this.get(auth, id);
    });
  }

  private async cancelLocked(
    tx: Prisma.TransactionClient,
    operation: LockedOperation,
    now: Date,
  ): Promise<void> {
    const { tenantId, id } = operation;
    await saveProgress(tx, tenantId, id, { ...operation, state: 'canceled', now });
    // O prazo do desfazer conta do fim: o da que já tinha parado não recomeça.
    const ending = operation.undoOfId === null && ACTIVE_STATES.includes(operation.state);
    await saveRun(tx, tenantId, id, operation.run, {
      keepIds: false,
      ...(ending && { undoUntil: undoDeadline(now) }),
    });
    if (operation.undoOfId === null) return;
    // A operação que ela desfazia volta ao que era: o que já foi devolvido fica, e dá para desfazer de novo.
    const undone = await lockOperation(tx, tenantId, operation.undoOfId);
    // No meio do desfazer, só a contagem do incidente acompanha (`removeFromIncidentSummary`).
    if (operation.changed > 0) await settleIncident(tx, tenantId, undone?.incidentId ?? null);
    if (undone?.state === 'undoing') {
      const state = operation.run.previousState ?? 'done';
      await saveProgress(tx, tenantId, undone.id, { ...undone, state, now });
    }
  }

  /** Retoma, pelo worker, uma operação que parou antes do fim: o que faltou e o que falhou. */
  continue(auth: RequestAuth, id: string): Promise<TriageOperationDetail> {
    return this.busy(async () => {
      const { tx, db, tenantId, now } = this.begin('triage.bulk.continue', id);
      await lockTenantTriage(tx, tenantId);
      const operation = await this.lockManaged(auth, tx, tenantId, id);
      const row = await db.triageOperation.findUniqueOrThrow({
        where: { id },
        select: { undoUntil: true, updatedAt: true, undoOf: { select: { incidentId: true } } },
      });
      if (!RESUMABLE_STATES.includes(operation.state) || resumeDeadline(row) <= now) {
        throw conflict('Esta operação não pode mais ser continuada.', TRIAGE_NOT_RESUMABLE_CODE);
      }
      const incidentId = operation.incidentId ?? row.undoOf?.incidentId ?? null;
      if (incidentId !== null) await this.assertOpenIncident(db, incidentId);
      await this.assertQueue(db, 1);
      const failed = operation.run.failed.length;
      if (operation.undoOfId === null) {
        await requeueRest(tx, tenantId, id, Number(operation.cursor ?? 0), operation.run);
        await saveProgress(tx, tenantId, id, {
          ...operation,
          state: 'queued',
          cursor: null,
          skipped: operation.skipped - failed,
          now,
        });
      } else {
        // O desfazer relê os alertas da operação do começo; os que já voltaram não contam de novo.
        await saveRun(tx, tenantId, id, { ...operation.run, failed: [], stop: null }, { keepIds: false });
        await saveProgress(tx, tenantId, id, {
          ...operation,
          state: 'queued',
          cursor: null,
          skipped: 0,
          now,
        });
      }
      this.audit.describe({
        before: { state: operation.state, stop: operation.run.stop, failed },
        after: { state: 'queued', matched: operation.matched, changed: operation.changed },
      });
      return this.get(auth, id);
    });
  }

  /** Desfaz uma operação, até 24 horas depois do fim dela. */
  undo(auth: RequestAuth, id: string, input: TriageUndo): Promise<TriageAnswer> {
    return this.busy(async () => {
      const { tx, db, tenantId, now } = this.begin('triage.bulk.undo', id);
      await lockTenantTriage(tx, tenantId);
      const repeated = await this.repeatedUndo(auth, db, id, input);
      if (repeated !== null) return repeated;
      // Antes das linhas da operação e do incidente: é a ordem dos lotes e das mudanças de incidente.
      await lockFindingsBriefly(tx, tenantId);
      const operation = await this.lockManaged(auth, tx, tenantId, id);
      this.assertUndoable(auth, operation, now);
      if (operation.incidentId !== null) {
        const incident = await lockIncident(tx, tenantId, operation.incidentId);
        if (incident?.status === 'resolved') throw incidentResolved();
      }
      const undoId = await this.enqueueUndo(tx, auth, operation, {
        requestId: input.requestId,
        reason: input.reason ?? null,
        now,
        at: now,
      });
      const { matched } = await db.triageOperation.findUniqueOrThrow({
        where: { id: undoId },
        select: { matched: true },
      });
      const sync = matched <= this.limits.syncAlerts;
      if (sync) await this.runHere(tx, tenantId, undoId, now);
      this.audit.describe({
        before: { state: operation.state, changed: operation.changed },
        after: {
          undoId,
          matched,
          removed: operation.changed - matched,
          reason: input.reason ?? null,
          sync,
        },
      });
      return {
        status: sync ? HttpStatus.CREATED : HttpStatus.ACCEPTED,
        operation: await this.get(auth, undoId),
      };
    });
  }

  private assertUndoable(auth: RequestAuth, operation: LockedOperation, now: Date): void {
    if (!FORWARD_ACTIONS.includes(operation.action)) {
      throw conflict('Esta operação não pode ser desfeita.', TRIAGE_NOT_UNDOABLE_CODE);
    }
    if (needsIncidentWrite(operation.action) && !hasPermission(auth.role, 'incidents:write')) {
      throw new ForbiddenException();
    }
    if (ACTIVE_STATES.includes(operation.state)) {
      throw conflict('A operação ainda está em curso. Cancele antes de desfazer.', TRIAGE_STILL_ACTIVE_CODE);
    }
    if (!UNDOABLE_STATES.includes(operation.state) || operation.changed === 0) {
      throw conflict('Esta operação não pode ser desfeita.', TRIAGE_NOT_UNDOABLE_CODE);
    }
    if (operation.undoUntil === null || operation.undoUntil <= now) {
      throw conflict('O prazo de 24 horas para desfazer já passou.', TRIAGE_UNDO_EXPIRED_CODE);
    }
  }

  /** Cria a operação que desfaz a outra, já travada, e marca a outra como em desfazer. Devolve o id da nova. */
  private async enqueueUndo(
    tx: Prisma.TransactionClient,
    auth: RequestAuth,
    operation: LockedOperation,
    { requestId, reason, now, at }: { requestId: string; reason: string | null; now: Date; at: Date },
  ): Promise<string> {
    const { tenantId, id: undoOfId } = operation;
    const matched = await tx.triageOperationItem.count({ where: { tenantId, operationId: undoOfId } });
    const id = uuidV7(at.getTime());
    await tx.triageOperation.create({
      data: {
        id,
        tenantId,
        requestId,
        action: 'undo',
        undoOfId,
        target: { operationId: undoOfId, run: { ...EMPTY_RUN, previousState: operation.state } },
        includeCritical: true,
        cutoffAt: now,
        expectedCount: operation.changed,
        reason,
        state: 'queued',
        matched,
        createdById: auth.userId,
        createdAt: at,
      },
      select: { id: true },
    });
    await saveProgress(tx, tenantId, undoOfId, { ...operation, state: 'undoing', now });
    return id;
  }

  private async repeatedUndo(
    auth: RequestAuth,
    db: Prisma.TransactionClient,
    undoOfId: string,
    { requestId }: TriageUndo,
  ): Promise<TriageAnswer | null> {
    const row = await db.triageOperation.findFirst({
      where: { requestId },
      select: { id: true, undoOfId: true, createdById: true },
    });
    if (row === null) return null;
    if (row.undoOfId !== undoOfId || row.createdById !== auth.userId) throw requestReused();
    this.audit.describe({ action: 'triage.bulk.replay', resourceId: row.id });
    return { status: HttpStatus.OK, operation: await this.get(auth, row.id) };
  }

  /**
   * Desfaz tudo o que uma pessoa fez em massa neste cliente e ainda está no prazo, da operação mais recente para a mais
   * antiga: cancela as que estão na fila ou em curso e põe um desfazer na fila para cada uma. Só de quem administra. O
   * alerta que duas operações dela mudaram volta ao que era antes da última.
   */
  private async undoAllOf(
    auth: RequestAuth,
    input: Extract<TriageOperationCreate, { action: 'undo_all_of' }>,
  ): Promise<TriageAnswer> {
    const { tx, db, tenantId, now } = this.begin('triage.bulk.undo_all');
    if (!isMassTriageRole(auth.role)) throw new ForbiddenException();
    const { userId } = input.target;
    await lockTenantTriage(tx, tenantId);
    const repeated = await this.repeated(auth, tenantId, input.requestId, {
      action: 'undo_all_of',
      status: null,
      incidentId: null,
      includeCritical: true,
      expectedCount: 0,
      reason: input.reason,
      target: input.target,
    });
    if (repeated !== null) return repeated;
    const where: Prisma.TriageOperationWhereInput = {
      createdById: userId,
      action: { in: [...FORWARD_ACTIONS] },
      OR: [
        { state: { in: [...ACTIVE_STATES] } },
        { state: { in: [...UNDOABLE_STATES] }, changed: { gt: 0 }, undoUntil: { gt: now } },
      ],
    };
    const total = await db.triageOperation.count({ where });
    const found = await db.triageOperation.findMany({
      where,
      select: { id: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_UNDO_ALL_OPERATIONS,
    });
    const canceled: string[] = [];
    const undone: string[] = [];
    // Antes das linhas das operações, como nos lotes.
    await lockFindingsBriefly(tx, tenantId);
    for (const { id } of found) {
      const operation = await this.lockOwn(tx, tenantId, id);
      const active = ACTIVE_STATES.includes(operation.state);
      if (active) {
        await this.cancelLocked(tx, operation, now);
        canceled.push(id);
      }
      // Pode ter terminado, ou alguém a ter desfeito, enquanto a linha não era desta transação.
      const undoable = active || (UNDOABLE_STATES.includes(operation.state) && operation.changed > 0);
      if (!undoable || operation.changed === 0) continue;
      await this.enqueueUndo(
        tx,
        auth,
        { ...operation, state: active ? 'canceled' : operation.state },
        {
          requestId: randomUUID(),
          reason: input.reason,
          now,
          // A fila é pela data: a mais recente é desfeita primeiro.
          at: new Date(now.getTime() + undone.length),
        },
      );
      undone.push(id);
    }
    if (canceled.length === 0 && undone.length === 0) {
      throw conflict('Esta pessoa não tem operação que possa ser desfeita.', TRIAGE_EMPTY_CODE, { count: 0 });
    }
    const id = uuidV7(now.getTime());
    await tx.triageOperation.create({
      data: {
        id,
        tenantId,
        requestId: input.requestId,
        action: 'undo_all_of',
        target: { ...input.target },
        includeCritical: true,
        cutoffAt: now,
        expectedCount: 0,
        reason: input.reason,
        state: 'done',
        matched: total,
        changed: undone.length,
        skipped: total - undone.length,
        createdById: auth.userId,
        createdAt: now,
      },
      select: { id: true },
    });
    this.audit.describe({
      resourceId: id,
      after: { userId, operations: total, canceled, undone, reason: input.reason },
    });
    return { status: HttpStatus.ACCEPTED, operation: await this.get(auth, id) };
  }

  // -------------------------------------------------------------------------------------------------
  // Apoio
  // -------------------------------------------------------------------------------------------------

  /** O cliente da sessão (a recusa sem cliente vem antes de tudo), a transação da requisição e o começo da auditoria. */
  private begin(action: string, resourceId?: string) {
    const db = this.prisma.scoped();
    this.audit.describe({
      action,
      resourceType: 'triage_operation',
      ...(resourceId !== undefined && { resourceId }),
    });
    return {
      db,
      tx: this.prisma.db(),
      tenantId: this.prisma.scopeTenantId(),
      now: this.limits.now(),
    };
  }

  private async lockOwn(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
  ): Promise<LockedOperation> {
    const operation = await lockOperation(tx, tenantId, id);
    if (operation === null) throw new ApiError(HttpStatus.NOT_FOUND, NOT_FOUND);
    return operation;
  }

  /** A operação do cliente, travada, se quem pede pode mexer nela: quem a pediu, ou quem administra. */
  private async lockManaged(
    auth: RequestAuth,
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
  ): Promise<LockedOperation> {
    const operation = await this.lockOwn(tx, tenantId, id);
    if (!mayManage(auth, operation)) throw new ForbiddenException();
    return operation;
  }

  /** Os prazos da transação, e o banco ocupado demais como 503: nada foi gravado, e dá para tentar de novo. */
  private async busy<T>(work: () => Promise<T>): Promise<T> {
    try {
      await setTriageTimeouts(this.prisma.db(), LOCK_TIMEOUT_MS, STATEMENT_TIMEOUT_MS);
      return await work();
    } catch (error) {
      const sqlState = sqlStateOf(error);
      if (!BUSY.has(sqlState)) throw error;
      this.logger.warn({ sqlState }, 'o banco estava ocupado demais para a triagem em massa');
      throw new ServiceUnavailableException();
    }
  }
}

/** O que do pedido vira coluna, para reconhecer o repetido. */
interface RequestColumns {
  action: string;
  status: 'new' | 'investigating' | 'legitimate' | 'resolved' | null;
  incidentId: string | null;
  includeCritical: boolean;
  expectedCount: number;
  reason: string | null;
  target: object;
}

const requestReused = (): ApiError =>
  conflict('Este pedido já foi usado em outra operação.', TRIAGE_REQUEST_REUSED_CODE);

const incidentResolved = (): ApiError =>
  conflict(
    'Incidente resolvido não muda de alertas. Reabra o incidente antes.',
    TRIAGE_INCIDENT_RESOLVED_CODE,
  );

/** Quantos ids de alerta vão para a trilha: os itens da operação guardam todos, e um estado tem no máximo 16 KB. */
const AUDIT_IDS_MAX = 100;

/** O alvo como vai para a trilha: sempre bem menor que o teto de um estado. */
function auditTarget(target: object): object {
  if (!('findingIds' in target)) return target;
  const ids = target.findingIds as string[];
  return { findings: ids.length, findingIds: ids.slice(0, AUDIT_IDS_MAX) };
}
