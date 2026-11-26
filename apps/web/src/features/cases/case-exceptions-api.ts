import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type AlertExceptionBatch,
  alertExceptionBatchCreatedSchema,
  caseExceptionDraftSchema,
  paginatedSchema,
  type ScopedExceptionCreate,
  scopedExceptionCreatedSchema,
  scopedExceptionPreviewSchema,
  scopedExceptionSchema,
} from '@verax/shared';
import {
  createWithOpenAlerts,
  useInvalidateOpenAlerts,
} from '@/features/exception-open-alerts/open-alerts-api';
import { api } from '@/lib/api';

const id = (value: string) => encodeURIComponent(value);
const SCOPED_PAGE_SIZE = 20;
const scopedPageSchema = paginatedSchema(scopedExceptionSchema);

/** O que é constante nos alertas do caso, para a exceção a partir dele. Lido a cada abertura do diálogo. */
export const useCaseExceptionDraft = (caseId: string) =>
  useQuery({
    queryKey: ['case-exception-draft', caseId],
    queryFn: () => api.get(`/v1/cases/${id(caseId)}/exception-draft`, caseExceptionDraftSchema),
    staleTime: 0,
    retry: false,
  });

/** As exceções de usuário, IP ou recurso do caso, de uma vez (até 20). */
export function useCreateExceptionBatch(caseId: string) {
  const invalidate = useInvalidateOpenAlerts();
  return useMutation({
    mutationFn: (input: AlertExceptionBatch) =>
      createWithOpenAlerts(
        `/v1/cases/${id(caseId)}/alert-exceptions`,
        input,
        alertExceptionBatchCreatedSchema,
      ),
    // As exceções novas e os alertas em aberto que elas resolveram.
    onSuccess: invalidate,
  });
}

/** A prévia da exceção ampla: quantos alertas dos últimos 30 dias ela teria marcado. */
export const useScopedPreview = () =>
  useMutation({
    mutationFn: (target: Record<string, string>) =>
      api.get(
        `/v1/scoped-exceptions/preview?${new URLSearchParams(target).toString()}`,
        scopedExceptionPreviewSchema,
      ),
  });

export function useCreateScoped() {
  const invalidate = useInvalidateOpenAlerts();
  return useMutation({
    mutationFn: (input: ScopedExceptionCreate) =>
      createWithOpenAlerts('/v1/scoped-exceptions', input, scopedExceptionCreatedSchema),
    onSuccess: invalidate,
  });
}

/** As exceções amplas do cliente. Só com os casos ligados; um nó de antes responde 404, e a seção some. */
export const useScopedList = (page: number, enabled: boolean) =>
  useQuery({
    queryKey: ['scoped-exceptions', page],
    queryFn: () =>
      api.get(`/v1/scoped-exceptions?page=${page}&pageSize=${SCOPED_PAGE_SIZE}`, scopedPageSchema),
    enabled,
    retry: false,
    placeholderData: keepPreviousData,
  });

export function useRevokeScoped() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (exceptionId: string) =>
      api.post(`/v1/scoped-exceptions/${id(exceptionId)}/revoke`, undefined, scopedExceptionSchema),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['scoped-exceptions'] }),
  });
}

export { SCOPED_PAGE_SIZE };
