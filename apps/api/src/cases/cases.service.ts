import { HttpStatus, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  CASE_PREVIEW_SAMPLES,
  CASE_SEAL_REASONS,
  type CaseAnalysis,
  type CaseDetail,
  type CaseFindingPage,
  type CaseFindingsQuery,
  type CaseGroup,
  type CaseGroupsQuery,
  type CaseListQuery,
  type CaseOperation,
  type CaseStatus,
  type CaseSummary,
  type CaseTimeline,
  type FindingTriage,
  hasPermission,
  INVALID_CASE_CURSOR_CODE,
  MAX_CASE_GROUPS,
  MAX_CASE_INCIDENTS,
  MAX_CASE_OPERATIONS,
  MAX_FINDING_OPERATIONS,
  MAX_PREVIOUS_CASES,
  MAX_RARE_VALUES,
  type Paginated,
} from '@verax/shared';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { ApiError } from '../common/http/api-error.js';
import { toPaginated, toPrismaPage } from '../common/http/pagination.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { escapeLike } from '../findings/finding-filters.js';
import { findingSelect, toFinding } from '../findings/findings.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { CASE_ASSIGN_TASK } from './case-assign-job.js';
import { boundedRead } from './case-bounded.js';
import { CASE_CURSOR_START, caseCursorScope, decodeCaseCursor, encodeCaseCursor } from './case-cursor.js';
import { caseSetFilter } from './case-filter.js';
import { caseProtectedItems } from './case-protected.js';
import { worstPending } from './case-radar.js';
import {
  caseAnalysis,
  type CaseAnalysisRow,
  caseFindingKeys,
  caseGroupsPage,
  caseListPage,
  oldestUnassignedAt,
  previousCaseIds,
  timelineCounts,
  timelineRange,
  treatedRecurrences,
} from './case-read-store.js';
import { sourcesOfCase } from './case-sources.js';
import { partsOf } from './case-store.js';
import { fillTimeline, timelineCap, timelineWindow } from './case-timeline.js';
import { casesOperable, casesVisibleTo } from './cases-mode.js';
import {
  caseOperationSelect,
  known,
  operationCan,
  operationSelect,
  type OperationViewer,
  toOperation,
} from './triage-view.js';

/** Os tetos da leitura dos alertas de um caso: um com milhões deles não prende o banco. */
export interface CaseReadLimits {
  /** Quantos alertas, os mais recentes, o detalhe lê para as contas dele, e por quanto tempo. */
  analysisAlerts: number;
  analysisTimeoutMs: number;
  /** O prazo da linha do tempo. */
  timelineTimeoutMs: number;
}
export const DEFAULT_CASE_READ_LIMITS: CaseReadLimits = {
  analysisAlerts: 50_000,
  analysisTimeoutMs: 1_500,
  timelineTimeoutMs: 3_000,
};
/** Os tetos, como provider (os testes usam menores). */
export const CASE_READ_LIMITS = Symbol('CASE_READ_LIMITS');

const CASE_NOT_FOUND = 'Caso não encontrado';
const FINDING_NOT_FOUND = 'Alerta não encontrado';

const countSelect = {
  total: true,
  newCount: true,
  investigatingCount: true,
  legitimateCount: true,
  resolvedCount: true,
  incidentCount: true,
} as const satisfies Prisma.AlertCaseSelect;

const caseSelect = {
  ...countSelect,
  id: true,
  queue: true,
  family: true,
  title: true,
  keyParts: true,
  previousCaseId: true,
  recurrence: true,
  openedAt: true,
  sealedAt: true,
  sealReason: true,
  firstSeenAt: true,
  lastSeenAt: true,
  lastAlertAt: true,
  pendingCritical: true,
  pendingHigh: true,
  pendingMedium: true,
  pendingLow: true,
  ruleIds: true,
  accounts: true,
  actors: true,
  accessKeys: true,
  ips: true,
  resources: true,
  mitreTactics: true,
  mitreTechniques: true,
  incidentId: true,
} as const satisfies Prisma.AlertCaseSelect;

type CaseRow = Prisma.AlertCaseGetPayload<{ select: typeof caseSelect }>;
type CountRow = Prisma.AlertCaseGetPayload<{ select: typeof countSelect }>;

const countsOf = (row: CountRow): CaseSummary['counts'] => ({
  total: row.total,
  new: row.newCount,
  investigating: row.investigatingCount,
  legitimate: row.legitimateCount,
  resolved: row.resolvedCount,
  incident: row.incidentCount,
});

const head = (values: readonly string[]): string[] => values.slice(0, CASE_PREVIEW_SAMPLES);

/** O caso toca a lista de proteção, pelo que está nas amostras. */
function touchesProtectedSample(row: CaseRow, protectedItems: ReadonlySet<string>): boolean {
  return [...row.resources, ...row.actors, ...row.accessKeys, ...row.ips].some((value) =>
    protectedItems.has(value),
  );
}

function toCaseSummary(
  row: CaseRow,
  protectedItems: ReadonlySet<string>,
  treatedBefore: ReadonlyMap<string, number>,
): CaseSummary {
  const keyParts = partsOf(row.keyParts);
  return {
    id: row.id,
    queue: row.queue,
    family: row.family,
    title: row.title,
    keyParts,
    sources: sourcesOfCase({ family: row.family, ruleIds: row.ruleIds, keyParts }),
    severity: worstPending(row),
    protected: touchesProtectedSample(row, protectedItems),
    pending: {
      critical: row.pendingCritical,
      high: row.pendingHigh,
      medium: row.pendingMedium,
      low: row.pendingLow,
    },
    counts: countsOf(row),
    sealedAt: row.sealedAt?.toISOString() ?? null,
    sealReason: known(CASE_SEAL_REASONS, row.sealReason),
    recurrence: row.recurrence,
    recurrenceTreated: treatedBefore.get(row.id) ?? 0,
    openedAt: row.openedAt.toISOString(),
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    lastAlertAt: row.lastAlertAt.toISOString(),
    preview: {
      accounts: head(row.accounts),
      actors: head(row.actors),
      ips: head(row.ips),
      resources: head(row.resources),
    },
    mitreTactics: row.mitreTactics,
  };
}

function toAnalysis(row: CaseAnalysisRow, total: number, limit: number): CaseAnalysis {
  const rare = (distinct: number, values: CaseAnalysisRow['rareIps']) => ({
    distinct,
    values: values.map(({ value, count, lastSeen }) => ({
      value,
      count,
      lastSeenAt: new Date(lastSeen).toISOString(),
    })),
  });
  return {
    alerts: row.alerts,
    complete: row.alerts < limit || total <= limit,
    rare: { ips: rare(row.distinctIps, row.rareIps), users: rare(row.distinctUsers, row.rareUsers) },
    groups: {
      distinct: row.distinctGroups,
      values: row.groups.map(({ value, total: alerts, critical, high, medium, low }) => ({
        value,
        total: alerts,
        pending: { critical, high, medium, low },
      })),
    },
    stillActive: row.stillActive,
  };
}

/**
 * A leitura dos casos do cliente da sessão. Só lê: quem abre e sela caso é o worker, e a pessoa trata alertas, um por um ou
 * em massa (`triage-operations.service.ts`).
 *
 * Todo id que sai para a tela é lido pelo escopo do cliente (`scoped()`); as contas e a ordem em SQL
 * (`case-read-store.ts`) levam o cliente da sessão em cada comando. Caso ou alerta de outro cliente é 404, igual a um que
 * não existe.
 */
@Injectable()
export class CasesService {
  private readonly logger = new Logger(CasesService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'CASES_MODE'>,
    @Inject(CASE_READ_LIMITS) private readonly limits: CaseReadLimits,
  ) {}

  /** A situação dos casos para quem está vendo. Com eles desligados (ou invisíveis), nem o banco é lido. */
  async status(auth: RequestAuth, now = new Date()): Promise<CaseStatus> {
    const mode = this.config.CASES_MODE;
    if (!casesVisibleTo(mode, auth.role)) return { mode: 'off', asOf: null, oldestUnassignedMinutes: null };
    // Do nó, e não de um cliente: só o horário da última passagem da tarefa.
    const task = await this.prisma
      .db()
      .syncState.findUnique({ where: { name: CASE_ASSIGN_TASK }, select: { lastRunAt: true } });
    const oldest =
      auth.scopeTenantId === null
        ? null
        : await oldestUnassignedAt(this.prisma.db(), this.prisma.scopeTenantId());
    return {
      mode,
      asOf: task?.lastRunAt?.toISOString() ?? null,
      oldestUnassignedMinutes:
        oldest === null ? null : Math.max(0, Math.floor((now.getTime() - oldest.getTime()) / 60_000)),
    };
  }

  async list(query: CaseListQuery, now = new Date()): Promise<Paginated<CaseSummary>> {
    const db = this.prisma.scoped();
    const protectedItems = await caseProtectedItems(db);
    const { skip, take } = toPrismaPage(query);
    const { total, ids } = await caseListPage(this.prisma.db(), this.prisma.scopeTenantId(), {
      ...caseSetFilter(query, now),
      sort: query.sort,
      protectedItems: [...protectedItems],
      limit: take,
      offset: skip,
    });
    const rows =
      ids.length === 0 ? [] : await db.alertCase.findMany({ where: { id: { in: ids } }, select: caseSelect });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const treatedBefore = await this.treatedBefore(rows);
    // Um caso que saiu entre as duas leituras (expurgo) só some da página.
    const items = ids.flatMap((id) => {
      const row = byId.get(id);
      return row === undefined ? [] : [toCaseSummary(row, protectedItems, treatedBefore)];
    });
    return toPaginated(items, total, query);
  }

  async groups(query: CaseGroupsQuery): Promise<Paginated<CaseGroup>> {
    const { skip, take } = toPrismaPage(query);
    const { total, items } = await caseGroupsPage(this.prisma.db(), this.prisma.scopeTenantId(), {
      by: query.by,
      state: query.state,
      severity: query.severity ?? null,
      accountId: query.accountId ?? null,
      pattern: query.q === undefined ? null : `%${escapeLike(query.q)}%`,
      limit: take,
      offset: skip,
    });
    const groups = items.map(({ value, cases, critical, high, medium, low }) => ({
      value,
      cases,
      pending: { critical, high, medium, low },
    }));
    return toPaginated(groups, total, query);
  }

  async get(auth: RequestAuth, id: string, now = new Date()): Promise<CaseDetail> {
    const db = this.prisma.scoped();
    const row = await db.alertCase.findUnique({ where: { id }, select: caseSelect });
    if (!row) throw new ApiError(HttpStatus.NOT_FOUND, CASE_NOT_FOUND);
    const tenantId = this.prisma.scopeTenantId();
    const protectedItems = await caseProtectedItems(db);
    const analysis = await this.bounded(this.limits.analysisTimeoutMs, (tx) =>
      caseAnalysis(tx, tenantId, id, {
        alerts: this.limits.analysisAlerts,
        rare: MAX_RARE_VALUES,
        groups: MAX_CASE_GROUPS,
        incidents: MAX_CASE_INCIDENTS,
        operations: MAX_CASE_OPERATIONS,
      }),
    );
    if (analysis === null) this.logger.warn({ caseId: id }, 'a leitura dos alertas do caso passou do prazo');
    // Na medição (`shadow`) ninguém opera, nem a equipe da Verax: as escritas respondem 404.
    const operating = casesOperable(this.config.CASES_MODE);
    const triage = operating && hasPermission(auth.role, 'findings:triage');
    return {
      ...toCaseSummary(row, protectedItems, await this.treatedBefore([row])),
      samples: {
        ruleIds: row.ruleIds,
        accounts: row.accounts,
        actors: row.actors,
        ips: row.ips,
        resources: row.resources,
        mitreTechniques: row.mitreTechniques,
      },
      analysis: analysis === null ? null : toAnalysis(analysis, row.total, this.limits.analysisAlerts),
      previous: await this.previousCases(db, tenantId, row.previousCaseId),
      incidents: await this.incidents(db, row.incidentId, analysis?.incidents ?? []),
      operations: await this.operations(
        db,
        analysis?.operationIds ?? [],
        { role: auth.role, userId: auth.userId, operating },
        now,
      ),
      can: { triage, promote: triage && hasPermission(auth.role, 'incidents:write') },
    };
  }

  async findings(id: string, query: CaseFindingsQuery): Promise<CaseFindingPage> {
    const db = this.prisma.scoped();
    await this.assertCase(db, id);
    const scope = caseCursorScope(id, query);
    const after = query.cursor === undefined ? CASE_CURSOR_START : decodeCaseCursor(query.cursor, scope);
    if (after === null) {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        'A página pedida não é desta lista. Volte ao começo.',
        INVALID_CASE_CURSOR_CODE,
      );
    }
    // Um a mais que a página: diz se há outra.
    const keys = await caseFindingKeys(this.prisma.db(), this.prisma.scopeTenantId(), id, {
      after,
      status: query.status ?? null,
      severity: query.severity ?? null,
      group: query.group ?? null,
      limit: query.pageSize + 1,
    });
    const page = keys.slice(0, query.pageSize);
    const last = page.at(-1);
    const rows =
      page.length === 0
        ? []
        : await db.finding.findMany({
            where: { id: { in: page.map((key) => key.id) } },
            select: { ...findingSelect, caseGroup: true, lastSeenAt: true, triagedAt: true },
          });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return {
      items: page.flatMap((key) => {
        const row = byId.get(key.id);
        if (row === undefined) return [];
        return [
          {
            finding: toFinding(row),
            group: row.caseGroup,
            lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
            stillActive:
              row.incidentId === null &&
              row.status === 'resolved' &&
              row.lastSeenAt !== null &&
              row.triagedAt !== null &&
              row.lastSeenAt > row.triagedAt,
          },
        ];
      }),
      nextCursor:
        keys.length > query.pageSize && last !== undefined
          ? encodeCaseCursor(last.occurredAt, last.id, scope)
          : null,
    };
  }

  async timeline(id: string, now = new Date()): Promise<CaseTimeline> {
    await this.assertCase(this.prisma.scoped(), id);
    const tenantId = this.prisma.scopeTenantId();
    const cap = timelineCap(now);
    const timeline = await this.bounded(this.limits.timelineTimeoutMs, async (tx): Promise<CaseTimeline> => {
      const { oldest, newest, beyond } = await timelineRange(tx, tenantId, id, cap);
      if (oldest === null || newest === null) {
        return { granularity: 'hour', from: null, to: null, truncated: beyond, buckets: [] };
      }
      const window = timelineWindow(oldest, newest);
      return {
        granularity: window.granularity,
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        truncated: beyond || oldest < window.from,
        buckets: fillTimeline(window, await timelineCounts(tx, tenantId, id, window, cap)),
      };
    });
    if (timeline === null) {
      this.logger.warn({ caseId: id }, 'a linha do tempo do caso passou do prazo');
      throw new ServiceUnavailableException();
    }
    return timeline;
  }

  /** As operações de triagem em massa que mexeram num alerta. A triagem de um alerta só não é uma operação. */
  async findingTriage(id: string): Promise<FindingTriage> {
    const db = this.prisma.scoped();
    const finding = await db.finding.findUnique({ where: { id }, select: { triageOpId: true } });
    if (!finding) throw new ApiError(HttpStatus.NOT_FOUND, FINDING_NOT_FOUND);
    const rows = await db.triageOperationItem.findMany({
      where: { findingId: id },
      // A chave estrangeira do item leva o cliente: a operação é sempre do mesmo.
      select: { createdAt: true, previousStatus: true, operation: { select: operationSelect } },
      orderBy: [{ createdAt: 'desc' }, { operationId: 'desc' }],
      take: MAX_FINDING_OPERATIONS,
    });
    const operations = rows.flatMap((row) => {
      const operation = toOperation(row.operation);
      return operation === null
        ? []
        : [{ operation, at: row.createdAt.toISOString(), previousStatus: row.previousStatus }];
    });
    return {
      operation: operations.find((entry) => entry.operation.id === finding.triageOpId) ?? null,
      operations,
    };
  }

  /** Dos casos que já voltaram, quantas vezes foi depois de tratado. */
  private async treatedBefore(
    rows: readonly { id: string; recurrence: number }[],
  ): Promise<ReadonlyMap<string, number>> {
    const ids = rows.filter((row) => row.recurrence > 0).map((row) => row.id);
    if (ids.length === 0) return new Map();
    const counts = await treatedRecurrences(this.prisma.db(), this.prisma.scopeTenantId(), ids);
    return new Map(counts.map(({ id, treated }) => [id, treated]));
  }

  private async assertCase(db: Prisma.TransactionClient, id: string): Promise<void> {
    const row = await db.alertCase.findUnique({ where: { id }, select: { id: true } });
    if (!row) throw new ApiError(HttpStatus.NOT_FOUND, CASE_NOT_FOUND);
  }

  private async previousCases(
    db: Prisma.TransactionClient,
    tenantId: string,
    previousCaseId: string | null,
  ): Promise<CaseDetail['previous']> {
    if (previousCaseId === null) return [];
    const ids = await previousCaseIds(this.prisma.db(), tenantId, previousCaseId, MAX_PREVIOUS_CASES);
    const rows = await db.alertCase.findMany({
      where: { id: { in: ids } },
      select: {
        ...countSelect,
        id: true,
        openedAt: true,
        sealedAt: true,
        sealReason: true,
        lastAlertAt: true,
      },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      if (row === undefined) return [];
      return [
        {
          id,
          openedAt: row.openedAt.toISOString(),
          sealedAt: row.sealedAt?.toISOString() ?? null,
          sealReason: known(CASE_SEAL_REASONS, row.sealReason),
          lastAlertAt: row.lastAlertAt.toISOString(),
          pending: row.newCount + row.investigatingCount,
          counts: countsOf(row),
        },
      ];
    });
  }

  private async incidents(
    db: Prisma.TransactionClient,
    promotedId: string | null,
    ofAlerts: readonly { id: string; alerts: number }[],
  ): Promise<CaseDetail['incidents']> {
    const alertsById = new Map(ofAlerts.map(({ id, alerts }) => [id, alerts]));
    const ids = [...new Set([...(promotedId === null ? [] : [promotedId]), ...alertsById.keys()])];
    if (ids.length === 0) return [];
    const rows = await db.incident.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true, severity: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      return row === undefined
        ? []
        : [{ ...row, alerts: alertsById.get(id) ?? 0, promoted: id === promotedId }];
    });
  }

  private async operations(
    db: Prisma.TransactionClient,
    ids: readonly string[],
    viewer: OperationViewer,
    now: Date,
  ): Promise<CaseOperation[]> {
    if (ids.length === 0) return [];
    const rows = await db.triageOperation.findMany({
      // As que elas desfizeram também: a chave estrangeira do desfazer leva o cliente.
      where: { OR: [{ id: { in: [...ids] } }, { undoneBy: { some: { id: { in: [...ids] } } } }] },
      select: caseOperationSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_CASE_OPERATIONS,
    });
    return rows.flatMap((row) => {
      const operation = toOperation(row);
      return operation === null ? [] : [{ ...operation, can: operationCan(row, viewer, now) }];
    });
  }

  private bounded<T>(
    milliseconds: number,
    read: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T | null> {
    return boundedRead(this.prisma, milliseconds, read);
  }
}
