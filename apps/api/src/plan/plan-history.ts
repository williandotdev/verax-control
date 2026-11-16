import { HttpStatus } from '@nestjs/common';
import {
  type HistoryPeriod,
  PERIOD_BEYOND_HISTORY_CODE,
  periodBeyondHistoryMessage,
  periodFitsHistory,
  rangeFitsHistory,
  type ResolvedPlan,
} from '@verax/shared';
import { ApiError } from '../common/http/api-error.js';

/**
 * Recusa (400) o período do filtro mais longo que o histórico do plano do cliente (fase 2, PR-20; por cliente desde o
 * CE-02): antes dele, o expurgo diário (PR-19) já tirou os dados, e a tela mostraria um período pela metade como se
 * fosse inteiro. Sem período ou com o histórico sem limite (plano `interno`), passa.
 */
export function assertPeriodWithinHistory(plan: ResolvedPlan, period: HistoryPeriod | undefined): void {
  assertPeriodWithinHistoryDays(plan.limits.historyDays, period);
}

/** O mesmo, a partir dos dias de histórico (null é sem limite). */
export function assertPeriodWithinHistoryDays(days: number | null, period: HistoryPeriod | undefined): void {
  if (period === undefined || days === null || periodFitsHistory(period, days)) return;
  throw new ApiError(HttpStatus.BAD_REQUEST, periodBeyondHistoryMessage(days), PERIOD_BEYOND_HISTORY_CODE);
}

/**
 * Recusa (400) o intervalo personalizado (tela Detecções) que começa antes do histórico do plano, com o mesmo código e a
 * mesma mensagem do período. Só o começo importa: o fim nunca passa de agora. Sem intervalo ou sem limite, passa.
 */
export function assertRangeWithinHistoryDays(days: number | null, from: string | undefined, now: Date): void {
  if (from === undefined || days === null || rangeFitsHistory(new Date(from), days, now)) return;
  throw new ApiError(HttpStatus.BAD_REQUEST, periodBeyondHistoryMessage(days), PERIOD_BEYOND_HISTORY_CODE);
}
