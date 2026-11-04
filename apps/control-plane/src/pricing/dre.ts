import type { ConfigurationInput, CostModel, PaymentMethod, PriceTable } from './pricing.schema.js';
import { type ContactReason, type Quote, quote } from './quote.js';

/**
 * A tabela de preços pede algo que o modelo de custos não cobre (um porte sem custo, uma faixa de volume sem horas de
 * suporte, uma alíquota que não existe). A mensagem lista só os caminhos que faltam, nunca valores.
 */
export class CostModelMismatchError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`o modelo de custos não cobre a tabela de preços: ${problems.join(', ')}`);
    this.name = 'CostModelMismatchError';
  }
}

/** Caminhos que a tabela de preços exige do modelo de custos e que faltam nele. Vazio quando os dois se cobrem. */
export function costModelProblems(table: PriceTable, model: CostModel): string[] {
  const problems: string[] = [];
  for (const rule of table.sizing.sizes) {
    if (model.infrastructure.sizes[rule.size] === undefined)
      problems.push(`infrastructure.sizes.${rule.size}`);
  }
  const bands = new Set(model.support.hours.perVolumeBand.map((band) => band.monthlyGib));
  for (const band of table.volume.bands) {
    if (!bands.has(band.monthlyGib)) problems.push(`support.hours.perVolumeBand.${band.monthlyGib}`);
  }
  return problems;
}

export interface DreOptions {
  paymentMethod: PaymentMethod;
  /** A alíquota do modelo de custos; sem ela, a padrão (`taxes.defaultRateId`). */
  taxRateId?: string;
  /** Desconto sobre os itens mensais (um cupom), entre 0 e 1. A implantação não tem desconto. */
  discountRate?: number;
  /** Clientes para o rateio dos custos fixos; sem ele, o do modelo. */
  allocationCustomers?: number;
}

/** As linhas da DRE de um cliente num mês, em centavos (as razões entre 0 e 1). */
export interface DreLines {
  /** (+) Receita bruta: soma dos itens mensais, menos o desconto. */
  grossRevenue: number;
  /** (−) Imposto sobre a receita bruta (DAS, pela alíquota escolhida). */
  taxes: number;
  /** (−) Reserva para reembolso e contestação. */
  refundReserve: number;
  /** (=) Receita líquida. */
  netRevenue: number;
  /** (−) Infraestrutura do nó (só no gerenciado). */
  infrastructure: number;
  /** (−) Meio de pagamento. */
  paymentFees: number;
  /** (−) Horas de suporte × custo da hora. */
  support: number;
  /** (=) Margem de contribuição. */
  contributionMargin: number;
  /** Margem de contribuição sobre a receita bruta (a da checagem de publicação). */
  contributionMarginRatio: number;
  /** Margem de contribuição sobre a receita líquida. */
  contributionMarginNetRatio: number;
  /** (−) Custos fixos rateados. */
  fixedCosts: number;
  /** (=) Resultado do cliente. */
  result: number;
  resultRatio: number;
}

/** A implantação, cobrada uma vez: as mesmas deduções, as horas dela e a tarifa sem o valor fixo (mesma cobrança). */
export interface SetupDre {
  revenue: number;
  taxes: number;
  refundReserve: number;
  paymentFees: number;
  supportHours: number;
  support: number;
  contributionMargin: number;
  /** `null` quando a implantação não é cobrada (receita zero). */
  contributionMarginRatio: number | null;
}

export interface DreResult {
  quote: Quote;
  paymentMethod: PaymentMethod;
  taxRateId: string;
  supportHours: number;
  monthly: DreLines;
  setup: SetupDre;
  /** Doze meses, com a implantação no primeiro. */
  twelveMonths: { grossRevenue: number; contributionMargin: number; result: number };
  /**
   * Na nuvem do cliente: a estimativa do custo da nuvem dele (o porte a preço de lista, sem a folga), com a faixa.
   * Só informação: não entra na receita nem no custo da Verax.
   */
  customerCloudEstimate: { monthly: number; low: number; high: number } | null;
}

export type DreOutcome = { kind: 'dre'; dre: DreResult } | { kind: 'contact_us'; reason: ContactReason };

function cents(value: number): number {
  return Math.round(value);
}

function ratio(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

function taxRateOf(model: CostModel, taxRateId: string | undefined): { id: string; rate: number } {
  const id = taxRateId ?? model.taxes.defaultRateId;
  const tax = model.taxes.rates.find((candidate) => candidate.id === id);
  if (tax === undefined) throw new CostModelMismatchError([`taxes.rates.${id}`]);
  return { id, rate: tax.rate };
}

/**
 * Custo mensal da nuvem do nó, em dólares: VM, disco e snapshots do porte, NAT, IP do NAT, outros, a ingestão da
 * franquia de volume e, com agentes, a entrada deles (regra de encaminhamento com o IP fixo) e o disco a mais (base
 * mais um tanto por agente, com snapshot).
 */
export function nodeCloudUsd(quoteResult: Quote, model: CostModel): number {
  const { configuration } = quoteResult;
  const infra = model.infrastructure;
  const size = infra.sizes[configuration.size];
  if (size === undefined) throw new CostModelMismatchError([`infrastructure.sizes.${configuration.size}`]);
  const perGib = infra.diskUsdPerGibMonth + infra.snapshotUsdPerGibMonth;
  const agents =
    configuration.agents > 0
      ? infra.agents.entryUsdPerMonth +
        (infra.agents.diskBaseGb + configuration.agents * infra.agents.diskPerAgentGb) * perGib
      : 0;
  return (
    size.vmUsdPerMonth +
    size.diskGb * infra.diskUsdPerGibMonth +
    size.snapshotGib * infra.snapshotUsdPerGibMonth +
    infra.natUsdPerVmMonth +
    infra.natIpUsdPerMonth +
    infra.otherUsdPerNodeMonth +
    configuration.monthlyGib * infra.ingestionUsdPerGib +
    agents
  );
}

/** Horas de suporte por mês: base do modo, contas adicionais, pacotes de agentes, faixa de volume e prioritário. */
export function monthlySupportHours(quoteResult: Quote, table: PriceTable, model: CostModel): number {
  const { configuration } = quoteResult;
  const hours = model.support.hours;
  const additionalAccounts = Math.max(0, configuration.cloudAccounts - table.cloudAccounts.included);
  let volume = 0;
  if (configuration.monthlyGib > table.volume.includedMonthlyGib) {
    const band = hours.perVolumeBand.find((entry) => entry.monthlyGib === configuration.monthlyGib);
    if (band === undefined) {
      throw new CostModelMismatchError([`support.hours.perVolumeBand.${configuration.monthlyGib}`]);
    }
    volume = band.hours;
  }
  return (
    (configuration.mode === 'managed' ? hours.baseManaged : hours.baseSelfHosted) +
    additionalAccounts * hours.perAdditionalAccount +
    quoteResult.agentPacks * hours.perAgentPack +
    volume +
    (configuration.support === 'priority' ? hours.prioritySupport : 0)
  );
}

/**
 * A DRE de uma cotação já calculada (a checagem de publicação reaproveita a cotação para várias alíquotas e meios de
 * pagamento). Fórmulas, por cliente e por mês:
 *
 *   RB  = Σ itens mensais × (1 − desconto)
 *   DAS = RB × alíquota;  reserva = RB × taxa de reserva;  RL = RB − DAS − reserva
 *   infraestrutura (gerenciado) = custo da nuvem do nó (US$, `nodeCloudUsd`) × câmbio × (1 + folga); na nuvem do
 *     cliente, 0
 *   meio de pagamento = cartão: RB × (tarifa do cartão + tarifa da cobrança recorrente) + valor fixo do cartão;
 *     boleto: valor fixo do boleto + RB × tarifa da cobrança recorrente
 *   suporte = horas (`monthlySupportHours`) × custo da hora
 *   MC  = RL − infraestrutura − meio de pagamento − suporte;  MC% = MC / RB (e MC / RL)
 *   resultado = MC − Σ custos fixos / clientes do rateio
 *
 * Cada linha é arredondada para o centavo, e as linhas derivadas saem das arredondadas: a DRE mostrada fecha.
 */
export function dreFromQuote(
  quoteResult: Quote,
  table: PriceTable,
  model: CostModel,
  options: DreOptions,
): DreResult {
  const tax = taxRateOf(model, options.taxRateId);
  const discount = Math.min(1, Math.max(0, options.discountRate ?? 0));
  const fx = model.exchange.brlPerUsd * 100;
  const fees = model.paymentFees;
  const managed = quoteResult.configuration.mode === 'managed';

  const grossRevenue = cents(quoteResult.monthlyTotal * (1 - discount));
  const taxes = cents(grossRevenue * tax.rate);
  const refundReserve = cents(grossRevenue * model.refundReserveRate);
  const netRevenue = grossRevenue - taxes - refundReserve;
  const cloudUsd = nodeCloudUsd(quoteResult, model);
  const infrastructure = managed ? cents(cloudUsd * fx * (1 + model.exchange.cloudBuffer)) : 0;
  const paymentFees =
    options.paymentMethod === 'card'
      ? cents(grossRevenue * (fees.card.rate + fees.billingRate) + fees.card.fixed)
      : cents(fees.boleto.fixed + grossRevenue * fees.billingRate);
  const supportHours = monthlySupportHours(quoteResult, table, model);
  const support = cents(supportHours * model.support.hourlyCost);
  const contributionMargin = netRevenue - infrastructure - paymentFees - support;
  const totalFixed = model.fixedCosts.items.reduce((sum, item) => sum + item.monthly, 0);
  const customers = Math.max(1, options.allocationCustomers ?? model.fixedCosts.allocationCustomers);
  const fixedCosts = cents(totalFixed / customers);
  const result = contributionMargin - fixedCosts;

  const setupRevenue = quoteResult.setupTotal;
  const setupHours = managed ? model.support.hours.setupManaged : model.support.hours.setupSelfHosted;
  const setupSupportHours =
    setupHours +
    (quoteResult.configuration.support === 'priority' ? model.support.hours.setupPriorityExtra : 0);
  const setupTaxes = cents(setupRevenue * tax.rate);
  const setupReserve = cents(setupRevenue * model.refundReserveRate);
  // A implantação vai na primeira fatura junto com a mensalidade: uma cobrança só, e o valor fixo já está no mês.
  const setupFees =
    options.paymentMethod === 'card'
      ? cents(setupRevenue * (fees.card.rate + fees.billingRate))
      : cents(setupRevenue * fees.billingRate);
  const setupSupport = cents(setupSupportHours * model.support.hourlyCost);
  const setupMargin = setupRevenue - setupTaxes - setupReserve - setupFees - setupSupport;

  const spread = model.customerCloudEstimateSpread;
  const estimate = cents(cloudUsd * fx);
  return {
    quote: quoteResult,
    paymentMethod: options.paymentMethod,
    taxRateId: tax.id,
    supportHours,
    monthly: {
      grossRevenue,
      taxes,
      refundReserve,
      netRevenue,
      infrastructure,
      paymentFees,
      support,
      contributionMargin,
      contributionMarginRatio: ratio(contributionMargin, grossRevenue),
      contributionMarginNetRatio: ratio(contributionMargin, netRevenue),
      fixedCosts,
      result,
      resultRatio: ratio(result, grossRevenue),
    },
    setup: {
      revenue: setupRevenue,
      taxes: setupTaxes,
      refundReserve: setupReserve,
      paymentFees: setupFees,
      supportHours: setupSupportHours,
      support: setupSupport,
      contributionMargin: setupMargin,
      contributionMarginRatio: setupRevenue === 0 ? null : ratio(setupMargin, setupRevenue),
    },
    twelveMonths: {
      grossRevenue: 12 * grossRevenue + setupRevenue,
      contributionMargin: 12 * contributionMargin + setupMargin,
      result: 12 * result + setupMargin,
    },
    customerCloudEstimate: managed
      ? null
      : { monthly: estimate, low: cents(estimate * (1 - spread)), high: cents(estimate * (1 + spread)) },
  };
}

/**
 * `dre(configuração, tabela, modelo de custos, meio de pagamento)`: cota a configuração pela tabela e monta a DRE.
 * Configuração "sob consulta" não tem DRE.
 */
export function dre(
  configuration: ConfigurationInput,
  table: PriceTable,
  model: CostModel,
  paymentMethod: PaymentMethod,
  options: Omit<DreOptions, 'paymentMethod'> = {},
): DreOutcome {
  const problems = costModelProblems(table, model);
  if (problems.length > 0) throw new CostModelMismatchError(problems);
  const outcome = quote(configuration, table);
  if (outcome.kind !== 'quote') return outcome;
  return { kind: 'dre', dre: dreFromQuote(outcome.quote, table, model, { ...options, paymentMethod }) };
}
