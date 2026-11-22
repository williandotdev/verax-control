import { TEMPORARY_PASSWORD_HOURS } from '@verax/shared';
import { verifyPassword } from 'better-auth/crypto';
import { describe, expect, it } from 'vitest';
import type { Prisma } from '../generated/prisma/client.js';
import { prepareTemporaryPassword, writeTemporaryPassword } from './temporary-password.js';
import { type AuthIds, defaultAuthIds, insertUser } from './user-provisioning.js';

/** Uma transação falsa: guarda cada chamada (model.operação e argumentos) e responde o mínimo. */
function fakeTransaction(accountsUpdated = 0) {
  const calls: { op: string; args: Record<string, unknown> }[] = [];
  const delegate = (model: string) =>
    new Proxy(
      {},
      {
        get: (_target, operation: string) => (args: Record<string, unknown>) => {
          calls.push({ op: `${model}.${operation}`, args });
          if (operation === 'updateMany' && model === 'account')
            return Promise.resolve({ count: accountsUpdated });
          if (operation.endsWith('Many')) return Promise.resolve({ count: 1 });
          return Promise.resolve({ id: 'x' });
        },
      },
    );
  const db = new Proxy({}, { get: (_target, model: string) => delegate(model) });
  return { db: db as Prisma.TransactionClient, calls };
}

/** IDs previsíveis: `user-1`, `account-2`... */
function countingIds(): AuthIds {
  let n = 0;
  return { generateId: (model) => `${model}-${(n += 1)}` };
}

describe('IDs do Better Auth sem a instância (o worker)', () => {
  it('32 caracteres de a-z, A-Z e 0-9, como o gerador padrão do Better Auth, e diferentes a cada vez', () => {
    const ids = Array.from({ length: 200 }, () => defaultAuthIds.generateId('user'));
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('insertUser: o usuário gravado na transação dada', () => {
  it('com os IDs dados e o e-mail em minúsculas; sem senha, sem conta de senha', async () => {
    const { db, calls } = fakeTransaction();
    const result = await insertUser(db, countingIds(), {
      email: '  Pessoa@Cliente.Example ',
      name: 'Pessoa',
      role: 'leitura',
      tenantId: '00000000-0000-4000-8000-000000000001',
      status: 'invited',
    });
    expect(result).toEqual({ id: 'user-1' });
    expect(calls.map((call) => call.op)).toEqual(['user.create']);
    expect(calls[0]?.args).toEqual({
      data: {
        id: 'user-1',
        email: 'pessoa@cliente.example',
        name: 'Pessoa',
        emailVerified: false,
        role: 'leitura',
        tenantId: '00000000-0000-4000-8000-000000000001',
        status: 'invited',
      },
      select: { id: true },
    });
  });

  it('com senha: a conta `credential` com o hash do Better Auth (nunca a senha)', async () => {
    const { db, calls } = fakeTransaction();
    const password = 'senha-de-teste-bem-longa';
    await insertUser(db, countingIds(), {
      email: 'a@cliente.example',
      name: 'A',
      role: 'admin_verax',
      tenantId: null,
      status: 'active',
      password,
    });
    expect(calls.map((call) => call.op)).toEqual(['user.create', 'account.create']);
    const data = calls[1]?.args['data'] as Record<string, string>;
    expect(data).toMatchObject({
      id: 'account-2',
      userId: 'user-1',
      providerId: 'credential',
      accountId: 'user-1',
    });
    expect(data['password']).not.toContain(password);
    expect(await verifyPassword({ hash: data['password'] ?? '', password })).toBe(true);
  });

  it('senha fora do tamanho: recusa antes de gravar', async () => {
    const { db, calls } = fakeTransaction();
    await expect(
      insertUser(db, countingIds(), {
        email: 'b@cliente.example',
        name: 'B',
        role: 'leitura',
        tenantId: null,
        status: 'active',
        password: 'curta',
      }),
    ).rejects.toThrow('A senha precisa ter entre');
    expect(calls).toEqual([]);
  });
});

describe('senha temporária preparada e gravada na transação dada', () => {
  const now = new Date('2026-11-22T12:00:00.000Z');

  it('gerada: no formato da geradora, com validade de TEMPORARY_PASSWORD_HOURS e o hash que o login confere', async () => {
    const prepared = await prepareTemporaryPassword(countingIds(), { now });
    const groups = prepared.password.split('-');
    expect(groups).toHaveLength(4);
    for (const group of groups) expect(group).toMatch(/^[A-HJ-NP-Za-km-z2-9]{5}$/);
    expect(prepared.expiresAt.getTime() - now.getTime()).toBe(TEMPORARY_PASSWORD_HOURS * 3_600_000);
    expect(prepared.accountId).toBe('account-1');
    expect(await verifyPassword({ hash: prepared.hash, password: prepared.password })).toBe(true);
  });

  it('a dada (a do pedido do console), com a validade dada', async () => {
    const expiresAt = new Date('2026-11-24T08:30:00.000Z');
    const password = 'Senha-do-pedido-do-console';
    const prepared = await prepareTemporaryPassword(countingIds(), { password, expiresAt, now });
    expect(prepared.password).toBe(password);
    expect(prepared.expiresAt).toEqual(expiresAt);
    expect(await verifyPassword({ hash: prepared.hash, password })).toBe(true);
    await expect(prepareTemporaryPassword(countingIds(), { password: 'curta' })).rejects.toThrow(
      'A senha precisa ter entre',
    );
  });

  it('grava: troca obrigatória com a validade, a conta de senha criada se faltar, ativa, sessões e bloqueio zerados', async () => {
    const prepared = await prepareTemporaryPassword(countingIds(), { now });
    const user = { id: 'user-9', email: 'c@cliente.example' };

    const { db, calls } = fakeTransaction(0);
    await writeTemporaryPassword(db, user, prepared);
    expect(calls.map((call) => call.op)).toEqual([
      'user.update',
      'account.updateMany',
      'account.create',
      'user.updateMany',
      'session.deleteMany',
      'loginAttempt.deleteMany',
    ]);
    expect(calls[0]?.args).toEqual({
      where: { id: 'user-9' },
      data: { mustChangePassword: true, temporaryPasswordExpiresAt: prepared.expiresAt },
    });
    expect(calls[2]?.args['data']).toEqual({
      id: prepared.accountId,
      userId: 'user-9',
      providerId: 'credential',
      accountId: 'user-9',
      password: prepared.hash,
    });
    expect(calls[3]?.args).toEqual({
      where: { id: 'user-9', status: 'invited' },
      data: { status: 'active' },
    });
    expect(calls[5]?.args).toEqual({ where: { email: 'c@cliente.example' } });
    expect(JSON.stringify(calls)).not.toContain(prepared.password);

    // Já com a conta de senha: só troca o hash.
    const again = fakeTransaction(1);
    await writeTemporaryPassword(again.db, user, prepared);
    expect(again.calls.map((call) => call.op)).not.toContain('account.create');
  });
});
