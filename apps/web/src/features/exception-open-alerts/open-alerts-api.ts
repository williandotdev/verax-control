import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { exceptionOpenPreviewSchema, exceptionOpenResolutionSchema } from '@verax/shared';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import { invalidateAfterTriage } from '@/features/cases/cases-api';
import { api } from '@/lib/api';
import { ApiRequestError } from '@/lib/api-client';

/**
 * Os alertas em aberto que uma exceção nova resolve (decisão do dono de 26/11/2026): a prévia antes de salvar, a contagem
 * na criação e o "resolver os próximos". O contrato está em `packages/shared/src/exception-open-alerts.ts`.
 */

/** A recusa do nó de antes, que não conhece o pedido: "esta rota não aceita parâmetros de consulta" (sem campo). */
const refusedQuery = (error: unknown): boolean =>
  error instanceof ApiRequestError &&
  error.status === 400 &&
  (error.issues ?? []).some((issue) => issue.path === '');

/**
 * Cria pedindo a contagem dos alertas em aberto (`openAlerts=true`). Um nó de antes recusa o pedido com 400 antes de
 * gravar qualquer coisa, e a criação vai de novo sem ele: a resposta é a de sempre, sem a contagem.
 */
export async function createWithOpenAlerts<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
  try {
    return await api.post(`${path}?openAlerts=true`, body, schema);
  } catch (error) {
    if (refusedQuery(error)) return api.post(path, body, schema);
    throw error;
  }
}

/** Os alertas mudaram: as listas, os casos, os incidentes e a Torre leem de novo, e as exceções mostram a contagem nova. */
export function useInvalidateOpenAlerts(): () => void {
  const queryClient = useQueryClient();
  return () => {
    invalidateAfterTriage(queryClient);
    void queryClient.invalidateQueries({ queryKey: ['admin-exceptions'] });
    void queryClient.invalidateQueries({ queryKey: ['scoped-exceptions'] });
  };
}

/** O valor depois de uma pausa na digitação: a prévia não vai à API a cada tecla. */
function useSettled<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

export interface AlertExceptionTarget {
  ruleId: string;
  field: string;
  value: string;
}

/**
 * A prévia da exceção de usuário, IP ou recurso, enquanto o alvo é válido (`null`: nada a perguntar). Um nó de antes
 * responde 400 (a rota cai no `:id`): a prévia só não aparece.
 */
export function useAlertExceptionOpenPreview(target: AlertExceptionTarget | null) {
  const key = target === null ? null : JSON.stringify(target);
  const settled = useSettled(key, 400);
  const params = new URLSearchParams(target === null ? {} : { ...target }).toString();
  return useQuery({
    queryKey: ['exception-open-preview', 'alert', key],
    queryFn: () => api.get(`/v1/alert-exceptions/open-alerts?${params}`, exceptionOpenPreviewSchema),
    enabled: key !== null && settled === key,
    staleTime: 0,
    retry: false,
  });
}

/** A prévia da ampla, pedida junto da de sempre ("Ver prévia"). Um nó de antes responde 404: só não aparece. */
export const useScopedOpenPreview = () =>
  useMutation({
    mutationFn: (target: Record<string, string>) =>
      api.get(
        `/v1/scoped-exceptions/open-alerts?${new URLSearchParams(target).toString()}`,
        exceptionOpenPreviewSchema,
      ),
  });

export type ExceptionKind = 'alert' | 'scoped';

/** "Resolver os próximos": a criação parou no teto da requisição. */
export function useResolveMoreOpen(kind: ExceptionKind, exceptionId: string) {
  const invalidate = useInvalidateOpenAlerts();
  const base = kind === 'alert' ? '/v1/alert-exceptions' : '/v1/scoped-exceptions';
  return useMutation({
    mutationFn: () =>
      api.post(
        `${base}/${encodeURIComponent(exceptionId)}/resolve-open`,
        undefined,
        exceptionOpenResolutionSchema,
      ),
    onSuccess: invalidate,
  });
}
