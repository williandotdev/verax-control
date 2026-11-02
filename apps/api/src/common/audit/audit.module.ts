import { Global, Module } from '@nestjs/common';
import { AuditContext } from './audit-context.service.js';
import { AuditInterceptor } from './audit.interceptor.js';
import { AuditService } from './audit.service.js';
import { DenialAudit } from './denial-audit.service.js';

@Global()
@Module({
  providers: [AuditService, AuditContext, AuditInterceptor, DenialAudit],
  exports: [AuditService, AuditContext, AuditInterceptor, DenialAudit],
})
export class AuditModule {}
