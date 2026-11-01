import { type NestApplicationOptions, RequestMethod } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { z } from 'zod';
import type { AppConfig } from './common/config/config.module.js';
import { setupOpenApi } from './common/http/openapi.js';

export const API_PREFIX = 'v1';
export const JSON_BODY_LIMIT = '100kb';

/**
 * Opções de criação da aplicação, iguais em produção e nos testes. Sem body parser padrão: a API só
 * aceita JSON (registrado em `configureApp`). Formulário HTML não vira corpo, o que também tira um vetor
 * de CSRF.
 */
export const APP_CREATE_OPTIONS: NestApplicationOptions = { bufferLogs: true, bodyParser: false };

/**
 * Headers de segurança de uma API que só devolve JSON: nada pode ser carregado, embutido em frame ou
 * enviado por formulário a partir das respostas.
 */
const API_HELMET_OPTIONS = {
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'same-site' as const },
  referrerPolicy: { policy: 'no-referrer' as const },
};

/** Configuração HTTP aplicada igual no `main.ts` e nos testes. */
export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  z.config(z.locales.ptBR());
  app.useLogger(app.get(Logger));
  app.set('trust proxy', config.TRUST_PROXY_HOPS);
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.use(helmet(API_HELMET_OPTIONS));
  app.setGlobalPrefix(API_PREFIX, {
    // Health check do ALB fica fora do prefixo versionado.
    exclude: [
      { path: 'health', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
    ],
  });
  if (config.NODE_ENV === 'development') {
    setupOpenApi(app, API_PREFIX);
  }
}
