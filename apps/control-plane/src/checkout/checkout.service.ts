import { HttpStatus, Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { CLOCK, type Clock } from '../common/clock.js';
import { ApiError } from '../common/http/api-error.js';
import {
  type CheckoutSessionParams,
  describeStripeError,
  STRIPE_CLIENT,
  type StripeClient,
  type StripePrice,
} from '../stripe/stripe-client.js';
import { isReservableSlug, type PlanId } from '../tenants/tenant.schema.js';
import {
  CHECKOUT_SETTINGS,
  type CheckoutSettings,
  type CheckoutSettingsResult,
} from './checkout-settings.js';
import {
  CheckoutStore,
  DailyLimitReachedError,
  type Reservation,
  SlugUnavailableError,
} from './checkout-store.js';
import {
  CHECKOUT_FIELDS,
  type CheckoutRequest,
  checkoutRequestSchema,
  type CheckoutResponse,
} from './checkout.schema.js';

/** A sessão do Checkout expira em 2 h (faixa da Stripe: 30 min a 24 h), antes da reserva de 2 h 30. */
export const CHECKOUT_SESSION_TTL_SECONDS = 2 * 60 * 60;
/** Por quanto tempo um preço lido da Stripe vale sem nova consulta. */
const PRICE_CACHE_MS = 5 * 60_000;
/** Meios de pagamento do checkout (decisão 2 do plano): cartão e boleto. */
const PAYMENT_METHODS = ['card', 'boleto'] as const;
/** Validade do boleto, em dias corridos (plano §4a). */
const BOLETO_EXPIRES_AFTER_DAYS = 3;

/** Erros que o site trata pelo código (`code`), com a mensagem em português. */
const UNAVAILABLE = (): ApiError =>
  new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'Checkout indisponível', 'checkout_unavailable');

export interface RequestContext {
  requestId?: string;
}

/**
 * Checkout (plano §4a): valida o pedido, confere as versões do aceite, reserva o subdomínio dentro do teto diário e
 * abre a sessão do Checkout hospedado da Stripe. Se a Stripe falhar depois da reserva, a reserva é desfeita na hora
 * (`released`); se nem isso for possível, ela vence sozinha em 2 h 30. Nenhum log leva e-mail, CNPJ, razão social ou
 * a chave da Stripe: só o `tenantId`, o slug, o plano e, de um erro da Stripe, tipo, código, status e id.
 */
@Injectable()
export class CheckoutService implements OnModuleInit {
  private readonly prices = new Map<string, { price: StripePrice; fetchedAt: number }>();

  constructor(
    @Inject(CHECKOUT_SETTINGS) private readonly settings: CheckoutSettingsResult,
    @Inject(STRIPE_CLIENT) private readonly stripe: StripeClient | null,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly store: CheckoutStore,
    @InjectPinoLogger(CheckoutService.name) private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    if (!this.settings.ready) {
      // Só os nomes das variáveis; o serviço sobe e o checkout responde 503 até a configuração ficar completa.
      this.logger.warn(
        { event: 'checkout_unconfigured', missing: this.settings.missing },
        'checkout desligado: configuração incompleta (o checkout responde 503 até ela ser preenchida)',
      );
    }
  }

  isSlugAvailable(slug: string): Promise<boolean> {
    return this.store.isSlugAvailable(slug);
  }

  async createSession(body: unknown, context: RequestContext = {}): Promise<CheckoutResponse> {
    const { settings, stripe } = this.requireReady();
    const request = this.parse(body);
    if (!isReservableSlug(request.slug)) throw slugUnavailable();
    if (
      request.consent.terms !== settings.versions.terms ||
      request.consent.privacy !== settings.versions.privacy ||
      request.consent.dpa !== settings.versions.dpa
    ) {
      throw new ApiError(
        HttpStatus.CONFLICT,
        'Os termos foram atualizados. Recarregue a página e aceite a versão vigente.',
        'terms_outdated',
      );
    }
    const price = await this.resolvePrice(stripe, settings, request.plan);

    const reservation = await this.reserve(request, settings, context);
    const params = this.sessionParams(request, settings, price, reservation);
    let session;
    try {
      session = await stripe.createCheckoutSession(params, `checkout-session-${reservation.tenantId}`);
    } catch (error) {
      this.logger.error(
        {
          event: 'checkout_session_failed',
          tenantId: reservation.tenantId,
          slug: reservation.slug,
          stripe: describeStripeError(error),
        },
        'a Stripe recusou ou não respondeu a criação da sessão; desfazendo a reserva',
      );
      await this.releaseQuietly(reservation, context);
      throw new ApiError(HttpStatus.BAD_GATEWAY, 'Falha ao abrir o pagamento', 'checkout_failed');
    }
    const sessionExpiresAt = new Date((params.expires_at ?? 0) * 1000);
    try {
      await this.store.attachSession(
        reservation,
        { id: session.id, livemode: session.livemode, expiresAt: sessionExpiresAt },
        context.requestId,
      );
    } catch (error) {
      // Sem a sessão gravada na reserva, o `checkout.session.completed` não a reconheceria: a URL não sai daqui. A
      // sessão órfã expira sozinha em 2 h sem que ninguém a tenha visto.
      this.logger.error(
        {
          event: 'checkout_session_unrecorded',
          tenantId: reservation.tenantId,
          slug: reservation.slug,
          err: error,
        },
        'sessão criada mas não registrada na reserva; a URL não foi entregue',
      );
      await this.releaseQuietly(reservation, context);
      throw new ApiError(HttpStatus.BAD_GATEWAY, 'Falha ao abrir o pagamento', 'checkout_failed');
    }
    const missingMethods = PAYMENT_METHODS.filter((method) => !session.paymentMethodTypes.includes(method));
    if (missingMethods.length > 0) {
      // O Checkout só oferece o que está ligado no Dashboard (plano §9, item 2). A compra segue; o aviso é para a Verax.
      this.logger.warn(
        {
          event: 'checkout_payment_methods_missing',
          tenantId: reservation.tenantId,
          missing: missingMethods,
        },
        'a sessão não oferece todos os meios de pagamento do plano: confira o Dashboard da Stripe',
      );
    }
    this.logger.info(
      {
        event: 'checkout_session_created',
        tenantId: reservation.tenantId,
        slug: reservation.slug,
        plan: reservation.plan,
        livemode: session.livemode,
      },
      'sessão do Checkout criada',
    );
    return { url: session.url, livemode: session.livemode };
  }

  private requireReady(): { settings: CheckoutSettings; stripe: StripeClient } {
    if (!this.settings.ready || this.stripe === null) throw UNAVAILABLE();
    return { settings: this.settings.settings, stripe: this.stripe };
  }

  /** Validação estrita; o erro cita só os nomes dos campos conhecidos, nunca valores nem chaves desconhecidas. */
  private parse(body: unknown): CheckoutRequest {
    const result = checkoutRequestSchema.safeParse(body);
    if (result.success) return result.data;
    const fields = [
      ...new Set(
        result.error.issues
          .map((issue) => issue.path[0])
          .filter((field): field is string => typeof field === 'string' && CHECKOUT_FIELDS.has(field)),
      ),
    ];
    const message =
      fields.length === 0 ? 'Dados do pedido inválidos.' : `Dados do pedido inválidos: ${fields.join(', ')}.`;
    throw new ApiError(HttpStatus.BAD_REQUEST, message, 'invalid_request');
  }

  /**
   * O preço do plano pelo `lookup_key`, guardado por alguns minutos. Precisa ser um preço ativo, recorrente mensal e
   * em reais; qualquer outra coisa é configuração errada na Stripe (o checkout fica indisponível e o log diz qual).
   */
  private async resolvePrice(
    stripe: StripeClient,
    settings: CheckoutSettings,
    plan: PlanId,
  ): Promise<StripePrice> {
    const lookupKey = settings.priceLookupKeys[plan];
    const now = this.clock.now().getTime();
    const cached = this.prices.get(lookupKey);
    if (cached !== undefined && now - cached.fetchedAt < PRICE_CACHE_MS) return cached.price;
    let price: StripePrice | undefined;
    try {
      price = await stripe.findPriceByLookupKey(lookupKey);
    } catch (error) {
      this.logger.error(
        { event: 'checkout_price_lookup_failed', lookupKey, stripe: describeStripeError(error) },
        'a Stripe não respondeu a consulta do preço',
      );
      throw new ApiError(HttpStatus.BAD_GATEWAY, 'Falha ao abrir o pagamento', 'checkout_failed');
    }
    const usable =
      price !== undefined &&
      price.active &&
      price.type === 'recurring' &&
      price.currency === 'brl' &&
      price.interval === 'month' &&
      price.intervalCount === 1 &&
      price.livemode === settings.livemode;
    if (price === undefined || !usable) {
      this.logger.error(
        { event: 'checkout_price_invalid', lookupKey, priceId: price?.id },
        'preço do plano ausente ou fora do esperado na Stripe (ativo, mensal, em BRL, no modo da chave)',
      );
      throw UNAVAILABLE();
    }
    this.prices.set(lookupKey, { price, fetchedAt: now });
    return price;
  }

  private async reserve(
    request: CheckoutRequest,
    settings: CheckoutSettings,
    context: RequestContext,
  ): Promise<Reservation> {
    try {
      return await this.store.reserve({
        slug: request.slug,
        order: {
          plan: request.plan,
          company: { legalName: request.companyName, cnpj: request.cnpj },
          adminEmail: request.adminEmail,
          consent: {
            termsVersion: settings.versions.terms,
            privacyVersion: settings.versions.privacy,
            dpaVersion: settings.versions.dpa,
          },
        },
        requestId: context.requestId,
      });
    } catch (error) {
      if (error instanceof SlugUnavailableError) throw slugUnavailable();
      if (error instanceof DailyLimitReachedError) {
        // A linha que o alerta procura (`event`), sem dado pessoal: pelo logger raiz, que não leva o `req` da
        // requisição (com o IP do cliente); a correlação fica no `requestId`.
        PinoLogger.root.warn(
          {
            event: 'checkout_daily_limit_reached',
            limit: error.limit,
            day: error.day,
            requestId: context.requestId,
            context: CheckoutService.name,
          },
          'teto diário de sessões do Checkout atingido; novas sessões recusadas até o fim do dia (UTC)',
        );
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((error.resetsAt.getTime() - this.clock.now().getTime()) / 1000),
        );
        throw new DailyLimitApiError(retryAfterSeconds);
      }
      throw error;
    }
  }

  /** Os parâmetros da sessão, exatamente os do plano §4a. */
  private sessionParams(
    request: CheckoutRequest,
    settings: CheckoutSettings,
    price: StripePrice,
    reservation: Reservation,
  ): CheckoutSessionParams {
    const metadata = {
      tenantId: reservation.tenantId,
      slug: reservation.slug,
      plan: reservation.plan,
      termsVersion: settings.versions.terms,
      privacyVersion: settings.versions.privacy,
      dpaVersion: settings.versions.dpa,
    };
    const { legalUrls, versions } = settings;
    return {
      mode: 'subscription',
      line_items: [{ price: price.id, quantity: 1 }],
      // `payment_method_types` saiu da API na versão fixada (2026-09-30.endive); `allowed_payment_method_types` é o
      // filtro que a substitui: só cartão e boleto, se estiverem ligados no Dashboard.
      allowed_payment_method_types: [...PAYMENT_METHODS],
      payment_method_options: { boleto: { expires_after_days: BOLETO_EXPIRES_AFTER_DAYS } },
      locale: 'pt-BR',
      customer_email: request.adminEmail,
      billing_address_collection: 'required',
      name_collection: { business: { enabled: true } },
      consent_collection: { terms_of_service: 'required' },
      custom_text: {
        terms_of_service_acceptance: {
          message:
            `Concordo com os [Termos de Uso](${legalUrls.terms}) (versão ${versions.terms}), ` +
            `a [Política de Privacidade](${legalUrls.privacy}) (versão ${versions.privacy}) e o ` +
            `[Acordo de Tratamento de Dados (DPA)](${legalUrls.dpa}) (versão ${versions.dpa}).`,
        },
      },
      allow_promotion_codes: true,
      client_reference_id: reservation.tenantId,
      metadata,
      subscription_data: { metadata },
      expires_at: Math.floor(this.clock.now().getTime() / 1000) + CHECKOUT_SESSION_TTL_SECONDS,
      success_url: settings.successUrl,
      cancel_url: settings.cancelUrl,
    };
  }

  private async releaseQuietly(reservation: Reservation, context: RequestContext): Promise<void> {
    try {
      await this.store.release(reservation, 'stripe_error', context.requestId);
    } catch (error) {
      this.logger.error(
        {
          event: 'checkout_release_failed',
          tenantId: reservation.tenantId,
          slug: reservation.slug,
          err: error,
        },
        'não foi possível desfazer a reserva; ela vence sozinha em 2 h 30',
      );
    }
  }
}

function slugUnavailable(): ApiError {
  return new ApiError(
    HttpStatus.CONFLICT,
    'Este subdomínio não está disponível. Escolha outro.',
    'slug_unavailable',
  );
}

/** 429 do teto diário, com quanto falta para o dia (UTC) virar. */
export class DailyLimitApiError extends ApiError {
  constructor(readonly retryAfterSeconds: number) {
    super(
      HttpStatus.TOO_MANY_REQUESTS,
      'Não foi possível iniciar a compra agora. Tente novamente mais tarde.',
      'checkout_daily_limit',
    );
  }
}
