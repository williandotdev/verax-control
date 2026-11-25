import { describe, expect, it } from 'vitest';
import { PLAN_LIMIT_BOUNDS } from './plans.js';
import {
  WEB_TRAFFIC_RECENT_MINUTES,
  WEB_TRAFFIC_WINDOW_HOURS,
  WEB_TRAFFIC_WINDOWS,
  type WebTraffic,
  webTrafficQuerySchema,
  webTrafficSchema,
} from './web-traffic.js';

const none = { requests: 0, blocked: 0, flagged: 0 };
const traffic: WebTraffic = {
  state: 'ok',
  window: '24h',
  windowHours: 24,
  generatedAt: '2026-11-24T17:33:21.500Z',
  recentMinutes: WEB_TRAFFIC_RECENT_MINUTES,
  lastClosedAt: '2026-11-24T17:20:00.000Z',
  lastLogAt: null,
  countries: [{ code: 'BR', requests: 10, blocked: 1, flagged: 2, recentRequests: 3, recentFlagged: 0 }],
  unknown: none,
  throughProxy: none,
  internal: none,
  unverified: none,
  sources: { authorized: 1, collecting: 1, observing: 1, failing: 0 },
};
const accepts = (change: Record<string, unknown>): boolean =>
  webTrafficSchema.safeParse({ ...traffic, ...change }).success;

describe('o pedido do mapa de origens', () => {
  it('24 horas sem pedir outra janela; só as janelas do contrato, e nada além dela', () => {
    expect(webTrafficQuerySchema.parse({})).toEqual({ window: '24h' });
    for (const window of WEB_TRAFFIC_WINDOWS) {
      expect(webTrafficQuerySchema.parse({ window })).toEqual({ window });
    }
    for (const query of [{ window: '1h' }, { window: '' }, { window: ['24h', '7d'] }, { tenantId: 'x' }]) {
      expect(webTrafficQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
    }
  });

  it('toda janela cabe no menor histórico de plano: nenhum plano recusa uma delas', () => {
    const days = WEB_TRAFFIC_WINDOWS.map((window) => WEB_TRAFFIC_WINDOW_HOURS[window] / 24);
    expect(days).toEqual([1, 7, 30]);
    expect(Math.max(...days)).toBeLessThanOrEqual(PLAN_LIMIT_BOUNDS.historyDays.min);
  });
});

describe('a resposta do mapa de origens', () => {
  it('o contrato é estrito, em todo nível', () => {
    expect(accepts({})).toBe(true);
    expect(accepts({ tenantId: 'x' })).toBe(false);
    expect(accepts({ countries: [{ ...traffic.countries[0], ip: '203.0.113.7' }] })).toBe(false);
    expect(accepts({ unknown: { ...none, host: 'x' } })).toBe(false);
    expect(accepts({ sources: { ...traffic.sources, names: ['loja'] } })).toBe(false);
    expect(accepts({ state: 'talvez' })).toBe(false);
    const { unverified: _removed, ...rest } = traffic;
    expect(webTrafficSchema.safeParse(rest).success).toBe(false);
  });

  it('contagens inteiras, seguras e não negativas; país em duas maiúsculas, e nunca o desconhecido', () => {
    const country = traffic.countries[0];
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, '3']) {
      expect(accepts({ countries: [{ ...country, requests: value }] }), String(value)).toBe(false);
      expect(accepts({ internal: { ...none, flagged: value } }), String(value)).toBe(false);
    }
    expect(accepts({ internal: { ...none, flagged: Number.MAX_SAFE_INTEGER } })).toBe(true);
    for (const code of ['br', 'BRA', 'B', '', 'B1', 'ZZ', ' BR']) {
      expect(accepts({ countries: [{ ...country, code }] }), code).toBe(false);
    }
    expect(accepts({ countries: Array.from({ length: 675 }, () => country) })).toBe(true);
    expect(accepts({ countries: Array.from({ length: 676 }, () => country) })).toBe(false);
  });
});
