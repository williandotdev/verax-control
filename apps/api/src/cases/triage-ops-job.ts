import { randomUUID } from 'node:crypto';
import type { TriageStop } from '@verax/shared';
import { lockTenantFindings, SyncLease } from '../alerts/finding-store.js';
import { AuditService } from '../common/audit/audit.service.js';
import { errorKind } from '../common/logger/error-kind.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import type { CaseLogger } from './case-assign-job.js';
import { isAlertFault, sqlStateOf } from './case-errors.js';
import { setLockTimeout } from './case-store.js';
import { ACTIVE_STATES, type BatchOutcome, finish, runTriageBatch, TRIAGE_BATCH } from './triage-engine.js';
import { lockOperation, ROW_LOCK_TIMEOUT_MS, setTriageTimeouts } from './triage-store.js';

/** Nome da tarefa no agendador e da linha no `SyncState` (concessão). */
export const TRIAGE_OPS_TASK = 'triage-ops';
export const TRIAGE_OPS_INTERVAL_MS = 5_000;
/** Trabalho máximo de uma passagem: a fila que sobra fica para a seguinte. */
export const TRIAGE_OPS_WORK_MS = 2 * 60_000;
export const TRIAGE_OPS_BUDGET_MS = TRIAGE_OPS_WORK_MS + 60_000;
/** Pausa entre dois lotes: os coletores e a atribuição passam na frente. */
export const TRIAGE_OPS_PAUSE_MS = 100;
/** Validade da concessão: um worker que morre no meio para a triagem por, no máximo, isto. */
export const TRIAGE_OPS_LEASE_MS = 60_000;
/** De quanto em quanto tempo sai o conjunto congelado das operações paradas que ninguém continuou. */
const DROP_EXPIRED_EVERY_MS = 60 * 60_000;
/** Por quanto tempo fica fora da vez a operação que nem encerrar deixa. */
const PARKED_MS = 10 * 60_000;
/** Passagens seguidas em que o lote de uma operação falha por culpa do banco, antes de ela dar lugar às outras. */
export const TRIAGE_MAX_STALLS = 10;
/** Espera máxima pelo lock dos alertas do cliente. */
const TENANT_LOCK_TIMEOUT_MS = 5_000;
const STATEMENT_TIMEOUT_MS = 20_000;
const TRANSACTION = { maxWait: 10_000, timeout: 30_000 } as const;

export interface TriageOpsOptions {
  logger?: CaseLogger;
  audit?: AuditService;
  now?: () => Date;
  /** Milissegundos que só andam para a frente (um falso nos testes). */
  elapsed?: () => number;
  name?: string;
  owner?: string;
  leaseMs?: number;
  batch?: number;
  pauseMs?: number;
  workMs?: number;
  maxStalls?: number;
  rowLockTimeoutMs?: number;
  /** Só os testes, que dividem o banco: restringe a tarefa a estes clientes. */
  tenantIds?: readonly string[];
  /** Cada lote confirmado (a medição de carga e os testes de queda). */
  onBatch?: (batch: { tenantId: string; operationId: string; seen: number; lockMs: number }) => void;
}

/** Contagens de uma passagem (vão para o log do agendador; nenhum dado de cliente). */
export interface TriageOpsReport {
  status: 'done' | 'partial' | 'locked' | 'lease_lost';
  batches: number;
  changed: number;
  finished: number;
  /** Lotes que falharam por culpa do banco: ficam para a próxima passagem. */
  stalled: number;
  /** Alertas isolados, porque a gravação deles falha. */
  isolated: number;
  maxLockMs: number;
}

/**
 * Tarefa `triage-ops` do worker: executa em lotes as operações de triagem em massa que não cabem na requisição.
 *
 * Uma operação por cliente de cada vez, na ordem do pedido. Os clientes se revezam, um lote cada: uma operação grande não
 * segura a de outro cliente. Cada lote é uma transação curta, com a ordem de travas do projeto (`triage-store.ts`), e entre
 * dois lotes há uma pausa.
 *
 * **Nada prende a fila.** O lote que falha por culpa de um alerta (`isAlertFault`) é cortado ao meio até sobrar ele, que é
 * contado como pulado e anotado para o "continuar"; com falhas demais, a operação para. O que falha por culpa do banco
 * (uma trava presa, uma queda) volta na passagem seguinte, e depois de muitas seguidas a operação para como `partial` (ou
 * `failed`), com as contagens, e a seguinte da fila roda.
 *
 * A concessão no `SyncState` deixa um worker por vez; a correção não depende dela (`runTriageBatch`).
 */
export class TriageOpsJob {
  private readonly lease: SyncLease;
  private readonly audit: AuditService;
  private readonly now: () => Date;
  private readonly elapsed: () => number;
  private readonly name: string;
  private readonly batch: number;
  private readonly renewEveryMs: number;
  /** O tamanho do próximo lote de cada operação, quando ele foi cortado por uma falha. */
  private readonly limits = new Map<string, number>();
  /** Falhas do banco seguidas de cada operação. */
  private readonly stalls = new Map<string, number>();
  /** Operações que nem encerrar deixam, e até quando ficam fora da vez. */
  private readonly parked = new Map<string, number>();
  private renewedAt = 0;
  private droppedAt = -Infinity;

  constructor(
    private readonly prisma: PrismaService,
    private readonly options: TriageOpsOptions = {},
  ) {
    const { batch = TRIAGE_BATCH, leaseMs = TRIAGE_OPS_LEASE_MS, name = TRIAGE_OPS_TASK } = options;
    if (!Number.isInteger(batch) || batch < 1)
      throw new Error('o lote da triagem precisa ser um inteiro positivo');
    this.audit = options.audit ?? new AuditService();
    this.now = options.now ?? (() => new Date());
    this.elapsed = options.elapsed ?? (() => performance.now());
    this.name = name;
    this.batch = batch;
    this.renewEveryMs = Math.floor(leaseMs / 3);
    this.lease = new SyncLease(prisma, name, options.owner ?? `worker-${randomUUID()}`, leaseMs);
  }

  async runOnce(signal: AbortSignal = new AbortController().signal): Promise<TriageOpsReport> {
    const report: TriageOpsReport = {
      status: 'done',
      batches: 0,
      changed: 0,
      finished: 0,
      stalled: 0,
      isolated: 0,
      maxLockMs: 0,
    };
    const startedAt = this.now();
    // Sem nada a fazer (quase sempre), nem a concessão é tomada.
    if ((await this.heads()).length === 0 && !this.dropDue()) return report;
    if (!(await this.lease.acquire(new Date()))) return { ...report, status: 'locked' };
    this.renewedAt = this.elapsed();
    const deadline = this.elapsed() + (this.options.workMs ?? TRIAGE_OPS_WORK_MS);
    let failure: string | null = null;
    try {
      // Um cliente com lote falho nesta passagem espera a próxima.
      const waiting = new Set<string>();
      for (;;) {
        signal.throwIfAborted();
        const queue = (await this.heads()).filter(({ tenantId }) => !waiting.has(tenantId));
        if (queue.length === 0) break;
        for (const head of queue) {
          signal.throwIfAborted();
          if (!(await this.step(head, report))) {
            waiting.add(head.tenantId);
            failure = 'batch_failed';
          }
          if (!(await this.keepLease())) return { ...report, status: 'lease_lost' };
        }
        if (this.elapsed() >= deadline) return { ...report, status: 'partial' };
        await pause(this.options.pauseMs ?? TRIAGE_OPS_PAUSE_MS, signal);
      }
      if (this.dropDue()) await this.dropExpired();
      return report;
    } catch (error) {
      failure = errorKind(error);
      throw error;
    } finally {
      await this.prisma.syncState.updateMany({
        where: { name: this.name },
        data: {
          lastRunAt: startedAt,
          lastError: failure,
          ...(failure === null && { lastSuccessAt: this.now() }),
        },
      });
      await this.lease.release();
    }
  }

  /** A operação da vez de cada cliente: a mais antiga na fila ou em curso. Uma ação de outra versão espera por ela. */
  private heads(): Promise<{ tenantId: string; id: string }[]> {
    const tenantIds = this.options.tenantIds === undefined ? null : [...this.options.tenantIds];
    const now = this.elapsed();
    for (const [id, until] of this.parked) if (until <= now) this.parked.delete(id);
    return this.prisma.$queryRaw<{ tenantId: string; id: string }[]>`
      SELECT DISTINCT ON (o."tenantId") o."tenantId"::text AS "tenantId", o."id"::text AS "id"
      FROM "TriageOperation" AS o
      WHERE o."state" IN ('queued', 'running')
        AND o."action" IN ('status', 'promote', 'attach', 'undo')
        AND o."id" <> ALL(${[...this.parked.keys()]}::uuid[])
        AND (${tenantIds}::uuid[] IS NULL OR o."tenantId" = ANY(${tenantIds}::uuid[]))
      ORDER BY o."tenantId", o."createdAt", o."id"`;
  }

  /** Um lote da operação. Falso se o banco falhou, e o cliente espera a próxima passagem. */
  private async step(head: { tenantId: string; id: string }, report: TriageOpsReport): Promise<boolean> {
    const limit = this.limits.get(head.id) ?? this.batch;
    try {
      await this.runBatch(head, limit, false, report);
      this.stalls.delete(head.id);
      // Passou: o próximo lote volta a crescer.
      if (limit >= this.batch) this.limits.delete(head.id);
      else this.limits.set(head.id, Math.min(this.batch, limit * 2));
      return true;
    } catch (error) {
      if (!isAlertFault(error)) return this.stall(head, error, report);
      this.log(head, error, limit, 'um lote da triagem em massa falhou por culpa de um alerta');
      if (limit > 1) {
        this.limits.set(head.id, Math.ceil(limit / 2));
        return true;
      }
    }
    // Sobrou um alerta só, e é ele que falha.
    try {
      await this.runBatch(head, 1, true, report);
      report.isolated += 1;
      this.limits.set(head.id, Math.min(this.batch, 2));
      return true;
    } catch (error) {
      return this.stall(head, error, report);
    }
  }

  /** A falha não é de um alerta: tenta de novo na próxima passagem, até um limite. */
  private async stall(
    head: { tenantId: string; id: string },
    error: unknown,
    report: TriageOpsReport,
  ): Promise<boolean> {
    const stalls = (this.stalls.get(head.id) ?? 0) + 1;
    this.stalls.set(head.id, stalls);
    report.stalled += 1;
    this.log(head, error, stalls, 'um lote da triagem em massa falhou');
    if (stalls < (this.options.maxStalls ?? TRIAGE_MAX_STALLS)) return false;
    try {
      await this.stop(head, 'unavailable');
      this.forget(head.id);
      report.finished += 1;
      return true;
    } catch (cause) {
      this.log(head, cause, stalls, 'a operação de triagem em massa não pôde ser encerrada');
      this.parked.set(head.id, this.elapsed() + PARKED_MS);
      return false;
    }
  }

  private async runBatch(
    head: { tenantId: string; id: string },
    limit: number,
    isolate: boolean,
    report: TriageOpsReport,
  ): Promise<BatchOutcome> {
    const { tenantId, id: operationId } = head;
    let lockedAt = this.elapsed();
    const outcome = await this.prisma.$transaction(async (tx) => {
      await setTriageTimeouts(tx, TENANT_LOCK_TIMEOUT_MS, STATEMENT_TIMEOUT_MS);
      await lockTenantFindings(tx, tenantId);
      lockedAt = this.elapsed();
      // Com o lock do cliente na mão, nenhuma espera é longa: uma triagem presa devolve o lote para a próxima passagem.
      await setLockTimeout(tx, this.options.rowLockTimeoutMs ?? ROW_LOCK_TIMEOUT_MS);
      return runTriageBatch(tx, this.audit, { tenantId, operationId, limit, isolate, now: this.now() });
    }, TRANSACTION);
    const lockMs = this.elapsed() - lockedAt;
    report.maxLockMs = Math.max(report.maxLockMs, Math.round(lockMs));
    if (outcome.gone) {
      this.forget(operationId);
      return outcome;
    }
    report.batches += 1;
    report.changed += outcome.changed;
    if (outcome.finished) {
      report.finished += 1;
      this.forget(operationId);
    }
    this.options.onBatch?.({ tenantId, operationId, seen: outcome.seen, lockMs });
    return outcome;
  }

  private async stop(head: { tenantId: string; id: string }, stop: TriageStop): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await setTriageTimeouts(tx, TENANT_LOCK_TIMEOUT_MS, STATEMENT_TIMEOUT_MS);
      await lockTenantFindings(tx, head.tenantId);
      const operation = await lockOperation(tx, head.tenantId, head.id);
      if (operation === null || !ACTIVE_STATES.includes(operation.state)) return;
      const undone =
        operation.undoOfId === null ? null : await lockOperation(tx, head.tenantId, operation.undoOfId);
      await finish(tx, this.audit, operation, stop, this.now(), undone);
    }, TRANSACTION);
  }

  private dropDue(): boolean {
    return this.elapsed() - this.droppedAt >= DROP_EXPIRED_EVERY_MS;
  }

  /** O conjunto congelado de uma operação parada que ninguém continuou a tempo: não serve a mais ninguém. */
  private async dropExpired(): Promise<void> {
    this.droppedAt = this.elapsed();
    const tenantIds = this.options.tenantIds === undefined ? null : [...this.options.tenantIds];
    await this.prisma.$executeRaw`
      UPDATE "TriageOperation" AS o SET "target" = o."target" - 'ids'
      WHERE o."state" IN ('partial', 'failed') AND o."undoUntil" < ${this.now().toISOString()}::timestamptz
        AND o."target" ? 'ids'
        AND (${tenantIds}::uuid[] IS NULL OR o."tenantId" = ANY(${tenantIds}::uuid[]))`;
  }

  private forget(operationId: string): void {
    this.limits.delete(operationId);
    this.stalls.delete(operationId);
  }

  private async keepLease(): Promise<boolean> {
    if (this.elapsed() - this.renewedAt < this.renewEveryMs) return true;
    this.renewedAt = this.elapsed();
    return this.lease.renew();
  }

  private log(
    { tenantId, id: operationId }: { tenantId: string; id: string },
    error: unknown,
    count: number,
    message: string,
  ): void {
    this.options.logger?.error(
      { tenantId, operationId, count, error: errorKind(error), sqlState: sqlStateOf(error) },
      message,
    );
  }
}

/** Espera; a parada do worker acorda na hora. */
async function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', wake);
      resolve();
    };
    const timer = setTimeout(wake, milliseconds);
    signal.addEventListener('abort', wake, { once: true });
  });
}
