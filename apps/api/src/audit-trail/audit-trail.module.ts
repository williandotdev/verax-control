import { Module } from '@nestjs/common';
import { PlanModule } from '../plan/plan.module.js';
import { AuditTrailController } from './audit-trail.controller.js';
import { AuditTrailService } from './audit-trail.service.js';

@Module({
  // O período do filtro não passa do histórico do plano.
  imports: [PlanModule],
  controllers: [AuditTrailController],
  providers: [AuditTrailService],
})
export class AuditTrailModule {}
