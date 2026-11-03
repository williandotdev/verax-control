import { Controller, Get, Param, Query } from '@nestjs/common';
import { REPORT_KINDS, type ReportKind, type ReportQuery, reportQuerySchema } from '@verax/shared';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators.js';
import { ReportsService } from './reports.service.js';

/** Relatórios do cliente da sessão: resumo, MITRE ATT&CK, detecções, entidades, incidentes, cobertura e exceções. */
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get(':kind')
  @RequirePermission('reports:read')
  report(
    @Param('kind', { schema: z.enum(REPORT_KINDS) }) kind: ReportKind,
    @Query({ schema: reportQuerySchema }) query: ReportQuery,
  ): Promise<unknown> {
    return this.reports.report(kind, query.period);
  }
}
