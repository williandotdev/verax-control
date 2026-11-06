import type {
  Configuration,
  ConfigurationInput,
  ContactReason,
  CostModel,
  DeploymentMode,
  DreResult,
  GuardConfiguration,
  GuardReport,
  GuardScenario,
  PaymentMethod,
  PriceTable,
  Quote,
  QuoteLineItem,
  SizeId,
} from '@/lib/api-types';

/**
 * Uma cópia reduzida do motor do plano de controle (`apps/control-plane/src/pricing/quote.ts`, `dre.ts` e
 * `publish-guard.ts`), só para a API simulada dos testes e das capturas: as mesmas fórmulas sobre as tabelas FICTÍCIAS,
 * para a tela mostrar números que fecham. Não é a fonte da verdade: a cotação, a DRE e a checagem de verdade são as da
 * API (e os testes do plano de controle conferem as contas).
 */

type QuoteOutcome = { kind: 'quote'; quote: Quote } | { kind: 'contact_us'; reason: ContactReason };

export function quote(input: ConfigurationInput, table: PriceTable): QuoteOutcome {
  const cloudAccounts = Math.max(input.cloudAccounts, table.cloudAccounts.included);
  if (cloudAccounts > table.cloudAccounts.max)
    return { kind: 'contact_us', reason: 'cloud_accounts_above_max' };
  let monthlyGib = table.volume.includedMonthlyGib;
  if (input.monthlyGib > monthlyGib) {
    const band = table.volume.bands.find((option) => option.monthlyGib >= input.monthlyGib);
    if (band === undefined) return { kind: 'contact_us', reason: 'volume_above_max' };
    monthlyGib = band.monthlyGib;
  }
  const agentPacks = Math.ceil(input.agents / table.agents.packSize);
  if (agentPacks > table.agents.maxPacks) return { kind: 'contact_us', reason: 'agents_above_max' };
  let historyDays = table.history.includedDays;
  if (input.historyDays > historyDays) {
    const option = table.history.extended.find((extended) => extended.days >= input.historyDays);
    if (option === undefined) return { kind: 'contact_us', reason: 'history_above_max' };
    historyDays = option.days;
  }
  const agents = agentPacks * table.agents.packSize;
  const rule = table.sizing.sizes.find(
    (size) =>
      cloudAccounts <= size.maxCloudAccounts && monthlyGib <= size.maxMonthlyGib && agents <= size.maxAgents,
  );
  if (rule === undefined) return { kind: 'contact_us', reason: 'above_largest_size' };
  const configuration: Configuration = {
    mode: input.mode,
    size: rule.size,
    cloudAccounts,
    monthlyGib,
    agents,
    historyDays,
    support: input.support,
  };
  const pricing = table.modes[input.mode];
  const environment = pricing.environment[rule.size];
  if (environment === undefined) throw new TypeError('tabela fictícia sem o porte');
  const item = (entry: Omit<QuoteLineItem, 'amount'>): QuoteLineItem => ({
    ...entry,
    amount: entry.unitAmount * entry.quantity,
  });
  const items: QuoteLineItem[] = [
    item({
      component: 'environment',
      variant: `${input.mode}_${rule.size}`,
      lookupKey: environment.lookupKey,
      quantity: 1,
      unitAmount: environment.amount,
      recurring: true,
    }),
  ];
  if (cloudAccounts > table.cloudAccounts.included) {
    items.push(
      item({
        component: 'cloud_accounts',
        variant: 'additional',
        lookupKey: table.cloudAccounts.additional.lookupKey,
        quantity: cloudAccounts - table.cloudAccounts.included,
        unitAmount: table.cloudAccounts.additional.amount,
        recurring: true,
      }),
    );
  }
  const band = table.volume.bands.find((option) => option.monthlyGib === monthlyGib);
  if (band !== undefined) {
    items.push(
      item({
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
      item({
        component: 'agents',
        variant: String(table.agents.packSize),
        lookupKey: table.agents.pack.lookupKey,
        quantity: agentPacks,
        unitAmount: table.agents.pack.amount,
        recurring: true,
      }),
    );
  }
  const history = table.history.extended.find((option) => option.days === historyDays);
  if (history !== undefined) {
    items.push(
      item({
        component: 'history',
        variant: String(history.days),
        lookupKey: history.lookupKey,
        quantity: 1,
        unitAmount: history.amount,
        recurring: true,
      }),
    );
  }
  if (input.support === 'priority') {
    items.push(
      item({
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
      item({
        component: 'setup',
        variant: input.mode,
        lookupKey: pricing.setup.lookupKey,
        quantity: 1,
        unitAmount: pricing.setup.amount,
        recurring: false,
      }),
    );
  }
  const monthlyTotal = items.filter((entry) => entry.recurring).reduce((sum, entry) => sum + entry.amount, 0);
  const setupTotal = items.filter((entry) => !entry.recurring).reduce((sum, entry) => sum + entry.amount, 0);
  return {
    kind: 'quote',
    quote: {
      configuration,
      sizeDescription: rule.description,
      lineItems: items,
      monthlyTotal,
      setupTotal,
      firstInvoiceTotal: monthlyTotal + setupTotal,
      limits: {
        maxCloudAccounts: cloudAccounts,
        monthlyGib,
        historyDays,
        maxAgents: agents,
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

export function dre(
  quoted: Quote,
  table: PriceTable,
  model: CostModel,
  options: {
    paymentMethod: PaymentMethod;
    taxRateId?: string;
    discountRate?: number;
    allocationCustomers?: number;
  },
): DreResult {
  const cents = Math.round;
  const ratio = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole);
  const taxRateId = options.taxRateId ?? model.taxes.defaultRateId;
  const tax = model.taxes.rates.find((rate) => rate.id === taxRateId)?.rate ?? 0;
  const configuration = quoted.configuration;
  const managed = configuration.mode === 'managed';
  const infra = model.infrastructure;
  const size = infra.sizes[configuration.size] ?? { vmUsdPerMonth: 0, diskGb: 0, snapshotGib: 0 };
  const perGib = infra.diskUsdPerGibMonth + infra.snapshotUsdPerGibMonth;
  const cloudUsd =
    size.vmUsdPerMonth +
    size.diskGb * infra.diskUsdPerGibMonth +
    size.snapshotGib * infra.snapshotUsdPerGibMonth +
    infra.natUsdPerVmMonth +
    infra.natIpUsdPerMonth +
    infra.otherUsdPerNodeMonth +
    configuration.monthlyGib * infra.ingestionUsdPerGib +
    (configuration.agents > 0
      ? infra.agents.entryUsdPerMonth +
        (infra.agents.diskBaseGb + configuration.agents * infra.agents.diskPerAgentGb) * perGib
      : 0);
  const fx = model.exchange.brlPerUsd * 100;
  const fees = model.paymentFees;
  const hours = model.support.hours;
  const grossRevenue = cents(quoted.monthlyTotal * (1 - (options.discountRate ?? 0)));
  const taxes = cents(grossRevenue * tax);
  const refundReserve = cents(grossRevenue * model.refundReserveRate);
  const netRevenue = grossRevenue - taxes - refundReserve;
  const infrastructure = managed ? cents(cloudUsd * fx * (1 + model.exchange.cloudBuffer)) : 0;
  const paymentFees =
    options.paymentMethod === 'card'
      ? cents(grossRevenue * (fees.card.rate + fees.billingRate) + fees.card.fixed)
      : cents(fees.boleto.fixed + grossRevenue * fees.billingRate);
  const volumeHours =
    configuration.monthlyGib > table.volume.includedMonthlyGib
      ? (hours.perVolumeBand.find((band) => band.monthlyGib === configuration.monthlyGib)?.hours ?? 0)
      : 0;
  const supportHours =
    (managed ? hours.baseManaged : hours.baseSelfHosted) +
    Math.max(0, configuration.cloudAccounts - table.cloudAccounts.included) * hours.perAdditionalAccount +
    quoted.agentPacks * hours.perAgentPack +
    volumeHours +
    (configuration.support === 'priority' ? hours.prioritySupport : 0);
  const support = cents(supportHours * model.support.hourlyCost);
  const contributionMargin = netRevenue - infrastructure - paymentFees - support;
  const totalFixed = model.fixedCosts.items.reduce((sum, item) => sum + item.monthly, 0);
  const fixedCosts = cents(
    totalFixed / Math.max(1, options.allocationCustomers ?? model.fixedCosts.allocationCustomers),
  );
  const result = contributionMargin - fixedCosts;
  const setupRevenue = quoted.setupTotal;
  const setupSupportHours =
    (managed ? hours.setupManaged : hours.setupSelfHosted) +
    (configuration.support === 'priority' ? hours.setupPriorityExtra : 0);
  const setupTaxes = cents(setupRevenue * tax);
  const setupReserve = cents(setupRevenue * model.refundReserveRate);
  const setupFees =
    options.paymentMethod === 'card'
      ? cents(setupRevenue * (fees.card.rate + fees.billingRate))
      : cents(setupRevenue * fees.billingRate);
  const setupSupport = cents(setupSupportHours * model.support.hourlyCost);
  const setupMargin = setupRevenue - setupTaxes - setupReserve - setupFees - setupSupport;
  const estimate = cents(cloudUsd * fx);
  const spread = model.customerCloudEstimateSpread;
  return {
    quote: quoted,
    paymentMethod: options.paymentMethod,
    taxRateId,
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

function worse(a: GuardConfiguration, b: GuardConfiguration): number {
  return a.contributionMarginRatio - b.contributionMarginRatio || a.monthlyTotal - b.monthlyTotal;
}

/** A checagem da grade (sem a monotonia, que a tabela fictícia não quebra). */
export function guard(table: PriceTable, model: CostModel): GuardReport {
  const taxRateId = model.taxes.defaultRateId;
  const modes: DeploymentMode[] = ['managed', 'self_hosted'];
  const volumes = [table.volume.includedMonthlyGib, ...table.volume.bands.map((band) => band.monthlyGib)];
  const histories = [table.history.includedDays, ...table.history.extended.map((option) => option.days)];
  const all: GuardConfiguration[] = [];
  const report: GuardReport = {
    ok: false,
    problems: [],
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
  const scenarios: GuardScenario[] = [
    ...model.taxes.rates
      .filter((rate) => rate.id !== taxRateId)
      .map((rate): GuardScenario => ({ taxRateId: rate.id, paymentMethod: 'card', worst: null })),
    { taxRateId, paymentMethod: 'boleto', worst: null },
  ];
  for (const mode of modes) {
    for (
      let cloudAccounts = table.cloudAccounts.included;
      cloudAccounts <= table.cloudAccounts.max;
      cloudAccounts += 1
    ) {
      for (const monthlyGib of volumes) {
        for (let packs = 0; packs <= table.agents.maxPacks; packs += 1) {
          for (const historyDays of histories) {
            for (const support of ['standard', 'priority'] as const) {
              const outcome = quote(
                {
                  mode,
                  cloudAccounts,
                  monthlyGib,
                  agents: packs * table.agents.packSize,
                  historyDays,
                  support,
                },
                table,
              );
              if (outcome.kind !== 'quote') {
                report.contactUsConfigurations += 1;
                continue;
              }
              report.checkedConfigurations += 1;
              const monthly = dre(outcome.quote, table, model, { paymentMethod: 'card', taxRateId }).monthly;
              const entry: GuardConfiguration = {
                configuration: outcome.quote.configuration,
                monthlyTotal: outcome.quote.monthlyTotal,
                contributionMargin: monthly.contributionMargin,
                contributionMarginRatio: monthly.contributionMarginRatio,
              };
              all.push(entry);
              const minimum = report.gridMinimum[mode];
              if (minimum === undefined || entry.monthlyTotal < minimum)
                report.gridMinimum[mode] = entry.monthlyTotal;
              const byMode = report.worstByMode[mode];
              if (byMode === undefined || worse(entry, byMode) < 0) report.worstByMode[mode] = entry;
              const sizeId: SizeId = entry.configuration.size;
              const bySize = report.worstBySize[sizeId];
              if (bySize === undefined || worse(entry, bySize) < 0) report.worstBySize[sizeId] = entry;
              for (const scenario of scenarios) {
                const lines = dre(outcome.quote, table, model, scenario).monthly;
                const candidate = {
                  ...entry,
                  contributionMargin: lines.contributionMargin,
                  contributionMarginRatio: lines.contributionMarginRatio,
                };
                if (scenario.worst === null || worse(candidate, scenario.worst) < 0)
                  scenario.worst = candidate;
              }
            }
          }
        }
      }
    }
  }
  all.sort(worse);
  const below = all.filter((entry) => entry.contributionMarginRatio < model.margins.minimum);
  const alert = all.filter(
    (entry) =>
      entry.contributionMarginRatio >= model.margins.minimum &&
      entry.contributionMarginRatio < model.margins.alert,
  );
  report.belowMinimum = { count: below.length, configurations: below.slice(0, 20) };
  report.belowAlert = { count: alert.length, configurations: alert.slice(0, 20) };
  report.worst = all.slice(0, 10);
  report.otherScenarios = scenarios;
  for (const mode of modes) {
    const start = quote(
      {
        mode,
        cloudAccounts: table.cloudAccounts.included,
        monthlyGib: table.volume.includedMonthlyGib,
        agents: 0,
        historyDays: table.history.includedDays,
        support: 'standard',
      },
      table,
    );
    if (start.kind === 'quote') report.startingAt[mode] = start.quote.monthlyTotal;
  }
  report.ok = below.length === 0;
  return report;
}
