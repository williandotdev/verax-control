import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type Role, ROLES, tenantSchema, tenantSummarySchema } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { createSignedInUser, createTenant, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import type { TestSession } from './support/tenant-isolation.js';

/** CNPJs válidos (dígitos verificadores certos), fictícios. */
const CNPJS = ['11222333000181', '12ABC34501DE35', '45723174000110', '04252011000110', '27865757000102'];

const newTenant = (cnpj: string, name = 'Cliente Novo') => ({
  name,
  cnpj,
  plan: 'Essencial',
  escalationContact: { name: 'Ana', email: 'ana@cliente.example', phone: '+55 11 91234-5678' },
});

describe('cadastro de clientes (T3.1)', () => {
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
  const entryOf = (response: request.Response) =>
    prisma.auditLog.findFirstOrThrow({ where: { requestId: response.headers['x-request-id'] } });

  beforeAll(async () => {
    app = await createApp();
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
      const tenant = tenantSchema.parse(created.body);
      expect(tenant).toMatchObject({ name: 'Cliente Alfa', cnpj: '12ABC34501DE35', status: 'active' });
      expect(await entryOf(created)).toMatchObject({
        action: 'tenant.create',
        tenantId: tenant.id,
        resourceId: tenant.id,
        outcome: 'success',
      });
    });

    it('CNPJ repetido responde 409 e não cria nada', async () => {
      await admin()
        .post('/v1/tenants', newTenant(CNPJS[0] as string, 'Primeiro'))
        .expect(201);
      const conflict = await admin()
        .post('/v1/tenants', newTenant('11.222.333/0001-81', 'Segundo'))
        .expect(409);
      expect(conflict.body).toMatchObject({ message: 'Já existe um cliente com este CNPJ' });
      expect(await prisma.tenant.count({ where: { name: 'Segundo' } })).toBe(0);
    });

    it.each([
      ['CNPJ inválido', { ...newTenant('11222333000182') }],
      ['status no corpo', { ...newTenant(CNPJS[2] as string), status: 'inactive' }],
      ['campo desconhecido', { ...newTenant(CNPJS[2] as string), tenantId: 'x' }],
      ['sem contato', { name: 'x', cnpj: CNPJS[2], plan: 'x' }],
      ['plano longo', { ...newTenant(CNPJS[2] as string), plan: 'x'.repeat(61) }],
    ])('recusa %s (400)', async (_label, body) => {
      await admin().post('/v1/tenants', body).expect(400);
    });
  });

  describe('leitura', () => {
    it('a listagem devolve só o resumo, no contrato do seletor do painel', async () => {
      const response = await admin().get('/v1/tenants?pageSize=100').expect(200);
      const page = z
        .strictObject({
          items: z.array(tenantSummarySchema),
          page: z.number(),
          pageSize: z.number(),
          total: z.number(),
        })
        .parse(response.body);
      expect(page.items.some((tenant) => tenant.id === homeTenant)).toBe(true);
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
      const created = tenantSchema.parse(
        (
          await admin()
            .post('/v1/tenants', newTenant(CNPJS[3] as string, 'Antes'))
            .expect(201)
        ).body,
      );
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
      const tenant = tenantSchema.parse(
        (
          await admin()
            .post('/v1/tenants', newTenant(CNPJS[4] as string, 'A desativar'))
            .expect(201)
        ).body,
      );
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
