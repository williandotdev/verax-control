import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  paginatedSchema,
  paginationQuerySchema,
  withPagination,
} from './pagination.js';

describe('paginationQuerySchema', () => {
  it('aplica os padrões quando a query vem vazia', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ page: 1, pageSize: DEFAULT_PAGE_SIZE });
  });

  it('converte os valores de texto da query string', () => {
    expect(paginationQuerySchema.parse({ page: '3', pageSize: '50' })).toEqual({ page: 3, pageSize: 50 });
  });

  it.each([
    ['página zero', { page: '0' }],
    ['página negativa', { page: '-1' }],
    ['página fracionária', { page: '1.5' }],
    ['página não numérica', { page: 'abc' }],
    ['página repetida na query', { page: ['1', '2'] }],
    ['pageSize acima do máximo', { pageSize: String(MAX_PAGE_SIZE + 1) }],
    ['pageSize zero', { pageSize: '0' }],
  ])('rejeita %s', (_label, input) => {
    expect(paginationQuerySchema.safeParse(input).success).toBe(false);
  });

  it('rejeita parâmetros desconhecidos', () => {
    const result = paginationQuerySchema.safeParse({ page: '1', orderBy: 'password' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
  });
});

describe('withPagination', () => {
  const schema = withPagination({ status: z.enum(['open', 'closed']).optional() });

  it('aceita os filtros da rota junto com a paginação', () => {
    expect(schema.parse({ status: 'open', page: '2' })).toEqual({
      status: 'open',
      page: 2,
      pageSize: DEFAULT_PAGE_SIZE,
    });
  });

  it('continua estrito', () => {
    expect(schema.safeParse({ status: 'open', tenantId: 'outro-cliente' }).success).toBe(false);
  });
});

describe('paginatedSchema', () => {
  const schema = paginatedSchema(z.strictObject({ id: z.string() }));

  it('valida uma resposta paginada', () => {
    const page = { items: [{ id: 'a' }], page: 1, pageSize: 25, total: 1 };
    expect(schema.parse(page)).toEqual(page);
  });

  it('rejeita campos inesperados nos itens', () => {
    const page = { items: [{ id: 'a', secret: 'x' }], page: 1, pageSize: 25, total: 1 };
    expect(schema.safeParse(page).success).toBe(false);
  });
});
