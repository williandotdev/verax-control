import { FINDING_PERIODS, FINDING_SEVERITIES, FINDING_STATUSES, type FindingListQuery } from '@verax/shared';

/** Parâmetros da URL (em português) e o filtro da API que cada um alimenta. */
export const FINDING_FILTER_PARAMS = {
  severity: 'severidade',
  status: 'status',
  accountId: 'conta',
  period: 'periodo',
} as const;
export type FindingFilterKey = keyof typeof FINDING_FILTER_PARAMS;

const pick = <T extends string>(allowed: readonly T[], value: string | null): T | undefined =>
  allowed.find((candidate) => candidate === value);

/** Filtros lidos da URL; valor desconhecido é ignorado, nunca enviado à API. */
export function readFindingFilters(params: URLSearchParams): Omit<FindingListQuery, 'page' | 'pageSize'> {
  const account = params.get(FINDING_FILTER_PARAMS.accountId);
  return {
    severity: pick(FINDING_SEVERITIES, params.get(FINDING_FILTER_PARAMS.severity)),
    status: pick(FINDING_STATUSES, params.get(FINDING_FILTER_PARAMS.status)),
    accountId: account && /^\d{12}$/.test(account) ? account : undefined,
    period: pick(FINDING_PERIODS, params.get(FINDING_FILTER_PARAMS.period)),
  };
}
