import { Controller, Get, HttpStatus, Inject, Req, Res } from '@nestjs/common';
import { CLOUDFLARE_OAUTH_PANEL_PATH } from '@verax/shared';
import type { Request, Response } from 'express';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { tenantUrls } from '../access/tenant-urls.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { rateLimitKey, type RateLimitRule, TokenBucketLimiter } from '../common/http/rate-limiter.js';
import { TenantStore } from '../tenants/tenant-store.js';
import { parseCallbackQuery } from './callback-query.js';
import {
  type CloudflareOauthSettings,
  cloudflareOauthSettings,
  isSlugReleased,
  isTenantReleased,
} from './cloudflare-oauth-settings.js';

/**
 * Limite por IP, em memória por instância. Um retorno por conexão; a folga é para vários clientes atrás do mesmo NAT e
 * para as saídas do Hosting, que se juntam num balde só enquanto `TRUSTED_PROXIES` não as lista.
 */
export const CLOUDFLARE_CALLBACK_PER_IP: RateLimitRule = { capacity: 120, windowMs: 60 * 60_000 };

export class CloudflareCallbackRateLimits {
  readonly callback: TokenBucketLimiter;

  constructor(clock: Clock) {
    this.callback = new TokenBucketLimiter(CLOUDFLARE_CALLBACK_PER_IP, clock);
  }
}

export const CLOUDFLARE_CALLBACK_RATE_LIMITS = Symbol('CLOUDFLARE_CALLBACK_RATE_LIMITS');

export const CLOUDFLARE_CALLBACK_RATE_LIMITS_PROVIDER = {
  provide: CLOUDFLARE_CALLBACK_RATE_LIMITS,
  useFactory: (clock: Clock) => new CloudflareCallbackRateLimits(clock),
  inject: [CLOCK],
};

function page(message: string): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Verax Control</title></head><body><p>${message}</p></body></html>`;
}

/** Textos fixos: nada do pedido entra na página. */
const REFUSED_PAGE = page(
  'Não foi possível concluir a conexão com o Cloudflare. Volte ao painel do Verax Control e comece de novo.',
);
const RATE_LIMITED_PAGE = page('Muitas tentativas. Tente novamente mais tarde.');
const UNAVAILABLE_PAGE = page(
  'Serviço temporariamente indisponível. Volte ao painel do Verax Control e comece de novo em alguns minutos.',
);

/** A query do pedido, sem o `?`, como chegou. */
function rawQueryOf(url: string): string {
  const start = url.indexOf('?');
  return start < 0 ? '' : url.slice(start + 1);
}

function sendPage(res: Response, status: HttpStatus, html: string): void {
  res.status(status).type('html').send(html);
}

/** Por que o retorno não foi repassado: só vai ao log, nunca à resposta. */
type Refusal = 'disabled' | 'invalid_query' | 'not_released' | 'not_eligible';

type Outcome = { target: string; tenantId: string } | { refusal: Refusal };

/**
 * O retorno do Cloudflare na conexão por OAuth (só no `cp-public`; `packages/shared/src/cloudflare-oauth.ts`): o
 * endereço fixo registrado no app, que devolve o navegador ao painel do cliente. Sem estado e sem segredo: não guarda o
 * código, não o troca, não sabe se a tentativa existe (quem decide é a API do nó, pelo `state` e pela sessão).
 *
 * - O destino é sempre `https://<subdomínio do cliente>.<PANEL_DOMAIN_SUFFIX>/conexao-cloudflare`, montado com o
 *   subdomínio gravado no cliente: nenhum pedaço de URL vem do pedido.
 * - O código vai no fragmento, que não chega a servidor nem ao `Referer`. Resposta 303 sem corpo (um corpo repetiria o
 *   endereço), `no-store` e `no-referrer` (globais, `app.setup.ts`), sem CORS.
 * - Toda recusa é a mesma página, com o mesmo status: subdomínio inexistente, não liberado, na VM do cliente, na célula,
 *   suspenso, recurso desligado ou pedido malformado.
 * - Nada aqui registra a query: o log leva só o motivo e, no sucesso, o id do cliente.
 */
@Controller('public/cloudflare')
export class CloudflareCallbackController {
  private readonly settings: CloudflareOauthSettings | null;

  constructor(
    private readonly tenants: TenantStore,
    @Inject(CLOUDFLARE_CALLBACK_RATE_LIMITS) private readonly limits: CloudflareCallbackRateLimits,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectPinoLogger(CloudflareCallbackController.name) private readonly logger: PinoLogger,
  ) {
    this.settings = cloudflareOauthSettings(config);
  }

  @Get('callback')
  async callback(@Req() req: Request, @Res() res: Response): Promise<void> {
    const decision = this.limits.callback.take(`ip:${rateLimitKey(req.ip)}`);
    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.retryAfterSeconds));
      sendPage(res, HttpStatus.TOO_MANY_REQUESTS, RATE_LIMITED_PAGE);
      return;
    }
    let outcome: Outcome;
    try {
      outcome = await this.resolve(rawQueryOf(req.originalUrl));
    } catch (error) {
      // Só o nome do erro: a mensagem de um erro do banco pode citar o que foi consultado.
      this.logger.error(
        {
          event: 'cloudflare_oauth_callback_failed',
          reason: error instanceof Error ? error.name : 'unknown',
        },
        'o retorno do Cloudflare não pôde ser repassado',
      );
      sendPage(res, HttpStatus.SERVICE_UNAVAILABLE, UNAVAILABLE_PAGE);
      return;
    }
    if ('refusal' in outcome) {
      this.logger.info(
        { event: 'cloudflare_oauth_callback_refused', reason: outcome.refusal },
        'retorno do Cloudflare recusado',
      );
      sendPage(res, HttpStatus.BAD_REQUEST, REFUSED_PAGE);
      return;
    }
    this.logger.info(
      { event: 'cloudflare_oauth_callback', tenantId: outcome.tenantId },
      'retorno do Cloudflare repassado ao painel',
    );
    res.status(HttpStatus.SEE_OTHER).setHeader('Location', outcome.target).end();
  }

  private async resolve(query: string): Promise<Outcome> {
    if (this.settings === null) return { refusal: 'disabled' };
    const callback = parseCallbackQuery(query);
    if (callback === null) return { refusal: 'invalid_query' };
    // Antes do banco: um subdomínio fora da lista não custa leitura e responde igual ao inexistente.
    if (!isSlugReleased(this.settings, callback.slug)) return { refusal: 'not_released' };
    const tenant = await this.tenants.findBySlug(callback.slug);
    if (tenant === undefined || !isTenantReleased(this.settings, tenant)) return { refusal: 'not_eligible' };
    const { panelUrl } = tenantUrls(tenant.slug, this.config);
    return {
      target: `${panelUrl}${CLOUDFLARE_OAUTH_PANEL_PATH}#${callback.fragment}`,
      tenantId: tenant.id,
    };
  }
}
