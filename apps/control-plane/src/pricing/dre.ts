import type {
  Configuration,
  ConfigurationInput,
  CostModel,
  Machine,
  PaymentMethod,
  PriceTable,
  TaxMode,
} from './pricing.schema.js';
import { type ContactReason, type Quote, quote } from './quote.js';

/**
 * A tabela de preços pede algo que o modelo de custos não cobre (um porte sem custo, uma alíquota que não existe). A
 * mensagem lista só os caminhos que faltam, nunca valores.
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
  /** O valor da tabela: a soma dos itens mensais, menos o desconto. */
  tableRevenue: number;
  /**
   * (+) Receita bruta: o que o cliente paga. Com o imposto embutido (`inclusive`), o valor da tabela; com o imposto por
   * cima (`exclusive`, o "+ impostos"), o valor da tabela ÷ (1 − alíquota).
   */
  grossRevenue: number;
  /** (−) Imposto sobre a receita bruta (DAS, pela alíquota escolhida). */
  taxes: number;
  /** (−) Reserva para reembolso e contestação. */
  refundReserve: number;
  /** (=) Receita líquida. */
  netRevenue: number;
  /** (−) Infraestrutura (só na Verax): o rateio da célula na Plataforma, o nó do porte no Dedicado e no vCISO. */
  infrastructure: number;
  /** (−) Meio de pagamento. */
  paymentFees: number;
  /** (−) Horas de suporte (e do serviço do vCISO) × custo da hora. */
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
  /** A receita bruta da implantação (com o imposto por cima, se a tabela for `exclusive`). */
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
  /** Como o imposto entra no preço, da tabela. */
  taxMode: TaxMode;
  supportHours: number;
  monthly: DreLines;
  setup: SetupDre;
  /** Doze meses, com a implantação no primeiro. */
  twelveMonths: { grossRevenue: number; contributionMargin: number; result: number };
  /**
   * Na infraestrutura do cliente: a estimativa do custo da nuvem dele (o porte a preço de lista, sem a folga), com a
   * faixa. Só informação: não entra na receita nem no custo da Verax.
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
 * O que o cliente paga por um valor da tabela e o imposto dentro disso: com `exclusive`, o imposto vai por cima (a
 * receita bruta é o valor ÷ (1 − alíquota), e o imposto é a diferença: o valor da tabela fica inteiro para a Verax);
 * com `inclusive`, o valor da tabela já é a receita bruta, e o imposto sai dela.
 */
function grossOf(amount: number, taxMode: TaxMode, taxRate: number): { gross: number; taxes: number } {
  if (taxMode === 'exclusive' && taxRate < 1) {
    const gross = cents(amount / (1 - taxRate));
    return { gross, taxes: gross - amount };
  }
  return { gross: amount, taxes: cents(amount * taxRate) };
}

/** Custo mensal de uma máquina, em dólares: a VM, o disco e os snapshots, o NAT, o IP do NAT e os outros itens. */
export function machineUsd(machine: Machine, model: CostModel): number {
  const infra = model.infrastructure;
  return (
    machine.vmUsdPerMonth +
    machine.diskGb * infra.diskUsdPerGibMonth +
    machine.snapshotGib * infra.snapshotUsdPerGibMonth +
    infra.natUsdPerVmMonth +
    infra.natIpUsdPerMonth +
    infra.otherUsdPerNodeMonth
  );
}

/** O custo do nó dedicado do porte da configuração (US$/mês), mais a ingestão do volume. */
function dedicatedNodeUsd(configuration: Configuration, model: CostModel): number {
  const size = model.infrastructure.sizes[configuration.size];
  if (size === undefined) throw new CostModelMismatchError([`infrastructure.sizes.${configuration.size}`]);
  return machineUsd(size, model) + configuration.gbDay * model.infrastructure.ingestionUsdPerGbDay;
}

/**
 * Custo mensal da nuvem da Verax para o cliente, em dólares:
 * - Plataforma: o rateio da célula compartilhada (custo da máquina ÷ capacidade em GB/dia × GB/dia contratado), o custo
 *   fixo de cada cliente na célula e a ingestão do volume;
 * - Dedicado e vCISO: o nó do porte e a ingestão do volume.
 */
export function cloudUsd(configuration: Configuration, model: CostModel): number {
  const infra = model.infrastructure;
  if (configuration.plan === 'plataforma') {
    const cell = infra.sharedCell;
    return (
      (machineUsd(cell, model) / cell.capacityGbDay) * configuration.gbDay +
      cell.perCustomerUsdPerMonth +
      configuration.gbDay * infra.ingestionUsdPerGbDay
    );
  }
  return dedicatedNodeUsd(configuration, model);
}

/**
 * Horas de suporte por mês: as do plano (o vCISO, as do Dedicado mais as do serviço) e, na infraestrutura do cliente, as
 * a mais.
 */
export function monthlySupportHours(configuration: Configuration, model: CostModel): number {
  const hours = model.support.hours;
  const plan =
    configuration.plan === 'plataforma'
      ? hours.plataforma
      : hours.dedicado + (configuration.plan === 'vciso' ? hours.vcisoService : 0);
  return plan + (configuration.mode === 'self_hosted' ? hours.selfHosted : 0);
}

/** Horas da implantação, uma vez: as do plano (o vCISO, as do Dedicado mais as dele) e as a mais no cliente. */
export function setupSupportHours(configuration: Configuration, model: CostModel): number {
  const hours = model.support.hours;
  const plan =
    configuration.plan === 'plataforma'
      ? hours.setupPlataforma
      : hours.setupDedicado + (configuration.plan === 'vciso' ? hours.setupVciso : 0);
  return plan + (configuration.mode === 'self_hosted' ? hours.setupSelfHosted : 0);
}

/**
 * A DRE de uma cotação já calculada (a checagem de publicação reaproveita a cotação para várias alíquotas e meios de
 * pagamento). Fórmulas, por cliente e por mês:
 *
 *   valor = Σ itens mensais × (1 − desconto)
 *   RB  = valor (imposto embutido) ou valor ÷ (1 − alíquota) (imposto por cima, `exclusive`)
 *   DAS = RB × alíquota (por cima: RB − valor);  reserva = RB × taxa de reserva;  RL = RB − DAS − reserva
 *   infraestrutura (na Verax) = custo da nuvem (US$, `cloudUsd`) × câmbio × (1 + folga); no cliente, 0
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
  const { configuration } = quoteResult;
  const managed = configuration.mode === 'managed';

  const tableRevenue = cents(quoteResult.monthlyTotal * (1 - discount));
  const { gross: grossRevenue, taxes } = grossOf(tableRevenue, table.taxMode, tax.rate);
  const refundReserve = cents(grossRevenue * model.refundReserveRate);
  const netRevenue = grossRevenue - taxes - refundReserve;
  const infrastructure = managed
    ? cents(cloudUsd(configuration, model) * fx * (1 + model.exchange.cloudBuffer))
    : 0;
  const paymentFees =
    options.paymentMethod === 'card'
      ? cents(grossRevenue * (fees.card.rate + fees.billingRate) + fees.card.fixed)
      : cents(fees.boleto.fixed + grossRevenue * fees.billingRate);
  const supportHours = monthlySupportHours(configuration, model);
  const support = cents(supportHours * model.support.hourlyCost);
  const contributionMargin = netRevenue - infrastructure - paymentFees - support;
  const totalFixed = model.fixedCosts.items.reduce((sum, item) => sum + item.monthly, 0);
  const customers = Math.max(1, options.allocationCustomers ?? model.fixedCosts.allocationCustomers);
  const fixedCosts = cents(totalFixed / customers);
  const result = contributionMargin - fixedCosts;

  const setup = grossOf(quoteResult.setupTotal, table.taxMode, tax.rate);
  const setupRevenue = setup.gross;
  const setupHours = setupSupportHours(configuration, model);
  const setupReserve = cents(setupRevenue * model.refundReserveRate);
  // A implantação vai na primeira fatura junto com a mensalidade: uma cobrança só, e o valor fixo já está no mês.
  const setupFees =
    options.paymentMethod === 'card'
      ? cents(setupRevenue * (fees.card.rate + fees.billingRate))
      : cents(setupRevenue * fees.billingRate);
  const setupSupport = cents(setupHours * model.support.hourlyCost);
  const setupMargin = setupRevenue - setup.taxes - setupReserve - setupFees - setupSupport;

  // A nuvem do cliente: o nó do porte a preço de lista (sem a folga da Verax), só como estimativa.
  const spread = model.customerCloudEstimateSpread;
  const estimate = managed ? 0 : cents(dedicatedNodeUsd(configuration, model) * fx);
  return {
    quote: quoteResult,
    paymentMethod: options.paymentMethod,
    taxRateId: tax.id,
    taxMode: table.taxMode,
    supportHours,
    monthly: {
      tableRevenue,
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
      taxes: setup.taxes,
      refundReserve: setupReserve,
      paymentFees: setupFees,
      supportHours: setupHours,
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
