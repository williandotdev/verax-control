import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH } from '../src/auth/auth.constants.js';
import type { Auth } from '../src/auth/auth.factory.js';
import { provisionUser } from '../src/auth/user-provisioning.js';
import { bootstrapEnvSchema, bootstrapNode } from '../src/cli/node-bootstrap.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { randomProject } from './gcp/fixtures.js';
import { authPost, createTenant, signIn, signInRequest } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';
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

  it('cria o admin_verax com senha temporária, sem e-mail; no primeiro login ele troca a senha', async () => {
    const env = input({ BOOTSTRAP_ADMIN_NAME: 'Pessoa Admin' });
    const email = env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase();
    const result = await bootstrapNode(prisma, auth, env);
    expect(result.admin).toBe('created');
    const temporary = result.temporaryPassword?.temporaryPassword ?? '';
    expect(temporary).toHaveLength(23);

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user).toMatchObject({
      role: 'admin_verax',
      tenantId: null,
      status: 'active',
      name: 'Pessoa Admin',
      mustChangePassword: true,
    });
    expect(mailbox.to(email)).toHaveLength(0);

    // O primeiro login é o mesmo de qualquer conta nova: só a troca de senha, depois o MFA.
    const cookie = await signIn(app, email, temporary);
    const me = (await request(app.getHttpServer()).get('/v1/me').set('Cookie', cookie).expect(200)).body as {
      mustChangePassword: boolean;
    };
    expect(me.mustChangePassword).toBe(true);
    await authPost(app, '/change-password', cookie, {
      currentPassword: temporary,
      newPassword: 'uma senha longa e única 4821',
    }).expect(200);

    const audit = await prisma.auditLog.findFirst({ where: { action: 'user.create', resourceId: user.id } });
    expect(audit).toMatchObject({ actorType: 'system', outcome: 'success', tenantId: null });
    expect(JSON.stringify(audit)).not.toContain(temporary);
  });

  it('de novo: admin que ainda não entrou recebe outra senha; admin que já trocou fica como está', async () => {
    const env = input();
    const email = env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase();
    const first = await bootstrapNode(prisma, auth, env);
    const second = await bootstrapNode(prisma, auth, env);
    expect(second.admin).toBe('renewed');
    expect(second.temporaryPassword?.temporaryPassword).not.toBe(first.temporaryPassword?.temporaryPassword);
    await signInRequest(app, email, first.temporaryPassword?.temporaryPassword ?? '').expect(401);

    await prisma.user.update({ where: { email }, data: { mustChangePassword: false } });
    const third = await bootstrapNode(prisma, auth, env);
    expect(third.admin).toBe('exists');
    expect(third.temporaryPassword).toBeUndefined();
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });

  it('execução anterior que parou entre criar a conta e gravar a senha: a próxima gera a senha', async () => {
    const env = input();
    const email = env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase();
    // Conta criada, sem senha nenhuma e sem a marca (o que sobra se o processo cair no meio).
    await provisionUser(auth, {
      email,
      name: 'Admin',
      role: 'admin_verax',
      tenantId: null,
      status: 'active',
    });
    const result = await bootstrapNode(prisma, auth, env);
    expect(result.admin).toBe('renewed');
    await signIn(app, email, result.temporaryPassword?.temporaryPassword ?? '');
  });

  it('saída de emergência: admin que já trocou a senha recebe outra a pedido, e só a pedido', async () => {
    const env = input();
    const email = env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase();
    const first = await bootstrapNode(prisma, auth, env);
    const cookie = await signIn(app, email, first.temporaryPassword?.temporaryPassword ?? '');
    const own = 'uma senha longa e única 4821';
    await authPost(app, '/change-password', cookie, {
      currentPassword: first.temporaryPassword?.temporaryPassword ?? '',
      newPassword: own,
    }).expect(200);
    expect((await bootstrapNode(prisma, auth, env)).admin).toBe('exists');

    const reset = await bootstrapNode(prisma, auth, { ...env, BOOTSTRAP_RENEW_ADMIN_PASSWORD: true });
    expect(reset.admin).toBe('reset');
    await signInRequest(app, email, own).expect(401);
    const fresh = await signIn(app, email, reset.temporaryPassword?.temporaryPassword ?? '');
    const me = (await request(app.getHttpServer()).get('/v1/me').set('Cookie', fresh).expect(200)).body as {
      mustChangePassword: boolean;
    };
    expect(me.mustChangePassword).toBe(true);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'user.temporary_password', resourceId: user.id },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit).toMatchObject({ actorType: 'system', outcome: 'success' });
    expect(audit.after).toMatchObject({ mustChangePassword: true });
  });

  it('admin desativado: a saída de emergência recusa; sem ela, o bootstrap segue sem mexer no admin', async () => {
    const env = input();
    const email = env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase();
    await bootstrapNode(prisma, auth, env);
    await prisma.user.update({ where: { email }, data: { status: 'disabled', mustChangePassword: false } });
    await expect(
      bootstrapNode(prisma, auth, { ...env, BOOTSTRAP_RENEW_ADMIN_PASSWORD: true }),
    ).rejects.toThrow('desativado');
    expect((await bootstrapNode(prisma, auth, env)).admin).toBe('exists');
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
