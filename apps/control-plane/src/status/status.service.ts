import {
  BadRequestException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { AccessStore } from '../access/access-store.js';
import {
  signStatusCookie,
  STATUS_TOKEN_TTL_MS,
  type StatusTokenKind,
  statusTokenValueSchema,
} from '../access/status-token.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import type { EnvKey } from '../common/config/env.schema.js';
import { ApiError } from '../common/http/api-error.js';
import { isUlid } from '../common/ulid.js';
import {
  describeStripeError,
  isStripeNotFound,
  STRIPE_CLIENT,
  type StripeClient,
} from '../stripe/stripe-client.js';
import { TenantStore } from '../tenants/tenant-store.js';
import type { TenantRecord } from '../tenants/tenant.schema.js';
import {
  REVEAL_GATEWAY,
  type RevealedAccessView,
  type RevealFailureCode,
  type RevealGateway,
  RevealGatewayError,
} from './reveal-gateway.js';
import { buildStatusView, type StatusView } from './status-view.js';

/** `POST /v1/public/status/claim`: o id da sessão do Checkout que veio na URL de sucesso (`?cs=`). */
export const claimRequestSchema = z.strictObject({
  sessionId: z
    .string()
    .max(255)
    .regex(/^cs_(test|live)_[A-Za-z0-9]{8,240}$/),
});

/** `POST /v1/public/status/reveal`: vazio (vale o cookie) ou com o valor do link do e-mail do plano B. */
export const revealRequestSchema = z.strictObject({ token: statusTokenValueSchema.optional() });

export interface RequestContext {
  requestId?: string;
}

export interface ClaimResult {
  view: StatusView;
  /** O valor assinado do cookie `__session`. */
  cookie: string;
  maxAgeMs: number;
}

const UNAVAILABLE = (): ApiError =>
  new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'Página de status indisponível', 'status_unavailable');

/** As mensagens que o site pode mostrar; o código decide o texto da página. */
const REVEAL_FAILURES: Readonly<Record<RevealFailureCode, () => Error>> = {
  not_found: () => new NotFoundException(),
  already_revealed: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'A senha já foi mostrada. Use "Esqueci minha senha" no painel.',
      'already_revealed',
    ),
  reveal_not_available: () =>
    new ApiError(HttpStatus.CONFLICT, 'O acesso ainda não está disponível.', 'reveal_not_available'),
  password_expired: () =>
    new ApiError(
      HttpStatus.GONE,
      'A senha temporária venceu. Fale com o suporte para gerar outra.',
      'password_expired',
    ),
  reveal_unavailable: () =>
    new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'Revelação indisponível', 'reveal_unavailable'),
};

/** Variáveis sem as quais a página de status não funciona: o cookie é assinado com a `COOKIE_KEY`. */
export const STATUS_REQUIRED = ['COOKIE_KEY'] as const satisfies readonly EnvKey[];

/**
 * Página de status (plano §2.3, §4c e §4g), no cp-public:
 * - `claim` troca o `cs_` da URL de sucesso por um cookie: relê a sessão na Stripe (completa, do mesmo modo, nossa:
 *   `metadata.tenantId` igual ao `client_reference_id`), confere que o cliente (se já existe) é dessa sessão, não foi
 *   excluído e não teve a senha revelada (depois da revelação o `cs_` não vale mais), e cria o `statusTokens` do tipo
 *   `cookie` (7 dias). Tudo que não confere é o mesmo 404;
 * - `status` devolve a visão pública do cliente do cookie; o link do boleto é lido na hora na Stripe;
 * - `reveal` passa a credencial (cookie ou link do e-mail) ao cp-worker, que marca, lê, enfileira a destruição e
 *   devolve a senha. O cp-public não tem acesso ao segredo.
 */
@Injectable()
export class StatusService implements OnModuleInit {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(STRIPE_CLIENT) private readonly stripe: StripeClient | null,
    @Inject(REVEAL_GATEWAY) private readonly gateway: RevealGateway,
    private readonly access: AccessStore,
    private readonly tenants: TenantStore,
    @InjectPinoLogger(StatusService.name) private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    const missing = STATUS_REQUIRED.filter((key) => this.config[key] === undefined);
    if (missing.length === 0) return;
    this.logger.warn(
      { event: 'status_unconfigured', missing },
      'página de status sem configuração: as rotas /v1/public/status* respondem 503',
    );
  }

  /** A chave do cookie; sem ela, 503. */
  cookieKey(): string {
    const key = this.config.COOKIE_KEY;
    if (key === undefined) throw UNAVAILABLE();
    return key;
  }

  async claim(body: unknown, context: RequestContext = {}): Promise<ClaimResult> {
    const key = this.cookieKey();
    if (this.stripe === null) throw UNAVAILABLE();
    const parsed = claimRequestSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException();
    let session;
    try {
      session = await this.stripe.retrieveCheckoutSession(parsed.data.sessionId);
    } catch (error) {
      if (isStripeNotFound(error)) throw new NotFoundException();
      this.logger.warn(
        { event: 'status_claim_stripe_failed', stripe: describeStripeError(error) },
        'Stripe falhou',
      );
      throw UNAVAILABLE();
    }
    const tenantId = session.metadata['tenantId'];
    if (
      session.status !== 'complete' ||
      session.mode !== 'subscription' ||
      session.livemode !== this.config.STRIPE_LIVE ||
      tenantId === undefined ||
      !isUlid(tenantId) ||
      session.clientReferenceId !== tenantId
    ) {
      throw new NotFoundException();
    }
    const tenant = await this.tenants.get(tenantId);
    if (
      tenant !== undefined &&
      (tenant.state === 'deleted' ||
        tenant.consent?.checkoutSessionId !== session.id ||
        tenant.access?.passwordRevealedAt !== undefined)
    ) {
      throw new NotFoundException();
    }
    const minted = await this.access.mint(tenantId, 'cookie', `customer:${tenantId}`, context);
    return {
      view: await this.view(tenant),
      cookie: signStatusCookie(minted.value, key),
      maxAgeMs: STATUS_TOKEN_TTL_MS.cookie,
    };
  }

  /** A visão do cliente do cookie (o valor já conferido pela assinatura), ou 404. */
  async status(value: string | undefined): Promise<StatusView> {
    if (value === undefined) throw new NotFoundException();
    const credential = await this.access.resolve(value, 'cookie');
    if (credential === undefined) throw new NotFoundException();
    const tenant = await this.tenants.get(credential.tenantId);
    if (tenant?.state === 'deleted') throw new NotFoundException();
    return this.view(tenant);
  }

  /**
   * A revelação: o link do e-mail (no corpo) vale mais que o cookie; sem nenhum dos dois, 404. A credencial é
   * conferida aqui (sem acordar o worker por um valor qualquer) e de novo na transação do worker.
   */
  async reveal(
    body: unknown,
    cookieValue: string | undefined,
    context: RequestContext = {},
  ): Promise<RevealedAccessView> {
    this.cookieKey();
    const parsed = revealRequestSchema.safeParse(body ?? {});
    if (!parsed.success) throw new NotFoundException();
    const kind: StatusTokenKind = parsed.data.token === undefined ? 'cookie' : 'email_reveal';
    const value = parsed.data.token ?? cookieValue;
    if (value === undefined || (await this.access.resolve(value, kind)) === undefined) {
      throw new NotFoundException();
    }
    try {
      return await this.gateway.reveal({ kind, token: value, requestId: context.requestId });
    } catch (error) {
      if (error instanceof RevealGatewayError) throw REVEAL_FAILURES[error.code]();
      this.logger.error(
        { event: 'reveal_worker_failed', err: error },
        'o cp-worker não respondeu à revelação',
      );
      throw REVEAL_FAILURES.reveal_unavailable();
    }
  }

  private async view(tenant: TenantRecord | undefined): Promise<StatusView> {
    return buildStatusView(tenant, this.config, await this.boletoUrl(tenant));
  }

  /**
   * O boleto em aberto de quem está em `pending` com boleto: a página do boleto, ou a da fatura se a do boleto não
   * vier. Lido na hora, nunca guardado; uma falha da Stripe só tira o link da resposta.
   */
  private async boletoUrl(tenant: TenantRecord | undefined): Promise<string | undefined> {
    const stripe = this.stripe;
    if (stripe === null || tenant?.state !== 'pending' || tenant.stripe?.paymentMethodType !== 'boleto') {
      return undefined;
    }
    try {
      let invoiceId = tenant.stripe.latestInvoiceId;
      if (invoiceId === undefined && tenant.stripe.subscriptionId !== undefined) {
        invoiceId =
          (await stripe.retrieveSubscription(tenant.stripe.subscriptionId)).latestInvoiceId ?? undefined;
      }
      if (invoiceId === undefined) return undefined;
      const links = await stripe.retrieveBoletoLinks(invoiceId);
      if (links.invoiceStatus !== 'open') return undefined;
      const url = links.voucherUrl ?? links.invoiceUrl;
      return url !== null && z.url({ protocol: /^https$/ }).safeParse(url).success ? url : undefined;
    } catch (error) {
      this.logger.warn(
        { event: 'status_boleto_unavailable', tenantId: tenant.id, stripe: describeStripeError(error) },
        'link do boleto indisponível',
      );
      return undefined;
    }
  }
}
