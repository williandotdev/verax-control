import { nodeFitProblems } from '../provisioning/node-fit.js';
import { costModelProblems, dreFromQuote } from './dre.js';
import {
  type Configuration,
  type ConfigurationInput,
  type CostModel,
  type DeploymentMode,
  PLAN_IDS,
  PLAN_MODES,
  type PaymentMethod,
  type PlanId,
  type PriceTable,
} from './pricing.schema.js';
import { isSoldOnline } from './public-pricing.js';
import { gbDayRange, quote, startingAt } from './quote.js';

/** Teto da grade: acima disso a tabela tem faixas absurdas e a checagem não roda (vira problema). */
export const MAX_GRID_CONFIGURATIONS = 100_000;
/** Quantas configurações cada lista do relatório mostra. */
const REPORT_LIMIT = 20;
const WORST_LIMIT = 10;

export interface GuardConfiguration {
  configuration: Configuration;
  monthlyTotal: number;
  contributionMargin: number;
  contributionMarginRatio: number;
}

/** O que a checagem precisa saber do serviço que publica. */
export interface PublishGuardOptions {
  /** A alíquota da Stripe do imposto por cima (`STRIPE_TAX_RATE_ID`) está configurada. */
  stripeTaxRate: boolean;
}

/** O problema da checagem de uma tabela sem impostos num serviço sem a alíquota da Stripe que os cobraria. */
export const TAX_RATE_UNCONFIGURED_PROBLEM =
  'a tabela é sem impostos (o imposto vai por cima), mas a alíquota da Stripe que o cobra não está configurada no serviço (STRIPE_TAX_RATE_ID): o checkout cobraria só o valor da tabela';

export interface GuardScenario {
  taxRateId: string;
  paymentMethod: PaymentMethod;
  worst: GuardConfiguration | null;
}

export interface MonotonicityViolation {
  from: Configuration;
  to: Configuration;
  fromTotal: number;
  toTotal: number;
}

/**
 * Resultado da checagem de publicação. `ok` só com: o modelo de custos cobrindo a tabela, nenhuma configuração abaixo
 * da margem mínima, nenhum GB/dia a mais baixando o preço, o "a partir de" igual ao mínimo de cada plano e tudo o que o
 * site vende cabendo no que o provisionamento cria.
 */
export interface GuardReport {
  ok: boolean;
  /** O que impede a checagem ou a publicação (modelo de custos incompleto, grade grande demais, regra quebrada). */
  problems: string[];
  paymentMethod: PaymentMethod;
  taxRateId: string;
  minimumMargin: number;
  alertMargin: number;
  checkedConfigurations: number;
  contactUsConfigurations: number;
  belowMinimum: { count: number; configurations: GuardConfiguration[] };
  belowAlert: { count: number; configurations: GuardConfiguration[] };
  worst: GuardConfiguration[];
  worstByPlan: Partial<Record<PlanId, GuardConfiguration>>;
  worstByMode: Partial<Record<DeploymentMode, GuardConfiguration>>;
  /** Só informação: o pior caso com as outras alíquotas (cartão) e no boleto (alíquota padrão). */
  otherScenarios: GuardScenario[];
  monotonicity: { violations: number; examples: MonotonicityViolation[] };
  /** O "a partir de" de cada plano e o menor preço mensal dele na grade (na infraestrutura da Verax). */
  startingAt: Partial<Record<PlanId, number>>;
  gridMinimum: Partial<Record<PlanId, number>>;
}

/** Quantas configurações a grade da tabela tem (cada plano, em cada modo dele, cada GB/dia vendável). */
export function gridSize(table: PriceTable): number {
  return PLAN_IDS.reduce((sum, plan) => {
    const range = gbDayRange(table, plan);
    return sum + PLAN_MODES[plan].length * Math.max(0, range.max - range.min + 1);
  }, 0);
}

/**
 * Todas as configurações que a tabela vende: a Plataforma de cada GB/dia contratável no site (do incluído ao máximo
 * online), o Dedicado e o vCISO de cada GB/dia do mínimo ao máximo cotável, em cada lugar em que o plano existe.
 */
export function* configurationGrid(table: PriceTable): Generator<ConfigurationInput> {
  for (const plan of PLAN_IDS) {
    const range = gbDayRange(table, plan);
    for (const mode of PLAN_MODES[plan]) {
      for (let gbDay = range.min; gbDay <= range.max; gbDay += 1) yield { plan, mode, gbDay };
    }
  }
}

function worse(a: GuardConfiguration, b: GuardConfiguration): number {
  return a.contributionMarginRatio - b.contributionMarginRatio || a.monthlyTotal - b.monthlyTotal;
}

/** Guarda as `limit` piores (menor margem) sem ordenar a grade inteira. */
class WorstList {
  readonly items: GuardConfiguration[] = [];
  count = 0;

  constructor(private readonly limit: number) {}

  add(item: GuardConfiguration): void {
    this.count += 1;
    const last = this.items.at(-1);
    if (this.items.length >= this.limit && last !== undefined && worse(item, last) >= 0) return;
    this.items.push(item);
    this.items.sort(worse);
    if (this.items.length > this.limit) this.items.pop();
  }
}

function keepWorst<K extends string>(
  record: Partial<Record<K, GuardConfiguration>>,
  key: K,
  item: GuardConfiguration,
): void {
  const current = record[key];
  if (current === undefined || worse(item, current) < 0) record[key] = item;
}

/**
 * A checagem de publicação: percorre a grade inteira com o modelo de custos vigente, no cartão e na alíquota padrão do
 * modelo, e recusa a tabela se alguma configuração ficar com margem de contribuição abaixo da mínima. A célula da
 * Plataforma entra rateada por GB/dia (custo ÷ capacidade) mais o custo fixo de cada cliente nela (`dre.ts`). Lista as
 * piores, as que ficam abaixo da margem de alerta, o pior caso de cada plano e lugar, o pior com as outras alíquotas e
 * no boleto (só informação), confere a monotonia (um GB/dia a mais nunca baixa o preço), que o "a partir de" é o menor
 * preço de cada plano, que o excedente não é mais barato que o GB/dia contratado e que tudo o que o site vende cabe no
 * que o provisionamento cria hoje (`node-fit.ts`). Com o imposto por cima (`taxMode = exclusive`), as margens são
 * calculadas com ele (`dre.ts`), e a tabela só passa se o serviço tiver a alíquota da Stripe que o cobra de verdade
 * (`stripeTaxRate`: `STRIPE_TAX_RATE_ID` configurada; o checkout confere a alíquota na Stripe a cada sessão). Pura: nada
 * de banco nem de Stripe.
 */
export function runPublishGuard(
  table: PriceTable,
  model: CostModel,
  options: PublishGuardOptions = { stripeTaxRate: false },
): GuardReport {
  const taxRateId = model.taxes.defaultRateId;
  const report: GuardReport = {
    ok: false,
    problems: costModelProblems(table, model),
    paymentMethod: 'card',
    taxRateId,
    minimumMargin: model.margins.minimum,
    alertMargin: model.margins.alert,
    checkedConfigurations: 0,
    contactUsConfigurations: 0,
    belowMinimum: { count: 0, configurations: [] },
    belowAlert: { count: 0, configurations: [] },
    worst: [],
    worstByPlan: {},
    worstByMode: {},
    otherScenarios: [],
    monotonicity: { violations: 0, examples: [] },
    startingAt: {},
    gridMinimum: {},
  };
  const size = gridSize(table);
  if (size > MAX_GRID_CONFIGURATIONS) report.problems.push(`grade grande demais (${size} configurações)`);
  if (report.problems.length > 0) return report;

  const below = new WorstList(REPORT_LIMIT);
  const alert = new WorstList(REPORT_LIMIT);
  const worst = new WorstList(WORST_LIMIT);
  const scenarios: GuardScenario[] = [
    ...model.taxes.rates
      .filter((tax) => tax.id !== taxRateId)
      .map((tax) => ({ taxRateId: tax.id, paymentMethod: 'card' as const, worst: null })),
    { taxRateId, paymentMethod: 'boleto', worst: null },
  ];
  /** O anterior de cada plano e lugar, para a monotonia (a grade sai em ordem crescente de GB/dia). */
  const previous = new Map<string, { configuration: Configuration; total: number }>();
  const unfit = new Set<string>();
  const onlineContactUs: string[] = [];

  for (const input of configurationGrid(table)) {
    const outcome = quote(input, table);
    if (outcome.kind !== 'quote') {
      report.contactUsConfigurations += 1;
      if (isSoldOnline(input))
        onlineContactUs.push(`${input.plan} ${input.gbDay} GB/dia (${outcome.reason})`);
      continue;
    }
    report.checkedConfigurations += 1;
    const { quote: quoted } = outcome;
    const { configuration } = quoted;
    if (configuration.mode === 'managed') {
      const minimum = report.gridMinimum[configuration.plan];
      if (minimum === undefined || quoted.monthlyTotal < minimum)
        report.gridMinimum[configuration.plan] = quoted.monthlyTotal;
    }
    // O que o site vende é pago antes de qualquer pessoa olhar: precisa caber no que o provisionamento cria.
    if (isSoldOnline(configuration) && nodeFitProblems(configuration, quoted.limits, 'verax').length > 0) {
      unfit.add(`${configuration.plan} ${configuration.gbDay} GB/dia (porte ${configuration.size})`);
    }

    const key = `${configuration.plan}|${configuration.mode}`;
    const before = previous.get(key);
    if (before !== undefined && quoted.monthlyTotal < before.total) {
      report.monotonicity.violations += 1;
      if (report.monotonicity.examples.length < WORST_LIMIT) {
        report.monotonicity.examples.push({
          from: before.configuration,
          to: configuration,
          fromTotal: before.total,
          toTotal: quoted.monthlyTotal,
        });
      }
    }
    previous.set(key, { configuration, total: quoted.monthlyTotal });

    const main = dreFromQuote(quoted, table, model, { paymentMethod: 'card', taxRateId }).monthly;
    const entry: GuardConfiguration = {
      configuration,
      monthlyTotal: quoted.monthlyTotal,
      contributionMargin: main.contributionMargin,
      contributionMarginRatio: main.contributionMarginRatio,
    };
    worst.add(entry);
    keepWorst(report.worstByPlan, configuration.plan, entry);
    keepWorst(report.worstByMode, configuration.mode, entry);
    if (entry.contributionMarginRatio < model.margins.minimum) below.add(entry);
    else if (entry.contributionMarginRatio < model.margins.alert) alert.add(entry);

    for (const scenario of scenarios) {
      const lines = dreFromQuote(quoted, table, model, scenario).monthly;
      const candidate = {
        ...entry,
        contributionMargin: lines.contributionMargin,
        contributionMarginRatio: lines.contributionMarginRatio,
      };
      if (scenario.worst === null || worse(candidate, scenario.worst) < 0) scenario.worst = candidate;
    }
  }

  for (const plan of PLAN_IDS) {
    const start = startingAt(table, plan);
    if (start !== undefined) report.startingAt[plan] = start.monthly;
    if (report.startingAt[plan] !== report.gridMinimum[plan]) {
      report.problems.push(`o "a partir de" do plano ${plan} não é o menor preço dele`);
    }
  }
  // Um volume que o site oferece e que cai em "sob consulta" levaria a um botão que não cota.
  if (onlineContactUs.length > 0) {
    report.problems.push(`o site oferece e não cota: ${onlineContactUs.slice(0, 5).join(', ')}`);
  }
  if (unfit.size > 0) {
    report.problems.push(
      `o site venderia o que o provisionamento ainda não cria: ${[...unfit].slice(0, 5).join(', ')}`,
    );
  }
  const { plataforma } = table.plans;
  if (plataforma.overageGbDay.amount < plataforma.additionalGbDay.amount) {
    report.problems.push('o GB/dia excedente da Plataforma é mais barato que o contratado');
  }
  if (table.taxMode === 'exclusive' && !options.stripeTaxRate) {
    report.problems.push(TAX_RATE_UNCONFIGURED_PROBLEM);
  }

  report.belowMinimum = { count: below.count, configurations: below.items };
  report.belowAlert = { count: alert.count, configurations: alert.items };
  report.worst = worst.items;
  report.otherScenarios = scenarios;
  report.ok = report.problems.length === 0 && below.count === 0 && report.monotonicity.violations === 0;
  return report;
}
