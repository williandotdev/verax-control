import { z } from 'zod';

/**
 * Volume por dia (CE-09, célula compartilhada): o que o nó mede por cliente, dia do calendário de Brasília e fonte
 * (`IngestUsageDay`), e o relatório `usage.daily` que a célula manda ao plano de controle. É a base da franquia da
 * Plataforma em GB/dia (`franchise.ts`) e do excedente.
 *
 * A regra do volume é a do medidor de uso (`apps/api/src/usage/usage-meter.ts`): os bytes UTF-8 de cada registro já
 * descompactado, contando também o que nenhuma regra acusa. O que conta na franquia:
 * - `aws`: os logs dos buckets do cliente (CloudTrail, GuardDuty e WAF), medidos na origem;
 * - `gcp`: as mensagens do Pub/Sub dos projetos do cliente, no dia do `publishTime`;
 * - `cloudflare`: as entradas da auditoria da conta, no dia de cada entrada.
 * Os eventos de segurança do Cloudflare (GraphQL) **não** contam: são agregados do tamanho da consulta da Verax, não o
 * volume do cliente, e ficam só na medida operacional do mês (`IngestUsage`).
 */
export const METERED_SOURCES = ['aws', 'gcp', 'cloudflare'] as const;
export type MeteredSource = (typeof METERED_SOURCES)[number];

/** Brasília está em UTC-3 o ano todo (sem horário de verão desde 2019): o dia vira às 03:00 UTC. */
export const BRASILIA_OFFSET_MS = 3 * 60 * 60 * 1000;

const DAY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Um dia do calendário (`AAAA-MM-DD`) que existe: 2026-02-30 é recusado. */
export function isCalendarDay(value: string): boolean {
  if (!DAY_PATTERN.test(value)) return false;
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export const usageDaySchema = z.string().refine(isCalendarDay, { error: 'dia no formato AAAA-MM-DD' });

/** O dia do calendário de Brasília de um instante (`AAAA-MM-DD`). */
export function brasiliaDay(at: Date): string {
  return new Date(at.getTime() - BRASILIA_OFFSET_MS).toISOString().slice(0, 10);
}

/** O dia `days` dias depois (ou antes, com negativo), no mesmo calendário. */
export function addDays(day: string, days: number): string {
  const base = new Date(`${day}T00:00:00Z`);
  return new Date(base.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/** O dia como a coluna `date` do banco o guarda: meia-noite UTC daquele dia. */
export function dayAsDate(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

/** O dia da coluna `date` do banco (meia-noite UTC) de volta para `AAAA-MM-DD`. */
export function dayOfDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Hora de Brasília do dia seguinte a partir da qual o dia está fechado (`final`): 06:00. */
export const USAGE_DAY_FINAL_HOUR = 6;

/**
 * O instante em que o dia fecha: 06:00 de Brasília do dia seguinte (09:00 UTC). Até lá, a medida do dia ainda pode
 * crescer (um objeto da AWS criado às 23:59 só é lido na hora seguinte; uma mensagem da GCP publicada no fim do dia
 * pode ser lida depois da meia-noite).
 */
export function usageDayFinalAt(day: string): Date {
  return new Date(
    dayAsDate(addDays(day, 1)).getTime() + USAGE_DAY_FINAL_HOUR * 3_600_000 + BRASILIA_OFFSET_MS,
  );
}

/** O dia já fechou: o relatório dele vai com `final: true`. */
export function isUsageDayFinal(day: string, now: Date): boolean {
  return now.getTime() >= usageDayFinalAt(day).getTime();
}

const counterSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Bytes e registros de uma fonte num dia. */
export const usageDayCountersSchema = z.strictObject({ bytes: counterSchema, events: counterSchema });
export type UsageDayCounters = z.infer<typeof usageDayCountersSchema>;

/**
 * Relatório `usage.daily` da célula ao plano de controle (CE-09; o canal e a fila de saída são do CE-05). Os valores
 * são **absolutos** (o total do dia até agora, não a diferença desde o último envio): mandar de novo não soma nada, e o
 * plano de controle guarda sempre o último. Todas as fontes vão, com zero quando não houve leitura: o dia sem volume é
 * um dia medido, não um dia que falta. `final` só depois das 06:00 de Brasília do dia seguinte
 * (`isUsageDayFinal`); depois dele, uma correção vai para o registro, mas não para a fatura.
 */
export const usageDailyReportSchema = z.strictObject({
  tenantId: z.uuid(),
  day: usageDaySchema,
  sources: z.strictObject({
    aws: usageDayCountersSchema,
    gcp: usageDayCountersSchema,
    cloudflare: usageDayCountersSchema,
  }),
  final: z.boolean(),
});
export type UsageDailyReport = z.infer<typeof usageDailyReportSchema>;
