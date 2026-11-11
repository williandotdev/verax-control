import { monthlyGibFor } from './node-limits.js';
import {
  type Configuration,
  type ConfigurationInput,
  type NodeLimits,
  PLAN_MODES,
  type PlanId,
  type PriceTable,
  type QuoteLineItem,
  type SizeRule,
} from './pricing.schema.js';

/**
 * Por que uma configuração não tem preço na hora: o volume passa do que o plano vende (no site, o máximo online da
 * Plataforma; no Dedicado e no vCISO, o máximo cotável), nenhum porte comporta o volume, ou o plano não existe no modo
 * pedido (a Plataforma é a célula da Verax: nunca no cliente). O site leva ao contato com o volume preenchido.
 */
export const CONTACT_REASONS = [
  'above_online_max',
  'above_max',
  'above_largest_size',
  'mode_unavailable',
] as const;
export type ContactReason = (typeof CONTACT_REASONS)[number];

export interface Quote {
  /** A configuração normalizada para a tabela (o volume levado ao mínimo do plano), com o porte. */
  configuration: Configuration;
  /** Texto do porte para o cliente, da regra de porte da tabela. */
  sizeDescription: string;
  /** Na ordem do Checkout: os itens mensais e, por último, a implantação (se o plano tiver). */
  lineItems: QuoteLineItem[];
  monthlyTotal: number;
  setupTotal: number;
  firstInvoiceTotal: number;
  /** Os limites do nó para esta configuração (PR-18; `node-limits.ts`). */
  limits: NodeLimits;
  /** O que já vem no plano sem custo a mais (na Plataforma, os GB/dia da base; nos outros, 0). */
  included: { gbDay: number; historyDays: number; users: number };
}

export type QuoteOutcome = { kind: 'quote'; quote: Quote } | { kind: 'contact_us'; reason: ContactReason };

/** O menor porte que comporta o volume, na ordem da tabela; nenhum, `undefined` ("sob consulta"). */
export function sizeFor(gbDay: number, sizes: readonly SizeRule[]): SizeRule | undefined {
  return sizes.find((rule) => gbDay <= rule.maxGbDay);
}

/** O menor e o maior GB/dia que cada plano cota (a Plataforma, do incluído até o máximo do site). */
export function gbDayRange(table: PriceTable, plan: PlanId): { min: number; max: number } {
  const { plataforma, dedicado } = table.plans;
  return plan === 'plataforma'
    ? { min: plataforma.includedGbDay, max: plataforma.maxOnlineGbDay }
    : { min: dedicado.minGbDay, max: dedicado.maxGbDay };
}

function lineItem(item: Omit<QuoteLineItem, 'amount'>): QuoteLineItem {
  return { ...item, amount: item.unitAmount * item.quantity };
}

/** Os itens de cada plano para um volume já normalizado. */
function itemsOf(table: PriceTable, plan: PlanId, gbDay: number): QuoteLineItem[] {
  const { plataforma, dedicado, vciso } = table.plans;
  if (plan === 'plataforma') {
    const items = [
      lineItem({
        component: 'base',
        variant: 'plataforma',
        lookupKey: plataforma.base.lookupKey,
        quantity: 1,
        unitAmount: plataforma.base.amount,
        recurring: true,
      }),
    ];
    // A franquia acima do incluído é a quantidade de um item só: ampliar depois é mudar a quantidade dele na
    // assinatura. No incluído, o item não entra (a Stripe não aceita quantidade 0 no Checkout).
    const additional = gbDay - plataforma.includedGbDay;
    if (additional > 0) {
      items.push(
        lineItem({
          component: 'additional_gb_day',
          variant: 'plataforma',
          lookupKey: plataforma.additionalGbDay.lookupKey,
          quantity: additional,
          unitAmount: plataforma.additionalGbDay.amount,
          recurring: true,
        }),
      );
    }
    return items;
  }
  const items = [
    lineItem({
      component: 'gb_day',
      variant: 'dedicado',
      lookupKey: dedicado.gbDay.lookupKey,
      quantity: gbDay,
      unitAmount: dedicado.gbDay.amount,
      recurring: true,
    }),
  ];
  if (plan === 'vciso') {
    items.push(
      lineItem({
        component: 'service',
        variant: 'vciso',
        lookupKey: vciso.service.lookupKey,
        quantity: 1,
        unitAmount: vciso.service.amount,
        recurring: true,
      }),
      lineItem({
        component: 'setup',
        variant: 'vciso',
        lookupKey: vciso.setup.lookupKey,
        quantity: 1,
        unitAmount: vciso.setup.amount,
        recurring: false,
      }),
    );
  }
  return items;
}

/**
 * O motor da cotação, puro: a mesma função serve o site (`POST /v1/public/quote`), o checkout (que recalcula a cotação
 * gravada antes de abrir a sessão), a cotação de referência do contrato direto, o simulador de DRE e a checagem de
 * publicação.
 *
 * - Plataforma: 1 × a base (com os GB/dia incluídos) e (contratado − incluído) × o GB/dia adicional. Abaixo do
 *   incluído, o volume sobe até ele; acima do máximo do site, "fale conosco".
 * - Dedicado: GB/dia × o preço do GB/dia. Abaixo do mínimo, sobe até ele; acima do máximo cotável, "fale conosco".
 * - vCISO: o Dedicado, mais 1 × o serviço mensal e 1 × a implantação, uma vez (item avulso).
 * - O porte do nó: o menor da regra de porte que comporta o volume; nenhum, "fale conosco". O lugar (`mode`) não muda o
 *   preço: no cliente, o mesmo preço por GB/dia (a Verax não paga a nuvem, e a DRE mostra isso).
 *
 * Total mensal = soma dos itens recorrentes; primeira fatura = mensal + implantação.
 */
export function quote(input: ConfigurationInput, table: PriceTable): QuoteOutcome {
  if (!PLAN_MODES[input.plan].includes(input.mode)) return { kind: 'contact_us', reason: 'mode_unavailable' };
  const range = gbDayRange(table, input.plan);
  const gbDay = Math.max(input.gbDay, range.min);
  if (gbDay > range.max) {
    return { kind: 'contact_us', reason: input.plan === 'plataforma' ? 'above_online_max' : 'above_max' };
  }
  const size = sizeFor(gbDay, table.sizing.sizes);
  if (size === undefined) return { kind: 'contact_us', reason: 'above_largest_size' };
  const configuration: Configuration = {
    plan: input.plan,
    mode: input.mode,
    gbDay,
    size: size.size,
    historyDays: table.history.includedDays,
  };
  const items = itemsOf(table, input.plan, gbDay);
  const monthlyTotal = items.filter((item) => item.recurring).reduce((sum, item) => sum + item.amount, 0);
  const setupTotal = items.filter((item) => !item.recurring).reduce((sum, item) => sum + item.amount, 0);
  const plans = table.plans;
  return {
    kind: 'quote',
    quote: {
      configuration,
      sizeDescription: size.description,
      lineItems: items,
      monthlyTotal,
      setupTotal,
      firstInvoiceTotal: monthlyTotal + setupTotal,
      limits: {
        maxCloudAccounts:
          input.plan === 'plataforma' ? plans.plataforma.maxCloudAccounts : plans.dedicado.maxCloudAccounts,
        monthlyGib: monthlyGibFor(gbDay),
        historyDays: table.history.includedDays,
        maxAgents: 0,
        maxUsers: table.users.max,
      },
      included: {
        gbDay: input.plan === 'plataforma' ? plans.plataforma.includedGbDay : 0,
        historyDays: table.history.includedDays,
        users: table.users.max,
      },
    },
  };
}

/** A configuração mínima de um plano na infraestrutura da Verax: o menor volume que ele cota. É a do "a partir de". */
export function minimalConfiguration(table: PriceTable, plan: PlanId): ConfigurationInput {
  return { plan, gbDay: gbDayRange(table, plan).min, mode: 'managed' };
}

/** O "a partir de" de um plano: o preço da configuração mínima, pelo mesmo motor da cotação. */
export function startingAt(table: PriceTable, plan: PlanId): { monthly: number; setup: number } | undefined {
  const outcome = quote(minimalConfiguration(table, plan), table);
  if (outcome.kind !== 'quote') return undefined;
  return { monthly: outcome.quote.monthlyTotal, setup: outcome.quote.setupTotal };
}
