import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  incidentAssigneesSchema,
  type IncidentCreate,
  type IncidentDetail,
  incidentDetailSchema,
  incidentSchema,
  type IncidentUpdate,
  MAX_PAGE_SIZE,
  paginatedSchema,
} from '@verax/shared';
import { api } from '@/lib/api';

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
      void queryClient.invalidateQueries({ queryKey: ['detections'] });
      // O resumo da tela Detecções conta os incidentes abertos e os sem responsável.
      void queryClient.invalidateQueries({ queryKey: ['tower'] });
    },
  });
}

/** Depois de promover, anexar ou remover: as listas, o alerta e o incidente mudam, e a Torre conta de novo. */
function useRefreshAfterMembership() {
  const queryClient = useQueryClient();
  return (detail: IncidentDetail) => {
    queryClient.setQueryData(['incident', detail.id], detail);
    for (const key of ['incidents', 'detections', 'findings', 'finding', 'related-findings', 'tower']) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
  };
}

/** Promove alertas a um incidente novo (`POST /v1/incidents`); a API audita e avisa por e-mail. */
export function useCreateIncident() {
  const refresh = useRefreshAfterMembership();
  return useMutation({
    mutationFn: (input: IncidentCreate) => api.post('/v1/incidents', input, incidentDetailSchema),
    onSuccess: refresh,
  });
}

/** Anexa alertas a um incidente que não está resolvido. */
export function useAttachFindings() {
  const refresh = useRefreshAfterMembership();
  return useMutation({
    mutationFn: ({ incidentId, findingIds }: { incidentId: string; findingIds: string[] }) =>
      api.post(
        `/v1/incidents/${encodeURIComponent(incidentId)}/findings`,
        { findingIds },
        incidentDetailSchema,
      ),
    onSuccess: refresh,
  });
}

/** Tira um alerta do incidente: ele volta para a lista de alertas a validar. */
export function useDetachFinding(incidentId: string) {
  const refresh = useRefreshAfterMembership();
  return useMutation({
    mutationFn: (findingId: string) =>
      api.delete(
        `/v1/incidents/${encodeURIComponent(incidentId)}/findings/${encodeURIComponent(findingId)}`,
        incidentDetailSchema,
      ),
    onSuccess: refresh,
  });
}

const incidentPageSchema = paginatedSchema(incidentSchema);

/** Os incidentes que ainda recebem alertas (abertos e em análise), os de maior nota primeiro, até 100 de cada. */
export function useOpenIncidents(enabled: boolean) {
  return useQuery({
    queryKey: ['incidents', 'not-resolved'],
    queryFn: async () => {
      const pages = await Promise.all(
        (['open', 'investigating'] as const).map((status) =>
          api.get(`/v1/incidents?status=${status}&pageSize=${MAX_PAGE_SIZE}`, incidentPageSchema),
        ),
      );
      return pages
        .flatMap((page) => page.items)
        .sort((a, b) => b.riskScore - a.riskScore || b.lastSeenAt.localeCompare(a.lastSeenAt));
    },
    enabled,
  });
}
