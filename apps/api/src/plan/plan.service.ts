import { Inject, Injectable } from '@nestjs/common';
import {
  type HistoryPeriod,
  PLAN_LIMIT_BOUNDS,
  type PlanHistory,
  type PlanSeat,
  type PlanUsage,
  type ResolvedPlan,
} from '@verax/shared';
import { AuditContext } from '../common/audit/audit-context.service.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { nodePlan } from '../common/config/env.schema.js';
import { requestContext } from '../common/context/request-context.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { usageMonth } from '../usage/usage-meter.js';
import { assertPeriodWithinHistoryDays } from './plan-history.js';
import { assertWithinPlan, countSeats, lockPlanSeats, lockSeatRow, PlanLimitReached } from './plan-limits.js';
import { TenantPlanMissing, TenantPlanResolver } from './tenant-plan.js';

/** Recurso da trilha de auditoria de cada vaga, para a recusa sair com a mesma área das outras operações. */
const SEAT_RESOURCE: Readonly<Record<PlanSeat, string>> = {
  cloudAccounts: 'cloud_account',
  users: 'user',
};

/** O que a recusa registra na trilha: a ação que foi tentada e, na reativação, o recurso. */
export interface PlanAttempt {
  action: string;
  resourceId?: string;
}

/**
 * Plano de cada cliente (fase 2, PR-18; por cliente desde o CE-02). O plano vem do `TenantPlanResolver`: no nó
 * dedicado, o do ambiente (`PLAN` e os ajustes `PLAN_*`, escritos pelo `start.sh` a partir do `node.conf`, lidos uma vez
 * na partida), que semeia o `TenantPlan` do cliente; na célula, o `TenantPlan` que o plano de controle gravou. O plano e
 * o uso são sempre os do cliente da sessão, ou os do cliente da vaga conferida.
 */
@Injectable()
export class PlanService {
  /** O plano do ambiente: o de todo cliente no nó dedicado; na célula, não vale (`NODE_MODE=cell` recusa o `PLAN`). */
  readonly envPlan: ResolvedPlan;
  readonly plans: TenantPlanResolver;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditContext,
    @Inject(APP_CONFIG)
    config: Pick<
      AppConfig,
      | 'NODE_MODE'
      | 'PLAN'
      | 'PLAN_MAX_CLOUD_ACCOUNTS'
      | 'PLAN_MAX_USERS'
      | 'PLAN_MONTHLY_GIB'
      | 'PLAN_HISTORY_DAYS'
    >,
  ) {
    this.envPlan = nodePlan(config);
    this.plans = new TenantPlanResolver(prisma, config.NODE_MODE, this.envPlan);
  }

  /**
   * O plano de um cliente, na transação da requisição quando houver. Na célula, o cliente ainda sem plano é recusado
   * (409 `TENANT_PLAN_MISSING`): nenhuma vaga é dada e nenhum uso é mostrado sem o que foi contratado.
   */
  async planOf(tenantId: string): Promise<ResolvedPlan> {
    const plan = await this.plans.planOf(tenantId, this.prisma.db());
    if (plan === null) throw new TenantPlanMissing();
    return plan;
  }

  /**
   * Dias de histórico do cliente da sessão (`null` é sem limite): o alcance dos filtros de período e da evolução da
   * postura. Sem cliente na sessão (a equipe da Verax sem escolher), o do nó (`historyDaysWithoutTenant`). Na célula, o
   * cliente ainda sem plano fica com o piso dos planos (30 dias): a tela nunca promete mais do que o banco guarda.
   */
  async historyDays(): Promise<number | null> {
    const tenantId = requestContext.getStore()?.auth?.scopeTenantId ?? null;
    if (tenantId === null) return this.plans.historyDaysWithoutTenant();
    const plan = await this.plans.planOf(tenantId, this.prisma.db());
    return plan === null ? PLAN_LIMIT_BOUNDS.historyDays.min : plan.limits.historyDays;
  }

  /** `GET /v1/plan/history`: só o histórico do plano do cliente da sessão (nenhum outro dado de cliente). */
  async history(): Promise<PlanHistory> {
    return { historyDays: await this.historyDays() };
  }

  /** Recusa (400) o período do filtro mais longo que o histórico do plano do cliente (achados, auditoria e relatórios). */
  async assertPeriodWithinHistory(period: HistoryPeriod | undefined): Promise<void> {
    if (period === undefined) return;
    assertPeriodWithinHistoryDays(await this.historyDays(), period);
  }

  /**
   * Trava as vagas do cliente na transação da requisição de escrita (`lockPlanSeats`), antes de ler o status do
   * recurso: toda escrita que pode ativar ou desativar uma conta ou um usuário chama isto primeiro, e a leitura que vem
   * depois já enxerga a mudança de vaga que outra requisição confirmou. Na célula, o cliente ainda sem plano trava do
   * mesmo jeito (a desativação passa; a criação é recusada em `assertWithinPlan`).
   */
  async lockSeats(seat: PlanSeat, tenantId: string): Promise<void> {
    const tx = this.writeTransaction();
    const plan = await this.plans.planOf(tenantId, tx);
    if (plan === null) await lockSeatRow(tx, seat, tenantId);
    else await lockPlanSeats(tx, plan, seat, tenantId);
  }

  /**
   * Confere a vaga do cliente na transação da requisição de escrita (`assertWithinPlan`), contra o plano dele. Na
   * recusa, a tentativa entra na trilha do cliente com a ação e a área de sempre (`cloud_account.create`,
   * `user.update`...), e o `AuditInterceptor` a grava como falha 409, com a alteração desfeita.
   */
  async assertWithinPlan(seat: PlanSeat, tenantId: string, attempt: PlanAttempt): Promise<void> {
    const tx = this.writeTransaction();
    const plan = await this.planOf(tenantId);
    try {
      await assertWithinPlan(tx, plan, seat, tenantId);
    } catch (error) {
      if (error instanceof PlanLimitReached) {
        this.audit.describe({ ...attempt, resourceType: SEAT_RESOURCE[seat], tenantId });
      }
      throw error;
    }
  }

  /** A transação da requisição de escrita: fora dela, o lock do plano não valeria até a gravação. */
  private writeTransaction() {
    const tx = requestContext.getStore()?.tx;
    if (!tx) throw new Error('a vaga do plano só é conferida numa requisição de escrita');
    return tx;
  }

  /**
   * Plano e uso do cliente da sessão: o plano dele, as contas cloud ativas, os usuários convidados ou ativos e o volume
   * lido no mês corrente do calendário de Brasília, somadas as fontes do medidor. Nada de outro cliente entra: tudo
   * pelo escopo.
   */
  async usage(now: Date = new Date()): Promise<PlanUsage> {
    // O escopo primeiro: sem cliente na sessão, 409 `TENANT_REQUIRED`, como antes.
    const db = this.prisma.scoped();
    const plan = await this.planOf(requestContext.getStore()?.auth?.scopeTenantId as string);
    const month = usageMonth(now);
    const [cloudAccounts, users, volume] = await Promise.all([
      countSeats(db, 'cloudAccounts'),
      countSeats(db, 'users'),
      db.ingestUsage.aggregate({ where: { month }, _sum: { bytes: true } }),
    ]);
    const bytes = volume._sum.bytes ?? 0n;
    return {
      plan,
      usage: {
        cloudAccounts,
        users,
        month: month.toISOString().slice(0, 7),
        // Muito acima de qualquer plano (8 PiB), mas o contrato é um inteiro seguro do JSON.
        monthlyBytes: Number(
          bytes > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : bytes,
        ),
      },
    };
  }
}
