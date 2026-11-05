import { useQuery } from '@tanstack/react-query';
import {
  type HistoryPeriod,
  MIN_HISTORY_DAYS,
  type PlanHistory,
  planHistorySchema,
  periodsWithinHistory,
} from '@verax/shared';
import { api } from '@/lib/api';

/**
 * Histórico do plano do nó (`GET /v1/plan/history`, fase 2, PR-20): todos os papéis leem, porque os filtros de período
 * de achados e relatórios são de todos. O plano só muda com o nó reiniciado, então a resposta vale por um bom tempo.
 */
export function usePlanHistory() {
  return useQuery({
    queryKey: ['plan-history'],
    queryFn: () => api.get('/v1/plan/history', planHistorySchema),
    staleTime: 10 * 60_000,
  });
}

/**
 * Os períodos que a tela oferece: os que cabem no histórico do plano. Sem a resposta (ainda carregando ou com erro), só
 * os que todo plano tem (até 30 dias): a tela nunca oferece um período que a API recusaria.
 */
export function offeredPeriods<P extends HistoryPeriod>(
  periods: readonly P[],
  history: PlanHistory | undefined,
): P[] {
  return periodsWithinHistory(periods, history === undefined ? MIN_HISTORY_DAYS : history.historyDays);
}

export interface PeriodFilter<P extends HistoryPeriod> {
  /** Os períodos do seletor, na ordem da lista da tela. */
  options: P[];
  /** O período pedido na URL, se ele cabe no plano; senão, nenhum (a tela usa o padrão dela). */
  period: P | undefined;
  /**
   * A URL pede um período além do piso e o plano ainda não chegou: a tela espera, em vez de pedir um período diferente
   * do escolhido e logo depois o certo.
   */
  waiting: boolean;
}

/** O filtro de período de uma tela, pelo histórico do plano. */
export function usePeriodFilter<P extends HistoryPeriod>(
  periods: readonly P[],
  requested: string | null,
): PeriodFilter<P> {
  const history = usePlanHistory();
  const options = offeredPeriods(periods, history.data);
  const known = periods.find((candidate) => candidate === requested);
  const period = options.find((candidate) => candidate === known);
  return { options, period, waiting: history.isPending && known !== undefined && period === undefined };
}
