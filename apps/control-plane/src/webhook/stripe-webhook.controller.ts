import { Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { StripeWebhookService } from './stripe-webhook.service.js';

function requestIdOf(req: Request): string | undefined {
  const id = (req as Request & { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

/**
 * `POST /v1/stripe/webhook` (plano §2.3), só no `cp-public`. O corpo chega bruto (`Buffer`, `raw-body.ts`), e a
 * resposta de sucesso é sempre `{received: true}`: nada do processamento volta para quem chamou.
 */
@Controller('stripe')
export class StripeWebhookController {
  constructor(private readonly webhook: StripeWebhookService) {}

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async receive(@Req() req: Request): Promise<{ received: true }> {
    await this.webhook.receive(req.body as unknown, req.headers['stripe-signature'], requestIdOf(req));
    return { received: true };
  }
}
