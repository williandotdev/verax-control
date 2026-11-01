import { type DynamicModule, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { type AppConfig, ConfigModule } from './common/config/config.module.js';
import { buildLoggerParams, type LoggerParamsOptions } from './common/logger/logger.options.js';
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
        HealthModule,
      ],
    };
  }
}
