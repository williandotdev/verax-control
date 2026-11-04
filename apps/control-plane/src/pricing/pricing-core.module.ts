import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CostModelStore, PricingTableStore } from './pricing-store.js';
import { QuoteStore } from './quote-store.js';

/**
 * Os repositórios do preço configurável (tabelas de preços, modelos de custo e cotações), comuns ao `cp-public` (site e
 * checkout) e ao `cp-admin` (console do responsável). Não registra rota nenhuma.
 */
@Module({
  imports: [AuditModule],
  providers: [PricingTableStore, CostModelStore, QuoteStore],
  exports: [PricingTableStore, CostModelStore, QuoteStore],
})
export class PricingCoreModule {}
