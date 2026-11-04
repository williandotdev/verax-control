import { describe, expect, it } from 'vitest';
import { fictitiousPriceTable } from '../../test/support/pricing-fixtures.js';
import { type ConfigurationInput, type PriceTable, priceTableSchema } from './pricing.schema.js';
import {
  minimalConfiguration,
  normalizeConfiguration,
  type Quote,
  quote,
  sizeFor,
  startingAt,
} from './quote.js';

/**
 * O motor da cotação sobre a tabela FICTÍCIA (`pricing-fixtures.ts`): ambiente P/M/G de 1.000/2.000/4.000 no
 * gerenciado, 2 contas incluídas a 30 cada adicional, volume incluído de 10 GiB e faixas de 50, 100 e 200 GiB,
 * pacotes de 10 agentes (até 4), histórico de 30 dias e opções de 180 e 360, suporte prioritário de 300. Portes de
 * teste: P até 5 contas, 50 GiB e 10 agentes; M até 10, 100 e 20; G até 20, 200 e 40. Nada disso é preço de verdade.
 */
const table: PriceTable = priceTableSchema.parse(fictitiousPriceTable());

function config(overrides: Partial<ConfigurationInput> = {}): ConfigurationInput {
  return { ...minimalConfiguration(table, 'managed'), ...overrides };
}

function quoted(input: ConfigurationInput): Quote {
  const outcome = quote(input, table);
  if (outcome.kind !== 'quote') throw new Error(`sob consulta: ${outcome.reason}`);
  return outcome.quote;
}

describe('regra de porte', () => {
  it('o porte é o menor que comporta as três dimensões ao mesmo tempo (o maior que qualquer uma exigir)', () => {
    const sizes = table.sizing.sizes;
    expect(sizeFor({ cloudAccounts: 5, monthlyGib: 50, agents: 10 }, sizes)?.size).toBe('P');
    expect(sizeFor({ cloudAccounts: 6, monthlyGib: 10, agents: 0 }, sizes)?.size).toBe('M');
    expect(sizeFor({ cloudAccounts: 2, monthlyGib: 100, agents: 0 }, sizes)?.size).toBe('M');
    expect(sizeFor({ cloudAccounts: 2, monthlyGib: 10, agents: 11 }, sizes)?.size).toBe('M');
    expect(sizeFor({ cloudAccounts: 2, monthlyGib: 200, agents: 20 }, sizes)?.size).toBe('G');
    expect(sizeFor({ cloudAccounts: 21, monthlyGib: 10, agents: 0 }, sizes)).toBeUndefined();
  });

  it('cada dimensão sozinha leva ao porte que ela exige, na cotação', () => {
    expect(quoted(config()).configuration.size).toBe('P');
    expect(quoted(config({ cloudAccounts: 10 })).configuration.size).toBe('M');
    expect(quoted(config({ monthlyGib: 200 })).configuration.size).toBe('G');
    expect(quoted(config({ agents: 40 })).configuration.size).toBe('G');
    expect(quoted(config({ cloudAccounts: 3, monthlyGib: 100, agents: 30 })).configuration.size).toBe('G');
  });
});

describe('normalização da configuração', () => {
  it('sempre para cima, até a opção vendida: contas, faixa de volume, pacote de agentes e histórico', () => {
    const normalized = normalizeConfiguration(
      { mode: 'managed', cloudAccounts: 0, monthlyGib: 51, agents: 11, historyDays: 31, support: 'standard' },
      table,
    );
    expect(normalized).toEqual({
      ok: true,
      agentPacks: 2,
      configuration: {
        mode: 'managed',
        cloudAccounts: 2,
        monthlyGib: 100,
        agents: 20,
        historyDays: 180,
        support: 'standard',
      },
    });
  });

  it('acima do que a tabela vende ou do maior porte: sob consulta, com o motivo', () => {
    expect(quote(config({ cloudAccounts: 21 }), table)).toEqual({
      kind: 'contact_us',
      reason: 'cloud_accounts_above_max',
    });
    expect(quote(config({ monthlyGib: 201 }), table)).toEqual({
      kind: 'contact_us',
      reason: 'volume_above_max',
    });
    expect(quote(config({ agents: 41 }), table)).toEqual({ kind: 'contact_us', reason: 'agents_above_max' });
    expect(quote(config({ historyDays: 361 }), table)).toEqual({
      kind: 'contact_us',
      reason: 'history_above_max',
    });
    // Uma tabela que vende mais contas do que o maior porte comporta: a combinação é sob consulta.
    const wider = priceTableSchema.parse({
      ...fictitiousPriceTable(),
      cloudAccounts: { ...fictitiousPriceTable().cloudAccounts, max: 30 },
    });
    expect(quote(config({ cloudAccounts: 25 }), wider)).toEqual({
      kind: 'contact_us',
      reason: 'above_largest_size',
    });
  });
});

describe('cotação', () => {
  it('um item por componente cobrado, com o lookup_key, a quantidade, o valor unitário e o total', () => {
    const result = quoted(
      config({ cloudAccounts: 4, monthlyGib: 50, agents: 10, historyDays: 180, support: 'priority' }),
    );

    expect(result.lineItems).toEqual([
      {
        component: 'environment',
        variant: 'managed_P',
        lookupKey: 'vc_env_p_v1',
        quantity: 1,
        unitAmount: 100_000,
        amount: 100_000,
        recurring: true,
      },
      {
        component: 'cloud_accounts',
        variant: 'additional',
        lookupKey: 'vc_acc_v1',
        quantity: 2,
        unitAmount: 3_000,
        amount: 6_000,
        recurring: true,
      },
      {
        component: 'volume',
        variant: '50',
        lookupKey: 'vc_vol_50_v1',
        quantity: 1,
        unitAmount: 10_000,
        amount: 10_000,
        recurring: true,
      },
      {
        component: 'agents',
        variant: '10',
        lookupKey: 'vc_agt_v1',
        quantity: 1,
        unitAmount: 10_000,
        amount: 10_000,
        recurring: true,
      },
      {
        component: 'history',
        variant: '180',
        lookupKey: 'vc_his_180_v1',
        quantity: 1,
        unitAmount: 2_000,
        amount: 2_000,
        recurring: true,
      },
      {
        component: 'priority_support',
        variant: 'priority',
        lookupKey: 'vc_sup_v1',
        quantity: 1,
        unitAmount: 30_000,
        amount: 30_000,
        recurring: true,
      },
    ]);
    expect(result.monthlyTotal).toBe(158_000);
    expect(result.setupTotal).toBe(0);
    expect(result.firstInvoiceTotal).toBe(158_000);
    expect(result.configuration).toEqual({
      mode: 'managed',
      size: 'P',
      cloudAccounts: 4,
      monthlyGib: 50,
      agents: 10,
      historyDays: 180,
      support: 'priority',
    });
    expect(result.sizeDescription).toBe('Porte de teste P');
    expect(result.included).toEqual({ cloudAccounts: 2, monthlyGib: 10, historyDays: 30, users: 10 });
  });

  it('os limites do nó saem da configuração contratada (PR-18): contas, volume, histórico, agentes e usuários', () => {
    expect(quoted(config({ cloudAccounts: 7, monthlyGib: 60, agents: 15, historyDays: 200 })).limits).toEqual(
      {
        maxCloudAccounts: 7,
        monthlyGib: 100,
        historyDays: 360,
        maxAgents: 20,
        maxUsers: 10,
      },
    );
  });

  it('a configuração mínima é só o ambiente do menor porte; é o "a partir de"', () => {
    const minimal = quoted(minimalConfiguration(table, 'managed'));
    expect(minimal.lineItems.map((item) => item.component)).toEqual(['environment']);
    expect(minimal.monthlyTotal).toBe(100_000);
    expect(startingAt(table, 'managed')).toEqual({ monthly: 100_000, setup: 0 });
    expect(startingAt(table, 'self_hosted')).toEqual({ monthly: 50_000, setup: 100_000 });
  });

  it('na nuvem do cliente: a licença do porte no lugar do ambiente e a implantação por último, avulsa', () => {
    const result = quoted(config({ mode: 'self_hosted', cloudAccounts: 6 }));
    expect(
      result.lineItems.map((item) => [item.component, item.variant, item.quantity, item.recurring]),
    ).toEqual([
      ['environment', 'self_hosted_M', 1, true],
      ['cloud_accounts', 'additional', 4, true],
      ['setup', 'self_hosted', 1, false],
    ]);
    expect(result.monthlyTotal).toBe(100_000 + 12_000);
    expect(result.setupTotal).toBe(100_000);
    expect(result.firstInvoiceTotal).toBe(212_000);
  });

  it('determinística: a mesma configuração dá sempre a mesma cotação', () => {
    const input = config({
      cloudAccounts: 9,
      monthlyGib: 70,
      agents: 25,
      historyDays: 360,
      support: 'priority',
    });
    expect(quote(input, table)).toEqual(quote({ ...input }, table));
  });
});
