import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ULID_PATTERN } from '../src/common/ulid.js';
import { COLLECTIONS } from '../src/firestore/collections.js';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import { QUOTE_PER_IP } from '../src/pricing/pricing.controller.js';
import type { ConfigurationInput } from '../src/pricing/pricing.schema.js';
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

/** Uma configuração na tabela FICTÍCIA (`pricing-fixtures.ts`): porte P com seis itens. */
const CONFIGURATION: ConfigurationInput = {
  mode: 'managed',
  cloudAccounts: 4,
  monthlyGib: 50,
  agents: 10,
  historyDays: 180,
  support: 'priority',
};

/**
 * A calculadora pública (`GET /v1/public/pricing` e `POST /v1/public/quote`) pelo app inteiro, sobre uma tabela
 * publicada FICTÍCIA, com o dublê do Firestore e um relógio falso. Um app por arquivo.
 */
describe('cp-public: tabela pública e cotação (preço configurável)', () => {
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
    expect(response.body).toMatchObject({ startingAt: { managed: { monthly: 100_000, setup: 0 } } });
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

  it('POST /v1/public/quote: os itens, os totais, o porte, o incluído e os limites; gravada por 24 h', async () => {
    const response = await quote(CONFIGURATION).expect(200);

    const body = response.body as Record<string, unknown>;
    expect(body).toEqual({
      contactUs: false,
      quoteId: expect.stringMatching(ULID_PATTERN) as unknown,
      priceTableVersion: 'teste-v1',
      expiresAt: new Date(START.getTime() + QUOTE_TTL_MS).toISOString(),
      currency: 'brl',
      configuration: { ...CONFIGURATION, size: 'P' },
      size: 'P',
      sizeDescription: 'Porte de teste P',
      // Valores fictícios.
      lineItems: [
        {
          component: 'environment',
          description: 'Ambiente gerenciado (porte P)',
          quantity: 1,
          unitAmount: 100_000,
          amount: 100_000,
          recurring: true,
        },
        {
          component: 'cloud_accounts',
          description: 'Contas de nuvem adicionais',
          quantity: 2,
          unitAmount: 3_000,
          amount: 6_000,
          recurring: true,
        },
        {
          component: 'volume',
          description: 'Volume de logs até 50 GiB/mês',
          quantity: 1,
          unitAmount: 10_000,
          amount: 10_000,
          recurring: true,
        },
        {
          component: 'agents',
          description: 'Agentes nas instâncias (pacote de 10)',
          quantity: 1,
          unitAmount: 10_000,
          amount: 10_000,
          recurring: true,
        },
        {
          component: 'history',
          description: 'Histórico de 180 dias',
          quantity: 1,
          unitAmount: 2_000,
          amount: 2_000,
          recurring: true,
        },
        {
          component: 'priority_support',
          description: 'Suporte prioritário',
          quantity: 1,
          unitAmount: 30_000,
          amount: 30_000,
          recurring: true,
        },
      ],
      monthlyTotal: 158_000,
      setupTotal: 0,
      firstInvoiceTotal: 158_000,
      included: { cloudAccounts: 2, monthlyGib: 10, historyDays: 30, users: 10 },
      limits: { maxCloudAccounts: 4, monthlyGib: 50, historyDays: 180, maxAgents: 10, maxUsers: 10 },
    });
    expect(JSON.stringify(body)).not.toContain('vc_');
    expect(response.headers['cache-control']).toBe('private, no-store');

    const stored = await documents.get(COLLECTIONS.quotes, String(body['quoteId']));
    expect(stored).toMatchObject({
      priceTableVersion: 'teste-v1',
      monthlyTotal: 158_000,
      expiresAt: new Date(START.getTime() + QUOTE_TTL_MS),
    });
    // A cotação gravada guarda os lookup_keys (o checkout precisa deles); a resposta, não.
    expect(JSON.stringify(stored)).toContain('vc_env_p_v1');
  });

  it('respostas arredondadas para a opção vendida, com a configuração normalizada de volta', async () => {
    const response = await quote({
      ...CONFIGURATION,
      cloudAccounts: 0,
      monthlyGib: 51,
      agents: 1,
      historyDays: 31,
    }).expect(200);
    expect(response.body).toMatchObject({
      configuration: { cloudAccounts: 2, monthlyGib: 100, agents: 10, historyDays: 180, size: 'M' },
      size: 'M',
    });
  });

  it('sob consulta: na nuvem do cliente (v1) ou acima do que a tabela vende; nada é gravado', async () => {
    const selfHosted = await quote({ ...CONFIGURATION, mode: 'self_hosted' }).expect(200);
    expect(selfHosted.body).toEqual({
      contactUs: true,
      reason: 'self_hosted',
      priceTableVersion: 'teste-v1',
    });
    const tooMany = await quote({ ...CONFIGURATION, agents: 41 }).expect(200);
    expect(tooMany.body).toEqual({
      contactUs: true,
      reason: 'agents_above_max',
      priceTableVersion: 'teste-v1',
    });
    expect(await documents.query(COLLECTIONS.quotes)).toHaveLength(0);
    const funnel = capture.entries().filter((entry) => entry['event'] === 'quote_contact_us');
    expect(funnel.map((entry) => entry['reason'])).toEqual(['self_hosted', 'agents_above_max']);
  });

  it('entrada fora do formato: 400 citando só os campos conhecidos; preço vindo do cliente é recusado', async () => {
    const cases: [unknown, string][] = [
      [{ ...CONFIGURATION, agents: -1 }, 'Configuração inválida: agents.'],
      [{ ...CONFIGURATION, mode: 'hibrido', support: 'vip' }, 'Configuração inválida: mode, support.'],
      [{ ...CONFIGURATION, monthlyTotal: 1 }, 'Configuração inválida.'],
      [{ ...CONFIGURATION, unitAmount: 1, lookupKey: 'vc_acc_v1' }, 'Configuração inválida.'],
      [{}, 'Configuração inválida: mode, cloudAccounts, monthlyGib, agents, historyDays, support.'],
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

  it('o log do funil leva o id, a versão, o porte e as faixas; nem IP, nem valores', async () => {
    const ip = nextIp();
    const response = await quote(CONFIGURATION, ip).expect(200);

    const issued = capture
      .entries()
      .filter((entry) => entry['event'] === 'quote_issued')
      .at(-1);
    expect(issued).toMatchObject({
      quoteId: (response.body as { quoteId: string }).quoteId,
      priceTableVersion: 'teste-v1',
      mode: 'managed',
      size: 'P',
      cloudAccounts: 4,
      monthlyGib: 50,
      agents: 10,
      historyDays: 180,
      support: 'priority',
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
