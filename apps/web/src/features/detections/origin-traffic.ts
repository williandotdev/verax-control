import { useQuery } from '@tanstack/react-query';
import { type WebTraffic, type WebTrafficWindow, webTrafficSchema } from '@verax/shared';
import type { OriginCounts, WorldTraffic } from '@/components/security/world-map-model';
import { api } from '@/lib/api';
import { ApiRequestError } from '@/lib/api-client';

/** De quanto em quanto tempo o mapa é pedido; sem balanceador autorizado, só para notar quando houver. */
export const ORIGIN_POLL_MS = 60_000;
export const ORIGIN_IDLE_POLL_MS = 5 * 60_000;

/**
 * O mapa de origens, ou null no nó que não o tem (os ataques web desligados, ou um nó de antes): a faixa não existe, e a
 * página é a de sempre.
 */
async function fetchTraffic(window: WebTrafficWindow): Promise<WebTraffic | null> {
  try {
    return await api.get(`/v1/web-logs/traffic?window=${window}`, webTrafficSchema);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) return null;
    throw error;
  }
}

/**
 * As requisições por país do cliente. Pedido de novo a cada minuto com a aba à vista (o React Query para com ela em segundo
 * plano e pede ao voltar); o nó que não tem o mapa é perguntado uma vez só.
 */
export function useOriginTraffic(
  scope: string,
  window: WebTrafficWindow,
  { enabled = true, polling = true }: { enabled?: boolean; polling?: boolean } = {},
) {
  return useQuery({
    queryKey: ['web-traffic', scope, window],
    queryFn: () => fetchTraffic(window),
    enabled,
    staleTime: ({ state }) => (state.data === null ? Infinity : 30_000),
    refetchInterval: ({ state }) => {
      if (!polling || state.data === null) return false;
      return state.data?.state === 'no_source' ? ORIGIN_IDLE_POLL_MS : ORIGIN_POLL_MS;
    },
  });
}

const together = (a: OriginCounts, b: OriginCounts): OriginCounts => ({
  requests: a.requests + b.requests,
  blocked: a.blocked + b.blocked,
  flagged: a.flagged + b.flagged,
});

/**
 * O que o mapa mostra, do contrato da API. O endereço que pode ser do visitante ou de uma CDN conta como origem desconhecida,
 * com a nota dele.
 */
export function toWorldTraffic(traffic: WebTraffic, refreshFailed: boolean): WorldTraffic {
  return {
    generatedAt: traffic.generatedAt,
    windowHours: traffic.windowHours,
    recentMinutes: traffic.recentMinutes,
    recentUntil: traffic.lastClosedAt,
    countries: traffic.countries,
    unknown: together(traffic.unknown, traffic.unverified),
    unverified: traffic.unverified.requests,
    throughProxy: traffic.throughProxy,
    internal: traffic.internal,
    state: traffic.state === 'stale' ? 'stale' : 'ok',
    lastLogAt: traffic.lastLogAt,
    refreshFailed,
  };
}
