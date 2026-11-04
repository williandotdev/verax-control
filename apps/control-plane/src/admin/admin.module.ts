import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditModule } from '../audit/audit.module.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { PricingCoreModule } from '../pricing/pricing-core.module.js';
import { AdminPricingController } from './admin-pricing.controller.js';
import { AdminPricingService } from './admin-pricing.service.js';
import {
  GoogleIapKeySource,
  IAP_KEY_SOURCE,
  IAP_VERIFIER,
  IapJwtVerifier,
  type IapKeySource,
} from './iap-verifier.js';
import { OwnerGuard } from './owner.guard.js';

export interface AdminModuleOptions {
  /** Só nos testes: as chaves públicas do "IAP" (uma chave ES256 gerada no teste). Em produção, as do Google. */
  iapKeySource?: IapKeySource;
}

/**
 * O console do responsável (`cp-admin`, `ROLE=admin`): as rotas `/v1/admin/...` e a guarda global que confere o JWT
 * do IAP em toda requisição. Só este papel carrega o módulo; no `cp-public` e no `cp-worker` as rotas nem existem.
 */
@Module({})
export class AdminModule {
  static forRoot(options: AdminModuleOptions = {}): DynamicModule {
    return {
      module: AdminModule,
      imports: [AuditModule, PricingCoreModule],
      controllers: [AdminPricingController],
      providers: [
        AdminPricingService,
        {
          provide: IAP_KEY_SOURCE,
          useFactory: (clock: Clock) => options.iapKeySource ?? new GoogleIapKeySource(clock),
          inject: [CLOCK],
        },
        {
          provide: IAP_VERIFIER,
          useFactory: (config: AppConfig, keys: IapKeySource) => {
            // O schema da configuração já exige as duas com ROLE=admin; aqui é só a garantia de tipo.
            if (config.IAP_AUDIENCE === undefined || config.OWNER_PRINCIPALS === undefined) {
              throw new Error('IAP_AUDIENCE e OWNER_PRINCIPALS são obrigatórias com ROLE=admin');
            }
            return new IapJwtVerifier(keys, config.IAP_AUDIENCE, config.OWNER_PRINCIPALS);
          },
          inject: [APP_CONFIG, IAP_KEY_SOURCE],
        },
        { provide: APP_GUARD, useClass: OwnerGuard },
      ],
    };
  }
}
