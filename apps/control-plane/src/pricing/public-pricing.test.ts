import { describe, expect, it } from 'vitest';
import { fictitiousPriceTable } from '../../test/support/pricing-fixtures.js';
import { priceTableSchema } from './pricing.schema.js';
import { describeLineItem, isSoldOnline, publicPricing } from './public-pricing.js';
import { quote } from './quote.js';

// Tabela FICTÍCIA (test/support/pricing-fixtures.ts).
const table = priceTableSchema.parse(fictitiousPriceTable());

describe('tabela pública (GET /v1/public/pricing)', () => {
  it('só preços e regras dos três planos: nenhum lookup_key, custo ou margem; o "a partir de" de cada plano', () => {
    const view = publicPricing('teste-v1', table);

    expect(view).toEqual({
      priceTableVersion: 'teste-v1',
      currency: 'brl',
      interval: 'month',
      taxMode: 'inclusive',
      startingAt: {
        plataforma: { monthly: 100_000, setup: 0 },
        dedicado: { monthly: 150_000, setup: 0 },
        vciso: { monthly: 350_000, setup: 500_000 },
      },
      plans: {
        plataforma: {
          sale: 'online',
          baseAmount: 100_000,
          includedGbDay: 2,
          additionalGbDayAmount: 30_000,
          overageGbDayAmount: 30_000,
          maxOnlineGbDay: 5,
        },
        dedicado: { sale: 'contract', gbDayAmount: 50_000, minGbDay: 3, maxGbDay: 15, contractMonths: 12 },
        vciso: {
          sale: 'contract',
          gbDayAmount: 50_000,
          serviceAmount: 200_000,
          setupAmount: 500_000,
          minGbDay: 3,
          maxGbDay: 15,
          contractMonths: 12,
        },
      },
      sizes: [
        { size: 'P', description: 'Porte de teste P', maxGbDay: 5 },
        { size: 'M', description: 'Porte de teste M', maxGbDay: 10 },
        { size: 'G', description: 'Porte de teste G', maxGbDay: 20 },
      ],
      history: { includedDays: 60 },
      users: { max: 10 },
    });
    expect(JSON.stringify(view)).not.toMatch(/lookupKey|vc_|cost|margin|self_hosted|maxCloudAccounts/i);
  });

  it('o site vende só a Plataforma, na infraestrutura da Verax', () => {
    expect(isSoldOnline({ plan: 'plataforma', mode: 'managed' })).toBe(true);
    expect(isSoldOnline({ plan: 'dedicado', mode: 'managed' })).toBe(false);
    expect(isSoldOnline({ plan: 'vciso', mode: 'managed' })).toBe(false);
    expect(isSoldOnline({ plan: 'plataforma', mode: 'self_hosted' })).toBe(false);
  });

  it('descreve cada item para o cliente, em português', () => {
    const plataforma = quote({ plan: 'plataforma', gbDay: 4, mode: 'managed' }, table);
    const vciso = quote({ plan: 'vciso', gbDay: 3, mode: 'managed' }, table);
    if (plataforma.kind !== 'quote' || vciso.kind !== 'quote') throw new Error('sob consulta');
    expect([...plataforma.quote.lineItems, ...vciso.quote.lineItems].map(describeLineItem)).toEqual([
      'Plataforma (base mensal com a franquia incluída)',
      'GB/dia adicional da franquia',
      'GB/dia do servidor dedicado',
      'Serviço de vCISO',
      'Implantação (cobrada uma vez)',
    ]);
  });
});
