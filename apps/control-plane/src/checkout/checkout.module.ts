import { type DynamicModule, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { STRIPE_CLIENT, type StripeApiOptions, createStripeClient } from '../stripe/stripe-client.js';
import { CHECKOUT_SETTINGS, resolveCheckoutSettings } from './checkout-settings.js';
import { CheckoutStore } from './checkout-store.js';
import { CHECKOUT_RATE_LIMITS_PROVIDER, CheckoutController } from './checkout.controller.js';
import { CheckoutService } from './checkout.service.js';

export interface CheckoutModuleOptions {
  /** Só nos testes: a API da Stripe num servidor falso em 127.0.0.1. */
  stripeApi?: StripeApiOptions;
}

/**
 * Reserva de subdomínio e sessão do Checkout (CP-03). Só o `cp-public` registra este módulo (`app.module.ts`). Sem a
 * chave da Stripe, o cliente da Stripe não é criado e o checkout responde 503; a consulta de subdomínio funciona.
 */
@Module({})
export class CheckoutModule {
  static register(options: CheckoutModuleOptions = {}): DynamicModule {
    return {
      module: CheckoutModule,
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
        {
          provide: STRIPE_CLIENT,
          useFactory: (config: AppConfig) =>
            config.STRIPE_SECRET_KEY === undefined
              ? null
              : createStripeClient(config.STRIPE_SECRET_KEY, options.stripeApi),
          inject: [APP_CONFIG],
        },
      ],
    };
  }
}
