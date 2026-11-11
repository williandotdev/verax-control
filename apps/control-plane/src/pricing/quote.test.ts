import { describe, expect, it } from 'vitest';
import { fictitiousPriceTable } from '../../test/support/pricing-fixtures.js';
import { type ConfigurationInput, type PriceTable, priceTableSchema } from './pricing.schema.js';
import { gbDayRange, minimalConfiguration, type Quote, quote, sizeFor, startingAt } from './quote.js';

/**
 * O motor da cotação sobre a tabela FICTÍCIA (`pricing-fixtures.ts`): Plataforma com base de 1.000 e 2 GB/dia
 * incluídos, GB/dia adicional de 300, até 5 GB/dia no site; Dedicado a 500 por GB/dia, de 3 a 15; vCISO com serviço de
 * 2.000 e implantação de 5.000. Portes de teste: P até 5 GB/dia, M até 10, G até 20. Nada disso é preço de verdade.
 */
const table: PriceTable = priceTableSchema.parse(fictitiousPriceTable());

function quoted(input: ConfigurationInput): Quote {
  const outcome = quote(input, table);
  if (outcome.kind !== 'quote') throw new Error(`sob consulta: ${outcome.reason}`);
  return outcome.quote;
}

describe('regra de porte', () => {
  it('o porte é o menor que comporta o volume em GB/dia', () => {
    const sizes = table.sizing.sizes;
    expect(sizeFor(1, sizes)?.size).toBe('P');
    expect(sizeFor(5, sizes)?.size).toBe('P');
    expect(sizeFor(6, sizes)?.size).toBe('M');
    expect(sizeFor(20, sizes)?.size).toBe('G');
    expect(sizeFor(21, sizes)).toBeUndefined();
  });

  it('o porte do Dedicado acompanha o volume, nos dois lugares', () => {
    expect(quoted({ plan: 'dedicado', gbDay: 5, mode: 'managed' }).configuration.size).toBe('P');
    expect(quoted({ plan: 'dedicado', gbDay: 8, mode: 'managed' }).configuration.size).toBe('M');
    expect(quoted({ plan: 'vciso', gbDay: 15, mode: 'self_hosted' }).configuration.size).toBe('G');
  });
});

describe('cotação', () => {
  it('Plataforma: a base com a franquia incluída e o GB/dia adicional como quantidade de um item só', () => {
    const result = quoted({ plan: 'plataforma', gbDay: 5, mode: 'managed' });
    expect(result.configuration).toEqual({
      plan: 'plataforma',
      mode: 'managed',
      gbDay: 5,
      size: 'P',
      historyDays: 60,
    });
    expect(result.lineItems).toEqual([
      {
        component: 'base',
        variant: 'plataforma',
        lookupKey: 'vc_base_v1',
        quantity: 1,
        unitAmount: 100_000,
        amount: 100_000,
        recurring: true,
      },
      {
        component: 'additional_gb_day',
        variant: 'plataforma',
        lookupKey: 'vc_add_v1',
        quantity: 3,
        unitAmount: 30_000,
        amount: 90_000,
        recurring: true,
      },
    ]);
    expect(result).toMatchObject({ monthlyTotal: 190_000, setupTotal: 0, firstInvoiceTotal: 190_000 });
    expect(result.included).toEqual({ gbDay: 2, historyDays: 60, users: 10 });
  });

  it('Plataforma no incluído (ou abaixo dele): só a base, sem o item do adicional (a Stripe não aceita quantidade 0)', () => {
    for (const gbDay of [1, 2]) {
      const result = quoted({ plan: 'plataforma', gbDay, mode: 'managed' });
      expect(result.configuration.gbDay).toBe(2);
      expect(result.lineItems.map((item) => item.component)).toEqual(['base']);
      expect(result.monthlyTotal).toBe(100_000);
    }
  });

  it('Dedicado: GB/dia × o preço, com o volume levado ao mínimo', () => {
    const result = quoted({ plan: 'dedicado', gbDay: 1, mode: 'managed' });
    expect(result.configuration.gbDay).toBe(3);
    expect(result.lineItems).toEqual([
      {
        component: 'gb_day',
        variant: 'dedicado',
        lookupKey: 'vc_ded_v1',
        quantity: 3,
        unitAmount: 50_000,
        amount: 150_000,
        recurring: true,
      },
    ]);
    expect(result.monthlyTotal).toBe(150_000);
    expect(result.included.gbDay).toBe(0);
  });

  it('vCISO: o Dedicado, mais o serviço mensal e a implantação por último, avulsa', () => {
    const result = quoted({ plan: 'vciso', gbDay: 4, mode: 'managed' });
    expect(
      result.lineItems.map((item) => [item.component, item.variant, item.quantity, item.recurring]),
    ).toEqual([
      ['gb_day', 'dedicado', 4, true],
      ['service', 'vciso', 1, true],
      ['setup', 'vciso', 1, false],
    ]);
    expect(result).toMatchObject({ monthlyTotal: 400_000, setupTotal: 500_000, firstInvoiceTotal: 900_000 });
  });

  it('o lugar não muda o preço: no cliente, o mesmo preço por GB/dia', () => {
    const verax = quoted({ plan: 'dedicado', gbDay: 6, mode: 'managed' });
    const customer = quoted({ plan: 'dedicado', gbDay: 6, mode: 'self_hosted' });
    expect(customer.lineItems).toEqual(verax.lineItems);
    expect(customer.configuration.mode).toBe('self_hosted');
  });

  it('acima do que o plano vende, do maior porte ou fora do lugar do plano: sob consulta, com o motivo', () => {
    expect(quote({ plan: 'plataforma', gbDay: 6, mode: 'managed' }, table)).toEqual({
      kind: 'contact_us',
      reason: 'above_online_max',
    });
    expect(quote({ plan: 'dedicado', gbDay: 16, mode: 'managed' }, table)).toEqual({
      kind: 'contact_us',
      reason: 'above_max',
    });
    expect(quote({ plan: 'plataforma', gbDay: 2, mode: 'self_hosted' }, table)).toEqual({
      kind: 'contact_us',
      reason: 'mode_unavailable',
    });
    const small = priceTableSchema.parse({
      ...fictitiousPriceTable(),
      sizing: { sizes: [{ size: 'P', maxGbDay: 5, description: 'Só P' }] },
    });
    expect(quote({ plan: 'dedicado', gbDay: 6, mode: 'managed' }, small)).toEqual({
      kind: 'contact_us',
      reason: 'above_largest_size',
    });
  });

  it('os limites do nó saem do contratado (PR-18): franquia mensal pelo GB/dia, teto de contas do plano, sem agentes', () => {
    expect(quoted({ plan: 'plataforma', gbDay: 5, mode: 'managed' }).limits).toEqual({
      maxCloudAccounts: 50,
      monthlyGib: 145,
      historyDays: 60,
      maxAgents: 0,
      maxUsers: 10,
    });
    expect(quoted({ plan: 'vciso', gbDay: 3, mode: 'self_hosted' }).limits.maxCloudAccounts).toBe(100);
  });

  it('a faixa de cada plano e o "a partir de" (o menor volume, na infraestrutura da Verax)', () => {
    expect(gbDayRange(table, 'plataforma')).toEqual({ min: 2, max: 5 });
    expect(gbDayRange(table, 'vciso')).toEqual({ min: 3, max: 15 });
    expect(minimalConfiguration(table, 'dedicado')).toEqual({ plan: 'dedicado', gbDay: 3, mode: 'managed' });
    expect(startingAt(table, 'plataforma')).toEqual({ monthly: 100_000, setup: 0 });
    expect(startingAt(table, 'dedicado')).toEqual({ monthly: 150_000, setup: 0 });
    expect(startingAt(table, 'vciso')).toEqual({ monthly: 350_000, setup: 500_000 });
  });

  it('determinística: a mesma configuração dá sempre a mesma cotação', () => {
    const input: ConfigurationInput = { plan: 'vciso', gbDay: 7, mode: 'managed' };
    expect(quote(input, table)).toEqual(quote(input, table));
  });
});
