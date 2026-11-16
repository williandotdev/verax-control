import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  DEFAULT_REPORT_PERIOD,
  REPORT_KINDS,
  type ReportKind,
  type ReportQuery,
  reportQueryWindow,
  reportQuerySchema,
} from '@verax/shared';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators.js';
import { PlanService } from '../plan/plan.service.js';
import { ReportsService } from './reports.service.js';

/**
 * Relatórios do cliente da sessão: resumo, MITRE ATT&CK, detecções, entidades, incidentes, cobertura e exceções. A
 * janela é um período (de 24 horas a 12 meses; 30 dias sem nenhum) ou, na tela Detecções, um intervalo personalizado.
 */
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
    // Sem intervalo, o período pedido (ou o padrão, 30 dias); com intervalo, o começo dele.
    const now = new Date();
    if (query.from === undefined) {
      await this.plan.assertPeriodWithinHistory(query.period ?? DEFAULT_REPORT_PERIOD);
    } else {
      await this.plan.assertRangeWithinHistory(query.from, now);
    }
    return this.reports.report(kind, reportQueryWindow(query, now));
  }
}
