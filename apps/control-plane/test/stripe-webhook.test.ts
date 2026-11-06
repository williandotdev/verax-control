import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import Stripe from 'stripe';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CheckoutStore } from '../src/checkout/checkout-store.js';
import { COLLECTIONS } from '../src/firestore/collections.js';
import type {
  DocumentData,
  DocumentQuery,
  DocumentStore,
  DocumentTransaction,
  StoredDocument,
} from '../src/firestore/document-store.js';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import { MemoryStepQueue } from '../src/queue/memory-step-queue.js';
import { StepQueueUnavailableError } from '../src/queue/step-queue.js';
import { STRIPE_API_VERSION } from '../src/stripe/stripe-client.js';
import { TenantStore } from '../src/tenants/tenant-store.js';
import { GRACE_PERIOD_MS } from '../src/webhook/billing-rules.js';
import { InvoiceStore } from '../src/webhook/invoice-store.js';
import { StripeEventStore } from '../src/webhook/stripe-event-store.js';
import { demoOrder } from './support/checkout-store-contract.js';
import { createApp } from './support/create-app.js';
import { FakeClock, MINUTE_MS } from './support/fake-clock.js';
import {
  type FakeItem,
  FakeStripe,
  fakeStripeKey,
  fakeWebhookSigningValue,
  type StripeObject,
} from './support/fake-stripe.js';
import { LogCapture } from './support/log-capture.js';
import { demoConfiguration, demoLimits, demoOrderPricing } from './support/pricing-fixtures.js';

const WEBHOOK = '/v1/stripe/webhook';
const SITE = 'https://veraxsistemas.com.br';
const START = new Date('2026-11-04T12:00:00.000Z');
const DAY_MS = 24 * 60 * MINUTE_MS;
/** O item do ambiente, com o `lookup_key` da tabela fictícia (`pricing-fixtures.ts`). Valores redondos e inventados. */
const AMBIENTE: FakeItem = {
  price: 'price_fake_ambiente',
  quantity: 1,
  lookupKey: 'vc_env_p_v1',
};

/** Um DocumentStore que conta cada acesso: prova que a assinatura inválida não toca o banco. */
class CountingStore implements DocumentStore {
  accesses = 0;

  constructor(private readonly inner: MemoryDocumentStore) {}

  get(collection: string, id: string): Promise<DocumentData | undefined> {
    this.accesses += 1;
    return this.inner.get(collection, id);
  }

  query(collection: string, query?: DocumentQuery): Promise<StoredDocument[]> {
    this.accesses += 1;
    return this.inner.query(collection, query);
  }

  runTransaction<T>(fn: (tx: DocumentTransaction) => Promise<T>): Promise<T> {
    this.accesses += 1;
    return this.inner.runTransaction(fn);
  }

  newId(): string {
    return this.inner.newId();
  }
}

interface Purchase {
  tenantId: string;
  slug: string;
  sessionId: string;
  customerId: string;
  subscriptionId: string;
  metadata: Record<string, string>;
}

function unix(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/**
 * O webhook da Stripe pelo app inteiro (CP-04): o SDK oficial aponta para o servidor falso da Stripe em 127.0.0.1, o
 * Firestore é o dublê em memória, a fila é a em memória e o relógio é falso. Os eventos são assinados com
 * `stripe.webhooks.generateTestHeaderString` e o segredo gerado no teste; o corpo de cada evento leva um marcador que
 * nunca pode chegar ao log, e campos que contradizem a Stripe (o webhook relê o objeto e ignora o corpo). Um app por
 * arquivo (o nestjs-pino guarda o logger em estado estático), no ar o arquivo todo.
 */
describe('cp-public: webhook da Stripe e máquina de estados (CP-04)', () => {
  const capture = new LogCapture();
  const clock = new FakeClock(START);
  const memory = new MemoryDocumentStore();
  const documents = new CountingStore(memory);
  const queue = new MemoryStepQueue();
  const fake = new FakeStripe();
  const stripeKey = fakeStripeKey('test', 'rk');
  const signingValue = fakeWebhookSigningValue();
  const bodyMarker = `marcador-do-corpo-${randomBytes(6).toString('hex')}`;
  let app: NestExpressApplication;
  let tenants: TenantStore;
  let events: StripeEventStore;
  let invoices: InvoiceStore;
  let checkouts: CheckoutStore;
  let eventSequence = 0;
  /** E-mails, CNPJs e nomes usados no arquivo: nenhum pode aparecer no log nem na auditoria. */
  const personalData = new Set<string>();

  function inDays(days: number): Date {
    return new Date(clock.now().getTime() + days * DAY_MS);
  }

  /** Um evento no formato da Stripe, com o marcador no corpo e o que mais o teste quiser contradizer. */
  function event(
    type: string,
    objectId: string,
    options: { id?: string; livemode?: boolean; body?: StripeObject } = {},
  ): { id: string; payload: string } {
    eventSequence += 1;
    const id = options.id ?? `evt_test_fake_${eventSequence}`;
    const payload = JSON.stringify({
      id,
      object: 'event',
      api_version: STRIPE_API_VERSION,
      created: unix(clock.now()),
      livemode: options.livemode ?? false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type,
      data: { object: { id: objectId, description: bodyMarker, ...options.body } },
    });
    return { id, payload };
  }

  function sign(payload: string, options: { timestamp?: number; key?: string } = {}): string {
    return Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: options.key ?? signingValue,
      timestamp: options.timestamp ?? unix(clock.now()),
    });
  }

  function deliver(e: { payload: string }, header: string = sign(e.payload)): request.Test {
    return request(app.getHttpServer())
      .post(WEBHOOK)
      .set('Content-Type', 'application/json; charset=utf-8')
      .set('Stripe-Signature', header)
      .send(e.payload);
  }

  async function send(
    type: string,
    objectId: string,
    options: { body?: StripeObject; status?: number } = {},
  ): Promise<string> {
    const e = event(type, objectId, { body: options.body });
    await deliver(e).expect(options.status ?? 200);
    return e.id;
  }

  async function outcome(eventId: string): Promise<string | undefined> {
    return (await events.get(eventId))?.outcome;
  }

  async function chain(tenantId: string): Promise<string[]> {
    return (await tenants.listTransitions(tenantId)).map((t) => `${t.from ?? '∅'}->${t.to}`);
  }

  /**
   * Uma compra até o ponto em que a Stripe manda o `checkout.session.completed`: a reserva pelo `CheckoutStore` (o
   * mesmo código do CP-03, com o pedido e a sessão gravados), o Customer, a assinatura e a sessão `complete` no falso.
   */
  async function purchase(options: {
    paymentStatus: 'paid' | 'unpaid';
    slug?: string;
    items?: FakeItem[];
  }): Promise<Purchase> {
    const slug = options.slug ?? 'cliente-demo-a';
    const order = demoOrder(slug);
    personalData.add(order.adminEmail).add(order.company.legalName).add(order.company.cnpj);
    const reservation = await checkouts.reserve({ slug, order });
    const customer = fake.addCustomer({ email: order.adminEmail, business_name: order.company.legalName });
    const items = options.items ?? [AMBIENTE];
    const metadata = {
      tenantId: reservation.tenantId,
      slug,
      priceTableVersion: order.pricing.priceTableVersion,
      quoteId: order.pricing.quoteId,
    };
    const subscription = fake.addSubscription({
      customer: String(customer['id']),
      items,
      metadata,
      periodEnd: inDays(30),
      defaultPaymentMethodType: options.paymentStatus === 'paid' ? 'card' : 'boleto',
    });
    const session = fake.addCheckoutSession({
      tenantId: reservation.tenantId,
      slug,
      customer: String(customer['id']),
      subscription: String(subscription['id']),
      status: 'complete',
      paymentStatus: options.paymentStatus,
      items,
    });
    await checkouts.attachSession(reservation, {
      id: String(session['id']),
      livemode: false,
      expiresAt: new Date(clock.now().getTime() + 2 * 60 * MINUTE_MS),
    });
    return {
      tenantId: reservation.tenantId,
      slug,
      sessionId: String(session['id']),
      customerId: String(customer['id']),
      subscriptionId: String(subscription['id']),
      metadata,
    };
  }

  /** Uma compra com cartão já entregue e o cliente levado a `active` (o CP-07 e o CP-11 fariam isso). */
  async function activeTenant(slug?: string): Promise<Purchase> {
    const p = await purchase({ paymentStatus: 'paid', slug });
    await send('checkout.session.completed', p.sessionId);
    const audit = { actor: 'system' };
    await tenants.transition(p.tenantId, {
      to: 'waiting_customer_connection',
      reason: 'access.ready',
      audit,
    });
    await tenants.transition(p.tenantId, { to: 'active', reason: 'accounts_connected', audit });
    return p;
  }

  function renewalInvoice(p: Purchase, status: string): StripeObject {
    return fake.addInvoice({
      customer: p.customerId,
      subscription: p.subscriptionId,
      subscriptionMetadata: p.metadata,
      status,
      billingReason: 'subscription_cycle',
      amountPaid: status === 'paid' ? 100_000 : 0,
      periodStart: inDays(30),
      periodEnd: inDays(60),
      ...(status === 'paid' ? { paidAt: clock.now() } : {}),
    });
  }

  beforeAll(async () => {
    const stripeApi = await fake.start();
    app = await createApp({
      role: 'public',
      capture,
      documentStore: documents,
      clock,
      stripeApi,
      stepQueue: queue,
      env: {
        // Debug: o teste de log prova a ausência de dado pessoal até nas linhas mais verbosas.
        LOG_LEVEL: 'debug',
        SITE_ORIGINS: SITE,
        STRIPE_SECRET_KEY: stripeKey,
        STRIPE_WEBHOOK_SECRET: signingValue,
        STRIPE_LIVE: 'false',
      },
    });
    tenants = app.get(TenantStore);
    events = app.get(StripeEventStore);
    invoices = app.get(InvoiceStore);
    checkouts = app.get(CheckoutStore);
    // Um servidor só, no ar o arquivo todo (abrir um por requisição derruba o processo de teste no Windows).
    await app.listen(0, '127.0.0.1');
  });

  beforeEach(() => {
    memory.clear();
    queue.clear();
    fake.reset();
    clock.set(START);
  });

  afterAll(async () => {
    await app.close();
    await fake.stop();
  });

  describe('assinatura e entrada', () => {
    it('assinatura inválida, ausente ou velha: 400 sem tocar o banco nem a Stripe', async () => {
      const e = event('checkout.session.completed', 'cs_test_fake_qualquer');
      const before = documents.accesses;
      const otherKey = fakeWebhookSigningValue();
      const tampered = e.payload.replace(bodyMarker, `${bodyMarker}x`);

      const responses = [
        await deliver(e, sign(e.payload, { key: otherKey })),
        await deliver({ payload: tampered }, sign(e.payload)),
        await request(app.getHttpServer())
          .post(WEBHOOK)
          .set('Content-Type', 'application/json')
          .send(e.payload),
        // 301 s: um segundo além da tolerância de 300 s.
        await deliver(e, sign(e.payload, { timestamp: unix(clock.now()) - 301 })),
      ];

      for (const response of responses) {
        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({ code: 'invalid_signature', message: 'Assinatura inválida' });
      }
      expect(documents.accesses).toBe(before);
      expect(fake.requests).toHaveLength(0);
      const alerts = capture
        .entries()
        .filter((entry) => entry['event'] === 'stripe_webhook_signature_failed');
      expect(alerts.length).toBeGreaterThanOrEqual(4);
      // A linha do alerta (monitoring.tf): o requestId e os campos do pino; nada da requisição, do corpo ou do cabeçalho.
      for (const alert of alerts) {
        expect(alert['requestId']).toEqual(expect.any(String));
        expect(Object.keys(alert).sort()).toEqual(
          ['context', 'event', 'hostname', 'level', 'message', 'pid', 'requestId', 'severity', 'time'].sort(),
        );
      }
      // 300 s ainda vale. A sessão não existe na Stripe (404 na releitura): ignorado com aviso, sem repetição.
      await deliver(e, sign(e.payload, { timestamp: unix(clock.now()) - 300 })).expect(200);
      expect(await events.get(e.id)).toMatchObject({ outcome: 'ignored', reason: 'object_not_found' });
    });

    it('tipo não assinado e evento do outro modo: 200 sem tocar o banco', async () => {
      const before = documents.accesses;
      await deliver(event('payment_intent.created', 'pi_fake_1')).expect(200, { received: true });
      await deliver(event('invoice.paid', 'in_fake_1', { livemode: true })).expect(200, { received: true });
      expect(documents.accesses).toBe(before);
      expect(fake.requests).toHaveLength(0);
    });

    it('corpo acima de 1 MB: 413; e nem a origem do site recebe CORS no webhook', async () => {
      const big = event('checkout.session.completed', 'cs_test_fake_grande', {
        body: { padding: 'x'.repeat(1024 * 1024) },
      });
      const response = await deliver(big);
      expect(response.status).toBe(413);

      const preflight = await request(app.getHttpServer())
        .options(WEBHOOK)
        .set('Origin', SITE)
        .set('Access-Control-Request-Method', 'POST');
      const post = await deliver(event('payment_intent.created', 'pi_fake_2')).set('Origin', SITE);
      for (const res of [preflight, post]) {
        expect(Object.keys(res.headers).filter((header) => header.startsWith('access-control-'))).toEqual([]);
      }
    });

    it('evento repetido: 200 sem efeito (nem releitura na Stripe)', async () => {
      const p = await purchase({ paymentStatus: 'paid' });
      const completed = event('checkout.session.completed', p.sessionId);
      await deliver(completed).expect(200);
      const stripeCalls = fake.requests.length;
      const history = await chain(p.tenantId);
      const audit = (await memory.query(COLLECTIONS.auditLog)).length;

      clock.advance(MINUTE_MS);
      await deliver(completed).expect(200, { received: true });

      expect(fake.requests).toHaveLength(stripeCalls);
      expect(await chain(p.tenantId)).toEqual(history);
      expect(await memory.query(COLLECTIONS.auditLog)).toHaveLength(audit);
      expect(queue.tasks).toHaveLength(1);
      expect(await events.get(completed.id)).toMatchObject({ outcome: 'applied', attempts: 1 });
    });
  });

  describe('compra', () => {
    it('cartão: a reserva vira o cliente (mesmo id), o slug fica taken sem o pedido, br_cnpj e preflight', async () => {
      const p = await purchase({ paymentStatus: 'paid' });
      // O corpo diz `unpaid`; a releitura diz `paid`, e é ela que vale.
      const id = await send('checkout.session.completed', p.sessionId, {
        body: { payment_status: 'unpaid', client_reference_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
      });

      const tenant = await tenants.require(p.tenantId);
      expect(tenant).toMatchObject({
        id: p.tenantId,
        slug: 'cliente-demo-a',
        state: 'provisioning',
        configuration: demoConfiguration(),
        limits: demoLimits(),
        pricing: demoOrderPricing(),
        priceId: AMBIENTE.price,
        company: { legalName: 'Cliente Demo A Ltda', cnpj: '12ABC34501DE35' },
        adminEmail: 'admin@cliente-demo-a.example',
        consent: { checkoutSessionId: p.sessionId, acceptedAt: clock.now() },
        stripe: {
          customerId: p.customerId,
          subscriptionId: p.subscriptionId,
          status: 'active',
          paymentMethodType: 'card',
          livemode: false,
          items: [{ priceId: AMBIENTE.price, quantity: 1, lookupKey: AMBIENTE.lookupKey }],
        },
        provisioning: { step: 'preflight', attempts: 0 },
      });
      const runId = tenant.provisioning?.runId ?? '';
      expect(queue.tasks).toEqual([
        {
          queue: 'provisioning',
          step: 'preflight',
          tenantId: p.tenantId,
          runId,
          taskId: `preflight-${runId}`,
        },
      ]);
      expect(await tenants.getSlug('cliente-demo-a')).toEqual({
        state: 'taken',
        tenantId: p.tenantId,
        checkoutSessionId: p.sessionId,
        updatedAt: clock.now(),
      });
      // A releitura: a sessão com as linhas e a assinatura; o CNPJ no Customer com a máscara da Receita.
      expect(fake.calls('GET', `/v1/checkout/sessions/${p.sessionId}`)[0]?.query.get('expand[0]')).toBe(
        'line_items',
      );
      const [taxId] = fake.calls('POST', `/v1/customers/${p.customerId}/tax_ids`);
      expect([...(taxId?.form.entries() ?? [])]).toEqual([
        ['type', 'br_cnpj'],
        ['value', '12.ABC.345/01DE-35'],
      ]);
      expect(taxId?.headers['idempotency-key']).toBe(`tax-id-br-cnpj-${p.tenantId}`);
      personalData.add('12.ABC.345/01DE-35');
      expect(await chain(p.tenantId)).toEqual(['∅->pending', 'pending->provisioning']);
      const transitions = await tenants.listTransitions(p.tenantId);
      expect(transitions.map((t) => t.eventId)).toEqual([id, id]);
      expect(await events.get(id)).toMatchObject({
        type: 'checkout.session.completed',
        objectId: p.sessionId,
        outcome: 'applied',
        reason: 'checkout_paid',
        tenantId: p.tenantId,
        attempts: 1,
        expiresAt: new Date(clock.now().getTime() + 90 * DAY_MS),
      });
      const audit = await memory.query(COLLECTIONS.auditLog, {
        where: [{ field: 'actor', op: '==', value: `stripe:${id}` }],
      });
      expect(audit.map((doc) => doc.data['action']).sort()).toEqual(['tenant.create', 'tenant.transition']);
    });

    it('boleto: completed com unpaid espera em pending; async_payment_succeeded provisiona', async () => {
      const p = await purchase({ paymentStatus: 'unpaid' });
      await send('checkout.session.completed', p.sessionId, { body: { payment_status: 'paid' } });

      expect(await tenants.require(p.tenantId)).toMatchObject({
        state: 'pending',
        stripe: { paymentMethodType: 'boleto' },
      });
      expect(queue.tasks).toHaveLength(0);
      expect(fake.calls('POST', `/v1/customers/${p.customerId}/tax_ids`)).toHaveLength(1);

      clock.advance(DAY_MS);
      const session = fake.sessions.get(p.sessionId);
      if (session !== undefined) session['payment_status'] = 'paid';
      await send('checkout.session.async_payment_succeeded', p.sessionId);

      expect((await tenants.require(p.tenantId)).state).toBe('provisioning');
      expect(queue.tasks).toHaveLength(1);
      // O CNPJ já estava no Customer: não é gravado de novo.
      expect(fake.calls('POST', `/v1/customers/${p.customerId}/tax_ids`)).toHaveLength(1);
      expect(await chain(p.tenantId)).toEqual(['∅->pending', 'pending->provisioning']);
    });

    it('boleto vencido: async_payment_failed cancela a assinatura no falso, libera o slug, sem provisionar', async () => {
      const p = await purchase({ paymentStatus: 'unpaid' });
      await send('checkout.session.completed', p.sessionId);
      clock.advance(3 * DAY_MS);

      const id = await send('checkout.session.async_payment_failed', p.sessionId);

      const [cancel] = fake.calls('DELETE', `/v1/subscriptions/${p.subscriptionId}`);
      expect(cancel?.headers['idempotency-key']).toBe(`cancel-boleto-${p.tenantId}`);
      expect(fake.subscriptions.get(p.subscriptionId)?.['status']).toBe('canceled');
      const tenant = await tenants.require(p.tenantId);
      expect(tenant.state).toBe('canceled');
      expect(tenant.lifecycle).toEqual({
        canceledAt: clock.now(),
        exportUntil: inDays(30),
        deleteAfter: inDays(30),
        cryptoDestroyAfter: inDays(97),
      });
      expect(queue.tasks).toHaveLength(0);
      expect(await tenants.getSlug('cliente-demo-a')).toEqual({
        state: 'released',
        tenantId: p.tenantId,
        updatedAt: clock.now(),
      });
      expect(await checkouts.isSlugAvailable('cliente-demo-a')).toBe(true);
      expect(await outcome(id)).toBe('applied');

      // O customer.subscription.deleted que a Stripe manda depois do cancelamento só registra o status; o estado e
      // os prazos ficam.
      await send('customer.subscription.deleted', p.subscriptionId);
      expect(await tenants.require(p.tenantId)).toMatchObject({
        state: 'canceled',
        stripe: { status: 'canceled' },
        lifecycle: tenant.lifecycle,
      });
      expect(await chain(p.tenantId)).toEqual(['∅->pending', 'pending->canceled']);
      // Repetido mais uma vez: nada a fazer.
      expect(await outcome(await send('customer.subscription.deleted', p.subscriptionId))).toBe('ignored');
    });

    it('checkout.session.expired libera a reserva (e só a da sessão vencida)', async () => {
      const order = demoOrder('cliente-demo-b');
      const reservation = await checkouts.reserve({ slug: 'cliente-demo-b', order });
      const session = fake.addCheckoutSession({
        tenantId: reservation.tenantId,
        slug: 'cliente-demo-b',
        customer: null,
        subscription: null,
        status: 'open',
        paymentStatus: 'unpaid',
        items: [AMBIENTE],
      });
      const sessionId = String(session['id']);
      await checkouts.attachSession(reservation, { id: sessionId, livemode: false, expiresAt: inDays(1) });

      // A sessão ainda aberta (o corpo diz `expired`): nada muda.
      const early = await send('checkout.session.expired', sessionId, { body: { status: 'expired' } });
      expect(await outcome(early)).toBe('ignored');
      expect((await tenants.getSlug('cliente-demo-b'))?.state).toBe('reserved');

      session['status'] = 'expired';
      const id = await send('checkout.session.expired', sessionId);
      expect(await outcome(id)).toBe('applied');
      expect(await tenants.getSlug('cliente-demo-b')).toEqual({
        state: 'released',
        tenantId: reservation.tenantId,
        updatedAt: clock.now(),
      });
      expect(await tenants.get(reservation.tenantId)).toBeUndefined();
    });

    it('sessão de outro checkout (sem a reserva nossa): ignorada', async () => {
      const session = fake.addCheckoutSession({
        tenantId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        slug: 'cliente-demo-c',
        customer: null,
        subscription: null,
        status: 'complete',
        paymentStatus: 'paid',
        items: [AMBIENTE],
      });
      session['metadata'] = {};
      const id = await send('checkout.session.completed', String(session['id']));
      expect(await events.get(id)).toMatchObject({ outcome: 'ignored', reason: 'foreign_session' });
    });
  });

  describe('ordem, repetição e concorrência', () => {
    async function finalState(order: 'certa' | 'invertida'): Promise<Record<string, unknown>> {
      memory.clear();
      queue.clear();
      fake.reset();
      const p = await purchase({ paymentStatus: 'paid' });
      const invoice = fake.addInvoice({
        customer: p.customerId,
        subscription: p.subscriptionId,
        subscriptionMetadata: p.metadata,
        status: 'paid',
        billingReason: 'subscription_create',
        amountPaid: 100_000,
        periodStart: clock.now(),
        periodEnd: inDays(30),
        paidAt: clock.now(),
      });
      const completed = event('checkout.session.completed', p.sessionId);
      const paid = event('invoice.paid', String(invoice['id']));
      if (order === 'certa') {
        await deliver(completed).expect(200);
        await deliver(paid).expect(200);
      } else {
        await deliver(paid).expect(200);
        expect(await events.get(paid.id)).toMatchObject({
          outcome: 'deferred',
          reason: 'tenant_not_created',
          tenantId: p.tenantId,
          slug: p.slug,
        });
        expect(await tenants.get(p.tenantId)).toBeUndefined();
        await deliver(completed).expect(200);
      }
      const tenant = await tenants.require(p.tenantId);
      return {
        state: tenant.state,
        chain: await chain(p.tenantId),
        paidUntil: tenant.billing?.paidUntil,
        invoices: (await invoices.list(p.tenantId)).map((doc) => [doc.billingReason, doc.amount, doc.nfse]),
        tasks: queue.tasks.length,
        outcomes: [await outcome(completed.id), await outcome(paid.id)],
      };
    }

    it('fora de ordem: invoice.paid antes do completed fica deferred e é reprocessado; o fim é o da ordem certa', async () => {
      const inOrder = await finalState('certa');
      const reversed = await finalState('invertida');

      expect(inOrder).toEqual({
        state: 'provisioning',
        chain: ['∅->pending', 'pending->provisioning'],
        paidUntil: inDays(30),
        invoices: [['subscription_create', 100_000, { status: 'manual' }]],
        tasks: 1,
        outcomes: ['applied', 'applied'],
      });
      expect(reversed).toEqual(inOrder);
    });

    it('boleto fora de ordem: async_payment_succeeded antes do completed cria o cliente e provisiona', async () => {
      const p = await purchase({ paymentStatus: 'paid' });
      const succeeded = await send('checkout.session.async_payment_succeeded', p.sessionId);
      const completed = await send('checkout.session.completed', p.sessionId);

      expect((await tenants.require(p.tenantId)).state).toBe('provisioning');
      expect(await chain(p.tenantId)).toEqual(['∅->pending', 'pending->provisioning']);
      expect([await outcome(succeeded), await outcome(completed)]).toEqual(['applied', 'ignored']);
      expect(queue.tasks).toHaveLength(1);
    });

    it('a releitura falha (Stripe fora): 500 e failed; a repetição da Stripe aplica', async () => {
      const p = await purchase({ paymentStatus: 'paid' });
      fake.failures.set(`GET /v1/checkout/sessions/${p.sessionId}`, {
        status: 500,
        type: 'api_error',
        message: `falha com ${demoOrder().adminEmail}`,
      });
      const completed = event('checkout.session.completed', p.sessionId);

      const failed = await deliver(completed).expect(500);
      expect(failed.body).toMatchObject({ code: 'webhook_failed', message: 'Erro interno' });
      expect(await events.get(completed.id)).toMatchObject({
        outcome: 'failed',
        reason: 'stripe_error',
        attempts: 1,
      });
      expect(await tenants.get(p.tenantId)).toBeUndefined();

      clock.advance(MINUTE_MS);
      await deliver(completed).expect(200);
      expect(await events.get(completed.id)).toMatchObject({ outcome: 'applied', attempts: 2 });
      expect((await tenants.require(p.tenantId)).state).toBe('provisioning');
    });

    it('a fila falha depois da transição: 500; a repetição enfileira o preflight da mesma execução', async () => {
      const p = await purchase({ paymentStatus: 'paid' });
      queue.failNext(new StepQueueUnavailableError(['TASKS_PROJECT_ID']));
      const completed = event('checkout.session.completed', p.sessionId);

      await deliver(completed).expect(500);
      const tenant = await tenants.require(p.tenantId);
      expect(tenant.state).toBe('provisioning');
      expect(queue.tasks).toHaveLength(0);
      expect(await events.get(completed.id)).toMatchObject({
        outcome: 'failed',
        reason: 'step_queue_unavailable',
      });

      await deliver(completed).expect(200);
      expect(queue.tasks.map((task) => task.runId)).toEqual([tenant.provisioning?.runId]);
      expect(await chain(p.tenantId)).toEqual(['∅->pending', 'pending->provisioning']);
    });

    it('a mesma entrega duas vezes ao mesmo tempo: uma processa, a outra recebe 409 (a Stripe repete)', async () => {
      const p = await purchase({ paymentStatus: 'paid' });
      const completed = event('checkout.session.completed', p.sessionId);
      // A 1.ª entrega fica parada na releitura (depois de tomar o evento) enquanto a 2.ª chega.
      const gate = fake.hold(`GET /v1/checkout/sessions/${p.sessionId}`);
      const first = deliver(completed).then((response) => response);
      await gate.reached;

      const second = await deliver(completed);
      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({ code: 'event_in_progress' });

      gate.release();
      expect((await first).status).toBe(200);
      expect(queue.tasks).toHaveLength(1);
      // A Stripe repete a que recebeu 409: duplicata, 200 sem efeito.
      await deliver(completed).expect(200);
      expect(await chain(p.tenantId)).toEqual(['∅->pending', 'pending->provisioning']);
    });

    it('dois eventos diferentes do mesmo cliente ao mesmo tempo: completed e invoice.paid', async () => {
      const p = await purchase({ paymentStatus: 'paid' });
      const invoice = fake.addInvoice({
        customer: p.customerId,
        subscription: p.subscriptionId,
        subscriptionMetadata: p.metadata,
        status: 'paid',
        billingReason: 'subscription_create',
        amountPaid: 100_000,
        periodStart: clock.now(),
        periodEnd: inDays(30),
        paidAt: clock.now(),
      });
      const completed = event('checkout.session.completed', p.sessionId);
      const paid = event('invoice.paid', String(invoice['id']));

      const responses = await Promise.all([deliver(paid), deliver(completed)]);

      expect(responses.map((r) => r.status)).toEqual([200, 200]);
      expect((await tenants.require(p.tenantId)).state).toBe('provisioning');
      expect(await chain(p.tenantId)).toEqual(['∅->pending', 'pending->provisioning']);
      expect(queue.tasks).toHaveLength(1);
      expect(await invoices.list(p.tenantId)).toHaveLength(1);
      expect([await outcome(completed.id), await outcome(paid.id)]).toEqual(['applied', 'applied']);
    });

    it('dois eventos diferentes do mesmo cliente ao mesmo tempo: falha de renovação e assinatura unpaid', async () => {
      const p = await activeTenant();
      const invoice = renewalInvoice(p, 'open');
      const subscription = fake.subscriptions.get(p.subscriptionId);
      if (subscription !== undefined) subscription['status'] = 'unpaid';

      const responses = await Promise.all([
        deliver(event('invoice.payment_failed', String(invoice['id']))),
        deliver(event('customer.subscription.updated', p.subscriptionId)),
      ]);

      expect(responses.map((r) => r.status)).toEqual([200, 200]);
      const tenant = await tenants.require(p.tenantId);
      expect(tenant.state).toBe('suspended');
      expect(tenant.billing).toMatchObject({ suspendedReason: 'unpaid', resumeState: 'active' });
      const history = (await chain(p.tenantId)).slice(4);
      expect([['active->past_due', 'past_due->suspended'], ['active->suspended']]).toContainEqual(history);
    });
  });

  describe('cobrança recorrente', () => {
    it('past_due → suspended → active: carência de 7 dias, sem estender; unpaid suspende; pagamento reativa', async () => {
      const p = await activeTenant();
      const invoice = renewalInvoice(p, 'open');
      const invoiceId = String(invoice['id']);
      clock.advance(30 * DAY_MS);
      const failedAt = clock.now();

      await send('invoice.payment_failed', invoiceId);
      expect(await tenants.require(p.tenantId)).toMatchObject({
        state: 'past_due',
        billing: { pastDueSince: failedAt, graceUntil: new Date(failedAt.getTime() + GRACE_PERIOD_MS) },
      });

      // O Smart Retries tenta de novo no dia seguinte e falha: a carência não estende.
      clock.advance(DAY_MS);
      const retry = await send('invoice.payment_failed', invoiceId);
      expect(await outcome(retry)).toBe('ignored');
      expect((await tenants.require(p.tenantId)).billing?.graceUntil).toEqual(
        new Date(failedAt.getTime() + GRACE_PERIOD_MS),
      );

      clock.advance(7 * DAY_MS);
      const subscription = fake.subscriptions.get(p.subscriptionId);
      if (subscription !== undefined) subscription['status'] = 'unpaid';
      await send('customer.subscription.updated', p.subscriptionId);
      expect(await tenants.require(p.tenantId)).toMatchObject({
        state: 'suspended',
        stripe: { status: 'unpaid' },
        billing: { suspendedReason: 'unpaid', unpaidSince: clock.now(), resumeState: 'active' },
      });

      clock.advance(DAY_MS);
      invoice['status'] = 'paid';
      invoice['amount_paid'] = 100_000;
      (invoice['status_transitions'] as StripeObject)['paid_at'] = unix(clock.now());
      if (subscription !== undefined) subscription['status'] = 'active';
      await send('invoice.paid', invoiceId);

      const tenant = await tenants.require(p.tenantId);
      expect(tenant.state).toBe('active');
      expect(tenant.billing).toEqual({ paidUntil: new Date(START.getTime() + 60 * DAY_MS) });
      expect(await chain(p.tenantId)).toEqual([
        '∅->pending',
        'pending->provisioning',
        'provisioning->waiting_customer_connection',
        'waiting_customer_connection->active',
        'active->past_due',
        'past_due->suspended',
        'suspended->active',
      ]);
      const [recorded] = await invoices.list(p.tenantId);
      expect(recorded).toMatchObject({
        id: invoiceId,
        amount: 100_000,
        currency: 'brl',
        status: 'paid',
        billingReason: 'subscription_cycle',
        subscriptionId: p.subscriptionId,
        paidAt: clock.now(),
        paymentMethodType: 'card',
        hostedInvoiceUrl: `https://invoice.stripe.com/i/${invoiceId}`,
        nfse: { status: 'manual' },
      });
      // A mesma fatura de novo não duplica nem mexe na NFS-e.
      await send('invoice.paid', invoiceId);
      expect(await invoices.list(p.tenantId)).toHaveLength(1);
    });

    it('a VM acompanha (CP-11): unpaid pede node.stop, o pagamento pede node.start; sem VM, nada', async () => {
      const p = await activeTenant();
      const withoutVm = await activeTenant('cliente-sem-vm');
      await tenants.change(p.tenantId, () => ({
        reason: 'teste',
        audit: { actor: 'system' },
        mutate: (t) => ({
          ...t,
          provisioning: { ...(t.provisioning ?? { attempts: 0 }), nodeVersionPinnedAt: clock.now() },
          resources: {
            nodesProject: 'projeto-dos-nos-demo',
            zone: 'southamerica-east1-b',
            instanceName: 'vx-x',
          },
        }),
      }));
      const before = queue.tasks.length;
      for (const tenant of [p, withoutVm]) {
        const subscription = fake.subscriptions.get(tenant.subscriptionId);
        if (subscription !== undefined) subscription['status'] = 'unpaid';
        await send('customer.subscription.updated', tenant.subscriptionId);
        expect((await tenants.require(tenant.tenantId)).state).toBe('suspended');
      }
      const lifecycle = (): string[] =>
        queue.tasks.slice(before).map((task) => `${task.queue}:${task.step}:${task.tenantId}`);
      expect(lifecycle()).toEqual([`lifecycle:node.stop:${p.tenantId}`]);

      const invoice = renewalInvoice(p, 'paid');
      const subscription = fake.subscriptions.get(p.subscriptionId);
      if (subscription !== undefined) subscription['status'] = 'active';
      await send('invoice.paid', String(invoice['id']));
      expect((await tenants.require(p.tenantId)).state).toBe('active');
      expect(lifecycle()).toEqual([
        `lifecycle:node.stop:${p.tenantId}`,
        `lifecycle:node.start:${p.tenantId}`,
      ]);

      // A fila fora do ar não derruba a entrega: o tick da hora seguinte pede de novo.
      const other = await activeTenant('cliente-fila-x');
      await tenants.change(other.tenantId, () => ({
        reason: 'teste',
        audit: { actor: 'system' },
        mutate: (t) => ({ ...t, resources: { instanceName: 'vx-y' } }),
      }));
      const otherSubscription = fake.subscriptions.get(other.subscriptionId);
      if (otherSubscription !== undefined) otherSubscription['status'] = 'canceled';
      queue.failNext(new Error('fila fora do ar'));
      const id = await send('customer.subscription.deleted', other.subscriptionId);
      expect(await outcome(id)).toBe('applied');
      expect((await tenants.require(other.tenantId)).state).toBe('canceled');
    });

    it('quem nunca conectou volta a waiting_customer_connection', async () => {
      const p = await purchase({ paymentStatus: 'paid' });
      await send('checkout.session.completed', p.sessionId);
      await tenants.transition(p.tenantId, {
        to: 'waiting_customer_connection',
        reason: 'access.ready',
        audit: { actor: 'system' },
      });
      const invoice = renewalInvoice(p, 'open');
      await send('invoice.payment_failed', String(invoice['id']));
      expect((await tenants.require(p.tenantId)).billing?.resumeState).toBe('waiting_customer_connection');

      invoice['status'] = 'paid';
      await send('invoice.paid', String(invoice['id']));
      expect((await tenants.require(p.tenantId)).state).toBe('waiting_customer_connection');
    });

    it('fatura antiga paga com atraso (ou evento dela atrasado) não reativa com renovação mais nova em aberto', async () => {
      const p = await activeTenant();
      const older = renewalInvoice(p, 'open');
      clock.advance(30 * DAY_MS);
      await send('invoice.payment_failed', String(older['id']));
      clock.advance(30 * DAY_MS);
      const newer = renewalInvoice(p, 'open');
      await send('invoice.payment_failed', String(newer['id']));
      const delinquent = await tenants.require(p.tenantId);
      expect(delinquent.state).toBe('past_due');

      // A renovação antiga é paga (ou o invoice.paid dela chega só agora); a mais nova continua em aberto.
      clock.advance(DAY_MS);
      older['status'] = 'paid';
      (older['status_transitions'] as StripeObject)['paid_at'] = unix(clock.now());
      const late = await send('invoice.paid', String(older['id']));

      const still = await tenants.require(p.tenantId);
      expect(still.state).toBe('past_due');
      expect(still.billing).toMatchObject({
        pastDueSince: delinquent.billing?.pastDueSince,
        graceUntil: delinquent.billing?.graceUntil,
        resumeState: 'active',
      });
      expect(await events.get(late)).toMatchObject({ outcome: 'applied', reason: 'debt_outstanding' });
      expect((await invoices.list(p.tenantId)).map((doc) => doc.id)).toEqual([String(older['id'])]);
      const [lookup] = fake.calls('GET', '/v1/invoices');
      expect(lookup?.query.get('subscription')).toBe(p.subscriptionId);
      expect(lookup?.query.get('status')).toBe('open');

      // A que faltava é paga: agora a dívida acabou, e o cliente volta.
      newer['status'] = 'paid';
      await send('invoice.paid', String(newer['id']));
      const back = await tenants.require(p.tenantId);
      expect(back.state).toBe('active');
      // O período pago vai até o fim da renovação mais nova (emitida em D+60, cobrindo D+90 a D+120).
      expect(back.billing).toEqual({ paidUntil: new Date(START.getTime() + 120 * DAY_MS) });
      expect(await invoices.list(p.tenantId)).toHaveLength(2);
    });

    it('fatura de outra assinatura do mesmo Customer: recusada, sem mexer no cliente nem gravar a fatura', async () => {
      // Uma falha de outra assinatura não deixa o cliente inadimplente.
      const p = await activeTenant();
      const foreign = fake.addSubscription({
        customer: p.customerId,
        items: [AMBIENTE],
        periodEnd: inDays(30),
      });
      const failed = fake.addInvoice({
        customer: p.customerId,
        subscription: String(foreign['id']),
        subscriptionMetadata: {},
        status: 'open',
        billingReason: 'subscription_cycle',
        amountPaid: 0,
        periodStart: clock.now(),
        periodEnd: inDays(30),
      });
      const failedId = await send('invoice.payment_failed', String(failed['id']));
      expect((await tenants.require(p.tenantId)).state).toBe('active');
      expect(await events.get(failedId)).toMatchObject({ outcome: 'ignored', reason: 'other_subscription' });

      // A 1.ª fatura paga de outra assinatura não provisiona quem espera o próprio boleto.
      const q = await purchase({ paymentStatus: 'unpaid', slug: 'cliente-demo-b' });
      await send('checkout.session.completed', q.sessionId);
      const other = fake.addSubscription({
        customer: q.customerId,
        items: [AMBIENTE],
        periodEnd: inDays(30),
      });
      const paid = fake.addInvoice({
        customer: q.customerId,
        subscription: String(other['id']),
        subscriptionMetadata: {},
        status: 'paid',
        billingReason: 'subscription_create',
        amountPaid: 100_000,
        periodStart: clock.now(),
        periodEnd: inDays(30),
        paidAt: clock.now(),
      });
      const paidId = await send('invoice.paid', String(paid['id']));

      expect((await tenants.require(q.tenantId)).state).toBe('pending');
      expect(queue.tasks.filter((task) => task.tenantId === q.tenantId)).toHaveLength(0);
      expect(await invoices.list(q.tenantId)).toHaveLength(0);
      expect(await events.get(paidId)).toMatchObject({ outcome: 'ignored', reason: 'other_subscription' });
      const attention = capture
        .entries()
        .filter((entry) => entry['reason'] === 'other_subscription')
        .map((entry) => entry['eventId']);
      expect(attention).toEqual(expect.arrayContaining([failedId, paidId]));
    });

    it('contestação suspende (fraud_review), avisa o responsável, e o pagamento não reativa', async () => {
      const p = await activeTenant();
      const charge = fake.addCharge({ customer: p.customerId, amount: 100_000, created: clock.now() });
      const dispute = fake.addDispute(String(charge['id']));

      const id = await send('charge.dispute.created', String(dispute['id']));

      expect(await tenants.require(p.tenantId)).toMatchObject({
        state: 'suspended',
        billing: { suspendedReason: 'fraud_review', resumeState: 'active' },
      });
      expect(fake.calls('GET', `/v1/disputes/${String(dispute['id'])}`)[0]?.query.get('expand[0]')).toBe(
        'charge',
      );
      const attention = capture.entries().filter((entry) => entry['event'] === 'stripe_webhook_attention');
      expect(attention.at(-1)).toMatchObject({
        reason: 'fraud_review',
        eventId: id,
        eventType: 'charge.dispute.created',
        tenantId: p.tenantId,
      });

      const invoice = renewalInvoice(p, 'paid');
      await send('invoice.paid', String(invoice['id']));
      expect((await tenants.require(p.tenantId)).state).toBe('suspended');
      expect(capture.entries().filter((entry) => entry['reason'] === 'paid_while_fraud_review')).toHaveLength(
        1,
      );
    });

    it('alerta de fraude durante o provisionamento suspende (provisioning → suspended)', async () => {
      const p = await purchase({ paymentStatus: 'paid' });
      await send('checkout.session.completed', p.sessionId);
      const charge = fake.addCharge({ customer: p.customerId, amount: 100_000, created: clock.now() });
      const warning = fake.addEarlyFraudWarning(String(charge['id']));

      await send('radar.early_fraud_warning.created', String(warning['id']));

      expect(await tenants.require(p.tenantId)).toMatchObject({
        state: 'suspended',
        billing: { suspendedReason: 'fraud_review' },
      });
      expect((await tenants.require(p.tenantId)).billing?.resumeState).toBeUndefined();
    });

    it('reembolso parcial: nada muda e o responsável é avisado; integral na garantia: cancela na Stripe', async () => {
      const p = await purchase({ paymentStatus: 'paid' });
      await send('checkout.session.completed', p.sessionId);
      const charge = fake.addCharge({
        customer: p.customerId,
        amount: 100_000,
        amountRefunded: 40_000,
        created: clock.now(),
      });
      clock.advance(2 * DAY_MS);

      const partial = await send('charge.refunded', String(charge['id']));
      expect(await events.get(partial)).toMatchObject({
        outcome: 'ignored',
        reason: 'refund_outside_guarantee',
      });
      expect(fake.calls('DELETE', `/v1/subscriptions/${p.subscriptionId}`)).toHaveLength(0);

      charge['amount_refunded'] = 100_000;
      charge['refunded'] = true;
      const full = await send('charge.refunded', String(charge['id']));

      expect(fake.calls('DELETE', `/v1/subscriptions/${p.subscriptionId}`)).toHaveLength(1);
      const tenant = await tenants.require(p.tenantId);
      expect(tenant.state).toBe('canceled');
      expect(tenant.lifecycle?.deleteAfter).toEqual(inDays(30));
      expect(await events.get(full)).toMatchObject({
        outcome: 'applied',
        reason: 'provisioning_to_canceled',
      });
      // Já provisionou (há execução): o slug continua tomado, para a exclusão do CP-11 achar os recursos.
      expect((await tenants.getSlug(p.slug))?.state).toBe('taken');
    });

    it('reembolso integral fora dos 7 dias: só avisa', async () => {
      const p = await activeTenant();
      clock.advance(8 * DAY_MS);
      const charge = fake.addCharge({
        customer: p.customerId,
        amount: 100_000,
        amountRefunded: 100_000,
        created: START,
      });
      await send('charge.refunded', String(charge['id']));
      expect((await tenants.require(p.tenantId)).state).toBe('active');
      expect(fake.calls('DELETE', `/v1/subscriptions/${p.subscriptionId}`)).toHaveLength(0);
    });

    it('customer.subscription.deleted cancela com os prazos de exportação e exclusão', async () => {
      const p = await activeTenant();
      clock.advance(40 * DAY_MS);
      const subscription = fake.subscriptions.get(p.subscriptionId);
      if (subscription !== undefined) subscription['status'] = 'canceled';

      await send('customer.subscription.deleted', p.subscriptionId);

      expect(await tenants.require(p.tenantId)).toMatchObject({
        state: 'canceled',
        stripe: { status: 'canceled' },
        lifecycle: {
          canceledAt: clock.now(),
          exportUntil: inDays(30),
          deleteAfter: inDays(30),
          cryptoDestroyAfter: inDays(97),
        },
      });
    });

    it('assinatura com outros itens: registra a lista lida, não mexe no plano e abre item de suporte', async () => {
      const p = await activeTenant();
      const subscription = fake.subscriptions.get(p.subscriptionId);
      const extra = { price: 'price_fake_componente', quantity: 3 };
      if (subscription !== undefined) {
        (subscription['items'] as { data: StripeObject[] }).data.push({
          id: 'si_fake_extra',
          object: 'subscription_item',
          current_period_end: unix(inDays(30)),
          quantity: 3,
          price: { id: extra.price, object: 'price', lookup_key: null },
        });
      }

      const id = await send('customer.subscription.updated', p.subscriptionId);

      const tenant = await tenants.require(p.tenantId);
      expect(tenant.configuration).toEqual(demoConfiguration());
      expect(tenant.stripe?.items).toEqual([
        { priceId: AMBIENTE.price, quantity: 1, lookupKey: AMBIENTE.lookupKey },
        { priceId: extra.price, quantity: 3 },
      ]);
      expect(tenant.state).toBe('active');
      expect(await events.get(id)).toMatchObject({ outcome: 'applied', reason: 'subscription_synced' });
      expect(
        capture
          .entries()
          .filter((entry) => entry['reason'] === 'subscription_items_changed' && entry['eventId'] === id),
      ).toHaveLength(1);
    });

    it('customer.updated sincroniza e-mail e razão social (o CNPJ fica); a auditoria leva só os nomes dos campos', async () => {
      const p = await activeTenant();
      const customer = fake.customers.get(p.customerId);
      const email = 'financeiro@cliente-demo-a.example';
      const name = 'Cliente Demo A Comercio Ltda';
      personalData.add(email).add(name);
      if (customer !== undefined) {
        customer['email'] = email;
        customer['business_name'] = name;
      }

      const id = await send('customer.updated', p.customerId);

      expect(await tenants.require(p.tenantId)).toMatchObject({
        adminEmail: email,
        company: { legalName: name, cnpj: '12ABC34501DE35' },
        state: 'active',
      });
      const [audit] = await memory.query(COLLECTIONS.auditLog, {
        where: [{ field: 'actor', op: '==', value: `stripe:${id}` }],
      });
      expect(audit?.data).toMatchObject({
        action: 'tenant.update',
        details: { fields: ['adminEmail', 'company'], reason: 'customer_synced', eventId: id },
      });
    });

    it('tenantId nos metadados de uma assinatura de outro Customer: recusado, com aviso', async () => {
      const p = await activeTenant();
      const other = fake.addCustomer();
      const subscription = fake.addSubscription({
        customer: String(other['id']),
        items: [AMBIENTE],
        metadata: p.metadata,
        status: 'canceled',
        periodEnd: inDays(30),
      });

      const id = await send('customer.subscription.deleted', String(subscription['id']));

      expect((await tenants.require(p.tenantId)).state).toBe('active');
      expect(await events.get(id)).toMatchObject({ outcome: 'ignored', reason: 'unknown_tenant' });
      expect(
        capture
          .entries()
          .filter((entry) => entry['reason'] === 'customer_mismatch' && entry['eventId'] === id),
      ).toHaveLength(1);
    });

    it('cliente desconhecido: pagamento é ignorado com alerta; customer.updated é ignorado sem alerta', async () => {
      const customer = fake.addCustomer({ email: 'ninguem@cliente-demo-z.example' });
      personalData.add('ninguem@cliente-demo-z.example');
      const subscription = fake.addSubscription({
        customer: String(customer['id']),
        items: [AMBIENTE],
        periodEnd: inDays(30),
      });
      const invoice = fake.addInvoice({
        customer: String(customer['id']),
        subscription: String(subscription['id']),
        subscriptionMetadata: {},
        status: 'paid',
        billingReason: 'subscription_cycle',
        amountPaid: 100_000,
        periodStart: clock.now(),
        periodEnd: inDays(30),
        paidAt: clock.now(),
      });

      const paid = await send('invoice.paid', String(invoice['id']));
      const updated = await send('customer.updated', String(customer['id']));

      expect(await events.get(paid)).toMatchObject({ outcome: 'ignored', reason: 'unknown_tenant' });
      expect(await events.get(updated)).toMatchObject({ outcome: 'ignored', reason: 'unknown_tenant' });
      const alerts = capture
        .entries()
        .filter(
          (entry) => entry['event'] === 'stripe_webhook_attention' && entry['reason'] === 'orphan_payment',
        );
      expect(alerts.map((entry) => entry['eventId'])).toEqual([paid]);
    });
  });

  describe('logs', () => {
    it('nenhuma linha leva o segredo do webhook, a chave, o corpo, e-mail, CNPJ ou razão social', async () => {
      // Uma falha cuja mensagem repete um e-mail: nem ela chega ao log.
      const p = await purchase({ paymentStatus: 'paid', slug: 'cliente-demo-b' });
      fake.failures.set(`GET /v1/checkout/sessions/${p.sessionId}`, {
        status: 400,
        type: 'invalid_request_error',
        message: `Invalid email: ${demoOrder('cliente-demo-b').adminEmail}`,
      });
      await deliver(event('checkout.session.completed', p.sessionId)).expect(500);

      const text = capture.text;
      expect(text).toContain('stripe_webhook_processed');
      expect(text).toContain('stripe_webhook_failed');
      for (const forbidden of [signingValue, stripeKey, bodyMarker, ...personalData]) {
        expect(text, forbidden).not.toContain(forbidden);
      }
      expect(text).not.toContain('invoice.stripe.com');
      expect(text.toLowerCase()).not.toContain('stripe-signature');
      // A auditoria também não leva dado pessoal.
      const audit = JSON.stringify((await memory.query(COLLECTIONS.auditLog)).map((doc) => doc.data));
      for (const forbidden of personalData) expect(audit, forbidden).not.toContain(forbidden);
    });
  });
});
