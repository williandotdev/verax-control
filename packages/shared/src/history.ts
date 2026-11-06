import { z } from 'zod';
import { PLAN_LIMIT_BOUNDS, resolvedPlanSchema } from './plans.js';

/**
 * Histórico do plano nas telas (fase 2, PR-20). O banco do nó guarda achados, incidentes e postura pelo histórico do
 * plano (`historyDays`: 90 dias no Essencial, 365 no Profissional, sem limite no Interno), e o expurgo diário (PR-19)
 * tira o que passou dele. Os filtros de período de achados, auditoria e relatórios alcançam no máximo esse histórico:
 * a API recusa (400) o período mais longo, e o painel só oferece os que cabem.
 */

/** Dias de cada período dos filtros. `12m` são 365 dias, o histórico do Profissional. */
export const HISTORY_PERIOD_DAYS = { '24h': 1, '7d': 7, '30d': 30, '90d': 90, '12m': 365 } as const;
export type HistoryPeriod = keyof typeof HISTORY_PERIOD_DAYS;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Início do período que termina em `now`. */
export function historyPeriodStart(period: HistoryPeriod, now: Date): Date {
  return new Date(now.getTime() - HISTORY_PERIOD_DAYS[period] * DAY_MS);
}

/**
 * Histórico que todo plano tem (o piso dos ajustes, 30 dias). O painel oferece só os períodos até ele enquanto não sabe
 * o plano do nó: nunca um período que a API recusaria.
 */
export const MIN_HISTORY_DAYS = PLAN_LIMIT_BOUNDS.historyDays.min;

/** O período cabe no histórico do plano (`null` é sem limite). */
export function periodFitsHistory(period: HistoryPeriod, historyDays: number | null): boolean {
  return historyDays === null || HISTORY_PERIOD_DAYS[period] <= historyDays;
}

/** Os períodos da lista que cabem no histórico, na mesma ordem. */
export function periodsWithinHistory<P extends HistoryPeriod>(
  periods: readonly P[],
  historyDays: number | null,
): P[] {
  return periods.filter((period) => periodFitsHistory(period, historyDays));
}

/** Código da recusa (400) do período mais longo que o histórico do plano. */
export const PERIOD_BEYOND_HISTORY_CODE = 'PERIOD_BEYOND_PLAN_HISTORY';

/** Mensagem da recusa, a mesma na API e na demonstração: diz o histórico do plano e o que fazer. */
export function periodBeyondHistoryMessage(historyDays: number): string {
  return `Seu plano guarda ${historyDays} dias de histórico. Escolha um período menor ou fale com a Verax para ampliar.`;
}

/**
 * Por quanto tempo o evento bruto do log fica no índice do Wazuh (a política ISM do indexer, `ALERT_RETENTION_DAYS`,
 * decisão D-6). Depois disso, o detalhe do achado mostra só os campos guardados nele, que seguem o histórico do plano.
 */
export const RAW_EVENT_RETENTION_DAYS = 30;

/**
 * `GET /v1/plan/history`: o histórico do plano do nó, o mesmo para toda sessão. Todos os papéis leem (os filtros de
 * período de achados e relatórios são de todos); o resto do plano e o uso continuam só no `GET /v1/plan`.
 */
export const planHistorySchema = z.strictObject({
  historyDays: resolvedPlanSchema.shape.limits.shape.historyDays,
});
export type PlanHistory = z.infer<typeof planHistorySchema>;
