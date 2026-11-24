import { randomUUID } from 'node:crypto';
import { lockTenantFindings, SyncLease } from '../alerts/finding-store.js';
import { errorKind } from '../common/logger/error-kind.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { protectedItemsOf } from '../incidents/incident-summary.js';
import { isAlertFault, sqlStateOf } from './case-errors.js';
import { type CaseFold, type CaseKey, caseKeyOf, foldedCaseKey } from './case-key.js';
import { arrivalOf, sealReasonFor } from './case-lifecycle.js';
import { LIMIT_WINDOW_MS, possibleFolds, RecentOpenings } from './case-limits.js';
import { type BatchPlan, type OpenCase, planBatch, type PlanFinding } from './case-plan.js';
import {
  loadOpenCases,
  loadOpenings,
  loadPreviousCases,
  lockOutboxRows,
  OUTBOX_START,
  type OutboxCursor,
  readOutboxPage,
  setLockTimeout,
  writePlan,
} from './case-store.js';

/** Nome da tarefa no agendador e da linha no `SyncState` (concessão e o começo dos avisos por caso). */
export const CASE_ASSIGN_TASK = 'case-assign';
export const CASE_ASSIGN_INTERVAL_MS = 10_000;
/** Orçamento no agendador: a passagem inteira, por todos os clientes do nó. */
export const CASE_ASSIGN_BUDGET_MS = 5 * 60_000;
/** Alertas por lote (cada lote é uma transação, sob o lock dos alertas do cliente). */
export const CASE_ASSIGN_BATCH = 200;
/** Trabalho máximo por cliente numa passagem: o resto fica para a seguinte, e os coletores não esperam por ele. */
export const CASE_ASSIGN_WORK_MS = 2_000;
/** Validade da concessão: um worker que morre no meio para a atribuição por, no máximo, isto. */
export const CASE_ASSIGN_LEASE_MS = 60_000;
/** Espera máxima pelo lock dos alertas do cliente (um coletor, um incidente ou o expurgo na frente). */
const TENANT_LOCK_TIMEOUT_MS = 5_000;
/** Espera máxima por um caso preso (uma triagem em curso), já com o lock do cliente na mão. */
const CASE_LOCK_TIMEOUT_MS = 1_000;
const TRANSACTION = { maxWait: 10_000, timeout: 30_000 } as const;
/** O alerta cuja gravação falha fica de fora por este tempo, que dobra a cada falha, até o teto. */
const QUARANTINE_MS = 60_000;
const QUARANTINE_MAX_MS = 60 * 60_000;
/** Alertas de um cliente fora da atribuição ao mesmo tempo (a lista vai em cada leitura da fila). */
export const QUARANTINE_LIMIT = 1_000;

/** O que a tarefa usa do logger do worker. Só ids do sistema, contagens e tipos de erro. */
export interface CaseLogger {
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

export interface CaseAssignOptions {
  logger?: CaseLogger;
  /**
   * Os avisos por e-mail já são por caso. Nenhum modo o liga ainda (o `FindingStore` avisa alerta por alerta): é a parte
   * dos avisos que vai ligar. Ver `noticedBefore`.
   */
  caseNotices?: boolean;
  /** O relógio do servidor (um falso nos testes). */
  now?: () => Date;
  /** Milissegundos que só andam para a frente: o tempo de trabalho (um falso nos testes). */
  elapsed?: () => number;
  name?: string;
  owner?: string;
  leaseMs?: number;
  batch?: number;
  workMs?: number;
  quarantineLimit?: number;
  caseLockTimeoutMs?: number;
  /** Só os testes, que dividem o banco: restringe a tarefa a estes clientes. */
  tenantIds?: readonly string[];
  /** Cada lote gravado: as linhas, o tempo total e o tempo com o lock do cliente na mão (a medição de carga). */
  onBatch?: (batch: { tenantId: string; rows: number; totalMs: number; lockMs: number }) => void;
}

/** Contagens de uma passagem (vão para o log do agendador; nenhum dado de cliente). */
export interface CaseAssignReport {
  status: 'done' | 'locked' | 'lease_lost';
  tenants: number;
  /** Clientes com erro nesta passagem (os outros seguem) e os que ficaram com alertas para a próxima. */
  failedTenants: number;
  unfinishedTenants: number;
  batches: number;
  assigned: number;
  opened: number;
  sealed: number;
  folded: Record<CaseFold, number>;
  /** Alertas isolados nesta passagem, porque a gravação deles falha. */
  quarantined: number;
  /** O maior tempo com o lock dos alertas de um cliente, em milissegundos: é o que um coletor pode ter esperado. */
  maxLockMs: number;
}

interface Quarantined {
  tenantId: string;
  failures: number;
  until: number;
}

/**
 * Tarefa `case-assign` do worker: dá um caso a cada alerta pendente que ainda não tem, em lotes pequenos.
 *
 * **A fila é o próprio predicado** (`caseId` vazio, fora de incidente, novo ou em análise), com índice parcial: não há
 * caixa de saída para perder linha. O alerta novo, o histórico e o que chegou com a versão anterior do nó passam por
 * aqui do mesmo jeito. O alerta esperado por exceção nasce legítimo e não entra na fila.
 *
 * **Um lote é uma transação**, sempre nesta ordem de travas (a de todo o projeto): o lock do cliente, as linhas dos
 * alertas (`FOR UPDATE`, todas as do lote de uma vez) e só então os casos. Os casos novos nascem antes (a chave
 * estrangeira exige), mas ninguém mais os vê; selar e abrir no lugar vêm depois do UPDATE dos alertas. A linha travada
 * por uma triagem em curso é pulada (`SKIP LOCKED`): o lote nunca espera por um alerta com o lock do cliente na mão, e o
 * alerta volta na passagem seguinte. As contagens são dos gatilhos, e o `updatedAt` do alerta não muda (a retenção o lê).
 *
 * **Uma falha não espalha.** O erro de um cliente não para os outros, e nada aqui roda dentro da gravação dos coletores.
 * Se um lote falha por causa de um alerta (`isAlertFault`), ele é partido ao meio até achar qual: os outros são gravados,
 * e o alerta fica de fora por um tempo, que dobra a cada falha (no máximo uma hora). Uma falha do banco ou uma espera
 * longa demais só adia o cliente para a passagem seguinte, que continua depois do trecho que falhou e volta ao começo:
 * nada prende a fila inteira.
 *
 * A concessão no `SyncState` deixa um worker por vez; a correção não depende dela (o lock do cliente já serializa, e a
 * linha travada é conferida de novo no lote).
 */
export class CaseAssignJob {
  private readonly lease: SyncLease;
  private readonly now: () => Date;
  private readonly elapsed: () => number;
  private readonly name: string;
  private readonly batch: number;
  private readonly workMs: number;
  private readonly renewEveryMs: number;
  private readonly quarantineLimit: number;
  private readonly logger: CaseLogger | undefined;
  private readonly quarantine = new Map<string, Quarantined>();
  /** De onde a próxima passagem continua a fila de cada cliente, quando a anterior não chegou ao fim. */
  private readonly resume = new Map<string, OutboxCursor>();
  /** O último cliente atendido: a passagem seguinte começa depois dele, e uma fila longa não deixa ninguém para trás. */
  private lastTenantId: string | null = null;
  private renewedAt = 0;
  private held = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly options: CaseAssignOptions = {},
  ) {
    const { batch = CASE_ASSIGN_BATCH, leaseMs = CASE_ASSIGN_LEASE_MS, name = CASE_ASSIGN_TASK } = options;
    if (!Number.isInteger(batch) || batch < 1)
      throw new Error('o lote dos casos precisa ser um inteiro positivo');
    this.now = options.now ?? (() => new Date());
    this.elapsed = options.elapsed ?? (() => performance.now());
    this.name = name;
    this.batch = batch;
    this.workMs = options.workMs ?? CASE_ASSIGN_WORK_MS;
    this.quarantineLimit = options.quarantineLimit ?? QUARANTINE_LIMIT;
    this.logger = options.logger;
    this.renewEveryMs = Math.floor(leaseMs / 3);
    this.lease = new SyncLease(prisma, name, options.owner ?? `worker-${randomUUID()}`, leaseMs);
  }

  async runOnce(signal: AbortSignal = new AbortController().signal): Promise<CaseAssignReport> {
    const report: CaseAssignReport = {
      status: 'done',
      tenants: 0,
      failedTenants: 0,
      unfinishedTenants: 0,
      batches: 0,
      assigned: 0,
      opened: 0,
      sealed: 0,
      folded: { distributed: 0, overflow: 0, rollup: 0 },
      quarantined: 0,
      maxLockMs: 0,
    };
    const startedAt = this.now();
    // A concessão é do relógio de verdade: ela é dividida com as outras réplicas.
    if (!(await this.lease.acquire(new Date()))) return { ...report, status: 'locked' };
    this.held = true;
    this.renewedAt = this.elapsed();
    this.forgetOldQuarantine();
    let firstError: string | null = null;
    try {
      const noticedBefore = await this.noticedBefore(startedAt);
      const tenants = await this.tenants();
      report.tenants = tenants.length;
      for (const tenantId of tenants) {
        signal.throwIfAborted();
        try {
          await this.assignTenant(tenantId, noticedBefore, report, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          report.failedTenants += 1;
          firstError ??= errorKind(error);
          this.logger?.error(
            { tenantId, error: errorKind(error), sqlState: sqlStateOf(error) },
            'atribuição de casos falhou para um cliente',
          );
        }
        this.lastTenantId = tenantId;
        if (!(await this.keepLease())) return { ...report, status: 'lease_lost' };
      }
      await this.prisma.syncState.update({
        where: { name: this.name },
        data: {
          lastRunAt: startedAt,
          ...(firstError === null && { lastSuccessAt: this.now() }),
          lastError: firstError,
        },
      });
      return report;
    } catch (error) {
      await this.prisma.syncState.update({
        where: { name: this.name },
        data: { lastRunAt: startedAt, lastError: errorKind(error) },
      });
      throw error;
    } finally {
      await this.lease.release();
    }
  }

  /**
   * Até quando o aviso por e-mail é alerta por alerta, o que faz de um alerta o **passado** para os avisos por caso: o
   * caso nascido dele já nasce com a severidade avisada.
   *
   * Enquanto os avisos não são por caso (`caseNotices`), sempre (null): o `FindingStore` avisa de cada alerta alto ou
   * crítico. Com eles, até a primeira passagem da tarefa assim, guardada uma vez só em `SyncState.cursorTimestamp` desta
   * tarefa (que não usa cursor de leitura, então não falta coluna). Vale a chegada do alerta, e não a hora em que ele foi
   * atribuído: no histórico e na volta de versão, o que chegou antes do marco já foi avisado, e o que chegou depois,
   * não. Na dúvida (a tarefa parada depois do marco), fica sem marca: um aviso repetido é melhor que nenhum.
   */
  private async noticedBefore(now: Date): Promise<Date | null> {
    if (this.options.caseNotices !== true) return null;
    await this.prisma.syncState.updateMany({
      where: { name: this.name, cursorTimestamp: null },
      data: { cursorTimestamp: now },
    });
    const state = await this.prisma.syncState.findUniqueOrThrow({
      where: { name: this.name },
      select: { cursorTimestamp: true },
    });
    return state.cursorTimestamp;
  }

  private async tenants(): Promise<string[]> {
    const rows = await this.prisma.tenant.findMany({
      where: this.options.tenantIds === undefined ? {} : { id: { in: [...this.options.tenantIds] } },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const ids = rows.map((row) => row.id);
    const last = this.lastTenantId;
    const next = last === null ? 0 : ids.findIndex((id) => id > last);
    return next <= 0 ? ids : [...ids.slice(next), ...ids.slice(0, next)];
  }

  /** Renova a concessão de tempos em tempos. Perdida, a passagem acaba: a fila que falta é da outra réplica. */
  private async keepLease(): Promise<boolean> {
    if (this.held && this.elapsed() - this.renewedAt >= this.renewEveryMs) {
      this.renewedAt = this.elapsed();
      this.held = await this.lease.renew();
    }
    return this.held;
  }

  private async assignTenant(
    tenantId: string,
    noticedBefore: Date | null,
    report: CaseAssignReport,
    signal: AbortSignal,
  ): Promise<void> {
    const deadline = this.elapsed() + this.workMs;
    let cursor = this.resume.get(tenantId) ?? OUTBOX_START;
    let fromStart = cursor === OUTBOX_START;
    for (;;) {
      signal.throwIfAborted();
      const page = await this.page(tenantId, cursor);
      const last = page.at(-1);
      if (last !== undefined) {
        cursor = { at: last.createdAt.toISOString(), id: last.id };
        // A fila é lida em roda: o trecho que falha não prende os que vêm depois dele, e volta a ser tentado na volta.
        this.resume.set(tenantId, cursor);
        const ids = page.map((row) => row.id);
        await this.assignPage(tenantId, ids, noticedBefore, report, deadline, signal);
      }
      if (page.length < this.batch) {
        this.resume.delete(tenantId);
        if (fromStart) return;
        fromStart = true;
        cursor = OUTBOX_START;
      }
      if (this.elapsed() >= deadline || !(await this.keepLease())) {
        report.unfinishedTenants += 1;
        return;
      }
    }
  }

  /** Um trecho da fila, na ordem de chegada, sem travar nada. */
  private page(tenantId: string, after: OutboxCursor): Promise<{ id: string; createdAt: Date }[]> {
    return readOutboxPage(this.prisma, tenantId, after, this.quarantinedOf(tenantId), this.batch);
  }

  /** Atribui um trecho da fila; se a culpa da falha é de um alerta, parte ao meio até isolar qual. */
  private async assignPage(
    tenantId: string,
    ids: readonly string[],
    noticedBefore: Date | null,
    report: CaseAssignReport,
    deadline: number,
    signal: AbortSignal,
  ): Promise<void> {
    const parts: (readonly string[])[] = [ids];
    for (let part = parts.pop(); part !== undefined; part = parts.pop()) {
      signal.throwIfAborted();
      try {
        await this.assignBatch(tenantId, part, noticedBefore, report);
        for (const id of part) this.quarantine.delete(id);
      } catch (error) {
        if (!isAlertFault(error)) throw error;
        const [only] = part;
        if (part.length === 1 && only !== undefined) this.isolate(tenantId, only, error, report);
        else {
          const half = Math.ceil(part.length / 2);
          parts.push(part.slice(half), part.slice(0, half));
        }
      }
      // O resto do trecho fica para a passagem seguinte; o que já foi isolado não volta agora.
      if (parts.length > 0 && this.elapsed() >= deadline) return;
    }
  }

  private isolate(tenantId: string, findingId: string, error: unknown, report: CaseAssignReport): void {
    report.quarantined += 1;
    const failures = (this.quarantine.get(findingId)?.failures ?? 0) + 1;
    // Cheio: fica sem guardar, e é tentado de novo na próxima volta da fila.
    if (failures === 1 && this.quarantinedOf(tenantId).length >= this.quarantineLimit) return;
    const wait = Math.min(QUARANTINE_MS * 2 ** (failures - 1), QUARANTINE_MAX_MS);
    this.quarantine.set(findingId, { tenantId, failures, until: this.now().getTime() + wait });
    this.logger?.error(
      { tenantId, findingId, failures, error: errorKind(error), sqlState: sqlStateOf(error) },
      'alerta fora da atribuição de casos: a gravação dele falha',
    );
  }

  /** O isolado que não voltou a falhar (alguém o triou, ou ele saiu na retenção) não fica na memória. */
  private forgetOldQuarantine(): void {
    const stale = this.now().getTime() - QUARANTINE_MAX_MS;
    for (const [id, entry] of this.quarantine) {
      if (entry.until < stale) this.quarantine.delete(id);
    }
  }

  private quarantinedOf(tenantId: string): string[] {
    const now = this.now().getTime();
    const ids: string[] = [];
    for (const [id, entry] of this.quarantine) {
      if (entry.tenantId === tenantId && entry.until > now) ids.push(id);
    }
    return ids;
  }

  private async assignBatch(
    tenantId: string,
    ids: readonly string[],
    noticedBefore: Date | null,
    report: CaseAssignReport,
  ): Promise<void> {
    const startedAt = this.elapsed();
    let lockedAt = startedAt;
    const plan = await this.prisma.$transaction(async (tx) => {
      await setLockTimeout(tx, TENANT_LOCK_TIMEOUT_MS);
      await lockTenantFindings(tx, tenantId);
      lockedAt = this.elapsed();
      // Com o lock do cliente na mão, nenhuma espera é longa: uma triagem presa devolve o lote para a próxima passagem.
      await setLockTimeout(tx, this.options.caseLockTimeoutMs ?? CASE_LOCK_TIMEOUT_MS);
      const findings = await lockOutboxRows(tx, tenantId, ids);
      if (findings.length === 0) return null;
      const now = this.now();
      const planned = await this.plan(tx, tenantId, findings, now, noticedBefore);
      await writePlan(tx, tenantId, planned, now);
      return planned;
    }, TRANSACTION);
    const endedAt = this.elapsed();
    if (plan === null) return;
    const lockMs = endedAt - lockedAt;
    report.batches += 1;
    report.assigned += plan.assignments.length;
    report.opened += plan.created.length;
    report.sealed += plan.sealed.length + plan.created.filter(({ state }) => state.kind === 'sealed').length;
    for (const fold of ['distributed', 'overflow', 'rollup'] as const)
      report.folded[fold] += plan.folded[fold];
    report.maxLockMs = Math.max(report.maxLockMs, Math.round(lockMs));
    this.options.onBatch?.({ tenantId, rows: plan.assignments.length, totalMs: endedAt - startedAt, lockMs });
  }

  /** Lê o que o plano do lote precisa (pouco, no caminho comum: só os casos abertos das chaves) e o faz. */
  private async plan(
    tx: Prisma.TransactionClient,
    tenantId: string,
    findings: readonly PlanFinding[],
    now: Date,
    noticedBefore: Date | null,
  ): Promise<BatchPlan> {
    const open = new Map<string, OpenCase>();
    const keyed = findings.map((finding) => ({ finding, key: caseKeyOf(finding) }));
    await loadOpenCases(tx, tenantId, unique(keyed.map(({ key }) => key.groupKey)), open);
    // As chaves que podem abrir um caso: sem caso aberto, ou com um que já não recebe algum dos alertas do lote.
    const opening = keyed.filter(({ finding, key }) => {
      const current = open.get(key.groupKey);
      return current === undefined || sealReasonFor(current, arrivalOf(finding.createdAt, now)) !== null;
    });
    if (opening.length === 0) {
      return planBatch({
        findings,
        now,
        noticedBefore,
        open,
        previous: new Map(),
        openings: new RecentOpenings(),
        protectedItems: new Set(),
      });
    }
    const foldKeys = unique(opening.flatMap(foldKeysOf));
    await loadOpenCases(tx, tenantId, foldKeys, open);
    const previous = await loadPreviousCases(
      tx,
      tenantId,
      unique([...opening.map(({ key }) => key.groupKey), ...foldKeys]),
    );
    const limited = foldKeys.length > 0;
    const arrivals = opening.map(({ finding }) => arrivalOf(finding.createdAt, now).getTime());
    return planBatch({
      findings,
      now,
      noticedBefore,
      open,
      previous,
      openings: limited
        ? await loadOpenings(tx, tenantId, {
            after: new Date(Math.min(...arrivals) - LIMIT_WINDOW_MS),
            until: new Date(Math.max(...arrivals)),
          })
        : new RecentOpenings(),
      protectedItems: limited
        ? protectedItemsOf(
            await tx.protectedResource.findMany({
              where: { tenantId },
              select: { type: true, identifier: true },
            }),
          )
        : new Set(),
    });
  }
}

const unique = (values: readonly string[]): string[] => [...new Set(values)];

function foldKeysOf({ finding, key }: { finding: PlanFinding; key: CaseKey }): string[] {
  return possibleFolds(key, finding.accountId).map((fold) => foldedCaseKey(finding, fold).groupKey);
}
