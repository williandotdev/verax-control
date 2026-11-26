import { Module } from '@nestjs/common';
import { PlanModule } from '../../plan/plan.module.js';
import { WebTrafficController } from '../map/web-traffic.controller.js';
import { WebTrafficService } from '../map/web-traffic.service.js';
import { WebAlbLoggingService } from './web-alb-logging.service.js';
import { WebLogsEnabledGuard } from './web-logs-enabled.guard.js';
import { WebLogsController } from './web-logs.controller.js';
import { WebLogsService } from './web-logs.service.js';

@Module({
  imports: [PlanModule],
  controllers: [WebLogsController, WebTrafficController],
  providers: [WebLogsService, WebAlbLoggingService, WebTrafficService, WebLogsEnabledGuard],
})
export class WebLogsModule {}
