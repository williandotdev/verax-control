import { FINDING_SOURCES, radarSectorOf } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { lastActivityOf, radarSectorOfCase, worstPending } from './case-radar.js';

describe('setor do radar de um caso', () => {
  it('a primeira fonte decide, seja qual for a conta', () => {
    for (const source of FINDING_SOURCES) {
      expect(radarSectorOfCase([source], ['agent:001']), source).toBe(radarSectorOf(source));
    }
    expect(radarSectorOfCase(['waf', 'cloudflare_waf'], [])).toBe('aws');
  });

  it.each([
    ['111122223333', 'aws'],
    ['agent:001', 'agents'],
    ['agent:123456', 'agents'],
    ['d0e0000000000000000000000000a1fa', 'cloudflare'],
    // Um a menos, um a mais, maiúsculas e um caractere que não é hexadecimal: não é um id do Cloudflare.
    ['d0e0000000000000000000000000a1f', 'gcp'],
    ['d0e0000000000000000000000000a1faa', 'gcp'],
    ['D0E0000000000000000000000000A1FA', 'gcp'],
    ['g0e0000000000000000000000000a1fa', 'gcp'],
    ['loja-demo', 'gcp'],
    ['agent:1', 'gcp'],
    ['1111222233334', 'gcp'],
  ])('sem fonte conhecida, o da conta: %s', (account, sector) => {
    expect(radarSectorOfCase([], [account, '111122223333'])).toBe(sector);
  });

  it('sem fonte nem conta, o primeiro setor', () => {
    expect(radarSectorOfCase([], [])).toBe('aws');
  });
});

describe('atividade mais recente de um caso', () => {
  const now = new Date('2026-11-25T12:00:00.000Z');
  const since = new Date('2026-11-24T12:00:00.000Z');
  const at = (text: string) => new Date(text);
  const of = (lastSeenAt: string, lastAlertAt: string) =>
    lastActivityOf({ lastSeenAt: at(lastSeenAt), lastAlertAt: at(lastAlertAt) }, since, now).toISOString();

  it('o evento, se ele é da janela (a ponta conta)', () => {
    expect(of('2026-11-25T09:00:00.000Z', '2026-11-25T11:00:00.000Z')).toBe('2026-11-25T09:00:00.000Z');
    expect(of('2026-11-24T12:00:00.000Z', '2026-11-25T11:00:00.000Z')).toBe('2026-11-24T12:00:00.000Z');
  });

  it('a chegada, se o evento é de antes da janela', () => {
    expect(of('2026-11-24T11:59:59.999Z', '2026-11-25T11:00:00.000Z')).toBe('2026-11-25T11:00:00.000Z');
  });

  it('nunca depois de agora', () => {
    expect(of('2030-01-01T00:00:00.000Z', '2026-11-25T11:00:00.000Z')).toBe(now.toISOString());
    expect(of('2026-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z')).toBe(now.toISOString());
  });
});

describe('pior severidade pendente', () => {
  const none = { pendingCritical: 0, pendingHigh: 0, pendingMedium: 0, pendingLow: 0 };
  it.each([
    [{ pendingCritical: 1, pendingHigh: 9, pendingMedium: 9, pendingLow: 9 }, 'critical'],
    [{ pendingHigh: 1, pendingMedium: 9, pendingLow: 9 }, 'high'],
    [{ pendingMedium: 1, pendingLow: 9 }, 'medium'],
    [{ pendingLow: 1 }, 'low'],
    [{}, null],
  ])('%j', (counts, severity) => {
    expect(worstPending({ ...none, ...counts })).toBe(severity);
  });
});
