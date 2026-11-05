import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AccessStore } from './access-store.js';

/** O repositório do acesso do cliente (`statusTokens` e `tenants.access`), usado pelos dois papéis. */
@Module({
  imports: [AuditModule],
  providers: [AccessStore],
  exports: [AccessStore],
})
export class AccessModule {}
