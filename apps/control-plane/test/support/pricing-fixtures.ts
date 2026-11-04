import type {
  Configuration,
  CostModelInput,
  NodeLimits,
  OrderPricing,
  PriceTableInput,
} from '../../src/pricing/pricing.schema.js';

/**
 * Tabela de preços e modelo de custos FICTÍCIOS, só para os testes: números redondos e inventados (o ambiente "custa"
 * R$ 1.000, o câmbio é 2, a hora de suporte R$ 80), sem relação nenhuma com os preços, custos, tarifas, alíquotas ou
 * margens de verdade, que vivem só no Firestore do plano de controle (o repositório é público). Até as faixas, os
 * portes e os incluídos são outros. Os `lookup_key` são curtos e inventados (`vc_env_p_v1`, `vc_acc_v1`...).
 */
export function fictitiousPriceTable(): PriceTableInput {
  return {
    currency: 'brl',
    interval: 'month',
    sizing: {
      sizes: [
        { size: 'P', maxCloudAccounts: 5, maxMonthlyGib: 50, maxAgents: 10, description: 'Porte de teste P' },
        {
          size: 'M',
          maxCloudAccounts: 10,
          maxMonthlyGib: 100,
          maxAgents: 20,
          description: 'Porte de teste M',
        },
        {
          size: 'G',
          maxCloudAccounts: 20,
          maxMonthlyGib: 200,
          maxAgents: 40,
          description: 'Porte de teste G',
        },
      ],
    },
    modes: {
      managed: {
        environment: {
          P: { amount: 100_000, lookupKey: 'vc_env_p_v1' },
          M: { amount: 200_000, lookupKey: 'vc_env_m_v1' },
          G: { amount: 400_000, lookupKey: 'vc_env_g_v1' },
        },
      },
      self_hosted: {
        environment: {
          P: { amount: 50_000, lookupKey: 'vc_lic_p_v1' },
          M: { amount: 100_000, lookupKey: 'vc_lic_m_v1' },
          G: { amount: 200_000, lookupKey: 'vc_lic_g_v1' },
        },
        setup: { amount: 100_000, lookupKey: 'vc_set_v1' },
      },
    },
    cloudAccounts: { included: 2, max: 20, additional: { amount: 3_000, lookupKey: 'vc_acc_v1' } },
    volume: {
      includedMonthlyGib: 10,
      bands: [
        { monthlyGib: 50, amount: 10_000, lookupKey: 'vc_vol_50_v1' },
        { monthlyGib: 100, amount: 20_000, lookupKey: 'vc_vol_100_v1' },
        { monthlyGib: 200, amount: 40_000, lookupKey: 'vc_vol_200_v1' },
      ],
    },
    agents: { packSize: 10, maxPacks: 4, pack: { amount: 10_000, lookupKey: 'vc_agt_v1' } },
    history: {
      includedDays: 30,
      extended: [
        { days: 180, amount: 2_000, lookupKey: 'vc_his_180_v1' },
        { days: 360, amount: 4_000, lookupKey: 'vc_his_360_v1' },
      ],
    },
    prioritySupport: { amount: 30_000, lookupKey: 'vc_sup_v1' },
    users: { max: 10 },
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
      {
        id: 'nuvem-propria',
        label: 'Na sua nuvem (teste)',
        configuration: {
          mode: 'self_hosted',
          cloudAccounts: 2,
          monthlyGib: 10,
          agents: 0,
          historyDays: 30,
          support: 'standard',
        },
      },
    ],
  };
}

/** Modelo de custos fictício (câmbio 2, folga de 10%, alíquotas de 10% e 20%, margem mínima de 25% e alerta em 35%). */
export function fictitiousCostModel(): CostModelInput {
  return {
    currency: 'brl',
    exchange: { brlPerUsd: 2, quotedOn: '2026-01-01', cloudBuffer: 0.1 },
    infrastructure: {
      sizes: {
        P: { vmUsdPerMonth: 100, diskGb: 10, snapshotGib: 10 },
        M: { vmUsdPerMonth: 200, diskGb: 20, snapshotGib: 20 },
        G: { vmUsdPerMonth: 400, diskGb: 40, snapshotGib: 40 },
      },
      diskUsdPerGibMonth: 0.1,
      snapshotUsdPerGibMonth: 0.05,
      natUsdPerVmMonth: 1,
      natIpUsdPerMonth: 2,
      otherUsdPerNodeMonth: 1,
      ingestionUsdPerGib: 0.1,
      agents: { entryUsdPerMonth: 2, diskBaseGb: 10, diskPerAgentGb: 2 },
    },
    paymentFees: { card: { rate: 0.05, fixed: 50 }, boleto: { fixed: 300 }, billingRate: 0.01 },
    taxes: {
      rates: [
        { id: 'teste_a', label: 'Alíquota de teste A', rate: 0.1 },
        { id: 'teste_b', label: 'Alíquota de teste B', rate: 0.2 },
      ],
      defaultRateId: 'teste_a',
    },
    refundReserveRate: 0.03,
    support: {
      hourlyCost: 8_000,
      hours: {
        baseManaged: 1.5,
        baseSelfHosted: 2.5,
        perAdditionalAccount: 0.15,
        perAgentPack: 0.5,
        prioritySupport: 2.5,
        perVolumeBand: [
          { monthlyGib: 50, hours: 0.5 },
          { monthlyGib: 100, hours: 1 },
          { monthlyGib: 200, hours: 2 },
        ],
        setupManaged: 1.5,
        setupPriorityExtra: 0.5,
        setupSelfHosted: 10,
      },
    },
    fixedCosts: { items: [{ name: 'Custo fixo de teste', monthly: 100_000 }], allocationCustomers: 5 },
    margins: { minimum: 0.25, alert: 0.35 },
    customerCloudEstimateSpread: 0.5,
    sources: [],
  };
}

/** A configuração mínima gerenciada da tabela fictícia, já normalizada (porte P). */
export function demoConfiguration(): Configuration {
  return {
    mode: 'managed',
    size: 'P',
    cloudAccounts: 2,
    monthlyGib: 10,
    agents: 0,
    historyDays: 30,
    support: 'standard',
  };
}

export function demoLimits(): NodeLimits {
  return { maxCloudAccounts: 2, monthlyGib: 10, historyDays: 30, maxAgents: 0, maxUsers: 10 };
}

/** O preço gravado no pedido, para os testes que não passam pela cotação (o id é um ULID fixo e fictício). */
export function demoOrderPricing(): OrderPricing {
  return {
    priceTableVersion: 'teste-v1',
    quoteId: '01JBTESTE0000000000000000Q',
    monthlyTotal: 100_000,
    setupTotal: 0,
  };
}
