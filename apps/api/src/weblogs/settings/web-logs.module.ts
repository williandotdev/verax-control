import { Module } from '@nestjs/common';
import { PlanModule } from '../../plan/plan.module.js';
import { WebLogsEnabledGuard } from './web-logs-enabled.guard.js';
import { WebLogsController } from './web-logs.controller.js';
import { WebLogsService } from './web-logs.service.js';

@Module({
  imports: [PlanModule],
  controllers: [WebLogsController],
  providers: [WebLogsService, WebLogsEnabledGuard],
})
export class WebLogsModule {}
