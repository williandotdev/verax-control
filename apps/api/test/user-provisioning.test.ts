import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { BetterAuthOptions } from 'better-auth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AUTH } from '../src/auth/auth.constants.js';
import type { Auth } from '../src/auth/auth.factory.js';
import * as provisioning from '../src/auth/user-provisioning.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { createSignedInUser, createTenant, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import type { TestSession } from './support/tenant-isolation.js';

type Provisioning = typeof provisioning;

/** De onde o Better Auth junta os `databaseHooks` ao subir (`runPluginInit`): a configuração e o `init` de cada plugin. */
interface HookSource {
  source: string;
  hooks: BetterAuthOptions['databaseHooks'];
}

// `provisionUser` continua o de verdade; os testes da corrida o interceptam uma vez para confirmar outra conta com
// o mesmo e-mail entre a checagem do service e a gravação.
vi.mock('../src/auth/user-provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<Provisioning>();
  return { ...actual, provisionUser: vi.fn(actual.provisionUser) };
});

const PROVISIONING_PATH = 'apps/api/src/auth/user-provisioning.ts';
const EMAIL_TAKEN = 'Já existe um usuário com este e-mail';
const CNPJ = '98765432000198';

describe('provisionamento de contas na transação da requisição', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let actual: Provisioning;
  let tenantA: string;
  let tenantB: string;
  let adminA: TestSession;
  let verax: TestSession;
  let counter = 0;
  const email = () => `corrida-${(counter += 1)}-${Date.now()}@cliente.example`;

  async function sessionFor(
    role: 'admin_cliente' | 'admin_verax',
    tenantId: string | null,
  ): Promise<TestSession> {
    const user = await createSignedInUser(app, { role, tenantId });
    const { cookie, token } = await withCsrf(app, user.cookie);
    return { cookie, csrfToken: token };
  }

  const post = (session: TestSession, path: string, body: object) =>
    request(app.getHttpServer())
      .post(path)
      .set('Cookie', session.cookie)
      .set('Origin', TEST_WEB_ORIGIN)
      .set('X-CSRF-Token', session.csrfToken)
      .send(body);

  /** Outra requisição vence a corrida: a mesma conta é confirmada (fora da transação) entre a checagem e a gravação. */
  function winRace(address: string): string {
    const winnerId = randomUUID();
    vi.mocked(provisioning.provisionUser).mockImplementationOnce(async (auth, input) => {
      await prisma.user.create({
        data: {
          id: winnerId,
          email: address,
          name: 'Quem venceu',
          role: 'leitura',
          tenantId: tenantB,
          status: 'active',
        },
      });
      return actual.provisionUser(auth, input);
    });
    return winnerId;
  }

  /** A mesma resposta da checagem prévia; só a conta vencedora, intocada e sem conta de senha; na auditoria, só a tentativa. */
  async function expectNothingHalfDone(
    address: string,
    winnerId: string,
    conflict: request.Response,
    action: string,
  ): Promise<void> {
    expect(conflict.body).toMatchObject({ message: EMAIL_TAKEN });
    const users = await prisma.user.findMany({ where: { email: address } });
    expect(users.map((user) => user.id)).toEqual([winnerId]);
    expect(users[0]).toMatchObject({ tenantId: tenantB, role: 'leitura', mustChangePassword: false });
    expect(await prisma.account.count({ where: { userId: winnerId } })).toBe(0);
    const entries = await prisma.auditLog.findMany({
      where: { requestId: conflict.headers['x-request-id'] },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action, outcome: 'failure', statusCode: 409 });
  }

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    actual = await vi.importActual<Provisioning>('../src/auth/user-provisioning.js');
    tenantA = await createTenant(app, 'Cliente A (provisionamento)');
    tenantB = await createTenant(app, 'Cliente B (provisionamento)');
    adminA = await sessionFor('admin_cliente', tenantA);
    verax = await sessionFor('admin_verax', null);
  });

  afterAll(async () => {
    await app.close();
  });

  it('o Better Auth não tem hook de criação de usuário nem de conta: o caminho transacional não os executaria', async () => {
    const context = await app.get<Auth>(AUTH).$context;
    // Os mesmos lugares de onde o Better Auth junta os hooks que `createWithHooks` executa: a configuração e o que
    // o `init` de cada plugin devolve (nos plugins em uso, o `init` é puro: só devolve configuração e contexto).
    const sources: HookSource[] = [{ source: 'configuração', hooks: context.options.databaseHooks }];
    const plugins = (context.options.plugins ?? []) as {
      id: string;
      init?: (ctx: typeof context) => unknown;
    }[];
    for (const plugin of plugins) {
      const result = (await plugin.init?.(context)) as { options?: Partial<BetterAuthOptions> } | undefined;
      sources.push({ source: `plugin:${plugin.id}`, hooks: result?.options?.databaseHooks });
    }
    // A leitura é a da configuração viva: o hook de sessão da aplicação e os plugins estão lá.
    expect(context.options.databaseHooks?.session?.create?.before).toBeTypeOf('function');
    expect(sources.map((entry) => entry.source)).toContain('plugin:two-factor');
    for (const { source, hooks } of sources) {
      for (const model of ['user', 'account'] as const) {
        expect(
          hooks?.[model]?.create,
          `databaseHooks.${model}.create (${source}) não rodaria em POST /users nem em POST /tenants: veja ${PROVISIONING_PATH}`,
        ).toBeUndefined();
      }
    }
  });

  describe('e-mail confirmado por outra requisição entre a checagem e a gravação', () => {
    it('POST /users responde 409 com a mesma mensagem, sem conta pela metade', async () => {
      const address = email();
      const winner = winRace(address);
      const conflict = await post(adminA, '/v1/users', {
        email: address,
        name: 'Quem perdeu',
        role: 'leitura',
      }).expect(409);
      await expectNothingHalfDone(address, winner, conflict, 'POST /v1/users');
    });

    it('POST /tenants responde 409 com a mesma mensagem, e o cliente também não é criado', async () => {
      const address = email();
      const winner = winRace(address);
      const conflict = await post(verax, '/v1/tenants', {
        name: 'Cliente da corrida',
        cnpj: CNPJ,
        plan: 'Essencial',
        escalationContact: { name: 'Ana', email: 'ana@cliente.example' },
        firstAdmin: { name: 'Quem perdeu', email: address },
      }).expect(409);
      await expectNothingHalfDone(address, winner, conflict, 'POST /v1/tenants');
      expect(
        await prisma.tenant.count({ where: { OR: [{ cnpj: CNPJ }, { name: 'Cliente da corrida' }] } }),
      ).toBe(0);
    });
  });
});
