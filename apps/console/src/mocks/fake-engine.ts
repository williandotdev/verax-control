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
  Machine,
  PaymentMethod,
  PlanId,
  PriceTable,
  Quote,
  QuoteLineItem,
} from '@/lib/api-types';

/**
 * Uma cópia reduzida do motor do plano de controle (`apps/control-plane/src/pricing/quote.ts`, `dre.ts` e
 * `publish-guard.ts`), só para a API simulada dos testes e das capturas: as mesmas fórmulas sobre as tabelas FICTÍCIAS,
 * para a tela mostrar números que fecham. Não é a fonte da verdade: a cotação, a DRE e a checagem de verdade são as da
 * API (e os testes do plano de controle conferem as contas).
 */

type QuoteOutcome = { kind: 'quote'; quote: Quote } | { kind: 'contact_us'; reason: ContactReason };

const PLANS: readonly PlanId[] = ['plataforma', 'dedicado', 'vciso'];
const PLAN_MODES: Readonly<Record<PlanId, readonly DeploymentMode[]>> = {
  plataforma: ['managed'],
  dedicado: ['managed', 'self_hosted'],
  vciso: ['managed', 'self_hosted'],
};

function range(table: PriceTable, plan: PlanId): { min: number; max: number } {
  const { plataforma, dedicado } = table.plans;
  return plan === 'plataforma'
    ? { min: plataforma.includedGbDay, max: plataforma.maxOnlineGbDay }
    : { min: dedicado.minGbDay, max: dedicado.maxGbDay };
}

function itemsOf(table: PriceTable, plan: PlanId, gbDay: number): QuoteLineItem[] {
  const item = (entry: Omit<QuoteLineItem, 'amount'>): QuoteLineItem => ({
    ...entry,
    amount: entry.unitAmount * entry.quantity,
  });
  const { plataforma, dedicado, vciso } = table.plans;
  if (plan === 'plataforma') {
    const items = [
      item({
        component: 'base',
        variant: 'plataforma',
        lookupKey: plataforma.base.lookupKey,
        quantity: 1,
        unitAmount: plataforma.base.amount,
        recurring: true,
      }),
    ];
    if (gbDay > plataforma.includedGbDay) {
      items.push(
        item({
          component: 'additional_gb_day',
          variant: 'plataforma',
          lookupKey: plataforma.additionalGbDay.lookupKey,
          quantity: gbDay - plataforma.includedGbDay,
          unitAmount: plataforma.additionalGbDay.amount,
          recurring: true,
        }),
      );
    }
    return items;
  }
  const items = [
    item({
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
      item({
        component: 'service',
        variant: 'vciso',
        lookupKey: vciso.service.lookupKey,
        quantity: 1,
        unitAmount: vciso.service.amount,
        recurring: true,
      }),
      item({
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

export function quote(input: ConfigurationInput, table: PriceTable): QuoteOutcome {
  if (!PLAN_MODES[input.plan].includes(input.mode)) return { kind: 'contact_us', reason: 'mode_unavailable' };
  const limits = range(table, input.plan);
  const gbDay = Math.max(input.gbDay, limits.min);
  if (gbDay > limits.max) {
    return { kind: 'contact_us', reason: input.plan === 'plataforma' ? 'above_online_max' : 'above_max' };
  }
  const rule = table.sizing.sizes.find((size) => gbDay <= size.maxGbDay);
  if (rule === undefined) return { kind: 'contact_us', reason: 'above_largest_size' };
  const configuration: Configuration = {
    plan: input.plan,
    mode: input.mode,
    gbDay,
    size: rule.size,
    historyDays: table.history.includedDays,
  };
  const items = itemsOf(table, input.plan, gbDay);
  const monthlyTotal = items.filter((entry) => entry.recurring).reduce((sum, entry) => sum + entry.amount, 0);
  const setupTotal = items.filter((entry) => !entry.recurring).reduce((sum, entry) => sum + entry.amount, 0);
  const { plataforma, dedicado } = table.plans;
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
        maxCloudAccounts:
          input.plan === 'plataforma' ? plataforma.maxCloudAccounts : dedicado.maxCloudAccounts,
        monthlyGib: Math.ceil((gbDay * 31 * 1e9) / 2 ** 30),
        historyDays: table.history.includedDays,
        maxAgents: 0,
        maxUsers: table.users.max,
      },
      included: {
        gbDay: input.plan === 'plataforma' ? plataforma.includedGbDay : 0,
        historyDays: table.history.includedDays,
        users: table.users.max,
      },
    },
  };
}

function machineUsd(machine: Machine, model: CostModel): number {
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

function dedicatedUsd(configuration: Configuration, model: CostModel): number {
  const size = model.infrastructure.sizes[configuration.size] ?? {
    vmUsdPerMonth: 0,
    diskGb: 0,
    snapshotGib: 0,
  };
  return machineUsd(size, model) + configuration.gbDay * model.infrastructure.ingestionUsdPerGbDay;
}

function cloudUsd(configuration: Configuration, model: CostModel): number {
  const infra = model.infrastructure;
  if (configuration.plan !== 'plataforma') return dedicatedUsd(configuration, model);
  const cell = infra.sharedCell;
  return (
    (machineUsd(cell, model) / cell.capacityGbDay) * configuration.gbDay +
    cell.perCustomerUsdPerMonth +
    configuration.gbDay * infra.ingestionUsdPerGbDay
  );
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
  const grossOf = (amount: number): { gross: number; taxes: number } => {
    if (table.taxMode === 'exclusive' && tax < 1) {
      const gross = cents(amount / (1 - tax));
      return { gross, taxes: gross - amount };
    }
    return { gross: amount, taxes: cents(amount * tax) };
  };
  const configuration = quoted.configuration;
  const managed = configuration.mode === 'managed';
  const selfHosted = !managed;
  const fx = model.exchange.brlPerUsd * 100;
  const fees = model.paymentFees;
  const hours = model.support.hours;
  const tableRevenue = cents(quoted.monthlyTotal * (1 - (options.discountRate ?? 0)));
  const { gross: grossRevenue, taxes } = grossOf(tableRevenue);
  const refundReserve = cents(grossRevenue * model.refundReserveRate);
  const netRevenue = grossRevenue - taxes - refundReserve;
  const infrastructure = managed
    ? cents(cloudUsd(configuration, model) * fx * (1 + model.exchange.cloudBuffer))
    : 0;
  const paymentFees =
    options.paymentMethod === 'card'
      ? cents(grossRevenue * (fees.card.rate + fees.billingRate) + fees.card.fixed)
      : cents(fees.boleto.fixed + grossRevenue * fees.billingRate);
  const supportHours =
    (configuration.plan === 'plataforma'
      ? hours.plataforma
      : hours.dedicado + (configuration.plan === 'vciso' ? hours.vcisoService : 0)) +
    (selfHosted ? hours.selfHosted : 0);
  const support = cents(supportHours * model.support.hourlyCost);
  const contributionMargin = netRevenue - infrastructure - paymentFees - support;
  const totalFixed = model.fixedCosts.items.reduce((sum, item) => sum + item.monthly, 0);
  const fixedCosts = cents(
    totalFixed / Math.max(1, options.allocationCustomers ?? model.fixedCosts.allocationCustomers),
  );
  const result = contributionMargin - fixedCosts;
  const setup = grossOf(quoted.setupTotal);
  const setupSupportHours =
    (configuration.plan === 'plataforma'
      ? hours.setupPlataforma
      : hours.setupDedicado + (configuration.plan === 'vciso' ? hours.setupVciso : 0)) +
    (selfHosted ? hours.setupSelfHosted : 0);
  const setupReserve = cents(setup.gross * model.refundReserveRate);
  const setupFees =
    options.paymentMethod === 'card'
      ? cents(setup.gross * (fees.card.rate + fees.billingRate))
      : cents(setup.gross * fees.billingRate);
  const setupSupport = cents(setupSupportHours * model.support.hourlyCost);
  const setupMargin = setup.gross - setup.taxes - setupReserve - setupFees - setupSupport;
  const estimate = managed ? 0 : cents(dedicatedUsd(configuration, model) * fx);
  const spread = model.customerCloudEstimateSpread;
  return {
    quote: quoted,
    paymentMethod: options.paymentMethod,
    taxRateId,
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
      revenue: setup.gross,
      taxes: setup.taxes,
      refundReserve: setupReserve,
      paymentFees: setupFees,
      supportHours: setupSupportHours,
      support: setupSupport,
      contributionMargin: setupMargin,
      contributionMarginRatio: setup.gross === 0 ? null : ratio(setupMargin, setup.gross),
    },
    twelveMonths: {
      grossRevenue: 12 * grossRevenue + setup.gross,
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
    worstByPlan: {},
    worstByMode: {},
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
  for (const plan of PLANS) {
    const limits = range(table, plan);
    for (const mode of PLAN_MODES[plan]) {
      for (let gbDay = limits.min; gbDay <= limits.max; gbDay += 1) {
        const outcome = quote({ plan, gbDay, mode }, table);
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
        if (mode === 'managed') {
          const minimum = report.gridMinimum[plan];
          if (minimum === undefined || entry.monthlyTotal < minimum)
            report.gridMinimum[plan] = entry.monthlyTotal;
        }
        const byPlan = report.worstByPlan[plan];
        if (byPlan === undefined || worse(entry, byPlan) < 0) report.worstByPlan[plan] = entry;
        const byMode = report.worstByMode[mode];
        if (byMode === undefined || worse(entry, byMode) < 0) report.worstByMode[mode] = entry;
        for (const scenario of scenarios) {
          const lines = dre(outcome.quote, table, model, scenario).monthly;
          const candidate = {
            ...entry,
            contributionMargin: lines.contributionMargin,
            contributionMarginRatio: lines.contributionMarginRatio,
          };
          if (scenario.worst === null || worse(candidate, scenario.worst) < 0) scenario.worst = candidate;
        }
      }
    }
    const start = quote({ plan, gbDay: limits.min, mode: 'managed' }, table);
    if (start.kind === 'quote') report.startingAt[plan] = start.quote.monthlyTotal;
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
  report.ok = below.length === 0;
  return report;
}
