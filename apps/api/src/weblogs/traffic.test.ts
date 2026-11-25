import { describe, expect, it } from 'vitest';
import {
  albLine,
  Harness,
  LB,
  type LineSpec,
  objectKey,
  prng,
  SLOT,
  T0,
  TEST_RANGES,
  times,
} from '../../test/support/alb-lines.js';
import { loadIpCountry } from '../geo/ip-country.js';
import { CLIENT_CLASSES, ClientClassifier, type ClientClass } from './client-class.js';
import type { OpenResult } from './engine.js';
import { parseIp } from './ip.js';
import { DEFAULT_LIMITS } from './limits.js';
import { type CountryLookup, countryIndex, ObjectTraffic, trafficClassOf } from './traffic.js';

const SOURCE = { tenantId: 't', sourceId: 's' };
const START = new Date(T0 - SLOT);

/** Países fictícios pelo primeiro octeto; o IPv6 pelo segundo grupo, e o NAT64 pelo IPv4 embutido. */
const COUNTRIES: CountryLookup = {
  size: 6,
  // O 198.51.100.255 fica sem país.
  countryOfV4: (word) => (word >>> 0 === 0xc633_64ff ? 0 : ({ 192: 1, 198: 2, 203: 3 }[word >>> 24] ?? 0)),
  countryOfWords: (first, _second, _third, fourth) =>
    first === 0x0064_ff9b ? COUNTRIES.countryOfV4(fourth) : first === 0x2001_0db8 ? 4 : 5,
  code: (index) => [null, 'BR', 'US', 'FR', 'DE', 'JP'][index] ?? null,
};

type Opened = Extract<OpenResult, { ok: true }>;

function open(harness: Harness, traffic: ObjectTraffic | null, endMs = T0): Opened {
  const opened = harness.engine.openObject(objectKey(endMs), endMs + 60_000, traffic);
  if (!opened.ok) throw new Error(opened.reason);
  return opened;
}

function countOf(lines: readonly LineSpec[], options: ConstructorParameters<typeof Harness>[0] = {}) {
  const harness = new Harness({ countries: COUNTRIES, ...options });
  const traffic = new ObjectTraffic(COUNTRIES);
  const object = open(harness, traffic);
  for (const spec of lines) harness.engine.ingest(object, albLine({ time: T0 - 60_000, ...spec }));
  return {
    harness,
    traffic,
    rows: traffic
      .deltas(SOURCE, START)
      .map(({ tenantId: _t, sourceId: _s, slotStart: _d, ...row }) => row)
      .sort((a, b) => (a.country + a.clientClass < b.country + b.clientClass ? -1 : 1)),
  };
}

const row = (country: string, clientClass: string, requests: number, over: Record<string, number> = {}) => ({
  country,
  clientClass,
  requests,
  blocked: 0,
  clientErrors: 0,
  serverErrors: 0,
  flagged: 0,
  ...over,
});

describe('tráfego por país de um objeto', () => {
  it('junta por país e classe; o endereço sem país é ZZ', () => {
    const { rows } = countOf([
      { client: '192.0.2.1' },
      { client: '192.0.2.2' },
      { client: '198.51.100.1' },
      // Uma CDN e um endereço privado, com o país do próprio endereço.
      { client: '203.0.113.1' },
      { client: '203.0.113.200' },
      { client: '10.0.0.1' },
      { client: '2001:db8::1' },
      { client: '198.51.100.255' },
    ]);
    expect(rows).toEqual([
      row('BR', 'direct', 2),
      row('DE', 'direct', 1),
      row('FR', 'proxy', 2),
      row('US', 'direct', 1),
      row('ZZ', 'direct', 1),
      row('ZZ', 'private', 1),
    ]);
  });

  it('cada linha usa o país do próprio endereço, e não o do primeiro do /64 (o NAT64 divide um /64)', () => {
    const { rows } = countOf([
      { client: '64:ff9b::c000:201' },
      { client: '64:ff9b::c633:6401' },
      { client: '64:ff9b::c633:6402' },
      { client: '::ffff:192.0.2.1' },
    ]);
    expect(rows).toEqual([row('BR', 'direct', 2), row('US', 'direct', 2)]);
  });

  it.each([
    [200, {}],
    [399, {}],
    [400, { clientErrors: 1 }],
    [499, { clientErrors: 1 }],
    [500, { serverErrors: 1 }],
    [599, { serverErrors: 1 }],
    [600, {}],
    ['-', {}],
  ] as const)('o status %s do balanceador', (status, over) => {
    expect(countOf([{ client: '192.0.2.1', status, target: 200 }]).rows).toEqual([
      row('BR', 'direct', 1, over),
    ]);
  });

  it('barrada pelo WAF; na linha ambígua, não dá para dizer', () => {
    expect(countOf([{ client: '192.0.2.1', status: 403, actions: 'waf' }]).rows).toEqual([
      row('BR', 'direct', 1, { blocked: 1, clientErrors: 1 }),
    ]);
    expect(countOf([{ client: '192.0.2.1', status: 403, actions: 'waf', userAgent: 'a"b' }]).rows).toEqual([
      row('BR', 'direct', 1, { clientErrors: 1 }),
    ]);
  });

  describe('marcada: sonda, ferramenta ou falha de login, uma vez por linha', () => {
    const login = { method: 'POST', path: '/login' };
    const cases: [string, LineSpec, boolean][] = [
      ['página comum', { path: '/produtos', status: 200 }, false],
      ['404 comum', { path: '/sumiu', status: 404 }, false],
      ['sonda de família secreta, com qualquer resposta', { path: '/.env', status: 200 }, true],
      ['sonda de plataforma recusada', { path: '/wp-login.php', status: 404 }, true],
      ['ferramenta de ataque', { path: '/', userAgent: 'sqlmap/1.8' }, true],
      ['curl não é ferramenta de ataque', { path: '/', userAgent: 'curl/8.0' }, false],
      ['falha de login', { ...login, status: 401 }, true],
      ['sucesso de login', { ...login, status: 302 }, false],
      ['GET na página de login', { path: '/login', status: 200 }, false],
      ['404 numa rota de login', { ...login, status: 404 }, false],
      ['as três de uma vez', { method: 'POST', path: '/.env/login', status: 401, userAgent: 'nikto' }, true],
    ];
    it.each(cases)('%s', (_, spec, flagged) => {
      const { rows } = countOf([{ client: '192.0.2.1', ...spec }]);
      expect(rows.reduce((sum, item) => sum + item.flagged, 0)).toBe(flagged ? 1 : 0);
    });

    const declared = {
      id: 'r1',
      host: null,
      method: 'ANY' as const,
      path: '/entrar',
      kind: 'login' as const,
      failureCodes: [200],
      successCodes: [302],
      multiplier: 1,
    };
    it('a rota declarada vale com os códigos dela, e a ignorada não conta', () => {
      const spec = { client: '192.0.2.1', path: '/entrar' };
      const flagged = (routes: (typeof declared)[], line: LineSpec) =>
        countOf([{ ...spec, ...line }], { routes }).rows[0]?.flagged;
      expect(flagged([declared], { status: 200 })).toBe(1);
      expect(flagged([declared], { status: 302 })).toBe(0);
      expect(flagged([{ ...declared, kind: 'ignore' as never }], { status: 200 })).toBe(0);
      expect(
        flagged([{ ...declared, path: '/login', kind: 'ignore' as never }], { ...login, status: 401 }),
      ).toBe(0);
    });
  });

  it('linha torta e linha de outro balanceador não contam', () => {
    const { harness, traffic } = countOf([{ client: '192.0.2.1' }]);
    const object = open(harness, traffic);
    expect(harness.engine.ingest(object, 'torta')).toBe('malformed');
    expect(harness.engine.ingest(object, albLine({ lb: 'app/outro/fedcba9876543210' }))).toBe('foreign');
    expect(harness.engine.ingest(object, albLine({ client: 'nao-e-ip' }))).toBe('malformed');
    expect(traffic.deltas(SOURCE, START).map((item) => item.requests)).toEqual([1]);
  });

  it('`recount` só soma o tráfego: o motor não vê a linha outra vez', () => {
    const harness = new Harness({ countries: COUNTRIES });
    const lines = times(19, () =>
      albLine({ client: '198.51.100.7', method: 'POST', path: '/login', status: 401 }),
    );
    const first = open(harness, new ObjectTraffic(COUNTRIES));
    for (const line of lines) harness.engine.ingest(first, line);
    const usage = { ...harness.engine.usage };
    const again = new ObjectTraffic(COUNTRIES);
    const object = open(harness, again);
    for (const line of lines) expect(harness.engine.recount(object, line)).toBe('counted');
    expect(harness.engine.recount(object, 'torta')).toBe('malformed');
    expect(harness.engine.recount(object, albLine({ lb: 'app/x/0123456789abcdef' }))).toBe('foreign');
    expect(again.deltas(SOURCE, START)).toMatchObject([{ country: 'US', requests: 19, flagged: 19 }]);
    expect(harness.engine.usage).toEqual(usage);
    const result = harness.evaluate();
    expect(result.drafts).toEqual([]);
    expect(result.counters).toMatchObject({ lines: 19, malformed: 0, foreign: 0 });
  });

  it('sem a conta por país, o motor é o mesmo', () => {
    const harness = new Harness();
    const object = open(harness, null);
    for (let i = 0; i < 30; i += 1) {
      harness.engine.ingest(
        object,
        albLine({ client: '198.51.100.7', method: 'POST', path: '/login', status: 401 }),
      );
    }
    expect(harness.evaluate().drafts).toHaveLength(1);
  });

  it('a linha mais recente do objeto, e nenhuma num objeto sem linha', () => {
    const { traffic } = countOf([
      { client: '192.0.2.1', time: T0 - 90_000 },
      { client: '192.0.2.1', time: T0 - 30_000 },
      { client: '192.0.2.1', time: T0 - 60_000 },
    ]);
    expect(traffic.newestMs).toBe(T0 - 30_000);
    expect(new ObjectTraffic(COUNTRIES).newestMs).toBe(0);
    expect(new ObjectTraffic(null).deltas(SOURCE, START)).toEqual([]);
  });

  it('sem a tabela, tudo sai com o país desconhecido e nada lança', () => {
    const harness = new Harness({ countries: null });
    const traffic = new ObjectTraffic(null);
    const object = open(harness, traffic);
    for (const client of ['192.0.2.1', '2001:db8::1', '10.0.0.1']) {
      harness.engine.ingest(object, albLine({ client }));
    }
    expect(
      traffic.deltas(SOURCE, START).map((item) => [item.country, item.clientClass, item.requests]),
    ).toEqual([
      ['ZZ', 'direct', 2],
      ['ZZ', 'private', 1],
    ]);
  });

  it('toda classe de cliente cai numa classe do tráfego', () => {
    for (const cls of CLIENT_CLASSES) {
      const traffic = new ObjectTraffic(COUNTRIES);
      traffic.count(1, cls, 200, false, false, 1);
      expect(traffic.deltas(SOURCE, START)).toMatchObject([
        { country: 'BR', clientClass: trafficClassOf(cls), requests: 1 },
      ]);
    }
  });

  it('com a tabela de verdade, o caminho numérico dá o mesmo que a consulta por texto', () => {
    const table = loadIpCountry();
    const random = prng(11);
    const group = () => Math.floor(random() * 0x10000).toString(16);
    for (let i = 0; i < 2_000; i += 1) {
      const octet = () => Math.floor(random() * 256);
      const text =
        i % 2 === 0
          ? `${octet()}.${octet()}.${octet()}.${octet()}`
          : `${(0x2000 + Math.floor(random() * 0x1000)).toString(16)}:${group()}:${group()}::${group()}`;
      const ip = parseIp(text);
      if (ip === null) throw new Error(text);
      expect([text, table.code(countryIndex(table, ip.version, ip.words))]).toEqual([
        text,
        table.countryOf(text),
      ]);
    }
  });

  /**
   * A prova de que a conta não depende da memória do motor: a mesma entrada, contada por fora, linha a linha, com os tetos
   * apertados, uma enchente de endereços e as trocas de slot que esvaziam tudo.
   */
  it.each([
    ['com folga', {}],
    [
      'com os registros saindo da memória o tempo todo',
      { maxClients: 50, maxLoginCells: 20, maxRouteClients: 10, maxDetails: 5, maxHosts: 3 },
    ],
    [
      'sem lugar para quase ninguém',
      { maxClients: 1, maxLoginCells: 1, maxRouteClients: 1, maxPathSets: 0, maxHashCells: 0 },
    ],
  ])('igual a uma contagem independente, %s', (_, limits) => {
    const random = prng(29);
    const classifier = new ClientClassifier({ now: T0, ranges: TEST_RANGES });
    const harness = new Harness({ countries: COUNTRIES, limits: { ...DEFAULT_LIMITS, ...limits } });
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const clientOf = (i: number): string => {
      const kind = i % 7;
      if (kind === 0 || kind > 4)
        return `2001:db8:${(i >> 8).toString(16)}:${(i & 0xff).toString(16)}::${(i % 9).toString(16)}`;
      if (kind === 1) return `198.51.100.${i % 256}`;
      if (kind === 2) return `64:ff9b::c000:${(0x200 + (i % 256)).toString(16)}`;
      if (kind === 3) return `203.0.113.${i % 256}`;
      return i % 2 === 0 ? `10.${i % 200}.1.1` : `192.0.2.${i % 250}`;
    };
    const expected = new Map<string, number[]>();
    const total = new Map<string, number[]>();
    for (let slot = 0; slot < 6; slot += 1) {
      const endMs = T0 + slot * SLOT;
      const traffic = new ObjectTraffic(COUNTRIES);
      const object = open(harness, traffic, endMs);
      for (let i = 0; i < 1_500; i += 1) {
        const client = clientOf(Math.floor(random() * 4_000));
        const status = pick([200, 200, 302, 401, 403, 404, 500, 503]);
        const probe = random() < 0.1;
        const login = !probe && random() < 0.3;
        const tool = random() < 0.1;
        const blocked = random() < 0.2;
        const outcome = harness.engine.ingest(
          object,
          albLine({
            time: endMs - 1_000,
            client,
            status,
            method: login ? 'POST' : 'GET',
            path: probe ? `/x${i}/.env` : login ? '/login' : `/p${i}?x=1`,
            userAgent: tool ? 'sqlmap/1.8' : `navegador ${i}`,
            domain: `h${i % 40}.exemplo.com.br`,
            actions: blocked ? 'waf' : 'waf,forward',
          }),
        );
        expect(outcome).toBe('counted');
        const ip = parseIp(client);
        if (ip === null) throw new Error(client);
        const cls: ClientClass = classifier.classify(ip);
        const country = COUNTRIES.code(countryIndex(COUNTRIES, ip.version, ip.words)) ?? 'ZZ';
        const key = `${slot}|${country}|${trafficClassOf(cls)}`;
        const held = expected.get(key) ?? [0, 0, 0, 0, 0];
        held[0] = (held[0] ?? 0) + 1;
        if (blocked) held[1] = (held[1] ?? 0) + 1;
        if (status >= 400 && status < 500) held[2] = (held[2] ?? 0) + 1;
        if (status >= 500) held[3] = (held[3] ?? 0) + 1;
        if (probe || tool || (login && [401, 403].includes(status))) held[4] = (held[4] ?? 0) + 1;
        expected.set(key, held);
      }
      for (const item of traffic.deltas(SOURCE, START)) {
        total.set(`${slot}|${item.country}|${item.clientClass}`, [
          item.requests,
          item.blocked,
          item.clientErrors,
          item.serverErrors,
          item.flagged,
        ]);
      }
      harness.engine.evaluate({ now: endMs + 60_000 });
    }
    expect([...total].sort()).toEqual([...expected].sort());
    expect([...expected.values()].reduce((sum, [requests = 0]) => sum + requests, 0)).toBe(9_000);
  });

  it('o balanceador das linhas do teste é o do motor', () => {
    expect(albLine().split(' ')[2]).toBe(LB);
  });
});
