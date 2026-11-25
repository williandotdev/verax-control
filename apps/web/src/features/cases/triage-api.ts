import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type CaseSplit,
  caseSplitResultSchema,
  triageAuthorsSchema,
  type TriageFilter,
  type TriageOperationDetail,
  triageOperationDetailSchema,
  triageOperationPageSchema,
  triagePreviewSchema,
} from '@verax/shared';
import { useEffect, useRef } from 'react';
import { toSearch } from '@/features/detections/detections-api';
import { api } from '@/lib/api';
import type { BulkRequestBody } from './bulk';
import { invalidateAfterTriage, invalidateCases } from './cases-api';
import { isActive } from './operation-text';

const id = (value: string) => encodeURIComponent(value);

/** De quanto em quanto tempo o andamento é relido, e só enquanto há operação na fila ou em curso. */
export const OPERATION_POLL_MS = 1_500;
export const OPERATION_LIST_POLL_MS = 3_000;
export const OPERATIONS_PAGE = 10;

/** O que o filtro alcança agora, para a pessoa confirmar. Sempre relido ao abrir o diálogo. */
export function useTriagePreview(filter: TriageFilter | null) {
  return useQuery({
    queryKey: ['triage-preview', filter],
    queryFn: () => api.get(`/v1/triage-operations/preview?${toSearch(filter ?? {})}`, triagePreviewSchema),
    enabled: filter !== null,
    staleTime: 0,
    gcTime: 0,
  });
}

/** As operações do cliente, da mais recente para trás; relidas sozinhas só enquanto uma delas anda. */
export function useTriageOperations(
  query: { authorId?: string | undefined; page: number },
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['triage-operations', query],
    queryFn: () =>
      api.get(
        `/v1/triage-operations?${toSearch({ ...query, pageSize: OPERATIONS_PAGE })}`,
        triageOperationPageSchema,
      ),
    enabled,
    placeholderData: keepPreviousData,
    refetchInterval: (current) => (current.state.data?.items.some(isMoving) ? OPERATION_LIST_POLL_MS : false),
  });
}

/** Quem pediu operações nos últimos 30 dias, para o filtro. Um nó de antes recusa: o filtro fica só com quem se vê. */
export function useTriageAuthors(enabled: boolean) {
  return useQuery({
    queryKey: ['triage-authors'],
    queryFn: () => api.get('/v1/triage-operations/authors', triageAuthorsSchema),
    enabled,
    retry: false,
  });
}

/** Na fila, em curso ou sendo desfeita: o estado ainda muda sozinho. */
const isMoving = (operation: TriageOperationDetail): boolean =>
  isActive(operation) || operation.state === 'undoing';

/** Uma operação, com o andamento relido enquanto ela anda. */
export function useTriageOperation(operation: TriageOperationDetail | null) {
  return useQuery({
    queryKey: ['triage-operation', operation?.id],
    queryFn: () => api.get(`/v1/triage-operations/${id(operation?.id ?? '')}`, triageOperationDetailSchema),
    enabled: operation !== null,
    initialData: operation ?? undefined,
    // O que o pedido respondeu é de agora: só se relê se ainda anda.
    staleTime: OPERATION_POLL_MS,
    refetchInterval: (current) =>
      current.state.data && isMoving(current.state.data) ? OPERATION_POLL_MS : false,
  });
}

/**
 * O id do pedido: um por conteúdo. O mesmo pedido de novo (a conexão caiu, o banco estava ocupado) leva o mesmo id, e a
 * API devolve a operação que ele já criou, em vez de fazer outra; mudou qualquer coisa, é um pedido novo.
 */
export function useRequestId(): (content: unknown) => string {
  const last = useRef<{ key: string; id: string } | null>(null);
  return (content) => {
    const key = JSON.stringify(content);
    if (last.current?.key !== key) last.current = { key, id: crypto.randomUUID() };
    return last.current.id;
  };
}

/** Depois de qualquer pedido aceito: a operação entra no histórico e, se já terminou, as listas mudam. */
function useAfterRequest() {
  const queryClient = useQueryClient();
  return (operation: TriageOperationDetail) => {
    queryClient.setQueryData(['triage-operation', operation.id], operation);
    void queryClient.invalidateQueries({ queryKey: ['triage-operations'] });
    void queryClient.invalidateQueries({ queryKey: ['triage-authors'] });
    if (!isActive(operation)) invalidateAfterTriage(queryClient);
    // Na fila, os alertas ainda não mudaram; o que se pode fazer com a operação no detalhe do caso, sim.
    else void queryClient.invalidateQueries({ queryKey: ['case'] });
  };
}

/** O pedido (`POST /v1/triage-operations`). Sem nova tentativa automática: repetir é da pessoa, com o mesmo id. */
export function useRequestTriage() {
  const after = useAfterRequest();
  return useMutation({
    mutationFn: (body: BulkRequestBody & { requestId: string }) =>
      api.post('/v1/triage-operations', body, triageOperationDetailSchema),
    onSuccess: after,
  });
}

export function useUndoAllOf() {
  const after = useAfterRequest();
  return useMutation({
    mutationFn: (body: { requestId: string; userId: string; reason: string }) =>
      api.post(
        '/v1/triage-operations',
        {
          action: 'undo_all_of',
          requestId: body.requestId,
          target: { userId: body.userId },
          reason: body.reason,
        },
        triageOperationDetailSchema,
      ),
    onSuccess: after,
  });
}

/** Desfazer: a resposta é a operação que desfaz. */
export function useUndoTriage() {
  const after = useAfterRequest();
  return useMutation({
    mutationFn: ({ operationId, ...body }: { operationId: string; requestId: string; reason?: string }) =>
      api.post(`/v1/triage-operations/${id(operationId)}/undo`, body, triageOperationDetailSchema),
    onSuccess: after,
  });
}

export function useCancelTriage() {
  const after = useAfterRequest();
  return useMutation({
    mutationFn: (operationId: string) =>
      api.post(`/v1/triage-operations/${id(operationId)}/cancel`, {}, triageOperationDetailSchema),
    onSuccess: after,
  });
}

export function useContinueTriage() {
  const after = useAfterRequest();
  return useMutation({
    mutationFn: (operationId: string) =>
      api.post(`/v1/triage-operations/${id(operationId)}/continue`, {}, triageOperationDetailSchema),
    onSuccess: after,
  });
}

/** Dividir um caso: os alertas escolhidos vão para um caso novo. */
export function useSplitCase(caseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CaseSplit) => api.post(`/v1/cases/${id(caseId)}/split`, body, caseSplitResultSchema),
    onSuccess: () => invalidateCases(queryClient),
  });
}

/**
 * Relê as listas quando uma operação que andava termina, vista por quem a acompanha (o diálogo ou o painel). A primeira
 * olhada não conta: o que já estava terminado não mudou nada. Uma que só saiu da página continua esperada.
 */
export function useRefreshWhenFinished(operations: readonly TriageOperationDetail[]): void {
  const queryClient = useQueryClient();
  const waiting = useRef<ReadonlySet<string>>(new Set());
  const key = operations.map((operation) => `${operation.id}${isMoving(operation) ? '+' : '-'}`).join(' ');
  useEffect(() => {
    const seen =
      key === '' ? [] : key.split(' ').map((entry) => [entry.slice(0, -1), entry.endsWith('+')] as const);
    const next = new Set(waiting.current);
    let finished = false;
    for (const [operationId, moving] of seen) {
      if (moving) next.add(operationId);
      else if (next.delete(operationId)) finished = true;
    }
    waiting.current = next;
    if (!finished) return;
    invalidateAfterTriage(queryClient);
    void queryClient.invalidateQueries({ queryKey: ['triage-operations'] });
  }, [key, queryClient]);
}
