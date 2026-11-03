import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  paginatedSchema,
  unownedAccountsSchema,
  type UnownedAlertListQuery,
  unownedAlertSchema,
  type UnownedPeriod,
} from '@verax/shared';
import { api } from '@/lib/api';

const unownedPageSchema = paginatedSchema(unownedAlertSchema);

function toSearch(query: UnownedAlertListQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

/** Alertas da fila sem dono, com os filtros na query string (só a equipe da Verax). */
export function useUnownedAlerts(query: UnownedAlertListQuery) {
  return useQuery({
    queryKey: ['unowned-alerts', query],
    queryFn: () => api.get(`/v1/unowned-alerts?${toSearch(query)}`, unownedPageSchema),
    placeholderData: keepPreviousData,
  });
}

/** As contas que mais aparecem na fila no período, e onde cada uma está cadastrada. */
export function useUnownedAccounts(period: UnownedPeriod) {
  return useQuery({
    queryKey: ['unowned-accounts', period],
    queryFn: () => api.get(`/v1/unowned-alerts/accounts?period=${period}`, unownedAccountsSchema),
  });
}
