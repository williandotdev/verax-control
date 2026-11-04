import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { TenantStore } from './tenant-store.js';

@Module({
  imports: [AuditModule],
  providers: [TenantStore],
  exports: [TenantStore],
})
export class TenantsModule {}
