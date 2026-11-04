import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CHECKOUT_DAILY_LIMIT, SLUG_RESERVATION_MS } from '../src/checkout/checkout-store.js';
import { COLLECTIONS } from '../src/firestore/collections.js';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import { STRIPE_API_VERSION } from '../src/stripe/stripe-client.js';
import { createApp } from './support/create-app.js';
import { FakeClock, MINUTE_MS } from './support/fake-clock.js';
import { FakeStripe, fakeStripeKey, formEntries } from './support/fake-stripe.js';
import { LogCapture } from './support/log-capture.js';

const SITE = 'https://veraxsistemas.com.br';
const VERSION = '2026-11-04';
const ESSENCIAL = 'verax_control_essencial_mensal';
const PROFISSIONAL = 'verax_control_profissional_mensal';
const START = new Date('2026-11-04T12:00:00.000Z');

/** Dados fictícios (CLAUDE.md, regra 10): CNPJ alfanumérico do exemplo da Receita e um numérico com DV válido. */
const CNPJ_ALPHANUMERIC = '12.ABC.345/01DE-35';
const CNPJ_NUMERIC = '11.222.333/0001-81';

function order(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    plan: 'essencial',
    companyName: 'Cliente Demo A Ltda',
    cnpj: CNPJ_ALPHANUMERIC,
    adminEmail: 'admin@cliente-demo-a.example',
    slug: 'cliente-demo-a',
    consent: { terms: VERSION, privacy: VERSION, dpa: VERSION },
    ...overrides,
  };
}

/**
 * O checkout pelo app inteiro (CP-03), com o SDK oficial da Stripe apontado para o servidor falso em 127.0.0.1, o
 * dublê do Firestore e um relógio falso. Cada teste usa IPs próprios (endereços de documentação), porque o limite por
 * IP vive no app durante o arquivo todo; um app por arquivo (o nestjs-pino guarda o logger em estado estático).
 */
describe('cp-public: reserva de subdomínio e sessão do Checkout (CP-03)', () => {
  const capture = new LogCapture();
  const clock = new FakeClock(START);
  const documents = new MemoryDocumentStore();
  const fake = new FakeStripe();
  const stripeKey = fakeStripeKey('test', 'rk');
  let app: NestExpressApplication;
  let ipSequence = 0;

  /** Um IP novo (TEST-NET-3 e TEST-NET-2), para o limite por IP de um teste não alcançar o outro. */
  function nextIp(): string {
    ipSequence += 1;
    return ipSequence <= 250 ? `203.0.113.${ipSequence}` : `198.51.100.${ipSequence - 250}`;
  }

  function checkout(body: unknown, ip = nextIp()): request.Test {
    return request(app.getHttpServer())
      .post('/v1/public/checkout')
      .set('X-Forwarded-For', ip)
      .send(body as object);
  }

  function slugLookup(slug: string, ip = nextIp()): request.Test {
    return request(app.getHttpServer()).get(`/v1/public/slugs/${slug}`).set('X-Forwarded-For', ip);
  }

  async function slugDocument(slug: string): Promise<Record<string, unknown> | undefined> {
    return documents.get(COLLECTIONS.slugs, slug);
  }

  function seedPrices(): void {
    fake.addPrice(ESSENCIAL, 249_000);
  }

  beforeAll(async () => {
    const stripeApi = await fake.start();
    app = await createApp({
      role: 'public',
      // O socket do supertest faz o papel do front end do Cloud Run; o cliente é o último do X-Forwarded-For.
      trustProxyHops: 1,
      capture,
      documentStore: documents,
      clock,
      stripeApi,
      env: {
        // Debug: o teste de log prova a ausência de dado pessoal até nas linhas mais verbosas.
        LOG_LEVEL: 'debug',
        SITE_ORIGINS: `${SITE},https://www.veraxsistemas.com.br`,
        SITE_SUCCESS_URL: `${SITE}/checkout/sucesso?cs={CHECKOUT_SESSION_ID}`,
        SITE_CANCEL_URL: `${SITE}/#planos`,
        TERMS_VERSION: VERSION,
        PRIVACY_VERSION: VERSION,
        DPA_VERSION: VERSION,
        STRIPE_SECRET_KEY: stripeKey,
        STRIPE_LIVE: 'false',
        STRIPE_PRICE_LOOKUP_ESSENCIAL: ESSENCIAL,
        STRIPE_PRICE_LOOKUP_PROFISSIONAL: PROFISSIONAL,
      },
    });
    // Um servidor só, no ar o arquivo todo: o supertest abriria e fecharia um por requisição (são centenas aqui).
    await app.listen(0, '127.0.0.1');
  });

  beforeEach(() => {
    documents.clear();
    fake.reset();
    seedPrices();
  });

  afterAll(async () => {
    await app.close();
    await fake.stop();
  });

  it('abre a sessão com exatamente os parâmetros do plano (§4a) e devolve só {url, livemode}', async () => {
    const response = await checkout(order()).expect(201);

    const [session] = fake.calls('POST', '/v1/checkout/sessions');
    expect(session).toBeDefined();
    const sent = session?.form ?? new URLSearchParams();
    const tenantId = sent.get('client_reference_id') ?? '';
    const price = [...fake.prices.values()][0]?.['id'];
    const expiresAt = Math.floor(clock.now().getTime() / 1000) + 2 * 60 * 60;
    const metadata = (prefix: string): [string, string][] => [
      [`${prefix}[dpaVersion]`, VERSION],
      [`${prefix}[plan]`, 'essencial'],
      [`${prefix}[privacyVersion]`, VERSION],
      [`${prefix}[slug]`, 'cliente-demo-a'],
      [`${prefix}[tenantId]`, tenantId],
      [`${prefix}[termsVersion]`, VERSION],
    ];
    expect(formEntries(sent)).toEqual(
      formEntries(
        new URLSearchParams([
          ['mode', 'subscription'],
          ['line_items[0][price]', String(price)],
          ['line_items[0][quantity]', '1'],
          ['allowed_payment_method_types[0]', 'card'],
          ['allowed_payment_method_types[1]', 'boleto'],
          ['payment_method_options[boleto][expires_after_days]', '3'],
          ['locale', 'pt-BR'],
          ['customer_email', 'admin@cliente-demo-a.example'],
          ['billing_address_collection', 'required'],
          ['name_collection[business][enabled]', 'true'],
          ['consent_collection[terms_of_service]', 'required'],
          [
            'custom_text[terms_of_service_acceptance][message]',
            `Concordo com os [Termos de Uso](${SITE}/termos) (versão ${VERSION}), ` +
              `a [Política de Privacidade](${SITE}/privacidade) (versão ${VERSION}) e o ` +
              `[Acordo de Tratamento de Dados (DPA)](${SITE}/dpa) (versão ${VERSION}).`,
          ],
          ['allow_promotion_codes', 'true'],
          ['client_reference_id', tenantId],
          ...metadata('metadata'),
          ...metadata('subscription_data[metadata]'),
          ['expires_at', String(expiresAt)],
          ['success_url', `${SITE}/checkout/sucesso?cs={CHECKOUT_SESSION_ID}`],
          ['cancel_url', `${SITE}/#planos`],
        ]),
      ),
    );
    // A chave vai só à Stripe (aqui, o falso), com a versão fixada e uma chave de idempotência por reserva.
    expect(session?.headers['authorization']).toBe(`Bearer ${stripeKey}`);
    expect(session?.headers['stripe-version']).toBe(STRIPE_API_VERSION);
    expect(session?.headers['idempotency-key']).toBe(`checkout-session-${tenantId}`);
    // O preço veio pelo lookup_key do plano.
    const [lookup] = fake.calls('GET', '/v1/prices');
    expect(lookup?.query.get('lookup_keys[0]')).toBe(ESSENCIAL);

    const sessionId = [...fake.sessions.keys()][0];
    expect(response.body).toEqual({ url: `https://checkout.stripe.com/c/pay/${sessionId}`, livemode: false });
    expect(response.headers['cache-control']).toBe('private, no-store');

    // A reserva: o mesmo tenantId, 2 h 30, a sessão gravada e o pedido com o CNPJ normalizado.
    expect(await slugDocument('cliente-demo-a')).toEqual({
      state: 'reserved',
      tenantId,
      checkoutSessionId: sessionId,
      order: {
        plan: 'essencial',
        company: { legalName: 'Cliente Demo A Ltda', cnpj: '12ABC34501DE35' },
        adminEmail: 'admin@cliente-demo-a.example',
        consent: { termsVersion: VERSION, privacyVersion: VERSION, dpaVersion: VERSION },
      },
      updatedAt: clock.now(),
      expiresAt: new Date(clock.now().getTime() + SLUG_RESERVATION_MS),
    });
  });

  it('audita a reserva e a sessão (ator system), sem e-mail, CNPJ nem razão social', async () => {
    const response = await checkout(order()).set('X-Request-Id', 'site-trace-00000001').expect(201);
    expect(response.headers['x-request-id']).toBe('site-trace-00000001');

    const audit = (await documents.query(COLLECTIONS.auditLog)).map((doc) => doc.data);
    expect(audit.map((entry) => entry['action'])).toEqual([
      'checkout.slug_reserved',
      'checkout.session_created',
    ]);
    for (const entry of audit) {
      expect(entry).toMatchObject({ actor: 'system', requestId: 'site-trace-00000001' });
      expect(entry['tenantId']).toBe((await slugDocument('cliente-demo-a'))?.['tenantId']);
    }
    expect(audit[1]?.['details']).toEqual({
      slug: 'cliente-demo-a',
      plan: 'essencial',
      livemode: false,
      sessionExpiresAt: new Date(clock.now().getTime() + 2 * 60 * 60_000),
    });
    const raw = JSON.stringify(audit);
    for (const personal of ['admin@cliente-demo-a.example', '12ABC34501DE35', 'Cliente Demo A', 'cs_test_']) {
      expect(raw).not.toContain(personal);
    }
  });

  it('CNPJ alfanumérico com máscara e numérico aceitos; DV errado recusado sem reservar nem chamar a Stripe', async () => {
    await checkout(order()).expect(201);
    await checkout(order({ slug: 'cliente-demo-b', cnpj: CNPJ_NUMERIC })).expect(201);
    await checkout(order({ slug: 'cliente-demo-c', cnpj: '12abc34501de35' })).expect(201);
    expect((await slugDocument('cliente-demo-b'))?.['order']).toMatchObject({
      company: { cnpj: '11222333000181' },
    });
    const sessionsBefore = fake.calls('POST', '/v1/checkout/sessions').length;

    const wrong = await checkout(order({ slug: 'cliente-demo-d', cnpj: '12.ABC.345/01DE-36' })).expect(400);

    expect(wrong.body).toMatchObject({
      statusCode: 400,
      code: 'invalid_request',
      message: 'Dados do pedido inválidos: cnpj.',
    });
    expect(await slugDocument('cliente-demo-d')).toBeUndefined();
    expect(fake.calls('POST', '/v1/checkout/sessions')).toHaveLength(sessionsBefore);
  });

  it('pedido fora do formato: 400 citando só os campos conhecidos, sem reservar', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [order({ plan: 'enterprise' }), 'Dados do pedido inválidos: plan.'],
      [order({ adminEmail: 'nao-e-email' }), 'Dados do pedido inválidos: adminEmail.'],
      [order({ slug: 'Cliente_Demo' }), 'Dados do pedido inválidos: slug.'],
      [order({ companyName: 'Cliente\nDemo' }), 'Dados do pedido inválidos: companyName.'],
      [order({ consent: { terms: VERSION, privacy: VERSION } }), 'Dados do pedido inválidos: consent.'],
      [order({ campoNovo: 'x' }), 'Dados do pedido inválidos.'],
    ];
    for (const [body, message] of cases) {
      const response = await checkout(body).expect(400);
      expect(response.body, message).toMatchObject({ code: 'invalid_request', message });
    }
    await checkout('texto').set('Content-Type', 'text/plain').expect(400);
    expect(await documents.query(COLLECTIONS.slugs)).toHaveLength(0);
    expect(fake.writes()).toHaveLength(0);
  });

  it('subdomínio da lista reservada: 409 slug_unavailable, igual à consulta', async () => {
    const response = await checkout(order({ slug: 'suporte' })).expect(409);
    expect(response.body).toMatchObject({ code: 'slug_unavailable' });
    await slugLookup('suporte').expect(200, { available: false });
    expect(fake.writes()).toHaveLength(0);
  });

  it('versão do aceite diferente da vigente: 409 terms_outdated, sem reserva nem Stripe', async () => {
    const response = await checkout(
      order({ consent: { terms: VERSION, privacy: '2026-01-01', dpa: VERSION } }),
    ).expect(409);
    expect(response.body).toMatchObject({ code: 'terms_outdated' });
    expect(await slugDocument('cliente-demo-a')).toBeUndefined();
    expect(fake.requests).toHaveLength(0);
  });

  it('o mesmo subdomínio duas vezes falha, em sequência e ao mesmo tempo; só uma sessão é aberta', async () => {
    await checkout(order()).expect(201);
    const again = await checkout(order({ companyName: 'Cliente Demo B Ltda' })).expect(409);
    expect(again.body).toMatchObject({ code: 'slug_unavailable' });

    const concurrent = await Promise.all([
      checkout(order({ slug: 'cliente-demo-b' })),
      checkout(order({ slug: 'cliente-demo-b' })),
      checkout(order({ slug: 'cliente-demo-b' })),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([201, 409, 409]);
    expect(fake.calls('POST', '/v1/checkout/sessions')).toHaveLength(2);
  });

  it('a reserva vence em 2 h 30: antes, indisponível; depois, outro pedido reserva o subdomínio', async () => {
    await checkout(order()).expect(201);
    const first = (await slugDocument('cliente-demo-a'))?.['tenantId'];

    clock.advance(SLUG_RESERVATION_MS - MINUTE_MS);
    await slugLookup('cliente-demo-a').expect(200, { available: false });
    await checkout(order()).expect(409);

    clock.advance(MINUTE_MS);
    await slugLookup('cliente-demo-a').expect(200, { available: true });
    await checkout(order()).expect(201);
    expect((await slugDocument('cliente-demo-a'))?.['tenantId']).not.toBe(first);
  });

  it('a Stripe falha depois da reserva: 502 checkout_failed, a reserva é desfeita e o subdomínio volta a estar livre', async () => {
    fake.failures.set('POST /v1/checkout/sessions', {
      status: 400,
      type: 'invalid_request_error',
      code: 'email_invalid',
      // Como a Stripe faz: o valor recusado volta na mensagem. O log não pode levá-lo adiante.
      message: 'Invalid email address: admin@cliente-demo-a.example',
    });

    const failed = await checkout(order()).expect(502);

    expect(failed.body).toMatchObject({ statusCode: 502, code: 'checkout_failed', message: 'Erro interno' });
    const released = await slugDocument('cliente-demo-a');
    expect(released).toMatchObject({ state: 'released' });
    expect(released).not.toHaveProperty('order');
    expect(released).not.toHaveProperty('expiresAt');
    const actions = (await documents.query(COLLECTIONS.auditLog)).map((doc) => doc.data['action']);
    expect(actions).toEqual(['checkout.slug_reserved', 'checkout.slug_released']);
    const logged = capture.entries().find((entry) => entry['event'] === 'checkout_session_failed');
    expect(logged).toMatchObject({
      tenantId: released?.['tenantId'],
      stripe: { type: 'StripeInvalidRequestError', code: 'email_invalid', statusCode: 400 },
    });

    await slugLookup('cliente-demo-a').expect(200, { available: true });
    await checkout(order()).expect(201);
    expect(await slugDocument('cliente-demo-a')).toMatchObject({ state: 'reserved' });
  });

  it('preço do plano ausente na Stripe: 503 checkout_unavailable, sem reservar; com o preço, abre', async () => {
    const missing = await checkout(order({ plan: 'profissional' })).expect(503);
    expect(missing.body).toMatchObject({
      statusCode: 503,
      code: 'checkout_unavailable',
      message: 'Serviço temporariamente indisponível',
    });
    expect(await slugDocument('cliente-demo-a')).toBeUndefined();
    expect(capture.entries().some((entry) => entry['event'] === 'checkout_price_invalid')).toBe(true);

    const price = fake.addPrice(PROFISSIONAL, 499_000);
    await checkout(order({ plan: 'profissional' })).expect(201);
    const [session] = fake.calls('POST', '/v1/checkout/sessions');
    expect(session?.form.get('line_items[0][price]')).toBe(price['id']);
    expect(session?.form.get('metadata[plan]')).toBe('profissional');
  });

  it('a sessão sem boleto (desligado no Dashboard) segue, mas avisa no log', async () => {
    fake.enabledPaymentMethods = ['card'];
    await checkout(order()).expect(201);
    const warning = capture.entries().find((entry) => entry['event'] === 'checkout_payment_methods_missing');
    expect(warning).toMatchObject({ missing: ['boleto'], severity: 'WARNING' });
  });

  it('limite por IP: 5 pedidos de checkout por hora; o 6º recebe 429 rate_limited com Retry-After', async () => {
    const ip = nextIp();
    for (let i = 0; i < 5; i += 1) await checkout({}, ip).expect(400);

    const refused = await checkout(order(), ip).expect(429);

    expect(refused.body).toMatchObject({ statusCode: 429, code: 'rate_limited' });
    expect(refused.headers['retry-after']).toBe(String(12 * 60));
    expect(await slugDocument('cliente-demo-a')).toBeUndefined();
    // Outro IP segue livre.
    await checkout(order()).expect(201);
    clock.advance(12 * MINUTE_MS);
    await checkout(order({ slug: 'cliente-demo-b' }), ip).expect(201);
  });

  it('consulta de subdomínio: só available, sem reservar; 30 por minuto por IP', async () => {
    const ip = nextIp();
    const free = await slugLookup('cliente-demo-z', ip).expect(200);
    expect(free.body).toEqual({ available: true });
    expect(await slugDocument('cliente-demo-z')).toBeUndefined();
    await slugLookup('Cliente_Demo', ip).expect(200, { available: false });
    for (let i = 0; i < 28; i += 1) await slugLookup('cliente-demo-z', ip).expect(200);

    const refused = await slugLookup('cliente-demo-z', ip).expect(429);
    expect(refused.body).toMatchObject({ code: 'rate_limited' });
    expect(refused.headers['retry-after']).toBe('2');
  });

  it(`teto diário: a ${CHECKOUT_DAILY_LIMIT + 1}ª sessão do dia é recusada com 429 e uma linha de log para o alerta`, async () => {
    // Um dia novo (UTC): o balde começa do zero.
    clock.set(new Date('2026-11-06T09:00:00.000Z'));
    const ips = Array.from({ length: 10 }, () => nextIp());
    for (let i = 0; i < CHECKOUT_DAILY_LIMIT; i += 1) {
      const slug = `teto-${String(i + 1).padStart(2, '0')}`;
      await checkout(order({ slug }), ips[i % ips.length]).expect(201);
    }
    expect(fake.calls('POST', '/v1/checkout/sessions')).toHaveLength(CHECKOUT_DAILY_LIMIT);
    const before = capture.lines.length;

    const refused = await checkout(order({ slug: 'teto-51' })).expect(429);

    expect(refused.body).toMatchObject({ statusCode: 429, code: 'checkout_daily_limit' });
    // Até a meia-noite UTC: 15 h.
    expect(refused.headers['retry-after']).toBe(String(15 * 60 * 60));
    expect(fake.calls('POST', '/v1/checkout/sessions')).toHaveLength(CHECKOUT_DAILY_LIMIT);
    await slugLookup('teto-51').expect(200, { available: true });
    const alert = capture
      .entries()
      .slice(before)
      .filter((entry) => entry['event'] === 'checkout_daily_limit_reached');
    expect(alert).toHaveLength(1);
    expect(alert[0]).toMatchObject({
      severity: 'WARNING',
      limit: CHECKOUT_DAILY_LIMIT,
      day: '2026-11-06',
      requestId: refused.headers['x-request-id'],
    });
    // Só isto (mais `pid` e `hostname`, do pino): nem o `req` da requisição (que leva o IP do cliente), nem nada do
    // pedido.
    expect(Object.keys(alert[0] ?? {}).sort()).toEqual(
      [
        'context',
        'day',
        'event',
        'hostname',
        'level',
        'limit',
        'message',
        'pid',
        'requestId',
        'severity',
        'time',
      ].sort(),
    );

    clock.set(new Date('2026-11-07T00:00:00.000Z'));
    await checkout(order({ slug: 'teto-51' })).expect(201);
  });

  it('corpo acima de 16 KB é recusado (413) antes de qualquer validação', async () => {
    const response = await checkout(order({ companyName: 'x'.repeat(17 * 1024) })).expect(413);
    expect(response.body).toMatchObject({ statusCode: 413, message: 'Requisição muito grande' });
    expect(fake.requests).toHaveLength(0);
  });

  it('CORS: só as origens do site, sem credentials fora do status, X-Request-Id exposto; outra origem não recebe nada', async () => {
    const preflight = await request(app.getHttpServer())
      .options('/v1/public/checkout')
      .set('Origin', SITE)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type')
      .expect(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(SITE);
    expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();
    expect(preflight.headers['access-control-allow-methods']).toBe('GET,POST');
    expect(preflight.headers['access-control-allow-headers']).toBe('Content-Type');

    const allowed = await checkout(order()).set('Origin', SITE).expect(201);
    expect(allowed.headers['access-control-allow-origin']).toBe(SITE);
    expect(allowed.headers['access-control-expose-headers']).toBe('X-Request-Id');
    expect(allowed.headers['access-control-allow-credentials']).toBeUndefined();

    const foreignPreflight = await request(app.getHttpServer())
      .options('/v1/public/checkout')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(foreignPreflight.status).toBe(404);
    const foreign = await slugLookup('cliente-demo-z').set('Origin', 'https://evil.example').expect(200);
    for (const response of [foreignPreflight, foreign]) {
      expect(Object.keys(response.headers).filter((header) => header.startsWith('access-control-'))).toEqual(
        [],
      );
    }

    // As rotas de status (CP-05) são as únicas com credentials.
    const status = await request(app.getHttpServer())
      .options('/v1/public/status')
      .set('Origin', SITE)
      .set('Access-Control-Request-Method', 'GET')
      .expect(204);
    expect(status.headers['access-control-allow-credentials']).toBe('true');
  });

  it('nenhum log leva a chave da Stripe, o e-mail, o CNPJ ou a razão social', async () => {
    // Um pouco de tudo: sucesso, CNPJ errado, versão vencida, falha da Stripe e conflito.
    await checkout(order()).expect(201);
    await checkout(order({ slug: 'cliente-demo-b', cnpj: '12.ABC.345/01DE-36' })).expect(400);
    await checkout(
      order({ slug: 'cliente-demo-b', consent: { terms: 'x', privacy: VERSION, dpa: VERSION } }),
    ).expect(409);
    fake.failures.set('POST /v1/checkout/sessions', {
      status: 400,
      type: 'invalid_request_error',
      message: 'Invalid email address: admin@cliente-demo-a.example; Cliente Demo A Ltda; 12ABC34501DE35',
    });
    await checkout(order({ slug: 'cliente-demo-b' })).expect(502);
    await checkout(order()).expect(409);

    const text = capture.text;
    // Não é vácuo: as linhas do checkout estão lá, inclusive as de debug do filtro de erros.
    expect(text).toContain('checkout_session_created');
    expect(text).toContain('checkout_session_failed');
    expect(text).toContain('requisição rejeitada');
    const forbidden = [
      stripeKey,
      stripeKey.slice(-12),
      'admin@cliente-demo-a.example',
      'cliente-demo-a.example',
      '12ABC34501DE35',
      '12.ABC.345/01DE-35',
      '12.ABC.345/01DE-36',
      '12ABC34501DE36',
      '11222333000181',
      'Cliente Demo A Ltda',
    ];
    for (const value of forbidden) expect(text, value).not.toContain(value);
  });
});
