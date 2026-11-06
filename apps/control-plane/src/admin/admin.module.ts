import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditModule } from '../audit/audit.module.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { TokenBucketLimiter } from '../common/http/rate-limiter.js';
import { PricingCoreModule } from '../pricing/pricing-core.module.js';
import { ProvisioningStore } from '../provisioning/provisioning-store.js';
import { TenantsModule } from '../tenants/tenants.module.js';
import { AdminPricingController } from './admin-pricing.controller.js';
import { AdminPricingService } from './admin-pricing.service.js';
import { AdminSessionController } from './admin-session.controller.js';
import { AdminTenantsController } from './admin-tenants.controller.js';
import {
  ADMIN_TENANT_LIMITS,
  type AdminTenantLimits,
  AdminTenantsService,
  CONSOLE_WORKER_CLIENT,
  DIRECT_TENANT_CREATIONS,
  TENANT_OPERATIONS,
} from './admin-tenants.service.js';
import { GoogleAuthIdTokenSource } from './google-id-token.js';
import {
  GoogleIapKeySource,
  IAP_KEY_SOURCE,
  IAP_VERIFIER,
  IapJwtVerifier,
  type IapKeySource,
} from './iap-verifier.js';
import { OwnerGuard } from './owner.guard.js';
import { HttpWorkerOwnerClient, type WorkerOwnerClient } from './worker-owner-client.js';

export interface AdminModuleOptions {
  /** Só nos testes: as chaves públicas do "IAP" (uma chave ES256 gerada no teste). Em produção, as do Google. */
  iapKeySource?: IapKeySource;
  /**
   * Só nos testes: o cliente das operações do responsável no cp-worker (o `HttpWorkerOwnerClient` com um "Google" de
   * teste e o worker local, ou um dublê). Em produção, o `HttpWorkerOwnerClient` com o token da conta do cp-admin pelo
   * `google-auth-library` (`google-id-token.ts`); sem `WORKER_URL`, nenhum (as operações respondem 503).
   */
  workerOwnerClient?: WorkerOwnerClient;
}

/**
 * O console do responsável (`cp-admin`, `ROLE=admin`): as rotas `/v1/admin/...` e a guarda global que confere o JWT
 * do IAP em toda requisição. Só este papel carrega o módulo; no `cp-public` e no `cp-worker` as rotas nem existem. Os
 * clientes (lista, detalhe, contrato direto) leem e gravam o Firestore; as operações do provisionamento vão ao cp-worker
 * pelo `CONSOLE_WORKER_CLIENT` (`worker-owner-client.ts`), com o token da conta do cp-admin.
 */
@Module({})
export class AdminModule {
  static forRoot(options: AdminModuleOptions = {}): DynamicModule {
    return {
      module: AdminModule,
      imports: [AuditModule, PricingCoreModule, TenantsModule],
      controllers: [AdminPricingController, AdminSessionController, AdminTenantsController],
      providers: [
        AdminPricingService,
        AdminTenantsService,
        ProvisioningStore,
        {
          provide: CONSOLE_WORKER_CLIENT,
          useFactory: (config: AppConfig): WorkerOwnerClient | null =>
            options.workerOwnerClient ??
            (config.WORKER_URL === undefined
              ? null
              : new HttpWorkerOwnerClient(config.WORKER_URL, new GoogleAuthIdTokenSource())),
          inject: [APP_CONFIG],
        },
        {
          provide: ADMIN_TENANT_LIMITS,
          useFactory: (clock: Clock): AdminTenantLimits => ({
            creations: new TokenBucketLimiter(DIRECT_TENANT_CREATIONS, clock),
            operations: new TokenBucketLimiter(TENANT_OPERATIONS, clock),
          }),
          inject: [CLOCK],
        },
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
