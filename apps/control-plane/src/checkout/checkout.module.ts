import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { CHECKOUT_SETTINGS, resolveCheckoutSettings } from './checkout-settings.js';
import { CheckoutStore } from './checkout-store.js';
import { CHECKOUT_RATE_LIMITS_PROVIDER, CheckoutController } from './checkout.controller.js';
import { CheckoutService } from './checkout.service.js';

/**
 * Reserva de subdomínio e sessão do Checkout (CP-03). Só o `cp-public` registra este módulo (`app.module.ts`), junto
 * com o `StripeModule`, que dá o cliente da Stripe. Sem a chave da Stripe, o checkout responde 503; a consulta de
 * subdomínio funciona. O `CheckoutStore` é exportado para o webhook (CP-04) liberar a reserva de uma sessão vencida.
 */
@Module({
  imports: [AuditModule],
  controllers: [CheckoutController],
  providers: [
    CheckoutStore,
    CheckoutService,
    CHECKOUT_RATE_LIMITS_PROVIDER,
    {
      provide: CHECKOUT_SETTINGS,
      useFactory: (config: AppConfig) => resolveCheckoutSettings(config),
      inject: [APP_CONFIG],
    },
  ],
  exports: [CheckoutStore],
})
export class CheckoutModule {}
