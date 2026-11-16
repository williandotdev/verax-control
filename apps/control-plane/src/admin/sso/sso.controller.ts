import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post, Req, Res } from '@nestjs/common';
import type { SsoJwk, SsoTokenResponse } from '@verax/shared';
import type { Response } from 'express';
import { ApiError } from '../../common/http/api-error.js';
import { rateLimitKey, type RateLimitRule, type TokenBucketLimiter } from '../../common/http/rate-limiter.js';
import { sessionCookieValues } from '../auth/session-cookie.js';
import { type OwnerRequest, PublicAdminRoute } from '../owner.guard.js';
import { type AuthorizeOutcome, type SsoRequestContext, SsoService } from './sso.service.js';

/**
 * Limites da entrada única, em memória (o cp-admin roda com uma instância só), contando só as falhas, como os do login:
 * um pedido recusado (parâmetro inválido, cliente ou endereço fora da lista, código errado) gasta a tentativa; o que
 * deu certo, ou foi para o login do console, devolve. Por IP (`req.ip`, a regra de `client-ip.ts`; atrás do Hosting, a
 * saída dele) e no total.
 */
export const SSO_PER_IP: RateLimitRule = { capacity: 20, windowMs: 15 * 60_000 };
export const SSO_GLOBAL: RateLimitRule = { capacity: 100, windowMs: 15 * 60_000 };

export const SSO_LIMITS = Symbol('SSO_LIMITS');
export interface SsoLimits {
  perIp: TokenBucketLimiter;
  global: TokenBucketLimiter;
}

const GLOBAL_KEY = 'todos';

type RefusalStatus = 400 | 403 | 429 | 503;

const REFUSAL_TEXT: Readonly<Record<RefusalStatus, { title: string; message: string }>> = {
  400: {
    title: 'Pedido de entrada inválido',
    message: 'O pedido de entrada não é válido. Volte ao SIEM e tente entrar de novo.',
  },
  403: { title: 'Sem permissão', message: 'Este acesso não é permitido.' },
  429: { title: 'Muitas tentativas', message: 'Muitas tentativas. Tente novamente mais tarde.' },
  503: {
    title: 'Entrada única indisponível',
    message: 'A entrada única está indisponível no momento. Tente de novo mais tarde.',
  },
};

/**
 * A tela de recusa do `/sso/authorize`: HTML estático e genérico (nenhum dado do pedido volta na página), sem estilo
 * nem script, sob a CSP da API (`default-src 'none'`). Nunca redireciona: o endereço do pedido pode não ser confiável.
 */
export function refusalPage(status: RefusalStatus): string {
  const { title, message } = REFUSAL_TEXT[status];
  return [
    '<!doctype html>',
    '<html lang="pt-BR">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title} · Verax Control</title></head>`,
    `<body><main><h1>${title}</h1><p>${message}</p><p><a href="/">Ir para o console</a></p></main></body>`,
    '</html>',
  ].join('');
}

function contextOf(req: OwnerRequest): SsoRequestContext {
  return typeof req.id === 'string' ? { requestId: req.id } : {};
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * O provedor de identidade do SIEM da Verax no console (`sso.service.ts`), fora do prefixo `/v1` (`app.setup.ts`):
 * `GET /sso/authorize` (o navegador do responsável), `POST /sso/token` (a API da célula, de servidor para servidor, em
 * JSON) e `GET /sso/jwks` (a chave pública, para conferir a que o nó fixou). Abrem sem a guarda da sessão
 * (`@PublicAdminRoute`): o `authorize` confere a sessão ele mesmo, e a troca é provada pelo código e pelo PKCE. A
 * escrita continua exigindo JSON e recusando outro site (`OwnerGuard.checkWrite`).
 */
@Controller('sso')
@PublicAdminRoute()
export class SsoController {
  constructor(
    private readonly sso: SsoService,
    @Inject(SSO_LIMITS) private readonly limits: SsoLimits,
  ) {}

  @Get('authorize')
  async authorize(@Req() req: OwnerRequest, @Res() res: Response): Promise<void> {
    const key = rateLimitKey(req.ip);
    if (!this.take(key, res)) {
      res.status(HttpStatus.TOO_MANY_REQUESTS).type('html').send(refusalPage(429));
      return;
    }
    let outcome: AuthorizeOutcome;
    try {
      outcome = await this.sso.authorize(
        req.query,
        sessionCookieValues(req.headers.cookie),
        headerValue(req.headers['sec-fetch-site']),
        contextOf(req),
      );
    } catch (error) {
      this.refund(key);
      throw error;
    }
    if (outcome.kind === 'refused') {
      // Só a recusa do pedido conta no limite; a indisponibilidade é do servidor.
      if (outcome.status === 503) this.refund(key);
      res.status(outcome.status).type('html').send(refusalPage(outcome.status));
      return;
    }
    this.refund(key);
    res.redirect(HttpStatus.SEE_OTHER, outcome.location);
  }

  @Post('token')
  @HttpCode(HttpStatus.OK)
  async token(
    @Body() body: unknown,
    @Req() req: OwnerRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SsoTokenResponse> {
    const key = rateLimitKey(req.ip);
    if (!this.take(key, res)) {
      throw new ApiError(
        HttpStatus.TOO_MANY_REQUESTS,
        'Muitas tentativas. Tente novamente mais tarde.',
        'rate_limited',
      );
    }
    try {
      const response = await this.sso.token(body, contextOf(req));
      this.refund(key);
      res.setHeader('Pragma', 'no-cache');
      return response;
    } catch (error) {
      const failure = error instanceof ApiError && error.getStatus() >= 400 && error.getStatus() < 500;
      if (!failure) this.refund(key);
      throw error;
    }
  }

  @Get('jwks')
  jwks(): Promise<{ keys: SsoJwk[] }> {
    return this.sso.jwks();
  }

  /** Uma tentativa de cada balde (as duas ou nenhuma); estourado, `Retry-After` e `false`. */
  private take(key: string, res: Response): boolean {
    const perIp = this.limits.perIp.take(key);
    if (!perIp.allowed) {
      res.setHeader('Retry-After', String(perIp.retryAfterSeconds));
      return false;
    }
    const global = this.limits.global.take(GLOBAL_KEY);
    if (!global.allowed) {
      this.limits.perIp.refund(key);
      res.setHeader('Retry-After', String(global.retryAfterSeconds));
      return false;
    }
    return true;
  }

  private refund(key: string): void {
    this.limits.perIp.refund(key);
    this.limits.global.refund(GLOBAL_KEY);
  }
}
