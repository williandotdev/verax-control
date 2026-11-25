import { type CaseListQuery, type DetectionFilters, MAX_CASE_PAGE } from '@verax/shared';
import type { CaseUrlState } from '@/features/detections/url-state';
import { severityApplies } from './labels';

/** A página cabe no que a API aceita. */
export const casePage = (page: number): number => Math.min(page, MAX_CASE_PAGE);

export const isGrouped = (view: 'cases' | 'vulnerabilities', cases: CaseUrlState): boolean =>
  view === 'vulnerabilities' && cases.grouping !== 'none';

/** A fila agrupada só tem o que está pendente: é o que a API conta. */
export const groupedState = (cases: CaseUrlState): 'pending' | 'investigating' =>
  cases.state === 'investigating' ? 'investigating' : 'pending';

/**
 * A pergunta da lista de casos, a partir da URL: só o que a API aceita (o status é dos alertas; a severidade, só do que está
 * pendente; a fila de vulnerabilidades tem a própria visão). Agrupada, ela só leva os filtros que se veem ali (a API agrupa
 * por estes): os que ficaram na URL de outra lista não valem, nem no CSV.
 */
export function caseListQuery({
  view,
  filters,
  cases,
  page,
  pageSize,
}: {
  view: 'cases' | 'vulnerabilities';
  filters: DetectionFilters;
  cases: CaseUrlState;
  page: number;
  pageSize: number;
}): CaseListQuery {
  const common = { accountId: filters.accountId, q: filters.q, page: casePage(page), pageSize };
  if (isGrouped(view, cases)) {
    return {
      ...common,
      queue: 'vulnerability',
      state: groupedState(cases),
      sort: 'priority',
      severity: filters.severity,
    };
  }
  return {
    ...common,
    queue: view === 'vulnerabilities' ? 'vulnerability' : cases.queue,
    state: cases.state,
    sort: cases.sort,
    severity: severityApplies(cases.state) ? filters.severity : undefined,
    source: filters.source,
    tactic: filters.tactic,
    technique: filters.technique,
    period: filters.period,
    from: filters.from,
    to: filters.to,
  };
}
