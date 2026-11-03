import { Module } from '@nestjs/common';
import { AuditTrailController } from './audit-trail.controller.js';
import { AuditTrailService } from './audit-trail.service.js';

@Module({
  controllers: [AuditTrailController],
  providers: [AuditTrailService],
})
export class AuditTrailModule {}
