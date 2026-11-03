import { describe, expect, it } from 'vitest';
import {
  type Finding,
  findingCommentCreateSchema,
  findingDetailSchema,
  findingListQuerySchema,
  findingSchema,
  findingStatusUpdateSchema,
} from './findings.js';

const finding: Finding = {
  id: '018f2c1e-0000-7000-8000-000000000001',
  accountId: '111122223333',
  occurredAt: '2026-11-02T12:00:00.000Z',
  severity: 'high',
  status: 'new',
  title: 'Login no console sem MFA',
  source: 'cloudtrail',
  eventName: 'ConsoleLogin',
  region: 'us-east-1',
  resource: null,
  actor: { user: 'ana', type: 'IAMUser', accessKeyId: null, ip: '203.0.113.10' },
  mitreTactics: ['Initial Access'],
  incidentId: null,
  commentCount: 0,
};

describe('achados', () => {
  it('aceita o item da lista e o detalhe', () => {
    expect(findingSchema.parse(finding)).toEqual(finding);
    const detail = {
      ...finding,
      ruleId: '80253',
      ruleLevel: 10,
      mitreTechniques: ['T1078'],
      comments: [
        {
          id: '018f2c1e-0000-7000-8000-000000000002',
          author: { id: 'u1', name: 'Ana' },
          body: 'Verificando com o time.\nRetorno até 15h.',
          createdAt: '2026-11-02T12:10:00.000Z',
        },
      ],
      rawEvent: { eventName: 'ConsoleLogin' },
    };
    expect(findingDetailSchema.safeParse(detail).success).toBe(true);
    expect(findingDetailSchema.safeParse({ ...detail, rawEvent: null }).success).toBe(true);
  });

  it.each([
    ['severidade desconhecida', { severity: 'info' }],
    ['status desconhecido', { status: 'closed' }],
    ['origem desconhecida', { source: 'vpcflow' }],
    ['conta fora do formato', { accountId: '123' }],
    ['campo a mais', { extra: 1 }],
  ])('recusa %s', (_name, change) => {
    expect(findingSchema.safeParse({ ...finding, ...change }).success).toBe(false);
  });

  it('filtros da lista vêm da query string e recusam o desconhecido', () => {
    expect(
      findingListQuerySchema.parse({ severity: 'critical', status: 'new', period: '7d', page: '2' }),
    ).toEqual({
      severity: 'critical',
      status: 'new',
      period: '7d',
      page: 2,
      pageSize: 25,
    });
    expect(findingListQuerySchema.safeParse({ ordem: 'asc' }).success).toBe(false);
    expect(findingListQuerySchema.safeParse({ period: '1y' }).success).toBe(false);
  });

  it('comentário aceita quebra de linha e recusa vazio e caractere de controle', () => {
    expect(findingCommentCreateSchema.parse({ body: '  linha 1\nlinha 2  ' })).toEqual({
      body: 'linha 1\nlinha 2',
    });
    expect(findingCommentCreateSchema.safeParse({ body: '   ' }).success).toBe(false);
    expect(findingCommentCreateSchema.safeParse({ body: 'a\u0000b' }).success).toBe(false);
    expect(findingCommentCreateSchema.safeParse({ body: 'x'.repeat(2001) }).success).toBe(false);
  });

  it('mudança de status com comentário opcional', () => {
    expect(findingStatusUpdateSchema.safeParse({ status: 'legitimate' }).success).toBe(true);
    expect(
      findingStatusUpdateSchema.safeParse({ status: 'resolved', comment: 'Chave rotacionada.' }).success,
    ).toBe(true);
    expect(findingStatusUpdateSchema.safeParse({ status: 'deleted' }).success).toBe(false);
  });
});
