import { describe, expect, it } from 'vitest';
import { alertExceptionSchema } from './alert-exceptions.js';
import {
  alertExceptionCreatedSchema,
  alertExceptionOpenPreviewQuerySchema,
  exceptionCreateQuerySchema,
} from './exception-open-alerts.js';

const exception = {
  id: '00000000-0000-7000-8000-000000000001',
  ruleId: '100200',
  field: 'user',
  value: 'automacao',
  reason: 'Job noturno',
  expiresAt: null,
  active: true,
  matchedCount: 3,
  lastMatchedAt: '2026-11-26T12:00:00.000Z',
  createdBy: { id: 'u1', name: 'Pessoa Demo' },
  createdAt: '2026-11-26T12:00:00.000Z',
  updatedAt: '2026-11-26T12:00:00.000Z',
};
const openAlerts = { resolved: 3, keptInIncident: 1, more: false };

describe('alertas em aberto resolvidos pela exceção nova', () => {
  it('o painel de antes recusaria a contagem (contrato estrito): por isso ela só vem para quem pede', () => {
    expect(alertExceptionSchema.safeParse({ ...exception, openAlerts }).success).toBe(false);
    expect(alertExceptionCreatedSchema.parse({ ...exception, openAlerts }).openAlerts).toEqual(openAlerts);
    // O painel novo lê a resposta de um nó de antes, sem a contagem.
    expect(alertExceptionCreatedSchema.parse(exception).openAlerts).toBeUndefined();
  });

  it('o pedido da contagem só aceita true', () => {
    expect(exceptionCreateQuerySchema.safeParse({ openAlerts: 'true' }).success).toBe(true);
    expect(exceptionCreateQuerySchema.safeParse({}).success).toBe(true);
    expect(exceptionCreateQuerySchema.safeParse({ openAlerts: 'false' }).success).toBe(false);
    expect(exceptionCreateQuerySchema.safeParse({ outra: '1' }).success).toBe(false);
  });

  it('a prévia da de usuário, IP ou recurso confere o IP e não aceita campo a mais', () => {
    const base = { ruleId: '100200', field: 'ip', value: '203.0.113.0/24' };
    expect(alertExceptionOpenPreviewQuerySchema.safeParse(base).success).toBe(true);
    expect(alertExceptionOpenPreviewQuerySchema.safeParse({ ...base, value: 'servidor' }).success).toBe(
      false,
    );
    expect(alertExceptionOpenPreviewQuerySchema.safeParse({ ...base, reason: 'x' }).success).toBe(false);
  });
});
