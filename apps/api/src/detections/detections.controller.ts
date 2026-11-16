import { Controller, Get, Query } from '@nestjs/common';
import {
  type DetectionListQuery,
  detectionListQuerySchema,
  type DetectionRow,
  type Paginated,
} from '@verax/shared';
import { RequirePermission } from '../auth/decorators.js';
import { PlanService } from '../plan/plan.service.js';
import { DetectionsService } from './detections.service.js';

/**
 * Tela Detecções, visão agrupada, do cliente da sessão: incidentes e achados avulsos numa lista só. Mostra os dois,
 * então exige as duas leituras (hoje, todos os papéis têm as duas). O período e o intervalo não passam do histórico do
 * plano.
 */
@Controller('detections')
export class DetectionsController {
  constructor(
    private readonly detections: DetectionsService,
    private readonly plan: PlanService,
  ) {}

  @Get()
  @RequirePermission('incidents:read', 'findings:read')
  async list(
    @Query({ schema: detectionListQuerySchema }) query: DetectionListQuery,
  ): Promise<Paginated<DetectionRow>> {
    await this.plan.assertPeriodWithinHistory(query.period);
    await this.plan.assertRangeWithinHistory(query.from);
    return this.detections.list(query);
  }
}
