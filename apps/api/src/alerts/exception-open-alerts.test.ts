import { describe, expect, it } from 'vitest';
import {
  alertExceptionComment,
  alertExceptionTarget,
  type OpenAlertRow,
  scopedExceptionComment,
  scopedExceptionTarget,
} from './exception-open-alerts.js';

const NOW = new Date('2026-11-26T12:00:00.000Z');
const LATER = new Date('2026-12-26T12:00:00.000Z');

const row = (overrides: Partial<OpenAlertRow> = {}): OpenAlertRow => ({
  id: '00000000-0000-7000-8000-000000000001',
  ruleId: '990511',
  logSource: 'inspector',
  accountId: '111111111111',
  eventName: 'CVE-2026-0001',
  resource: 'arn:aws:ecr:us-east-1:111111111111:repository/app',
  actorUser: 'automacao',
  sourceIp: '203.0.113.9',
  severity: 'medium',
  incidentId: null,
  alertCase: null,
  ...overrides,
});

const scoped = {
  id: '00000000-0000-7000-8000-0000000000aa',
  ruleId: '990511',
  logSource: 'inspector',
  accountId: '111111111111',
  eventName: 'CVE-2026-0001',
  resourcePrefix: 'arn:aws:ecr:us-east-1:111111111111:repository/',
  maxSeverity: 'high' as const,
  expiresAt: LATER,
};

describe('alvos da exceção sobre os alertas em aberto (a regra da chegada)', () => {
  it('ampla: crítico nunca, acima da máxima não, evento e começo do recurso iguais', () => {
    const target = scopedExceptionTarget(scoped);
    expect(target.matches(row(), NOW)).toBe(true);
    expect(target.matches(row({ severity: 'high' }), NOW)).toBe(true);
    expect(target.matches(row({ severity: 'critical' }), NOW)).toBe(false);
    expect(scopedExceptionTarget({ ...scoped, maxSeverity: 'low' }).matches(row(), NOW)).toBe(false);
    expect(target.matches(row({ eventName: 'CVE-2026-9999' }), NOW)).toBe(false);
    expect(target.matches(row({ resource: 'arn:aws:ecr:outra' }), NOW)).toBe(false);
    expect(target.matches(row({ accountId: '222222222222' }), NOW)).toBe(false);
    // Vencida, não casa.
    expect(target.matches(row(), LATER)).toBe(false);
    expect(target.link).toEqual({ scopedExceptionId: scoped.id, exceptionId: null });
  });

  it('ampla: regra bloqueada nunca casa, mesmo com a linha gravada à mão', () => {
    const blocked = scopedExceptionTarget({
      ...scoped,
      ruleId: '100310',
      eventName: null,
      resourcePrefix: null,
    });
    expect(blocked.matches(row({ ruleId: '100310' }), NOW)).toBe(false);
  });

  it('o filtro do banco só estreita: nunca leva o crítico e nunca decide o prefixo', () => {
    expect(scopedExceptionTarget({ ...scoped, maxSeverity: 'medium' }).narrow).toMatchObject({
      severity: { in: ['low', 'medium'] },
      eventName: 'CVE-2026-0001',
    });
    expect(scopedExceptionTarget(scoped).narrow).not.toHaveProperty('resource');
  });

  it('usuário, IP (faixa) e recurso, pela comparação de sempre', () => {
    const base = { id: 'e1', ruleId: '990511', expiresAt: null };
    expect(alertExceptionTarget({ ...base, field: 'user', value: 'automacao' }).matches(row(), NOW)).toBe(
      true,
    );
    expect(alertExceptionTarget({ ...base, field: 'user', value: 'outra' }).matches(row(), NOW)).toBe(false);
    const ip = alertExceptionTarget({ ...base, field: 'ip', value: '203.0.113.0/24' });
    expect(ip.matches(row(), NOW)).toBe(true);
    expect(ip.matches(row({ sourceIp: '198.51.100.1' }), NOW)).toBe(false);
    expect(ip.narrow).toEqual({ ruleId: '990511', sourceIp: { not: null } });
    expect(
      alertExceptionTarget({ ...base, field: 'resource', value: row().resource ?? '' }).matches(row(), NOW),
    ).toBe(true);
    expect(alertExceptionTarget({ ...base, field: 'user', value: 'automacao' }).link).toEqual({
      exceptionId: 'e1',
      scopedExceptionId: null,
    });
  });

  it('o comentário diz a exceção e quem a criou, e cabe na coluna', () => {
    const long = 'x'.repeat(256);
    const text = alertExceptionComment(
      { id: 'e1', ruleId: '123456', field: 'resource', value: long },
      'y'.repeat(900),
    );
    expect(text).toContain('exceção de recurso');
    expect(text).toContain('criada por');
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(scopedExceptionComment(scoped, 'Pessoa Demo')).toContain('exceção ampla da regra 990511');
  });
});
