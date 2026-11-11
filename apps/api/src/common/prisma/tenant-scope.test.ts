import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '../../generated/prisma/client.js';
import { scopeArgs, scopeTenantRootArgs, scopeToTenant, TenantScopeViolation } from './tenant-scope.js';

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

describe('scopeTenantRootArgs', () => {
  it('o cadastro do cliente só alcança o próprio, sem trocar o id pedido', () => {
    expect(scopeTenantRootArgs('findUnique', { where: { id: B } }, A)).toEqual({
      where: { id: B, AND: [{ id: A }] },
    });
    expect(scopeTenantRootArgs('findMany', { where: { AND: { name: 'x' } } }, A)).toEqual({
      where: { AND: [{ name: 'x' }, { id: A }] },
    });
    expect(scopeTenantRootArgs('update', { where: { id: A }, data: { name: 'y' } }, A)).toEqual({
      where: { id: A, AND: [{ id: A }] },
      data: { name: 'y' },
    });
  });

  it.each(['create', 'createMany', 'createManyAndReturn', 'upsert'])('recusa %s', (operation) => {
    expect(() => scopeTenantRootArgs(operation, { data: { name: 'x' } }, A)).toThrow(TenantScopeViolation);
  });

  it('recusa trocar o id do cliente', () => {
    expect(() => scopeTenantRootArgs('update', { where: { id: A }, data: { id: B } }, A)).toThrow(
      TenantScopeViolation,
    );
  });
});

describe('scopeToTenant', () => {
  function fakeDb() {
    const findMany = vi.fn((args: unknown) => Promise.resolve(args));
    const tenantFindUnique = vi.fn((args: unknown) => Promise.resolve(args));
    const db = {
      user: { findMany },
      tenant: { findUnique: tenantFindUnique },
      session: { findMany: vi.fn() },
      verification: { findMany: vi.fn() },
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn(),
      $transaction: vi.fn(),
      $extends: vi.fn(),
    };
    return { db: db as unknown as Prisma.TransactionClient, findMany, tenantFindUnique };
  }

  it('aplica o filtro nos models com dado de cliente', async () => {
    const { db, findMany } = fakeDb();
    await scopeToTenant(db, A).user.findMany({ where: { name: 'x' } });
    expect(findMany).toHaveBeenCalledWith({ where: { name: 'x', tenantId: A } });
  });

  it('o model tenant fica restrito ao próprio cliente', async () => {
    const { db, tenantFindUnique } = fakeDb();
    await scopeToTenant(db, A).tenant.findUnique({ where: { id: B } });
    expect(tenantFindUnique).toHaveBeenCalledWith({ where: { id: B, AND: [{ id: A }] } });
  });

  it.each(['session', 'verification'])('model sem dado de cliente (%s) não existe no escopo', (model) => {
    const { db } = fakeDb();
    expect(() => (scopeToTenant(db, A) as unknown as Record<string, unknown>)[model]).toThrow(
      TenantScopeViolation,
    );
  });

  it.each(['$queryRaw', '$executeRaw', '$transaction', '$extends'])(
    '%s não existe no escopo do cliente (escaparia do filtro)',
    (method) => {
      const { db } = fakeDb();
      expect(() => (scopeToTenant(db, A) as unknown as Record<string, unknown>)[method]).toThrow(
        TenantScopeViolation,
      );
    },
  );

  it('não aceita escopo vazio', () => {
    const { db } = fakeDb();
    expect(() => scopeToTenant(db, '')).toThrow(TenantScopeViolation);
  });

  describe('endereço do cliente na célula (CE-01): só o sistema grava', () => {
    const OPERATIONS = [
      'findMany',
      'create',
      'createMany',
      'update',
      'updateMany',
      'upsert',
      'delete',
      'deleteMany',
    ];

    function hostDb() {
      const operations = Object.fromEntries(
        OPERATIONS.map((operation) => [operation, vi.fn((args: unknown) => Promise.resolve(args))]),
      );
      return { db: { tenantHost: operations } as unknown as Prisma.TransactionClient, operations };
    }

    it('lê só a linha do próprio cliente', async () => {
      const { db, operations } = hostDb();
      await scopeToTenant(db, A).tenantHost.findMany({});
      expect(operations['findMany']).toHaveBeenCalledWith({ where: { tenantId: A } });
    });

    it.each(OPERATIONS.filter((operation) => operation !== 'findMany'))(
      '%s é recusado no escopo, sem chegar ao banco',
      (operation) => {
        const { db, operations } = hostDb();
        const delegate = scopeToTenant(db, A).tenantHost as unknown as Record<
          string,
          (args: unknown) => unknown
        >;
        expect(() => delegate[operation]?.({ where: { tenantId: A }, data: { slug: 'cliente-b' } })).toThrow(
          TenantScopeViolation,
        );
        expect(operations[operation]).not.toHaveBeenCalled();
      },
    );
  });
});
