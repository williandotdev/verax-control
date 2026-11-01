import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE, DiscoveryModule } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { type AppConfig, ConfigModule } from './common/config/config.module.js';
import { AllExceptionsFilter } from './common/http/all-exceptions.filter.js';
import { UndeclaredInputInterceptor } from './common/http/undeclared-input.interceptor.js';
import { AppValidationPipe } from './common/http/validation.pipe.js';
import { buildLoggerParams, type LoggerParamsOptions } from './common/logger/logger.options.js';
import { PrismaModule } from './common/prisma/prisma.module.js';
import { HealthModule } from './health/health.module.js';

export interface AppModuleOptions {
  logger?: LoggerParamsOptions;
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
        HealthModule,
      ],
      providers: [
        { provide: APP_PIPE, useClass: AppValidationPipe },
        { provide: APP_INTERCEPTOR, useClass: UndeclaredInputInterceptor },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    };
  }
}
