import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COLLECTIONS } from '../src/firestore/collections.js';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import type { PriceTableInput } from '../src/pricing/pricing.schema.js';
import { createApp } from './support/create-app.js';
import { FakeClock, MINUTE_MS } from './support/fake-clock.js';
import { FakeStripe, fakeStripeKey } from './support/fake-stripe.js';
import { seedPublishedLegalTexts } from './support/legal-seed.js';
import { LogCapture } from './support/log-capture.js';
import { fictitiousCostModel, fictitiousPriceTable } from './support/pricing-fixtures.js';
import { seedPublishedCostModel, seedPublishedTable, seedStripePrices } from './support/pricing-seed.js';

const SITE = 'https://veraxsistemas.com.br';
const VERSION = '2026-11-04';
const START = new Date('2026-11-04T12:00:00.000Z');
const DAY_MS = 24 * 60 * MINUTE_MS;
/** A alíquota do imposto por cima configurada no serviço (`STRIPE_TAX_RATE_ID`), FICTÍCIA. */
const TAX_RATE_ID = 'txr_teste_imposto';
/** A alíquota padrão do modelo de custos FICTÍCIO (`teste_a`, 10%), em percentual, como a Stripe guarda. */
const DEFAULT_PERCENT = 10;

/** A tabela FICTÍCIA com os valores sem impostos (o "+ impostos"). */
function exclusiveTable(): PriceTableInput {
  return { ...fictitiousPriceTable(), taxMode: 'exclusive' };
}

/**
 * O imposto por cima no checkout: com a tabela `exclusive`, a sessão leva a alíquota da Stripe de `STRIPE_TAX_RATE_ID`
 * em cada item e como padrão da assinatura, conferida a cada sessão (ativa, exclusiva, no modo da chave, com o
 * percentual da alíquota padrão do modelo de custos vigente); qualquer divergência é 503 antes de reservar. Um app por
 * arquivo (o nestjs-pino guarda o logger em estado estático): este tem a variável; o `checkout.test.ts`, não.
 */
describe('cp-public: checkout com o imposto por cima (tabela sem impostos)', () => {
  const capture = new LogCapture();
  const clock = new FakeClock(START);
  const documents = new MemoryDocumentStore();
  const fake = new FakeStripe();
  let app: NestExpressApplication;
  let ipSequence = 0;
  let testStart = START.getTime();

  function nextIp(): string {
    ipSequence += 1;
    return `203.0.113.${ipSequence}`;
  }

  async function newQuote(): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/v1/public/quote')
      .set('X-Forwarded-For', nextIp())
      .send({ plan: 'plataforma', gbDay: 4 })
      .expect(200);
    return String((response.body as { quoteId: string }).quoteId);
  }

  function checkout(quoteId: string): request.Test {
    return request(app.getHttpServer())
      .post('/v1/public/checkout')
      .set('X-Forwarded-For', nextIp())
      .send({
        quoteId,
        companyName: 'Cliente Demo A Ltda',
        cnpj: '11.222.333/0001-81',
        adminEmail: 'admin@cliente-demo-a.example',
        slug: 'cliente-demo-a',
        consent: { terms: VERSION, privacy: VERSION, dpa: VERSION },
      });
  }

  async function seed(table: PriceTableInput, options: { costModel?: boolean } = {}): Promise<string> {
    const since = new Date(START.getTime() - DAY_MS);
    await seedPublishedTable(documents, table, { effectiveFrom: since });
    if (options.costModel !== false) {
      await seedPublishedCostModel(documents, fictitiousCostModel(), { effectiveFrom: since });
    }
    await seedPublishedLegalTexts(documents, VERSION, since);
    seedStripePrices(fake, table);
    return newQuote();
  }

  function refusal(): Record<string, unknown> | undefined {
    return capture.entries().find((entry) => entry['event'] === 'checkout_tax_rate_invalid');
  }

  beforeAll(async () => {
    const stripeApi = await fake.start();
    app = await createApp({
      role: 'public',
      trustProxyHops: 1,
      capture,
      documentStore: documents,
      clock,
      stripeApi,
      env: {
        SITE_ORIGINS: SITE,
        SITE_SUCCESS_URL: `${SITE}/checkout/sucesso?cs={CHECKOUT_SESSION_ID}`,
        SITE_CANCEL_URL: `${SITE}/#planos`,
        STRIPE_SECRET_KEY: fakeStripeKey('test', 'rk'),
        STRIPE_LIVE: 'false',
        STRIPE_TAX_RATE_ID: TAX_RATE_ID,
      },
    });
    await app.listen(0, '127.0.0.1');
  });

  beforeEach(() => {
    // O cache dos preços (5 min) não passa de um teste para o outro: a Stripe falsa recria os preços com ids novos.
    testStart += 10 * MINUTE_MS;
    clock.set(new Date(testStart));
    documents.clear();
    fake.reset();
    capture.lines.length = 0;
    fake.addTaxRate(DEFAULT_PERCENT, { id: TAX_RATE_ID });
  });

  afterAll(async () => {
    await app.close();
    await fake.stop();
  });

  it('a alíquota conferida vai em cada item e como padrão da assinatura; a soma conferida continua a da tabela', async () => {
    const quoteId = await seed(exclusiveTable());

    await checkout(quoteId).expect(201);

    expect(fake.calls('GET', `/v1/tax_rates/${TAX_RATE_ID}`)).toHaveLength(1);
    const form = fake.calls('POST', '/v1/checkout/sessions')[0]?.form ?? new URLSearchParams();
    expect(form.get('line_items[0][tax_rates][0]')).toBe(TAX_RATE_ID);
    expect(form.get('line_items[1][tax_rates][0]')).toBe(TAX_RATE_ID);
    expect(form.get('subscription_data[default_tax_rates][0]')).toBe(TAX_RATE_ID);
    // O pedido guarda o valor da tabela (sem o imposto): a Stripe soma o imposto na fatura.
    expect((await documents.get(COLLECTIONS.slugs, 'cliente-demo-a'))?.['order']).toMatchObject({
      pricing: { monthlyTotal: 160_000 },
    });
  });

  it('com o imposto embutido (tabela inclusive), nenhuma alíquota e nenhuma consulta dela', async () => {
    const quoteId = await seed(fictitiousPriceTable());

    await checkout(quoteId).expect(201);

    expect(fake.calls('GET', `/v1/tax_rates/${TAX_RATE_ID}`)).toHaveLength(0);
    const form = fake.calls('POST', '/v1/checkout/sessions')[0]?.form.toString() ?? '';
    expect(form).not.toContain('tax_rates');
  });

  it('alíquota inativa, embutida, de outro modo, com outro percentual ou inexistente: 503, sem reservar nem abrir sessão', async () => {
    const cases: [Record<string, unknown> | 'missing', string][] = [
      [{ active: false }, 'inactive'],
      [{ inclusive: true }, 'inclusive'],
      [{ livemode: true }, 'livemode'],
      [{ percentage: DEFAULT_PERCENT + 0.5 }, 'percentage'],
      ['missing', 'missing'],
    ];
    for (const [change, problem] of cases) {
      documents.clear();
      fake.reset();
      capture.lines.length = 0;
      if (change !== 'missing') fake.addTaxRate(DEFAULT_PERCENT, { id: TAX_RATE_ID, ...change });
      const quoteId = await seed(exclusiveTable());

      const response = await checkout(quoteId);

      expect(response.status, problem).toBe(503);
      expect(response.body, problem).toMatchObject({ code: 'checkout_unavailable' });
      expect(refusal(), problem).toMatchObject({ taxRateId: TAX_RATE_ID, problem });
      expect(await documents.get(COLLECTIONS.slugs, 'cliente-demo-a'), problem).toBeUndefined();
      expect(fake.calls('POST', '/v1/checkout/sessions'), problem).toHaveLength(0);
    }
  });

  it('sem modelo de custos vigente, não há alíquota padrão para conferir: 503', async () => {
    const quoteId = await seed(exclusiveTable(), { costModel: false });

    await checkout(quoteId).expect(503);

    expect(refusal()).toMatchObject({ problem: 'cost_model_missing' });
    expect(fake.calls('POST', '/v1/checkout/sessions')).toHaveLength(0);
  });
});
