import { Controller, Get } from '@nestjs/common';
import type { PlanUsage } from '@verax/shared';
import { RequirePermission } from '../auth/decorators.js';
import { PlanService } from './plan.service.js';

/** "Plano e uso" (fase 2, PR-18): o plano do nó e o uso do cliente da sessão. Só leitura, para quem administra. */
@Controller('plan')
export class PlanController {
  constructor(private readonly plan: PlanService) {}

  @Get()
  @RequirePermission('plan:read')
  summary(): Promise<PlanUsage> {
    return this.plan.usage();
  }
}
