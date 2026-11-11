import { HttpStatus, Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { CLOCK, type Clock } from '../common/clock.js';
import { ApiError } from '../common/http/api-error.js';
import { equalValues } from '../firestore/document-store.js';
import { LegalTextStore } from '../legal/legal-store.js';
import { LEGAL_KINDS } from '../legal/legal.schema.js';
import { LegacyVersionError, PricingTableStore } from '../pricing/pricing-store.js';
import type { QuoteLineItem } from '../pricing/pricing.schema.js';
import { isSoldOnline, planNotSoldOnline } from '../pricing/public-pricing.js';
import { type StoredQuote, QuoteStore } from '../pricing/quote-store.js';
import { quote } from '../pricing/quote.js';
import {
  type CheckoutSessionParams,
  describeStripeError,
  STRIPE_CLIENT,
  type StripeClient,
  type StripePrice,
} from '../stripe/stripe-client.js';
import { isReservableSlug } from '../tenants/tenant.schema.js';
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

/** As versões dos textos legais que o cliente aceitou: as vigentes, publicadas pelo console. */
interface AcceptedVersions {
  terms: string;
  privacy: string;
  dpa: string;
}

/** A cotação venceu, sumiu ou não confere com a tabela: o site pede uma cotação nova e mostra o preço antes de pagar. */
const QUOTE_OUTDATED = (): ApiError =>
  new ApiError(
    HttpStatus.CONFLICT,
    'O preço desta cotação não vale mais. Calcule o preço de novo para continuar.',
    'quote_outdated',
  );

export interface RequestContext {
  requestId?: string;
}

/**
 * Checkout (plano §4a, com o preço por GB/dia): valida o pedido, confere as versões do aceite com as dos textos legais
 * publicados no console, relê a cotação gravada (`quoteId`) e a recalcula pela tabela da versão dela, confere na
 * Stripe cada preço dos itens (ativo, em BRL, mensal
 * ou avulso, com o valor da tabela), reserva o subdomínio dentro do teto diário e abre a sessão do Checkout hospedado
 * com um item por componente (na Plataforma: a base, quantidade 1, e o GB/dia adicional, com a quantidade contratada
 * acima do incluído). O site nunca manda preço. Se a Stripe falhar depois da reserva, a reserva é desfeita na
 * hora (`released`); se nem isso for possível, ela vence sozinha em 2 h 30. Nenhum log leva e-mail, CNPJ, razão social,
 * valores ou a chave da Stripe: só o `tenantId`, o slug, o plano, o porte, a versão da tabela, a cotação e, de um erro
 * da Stripe, tipo, código, status e id.
 */
@Injectable()
export class CheckoutService implements OnModuleInit {
  private readonly prices = new Map<string, { price: StripePrice; fetchedAt: number }>();

  constructor(
    @Inject(CHECKOUT_SETTINGS) private readonly settings: CheckoutSettingsResult,
    @Inject(STRIPE_CLIENT) private readonly stripe: StripeClient | null,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly store: CheckoutStore,
    private readonly quotes: QuoteStore,
    private readonly tables: PricingTableStore,
    private readonly legal: LegalTextStore,
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
    const versions = await this.acceptedVersions();
    if (
      request.consent.terms !== versions.terms ||
      request.consent.privacy !== versions.privacy ||
      request.consent.dpa !== versions.dpa
    ) {
      throw new ApiError(
        HttpStatus.CONFLICT,
        'Os termos foram atualizados. Recarregue a página e aceite a versão vigente.',
        'terms_outdated',
      );
    }
    const quoted = await this.resolveQuote(request.quoteId);
    const prices = await this.resolvePrices(stripe, settings, quoted);

    const reservation = await this.reserve(request, versions, quoted, context);
    const params = this.sessionParams(request, settings, versions, quoted, prices, reservation);
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
        size: reservation.size,
        priceTableVersion: reservation.priceTableVersion,
        quoteId: reservation.quoteId,
        lineItems: params.line_items?.length ?? 0,
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

  /**
   * As versões vigentes dos três textos legais (as publicadas mais recentes, no Firestore). Sem uma publicada de algum
   * deles, o checkout fica indisponível (503), como sem a configuração: ninguém compra sem um texto para aceitar. O log
   * diz só quais faltam.
   */
  private async acceptedVersions(): Promise<AcceptedVersions> {
    const current = await this.legal.currentVersions();
    const { terms, privacy, dpa } = current;
    if (terms === undefined || privacy === undefined || dpa === undefined) {
      this.logger.error(
        {
          event: 'checkout_legal_texts_missing',
          missing: LEGAL_KINDS.filter((kind) => current[kind] === undefined),
        },
        'checkout indisponível: falta publicar texto legal no console (Termos, Privacidade e DPA)',
      );
      throw UNAVAILABLE();
    }
    return { terms, privacy, dpa };
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
   * A cotação gravada, válida e recalculada pela tabela da versão dela (publicada ou já aposentada: o preço mostrado é
   * honrado até a cotação vencer). Vencida, inexistente ou diferente do recálculo (tabela apagada, documento
   * adulterado, ou do modelo de preço anterior): 409 `quote_outdated`, e o site pede outra. De um plano ou lugar que o
   * site não vende (a cotação de referência de um contrato direto, gravada pelo console na mesma coleção): 422
   * `plan_not_sold_online`, antes de qualquer outra conferência, e nada é reservado.
   */
  private async resolveQuote(quoteId: string): Promise<StoredQuote> {
    const stored = await this.quotes.getValid(quoteId);
    if (stored === undefined) throw QUOTE_OUTDATED();
    if (!isSoldOnline(stored.configuration)) {
      this.logger.warn(
        {
          event: 'checkout_plan_refused',
          quoteId,
          plan: stored.configuration.plan,
          mode: stored.configuration.mode,
        },
        'checkout com uma cotação de um plano que o site não vende',
      );
      throw planNotSoldOnline();
    }
    const table = await this.tables.get(stored.priceTableVersion).catch((error: unknown) => {
      if (error instanceof LegacyVersionError) return undefined;
      throw error;
    });
    const { plan, gbDay, mode } = stored.configuration;
    const outcome =
      table === undefined || table.status === 'draft'
        ? undefined
        : quote({ plan, gbDay, mode }, table.content);
    const matches =
      outcome?.kind === 'quote' &&
      equalValues(outcome.quote.configuration, stored.configuration) &&
      equalValues(outcome.quote.lineItems, stored.lineItems) &&
      equalValues(outcome.quote.limits, stored.limits) &&
      outcome.quote.monthlyTotal === stored.monthlyTotal &&
      outcome.quote.setupTotal === stored.setupTotal;
    if (!matches) {
      this.logger.error(
        { event: 'checkout_quote_mismatch', quoteId, priceTableVersion: stored.priceTableVersion },
        'a cotação gravada não confere com o recálculo pela tabela da versão dela',
      );
      throw QUOTE_OUTDATED();
    }
    return stored;
  }

  /**
   * Os preços dos itens pelo `lookup_key`, guardados por alguns minutos. Cada um precisa estar ativo, em reais, no
   * modo da chave, com o valor unitário da tabela e, conforme o item, recorrente mensal ou avulso (a implantação); a
   * soma de valor × quantidade precisa dar o total da cotação. Qualquer outra coisa é configuração errada na Stripe:
   * o checkout fica indisponível e o log diz qual preço (só o `lookup_key`, o id e o problema).
   */
  private async resolvePrices(
    stripe: StripeClient,
    settings: CheckoutSettings,
    quoted: StoredQuote,
  ): Promise<Map<string, StripePrice>> {
    const now = this.clock.now().getTime();
    const resolved = new Map<string, StripePrice>();
    /** Só os preços lidos agora da Stripe: um preço servido do cache mantém a hora da leitura original. */
    const fetched = new Map<string, StripePrice>();
    const missing: string[] = [];
    for (const item of quoted.lineItems) {
      const cached = this.prices.get(item.lookupKey);
      // Um relógio que voltou também invalida o cache (só vale o que foi lido nos últimos minutos, para a frente).
      const fresh =
        cached !== undefined && now >= cached.fetchedAt && now - cached.fetchedAt < PRICE_CACHE_MS;
      if (fresh) resolved.set(item.lookupKey, cached.price);
      else missing.push(item.lookupKey);
    }
    if (missing.length > 0) {
      let found: StripePrice[];
      try {
        found = await stripe.findPricesByLookupKeys(missing);
      } catch (error) {
        this.logger.error(
          { event: 'checkout_price_lookup_failed', lookupKeys: missing, stripe: describeStripeError(error) },
          'a Stripe não respondeu a consulta dos preços',
        );
        throw new ApiError(HttpStatus.BAD_GATEWAY, 'Falha ao abrir o pagamento', 'checkout_failed');
      }
      for (const price of found) {
        if (price.lookupKey === null || !missing.includes(price.lookupKey)) continue;
        resolved.set(price.lookupKey, price);
        fetched.set(price.lookupKey, price);
      }
    }

    let sum = 0;
    for (const item of quoted.lineItems) {
      const price = resolved.get(item.lookupKey);
      const problem = priceProblem(price, item, settings.livemode);
      if (problem !== undefined) {
        this.logger.error(
          { event: 'checkout_price_invalid', lookupKey: item.lookupKey, priceId: price?.id, problem },
          'preço da cotação ausente ou fora do esperado na Stripe (ativo, em BRL, no modo da chave, com o valor da tabela)',
        );
        throw UNAVAILABLE();
      }
      sum += (price?.unitAmount ?? 0) * item.quantity;
    }
    if (sum !== quoted.monthlyTotal + quoted.setupTotal) {
      this.logger.error(
        { event: 'checkout_price_invalid', quoteId: quoted.quoteId, problem: 'total' },
        'a soma dos preços da Stripe não dá o total da cotação',
      );
      throw UNAVAILABLE();
    }
    // Guarda só o que veio da Stripe agora. Renovar a hora de um preço servido do cache faria um preço muito usado
    // nunca ser relido, e um preço arquivado na Stripe continuaria valendo aqui.
    for (const [key, price] of fetched) this.prices.set(key, { price, fetchedAt: now });
    return resolved;
  }

  private async reserve(
    request: CheckoutRequest,
    versions: AcceptedVersions,
    quoted: StoredQuote,
    context: RequestContext,
  ): Promise<Reservation> {
    try {
      return await this.store.reserve({
        slug: request.slug,
        order: {
          configuration: quoted.configuration,
          limits: quoted.limits,
          pricing: {
            priceTableVersion: quoted.priceTableVersion,
            quoteId: quoted.quoteId,
            monthlyTotal: quoted.monthlyTotal,
            setupTotal: quoted.setupTotal,
          },
          company: { legalName: request.companyName, cnpj: request.cnpj },
          adminEmail: request.adminEmail,
          consent: {
            termsVersion: versions.terms,
            privacyVersion: versions.privacy,
            dpaVersion: versions.dpa,
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

  /**
   * Os parâmetros da sessão (plano §4a), com um item por componente da cotação, na ordem dela: os mensais e, por
   * último, a implantação (avulsa, só na primeira fatura). Os metadados levam a versão da tabela, a cotação, o plano, a
   * franquia contratada em GB/dia, o modo e o porte, para o webhook reconhecer a compra (e, depois, a medição do
   * excedente).
   */
  private sessionParams(
    request: CheckoutRequest,
    settings: CheckoutSettings,
    versions: AcceptedVersions,
    quoted: StoredQuote,
    prices: ReadonlyMap<string, StripePrice>,
    reservation: Reservation,
  ): CheckoutSessionParams {
    const metadata = {
      tenantId: reservation.tenantId,
      slug: reservation.slug,
      priceTableVersion: quoted.priceTableVersion,
      quoteId: quoted.quoteId,
      plan: quoted.configuration.plan,
      gbDay: String(quoted.configuration.gbDay),
      mode: quoted.configuration.mode,
      size: quoted.configuration.size,
      termsVersion: versions.terms,
      privacyVersion: versions.privacy,
      dpaVersion: versions.dpa,
    };
    const { legalUrls } = settings;
    return {
      mode: 'subscription',
      line_items: quoted.lineItems.map((item) => ({
        price: prices.get(item.lookupKey)?.id ?? '',
        quantity: item.quantity,
      })),
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

/** O que há de errado com o preço da Stripe para este item; `undefined` quando ele serve. */
function priceProblem(
  price: StripePrice | undefined,
  item: QuoteLineItem,
  livemode: boolean,
): string | undefined {
  if (price === undefined) return 'missing';
  if (!price.active) return 'inactive';
  if (price.currency !== 'brl') return 'currency';
  if (price.livemode !== livemode) return 'livemode';
  if (price.unitAmount !== item.unitAmount) return 'amount';
  if (item.recurring) {
    if (price.type !== 'recurring' || price.interval !== 'month' || price.intervalCount !== 1)
      return 'interval';
  } else if (price.type !== 'one_time') {
    return 'type';
  }
  return undefined;
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
