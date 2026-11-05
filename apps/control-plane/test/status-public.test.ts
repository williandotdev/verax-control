import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccessStore } from '../src/access/access-store.js';
import { RevealService } from '../src/access/reveal.service.js';
import { signStatusCookie, STATUS_TOKEN_TTL_MS } from '../src/access/status-token.js';
import { AuditService } from '../src/audit/audit.service.js';
import { loadConfig } from '../src/common/config/load-config.js';
import { newUlid } from '../src/common/ulid.js';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import { MemoryStepQueue } from '../src/queue/memory-step-queue.js';
import { TenantStore } from '../src/tenants/tenant-store.js';
import type { TenantRecord } from '../src/tenants/tenant.schema.js';
import {
  fakeTemporaryPassword,
  InProcessRevealGateway,
  MemoryBootstrapSecrets,
  silentLogger,
} from './support/access-fakes.js';
import { type DemoState, type DemoTenantOptions, tenantIn } from './support/access-store-contract.js';
import { createApp } from './support/create-app.js';
import { FakeClock, MINUTE_MS } from './support/fake-clock.js';
import { FakeStripe, fakeStripeKey } from './support/fake-stripe.js';
import { LogCapture } from './support/log-capture.js';

const START = new Date('2026-11-04T12:00:00.000Z');
const HOUR_MS = 60 * MINUTE_MS;
const SITE = 'https://veraxsistemas.com.br';
const VOUCHER = 'https://payments.stripe.com/boleto/voucher/test_fake_1';

interface Purchase {
  tenant: TenantRecord;
  sessionId: string;
  password: string;
}

/**
 * A página de status pelo app inteiro do cp-public (CP-05): `claim` com a sessão relida no servidor falso da Stripe,
 * o cookie `__session` assinado, `status` por estado (com o boleto lido na hora), a revelação única passando pelo
 * mesmo `RevealService` do worker (sem HTTP: o par controlador do worker + cliente HTTP tem os próprios testes) e os
 * limites por IP e por cookie. Um app por arquivo, no ar o arquivo todo.
 */
describe('cp-public: página de status e revelação única (CP-05)', () => {
  const capture = new LogCapture();
  const clock = new FakeClock(START);
  const documents = new MemoryDocumentStore();
  const queue = new MemoryStepQueue();
  const secrets = new MemoryBootstrapSecrets();
  const fake = new FakeStripe();
  const cookieKey = randomBytes(32).toString('base64url');
  const audit = new AuditService(documents, clock);
  const tenants = new TenantStore(documents, clock, audit);
  const access = new AccessStore(documents, clock, audit);
  const workerConfig = loadConfig({
    ROLE: 'worker',
    NODE_ENV: 'test',
    NODES_PROJECT_ID: 'projeto-dos-nos-demo',
  });
  const revealService = new RevealService(access, secrets, queue, workerConfig, clock, silentLogger());
  const gateway = new InProcessRevealGateway(() => revealService);
  /** Senhas, valores de cookie, links e ids de sessão do arquivo: nenhum pode chegar ao log. */
  const sensitive = new Set<string>();
  let app: NestExpressApplication;
  let sequence = 0;

  beforeAll(async () => {
    const stripeApi = await fake.start();
    app = await createApp({
      role: 'public',
      clock,
      documentStore: documents,
      stepQueue: queue,
      revealGateway: gateway,
      stripeApi,
      capture,
      // O socket do supertest faz o papel do front end do Cloud Run; o cliente é o último do X-Forwarded-For.
      trustProxyHops: 1,
      env: {
        LOG_LEVEL: 'debug',
        COOKIE_KEY: cookieKey,
        STRIPE_SECRET_KEY: fakeStripeKey('test', 'rk'),
        SITE_ORIGINS: SITE,
      },
    });
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
    await fake.stop();
  });

  beforeEach(() => {
    clock.set(START);
    queue.clear();
  });

  /** Um IP de documentação por teste: os limites por IP não vazam de um teste para outro. */
  function nextIp(): string {
    sequence += 1;
    return `203.0.113.${sequence}`;
  }

  async function purchase(
    state: DemoState,
    options: { stripe?: DemoTenantOptions['stripe']; createTenant?: boolean } = {},
  ): Promise<Purchase> {
    sequence += 1;
    const slug = `cliente-demo-p${sequence}`;
    const tenantId = newUlid(clock.now().getTime());
    const sessionId = `cs_test_${randomBytes(12).toString('hex')}`;
    fake.addCheckoutSession({
      id: sessionId,
      tenantId,
      slug,
      customer: 'cus_fake_status',
      subscription: 'sub_fake_status',
      status: 'complete',
      paymentStatus: state === 'pending' ? 'unpaid' : 'paid',
      items: [],
    });
    const tenant =
      options.createTenant === false
        ? ({ id: tenantId, slug } as TenantRecord)
        : await tenantIn(tenants, slug, state, { tenantId, sessionId, stripe: options.stripe });
    const password = fakeTemporaryPassword();
    secrets.put(slug, {
      email: `admin@${slug}.example`,
      password,
      expiresAt: new Date(clock.now().getTime() + 72 * HOUR_MS),
    });
    sensitive.add(password).add(sessionId);
    return { tenant, sessionId, password };
  }

  function claim(sessionId: unknown, ip = nextIp()): request.Test {
    return request(app.getHttpServer())
      .post('/v1/public/status/claim')
      .set('X-Forwarded-For', ip)
      .send({ sessionId });
  }

  /** O valor do `Set-Cookie` do `__session`. */
  function cookieFrom(response: request.Response): string {
    const header = ([] as string[]).concat(response.headers['set-cookie'] ?? []);
    const cookie = header.find((line) => line.startsWith('__session='));
    if (cookie === undefined) throw new Error('sem cookie __session');
    const value = cookie.split(';', 1)[0]?.slice('__session='.length) ?? '';
    sensitive.add(value).add(value.split('.')[1] ?? '');
    return value;
  }

  async function claimed(
    state: DemoState,
    options?: Parameters<typeof purchase>[1],
  ): Promise<Purchase & { cookie: string }> {
    const bought = await purchase(state, options);
    const response = await claim(bought.sessionId).expect(200);
    return { ...bought, cookie: cookieFrom(response) };
  }

  function status(cookie: string | undefined, ip = nextIp()): request.Test {
    const call = request(app.getHttpServer()).get('/v1/public/status').set('X-Forwarded-For', ip);
    return cookie === undefined ? call : call.set('Cookie', `__session=${cookie}`);
  }

  function reveal(cookie: string | undefined, body: object = {}, ip = nextIp()): request.Test {
    const call = request(app.getHttpServer()).post('/v1/public/status/reveal').set('X-Forwarded-For', ip);
    return (cookie === undefined ? call : call.set('Cookie', `__session=${cookie}`)).send(body);
  }

  describe('claim', () => {
    it('troca o cs_ pelo cookie __session (httpOnly, Secure, Lax, só nas rotas de status, 7 dias)', async () => {
      const bought = await purchase('waiting_customer_connection');
      const response = await claim(bought.sessionId).expect(200);

      expect(response.body).toEqual({
        state: 'waiting_customer_connection',
        step: null,
        etaMinutes: null,
        panelUrl: `https://${bought.tenant.slug}.control.veraxsistemas.com.br`,
        apiUrl: `https://api-${bought.tenant.slug}.veraxsistemas.com.br`,
        revealAvailable: true,
      });
      expect(response.headers['cache-control']).toBe('private, no-store');
      const setCookie = ([] as string[]).concat(response.headers['set-cookie'] ?? []).join('\n');
      expect(setCookie).toMatch(/^__session=v1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}; /);
      expect(setCookie).toContain('Path=/v1/public/status');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Secure');
      expect(setCookie).toContain('SameSite=Lax');
      expect(setCookie).toContain(`Max-Age=${STATUS_TOKEN_TTL_MS.cookie / 1000}`);
      cookieFrom(response);
      const tokens = await documents.query('statusTokens', {
        where: [{ field: 'tenantId', op: '==', value: bought.tenant.id }],
      });
      expect(tokens).toHaveLength(1);
      expect(tokens[0]?.data).toMatchObject({ kind: 'cookie', tenantId: bought.tenant.id });
    });

    it('cs_ de outra sessão, inexistente, incompleta, de outro modo ou sem o tenant nos metadados → 404', async () => {
      const bought = await purchase('waiting_customer_connection');
      const other = await purchase('waiting_customer_connection');
      // A sessão do segundo aponta para o cliente do primeiro: o cliente é de outra sessão.
      fake.sessions.set(other.sessionId, {
        ...fake.sessions.get(other.sessionId),
        client_reference_id: bought.tenant.id,
        metadata: { tenantId: bought.tenant.id },
      });
      await claim(other.sessionId).expect(404);
      await claim(`cs_test_${randomBytes(12).toString('hex')}`).expect(404);

      const open = await purchase('waiting_customer_connection');
      fake.sessions.set(open.sessionId, { ...fake.sessions.get(open.sessionId), status: 'open' });
      await claim(open.sessionId).expect(404);

      const live = await purchase('waiting_customer_connection');
      fake.sessions.set(live.sessionId, { ...fake.sessions.get(live.sessionId), livemode: true });
      await claim(live.sessionId).expect(404);

      const foreign = await purchase('waiting_customer_connection');
      fake.sessions.set(foreign.sessionId, { ...fake.sessions.get(foreign.sessionId), metadata: {} });
      await claim(foreign.sessionId).expect(404);

      const deleted = await purchase('deleted');
      await claim(deleted.sessionId).expect(404);

      await claim('não-é-cs').expect(400);
      await claim(undefined).expect(400);
      expect(
        await documents.query('statusTokens', {
          where: [{ field: 'tenantId', op: '==', value: bought.tenant.id }],
        }),
      ).toEqual([]);
    });

    it('compra paga antes de o webhook criar o cliente: cookie mesmo assim, e a página mostra "pending"', async () => {
      const bought = await purchase('provisioning', { createTenant: false });
      const response = await claim(bought.sessionId).expect(200);
      expect(response.body).toMatchObject({ state: 'pending', revealAvailable: false, panelUrl: null });
      const cookie = cookieFrom(response);

      await tenantIn(tenants, bought.tenant.slug, 'provisioning', {
        tenantId: bought.tenant.id,
        sessionId: bought.sessionId,
      });
      expect((await status(cookie).expect(200)).body).toMatchObject({
        state: 'provisioning',
        step: 'preflight',
      });
    });

    it('a Stripe fora do ar → 503 sem cookie', async () => {
      const bought = await purchase('waiting_customer_connection');
      fake.failures.set(`GET /v1/checkout/sessions/${bought.sessionId}`, {
        status: 500,
        type: 'api_error',
        message: 'falha',
      });
      const response = await claim(bought.sessionId).expect(503);
      expect(response.body).toMatchObject({ code: 'status_unavailable' });
      expect(response.headers['set-cookie']).toBeUndefined();
    });
  });

  describe('status', () => {
    it('pelo cookie: a visão do estado; sem cookie, adulterado, de outra chave ou vencido → 404', async () => {
      const bought = await claimed('provisioning');
      const view = await status(bought.cookie).expect(200);
      expect(view.body).toMatchObject({ state: 'provisioning', step: 'preflight', etaMinutes: 30 });
      expect(view.headers['cache-control']).toBe('private, no-store');

      await status(undefined).expect(404);
      const [version, value] = bought.cookie.split('.');
      await status(`${version}.${value}.${'A'.repeat(43)}`).expect(404);
      await status(signStatusCookie(value ?? '', randomBytes(32).toString('base64url'))).expect(404);
      await status(`v1.${'x'.repeat(43)}.${'y'.repeat(43)}`).expect(404);

      clock.advance(STATUS_TOKEN_TTL_MS.cookie);
      await status(bought.cookie).expect(404);
    });

    it('cliente excluído → 404, sem dizer por quê', async () => {
      const bought = await claimed('waiting_customer_connection');
      await tenants.transition(bought.tenant.id, {
        to: 'canceled',
        reason: 'teste',
        audit: { actor: 'system' },
      });
      expect((await status(bought.cookie).expect(200)).body).toMatchObject({ state: 'canceled' });
      await tenants.transition(bought.tenant.id, {
        to: 'deleted',
        reason: 'teste',
        audit: { actor: 'system' },
      });
      const gone = await status(bought.cookie).expect(404);
      expect(gone.body).toMatchObject({ statusCode: 404, message: 'Recurso não encontrado' });
    });

    it('pending com boleto: o link do boleto lido na hora da Stripe (e só se a fatura estiver em aberto)', async () => {
      const invoice = fake.addInvoice({
        customer: 'cus_fake_status',
        subscription: 'sub_fake_status',
        subscriptionMetadata: {},
        status: 'open',
        billingReason: 'subscription_create',
        amountPaid: 0,
        periodStart: START,
        periodEnd: new Date(START.getTime() + 30 * 24 * HOUR_MS),
      });
      invoice['payments'] = {
        object: 'list',
        has_more: false,
        url: `/v1/invoices/${String(invoice['id'])}/payments`,
        data: [
          {
            id: 'inpay_fake_1',
            object: 'invoice_payment',
            payment: {
              type: 'payment_intent',
              payment_intent: {
                id: 'pi_fake_1',
                object: 'payment_intent',
                next_action: {
                  type: 'boleto_display_details',
                  boleto_display_details: { hosted_voucher_url: VOUCHER },
                },
              },
            },
          },
        ],
      };
      const bought = await claimed('pending', {
        stripe: {
          paymentMethodType: 'boleto',
          latestInvoiceId: String(invoice['id']),
          subscriptionId: 'sub_fake_status',
        },
      });

      const view = await status(bought.cookie).expect(200);
      expect(view.body).toMatchObject({ state: 'pending', boletoUrl: VOUCHER, panelUrl: null });
      const call = fake.calls('GET', `/v1/invoices/${String(invoice['id'])}`).at(-1);
      expect(call?.query.getAll('expand[0]')).toEqual(['payments.data.payment.payment_intent']);

      fake.failures.set(`GET /v1/invoices/${String(invoice['id'])}`, {
        status: 500,
        type: 'api_error',
        message: 'x',
      });
      expect((await status(bought.cookie).expect(200)).body).not.toHaveProperty('boletoUrl');

      invoice['status'] = 'paid';
      expect((await status(bought.cookie).expect(200)).body).not.toHaveProperty('boletoUrl');
    });
  });

  describe('revelação', () => {
    it('pelo cookie: painel, login e senha uma vez, no-store; a destruição na fila; depois, 409 e o cs_ não vale', async () => {
      const bought = await claimed('waiting_customer_connection');

      const response = await reveal(bought.cookie).expect(200);
      expect(response.body).toEqual({
        panelUrl: `https://${bought.tenant.slug}.control.veraxsistemas.com.br`,
        adminEmail: `admin@${bought.tenant.slug}.example`,
        password: bought.password,
        passwordExpiresAt: new Date(START.getTime() + 72 * HOUR_MS).toISOString(),
      });
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(queue.inQueue('lifecycle')).toEqual([
        expect.objectContaining({ step: 'secrets.destroy_bootstrap', tenantId: bought.tenant.id }),
      ]);

      expect((await status(bought.cookie).expect(200)).body).toMatchObject({
        state: 'waiting_customer_connection',
        revealAvailable: false,
      });
      const again = await reveal(bought.cookie).expect(409);
      expect(again.body).toMatchObject({ code: 'already_revealed' });
      expect((again.body as { message: string }).message).toContain('Esqueci minha senha');
      // Depois da revelação, o cs_ da URL de sucesso não vale mais.
      await claim(bought.sessionId).expect(404);
      expect(secrets.reads).toBeGreaterThan(0);
    });

    it('pelo link do e-mail, sem cookie, uma vez', async () => {
      const bought = await purchase('waiting_customer_connection');
      const link = await access.mint(bought.tenant.id, 'email_reveal', 'system');
      sensitive.add(link.value);

      const response = await reveal(undefined, { token: link.value }).expect(200);
      expect(response.body).toMatchObject({ password: bought.password });
      await reveal(undefined, { token: link.value }).expect(404);
    });

    it('a resposta do worker se perde: 503 para o site, mas a revelação está marcada e a destruição na fila', async () => {
      const bought = await claimed('waiting_customer_connection');
      gateway.loseNextResponse();

      const response = await reveal(bought.cookie).expect(503);
      expect(response.body).toMatchObject({ code: 'reveal_unavailable' });
      expect(response.body).not.toHaveProperty('password');
      expect(queue.inQueue('lifecycle')).toEqual([
        expect.objectContaining({ step: 'secrets.destroy_bootstrap', tenantId: bought.tenant.id }),
      ]);
      expect((await tenants.require(bought.tenant.id)).access?.passwordRevealedAt).toEqual(START);
      await reveal(bought.cookie).expect(409);
    });

    it('sem credencial, com valor desconhecido ou antes da hora: 404 ou 409, e o worker não é chamado à toa', async () => {
      const calls = gateway.calls;
      await reveal(undefined).expect(404);
      await reveal(undefined, { token: 'x'.repeat(43) }).expect(404);
      await reveal(undefined, { token: 'curto' }).expect(404);
      await reveal(`v1.${'x'.repeat(43)}.${'y'.repeat(43)}`).expect(404);
      expect(gateway.calls).toBe(calls);

      const early = await claimed('provisioning');
      const response = await reveal(early.cookie).expect(409);
      expect(response.body).toMatchObject({ code: 'reveal_not_available' });
    });

    it('só JSON: um POST "simples" (texto ou formulário, sem preflight de CORS) não gasta a revelação', async () => {
      const bought = await claimed('waiting_customer_connection');
      const calls = gateway.calls;
      for (const type of ['text/plain', 'application/x-www-form-urlencoded']) {
        const response = await request(app.getHttpServer())
          .post('/v1/public/status/reveal')
          .set('X-Forwarded-For', nextIp())
          .set('Origin', 'https://outro.veraxsistemas.com.br')
          .set('Cookie', `__session=${bought.cookie}`)
          .set('Content-Type', type)
          .send('{}')
          .expect(415);
        expect(response.body).toMatchObject({ code: 'unsupported_media_type' });
      }
      await request(app.getHttpServer())
        .post('/v1/public/status/claim')
        .set('X-Forwarded-For', nextIp())
        .set('Content-Type', 'text/plain')
        .send(JSON.stringify({ sessionId: bought.sessionId }))
        .expect(415);
      expect(gateway.calls).toBe(calls);
      expect((await tenants.require(bought.tenant.id)).access?.passwordRevealedAt).toBeUndefined();
      await reveal(bought.cookie).expect(200);
    });
  });

  describe('limites (plano §2.3)', () => {
    it('claim: 10 por hora por IP', async () => {
      const ip = nextIp();
      for (let i = 0; i < 10; i += 1)
        await claim(`cs_test_${randomBytes(12).toString('hex')}`, ip).expect(404);
      const limited = await claim(`cs_test_${randomBytes(12).toString('hex')}`, ip).expect(429);
      expect(limited.body).toMatchObject({ code: 'rate_limited' });
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      await claim(`cs_test_${randomBytes(12).toString('hex')}`).expect(404);
    });

    it('status: 12 por minuto por cookie (outro cookie no mesmo IP segue); sem cookie, pelo IP', async () => {
      const first = await claimed('provisioning');
      const second = await claimed('provisioning');
      const ip = nextIp();
      for (let i = 0; i < 12; i += 1) await status(first.cookie, ip).expect(200);
      await status(first.cookie, ip).expect(429);
      await status(second.cookie, ip).expect(200);
      clock.advance(MINUTE_MS);
      await status(first.cookie, ip).expect(200);

      const anonymous = nextIp();
      for (let i = 0; i < 12; i += 1) await status(undefined, anonymous).expect(404);
      await status(undefined, anonymous).expect(429);
    });

    it('reveal: 5 por hora por IP', async () => {
      const ip = nextIp();
      for (let i = 0; i < 5; i += 1) await reveal(undefined, {}, ip).expect(404);
      await reveal(undefined, {}, ip).expect(429);
    });
  });

  it('rotas internas não existem no cp-public', async () => {
    await request(app.getHttpServer()).post('/internal/access/reveal').send({}).expect(404);
    await request(app.getHttpServer()).post('/internal/steps/secrets.destroy_bootstrap').send({}).expect(404);
    await request(app.getHttpServer()).post('/v1/internal/access/reveal').send({}).expect(404);
  });

  it('CORS com credenciais só para o site, nas rotas de status', async () => {
    const response = await request(app.getHttpServer())
      .options('/v1/public/status')
      .set('Origin', SITE)
      .set('Access-Control-Request-Method', 'GET')
      .expect(204);
    expect(response.headers['access-control-allow-origin']).toBe(SITE);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('log-capture: nenhuma senha, cookie, link ou id de sessão no log', () => {
    expect(sensitive.size).toBeGreaterThan(10);
    for (const value of sensitive) expect(capture.text).not.toContain(value);
    expect(capture.text).not.toContain('@cliente-demo');
  });
});
