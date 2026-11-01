import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { ModuleMetadata } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { inject } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { APP_CREATE_OPTIONS, configureApp } from '../../src/app.setup.js';
import type { AppConfig } from '../../src/common/config/config.module.js';
import { loadConfig } from '../../src/common/config/load-config.js';
import { MAIL_TRANSPORT, type MailTransport } from '../../src/mail/mail.types.js';
import { LogCapture } from './log-capture.js';
import { MemoryMailTransport } from './memory-mail.js';

/** Origem do painel nos testes: requisições de autenticação mandam este Origin. */
export const TEST_WEB_ORIGIN = 'http://localhost:5173';
// Só para testes; gerado na hora, nunca é um segredo real.
const TEST_AUTH_SECRET = randomBytes(32).toString('base64url');
const TEST_CSRF_SECRET = randomBytes(32).toString('base64url');

export interface CreateAppOptions {
  databaseUrl?: string;
  nodeEnv?: AppConfig['NODE_ENV'];
  trustProxyHops?: number;
  /** Limite de tentativas por IP: desligado por padrão nos testes, que fazem muitos logins do mesmo IP. */
  authRateLimit?: boolean;
  capture?: LogCapture;
  /** Caixa de e-mail em memória no lugar do transporte configurado. */
  mailbox?: MailTransport;
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
    WEB_ORIGIN: TEST_WEB_ORIGIN,
    API_ORIGIN: 'http://localhost:3000',
    BETTER_AUTH_SECRET: TEST_AUTH_SECRET,
    CSRF_SECRET: TEST_CSRF_SECRET,
    MAIL_FROM: 'nao-responda@verax.example',
    AUTH_RATE_LIMIT_ENABLED: String(options.authRateLimit ?? false),
    // Por padrão, o banco de teste: toda escrita abre transação e grava auditoria de verdade.
    DATABASE_URL: options.databaseUrl ?? inject('testDatabaseUrl'),
    TRUST_PROXY_HOPS: String(options.trustProxyHops ?? 0),
  });
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register(config, { logger: { destination: options.capture ?? new LogCapture() } }),
      ...(options.imports ?? []),
    ],
  })
    .overrideProvider(MAIL_TRANSPORT)
    .useValue(options.mailbox ?? new MemoryMailTransport())
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>(APP_CREATE_OPTIONS);
  configureApp(app, config);
  await app.init();
  return app;
}
