import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { AppModule } from '../../src/app.module.js';
import { loadConfig } from '../../src/common/config/load-config.js';
import type { LogCapture } from './log-capture.js';

/**
 * Sobe a aplicação inteira para teste, com os logs capturados em memória.
 * O nestjs-pino guarda o logger raiz em estado estático: use um app por arquivo de teste.
 */
export async function createApp(databaseUrl: string, capture: LogCapture): Promise<INestApplication> {
  const config = loadConfig({
    NODE_ENV: 'test',
    WEB_ORIGIN: 'http://localhost:5173',
    DATABASE_URL: databaseUrl,
  });
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register(config, { logger: { destination: capture } })],
  }).compile();
  const app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useLogger(app.get(Logger));
  await app.init();
  return app;
}
