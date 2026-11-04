import { randomBytes } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { StripeApiOptions } from '../../src/stripe/stripe-client.js';

/** Uma chamada que o SDK fez ao servidor falso: método, caminho, query e corpo (form-encoded) como chegaram. */
export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  form: URLSearchParams;
  headers: IncomingHttpHeaders;
}

export type StripeObject = Record<string, unknown>;

/** Resposta de erro no formato da Stripe, para a próxima chamada a um caminho. */
export interface FakeFailure {
  status: number;
  type: string;
  code?: string;
  message: string;
}

/** Chave da Stripe no formato real, gerada no teste: nenhum valor fixo de chave entra no repositório. */
export function fakeStripeKey(mode: 'test' | 'live' = 'test', kind: 'sk' | 'rk' = 'sk'): string {
  return [kind, mode, randomBytes(12).toString('hex')].join('_');
}

/** Segredo de assinatura de webhook no formato real (`whsec_...`), gerado no teste. */
export function fakeWebhookSigningValue(): string {
  return ['whsec', randomBytes(16).toString('hex')].join('_');
}

/** Pares `[chave, valor]` de um corpo form-encoded, em ordem, para comparar com o esperado. */
export function formEntries(form: URLSearchParams): [string, string][] {
  return [...form.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** `lookup_keys[0]=a&lookup_keys[1]=b` (como o SDK codifica arrays) vira `['a', 'b']`. */
function indexed(params: URLSearchParams, name: string): string[] {
  return [...params.entries()].filter(([key]) => key.startsWith(`${name}[`)).map(([, value]) => value);
}

function unix(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/** Um item cobrado, no formato das fixtures: preço, quantidade e `lookup_key`. */
export interface FakeItem {
  price: string;
  quantity?: number;
  lookupKey?: string;
}

/**
 * A API da Stripe de mentira, em 127.0.0.1 (o SDK oficial aponta para ela com `host`, `port` e `protocol`), com o
 * pouco que o plano de controle usa: preços por `lookup_key`, produto, cupom, código promocional e sessão do Checkout
 * (CP-03); a releitura de sessões, assinaturas, faturas, cobranças, contestações, alertas de fraude e Customers, o
 * cancelamento da assinatura, os IDs fiscais e os endpoints de webhook (CP-04). Grava cada chamada para os testes
 * conferirem os parâmetros exatos que a Stripe receberia. Nenhum objeto tem dado real: ids `*_fake_<n>`.
 */
export class FakeStripe {
  readonly requests: RecordedRequest[] = [];
  readonly prices = new Map<string, StripeObject>();
  readonly products = new Map<string, StripeObject>();
  readonly coupons = new Map<string, StripeObject>();
  readonly promotionCodes = new Map<string, StripeObject>();
  readonly sessions = new Map<string, StripeObject>();
  /** Linhas de cada sessão, devolvidas com `expand: ['line_items']`. */
  readonly sessionLineItems = new Map<string, StripeObject[]>();
  readonly subscriptions = new Map<string, StripeObject>();
  readonly invoices = new Map<string, StripeObject>();
  readonly charges = new Map<string, StripeObject>();
  readonly disputes = new Map<string, StripeObject>();
  readonly earlyFraudWarnings = new Map<string, StripeObject>();
  readonly customers = new Map<string, StripeObject>();
  readonly taxIds = new Map<string, StripeObject[]>();
  readonly webhookEndpoints = new Map<string, StripeObject>();
  /** Falha da próxima chamada a um caminho (`POST /v1/checkout/sessions`, por exemplo). */
  readonly failures = new Map<string, FakeFailure>();
  /** Meios de pagamento "ligados no Dashboard": a sessão oferece a interseção com os permitidos. */
  enabledPaymentMethods: string[] = ['card', 'boleto'];
  /** O segredo de assinatura devolvido na última criação de endpoint (o teste confere aonde ele foi parar). */
  lastWebhookSigningValue: string | undefined;
  private readonly gates = new Map<string, { reached: () => void; released: Promise<void> }>();
  private server: Server | undefined;
  private sequence = 0;

  async start(): Promise<Required<StripeApiOptions>> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    return { host: '127.0.0.1', port, protocol: 'http' };
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server === undefined
        ? resolve()
        : this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  reset(): void {
    this.requests.length = 0;
    for (const map of [
      this.prices,
      this.products,
      this.coupons,
      this.promotionCodes,
      this.sessions,
      this.sessionLineItems,
      this.subscriptions,
      this.invoices,
      this.charges,
      this.disputes,
      this.earlyFraudWarnings,
      this.customers,
      this.taxIds,
      this.webhookEndpoints,
    ])
      map.clear();
    this.failures.clear();
    this.enabledPaymentMethods = ['card', 'boleto'];
    this.lastWebhookSigningValue = undefined;
  }

  /**
   * Segura a próxima resposta a `"<MÉTODO> <caminho>"` até `release()`; `reached` resolve quando o pedido chega. Deixa
   * um teste de concorrência determinístico: uma entrega fica parada no meio enquanto a outra chega.
   */
  hold(route: string): { reached: Promise<void>; release: () => void } {
    let release = (): void => undefined;
    let reached = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const arrival = new Promise<void>((resolve) => {
      reached = resolve;
    });
    this.gates.set(route, { reached, released });
    return { reached: arrival, release };
  }

  /** As chamadas a um método e caminho, na ordem. */
  calls(method: string, path: string): RecordedRequest[] {
    return this.requests.filter((request) => request.method === method && request.path === path);
  }

  /** As escritas (POST e DELETE) recebidas, de qualquer caminho. */
  writes(): RecordedRequest[] {
    return this.requests.filter((request) => request.method === 'POST' || request.method === 'DELETE');
  }

  /** Um preço mensal em BRL, como o `stripe-setup` o criaria. */
  addPrice(lookupKey: string, unitAmount: number, overrides: StripeObject = {}): StripeObject {
    const price = {
      id: this.nextId('price'),
      object: 'price',
      active: true,
      currency: 'brl',
      livemode: false,
      lookup_key: lookupKey,
      metadata: {},
      nickname: null,
      product: 'verax_control',
      recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
      type: 'recurring',
      unit_amount: unitAmount,
      ...overrides,
    };
    this.prices.set(price.id, price);
    return price;
  }

  // --- Fixtures do webhook (CP-04) ----------------------------------------------------------------------------

  addCustomer(overrides: StripeObject = {}): StripeObject {
    const customer = {
      id: this.nextId('cus'),
      object: 'customer',
      livemode: false,
      email: null,
      name: null,
      metadata: {},
      ...overrides,
    };
    this.customers.set(String(customer.id), customer);
    return customer;
  }

  /** Uma assinatura com os itens dados; o período de cada item termina em `periodEnd`. */
  addSubscription(input: {
    customer: string;
    items: FakeItem[];
    metadata?: Record<string, string>;
    status?: string;
    periodEnd: Date;
    latestInvoice?: string | null;
    defaultPaymentMethodType?: string | null;
  }): StripeObject {
    const id = this.nextId('sub');
    const subscription = {
      id,
      object: 'subscription',
      livemode: false,
      status: input.status ?? 'active',
      customer: input.customer,
      metadata: input.metadata ?? {},
      cancel_at: null,
      latest_invoice: input.latestInvoice ?? null,
      default_payment_method:
        input.defaultPaymentMethodType === undefined || input.defaultPaymentMethodType === null
          ? null
          : { id: this.nextId('pm'), object: 'payment_method', type: input.defaultPaymentMethodType },
      items: {
        object: 'list',
        has_more: false,
        url: `/v1/subscription_items?subscription=${id}`,
        data: input.items.map((item) => ({
          id: this.nextId('si'),
          object: 'subscription_item',
          current_period_end: unix(input.periodEnd),
          quantity: item.quantity ?? 1,
          price: this.priceObject(item),
        })),
      },
    };
    this.subscriptions.set(id, subscription);
    return subscription;
  }

  /** A sessão do Checkout como o CP-03 a criou, já no estado pedido (`complete`, `expired`...). */
  addCheckoutSession(input: {
    tenantId: string;
    slug: string;
    customer: string | null;
    subscription: string | null;
    status: string;
    paymentStatus: string;
    items: FakeItem[];
    termsAccepted?: boolean;
    id?: string;
  }): StripeObject {
    const id = input.id ?? `cs_test_fake_${this.nextId('session').split('_').at(-1)}`;
    const session = {
      id,
      object: 'checkout.session',
      livemode: false,
      mode: 'subscription',
      status: input.status,
      payment_status: input.paymentStatus,
      client_reference_id: input.tenantId,
      metadata: { tenantId: input.tenantId, slug: input.slug, priceTableVersion: 'teste-v1' },
      customer: input.customer,
      subscription: input.subscription,
      consent: { promotions: null, terms_of_service: input.termsAccepted === false ? null : 'accepted' },
      payment_method_types: ['card', 'boleto'],
    };
    this.sessions.set(id, session);
    this.sessionLineItems.set(
      id,
      input.items.map((item) => ({
        id: this.nextId('li'),
        object: 'item',
        quantity: item.quantity ?? 1,
        price: this.priceObject(item),
      })),
    );
    return session;
  }

  addInvoice(input: {
    customer: string;
    subscription: string;
    subscriptionMetadata: Record<string, string>;
    status: string;
    billingReason: string;
    amountPaid: number;
    periodStart: Date;
    periodEnd: Date;
    paidAt?: Date;
  }): StripeObject {
    const id = this.nextId('in');
    const invoice = {
      id,
      object: 'invoice',
      livemode: false,
      status: input.status,
      billing_reason: input.billingReason,
      customer: input.customer,
      currency: 'brl',
      amount_paid: input.amountPaid,
      hosted_invoice_url: `https://invoice.stripe.com/i/${id}`,
      status_transitions: {
        finalized_at: unix(input.periodStart),
        marked_uncollectible_at: null,
        paid_at: input.paidAt === undefined ? null : unix(input.paidAt),
        voided_at: null,
      },
      parent: {
        type: 'subscription_details',
        quote_details: null,
        subscription_details: { subscription: input.subscription, metadata: input.subscriptionMetadata },
      },
      lines: {
        object: 'list',
        has_more: false,
        url: `/v1/invoices/${id}/lines`,
        data: [
          {
            id: this.nextId('il'),
            object: 'line_item',
            period: { start: unix(input.periodStart), end: unix(input.periodEnd) },
          },
        ],
      },
    };
    this.invoices.set(id, invoice);
    return invoice;
  }

  addCharge(input: {
    customer: string;
    amount: number;
    amountRefunded?: number;
    created: Date;
  }): StripeObject {
    const id = this.nextId('ch');
    const refunded = input.amountRefunded ?? 0;
    const charge = {
      id,
      object: 'charge',
      livemode: false,
      customer: input.customer,
      amount: input.amount,
      amount_refunded: refunded,
      refunded: refunded >= input.amount,
      created: unix(input.created),
    };
    this.charges.set(id, charge);
    return charge;
  }

  addDispute(chargeId: string): StripeObject {
    const dispute = { id: this.nextId('dp'), object: 'dispute', livemode: false, charge: chargeId };
    this.disputes.set(dispute.id, dispute);
    return dispute;
  }

  addEarlyFraudWarning(chargeId: string): StripeObject {
    const warning = {
      id: this.nextId('issfr'),
      object: 'radar.early_fraud_warning',
      livemode: false,
      actionable: true,
      charge: chargeId,
    };
    this.earlyFraudWarnings.set(warning.id, warning);
    return warning;
  }

  private priceObject(item: FakeItem): StripeObject {
    return {
      id: item.price,
      object: 'price',
      active: true,
      currency: 'brl',
      livemode: false,
      lookup_key: item.lookupKey ?? null,
      type: 'recurring',
      recurring: { interval: 'month', interval_count: 1 },
    };
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_fake_${this.sequence}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const body = await readBody(req);
    const recorded: RecordedRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      form: new URLSearchParams(body),
      headers: req.headers,
    };
    this.requests.push(recorded);
    const gate = this.gates.get(`${recorded.method} ${recorded.path}`);
    if (gate !== undefined) {
      this.gates.delete(`${recorded.method} ${recorded.path}`);
      gate.reached();
      await gate.released;
    }
    const failure = this.failures.get(`${recorded.method} ${recorded.path}`);
    if (failure !== undefined) {
      this.failures.delete(`${recorded.method} ${recorded.path}`);
      this.error(res, failure);
      return;
    }
    const result = this.route(recorded);
    if (result === undefined) {
      this.error(res, {
        status: 404,
        type: 'invalid_request_error',
        code: 'resource_missing',
        message: `No such resource: ${recorded.path}`,
      });
      return;
    }
    this.json(res, 200, result);
  }

  private route(request: RecordedRequest): StripeObject | undefined {
    const { method, path, query, form } = request;
    const parts = path.split('/').filter(Boolean);
    if (parts[0] !== 'v1') return undefined;
    // `checkout/sessions` e `radar/early_fraud_warnings` têm dois segmentos no nome do recurso.
    const nested = parts[1] === 'checkout' || parts[1] === 'radar';
    const resource = nested ? `${parts[1]}/${parts[2] ?? ''}` : (parts[1] ?? '');
    const id = nested ? parts[3] : parts[2];
    const sub = nested ? parts[4] : parts[3];
    const route = `${method} ${resource}${id === undefined ? '' : '/:id'}${sub === undefined ? '' : `/${sub}`}`;
    switch (route) {
      case 'GET prices':
        return this.listPrices(query);
      case 'POST prices':
        return this.createPrice(form);
      case 'GET products/:id':
        return this.products.get(String(id));
      case 'POST products':
        return this.createProduct(form);
      case 'GET coupons/:id':
        return this.coupons.get(String(id));
      case 'POST coupons':
        return this.createCoupon(form);
      case 'GET promotion_codes':
        return this.listPromotionCodes(query);
      case 'POST promotion_codes':
        return this.createPromotionCode(form);
      case 'POST checkout/sessions':
        return this.createSession(form);
      case 'GET checkout/sessions/:id':
        return this.retrieveSession(String(id), query);
      case 'GET subscriptions/:id':
        return this.subscriptions.get(String(id));
      case 'DELETE subscriptions/:id':
        return this.cancelSubscription(String(id));
      case 'GET invoices':
        return this.listInvoices(query);
      case 'GET invoices/:id':
        return this.invoices.get(String(id));
      case 'GET charges/:id':
        return this.charges.get(String(id));
      case 'GET disputes/:id':
        return this.withCharge(this.disputes.get(String(id)), query);
      case 'GET radar/early_fraud_warnings/:id':
        return this.withCharge(this.earlyFraudWarnings.get(String(id)), query);
      case 'GET customers/:id':
        return this.customers.get(String(id));
      case 'GET customers/:id/tax_ids':
        return this.list(this.taxIds.get(String(id)) ?? [], path);
      case 'POST customers/:id/tax_ids':
        return this.createTaxId(String(id), form);
      case 'GET webhook_endpoints':
        return this.list([...this.webhookEndpoints.values()], path);
      case 'POST webhook_endpoints':
        return this.createWebhookEndpoint(form);
      case 'POST webhook_endpoints/:id':
        return this.updateWebhookEndpoint(String(id), form);
      case 'DELETE webhook_endpoints/:id':
        return this.deleteWebhookEndpoint(String(id));
      default:
        return undefined;
    }
  }

  private list(data: StripeObject[], url: string): StripeObject {
    return { object: 'list', data, has_more: false, url };
  }

  private listPrices(query: URLSearchParams): StripeObject {
    const keys = indexed(query, 'lookup_keys');
    const active = query.get('active');
    const data = [...this.prices.values()].filter(
      (price) =>
        (keys.length === 0 || keys.includes(String(price['lookup_key']))) &&
        (active === null || String(price['active']) === active),
    );
    return this.list(data, '/v1/prices');
  }

  /** Mensal com `recurring[...]`; sem ele, avulso (`one_time`), como a Stripe faz. */
  private createPrice(form: URLSearchParams): StripeObject {
    const lookupKey = form.get('lookup_key');
    const interval = form.get('recurring[interval]');
    return this.addPrice(lookupKey ?? '', Number(form.get('unit_amount')), {
      lookup_key: lookupKey,
      currency: form.get('currency'),
      product: form.get('product'),
      nickname: form.get('nickname'),
      metadata: Object.fromEntries(
        [...form.entries()]
          .filter(([key]) => key.startsWith('metadata['))
          .map(([key, value]) => [key.slice('metadata['.length, -1), value]),
      ),
      ...(interval === null
        ? { type: 'one_time', recurring: null }
        : {
            type: 'recurring',
            recurring: {
              interval,
              interval_count: Number(form.get('recurring[interval_count]') ?? '1'),
              usage_type: 'licensed',
            },
          }),
    });
  }

  private createProduct(form: URLSearchParams): StripeObject {
    const product = {
      id: form.get('id') ?? this.nextId('prod'),
      object: 'product',
      active: true,
      name: form.get('name'),
      unit_label: form.get('unit_label'),
      livemode: false,
    };
    this.products.set(product.id, product);
    return product;
  }

  private createCoupon(form: URLSearchParams): StripeObject {
    const coupon = {
      id: form.get('id') ?? this.nextId('coupon'),
      object: 'coupon',
      name: form.get('name'),
      percent_off: Number(form.get('percent_off')),
      duration: form.get('duration'),
      duration_in_months: Number(form.get('duration_in_months')),
      max_redemptions: Number(form.get('max_redemptions')),
      times_redeemed: 0,
      valid: true,
      livemode: false,
      ...(indexed(form, 'applies_to[products]').length === 0
        ? {}
        : { applies_to: { products: indexed(form, 'applies_to[products]') } }),
    };
    this.coupons.set(coupon.id, coupon);
    return coupon;
  }

  private listPromotionCodes(query: URLSearchParams): StripeObject {
    const code = query.get('code');
    const data = [...this.promotionCodes.values()].filter(
      (promotion) => code === null || String(promotion['code']).toLowerCase() === code.toLowerCase(),
    );
    return this.list(data, '/v1/promotion_codes');
  }

  private createPromotionCode(form: URLSearchParams): StripeObject {
    const promotion = {
      id: this.nextId('promo'),
      object: 'promotion_code',
      active: form.get('active') !== 'false',
      code: form.get('code'),
      promotion: { type: form.get('promotion[type]'), coupon: form.get('promotion[coupon]') },
      livemode: false,
    };
    this.promotionCodes.set(promotion.id, promotion);
    return promotion;
  }

  private createSession(form: URLSearchParams): StripeObject {
    const id = `cs_test_fake_${this.nextId('session').split('_').at(-1)}`;
    const allowed = indexed(form, 'allowed_payment_method_types');
    const session = {
      id,
      object: 'checkout.session',
      url: `https://checkout.stripe.com/c/pay/${id}`,
      livemode: false,
      mode: form.get('mode'),
      status: 'open',
      client_reference_id: form.get('client_reference_id'),
      customer_email: form.get('customer_email'),
      expires_at: Number(form.get('expires_at')),
      payment_method_types: allowed.filter((method) => this.enabledPaymentMethods.includes(method)),
    };
    this.sessions.set(id, session);
    return session;
  }

  /** A sessão; com `expand[]=line_items`, as linhas junto (como a Stripe faz). */
  private retrieveSession(id: string, query: URLSearchParams): StripeObject | undefined {
    const session = this.sessions.get(id);
    if (session === undefined) return undefined;
    if (!indexed(query, 'expand').includes('line_items')) return session;
    return {
      ...session,
      line_items: this.list(this.sessionLineItems.get(id) ?? [], `/v1/checkout/sessions/${id}/line_items`),
    };
  }

  /** Faturas filtradas por assinatura (`parent.subscription_details.subscription`) e status, como a Stripe lista. */
  private listInvoices(query: URLSearchParams): StripeObject {
    const subscription = query.get('subscription');
    const status = query.get('status');
    const limit = Number(query.get('limit') ?? '10');
    const data = [...this.invoices.values()].filter((invoice) => {
      const parent = invoice['parent'] as { subscription_details?: { subscription?: unknown } } | null;
      return (
        (subscription === null || parent?.subscription_details?.subscription === subscription) &&
        (status === null || invoice['status'] === status)
      );
    });
    return this.list(data.slice(0, limit), '/v1/invoices');
  }

  private cancelSubscription(id: string): StripeObject | undefined {
    const subscription = this.subscriptions.get(id);
    if (subscription === undefined) return undefined;
    subscription['status'] = 'canceled';
    subscription['canceled_at'] = Math.floor(Date.now() / 1000);
    return subscription;
  }

  /** Contestação e alerta de fraude: com `expand[]=charge`, a cobrança junto. */
  private withCharge(object: StripeObject | undefined, query: URLSearchParams): StripeObject | undefined {
    if (object === undefined) return undefined;
    if (!indexed(query, 'expand').includes('charge')) return object;
    return { ...object, charge: this.charges.get(String(object['charge'])) ?? object['charge'] };
  }

  private createTaxId(customerId: string, form: URLSearchParams): StripeObject | undefined {
    if (!this.customers.has(customerId)) return undefined;
    const taxId = {
      id: this.nextId('txi'),
      object: 'tax_id',
      customer: customerId,
      type: form.get('type'),
      value: form.get('value'),
      livemode: false,
    };
    this.taxIds.set(customerId, [...(this.taxIds.get(customerId) ?? []), taxId]);
    return taxId;
  }

  /** Cria o endpoint; só a resposta da criação leva o segredo de assinatura (como na Stripe). */
  private createWebhookEndpoint(form: URLSearchParams): StripeObject {
    const endpoint = {
      id: this.nextId('we'),
      object: 'webhook_endpoint',
      url: form.get('url'),
      enabled_events: indexed(form, 'enabled_events'),
      api_version: form.get('api_version'),
      description: form.get('description'),
      status: 'enabled',
      livemode: false,
      metadata: {},
    };
    this.webhookEndpoints.set(endpoint.id, endpoint);
    this.lastWebhookSigningValue = fakeWebhookSigningValue();
    return { ...endpoint, secret: this.lastWebhookSigningValue };
  }

  private updateWebhookEndpoint(id: string, form: URLSearchParams): StripeObject | undefined {
    const endpoint = this.webhookEndpoints.get(id);
    if (endpoint === undefined) return undefined;
    const events = indexed(form, 'enabled_events');
    if (events.length > 0) endpoint['enabled_events'] = events;
    if (form.get('disabled') === 'false') endpoint['status'] = 'enabled';
    if (form.get('description') !== null) endpoint['description'] = form.get('description');
    return endpoint;
  }

  private deleteWebhookEndpoint(id: string): StripeObject | undefined {
    if (!this.webhookEndpoints.delete(id)) return undefined;
    return { id, object: 'webhook_endpoint', deleted: true };
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {
      'content-type': 'application/json',
      'request-id': `req_fake_${this.requests.length}`,
    });
    res.end(JSON.stringify(body));
  }

  /** Erro no formato da Stripe; `Stripe-Should-Retry: false` evita que o SDK repita (e atrase o teste). */
  private error(res: ServerResponse, failure: FakeFailure): void {
    res.writeHead(failure.status, {
      'content-type': 'application/json',
      'request-id': `req_fake_${this.requests.length}`,
      'stripe-should-retry': 'false',
    });
    res.end(JSON.stringify({ error: { type: failure.type, code: failure.code, message: failure.message } }));
  }
}
