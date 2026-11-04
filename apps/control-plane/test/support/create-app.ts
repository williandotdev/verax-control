import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { APP_CREATE_OPTIONS, configureApp } from '../../src/app.setup.js';
import type { Clock } from '../../src/common/clock.js';
import type { AppConfig } from '../../src/common/config/config.module.js';
import type { Role } from '../../src/common/config/env.schema.js';
import { loadConfig } from '../../src/common/config/load-config.js';
import type { DocumentStore } from '../../src/firestore/document-store.js';
import { MemoryDocumentStore } from '../../src/firestore/memory-document-store.js';
import { LogCapture } from './log-capture.js';

export interface CreateAppOptions {
  role?: Role;
  nodeEnv?: AppConfig['NODE_ENV'];
  trustProxyHops?: number;
  /** Valor de TRUSTED_PROXIES (lista separada por vírgula). */
  trustedProxies?: string;
  /** Outras variáveis de ambiente, por cima das acima. */
  env?: Record<string, string>;
  capture?: LogCapture;
  documentStore?: DocumentStore;
  clock?: Clock;
}

/**
 * Sobe a aplicação inteira para teste, com a mesma configuração HTTP de produção, o dublê em memória do Firestore
 * e os logs capturados. O nestjs-pino guarda o primeiro pino-http do processo em estado de módulo: um segundo app
 * no mesmo arquivo reaproveitaria o logger (e o destino) do primeiro. Um app por arquivo de teste.
 */
export async function createApp(options: CreateAppOptions = {}): Promise<NestExpressApplication> {
  const config = loadConfig({
    ROLE: options.role ?? 'public',
    NODE_ENV: options.nodeEnv ?? 'test',
    TRUST_PROXY_HOPS: String(options.trustProxyHops ?? 0),
    ...(options.trustedProxies === undefined ? {} : { TRUSTED_PROXIES: options.trustedProxies }),
    ...options.env,
  });
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register(config, {
        documentStore: options.documentStore ?? new MemoryDocumentStore(),
        clock: options.clock,
        logger: { destination: options.capture ?? new LogCapture() },
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>(APP_CREATE_OPTIONS);
  configureApp(app, config);
  await app.init();
  return app;
}
