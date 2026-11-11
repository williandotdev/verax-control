import { describe, expect, it } from 'vitest';
import { fictitiousCostModel, fictitiousPriceTable } from '../../test/support/pricing-fixtures.js';
import {
  type CostModel,
  costModelSchema,
  type PriceTable,
  type PriceTableInput,
  priceTableSchema,
} from './pricing.schema.js';
import { configurationGrid, gridSize, MAX_GRID_CONFIGURATIONS, runPublishGuard } from './publish-guard.js';

/**
 * A checagem de publicação sobre a tabela e o modelo de custos FICTÍCIOS (`pricing-fixtures.ts`, margem mínima de
 * teste 25%, alerta 35%). Com eles a grade inteira passa; cada teste estraga uma coisa e confere que a checagem acha.
 */
const model: CostModel = costModelSchema.parse(fictitiousCostModel());

function tableWith(change: (table: PriceTableInput) => void = () => undefined): PriceTable {
  const input = fictitiousPriceTable();
  change(input);
  return priceTableSchema.parse(input);
}

describe('checagem de publicação (grade inteira)', () => {
  it('percorre cada GB/dia vendável de cada plano, em cada lugar dele, e aprova a tabela fictícia', () => {
    const table = tableWith();
    // Plataforma de 2 a 5 GB/dia (só na Verax); Dedicado e vCISO de 3 a 15, nos dois lugares.
    expect(gridSize(table)).toBe(4 + 2 * 13 + 2 * 13);
    const grid = [...configurationGrid(table)];
    expect(grid).toHaveLength(gridSize(table));
    expect(grid.slice(0, 5)).toEqual([
      { plan: 'plataforma', mode: 'managed', gbDay: 2 },
      { plan: 'plataforma', mode: 'managed', gbDay: 3 },
      { plan: 'plataforma', mode: 'managed', gbDay: 4 },
      { plan: 'plataforma', mode: 'managed', gbDay: 5 },
      { plan: 'dedicado', mode: 'managed', gbDay: 3 },
    ]);

    const report = runPublishGuard(table, model);

    expect(report).toMatchObject({
      ok: true,
      problems: [],
      paymentMethod: 'card',
      taxRateId: 'teste_a',
      minimumMargin: 0.25,
      alertMargin: 0.35,
      checkedConfigurations: gridSize(table),
      contactUsConfigurations: 0,
      belowMinimum: { count: 0, configurations: [] },
      monotonicity: { violations: 0, examples: [] },
      startingAt: { plataforma: 100_000, dedicado: 150_000, vciso: 350_000 },
      gridMinimum: { plataforma: 100_000, dedicado: 150_000, vciso: 350_000 },
    });
    // As piores em ordem crescente de margem; a pior de todas é a do relatório por plano e por lugar.
    const ratios = report.worst.map((entry) => entry.contributionMarginRatio);
    expect(ratios).toEqual([...ratios].sort((a, b) => a - b));
    expect(report.worst).toHaveLength(10);
    // O pior caso é o Dedicado no mínimo, na Verax: o nó P inteiro para 3 GB/dia.
    expect(report.worst[0]?.configuration).toMatchObject({ plan: 'dedicado', gbDay: 3, mode: 'managed' });
    expect(report.worstByPlan.dedicado).toEqual(report.worst[0]);
    expect(report.worstByMode.managed).toEqual(report.worst[0]);
    expect(report.worstByPlan.plataforma?.configuration.plan).toBe('plataforma');
    // Só informação: a outra alíquota no cartão e a padrão no boleto.
    expect(report.otherScenarios.map((scenario) => [scenario.taxRateId, scenario.paymentMethod])).toEqual([
      ['teste_b', 'card'],
      ['teste_a', 'boleto'],
    ]);
    expect(report.otherScenarios[0]?.worst?.contributionMarginRatio).toBeLessThan(ratios[0] ?? 0);
  });

  it('entre a mínima e o alerta: avisadas, não bloqueiam', () => {
    const alerting = costModelSchema.parse({
      ...fictitiousCostModel(),
      margins: { minimum: 0.25, alert: 0.6 },
    });
    const report = runPublishGuard(tableWith(), alerting);
    expect(report.ok).toBe(true);
    expect(report.belowAlert.count).toBeGreaterThan(0);
    for (const entry of report.belowAlert.configurations) {
      expect(entry.contributionMarginRatio).toBeGreaterThanOrEqual(0.25);
      expect(entry.contributionMarginRatio).toBeLessThan(0.6);
    }
  });

  it('acha toda configuração abaixo da margem mínima e recusa a tabela, listando as piores', () => {
    // GB/dia do Dedicado quase de graça (R$ 50, fictício): o nó inteiro sem receita que o pague.
    const table = tableWith((input) => {
      input.plans.dedicado.gbDay.amount = 5_000;
    });

    const report = runPublishGuard(table, model);

    expect(report.ok).toBe(false);
    expect(report.belowMinimum.count).toBeGreaterThan(0);
    expect(report.belowMinimum.configurations.length).toBe(Math.min(20, report.belowMinimum.count));
    for (const entry of report.belowMinimum.configurations) {
      expect(entry.configuration.plan).not.toBe('plataforma');
      expect(entry.contributionMarginRatio).toBeLessThan(0.25);
    }
    expect(report.worst[0]).toEqual(report.belowMinimum.configurations[0]);
    expect(report.worstByPlan.plataforma?.contributionMarginRatio).toBeGreaterThan(0.25);
  });

  it('uma margem mínima mais alta no modelo de custos reprova a mesma tabela', () => {
    const strict = costModelSchema.parse({
      ...fictitiousCostModel(),
      margins: { minimum: 0.6, alert: 0.65 },
    });
    const report = runPublishGuard(tableWith(), strict);
    expect(report.ok).toBe(false);
    expect(report.belowMinimum.count).toBeGreaterThan(0);
    expect(report.belowMinimum.configurations.every((entry) => entry.contributionMarginRatio < 0.6)).toBe(
      true,
    );
  });

  it('monotonia: um GB/dia a mais que baixa o preço reprova, e o "a partir de" deixa de ser o menor', () => {
    // Uma tabela fora do schema (adicional negativo), só para exercitar a conferência: a forma da tabela já impede.
    const base = tableWith();
    const table: PriceTable = {
      ...base,
      plans: {
        ...base.plans,
        plataforma: { ...base.plans.plataforma, additionalGbDay: { amount: -1_000, lookupKey: 'vc_add_v1' } },
      },
    };

    const report = runPublishGuard(table, model);

    expect(report.ok).toBe(false);
    expect(report.monotonicity.violations).toBe(3);
    const [example] = report.monotonicity.examples;
    expect(example?.from).toMatchObject({ plan: 'plataforma', gbDay: 2 });
    expect(example?.to).toMatchObject({ plan: 'plataforma', gbDay: 3 });
    expect(example?.toTotal).toBeLessThan(example?.fromTotal ?? 0);
    expect(report.gridMinimum.plataforma).toBeLessThan(report.startingAt.plataforma ?? 0);
    expect(report.problems).toContain('o "a partir de" do plano plataforma não é o menor preço dele');
  });

  it('o site não pode vender o que não cota nem o que o provisionamento não cria', () => {
    // Até 8 GB/dia no site, com o P até 5: de 6 a 8 o porte é M, que o provisionamento ainda não cria.
    const unfit = runPublishGuard(
      tableWith((input) => {
        input.plans.plataforma.maxOnlineGbDay = 8;
      }),
      model,
    );
    expect(unfit.ok).toBe(false);
    expect(unfit.problems).toEqual([
      'o site venderia o que o provisionamento ainda não cria: plataforma 6 GB/dia (porte M), ' +
        'plataforma 7 GB/dia (porte M), plataforma 8 GB/dia (porte M)',
    ]);
    // Só com o P: de 6 a 8 GB/dia o site oferece e a cotação cai em "sob consulta".
    const contact = runPublishGuard(
      tableWith((input) => {
        input.plans.plataforma.maxOnlineGbDay = 8;
        input.plans.dedicado.maxGbDay = 5;
        input.sizing.sizes = [{ size: 'P', maxGbDay: 5, description: 'Só P' }];
      }),
      model,
    );
    expect(contact.ok).toBe(false);
    expect(contact.problems).toEqual([
      'o site oferece e não cota: plataforma 6 GB/dia (above_largest_size), ' +
        'plataforma 7 GB/dia (above_largest_size), plataforma 8 GB/dia (above_largest_size)',
    ]);
  });

  it('o excedente da Plataforma não pode ser mais barato que o GB/dia contratado', () => {
    const report = runPublishGuard(
      tableWith((input) => {
        input.plans.plataforma.overageGbDay.amount = 10_000;
      }),
      model,
    );
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual(['o GB/dia excedente da Plataforma é mais barato que o contratado']);
  });

  it('modelo de custos incompleto ou grade grande demais: a checagem nem roda e a tabela é recusada', () => {
    const partial = costModelSchema.parse({
      ...fictitiousCostModel(),
      infrastructure: {
        ...fictitiousCostModel().infrastructure,
        sizes: { P: { vmUsdPerMonth: 100, diskGb: 10, snapshotGib: 10 } },
      },
    });
    const incomplete = runPublishGuard(tableWith(), partial);
    expect(incomplete).toMatchObject({
      ok: false,
      problems: ['infrastructure.sizes.M', 'infrastructure.sizes.G'],
      checkedConfigurations: 0,
    });

    // Uma tabela fora do schema (máximo acima do teto de sanidade), só para exercitar o teto da grade.
    const base = tableWith();
    const huge: PriceTable = {
      ...base,
      plans: { ...base.plans, dedicado: { ...base.plans.dedicado, maxGbDay: 60_000 } },
    };
    expect(gridSize(huge)).toBeGreaterThan(MAX_GRID_CONFIGURATIONS);
    const tooLarge = runPublishGuard(huge, model);
    expect(tooLarge.ok).toBe(false);
    expect(tooLarge.problems[0]).toMatch(/^grade grande demais/);
  });

  it('o Dedicado acima do maior porte conta como sob consulta e fica fora da margem (não é vendido no site)', () => {
    const table = tableWith((input) => {
      input.sizing.sizes = [
        { size: 'P', maxGbDay: 5, description: 'P' },
        { size: 'M', maxGbDay: 12, description: 'M' },
      ];
    });
    const report = runPublishGuard(table, model);
    // 13, 14 e 15 GB/dia, no Dedicado e no vCISO, nos dois lugares.
    expect(report.contactUsConfigurations).toBe(3 * 2 * 2);
    expect(report.checkedConfigurations).toBe(gridSize(table) - report.contactUsConfigurations);
    expect(report.ok).toBe(true);
  });
});
