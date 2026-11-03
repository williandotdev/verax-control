import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  type AssetKind,
  type AssetListQuery,
  assetSchemas,
  inventorySummarySchema,
  paginatedSchema,
} from '@verax/shared';
import { api } from '@/lib/api';

/** Conta root de cada conta e quantos ativos há de cada tipo, e quantos com risco (T5.9). */
export function useInventorySummary(enabled: boolean) {
  return useQuery({
    queryKey: ['assets', 'summary'],
    queryFn: () => api.get('/v1/assets', inventorySummarySchema),
    enabled,
  });
}

/** Ativos de um tipo, do maior risco ao menor. */
export function useAssets<K extends AssetKind>(kind: K, query: AssetListQuery, enabled: boolean) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const schema = paginatedSchema(assetSchemas[kind]);
  return useQuery({
    queryKey: ['assets', kind, query],
    queryFn: () => api.get(`/v1/assets/${kind}?${params.toString()}`, schema),
    enabled,
    placeholderData: keepPreviousData,
  });
}
