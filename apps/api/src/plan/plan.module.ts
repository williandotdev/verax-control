import { Module } from '@nestjs/common';
import { PlanController } from './plan.controller.js';
import { PlanService } from './plan.service.js';

@Module({
  controllers: [PlanController],
  providers: [PlanService],
  // Contas cloud e usuários conferem a vaga do plano antes de criar ou reativar.
  exports: [PlanService],
})
export class PlanModule {}
