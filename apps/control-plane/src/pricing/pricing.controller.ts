import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CLOCK, type Clock } from '../common/clock.js';
import { enforceRateLimit, type RateLimitRule, TokenBucketLimiter } from '../common/http/rate-limiter.js';
import type { PublicPricing } from './public-pricing.js';
import {
  type ContactUsResponse,
  PublicPricingService,
  QuoteDailyLimitApiError,
  type QuoteResponse,
} from './pricing.service.js';

/**
 * Limites por IP em memória (como os do checkout): a tabela pública é lida a cada visita (e fica 5 min no CDN do
 * Hosting); a cotação é gravada no Firestore e tem, além deste, o teto diário global (`QUOTE_DAILY_LIMIT`).
 */
export const PRICING_PER_IP: RateLimitRule = { capacity: 30, windowMs: 60_000 };
export const QUOTE_PER_IP: RateLimitRule = { capacity: 20, windowMs: 60 * 60_000 };

export class PricingRateLimits {
  readonly pricing: TokenBucketLimiter;
  readonly quote: TokenBucketLimiter;

  constructor(clock: Clock) {
    this.pricing = new TokenBucketLimiter(PRICING_PER_IP, clock);
    this.quote = new TokenBucketLimiter(QUOTE_PER_IP, clock);
  }
}

export const PRICING_RATE_LIMITS = Symbol('PRICING_RATE_LIMITS');

/** Cache da tabela pública no CDN do Hosting (e no navegador): 5 min. */
const PUBLIC_CACHE = 'public, max-age=300';

export const PRICING_RATE_LIMITS_PROVIDER = {
  provide: PRICING_RATE_LIMITS,
  useFactory: (clock: Clock) => new PricingRateLimits(clock),
  inject: [CLOCK],
};

/** A calculadora do site (só no `cp-public`): a tabela pública e a cotação. */
@Controller('public')
export class PricingController {
  constructor(
    private readonly pricing: PublicPricingService,
    @Inject(PRICING_RATE_LIMITS) private readonly limits: PricingRateLimits,
  ) {}

  /**
   * A tabela vigente sem custos; pode ficar 5 min no CDN (a resposta é a mesma para todo visitante). O cabeçalho é
   * trocado só depois do sucesso: um erro (503 sem tabela, 429) continua `private, no-store` e nunca fica no cache.
   */
  @Get('pricing')
  async catalog(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<PublicPricing> {
    enforceRateLimit(this.limits.pricing, req, res);
    const catalog = await this.pricing.catalog();
    res.setHeader('Cache-Control', PUBLIC_CACHE);
    return catalog;
  }

  @Post('quote')
  @HttpCode(200)
  async quote(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<QuoteResponse | ContactUsResponse> {
    enforceRateLimit(this.limits.quote, req, res);
    const id = (req as Request & { id?: unknown }).id;
    try {
      return await this.pricing.createQuote(body, typeof id === 'string' ? id : undefined);
    } catch (error) {
      if (error instanceof QuoteDailyLimitApiError)
        res.setHeader('Retry-After', String(error.retryAfterSeconds));
      throw error;
    }
  }
}
