import type { CostModel, PriceTable } from '@/lib/api-types';

/**
 * Tabela de preços e modelo de custos FICTÍCIOS, só para os testes e as capturas de tela do console: números redondos
 * e inventados (a base da Plataforma "custa" R$ 1.000 com 2 GB/dia, o câmbio é 2, a hora de suporte R$ 80). Nada aqui
 * tem relação com os preços, custos, tarifas, alíquotas ou margens de verdade, que vivem só no Firestore (o
 * repositório é público).
 */
export const FICTITIOUS_OWNER = 'responsavel@verax.example';

export function fictitiousPriceTable(): PriceTable {
  return {
    currency: 'brl',
    interval: 'month',
    taxMode: 'exclusive',
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
        additionalGbDay: { amount: 30_000, lookupKey: 'vc_adicional_v1' },
        overageGbDay: { amount: 30_000, lookupKey: 'vc_excedente_v1' },
        maxOnlineGbDay: 5,
        maxCloudAccounts: 50,
      },
      dedicado: {
        gbDay: { amount: 50_000, lookupKey: 'vc_gbdia_v1' },
        minGbDay: 3,
        maxGbDay: 15,
        contractMonths: 12,
        maxCloudAccounts: 100,
      },
      vciso: {
        service: { amount: 200_000, lookupKey: 'vc_servico_v1' },
        setup: { amount: 500_000, lookupKey: 'vc_implantacao_v1' },
      },
    },
    history: { includedDays: 30 },
    users: { max: 10 },
  };
}

/** Câmbio 2, folga de 10%, alíquotas de 10% e 20%, margem mínima de 25% e alerta em 35% (tudo fictício). */
export function fictitiousCostModel(): CostModel {
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
        vcisoService: 10,
        selfHosted: 1,
        setupPlataforma: 1,
        setupDedicado: 4,
        setupVciso: 10,
        setupSelfHosted: 8,
      },
    },
    fixedCosts: { items: [{ name: 'Custo fixo de teste', monthly: 100_000 }], allocationCustomers: 5 },
    margins: { minimum: 0.25, alert: 0.35 },
    customerCloudEstimateSpread: 0.5,
    sources: [{ item: 'Preço de teste', url: 'https://exemplo.invalid/precos', checkedOn: '2026-01-01' }],
  };
}
