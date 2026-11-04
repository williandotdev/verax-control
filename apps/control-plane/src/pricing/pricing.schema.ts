import { z } from 'zod';
import { ULID_PATTERN } from '../common/ulid.js';

/**
 * Domínio do preço configurável (estudo comercial da fase 3, aprovado em 04/11/2026): o cliente responde seis
 * perguntas (onde roda, contas de nuvem, volume de logs, agentes, histórico e suporte), o porte do nó sai de uma regra
 * determinística e o preço é a soma dos componentes da tabela publicada.
 *
 * Nenhum valor comercial mora no código: preços, chaves da Stripe, faixas, limites de porte e o modelo de custos vêm
 * de documentos versionados no Firestore (`pricingTables/{versão}` e `costModels/{versão}`), editados pelo
 * responsável. O código só define a forma e as regras de coerência de cada documento.
 */

/** Teto de sanidade para um valor em centavos (não é preço: só barra um número absurdo digitado por engano). */
export const MAX_AMOUNT_CENTS = 100_000_000;

/** Onde o ambiente roda: na infraestrutura da Verax ou na nuvem do cliente. */
export const DEPLOYMENT_MODES = ['managed', 'self_hosted'] as const;
export const deploymentModeSchema = z.enum(DEPLOYMENT_MODES);
export type DeploymentMode = z.infer<typeof deploymentModeSchema>;

/** Portes do nó, do menor para o maior. O cliente nunca escolhe: a regra da tabela decide (`sizing.ts`). */
export const SIZE_IDS = ['P', 'M', 'G'] as const;
export const sizeIdSchema = z.enum(SIZE_IDS);
export type SizeId = z.infer<typeof sizeIdSchema>;

export const SUPPORT_LEVELS = ['standard', 'priority'] as const;
export const supportLevelSchema = z.enum(SUPPORT_LEVELS);
export type SupportLevel = z.infer<typeof supportLevelSchema>;

/** Componentes cobrados. É também o `component` dos metadados de cada preço na Stripe. */
export const COMPONENT_IDS = [
  'environment',
  'cloud_accounts',
  'volume',
  'agents',
  'history',
  'priority_support',
  'setup',
] as const;
export type ComponentId = (typeof COMPONENT_IDS)[number];

export const PAYMENT_METHODS = ['card', 'boleto'] as const;
export const paymentMethodSchema = z.enum(PAYMENT_METHODS);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

/** Versão de uma tabela (ex.: `2026-11-v1`): também é o id do documento. */
export const versionIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, { error: 'versão inválida (minúsculas, números e traço)' });

/** `lookup_key` de um preço da Stripe (ex.: `vc_env_p_v1`). */
export const lookupKeySchema = z.string().regex(/^[a-z0-9_]{3,64}$/, { error: 'lookup_key inválido' });

const cents = z.number().int().min(0).max(MAX_AMOUNT_CENTS);
const positiveCents = z.number().int().min(1).max(MAX_AMOUNT_CENTS);
const publicText = z.string().trim().min(1).max(120);
/** Taxa entre 0 e 1 (0,06 = 6%). */
const rate = z.number().min(0).max(1);

/** Um preço da tabela: o valor em centavos e o `lookup_key` do preço correspondente na Stripe. */
export const pricedSchema = z.strictObject({ amount: positiveCents, lookupKey: lookupKeySchema });
export type Priced = z.infer<typeof pricedSchema>;

/** Um degrau da regra de porte: o porte cabe na configuração se ela não passar de nenhum dos três tetos. */
export const sizeRuleSchema = z.strictObject({
  size: sizeIdSchema,
  maxCloudAccounts: z.number().int().min(1).max(10_000),
  maxMonthlyGib: z.number().int().min(1).max(1_000_000),
  maxAgents: z.number().int().min(0).max(100_000),
  /** Texto para o cliente (ex.: "2 vCPU e 8 GB em São Paulo"). */
  description: publicText,
});
export type SizeRule = z.infer<typeof sizeRuleSchema>;

const modePricingSchema = z.strictObject({
  /** Ambiente (gerenciado) ou licença (na nuvem do cliente), um preço por porte. */
  environment: z.partialRecord(sizeIdSchema, pricedSchema),
  /** Implantação, cobrada uma vez na primeira fatura. Sem ela, o modo não tem taxa de implantação. */
  setup: pricedSchema.optional(),
});
export type ModePricing = z.infer<typeof modePricingSchema>;

/**
 * O que o cliente escolhe (a entrada de `POST /v1/public/quote`): estrito e sem nenhum campo de preço. Os números são
 * arredondados para cima até a opção da tabela (`quote.ts`); acima do que a tabela vende, a resposta é "fale conosco".
 */
export const configurationInputSchema = z.strictObject({
  mode: deploymentModeSchema,
  cloudAccounts: z.number().int().min(0).max(10_000),
  monthlyGib: z.number().int().min(0).max(1_000_000),
  agents: z.number().int().min(0).max(100_000),
  historyDays: z.number().int().min(0).max(36_500),
  support: supportLevelSchema,
});
export type ConfigurationInput = z.infer<typeof configurationInputSchema>;

const presetSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  label: publicText,
  configuration: configurationInputSchema,
});

/**
 * Conteúdo de uma tabela de preços (o que o responsável edita). Valores mensais em centavos de real, com o imposto
 * embutido. Cada degrau de volume e de histórico acima do incluído é um preço da Stripe.
 */
export const priceTableSchema = z
  .strictObject({
    currency: z.literal('brl'),
    interval: z.literal('month'),
    sizing: z.strictObject({ sizes: z.array(sizeRuleSchema).min(1).max(SIZE_IDS.length) }),
    modes: z.strictObject({ managed: modePricingSchema, self_hosted: modePricingSchema }),
    cloudAccounts: z.strictObject({
      included: z.number().int().min(1).max(10_000),
      max: z.number().int().min(1).max(10_000),
      additional: pricedSchema,
    }),
    volume: z.strictObject({
      includedMonthlyGib: z.number().int().min(1).max(1_000_000),
      bands: z
        .array(
          z.strictObject({
            monthlyGib: z.number().int().min(1).max(1_000_000),
            amount: positiveCents,
            lookupKey: lookupKeySchema,
          }),
        )
        .max(20),
    }),
    agents: z.strictObject({
      packSize: z.number().int().min(1).max(10_000),
      maxPacks: z.number().int().min(0).max(1_000),
      pack: pricedSchema,
    }),
    history: z.strictObject({
      includedDays: z.number().int().min(30).max(3_650),
      extended: z
        .array(
          z.strictObject({
            days: z.number().int().min(30).max(3_650),
            amount: positiveCents,
            lookupKey: lookupKeySchema,
          }),
        )
        .max(10),
    }),
    prioritySupport: pricedSchema,
    users: z.strictObject({ max: z.number().int().min(1).max(1_000) }),
    presets: z.array(presetSchema).max(10).default([]),
  })
  .superRefine((table, ctx) => {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: 'custom', path, message });
    };
    const sizes = table.sizing.sizes;
    const ids = sizes.map((rule) => rule.size);
    if (new Set(ids).size !== ids.length) issue(['sizing', 'sizes'], 'porte repetido');
    // Do menor para o maior: a ordem da lista é a ordem dos portes e nenhum teto diminui de um degrau para o seguinte.
    const order = ids.map((id) => SIZE_IDS.indexOf(id));
    if (order.some((position, index) => index > 0 && position <= (order[index - 1] ?? -1))) {
      issue(['sizing', 'sizes'], 'portes fora de ordem (P, M, G)');
    }
    sizes.forEach((rule, index) => {
      const previous = sizes[index - 1];
      if (previous === undefined) return;
      if (
        rule.maxCloudAccounts < previous.maxCloudAccounts ||
        rule.maxMonthlyGib < previous.maxMonthlyGib ||
        rule.maxAgents < previous.maxAgents
      ) {
        issue(['sizing', 'sizes', index], 'um porte maior não pode ter teto menor que o anterior');
      }
    });
    for (const mode of DEPLOYMENT_MODES) {
      for (const size of ids) {
        if (table.modes[mode].environment[size] === undefined) {
          issue(['modes', mode, 'environment', size], 'sem preço para este porte');
        }
      }
      for (const size of Object.keys(table.modes[mode].environment)) {
        if (!ids.includes(size as SizeId)) {
          issue(['modes', mode, 'environment', size], 'porte fora da regra de porte');
        }
      }
    }
    if (table.cloudAccounts.max < table.cloudAccounts.included) {
      issue(['cloudAccounts', 'max'], 'menor que o incluído');
    }
    const bands = table.volume.bands.map((band) => band.monthlyGib);
    if (
      bands.some(
        (gib, index) => gib <= (index === 0 ? table.volume.includedMonthlyGib : (bands[index - 1] ?? 0)),
      )
    ) {
      issue(['volume', 'bands'], 'faixas em ordem crescente e acima do incluído');
    }
    const days = table.history.extended.map((option) => option.days);
    if (
      days.some((day, index) => day <= (index === 0 ? table.history.includedDays : (days[index - 1] ?? 0)))
    ) {
      issue(['history', 'extended'], 'opções em ordem crescente e acima do incluído');
    }
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
  variant: string;
  lookupKey: string;
  amount: number;
  recurring: boolean;
}

export function lookupKeysOf(table: {
  modes: Record<DeploymentMode, ModePricing>;
  cloudAccounts: { additional: Priced };
  volume: { bands: readonly { monthlyGib: number; amount: number; lookupKey: string }[] };
  agents: { packSize: number; pack: Priced };
  history: { extended: readonly { days: number; amount: number; lookupKey: string }[] };
  prioritySupport: Priced;
}): TableLookupKey[] {
  const entries: TableLookupKey[] = [];
  for (const mode of DEPLOYMENT_MODES) {
    for (const size of SIZE_IDS) {
      const price = table.modes[mode].environment[size];
      if (price !== undefined) {
        entries.push({ component: 'environment', variant: `${mode}_${size}`, ...price, recurring: true });
      }
    }
    const setup = table.modes[mode].setup;
    if (setup !== undefined) entries.push({ component: 'setup', variant: mode, ...setup, recurring: false });
  }
  entries.push({
    component: 'cloud_accounts',
    variant: 'additional',
    ...table.cloudAccounts.additional,
    recurring: true,
  });
  for (const band of table.volume.bands) {
    entries.push({
      component: 'volume',
      variant: String(band.monthlyGib),
      amount: band.amount,
      lookupKey: band.lookupKey,
      recurring: true,
    });
  }
  entries.push({
    component: 'agents',
    variant: String(table.agents.packSize),
    ...table.agents.pack,
    recurring: true,
  });
  for (const option of table.history.extended) {
    entries.push({
      component: 'history',
      variant: String(option.days),
      amount: option.amount,
      lookupKey: option.lookupKey,
      recurring: true,
    });
  }
  entries.push({
    component: 'priority_support',
    variant: 'priority',
    ...table.prioritySupport,
    recurring: true,
  });
  return entries;
}

/** A configuração já normalizada para a tabela, com o porte calculado: é o que vai à reserva e ao cliente. */
export const configurationSchema = z.strictObject({
  mode: deploymentModeSchema,
  size: sizeIdSchema,
  cloudAccounts: z.number().int().min(1).max(10_000),
  monthlyGib: z.number().int().min(1).max(1_000_000),
  agents: z.number().int().min(0).max(100_000),
  historyDays: z.number().int().min(1).max(36_500),
  support: supportLevelSchema,
});
export type Configuration = z.infer<typeof configurationSchema>;

/**
 * Limites do nó para uma configuração: o que o PR-18 aplica (contas, volume, histórico, usuários) mais os agentes.
 * `node-limits.ts` traduz para as variáveis `PLAN_*` do nó.
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
  variant: z.string().min(1).max(40),
  lookupKey: lookupKeySchema,
  quantity: z.number().int().min(1).max(10_000),
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
      /** Custo de cada porte gerenciado: a VM (US$/mês), o disco (GB) e os snapshots estimados (GiB). */
      sizes: z.partialRecord(
        sizeIdSchema,
        z.strictObject({
          vmUsdPerMonth: usd,
          diskGb: z.number().min(0).max(100_000),
          snapshotGib: z.number().min(0).max(100_000),
        }),
      ),
      diskUsdPerGibMonth: usd,
      snapshotUsdPerGibMonth: usd,
      natUsdPerVmMonth: usd,
      natIpUsdPerMonth: usd,
      otherUsdPerNodeMonth: usd,
      /** Custo da ingestão por GiB de franquia (publicação, entrega e retenção no tópico). */
      ingestionUsdPerGib: usd,
      agents: z.strictObject({
        staticIpUsdPerMonth: usd,
        /** Disco a mais com agentes: a base de vulnerabilidades mais o índice por agente. */
        diskBaseGb: z.number().min(0).max(100_000),
        diskPerAgentGb: z.number().min(0).max(1_000),
      }),
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
        baseManaged: hours,
        baseSelfHosted: hours,
        perAdditionalAccount: hours,
        perAgentPack: hours,
        prioritySupport: hours,
        /** Horas a mais por faixa de volume vendida (a franquia incluída não tem). */
        perVolumeBand: z.array(z.strictObject({ monthlyGib: z.number().int().min(1), hours })).max(20),
        setupManaged: hours,
        setupPriorityExtra: hours,
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
    /** Faixa da estimativa da nuvem do cliente (0,25 = ±25%), só informativa. */
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
    if (model.margins.alert < model.margins.minimum) {
      ctx.addIssue({ code: 'custom', path: ['margins', 'alert'], message: 'menor que a mínima' });
    }
    const bands = model.support.hours.perVolumeBand.map((band) => band.monthlyGib);
    if (new Set(bands).size !== bands.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['support', 'hours', 'perVolumeBand'],
        message: 'faixa repetida',
      });
    }
  });
export type CostModel = z.infer<typeof costModelSchema>;
export type CostModelInput = z.input<typeof costModelSchema>;
