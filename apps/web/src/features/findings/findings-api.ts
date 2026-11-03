import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type AlertExceptionCreate,
  alertExceptionSchema,
  cloudAccountSchema,
  findingCommentSchema,
  findingDetailSchema,
  type FindingListQuery,
  findingSchema,
  type FindingStatusUpdate,
  paginatedSchema,
} from '@verax/shared';
import { api } from '@/lib/api';

const findingPageSchema = paginatedSchema(findingSchema);
const cloudAccountPageSchema = paginatedSchema(cloudAccountSchema);

function toSearch(query: FindingListQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

/** Lista de achados do cliente da sessão, com os filtros na query string (T5.4). */
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
    // A Torre conta os achados sem triagem.
    void queryClient.invalidateQueries({ queryKey: ['tower'] });
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
  return useMutation({
    mutationFn: (exception: AlertExceptionCreate) =>
      api.post('/v1/alert-exceptions', exception, alertExceptionSchema),
  });
}
