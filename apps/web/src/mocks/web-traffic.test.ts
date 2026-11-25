import { WEB_TRAFFIC_STATES, WEB_TRAFFIC_WINDOWS, webTrafficSchema } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { isFlagged } from '@/components/security/world-map-model';
import { demoWebTraffic } from './web-traffic';

const at = (minute: number, second = 0) => new Date(Date.UTC(2026, 10, 24, 17, minute, second));
const pulsing = (minute: number) =>
  demoWebTraffic('ok', '24h', at(minute))
    .countries.filter((country) => country.recentRequests > 0)
    .map((country) => country.code)
    .sort();

describe('mapa de origens da demonstração', () => {
  it('toda situação e toda janela seguem o contrato da API', () => {
    for (const state of WEB_TRAFFIC_STATES) {
      for (const window of WEB_TRAFFIC_WINDOWS) {
        const traffic = demoWebTraffic(state, window, at(33));
        expect(webTrafficSchema.parse(traffic)).toEqual(traffic);
        expect(traffic.state).toBe(state);
        expect(traffic.window).toBe(window);
        for (const country of traffic.countries) {
          expect(country.recentRequests).toBeLessThanOrEqual(country.requests);
          expect(country.recentFlagged).toBeLessThanOrEqual(country.flagged);
          expect(country.blocked).toBeLessThanOrEqual(country.flagged);
        }
      }
    }
  });

  it('no mesmo minuto é sempre a mesma; noutro, outros países pulsam, e nunca poucos nem todos', () => {
    const [first, again] = [demoWebTraffic('ok', '24h', at(33)), demoWebTraffic('ok', '24h', at(33, 59))];
    expect(again.countries).toEqual(first.countries);
    for (let minute = 0; minute < 30; minute += 1) {
      expect(pulsing(minute + 1)).not.toEqual(pulsing(minute));
      expect(pulsing(minute).length).toBeGreaterThan(15);
      expect(pulsing(minute).length).toBeLessThan(first.countries.length);
    }
  });

  it('alguns países passam do limite da marca, em toda janela; a maioria, não', () => {
    for (const window of WEB_TRAFFIC_WINDOWS) {
      const { countries, windowHours } = demoWebTraffic('ok', window, at(33));
      const flagged = countries.filter((country) => isFlagged(country, windowHours));
      expect(flagged.length, window).toBeGreaterThanOrEqual(5);
      expect(flagged.length, window).toBeLessThanOrEqual(10);
      expect(countries.filter((country) => country.flagged > 0).length).toBeGreaterThan(flagged.length);
    }
  });

  it('o agora acaba no último intervalo fechado, como na leitura de verdade; parada, nada é de agora', () => {
    expect(demoWebTraffic('ok', '24h', at(33)).lastClosedAt).toBe(at(20).toISOString());
    const stale = demoWebTraffic('stale', '24h', at(33));
    expect(stale.countries.every((country) => country.recentRequests === 0)).toBe(true);
    expect(stale.countries.length).toBeGreaterThan(0);
  });
});
