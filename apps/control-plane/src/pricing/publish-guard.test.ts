import { describe, expect, it } from 'vitest';
import { fictitiousCostModel, fictitiousPriceTable } from '../../test/support/pricing-fixtures.js';
import { type CostModel, costModelSchema, type PriceTableInput, priceTableSchema } from './pricing.schema.js';
import { configurationGrid, gridSize, MAX_GRID_CONFIGURATIONS, runPublishGuard } from './publish-guard.js';

/**
 * A checagem de publicação sobre a tabela e o modelo de custos FICTÍCIOS (`pricing-fixtures.ts`, margem mínima de
 * teste 25%, alerta 35%). Com eles a grade inteira passa; cada teste estraga uma coisa e confere que a checagem acha.
 */
const model: CostModel = costModelSchema.parse(fictitiousCostModel());

function tableWith(change: (table: PriceTableInput) => void = () => undefined) {
  const input = fictitiousPriceTable();
  change(input);
  return priceTableSchema.parse(input);
}

describe('checagem de publicação (grade inteira)', () => {
  it('percorre todas as configurações vendáveis dos dois modos e aprova a tabela fictícia', () => {
    const table = tableWith();
    // 2 modos × 19 contas (2 a 20) × 4 volumes × 5 pacotes de agentes (0 a 4) × 3 históricos × 2 suportes.
    expect(gridSize(table)).toBe(2 * 19 * 4 * 5 * 3 * 2);
    expect([...configurationGrid(table)]).toHaveLength(gridSize(table));

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
      startingAt: { managed: 100_000, self_hosted: 50_000 },
      gridMinimum: { managed: 100_000, self_hosted: 50_000 },
    });
    // As piores em ordem crescente de margem; a pior de todas é a do relatório por modo e por porte.
    const ratios = report.worst.map((entry) => entry.contributionMarginRatio);
    expect(ratios).toEqual([...ratios].sort((a, b) => a - b));
    expect(report.worst).toHaveLength(10);
    expect(report.worstByMode.self_hosted).toEqual(report.worst[0]);
    expect(report.worstBySize.P?.contributionMarginRatio).toBe(report.worst[0]?.contributionMarginRatio);
    // Entre a mínima e o alerta há configurações: avisadas, não bloqueiam.
    expect(report.belowAlert.count).toBeGreaterThan(0);
    for (const entry of report.belowAlert.configurations) {
      expect(entry.contributionMarginRatio).toBeGreaterThanOrEqual(0.25);
      expect(entry.contributionMarginRatio).toBeLessThan(0.35);
    }
    // Só informação: a outra alíquota no cartão e a padrão no boleto.
    expect(report.otherScenarios.map((scenario) => [scenario.taxRateId, scenario.paymentMethod])).toEqual([
      ['teste_b', 'card'],
      ['teste_a', 'boleto'],
    ]);
    expect(report.otherScenarios[0]?.worst?.contributionMarginRatio).toBeLessThan(ratios[0] ?? 0);
  });

  it('acha toda configuração abaixo da margem mínima e recusa a tabela, listando as piores', () => {
    // Suporte prioritário quase de graça (R$ 1, fictício): duas horas a mais por mês sem receita que as pague.
    const table = tableWith((input) => {
      input.prioritySupport.amount = 100;
    });

    const report = runPublishGuard(table, model);

    expect(report.ok).toBe(false);
    expect(report.belowMinimum.count).toBeGreaterThan(0);
    expect(report.belowMinimum.configurations.length).toBe(Math.min(20, report.belowMinimum.count));
    for (const entry of report.belowMinimum.configurations) {
      expect(entry.configuration.support).toBe('priority');
      expect(entry.contributionMarginRatio).toBeLessThan(0.25);
    }
    expect(report.worst[0]).toEqual(report.belowMinimum.configurations[0]);
    // No máximo as configurações com suporte prioritário (metade da grade): o defeito é desse componente.
    expect(report.belowMinimum.count).toBeLessThanOrEqual(gridSize(table) / 2);
    expect(report.worstByMode.managed?.configuration.support).toBe('priority');
  });

  it('uma margem mínima mais alta no modelo de custos reprova a mesma tabela', () => {
    const strict = costModelSchema.parse({
      ...fictitiousCostModel(),
      margins: { minimum: 0.45, alert: 0.5 },
    });
    const report = runPublishGuard(tableWith(), strict);
    expect(report.ok).toBe(false);
    expect(report.belowMinimum.count).toBeGreaterThan(0);
    expect(report.belowMinimum.configurations.every((entry) => entry.contributionMarginRatio < 0.45)).toBe(
      true,
    );
  });

  it('monotonia: um porte maior mais barato que o menor faz acrescentar uma conta baixar o preço', () => {
    const table = tableWith((input) => {
      input.modes.managed.environment.M = { amount: 50_000, lookupKey: 'vc_env_m_v1' };
    });

    const report = runPublishGuard(table, model);

    expect(report.ok).toBe(false);
    expect(report.monotonicity.violations).toBeGreaterThan(0);
    const [example] = report.monotonicity.examples;
    expect(example?.from.size).toBe('P');
    expect(example?.to.size).toBe('M');
    expect(example?.toTotal).toBeLessThan(example?.fromTotal ?? 0);
    // E o "a partir de" deixa de ser o mínimo da grade.
    expect(report.gridMinimum.managed).toBeLessThan(report.startingAt.managed ?? 0);
    expect(report.problems).toContain('o "a partir de" não é o menor preço da grade');
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

    const huge = tableWith((input) => {
      input.cloudAccounts.max = 10_000;
      input.agents.maxPacks = 1_000;
    });
    expect(gridSize(huge)).toBeGreaterThan(MAX_GRID_CONFIGURATIONS);
    const tooLarge = runPublishGuard(huge, model);
    expect(tooLarge.ok).toBe(false);
    expect(tooLarge.problems[0]).toMatch(/^grade grande demais/);
  });

  it('um pacote de partida que cai em "sob consulta" reprova a tabela', () => {
    const table = tableWith((input) => {
      input.presets = [
        {
          id: 'grande-demais',
          label: 'Grande demais (teste)',
          configuration: {
            mode: 'managed',
            cloudAccounts: 2,
            monthlyGib: 10,
            agents: 999,
            historyDays: 30,
            support: 'standard',
          },
        },
      ];
    });
    const report = runPublishGuard(table, model);
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual(['pacote de partida grande-demais fica sob consulta (agents_above_max)']);
  });

  it('uma tabela que vende mais agentes do que o nó aceita é recusada', () => {
    const table = tableWith((input) => {
      input.agents.packSize = 100;
      input.agents.maxPacks = 6;
    });
    const report = runPublishGuard(table, model);
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual(['agentes acima do que o nó aceita (600 de 500)']);
  });

  it('configurações acima do maior porte contam como sob consulta e ficam fora da margem', () => {
    const table = tableWith((input) => {
      input.cloudAccounts.max = 22;
    });
    const report = runPublishGuard(table, model);
    expect(report.contactUsConfigurations).toBe(2 * 2 * 4 * 5 * 3 * 2);
    expect(report.checkedConfigurations).toBe(gridSize(table) - report.contactUsConfigurations);
    expect(report.ok).toBe(true);
  });
});
