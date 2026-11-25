import { errorKind } from '../common/logger/error-kind.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import { scopeToTenant } from '../common/prisma/tenant-scope.js';
import type { CaseQueue, FindingSeverity, Prisma } from '../generated/prisma/client.js';
import { alertNotices, enqueueNotices, type NoticeSeverity } from '../notifications/finding-notices.js';
import type { CaseLogger } from './case-assign-job.js';
import { CaseBatchError, isAlertFault, sqlStateOf } from './case-errors.js';
import {
  CASE_CRITICAL_INTERVAL_MS,
  CASE_CRITICAL_PAGE,
  CASE_LAG_NOTICE_MS,
  CASE_NOTICE_BATCH,
  CASE_NOTICE_MAX_BATCHES,
  CASE_NOTICE_PAGE,
  CASE_NOTICE_WORK_MS,
  CASE_SKIP,
  CASE_SUPERSEDE_BATCH,
  caseGrowthKey,
  caseNoticeKey,
  caseWaveKey,
  criticalCasesKey,
  dailyCasesKey,
  dailyDayOf,
  dailyMoment,
  detectionDecision,
  dueDaily,
  growthDue,
  noticeKindOf,
  recentCriticalCasesKeys,
  rememberedDailyDays,
} from './case-notice-policy.js';
import {
  CASE_NOTICES_STATE,
  type CaseNoticeEpoch,
  type CaseNoticeRegime,
  finishHandBack,
  pendingHandBack,
} from './case-notice-regime.js';
import {
  type CriticalCase,
  criticalCases,
  dailyContent,
  detectionFacts,
  detectionPage,
  type DetectionRow,
  growthFacts,
  type NoticeContext,
  skipWaiting,
  stillWaiting,
  unannouncedCriticals,
  unassignedUnnoticed,
  waitingCases,
} from './case-notice-store.js';
import { lockFindingsBriefly, setTriageTimeouts } from './triage-store.js';

/** Espera máxima pelo lock dos alertas do cliente (com ele na mão, a espera por uma linha é de 1 s). */
const LOCK_TIMEOUT_MS = 5_000;
/** Prazo de um comando: o lote que não cabe nele é partido. */
const STATEMENT_TIMEOUT_MS = 10_000;
const TRANSACTION = { maxWait: 10_000, timeout: 30_000 } as const;
/** Casos com aviso de alerta na fila que se leem de uma vez (a virada): o resto fica para a execução seguinte. */
const WAITING_LIMIT = 2_000;
/** Por quantas horas um aviso imediato ainda cobre os avisos de alerta que estavam na fila (a virada). */
const CRITICAL_COVER_HOURS = 24;
/** Sem o que dizer no resumo diário, o cliente só é conferido de novo depois disto. */
const DAILY_RECHECK_MS = 15 * 60_000;
/** O comando passou do prazo. */
const QUERY_CANCELED = '57014';

export interface CaseNoticesOptions {
  /** A virada deste processo. Só com `CASES_MODE=on`: sem ela, só a devolução (`handBack`). */
  regime?: CaseNoticeRegime;
  logger?: CaseLogger;
  now?: () => Date;
  /** Milissegundos que só andam para a frente: o tempo de trabalho (um falso nos testes). */
  elapsed?: () => number;
  workMs?: number;
  page?: number;
  batch?: number;
  supersedeBatch?: number;
  statementTimeoutMs?: number;
  /** A linha no `SyncState` (outra por teste). */
  name?: string;
  /** Só os testes, que dividem o banco: restringe a estes clientes. */
  tenantIds?: readonly string[];
}

/** Contagens de uma execução (vão para o log do agendador; nenhum dado de cliente). */
export interface CaseNoticesReport {
  tenants: number;
  /** Clientes com erro nesta execução (os outros seguem) e os que não couberam nela. */
  failedTenants: number;
  unfinishedTenants: number;
  /** Avisos de caso de detecção que entraram na fila, e os de crescimento. */
  opened: number;
  growth: number;
  /** Avisos imediatos de vulnerabilidade e postura, e resumos diários. */
  critical: number;
  daily: number;
  /** Casos marcados como avisados sem e-mail: tudo neles já tinha sido avisado alerta por alerta. */
  marked: number;
  /** Avisos de alerta tirados da fila, porque o caso avisa (a virada). */
  superseded: number;
  /** Avisos alerta por alerta: sem caso há tempo demais (a atribuição atrasada), ou um caso que não deixa decidir. */
  lagging: number;
  isolated: number;
}

/** Contagens da devolução ao aviso por alerta. */
export interface CaseHandBackReport {
  handedBack: { alerts: number; cases: number };
  failedTenants: number;
  unfinishedTenants: number;
}

const emptyReport = (): CaseNoticesReport => ({
  tenants: 0,
  failedTenants: 0,
  unfinishedTenants: 0,
  opened: 0,
  growth: 0,
  critical: 0,
  daily: 0,
  marked: 0,
  superseded: 0,
  lagging: 0,
  isolated: 0,
});

/** O trabalho de uma execução: o relatório, o prazo e o sinal de parada. */
interface Run {
  report: CaseNoticesReport;
  /** Os casos isolados nesta execução: não voltam nela. */
  isolated: Set<string>;
  startedAt: Date;
  deadline: number;
  signal: AbortSignal | undefined;
}

interface Decision {
  row: DetectionRow;
  what: 'notice' | 'mark';
}

/**
 * Os avisos por e-mail **por caso** (`CASES_MODE=on`), calculados no começo de cada execução da tarefa `notifications`, antes
 * da entrega, a partir do que está no banco: nenhum evento precisa chegar até aqui, e o que uma execução não viu a seguinte
 * vê. Roda noutra tarefa que não a `case-assign`, para avisar mesmo com ela parada.
 *
 * - **Detecção:** um aviso por caso e severidade, quando a pior severidade pendente passa da já avisada (`noticedSeverity`);
 *   outro, se tudo o que foi avisado já foi tratado e chegou mais (`detectionDecision`). E no máximo um por dia, se o caso
 *   já avisado cresceu (`growthDue`).
 * - **Vulnerabilidade e postura:** no máximo um aviso imediato por hora e cliente, com todos os casos críticos novos, e um
 *   resumo por dia, às 09:00 de Brasília.
 * - **Nunca calado:** o alerta alto ou crítico sem caso há mais de 10 min avisa sozinho, alerta por alerta (`finding:<id>`).
 * - **A virada:** o que já foi avisado alerta por alerta marca o caso sem e-mail, e o aviso de alerta que ainda está na fila
 *   só sai dela depois que o aviso do caso dele existe.
 *
 * Cada lote é uma transação sob o lock dos alertas do cliente, que decide de novo com ele na mão: o aviso e a severidade
 * avisada são gravados juntos, e duas réplicas nunca avisam a mesma coisa duas vezes, com ou sem a concessão. A ordem das
 * travas é a de sempre: o lock, os alertas (a chave estrangeira do aviso) e os casos.
 *
 * O erro de um cliente não para os outros nem a entrega; o caso que não deixa decidir é isolado, e o alerta mais novo dele
 * avisa sozinho.
 */
export class CaseNotices {
  private readonly now: () => Date;
  private readonly elapsed: () => number;
  private readonly page: number;
  private readonly batch: number;
  private readonly supersedeBatch: number;
  private readonly name: string;
  /** O último cliente atendido: a execução seguinte começa depois dele. */
  private lastTenantId: string | null = null;
  /** De onde a volta dos casos de detecção de um cliente continua, quando a anterior não chegou ao fim. */
  private readonly resume = new Map<string, string>();
  /** Os clientes sem o que dizer no resumo de hoje, e quando se conferiu. */
  private readonly dailyChecked = new Map<string, { day: string; at: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly options: CaseNoticesOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.elapsed = options.elapsed ?? (() => performance.now());
    this.page = options.page ?? CASE_NOTICE_PAGE;
    this.batch = options.batch ?? CASE_NOTICE_BATCH;
    this.supersedeBatch = options.supersedeBatch ?? CASE_SUPERSEDE_BATCH;
    this.name = options.name ?? CASE_NOTICES_STATE;
  }

  /** Os avisos por caso de todos os clientes. */
  async check(startedAt: Date, signal?: AbortSignal): Promise<CaseNoticesReport> {
    const { regime } = this.options;
    if (regime === undefined) throw new Error('os avisos por caso só rodam com a virada');
    const epoch = await regime.activate(startedAt);
    const run = this.run(startedAt, signal);
    await this.eachTenant(run, (tenantId) => this.noticesOf(tenantId, epoch, run));
    return run.report;
  }

  /**
   * A volta ao aviso por alerta (`CASES_MODE` em `off` ou `shadow` depois de `on`): o que chegou com os avisos por caso e
   * ainda não tinha sido avisado entra na fila, uma vez só. O alerta sem caso avisa alerta por alerta; o caso ainda não
   * avisado, com um aviso só. No nó que nunca os ligou, não faz nada (uma leitura pela chave).
   */
  async handBack(startedAt: Date, signal?: AbortSignal): Promise<CaseHandBackReport | null> {
    const epoch = await pendingHandBack(this.prisma, this.name);
    if (epoch === null) return null;
    const run = this.run(startedAt, signal);
    await this.eachTenant(run, (tenantId) => this.handBackTenant(tenantId, epoch, run));
    const { report } = run;
    if (report.failedTenants === 0 && report.unfinishedTenants === 0)
      await finishHandBack(this.prisma, this.name);
    return {
      handedBack: { alerts: report.lagging, cases: report.opened },
      failedTenants: report.failedTenants,
      unfinishedTenants: report.unfinishedTenants,
    };
  }

  private run(startedAt: Date, signal: AbortSignal | undefined): Run {
    const deadline = this.elapsed() + (this.options.workMs ?? CASE_NOTICE_WORK_MS);
    return { report: emptyReport(), isolated: new Set(), startedAt, deadline, signal };
  }

  private async eachTenant(run: Run, work: (tenantId: string) => Promise<boolean>): Promise<void> {
    const tenants = await this.tenants();
    run.report.tenants = tenants.length;
    for (const tenantId of tenants) {
      run.signal?.throwIfAborted();
      if (this.elapsed() >= run.deadline) {
        run.report.unfinishedTenants += 1;
        continue;
      }
      try {
        if (!(await work(tenantId))) run.report.unfinishedTenants += 1;
      } catch (error) {
        if (run.signal?.aborted) throw error;
        run.report.failedTenants += 1;
        this.options.logger?.error(
          { tenantId, error: errorKind(error), sqlState: sqlStateOf(error) },
          'os avisos por caso falharam para um cliente',
        );
      }
      this.lastTenantId = tenantId;
    }
  }

  private async tenants(): Promise<string[]> {
    const { tenantIds } = this.options;
    const rows = await this.prisma.tenant.findMany({
      where: tenantIds === undefined ? {} : { id: { in: [...tenantIds] } },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const ids = rows.map((row) => row.id);
    const last = this.lastTenantId;
    const next = last === null ? 0 : ids.findIndex((id) => id > last);
    return next <= 0 ? ids : [...ids.slice(next), ...ids.slice(0, next)];
  }

  /**
   * Os avisos de um cliente, um passo de cada vez. A falha de um passo não segura os outros (o resumo diário não espera um
   * lote preso), e o erro sobe no fim. Falso se sobrou trabalho para a execução seguinte.
   */
  private async noticesOf(tenantId: string, epoch: CaseNoticeEpoch, run: Run): Promise<boolean> {
    const context = (): NoticeContext => ({ tenantId, epoch, now: this.now(), pendingCounts: false });
    let criticalAt: Date | null = null;
    let waiting: { id: string; queue: CaseQueue }[] = [];
    return this.steps(run, [
      () => this.lagging(tenantId, epoch, run),
      async () => {
        criticalAt = await this.lastCriticalAt(tenantId);
        return true;
      },
      async () => {
        waiting = await this.read((tx) => waitingCases(tx, context(), criticalAt, WAITING_LIMIT));
        return true;
      },
      () => this.detection(context, idsOf(waiting, true), run),
      async () => {
        // De novo: se a leitura de antes falhou, o intervalo entre dois avisos não é esquecido.
        const last = await this.lastCriticalAt(tenantId);
        const critical = await this.critical(context, idsOf(waiting, false), last, run);
        criticalAt = critical.noticedAt ?? last;
        return critical.finished;
      },
      () => this.supersede(context, criticalAt, run),
      async () => {
        await this.daily(tenantId, epoch, run);
        return true;
      },
    ]);
  }

  private async handBackTenant(tenantId: string, epoch: CaseNoticeEpoch, run: Run): Promise<boolean> {
    const context = (): NoticeContext => ({ tenantId, epoch, now: this.now(), pendingCounts: true });
    // Todos, mesmo o do relógio que voltou.
    const all = new Date(this.now().getTime() + 24 * 60 * 60_000);
    return this.steps(run, [
      () =>
        this.alertByAlert(tenantId, run, () =>
          this.read((tx) =>
            unassignedUnnoticed(tx, { tenantId, epoch }, all, { quiet: true, limit: this.batch }),
          ),
        ),
      () => this.detection(context, [], run),
      () =>
        this.alertByAlert(tenantId, run, () =>
          this.read((tx) => unannouncedCriticals(tx, context(), this.batch)),
        ),
    ]);
  }

  private async steps(run: Run, steps: readonly (() => Promise<boolean>)[]): Promise<boolean> {
    let finished = true;
    let failure: { error: unknown } | null = null;
    for (const step of steps) {
      run.signal?.throwIfAborted();
      try {
        finished = (await step()) && finished;
      } catch (error) {
        if (run.signal?.aborted) throw error;
        failure ??= { error };
      }
    }
    if (failure !== null) throw failure.error;
    return finished;
  }

  /** O alerta alto ou crítico sem caso há tempo demais avisa sozinho. */
  private async lagging(tenantId: string, epoch: CaseNoticeEpoch, run: Run): Promise<boolean> {
    const until = new Date(this.now().getTime() - CASE_LAG_NOTICE_MS);
    const before = run.report.lagging;
    const finished = await this.alertByAlert(tenantId, run, () =>
      this.read((tx) =>
        unassignedUnnoticed(tx, { tenantId, epoch }, until, { quiet: false, limit: this.batch }),
      ),
    );
    const alerts = run.report.lagging - before;
    if (alerts > 0) {
      this.options.logger?.warn(
        { tenantId, alerts },
        'alertas sem caso há mais de 10 min avisados um a um: a atribuição está atrasada',
      );
    }
    return finished;
  }

  // -------------------------------------------------------------------------------------------------
  // Alerta por alerta
  // -------------------------------------------------------------------------------------------------

  /** Avisa alerta por alerta o que `next` acha, em lotes, até não achar mais. */
  private async alertByAlert(
    tenantId: string,
    run: Run,
    next: () => Promise<{ id: string; severity: FindingSeverity }[]>,
  ): Promise<boolean> {
    for (let batches = 0; batches < CASE_NOTICE_MAX_BATCHES; batches += 1) {
      run.signal?.throwIfAborted();
      const found = await next();
      if (found.length > 0) {
        const rows = found.flatMap(({ id, severity }) => alertNotices({ tenantId, id, severity }));
        run.report.lagging += await enqueueNotices(
          this.prisma.forTenant(tenantId),
          rows.map((row) => ({ ...row, nextAttemptAt: run.startedAt })),
        );
      }
      if (found.length < this.batch) return true;
      if (this.elapsed() >= run.deadline) return false;
    }
    return false;
  }

  // -------------------------------------------------------------------------------------------------
  // Detecção
  // -------------------------------------------------------------------------------------------------

  private async detection(
    context: () => NoticeContext,
    waiting: readonly string[],
    run: Run,
  ): Promise<boolean> {
    let failure: { error: unknown } | null = null;
    // O trecho que falha (uma espera longa) não segura os seguintes: o erro sobe no fim, e ele volta na próxima volta.
    const batch = async (ids: readonly string[], fromWaiting: boolean): Promise<void> => {
      run.signal?.throwIfAborted();
      try {
        await this.detectionBatch(context, ids, fromWaiting, run);
      } catch (error) {
        if (run.signal?.aborted) throw error;
        failure ??= { error };
      }
    };
    const settle = (finished: boolean): boolean => {
      if (failure !== null) throw failure.error;
      return finished;
    };
    for (let start = 0; start < waiting.length; start += this.page) {
      await batch(waiting.slice(start, start + this.page), true);
      if (this.elapsed() >= run.deadline) return settle(false);
    }
    // A volta que não coube na execução anterior continua de onde parou: uma fila longa não deixa os últimos casos para trás.
    const { tenantId } = context();
    const started = this.resume.get(tenantId) ?? null;
    let after = started;
    for (;;) {
      const cursor: string | null = after;
      const ids: string[] = await this.read((tx) => detectionPage(tx, context(), cursor, this.page));
      await batch(ids, false);
      if (ids.length < this.page) {
        this.resume.delete(tenantId);
        return settle(started === null);
      }
      after = ids.at(-1) ?? null;
      if (after !== null) this.resume.set(tenantId, after);
      if (this.elapsed() >= run.deadline) return settle(false);
    }
  }

  /** Um trecho de casos. O que falha por causa de um caso é partido ao meio até sobrar ele, que avisa alerta por alerta. */
  private async detectionBatch(
    context: () => NoticeContext,
    ids: readonly string[],
    waiting: boolean,
    run: Run,
  ): Promise<void> {
    const some = ids.filter((id) => !run.isolated.has(id));
    const parts: (readonly string[])[] = some.length === 0 ? [] : [some];
    for (let part = parts.pop(); part !== undefined; part = parts.pop()) {
      run.signal?.throwIfAborted();
      try {
        await this.decide(context, part, waiting, run);
      } catch (error) {
        if (!isAlertFault(error) && sqlStateOf(error) !== QUERY_CANCELED) throw error;
        const [only] = part;
        if (part.length === 1 && only !== undefined) await this.isolate(context(), only, error, run);
        else {
          const half = Math.ceil(part.length / 2);
          parts.push(part.slice(half), part.slice(0, half));
        }
      }
    }
  }

  private async decide(
    context: () => NoticeContext,
    ids: readonly string[],
    waiting: boolean,
    run: Run,
  ): Promise<void> {
    const rows = await this.read((tx) => detectionFacts(tx, context(), ids, { withFinding: false }));
    // Com `waiting`, todos os do trecho têm aviso de alerta na fila; quem confirma é a decisão com o lock.
    const due = rows.filter((row) => detectionDecision({ ...row, waiting }) !== 'none').map((row) => row.id);
    if (due.length > 0) await this.apply(context, due, waiting, run);
    if (context().pendingCounts) return;
    const settled = new Set(due);
    const grown = await this.read((tx) =>
      growthFacts(
        tx,
        context(),
        rows.map((row) => row.id).filter((id) => !settled.has(id)),
      ),
    );
    const growing = grown.filter((row) => growthDue(row, this.now())).map((row) => row.id);
    if (growing.length > 0) await this.applyGrowth(context, growing, run);
  }

  /** Grava os avisos e as severidades avisadas, decididos de novo com o lock do cliente na mão. */
  private async apply(
    context: () => NoticeContext,
    ids: readonly string[],
    waiting: boolean,
    run: Run,
  ): Promise<void> {
    const { opened, marked } = await this.locked(context().tenantId, async (tx) => {
      const held = context();
      const rows = await detectionFacts(tx, held, ids, { withFinding: true });
      const still = waiting ? await stillWaiting(tx, held, ids) : new Set<string>();
      const decisions = rows.flatMap((row): Decision[] => {
        const what = detectionDecision({ ...row, waiting: still.has(row.id) });
        return what === 'none' ? [] : [{ row, what }];
      });
      const notices = decisions.filter(({ what }) => what === 'notice').map(({ row }) => row);
      await this.writeNotices(tx, held, notices, run);
      await raiseNoticed(
        tx,
        held.tenantId,
        decisions.map(({ row }) => row),
      );
      return { opened: notices.length, marked: decisions.length - notices.length };
    });
    run.report.opened += opened;
    run.report.marked += marked;
  }

  private async writeNotices(
    tx: Prisma.TransactionClient,
    { tenantId, now }: NoticeContext,
    rows: readonly DetectionRow[],
    run: Run,
  ): Promise<void> {
    if (rows.length === 0) return;
    const db = scopeToTenant(tx, tenantId);
    const keys = rows.map((row) => caseNoticeKey(row.id, row.worst));
    const known = await db.notification.findMany({
      where: { dedupeKey: { in: keys } },
      select: { dedupeKey: true },
    });
    const used = new Set(known.map((row) => row.dedupeKey));
    const data: Prisma.NotificationCreateManyInput[] = [];
    for (const row of rows) {
      const { findingId } = row;
      if (findingId === null) throw new CaseBatchError('caso pendente sem alerta');
      const key = caseNoticeKey(row.id, row.worst);
      data.push({
        ...noticeRow(tenantId, row.worst, findingId, run.startedAt, now),
        caseId: row.id,
        dedupeKey: used.has(key) ? caseWaveKey(row.id, row.worst, now) : key,
      });
    }
    const { count } = await db.notification.createMany({ data, skipDuplicates: true });
    if (count !== data.length) throw new CaseBatchError('aviso de caso que já existia');
    // O aviso alto do mesmo caso, ainda na fila, não sai junto com o crítico.
    const critical = rows.filter((row) => row.worst === 'critical').map((row) => row.id);
    if (critical.length > 0) {
      await db.notification.updateMany({
        where: {
          caseId: { in: critical },
          kind: 'high_finding',
          status: 'pending',
          attempts: 0,
          deliveredUserIds: { isEmpty: true },
          digestedUserIds: { isEmpty: true },
        },
        data: { status: 'skipped', lastError: CASE_SKIP.byCase },
      });
    }
  }

  private async applyGrowth(context: () => NoticeContext, ids: readonly string[], run: Run): Promise<void> {
    run.report.growth += await this.locked(context().tenantId, async (tx) => {
      const held = context();
      const { tenantId, now } = held;
      const due = (await growthFacts(tx, held, ids)).filter((row) => growthDue(row, now));
      const data: Prisma.NotificationCreateManyInput[] = [];
      for (const row of due) {
        const { findingId } = row;
        if (findingId === null) continue;
        data.push({
          ...noticeRow(tenantId, row.worst, findingId, run.startedAt, now),
          caseId: row.id,
          dedupeKey: caseGrowthKey(row.id, now),
        });
      }
      const { count } = await scopeToTenant(tx, tenantId).notification.createMany({
        data,
        skipDuplicates: true,
      });
      return count;
    });
  }

  /** O caso que não deixa decidir: o alerta mais novo da pior severidade dele avisa sozinho (uma vez por alerta). */
  private async isolate(context: NoticeContext, caseId: string, error: unknown, run: Run): Promise<void> {
    const { tenantId } = context;
    run.isolated.add(caseId);
    run.report.isolated += 1;
    this.options.logger?.error(
      { tenantId, caseId, error: errorKind(error), sqlState: sqlStateOf(error) },
      'caso fora dos avisos por caso: a decisão dele falha',
    );
    const db = this.prisma.forTenant(tenantId);
    const alert = await db.finding.findFirst({
      where: {
        caseId,
        incidentId: null,
        status: { in: ['new', 'investigating'] },
        severity: { in: ['critical', 'high'] },
        createdAt: { gte: context.epoch.mark },
      },
      orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
      select: { id: true, severity: true },
    });
    if (alert === null) return;
    run.report.lagging += await enqueueNotices(db, alertNotices({ tenantId, ...alert }));
  }

  // -------------------------------------------------------------------------------------------------
  // Vulnerabilidade e postura
  // -------------------------------------------------------------------------------------------------

  /** Quando saiu o último aviso imediato que vale. */
  private async lastCriticalAt(tenantId: string): Promise<Date | null> {
    const rows = await this.prisma.forTenant(tenantId).notification.findMany({
      where: {
        dedupeKey: { in: recentCriticalCasesKeys(this.now(), CRITICAL_COVER_HOURS) },
        NOT: { status: 'skipped', lastError: CASE_SKIP.treated },
      },
      select: { createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    return rows[0]?.createdAt ?? null;
  }

  /**
   * Os casos com crítico novo entram todos num aviso só, se o último saiu há uma hora ou mais; senão, esperam. O primeiro
   * lote grava o aviso; os seguintes da mesma execução são cobertos por ele.
   */
  private async critical(
    context: () => NoticeContext,
    waiting: readonly string[],
    lastAt: Date | null,
    run: Run,
  ): Promise<{ noticedAt: Date | null; finished: boolean }> {
    let noticedAt: Date | null = null;
    const allowed = (): boolean =>
      noticedAt !== null ||
      lastAt === null ||
      this.now().getTime() - lastAt.getTime() >= CASE_CRITICAL_INTERVAL_MS;
    const step = async (ids: readonly string[]): Promise<void> => {
      const done = await this.applyCritical(context, ids, allowed(), noticedAt, run);
      noticedAt = done ?? noticedAt;
    };
    for (let start = 0; start < waiting.length && allowed(); start += CASE_CRITICAL_PAGE) {
      run.signal?.throwIfAborted();
      await step(waiting.slice(start, start + CASE_CRITICAL_PAGE));
    }
    let after: string | null = null;
    for (;;) {
      run.signal?.throwIfAborted();
      const cursor: string | null = after;
      const rows: CriticalCase[] = await this.read((tx) =>
        criticalCases(tx, context(), cursor, CASE_CRITICAL_PAGE),
      );
      const ids = rows.filter((row) => row.findingId === null || allowed()).map((row) => row.id);
      if (ids.length > 0) await step(ids);
      if (rows.length < CASE_CRITICAL_PAGE) return { noticedAt, finished: true };
      after = rows.at(-1)?.id ?? null;
      if (this.elapsed() >= run.deadline) return { noticedAt, finished: false };
    }
  }

  /** Um lote: grava o aviso (se ainda não há um nesta execução) e marca os casos. Devolve quando o aviso nasceu. */
  private async applyCritical(
    context: () => NoticeContext,
    ids: readonly string[],
    allowed: boolean,
    noticedAt: Date | null,
    run: Run,
  ): Promise<Date | null> {
    const done = await this.locked(context().tenantId, async (tx) => {
      const held = context();
      const { tenantId, now } = held;
      const rows = await criticalCases(tx, held, null, ids.length, ids);
      const [first] = rows.filter((row) => row.findingId !== null);
      let at = noticedAt;
      let created = 0;
      if (first?.findingId != null && allowed && at === null) {
        const { count } = await scopeToTenant(tx, tenantId).notification.createMany({
          data: [
            {
              ...noticeRow(tenantId, 'critical', first.findingId, run.startedAt, now),
              dedupeKey: criticalCasesKey(now),
            },
          ],
          skipDuplicates: true,
        });
        created = count;
        if (count === 1) at = now;
      }
      // Sem aviso (o intervalo, ou outra réplica), o crítico novo espera; o que já foi avisado só é marcado.
      const marked = rows.filter((row) => row.findingId === null || at !== null).map((row) => row.id);
      await raiseNoticed(
        tx,
        tenantId,
        marked.map((id) => ({ id, worst: 'critical' as const })),
      );
      return { at, created, marked: rows.filter((row) => row.findingId === null).length };
    });
    run.report.critical += done.created;
    run.report.marked += done.marked;
    return done.at;
  }

  // -------------------------------------------------------------------------------------------------
  // A virada e o resumo diário
  // -------------------------------------------------------------------------------------------------

  private async supersede(context: () => NoticeContext, criticalAt: Date | null, run: Run): Promise<boolean> {
    for (let batches = 0; batches < CASE_NOTICE_MAX_BATCHES; batches += 1) {
      run.signal?.throwIfAborted();
      const skipped = await this.read((tx) => skipWaiting(tx, context(), criticalAt, this.supersedeBatch));
      run.report.superseded += skipped;
      if (skipped < this.supersedeBatch) return true;
      if (this.elapsed() >= run.deadline) return false;
    }
    return false;
  }

  /**
   * O resumo do dia, a partir das 09:00 de Brasília: uma linha por cliente e dia (um e-mail por pessoa), se há caso com
   * alerta alto ou crítico pendente e algo chegou desde o último resumo enviado (ou faz dias que nenhum sai). Só o que
   * chegou até as 09:00 conta: o resumo não sai às 14:00 por causa de um alerta das 14:00. No dia em que os avisos por caso
   * foram ligados depois das 09:00, o primeiro é o do dia seguinte.
   */
  private async daily(tenantId: string, epoch: CaseNoticeEpoch, run: Run): Promise<void> {
    const due = dueDaily(run.startedAt);
    if (due === null || epoch.activatedAt > due.at) return;
    const checked = this.dailyChecked.get(tenantId);
    if (checked?.day === due.day && this.elapsed() - checked.at < DAILY_RECHECK_MS) return;
    const db = this.prisma.forTenant(tenantId);
    const known = await db.notification.findMany({
      where: { dedupeKey: { in: [due.day, ...rememberedDailyDays(due.day)].map(dailyCasesKey) } },
      select: { dedupeKey: true, status: true },
      orderBy: { dedupeKey: 'desc' },
    });
    this.dailyChecked.set(tenantId, { day: due.day, at: this.elapsed() });
    if (known.some((row) => row.dedupeKey === dailyCasesKey(due.day))) return;
    const last = known.find((row) => row.status === 'sent');
    const since = last === undefined ? null : dailyMoment(dailyDayOf(last.dedupeKey));
    const content = await this.read((tx) => dailyContent(tx, tenantId, { since, until: due.at }));
    if (content === null) return;
    // Sempre como alerta alto: o contato de escalonamento, que só recebe os críticos, não recebe o resumo.
    const { count } = await db.notification.createMany({
      data: [
        {
          ...noticeRow(tenantId, 'high', content.findingId, run.startedAt, run.startedAt),
          dedupeKey: dailyCasesKey(due.day),
        },
      ],
      skipDuplicates: true,
    });
    run.report.daily += count;
  }

  // -------------------------------------------------------------------------------------------------

  /** Um comando com prazo e sem JIT, sem travar nada. */
  private read<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await setTriageTimeouts(tx, LOCK_TIMEOUT_MS, this.options.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS);
      return work(tx);
    }, TRANSACTION);
  }

  /** Uma transação com o lock dos alertas do cliente na mão. */
  private locked<T>(tenantId: string, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.read(async (tx) => {
      await lockFindingsBriefly(tx, tenantId);
      return work(tx);
    });
  }
}

const idsOf = (rows: readonly { id: string; queue: CaseQueue }[], detection: boolean): string[] =>
  rows.filter((row) => (row.queue === 'detection') === detection).map((row) => row.id);

/** A linha da fila de um aviso por caso, sem o caso e sem a chave. Os tipos são os do alerta. */
function noticeRow(
  tenantId: string,
  severity: NoticeSeverity,
  findingId: string,
  nextAttemptAt: Date,
  createdAt: Date,
): Omit<Prisma.NotificationCreateManyInput, 'dedupeKey'> {
  return { tenantId, kind: noticeKindOf(severity), severity, findingId, nextAttemptAt, createdAt };
}

/** A severidade avisada dos casos, que só sobe. */
async function raiseNoticed(
  tx: Prisma.TransactionClient,
  tenantId: string,
  rows: readonly { id: string; worst: NoticeSeverity }[],
): Promise<void> {
  if (rows.length === 0) return;
  await tx.$executeRaw`
    UPDATE "AlertCase" AS c SET "noticedSeverity" = v.severity::"FindingSeverity"
    FROM unnest(${rows.map((row) => row.id)}::uuid[], ${rows.map((row) => row.worst)}::text[]) AS v(id, severity)
    WHERE c."id" = v.id AND c."tenantId" = ${tenantId}::uuid
      AND (c."noticedSeverity" IS NULL OR c."noticedSeverity" > v.severity::"FindingSeverity")`;
}
