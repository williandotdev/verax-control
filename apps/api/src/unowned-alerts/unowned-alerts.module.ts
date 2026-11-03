import { Module } from '@nestjs/common';
import { UnownedAlertsController } from './unowned-alerts.controller.js';
import { UnownedAlertsService } from './unowned-alerts.service.js';

@Module({
  controllers: [UnownedAlertsController],
  providers: [UnownedAlertsService],
})
export class UnownedAlertsModule {}
