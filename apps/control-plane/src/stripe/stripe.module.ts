import { type DynamicModule, Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { createStripeClient, STRIPE_CLIENT, type StripeApiOptions } from './stripe-client.js';

export interface StripeModuleOptions {
  /** Só nos testes: a API da Stripe num servidor falso em 127.0.0.1. */
  stripeApi?: StripeApiOptions;
}

/**
 * O cliente da Stripe do cp-public, um só para o checkout (CP-03) e o webhook (CP-04). Sem a chave, o provedor é
 * `null`: o checkout e o webhook respondem 503, e o resto do serviço sobe.
 */
@Global()
@Module({})
export class StripeModule {
  static forRoot(options: StripeModuleOptions = {}): DynamicModule {
    return {
      module: StripeModule,
      providers: [
        {
          provide: STRIPE_CLIENT,
          useFactory: (config: AppConfig) =>
            config.STRIPE_SECRET_KEY === undefined
              ? null
              : createStripeClient(config.STRIPE_SECRET_KEY, options.stripeApi),
          inject: [APP_CONFIG],
        },
      ],
      exports: [STRIPE_CLIENT],
    };
  }
}
