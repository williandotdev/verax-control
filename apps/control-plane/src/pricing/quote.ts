import type {
  Configuration,
  ConfigurationInput,
  DeploymentMode,
  NodeLimits,
  PriceTable,
  QuoteLineItem,
  SizeRule,
} from './pricing.schema.js';

/**
 * Por que uma configuração não tem preço na hora: algum número passa do que a tabela vende, ou nenhum porte comporta
 * a combinação. O site leva ao contato com a configuração preenchida.
 */
export const CONTACT_REASONS = [
  'cloud_accounts_above_max',
  'volume_above_max',
  'agents_above_max',
  'history_above_max',
  'above_largest_size',
] as const;
export type ContactReason = (typeof CONTACT_REASONS)[number];

export interface Quote {
  /** A configuração normalizada para a tabela (arredondada para cima até a opção vendida), com o porte. */
  configuration: Configuration;
  /** Texto do porte para o cliente, da regra de porte da tabela. */
  sizeDescription: string;
  /** Na ordem do Checkout: os itens mensais e, por último, a implantação (se o modo tiver). */
  lineItems: QuoteLineItem[];
  monthlyTotal: number;
  setupTotal: number;
  firstInvoiceTotal: number;
  /** Os limites do nó para esta configuração (PR-18; `node-limits.ts`). */
  limits: NodeLimits;
  /** O que já vem no ambiente sem custo a mais. */
  included: { cloudAccounts: number; monthlyGib: number; historyDays: number; users: number };
  agentPacks: number;
}

export type QuoteOutcome = { kind: 'quote'; quote: Quote } | { kind: 'contact_us'; reason: ContactReason };

/** O menor porte que comporta as três dimensões, na ordem da tabela; nenhum, `undefined` ("sob consulta"). */
export function sizeFor(
  dimensions: { cloudAccounts: number; monthlyGib: number; agents: number },
  sizes: readonly SizeRule[],
): SizeRule | undefined {
  return sizes.find(
    (rule) =>
      dimensions.cloudAccounts <= rule.maxCloudAccounts &&
      dimensions.monthlyGib <= rule.maxMonthlyGib &&
      dimensions.agents <= rule.maxAgents,
  );
}

type Normalized =
  | { ok: true; configuration: Omit<Configuration, 'size'>; agentPacks: number }
  | { ok: false; reason: ContactReason };

/**
 * Leva cada resposta à opção que a tabela vende, sempre para cima: contas abaixo das incluídas viram as incluídas;
 * volume e histórico sobem até a próxima faixa; agentes, até o próximo pacote. Acima da maior opção, "sob consulta".
 */
export function normalizeConfiguration(input: ConfigurationInput, table: PriceTable): Normalized {
  const cloudAccounts = Math.max(input.cloudAccounts, table.cloudAccounts.included);
  if (cloudAccounts > table.cloudAccounts.max) return { ok: false, reason: 'cloud_accounts_above_max' };

  let monthlyGib = table.volume.includedMonthlyGib;
  if (input.monthlyGib > monthlyGib) {
    const band = table.volume.bands.find((option) => option.monthlyGib >= input.monthlyGib);
    if (band === undefined) return { ok: false, reason: 'volume_above_max' };
    monthlyGib = band.monthlyGib;
  }

  const agentPacks = Math.ceil(input.agents / table.agents.packSize);
  if (agentPacks > table.agents.maxPacks) return { ok: false, reason: 'agents_above_max' };

  let historyDays = table.history.includedDays;
  if (input.historyDays > historyDays) {
    const option = table.history.extended.find((extended) => extended.days >= input.historyDays);
    if (option === undefined) return { ok: false, reason: 'history_above_max' };
    historyDays = option.days;
  }

  return {
    ok: true,
    agentPacks,
    configuration: {
      mode: input.mode,
      cloudAccounts,
      monthlyGib,
      agents: agentPacks * table.agents.packSize,
      historyDays,
      support: input.support,
    },
  };
}

function lineItem(item: Omit<QuoteLineItem, 'amount'>): QuoteLineItem {
  return { ...item, amount: item.unitAmount * item.quantity };
}

/**
 * O motor da cotação, puro: a mesma função serve o site (`POST /v1/public/quote`), o checkout (que recalcula a cotação
 * gravada antes de abrir a sessão), o simulador de DRE e a checagem de publicação.
 *
 * - Ambiente (ou licença): 1 × o preço do porte no modo.
 * - Contas de nuvem: (contas − incluídas) × o preço da conta adicional.
 * - Volume: 1 × o preço da faixa, quando acima da franquia incluída.
 * - Agentes: pacotes × o preço do pacote.
 * - Histórico: 1 × o preço da opção, quando acima do incluído.
 * - Suporte prioritário: 1 × o preço, quando escolhido.
 * - Implantação: 1 × o preço do modo, uma vez (item avulso), quando o modo tiver.
 *
 * Total mensal = soma dos itens recorrentes; primeira fatura = mensal + implantação.
 */
export function quote(input: ConfigurationInput, table: PriceTable): QuoteOutcome {
  const normalized = normalizeConfiguration(input, table);
  if (!normalized.ok) return { kind: 'contact_us', reason: normalized.reason };
  const { configuration: base, agentPacks } = normalized;
  const size = sizeFor(base, table.sizing.sizes);
  if (size === undefined) return { kind: 'contact_us', reason: 'above_largest_size' };
  const configuration: Configuration = { ...base, size: size.size };
  const pricing = table.modes[base.mode];
  const environment = pricing.environment[size.size];
  // A tabela validada tem preço para todo porte da regra (`priceTableSchema`); sem ele, a tabela é inconsistente.
  if (environment === undefined)
    throw new TypeError(`tabela sem preço do ambiente para o porte ${size.size}`);

  const items: QuoteLineItem[] = [
    lineItem({
      component: 'environment',
      variant: `${base.mode}_${size.size}`,
      lookupKey: environment.lookupKey,
      quantity: 1,
      unitAmount: environment.amount,
      recurring: true,
    }),
  ];
  const additionalAccounts = base.cloudAccounts - table.cloudAccounts.included;
  if (additionalAccounts > 0) {
    items.push(
      lineItem({
        component: 'cloud_accounts',
        variant: 'additional',
        lookupKey: table.cloudAccounts.additional.lookupKey,
        quantity: additionalAccounts,
        unitAmount: table.cloudAccounts.additional.amount,
        recurring: true,
      }),
    );
  }
  const band = table.volume.bands.find((option) => option.monthlyGib === base.monthlyGib);
  if (band !== undefined) {
    items.push(
      lineItem({
        component: 'volume',
        variant: String(band.monthlyGib),
        lookupKey: band.lookupKey,
        quantity: 1,
        unitAmount: band.amount,
        recurring: true,
      }),
    );
  }
  if (agentPacks > 0) {
    items.push(
      lineItem({
        component: 'agents',
        variant: String(table.agents.packSize),
        lookupKey: table.agents.pack.lookupKey,
        quantity: agentPacks,
        unitAmount: table.agents.pack.amount,
        recurring: true,
      }),
    );
  }
  const history = table.history.extended.find((option) => option.days === base.historyDays);
  if (history !== undefined) {
    items.push(
      lineItem({
        component: 'history',
        variant: String(history.days),
        lookupKey: history.lookupKey,
        quantity: 1,
        unitAmount: history.amount,
        recurring: true,
      }),
    );
  }
  if (base.support === 'priority') {
    items.push(
      lineItem({
        component: 'priority_support',
        variant: 'priority',
        lookupKey: table.prioritySupport.lookupKey,
        quantity: 1,
        unitAmount: table.prioritySupport.amount,
        recurring: true,
      }),
    );
  }
  if (pricing.setup !== undefined) {
    items.push(
      lineItem({
        component: 'setup',
        variant: base.mode,
        lookupKey: pricing.setup.lookupKey,
        quantity: 1,
        unitAmount: pricing.setup.amount,
        recurring: false,
      }),
    );
  }

  const monthlyTotal = items.filter((item) => item.recurring).reduce((sum, item) => sum + item.amount, 0);
  const setupTotal = items.filter((item) => !item.recurring).reduce((sum, item) => sum + item.amount, 0);
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
        maxCloudAccounts: configuration.cloudAccounts,
        monthlyGib: configuration.monthlyGib,
        historyDays: configuration.historyDays,
        maxAgents: configuration.agents,
        maxUsers: table.users.max,
      },
      included: {
        cloudAccounts: table.cloudAccounts.included,
        monthlyGib: table.volume.includedMonthlyGib,
        historyDays: table.history.includedDays,
        users: table.users.max,
      },
      agentPacks,
    },
  };
}

/** A configuração mínima de um modo: o menor porte, só o incluído, suporte padrão. É a do "a partir de". */
export function minimalConfiguration(table: PriceTable, mode: DeploymentMode): ConfigurationInput {
  return {
    mode,
    cloudAccounts: table.cloudAccounts.included,
    monthlyGib: table.volume.includedMonthlyGib,
    agents: 0,
    historyDays: table.history.includedDays,
    support: 'standard',
  };
}

/** O "a partir de" de um modo: o preço da configuração mínima, pelo mesmo motor da cotação. */
export function startingAt(
  table: PriceTable,
  mode: DeploymentMode,
): { monthly: number; setup: number } | undefined {
  const outcome = quote(minimalConfiguration(table, mode), table);
  if (outcome.kind !== 'quote') return undefined;
  return { monthly: outcome.quote.monthlyTotal, setup: outcome.quote.setupTotal };
}
