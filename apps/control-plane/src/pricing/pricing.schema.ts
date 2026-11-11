import { z } from 'zod';
import { ULID_PATTERN } from '../common/ulid.js';

/**
 * Domínio do preço (modelo por volume, decisão do responsável de 10/11/2026): o preço depende só do volume de logs em
 * GB por dia (GB/dia), em três planos.
 *
 * - **Plataforma** (célula compartilhada, vendida no checkout do site): uma base mensal que inclui alguns GB/dia e um
 *   preço mensal por GB/dia contratado acima disso. O cliente escolhe a franquia no checkout, do incluído até o máximo
 *   do site; acima, "fale conosco". O uso acima da franquia é cobrado depois (o excedente, por GB/dia).
 * - **Dedicado** (servidor próprio, contrato anual, só por contrato direto): um preço por GB/dia, com um mínimo e um
 *   máximo cotável; o porte do nó sai do GB/dia pela regra de porte da tabela.
 * - **vCISO**: o Dedicado mais um serviço mensal e uma implantação cobrada uma vez; também só por contrato direto.
 *
 * Nenhum valor comercial mora no código: preços, chaves da Stripe, limites e o modelo de custos vêm de documentos
 * versionados no Firestore (`pricingTables/{versão}` e `costModels/{versão}`), editados pelo responsável. O código só
 * define a forma e as regras de coerência de cada documento. Um documento gravado no modelo anterior (portes,
 * componentes e contas de nuvem: até `2026-11-v1`) não passa nestes schemas e é tratado como legado (`pricing-store.ts`).
 */

/** Teto de sanidade para um valor em centavos (não é preço: só barra um número absurdo digitado por engano). */
export const MAX_AMOUNT_CENTS = 100_000_000;

/** Teto de sanidade do volume em GB/dia (não é limite comercial: só barra um número absurdo). */
export const MAX_GB_DAY = 10_000;

/** Os planos, na ordem em que o site os mostra. */
export const PLAN_IDS = ['plataforma', 'dedicado', 'vciso'] as const;
export const planIdSchema = z.enum(PLAN_IDS);
export type PlanId = z.infer<typeof planIdSchema>;

/** Onde o ambiente roda: na infraestrutura da Verax (`managed`) ou na do cliente (`self_hosted`, só contrato direto). */
export const DEPLOYMENT_MODES = ['managed', 'self_hosted'] as const;
export const deploymentModeSchema = z.enum(DEPLOYMENT_MODES);
export type DeploymentMode = z.infer<typeof deploymentModeSchema>;

/** Em que modos cada plano existe: a Plataforma é a célula da Verax, então nunca roda no cliente. */
export const PLAN_MODES: Readonly<Record<PlanId, readonly DeploymentMode[]>> = {
  plataforma: ['managed'],
  dedicado: ['managed', 'self_hosted'],
  vciso: ['managed', 'self_hosted'],
};

/** Portes do nó, do menor para o maior. O cliente nunca escolhe: a regra da tabela decide pelo GB/dia. */
export const SIZE_IDS = ['P', 'M', 'G'] as const;
export const sizeIdSchema = z.enum(SIZE_IDS);
export type SizeId = z.infer<typeof sizeIdSchema>;

/**
 * Componentes cobrados. É também o `component` dos metadados de cada preço na Stripe:
 * - `base`: a base mensal da Plataforma (com os GB/dia incluídos);
 * - `additional_gb_day`: cada GB/dia contratado acima do incluído na Plataforma (a quantidade do item);
 * - `overage_gb_day`: o excedente medido da Plataforma, por GB/dia (cobrado depois, fora do checkout);
 * - `gb_day`: cada GB/dia do Dedicado (e do vCISO, que usa o mesmo preço);
 * - `service`: o serviço mensal do vCISO;
 * - `setup`: a implantação do vCISO, cobrada uma vez.
 */
export const COMPONENT_IDS = [
  'base',
  'additional_gb_day',
  'overage_gb_day',
  'gb_day',
  'service',
  'setup',
] as const;
export type ComponentId = (typeof COMPONENT_IDS)[number];

export const PAYMENT_METHODS = ['card', 'boleto'] as const;
export const paymentMethodSchema = z.enum(PAYMENT_METHODS);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

/**
 * Como o imposto entra no preço: `inclusive` (o valor da tabela já tem o imposto) ou `exclusive` (o "+ impostos": o
 * imposto vai por cima na fatura, e o cliente paga o valor da tabela dividido por 1 menos a alíquota).
 */
export const TAX_MODES = ['inclusive', 'exclusive'] as const;
export type TaxMode = (typeof TAX_MODES)[number];

/** Versão de uma tabela (ex.: `2026-11-v2`): também é o id do documento. */
export const versionIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, { error: 'versão inválida (minúsculas, números e traço)' });

/** `lookup_key` de um preço da Stripe (ex.: `vc_plat_base_v2`). */
export const lookupKeySchema = z.string().regex(/^[a-z0-9_]{3,64}$/, { error: 'lookup_key inválido' });

const cents = z.number().int().min(0).max(MAX_AMOUNT_CENTS);
const positiveCents = z.number().int().min(1).max(MAX_AMOUNT_CENTS);
const publicText = z.string().trim().min(1).max(120);
const gbDay = z.number().int().min(1).max(MAX_GB_DAY);
/** O teto de contas de nuvem do nó (a vaga do PR-18): não muda o preço, só o limite gravado no nó. */
const maxCloudAccounts = z.number().int().min(1).max(1_000);
/** Taxa entre 0 e 1 (0,1 = 10%). */
const rate = z.number().min(0).max(1);

/** Um teto abaixo do piso correspondente (máximo menor que o incluído ou o mínimo, alerta menor que a mínima). */
function belowFloor(ceiling: number, floor: number): boolean {
  return ceiling < floor;
}

/** Um preço da tabela: o valor em centavos e o `lookup_key` do preço correspondente na Stripe. */
export const pricedSchema = z.strictObject({ amount: positiveCents, lookupKey: lookupKeySchema });
export type Priced = z.infer<typeof pricedSchema>;

/** Um degrau da regra de porte: o porte cabe no volume se ele não passar de `maxGbDay`. */
export const sizeRuleSchema = z.strictObject({
  size: sizeIdSchema,
  maxGbDay: gbDay,
  /** Texto para o cliente (ex.: "2 vCPU e 8 GB em São Paulo"). */
  description: publicText,
});
export type SizeRule = z.infer<typeof sizeRuleSchema>;

/**
 * O que o site pede (a entrada de `POST /v1/public/quote`): o plano e o volume em GB/dia, estrito e sem nenhum campo de
 * preço. O volume sobe até o mínimo do plano (`quote.ts`); acima do que o plano vende, a resposta é "fale conosco".
 */
export const quoteInputSchema = z.strictObject({ plan: planIdSchema, gbDay });
export type QuoteInput = z.infer<typeof quoteInputSchema>;

/**
 * A configuração com onde o ambiente roda: o que o motor cota (o site sempre na infraestrutura da Verax; o contrato
 * direto e o simulador de DRE escolhem).
 */
export const configurationInputSchema = z.strictObject({
  plan: planIdSchema,
  gbDay,
  mode: deploymentModeSchema,
});
export type ConfigurationInput = z.infer<typeof configurationInputSchema>;

/**
 * Conteúdo de uma tabela de preços (o que o responsável edita). Valores mensais em centavos de real; o imposto segue
 * `taxMode`. Cada valor é um preço da Stripe pelo `lookupKey`.
 */
export const priceTableSchema = z
  .strictObject({
    currency: z.literal('brl'),
    interval: z.literal('month'),
    taxMode: z.enum(TAX_MODES),
    /** O porte do nó pelo GB/dia, do menor para o maior. */
    sizing: z.strictObject({ sizes: z.array(sizeRuleSchema).min(1).max(SIZE_IDS.length) }),
    plans: z.strictObject({
      plataforma: z.strictObject({
        /** A base mensal (quantidade 1), com `includedGbDay` incluídos. */
        base: pricedSchema,
        includedGbDay: gbDay,
        /** Cada GB/dia contratado acima do incluído, por mês: a quantidade do item é o contratado menos o incluído. */
        additionalGbDay: pricedSchema,
        /** O excedente medido acima da franquia contratada, por GB/dia (cobrado depois, fora do checkout). */
        overageGbDay: pricedSchema,
        /** O maior volume contratável no site; acima, "fale conosco". */
        maxOnlineGbDay: gbDay,
        maxCloudAccounts,
      }),
      dedicado: z.strictObject({
        /** Cada GB/dia, por mês (a quantidade do item é o GB/dia contratado). */
        gbDay: pricedSchema,
        minGbDay: gbDay,
        maxGbDay: gbDay,
        /** A duração do contrato, em meses (informação da proposta). */
        contractMonths: z.number().int().min(1).max(60),
        maxCloudAccounts,
      }),
      /** O vCISO é o Dedicado (o mesmo preço por GB/dia, mínimo e máximo) mais o serviço e a implantação. */
      vciso: z.strictObject({ service: pricedSchema, setup: pricedSchema }),
    }),
    history: z.strictObject({ includedDays: z.number().int().min(30).max(3_650) }),
    users: z.strictObject({ max: z.number().int().min(1).max(1_000) }),
  })
  .superRefine((table, ctx) => {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: 'custom', path, message });
    };
    const sizes = table.sizing.sizes;
    const ids = sizes.map((rule) => rule.size);
    if (new Set(ids).size !== ids.length) issue(['sizing', 'sizes'], 'porte repetido');
    // Do menor para o maior: a ordem da lista é a ordem dos portes e o teto cresce de um degrau para o seguinte.
    const order = ids.map((id) => SIZE_IDS.indexOf(id));
    if (order.some((position, index) => index > 0 && position <= (order[index - 1] ?? -1))) {
      issue(['sizing', 'sizes'], 'portes fora de ordem (P, M, G)');
    }
    sizes.forEach((rule, index) => {
      const previous = sizes[index - 1];
      if (previous !== undefined && rule.maxGbDay <= previous.maxGbDay) {
        issue(['sizing', 'sizes', index, 'maxGbDay'], 'um porte maior precisa de teto maior que o anterior');
      }
    });
    const { plataforma, dedicado } = table.plans;
    if (belowFloor(plataforma.maxOnlineGbDay, plataforma.includedGbDay)) {
      issue(['plans', 'plataforma', 'maxOnlineGbDay'], 'menor que o incluído');
    }
    if (belowFloor(dedicado.maxGbDay, dedicado.minGbDay))
      issue(['plans', 'dedicado', 'maxGbDay'], 'menor que o mínimo');
    const keys = lookupKeysOf(table).map((entry) => entry.lookupKey);
    const repeated = keys.filter((key, index) => keys.indexOf(key) !== index);
    if (repeated.length > 0)
      issue(['lookupKeys'], `lookup_key repetido: ${[...new Set(repeated)].join(', ')}`);
  });
export type PriceTable = z.infer<typeof priceTableSchema>;
export type PriceTableInput = z.input<typeof priceTableSchema>;

/** Todos os preços da tabela, com o componente e a variante de cada um (os metadados do preço na Stripe). */
export interface TableLookupKey {
  component: ComponentId;
  /** O plano do preço. */
  variant: PlanId;
  lookupKey: string;
  amount: number;
  recurring: boolean;
}

export function lookupKeysOf(table: { plans: PriceTable['plans'] }): TableLookupKey[] {
  const { plataforma, dedicado, vciso } = table.plans;
  const entry = (
    component: ComponentId,
    variant: PlanId,
    price: Priced,
    recurring = true,
  ): TableLookupKey => ({
    component,
    variant,
    lookupKey: price.lookupKey,
    amount: price.amount,
    recurring,
  });
  return [
    entry('base', 'plataforma', plataforma.base),
    entry('additional_gb_day', 'plataforma', plataforma.additionalGbDay),
    entry('overage_gb_day', 'plataforma', plataforma.overageGbDay),
    entry('gb_day', 'dedicado', dedicado.gbDay),
    entry('service', 'vciso', vciso.service),
    entry('setup', 'vciso', vciso.setup, false),
  ];
}

/**
 * A configuração já normalizada para a tabela, com o porte calculado: é o que vai à reserva e ao cliente
 * (`tenants/{id}.configuration`). `gbDay` é a franquia contratada (a medição do excedente e o contador do painel
 * partem dela).
 */
export const configurationSchema = z.strictObject({
  plan: planIdSchema,
  mode: deploymentModeSchema,
  gbDay,
  size: sizeIdSchema,
  historyDays: z.number().int().min(1).max(36_500),
});
export type Configuration = z.infer<typeof configurationSchema>;

/**
 * A configuração de um cliente contratado no modelo anterior (portes, contas, volume mensal, agentes e suporte), só
 * para leitura: o cliente continua legível pelo `tick`, pela lista e pelo detalhe, e nunca é cotado de novo.
 */
export const legacyConfigurationSchema = z.strictObject({
  mode: deploymentModeSchema,
  size: sizeIdSchema,
  cloudAccounts: z.number().int().min(1).max(10_000),
  monthlyGib: z.number().int().min(1).max(1_000_000),
  agents: z.number().int().min(0).max(100_000),
  historyDays: z.number().int().min(1).max(36_500),
  support: z.enum(['standard', 'priority']),
});
export type LegacyConfiguration = z.infer<typeof legacyConfigurationSchema>;

/** O que um cliente contratou: no modelo por GB/dia ou, de antes dele, no anterior. */
export const contractedConfigurationSchema = z.union([configurationSchema, legacyConfigurationSchema]);
export type ContractedConfiguration = z.infer<typeof contractedConfigurationSchema>;

export function isLegacyConfiguration(
  configuration: ContractedConfiguration,
): configuration is LegacyConfiguration {
  return !('plan' in configuration);
}

/**
 * Limites do nó para uma configuração: o que o PR-18 aplica (contas, volume, histórico, usuários) mais os agentes (0:
 * não são vendidos). `node-limits.ts` traduz para as variáveis `PLAN_*` do nó.
 */
export const nodeLimitsSchema = z.strictObject({
  maxCloudAccounts: z.number().int().min(1).max(10_000),
  monthlyGib: z.number().int().min(1).max(1_000_000),
  historyDays: z.number().int().min(1).max(36_500),
  maxAgents: z.number().int().min(0).max(100_000),
  maxUsers: z.number().int().min(1).max(1_000),
});
export type NodeLimits = z.infer<typeof nodeLimitsSchema>;

/** Uma linha da cotação: o preço da Stripe (pelo `lookup_key`), a quantidade e o valor unitário da tabela. */
export const quoteLineItemSchema = z.strictObject({
  component: z.enum(COMPONENT_IDS),
  variant: planIdSchema,
  lookupKey: lookupKeySchema,
  quantity: z.number().int().min(1).max(MAX_GB_DAY),
  unitAmount: positiveCents,
  amount: cents,
  /** `false` só na implantação, cobrada uma vez na primeira fatura. */
  recurring: z.boolean(),
});
export type QuoteLineItem = z.infer<typeof quoteLineItemSchema>;

/** Preço gravado na reserva e no cliente: de qual tabela e cotação ele saiu e quanto foi cotado. */
export const orderPricingSchema = z.strictObject({
  priceTableVersion: versionIdSchema,
  quoteId: z.string().regex(ULID_PATTERN),
  monthlyTotal: cents,
  setupTotal: cents,
});
export type OrderPricing = z.infer<typeof orderPricingSchema>;

/**
 * Modelo de custos (confidencial: só no Firestore e no console do responsável, nunca no site nem no repositório).
 * Custos de nuvem em dólares por mês; tarifas e custos fixos em centavos de real; taxas entre 0 e 1.
 */
const usd = z.number().min(0).max(1_000_000);
const hours = z.number().min(0).max(1_000);

/** Uma máquina: a VM (US$/mês), o disco (GB) e os snapshots estimados (GiB). */
const machineSchema = z.strictObject({
  vmUsdPerMonth: usd,
  diskGb: z.number().min(0).max(100_000),
  snapshotGib: z.number().min(0).max(100_000),
});
export type Machine = z.infer<typeof machineSchema>;

export const costModelSchema = z
  .strictObject({
    currency: z.literal('brl'),
    exchange: z.strictObject({
      /** Reais por dólar, o câmbio de planejamento. */
      brlPerUsd: z.number().positive().max(1_000),
      /** Data da cotação (AAAA-MM-DD), para o console mostrar a idade do número. */
      quotedOn: z.iso.date(),
      /** Folga sobre a nuvem (impostos, IOF, câmbio). */
      cloudBuffer: rate,
    }),
    infrastructure: z.strictObject({
      /**
       * A célula compartilhada da Plataforma: uma máquina com vários clientes e a capacidade dela em GB/dia. O custo
       * dela é rateado por GB/dia contratado (custo ÷ capacidade), mais o custo fixo de cada cliente nela.
       */
      sharedCell: z.strictObject({
        ...machineSchema.shape,
        capacityGbDay: gbDay,
        /** O que cada cliente custa na célula independentemente do volume (US$/mês). */
        perCustomerUsdPerMonth: usd,
      }),
      /** O nó dedicado de cada porte (Dedicado e vCISO na infraestrutura da Verax). */
      sizes: z.partialRecord(sizeIdSchema, machineSchema),
      diskUsdPerGibMonth: usd,
      snapshotUsdPerGibMonth: usd,
      natUsdPerVmMonth: usd,
      natIpUsdPerMonth: usd,
      otherUsdPerNodeMonth: usd,
      /** O custo da ingestão por GB/dia, por mês (publicação, entrega e retenção no tópico). */
      ingestionUsdPerGbDay: usd,
    }),
    paymentFees: z.strictObject({
      card: z.strictObject({ rate, fixed: cents }),
      boleto: z.strictObject({ fixed: cents }),
      /** Tarifa da cobrança recorrente, sobre o valor faturado em assinatura. */
      billingRate: rate,
    }),
    taxes: z.strictObject({
      /** Alíquotas (ex.: as dos anexos do Simples e a efetiva do mês). */
      rates: z
        .array(z.strictObject({ id: z.string().regex(/^[a-z0-9_]{1,32}$/), label: publicText, rate }))
        .min(1)
        .max(10),
      /** A alíquota da checagem de publicação e do simulador, quando ele não pede outra. */
      defaultRateId: z.string().regex(/^[a-z0-9_]{1,32}$/),
    }),
    /** Reserva para reembolso e contestação, sobre a receita bruta. */
    refundReserveRate: rate,
    support: z.strictObject({
      hourlyCost: cents,
      hours: z.strictObject({
        /** Horas por mês de cada cliente, pelo plano (o vCISO tem as do Dedicado mais as do serviço). */
        plataforma: hours,
        dedicado: hours,
        /** O serviço do vCISO em horas equivalentes por mês. */
        vcisoService: hours,
        /** A mais, por mês, com o ambiente na infraestrutura do cliente. */
        selfHosted: hours,
        /** A implantação, uma vez: por plano e a mais na infraestrutura do cliente. */
        setupPlataforma: hours,
        setupDedicado: hours,
        setupVciso: hours,
        setupSelfHosted: hours,
      }),
    }),
    fixedCosts: z.strictObject({
      items: z.array(z.strictObject({ name: publicText, monthly: cents })).max(50),
      /** Clientes para o rateio dos custos fixos. */
      allocationCustomers: z.number().int().min(1).max(100_000),
    }),
    /** Margem de contribuição sobre a receita bruta: abaixo da mínima a publicação é recusada; da de alerta, avisa. */
    margins: z.strictObject({ minimum: rate, alert: rate }),
    /** Faixa da estimativa da nuvem do cliente (0,5 = ±50%), só informativa. */
    customerCloudEstimateSpread: rate,
    /** De onde veio cada número (link e data), para o console. */
    sources: z
      .array(
        z.strictObject({
          item: publicText,
          url: z.url({ protocol: /^https$/ }).max(500),
          checkedOn: z.iso.date(),
        }),
      )
      .max(50)
      .default([]),
  })
  .superRefine((model, ctx) => {
    if (!model.taxes.rates.some((tax) => tax.id === model.taxes.defaultRateId)) {
      ctx.addIssue({ code: 'custom', path: ['taxes', 'defaultRateId'], message: 'alíquota inexistente' });
    }
    const ids = model.taxes.rates.map((tax) => tax.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', path: ['taxes', 'rates'], message: 'alíquota repetida' });
    }
    if (belowFloor(model.margins.alert, model.margins.minimum)) {
      ctx.addIssue({ code: 'custom', path: ['margins', 'alert'], message: 'menor que a mínima' });
    }
  });
export type CostModel = z.infer<typeof costModelSchema>;
export type CostModelInput = z.input<typeof costModelSchema>;
