import { Inject, Injectable } from '@nestjs/common';
import type { PlanSeat, PlanUsage, ResolvedPlan } from '@verax/shared';
import { AuditContext } from '../common/audit/audit-context.service.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { nodePlan } from '../common/config/env.schema.js';
import { requestContext } from '../common/context/request-context.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { usageMonth } from '../usage/usage-meter.js';
import { assertWithinPlan, countSeats, lockPlanSeats, PlanLimitReached } from './plan-limits.js';

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
 * Plano do nó (fase 2, PR-18). O plano vem do ambiente (`PLAN` e os ajustes `PLAN_*`, escritos pelo `start.sh` a partir
 * do `node.conf`), lido uma vez na partida: trocar de plano é trocar o `node.conf` e reiniciar. O uso é sempre o do
 * cliente da sessão.
 */
@Injectable()
export class PlanService {
  readonly plan: ResolvedPlan;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditContext,
    @Inject(APP_CONFIG)
    config: Pick<
      AppConfig,
      'PLAN' | 'PLAN_MAX_CLOUD_ACCOUNTS' | 'PLAN_MAX_USERS' | 'PLAN_MONTHLY_GIB' | 'PLAN_HISTORY_DAYS'
    >,
  ) {
    this.plan = nodePlan(config);
  }

  /**
   * Trava as vagas do cliente na transação da requisição de escrita (`lockPlanSeats`), antes de ler o status do
   * recurso: toda escrita que pode ativar ou desativar uma conta ou um usuário chama isto primeiro, e a leitura que vem
   * depois já enxerga a mudança de vaga que outra requisição confirmou.
   */
  async lockSeats(seat: PlanSeat, tenantId: string): Promise<void> {
    await lockPlanSeats(this.writeTransaction(), this.plan, seat, tenantId);
  }

  /**
   * Confere a vaga do cliente na transação da requisição de escrita (`assertWithinPlan`). Na recusa, a tentativa entra
   * na trilha do cliente com a ação e a área de sempre (`cloud_account.create`, `user.update`...), e o
   * `AuditInterceptor` a grava como falha 409, com a alteração desfeita.
   */
  async assertWithinPlan(seat: PlanSeat, tenantId: string, attempt: PlanAttempt): Promise<void> {
    const tx = this.writeTransaction();
    try {
      await assertWithinPlan(tx, this.plan, seat, tenantId);
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
   * Plano e uso do cliente da sessão: as contas cloud ativas, os usuários convidados ou ativos e o volume lido no mês
   * corrente do calendário de Brasília, somadas as fontes do medidor. Nada de outro cliente entra: tudo pelo escopo.
   */
  async usage(now: Date = new Date()): Promise<PlanUsage> {
    const db = this.prisma.scoped();
    const month = usageMonth(now);
    const [cloudAccounts, users, volume] = await Promise.all([
      countSeats(db, 'cloudAccounts'),
      countSeats(db, 'users'),
      db.ingestUsage.aggregate({ where: { month }, _sum: { bytes: true } }),
    ]);
    const bytes = volume._sum.bytes ?? 0n;
    return {
      plan: this.plan,
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
