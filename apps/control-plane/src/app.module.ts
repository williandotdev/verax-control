import { type DynamicModule, Module, type ModuleMetadata } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AuditModule } from './audit/audit.module.js';
import type { Clock } from './common/clock.js';
import { type AppConfig, ConfigModule } from './common/config/config.module.js';
import type { Role } from './common/config/env.schema.js';
import { AllExceptionsFilter } from './common/http/all-exceptions.filter.js';
import { buildLoggerParams, type LoggerParamsOptions } from './common/logger/logger.options.js';
import type { DocumentStore } from './firestore/document-store.js';
import { FirestoreModule } from './firestore/firestore.module.js';
import { HealthModule } from './health/health.module.js';
import { TenantsModule } from './tenants/tenants.module.js';

export interface AppModuleOptions {
  /** `FirestoreDocumentStore` em produção; o dublê em memória nos testes. */
  documentStore: DocumentStore;
  clock?: Clock;
  logger?: LoggerParamsOptions;
}

/**
 * Módulos que só existem num papel (plano §2.1): o `cp-public` registra as rotas públicas (checkout, status e
 * webhook, CP-03 a CP-05) e o `cp-worker` as internas (passos, tick e reconcile, CP-07 e CP-11). O outro papel
 * nem carrega o módulo, então a rota não existe nele.
 */
function modulesFor(role: Role): NonNullable<ModuleMetadata['imports']> {
  switch (role) {
    case 'public':
      return [];
    case 'worker':
      return [];
  }
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
        AuditModule,
        TenantsModule,
        HealthModule,
        ...modulesFor(config.ROLE),
      ],
      providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
    };
  }
}
