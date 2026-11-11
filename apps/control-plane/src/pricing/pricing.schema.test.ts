import { describe, expect, it } from 'vitest';
import {
  demoConfiguration,
  fictitiousCostModel,
  fictitiousPriceTable,
} from '../../test/support/pricing-fixtures.js';
import {
  configurationInputSchema,
  contractedConfigurationSchema,
  costModelSchema,
  isLegacyConfiguration,
  lookupKeysOf,
  type PriceTableInput,
  priceTableSchema,
  quoteInputSchema,
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
  it('a tabela e o modelo fictícios são válidos', () => {
    expect(priceTableSchema.safeParse(fictitiousPriceTable()).success).toBe(true);
    expect(costModelSchema.safeParse(fictitiousCostModel()).success).toBe(true);
  });

  it('lista cada preço da tabela com o componente, o plano e o tipo (o que vai aos metadados da Stripe)', () => {
    const keys = lookupKeysOf(priceTableSchema.parse(fictitiousPriceTable()));
    expect(keys.map((entry) => [entry.component, entry.variant, entry.lookupKey, entry.recurring])).toEqual([
      ['base', 'plataforma', 'vc_base_v1', true],
      ['additional_gb_day', 'plataforma', 'vc_add_v1', true],
      ['overage_gb_day', 'plataforma', 'vc_over_v1', true],
      ['gb_day', 'dedicado', 'vc_ded_v1', true],
      ['service', 'vciso', 'vc_vciso_v1', true],
      ['setup', 'vciso', 'vc_setup_v1', false],
    ]);
  });

  it('recusa regra de porte incoerente: porte repetido, fora de ordem ou sem teto maior que o anterior', () => {
    const repeated = tableWith((table) => {
      const first = table.sizing.sizes[0];
      if (first !== undefined) table.sizing.sizes[1] = { ...first, maxGbDay: 50, description: 'outro' };
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
      if (largest !== undefined) largest.maxGbDay = 10;
    });
    expect(problems(priceTableSchema.safeParse(smaller))).toEqual([
      'sizing.sizes.2.maxGbDay: um porte maior precisa de teto maior que o anterior',
    ]);
  });

  it('o máximo do site não fica abaixo do incluído, nem o máximo do Dedicado abaixo do mínimo', () => {
    const online = tableWith((table) => {
      table.plans.plataforma.maxOnlineGbDay = 1;
    });
    expect(problems(priceTableSchema.safeParse(online))).toEqual([
      'plans.plataforma.maxOnlineGbDay: menor que o incluído',
    ]);
    const dedicated = tableWith((table) => {
      table.plans.dedicado.maxGbDay = 2;
    });
    expect(problems(priceTableSchema.safeParse(dedicated))).toEqual([
      'plans.dedicado.maxGbDay: menor que o mínimo',
    ]);
  });

  it('o mesmo lookup_key em dois preços é recusado (cada preço da Stripe é de um componente só)', () => {
    const table = tableWith((value) => {
      value.plans.vciso.service.lookupKey = 'vc_ded_v1';
    });
    expect(problems(priceTableSchema.safeParse(table))).toEqual([
      'lookupKeys: lookup_key repetido: vc_ded_v1',
    ]);
  });

  it('estrito e com formatos: campo desconhecido, moeda, imposto, valor e lookup_key fora do formato', () => {
    const vciso = (service: unknown): Record<string, unknown> => {
      const table = fictitiousPriceTable();
      return { ...table, plans: { ...table.plans, vciso: { ...table.plans.vciso, service } } };
    };
    const cases: [Record<string, unknown>, string][] = [
      [{ ...fictitiousPriceTable(), desconto: 1 }, ''],
      [{ ...fictitiousPriceTable(), currency: 'usd' }, 'currency'],
      [{ ...fictitiousPriceTable(), taxMode: 'talvez' }, 'taxMode'],
      [vciso({ amount: 0, lookupKey: 'vc_x_v1' }), 'plans.vciso.service.amount'],
      [vciso({ amount: 1.5, lookupKey: 'vc_x_v1' }), 'plans.vciso.service.amount'],
      [vciso({ amount: 100, lookupKey: 'Com-Maiuscula' }), 'plans.vciso.service.lookupKey'],
    ];
    for (const [table, path] of cases) {
      const result = priceTableSchema.safeParse(table);
      expect(result.success, path).toBe(false);
      expect(result.error?.issues[0]?.path.map(String).join('.'), path).toBe(path);
    }
  });

  it('uma tabela do modelo de preço anterior (portes, componentes, contas) não passa: é legado', () => {
    const legacy = {
      currency: 'brl',
      interval: 'month',
      sizing: {
        sizes: [{ size: 'P', maxCloudAccounts: 5, maxMonthlyGib: 50, maxAgents: 10, description: 'P' }],
      },
      modes: { managed: { environment: {} }, self_hosted: { environment: {} } },
      cloudAccounts: { included: 1, max: 2, additional: { amount: 1, lookupKey: 'vc_a_v1' } },
    };
    expect(priceTableSchema.safeParse(legacy).success).toBe(false);
  });

  it('modelo de custos: alíquota padrão existente e única, alerta ≥ mínima, capacidade da célula positiva', () => {
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
    const infrastructure = model.infrastructure;
    expect(
      costModelSchema.safeParse({
        ...model,
        infrastructure: { ...infrastructure, sharedCell: { ...infrastructure.sharedCell, capacityGbDay: 0 } },
      }).success,
    ).toBe(false);
    expect(costModelSchema.safeParse({ ...model, refundReserveRate: 1.5 }).success).toBe(false);
    expect(costModelSchema.safeParse({ ...model, margem: 0.5 }).success).toBe(false);
  });

  it('a entrada da cotação é estrita: só o plano e o GB/dia, nenhum campo de preço nem o lugar', () => {
    const base = { plan: 'plataforma', gbDay: 3 };
    expect(quoteInputSchema.safeParse(base).success).toBe(true);
    for (const extra of [{ price: 1 }, { size: 'P' }, { monthlyTotal: 1 }, { mode: 'managed' }]) {
      expect(quoteInputSchema.safeParse({ ...base, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    for (const wrong of [{ plan: 'enterprise' }, { gbDay: 0 }, { gbDay: 2.5 }, { gbDay: 10_001 }]) {
      expect(quoteInputSchema.safeParse({ ...base, ...wrong }).success, JSON.stringify(wrong)).toBe(false);
    }
    expect(configurationInputSchema.safeParse({ ...base, mode: 'self_hosted' }).success).toBe(true);
    expect(configurationInputSchema.safeParse({ ...base, mode: 'hibrido' }).success).toBe(false);
  });

  it('o contratado de um cliente: o modelo por GB/dia ou, de antes dele, o anterior (só leitura)', () => {
    const legacy = {
      mode: 'managed',
      size: 'P',
      cloudAccounts: 2,
      monthlyGib: 10,
      agents: 0,
      historyDays: 30,
      support: 'standard',
    } as const;
    expect(isLegacyConfiguration(contractedConfigurationSchema.parse(legacy))).toBe(true);
    expect(isLegacyConfiguration(contractedConfigurationSchema.parse(demoConfiguration()))).toBe(false);
    expect(contractedConfigurationSchema.safeParse({ ...demoConfiguration(), agents: 0 }).success).toBe(
      false,
    );
  });
});
