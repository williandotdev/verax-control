import { describe, expect, it } from 'vitest';
import { auditEntryDetailSchema, auditListQuerySchema } from './audit.js';

const entry = {
  id: '018f2c1e-0000-7000-8000-0000000b0001',
  occurredAt: '2026-11-03T12:00:00.000Z',
  actor: { type: 'user', id: 'usuario-1', name: 'Ana Admin', verax: false },
  action: 'cloud_account.create',
  resourceType: 'cloud_account',
  resourceId: 'conta-a',
  outcome: 'success',
  statusCode: 201,
  ip: '203.0.113.10',
  requestId: 'req-1',
};

describe('auditoria', () => {
  it('filtros da lista: estritos, com paginação', () => {
    expect(auditListQuerySchema.parse({ outcome: 'denied', period: '7d', page: '2' })).toEqual({
      outcome: 'denied',
      period: '7d',
      page: 2,
      pageSize: 25,
    });
    expect(auditListQuerySchema.safeParse({ resourceType: 'widget' }).success).toBe(false);
    expect(auditListQuerySchema.safeParse({ tenantId: 'x' }).success).toBe(false);
    expect(auditListQuerySchema.parse({ period: '12m' })).toMatchObject({ period: '12m' });
    expect(auditListQuerySchema.safeParse({ period: '1y' }).success).toBe(false);
  });

  it('detalhe com o estado anterior e o novo em JSON, nunca outra coisa', () => {
    const detail = {
      ...entry,
      userAgent: null,
      before: null,
      after: { regions: ['sa-east-1'], ativo: true },
    };
    expect(auditEntryDetailSchema.parse(detail)).toEqual(detail);
    expect(auditEntryDetailSchema.safeParse({ ...detail, extra: 1 }).success).toBe(false);
  });
});
