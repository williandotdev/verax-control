import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  CREDENTIAL_CHANGE_REQUIRED_CODE,
  meSchema,
  type Role,
  ROLES,
  tenantCreatedSchema,
  tenantSchema,
  tenantSummarySchema,
  userSchema,
} from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import {
  authPost,
  createSignedInUser,
  createTenant,
  createUser,
  enrollMfa,
  signIn,
  signInRequest,
  withCsrf,
} from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import { LogCapture } from './support/log-capture.js';
import type { TestSession } from './support/tenant-isolation.js';

/** CNPJs válidos (dígitos verificadores certos), fictícios. */
const CNPJS = [
  '11222333000181',
  '12ABC34501DE35',
  '45723174000110',
  '04252011000110',
  '27865757000102',
  '11444777000161',
  '34028316000103',
  '33000167000101',
];
const NEW_PASSWORD = 'senha-nova-bem-longa-2';

let adminCounter = 0;
/** Primeiro administrador do cliente, com e-mail único por chamada. */
const firstAdmin = (name = 'Bia Admin') => ({
  name,
  email: `primeiro-admin-${(adminCounter += 1)}-${Date.now()}@cliente.example`,
});

const newTenant = (cnpj: string, name = 'Cliente Novo') => ({
  name,
  cnpj,
  plan: 'Essencial',
  escalationContact: { name: 'Ana', email: 'ana@cliente.example', phone: '+55 11 91234-5678' },
  firstAdmin: firstAdmin(),
});

describe('cadastro de clientes (T3.1)', () => {
  const capture = new LogCapture();
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const sessions = new Map<Role, TestSession & { userId: string }>();
  let homeTenant: string;

  const as = (role: Role) => {
    const session = sessions.get(role);
    if (!session) throw new Error(`sem sessão para ${role}`);
    const server = request(app.getHttpServer());
    const write = (method: 'post' | 'patch' | 'delete', path: string) =>
      server[method](path)
        .set('Cookie', session.cookie)
        .set('Origin', TEST_WEB_ORIGIN)
        .set('X-CSRF-Token', session.csrfToken);
    return {
      get: (path: string) => server.get(path).set('Cookie', session.cookie),
      post: (path: string, body: object) => write('post', path).send(body),
      patch: (path: string, body: object) => write('patch', path).send(body),
      delete: (path: string) => write('delete', path),
    };
  };
  const admin = () => as('admin_verax');
  /** Registros da requisição, na ordem em que foram descritos (os dois do cadastro podem ter o mesmo instante). */
  const entriesOf = (response: request.Response) =>
    prisma.auditLog.findMany({
      where: { requestId: response.headers['x-request-id'] },
      orderBy: [{ occurredAt: 'asc' }, { action: 'asc' }],
    });
  const entryOf = async (response: request.Response) => {
    const [entry, ...others] = await entriesOf(response);
    if (!entry) throw new Error('sem registro de auditoria para a requisição');
    expect(others).toHaveLength(0);
    return entry;
  };

  beforeAll(async () => {
    app = await createApp({ capture });
    prisma = app.get(PrismaService);
    homeTenant = await createTenant(app, 'Cliente de casa');
    for (const role of ROLES) {
      const user = await createSignedInUser(app, {
        role,
        tenantId: role === 'admin_verax' ? null : homeTenant,
      });
      const { cookie, token } = await withCsrf(app, user.cookie);
      sessions.set(role, { cookie, csrfToken: token, userId: user.id });
    }
  });

  afterAll(async () => {
    await app.close();
  });

  describe('permissões: só admin_verax lê e altera', () => {
    const others = ROLES.filter((role) => role !== 'admin_verax');

    it.each(others)('%s recebe 403 em todas as rotas', async (role) => {
      const id = await createTenant(app, 'Alvo');
      await as(role).get('/v1/tenants').expect(403);
      await as(role).get(`/v1/tenants/${id}`).expect(403);
      await as(role).post('/v1/tenants', newTenant('11444777000161')).expect(403);
      await as(role).patch(`/v1/tenants/${id}`, { name: 'Invadido' }).expect(403);
      await as(role).delete(`/v1/tenants/${id}`).expect(403);
      expect((await prisma.tenant.findUniqueOrThrow({ where: { id } })).name).toBe('Alvo');
    });
  });

  describe('criação', () => {
    it('cria com CNPJ normalizado, e a criação entra na trilha do novo cliente', async () => {
      const created = await admin()
        .post('/v1/tenants', newTenant('12.abc.345/01de-35', 'Cliente Alfa'))
        .expect(201);
      const { tenant } = tenantCreatedSchema.parse(created.body);
      expect(tenant).toMatchObject({ name: 'Cliente Alfa', cnpj: '12ABC34501DE35', status: 'active' });
      expect(await entriesOf(created)).toMatchObject([
        { action: 'tenant.create', tenantId: tenant.id, resourceId: tenant.id, outcome: 'success' },
        { action: 'user.create', tenantId: tenant.id, outcome: 'success' },
      ]);
    });

    it('CNPJ repetido responde 409 e não cria nada', async () => {
      await admin()
        .post('/v1/tenants', newTenant(CNPJS[0] as string, 'Primeiro'))
        .expect(201);
      const second = newTenant('11.222.333/0001-81', 'Segundo');
      const conflict = await admin().post('/v1/tenants', second).expect(409);
      expect(conflict.body).toMatchObject({ message: 'Já existe um cliente com este CNPJ' });
      expect(await prisma.tenant.count({ where: { name: 'Segundo' } })).toBe(0);
      expect(await prisma.user.count({ where: { email: second.firstAdmin.email } })).toBe(0);
    });

    it.each([
      ['CNPJ inválido', { ...newTenant('11222333000182') }],
      ['status no corpo', { ...newTenant(CNPJS[2] as string), status: 'inactive' }],
      ['campo desconhecido', { ...newTenant(CNPJS[2] as string), tenantId: 'x' }],
      ['sem contato', { name: 'x', cnpj: CNPJS[2], plan: 'x', firstAdmin: firstAdmin() }],
      ['plano longo', { ...newTenant(CNPJS[2] as string), plan: 'x'.repeat(61) }],
      ['sem o primeiro administrador', { ...newTenant(CNPJS[2] as string), firstAdmin: undefined }],
      [
        'e-mail do administrador inválido',
        { ...newTenant(CNPJS[2] as string), firstAdmin: { name: 'Bia', email: 'bia' } },
      ],
      [
        'papel no administrador',
        { ...newTenant(CNPJS[2] as string), firstAdmin: { ...firstAdmin(), role: 'admin_verax' } },
      ],
      [
        'senha no administrador',
        { ...newTenant(CNPJS[2] as string), firstAdmin: { ...firstAdmin(), password: 'x' } },
      ],
    ])('recusa %s (400)', async (_label, body) => {
      await admin().post('/v1/tenants', body).expect(400);
      expect(await prisma.tenant.count({ where: { cnpj: CNPJS[2] } })).toBe(0);
    });
  });

  describe('primeiro administrador do cliente', () => {
    it('nasce junto com o cliente, como admin_cliente, com senha temporária que só aparece na resposta', async () => {
      const body = newTenant(CNPJS[5] as string, 'Cliente com Admin');
      body.firstAdmin.email = body.firstAdmin.email.toUpperCase();
      const created = await admin().post('/v1/tenants', body).expect(201);
      const { tenant, firstAdmin: created1 } = tenantCreatedSchema.parse(created.body);
      expect(created1).toMatchObject({ name: 'Bia Admin', email: body.firstAdmin.email.toLowerCase() });

      const stored = await prisma.user.findUniqueOrThrow({ where: { id: created1.id } });
      expect(stored).toMatchObject({
        tenantId: tenant.id,
        role: 'admin_cliente',
        status: 'active',
        mustChangePassword: true,
        twoFactorEnabled: false,
      });
      expect(stored.temporaryPasswordExpiresAt?.toISOString()).toBe(created1.expiresAt);
      // No banco, só o hash, na conta de senha do Better Auth.
      const account = await prisma.account.findFirstOrThrow({ where: { userId: created1.id } });
      expect(account.providerId).toBe('credential');
      expect(account.password).not.toContain(created1.temporaryPassword);

      // Nenhuma leitura devolve a senha de novo.
      const read = await admin().get(`/v1/tenants/${tenant.id}`).expect(200);
      expect(tenantSchema.parse(read.body)).toMatchObject({ id: tenant.id });
      expect(JSON.stringify(read.body)).not.toContain(created1.temporaryPassword);
      expect(JSON.stringify(read.body)).not.toContain('firstAdmin');

      // Os dois registros de auditoria, sem a senha; o log da requisição também não a leva.
      const entries = await entriesOf(created);
      expect(entries).toMatchObject([
        { action: 'tenant.create', resourceType: 'tenant', resourceId: tenant.id, tenantId: tenant.id },
        {
          action: 'user.create',
          resourceType: 'user',
          resourceId: created1.id,
          tenantId: tenant.id,
          actorId: sessions.get('admin_verax')?.userId,
          after: { role: 'admin_cliente', mustChangePassword: true, email: created1.email },
        },
      ]);
      expect(JSON.stringify(entries)).not.toContain(created1.temporaryPassword);
      expect(capture.text).not.toContain(created1.temporaryPassword);
    });

    it('entra com a senha temporária, é obrigado a trocá-la, e depois só enxerga o próprio cliente', async () => {
      const created = tenantCreatedSchema.parse(
        (
          await admin()
            .post('/v1/tenants', newTenant(CNPJS[6] as string, 'Cliente Isolado'))
            .expect(201)
        ).body,
      );
      const { email, temporaryPassword } = created.firstAdmin;
      const server = () => request(app.getHttpServer());

      // Com a temporária, a sessão só alcança a troca de senha.
      const cookie = await signIn(app, email, temporaryPassword);
      const me = meSchema.parse((await server().get('/v1/me').set('Cookie', cookie).expect(200)).body);
      expect(me).toMatchObject({
        role: 'admin_cliente',
        tenantId: created.tenant.id,
        mustChangePassword: true,
        mfaEnabled: false,
      });
      const blocked = await server().get('/v1/users').set('Cookie', cookie).expect(403);
      expect(blocked.body).toMatchObject({ code: CREDENTIAL_CHANGE_REQUIRED_CODE });

      await authPost(app, '/change-password', cookie, {
        currentPassword: temporaryPassword,
        newPassword: NEW_PASSWORD,
      }).expect(200);
      await signInRequest(app, email, temporaryPassword).expect(401);
      const mfaRequired = await server().get('/v1/users').set('Cookie', cookie).expect(403);
      expect(mfaRequired.body).toMatchObject({ code: 'MFA_REQUIRED' });

      // Senha própria e MFA cadastrado: o painel abre, só com os dados do próprio cliente.
      const fresh = await signIn(app, email, NEW_PASSWORD);
      const { cookie: full } = await enrollMfa(app, fresh, NEW_PASSWORD);
      const users = await server().get('/v1/users?pageSize=100').set('Cookie', full).expect(200);
      const items = (users.body as { items: unknown[] }).items.map((item) => userSchema.parse(item));
      expect(items.map((item) => item.id)).toEqual([created.firstAdmin.id]);
      expect(items[0]).toMatchObject({ role: 'admin_cliente', mustChangePassword: false, mfaEnabled: true });

      // A/B: nada do cliente de casa, e nenhuma rota de clientes (ler, criar, alterar).
      const homeAdmin = sessions.get('admin_cliente');
      if (!homeAdmin) throw new Error('sem sessão de admin_cliente');
      await server().get(`/v1/users/${homeAdmin.userId}`).set('Cookie', full).expect(404);
      const csrf = await withCsrf(app, full);
      await server().get('/v1/tenants').set('Cookie', csrf.cookie).expect(403);
      await server().get(`/v1/tenants/${homeTenant}`).set('Cookie', csrf.cookie).expect(403);
      await server()
        .post('/v1/tenants')
        .set('Cookie', csrf.cookie)
        .set('Origin', TEST_WEB_ORIGIN)
        .set('X-CSRF-Token', csrf.token)
        .send(newTenant(CNPJS[7] as string, 'Invasor'))
        .expect(403);
      expect(await prisma.tenant.count({ where: { name: 'Invasor' } })).toBe(0);
      await server()
        .patch(`/v1/tenants/${homeTenant}`)
        .set('Cookie', csrf.cookie)
        .set('Origin', TEST_WEB_ORIGIN)
        .set('X-CSRF-Token', csrf.token)
        .send({ name: 'Invadido' })
        .expect(403);
    });

    it('e-mail já usado (em qualquer cliente) responde 409 genérico, e o cliente não é criado', async () => {
      const existing = await createUser(app, { role: 'leitura', tenantId: homeTenant });
      const body = {
        ...newTenant(CNPJS[7] as string, 'Cliente sem Admin'),
        firstAdmin: { name: 'Bia', email: existing.email },
      };
      const conflict = await admin().post('/v1/tenants', body).expect(409);
      expect(conflict.body).toMatchObject({ message: 'Já existe um usuário com este e-mail' });
      expect(JSON.stringify(conflict.body)).not.toContain(homeTenant);

      // Nada ficou: nem o cliente, nem mudança na conta existente, nem registro de criação na auditoria.
      expect(
        await prisma.tenant.count({ where: { OR: [{ name: 'Cliente sem Admin' }, { cnpj: CNPJS[7] }] } }),
      ).toBe(0);
      expect(await prisma.user.findUniqueOrThrow({ where: { id: existing.id } })).toMatchObject({
        tenantId: homeTenant,
        role: 'leitura',
        mustChangePassword: false,
      });
      const [attempt, ...others] = await entriesOf(conflict);
      expect(others).toHaveLength(0);
      expect(attempt).toMatchObject({ outcome: 'failure', statusCode: 409, tenantId: null });
      expect(attempt?.action).not.toBe('user.create');
    });

    it('o primeiro administrador não entra na alteração do cliente', async () => {
      await admin()
        .patch(`/v1/tenants/${homeTenant}`, { firstAdmin: { name: 'Outro', email: 'outro@cliente.example' } })
        .expect(400);
      expect(await prisma.user.count({ where: { email: 'outro@cliente.example' } })).toBe(0);
    });
  });

  describe('leitura', () => {
    it('a listagem devolve só o resumo, no contrato do seletor do painel', async () => {
      const pageSchema = z.strictObject({
        items: z.array(tenantSummarySchema),
        page: z.number(),
        pageSize: z.number(),
        total: z.number(),
      });
      // A suíte inteira divide o banco e cria clientes em paralelo, e a ordem é pelo nome: o cliente deste arquivo
      // pode não estar na primeira página. Todas as páginas seguem o contrato.
      const ids: string[] = [];
      for (let number = 1; number <= 50; number += 1) {
        const response = await admin().get(`/v1/tenants?pageSize=100&page=${number}`).expect(200);
        const page = pageSchema.parse(response.body);
        ids.push(...page.items.map((tenant) => tenant.id));
        if (page.items.length === 0 || number * page.pageSize >= page.total) break;
      }
      expect(ids).toContain(homeTenant);
    });

    it('filtra por status', async () => {
      const id = await createTenant(app, 'Inativo filtrado');
      await prisma.tenant.update({ where: { id }, data: { status: 'inactive' } });
      const response = await admin().get('/v1/tenants?status=inactive&pageSize=100').expect(200);
      const items = (response.body as { items: { id: string; status: string }[] }).items;
      expect(items.some((tenant) => tenant.id === id)).toBe(true);
      expect(items.every((tenant) => tenant.status === 'inactive')).toBe(true);
    });

    it('detalhe completo; inexistente 404; id inválido 400', async () => {
      tenantSchema.parse((await admin().get(`/v1/tenants/${homeTenant}`).expect(200)).body);
      await admin().get('/v1/tenants/018f0000-0000-7000-8000-0000000000ff').expect(404);
      await admin().get('/v1/tenants/nao-e-uuid').expect(400);
    });
  });

  describe('alteração e desativação', () => {
    it('altera parcialmente, com estado anterior e novo na auditoria', async () => {
      const created = tenantCreatedSchema.parse(
        (
          await admin()
            .post('/v1/tenants', newTenant(CNPJS[3] as string, 'Antes'))
            .expect(201)
        ).body,
      ).tenant;
      const updated = await admin()
        .patch(`/v1/tenants/${created.id}`, {
          name: 'Depois',
          escalationContact: { name: 'Bia', email: 'bia@cliente.example' },
        })
        .expect(200);
      expect(updated.body).toMatchObject({
        name: 'Depois',
        cnpj: CNPJS[3],
        escalationContact: { name: 'Bia', email: 'bia@cliente.example', phone: null },
      });
      expect(await entryOf(updated)).toMatchObject({
        action: 'tenant.update',
        tenantId: created.id,
        before: { name: 'Antes' },
        after: { name: 'Depois' },
      });
    });

    it('alteração vazia é recusada', async () => {
      await admin().patch(`/v1/tenants/${homeTenant}`, {}).expect(400);
    });

    it('desativar (exclusão lógica) derruba quem é do cliente e a seleção do admin_verax', async () => {
      const tenant = tenantCreatedSchema.parse(
        (
          await admin()
            .post('/v1/tenants', newTenant(CNPJS[4] as string, 'A desativar'))
            .expect(201)
        ).body,
      ).tenant;
      const member = await createSignedInUser(app, { role: 'leitura', tenantId: tenant.id });
      const verax = await createSignedInUser(app, { role: 'admin_verax', tenantId: null });
      const veraxCsrf = await withCsrf(app, verax.cookie);
      await request(app.getHttpServer())
        .post('/v1/session/tenant')
        .set('Cookie', veraxCsrf.cookie)
        .set('Origin', TEST_WEB_ORIGIN)
        .set('X-CSRF-Token', veraxCsrf.token)
        .send({ tenantId: tenant.id })
        .expect(200);

      const deleted = await admin().delete(`/v1/tenants/${tenant.id}`).expect(204);

      expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).status).toBe('inactive');
      expect(await prisma.session.count({ where: { userId: member.id } })).toBe(0);
      await request(app.getHttpServer()).get('/v1/me').set('Cookie', member.cookie).expect(401);
      const me = await request(app.getHttpServer()).get('/v1/me').set('Cookie', veraxCsrf.cookie).expect(200);
      expect(me.body).toMatchObject({ activeTenantId: null });
      expect(await entryOf(deleted)).toMatchObject({
        action: 'tenant.deactivate',
        tenantId: tenant.id,
        before: { status: 'active' },
        after: { status: 'inactive' },
      });

      const reactivated = await admin().patch(`/v1/tenants/${tenant.id}`, { status: 'active' }).expect(200);
      expect(await entryOf(reactivated)).toMatchObject({ action: 'tenant.reactivate' });
    });

    it('trocar para um CNPJ já usado responde 409', async () => {
      const id = await createTenant(app, 'Sem CNPJ');
      await admin().patch(`/v1/tenants/${id}`, { cnpj: CNPJS[0] }).expect(409);
    });
  });
});
