import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '../../generated/prisma/client.js';
import { scopeArgs, scopeToTenant, TenantScopeViolation } from './tenant-scope.js';

const A = '018f0000-0000-7000-8000-00000000000a';
const B = '018f0000-0000-7000-8000-00000000000b';

describe('scopeArgs', () => {
  it.each(['findMany', 'findFirst', 'findUnique', 'count', 'update', 'updateMany', 'delete', 'deleteMany'])(
    '%s recebe o filtro do cliente',
    (operation) => {
      expect(scopeArgs(operation, { where: { id: 'x' } }, A)).toMatchObject({
        where: { id: 'x', tenantId: A },
      });
    },
  );

  it('sobrescreve um tenantId vindo da chamada', () => {
    expect(scopeArgs('findMany', { where: { tenantId: B } }, A)).toEqual({ where: { tenantId: A } });
    expect(scopeArgs('findMany', { where: { tenantId: { in: [A, B] } } }, A)).toEqual({
      where: { tenantId: A },
    });
  });

  it('mantém OR e outros filtros, sempre dentro do cliente', () => {
    const scoped = scopeArgs('findMany', { where: { OR: [{ name: 'a' }, { name: 'b' }] } }, A);
    expect(scoped).toEqual({ where: { OR: [{ name: 'a' }, { name: 'b' }], tenantId: A } });
  });

  it('cria sempre no cliente da sessão', () => {
    expect(scopeArgs('create', { data: { name: 'x' } }, A)).toEqual({ data: { name: 'x', tenantId: A } });
    expect(scopeArgs('createMany', { data: [{ name: 'x' }, { name: 'y' }] }, A)).toEqual({
      data: [
        { name: 'x', tenantId: A },
        { name: 'y', tenantId: A },
      ],
    });
  });

  it.each([
    ['criar em outro cliente', 'create', { data: { name: 'x', tenantId: B } }],
    [
      'criar ligando a outro cliente pela relação',
      'create',
      { data: { name: 'x', tenant: { connect: { id: B } } } },
    ],
    ['mover registro para outro cliente', 'update', { where: { id: 'x' }, data: { tenantId: B } }],
    ['mover vários registros', 'updateMany', { data: { tenantId: B } }],
    [
      'upsert mudando o cliente',
      'upsert',
      { where: { id: 'x' }, create: { name: 'x' }, update: { tenantId: B } },
    ],
  ])('recusa %s', (_label, operation, args) => {
    expect(() => scopeArgs(operation, args, A)).toThrow(TenantScopeViolation);
  });

  it('upsert filtra e cria no cliente', () => {
    expect(
      scopeArgs('upsert', { where: { id: 'x' }, create: { name: 'x' }, update: { name: 'y' } }, A),
    ).toEqual({
      where: { id: 'x', tenantId: A },
      create: { name: 'x', tenantId: A },
      update: { name: 'y' },
    });
  });

  it('recusa operação desconhecida (nova API do Prisma não passa sem revisão)', () => {
    expect(() => scopeArgs('findManyStream', {}, A)).toThrow(TenantScopeViolation);
  });
});

describe('scopeToTenant', () => {
  function fakeDb() {
    const findMany = vi.fn((args: unknown) => Promise.resolve(args));
    const tenantFindUnique = vi.fn((args: unknown) => Promise.resolve(args));
    const db = {
      user: { findMany },
      tenant: { findUnique: tenantFindUnique },
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn(),
    };
    return { db: db as unknown as Prisma.TransactionClient, findMany, tenantFindUnique };
  }

  it('aplica o filtro nos models com dado de cliente', async () => {
    const { db, findMany } = fakeDb();
    await scopeToTenant(db, A).user.findMany({ where: { name: 'x' } });
    expect(findMany).toHaveBeenCalledWith({ where: { name: 'x', tenantId: A } });
  });

  it('models sem dado de cliente passam sem filtro', async () => {
    const { db, tenantFindUnique } = fakeDb();
    await scopeToTenant(db, A).tenant.findUnique({ where: { id: A } });
    expect(tenantFindUnique).toHaveBeenCalledWith({ where: { id: A } });
  });

  it('SQL cru não existe no escopo do cliente', () => {
    const { db } = fakeDb();
    const scoped = scopeToTenant(db, A);
    expect(() => scoped.$queryRaw).toThrow(TenantScopeViolation);
    expect(() => scoped.$executeRaw).toThrow(TenantScopeViolation);
  });

  it('não aceita escopo vazio', () => {
    const { db } = fakeDb();
    expect(() => scopeToTenant(db, '')).toThrow(TenantScopeViolation);
  });
});
