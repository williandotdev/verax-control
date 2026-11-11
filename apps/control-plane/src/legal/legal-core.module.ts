import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { LegalTextStore } from './legal-store.js';

/**
 * O repositório dos textos legais, comum ao `cp-public` (site e checkout) e ao `cp-admin` (console do responsável). Não
 * registra rota nenhuma.
 */
@Module({
  imports: [AuditModule],
  providers: [LegalTextStore],
  exports: [LegalTextStore],
})
export class LegalCoreModule {}
