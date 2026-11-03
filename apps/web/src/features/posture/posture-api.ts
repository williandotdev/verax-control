import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  paginatedSchema,
  type PostureCheckListQuery,
  postureCheckSchema,
  postureOverviewSchema,
} from '@verax/shared';
import { api } from '@/lib/api';

const checkPageSchema = paginatedSchema(postureCheckSchema);

/** Nota do cliente e de cada conta, com a evolução (T5.8). */
export function usePostureOverview(enabled: boolean) {
  return useQuery({
    queryKey: ['posture'],
    queryFn: () => api.get('/v1/posture', postureOverviewSchema),
    enabled,
  });
}

/** Checagens reprovadas na última varredura, da mais grave para a menos grave. */
export function usePostureChecks(query: PostureCheckListQuery, enabled: boolean) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return useQuery({
    queryKey: ['posture-checks', query],
    queryFn: () => api.get(`/v1/posture/checks?${params.toString()}`, checkPageSchema),
    enabled,
    placeholderData: keepPreviousData,
  });
}
