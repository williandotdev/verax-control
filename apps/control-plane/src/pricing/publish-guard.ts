import { costModelProblems, dreFromQuote } from './dre.js';
import {
  type Configuration,
  type ConfigurationInput,
  type CostModel,
  DEPLOYMENT_MODES,
  type DeploymentMode,
  type PaymentMethod,
  type PriceTable,
  type SizeId,
  SUPPORT_LEVELS,
} from './pricing.schema.js';
import { quote, startingAt } from './quote.js';

/** Teto da grade: acima disso a tabela tem dimensões absurdas e a checagem não roda (vira problema). */
export const MAX_GRID_CONFIGURATIONS = 500_000;
/** Quantas configurações cada lista do relatório mostra. */
const REPORT_LIMIT = 20;
const WORST_LIMIT = 10;

export interface GuardConfiguration {
  configuration: Configuration;
  monthlyTotal: number;
  contributionMargin: number;
  contributionMarginRatio: number;
}

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
 * da margem mínima, nenhum acréscimo que baixe o preço e o "a partir de" igual ao mínimo da grade em cada modo.
 */
export interface GuardReport {
  ok: boolean;
  /** O que impede a checagem (modelo de custos incompleto, grade grande demais). */
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
  worstByMode: Partial<Record<DeploymentMode, GuardConfiguration>>;
  worstBySize: Partial<Record<SizeId, GuardConfiguration>>;
  /** Só informação: o pior caso com as outras alíquotas (cartão) e no boleto (alíquota padrão). */
  otherScenarios: GuardScenario[];
  monotonicity: { violations: number; examples: MonotonicityViolation[] };
  startingAt: Partial<Record<DeploymentMode, number>>;
  gridMinimum: Partial<Record<DeploymentMode, number>>;
}

/** Quantas configurações a grade da tabela tem (os dois modos). */
export function gridSize(table: PriceTable): number {
  const accounts = table.cloudAccounts.max - table.cloudAccounts.included + 1;
  return (
    DEPLOYMENT_MODES.length *
    accounts *
    (table.volume.bands.length + 1) *
    (table.agents.maxPacks + 1) *
    (table.history.extended.length + 1) *
    SUPPORT_LEVELS.length
  );
}

/**
 * Todas as configurações que a tabela vende, já nos valores das opções (contas de uma em uma, cada faixa de volume,
 * cada pacote de agentes, cada opção de histórico, os dois suportes), nos dois modos. As acima do maior porte saem
 * como "sob consulta" na cotação.
 */
export function* configurationGrid(table: PriceTable): Generator<ConfigurationInput> {
  const volumes = [table.volume.includedMonthlyGib, ...table.volume.bands.map((band) => band.monthlyGib)];
  const histories = [table.history.includedDays, ...table.history.extended.map((option) => option.days)];
  for (const mode of DEPLOYMENT_MODES) {
    for (
      let cloudAccounts = table.cloudAccounts.included;
      cloudAccounts <= table.cloudAccounts.max;
      cloudAccounts += 1
    ) {
      for (const monthlyGib of volumes) {
        for (let packs = 0; packs <= table.agents.maxPacks; packs += 1) {
          for (const historyDays of histories) {
            for (const support of SUPPORT_LEVELS) {
              yield {
                mode,
                cloudAccounts,
                monthlyGib,
                agents: packs * table.agents.packSize,
                historyDays,
                support,
              };
            }
          }
        }
      }
    }
  }
}

function keyOf(configuration: ConfigurationInput): string {
  return [
    configuration.mode,
    configuration.cloudAccounts,
    configuration.monthlyGib,
    configuration.agents,
    configuration.historyDays,
    configuration.support,
  ].join('|');
}

/** As configurações vizinhas "com uma unidade a mais" em cada dimensão (para a monotonia do preço). */
function neighbors(configuration: ConfigurationInput, table: PriceTable): ConfigurationInput[] {
  const result: ConfigurationInput[] = [];
  if (configuration.cloudAccounts < table.cloudAccounts.max) {
    result.push({ ...configuration, cloudAccounts: configuration.cloudAccounts + 1 });
  }
  const volumes = [table.volume.includedMonthlyGib, ...table.volume.bands.map((band) => band.monthlyGib)];
  const nextVolume = volumes[volumes.indexOf(configuration.monthlyGib) + 1];
  if (nextVolume !== undefined) result.push({ ...configuration, monthlyGib: nextVolume });
  if (configuration.agents < table.agents.maxPacks * table.agents.packSize) {
    result.push({ ...configuration, agents: configuration.agents + table.agents.packSize });
  }
  const histories = [table.history.includedDays, ...table.history.extended.map((option) => option.days)];
  const nextHistory = histories[histories.indexOf(configuration.historyDays) + 1];
  if (nextHistory !== undefined) result.push({ ...configuration, historyDays: nextHistory });
  if (configuration.support === 'standard') result.push({ ...configuration, support: 'priority' });
  return result;
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
 * modelo, e recusa a tabela se alguma configuração ficar com margem de contribuição abaixo da mínima. Lista as piores,
 * as que ficam abaixo da margem de alerta, o pior caso de cada modo e porte, o pior com as outras alíquotas e no boleto
 * (só informação), confere a monotonia (uma unidade a mais nunca baixa o preço) e que o "a partir de" é o mínimo da
 * grade em cada modo. Pura: nada de banco nem de Stripe.
 */
export function runPublishGuard(table: PriceTable, model: CostModel): GuardReport {
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
    worstByMode: {},
    worstBySize: {},
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
  const scenarios: { taxRateId: string; paymentMethod: PaymentMethod; worst: GuardConfiguration | null }[] = [
    ...model.taxes.rates
      .filter((tax) => tax.id !== taxRateId)
      .map((tax) => ({ taxRateId: tax.id, paymentMethod: 'card' as const, worst: null })),
    { taxRateId, paymentMethod: 'boleto', worst: null },
  ];
  const totals = new Map<string, number>();
  const configurations: ConfigurationInput[] = [];

  for (const configuration of configurationGrid(table)) {
    const outcome = quote(configuration, table);
    if (outcome.kind !== 'quote') {
      report.contactUsConfigurations += 1;
      continue;
    }
    report.checkedConfigurations += 1;
    const { quote: quoted } = outcome;
    totals.set(keyOf(configuration), quoted.monthlyTotal);
    configurations.push(configuration);
    const minimum = report.gridMinimum[configuration.mode];
    if (minimum === undefined || quoted.monthlyTotal < minimum)
      report.gridMinimum[configuration.mode] = quoted.monthlyTotal;

    const main = dreFromQuote(quoted, table, model, { paymentMethod: 'card', taxRateId }).monthly;
    const entry: GuardConfiguration = {
      configuration: quoted.configuration,
      monthlyTotal: quoted.monthlyTotal,
      contributionMargin: main.contributionMargin,
      contributionMarginRatio: main.contributionMarginRatio,
    };
    worst.add(entry);
    keepWorst(report.worstByMode, configuration.mode, entry);
    keepWorst(report.worstBySize, quoted.configuration.size, entry);
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

  for (const configuration of configurations) {
    const total = totals.get(keyOf(configuration));
    if (total === undefined) continue;
    for (const next of neighbors(configuration, table)) {
      const nextTotal = totals.get(keyOf(next));
      if (nextTotal === undefined || nextTotal >= total) continue;
      report.monotonicity.violations += 1;
      if (report.monotonicity.examples.length < WORST_LIMIT) {
        const from = quote(configuration, table);
        const to = quote(next, table);
        if (from.kind === 'quote' && to.kind === 'quote') {
          report.monotonicity.examples.push({
            from: from.quote.configuration,
            to: to.quote.configuration,
            fromTotal: total,
            toTotal: nextTotal,
          });
        }
      }
    }
  }

  for (const mode of DEPLOYMENT_MODES) {
    const start = startingAt(table, mode);
    if (start !== undefined) report.startingAt[mode] = start.monthly;
  }
  const startingAtIsMinimum = DEPLOYMENT_MODES.every(
    (mode) => report.startingAt[mode] === report.gridMinimum[mode],
  );
  if (!startingAtIsMinimum) report.problems.push('o "a partir de" não é o menor preço da grade');
  // Um pacote de partida que cai em "sob consulta" levaria o site a um botão que não cota.
  for (const preset of table.presets) {
    const outcome = quote(preset.configuration, table);
    if (outcome.kind !== 'quote')
      report.problems.push(`pacote de partida ${preset.id} fica sob consulta (${outcome.reason})`);
  }

  report.belowMinimum = { count: below.count, configurations: below.items };
  report.belowAlert = { count: alert.count, configurations: alert.items };
  report.worst = worst.items;
  report.otherScenarios = scenarios;
  report.ok = report.problems.length === 0 && below.count === 0 && report.monotonicity.violations === 0;
  return report;
}
