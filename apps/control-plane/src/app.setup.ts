import { type NestApplicationOptions, RequestMethod } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { z } from 'zod';
import type { AppConfig } from './common/config/config.module.js';
import { buildTrustProxy } from './common/http/client-ip.js';
import { buildCorsDelegate } from './common/http/cors.js';
import { rawBodyParser, WEBHOOK_BODY_LIMIT_BYTES, WEBHOOK_PATH } from './webhook/raw-body.js';

export const API_PREFIX = 'v1';

/** Teto do JSON das rotas públicas (plano §2.3). O webhook da Stripe tem o próprio leitor de corpo bruto (1 MB). */
export const JSON_BODY_LIMIT = '16kb';
/** No console do responsável, uma tabela de preços ou um modelo de custos inteiro (com as fontes) cabe folgado. */
export const ADMIN_JSON_BODY_LIMIT = '64kb';

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

/** As rotas internas do cp-worker (`/internal/...`), fora do prefixo `/v1`. */
const INTERNAL_ROUTES = [{ path: 'internal/*path', method: RequestMethod.POST }];

function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
}

/** Configuração HTTP aplicada igual no `main.ts` e nos testes. */
export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  z.config(z.locales.ptBR());
  app.useLogger(app.get(Logger));
  // `req.ip` pela regra de client-ip.ts (saltos confiáveis mais as saídas do Hosting); é o IP dos limites e dos logs.
  app.set('trust proxy', buildTrustProxy(config));
  // O webhook da Stripe (CP-04, só no cp-public) lê o corpo bruto até 1 MB: a assinatura vale sobre os bytes exatos.
  // Registrado antes do JSON, que encontra a requisição já lida e não a toca.
  if (config.ROLE === 'public') app.use(WEBHOOK_PATH, rawBodyParser(WEBHOOK_BODY_LIMIT_BYTES));
  app.useBodyParser('json', { limit: config.ROLE === 'admin' ? ADMIN_JSON_BODY_LIMIT : JSON_BODY_LIMIT });
  app.use(helmet(HELMET_OPTIONS));
  // Toda resposta é dinâmica: nem o cache do Hosting nem o do navegador guardam (plano §2.4).
  app.use(noStore);
  // CORS só para as origens do site, e só no cp-public (o worker é chamado por tasks e pelo Scheduler, nunca por um
  // navegador): sem cabeçalho nenhum para outra origem, `credentials` só nas rotas de status (cors.ts).
  if (config.ROLE === 'public') app.enableCors(buildCorsDelegate(config.SITE_ORIGINS ?? []));
  app.setGlobalPrefix(API_PREFIX, {
    // O health check fica fora do prefixo versionado, e as rotas internas do cp-worker também: as tasks chamam
    // `<WORKER_URL>/internal/steps/<passo>` (cloud-tasks-step-queue.ts). O cp-public não tem rota interna nenhuma.
    exclude: [
      { path: 'health', method: RequestMethod.GET },
      ...(config.ROLE === 'worker' ? INTERNAL_ROUTES : []),
    ],
  });
}
