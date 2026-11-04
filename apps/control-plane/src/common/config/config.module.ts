import { type DynamicModule, Global, Module } from '@nestjs/common';
import type { Env } from './env.schema.js';

export const APP_CONFIG = Symbol('APP_CONFIG');
export type AppConfig = Readonly<Env>;

@Global()
@Module({})
export class ConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
