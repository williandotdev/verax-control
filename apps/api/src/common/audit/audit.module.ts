import { Global, Module } from '@nestjs/common';
import { AuditContext } from './audit-context.service.js';
import { AuditInterceptor } from './audit.interceptor.js';
import { AuditService } from './audit.service.js';

@Global()
@Module({
  providers: [AuditService, AuditContext, AuditInterceptor],
  exports: [AuditService, AuditContext, AuditInterceptor],
})
export class AuditModule {}
