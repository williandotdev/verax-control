import { describe, expect, it } from 'vitest';
import { fictitiousCostModel, fictitiousPriceTable } from '../../test/support/pricing-fixtures.js';
import {
  configurationInputSchema,
  costModelSchema,
  lookupKeysOf,
  type PriceTableInput,
  priceTableSchema,
} from './pricing.schema.js';

/** As mensagens dos problemas de um conteúdo inválido, por caminho. */
function problems(result: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}): string[] {
  return (result.error?.issues ?? []).map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`);
}

function tableWith(change: (table: PriceTableInput) => void): PriceTableInput {
  const table = fictitiousPriceTable();
  change(table);
  return table;
}

// Tabelas e modelos FICTÍCIOS (test/support/pricing-fixtures.ts): números redondos e inventados.
describe('tabela de preços e modelo de custos (schema)', () => {
  it('a tabela e o modelo fictícios são válidos; os pacotes de partida têm padrão vazio', () => {
    expect(priceTableSchema.safeParse(fictitiousPriceTable()).success).toBe(true);
    expect(costModelSchema.safeParse(fictitiousCostModel()).success).toBe(true);
    const { presets: _presets, ...withoutPresets } = fictitiousPriceTable();
    expect(priceTableSchema.parse(withoutPresets).presets).toEqual([]);
  });

  it('lista cada preço da tabela com o componente, a variante e o tipo (o que vai aos metadados da Stripe)', () => {
    const keys = lookupKeysOf(priceTableSchema.parse(fictitiousPriceTable()));
    expect(keys.map((entry) => [entry.component, entry.variant, entry.lookupKey, entry.recurring])).toEqual([
      ['environment', 'managed_P', 'vc_env_p_v1', true],
      ['environment', 'managed_M', 'vc_env_m_v1', true],
      ['environment', 'managed_G', 'vc_env_g_v1', true],
      ['environment', 'self_hosted_P', 'vc_lic_p_v1', true],
      ['environment', 'self_hosted_M', 'vc_lic_m_v1', true],
      ['environment', 'self_hosted_G', 'vc_lic_g_v1', true],
      ['setup', 'self_hosted', 'vc_set_v1', false],
      ['cloud_accounts', 'additional', 'vc_acc_v1', true],
      ['volume', '50', 'vc_vol_50_v1', true],
      ['volume', '100', 'vc_vol_100_v1', true],
      ['volume', '200', 'vc_vol_200_v1', true],
      ['agents', '10', 'vc_agt_v1', true],
      ['history', '180', 'vc_his_180_v1', true],
      ['history', '360', 'vc_his_360_v1', true],
      ['priority_support', 'priority', 'vc_sup_v1', true],
    ]);
  });

  it('recusa regra de porte incoerente: porte repetido, fora de ordem ou com teto menor que o anterior', () => {
    const repeated = tableWith((table) => {
      const first = table.sizing.sizes[0];
      if (first !== undefined) table.sizing.sizes[1] = { ...first, description: 'outro' };
    });
    expect(problems(priceTableSchema.safeParse(repeated))).toContain('sizing.sizes: porte repetido');
    const outOfOrder = tableWith((table) => {
      table.sizing.sizes.reverse();
    });
    expect(problems(priceTableSchema.safeParse(outOfOrder))).toContain(
      'sizing.sizes: portes fora de ordem (P, M, G)',
    );
    const smaller = tableWith((table) => {
      const largest = table.sizing.sizes[2];
      if (largest !== undefined) largest.maxAgents = 1;
    });
    expect(problems(priceTableSchema.safeParse(smaller))).toEqual([
      'sizing.sizes.2: um porte maior não pode ter teto menor que o anterior',
    ]);
  });

  it('cada porte da regra precisa de preço nos dois modos, e nenhum preço de porte fora da regra', () => {
    const missing = tableWith((table) => {
      delete table.modes.self_hosted.environment.M;
    });
    expect(problems(priceTableSchema.safeParse(missing))).toEqual([
      'modes.self_hosted.environment.M: sem preço para este porte',
    ]);
    const extra = tableWith((table) => {
      table.sizing.sizes.pop();
    });
    expect(problems(priceTableSchema.safeParse(extra))).toEqual([
      'modes.managed.environment.G: porte fora da regra de porte',
      'modes.self_hosted.environment.G: porte fora da regra de porte',
    ]);
  });

  it('faixas de volume e opções de histórico em ordem crescente e acima do incluído; contas máximas ≥ incluídas', () => {
    const bands = tableWith((table) => {
      table.volume.bands = [...table.volume.bands].reverse();
    });
    expect(problems(priceTableSchema.safeParse(bands))).toEqual([
      'volume.bands: faixas em ordem crescente e acima do incluído',
    ]);
    const included = tableWith((table) => {
      table.volume.includedMonthlyGib = 50;
    });
    expect(problems(priceTableSchema.safeParse(included))).toContain(
      'volume.bands: faixas em ordem crescente e acima do incluído',
    );
    const history = tableWith((table) => {
      const first = table.history.extended[0];
      if (first !== undefined) first.days = 30;
    });
    expect(problems(priceTableSchema.safeParse(history))).toEqual([
      'history.extended: opções em ordem crescente e acima do incluído',
    ]);
    const accounts = tableWith((table) => {
      table.cloudAccounts.max = 1;
    });
    expect(problems(priceTableSchema.safeParse(accounts))).toEqual([
      'cloudAccounts.max: menor que o incluído',
    ]);
  });

  it('o mesmo lookup_key em dois preços é recusado (cada preço da Stripe é de um componente só)', () => {
    const table = tableWith((value) => {
      value.prioritySupport.lookupKey = 'vc_acc_v1';
    });
    expect(problems(priceTableSchema.safeParse(table))).toEqual([
      'lookupKeys: lookup_key repetido: vc_acc_v1',
    ]);
  });

  it('estrito e com formatos: campo desconhecido, moeda, valor e lookup_key fora do formato', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...fictitiousPriceTable(), desconto: 1 }, ''],
      [{ ...fictitiousPriceTable(), currency: 'usd' }, 'currency'],
      [
        { ...fictitiousPriceTable(), prioritySupport: { amount: 0, lookupKey: 'vc_x_v1' } },
        'prioritySupport.amount',
      ],
      [
        { ...fictitiousPriceTable(), prioritySupport: { amount: 1.5, lookupKey: 'vc_x_v1' } },
        'prioritySupport.amount',
      ],
      [
        { ...fictitiousPriceTable(), prioritySupport: { amount: 100, lookupKey: 'Com-Maiuscula' } },
        'prioritySupport.lookupKey',
      ],
    ];
    for (const [table, path] of cases) {
      const result = priceTableSchema.safeParse(table);
      expect(result.success, path).toBe(false);
      expect(result.error?.issues[0]?.path.map(String).join('.'), path).toBe(path);
    }
  });

  it('modelo de custos: alíquota padrão existente e única, alerta ≥ mínima, faixa de horas sem repetição', () => {
    const model = fictitiousCostModel();
    expect(
      problems(
        costModelSchema.safeParse({ ...model, taxes: { ...model.taxes, defaultRateId: 'inexistente' } }),
      ),
    ).toEqual(['taxes.defaultRateId: alíquota inexistente']);
    expect(
      problems(
        costModelSchema.safeParse({
          ...model,
          taxes: {
            ...model.taxes,
            rates: [...model.taxes.rates, { id: 'teste_a', label: 'De novo', rate: 0.3 }],
          },
        }),
      ),
    ).toEqual(['taxes.rates: alíquota repetida']);
    expect(problems(costModelSchema.safeParse({ ...model, margins: { minimum: 0.5, alert: 0.4 } }))).toEqual([
      'margins.alert: menor que a mínima',
    ]);
    const hours = model.support.hours;
    expect(
      problems(
        costModelSchema.safeParse({
          ...model,
          support: {
            ...model.support,
            hours: { ...hours, perVolumeBand: [...hours.perVolumeBand, { monthlyGib: 50, hours: 9 }] },
          },
        }),
      ),
    ).toEqual(['support.hours.perVolumeBand: faixa repetida']);
    expect(costModelSchema.safeParse({ ...model, refundReserveRate: 1.5 }).success).toBe(false);
    expect(costModelSchema.safeParse({ ...model, margem: 0.5 }).success).toBe(false);
  });

  it('a configuração do cliente é estrita e não aceita nenhum campo de preço', () => {
    const base = {
      mode: 'managed',
      cloudAccounts: 3,
      monthlyGib: 10,
      agents: 0,
      historyDays: 30,
      support: 'standard',
    };
    expect(configurationInputSchema.safeParse(base).success).toBe(true);
    for (const extra of [{ price: 1 }, { size: 'P' }, { monthlyTotal: 1 }, { lookupKey: 'vc_acc_v1' }]) {
      expect(configurationInputSchema.safeParse({ ...base, ...extra }).success, JSON.stringify(extra)).toBe(
        false,
      );
    }
    for (const wrong of [{ mode: 'hibrido' }, { agents: -1 }, { cloudAccounts: 2.5 }, { support: 'vip' }]) {
      expect(configurationInputSchema.safeParse({ ...base, ...wrong }).success, JSON.stringify(wrong)).toBe(
        false,
      );
    }
  });
});
