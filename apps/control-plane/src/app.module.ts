import { type DynamicModule, Module, type ModuleMetadata } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AuditModule } from './audit/audit.module.js';
import { AccessWorkerModule, type AccessWorkerModuleOptions } from './access/access-worker.module.js';
import { CheckoutModule } from './checkout/checkout.module.js';
import type { Clock } from './common/clock.js';
import { type AppConfig, ConfigModule } from './common/config/config.module.js';
import type { Role } from './common/config/env.schema.js';
import { AllExceptionsFilter } from './common/http/all-exceptions.filter.js';
import { buildLoggerParams, type LoggerParamsOptions } from './common/logger/logger.options.js';
import type { DocumentStore } from './firestore/document-store.js';
import { FirestoreModule } from './firestore/firestore.module.js';
import { HealthModule } from './health/health.module.js';
import type { StepQueue } from './queue/step-queue.js';
import { StepQueueModule } from './queue/step-queue.module.js';
import { StatusModule, type StatusModuleOptions } from './status/status.module.js';
import type { StripeApiOptions } from './stripe/stripe-client.js';
import { StripeModule } from './stripe/stripe.module.js';
import { TenantsModule } from './tenants/tenants.module.js';
import { WebhookModule } from './webhook/webhook.module.js';

export interface AppModuleOptions {
  /** `FirestoreDocumentStore` em produção; o dublê em memória nos testes. */
  documentStore: DocumentStore;
  clock?: Clock;
  logger?: LoggerParamsOptions;
  /** Só nos testes: o caminho do cp-public até a revelação sem HTTP (em produção, o cp-worker em `WORKER_URL`). */
  revealGateway?: StatusModuleOptions['revealGateway'];
  /** Só nos testes: o cofre da senha inicial em memória (em produção, o Secret Manager do projeto dos nós). */
  bootstrapSecrets?: AccessWorkerModuleOptions['bootstrapSecrets'];
  /** Só nos testes: o envio de e-mail em memória (em produção, o SMTP da configuração). */
  mailSender?: AccessWorkerModuleOptions['mailSender'];
  /** Só nos testes: a API da Stripe num servidor falso em 127.0.0.1 (em produção, o padrão do SDK). */
  stripeApi?: StripeApiOptions;
  /** Só nos testes: a fila de passos em memória (em produção, o Cloud Tasks pela configuração). */
  stepQueue?: StepQueue;
}

/**
 * Módulos que só existem num papel (plano §2.1): o `cp-public` registra as rotas públicas (checkout, status e
 * webhook, CP-03 a CP-05) e o `cp-worker` as internas (passos, tick e reconcile, CP-07 e CP-11). O outro papel
 * nem carrega o módulo, então a rota não existe nele.
 */
function modulesFor(role: Role, options: AppModuleOptions): NonNullable<ModuleMetadata['imports']> {
  switch (role) {
    case 'public':
      return [StripeModule.forRoot({ stripeApi: options.stripeApi }), CheckoutModule, WebhookModule];
    case 'worker':
      return [];
  }
}

/**
 * Página de status e revelação única (CP-05), com a mesma separação por papel: no `cp-public`, as rotas
 * `/v1/public/status*`; no `cp-worker`, a revelação em si (só ele lê o segredo), os passos `/internal/steps/*` e o
 * gatilho do plano B. Nenhum outro papel carrega estes módulos.
 */
function accessModulesFor(role: Role, options: AppModuleOptions): NonNullable<ModuleMetadata['imports']> {
  if (role === 'public') return [StatusModule.forRoot({ revealGateway: options.revealGateway })];
  if (role === 'worker') {
    return [
      AccessWorkerModule.forRoot({
        bootstrapSecrets: options.bootstrapSecrets,
        mailSender: options.mailSender,
      }),
    ];
  }
  return [];
}

@Module({})
export class AppModule {
  static register(config: AppConfig, options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        LoggerModule.forRoot(buildLoggerParams(config, options.logger)),
        FirestoreModule.forRoot({ store: options.documentStore, clock: options.clock }),
        StepQueueModule.forRoot({ stepQueue: options.stepQueue }),
        AuditModule,
        TenantsModule,
        HealthModule,
        ...modulesFor(config.ROLE, options),
        ...accessModulesFor(config.ROLE, options),
      ],
      providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
    };
  }
}
