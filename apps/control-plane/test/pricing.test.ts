import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ULID_PATTERN } from '../src/common/ulid.js';
import { COLLECTIONS } from '../src/firestore/collections.js';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import { QUOTE_PER_IP } from '../src/pricing/pricing.controller.js';
import type { QuoteInput } from '../src/pricing/pricing.schema.js';
import { publicPricing } from '../src/pricing/public-pricing.js';
import { QUOTE_DAILY_LIMIT, QUOTE_TTL_MS, quoteDailyBucket } from '../src/pricing/quote-store.js';
import { priceTableSchema } from '../src/pricing/pricing.schema.js';
import { createApp } from './support/create-app.js';
import { FakeClock, MINUTE_MS } from './support/fake-clock.js';
import { LogCapture } from './support/log-capture.js';
import { fictitiousPriceTable } from './support/pricing-fixtures.js';
import { seedPublishedTable } from './support/pricing-seed.js';

const START = new Date('2026-11-04T12:00:00.000Z');
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Um pedido na tabela FICTÍCIA (`pricing-fixtures.ts`): a Plataforma com 4 GB/dia (2 incluídos + 2 adicionais). */
const CONFIGURATION: QuoteInput = { plan: 'plataforma', gbDay: 4 };

/**
 * A calculadora pública (`GET /v1/public/pricing` e `POST /v1/public/quote`) pelo app inteiro, sobre uma tabela
 * publicada FICTÍCIA, com o dublê do Firestore e um relógio falso. Um app por arquivo.
 */
describe('cp-public: tabela pública e cotação (preço por GB/dia)', () => {
  const capture = new LogCapture();
  const clock = new FakeClock(START);
  const documents = new MemoryDocumentStore();
  let app: NestExpressApplication;
  let ipSequence = 0;

  function nextIp(): string {
    ipSequence += 1;
    return ipSequence <= 250 ? `203.0.113.${ipSequence}` : `198.51.100.${ipSequence - 250}`;
  }

  function quote(body: unknown, ip = nextIp()): request.Test {
    return request(app.getHttpServer())
      .post('/v1/public/quote')
      .set('X-Forwarded-For', ip)
      .send(body as object);
  }

  function pricing(ip = nextIp()): request.Test {
    return request(app.getHttpServer()).get('/v1/public/pricing').set('X-Forwarded-For', ip);
  }

  beforeAll(async () => {
    app = await createApp({
      role: 'public',
      trustProxyHops: 1,
      capture,
      documentStore: documents,
      clock,
      env: { LOG_LEVEL: 'debug', SITE_ORIGINS: 'https://veraxsistemas.com.br' },
    });
    await app.listen(0, '127.0.0.1');
  });

  beforeEach(async () => {
    clock.set(START);
    documents.clear();
    await seedPublishedTable(documents, fictitiousPriceTable(), {
      effectiveFrom: new Date(START.getTime() - DAY_MS),
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /v1/public/pricing: a tabela vigente sem custos nem lookup_key, cacheável por 5 min no CDN', async () => {
    const response = await pricing().expect(200);

    expect(response.body).toEqual(
      JSON.parse(JSON.stringify(publicPricing('teste-v1', priceTableSchema.parse(fictitiousPriceTable())))),
    );
    expect(response.body).toMatchObject({ startingAt: { plataforma: { monthly: 100_000, setup: 0 } } });
    expect(response.headers['cache-control']).toBe('public, max-age=300');
    expect(JSON.stringify(response.body)).not.toMatch(/vc_|lookupKey|cost|margin|infrastructure/i);
  });

  it('sem tabela publicada vigente: 503 pricing_unavailable nas duas rotas (nunca um preço inventado)', async () => {
    documents.clear();
    // Uma tabela agendada para amanhã ainda não vale.
    await seedPublishedTable(documents, fictitiousPriceTable(), {
      effectiveFrom: new Date(START.getTime() + DAY_MS),
    });

    const catalog = await pricing().expect(503);
    expect(catalog.body).toMatchObject({ code: 'pricing_unavailable' });
    // O erro nunca fica no CDN: só a tabela respondida com sucesso é pública.
    expect(catalog.headers['cache-control']).toBe('private, no-store');
    await quote(CONFIGURATION).expect(503);
    expect(capture.entries().some((entry) => entry['event'] === 'pricing_table_missing')).toBe(true);

    clock.advance(DAY_MS);
    await pricing().expect(200);
  });

  it('POST /v1/public/quote: a base e o GB/dia adicional, os totais, o porte, o incluído e os limites; gravada por 24 h', async () => {
    const response = await quote(CONFIGURATION).expect(200);

    const body = response.body as Record<string, unknown>;
    expect(body).toEqual({
      contactUs: false,
      quoteId: expect.stringMatching(ULID_PATTERN) as unknown,
      priceTableVersion: 'teste-v1',
      expiresAt: new Date(START.getTime() + QUOTE_TTL_MS).toISOString(),
      currency: 'brl',
      configuration: { plan: 'plataforma', mode: 'managed', gbDay: 4, size: 'P', historyDays: 60 },
      size: 'P',
      sizeDescription: 'Porte de teste P',
      // Valores fictícios.
      lineItems: [
        {
          component: 'base',
          description: 'Plataforma (base mensal com a franquia incluída)',
          quantity: 1,
          unitAmount: 100_000,
          amount: 100_000,
          recurring: true,
        },
        {
          component: 'additional_gb_day',
          description: 'GB/dia adicional da franquia',
          quantity: 2,
          unitAmount: 30_000,
          amount: 60_000,
          recurring: true,
        },
      ],
      monthlyTotal: 160_000,
      setupTotal: 0,
      firstInvoiceTotal: 160_000,
      included: { gbDay: 2, historyDays: 60, users: 10 },
      limits: { maxCloudAccounts: 50, monthlyGib: 116, historyDays: 60, maxAgents: 0, maxUsers: 10 },
    });
    expect(JSON.stringify(body)).not.toContain('vc_');
    expect(response.headers['cache-control']).toBe('private, no-store');

    const stored = await documents.get(COLLECTIONS.quotes, String(body['quoteId']));
    expect(stored).toMatchObject({
      priceTableVersion: 'teste-v1',
      monthlyTotal: 160_000,
      expiresAt: new Date(START.getTime() + QUOTE_TTL_MS),
    });
    // A cotação gravada guarda os lookup_keys (o checkout precisa deles); a resposta, não.
    expect(JSON.stringify(stored)).toContain('vc_add_v1');
  });

  it('abaixo do incluído, a franquia sobe até ele e volta normalizada (só a base)', async () => {
    const response = await quote({ plan: 'plataforma', gbDay: 1 }).expect(200);
    expect(response.body).toMatchObject({
      configuration: { plan: 'plataforma', gbDay: 2, size: 'P' },
      monthlyTotal: 100_000,
    });
    expect((response.body as { lineItems: unknown[] }).lineItems).toHaveLength(1);
  });

  it('o Dedicado e o vCISO não são vendidos no site: 422 com a mensagem da proposta, nada gravado', async () => {
    const dedicated = await quote({ plan: 'dedicado', gbDay: 5 }).expect(422);
    expect(dedicated.body).toMatchObject({
      code: 'plan_not_sold_online',
      message:
        'Pelo site, só a Plataforma é contratada na hora. O Dedicado, o vCISO e o ambiente na infraestrutura da sua empresa são por proposta e contrato direto: fale com a Verax.',
    });
    // Sem nome de provedor na mensagem: a infraestrutura da Verax pode mudar.
    expect(JSON.stringify(dedicated.body)).not.toMatch(/gcp|google|aws|amazon/i);
    // Qualquer que seja a tabela: sem nenhuma publicada, a recusa é a mesma (não é falta de preço).
    documents.clear();
    await quote({ plan: 'vciso', gbDay: 5 }).expect(422);
    expect(await documents.query(COLLECTIONS.quotes)).toHaveLength(0);
    const refused = capture.entries().filter((entry) => entry['event'] === 'quote_plan_refused');
    expect(refused.map((entry) => entry['plan'])).toEqual(['dedicado', 'vciso']);
    // O lugar não é pergunta do site: pedir o ambiente no cliente é um campo desconhecido.
    await quote({ ...CONFIGURATION, mode: 'self_hosted' }).expect(400);
    // A tabela pública mostra os três planos (o Dedicado e o vCISO como referência, por contrato).
    await seedPublishedTable(documents, fictitiousPriceTable(), {
      effectiveFrom: new Date(START.getTime() - DAY_MS),
    });
    const catalog = await pricing().expect(200);
    expect(catalog.body).toMatchObject({
      plans: { plataforma: { sale: 'online' }, dedicado: { sale: 'contract' }, vciso: { sale: 'contract' } },
    });
  });

  it('sob consulta: acima do máximo do site; nada é gravado', async () => {
    const tooMuch = await quote({ plan: 'plataforma', gbDay: 6 }).expect(200);
    expect(tooMuch.body).toEqual({
      contactUs: true,
      reason: 'above_online_max',
      priceTableVersion: 'teste-v1',
    });
    expect(await documents.query(COLLECTIONS.quotes)).toHaveLength(0);
    const funnel = capture.entries().filter((entry) => entry['event'] === 'quote_contact_us');
    expect(funnel.map((entry) => [entry['plan'], entry['reason']])).toEqual([
      ['plataforma', 'above_online_max'],
    ]);
  });

  it('entrada fora do formato: 400 citando só os campos conhecidos; preço vindo do cliente é recusado', async () => {
    const cases: [unknown, string][] = [
      [{ ...CONFIGURATION, gbDay: 0 }, 'Configuração inválida: gbDay.'],
      [{ plan: 'enterprise', gbDay: 2.5 }, 'Configuração inválida: plan, gbDay.'],
      [{ ...CONFIGURATION, monthlyTotal: 1 }, 'Configuração inválida.'],
      [{ ...CONFIGURATION, unitAmount: 1, lookupKey: 'vc_add_v1' }, 'Configuração inválida.'],
      [{}, 'Configuração inválida: plan, gbDay.'],
    ];
    for (const [body, message] of cases) {
      const response = await quote(body).expect(400);
      expect(response.body, message).toMatchObject({ code: 'invalid_request', message });
    }
    expect(await documents.query(COLLECTIONS.quotes)).toHaveLength(0);
  });

  it(`limite por IP: ${QUOTE_PER_IP.capacity} cotações por hora; a seguinte recebe 429 com Retry-After`, async () => {
    const ip = nextIp();
    for (let i = 0; i < QUOTE_PER_IP.capacity; i += 1) await quote({}, ip).expect(400);
    const refused = await quote(CONFIGURATION, ip).expect(429);
    expect(refused.body).toMatchObject({ code: 'rate_limited' });
    expect(refused.headers['retry-after']).toBe(String(3 * 60));
    await quote(CONFIGURATION).expect(200);
  });

  it(`teto diário: com ${QUOTE_DAILY_LIMIT} cotações no dia, a próxima recebe 429 até a meia-noite (UTC)`, async () => {
    const bucket = quoteDailyBucket(clock.now());
    await documents.runTransaction((tx) => {
      tx.set(COLLECTIONS.rateLimits, bucket.id, { count: QUOTE_DAILY_LIMIT, expiresAt: bucket.endsAt });
      return Promise.resolve();
    });

    const refused = await quote(CONFIGURATION).expect(429);

    expect(refused.body).toMatchObject({ code: 'quote_daily_limit' });
    expect(refused.headers['retry-after']).toBe(String(12 * 60 * 60));
    const alert = capture.entries().find((entry) => entry['event'] === 'quote_daily_limit_reached');
    expect(alert).toMatchObject({ severity: 'WARNING', limit: QUOTE_DAILY_LIMIT, day: '2026-11-04' });
    expect(alert).not.toHaveProperty('req');
  });

  it('o log do funil leva o id, a versão, o plano, o GB/dia e o porte; nem IP, nem valores', async () => {
    const ip = nextIp();
    const response = await quote(CONFIGURATION, ip).expect(200);

    const issued = capture
      .entries()
      .filter((entry) => entry['event'] === 'quote_issued')
      .at(-1);
    expect(issued).toMatchObject({
      quoteId: (response.body as { quoteId: string }).quoteId,
      priceTableVersion: 'teste-v1',
      plan: 'plataforma',
      gbDay: 4,
      size: 'P',
      requestId: response.headers['x-request-id'],
    });
    expect(issued).not.toHaveProperty('req');
    const line = JSON.stringify(issued);
    expect(line).not.toContain(ip);
    for (const key of ['"monthlyTotal":', '"unitAmount":', '"amount":', '"lookupKey":']) {
      expect(capture.text, key).not.toContain(key);
    }
  });

  it('o console do responsável não existe no cp-public', async () => {
    await request(app.getHttpServer()).get('/v1/admin/pricing-tables').expect(404);
    await request(app.getHttpServer()).post('/v1/admin/dre/simulate').send({}).expect(404);
  });
});
