import { Module } from '@nestjs/common';
import { PlanModule } from '../plan/plan.module.js';
import { ReportsController } from './reports.controller.js';
import { DEFAULT_REPORT_BATCH_SIZE, REPORT_BATCH_SIZE, ReportsService } from './reports.service.js';

@Module({
  // O período do relatório não passa do histórico do plano.
  imports: [PlanModule],
  controllers: [ReportsController],
  providers: [ReportsService, { provide: REPORT_BATCH_SIZE, useValue: DEFAULT_REPORT_BATCH_SIZE }],
  exports: [ReportsService],
})
export class ReportsModule {}
