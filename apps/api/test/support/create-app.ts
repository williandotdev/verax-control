import 'reflect-metadata';
import type { ModuleMetadata } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { APP_CREATE_OPTIONS, configureApp } from '../../src/app.setup.js';
import type { AppConfig } from '../../src/common/config/config.module.js';
import { loadConfig } from '../../src/common/config/load-config.js';
import { LogCapture } from './log-capture.js';

export interface CreateAppOptions {
  databaseUrl?: string;
  nodeEnv?: AppConfig['NODE_ENV'];
  capture?: LogCapture;
  /** Módulos extras só de teste (ex.: controllers-sonda). */
  imports?: ModuleMetadata['imports'];
}

/**
 * Sobe a aplicação inteira para teste, com a mesma configuração HTTP de produção e os logs capturados
 * em memória. O nestjs-pino guarda o logger raiz em estado estático: use um app por arquivo de teste.
 */
export async function createApp(options: CreateAppOptions = {}): Promise<NestExpressApplication> {
  const config = loadConfig({
    NODE_ENV: options.nodeEnv ?? 'test',
    WEB_ORIGIN: 'http://localhost:5173',
    DATABASE_URL: options.databaseUrl ?? 'postgresql://verax:unused@localhost:5432/verax_test',
  });
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register(config, { logger: { destination: options.capture ?? new LogCapture() } }),
      ...(options.imports ?? []),
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>(APP_CREATE_OPTIONS);
  configureApp(app, config);
  await app.init();
  return app;
}
