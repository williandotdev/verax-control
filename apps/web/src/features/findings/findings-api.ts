import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type AlertExceptionCreate,
  alertExceptionCreatedSchema,
  cloudAccountSchema,
  findingCommentSchema,
  findingDetailSchema,
  findingEvidenceSchema,
  type FindingListQuery,
  findingSchema,
  type FindingStatusUpdate,
  paginatedSchema,
  relatedFindingsSchema,
} from '@verax/shared';
import { invalidateCases } from '@/features/cases/cases-api';
import { toSearch } from '@/features/detections/detections-api';
import {
  createWithOpenAlerts,
  useInvalidateOpenAlerts,
} from '@/features/exception-open-alerts/open-alerts-api';
import { api } from '@/lib/api';
import { ApiRequestError } from '@/lib/api-client';

const findingPageSchema = paginatedSchema(findingSchema);
const cloudAccountPageSchema = paginatedSchema(cloudAccountSchema);

/** Lista de alertas (achados) do cliente da sessão, com os filtros na query string (T5.4). */
export function useFindings(query: FindingListQuery, enabled: boolean) {
  return useQuery({
    queryKey: ['findings', query],
    queryFn: () => api.get(`/v1/findings?${toSearch(query)}`, findingPageSchema),
    enabled,
    placeholderData: keepPreviousData,
  });
}

/** Detalhe com o evento bruto e os comentários. */
export function useFinding(id: string | null) {
  return useQuery({
    queryKey: ['finding', id],
    queryFn: () => api.get(`/v1/findings/${encodeURIComponent(id ?? '')}`, findingDetailSchema),
    enabled: id !== null,
  });
}

/**
 * A evidência do achado que não tem evento bruto guardado (os ataques web dos logs do ALB). Rota à parte do detalhe: o nó de antes
 * responde 404, e o achado aparece sem ela (`null`).
 */
export function useFindingEvidence(id: string) {
  return useQuery({
    queryKey: ['finding-evidence', id],
    queryFn: async () => {
      try {
        return await api.get(`/v1/findings/${encodeURIComponent(id)}/evidence`, findingEvidenceSchema);
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 404) return null;
        throw error;
      }
    },
  });
}

/** Contas cloud do cliente (filtro por conta). */
export function useCloudAccounts(enabled: boolean) {
  return useQuery({
    queryKey: ['cloud-accounts', 'options'],
    queryFn: () => api.get('/v1/cloud-accounts?pageSize=100', cloudAccountPageSchema),
    enabled,
    select: (page) => page.items,
  });
}

function useRefreshFindings() {
  const queryClient = useQueryClient();
  return (id: string) => {
    void queryClient.invalidateQueries({ queryKey: ['finding', id] });
    void queryClient.invalidateQueries({ queryKey: ['findings'] });
    void queryClient.invalidateQueries({ queryKey: ['detections'] });
    // O incidente do achado mostra os achados dele.
    void queryClient.invalidateQueries({ queryKey: ['incident'] });
    // O resumo da tela Detecções conta os achados sem triagem.
    void queryClient.invalidateQueries({ queryKey: ['tower'] });
    // O caso conta os alertas dele por status.
    invalidateCases(queryClient);
  };
}

/** Muda o status (T5.5); a API audita, com o comentário junto. O detalhe devolvido entra na tela na hora. */
export function useUpdateFindingStatus(id: string) {
  const queryClient = useQueryClient();
  const refresh = useRefreshFindings();
  return useMutation({
    mutationFn: (update: FindingStatusUpdate) =>
      api.patch(`/v1/findings/${encodeURIComponent(id)}/status`, update, findingDetailSchema),
    onSuccess: (detail) => {
      queryClient.setQueryData(['finding', id], detail);
      refresh(id);
    },
  });
}

export function useAddFindingComment(id: string) {
  const refresh = useRefreshFindings();
  return useMutation({
    mutationFn: (body: string) =>
      api.post(`/v1/findings/${encodeURIComponent(id)}/comments`, { body }, findingCommentSchema),
    onSuccess: () => refresh(id),
  });
}

/** Exceção oferecida ao marcar um achado como legítimo (T3.5): alertas iguais passam a ser esperados. */
export function useCreateAlertException() {
  const invalidate = useInvalidateOpenAlerts();
  return useMutation({
    mutationFn: (exception: AlertExceptionCreate) =>
      createWithOpenAlerts('/v1/alert-exceptions', exception, alertExceptionCreatedSchema),
    // Os alertas em aberto que ela cobre foram resolvidos junto.
    onSuccess: invalidate,
  });
}

/** Alertas relacionados (mesmo usuário, chave, IP ou recurso, perto no tempo): a sugestão ao promover. */
export function useRelatedFindings(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['related-findings', id],
    queryFn: () => api.get(`/v1/findings/${encodeURIComponent(id)}/related`, relatedFindingsSchema),
    enabled,
    select: (response) => response.items,
  });
}
