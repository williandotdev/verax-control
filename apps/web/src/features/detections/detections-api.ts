import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { type DetectionListQuery, detectionPageSchema } from '@verax/shared';
import { api } from '@/lib/api';

/** A query string de uma listagem: só os campos com valor (um painel novo num nó de antes manda o mínimo). */
export function toSearch(query: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  return params.toString();
}

/** Visão agrupada da tela Detecções: incidentes e achados fora de incidente, numa ordem só (`GET /v1/detections`). */
export function useDetections(query: DetectionListQuery, enabled: boolean) {
  return useQuery({
    queryKey: ['detections', query],
    queryFn: () => api.get(`/v1/detections?${toSearch(query)}`, detectionPageSchema),
    enabled,
    placeholderData: keepPreviousData,
  });
}
