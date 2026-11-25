import { randomUUID } from 'node:crypto';
import { SyncLease } from '../alerts/finding-store.js';
import { errorKind } from '../common/logger/error-kind.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { CaseLogger } from './case-assign-job.js';
import { setLockTimeout } from './case-store.js';

/** Nome da tarefa no agendador e da linha no `SyncState` (concessão, até onde foi e quando terminou a última volta). */
export const CASE_RECONCILE_TASK = 'case-reconcile';
/** De quanto em quanto tempo a tarefa confere se já é hora (e continua a volta que não coube na execução anterior). */
export const CASE_RECONCILE_CHECK_MS = 60 * 60_000;
/** Uma volta por semana. */
export const CASE_RECONCILE_EVERY_MS = 7 * 24 * 60 * 60_000;
/** A volta em que algum caso falhou se repete inteira depois disto, e não na semana seguinte. */
export const CASE_RECONCILE_RETRY_MS = 24 * 60 * 60_000;
/** O `lastError` da volta em que algum caso falhou. */
const INCOMPLETE = 'cases_failed';
export const CASE_RECONCILE_MAX_RUN_MS = 4 * 60_000;
export const CASE_RECONCILE_BUDGET_MS = CASE_RECONCILE_MAX_RUN_MS + 60_000;
const PAGE = 100;
const TRANSACTION = { maxWait: 10_000, timeout: 30_000 } as const;

/** As contagens do caso (as dos gatilhos). */
const COUNTERS = [
  'total',
  'pendingCritical',
  'pendingHigh',
  'pendingMedium',
  'pendingLow',
  'newCount',
  'investigatingCount',
  'legitimateCount',
  'resolvedCount',
  'incidentCount',
] as const;
type Counters = Record<(typeof COUNTERS)[number], number> & { pending: boolean };

export interface CaseReconcileReport {
  /** `not_due`: a última volta terminou há menos de uma semana; `partial`: o tempo acabou, e a próxima continua. */
  status: 'done' | 'partial' | 'not_due' | 'locked' | 'lease_lost';
  checked: number;
  /** Casos com contagem errada, corrigidos. O esperado é sempre zero. */
  drifted: number;
  failed: number;
}

export interface CaseReconcileOptions {
  logger?: CaseLogger;
  now?: () => Date;
  elapsed?: () => number;
  name?: string;
  owner?: string;
  leaseMs?: number;
  maxRunMs?: number;
  page?: number;
  /** Só os testes, que dividem o banco: restringe a tarefa a estes clientes. */
  tenantIds?: readonly string[];
}

/**
 * Conferência semanal das contagens dos casos: refaz as de cada caso a partir dos alertas e corrige a que não bate. Fora
 * os gatilhos do alerta, é a única escrita de contagem; nenhum service as grava.
 *
 * Um caso por transação: trava a linha dele (`FOR UPDATE`) e só então, noutro comando, conta os alertas. Em READ
 * COMMITTED, a contagem vê tudo o que já foi confirmado; o que está no meio (o gatilho esperando por esta linha) soma a
 * própria diferença depois, sobre o valor novo. Por isso é exata com a triagem e a atribuição rodando. Só trava casos,
 * um por vez, e nenhum alerta: não entra em ciclo com ninguém.
 *
 * Um caso com erro não para os outros, e a volta em que algum falhou se repete no dia seguinte (`lastError`). A que não
 * cabe no tempo continua de onde parou (`cursorId`, o cliente e o caso).
 */
export class CaseReconcileJob {
  private readonly lease: SyncLease;
  private readonly now: () => Date;
  private readonly elapsed: () => number;
  private readonly name: string;
  private readonly pageSize: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly options: CaseReconcileOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.elapsed = options.elapsed ?? (() => performance.now());
    this.name = options.name ?? CASE_RECONCILE_TASK;
    this.pageSize = options.page ?? PAGE;
    this.lease = new SyncLease(
      prisma,
      this.name,
      options.owner ?? `worker-${randomUUID()}`,
      options.leaseMs ?? 2 * 60_000,
    );
  }

  async runOnce(signal: AbortSignal = new AbortController().signal): Promise<CaseReconcileReport> {
    const report: CaseReconcileReport = { status: 'done', checked: 0, drifted: 0, failed: 0 };
    const startedAt = this.now();
    if (!(await this.due(startedAt))) return { ...report, status: 'not_due' };
    if (!(await this.lease.acquire(new Date()))) return { ...report, status: 'locked' };
    const deadline = this.elapsed() + (this.options.maxRunMs ?? CASE_RECONCILE_MAX_RUN_MS);
    try {
      // De novo, com a concessão: outra réplica pode ter terminado a volta no meio.
      if (!(await this.due(startedAt))) return { ...report, status: 'not_due' };
      const state = await this.prisma.syncState.findUniqueOrThrow({
        where: { name: this.name },
        select: { cursorId: true, lastError: true },
      });
      const [resumeTenant, resumeCase] = (state.cursorId ?? '').split('/');
      // A falha de uma execução anterior da mesma volta também conta.
      const failedBefore = state.cursorId !== null && state.lastError !== null;
      const lastError = () => (failedBefore || report.failed > 0 ? INCOMPLETE : null);
      for (const tenantId of await this.tenants(resumeTenant)) {
        let after = tenantId === resumeTenant ? resumeCase : undefined;
        for (;;) {
          const page = await this.prisma.alertCase.findMany({
            where: { tenantId, ...(after !== undefined && { id: { gt: after } }) },
            select: { id: true },
            orderBy: { id: 'asc' },
            take: this.pageSize,
          });
          for (const row of page) {
            signal.throwIfAborted();
            await this.check(tenantId, row.id, report);
          }
          after = page.at(-1)?.id;
          if (after === undefined) break;
          await this.prisma.syncState.update({
            where: { name: this.name },
            data: { lastRunAt: startedAt, cursorId: `${tenantId}/${after}`, lastError: lastError() },
          });
          if (this.elapsed() >= deadline) return { ...report, status: 'partial' };
          if (!(await this.lease.renew())) return { ...report, status: 'lease_lost' };
        }
      }
      await this.prisma.syncState.update({
        where: { name: this.name },
        data: {
          lastRunAt: startedAt,
          cursorId: null,
          lastError: lastError(),
          ...(lastError() === null && { lastSuccessAt: this.now() }),
        },
      });
      return report;
    } finally {
      if (report.drifted > 0) {
        this.options.logger?.warn(
          { drifted: report.drifted, checked: report.checked },
          'contagens de casos corrigidas na conferência',
        );
      }
      await this.lease.release();
    }
  }

  /** Os clientes a conferir, do ponto em que a volta parou em diante. */
  private async tenants(from: string | undefined): Promise<string[]> {
    const { tenantIds } = this.options;
    const rows = await this.prisma.tenant.findMany({
      where: {
        id: { ...(from && { gte: from }), ...(tenantIds !== undefined && { in: [...tenantIds] }) },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => row.id);
  }

  private async due(now: Date): Promise<boolean> {
    const state = await this.prisma.syncState.findUnique({
      where: { name: this.name },
      select: { lastRunAt: true, lastSuccessAt: true, lastError: true, cursorId: true },
    });
    if (state === null || state.cursorId !== null) return true;
    const failed = state.lastError !== null;
    const last = failed ? state.lastRunAt : state.lastSuccessAt;
    const wait = failed ? CASE_RECONCILE_RETRY_MS : CASE_RECONCILE_EVERY_MS;
    return last === null || now.getTime() - last.getTime() >= wait;
  }

  private async check(tenantId: string, caseId: string, report: CaseReconcileReport): Promise<void> {
    try {
      const counters = await reconcileCase(this.prisma, tenantId, caseId);
      report.checked += 1;
      if (counters.length === 0) return;
      report.drifted += 1;
      this.options.logger?.warn(
        { tenantId, caseId, counters },
        'contagem de caso diferente dos alertas dele',
      );
    } catch (error) {
      report.failed += 1;
      this.options.logger?.error(
        { tenantId, caseId, error: errorKind(error) },
        'conferência de um caso falhou',
      );
    }
  }
}

/** Refaz as contagens de um caso e corrige as que não batem. Devolve os nomes das que estavam erradas. */
export async function reconcileCase(
  prisma: PrismaService,
  tenantId: string,
  caseId: string,
): Promise<string[]> {
  return prisma.$transaction(async (tx) => {
    await setLockTimeout(tx, 5_000);
    const stored = await lockedCounters(tx, tenantId, caseId);
    // O caso saiu na retenção.
    if (stored === null) return [];
    const real = await countedCounters(tx, tenantId, caseId);
    const drifted = [...COUNTERS, 'pending' as const].filter((name) => stored[name] !== real[name]);
    if (drifted.length > 0) {
      await tx.alertCase.updateMany({ where: { id: caseId, tenantId }, data: real });
    }
    return drifted;
  }, TRANSACTION);
}

async function lockedCounters(
  tx: Prisma.TransactionClient,
  tenantId: string,
  caseId: string,
): Promise<Counters | null> {
  const [row] = await tx.$queryRaw<Counters[]>`
    SELECT "total", "pendingCritical", "pendingHigh", "pendingMedium", "pendingLow", "newCount",
      "investigatingCount", "legitimateCount", "resolvedCount", "incidentCount", "pending"
    FROM "AlertCase"
    WHERE "id" = ${caseId}::uuid AND "tenantId" = ${tenantId}::uuid
    FOR UPDATE`;
  return row ?? null;
}

/** A mesma conta dos gatilhos (migration `20261127120000_alert_cases`). */
async function countedCounters(
  tx: Prisma.TransactionClient,
  tenantId: string,
  caseId: string,
): Promise<Counters> {
  const [row] = await tx.$queryRaw<Counters[]>`
    SELECT
      count(*)::integer AS "total",
      (count(*) FILTER (WHERE f.pending AND f."severity" = 'critical'))::integer AS "pendingCritical",
      (count(*) FILTER (WHERE f.pending AND f."severity" = 'high'))::integer AS "pendingHigh",
      (count(*) FILTER (WHERE f.pending AND f."severity" = 'medium'))::integer AS "pendingMedium",
      (count(*) FILTER (WHERE f.pending AND f."severity" = 'low'))::integer AS "pendingLow",
      (count(*) FILTER (WHERE f.loose AND f."status" = 'new'))::integer AS "newCount",
      (count(*) FILTER (WHERE f.loose AND f."status" = 'investigating'))::integer AS "investigatingCount",
      (count(*) FILTER (WHERE f.loose AND f."status" = 'legitimate'))::integer AS "legitimateCount",
      (count(*) FILTER (WHERE f.loose AND f."status" = 'resolved'))::integer AS "resolvedCount",
      (count(*) FILTER (WHERE NOT f.loose))::integer AS "incidentCount",
      COALESCE(bool_or(f.pending), false) AS "pending"
    FROM (
      SELECT "severity", "status", "incidentId" IS NULL AS loose,
        "incidentId" IS NULL AND "status" IN ('new', 'investigating') AS pending
      FROM "Finding"
      WHERE "tenantId" = ${tenantId}::uuid AND "caseId" = ${caseId}::uuid
    ) AS f`;
  if (row === undefined) throw new Error('contagem sem linha');
  return row;
}
