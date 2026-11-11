import { Controller, Get, Param, Query } from '@nestjs/common';
import { REPORT_KINDS, type ReportKind, type ReportQuery, reportQuerySchema } from '@verax/shared';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators.js';
import { PlanService } from '../plan/plan.service.js';
import { ReportsService } from './reports.service.js';

/** Relatórios do cliente da sessão: resumo, MITRE ATT&CK, detecções, entidades, incidentes, cobertura e exceções. */
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly plan: PlanService,
  ) {}

  @Get(':kind')
  @RequirePermission('reports:read')
  async report(
    @Param('kind', { schema: z.enum(REPORT_KINDS) }) kind: ReportKind,
    @Query({ schema: reportQuerySchema }) query: ReportQuery,
  ): Promise<unknown> {
    await this.plan.assertPeriodWithinHistory(query.period);
    return this.reports.report(kind, query.period);
  }
}
