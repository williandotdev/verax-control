import { Body, Controller, Get, HttpStatus, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CLOCK, type Clock } from '../common/clock.js';
import { ApiError } from '../common/http/api-error.js';
import { rateLimitKey, type RateLimitRule, TokenBucketLimiter } from '../common/http/rate-limiter.js';
import type { CheckoutResponse, SlugAvailability } from './checkout.schema.js';
import { CheckoutService, DailyLimitApiError } from './checkout.service.js';

/** Limites por IP do plano §2.3, em memória por instância. */
export const CHECKOUT_PER_IP: RateLimitRule = { capacity: 5, windowMs: 60 * 60_000 };
export const SLUG_LOOKUP_PER_IP: RateLimitRule = { capacity: 30, windowMs: 60_000 };

/** Os dois limitadores por IP das rotas do checkout (uma instância por processo). */
export class CheckoutRateLimits {
  readonly checkout: TokenBucketLimiter;
  readonly slugs: TokenBucketLimiter;

  constructor(clock: Clock) {
    this.checkout = new TokenBucketLimiter(CHECKOUT_PER_IP, clock);
    this.slugs = new TokenBucketLimiter(SLUG_LOOKUP_PER_IP, clock);
  }
}

export const CHECKOUT_RATE_LIMITS = Symbol('CHECKOUT_RATE_LIMITS');

/** O IP vem de `req.ip`, pela regra de `common/http/client-ip.ts` (o mesmo do log da requisição). */
function enforce(limiter: TokenBucketLimiter, req: Request, res: Response): void {
  const decision = limiter.take(rateLimitKey(req.ip));
  if (decision.allowed) return;
  res.setHeader('Retry-After', String(decision.retryAfterSeconds));
  throw new ApiError(
    HttpStatus.TOO_MANY_REQUESTS,
    'Muitas tentativas. Tente novamente mais tarde.',
    'rate_limited',
  );
}

function requestIdOf(req: Request): string | undefined {
  const id = (req as Request & { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

/** Rotas públicas do checkout (só no `cp-public`): consulta de subdomínio e abertura da sessão do Checkout. */
@Controller('public')
export class CheckoutController {
  constructor(
    private readonly checkout: CheckoutService,
    @Inject(CHECKOUT_RATE_LIMITS) private readonly limits: CheckoutRateLimits,
  ) {}

  /** Só `available`; nunca reserva nem diz por que não está disponível (plano §2.3 e §5). */
  @Get('slugs/:slug')
  async slug(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SlugAvailability> {
    enforce(this.limits.slugs, req, res);
    return { available: await this.checkout.isSlugAvailable(slug) };
  }

  @Post('checkout')
  async create(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CheckoutResponse> {
    enforce(this.limits.checkout, req, res);
    try {
      return await this.checkout.createSession(body, { requestId: requestIdOf(req) });
    } catch (error) {
      if (error instanceof DailyLimitApiError) res.setHeader('Retry-After', String(error.retryAfterSeconds));
      throw error;
    }
  }
}

export function createCheckoutRateLimits(clock: Clock): CheckoutRateLimits {
  return new CheckoutRateLimits(clock);
}

export const CHECKOUT_RATE_LIMITS_PROVIDER = {
  provide: CHECKOUT_RATE_LIMITS,
  useFactory: createCheckoutRateLimits,
  inject: [CLOCK],
};
