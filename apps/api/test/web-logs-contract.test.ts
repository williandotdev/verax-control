import {
  normalizeTrustedCidr,
  WEB_MULTIPLIER_BOUNDS,
  WEB_ROUTE_KINDS,
  WEB_ROUTE_METHODS,
  WEB_ROUTES_LIMIT,
  WEB_TRUSTED_KINDS,
  WEB_TRUSTED_LIMIT,
  WEB_TRUSTED_MAX_VALIDITY_MS,
  webRouteCreateSchema,
  webTrustedSourceCreateSchema,
} from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { cidrContains, parseCidr, parseIp } from '../src/weblogs/ip.js';
import {
  MAX_ROUTES,
  RouteTable,
  WEB_ROUTE_KINDS as ENGINE_ROUTE_KINDS,
  webRouteSchema,
} from '../src/weblogs/routes.js';
import {
  MAX_TRUSTED,
  TRUSTED_KINDS,
  TrustedSources,
  webTrustedSourceSchema,
} from '../src/weblogs/trusted-sources.js';

/**
 * O cadastro (`packages/shared/src/web-logs.ts`) e o motor (`apps/api/src/weblogs/`) têm de concordar: o que a API aceita e
 * guarda, o motor aceita, sem recusar nada em silêncio e com o mesmo significado.
 */

const NOW = Date.parse('2026-11-24T12:00:00.000Z');
const ID = '018f0000-0000-7000-8000-000000000001';

/** Um gerador fixo: a mesma sequência a cada execução. */
function sequence(seed: number): (max: number) => number {
  let state = seed >>> 0;
  return (max) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return Math.floor((state / 2 ** 32) * max);
  };
}

describe('cadastro e motor: fontes confiáveis', () => {
  it('os mesmos tipos, o mesmo teto e a mesma validade', () => {
    expect([...WEB_TRUSTED_KINDS]).toEqual([...TRUSTED_KINDS]);
    expect(WEB_TRUSTED_LIMIT).toBe(MAX_TRUSTED);
    const at = (ms: number) => new Date(NOW + ms).toISOString();
    const source = (expiresAt: string) => ({
      id: ID,
      cidr: '192.0.2.0/24',
      kind: 'office' as const,
      reason: 'teste',
      expiresAt,
    });
    expect(new TrustedSources([source(at(WEB_TRUSTED_MAX_VALIDITY_MS))], NOW).rejected).toEqual([]);
    expect(new TrustedSources([source(at(WEB_TRUSTED_MAX_VALIDITY_MS + 1))], NOW).rejected).toEqual([ID]);
  });

  it('a faixa normalizada é aceita pelo motor e cobre os mesmos endereços que a escrita pelo cliente', () => {
    const next = sequence(20_261_124);
    const hextet = () => next(65_536).toString(16);
    let accepted = 0;
    for (let i = 0; i < 4_000; i += 1) {
      const v4 = i % 2 === 0;
      const prefix = v4 ? next(36) : 28 + next(40);
      // Metade com os bits de máquina zerados na mão, metade como vier.
      const groups = v4
        ? Array.from({ length: 4 }, () => String(next(258)))
        : Array.from({ length: 4 }, () => (next(3) === 0 ? '0' : hextet()));
      const text = v4
        ? `${groups.slice(0, 2).join('.')}.${next(2) === 0 ? '0.0' : groups.slice(2).join('.')}/${prefix}`
        : `${next(2) === 0 ? groups.slice(0, 2).join(':') : groups.join(':')}::/${prefix}`;
      const normalized = normalizeTrustedCidr(text);
      const engine = webTrustedSourceSchema.safeParse({
        id: ID,
        cidr: normalized ?? text,
        kind: 'office',
        reason: 'teste',
        expiresAt: new Date(NOW).toISOString(),
      }).success;
      if (normalized === null) continue;
      accepted += 1;
      expect(engine, `${text} -> ${normalized}`).toBe(true);
      const [written, stored] = [parseCidr(text), parseCidr(normalized)];
      expect(written, text).not.toBeNull();
      expect(stored).toEqual(written);
      // Normalizar de novo não muda: a unicidade no banco é pelo texto.
      expect(normalizeTrustedCidr(normalized)).toBe(normalized);
    }
    expect(accepted).toBeGreaterThan(500);
  });

  it('o que o motor recusa, o cadastro recusa', () => {
    for (const cidr of [
      '0.0.0.0/0',
      '198.50.0.0/15',
      '198.51.100.1/24',
      '::/0',
      '2001::/31',
      '2001:db8::/65',
      '2001:db8::1/128',
      '::ffff:192.0.2.0/120',
      '198.51.100.0',
      'escritorio',
    ]) {
      expect(normalizeTrustedCidr(cidr), cidr).toBeNull();
      const body = {
        sourceId: null,
        cidr,
        kind: 'office',
        reason: 'x',
        expiresAt: new Date(NOW).toISOString(),
      };
      expect(webTrustedSourceCreateSchema.safeParse(body).success, cidr).toBe(false);
    }
  });

  it('a faixa guardada casa com quem está nela, e só com quem está', () => {
    const cidr = parseCidr(normalizeTrustedCidr('2001:0DB8:0:0007::/64') ?? '');
    const contains = (text: string) => {
      const ip = parseIp(text);
      return cidr !== null && ip !== null && cidrContains(cidr, ip);
    };
    expect(contains('2001:db8:0:7:1:2:3:4')).toBe(true);
    expect(contains('2001:db8:0:8::1')).toBe(false);
  });
});

describe('cadastro e motor: rotas', () => {
  it('os mesmos tipos, o mesmo teto e o mesmo multiplicador', () => {
    expect([...WEB_ROUTE_KINDS]).toEqual([...ENGINE_ROUTE_KINDS]);
    expect([...WEB_ROUTE_METHODS]).toEqual([...webRouteSchema.shape.method.options]);
    expect(WEB_ROUTES_LIMIT).toBe(MAX_ROUTES);
    const base = {
      id: ID,
      host: null,
      method: 'ANY',
      path: '/',
      kind: 'login',
      failureCodes: [],
      successCodes: [],
    };
    for (const [multiplier, expected] of [
      [WEB_MULTIPLIER_BOUNDS.min, true],
      [WEB_MULTIPLIER_BOUNDS.max, true],
      [WEB_MULTIPLIER_BOUNDS.min - 0.01, false],
      [WEB_MULTIPLIER_BOUNDS.max + 0.01, false],
    ] as const) {
      expect(webRouteSchema.safeParse({ ...base, multiplier }).success).toBe(expected);
    }
  });

  it('a rota que o cadastro aceita, o motor aceita e casa', () => {
    const next = sequence(7);
    const alphabet = [
      'login',
      'API',
      '*',
      'a.b',
      'c_d',
      '~x',
      '-',
      '..',
      '.',
      'á',
      'x y',
      'log*',
      '%2e',
      'v1',
    ];
    let accepted = 0;
    for (let i = 0; i < 4_000; i += 1) {
      const path = `/${Array.from({ length: 1 + next(9) }, () => alphabet[next(alphabet.length)]).join('/')}`;
      const parsed = webRouteCreateSchema.safeParse({
        host: next(2) === 0 ? null : 'Loja.Example.com',
        method: 'POST',
        path,
        kind: 'login',
        failureCodes: [401],
        successCodes: [],
        multiplier: 1,
      });
      if (!parsed.success) continue;
      accepted += 1;
      const route = { id: ID, ...parsed.data };
      expect(webRouteSchema.safeParse(route).success, path).toBe(true);
      const table = new RouteTable([route]);
      const segments = parsed.data.path
        .slice(1)
        .split('/')
        .map((segment) => (segment === '*' ? 'qualquer' : segment));
      expect(table.match(parsed.data.host ?? 'outro', 'POST', segments), path).not.toBeNull();
      expect(table.match(parsed.data.host ?? 'outro', 'POST', [...segments, 'mais'])).toBeNull();
    }
    expect(accepted).toBeGreaterThan(50);
  });
});
