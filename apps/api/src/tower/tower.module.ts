import { Module } from '@nestjs/common';
import { PostureModule } from '../posture/posture.module.js';
import { ReportsModule } from '../reports/reports.module.js';
import { TowerController } from './tower.controller.js';
import { TowerService } from './tower.service.js';

@Module({
  imports: [PostureModule, ReportsModule],
  controllers: [TowerController],
  providers: [TowerService],
})
export class TowerModule {}
