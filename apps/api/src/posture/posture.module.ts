import { Module } from '@nestjs/common';
import { PlanModule } from '../plan/plan.module.js';
import { PostureController } from './posture.controller.js';
import { PostureService } from './posture.service.js';

@Module({
  // A evolução da nota segue o histórico do plano.
  imports: [PlanModule],
  controllers: [PostureController],
  providers: [PostureService],
  exports: [PostureService],
})
export class PostureModule {}
