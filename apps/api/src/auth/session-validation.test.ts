import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import { resolveSession, type SessionData } from './session-validation.js';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';

/** Só o que `resolveSession` usa do Prisma: os clientes (ativos ou não) e a remoção da sessão. */
function fakePrisma(active: readonly string[]) {
  const findMany = vi.fn(({ take }: { take: number }) =>
    Promise.resolve(active.slice(0, take).map((id) => ({ id }))),
  );
  const findUnique = vi.fn(({ where }: { where: { id: string } }) =>
    Promise.resolve({ status: active.includes(where.id) ? 'active' : 'inactive' }),
  );
  const deleteMany = vi.fn(() => Promise.resolve({ count: 1 }));
  const prisma = { tenant: { findMany, findUnique }, session: { deleteMany } } as unknown as PrismaService;
  return { prisma, findMany, deleteMany };
}

function sessionOf(
  user: Partial<SessionData['user']> = {},
  activeTenantId: string | null = null,
): SessionData {
  const now = Date.now();
  return {
    session: {
      id: 'sessao-1',
      createdAt: new Date(now - 60_000),
      expiresAt: new Date(now + 10 * 60_000),
      activeTenantId,
    },
    user: {
      id: 'pessoa-1',
      email: 'equipe@verax.example',
      role: 'admin_verax',
      tenantId: null,
      status: 'active',
      twoFactorEnabled: true,
      mustChangePassword: false,
      ...user,
    },
  };
}

describe('resolveSession: a equipe vendo o painel como o cliente (STAFF_CUSTOMER_VIEW)', () => {
  it('com o interruptor e um cliente ativo só: o admin_cliente desse cliente, com o id de verdade da pessoa', async () => {
    const { prisma, findMany } = fakePrisma([TENANT_A]);
    const auth = await resolveSession(prisma, sessionOf({}, TENANT_A), { staffCustomerView: true });
    expect(auth).toEqual({
      sessionId: 'sessao-1',
      userId: 'pessoa-1',
      email: 'equipe@verax.example',
      role: 'admin_cliente',
      tenantId: TENANT_A,
      activeTenantId: null,
      scopeTenantId: TENANT_A,
      mfaEnabled: true,
      mustChangePassword: false,
      staffAsCustomer: true,
    });
    // A consulta é barata: dois clientes bastam para saber que não há um só.
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 'active' }, take: 2 }));
  });

  it('com dois clientes ativos (ou nenhum): nada muda, a equipe nunca cai num cliente qualquer', async () => {
    for (const active of [[TENANT_A, TENANT_B], []]) {
      const { prisma } = fakePrisma(active);
      const auth = await resolveSession(prisma, sessionOf(), { staffCustomerView: true });
      expect(auth).toMatchObject({
        role: 'admin_verax',
        tenantId: null,
        scopeTenantId: null,
        activeTenantId: null,
      });
      expect(auth).not.toHaveProperty('staffAsCustomer');
    }
  });

  it('sem o interruptor: o admin_verax de sempre (com o cliente selecionado), sem consultar a lista', async () => {
    const { prisma, findMany } = fakePrisma([TENANT_A]);
    for (const options of [undefined, {}, { staffCustomerView: false }]) {
      const auth = await resolveSession(prisma, sessionOf({}, TENANT_A), options);
      expect(auth).toMatchObject({ role: 'admin_verax', tenantId: null, activeTenantId: TENANT_A });
      expect(auth?.scopeTenantId).toBe(TENANT_A);
      expect(auth).not.toHaveProperty('staffAsCustomer');
    }
    expect(findMany).not.toHaveBeenCalled();
  });

  it('as pessoas do cliente não mudam com o interruptor', async () => {
    const { prisma, findMany } = fakePrisma([TENANT_A]);
    for (const role of ['admin_cliente', 'analista_cliente', 'leitura']) {
      const auth = await resolveSession(prisma, sessionOf({ role, tenantId: TENANT_A }), {
        staffCustomerView: true,
      });
      expect(auth).toMatchObject({ role, tenantId: TENANT_A, scopeTenantId: TENANT_A, activeTenantId: null });
      expect(auth).not.toHaveProperty('staffAsCustomer');
    }
    expect(findMany).not.toHaveBeenCalled();
  });

  it('as regras da sessão valem antes: a sessão vencida continua apagada, sem visão de cliente', async () => {
    const { prisma, deleteMany } = fakePrisma([TENANT_A]);
    const expired = sessionOf();
    expired.session.createdAt = new Date(Date.now() - 13 * 60 * 60 * 1000);
    expect(await resolveSession(prisma, expired, { staffCustomerView: true })).toBeUndefined();
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: 'sessao-1' } });
  });
});
