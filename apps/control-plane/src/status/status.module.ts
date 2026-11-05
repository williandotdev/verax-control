import { type DynamicModule, Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { TenantsModule } from '../tenants/tenants.module.js';
import { MetadataIdTokenSource } from './id-token.js';
import {
  REVEAL_GATEWAY,
  type RevealGateway,
  UnconfiguredRevealGateway,
  WorkerRevealGateway,
} from './reveal-gateway.js';
import { STATUS_RATE_LIMITS_PROVIDER, StatusController } from './status.controller.js';
import { StatusService } from './status.service.js';

export interface StatusModuleOptions {
  /** Só nos testes: o caminho até a revelação sem HTTP (em produção, o cp-worker em `WORKER_URL`). */
  revealGateway?: RevealGateway;
}

/**
 * Página de status e revelação única, lado público (CP-05). Só o `cp-public` registra este módulo, junto com o
 * `StripeModule` (o `claim` relê a sessão do Checkout e o `status` lê o boleto). A revelação em si roda no cp-worker
 * (`AccessWorkerModule`), chamado em `WORKER_URL` com o token de identidade do cp-public.
 */
@Module({})
export class StatusModule {
  static forRoot(options: StatusModuleOptions = {}): DynamicModule {
    return {
      module: StatusModule,
      imports: [TenantsModule, AccessModule],
      controllers: [StatusController],
      providers: [
        StatusService,
        STATUS_RATE_LIMITS_PROVIDER,
        {
          provide: REVEAL_GATEWAY,
          useFactory: (config: AppConfig, clock: Clock): RevealGateway => {
            if (options.revealGateway !== undefined) return options.revealGateway;
            return config.WORKER_URL === undefined
              ? new UnconfiguredRevealGateway()
              : new WorkerRevealGateway(config.WORKER_URL, new MetadataIdTokenSource(clock));
          },
          inject: [APP_CONFIG, CLOCK],
        },
      ],
    };
  }
}
