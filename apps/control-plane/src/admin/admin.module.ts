import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditModule } from '../audit/audit.module.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { TokenBucketLimiter } from '../common/http/rate-limiter.js';
import { LegalCoreModule } from '../legal/legal-core.module.js';
import { PricingCoreModule } from '../pricing/pricing-core.module.js';
import { FleetStore } from '../fleet/fleet-store.js';
import { ProvisioningStore } from '../provisioning/provisioning-store.js';
import { TenantsModule } from '../tenants/tenants.module.js';
import { AdminFleetController } from './admin-fleet.controller.js';
import { AdminFleetService } from './admin-fleet.service.js';
import { AdminLegalController } from './admin-legal.controller.js';
import { AdminLogSourcesController } from './admin-log-sources.controller.js';
import { AdminLogSourcesService } from './admin-log-sources.service.js';
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
} from './auth/admin-auth.controller.js';
import { AdminAuthService } from './auth/admin-auth.service.js';
import { ADMIN_SECRETS, type AdminSecretSource, SecretManagerAdminSecrets } from './auth/admin-secrets.js';
import { ADMIN_TURNSTILE_FETCH, AdminTurnstile, type TurnstileFetch } from './auth/turnstile.js';
import { AwsReaderTemplateController } from './aws-reader-template.js';
import { GoogleAuthIdTokenSource } from './google-id-token.js';
import { OwnerGuard } from './owner.guard.js';
import { SSO_GLOBAL, SSO_LIMITS, SSO_PER_IP, SsoController, type SsoLimits } from './sso/sso.controller.js';
import { SsoService } from './sso/sso.service.js';
import {
  CONSOLE_FLEET_CLIENT,
  HttpWorkerFleetClient,
  type WorkerFleetClient,
} from './worker-fleet-client.js';
import { HttpWorkerOwnerClient, type WorkerOwnerClient } from './worker-owner-client.js';

export interface AdminModuleOptions {
  /**
   * Só nos testes: o cofre do login do console em memória (a chave mestra). Em produção, o Secret Manager do projeto
   * `ADMIN_SECRETS_PROJECT_ID`, pela API, com a identidade do cp-admin.
   */
  adminSecrets?: AdminSecretSource;
  /**
   * Só nos testes: o cliente das operações do responsável no cp-worker (o `HttpWorkerOwnerClient` com um "Google" de
   * teste e o worker local, ou um dublê). Em produção, o `HttpWorkerOwnerClient` com o token da conta do cp-admin pelo
   * `google-auth-library` (`google-id-token.ts`); sem `WORKER_URL`, nenhum (as operações respondem 503).
   */
  workerOwnerClient?: WorkerOwnerClient;
  /** Só nos testes: o cliente da frota no cp-worker (em produção, o HTTP com o token da conta do cp-admin). */
  workerFleetClient?: WorkerFleetClient;
  /** Só nos testes: o siteverify do Turnstile num dublê (em produção, o `fetch` global até a Cloudflare). */
  turnstileFetch?: TurnstileFetch;
}

/**
 * O console do responsável (`cp-admin`, `ROLE=admin`): as rotas `/v1/admin/...`, o login próprio (e-mail, senha e
 * TOTP, `auth/`), o provedor de identidade do SIEM da Verax (`/sso/...`, `sso/`) e a guarda global que exige a sessão dele em toda requisição. Só este papel carrega o módulo; no
 * `cp-public` e no `cp-worker` as rotas nem existem. Os clientes (lista, detalhe, contrato direto) e os textos legais
 * (Termos, Privacidade e DPA) e as fontes de log do nó do cliente (o estado desejado da sincronização, com a credencial
 * cifrada para o cofre do nó) leem e gravam o Firestore; as operações do provisionamento vão ao cp-worker
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
        AdminFleetController,
        AdminLegalController,
        AdminLogSourcesController,
        AdminPricingController,
        AdminSessionController,
        AdminTenantsController,
        AwsReaderTemplateController,
        SsoController,
      ],
      providers: [
        AdminAuthService,
        AdminTurnstile,
        {
          provide: ADMIN_TURNSTILE_FETCH,
          useValue: options.turnstileFetch ?? ((input: string, init: RequestInit) => fetch(input, init)),
        },
        AdminFleetService,
        FleetStore,
        AdminLegalService,
        AdminLogSourcesService,
        AdminPricingService,
        AdminTenantsService,
        SsoService,
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
          provide: CONSOLE_FLEET_CLIENT,
          useFactory: (config: AppConfig): WorkerFleetClient | null =>
            options.workerFleetClient ??
            (config.WORKER_URL === undefined
              ? null
              : new HttpWorkerFleetClient(config.WORKER_URL, new GoogleAuthIdTokenSource())),
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
            account: new TokenBucketLimiter(ACCOUNT_PER_IP, clock),
          }),
          inject: [CLOCK],
        },
        {
          provide: SSO_LIMITS,
          useFactory: (clock: Clock): SsoLimits => ({
            perIp: new TokenBucketLimiter(SSO_PER_IP, clock),
            global: new TokenBucketLimiter(SSO_GLOBAL, clock),
          }),
          inject: [CLOCK],
        },
        { provide: APP_GUARD, useClass: OwnerGuard },
      ],
    };
  }
}
