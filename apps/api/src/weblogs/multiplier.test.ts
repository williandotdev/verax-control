import { describe, expect, it } from 'vitest';
import { Harness, type LineSpec, T0, times } from '../../test/support/alb-lines.js';

/**
 * O multiplicador do cliente (`WebSourceSettings.thresholdMultiplier`): cada limite de contagem em −1, 0 e +1, para menos e
 * para mais; o que não é limite de contagem não muda; e ele se multiplica com o da rota declarada e com o da cara de NAT.
 */
const CLIENT = '198.51.100.7';

/** As regras que disparam (achado próprio ou marca do resumo), com o nível. */
function fire(
  lines: readonly LineSpec[],
  multiplier?: number,
  options: ConstructorParameters<typeof Harness>[0] = {},
) {
  const harness = new Harness(options);
  harness.feed(lines);
  const { drafts } = harness.evaluate(T0 + 60_000, multiplier === undefined ? {} : { multiplier });
  return drafts.map((draft) => `${draft.ruleId}:${draft.ruleLevel}`).sort();
}
const fires = (rule: string, lines: readonly LineSpec[], multiplier: number, options = {}): boolean =>
  // 990401, 990402 e 990404 sozinhas ficam no resumo do dia.
  fire(lines, multiplier, options).some((id) => id.startsWith(rule) || id.startsWith('990400'));

const tool = (n: number) => times(n, () => ({ client: CLIENT, userAgent: 'sqlmap/1.8' }));
/** Duas famílias, para não passar pela regra das três. */
const probes = (n: number) =>
  times(n, (i) => ({ client: CLIENT, path: `/a${i}/${i % 2 === 0 ? '.env' : '.git/config'}`, status: 404 }));
const enumeration = (n: number) => times(n, (i) => ({ client: CLIENT, path: `/sumiu/${i}`, status: 404 }));
const post = (n: number, status: number, client = CLIENT): LineSpec[] =>
  times(n, (i) => ({ client, method: 'POST', path: '/login', status, time: T0 - 240_000 + i * 100 }));
const hard = (n: number) => post(n, 401);
/** A rota que não distingue falha de sucesso: só o volume. */
const volume = (n: number) => post(n, 200);
const broken = (n: number) => [
  ...hard(n),
  { client: CLIENT, method: 'POST', path: '/login', status: 302, time: T0 - 60_000 },
];
/** Falhas divididas por 60 endereços. */
const distributed = (n: number) =>
  times(n, (i) => ({
    client: `198.51.100.${(i % 60) + 1}`,
    method: 'POST',
    path: '/login',
    status: 401,
  }));

const LIMITS: [string, number, (n: number) => LineSpec[]][] = [
  ['990401', 5, tool],
  ['990402', 10, probes],
  ['990404', 100, enumeration],
  ['990405', 20, hard],
  ['990405', 60, volume],
  ['990406', 10, broken],
  ['990407', 500, distributed],
];

describe('multiplicador do cliente', () => {
  describe.each([0.5, 1, 1.1, 2])('vezes %d', (multiplier) => {
    it.each(LIMITS)('%s com o limite de %d', (rule, base, build) => {
      const limit = Math.ceil(Number((base * multiplier).toFixed(6)));
      expect([limit - 1, fires(rule, build(limit - 1), multiplier)]).toEqual([limit - 1, false]);
      expect([limit, fires(rule, build(limit), multiplier)]).toEqual([limit, true]);
      expect([limit + 1, fires(rule, build(limit + 1), multiplier)]).toEqual([limit + 1, true]);
    });

    it('a 990404 também pelos caminhos distintos', () => {
      const limit = Math.ceil(Number((40 * multiplier).toFixed(6)));
      const lines = (paths: number) =>
        times(400, (i) => ({ client: CLIENT, path: `/sumiu/${i % paths}`, status: 404 }));
      expect(fires('990404', lines(limit - 1), multiplier)).toBe(false);
      expect(fires('990404', lines(limit), multiplier)).toBe(true);
    });

    it('os níveis altos', () => {
      const at = (base: number) => Math.ceil(Number((base * multiplier).toFixed(6)));
      const level = (rule: string, lines: LineSpec[]) =>
        fire(lines, multiplier).find((id) => id.startsWith(rule));
      expect(level('990405', hard(at(100) - 1))).toBe('990405:7');
      expect(level('990405', hard(at(100)))).toBe('990405:10');
      expect(level('990406', broken(at(50) - 1))).toBe('990406:10');
      expect(level('990406', broken(at(50)))).toBe('990406:12');
    });
  });

  it('o padrão é 1', () => {
    expect(fire(hard(19))).toEqual([]);
    expect(fire(hard(20))).toEqual(['990405:7']);
  });

  it('razões, as três famílias de sonda e os 30 endereços da 990407 não mudam', () => {
    // Três famílias, três sondas: dispara com qualquer multiplicador.
    const families = ['/.env', '/.git/config', '/phpinfo.php'].map((path) => ({
      client: CLIENT,
      path,
      status: 404,
    }));
    for (const multiplier of [0.5, 10]) expect(fires('990402', families, multiplier)).toBe(true);
    // 29 endereços não são 30, mesmo com o limite de falhas pela metade.
    const few = times(580, (i) => ({
      client: `198.51.100.${(i % 29) + 1}`,
      method: 'POST',
      path: '/login',
      status: 401,
    }));
    expect(fire(few, 0.5).filter((id) => id.startsWith('990407'))).toEqual([]);
    // Metade das tentativas deu certo: a razão da 990405 continua 0,7.
    const half = [...post(40, 401), ...post(40, 302)];
    expect(fire(half, 0.5).filter((id) => id.startsWith('990405'))).toEqual([]);
  });

  it('a 990403 não tem limite: uma resposta basta, com qualquer multiplicador', () => {
    const answered = [{ client: CLIENT, path: '/.env', status: 200, sent: 4_321 }];
    for (const multiplier of [0.5, 10]) {
      expect(fire(answered, multiplier)).toEqual(['990403:10']);
    }
  });

  it('multiplica com o da rota declarada', () => {
    const routes = [
      {
        id: 'r',
        host: null,
        method: 'POST' as const,
        path: '/login',
        kind: 'login' as const,
        failureCodes: [401],
        successCodes: [302],
        multiplier: 2,
      },
    ];
    expect(fire(hard(59), 1.5, { routes })).toEqual([]);
    expect(fire(hard(60), 1.5, { routes })).toEqual(['990405:7']);
  });

  it('multiplica com o da cara de NAT', () => {
    const office = times(25, (i) => ({
      client: CLIENT,
      method: 'POST',
      path: '/entrar/login',
      status: 302,
      userAgent: `Mozilla/5.0 (pessoa ${i})`,
    }));
    // 20 vezes 5 vezes 2.
    expect(fire([...office, ...hard(199)], 2).filter((id) => id.startsWith('990405'))).toEqual([]);
    expect(fire([...office, ...hard(200)], 2).filter((id) => id.startsWith('990405'))).toEqual(['990405:7']);
  });
});
