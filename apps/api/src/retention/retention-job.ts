import { PLAN_LIMIT_BOUNDS } from '@verax/shared';
import { randomUUID } from 'node:crypto';
import { lockTenantFindings, SyncLease } from '../alerts/finding-store.js';
import { AuditService } from '../common/audit/audit.service.js';
import { errorKind } from '../common/logger/error-kind.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import { scopeToTenant } from '../common/prisma/tenant-scope.js';
import type { Prisma } from '../generated/prisma/client.js';
import { fixedTenantPlans, type TenantPlans } from '../plan/tenant-plan.js';
import {
  decideHistoryDays,
  type HistoryDecision,
  type RetentionCutoffs,
  retentionCutoffs,
  retentionWindowStart,
} from './retention-policy.js';

/** Nome da tarefa no agendador, da linha no `SyncState` (agenda e concessão) e no `RetentionState` (prazo). */
export const RETENTION_TASK = 'retention';
/** De quanto em quanto tempo a tarefa confere se já pode rodar: a primeira conferência depois das 04:00 UTC roda. */
export const RETENTION_CHECK_INTERVAL_MS = 15 * 60 * 1000;
/** Tempo máximo de uma execução. O que sobrar fica para o dia seguinte. */
export const RETENTION_MAX_RUN_MS = 10 * 60 * 1000;
/** Orçamento no agendador: a execução, mais a gravação da trilha e a devolução da concessão. */
export const RETENTION_BUDGET_MS = RETENTION_MAX_RUN_MS + 2 * 60 * 1000;
/** Linhas por lote (cada lote é uma transação). */
export const RETENTION_BATCH = 500;
/** Pausa entre dois lotes, para o expurgo não disputar o banco com os coletores e a API. */
export const RETENTION_PAUSE_MS = 100;
/** O máximo que as funções do banco aceitam por chamada. */
const FUNCTION_BATCH_MAX = 1000;
/** Validade de uma transação do expurgo (um lote, sob o lock dos achados do cliente). */
const TRANSACTION_TIMEOUT_MS = 60_000;

/** O que saiu de um cliente. Vai para a trilha dele (só contagens). */
export interface TenantPurgeCounts {
  incidents: number;
  findings: number;
  comments: number;
  postureScans: number;
  postureFailures: number;
  inventorySnapshots: number;
  notifications: number;
  /** Horas de avisos de cada pessoa (a contagem e o resumo do PR-17'). */
  noticeDigests: number;
  auditLogs: number;
}

/** O que saiu das tabelas sem cliente. Vai para a trilha global da Verax (só contagens). */
export interface SystemPurgeCounts {
  unownedAlerts: number;
  sessions: number;
  verifications: number;
  loginAttempts: number;
  usedTotpCodes: number;
  rateLimits: number;
  /** Registros da auditoria sem cliente (operações globais da Verax) ou de cliente fora da execução. */
  auditLogs: number;
}

/**
 * Resultado de uma conferência da tarefa (vai para o log do agendador; só contagens, nenhum dado de cliente):
 * - `waiting`: antes das 04:00 UTC;
 * - `already_ran`: o expurgo de hoje já rodou;
 * - `locked`: outra réplica está com a concessão;
 * - `done`: rodou até o fim;
 * - `partial`: parou no tempo máximo; o resto fica para o dia seguinte.
 *
 * `historyDays` é o prazo em vigor quando ele é o mesmo para todos os clientes (o nó dedicado); com prazos diferentes
 * (a célula), fica de fora, e cada cliente tem o dele na trilha. `withoutPlan` conta os clientes da célula ainda sem
 * plano, que ficaram fora do expurgo do histórico e da auditoria.
 */
export interface RetentionReport {
  status: 'waiting' | 'already_ran' | 'locked' | 'done' | 'partial';
  historyDays?: number | null;
  tenants?: number;
  withoutPlan?: number;
  deleted?: {
    incidents: number;
    findings: number;
    comments: number;
    postureScans: number;
    postureFailures: number;
    inventorySnapshots: number;
    notifications: number;
    noticeDigests: number;
    unownedAlerts: number;
    operational: number;
    auditLogs: number;
  };
}

export interface RetentionJobOptions {
  /**
   * O plano de cada cliente (CE-02; o `TenantPlanResolver` do worker). Sem ele, `historyDays` vale para todos os
   * clientes (os testes).
   */
  plans?: TenantPlans;
  /** Dias de histórico de todo cliente, sem `plans`; null é sem limite. */
  historyDays?: number | null;
  audit?: AuditService;
  /** Nome da linha no `SyncState` e no `RetentionState` (outro nos testes, para cada um ter a própria agenda). */
  name?: string;
  owner?: string;
  leaseMs?: number;
  /** Linhas por lote, de 1 a 1000 (menor nos testes, para percorrer vários lotes com poucas linhas). */
  batch?: number;
  pauseMs?: number;
  maxRunMs?: number;
  /** Relógio do tempo máximo (um falso nos testes). */
  clock?: () => number;
  /**
   * Só estes clientes nas fases de cliente (os testes dividem o banco com as outras suítes). Sem informar, todos. As
   * fases sem cliente (fila sem dono, tabelas de operação e auditoria) valem sempre para o nó inteiro.
   */
  tenantIds?: readonly string[];
}

/** O que vale para um cliente nesta execução: o prazo do plano dele, a decisão (com a carência) e os cortes. */
interface TenantRun {
  counts: TenantPurgeCounts;
  /** null: o cliente da célula ainda sem plano (fica fora do histórico e da auditoria). */
  plan: { planDays: number | null; decision: HistoryDecision; cutoffs: RetentionCutoffs } | null;
}

/** Uma execução: o tempo máximo, a parada do worker, a concessão e a pausa entre lotes. */
class RunBudget {
  private readonly deadline: number;
  stopped = false;

  constructor(
    private readonly clock: () => number,
    maxRunMs: number,
    private readonly lease: SyncLease,
    private readonly pauseMs: number,
    private readonly signal?: AbortSignal,
  ) {
    this.deadline = clock() + maxRunMs;
  }

  /**
   * Pode começar mais um lote? A parada do worker lança (a execução é interrompida); o tempo máximo só para: depois
   * dele, nenhum lote começa, e a execução termina como parcial. O relógio é lido uma vez por lote.
   */
  canStartBatch(): boolean {
    this.signal?.throwIfAborted();
    if (!this.stopped && this.clock() >= this.deadline) this.stopped = true;
    return !this.stopped;
  }

  /** Depois de cada lote: renova a concessão e espera a pausa (a parada do worker acorda na hora). */
  async afterBatch(): Promise<void> {
    await this.lease.renew();
    if (this.pauseMs <= 0) return;
    const signal = this.signal;
    await new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', wake);
        resolve();
      };
      const timer = setTimeout(wake, this.pauseMs);
      signal?.addEventListener('abort', wake, { once: true });
    });
    this.signal?.throwIfAborted();
  }
}

const emptyTenantCounts = (): TenantPurgeCounts => ({
  incidents: 0,
  findings: 0,
  comments: 0,
  postureScans: 0,
  postureFailures: 0,
  inventorySnapshots: 0,
  notifications: 0,
  noticeDigests: 0,
  auditLogs: 0,
});

const emptySystemCounts = (): SystemPurgeCounts => ({
  unownedAlerts: 0,
  sessions: 0,
  verifications: 0,
  loginAttempts: 0,
  usedTotpCodes: 0,
  rateLimits: 0,
  auditLogs: 0,
});

/** O menor prazo de histórico que um plano aceita: os cortes que não dependem do plano saem com ele. */
const PLAN_HISTORY_FLOOR_DAYS = PLAN_LIMIT_BOUNDS.historyDays.min;

/**
 * O corte da auditoria que vale para todos (os registros sem cliente e os de cada cliente): o mais antigo entre os
 * clientes, para nenhum perder o que o prazo dele guarda. Um cliente sem limite, ou sem plano, segura tudo (null). Sem
 * nenhum cliente, o piso de 13 meses.
 */
function globalAuditCutoff(perTenant: ReadonlyMap<string, TenantRun>, floor: Date | null): Date | null {
  let oldest: Date | null = null;
  for (const { plan } of perTenant.values()) {
    const cutoff = plan?.cutoffs.audit ?? null;
    if (cutoff === null) return null;
    if (oldest === null || cutoff.getTime() < oldest.getTime()) oldest = cutoff;
  }
  return oldest ?? floor;
}

/** O achado teve atividade a partir do corte: aconteceu, mudou (status, versão do GuardDuty) ou ganhou comentário. */
function touchedSince(cutoff: Date): Prisma.FindingWhereInput {
  return {
    OR: [
      { occurredAt: { gte: cutoff } },
      { updatedAt: { gte: cutoff } },
      { lastSeenAt: { gte: cutoff } },
      { comments: { some: { createdAt: { gte: cutoff } } } },
    ],
  };
}

/**
 * Incidente que sai: sem atividade antes do corte (último achado e última mudança) e nenhum achado dele com atividade
 * a partir do corte. Um incidente que fica guarda a linha do tempo inteira, inclusive os achados antigos.
 */
function incidentExpired(cutoff: Date): Prisma.IncidentWhereInput {
  return { lastSeenAt: { lt: cutoff }, updatedAt: { lt: cutoff }, findings: { none: touchedSince(cutoff) } };
}

/**
 * Achado solto que sai: fora de incidente, sem atividade a partir do corte e sem recorrência apontando para ele (a
 * recorrência, mais nova, sai antes; o original sai num lote seguinte).
 */
function looseFindingExpired(cutoff: Date): Prisma.FindingWhereInput {
  return {
    incidentId: null,
    occurredAt: { lt: cutoff },
    updatedAt: { lt: cutoff },
    OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: cutoff } }],
    comments: { none: { createdAt: { gte: cutoff } } },
    recurrences: { none: {} },
  };
}

/** Aviso resolvido (enviado, com falha ou pulado) sem mudança desde o corte. O pendente nunca sai. */
interface NotificationExpiredWhere {
  status: { in: ('sent' | 'failed' | 'skipped')[] };
  updatedAt: { lt: Date };
}

/**
 * O que o expurgo usa do model `Notification` (a fila de saída dos avisos por e-mail, PR-16). Enquanto o PR-16 não
 * estiver no código, o model não existe no client e a fase não roda; com ele, o client no escopo do cliente entrega o
 * delegate já filtrado pelo `tenantId` (o PR-16 põe `notification` em `TENANT_SCOPED_MODELS`). Quando o PR-16 entrar,
 * esta interface pode dar lugar ao delegate tipado do Prisma, sem mudar a regra.
 */
interface NotificationDelegate {
  findMany(args: {
    where: NotificationExpiredWhere;
    select: { id: true };
    orderBy: { updatedAt: 'asc' };
    take: number;
  }): Promise<{ id: string }[]>;
  deleteMany(args: {
    where: NotificationExpiredWhere & { id: { in: string[] } };
  }): Promise<{ count: number }>;
}

function notificationsOf(db: Prisma.TransactionClient): NotificationDelegate | undefined {
  return (db as unknown as { notification?: NotificationDelegate }).notification;
}

/*
 * Travas de linha do expurgo de achados e incidentes. A triagem pela API (status do achado, comentário, status e
 * responsável do incidente) não toma o lock dos coletores; sem estas travas, uma triagem confirmada entre a conferência
 * e o DELETE seria apagada junto. Por isso cada lote, na própria transação:
 * 1. trava com `SELECT ... FOR UPDATE` as linhas que vai apagar (os incidentes e os achados deles, ou os achados soltos),
 *    só pelo ID e pelo cliente. Uma triagem em curso nessas linhas faz o lote esperar o fim dela; uma que chega depois
 *    espera o lote. Um comentário novo também espera: a chave estrangeira dele trava o achado (`FOR KEY SHARE`), o que
 *    conflita com o `FOR UPDATE`;
 * 2. só então refaz a conferência completa, numa consulta nova. Em READ COMMITTED cada comando tem o próprio retrato,
 *    então ela vê toda triagem e todo comentário confirmados antes da trava, e a linha que deixou de valer fica.
 * Conferir de novo só no DELETE não bastaria: o Postgres reavalia, na linha alterada, só as condições sobre a própria
 * tabela, e não as que dependem de outras (os comentários, os achados do incidente); e no incidente o DELETE vem depois
 * dos achados dele, que já teriam saído.
 *
 * A ordem é sempre incidente e depois achado. A API trava uma linha só por transação (um achado ou um incidente), então
 * não há ciclo de espera com ela; os coletores entram pelo lock do cliente, que o expurgo toma antes.
 */
async function lockIncidentRows(
  tx: Prisma.TransactionClient,
  tenantId: string,
  ids: readonly string[],
): Promise<void> {
  await tx.$executeRaw`
    SELECT 1 FROM "Incident"
    WHERE "id" = ANY(${[...ids]}::uuid[]) AND "tenantId" = ${tenantId}::uuid
    ORDER BY "id" FOR UPDATE`;
}

async function lockFindingRows(
  tx: Prisma.TransactionClient,
  tenantId: string,
  rows: { ids: readonly string[] } | { incidentIds: readonly string[] },
): Promise<void> {
  if ('ids' in rows) {
    await tx.$executeRaw`
      SELECT 1 FROM "Finding"
      WHERE "id" = ANY(${[...rows.ids]}::uuid[]) AND "tenantId" = ${tenantId}::uuid
      ORDER BY "id" FOR UPDATE`;
  } else {
    await tx.$executeRaw`
      SELECT 1 FROM "Finding"
      WHERE "incidentId" = ANY(${[...rows.incidentIds]}::uuid[]) AND "tenantId" = ${tenantId}::uuid
      ORDER BY "id" FOR UPDATE`;
  }
}

/** Apaga os comentários dos achados pela função controlada do banco (a aplicação não tem DELETE na tabela). */
async function purgeComments(tx: Prisma.TransactionClient, findingIds: readonly string[]): Promise<number> {
  let deleted = 0;
  for (let start = 0; start < findingIds.length; start += FUNCTION_BATCH_MAX) {
    const chunk = findingIds.slice(start, start + FUNCTION_BATCH_MAX);
    const rows = await tx.$queryRaw<{ deleted: number }[]>`
      SELECT verax_purge_finding_comments(${chunk}::uuid[]) AS deleted`;
    deleted += Number(rows[0]?.deleted ?? 0);
  }
  return deleted;
}

/** Agrupa incidentes em lotes de até `limit` achados (um incidente maior que isso vai sozinho). */
function byFindingCount<T extends { findingCount: number }>(rows: readonly T[], limit: number): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const row of rows) {
    if (current.length > 0 && size + row.findingCount > limit) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(row);
    size += row.findingCount;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Tarefa `retention` do worker (fase 2, PR-19): o expurgo diário do histórico guardado no banco do nó, pelo prazo do
 * plano de cada cliente (CE-02: o `TenantPlan`, que no nó dedicado é o do `node.conf`). Só o banco da Verax: nada na
 * nuvem do cliente, nos buckets dele nem no índice do Wazuh, que tem retenção própria de 30 dias (ISM).
 *
 * Agenda: roda depois das 04:00 UTC, no máximo uma vez por dia (`SyncState('retention').lastSuccessAt`), com a
 * concessão do banco (uma réplica por vez, renovada a cada lote). Uma execução dura no máximo 10 minutos; o que sobrar
 * fica para o dia seguinte. A parada do worker interrompe entre dois lotes, e o dia roda de novo na próxima partida.
 *
 * Ordem, cada cliente pelo próprio escopo:
 * 1. incidentes sem atividade antes do corte, com os achados e os comentários deles;
 * 2. achados soltos (fora de incidente);
 * 3. postura (a varredura mais recente de cada conta fica sempre), inventário (30 dias; o retrato mais recente de cada
 *    conta fica sempre) e avisos por e-mail resolvidos (90 dias; só quando o model do PR-16 existe);
 * 4. fila sem dono (90 dias);
 * 5. tabelas de operação (sessões, links, tentativas de login, códigos TOTP usados e limite por IP, vencidos há mais
 *    de um dia);
 * 6. auditoria (13 meses, ou o histórico do cliente se for maior): pela função `verax_purge_audit_log`, com o corte
 *    mais antigo entre os clientes (que vale também para os registros sem cliente), e, de cada cliente com corte mais
 *    novo que esse, pela `verax_purge_tenant_audit_log`. Um cliente sem limite (ou da célula ainda sem plano) segura o
 *    corte global: nada mais antigo que o dele sai.
 *
 * O prazo de cada cliente tem a própria carência (`TenantRetentionState`): quando o plano dele diminui, o expurgo dele
 * continua com o prazo anterior por 30 dias. O cliente da célula ainda sem plano fica fora do histórico e da auditoria
 * (o inventário, os avisos e as tabelas de operação seguem regras que não dependem do plano).
 *
 * Os comentários e a auditoria são imutáveis no banco: saem só pelas funções `verax_purge_*`, que conferem o piso de
 * idade por conta própria. No fim, cada cliente ganha um `retention.purge` na trilha dele, com os cortes e as
 * contagens (nenhum conteúdo), e a Verax um global com as tabelas sem cliente. A trilha passa a dizer que, antes do
 * corte, os registros saíram pela política.
 */
export class RetentionJob {
  private readonly audit: AuditService;
  private readonly name: string;
  private readonly lease: SyncLease;
  private readonly batch: number;
  private readonly pauseMs: number;
  private readonly maxRunMs: number;
  private readonly clock: () => number;
  private readonly plans: TenantPlans;
  private readonly tenantIds: readonly string[] | null;

  constructor(
    private readonly prisma: PrismaService,
    options: RetentionJobOptions,
  ) {
    const batch = options.batch ?? RETENTION_BATCH;
    if (!Number.isInteger(batch) || batch < 1 || batch > FUNCTION_BATCH_MAX) {
      throw new Error(`o lote do expurgo precisa ser um inteiro de 1 a ${FUNCTION_BATCH_MAX}`);
    }
    if (options.plans !== undefined) {
      this.plans = options.plans;
    } else {
      if (options.historyDays === undefined) throw new Error('o expurgo precisa do plano de cada cliente');
      // Confere o prazo fixo já na partida.
      retentionCutoffs(new Date(), options.historyDays);
      this.plans = fixedTenantPlans({
        id: 'enterprise',
        label: 'Prazo fixo',
        limits: {
          maxCloudAccounts: null,
          maxUsers: null,
          monthlyGib: null,
          historyDays: options.historyDays,
        },
      });
    }
    this.audit = options.audit ?? new AuditService();
    this.name = options.name ?? RETENTION_TASK;
    this.batch = batch;
    this.pauseMs = options.pauseMs ?? RETENTION_PAUSE_MS;
    this.maxRunMs = options.maxRunMs ?? RETENTION_MAX_RUN_MS;
    this.clock = options.clock ?? Date.now;
    this.tenantIds = options.tenantIds ?? null;
    this.lease = new SyncLease(
      prisma,
      this.name,
      options.owner ?? `worker-${randomUUID()}`,
      options.leaseMs ?? 5 * 60 * 1000,
    );
  }

  /** Uma conferência do agendador: roda o expurgo do dia, se for a hora e se ainda não rodou. */
  async maybeRun(now: Date = new Date(), signal?: AbortSignal): Promise<RetentionReport> {
    const windowStart = retentionWindowStart(now);
    if (now.getTime() < windowStart.getTime()) return { status: 'waiting' };
    if (await this.ranSince(windowStart)) return { status: 'already_ran' };
    if (!(await this.lease.acquire(now))) return { status: 'locked' };
    try {
      // De novo, com a concessão: outra réplica pode ter terminado entre a leitura e a concessão.
      if (await this.ranSince(windowStart)) return { status: 'already_ran' };
      try {
        const report = await this.purge(now, signal);
        await this.prisma.syncState.update({
          where: { name: this.name },
          data: { lastRunAt: now, lastSuccessAt: now, lastError: null },
        });
        return report;
      } catch (error) {
        // Só o tipo do erro: a mensagem de um erro do banco pode carregar dado.
        await this.prisma.syncState.update({
          where: { name: this.name },
          data: { lastRunAt: now, lastError: errorKind(error) },
        });
        throw error;
      }
    } finally {
      await this.lease.release();
    }
  }

  private async ranSince(windowStart: Date): Promise<boolean> {
    const state = await this.prisma.syncState.findUnique({
      where: { name: this.name },
      select: { lastSuccessAt: true },
    });
    const lastSuccessAt = state?.lastSuccessAt ?? null;
    return lastSuccessAt !== null && lastSuccessAt.getTime() >= windowStart.getTime();
  }

  private async purge(now: Date, signal?: AbortSignal): Promise<RetentionReport> {
    // As regras que não dependem do plano (inventário, avisos, fila sem dono e operação) e o piso da auditoria.
    const common = retentionCutoffs(now, PLAN_HISTORY_FLOOR_DAYS);
    const run = new RunBudget(this.clock, this.maxRunMs, this.lease, this.pauseMs, signal);
    const tenants = await this.tenants();
    const perTenant = new Map<string, TenantRun>();
    for (const tenantId of tenants) perTenant.set(tenantId, await this.tenantRun(tenantId, now));
    const system = emptySystemCounts();
    const globalAudit = globalAuditCutoff(perTenant, common.audit);

    try {
      for (const [tenantId, { counts, plan }] of perTenant) {
        const history = plan?.cutoffs.history ?? null;
        if (history !== null) {
          await this.purgeIncidents(tenantId, history, counts, run);
          await this.purgeLooseFindings(tenantId, history, counts, run);
          await this.purgePosture(tenantId, history, counts, run);
        }
        await this.purgeInventory(tenantId, common.inventory, counts, run);
        await this.purgeNotifications(tenantId, common.notifications, counts, run);
      }
      await this.purgeUnowned(common.unowned, system, run);
      await this.purgeOperational(common.operational, system, run);
      await this.purgeTenantAudit(perTenant, globalAudit, run);
      if (globalAudit !== null) await this.purgeAudit(globalAudit, perTenant, system, run);
    } catch (error) {
      // A trilha registra o que já saiu também quando a execução para no meio (parada do worker, erro). Uma falha ao
      // gravá-la não esconde o erro original.
      await this.writeTrail(common, globalAudit, perTenant, system, false, error).catch(() => undefined);
      throw error;
    }
    // Parar no tempo máximo não é erro: a trilha diz que a execução ficou incompleta.
    const complete = !run.stopped;
    await this.writeTrail(common, globalAudit, perTenant, system, complete, null);

    const runs = [...perTenant.values()];
    const totals = runs.reduce((sum, { counts }) => {
      for (const key of Object.keys(sum) as (keyof TenantPurgeCounts)[]) sum[key] += counts[key];
      return sum;
    }, emptyTenantCounts());
    const days = new Set(runs.flatMap(({ plan }) => (plan === null ? [] : [plan.decision.days])));
    const withoutPlan = runs.filter(({ plan }) => plan === null).length;
    return {
      status: complete ? 'done' : 'partial',
      ...(days.size === 1 && { historyDays: [...days][0] }),
      tenants: tenants.length,
      ...(withoutPlan > 0 && { withoutPlan }),
      deleted: {
        incidents: totals.incidents,
        findings: totals.findings,
        comments: totals.comments,
        postureScans: totals.postureScans,
        postureFailures: totals.postureFailures,
        inventorySnapshots: totals.inventorySnapshots,
        notifications: totals.notifications,
        noticeDigests: totals.noticeDigests,
        unownedAlerts: system.unownedAlerts,
        operational:
          system.sessions +
          system.verifications +
          system.loginAttempts +
          system.usedTotpCodes +
          system.rateLimits,
        auditLogs: totals.auditLogs + system.auditLogs,
      },
    };
  }

  /** O plano do cliente, a decisão do prazo (com a carência) e os cortes dele; sem plano (a célula), null. */
  private async tenantRun(tenantId: string, now: Date): Promise<TenantRun> {
    const counts = emptyTenantCounts();
    const plan = await this.plans.planOf(tenantId);
    if (plan === null) return { counts, plan: null };
    const planDays = plan.limits.historyDays;
    const decision = await this.historyPolicy(tenantId, planDays, now);
    return { counts, plan: { planDays, decision, cutoffs: retentionCutoffs(now, decision.days) } };
  }

  /**
   * Prazo de histórico em vigor para um cliente, com a carência quando o plano dele diminui; guarda o estado para a
   * próxima execução.
   */
  private async historyPolicy(
    tenantId: string,
    planDays: number | null,
    now: Date,
  ): Promise<HistoryDecision> {
    const key = { job: this.name, tenantId };
    const row = await this.prisma.tenantRetentionState.findUnique({
      where: { job_tenantId: key },
      select: { appliedDays: true, pendingSince: true },
    });
    const decision = decideHistoryDays(planDays, row, now);
    await this.prisma.tenantRetentionState.upsert({
      where: { job_tenantId: key },
      create: { ...key, ...decision.state },
      update: decision.state,
    });
    return decision;
  }

  private async tenants(): Promise<string[]> {
    const rows = await this.prisma.tenant.findMany({
      where: this.tenantIds === null ? {} : { id: { in: [...this.tenantIds] } },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => row.id);
  }

  /**
   * Laço comum de lotes: busca as chaves de um lote (fora de transação), confere o tempo e apaga. Termina quando a
   * busca volta vazia, quando o tempo acaba ou quando um lote não apaga nada (as linhas buscadas deixaram de valer).
   * `record` soma o lote assim que ele é confirmado: se a execução parar depois (parada do worker, erro num lote
   * seguinte), a trilha da falha conta o que já saiu.
   */
  private async inBatches<K>(
    run: RunBudget,
    fetch: () => Promise<K[]>,
    remove: (keys: K[]) => Promise<number>,
    record: (deleted: number) => void,
  ): Promise<void> {
    for (;;) {
      const keys = await fetch();
      if (keys.length === 0 || !run.canStartBatch()) return;
      const deleted = await remove(keys);
      record(deleted);
      await run.afterBatch();
      if (deleted === 0) return;
    }
  }

  /** 1. Incidentes que saem inteiros, com os achados e os comentários deles, em lotes de até `batch` achados. */
  private async purgeIncidents(
    tenantId: string,
    cutoff: Date,
    counts: TenantPurgeCounts,
    run: RunBudget,
  ): Promise<void> {
    const db = this.prisma.forTenant(tenantId);
    // Cursor pelo ID: um incidente preso por uma recorrência de fora fica, e a próxima página começa depois dele.
    let after: string | null = null;
    for (;;) {
      const page: { id: string; findingCount: number }[] = await db.incident.findMany({
        where: { ...incidentExpired(cutoff), ...(after !== null && { id: { gt: after } }) },
        select: { id: true, findingCount: true },
        orderBy: { id: 'asc' },
        take: this.batch,
      });
      for (const group of byFindingCount(page, this.batch)) {
        if (!run.canStartBatch()) return;
        const deleted = await this.deleteIncidents(
          tenantId,
          cutoff,
          group.map((row) => row.id),
        );
        counts.incidents += deleted.incidents;
        counts.findings += deleted.findings;
        counts.comments += deleted.comments;
        await run.afterBatch();
      }
      const last = page.at(-1);
      if (last === undefined || page.length < this.batch) return;
      after = last.id;
    }
  }

  private deleteIncidents(
    tenantId: string,
    cutoff: Date,
    ids: readonly string[],
  ): Promise<{ incidents: number; findings: number; comments: number }> {
    return this.prisma.$transaction(
      async (tx) => {
        // O lock dos coletores: nenhum achado novo entra num destes incidentes enquanto o lote sai.
        await lockTenantFindings(tx, tenantId);
        // As linhas do lote, travadas antes da conferência final (ver `lockRows`): primeiro os incidentes, depois os
        // achados deles, sempre nesta ordem.
        await lockIncidentRows(tx, tenantId, ids);
        await lockFindingRows(tx, tenantId, { incidentIds: ids });
        const db = scopeToTenant(tx, tenantId);
        // De novo, com as linhas travadas: a consulta vê toda triagem, mudança ou comentário já confirmado.
        const incidents = await db.incident.findMany({
          where: { id: { in: [...ids] }, ...incidentExpired(cutoff) },
          select: { id: true, findings: { select: { id: true } } },
        });
        const held = await this.heldByRecurrences(db, incidents);
        const doomed = incidents.filter((incident) => !held.has(incident.id));
        const findingIds = doomed.flatMap((incident) => incident.findings.map((finding) => finding.id));
        const comments = findingIds.length === 0 ? 0 : await purgeComments(tx, findingIds);
        const findings =
          findingIds.length === 0
            ? 0
            : (await db.finding.deleteMany({ where: { id: { in: findingIds } } })).count;
        const incidentsDeleted =
          doomed.length === 0
            ? 0
            : (await db.incident.deleteMany({ where: { id: { in: doomed.map((incident) => incident.id) } } }))
                .count;
        return { incidents: incidentsDeleted, findings, comments };
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
  }

  /**
   * Incidentes que ficam porque um achado deles é o original de uma recorrência que não sai junto (em outro incidente
   * ou solta): a recorrência aponta para o original, e ele só sai depois dela. Repete até não sobrar nenhum.
   */
  private async heldByRecurrences(
    db: Prisma.TransactionClient,
    incidents: readonly { id: string; findings: readonly { id: string }[] }[],
  ): Promise<Set<string>> {
    const held = new Set<string>();
    for (;;) {
      const doomed = incidents.filter((incident) => !held.has(incident.id));
      const ids = doomed.flatMap((incident) => incident.findings.map((finding) => finding.id));
      if (ids.length === 0) return held;
      const outside = await db.finding.findMany({
        where: { recurrenceOfId: { in: ids }, id: { notIn: ids } },
        select: { recurrenceOfId: true },
      });
      if (outside.length === 0) return held;
      const originals = new Set(outside.map((row) => row.recurrenceOfId));
      for (const incident of doomed) {
        if (incident.findings.some((finding) => originals.has(finding.id))) held.add(incident.id);
      }
    }
  }

  /** 2. Achados soltos, com os comentários. */
  private async purgeLooseFindings(
    tenantId: string,
    cutoff: Date,
    counts: TenantPurgeCounts,
    run: RunBudget,
  ): Promise<void> {
    const db = this.prisma.forTenant(tenantId);
    await this.inBatches(
      run,
      async () =>
        (
          await db.finding.findMany({
            where: looseFindingExpired(cutoff),
            select: { id: true },
            orderBy: { id: 'asc' },
            take: this.batch,
          })
        ).map((row) => row.id),
      async (ids) => {
        const deleted = await this.prisma.$transaction(
          async (tx) => {
            await lockTenantFindings(tx, tenantId);
            await lockFindingRows(tx, tenantId, { ids });
            const scoped = scopeToTenant(tx, tenantId);
            // De novo, com as linhas travadas: a consulta vê toda triagem ou comentário já confirmado.
            const doomed = (
              await scoped.finding.findMany({
                where: { id: { in: ids }, ...looseFindingExpired(cutoff) },
                select: { id: true },
              })
            ).map((row) => row.id);
            if (doomed.length === 0) return { findings: 0, comments: 0 };
            const comments = await purgeComments(tx, doomed);
            const findings = (await scoped.finding.deleteMany({ where: { id: { in: doomed } } })).count;
            return { findings, comments };
          },
          { timeout: TRANSACTION_TIMEOUT_MS },
        );
        counts.comments += deleted.comments;
        return deleted.findings;
      },
      (deleted) => {
        counts.findings += deleted;
      },
    );
  }

  /** 3a. Postura: as reprovações das varreduras que saem (em lotes), depois as varreduras. A mais recente fica. */
  private async purgePosture(
    tenantId: string,
    cutoff: Date,
    counts: TenantPurgeCounts,
    run: RunBudget,
  ): Promise<void> {
    const db = this.prisma.forTenant(tenantId);
    const latest = await db.postureScan.groupBy({ by: ['accountId'], _max: { scannedAt: true } });
    const keep = latest.flatMap((row) =>
      row._max.scannedAt === null ? [] : [{ accountId: row.accountId, scannedAt: row._max.scannedAt }],
    );
    if (keep.length === 0) return;
    const expired: Prisma.PostureScanWhereInput = { scannedAt: { lt: cutoff }, NOT: { OR: keep } };
    await this.inBatches(
      run,
      async () =>
        (
          await db.postureFailure.findMany({
            where: { scan: expired },
            select: { id: true },
            take: this.batch,
          })
        ).map((row) => row.id),
      async (ids) =>
        (await db.postureFailure.deleteMany({ where: { id: { in: ids }, scan: expired } })).count,
      (deleted) => {
        counts.postureFailures += deleted;
      },
    );
    await this.inBatches(
      run,
      async () =>
        (
          await db.postureScan.findMany({
            where: expired,
            select: { id: true },
            orderBy: { scannedAt: 'asc' },
            take: this.batch,
          })
        ).map((row) => row.id),
      async (ids) => (await db.postureScan.deleteMany({ where: { id: { in: ids }, ...expired } })).count,
      (deleted) => {
        counts.postureScans += deleted;
      },
    );
  }

  /** 3b. Inventário: 30 dias, e o retrato mais recente de cada conta fica sempre. */
  private async purgeInventory(
    tenantId: string,
    cutoff: Date,
    counts: TenantPurgeCounts,
    run: RunBudget,
  ): Promise<void> {
    const db = this.prisma.forTenant(tenantId);
    const latest = await db.inventorySnapshot.groupBy({ by: ['accountId'], _max: { collectedAt: true } });
    const keep = latest.flatMap((row) =>
      row._max.collectedAt === null ? [] : [{ accountId: row.accountId, collectedAt: row._max.collectedAt }],
    );
    if (keep.length === 0) return;
    const expired: Prisma.InventorySnapshotWhereInput = { collectedAt: { lt: cutoff }, NOT: { OR: keep } };
    await this.inBatches(
      run,
      async () =>
        (
          await db.inventorySnapshot.findMany({
            where: expired,
            select: { id: true },
            orderBy: { collectedAt: 'asc' },
            take: this.batch,
          })
        ).map((row) => row.id),
      async (ids) =>
        (await db.inventorySnapshot.deleteMany({ where: { id: { in: ids }, ...expired } })).count,
      (deleted) => {
        counts.inventorySnapshots += deleted;
      },
    );
  }

  /**
   * 3c. Avisos por e-mail resolvidos há mais de 90 dias (PR-16). O aviso de um incidente ou achado que saiu já foi
   * junto, pela chave estrangeira em cascata; aqui saem os que sobram (volume do plano, pulados, com falha). Depois, as
   * horas de avisos das pessoas (PR-17'), pelo mesmo prazo.
   */
  private async purgeNotifications(
    tenantId: string,
    cutoff: Date,
    counts: TenantPurgeCounts,
    run: RunBudget,
  ): Promise<void> {
    const notifications = notificationsOf(this.prisma.forTenant(tenantId));
    if (notifications === undefined) return;
    const where: NotificationExpiredWhere = {
      status: { in: ['sent', 'failed', 'skipped'] },
      updatedAt: { lt: cutoff },
    };
    await this.inBatches(
      run,
      async () =>
        (
          await notifications.findMany({
            where,
            select: { id: true },
            orderBy: { updatedAt: 'asc' },
            take: this.batch,
          })
        ).map((row) => row.id),
      async (ids) => (await notifications.deleteMany({ where: { ...where, id: { in: ids } } })).count,
      (deleted) => {
        counts.notifications += deleted;
      },
    );
    // As horas de avisos de cada pessoa (PR-17'), pelo mesmo prazo: o resumo resolvido e a hora que só contou e-mails
    // avulsos (sem resumo), sem mudança desde o corte. O resumo pendente fica, como o aviso pendente.
    const digests = this.prisma.forTenant(tenantId).notificationDigest;
    const digestWhere: Prisma.NotificationDigestWhereInput = {
      OR: [{ status: { in: ['sent', 'failed', 'skipped'] } }, { status: null }],
      updatedAt: { lt: cutoff },
    };
    await this.inBatches(
      run,
      async () =>
        (
          await digests.findMany({
            where: digestWhere,
            select: { id: true },
            orderBy: { updatedAt: 'asc' },
            take: this.batch,
          })
        ).map((row) => row.id),
      async (ids) => (await digests.deleteMany({ where: { ...digestWhere, id: { in: ids } } })).count,
      (deleted) => {
        counts.noticeDigests += deleted;
      },
    );
  }

  /** 4. Fila sem dono (dado de sistema, só a Verax vê). */
  private async purgeUnowned(cutoff: Date, system: SystemPurgeCounts, run: RunBudget): Promise<void> {
    const where: Prisma.UnownedAlertWhereInput = { createdAt: { lt: cutoff } };
    await this.inBatches(
      run,
      async () =>
        (
          await this.prisma.unownedAlert.findMany({
            where,
            select: { id: true },
            orderBy: { createdAt: 'asc' },
            take: this.batch,
          })
        ).map((row) => row.id),
      async (ids) =>
        (await this.prisma.unownedAlert.deleteMany({ where: { id: { in: ids }, ...where } })).count,
      (deleted) => {
        system.unownedAlerts += deleted;
      },
    );
  }

  /**
   * 5. Tabelas de operação, vencidas há mais de um dia: nenhuma sessão válida, link válido, bloqueio de login vigente,
   * código TOTP dentro da janela ou contador de limite em uso sai.
   */
  private async purgeOperational(cutoff: Date, system: SystemPurgeCounts, run: RunBudget): Promise<void> {
    const db = this.prisma;
    const take = this.batch;

    const sessions: Prisma.SessionWhereInput = { expiresAt: { lt: cutoff } };
    await this.inBatches(
      run,
      async () =>
        (await db.session.findMany({ where: sessions, select: { id: true }, take })).map((row) => row.id),
      async (ids) => (await db.session.deleteMany({ where: { id: { in: ids }, ...sessions } })).count,
      (deleted) => {
        system.sessions += deleted;
      },
    );

    const verifications: Prisma.VerificationWhereInput = { expiresAt: { lt: cutoff } };
    await this.inBatches(
      run,
      async () =>
        (await db.verification.findMany({ where: verifications, select: { id: true }, take })).map(
          (row) => row.id,
        ),
      async (ids) =>
        (await db.verification.deleteMany({ where: { id: { in: ids }, ...verifications } })).count,
      (deleted) => {
        system.verifications += deleted;
      },
    );

    // A tentativa conta por 15 minutos e o bloqueio dura 15: passado um dia de ambos, a linha não decide mais nada.
    const attempts: Prisma.LoginAttemptWhereInput = {
      firstFailureAt: { lt: cutoff },
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: cutoff } }],
    };
    await this.inBatches(
      run,
      async () =>
        (await db.loginAttempt.findMany({ where: attempts, select: { email: true }, take })).map(
          (row) => row.email,
        ),
      async (emails) =>
        (await db.loginAttempt.deleteMany({ where: { email: { in: emails }, ...attempts } })).count,
      (deleted) => {
        system.loginAttempts += deleted;
      },
    );

    const codes: Prisma.UsedTotpCodeWhereInput = { usedAt: { lt: cutoff } };
    await this.inBatches(
      run,
      () => db.usedTotpCode.findMany({ where: codes, select: { userId: true, code: true }, take }),
      async (keys) =>
        (
          await db.usedTotpCode.deleteMany({
            where: { AND: [codes, { OR: keys.map(({ userId, code }) => ({ userId, code })) }] },
          })
        ).count,
      (deleted) => {
        system.usedTotpCodes += deleted;
      },
    );

    // O limite por IP guarda a última requisição em milissegundos (Better Auth).
    const limits: Prisma.RateLimitWhereInput = { lastRequest: { lt: BigInt(cutoff.getTime()) } };
    await this.inBatches(
      run,
      async () =>
        (await db.rateLimit.findMany({ where: limits, select: { id: true }, take })).map((row) => row.id),
      async (ids) => (await db.rateLimit.deleteMany({ where: { id: { in: ids }, ...limits } })).count,
      (deleted) => {
        system.rateLimits += deleted;
      },
    );
  }

  /**
   * 6a. Auditoria de cada cliente com o corte mais novo que o global (o prazo dele é menor que o do cliente que segura
   * o global), pela função do banco que apaga só a dele e confere o piso de 13 meses.
   */
  private async purgeTenantAudit(
    perTenant: ReadonlyMap<string, TenantRun>,
    globalCutoff: Date | null,
    run: RunBudget,
  ): Promise<void> {
    for (const [tenantId, { counts, plan }] of perTenant) {
      const cutoff = plan?.cutoffs.audit ?? null;
      if (cutoff === null || (globalCutoff !== null && cutoff.getTime() <= globalCutoff.getTime())) continue;
      for (;;) {
        const pending = await this.prisma.auditLog.findFirst({
          where: { tenantId, occurredAt: { lt: cutoff } },
          select: { id: true },
        });
        if (pending === null || !run.canStartBatch()) break;
        const rows = await this.prisma.$queryRaw<{ deleted: number }[]>`
          SELECT verax_purge_tenant_audit_log(${tenantId}::uuid, ${cutoff}::timestamptz, ${this.batch}::integer)
            AS deleted`;
        const deleted = Number(rows[0]?.deleted ?? 0);
        counts.auditLogs += deleted;
        await run.afterBatch();
        if (deleted === 0) break;
      }
    }
  }

  /**
   * 6b. Auditoria com o corte global (o mais antigo entre os clientes), só pela função controlada do banco, que confere
   * o piso de 13 meses e conta por cliente.
   */
  private async purgeAudit(
    cutoff: Date,
    perTenant: ReadonlyMap<string, TenantRun>,
    system: SystemPurgeCounts,
    run: RunBudget,
  ): Promise<void> {
    for (;;) {
      const pending = await this.prisma.auditLog.findFirst({
        where: { occurredAt: { lt: cutoff } },
        select: { id: true },
      });
      if (pending === null || !run.canStartBatch()) return;
      const rows = await this.prisma.$queryRaw<{ tenantId: string | null; deleted: number }[]>`
        SELECT tenant_id AS "tenantId", deleted
        FROM verax_purge_audit_log(${cutoff}::timestamptz, ${this.batch}::integer)`;
      let deleted = 0;
      for (const row of rows) {
        const count = Number(row.deleted);
        deleted += count;
        const counts = row.tenantId === null ? undefined : perTenant.get(row.tenantId)?.counts;
        if (counts === undefined) system.auditLogs += count;
        else counts.auditLogs += count;
      }
      await run.afterBatch();
      if (deleted === 0) return;
    }
  }

  /**
   * `retention.purge` na trilha de cada cliente (o prazo e os cortes dele) e um global, só com os cortes e as
   * contagens. O cliente da célula ainda sem plano ganha o registro com `planMissing` e sem os cortes do histórico.
   */
  private async writeTrail(
    common: RetentionCutoffs,
    globalAudit: Date | null,
    perTenant: ReadonlyMap<string, TenantRun>,
    system: SystemPurgeCounts,
    complete: boolean,
    failure: unknown,
  ): Promise<void> {
    const iso = (at: Date | null): string | null => (at === null ? null : at.toISOString());
    const outcome = failure === null ? 'success' : 'failure';
    const ending = {
      complete,
      ...(failure !== null && { error: errorKind(failure) }),
    };
    for (const [tenantId, { counts: deleted, plan }] of perTenant) {
      const policy =
        plan === null
          ? { planMissing: true }
          : {
              historyDays: plan.decision.days,
              planHistoryDays: plan.planDays,
              graceUntil: iso(plan.decision.graceUntil),
            };
      await this.audit.write(this.prisma, {
        actor: { type: 'system', tenantId },
        action: 'retention.purge',
        outcome,
        resourceType: 'retention',
        after: {
          ...policy,
          cutoffs: {
            history: iso(plan?.cutoffs.history ?? null),
            inventory: iso(common.inventory),
            notifications: iso(common.notifications),
            audit: iso(plan?.cutoffs.audit ?? null),
          },
          deleted,
          ...ending,
        },
      });
    }
    await this.audit.write(this.prisma, {
      actor: { type: 'system', tenantId: null },
      action: 'retention.purge',
      outcome,
      resourceType: 'retention',
      after: {
        cutoffs: {
          unowned: iso(common.unowned),
          operational: iso(common.operational),
          audit: iso(globalAudit),
        },
        deleted: system,
        ...ending,
      },
    });
  }
}
