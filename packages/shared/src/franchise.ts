import { z } from 'zod';
import { FRANCHISE_GB_PER_DAY_BOUNDS } from './plans.js';
import { addDays, brasiliaDay, METERED_SOURCES, usageDaySchema } from './usage-day.js';

/**
 * Franquia da Plataforma em GB/dia (CE-10): o ciclo, a franquia que vale em cada dia, o orçamento do ciclo e o
 * excedente, numa conta só, que o painel usa hoje para a projeção e o fechamento do ciclo (CE-20) vai usar para a
 * cobrança. Nenhum valor em dinheiro: o preço fica na tabela do plano de controle e chega ao painel pelo estado
 * desejado (CE-19).
 *
 * - **GB = 10⁹ bytes** (não GiB), sobre os bytes do volume por dia (`usage-day.ts`).
 * - **Ciclo:** o mês do calendário de Brasília, do dia 1º ao último dia (a cobrança é ancorada no dia 1º). `D` é o
 *   número de dias do ciclo, e o dia `k` é o de hoje.
 * - **Orçamento do ciclo:** `B = Σ F_d`, a franquia que valia em cada dia do ciclo (`franchiseOnDay`).
 * - **Excedente:** `max(0, U − B) / D`, em centésimos de GB/dia, **arredondado para baixo** (a dúvida a favor do
 *   cliente). É a média diária do ciclo menos a franquia ponderada pelos dias em que valeu: uma ampliação de um dia só
 *   compra 1/D de folga.
 */

/** 1 GB, em bytes: a franquia é contada em GB (10⁹), não em GiB. */
export const GB_BYTES = 1_000_000_000;

/** A unidade do excedente: centésimos de GB/dia. */
export const OVERAGE_UNITS_PER_GB = 100;

/** Dias do gráfico do painel: os últimos 30, hoje incluído. */
export const FRANCHISE_CHART_DAYS = 30;

/** O ciclo de cobrança de um dia: do dia 1º ao último dia do mês, no calendário de Brasília. */
export interface BillingCycle {
  /** Primeiro dia do ciclo (`AAAA-MM-01`). */
  start: string;
  /** Último dia do ciclo. */
  end: string;
  /** O dia `k` do ciclo (1 no dia 1º). */
  day: number;
  /** `D`, o número de dias do ciclo. */
  days: number;
}

/** O ciclo que contém o dia (`AAAA-MM-DD`). */
export function billingCycleOf(day: string): BillingCycle {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const prefix = day.slice(0, 8);
  return { start: `${prefix}01`, end: `${prefix}${String(days).padStart(2, '0')}`, day: date, days };
}

/** O ciclo de agora, no calendário de Brasília. */
export function currentBillingCycle(now: Date): BillingCycle {
  return billingCycleOf(brasiliaDay(now));
}

/** Os dias do ciclo, do primeiro ao último. */
export function cycleDays(cycle: BillingCycle): string[] {
  return Array.from({ length: cycle.days }, (_, index) => addDays(cycle.start, index));
}

const franchiseGbSchema = z
  .number()
  .int()
  .min(FRANCHISE_GB_PER_DAY_BOUNDS.min)
  .max(FRANCHISE_GB_PER_DAY_BOUNDS.max);

/** Uma mudança da franquia: a partir do dia `from`, `gbPerDay` GB/dia. */
export const franchiseChangeSchema = z.strictObject({ from: usageDaySchema, gbPerDay: franchiseGbSchema });
export type FranchiseChange = z.infer<typeof franchiseChangeSchema>;

/**
 * A agenda da franquia: as mudanças em ordem de dia, sem dia repetido. Cada uma vale do dia `from` até a véspera da
 * seguinte. Antes da primeira, não há franquia (0 GB/dia).
 */
export const franchiseScheduleSchema = z
  .array(franchiseChangeSchema)
  .min(1)
  .max(366)
  .refine((changes) => changes.every((change, index) => (changes[index - 1]?.from ?? '') < change.from), {
    error: 'as mudanças da franquia vêm em ordem de dia, sem dia repetido',
  });
export type FranchiseSchedule = z.infer<typeof franchiseScheduleSchema>;

/** A franquia que vale no dia (`F_d`), em GB/dia; 0 antes da primeira mudança. */
export function franchiseOnDay(schedule: readonly FranchiseChange[], day: string): number {
  let gbPerDay = 0;
  for (const change of schedule) {
    if (change.from > day) break;
    gbPerDay = change.gbPerDay;
  }
  return gbPerDay;
}

/** O orçamento do ciclo, `B = Σ F_d`, em GB. */
export function cycleBudgetGb(schedule: readonly FranchiseChange[], cycle: BillingCycle): number {
  return cycleDays(cycle).reduce((sum, day) => sum + franchiseOnDay(schedule, day), 0);
}

function assertCount(name: string, value: number, min: number): void {
  if (!Number.isSafeInteger(value) || value < min)
    throw new RangeError(`${name} deve ser um inteiro ≥ ${min}`);
}

/**
 * O excedente do ciclo fechado, em centésimos de GB/dia: `floor(100 × max(0, U − B) / D)`, com `U` em GB. A conta é
 * feita em inteiros (BigInt): nenhum arredondamento do ponto flutuante tira ou põe um centésimo.
 */
export function overageUnits(usedBytes: number, budgetGb: number, days: number): number {
  assertCount('usedBytes', usedBytes, 0);
  assertCount('budgetGb', budgetGb, 0);
  assertCount('days', days, 1);
  const excess = BigInt(usedBytes) - BigInt(budgetGb) * BigInt(GB_BYTES);
  if (excess <= 0n) return 0;
  return Number((excess * BigInt(OVERAGE_UNITS_PER_GB)) / (BigInt(days) * BigInt(GB_BYTES)));
}

/**
 * O excedente projetado do ciclo em curso: o mesmo `overageUnits`, com `U` trocado pela projeção `U_k / k × D` (a média
 * dos dias até hoje, mantida até o fim do ciclo). Em inteiros: `floor(100 × max(0, U_k × D − B × k) / (k × D))`.
 */
export function projectedOverageUnits(
  usedBytes: number,
  budgetGb: number,
  day: number,
  days: number,
): number {
  assertCount('usedBytes', usedBytes, 0);
  assertCount('budgetGb', budgetGb, 0);
  assertCount('day', day, 1);
  assertCount('days', days, 1);
  const k = BigInt(day);
  const total = BigInt(days);
  const excess = BigInt(usedBytes) * total - BigInt(budgetGb) * BigInt(GB_BYTES) * k;
  if (excess <= 0n) return 0;
  return Number((excess * BigInt(OVERAGE_UNITS_PER_GB)) / (k * total * BigInt(GB_BYTES)));
}

const bytesSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** O volume de um dia por fonte, em bytes (o gráfico do painel). */
export const franchiseDaySchema = z.strictObject({
  day: usageDaySchema,
  aws: bytesSchema,
  gcp: bytesSchema,
  cloudflare: bytesSchema,
});
export type FranchiseDay = z.infer<typeof franchiseDaySchema>;

/** As fontes que somam na franquia, na ordem do gráfico. */
export const FRANCHISE_SOURCES = METERED_SOURCES;

/**
 * O contador da franquia no `GET /v1/plan` (CE-10), só para o cliente com franquia no plano (a Plataforma, na célula).
 * Os volumes vão em bytes; o painel mostra em GB (10⁹).
 */
export const franchiseUsageSchema = z.strictObject({
  cycle: z.strictObject({
    start: usageDaySchema,
    end: usageDaySchema,
    /** O dia `k` de hoje. */
    day: z.number().int().min(1).max(31),
    /** `D`, os dias do ciclo. */
    days: z.number().int().min(28).max(31),
  }),
  /** A franquia contratada que vale hoje, em GB/dia. */
  franchiseGbPerDay: franchiseGbSchema,
  /** A agenda da franquia que vale no ciclo (a primeira mudança é a que já valia no dia 1º). */
  schedule: franchiseScheduleSchema,
  /** `B = Σ F_d`, o orçamento do ciclo, em GB. */
  budgetGb: z.number().int().min(0),
  /** `U_k`, o volume do ciclo até agora (hoje incluído), em bytes. */
  usedBytes: bytesSchema,
  /** `U_k / k`, a média diária do ciclo, em bytes (para baixo). */
  dailyAverageBytes: bytesSchema,
  /** `U_k / k × D`, a projeção do ciclo, em bytes (para baixo). */
  projectedBytes: bytesSchema,
  /** O excedente projetado, em centésimos de GB/dia (`projectedOverageUnits`). */
  projectedOverageUnits: z.number().int().min(0),
  /** Os últimos 30 dias, do mais antigo a hoje, por fonte. */
  days: z.array(franchiseDaySchema).max(FRANCHISE_CHART_DAYS),
});
export type FranchiseUsage = z.infer<typeof franchiseUsageSchema>;
