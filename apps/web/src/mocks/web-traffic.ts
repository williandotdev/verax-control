import {
  WEB_LOGS_DISABLED_CODE,
  WEB_TRAFFIC_RECENT_MINUTES,
  WEB_TRAFFIC_WINDOW_HOURS,
  type WebTraffic,
  type WebTrafficCountry,
  type WebTrafficCounts,
  webTrafficQuerySchema,
  webTrafficSchema,
  type WebTrafficState,
  type WebTrafficWindow,
} from '@verax/shared';
import { delay, http, HttpResponse } from 'msw';
import { API_URL } from '@/lib/env';
import { DEMO_CODES, seeded } from '@/pages/catalog/world-map-demo';
import { DEMO_TENANTS } from './fixtures';
import type { MockState } from './handlers';
import { demoWebLogsEnabled } from './web-logs';

/**
 * O mapa de origens da demonstração: dados fictícios que andam com o relógio e são sempre os mesmos no mesmo minuto. Só a
 * Alfa tem balanceador com a leitura autorizada (os três autorizados de `DEMO_ALBS`); a Beta vê a tela sem a faixa.
 * `localStorage['verax.mock.traffic']` escolhe outra situação; com os ataques web desligados, não há mapa.
 */
export const MOCK_TRAFFIC_MODES = ['ok', 'slow', 'stale', 'waiting', 'no_source', 'off', 'error'] as const;
export type MockTrafficMode = (typeof MOCK_TRAFFIC_MODES)[number];

const MINUTE_MS = 60_000;
const SLOT_MS = 5 * MINUTE_MS;
const HOUR_MS = 60 * MINUTE_MS;

/** Quantos países mandam requisições num dia. */
const COUNTRIES = 64;
/** O volume do maior, por dia. */
const TOP_PER_DAY = 184_000;
/** Os intervalos de 15 minutos de um dia. */
const QUARTERS = 96;

const none: WebTrafficCounts = { requests: 0, blocked: 0, flagged: 0 };

/** O dia de um país: a cauda longa, com a sondagem de fundo de todo lugar e alguns poucos com muita. */
function dayOf(index: number): WebTrafficCounts {
  const random = seeded(1_000 + index);
  const requests = Math.max(1, Math.round((TOP_PER_DAY / (index + 1) ** 1.6) * (0.7 + random() * 0.6)));
  // Um em cada nove passa do limite da marca; nos outros, um punhado de sondagens.
  const loud = index % 9 === 5;
  const flagged = Math.min(requests, Math.floor(loud ? 60 + random() * 240 : random() * 9));
  return {
    requests: loud ? Math.max(requests, 400) : requests,
    flagged,
    blocked: Math.floor(flagged * random()),
  };
}

/** Os últimos 15 minutos de um país: os maiores, sempre; os outros, conforme o minuto. */
function recentOf(day: WebTrafficCounts, index: number, minute: number) {
  const random = seeded(minute * 512 + index);
  const active = index < 6 || random() < 0.45;
  if (!active) return { recentRequests: 0, recentFlagged: 0 };
  const recentRequests = Math.max(1, Math.round((day.requests / QUARTERS) * (0.5 + random())));
  const flagged = day.flagged > 20 && random() < 0.5 ? 1 + Math.floor(random() * 4) : 0;
  return { recentRequests, recentFlagged: Math.min(recentRequests, flagged) };
}

const scaled = (counts: WebTrafficCounts, factor: number): WebTrafficCounts => ({
  requests: Math.round(counts.requests * factor),
  blocked: Math.round(counts.blocked * factor),
  flagged: Math.round(counts.flagged * factor),
});

/** O mapa de um cliente neste minuto. */
export function demoWebTraffic(mode: WebTrafficState, window: WebTrafficWindow, now: Date): WebTraffic {
  const minute = Math.floor(now.getTime() / MINUTE_MS);
  // O intervalo fecha 10 minutos depois do fim, como na leitura de verdade.
  const closed = Math.floor((now.getTime() - 10 * MINUTE_MS) / SLOT_MS) * SLOT_MS;
  const lastClosed = mode === 'stale' ? closed - 4 * HOUR_MS : closed;
  const empty = mode === 'waiting' || mode === 'no_source';
  const hours = WEB_TRAFFIC_WINDOW_HOURS[window];
  const days = hours / 24;
  // O total anda devagar com o relógio, sem pular de um minuto para o outro.
  const drift = 1 + Math.sin(minute / 90) * 0.04;
  const countries: WebTrafficCountry[] = empty
    ? []
    : DEMO_CODES.slice(0, COUNTRIES)
        .map((code, index) => {
          const day = dayOf(index);
          const counts = scaled(day, days * drift);
          const recent =
            mode === 'stale' ? { recentRequests: 0, recentFlagged: 0 } : recentOf(day, index, minute);
          return { code, ...counts, ...recent };
        })
        .sort((a, b) => b.requests - a.requests);
  const group = (requests: number, blocked: number, flagged: number) =>
    empty ? none : scaled({ requests, blocked, flagged }, days * drift);
  return webTrafficSchema.parse({
    state: mode,
    window,
    windowHours: hours,
    generatedAt: now.toISOString(),
    recentMinutes: WEB_TRAFFIC_RECENT_MINUTES,
    lastClosedAt: empty ? null : new Date(lastClosed).toISOString(),
    lastLogAt: empty ? null : new Date(lastClosed + 2 * MINUTE_MS + 14_000).toISOString(),
    countries,
    unknown: group(1_204, 3, 18),
    throughProxy: group(20_480, 12, 96),
    internal: group(3_310, 0, 0),
    unverified: none,
    sources:
      mode === 'no_source'
        ? { authorized: 0, collecting: 0, observing: 0, failing: 0 }
        : mode === 'waiting'
          ? { authorized: 1, collecting: 0, observing: 1, failing: 0 }
          : mode === 'stale'
            ? { authorized: 3, collecting: 0, observing: 2, failing: 3 }
            : { authorized: 3, collecting: 3, observing: 2, failing: 0 },
  } satisfies WebTraffic);
}

function storedMode(): MockTrafficMode | undefined {
  const stored = typeof window === 'undefined' ? null : window.localStorage.getItem('verax.mock.traffic');
  return MOCK_TRAFFIC_MODES.find((mode) => mode === stored);
}

const problem = (status: number, message: string, code?: string) =>
  HttpResponse.json({ statusCode: status, message, ...(code !== undefined && { code }) }, { status });

export function createWebTrafficHandlers(state: MockState) {
  return [
    http.get(`${API_URL}/v1/web-logs/traffic`, async ({ request }) => {
      if (!state.me) return problem(401, 'Não autenticado');
      const mode = state.traffic ?? storedMode() ?? 'ok';
      if (mode === 'off' || !demoWebLogsEnabled(state))
        return problem(404, 'Os ataques web não estão ligados.', WEB_LOGS_DISABLED_CODE);
      const { scopeTenantId } = state.me;
      if (!scopeTenantId) return problem(409, 'Selecione um cliente para continuar', 'TENANT_REQUIRED');
      const query = webTrafficQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
      if (!query.success) return problem(400, 'Período inválido');
      if (mode === 'error') return problem(503, 'Fora do ar');
      // Devagar: o esqueleto à vista.
      if (mode === 'slow') await delay(4_000);
      const own = scopeTenantId !== DEMO_TENANTS[0]?.id ? 'no_source' : mode === 'slow' ? 'ok' : mode;
      return HttpResponse.json(demoWebTraffic(own, query.data.window, new Date()));
    }),
  ];
}
