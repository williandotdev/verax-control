import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import {
  DEFAULT_REPORT_PERIOD,
  REPORT_KINDS,
  type ReportKind,
  type ReportQuery,
  reportQueryWindow,
  reportQuerySchema,
} from '@verax/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators.js';
import { casesVisibleTo } from '../cases/cases-mode.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { PlanService } from '../plan/plan.service.js';
import { ReportsService } from './reports.service.js';

/**
 * Relatórios do cliente da sessão: resumo, MITRE ATT&CK, detecções, entidades, incidentes, cobertura e exceções. A
 * janela é um período (de 24 horas a 12 meses; 30 dias sem nenhum) ou, na tela Detecções, um intervalo personalizado. Os
 * campos dos casos só vêm para quem os pede e pode vê-los.
 */
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly plan: PlanService,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'CASES_MODE'>,
  ) {}

  @Get(':kind')
  @RequirePermission('reports:read')
  async report(
    @Req() request: Request,
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
    const { role } = request.auth as RequestAuth;
    const cases = query.cases === 'true' && casesVisibleTo(this.config.CASES_MODE, role);
    return this.reports.report(kind, reportQueryWindow(query, now), { cases });
  }
}
