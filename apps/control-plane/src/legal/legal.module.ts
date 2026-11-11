import { Module } from '@nestjs/common';
import { LegalCoreModule } from './legal-core.module.js';
import { LEGAL_RATE_LIMIT_PROVIDER, LegalController } from './legal.controller.js';

/** Os textos legais para o site (só no `cp-public`): `GET /v1/public/legal`, `.../{tipo}` e `.../{tipo}/{versão}`. */
@Module({
  imports: [LegalCoreModule],
  controllers: [LegalController],
  providers: [LEGAL_RATE_LIMIT_PROVIDER],
})
export class LegalModule {}
