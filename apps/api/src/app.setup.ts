import { type NestApplicationOptions, RequestMethod } from '@nestjs/common';
import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface.js';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { z } from 'zod';
import type { AppConfig } from './common/config/config.module.js';
import { API_PREFIX } from './common/http/api-prefix.js';
import { setupOpenApi } from './common/http/openapi.js';
import { CSRF_HEADER } from './auth/csrf.js';
import { HostTenantResolver } from './auth/host-tenant.js';
import { TURNSTILE_TOKEN_HEADER } from './auth/turnstile.js';

export { API_PREFIX };
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
  // CORS só para o painel, com cookies (T2.3). Qualquer outra origem não recebe os headers de permissão.
  const corsOptions = {
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    // O token do Turnstile vai num header próprio no login e no pedido de redefinição (preflight do navegador).
    allowedHeaders: ['Content-Type', CSRF_HEADER, TURNSTILE_TOKEN_HEADER],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
  };
  if (config.cell === null) {
    app.enableCors({
      // Função em vez de texto: outra origem não recebe nem o header com o endereço do painel.
      origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
        callback(null, origin === config.WEB_ORIGIN);
      },
      ...corsOptions,
    });
  } else {
    // Na célula (CE-01), só o painel do cliente do endereço (`Host`). Endereço desconhecido, outro painel ou erro ao
    // consultar o mapa: nenhum header de permissão (o guard do endereço responde 404 em seguida).
    const hosts = app.get(HostTenantResolver);
    app.enableCors((request: Request, callback: (error: Error | null, options: CorsOptions) => void) => {
      hosts.resolve(request).then(
        (host) =>
          callback(null, {
            ...corsOptions,
            origin: host !== undefined && request.headers.origin === host.panelOrigin,
          }),
        () => callback(null, { ...corsOptions, origin: false }),
      );
    });
  }
  // Só para ler o cookie do token CSRF; o Better Auth lê os próprios cookies.
  app.use(cookieParser());
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
