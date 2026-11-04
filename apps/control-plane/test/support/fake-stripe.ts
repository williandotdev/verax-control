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

type StripeObject = Record<string, unknown>;

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

/**
 * A API da Stripe de mentira, em 127.0.0.1 (o SDK oficial aponta para ela com `host`, `port` e `protocol`), com o
 * pouco que o checkout e o `stripe-setup` usam: preços por `lookup_key`, produto, cupom, código promocional e sessão
 * do Checkout. Grava cada chamada para os testes conferirem os parâmetros exatos que a Stripe receberia. Nenhum
 * objeto tem dado real: ids `*_fake_<n>`.
 */
export class FakeStripe {
  readonly requests: RecordedRequest[] = [];
  readonly prices = new Map<string, StripeObject>();
  readonly products = new Map<string, StripeObject>();
  readonly coupons = new Map<string, StripeObject>();
  readonly promotionCodes = new Map<string, StripeObject>();
  readonly sessions = new Map<string, StripeObject>();
  /** Falha da próxima chamada a um caminho (`POST /v1/checkout/sessions`, por exemplo). */
  readonly failures = new Map<string, FakeFailure>();
  /** Meios de pagamento "ligados no Dashboard": a sessão oferece a interseção com os permitidos. */
  enabledPaymentMethods: string[] = ['card', 'boleto'];
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
    for (const map of [this.prices, this.products, this.coupons, this.promotionCodes, this.sessions])
      map.clear();
    this.failures.clear();
    this.enabledPaymentMethods = ['card', 'boleto'];
  }

  /** As chamadas a um método e caminho, na ordem. */
  calls(method: string, path: string): RecordedRequest[] {
    return this.requests.filter((request) => request.method === method && request.path === path);
  }

  /** As escritas (POST) recebidas, de qualquer caminho. */
  writes(): RecordedRequest[] {
    return this.requests.filter((request) => request.method === 'POST');
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
    const [, version, resource, id] = path.split('/');
    if (version !== 'v1') return undefined;
    if (method === 'GET' && resource === 'prices' && id === undefined) return this.listPrices(query);
    if (method === 'POST' && resource === 'prices' && id === undefined) return this.createPrice(form);
    if (method === 'GET' && resource === 'products' && id !== undefined) return this.products.get(id);
    if (method === 'POST' && resource === 'products' && id === undefined) return this.createProduct(form);
    if (method === 'GET' && resource === 'coupons' && id !== undefined) return this.coupons.get(id);
    if (method === 'POST' && resource === 'coupons' && id === undefined) return this.createCoupon(form);
    if (method === 'GET' && resource === 'promotion_codes' && id === undefined)
      return this.listPromotionCodes(query);
    if (method === 'POST' && resource === 'promotion_codes' && id === undefined)
      return this.createPromotionCode(form);
    if (method === 'POST' && path === '/v1/checkout/sessions') return this.createSession(form);
    return undefined;
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

  private createPrice(form: URLSearchParams): StripeObject {
    const lookupKey = form.get('lookup_key');
    if (lookupKey !== null && form.get('transfer_lookup_key') === 'true') {
      for (const price of this.prices.values())
        if (price['lookup_key'] === lookupKey) price['lookup_key'] = null;
    }
    return this.addPrice(lookupKey ?? '', Number(form.get('unit_amount')), {
      lookup_key: lookupKey,
      currency: form.get('currency'),
      product: form.get('product'),
      nickname: form.get('nickname'),
      recurring: {
        interval: form.get('recurring[interval]'),
        interval_count: Number(form.get('recurring[interval_count]') ?? '1'),
        usage_type: 'licensed',
      },
    });
  }

  private createProduct(form: URLSearchParams): StripeObject {
    const product = {
      id: form.get('id') ?? this.nextId('prod'),
      object: 'product',
      active: true,
      name: form.get('name'),
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
