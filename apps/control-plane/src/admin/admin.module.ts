import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditModule } from '../audit/audit.module.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { TokenBucketLimiter } from '../common/http/rate-limiter.js';
import { LegalCoreModule } from '../legal/legal-core.module.js';
import { PricingCoreModule } from '../pricing/pricing-core.module.js';
import { ProvisioningStore } from '../provisioning/provisioning-store.js';
import { TenantsModule } from '../tenants/tenants.module.js';
import { AdminLegalController } from './admin-legal.controller.js';
import { AdminLegalService } from './admin-legal.service.js';
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
import {
  ACCOUNT_PER_IP,
  ADMIN_AUTH_LIMITS,
  AdminAuthController,
  type AdminAuthLimits,
  LOGIN_GLOBAL,
  LOGIN_PER_IP,
  SETUP_PER_IP,
} from './auth/admin-auth.controller.js';
import { AdminAuthService } from './auth/admin-auth.service.js';
import { ADMIN_SECRETS, type AdminSecretSource, SecretManagerAdminSecrets } from './auth/admin-secrets.js';
import { GoogleAuthIdTokenSource } from './google-id-token.js';
import { OwnerGuard } from './owner.guard.js';
import { HttpWorkerOwnerClient, type WorkerOwnerClient } from './worker-owner-client.js';

export interface AdminModuleOptions {
  /**
   * Só nos testes: os cofres do login do console em memória (a chave mestra e o token do primeiro cadastro). Em
   * produção, o Secret Manager do projeto `ADMIN_SECRETS_PROJECT_ID`, pela API, com a identidade do cp-admin.
   */
  adminSecrets?: AdminSecretSource;
  /**
   * Só nos testes: o cliente das operações do responsável no cp-worker (o `HttpWorkerOwnerClient` com um "Google" de
   * teste e o worker local, ou um dublê). Em produção, o `HttpWorkerOwnerClient` com o token da conta do cp-admin pelo
   * `google-auth-library` (`google-id-token.ts`); sem `WORKER_URL`, nenhum (as operações respondem 503).
   */
  workerOwnerClient?: WorkerOwnerClient;
}

/**
 * O console do responsável (`cp-admin`, `ROLE=admin`): as rotas `/v1/admin/...`, o login próprio (e-mail, senha e
 * TOTP, `auth/`) e a guarda global que exige a sessão dele em toda requisição. Só este papel carrega o módulo; no
 * `cp-public` e no `cp-worker` as rotas nem existem. Os clientes (lista, detalhe, contrato direto) e os textos legais
 * (Termos, Privacidade e DPA) leem e gravam o Firestore; as operações do provisionamento vão ao cp-worker
 * pelo `CONSOLE_WORKER_CLIENT` (`worker-owner-client.ts`), com o token da conta do cp-admin.
 */
@Module({})
export class AdminModule {
  static forRoot(options: AdminModuleOptions = {}): DynamicModule {
    return {
      module: AdminModule,
      imports: [AuditModule, LegalCoreModule, PricingCoreModule, TenantsModule],
      controllers: [
        AdminAuthController,
        AdminLegalController,
        AdminPricingController,
        AdminSessionController,
        AdminTenantsController,
      ],
      providers: [
        AdminAuthService,
        AdminLegalService,
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
          provide: ADMIN_SECRETS,
          useFactory: (config: AppConfig): AdminSecretSource => {
            if (options.adminSecrets !== undefined) return options.adminSecrets;
            // O schema da configuração já exige as duas com ROLE=admin; aqui é só a garantia de tipo.
            if (config.ADMIN_SECRETS_PROJECT_ID === undefined || config.OWNER_PRINCIPALS === undefined) {
              throw new Error('ADMIN_SECRETS_PROJECT_ID e OWNER_PRINCIPALS são obrigatórias com ROLE=admin');
            }
            return new SecretManagerAdminSecrets(config.ADMIN_SECRETS_PROJECT_ID);
          },
          inject: [APP_CONFIG],
        },
        {
          provide: ADMIN_AUTH_LIMITS,
          useFactory: (clock: Clock): AdminAuthLimits => ({
            login: new TokenBucketLimiter(LOGIN_PER_IP, clock),
            loginGlobal: new TokenBucketLimiter(LOGIN_GLOBAL, clock),
            setup: new TokenBucketLimiter(SETUP_PER_IP, clock),
            account: new TokenBucketLimiter(ACCOUNT_PER_IP, clock),
          }),
          inject: [CLOCK],
        },
        { provide: APP_GUARD, useClass: OwnerGuard },
      ],
    };
  }
}
