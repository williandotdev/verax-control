import type {
  Configuration,
  CostModelInput,
  NodeLimits,
  OrderPricing,
  PriceTableInput,
} from '../../src/pricing/pricing.schema.js';

/**
 * Tabela de preços e modelo de custos FICTÍCIOS, só para os testes: números redondos e inventados (a base da
 * Plataforma "custa" R$ 1.000 com 2 GB/dia incluídos, o GB/dia adicional R$ 300, o Dedicado R$ 500 por GB/dia; o câmbio
 * é 2, a hora de suporte R$ 80), sem relação nenhuma com os preços, custos, tarifas, alíquotas ou margens de verdade,
 * que vivem só no Firestore do plano de controle (o repositório é público). Até os incluídos, mínimos, máximos e portes
 * são outros. Os `lookup_key` são curtos e inventados (`vc_base_v1`, `vc_add_v1`...).
 */
export function fictitiousPriceTable(): PriceTableInput {
  return {
    currency: 'brl',
    interval: 'month',
    taxMode: 'inclusive',
    sizing: {
      sizes: [
        { size: 'P', maxGbDay: 5, description: 'Porte de teste P' },
        { size: 'M', maxGbDay: 10, description: 'Porte de teste M' },
        { size: 'G', maxGbDay: 20, description: 'Porte de teste G' },
      ],
    },
    plans: {
      plataforma: {
        base: { amount: 100_000, lookupKey: 'vc_base_v1' },
        includedGbDay: 2,
        additionalGbDay: { amount: 30_000, lookupKey: 'vc_add_v1' },
        overageGbDay: { amount: 30_000, lookupKey: 'vc_over_v1' },
        maxOnlineGbDay: 5,
        maxCloudAccounts: 50,
      },
      dedicado: {
        gbDay: { amount: 50_000, lookupKey: 'vc_ded_v1' },
        minGbDay: 3,
        maxGbDay: 15,
        contractMonths: 12,
        maxCloudAccounts: 100,
      },
      vciso: {
        service: { amount: 200_000, lookupKey: 'vc_vciso_v1' },
        setup: { amount: 500_000, lookupKey: 'vc_setup_v1' },
      },
    },
    history: { includedDays: 60 },
    users: { max: 10 },
  };
}

/** Modelo de custos fictício (câmbio 2, folga de 10%, alíquotas de 10% e 20%, margem mínima de 25% e alerta em 35%). */
export function fictitiousCostModel(): CostModelInput {
  return {
    currency: 'brl',
    exchange: { brlPerUsd: 2, quotedOn: '2026-01-01', cloudBuffer: 0.1 },
    infrastructure: {
      sharedCell: {
        vmUsdPerMonth: 100,
        diskGb: 10,
        snapshotGib: 10,
        capacityGbDay: 10,
        perCustomerUsdPerMonth: 1,
      },
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
      ingestionUsdPerGbDay: 2,
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
        plataforma: 1,
        dedicado: 2,
        vcisoService: 5,
        selfHosted: 1,
        setupPlataforma: 0.5,
        setupDedicado: 4,
        setupVciso: 10,
        setupSelfHosted: 8,
      },
    },
    fixedCosts: { items: [{ name: 'Custo fixo de teste', monthly: 100_000 }], allocationCustomers: 5 },
    margins: { minimum: 0.25, alert: 0.35 },
    customerCloudEstimateSpread: 0.5,
    sources: [],
  };
}

/** A configuração mínima da Plataforma na tabela fictícia, já normalizada (2 GB/dia, porte P). */
export function demoConfiguration(): Configuration {
  return { plan: 'plataforma', mode: 'managed', gbDay: 2, size: 'P', historyDays: 60 };
}

/** Os limites do nó da configuração mínima (2 GB/dia viram 58 GiB por mês: 2 × 31 × 10⁹ / 2³⁰, para cima). */
export function demoLimits(): NodeLimits {
  return { maxCloudAccounts: 50, monthlyGib: 58, historyDays: 60, maxAgents: 0, maxUsers: 10 };
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
