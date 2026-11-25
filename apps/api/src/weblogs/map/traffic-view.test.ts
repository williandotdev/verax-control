import { WEB_TRAFFIC_STALE_MS, WEB_TRAFFIC_WINDOWS, webTrafficSchema } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import type { CountryTraffic } from '../store/web-traffic-store.js';
import { buildTraffic, recentRange, type TrafficSource, viewSources, windowRange } from './traffic-view.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Fora de um intervalo de 5 minutos, para o arredondamento aparecer. */
const NOW = new Date('2026-11-24T17:33:21.500Z');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
/** O último intervalo fechado às 17:33:21: o que acabou às 17:20. */
const CLOSED = new Date('2026-11-24T17:20:00.000Z');

const source = (over: Partial<TrafficSource> = {}): TrafficSource => ({
  state: 'collecting',
  authorizedAt: ago(5 * 24 * HOUR),
  lastEventAt: new Date('2026-11-24T17:24:10.000Z'),
  lastIngestedAt: ago(2 * MINUTE),
  position: CLOSED,
  alerting: false,
  ...over,
});

const row = (
  country: string,
  requests: number,
  over: Partial<Omit<CountryTraffic, 'country' | 'requests'>> = {},
): CountryTraffic => ({
  country,
  clientClass: 'direct',
  requests: BigInt(requests),
  blocked: 0n,
  clientErrors: 0n,
  serverErrors: 0n,
  flagged: 0n,
  ...over,
});

const build = (
  total: CountryTraffic[],
  recent: CountryTraffic[] = [],
  sources: TrafficSource[] = [source()],
) =>
  webTrafficSchema.parse(
    buildTraffic({ window: '24h', now: NOW, view: viewSources(sources, NOW), total, recent }),
  );

describe('o estado da leitura', () => {
  it('sem balanceador autorizado, nada a mostrar', () => {
    const view = viewSources([], NOW);
    expect(view).toEqual({
      lastClosedAt: null,
      lastLogAt: null,
      fresh: false,
      seen: false,
      counts: { authorized: 0, collecting: 0, observing: 0, failing: 0 },
    });
    expect(recentRange(view)).toBeNull();
    expect(build([], [], [])).toMatchObject({ state: 'no_source', countries: [], lastClosedAt: null });
  });

  it('o "agora" é o fim do último intervalo fechado, do balanceador mais em dia', () => {
    const view = viewSources(
      [
        source({ position: new Date(CLOSED.getTime() - 3 * HOUR), lastEventAt: ago(4 * HOUR) }),
        source(),
        source({ position: new Date(CLOSED.getTime() - 5 * MINUTE), lastEventAt: null }),
      ],
      NOW,
    );
    expect(view.lastClosedAt).toEqual(CLOSED);
    expect(view.lastLogAt).toEqual(new Date('2026-11-24T17:24:10.000Z'));
    // O de três horas atrás não está em dia.
    expect(view.counts).toEqual({ authorized: 3, collecting: 2, observing: 3, failing: 0 });
    expect(recentRange(view)).toEqual({ from: new Date('2026-11-24T17:05:00.000Z'), to: CLOSED });
  });

  it('em dia até o limite, inclusive; um instante depois, parado, e nada é de agora', () => {
    const lastEventAt = ago(3 * HOUR);
    const at = viewSources([source({ position: ago(WEB_TRAFFIC_STALE_MS), lastEventAt })], NOW);
    expect(at.fresh).toBe(true);
    expect(recentRange(at)).not.toBeNull();
    const stopped = source({ position: ago(WEB_TRAFFIC_STALE_MS + 1), lastEventAt });
    const past = viewSources([stopped], NOW);
    expect(past.fresh).toBe(false);
    expect(past.counts.collecting).toBe(0);
    expect(recentRange(past)).toBeNull();
    expect(build([row('BR', 5)], [], [stopped])).toMatchObject({
      state: 'stale',
      lastClosedAt: ago(WEB_TRAFFIC_STALE_MS + 1).toISOString(),
      lastLogAt: lastEventAt.toISOString(),
    });
  });

  it('recuperando um atraso, vale o intervalo do registro mais novo, se já fechou: os minutos de agora já foram lidos', () => {
    const behind = (over: Partial<TrafficSource> = {}) =>
      viewSources([source({ position: ago(9 * HOUR), ...over })], NOW);
    // O registro das 17:24 é de um intervalo que ainda não fechou: o último fechado é o das 17:20.
    expect(behind()).toMatchObject({ lastClosedAt: CLOSED, fresh: true, counts: { collecting: 1 } });
    // O das 17:11 é do intervalo que acabou às 17:15; o do começo exato, do que começa nele.
    expect(behind({ lastEventAt: new Date('2026-11-24T17:11:00.000Z') }).lastClosedAt).toEqual(
      new Date('2026-11-24T17:15:00.000Z'),
    );
    expect(behind({ lastEventAt: new Date('2026-11-24T17:10:00.000Z') }).lastClosedAt).toEqual(
      new Date('2026-11-24T17:15:00.000Z'),
    );
    // Sem posição desta autorização, também; com o registro de antes dela, não.
    expect(behind({ position: null }).lastClosedAt).toEqual(CLOSED);
    const authorizedAt = ago(20 * MINUTE);
    expect(behind({ position: null, authorizedAt, lastEventAt: ago(21 * MINUTE) }).lastClosedAt).toBeNull();
    expect(behind({ position: null, authorizedAt, lastEventAt: authorizedAt }).lastClosedAt).not.toBeNull();
    // O mais novo dos dois, quando nenhum está em dia.
    expect(behind({ lastEventAt: ago(10 * HOUR) })).toMatchObject({
      lastClosedAt: ago(9 * HOUR),
      fresh: false,
    });
    // Em dia, quem vale é a posição: o registro de um intervalo que o leitor ainda não fechou não adianta o agora.
    const position = new Date('2026-11-24T17:15:00.000Z');
    expect(viewSources([source({ position })], NOW).lastClosedAt).toEqual(position);
  });

  it('a posição de antes desta autorização não vale; a da própria hora vale, e nunca fica no futuro', () => {
    const authorizedAt = ago(2 * MINUTE);
    expect(viewSources([source({ authorizedAt, position: CLOSED })], NOW).lastClosedAt).toBeNull();
    expect(viewSources([source({ authorizedAt, position: authorizedAt })], NOW).lastClosedAt).toEqual(
      authorizedAt,
    );
    // Recém-autorizado às 17:31, a posição é o fim do intervalo em curso (17:35).
    const view = viewSources([source({ authorizedAt, position: new Date('2026-11-24T17:35:00.000Z') })], NOW);
    expect(view.lastClosedAt).toEqual(new Date('2026-11-24T17:30:00.000Z'));
    expect(view.fresh).toBe(true);
    expect(viewSources([source({ position: null, lastEventAt: null })], NOW)).toMatchObject({
      lastClosedAt: null,
      fresh: false,
    });
  });

  it('conta quem só observa e quem está com problema, sem confundir com a leitura em dia', () => {
    const view = viewSources(
      [
        source({ alerting: true }),
        source({ state: 'ingestion_error' }),
        source({ state: 'stalled', position: ago(3 * HOUR), lastEventAt: ago(3 * HOUR), alerting: true }),
        source({ state: 'permission_error', position: ago(9 * HOUR), lastEventAt: ago(9 * HOUR) }),
        source({ state: 'waiting_events' }),
        source({ state: 'authorized', position: null, lastEventAt: null }),
      ],
      NOW,
    );
    // A lacuna (`ingestion_error`) não para a leitura: segue em dia e à vista.
    expect(view.counts).toEqual({ authorized: 6, collecting: 3, observing: 4, failing: 3 });
  });

  it('aguardando: nada lido desde a autorização e nada na janela', () => {
    const fresh = source({
      authorizedAt: ago(10 * MINUTE),
      lastEventAt: null,
      lastIngestedAt: null,
      position: null,
    });
    expect(build([], [], [fresh]).state).toBe('waiting');
    // O que foi lido antes desta autorização não é desta leitura.
    const again = source({
      authorizedAt: ago(10 * MINUTE),
      lastIngestedAt: ago(11 * MINUTE),
      lastEventAt: ago(12 * MINUTE),
      position: null,
    });
    expect(build([], [], [again]).state).toBe('waiting');
    // Mas o tráfego que está na janela aparece; parado, porque nada novo foi lido.
    expect(build([row('BR', 1)], [], [again]).state).toBe('stale');
    // Lido no próprio instante da autorização, é desta leitura.
    const position = new Date('2026-11-24T17:25:00.000Z');
    const read = source({ authorizedAt: ago(10 * MINUTE), lastIngestedAt: ago(10 * MINUTE), position });
    expect(build([], [], [read]).state).toBe('ok');
    // Um balanceador que já leu basta.
    expect(build([], [], [fresh, source()]).state).toBe('ok');
    // Linhas zeradas não são tráfego.
    expect(build([row('BR', 0)], [], [fresh]).state).toBe('waiting');
  });

  it('em dia e sem nenhuma requisição na janela (o site quieto) é "ok", e não "aguardando" nem "parado"', () => {
    expect(
      build([], [], [source({ lastIngestedAt: ago(30 * HOUR), lastEventAt: ago(30 * HOUR) })]),
    ).toMatchObject({
      state: 'ok',
      countries: [],
      lastClosedAt: CLOSED.toISOString(),
      lastLogAt: ago(30 * HOUR).toISOString(),
    });
  });
});

describe('a janela', () => {
  it('24 h por intervalo de 5 minutos; 7 e 30 dias por hora inteira; até agora', () => {
    expect(windowRange('24h', NOW)).toEqual({ from: new Date('2026-11-23T17:30:00.000Z'), to: NOW });
    expect(windowRange('7d', NOW)).toEqual({ from: new Date('2026-11-17T17:00:00.000Z'), to: NOW });
    expect(windowRange('30d', NOW)).toEqual({ from: new Date('2026-10-25T17:00:00.000Z'), to: NOW });
    const hours = WEB_TRAFFIC_WINDOWS.map(
      (window) =>
        buildTraffic({ window, now: NOW, view: viewSources([], NOW), total: [], recent: [] }).windowHours,
    );
    expect(hours).toEqual([24, 168, 720]);
  });
});

describe('os grupos', () => {
  it('cada requisição num grupo só: só o cliente direto tem país', () => {
    const counts = (requests: number) => ({ requests, blocked: 1, flagged: 2 });
    const mark = { blocked: 1n, flagged: 2n };
    const traffic = build(
      [
        row('BR', 100, { ...mark }),
        row('US', 90, { clientClass: 'proxy', ...mark }),
        row('US', 80, { ...mark }),
        row('ZZ', 70, { ...mark }),
        row('ZZ', 60, { clientClass: 'private', ...mark }),
        row('DE', 50, { clientClass: 'unverified', ...mark }),
        row('BR', 40, { clientClass: 'proxy', ...mark }),
        row('ZZ', 30, { clientClass: 'unverified', ...mark }),
        // Fora do formato (o banco não deixa): sem país, e não um código inventado.
        row('b1', 20, { ...mark }),
        row('BRA', 10, { ...mark }),
      ],
      [row('BR', 10, { flagged: 1n }), row('US', 9, { clientClass: 'proxy' }), row('ZZ', 8)],
    );
    expect(traffic.countries).toEqual([
      { code: 'BR', ...counts(100), recentRequests: 10, recentFlagged: 1 },
      { code: 'US', ...counts(80), recentRequests: 0, recentFlagged: 0 },
    ]);
    expect(traffic.unknown).toEqual({ requests: 100, blocked: 3, flagged: 6 });
    expect(traffic.throughProxy).toEqual({ requests: 130, blocked: 2, flagged: 4 });
    expect(traffic.internal).toEqual(counts(60));
    expect(traffic.unverified).toEqual({ requests: 80, blocked: 2, flagged: 4 });
    expect(traffic).toMatchObject({ window: '24h', recentMinutes: 15, generatedAt: NOW.toISOString() });
  });

  it('o recente nunca passa do total, nem cria país que o total não tem', () => {
    const traffic = build(
      [row('BR', 5, { flagged: 1n })],
      [row('BR', 7, { flagged: 3n }), row('AR', 4), row('US', 4, { clientClass: 'private' })],
    );
    expect(traffic.countries).toEqual([
      { code: 'BR', requests: 5, blocked: 0, flagged: 1, recentRequests: 5, recentFlagged: 1 },
    ]);
  });

  it('contagens além do inteiro seguro ficam no teto, uma a uma e na soma', () => {
    const huge = 2n ** 62n;
    const wide = { requests: huge, blocked: huge, flagged: huge };
    const limit = Number.MAX_SAFE_INTEGER;
    const traffic = build(
      [
        { ...row('BR', 0), ...wide },
        { ...row('US', 0, { clientClass: 'proxy' }), ...wide },
        { ...row('DE', 0, { clientClass: 'proxy' }), ...wide },
      ],
      [{ ...row('BR', 0), ...wide }],
    );
    expect(traffic.countries).toEqual([
      {
        code: 'BR',
        requests: limit,
        blocked: limit,
        flagged: limit,
        recentRequests: limit,
        recentFlagged: limit,
      },
    ]);
    expect(traffic.throughProxy).toEqual({ requests: limit, blocked: limit, flagged: limit });
  });
});
