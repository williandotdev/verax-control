import { type NestApplicationOptions, RequestMethod } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { z } from 'zod';
import type { AppConfig } from './common/config/config.module.js';

export const API_PREFIX = 'v1';

/** Teto do JSON das rotas públicas (plano §2.3). O webhook da Stripe registra o próprio parser de corpo bruto. */
export const JSON_BODY_LIMIT = '16kb';

/**
 * Opções de criação da aplicação, iguais em produção e nos testes. Sem body parser padrão: só JSON, registrado
 * em `configureApp`; formulário HTML não vira corpo.
 */
export const APP_CREATE_OPTIONS: NestApplicationOptions = { bufferLogs: true, bodyParser: false };

/**
 * Headers de segurança de um serviço que só devolve JSON (mesma política da API, plano §2.4): nada pode ser
 * carregado, embutido em frame ou enviado por formulário a partir das respostas.
 */
const HELMET_OPTIONS = {
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
  app.use(helmet(HELMET_OPTIONS));
  // CORS só para as origens do site, e só no cp-public: entra no CP-03 com as rotas públicas.
  app.setGlobalPrefix(API_PREFIX, {
    // O health check fica fora do prefixo versionado.
    exclude: [{ path: 'health', method: RequestMethod.GET }],
  });
}
