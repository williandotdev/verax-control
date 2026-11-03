import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH } from '../src/auth/auth.constants.js';
import type { Auth } from '../src/auth/auth.factory.js';
import { bootstrapEnvSchema, bootstrapNode } from '../src/cli/node-bootstrap.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { randomProject } from './gcp/fixtures.js';
import { createTenant } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import { MemoryMailTransport } from './support/memory-mail.js';

describe('bootstrap do nó: primeiro admin, cliente e contas da GCP', () => {
  const mailbox = new MemoryMailTransport();
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let auth: Auth;

  const input = (overrides: Record<string, string> = {}) =>
    bootstrapEnvSchema.parse({ BOOTSTRAP_ADMIN_EMAIL: `admin-${randomUUID()}@verax.example`, ...overrides });

  beforeAll(async () => {
    app = await createApp({ mailbox });
    prisma = app.get(PrismaService);
    auth = app.get<Auth>(AUTH);
  });

  afterAll(async () => {
    await app.close();
  });

  it('cria o admin_verax sem senha e envia o convite; ele define a senha pelo link', async () => {
    const env = input({ BOOTSTRAP_ADMIN_NAME: 'Pessoa Admin' });
    const email = env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase();
    expect((await bootstrapNode(prisma, auth, env)).admin).toBe('invited');

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user).toMatchObject({
      role: 'admin_verax',
      tenantId: null,
      status: 'invited',
      name: 'Pessoa Admin',
    });
    expect(await prisma.account.count({ where: { userId: user.id } })).toBe(0);
    const token = mailbox.lastToken(email);
    expect(token).toBeDefined();
    expect(mailbox.to(email).at(-1)?.subject).toMatch(/convite/i);

    // O link do e-mail é o mesmo do convite pelo painel: define a senha e ativa a conta.
    await request(app.getHttpServer())
      .post('/v1/auth/reset-password')
      .set('Origin', TEST_WEB_ORIGIN)
      .send({ newPassword: 'uma senha longa e única 4821', token })
      .expect(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).status).toBe('active');
    const audit = await prisma.auditLog.findFirst({ where: { action: 'user.invite', resourceId: user.id } });
    expect(audit).toMatchObject({ actorType: 'system', outcome: 'success', tenantId: null });
  });

  it('de novo: admin ainda sem senha recebe outro convite; admin ativo fica como está, sem e-mail', async () => {
    const env = input();
    const email = env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase();
    await bootstrapNode(prisma, auth, env);
    expect((await bootstrapNode(prisma, auth, env)).admin).toBe('reinvited');
    expect(mailbox.to(email)).toHaveLength(2);

    await prisma.user.update({ where: { email }, data: { status: 'active' } });
    expect((await bootstrapNode(prisma, auth, env)).admin).toBe('exists');
    expect(mailbox.to(email)).toHaveLength(2);
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });

  it('e-mail de usuário de cliente não vira admin da Verax', async () => {
    const tenantId = await createTenant(app, 'Cliente (bootstrap)');
    const email = `cliente-${randomUUID()}@verax.example`;
    await prisma.user.create({
      data: { id: randomUUID(), email, name: 'Cliente', role: 'leitura', tenantId, status: 'active' },
    });
    await expect(bootstrapNode(prisma, auth, input({ BOOTSTRAP_ADMIN_EMAIL: email }))).rejects.toThrow(
      'usuário de cliente',
    );
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).role).toBe('leitura');
  });

  it('cria o cliente do nó e as contas da GCP, cada uma com a sua assinatura; de novo, nada duplica', async () => {
    const tenantName = `Verax (bootstrap ${randomUUID().slice(0, 8)})`;
    const [alfa, beta] = [randomProject(), randomProject()];
    const env = input({
      BOOTSTRAP_TENANT_NAME: tenantName,
      BOOTSTRAP_GCP_ACCOUNTS: `${alfa}=projects/projeto-no/subscriptions/seguranca-${alfa}, ${beta}=projects/projeto-no/subscriptions/seguranca-${beta}`,
    });
    expect(await bootstrapNode(prisma, auth, env)).toMatchObject({
      tenant: 'created',
      accounts: [
        { project: alfa, outcome: 'created' },
        { project: beta, outcome: 'created' },
      ],
    });
    const tenant = await prisma.tenant.findFirstOrThrow({ where: { name: tenantName } });
    const accounts = await prisma.cloudAccount.findMany({
      where: { tenantId: tenant.id },
      orderBy: { accountId: 'asc' },
    });
    expect(
      accounts.map((account) => [account.provider, account.accountId, account.pubsubSubscription]),
    ).toEqual(
      [
        ['gcp', alfa, `projects/projeto-no/subscriptions/seguranca-${alfa}`],
        ['gcp', beta, `projects/projeto-no/subscriptions/seguranca-${beta}`],
      ].sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    );
    expect(
      await prisma.auditLog.count({
        where: { tenantId: tenant.id, actorType: 'system', action: 'cloud_account.create' },
      }),
    ).toBe(2);

    expect(await bootstrapNode(prisma, auth, env)).toMatchObject({
      tenant: 'exists',
      accounts: [
        { project: alfa, outcome: 'exists' },
        { project: beta, outcome: 'exists' },
      ],
    });
    expect(await prisma.tenant.count({ where: { name: tenantName } })).toBe(1);
  });

  it('conta que já é de outro cliente não muda de dono', async () => {
    const project = randomProject();
    const owner = await createTenant(app, 'Dono da conta (bootstrap)');
    await prisma.cloudAccount.create({
      data: {
        tenantId: owner,
        provider: 'gcp',
        accountId: project,
        regions: [],
        pubsubSubscription: `projects/projeto-no/subscriptions/dono-${project}`,
      },
    });
    const result = await bootstrapNode(
      prisma,
      auth,
      input({
        BOOTSTRAP_TENANT_NAME: `Outro (bootstrap ${randomUUID().slice(0, 8)})`,
        BOOTSTRAP_GCP_ACCOUNTS: `${project}=projects/projeto-no/subscriptions/outra-${project}`,
      }),
    );
    expect(result.accounts).toEqual([{ project, outcome: 'other-tenant' }]);
    expect((await prisma.cloudAccount.findFirstOrThrow({ where: { accountId: project } })).tenantId).toBe(
      owner,
    );
  });

  it.each([
    { BOOTSTRAP_ADMIN_EMAIL: 'não é e-mail' },
    {
      BOOTSTRAP_ADMIN_EMAIL: 'a@verax.example',
      BOOTSTRAP_GCP_ACCOUNTS: 'Projeto_Invalido=projects/x/subscriptions/y',
    },
    { BOOTSTRAP_ADMIN_EMAIL: 'a@verax.example', BOOTSTRAP_GCP_ACCOUNTS: 'projeto-valido=../../outra' },
  ])('configuração inválida é recusada antes de tocar no banco: %o', (env) => {
    expect(bootstrapEnvSchema.safeParse(env).success).toBe(false);
  });
});
