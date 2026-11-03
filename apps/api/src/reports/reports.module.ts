import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller.js';
import { DEFAULT_REPORT_BATCH_SIZE, REPORT_BATCH_SIZE, ReportsService } from './reports.service.js';

@Module({
  controllers: [ReportsController],
  providers: [ReportsService, { provide: REPORT_BATCH_SIZE, useValue: DEFAULT_REPORT_BATCH_SIZE }],
  exports: [ReportsService],
})
export class ReportsModule {}
