import { describe, expect, it } from 'vitest';
import {
  alertExceptionBatchSchema,
  canWriteScopedExceptions,
  isScopedExceptionBlocked,
  MAX_ALERT_EXCEPTIONS_PER_REQUEST,
  scopedExceptionCreateSchema,
  scopedExceptionNeedsEvent,
  scopedExceptionPreviewQuerySchema,
  severityWithin,
} from './scoped-exceptions.js';

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const base = {
  ruleId: '990511',
  logSource: 'inspector',
  accountId: '111111111111',
  eventName: 'CVE-2026-0001',
  reason: 'Pacote sem correção do fornecedor',
  expiresAt: inDays(30),
};

describe('exceções amplas', () => {
  it('aceita o alvo completo, com a severidade média por padrão', () => {
    const parsed = scopedExceptionCreateSchema.parse(base);
    expect(parsed.maxSeverity).toBe('medium');
  });

  it('nunca aceita crítico, e alto só pelo valor explícito', () => {
    expect(scopedExceptionCreateSchema.safeParse({ ...base, maxSeverity: 'critical' }).success).toBe(false);
    expect(scopedExceptionCreateSchema.parse({ ...base, maxSeverity: 'high' }).maxSeverity).toBe('high');
  });

  it('a validade é obrigatória, no futuro e de até 90 dias', () => {
    const { expiresAt: _, ...withoutExpiry } = base;
    expect(scopedExceptionCreateSchema.safeParse(withoutExpiry).success).toBe(false);
    expect(scopedExceptionCreateSchema.safeParse({ ...base, expiresAt: inDays(91) }).success).toBe(false);
    expect(scopedExceptionCreateSchema.safeParse({ ...base, expiresAt: inDays(-1) }).success).toBe(false);
    expect(scopedExceptionCreateSchema.safeParse({ ...base, expiresAt: inDays(89) }).success).toBe(true);
  });

  it('exige o evento nas regras de classe e recusa as regras bloqueadas', () => {
    for (const ruleId of ['990501', '990502', '990511', '80300', '80303', '80309']) {
      expect(scopedExceptionNeedsEvent(ruleId), ruleId).toBe(true);
      const { eventName: _, ...noEvent } = { ...base, ruleId };
      expect(scopedExceptionPreviewQuerySchema.safeParse(noEvent).success, ruleId).toBe(false);
    }
    expect(scopedExceptionNeedsEvent('80310')).toBe(false);
    for (const ruleId of ['100300', '100312', '100324', '990403', '990406', '990407']) {
      expect(isScopedExceptionBlocked(ruleId), ruleId).toBe(true);
      expect(scopedExceptionCreateSchema.safeParse({ ...base, ruleId }).success, ruleId).toBe(false);
    }
    expect(isScopedExceptionBlocked('100325')).toBe(false);
    expect(isScopedExceptionBlocked('990404')).toBe(false);
  });

  it('a conta é obrigatória, sem espaço nem controle; o corpo é estrito', () => {
    expect(scopedExceptionCreateSchema.safeParse({ ...base, accountId: '' }).success).toBe(false);
    expect(scopedExceptionCreateSchema.safeParse({ ...base, accountId: '1111 1111' }).success).toBe(false);
    expect(scopedExceptionCreateSchema.safeParse({ ...base, tenantId: 'x' }).success).toBe(false);
    expect(scopedExceptionCreateSchema.safeParse({ ...base, reason: 'a\u0007b' }).success).toBe(false);
    expect(scopedExceptionCreateSchema.safeParse({ ...base, resourcePrefix: 'arn:aw' }).success).toBe(false);
  });

  it('severidade dentro do teto, crítico nunca', () => {
    expect(severityWithin('medium', 'medium')).toBe(true);
    expect(severityWithin('high', 'medium')).toBe(false);
    expect(severityWithin('critical', 'high')).toBe(false);
  });

  it('só administradores escrevem', () => {
    expect(canWriteScopedExceptions('admin_cliente')).toBe(true);
    expect(canWriteScopedExceptions('admin_verax')).toBe(true);
    expect(canWriteScopedExceptions('analista_cliente')).toBe(false);
    expect(canWriteScopedExceptions('leitura')).toBe(false);
  });

  it('exceções de um caso: até 20 valores, sem repetição, IP válido', () => {
    const batch = { ruleId: '100510', field: 'ip', reason: 'Varredura autorizada' };
    const ips = Array.from({ length: MAX_ALERT_EXCEPTIONS_PER_REQUEST + 1 }, (_, i) => `198.51.100.${i + 1}`);
    expect(alertExceptionBatchSchema.safeParse({ ...batch, values: ips.slice(0, 20) }).success).toBe(true);
    expect(alertExceptionBatchSchema.safeParse({ ...batch, values: ips }).success).toBe(false);
    expect(
      alertExceptionBatchSchema.safeParse({ ...batch, values: ['198.51.100.1', '198.51.100.1'] }).success,
    ).toBe(false);
    expect(alertExceptionBatchSchema.safeParse({ ...batch, values: ['nao-e-ip'] }).success).toBe(false);
  });
});
