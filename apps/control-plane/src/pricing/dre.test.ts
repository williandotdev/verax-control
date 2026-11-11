import { describe, expect, it } from 'vitest';
import { fictitiousCostModel, fictitiousPriceTable } from '../../test/support/pricing-fixtures.js';
import {
  cloudUsd,
  CostModelMismatchError,
  costModelProblems,
  dre,
  type DreOptions,
  type DreResult,
} from './dre.js';
import {
  type ConfigurationInput,
  type CostModel,
  costModelSchema,
  type PaymentMethod,
  type PriceTable,
  priceTableSchema,
} from './pricing.schema.js';

/**
 * A DRE sobre a tabela e o modelo de custos FICTÍCIOS (`pricing-fixtures.ts`): câmbio 2, folga de 10%, cartão 5% +
 * R$ 0,50, boleto R$ 3, cobrança recorrente 1%, alíquotas de 10% (padrão) e 20%, reserva de 3%, hora de suporte de
 * R$ 80, custos fixos de R$ 1.000 rateados entre 5 clientes; a célula de US$ 105,50 por mês (VM 100 + disco 1 +
 * snapshots 0,50 + NAT 1 + IP 2 + outros 1) para 10 GB/dia, US$ 1 por cliente nela e ingestão de US$ 2 por GB/dia. As
 * contas abaixo estão feitas à mão, linha a linha.
 */
const table: PriceTable = priceTableSchema.parse(fictitiousPriceTable());
const model: CostModel = costModelSchema.parse(fictitiousCostModel());

/** Plataforma com 4 GB/dia (2 incluídos + 2 adicionais): R$ 1.600 por mês. */
const PLATAFORMA: ConfigurationInput = { plan: 'plataforma', gbDay: 4, mode: 'managed' };

function computed(
  configuration: ConfigurationInput,
  paymentMethod: PaymentMethod,
  options: Omit<DreOptions, 'paymentMethod'> = {},
  priceTable: PriceTable = table,
): DreResult {
  const outcome = dre(configuration, priceTable, model, paymentMethod, options);
  if (outcome.kind !== 'dre') throw new Error(`sob consulta: ${outcome.reason}`);
  return outcome.dre;
}

describe('DRE por cliente e por mês', () => {
  it('Plataforma no cartão, imposto embutido: a célula rateada por GB/dia e cada linha conforme a fórmula', () => {
    const result = computed(PLATAFORMA, 'card');

    // Nuvem (US$): célula 105,50 ÷ 10 × 4 GB/dia = 42,20 + 1 do cliente + ingestão 4 × 2 = 51,20
    //   → × câmbio 2 × folga 1,1 = R$ 112,64. Meio de pagamento: 1.600 × (5% + 1%) + 0,50 = 96,50. Suporte: 1 h × 80.
    expect(result.monthly).toEqual({
      tableRevenue: 160_000,
      grossRevenue: 160_000,
      taxes: 16_000,
      refundReserve: 4_800,
      netRevenue: 139_200,
      infrastructure: 11_264,
      paymentFees: 9_650,
      support: 8_000,
      contributionMargin: 110_286,
      contributionMarginRatio: 110_286 / 160_000,
      contributionMarginNetRatio: 110_286 / 139_200,
      fixedCosts: 20_000,
      result: 90_286,
      resultRatio: 90_286 / 160_000,
    });
    expect(result.supportHours).toBe(1);
    expect(result.taxRateId).toBe('teste_a');
    expect(result.taxMode).toBe('inclusive');
    // Sem implantação na Plataforma: as horas dela (0,5 h) são só custo, no primeiro mês.
    expect(result.setup).toEqual({
      revenue: 0,
      taxes: 0,
      refundReserve: 0,
      paymentFees: 0,
      supportHours: 0.5,
      support: 4_000,
      contributionMargin: -4_000,
      contributionMarginRatio: null,
    });
    expect(result.twelveMonths).toEqual({
      grossRevenue: 12 * 160_000,
      contributionMargin: 12 * 110_286 - 4_000,
      result: 12 * 90_286 - 4_000,
    });
    expect(result.customerCloudEstimate).toBeNull();
  });

  it('com o imposto por cima ("+ impostos"): a receita bruta é o valor ÷ (1 − alíquota), e o valor fica inteiro', () => {
    const exclusive = priceTableSchema.parse({ ...fictitiousPriceTable(), taxMode: 'exclusive' });
    const result = computed(PLATAFORMA, 'card', {}, exclusive);
    // 1.600 ÷ 0,9 = 1.777,78; o imposto é a diferença (177,78). Reserva 3% = 53,33; tarifa 1.777,78 × 6% + 0,50.
    expect(result.monthly).toMatchObject({
      tableRevenue: 160_000,
      grossRevenue: 177_778,
      taxes: 17_778,
      refundReserve: 5_333,
      netRevenue: 154_667,
      infrastructure: 11_264,
      paymentFees: 10_717,
      support: 8_000,
      contributionMargin: 124_686,
    });
    expect(result.taxMode).toBe('exclusive');
  });

  it('no boleto, a tarifa é o valor fixo mais a cobrança recorrente; com a outra alíquota, o imposto muda', () => {
    const boleto = computed(PLATAFORMA, 'boleto');
    // 3,00 + 1.600 × 1% = 19,00.
    expect(boleto.monthly.paymentFees).toBe(1_900);
    expect(boleto.monthly.contributionMargin).toBe(139_200 - 11_264 - 1_900 - 8_000);

    const other = computed(PLATAFORMA, 'card', { taxRateId: 'teste_b' });
    expect(other.monthly.taxes).toBe(32_000);
    expect(other.monthly.netRevenue).toBe(160_000 - 32_000 - 4_800);
    expect(other.taxRateId).toBe('teste_b');
  });

  it('desconto (cupom) só nos itens mensais; rateio dos custos fixos por outro número de clientes', () => {
    const discounted = computed(PLATAFORMA, 'card', { discountRate: 0.5, allocationCustomers: 4 });
    expect(discounted.monthly.grossRevenue).toBe(80_000);
    expect(discounted.monthly.taxes).toBe(8_000);
    expect(discounted.monthly.fixedCosts).toBe(25_000);
  });

  it('Dedicado na Verax: o nó inteiro do porte do volume, mais a ingestão', () => {
    const result = computed({ plan: 'dedicado', gbDay: 8, mode: 'managed' }, 'card');
    // Porte M: VM 200 + disco 2 + snapshots 1 + NAT 1 + IP 2 + outros 1 + ingestão 8 × 2 = 223 → × 2 × 1,1 = R$ 490,60.
    expect(result.quote.configuration.size).toBe('M');
    expect(result.monthly.infrastructure).toBe(49_060);
    expect(result.supportHours).toBe(2);
  });

  it('vCISO no cliente: sem infraestrutura, as horas do serviço e do cliente, a implantação e a estimativa da nuvem', () => {
    const result = computed({ plan: 'vciso', gbDay: 4, mode: 'self_hosted' }, 'card');

    // 4 GB/dia × 500 + serviço 2.000 = 4.000. Suporte: Dedicado 2 h + serviço 5 h + no cliente 1 h = 8 h.
    expect(result.monthly).toMatchObject({
      grossRevenue: 400_000,
      taxes: 40_000,
      refundReserve: 12_000,
      netRevenue: 348_000,
      infrastructure: 0,
      paymentFees: 24_050,
      support: 64_000,
      contributionMargin: 259_950,
    });
    // Implantação de 5.000: 10% de imposto, 3% de reserva, 6% de tarifa (o valor fixo já está no mês), 4 + 10 + 8 h.
    expect(result.setup).toEqual({
      revenue: 500_000,
      taxes: 50_000,
      refundReserve: 15_000,
      paymentFees: 30_000,
      supportHours: 22,
      support: 176_000,
      contributionMargin: 229_000,
      contributionMarginRatio: 0.458,
    });
    // A nuvem do cliente: o nó P a preço de lista com a ingestão, sem a folga (US$ 113,50 × 2), com a faixa de ±50%.
    expect(result.customerCloudEstimate).toEqual({ monthly: 22_700, low: 11_350, high: 34_050 });
  });

  it('a nuvem da Plataforma cresce com o GB/dia; a do Dedicado é o nó inteiro desde o mínimo', () => {
    const cell = (gbDay: number): number =>
      cloudUsd({ plan: 'plataforma', mode: 'managed', gbDay, size: 'P', historyDays: 60 }, model);
    expect(cell(2)).toBeCloseTo(10.55 * 2 + 1 + 4, 10);
    expect(cell(5) - cell(4)).toBeCloseTo(10.55 + 2, 10);
    expect(
      cloudUsd({ plan: 'dedicado', mode: 'managed', gbDay: 3, size: 'P', historyDays: 60 }, model),
    ).toBeCloseTo(105.5 + 6, 10);
  });

  it('configuração sob consulta não tem DRE', () => {
    expect(dre({ plan: 'plataforma', gbDay: 50, mode: 'managed' }, table, model, 'card')).toEqual({
      kind: 'contact_us',
      reason: 'above_online_max',
    });
  });

  it('modelo de custos que não cobre a tabela (porte sem custo, alíquota inexistente): erro com os caminhos', () => {
    const partial = costModelSchema.parse({
      ...fictitiousCostModel(),
      infrastructure: {
        ...fictitiousCostModel().infrastructure,
        sizes: { P: { vmUsdPerMonth: 100, diskGb: 10, snapshotGib: 10 } },
      },
    });
    expect(costModelProblems(table, partial)).toEqual(['infrastructure.sizes.M', 'infrastructure.sizes.G']);
    expect(() => dre(PLATAFORMA, table, partial, 'card')).toThrow(CostModelMismatchError);
    expect(() => dre(PLATAFORMA, table, model, 'card', { taxRateId: 'inexistente' })).toThrow(
      CostModelMismatchError,
    );
    expect(costModelProblems(table, model)).toEqual([]);
  });
});
