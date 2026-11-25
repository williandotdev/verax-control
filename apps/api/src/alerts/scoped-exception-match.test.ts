import { describe, expect, it } from 'vitest';
import { type ActiveScopedException, matchingScopedException } from './scoped-exception-match.js';

const now = new Date('2026-12-04T12:00:00Z');
const exception = (overrides: Partial<ActiveScopedException> = {}): ActiveScopedException => ({
  id: 'ampla-1',
  ruleId: '990511',
  logSource: 'inspector',
  accountId: '111111111111',
  eventName: 'CVE-2026-0001',
  resourcePrefix: 'arn:aws:ecr:us-east-1:111111111111:repository/api/',
  maxSeverity: 'medium',
  expiresAt: new Date('2026-12-10T00:00:00Z'),
  ...overrides,
});
const alert = {
  ruleId: '990511',
  logSource: 'inspector' as const,
  accountId: '111111111111',
  eventName: 'CVE-2026-0001',
  resource: 'arn:aws:ecr:us-east-1:111111111111:repository/api/sha256:abc',
  severity: 'medium' as const,
};

describe('matchingScopedException', () => {
  it('casa regra, fonte, conta, evento, começo do recurso e severidade até a máxima', () => {
    expect(matchingScopedException(alert, [exception()], now)?.id).toBe('ampla-1');
    expect(matchingScopedException({ ...alert, severity: 'low' }, [exception()], now)).not.toBeNull();
  });

  it('não casa fora do alvo, acima da máxima, crítico, vencida ou com prefixo tratado como curinga', () => {
    const misses = [
      { ...alert, severity: 'high' as const },
      { ...alert, ruleId: '990512' },
      { ...alert, logSource: 'security_hub' as const },
      { ...alert, accountId: '222222222222' },
      { ...alert, eventName: 'CVE-2026-0002' },
      { ...alert, eventName: null },
      { ...alert, resource: null },
      { ...alert, resource: 'arn:aws:ecr:us-east-1:111111111111:repository/apiX/sha256:abc' },
    ];
    for (const miss of misses) expect(matchingScopedException(miss, [exception()], now)).toBeNull();
    expect(
      matchingScopedException({ ...alert, severity: 'critical' }, [exception({ maxSeverity: 'high' })], now),
    ).toBeNull();
    expect(matchingScopedException(alert, [exception({ expiresAt: now })], now)).toBeNull();
    expect(
      matchingScopedException(
        alert,
        [exception({ resourcePrefix: 'arn:aws:ecr:us-east-1:111111111111:repository/a%' })],
        now,
      ),
    ).toBeNull();
  });

  it('sem evento nem prefixo, vale para toda a regra na conta; as regras bloqueadas nunca casam', () => {
    const wide = exception({
      eventName: null,
      resourcePrefix: null,
      ruleId: '100510',
      logSource: 'cloudtrail',
    });
    expect(
      matchingScopedException({ ...alert, ruleId: '100510', logSource: 'cloudtrail' }, [wide], now),
    ).not.toBeNull();
    for (const ruleId of ['100300', '100324', '990403', '990406', '990407']) {
      const blocked = exception({ ruleId, eventName: null, resourcePrefix: null, logSource: 'cloudtrail' });
      expect(
        matchingScopedException({ ...alert, ruleId, logSource: 'cloudtrail' }, [blocked], now),
      ).toBeNull();
    }
  });

  it('compara o evento como o achado o grava, cortado em 256', () => {
    const long = 'E'.repeat(300);
    expect(
      matchingScopedException(
        { ...alert, eventName: long },
        [exception({ eventName: long.slice(0, 256) })],
        now,
      ),
    ).not.toBeNull();
  });
});
