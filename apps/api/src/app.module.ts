import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE, DiscoveryModule } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AlertExceptionsModule } from './alert-exceptions/alert-exceptions.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CloudAccountsModule } from './cloud-accounts/cloud-accounts.module.js';
import { AuditInterceptor } from './common/audit/audit.interceptor.js';
import { RequestContextInterceptor } from './common/context/request-context.interceptor.js';
import { AuditModule } from './common/audit/audit.module.js';
import { type AppConfig, ConfigModule } from './common/config/config.module.js';
import { AllExceptionsFilter } from './common/http/all-exceptions.filter.js';
import { UndeclaredInputInterceptor } from './common/http/undeclared-input.interceptor.js';
import { AppValidationPipe } from './common/http/validation.pipe.js';
import { buildLoggerParams, type LoggerParamsOptions } from './common/logger/logger.options.js';
import { PrismaModule } from './common/prisma/prisma.module.js';
import { FindingsModule } from './findings/findings.module.js';
import type { RawEventReader } from './findings/raw-events.js';
import { HealthModule } from './health/health.module.js';
import { MailModule } from './mail/mail.module.js';
import { ProtectedResourcesModule } from './protected-resources/protected-resources.module.js';
import { TenantsModule } from './tenants/tenants.module.js';
import { UsersModule } from './users/users.module.js';

export interface AppModuleOptions {
  logger?: LoggerParamsOptions;
  /** Evento bruto do detalhe do achado, lido do indexer quando ele está configurado. */
  rawEvents?: RawEventReader;
}

@Module({})
export class AppModule {
  static register(config: AppConfig, options: AppModuleOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        LoggerModule.forRoot(buildLoggerParams(config, options.logger)),
        // Usado pelos meta-testes que percorrem todas as rotas.
        DiscoveryModule,
        PrismaModule,
        AuditModule,
        MailModule,
        AuthModule,
        HealthModule,
        TenantsModule,
        UsersModule,
        CloudAccountsModule,
        FindingsModule.register(options.rawEvents),
        ProtectedResourcesModule,
        AlertExceptionsModule,
      ],
      providers: [
        { provide: APP_PIPE, useClass: AppValidationPipe },
        // A ordem importa: o contexto da requisição primeiro; a auditoria envolve tudo o que vem depois,
        // inclusive as rejeições do interceptor de entrada não declarada.
        { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
        { provide: APP_INTERCEPTOR, useExisting: AuditInterceptor },
        { provide: APP_INTERCEPTOR, useClass: UndeclaredInputInterceptor },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    };
  }
}
