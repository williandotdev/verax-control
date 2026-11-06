import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { resolvePlan } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH } from '../src/auth/auth.constants.js';
import type { Auth } from '../src/auth/auth.factory.js';
import { provisionUser } from '../src/auth/user-provisioning.js';
import { type BootstrapInput, bootstrapEnvSchema, bootstrapNode } from '../src/cli/node-bootstrap.js';
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
  const bootstrap = (env: BootstrapInput, plan = resolvePlan('essencial')) =>
    bootstrapNode(prisma, auth, env, plan);

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
    const result = await bootstrap(env);
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
    const first = await bootstrap(env);
    const second = await bootstrap(env);
    expect(second.admin).toBe('renewed');
    expect(second.temporaryPassword?.temporaryPassword).not.toBe(first.temporaryPassword?.temporaryPassword);
    await signInRequest(app, email, first.temporaryPassword?.temporaryPassword ?? '').expect(401);

    await prisma.user.update({ where: { email }, data: { mustChangePassword: false } });
    const third = await bootstrap(env);
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
    const result = await bootstrap(env);
    expect(result.admin).toBe('renewed');
    await signIn(app, email, result.temporaryPassword?.temporaryPassword ?? '');
  });

  it('saída de emergência: admin que já trocou a senha recebe outra a pedido, e só a pedido', async () => {
    const env = input();
    const email = env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase();
    const first = await bootstrap(env);
    const cookie = await signIn(app, email, first.temporaryPassword?.temporaryPassword ?? '');
    const own = 'uma senha longa e única 4821';
    await authPost(app, '/change-password', cookie, {
      currentPassword: first.temporaryPassword?.temporaryPassword ?? '',
      newPassword: own,
    }).expect(200);
    expect((await bootstrap(env)).admin).toBe('exists');

    const reset = await bootstrap({ ...env, BOOTSTRAP_RENEW_ADMIN_PASSWORD: true });
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

  it('aceita o que o start.sh escreve na saída de emergência (sem cliente: linha vazia)', () => {
    const parsed = bootstrapEnvSchema.parse({
      BOOTSTRAP_ADMIN_EMAIL: 'admin@verax.example',
      BOOTSTRAP_ADMIN_NAME: 'Administrador Verax',
      BOOTSTRAP_TENANT_NAME: '',
      BOOTSTRAP_GCP_ACCOUNTS: '',
      BOOTSTRAP_RENEW_ADMIN_PASSWORD: 'true',
    });
    expect(parsed).toMatchObject({ BOOTSTRAP_TENANT_NAME: undefined, BOOTSTRAP_RENEW_ADMIN_PASSWORD: true });
  });

  it('admin desativado: a saída de emergência recusa; sem ela, o bootstrap segue sem mexer no admin', async () => {
    const env = input();
    const email = env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase();
    await bootstrap(env);
    await prisma.user.update({ where: { email }, data: { status: 'disabled', mustChangePassword: false } });
    await expect(bootstrap({ ...env, BOOTSTRAP_RENEW_ADMIN_PASSWORD: true })).rejects.toThrow('desativado');
    expect((await bootstrap(env)).admin).toBe('exists');
  });

  it('e-mail de usuário de cliente não vira admin da Verax', async () => {
    const tenantId = await createTenant(app, 'Cliente (bootstrap)');
    const email = `cliente-${randomUUID()}@verax.example`;
    await prisma.user.create({
      data: { id: randomUUID(), email, name: 'Cliente', role: 'leitura', tenantId, status: 'active' },
    });
    await expect(bootstrap(input({ BOOTSTRAP_ADMIN_EMAIL: email }))).rejects.toThrow('usuário de cliente');
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).role).toBe('leitura');
  });

  it('cria o cliente do nó e as contas da GCP, cada uma com a sua assinatura; de novo, nada duplica', async () => {
    const tenantName = `Verax (bootstrap ${randomUUID().slice(0, 8)})`;
    const [alfa, beta] = [randomProject(), randomProject()];
    const env = input({
      BOOTSTRAP_TENANT_NAME: tenantName,
      BOOTSTRAP_GCP_ACCOUNTS: `${alfa}=projects/projeto-no/subscriptions/seguranca-${alfa}, ${beta}=projects/projeto-no/subscriptions/seguranca-${beta}`,
    });
    expect(await bootstrap(env)).toMatchObject({
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

    expect(await bootstrap(env)).toMatchObject({
      tenant: 'exists',
      accounts: [
        { project: alfa, outcome: 'exists' },
        { project: beta, outcome: 'exists' },
      ],
    });
    expect(await prisma.tenant.count({ where: { name: tenantName } })).toBe(1);
  });

  it('grava o rótulo do plano do nó em Tenant.plan; com o PLAN trocado, atualiza e audita', async () => {
    const tenantName = `Cliente Demo A (plano ${randomUUID().slice(0, 8)})`;
    const env = input({ BOOTSTRAP_TENANT_NAME: tenantName });
    expect(await bootstrap(env, resolvePlan('essencial'))).toMatchObject({ tenant: 'created', plan: 'set' });
    const tenant = await prisma.tenant.findFirstOrThrow({ where: { name: tenantName } });
    expect(tenant.plan).toBe('Essencial');
    expect(
      await prisma.auditLog.findFirstOrThrow({ where: { action: 'tenant.create', resourceId: tenant.id } }),
    ).toMatchObject({
      actorType: 'system',
      tenantId: tenant.id,
      after: { name: tenantName, plan: 'Essencial' },
    });

    // De novo com o mesmo plano: nada muda.
    expect(await bootstrap(env, resolvePlan('essencial'))).toMatchObject({
      tenant: 'exists',
      plan: 'unchanged',
    });
    expect(await prisma.auditLog.count({ where: { action: 'tenant.update', resourceId: tenant.id } })).toBe(
      0,
    );

    // O node.conf passou para o Profissional: o cadastro acompanha, com o antes e o depois na auditoria.
    expect(await bootstrap(env, resolvePlan('profissional'))).toMatchObject({
      tenant: 'exists',
      plan: 'set',
    });
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).plan).toBe('Profissional');
    expect(
      await prisma.auditLog.findFirstOrThrow({ where: { action: 'tenant.update', resourceId: tenant.id } }),
    ).toMatchObject({
      actorType: 'system',
      tenantId: tenant.id,
      before: { plan: 'Essencial' },
      after: { plan: 'Profissional' },
    });
  });

  it('cliente criado antes do plano (Tenant.plan vazio) recebe o rótulo; outro cliente fica como está', async () => {
    const tenantName = `Verax (plano ${randomUUID().slice(0, 8)})`;
    const legacy = await prisma.tenant.create({ data: { name: tenantName }, select: { id: true } });
    const other = await prisma.tenant.create({
      data: { name: `Cliente Demo B (plano ${randomUUID().slice(0, 8)})`, plan: 'Essencial' },
      select: { id: true },
    });
    expect(
      await bootstrap(input({ BOOTSTRAP_TENANT_NAME: tenantName }), resolvePlan('interno')),
    ).toMatchObject({ tenant: 'exists', plan: 'set' });
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: legacy.id } })).plan).toBe('Interno');
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: other.id } })).plan).toBe('Essencial');
  });

  it('sem cliente (só o admin), nenhum plano é gravado', async () => {
    expect(await bootstrap(input())).toMatchObject({ tenant: 'skipped' });
    expect((await bootstrap(input())).plan).toBeUndefined();
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
    const result = await bootstrap(
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

  it('respeita o limite de contas do plano: a conta acima fica de fora, com a recusa na auditoria; desativar libera a vaga', async () => {
    const plan = resolvePlan('essencial');
    const max = plan.limits.maxCloudAccounts as number;
    const tenantName = `Cliente Demo A (limite ${randomUUID().slice(0, 8)})`;
    const projects = Array.from({ length: max + 1 }, () => randomProject());
    const env = input({
      BOOTSTRAP_TENANT_NAME: tenantName,
      BOOTSTRAP_GCP_ACCOUNTS: projects
        .map((project) => `${project}=projects/projeto-no/subscriptions/seguranca-${project}`)
        .join(','),
    });
    const first = await bootstrap(env, plan);
    expect(first.accounts).toEqual(
      projects.map((project, index) => ({ project, outcome: index < max ? 'created' : 'plan-limit' })),
    );
    const tenant = await prisma.tenant.findFirstOrThrow({ where: { name: tenantName } });
    expect(await prisma.cloudAccount.count({ where: { tenantId: tenant.id } })).toBe(max);
    expect(
      await prisma.auditLog.findMany({
        where: { tenantId: tenant.id, action: 'cloud_account.create', outcome: 'failure' },
        select: { actorType: true, statusCode: true, resourceType: true },
      }),
    ).toEqual([{ actorType: 'system', statusCode: 409, resourceType: 'cloud_account' }]);

    // Uma conta desativada pelo painel abre a vaga: a próxima execução cria a que ficou de fora.
    await prisma.cloudAccount.updateMany({
      where: { tenantId: tenant.id, accountId: projects[0] },
      data: { status: 'inactive' },
    });
    const second = await bootstrap(env, plan);
    expect(second.accounts.map((account) => account.outcome)).toEqual([
      ...Array.from({ length: max }, () => 'exists'),
      'created',
    ]);
    expect(await prisma.cloudAccount.count({ where: { tenantId: tenant.id, status: 'active' } })).toBe(max);
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
