import { Module } from '@nestjs/common';
import { PlanModule } from '../plan/plan.module.js';
import { DetectionsController } from './detections.controller.js';
import { DetectionsService } from './detections.service.js';

@Module({
  // O período e o intervalo do filtro não passam do histórico do plano.
  imports: [PlanModule],
  controllers: [DetectionsController],
  providers: [DetectionsService],
})
export class DetectionsModule {}
