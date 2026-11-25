import {
  WEB_TRAFFIC_RECENT_MINUTES,
  WEB_TRAFFIC_STALE_MS,
  WEB_TRAFFIC_WINDOW_HOURS,
  type WebTraffic,
  type WebTrafficCounts,
  type WebTrafficState,
  type WebTrafficWindow,
} from '@verax/shared';
import { CLOSE_DELAY_MS, MINUTE_MS, SLOT_MS } from '../limits.js';
import type { CountryTraffic } from '../store/web-traffic-store.js';
import { UNKNOWN_COUNTRY } from '../traffic.js';

/**
 * O mapa de origens: a resposta de `GET /v1/web-logs/traffic` a partir do que está no banco. Puro; quem lê é o
 * `web-traffic.service.ts`.
 *
 * **O "agora" não é a hora de agora.** A AWS entrega o log de 5 a 10 minutos depois, e o leitor só fecha um intervalo 10
 * minutos depois do fim dele: contados de agora, os últimos minutos estariam sempre vazios. Conta-se do fim do último
 * intervalo que o leitor já fechou (a posição de cada balanceador), do mais em dia. Não é o intervalo com o registro mais
 * novo: num site quieto, ele pode ser de horas atrás. Só enquanto o leitor recupera um atraso é ele que vale: a posição fica
 * no atraso, e os minutos de agora já foram lidos (a leitura ao vivo vem primeiro).
 */

const HOUR_MS = 60 * MINUTE_MS;

/** Um balanceador autorizado, com o que a leitura dele diz. */
export interface TrafficSource {
  state: string;
  authorizedAt: Date;
  lastEventAt: Date | null;
  lastIngestedAt: Date | null;
  /** A posição do cursor: o fim do último intervalo tratado. Null antes da primeira leitura. */
  position: Date | null;
  /** Abre achado (`alert`); senão, só observa. */
  alerting: boolean;
}

export interface TrafficSourcesView {
  /** O fim do último intervalo lido e fechado, do balanceador mais em dia (e nunca no futuro). */
  lastClosedAt: Date | null;
  lastLogAt: Date | null;
  /** A leitura de algum balanceador está em dia. */
  fresh: boolean;
  /** Algum arquivo já foi lido desde a autorização. */
  seen: boolean;
  counts: WebTraffic['sources'];
}

/** Os estados em que a leitura tem um problema à vista. */
const FAILING: ReadonlySet<string> = new Set(['stalled', 'permission_error', 'ingestion_error']);

const latest = (dates: readonly (Date | null)[]): Date | null =>
  dates.reduce<Date | null>(
    (max, date) => (date !== null && (max === null || date > max) ? date : max),
    null,
  );

const floorSlot = (ms: number): Date => new Date(Math.floor(ms / SLOT_MS) * SLOT_MS);
const isFresh = (date: Date | null, now: Date): boolean =>
  date !== null && now.getTime() - date.getTime() <= WEB_TRAFFIC_STALE_MS;

/** O fim do último intervalo que um balanceador já leu e fechou, desde esta autorização. */
function closedOf({ position, lastEventAt, authorizedAt }: TrafficSource, now: Date): Date | null {
  // A posição de antes desta autorização é de uma leitura que já tinha parado. Recém-autorizado, ela é o fim do intervalo em
  // curso.
  const own =
    position === null || position < authorizedAt
      ? null
      : position > now
        ? floorSlot(now.getTime())
        : position;
  if (isFresh(own, now) || lastEventAt === null || lastEventAt < authorizedAt) return own;
  // Recuperando um atraso: o intervalo do registro mais novo, se ele já fechou.
  const closed = floorSlot(now.getTime() - CLOSE_DELAY_MS);
  const live = floorSlot(lastEventAt.getTime() + SLOT_MS);
  return latest([own, live < closed ? live : closed]);
}

export function viewSources(sources: readonly TrafficSource[], now: Date): TrafficSourcesView {
  const closed = sources.map((source) => closedOf(source, now));
  const fresh = closed.map((date) => isFresh(date, now));
  const alerting = sources.filter((source) => source.alerting).length;
  return {
    lastClosedAt: latest(closed),
    lastLogAt: latest(sources.map((source) => source.lastEventAt)),
    fresh: fresh.includes(true),
    seen: sources.some(
      ({ lastIngestedAt, authorizedAt }) => lastIngestedAt !== null && lastIngestedAt >= authorizedAt,
    ),
    counts: {
      authorized: sources.length,
      collecting: fresh.filter(Boolean).length,
      observing: sources.length - alerting,
      failing: sources.filter((source) => FAILING.has(source.state)).length,
    },
  };
}

/** De quando até quando a janela conta: por intervalo de 5 minutos até 24 h; nas maiores, por hora inteira. */
export function windowRange(window: WebTrafficWindow, now: Date): { from: Date; to: Date } {
  const hours = WEB_TRAFFIC_WINDOW_HOURS[window];
  const step = hours > 24 ? HOUR_MS : SLOT_MS;
  return { from: new Date(Math.floor(now.getTime() / step) * step - hours * HOUR_MS), to: now };
}

/** Os últimos minutos, até o fim do último intervalo fechado; null com a leitura parada: nada é de agora. */
export function recentRange(view: TrafficSourcesView): { from: Date; to: Date } | null {
  if (!view.fresh || view.lastClosedAt === null) return null;
  return {
    from: new Date(view.lastClosedAt.getTime() - WEB_TRAFFIC_RECENT_MINUTES * MINUTE_MS),
    to: view.lastClosedAt,
  };
}

/** Até o teto do inteiro seguro do JSON: o banco soma em 64 bits. */
const sum = (held: number, value: bigint): number => Math.min(Number.MAX_SAFE_INTEGER, held + Number(value));

const add = (held: WebTrafficCounts, row: CountryTraffic): WebTrafficCounts => ({
  requests: sum(held.requests, row.requests),
  blocked: sum(held.blocked, row.blocked),
  flagged: sum(held.flagged, row.flagged),
});

const isCountryCode = (code: string): boolean =>
  code !== UNKNOWN_COUNTRY && code.length === 2 && [...code].every((char) => char >= 'A' && char <= 'Z');

const NONE: WebTrafficCounts = { requests: 0, blocked: 0, flagged: 0 };

function stateOf(view: TrafficSourcesView, hasTraffic: boolean): WebTrafficState {
  if (view.counts.authorized === 0) return 'no_source';
  // O que já chegou na janela (antes de uma autorização refeita, ou de um balanceador retirado) também é mapa.
  if (!view.seen && !hasTraffic) return 'waiting';
  return view.fresh ? 'ok' : 'stale';
}

/**
 * A resposta. `total` e `recent` são o que o `WebTrafficStore.byCountry` devolve, na ordem dele (do maior ao menor). Só o
 * cliente direto tem país: o da CDN é o da borda, e o endereço lido sem a lista delas pode ser uma coisa ou outra.
 */
export function buildTraffic(input: {
  window: WebTrafficWindow;
  now: Date;
  view: TrafficSourcesView;
  total: readonly CountryTraffic[];
  recent: readonly CountryTraffic[];
}): WebTraffic {
  const { window, now, view, total, recent } = input;
  const recentOf = new Map(
    recent.filter((row) => row.clientClass === 'direct').map((row) => [row.country, row]),
  );
  const countries: WebTraffic['countries'] = [];
  let unknown = NONE;
  let throughProxy = NONE;
  let internal = NONE;
  let unverified = NONE;
  for (const row of total) {
    if (row.clientClass === 'proxy') throughProxy = add(throughProxy, row);
    else if (row.clientClass === 'private') internal = add(internal, row);
    else if (row.clientClass === 'unverified') unverified = add(unverified, row);
    else if (!isCountryCode(row.country)) unknown = add(unknown, row);
    else {
      const counts = add(NONE, row);
      const held = recentOf.get(row.country);
      countries.push({
        code: row.country,
        ...counts,
        // As duas leituras são em momentos diferentes: o recente nunca passa do total.
        recentRequests: Math.min(counts.requests, Number(held?.requests ?? 0n)),
        recentFlagged: Math.min(counts.flagged, Number(held?.flagged ?? 0n)),
      });
    }
  }
  return {
    state: stateOf(
      view,
      total.some((row) => row.requests > 0n),
    ),
    window,
    windowHours: WEB_TRAFFIC_WINDOW_HOURS[window],
    generatedAt: now.toISOString(),
    recentMinutes: WEB_TRAFFIC_RECENT_MINUTES,
    lastClosedAt: view.lastClosedAt?.toISOString() ?? null,
    lastLogAt: view.lastLogAt?.toISOString() ?? null,
    countries,
    unknown,
    throughProxy,
    internal,
    unverified,
    sources: view.counts,
  };
}
