import Stripe from 'stripe';

/**
 * Versão da API da Stripe, fixada: a mesma do SDK `stripe@23.1.0` (os tipos do SDK só descrevem ela). Trocar o SDK
 * exige trocar aqui, e o `tsc` acusa se as duas divergirem.
 */
export const STRIPE_API_VERSION = '2026-10-28.endive' satisfies Stripe.LatestApiVersion;

/**
 * Prazo por tentativa e uma nova tentativa (o SDK põe chave de idempotência nas repetições). O padrão do SDK (80 s)
 * passaria do prazo do rewrite do Hosting (60 s); com isto, o pior caso fica em cerca de 20 s.
 */
const STRIPE_TIMEOUT_MS = 10_000;
const STRIPE_MAX_NETWORK_RETRIES = 1;

/** Onde fica a API da Stripe. Só os testes mudam (servidor falso em 127.0.0.1); em produção, o padrão do SDK. */
export interface StripeApiOptions {
  host?: string;
  port?: number;
  protocol?: 'http' | 'https';
}

/** Preço como o checkout precisa dele (só o que é conferido antes de usar). */
export interface StripePrice {
  id: string;
  lookupKey: string | null;
  active: boolean;
  type: string;
  currency: string;
  unitAmount: number | null;
  interval: string | null;
  intervalCount: number | null;
  livemode: boolean;
}

export interface CreatedCheckoutSession {
  id: string;
  url: string;
  livemode: boolean;
  /** Os meios de pagamento que a sessão vai oferecer, como a Stripe decidiu (cartão e boleto ligados no Dashboard). */
  paymentMethodTypes: string[];
}

export type CheckoutSessionParams = Stripe.Checkout.SessionCreateParams;

/**
 * O pouco do SDK da Stripe que o plano de controle usa, atrás de uma interface (o CP-04 acrescenta a releitura de
 * sessões, assinaturas e faturas). A implementação é o SDK oficial; nos testes, o mesmo SDK aponta para um servidor
 * falso em 127.0.0.1, que confere os parâmetros exatos de cada chamada.
 */
export interface StripeClient {
  /** O preço com este `lookup_key`, ativo ou não; `undefined` se nenhum tiver a chave. */
  findPriceByLookupKey(lookupKey: string): Promise<StripePrice | undefined>;
  createCheckoutSession(
    params: CheckoutSessionParams,
    idempotencyKey: string,
  ): Promise<CreatedCheckoutSession>;
}

export const STRIPE_CLIENT = Symbol('STRIPE_CLIENT');

/** A sessão voltou sem URL (não acontece no Checkout hospedado): tratada como falha da Stripe. */
export class StripeResponseError extends Error {
  constructor(readonly reason: string) {
    super(`resposta inesperada da Stripe: ${reason}`);
    this.name = 'StripeResponseError';
  }
}

/**
 * O que um erro da Stripe pode mostrar num log: tipo, código, status HTTP e o id da requisição na Stripe. Nunca a
 * mensagem nem o `raw`: a Stripe repete na mensagem o valor recusado (um e-mail, por exemplo).
 */
export function describeStripeError(error: unknown): Record<string, unknown> {
  if (error instanceof Stripe.errors.StripeError) {
    return {
      type: error.type,
      code: error.code,
      statusCode: error.statusCode,
      stripeRequestId: error.requestId,
    };
  }
  if (error instanceof StripeResponseError) return { type: error.name, reason: error.reason };
  return { type: error instanceof Error ? error.name : typeof error };
}

function toPrice(price: Stripe.Price): StripePrice {
  return {
    id: price.id,
    lookupKey: price.lookup_key,
    active: price.active,
    type: price.type,
    currency: price.currency,
    unitAmount: price.unit_amount,
    interval: price.recurring?.interval ?? null,
    intervalCount: price.recurring?.interval_count ?? null,
    livemode: price.livemode,
  };
}

export class SdkStripeClient implements StripeClient {
  constructor(private readonly stripe: Stripe) {}

  async findPriceByLookupKey(lookupKey: string): Promise<StripePrice | undefined> {
    const prices = await this.stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 });
    const [price] = prices.data;
    return price === undefined ? undefined : toPrice(price);
  }

  async createCheckoutSession(
    params: CheckoutSessionParams,
    idempotencyKey: string,
  ): Promise<CreatedCheckoutSession> {
    const session = await this.stripe.checkout.sessions.create(params, { idempotencyKey });
    if (session.url === null) throw new StripeResponseError('sessão sem url');
    return {
      id: session.id,
      url: session.url,
      livemode: session.livemode,
      paymentMethodTypes: session.payment_method_types,
    };
  }
}

/** O SDK configurado para o plano de controle: versão fixada, prazo curto, sem telemetria. */
export function createStripeSdk(apiKey: string, api: StripeApiOptions = {}): Stripe {
  return new Stripe(apiKey, {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: STRIPE_MAX_NETWORK_RETRIES,
    timeout: STRIPE_TIMEOUT_MS,
    telemetry: false,
    appInfo: { name: 'verax-control-plane' },
    ...api,
  });
}

export function createStripeClient(apiKey: string, api?: StripeApiOptions): StripeClient {
  return new SdkStripeClient(createStripeSdk(apiKey, api));
}
