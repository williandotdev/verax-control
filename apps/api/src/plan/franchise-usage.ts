import {
  addDays,
  brasiliaDay,
  currentBillingCycle,
  cycleBudgetGb,
  dayAsDate,
  dayOfDate,
  FRANCHISE_CHART_DAYS,
  type FranchiseSchedule,
  type FranchiseUsage,
  franchiseUsageSchema,
  METERED_SOURCES,
  type MeteredSource,
  projectedOverageUnits,
} from '@verax/shared';
import type { Prisma } from '../generated/prisma/client.js';

/** Uma linha do volume por dia, como o banco a guarda. */
export interface UsageDayRow {
  day: Date;
  source: string;
  bytes: bigint;
}

function safeBytes(value: bigint): number {
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}

function isMeteredSource(source: string): source is MeteredSource {
  return (METERED_SOURCES as readonly string[]).includes(source);
}

/**
 * A agenda da franquia do ciclo. Hoje, a franquia gravada no plano do cliente (`TenantPlan.franchiseGbPerDay`) vale
 * desde o dia 1º: a franquia só muda pelo plano de controle, e a ampliação pelo painel (CE-19) é que traz a agenda com
 * as mudanças no meio do ciclo, no estado desejado.
 */
export function franchiseScheduleOf(franchiseGbPerDay: number, cycleStart: string): FranchiseSchedule {
  return [{ from: cycleStart, gbPerDay: franchiseGbPerDay }];
}

/**
 * O contador da franquia (CE-10) a partir do volume por dia do cliente: o ciclo (o mês de Brasília), o dia `k` de `D`,
 * o orçamento `B = Σ F_d`, o volume do ciclo até agora `U_k` (hoje incluído), a média `U_k / k`, a projeção
 * `U_k / k × D`, o excedente projetado em centésimos de GB/dia (para baixo) e os últimos 30 dias por fonte. Os dias sem
 * linha contam zero.
 */
export function franchiseUsageOf(
  franchiseGbPerDay: number,
  rows: readonly UsageDayRow[],
  now: Date,
  schedule?: FranchiseSchedule,
): FranchiseUsage {
  const cycle = currentBillingCycle(now);
  const today = brasiliaDay(now);
  const agenda = schedule ?? franchiseScheduleOf(franchiseGbPerDay, cycle.start);
  const byDay = new Map<string, Record<MeteredSource, number>>();
  for (const row of rows) {
    if (!isMeteredSource(row.source)) continue;
    const day = dayOfDate(row.day);
    const totals = byDay.get(day) ?? { aws: 0, gcp: 0, cloudflare: 0 };
    totals[row.source] += safeBytes(row.bytes);
    byDay.set(day, totals);
  }
  let used = 0;
  for (let day = cycle.start; day <= today; day = addDays(day, 1)) {
    const totals = byDay.get(day);
    if (totals !== undefined) used += totals.aws + totals.gcp + totals.cloudflare;
  }
  const budgetGb = cycleBudgetGb(agenda, cycle);
  const firstChartDay = addDays(today, -(FRANCHISE_CHART_DAYS - 1));
  return franchiseUsageSchema.parse({
    cycle,
    franchiseGbPerDay,
    schedule: agenda,
    budgetGb,
    usedBytes: used,
    dailyAverageBytes: Math.floor(used / cycle.day),
    projectedBytes: Math.floor((used * cycle.days) / cycle.day),
    projectedOverageUnits: projectedOverageUnits(used, budgetGb, cycle.day, cycle.days),
    days: Array.from({ length: FRANCHISE_CHART_DAYS }, (_, index) => {
      const day = addDays(firstChartDay, index);
      return { day, ...(byDay.get(day) ?? { aws: 0, gcp: 0, cloudflare: 0 }) };
    }),
  });
}

/**
 * Lê o volume por dia do cliente (no escopo dele, que só lê o `IngestUsageDay`) do mais antigo entre o dia 1º do ciclo
 * e o primeiro dos 30 dias do gráfico, até hoje, e monta o contador.
 */
export async function readFranchiseUsage(
  scoped: Prisma.TransactionClient,
  franchiseGbPerDay: number,
  now: Date,
): Promise<FranchiseUsage> {
  const cycle = currentBillingCycle(now);
  const today = brasiliaDay(now);
  const chartStart = addDays(today, -(FRANCHISE_CHART_DAYS - 1));
  const from = chartStart < cycle.start ? chartStart : cycle.start;
  const rows = await scoped.ingestUsageDay.findMany({
    where: { day: { gte: dayAsDate(from), lte: dayAsDate(today) } },
    select: { day: true, source: true, bytes: true },
  });
  return franchiseUsageOf(franchiseGbPerDay, rows, now);
}
