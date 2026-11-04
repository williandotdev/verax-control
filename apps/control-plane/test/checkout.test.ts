import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CHECKOUT_DAILY_LIMIT, SLUG_RESERVATION_MS } from '../src/checkout/checkout-store.js';
import { COLLECTIONS } from '../src/firestore/collections.js';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import type { ConfigurationInput, PriceTableInput } from '../src/pricing/pricing.schema.js';
import { QUOTE_TTL_MS } from '../src/pricing/quote-store.js';
import { STRIPE_API_VERSION } from '../src/stripe/stripe-client.js';
import { createApp } from './support/create-app.js';
import { FakeClock, MINUTE_MS } from './support/fake-clock.js';
import { FakeStripe, fakeStripeKey, formEntries } from './support/fake-stripe.js';
import { LogCapture } from './support/log-capture.js';
import { fictitiousPriceTable } from './support/pricing-fixtures.js';
import { seedPublishedTable, seedStripePrices } from './support/pricing-seed.js';

const SITE = 'https://veraxsistemas.com.br';
const VERSION = '2026-11-04';
const START = new Date('2026-11-04T12:00:00.000Z');
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Dados fictícios (CLAUDE.md, regra 10): CNPJ alfanumérico do exemplo da Receita e um numérico com DV válido. */
const CNPJ_ALPHANUMERIC = '12.ABC.345/01DE-35';
const CNPJ_NUMERIC = '11.222.333/0001-81';

/**
 * A configuração do teste, na tabela FICTÍCIA (`pricing-fixtures.ts`, valores redondos e inventados): porte P, duas
 * contas a mais, a primeira faixa de volume, um pacote de agentes, o primeiro histórico estendido e o suporte
 * prioritário. Seis itens mensais.
 */
const CONFIGURATION: ConfigurationInput = {
  mode: 'managed',
  cloudAccounts: 4,
  monthlyGib: 50,
  agents: 10,
  historyDays: 180,
  support: 'priority',
};

/**
 * O checkout pela cotação (preço configurável, sobre o CP-03), pelo app inteiro, com o SDK oficial da Stripe apontado
 * para o servidor falso em 127.0.0.1, o dublê do Firestore e um relógio falso. A cotação sai de `POST /v1/public/quote`
 * sobre uma tabela publicada fictícia. Cada teste usa IPs próprios (endereços de documentação), porque o limite por IP
 * vive no app durante o arquivo todo; um app por arquivo (o nestjs-pino guarda o logger em estado estático).
 */
describe('cp-public: checkout pela cotação, com vários itens (preço configurável)', () => {
  const capture = new LogCapture();
  const clock = new FakeClock(START);
  const documents = new MemoryDocumentStore();
  const fake = new FakeStripe();
  const stripeKey = fakeStripeKey('test', 'rk');
  let app: NestExpressApplication;
  let ipSequence = 0;
  let prices = new Map<string, string>();
  let quoteId = '';
  /**
   * Cada teste começa 10 min depois do anterior, no mesmo dia: o checkout guarda os preços lidos da Stripe por 5 min,
   * e a Stripe falsa recria os preços (com ids novos) a cada teste.
   */
  let testStart = START.getTime();

  /** Um IP novo (TEST-NET-3 e TEST-NET-2), para o limite por IP de um teste não alcançar o outro. */
  function nextIp(): string {
    ipSequence += 1;
    return ipSequence <= 250 ? `203.0.113.${ipSequence}` : `198.51.100.${ipSequence - 250}`;
  }

  function order(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      quoteId,
      companyName: 'Cliente Demo A Ltda',
      cnpj: CNPJ_ALPHANUMERIC,
      adminEmail: 'admin@cliente-demo-a.example',
      slug: 'cliente-demo-a',
      consent: { terms: VERSION, privacy: VERSION, dpa: VERSION },
      ...overrides,
    };
  }

  function checkout(body: unknown, ip = nextIp()): request.Test {
    return request(app.getHttpServer())
      .post('/v1/public/checkout')
      .set('X-Forwarded-For', ip)
      .send(body as object);
  }

  async function newQuote(configuration: ConfigurationInput = CONFIGURATION): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/v1/public/quote')
      .set('X-Forwarded-For', nextIp())
      .send(configuration)
      .expect(200);
    return String((response.body as { quoteId: string }).quoteId);
  }

  function slugLookup(slug: string, ip = nextIp()): request.Test {
    return request(app.getHttpServer()).get(`/v1/public/slugs/${slug}`).set('X-Forwarded-For', ip);
  }

  async function slugDocument(slug: string): Promise<Record<string, unknown> | undefined> {
    return documents.get(COLLECTIONS.slugs, slug);
  }

  async function seed(table: PriceTableInput = fictitiousPriceTable()): Promise<void> {
    await seedPublishedTable(documents, table, { effectiveFrom: new Date(START.getTime() - DAY_MS) });
    prices = seedStripePrices(fake, table);
    quoteId = await newQuote();
  }

  function price(lookupKey: string): string {
    return prices.get(lookupKey) ?? `ausente:${lookupKey}`;
  }

  function lineItemsOf(form: URLSearchParams | undefined): [string, string][] {
    return [...(form ?? new URLSearchParams()).entries()].filter(([key]) => key.startsWith('line_items'));
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
      },
    });
    // Um servidor só, no ar o arquivo todo: o supertest abriria e fecharia um por requisição (são centenas aqui).
    await app.listen(0, '127.0.0.1');
  });

  beforeEach(async () => {
    testStart += 10 * MINUTE_MS;
    clock.set(new Date(testStart));
    documents.clear();
    fake.reset();
    await seed();
  });

  afterAll(async () => {
    await app.close();
    await fake.stop();
  });

  it('abre a sessão com um item por componente da cotação, nos parâmetros exatos, e grava a configuração na reserva', async () => {
    const response = await checkout(order()).expect(201);

    const [session] = fake.calls('POST', '/v1/checkout/sessions');
    expect(session).toBeDefined();
    const sent = session?.form ?? new URLSearchParams();
    const tenantId = sent.get('client_reference_id') ?? '';
    const expiresAt = Math.floor(clock.now().getTime() / 1000) + 2 * 60 * 60;
    const metadata = (prefix: string): [string, string][] => [
      [`${prefix}[dpaVersion]`, VERSION],
      [`${prefix}[mode]`, 'managed'],
      [`${prefix}[priceTableVersion]`, 'teste-v1'],
      [`${prefix}[privacyVersion]`, VERSION],
      [`${prefix}[quoteId]`, quoteId],
      [`${prefix}[size]`, 'P'],
      [`${prefix}[slug]`, 'cliente-demo-a'],
      [`${prefix}[tenantId]`, tenantId],
      [`${prefix}[termsVersion]`, VERSION],
    ];
    expect(formEntries(sent)).toEqual(
      formEntries(
        new URLSearchParams([
          ['mode', 'subscription'],
          // Os itens da cotação, na ordem dela, com o preço da Stripe achado pelo lookup_key de cada componente.
          ['line_items[0][price]', price('vc_env_p_v1')],
          ['line_items[0][quantity]', '1'],
          ['line_items[1][price]', price('vc_acc_v1')],
          ['line_items[1][quantity]', '2'],
          ['line_items[2][price]', price('vc_vol_50_v1')],
          ['line_items[2][quantity]', '1'],
          ['line_items[3][price]', price('vc_agt_v1')],
          ['line_items[3][quantity]', '1'],
          ['line_items[4][price]', price('vc_his_180_v1')],
          ['line_items[4][quantity]', '1'],
          ['line_items[5][price]', price('vc_sup_v1')],
          ['line_items[5][quantity]', '1'],
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
    // Os seis preços vieram numa consulta só, pelos lookup_keys da cotação.
    const lookups = fake.calls('GET', '/v1/prices');
    expect(lookups).toHaveLength(1);
    expect([...(lookups[0]?.query.keys() ?? [])].filter((key) => key.startsWith('lookup_keys'))).toHaveLength(
      6,
    );

    const sessionId = [...fake.sessions.keys()][0];
    expect(response.body).toEqual({ url: `https://checkout.stripe.com/c/pay/${sessionId}`, livemode: false });
    expect(response.headers['cache-control']).toBe('private, no-store');

    // A reserva: o mesmo tenantId, 2 h 30, a sessão gravada e o pedido com a configuração, os limites e o preço da
    // cotação (que o CP-04 copia para o cliente) e o CNPJ normalizado.
    expect(await slugDocument('cliente-demo-a')).toEqual({
      state: 'reserved',
      tenantId,
      checkoutSessionId: sessionId,
      order: {
        configuration: { ...CONFIGURATION, size: 'P' },
        limits: { maxCloudAccounts: 4, monthlyGib: 50, historyDays: 180, maxAgents: 10, maxUsers: 10 },
        // Fictícios: ambiente 1.000 + 2 contas × 30 + volume 100 + 1 pacote 100 + histórico 20 + suporte 300.
        pricing: { priceTableVersion: 'teste-v1', quoteId, monthlyTotal: 158_000, setupTotal: 0 },
        company: { legalName: 'Cliente Demo A Ltda', cnpj: '12ABC34501DE35' },
        adminEmail: 'admin@cliente-demo-a.example',
        consent: { termsVersion: VERSION, privacyVersion: VERSION, dpaVersion: VERSION },
      },
      updatedAt: clock.now(),
      expiresAt: new Date(clock.now().getTime() + SLUG_RESERVATION_MS),
    });
  });

  it('com implantação no modo, ela entra como o último item (avulso, só na primeira fatura)', async () => {
    documents.clear();
    fake.reset();
    const table = fictitiousPriceTable();
    table.modes.managed.setup = { amount: 50_000, lookupKey: 'vc_set_m_v1' };
    await seed(table);

    await checkout(order()).expect(201);

    expect(lineItemsOf(fake.calls('POST', '/v1/checkout/sessions')[0]?.form)).toEqual([
      ['line_items[0][price]', price('vc_env_p_v1')],
      ['line_items[0][quantity]', '1'],
      ['line_items[1][price]', price('vc_acc_v1')],
      ['line_items[1][quantity]', '2'],
      ['line_items[2][price]', price('vc_vol_50_v1')],
      ['line_items[2][quantity]', '1'],
      ['line_items[3][price]', price('vc_agt_v1')],
      ['line_items[3][quantity]', '1'],
      ['line_items[4][price]', price('vc_his_180_v1')],
      ['line_items[4][quantity]', '1'],
      ['line_items[5][price]', price('vc_sup_v1')],
      ['line_items[5][quantity]', '1'],
      ['line_items[6][price]', price('vc_set_m_v1')],
      ['line_items[6][quantity]', '1'],
    ]);
    expect((await slugDocument('cliente-demo-a'))?.['order']).toMatchObject({
      pricing: { monthlyTotal: 158_000, setupTotal: 50_000 },
    });
  });

  it('a configuração mínima tem um item só, o ambiente', async () => {
    quoteId = await newQuote({
      mode: 'managed',
      cloudAccounts: 0,
      monthlyGib: 0,
      agents: 0,
      historyDays: 0,
      support: 'standard',
    });
    await checkout(order()).expect(201);
    expect(lineItemsOf(fake.calls('POST', '/v1/checkout/sessions')[0]?.form)).toEqual([
      ['line_items[0][price]', price('vc_env_p_v1')],
      ['line_items[0][quantity]', '1'],
    ]);
  });

  it('audita a reserva e a sessão (ator system), sem e-mail, CNPJ, razão social nem valores', async () => {
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
      size: 'P',
      priceTableVersion: 'teste-v1',
      quoteId,
      livemode: false,
      sessionExpiresAt: new Date(clock.now().getTime() + 2 * 60 * 60_000),
    });
    const raw = JSON.stringify(audit);
    for (const personal of [
      'admin@cliente-demo-a.example',
      '12ABC34501DE35',
      'Cliente Demo A',
      'cs_test_',
      '158000',
    ]) {
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

  it('pedido fora do formato: 400 citando só os campos conhecidos; preço, plano ou itens vindos do site são recusados', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [order({ quoteId: 'nao-e-uma-cotacao' }), 'Dados do pedido inválidos: quoteId.'],
      [order({ quoteId: undefined }), 'Dados do pedido inválidos: quoteId.'],
      [order({ adminEmail: 'nao-e-email' }), 'Dados do pedido inválidos: adminEmail.'],
      [order({ slug: 'Cliente_Demo' }), 'Dados do pedido inválidos: slug.'],
      [order({ companyName: 'Cliente\nDemo' }), 'Dados do pedido inválidos: companyName.'],
      [order({ consent: { terms: VERSION, privacy: VERSION } }), 'Dados do pedido inválidos: consent.'],
      // O preço nunca vem do cliente: qualquer campo a mais é recusado, sem ser ecoado.
      [order({ plan: 'essencial' }), 'Dados do pedido inválidos.'],
      [order({ monthlyTotal: 1 }), 'Dados do pedido inválidos.'],
      [order({ lineItems: [{ price: 'price_qualquer', quantity: 1 }] }), 'Dados do pedido inválidos.'],
    ];
    for (const [body, message] of cases) {
      const response = await checkout(body).expect(400);
      expect(response.body, message).toMatchObject({ code: 'invalid_request', message });
    }
    await checkout('texto').set('Content-Type', 'text/plain').expect(400);
    expect(await documents.query(COLLECTIONS.slugs)).toHaveLength(0);
    expect(fake.writes()).toHaveLength(0);
  });

  it('cotação inexistente ou vencida (24 h): 409 quote_outdated, sem reservar nem chamar a Stripe', async () => {
    const unknown = await checkout(order({ quoteId: '01JBZZZZZZZZZZZZZZZZZZZZZZ' })).expect(409);
    expect(unknown.body).toMatchObject({ code: 'quote_outdated' });

    clock.advance(QUOTE_TTL_MS - 1);
    await checkout(order({ slug: 'cliente-demo-b' })).expect(201);
    clock.advance(1);
    const expired = await checkout(order({ slug: 'cliente-demo-c' })).expect(409);
    expect(expired.body).toMatchObject({ code: 'quote_outdated' });
    expect(await slugDocument('cliente-demo-c')).toBeUndefined();
    expect(fake.calls('POST', '/v1/checkout/sessions')).toHaveLength(1);
  });

  it('cotação adulterada no banco (total diferente do recálculo pela tabela): 409 e alerta no log', async () => {
    const stored = await documents.get(COLLECTIONS.quotes, quoteId);
    await documents.runTransaction((tx) => {
      tx.set(COLLECTIONS.quotes, quoteId, { ...stored, monthlyTotal: 1_000 });
      return Promise.resolve();
    });

    const response = await checkout(order()).expect(409);

    expect(response.body).toMatchObject({ code: 'quote_outdated' });
    expect(capture.entries().some((entry) => entry['event'] === 'checkout_quote_mismatch')).toBe(true);
    expect(fake.requests).toHaveLength(0);
  });

  it('uma tabela nova publicada depois da cotação não muda o preço dela: a cotação vale até vencer', async () => {
    const newer = fictitiousPriceTable();
    newer.modes.managed.environment.P = { amount: 120_000, lookupKey: 'vc_env_p_v2' };
    await seedPublishedTable(documents, newer, { version: 'teste-v2', effectiveFrom: clock.now() });
    fake.addPrice('vc_env_p_v2', 120_000);

    await checkout(order()).expect(201);

    const sent = fake.calls('POST', '/v1/checkout/sessions')[0]?.form;
    expect(sent?.get('line_items[0][price]')).toBe(price('vc_env_p_v1'));
    expect(sent?.get('metadata[priceTableVersion]')).toBe('teste-v1');
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

  it('preço da cotação ausente, com outro valor, inativo, de outro tipo ou em outra moeda na Stripe: 503, sem reservar', async () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ['vc_sup_v1', { lookup_key: 'outro_lookup_key' }, 'missing'],
      ['vc_acc_v1', { unit_amount: 2_999 }, 'amount'],
      ['vc_vol_50_v1', { active: false }, 'inactive'],
      ['vc_agt_v1', { type: 'one_time', recurring: null }, 'interval'],
      ['vc_his_180_v1', { currency: 'usd' }, 'currency'],
    ];
    for (const [lookupKey, change, problem] of cases) {
      fake.reset();
      prices = seedStripePrices(fake, fictitiousPriceTable());
      const target = fake.prices.get(price(lookupKey));
      if (target !== undefined) Object.assign(target, change);
      const before = capture.lines.length;

      const response = await checkout(order()).expect(503);

      expect(response.body, problem).toMatchObject({ statusCode: 503, code: 'checkout_unavailable' });
      const logged = capture
        .entries()
        .slice(before)
        .find((entry) => entry['event'] === 'checkout_price_invalid');
      expect(logged, problem).toMatchObject({ lookupKey, problem });
    }
    expect(await slugDocument('cliente-demo-a')).toBeUndefined();
    expect(fake.calls('POST', '/v1/checkout/sessions')).toHaveLength(0);
  });

  it('implantação cadastrada como mensal na Stripe: 503 (o item avulso precisa de preço avulso)', async () => {
    documents.clear();
    fake.reset();
    const table = fictitiousPriceTable();
    table.modes.managed.setup = { amount: 50_000, lookupKey: 'vc_set_m_v1' };
    await seed(table);
    const setup = fake.prices.get(price('vc_set_m_v1'));
    if (setup !== undefined) {
      Object.assign(setup, { type: 'recurring', recurring: { interval: 'month', interval_count: 1 } });
    }
    const before = capture.lines.length;

    await checkout(order()).expect(503);

    const logged = capture
      .entries()
      .slice(before)
      .find((entry) => entry['event'] === 'checkout_price_invalid');
    expect(logged).toMatchObject({ lookupKey: 'vc_set_m_v1', problem: 'type' });
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

  it(`teto diário: a ${CHECKOUT_DAILY_LIMIT + 1}ª sessão do dia é recusada com 429 e uma linha de log para o alerta`, async () => {
    // Um dia novo (UTC): o balde começa do zero. A cotação de antes venceu: uma nova.
    clock.set(new Date('2026-11-06T09:00:00.000Z'));
    quoteId = await newQuote();
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

  it('nenhum log leva a chave da Stripe, o e-mail, o CNPJ, a razão social ou valores da cotação', async () => {
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
      // Os valores ficam na cotação e na reserva, nunca no log (nenhum campo de valor em linha nenhuma).
      '"monthlyTotal":',
      '"setupTotal":',
      '"unitAmount":',
      '"amount":',
    ];
    for (const value of forbidden) expect(text, value).not.toContain(value);
  });
});
