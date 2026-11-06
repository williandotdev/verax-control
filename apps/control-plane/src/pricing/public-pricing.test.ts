import { describe, expect, it } from 'vitest';
import { fictitiousPriceTable } from '../../test/support/pricing-fixtures.js';
import { priceTableSchema } from './pricing.schema.js';
import { describeLineItem, isSoldOnline, publicPricing } from './public-pricing.js';
import { quote } from './quote.js';

// Tabela FICTÍCIA (test/support/pricing-fixtures.ts).
const table = priceTableSchema.parse(fictitiousPriceTable());

describe('tabela pública (GET /v1/public/pricing)', () => {
  it('só preços e regras: nenhum lookup_key, custo ou margem; o ambiente no cliente nem aparece (contrato direto)', () => {
    const view = publicPricing('teste-v1', table);

    expect(view).toEqual({
      priceTableVersion: 'teste-v1',
      currency: 'brl',
      interval: 'month',
      startingAt: { managed: { monthly: 100_000, setup: 0 } },
      modes: [
        {
          mode: 'managed',
          sale: 'online',
          environment: [
            { size: 'P', amount: 100_000 },
            { size: 'M', amount: 200_000 },
            { size: 'G', amount: 400_000 },
          ],
          setupAmount: 0,
        },
      ],
      sizes: [
        { size: 'P', description: 'Porte de teste P', maxCloudAccounts: 5, maxMonthlyGib: 50, maxAgents: 10 },
        {
          size: 'M',
          description: 'Porte de teste M',
          maxCloudAccounts: 10,
          maxMonthlyGib: 100,
          maxAgents: 20,
        },
        {
          size: 'G',
          description: 'Porte de teste G',
          maxCloudAccounts: 20,
          maxMonthlyGib: 200,
          maxAgents: 40,
        },
      ],
      cloudAccounts: { included: 2, max: 20, additionalAmount: 3_000 },
      volume: {
        includedMonthlyGib: 10,
        bands: [
          { monthlyGib: 50, amount: 10_000 },
          { monthlyGib: 100, amount: 20_000 },
          { monthlyGib: 200, amount: 40_000 },
        ],
      },
      agents: { packSize: 10, maxPacks: 4, packAmount: 10_000 },
      history: {
        includedDays: 30,
        extended: [
          { days: 180, amount: 2_000 },
          { days: 360, amount: 4_000 },
        ],
      },
      prioritySupport: { amount: 30_000 },
      users: { max: 10 },
      // O pacote de partida do ambiente no cliente fica de fora: o site só vende o da infraestrutura da Verax.
      presets: [
        {
          id: 'inicial',
          label: 'Inicial (teste)',
          configuration: {
            mode: 'managed',
            cloudAccounts: 2,
            monthlyGib: 10,
            agents: 0,
            historyDays: 30,
            support: 'standard',
          },
        },
      ],
    });
    expect(JSON.stringify(view)).not.toMatch(/lookupKey|vc_|cost|margin|self_hosted/i);
    // A tabela FICTÍCIA tem os preços da licença no cliente (o console os usa): nenhum deles chega aqui.
    expect(table.modes.self_hosted.setup?.amount).toBe(100_000);
    expect(view.modes.map((mode) => mode.mode)).toEqual(['managed']);
    expect(isSoldOnline('managed')).toBe(true);
    expect(isSoldOnline('self_hosted')).toBe(false);
  });

  it('descreve cada item para o cliente, em português', () => {
    const outcome = quote(
      {
        mode: 'managed',
        cloudAccounts: 4,
        monthlyGib: 50,
        agents: 10,
        historyDays: 180,
        support: 'priority',
      },
      table,
    );
    if (outcome.kind !== 'quote') throw new Error('sob consulta');
    expect(outcome.quote.lineItems.map((item) => describeLineItem(item, 'managed', 'P'))).toEqual([
      'Ambiente na infraestrutura da Verax (porte P)',
      'Contas de nuvem adicionais',
      'Volume de logs até 50 GiB/mês',
      'Agentes nas instâncias (pacote de 10)',
      'Histórico de 180 dias',
      'Suporte prioritário',
    ]);
  });
});
