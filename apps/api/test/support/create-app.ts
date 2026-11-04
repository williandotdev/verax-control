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
  /** Checagem no Have I Been Pwned: desligada por padrão (os testes não acessam a internet). */
  passwordBreachCheck?: boolean;
  capture?: LogCapture;
  /** Caixa de e-mail em memória no lugar do transporte configurado. */
  mailbox?: MailTransport;
  /** Módulos extras só de teste (ex.: controllers-sonda). */
  imports?: ModuleMetadata['imports'];
  /** Providers trocados por dublês (ex.: o leitor de evento bruto do indexer). */
  overrideProviders?: { provide: unknown; useValue: unknown }[];
  /** Tópico do nó para o sink de projeto GCP de cliente (`GCP_SINK_TOPIC_PREFIX`); sem ele, como no ambiente local. */
  gcpSinkTopicPrefix?: string;
  /** Cofre de credenciais ligado: a chave pública (PEM em base64) e a versão. Sem ele, a API sobe sem o cofre. */
  vault?: { publicKey: string; version: number };
  /** IPs de saída do nó (`NODE_EGRESS_IPS`), separados por vírgula. */
  nodeEgressIps?: string;
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
    PASSWORD_BREACH_CHECK_ENABLED: String(options.passwordBreachCheck ?? false),
    // Por padrão, o banco de teste: toda escrita abre transação e grava auditoria de verdade.
    DATABASE_URL: options.databaseUrl ?? inject('testDatabaseUrl'),
    TRUST_PROXY_HOPS: String(options.trustProxyHops ?? 0),
    ...(options.gcpSinkTopicPrefix !== undefined && { GCP_SINK_TOPIC_PREFIX: options.gcpSinkTopicPrefix }),
    ...(options.vault !== undefined && {
      CREDENTIALS_PUBLIC_KEY: options.vault.publicKey,
      CREDENTIALS_KEY_VERSION: String(options.vault.version),
    }),
    ...(options.nodeEgressIps !== undefined && { NODE_EGRESS_IPS: options.nodeEgressIps }),
  });
  const builder = Test.createTestingModule({
    imports: [
      AppModule.register(config, { logger: { destination: options.capture ?? new LogCapture() } }),
      ...(options.imports ?? []),
    ],
  })
    .overrideProvider(MAIL_TRANSPORT)
    .useValue(options.mailbox ?? new MemoryMailTransport());
  for (const { provide, useValue } of options.overrideProviders ?? []) {
    builder.overrideProvider(provide).useValue(useValue);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>(APP_CREATE_OPTIONS);
  configureApp(app, config);
  await app.init();
  return app;
}
