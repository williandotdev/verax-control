import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AWS_MAX_SOURCES_PER_ACCOUNT,
  type WebAlbLogging,
  type WebAlbLoggingAction,
  webAlbLoggingSchema,
  type WebLogSource,
  webLogSourceListSchema,
  webLogSourceSchema,
  type WebRoute,
  type WebRouteCreate,
  webRouteListSchema,
  webRouteSchema,
  type WebRouteUpdate,
  webSourceHealthSchema,
  type WebSourceSettingsUpdate,
  type WebTrustedSource,
  type WebTrustedSourceCreate,
  webTrustedSourceListSchema,
  webTrustedSourceSchema,
  type WebTrustedSourceUpdate,
} from '@verax/shared';
import { useCallback, useEffect } from 'react';
import { api } from '@/lib/api';
import { ApiRequestError } from '@/lib/api-client';

/**
 * Os ataques web pelos logs do ALB no painel (`/v1/web-logs`). O nó com eles desligados, o de antes deles e o da célula
 * respondem 404 a tudo: aqui isso é "não existe" (`null`), e nunca um erro na tela. Toda escrita responde com o que ficou
 * gravado, e é isso que entra no cache: a tela não adianta estado.
 */

const BASE = '/v1/web-logs';
const PAGE_SIZE = 100;
/** Bem além do que uma conta pode ter: a API é quem limita as fontes por conta. */
const MAX_PAGES = Math.ceil(AWS_MAX_SOURCES_PER_ACCOUNT / PAGE_SIZE);

/** Com uma estimativa pedida: de quanto em quanto tempo a leitura se repete. */
export const ESTIMATE_POLL_MS = 4_000;
/** Passado este tempo sem resposta, a tela avisa e relê mais devagar. */
export const ESTIMATE_SLOW_AFTER_MS = 3 * 60_000;
export const ESTIMATE_SLOW_POLL_MS = 30_000;
/** A leitura dos logs anda de 5 em 5 minutos: a saúde dela é relida devagar. */
export const WEB_HEALTH_POLL_MS = 60_000;

const sourcePath = (sourceId: string, rest = '') => `${BASE}/sources/${encodeURIComponent(sourceId)}${rest}`;

export const webLogsKeys = {
  sources: (cloudAccountId: string) => ['web-logs', 'sources', cloudAccountId] as const,
  source: (sourceId: string) => ['web-logs', 'source', sourceId] as const,
  health: (sourceId: string) => ['web-logs', 'health', sourceId] as const,
  routes: (sourceId: string) => ['web-logs', 'routes', sourceId] as const,
  trusted: ['web-logs', 'trusted'] as const,
  albLogging: (sourceId: string) => ['web-logs', 'alb-logging', sourceId] as const,
};

/** Com um pedido de ligar ou desligar o log do ALB esperando o worker: de quanto em quanto tempo a leitura se repete. */
export const ALB_LOGGING_POLL_MS = 4_000;

/** A resposta, ou `null` quando a API diz 404 (a funcionalidade não existe neste nó, ou o item saiu). */
async function orMissing<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) return null;
    throw error;
  }
}

/** Os balanceadores de uma conta, em todas as páginas; `null` com os ataques web desligados. */
export async function fetchWebLogSources(cloudAccountId: string): Promise<WebLogSource[] | null> {
  const items = new Map<string, WebLogSource>();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ cloudAccountId, page: String(page), pageSize: String(PAGE_SIZE) });
    const result = await orMissing(api.get(`${BASE}/sources?${query.toString()}`, webLogSourceListSchema));
    if (result === null) return null;
    for (const item of result.items) items.set(item.id, item);
    if (result.items.length === 0 || page * PAGE_SIZE >= result.total) break;
  }
  return [...items.values()];
}

/** Os balanceadores da conta, com a configuração e a estimativa de cada um. */
export function useWebLogSources(cloudAccountId: string, enabled: boolean) {
  return useQuery({
    queryKey: webLogsKeys.sources(cloudAccountId),
    queryFn: () => fetchWebLogSources(cloudAccountId),
    enabled,
  });
}

/** Põe no cache da conta o balanceador que uma leitura ou uma escrita acabou de devolver. */
function useStoreSource() {
  const queryClient = useQueryClient();
  return useCallback(
    (source: WebLogSource) => {
      queryClient.setQueryData<WebLogSource[] | null>(
        webLogsKeys.sources(source.cloudAccountId),
        (current) =>
          current == null ? current : current.map((item) => (item.id === source.id ? source : item)),
      );
      queryClient.setQueryData(webLogsKeys.source(source.id), source);
    },
    [queryClient],
  );
}

/** Um balanceador, pelo ID (o nome do de outra conta, numa fonte confiável). */
export function useWebLogSource(sourceId: string, enabled = true) {
  return useQuery({
    queryKey: webLogsKeys.source(sourceId),
    queryFn: () => orMissing(api.get(sourcePath(sourceId), webLogSourceSchema)),
    enabled,
  });
}

/** Com a estimativa pedida, relê o balanceador até o worker responder; sem pedido, não lê nada. */
export function useEstimatePolling(source: WebLogSource | undefined, now: number): void {
  const store = useStoreSource();
  const requestedAt = source?.estimate?.requestedAt ?? null;
  const slow = requestedAt !== null && now - Date.parse(requestedAt) > ESTIMATE_SLOW_AFTER_MS;
  const query = useQuery({
    // O pedido entra na chave: a resposta de um pedido anterior nunca desfaz o de agora.
    queryKey: ['web-logs', 'estimate-poll', source?.id ?? '', requestedAt],
    queryFn: () => orMissing(api.get(sourcePath(source?.id ?? ''), webLogSourceSchema)),
    enabled: source !== undefined && requestedAt !== null,
    refetchInterval: slow ? ESTIMATE_SLOW_POLL_MS : ESTIMATE_POLL_MS,
    gcTime: 0,
  });
  const { data } = query;
  useEffect(() => {
    if (data != null) store(data);
  }, [data, store]);
}

export function useRequestEstimate() {
  const store = useStoreSource();
  return useMutation({
    mutationFn: (sourceId: string) =>
      api.post(sourcePath(sourceId, '/estimate'), undefined, webLogSourceSchema),
    onSuccess: store,
  });
}

/** O modo e o multiplicador. */
export function useUpdateWebSettings(sourceId: string) {
  const store = useStoreSource();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: WebSourceSettingsUpdate) =>
      api.patch(sourcePath(sourceId, '/settings'), input, webLogSourceSchema),
    onSuccess: (source) => {
      store(source);
      void queryClient.invalidateQueries({ queryKey: webLogsKeys.health(sourceId) });
    },
  });
}

/** As contagens da leitura e o resumo da observação; `null` se o nó não os tem. */
export function useWebHealth(sourceId: string, enabled = true) {
  return useQuery({
    queryKey: webLogsKeys.health(sourceId),
    queryFn: () => orMissing(api.get(sourcePath(sourceId, '/health'), webSourceHealthSchema)),
    enabled,
    refetchInterval: WEB_HEALTH_POLL_MS,
  });
}

// --- O log de acesso do ALB ligado pelo painel ---

/**
 * O log de acesso do balanceador ligado pelo painel; `null` no nó que não tem a rota (o de antes, ou com os ataques web
 * desligados): aí a tela mostra o caminho de antes, os comandos. Com um pedido pendente, relê até o worker responder.
 */
export function useAlbLogging(sourceId: string, enabled = true) {
  return useQuery({
    queryKey: webLogsKeys.albLogging(sourceId),
    queryFn: () => orMissing(api.get(sourcePath(sourceId, '/access-logs'), webAlbLoggingSchema)),
    enabled,
    refetchInterval: (query) => (query.state.data?.pending != null ? ALB_LOGGING_POLL_MS : false),
  });
}

/** Pede ao worker que ligue (ou desligue) o log; a resposta é o pedido gravado, que entra no cache. */
export function useRequestAlbLogging(sourceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (action: WebAlbLoggingAction) =>
      api.post(sourcePath(sourceId, `/access-logs/${action}`), { confirm: true }, webAlbLoggingSchema),
    onSuccess: (state: WebAlbLogging) => {
      queryClient.setQueryData(webLogsKeys.albLogging(sourceId), state);
    },
  });
}

// --- Rotas declaradas ---

export function useWebRoutes(sourceId: string, enabled = true) {
  return useQuery({
    queryKey: webLogsKeys.routes(sourceId),
    queryFn: () => orMissing(api.get(sourcePath(sourceId, '/routes'), webRouteListSchema)),
    enabled,
  });
}

type RouteList = { items: WebRoute[]; limit: number } | null;
const routePath = (sourceId: string, id: string) => sourcePath(sourceId, `/routes/${encodeURIComponent(id)}`);

/** Escreve a lista no cache e a relê: a ordem e o resto são os da API. */
function useListWrite<TInput, TResult, TList>(
  key: readonly string[],
  write: (input: TInput) => Promise<TResult>,
  apply: (list: TList, result: TResult, input: TInput) => TList,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: write,
    onSuccess: async (result, input) => {
      await queryClient.cancelQueries({ queryKey: key });
      queryClient.setQueryData<TList>(key, (current) =>
        current === undefined ? current : apply(current, result, input),
      );
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

const replaced = <T extends { id: string }>(items: readonly T[], item: T): T[] =>
  items.map((current) => (current.id === item.id ? item : current));

export const useCreateRoute = (sourceId: string) =>
  useListWrite<WebRouteCreate, WebRoute, RouteList>(
    webLogsKeys.routes(sourceId),
    (input) => api.post(sourcePath(sourceId, '/routes'), input, webRouteSchema),
    (list, route) => list && { ...list, items: [...list.items, route] },
  );

export const useUpdateRoute = (sourceId: string) =>
  useListWrite<{ id: string; input: WebRouteUpdate }, WebRoute, RouteList>(
    webLogsKeys.routes(sourceId),
    ({ id, input }) => api.patch(routePath(sourceId, id), input, webRouteSchema),
    (list, route) => list && { ...list, items: replaced(list.items, route) },
  );

export const useRemoveRoute = (sourceId: string) =>
  useListWrite<string, void, RouteList>(
    webLogsKeys.routes(sourceId),
    (id) => api.delete(routePath(sourceId, id)),
    (list, _result, id) => list && { ...list, items: list.items.filter((item) => item.id !== id) },
  );

// --- Fontes confiáveis ---

export function useTrustedSources(enabled = true) {
  return useQuery({
    queryKey: webLogsKeys.trusted,
    queryFn: () => orMissing(api.get(`${BASE}/trusted-sources`, webTrustedSourceListSchema)),
    enabled,
  });
}

type TrustedList = { items: WebTrustedSource[]; limit: number } | null;
const trustedPath = (id: string) => `${BASE}/trusted-sources/${encodeURIComponent(id)}`;

export const useCreateTrusted = () =>
  useListWrite<WebTrustedSourceCreate, WebTrustedSource, TrustedList>(
    webLogsKeys.trusted,
    (input) => api.post(`${BASE}/trusted-sources`, input, webTrustedSourceSchema),
    (list, trusted) => list && { ...list, items: [...list.items, trusted] },
  );

export const useUpdateTrusted = () =>
  useListWrite<{ id: string; input: WebTrustedSourceUpdate }, WebTrustedSource, TrustedList>(
    webLogsKeys.trusted,
    ({ id, input }) => api.patch(trustedPath(id), input, webTrustedSourceSchema),
    (list, trusted) => list && { ...list, items: replaced(list.items, trusted) },
  );

export const useRemoveTrusted = () =>
  useListWrite<string, void, TrustedList>(
    webLogsKeys.trusted,
    (id) => api.delete(trustedPath(id)),
    (list, _result, id) => list && { ...list, items: list.items.filter((item) => item.id !== id) },
  );
