import { Module } from '@nestjs/common';
import { PricingCoreModule } from './pricing-core.module.js';
import { PRICING_RATE_LIMITS_PROVIDER, PricingController } from './pricing.controller.js';
import { PublicPricingService } from './pricing.service.js';

/** A calculadora pública (só no `cp-public`): `GET /v1/public/pricing` e `POST /v1/public/quote`. */
@Module({
  imports: [PricingCoreModule],
  controllers: [PricingController],
  providers: [PublicPricingService, PRICING_RATE_LIMITS_PROVIDER],
})
export class PricingModule {}
