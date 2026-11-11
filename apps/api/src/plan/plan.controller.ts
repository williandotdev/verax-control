import { Controller, Get } from '@nestjs/common';
import type { PlanHistory, PlanUsage } from '@verax/shared';
import { RequirePermission } from '../auth/decorators.js';
import { PlanService } from './plan.service.js';

/**
 * "Plano e uso" (fase 2, PR-18): o plano e o uso do cliente da sessão (o plano é de cada cliente desde o CE-02). Só
 * leitura, para quem administra. O histórico do plano (PR-20) é de todos os papéis: os filtros de período de achados e
 * relatórios dependem dele.
 */
@Controller('plan')
export class PlanController {
  constructor(private readonly plan: PlanService) {}

  @Get()
  @RequirePermission('plan:read')
  summary(): Promise<PlanUsage> {
    return this.plan.usage();
  }

  @Get('history')
  @RequirePermission('plan_history:read')
  history(): Promise<PlanHistory> {
    return this.plan.history();
  }
}
