import {
  keepPreviousData,
  type QueryClient,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect } from 'react';
import {
  caseDetailSchema,
  type CaseFindingPage,
  caseFindingPageSchema,
  type CaseFindingsQuery,
  type CaseGroupsQuery,
  caseGroupPageSchema,
  type CaseListQuery,
  casePageSchema,
  type CaseMode,
  type CaseStatus,
  caseStatusSchema,
  caseTimelineSchema,
  findingTriageSchema,
  INVALID_CASE_CURSOR_CODE,
} from '@verax/shared';
import type { z } from 'zod';
import { toSearch } from '@/features/detections/detections-api';
import { api } from '@/lib/api';
import { ApiRequestError, UnexpectedResponseError } from '@/lib/api-client';

const id = (value: string) => encodeURIComponent(value);

/** A situação muda quando a Verax liga ou desliga os casos no nó: não é algo a conferir a toda hora. */
const STATUS_STALE_MS = 5 * 60_000;

export interface CaseModeState {
  mode: CaseMode;
  /** Ainda não se sabe: a lista padrão espera, para não pedir os alertas à toa. */
  loading: boolean;
  status: CaseStatus | null;
}

/**
 * Se os casos valem para quem está vendo (`GET /v1/cases/status`). Nó de antes (404), resposta que não se entende ou erro:
 * desligados, e a tela é a de sempre. Um pedido só por visita, sem repetir.
 */
export function useCaseMode(scope: string | null, enabled = true): CaseModeState {
  const status = useQuery({
    queryKey: ['case-status', scope],
    queryFn: () => api.get('/v1/cases/status', caseStatusSchema),
    enabled: enabled && scope !== null,
    staleTime: STATUS_STALE_MS,
    retry: false,
  });
  if (!enabled || scope === null) return { mode: 'off', loading: false, status: null };
  // A versão do nó voltou: a resposta guardada não vale mais.
  const gone = status.error instanceof ApiRequestError && status.error.status === 404;
  const data = gone ? undefined : status.data;
  return { mode: data?.mode ?? 'off', loading: status.isPending, status: data ?? null };
}

/**
 * A Torre e os relatórios, com os campos dos casos (`cases`) ou sem eles. As respostas são fechadas, então os campos só vêm
 * para quem os pede. Um nó que tem casos e ainda não conhece o pedido responde 400; um mais novo pode mandar algo que este
 * painel não conhece: nos dois, vale a resposta de sempre.
 */
export async function getWithCases<T>(path: string, schema: z.ZodType<T>, cases: boolean): Promise<T> {
  if (!cases) return api.get(path, schema);
  try {
    return await api.get(`${path}${path.includes('?') ? '&' : '?'}cases=true`, schema);
  } catch (error) {
    const refused = error instanceof ApiRequestError && error.status === 400;
    if (refused || error instanceof UnexpectedResponseError) return api.get(path, schema);
    throw error;
  }
}

/** A lista que passou a responder 404: os casos foram desligados no nó com a tela aberta. Pergunta a situação de novo. */
export function useRecheckMode(error: unknown): void {
  const queryClient = useQueryClient();
  const gone = error instanceof ApiRequestError && error.status === 404;
  useEffect(() => {
    if (gone) void queryClient.invalidateQueries({ queryKey: ['case-status'] });
  }, [gone, queryClient]);
}

/** As chaves do que muda quando alertas são tratados. Invalidar o que ninguém está vendo não faz pedido nenhum. */
const CASE_KEYS = [
  'cases',
  'case-groups',
  'case',
  'case-findings',
  'case-timeline',
  'finding-triage',
] as const;

export function invalidateCases(queryClient: QueryClient): void {
  for (const key of CASE_KEYS) void queryClient.invalidateQueries({ queryKey: [key] });
}

/** Depois de uma operação em massa: os casos, as outras listas, o detalhe aberto e o resumo da situação. */
export function invalidateAfterTriage(queryClient: QueryClient): void {
  invalidateCases(queryClient);
  for (const key of [
    'findings',
    'finding',
    'related-findings',
    'detections',
    'incidents',
    'incident',
    'tower',
  ]) {
    void queryClient.invalidateQueries({ queryKey: [key] });
  }
}

export function useCases(query: CaseListQuery, enabled: boolean) {
  return useQuery({
    queryKey: ['cases', query],
    queryFn: () => api.get(`/v1/cases?${toSearch(query)}`, casePageSchema),
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useCaseGroups(query: CaseGroupsQuery, enabled: boolean) {
  return useQuery({
    queryKey: ['case-groups', query],
    queryFn: () => api.get(`/v1/cases/groups?${toSearch(query)}`, caseGroupPageSchema),
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useCase(caseId: string | null) {
  return useQuery({
    queryKey: ['case', caseId],
    queryFn: () => api.get(`/v1/cases/${id(caseId ?? '')}`, caseDetailSchema),
    enabled: caseId !== null,
  });
}

export function useCaseTimeline(caseId: string) {
  return useQuery({
    queryKey: ['case-timeline', caseId],
    queryFn: () => api.get(`/v1/cases/${id(caseId)}/timeline`, caseTimelineSchema),
    // O 503 daqui é o banco que cortou a leitura: repetir na hora só o ocupa mais. A pessoa pode tentar de novo.
    retry: false,
  });
}

export type CaseFindingFilters = Pick<CaseFindingsQuery, 'status' | 'severity' | 'group'>;
export const CASE_FINDINGS_PAGE = 20;

/** Os alertas do caso, por cursor: "Carregar mais" pede a página seguinte. */
export function useCaseFindings(caseId: string, filters: CaseFindingFilters) {
  return useInfiniteQuery({
    queryKey: ['case-findings', caseId, filters],
    queryFn: ({ pageParam }): Promise<CaseFindingPage> =>
      api.get(
        `/v1/cases/${id(caseId)}/findings?${toSearch({
          ...filters,
          pageSize: CASE_FINDINGS_PAGE,
          cursor: pageParam,
        })}`,
        caseFindingPageSchema,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

/** O cursor não é mais desta lista (o nó mudou de versão): a leitura recomeça da primeira página. */
export function isInvalidCursor(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === INVALID_CASE_CURSOR_CODE;
}

/** As operações em massa que mexeram num alerta. */
export function useFindingTriage(findingId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['finding-triage', findingId],
    queryFn: () => api.get(`/v1/findings/${id(findingId)}/triage`, findingTriageSchema),
    enabled,
  });
}
