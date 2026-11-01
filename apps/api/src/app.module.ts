import { type DynamicModule, Module } from '@nestjs/common';
import { type AppConfig, ConfigModule } from './common/config/config.module.js';

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigModule.forRoot(config)],
    };
  }
}
