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

/** Um item cobrado (linha da sessão ou item da assinatura): preço, quantidade e o `lookup_key` do preço. */
export interface StripeItem {
  priceId: string;
  quantity?: number;
  lookupKey?: string;
}

/**
 * As releituras do webhook (CP-04) devolvem só o que decide a transição, em objetos simples: o evento só dispara, e a
 * decisão sai daqui (plano §4b). Nenhum guarda dado de cartão; e-mail e razão social só no `Customer`, que o webhook
 * sincroniza sem levar a log.
 */
export interface CheckoutSessionSnapshot {
  id: string;
  livemode: boolean;
  mode: string;
  status: string | null;
  paymentStatus: string;
  clientReferenceId: string | null;
  metadata: Readonly<Record<string, string>>;
  customerId: string | null;
  subscriptionId: string | null;
  /** `consent.terms_of_service === 'accepted'`: o aceite exigido pelo `consent_collection` (plano §3). */
  termsAccepted: boolean;
  /** As linhas da sessão (releitura com `expand: ['line_items']`). */
  lineItems: StripeItem[];
}

export interface SubscriptionSnapshot {
  id: string;
  livemode: boolean;
  status: string;
  customerId: string | null;
  metadata: Readonly<Record<string, string>>;
  cancelAt: Date | null;
  /** O maior fim de período entre os itens (na API fixada, o período é de cada item). */
  currentPeriodEnd: Date | null;
  latestInvoiceId: string | null;
  items: StripeItem[];
  /** Tipo do meio de pagamento padrão (`card`, `boleto`), quando a Stripe o devolve expandido. */
  defaultPaymentMethodType: string | null;
}

export interface InvoiceSnapshot {
  id: string;
  livemode: boolean;
  status: string | null;
  billingReason: string | null;
  customerId: string | null;
  subscriptionId: string | null;
  /** Retrato dos metadados da assinatura na finalização da fatura (`tenantId`, `slug` do checkout). */
  subscriptionMetadata: Readonly<Record<string, string>>;
  amountPaid: number;
  currency: string;
  paidAt: Date | null;
  /** Período do serviço cobrado: o das linhas da fatura. */
  periodStart: Date | null;
  periodEnd: Date | null;
  hostedInvoiceUrl: string | null;
}

export interface ChargeSnapshot {
  id: string;
  livemode: boolean;
  customerId: string | null;
  amount: number;
  amountRefunded: number;
  refunded: boolean;
  created: Date;
}

/** Contestação ou alerta de fraude: o que importa é de quem é a cobrança. */
export interface PaymentRiskSnapshot {
  id: string;
  livemode: boolean;
  chargeId: string | null;
  customerId: string | null;
}

export interface CustomerSnapshot {
  id: string;
  livemode: boolean;
  deleted: boolean;
  email: string | null;
  /** O nome da empresa (`business_name`, o que o Checkout coleta) ou, sem ele, o `name`. */
  businessName: string | null;
}

export type TaxIdResult = 'created' | 'exists';

/**
 * Faturas que ainda são dívida: `open` (a cobrar, inclusive o boleto emitido e não pago) e `uncollectible` (marcada
 * como incobrável, mas que o cliente ainda pode pagar). `draft` ainda não venceu; `void` foi anulada.
 */
export const OUTSTANDING_INVOICE_STATUSES = ['open', 'uncollectible'] as const;

/**
 * O pouco do SDK da Stripe que o plano de controle usa, atrás de uma interface. A implementação é o SDK oficial; nos
 * testes, o mesmo SDK aponta para um servidor falso em 127.0.0.1, que confere os parâmetros exatos de cada chamada.
 */
export interface StripeClient {
  /** O preço com este `lookup_key`, ativo ou não; `undefined` se nenhum tiver a chave. */
  findPriceByLookupKey(lookupKey: string): Promise<StripePrice | undefined>;
  createCheckoutSession(
    params: CheckoutSessionParams,
    idempotencyKey: string,
  ): Promise<CreatedCheckoutSession>;
  retrieveCheckoutSession(id: string): Promise<CheckoutSessionSnapshot>;
  retrieveSubscription(id: string): Promise<SubscriptionSnapshot>;
  retrieveInvoice(id: string): Promise<InvoiceSnapshot>;
  /**
   * A assinatura ainda deve alguma fatura (`open` ou `uncollectible`)? É o que decide se uma fatura paga quita a
   * inadimplência: ela prova só que aquela fatura foi paga, não que não há outra em aberto.
   */
  hasOutstandingInvoices(subscriptionId: string): Promise<boolean>;
  retrieveCharge(id: string): Promise<ChargeSnapshot>;
  retrieveDispute(id: string): Promise<PaymentRiskSnapshot>;
  retrieveEarlyFraudWarning(id: string): Promise<PaymentRiskSnapshot>;
  retrieveCustomer(id: string): Promise<CustomerSnapshot>;
  /** Cancela a assinatura na hora (sem esperar o fim do período). */
  cancelSubscription(id: string, idempotencyKey: string): Promise<SubscriptionSnapshot>;
  /** Grava o ID fiscal no Customer, se ainda não houver um igual (`exists` quando já havia). */
  ensureTaxId(
    customerId: string,
    taxId: { type: 'br_cnpj'; value: string },
    idempotencyKey: string,
  ): Promise<TaxIdResult>;
  /**
   * O boleto de uma fatura, para a página de status de quem pagou com boleto (plano §4g): a página do boleto
   * (`hosted_voucher_url` do PaymentIntent, pela expansão dos pagamentos da fatura) e a da fatura. Lidas na hora e
   * nunca guardadas. Exige leitura de Invoices e de PaymentIntents na chave restrita.
   */
  retrieveBoletoLinks(invoiceId: string): Promise<BoletoLinks>;
}

/** O que a página de status mostra de um boleto em aberto. */
export interface BoletoLinks {
  invoiceStatus: string | null;
  voucherUrl: string | null;
  invoiceUrl: string | null;
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

/** A Stripe recusou o pedido em si (400): repetir não muda nada. */
export function isStripeInvalidRequest(error: unknown): boolean {
  return error instanceof Stripe.errors.StripeError && error.statusCode === 400;
}

/** O objeto não existe na conta da chave (404): repetir não muda nada. */
export function isStripeNotFound(error: unknown): boolean {
  return error instanceof Stripe.errors.StripeError && error.statusCode === 404;
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

/** Id de um campo que a Stripe devolve como id ou como objeto expandido. */
function idOf(value: string | { id: string } | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : value.id;
}

function fromUnix(seconds: number | null | undefined): Date | null {
  return typeof seconds === 'number' ? new Date(seconds * 1000) : null;
}

function toItem(price: Stripe.Price | null | undefined, quantity: number | null | undefined): StripeItem[] {
  if (price === null || price === undefined) return [];
  return [
    {
      priceId: price.id,
      ...(typeof quantity === 'number' ? { quantity } : {}),
      ...(price.lookup_key === null ? {} : { lookupKey: price.lookup_key }),
    },
  ];
}

function metadataOf(metadata: Stripe.Metadata | null | undefined): Record<string, string> {
  return { ...(metadata ?? {}) };
}

function toSubscription(subscription: Stripe.Subscription): SubscriptionSnapshot {
  const ends = subscription.items.data.map((item) => item.current_period_end);
  const method = subscription.default_payment_method;
  return {
    id: subscription.id,
    livemode: subscription.livemode,
    status: subscription.status,
    customerId: idOf(subscription.customer),
    metadata: metadataOf(subscription.metadata),
    cancelAt: fromUnix(subscription.cancel_at),
    currentPeriodEnd: ends.length === 0 ? null : fromUnix(Math.max(...ends)),
    latestInvoiceId: idOf(subscription.latest_invoice),
    items: subscription.items.data.flatMap((item) => toItem(item.price, item.quantity)),
    defaultPaymentMethodType: typeof method === 'object' && method !== null ? method.type : null,
  };
}

function riskOf(
  id: string,
  livemode: boolean,
  charge: string | Stripe.Charge | null | undefined,
): PaymentRiskSnapshot {
  return {
    id,
    livemode,
    chargeId: idOf(charge),
    customerId: typeof charge === 'object' && charge !== null ? idOf(charge.customer) : null,
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

  async retrieveCheckoutSession(id: string): Promise<CheckoutSessionSnapshot> {
    const session = await this.stripe.checkout.sessions.retrieve(id, { expand: ['line_items'] });
    return {
      id: session.id,
      livemode: session.livemode,
      mode: session.mode,
      status: session.status,
      paymentStatus: session.payment_status,
      clientReferenceId: session.client_reference_id,
      metadata: metadataOf(session.metadata),
      customerId: idOf(session.customer),
      subscriptionId: idOf(session.subscription),
      termsAccepted: session.consent?.terms_of_service === 'accepted',
      lineItems: (session.line_items?.data ?? []).flatMap((line) => toItem(line.price, line.quantity)),
    };
  }

  async retrieveSubscription(id: string): Promise<SubscriptionSnapshot> {
    return toSubscription(
      await this.stripe.subscriptions.retrieve(id, { expand: ['default_payment_method'] }),
    );
  }

  async retrieveInvoice(id: string): Promise<InvoiceSnapshot> {
    const invoice = await this.stripe.invoices.retrieve(id);
    const details = invoice.parent?.subscription_details ?? null;
    const starts = invoice.lines.data.map((line) => line.period.start);
    const ends = invoice.lines.data.map((line) => line.period.end);
    return {
      id: invoice.id,
      livemode: invoice.livemode,
      status: invoice.status,
      billingReason: invoice.billing_reason,
      customerId: idOf(invoice.customer),
      subscriptionId: idOf(details?.subscription),
      subscriptionMetadata: metadataOf(details?.metadata),
      amountPaid: invoice.amount_paid,
      currency: invoice.currency,
      paidAt: fromUnix(invoice.status_transitions.paid_at),
      periodStart: starts.length === 0 ? null : fromUnix(Math.min(...starts)),
      periodEnd: ends.length === 0 ? null : fromUnix(Math.max(...ends)),
      hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    };
  }

  async hasOutstandingInvoices(subscriptionId: string): Promise<boolean> {
    for (const status of OUTSTANDING_INVOICE_STATUSES) {
      const page = await this.stripe.invoices.list({ subscription: subscriptionId, status, limit: 1 });
      if (page.data.length > 0) return true;
    }
    return false;
  }

  async retrieveCharge(id: string): Promise<ChargeSnapshot> {
    const charge = await this.stripe.charges.retrieve(id);
    return {
      id: charge.id,
      livemode: charge.livemode,
      customerId: idOf(charge.customer),
      amount: charge.amount,
      amountRefunded: charge.amount_refunded,
      refunded: charge.refunded,
      created: new Date(charge.created * 1000),
    };
  }

  async retrieveDispute(id: string): Promise<PaymentRiskSnapshot> {
    const dispute = await this.stripe.disputes.retrieve(id, { expand: ['charge'] });
    return riskOf(dispute.id, dispute.livemode, dispute.charge);
  }

  async retrieveEarlyFraudWarning(id: string): Promise<PaymentRiskSnapshot> {
    const warning = await this.stripe.radar.earlyFraudWarnings.retrieve(id, { expand: ['charge'] });
    return riskOf(warning.id, warning.livemode, warning.charge);
  }

  async retrieveCustomer(id: string): Promise<CustomerSnapshot> {
    const customer = await this.stripe.customers.retrieve(id);
    if (customer.deleted === true) {
      return { id: customer.id, livemode: false, deleted: true, email: null, businessName: null };
    }
    const business = customer.business_name?.trim();
    return {
      id: customer.id,
      livemode: customer.livemode,
      deleted: false,
      email: customer.email,
      businessName: business !== undefined && business !== '' ? business : (customer.name ?? null),
    };
  }

  async cancelSubscription(id: string, idempotencyKey: string): Promise<SubscriptionSnapshot> {
    return toSubscription(await this.stripe.subscriptions.cancel(id, {}, { idempotencyKey }));
  }

  async ensureTaxId(
    customerId: string,
    taxId: { type: 'br_cnpj'; value: string },
    idempotencyKey: string,
  ): Promise<TaxIdResult> {
    const comparable = (value: string): string => value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const existing = await this.stripe.customers.listTaxIds(customerId, { limit: 100 });
    if (
      existing.data.some(
        (current) => current.type === taxId.type && comparable(current.value) === comparable(taxId.value),
      )
    ) {
      return 'exists';
    }
    await this.stripe.customers.createTaxId(customerId, taxId, { idempotencyKey });
    return 'created';
  }

  async retrieveBoletoLinks(invoiceId: string): Promise<BoletoLinks> {
    const invoice = await this.stripe.invoices.retrieve(invoiceId, {
      expand: ['payments.data.payment.payment_intent'],
    });
    const voucherUrl =
      (invoice.payments?.data ?? [])
        .map((payment) => payment.payment.payment_intent)
        .map((intent) =>
          typeof intent === 'object' && intent !== null
            ? (intent.next_action?.boleto_display_details?.hosted_voucher_url ?? null)
            : null,
        )
        .find((url) => url !== null) ?? null;
    return { invoiceStatus: invoice.status, voucherUrl, invoiceUrl: invoice.hosted_invoice_url ?? null };
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
