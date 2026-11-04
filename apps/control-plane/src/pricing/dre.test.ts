import { describe, expect, it } from 'vitest';
import { fictitiousCostModel, fictitiousPriceTable } from '../../test/support/pricing-fixtures.js';
import { CostModelMismatchError, costModelProblems, dre, type DreOptions, type DreResult } from './dre.js';
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
 * R$ 80, custos fixos de R$ 1.000 rateados entre 5 clientes. As contas abaixo estão feitas à mão, linha a linha.
 */
const table: PriceTable = priceTableSchema.parse(fictitiousPriceTable());
const model: CostModel = costModelSchema.parse(fictitiousCostModel());

/** Gerenciado, 4 contas (2 adicionais), 50 GiB, 10 agentes (1 pacote), 180 dias, suporte padrão: porte P. */
const MANAGED: ConfigurationInput = {
  mode: 'managed',
  cloudAccounts: 4,
  monthlyGib: 50,
  agents: 10,
  historyDays: 180,
  support: 'standard',
};

function computed(
  configuration: ConfigurationInput,
  paymentMethod: PaymentMethod,
  options: Omit<DreOptions, 'paymentMethod'> = {},
): DreResult {
  const outcome = dre(configuration, table, model, paymentMethod, options);
  if (outcome.kind !== 'dre') throw new Error(`sob consulta: ${outcome.reason}`);
  return outcome.dre;
}

describe('DRE por cliente e por mês', () => {
  it('gerenciado no cartão, alíquota padrão: cada linha conforme a fórmula', () => {
    const result = computed(MANAGED, 'card');

    // Receita: ambiente 1.000 + 2 contas × 30 + faixa de 50 GiB 100 + 1 pacote 100 + histórico de 180 dias 20 = 1.280.
    // Nuvem do nó (US$): VM 100 + disco 10 × 0,10 + snapshots 10 × 0,05 + NAT 1 + IP do NAT 2 + outros 1
    //   + ingestão 50 × 0,10 + agentes (entrada 2 + (10 + 10 × 2) GB × 0,15) = 117 → × câmbio 2 × folga 1,1 = R$ 257,40.
    // Meio de pagamento: 1.280 × (5% + 1%) + 0,50 = 77,30. Suporte: (1,5 + 2 × 0,15 + 0,5 + 0,5) h = 2,8 h × 80.
    expect(result.monthly).toEqual({
      grossRevenue: 128_000,
      taxes: 12_800,
      refundReserve: 3_840,
      netRevenue: 111_360,
      infrastructure: 25_740,
      paymentFees: 7_730,
      support: 22_400,
      contributionMargin: 55_490,
      contributionMarginRatio: 55_490 / 128_000,
      contributionMarginNetRatio: 55_490 / 111_360,
      fixedCosts: 20_000,
      result: 35_490,
      resultRatio: 35_490 / 128_000,
    });
    expect(result.supportHours).toBeCloseTo(2.8, 10);
    expect(result.taxRateId).toBe('teste_a');
    // Sem implantação no gerenciado: as horas da implantação (1,5 h) são só custo, no primeiro mês.
    expect(result.setup).toEqual({
      revenue: 0,
      taxes: 0,
      refundReserve: 0,
      paymentFees: 0,
      supportHours: 1.5,
      support: 12_000,
      contributionMargin: -12_000,
      contributionMarginRatio: null,
    });
    expect(result.twelveMonths).toEqual({
      grossRevenue: 12 * 128_000,
      contributionMargin: 12 * 55_490 - 12_000,
      result: 12 * 35_490 - 12_000,
    });
    expect(result.customerCloudEstimate).toBeNull();
  });

  it('no boleto, a tarifa é o valor fixo mais a cobrança recorrente; com a outra alíquota, o imposto muda', () => {
    const boleto = computed(MANAGED, 'boleto');
    // 3,00 + 1.280 × 1% = 15,80.
    expect(boleto.monthly.paymentFees).toBe(1_580);
    expect(boleto.monthly.contributionMargin).toBe(111_360 - 25_740 - 1_580 - 22_400);

    const other = computed(MANAGED, 'card', { taxRateId: 'teste_b' });
    expect(other.monthly.taxes).toBe(25_600);
    expect(other.monthly.netRevenue).toBe(128_000 - 25_600 - 3_840);
    expect(other.taxRateId).toBe('teste_b');
  });

  it('desconto (cupom) só nos itens mensais; rateio dos custos fixos por outro número de clientes', () => {
    const discounted = computed(MANAGED, 'card', { discountRate: 0.5, allocationCustomers: 4 });
    expect(discounted.monthly.grossRevenue).toBe(64_000);
    expect(discounted.monthly.taxes).toBe(6_400);
    expect(discounted.monthly.fixedCosts).toBe(25_000);
  });

  it('na nuvem do cliente: sem infraestrutura, suporte base maior, implantação com as horas dela e a estimativa da nuvem', () => {
    const result = computed({ ...MANAGED, mode: 'self_hosted' }, 'card');

    // Licença P 500 + os mesmos componentes (280) = 780. Suporte: (2,5 + 0,3 + 0,5 + 0,5) h = 3,8 h.
    expect(result.monthly).toMatchObject({
      grossRevenue: 78_000,
      taxes: 7_800,
      refundReserve: 2_340,
      netRevenue: 67_860,
      infrastructure: 0,
      paymentFees: 4_730,
      support: 30_400,
      contributionMargin: 32_730,
    });
    // Implantação de 1.000: 10% de imposto, 3% de reserva, 6% de tarifa (o valor fixo já está no mês), 10 h.
    expect(result.setup).toEqual({
      revenue: 100_000,
      taxes: 10_000,
      refundReserve: 3_000,
      paymentFees: 6_000,
      supportHours: 10,
      support: 80_000,
      contributionMargin: 1_000,
      contributionMarginRatio: 0.01,
    });
    // A nuvem do cliente: o mesmo nó a preço de lista, sem a folga (US$ 117 × 2), com a faixa de ±50%.
    expect(result.customerCloudEstimate).toEqual({ monthly: 23_400, low: 11_700, high: 35_100 });
  });

  it('configuração sob consulta não tem DRE', () => {
    expect(dre({ ...MANAGED, agents: 999 }, table, model, 'card')).toEqual({
      kind: 'contact_us',
      reason: 'agents_above_max',
    });
  });

  it('modelo de custos que não cobre a tabela (porte sem custo, faixa sem horas, alíquota inexistente): erro com os caminhos', () => {
    const partial = costModelSchema.parse({
      ...fictitiousCostModel(),
      infrastructure: {
        ...fictitiousCostModel().infrastructure,
        sizes: { P: { vmUsdPerMonth: 100, diskGb: 10, snapshotGib: 10 } },
      },
      support: {
        ...fictitiousCostModel().support,
        hours: { ...fictitiousCostModel().support.hours, perVolumeBand: [{ monthlyGib: 50, hours: 0.5 }] },
      },
    });
    expect(costModelProblems(table, partial)).toEqual([
      'infrastructure.sizes.M',
      'infrastructure.sizes.G',
      'support.hours.perVolumeBand.100',
      'support.hours.perVolumeBand.200',
    ]);
    expect(() => dre(MANAGED, table, partial, 'card')).toThrow(CostModelMismatchError);
    expect(() => dre(MANAGED, table, model, 'card', { taxRateId: 'inexistente' })).toThrow(
      CostModelMismatchError,
    );
    expect(costModelProblems(table, model)).toEqual([]);
  });
});
