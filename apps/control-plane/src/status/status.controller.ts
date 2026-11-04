import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  readStatusCookie,
  STATUS_COOKIE_NAME,
  STATUS_COOKIE_PATH,
  statusTokenId,
} from '../access/status-token.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { ApiError } from '../common/http/api-error.js';
import { rateLimitKey, type RateLimitRule, TokenBucketLimiter } from '../common/http/rate-limiter.js';
import { forgetLiveSecret } from '../common/logger/sanitize.js';
import type { RevealedAccessView } from './reveal-gateway.js';
import { StatusService } from './status.service.js';
import type { StatusView } from './status-view.js';

/** Limites do plano §2.3, em memória por instância (com 2 instâncias o efetivo dobra, como no checkout). */
export const STATUS_CLAIM_PER_IP: RateLimitRule = { capacity: 10, windowMs: 60 * 60_000 };
/** A página consulta a cada 10 s: 12 por minuto por cookie (sem cookie válido, conta pelo IP). */
export const STATUS_READ_PER_COOKIE: RateLimitRule = { capacity: 12, windowMs: 60_000 };
export const STATUS_REVEAL_PER_IP: RateLimitRule = { capacity: 5, windowMs: 60 * 60_000 };

/** Os limitadores das rotas de status (uma instância por processo). */
export class StatusRateLimits {
  readonly claim: TokenBucketLimiter;
  readonly read: TokenBucketLimiter;
  readonly reveal: TokenBucketLimiter;

  constructor(clock: Clock) {
    this.claim = new TokenBucketLimiter(STATUS_CLAIM_PER_IP, clock);
    this.read = new TokenBucketLimiter(STATUS_READ_PER_COOKIE, clock);
    this.reveal = new TokenBucketLimiter(STATUS_REVEAL_PER_IP, clock);
  }
}

export const STATUS_RATE_LIMITS = Symbol('STATUS_RATE_LIMITS');

export const STATUS_RATE_LIMITS_PROVIDER = {
  provide: STATUS_RATE_LIMITS,
  useFactory: (clock: Clock) => new StatusRateLimits(clock),
  inject: [CLOCK],
};

function enforce(limiter: TokenBucketLimiter, key: string, res: Response): void {
  const decision = limiter.take(key);
  if (decision.allowed) return;
  res.setHeader('Retry-After', String(decision.retryAfterSeconds));
  throw new ApiError(
    HttpStatus.TOO_MANY_REQUESTS,
    'Muitas tentativas. Tente novamente mais tarde.',
    'rate_limited',
  );
}

function ipKey(req: Request): string {
  return `ip:${rateLimitKey(req.ip)}`;
}

function requestIdOf(req: Request): string | undefined {
  const id = (req as Request & { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

/**
 * Os POST da página de status só aceitam JSON. Um POST `text/plain` ou de formulário é "simples" para o navegador (sai
 * sem preflight de CORS) e, vindo de outro site sob `veraxsistemas.com.br`, levaria o cookie `SameSite=Lax`: bastaria
 * para gastar a revelação única de alguém. Com JSON, toda chamada de outra origem passa antes pelo preflight, que o
 * CORS recusa (`cors.ts`).
 */
function requireJson(req: Request): void {
  if (req.is('application/json') !== 'application/json') {
    throw new ApiError(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'Envie JSON', 'unsupported_media_type');
  }
}

/**
 * Rotas da página de status (só no `cp-public`; `credentials: true` no CORS só nelas, `cors.ts`). Toda resposta sai
 * com `Cache-Control: private, no-store` (`app.setup.ts`), inclusive a da revelação.
 */
@Controller('public/status')
export class StatusController {
  constructor(
    private readonly status: StatusService,
    @Inject(STATUS_RATE_LIMITS) private readonly limits: StatusRateLimits,
  ) {}

  /** Troca o `cs_` da URL de sucesso pelo cookie `__session` (httpOnly, Secure, SameSite=Lax, só nestas rotas). */
  @Post('claim')
  @HttpCode(HttpStatus.OK)
  async claim(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StatusView> {
    enforce(this.limits.claim, ipKey(req), res);
    requireJson(req);
    const result = await this.status.claim(body, { requestId: requestIdOf(req) });
    res.cookie(STATUS_COOKIE_NAME, result.cookie, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: STATUS_COOKIE_PATH,
      maxAge: result.maxAgeMs,
    });
    return result.view;
  }

  @Get()
  async read(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<StatusView> {
    const value = readStatusCookie(req.headers.cookie, this.status.cookieKey());
    // Com cookie de assinatura válida, o limite é dele; sem, do IP (um cookie forjado não ganha balde novo).
    enforce(this.limits.read, value === undefined ? ipKey(req) : `cookie:${statusTokenId(value)}`, res);
    return this.status.status(value);
  }

  /** A senha, uma vez. A destruição da versão já está na fila do worker quando esta resposta sai. */
  @Post('reveal')
  @HttpCode(HttpStatus.OK)
  async reveal(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RevealedAccessView> {
    enforce(this.limits.reveal, ipKey(req), res);
    requireJson(req);
    const value = readStatusCookie(req.headers.cookie, this.status.cookieKey());
    const revealed = await this.status.reveal(body, value, { requestId: requestIdOf(req) });
    res.on('close', () => forgetLiveSecret(revealed.password));
    return revealed;
  }
}
