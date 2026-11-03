import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  incidentAssigneesSchema,
  incidentDetailSchema,
  type IncidentListQuery,
  incidentSchema,
  type IncidentUpdate,
  paginatedSchema,
} from '@verax/shared';
import { api } from '@/lib/api';

const incidentPageSchema = paginatedSchema(incidentSchema);

function toSearch(query: IncidentListQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

/** Incidentes do cliente da sessão, ordenados pela nota de risco (T5.7). */
export function useIncidents(query: IncidentListQuery, enabled: boolean) {
  return useQuery({
    queryKey: ['incidents', query],
    queryFn: () => api.get(`/v1/incidents?${toSearch(query)}`, incidentPageSchema),
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useIncident(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['incident', id],
    queryFn: () => api.get(`/v1/incidents/${encodeURIComponent(id)}`, incidentDetailSchema),
    enabled,
  });
}

export function useIncidentAssignees(enabled: boolean) {
  return useQuery({
    queryKey: ['incident-assignees'],
    queryFn: () => api.get('/v1/incidents/assignees', incidentAssigneesSchema),
    enabled,
    select: (response) => response.items,
    staleTime: 5 * 60_000,
  });
}

/** Status e responsável (T5.7); a API audita. O detalhe devolvido entra na tela na hora. */
export function useUpdateIncident(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (update: IncidentUpdate) =>
      api.patch(`/v1/incidents/${encodeURIComponent(id)}`, update, incidentDetailSchema),
    onSuccess: (detail) => {
      queryClient.setQueryData(['incident', id], detail);
      void queryClient.invalidateQueries({ queryKey: ['incidents'] });
      // A Torre conta os incidentes abertos e os sem responsável.
      void queryClient.invalidateQueries({ queryKey: ['tower'] });
    },
  });
}
