import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Module,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { paginationQuerySchema, type PaginationQuery } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RequirePermission } from '../src/auth/decorators.js';
import { toPrismaPage } from '../src/common/http/pagination.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { TENANT_SCOPED_MODELS } from '../src/common/prisma/tenant-scope.js';
import { createSignedInUser, createTenant, createUser, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import { describeTenantIsolation, type TestSession } from './support/tenant-isolation.js';

const userId = z.string().min(1).max(64);
const userSelect = { id: true, name: true, email: true, status: true } as const;

/** Sonda com dado de cliente real (usuários), acessada só pelo escopo da sessão. */
@Controller('isolation-probe/users')
class IsolationProbeController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequirePermission('users:read')
  list(@Query({ schema: paginationQuerySchema }) query: PaginationQuery) {
    return this.prisma
      .scoped()
      .user.findMany({ select: userSelect, orderBy: { email: 'asc' }, ...toPrismaPage(query) });
  }

  @Get(':id')
  @RequirePermission('users:read')
  get(@Param('id', { schema: userId }) id: string) {
    return this.prisma.scoped().user.findUniqueOrThrow({ where: { id }, select: userSelect });
  }

  @Patch(':id')
  @RequirePermission('users:write')
  rename(
    @Param('id', { schema: userId }) id: string,
    @Body({ schema: z.strictObject({ name: z.string().min(1).max(120) }) }) body: { name: string },
  ) {
    return this.prisma.scoped().user.update({ where: { id }, data: { name: body.name }, select: userSelect });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('users:write')
  async disable(@Param('id', { schema: userId }) id: string): Promise<void> {
    await this.prisma.scoped().user.update({ where: { id }, data: { status: 'disabled' } });
  }

  /** Escrita global da Verax, sem dado de cliente (ex.: cadastro de clientes, T3.1). */
  @Post('global')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('tenants:write')
  global(): void {}
}

@Module({ controllers: [IsolationProbeController] })
class IsolationProbeModule {}

describe('isolamento por cliente (T2.5)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let sessionA: TestSession & { user: { id: string } };
  let sessionB: TestSession;

  async function sessionFor(tenantId: string | null, role: 'admin_cliente' | 'admin_verax' | 'leitura') {
    const user = await createSignedInUser(app, { role, tenantId });
    const { cookie, token } = await withCsrf(app, user.cookie);
    return { cookie, csrfToken: token, user };
  }

  beforeAll(async () => {
    app = await createApp({ imports: [IsolationProbeModule] });
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente A');
    tenantB = await createTenant(app, 'Cliente B');
    sessionA = await sessionFor(tenantA, 'admin_cliente');
    sessionB = await sessionFor(tenantB, 'admin_cliente');
  });

  afterAll(async () => {
    await app.close();
  });

  describeTenantIsolation({
    resource: 'usuários',
    basePath: '/v1/isolation-probe/users',
    context: () => ({ app, sessionA, sessionB }),
    createInTenantB: async () => (await createUser(app, { role: 'leitura', tenantId: tenantB })).id,
    readDirect: (id) => prisma.user.findUniqueOrThrow({ where: { id }, select: userSelect }),
    patchBody: { name: 'Alterado por outro cliente' },
    hasDelete: true,
  });

  describe('o cliente nunca vem da requisição', () => {
    it('tenantId na query é recusado', async () => {
      await request(app.getHttpServer())
        .get(`/v1/isolation-probe/users?tenantId=${tenantB}`)
        .set('Cookie', sessionA.cookie)
        .expect(400);
    });

    it('tenantId no corpo é recusado', async () => {
      const own = await createUser(app, { role: 'leitura', tenantId: tenantA });
      await request(app.getHttpServer())
        .patch(`/v1/isolation-probe/users/${own.id}`)
        .set('Cookie', sessionA.cookie)
        .set('Origin', TEST_WEB_ORIGIN)
        .set('X-CSRF-Token', sessionA.csrfToken)
        .send({ name: 'x', tenantId: tenantB })
        .expect(400);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: own.id } })).tenantId).toBe(tenantA);
    });

    it('A lista só os próprios usuários; admin_verax nunca aparece', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/isolation-probe/users?pageSize=100')
        .set('Cookie', sessionA.cookie)
        .expect(200);
      const ids = (response.body as { id: string }[]).map((user) => user.id);
      const inA = await prisma.user.findMany({ where: { tenantId: tenantA }, select: { id: true } });
      expect(new Set(ids)).toEqual(new Set(inA.map((user) => user.id)));
    });
  });

  describe('troca de cliente do admin_verax', () => {
    it('sem cliente selecionado, rota de dados de cliente responde 409 TENANT_REQUIRED', async () => {
      const admin = await sessionFor(null, 'admin_verax');
      const response = await request(app.getHttpServer())
        .get('/v1/isolation-probe/users')
        .set('Cookie', admin.cookie)
        .expect(409);
      expect(response.body).toMatchObject({ code: 'TENANT_REQUIRED' });
    });

    it('seleciona o cliente B: passa a ver só B, e a troca fica na auditoria', async () => {
      const admin = await sessionFor(null, 'admin_verax');
      const switched = await request(app.getHttpServer())
        .post('/v1/session/tenant')
        .set('Cookie', admin.cookie)
        .set('Origin', TEST_WEB_ORIGIN)
        .set('X-CSRF-Token', admin.csrfToken)
        .send({ tenantId: tenantB })
        .expect(200, { activeTenantId: tenantB });

      const me = await request(app.getHttpServer()).get('/v1/me').set('Cookie', admin.cookie).expect(200);
      expect(me.body).toMatchObject({ activeTenantId: tenantB, scopeTenantId: tenantB, tenantId: null });

      const list = await request(app.getHttpServer())
        .get('/v1/isolation-probe/users?pageSize=100')
        .set('Cookie', admin.cookie)
        .expect(200);
      const tenants = await prisma.user.findMany({
        where: { id: { in: (list.body as { id: string }[]).map((user) => user.id) } },
        select: { tenantId: true },
      });
      expect(tenants.every((user) => user.tenantId === tenantB)).toBe(true);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { requestId: switched.headers['x-request-id'] },
      });
      expect(audit).toMatchObject({
        action: 'session.switch_tenant',
        actorId: admin.user.id,
        tenantId: tenantB,
        resourceId: tenantB,
        before: null,
        after: { activeTenantId: tenantB },
        outcome: 'success',
      });
    });

    describe('trilha de auditoria de quem a Verax atendeu', () => {
      async function adminIn(tenantId: string) {
        const admin = await sessionFor(null, 'admin_verax');
        const write = (method: 'post' | 'patch' | 'delete', path: string) => {
          const server = request(app.getHttpServer());
          return server[method](path)
            .set('Cookie', admin.cookie)
            .set('Origin', TEST_WEB_ORIGIN)
            .set('X-CSRF-Token', admin.csrfToken);
        };
        await write('post', '/v1/session/tenant').send({ tenantId }).expect(200);
        return { admin, write };
      }
      const entryOf = (response: request.Response) =>
        prisma.auditLog.findFirstOrThrow({ where: { requestId: response.headers['x-request-id'] } });

      it('trocar de A para B entra só na trilha de B, sem citar A', async () => {
        const { write } = await adminIn(tenantA);
        const switched = await write('post', '/v1/session/tenant').send({ tenantId: tenantB }).expect(200);
        const entry = await entryOf(switched);
        expect(entry.tenantId).toBe(tenantB);
        expect(JSON.stringify(entry)).not.toContain(tenantA);
      });

      it('limpar a seleção entra na trilha do cliente deixado', async () => {
        const { write } = await adminIn(tenantA);
        const cleared = await write('delete', '/v1/session/tenant').expect(204);
        expect(await entryOf(cleared)).toMatchObject({ action: 'session.clear_tenant', tenantId: tenantA });
      });

      it('alterar dado do cliente selecionado entra na trilha dele', async () => {
        const { write } = await adminIn(tenantB);
        const target = await createUser(app, { role: 'leitura', tenantId: tenantB });
        const renamed = await write('patch', `/v1/isolation-probe/users/${target.id}`)
          .send({ name: 'Renomeado pela Verax' })
          .expect(200);
        expect(await entryOf(renamed)).toMatchObject({ tenantId: tenantB, outcome: 'success' });
      });

      it('operação global com um cliente selecionado não entra na trilha dele', async () => {
        const { write } = await adminIn(tenantB);
        const global = await write('post', '/v1/isolation-probe/users/global').expect(204);
        expect(await entryOf(global)).toMatchObject({ tenantId: null, outcome: 'success' });
      });
    });

    it('a seleção vale só para a sessão em que foi feita', async () => {
      const admin = await sessionFor(null, 'admin_verax');
      await request(app.getHttpServer())
        .post('/v1/session/tenant')
        .set('Cookie', admin.cookie)
        .set('Origin', TEST_WEB_ORIGIN)
        .set('X-CSRF-Token', admin.csrfToken)
        .send({ tenantId: tenantA })
        .expect(200);
      const sessions = await prisma.session.findMany({ where: { userId: admin.user.id } });
      expect(sessions.filter((session) => session.activeTenantId === tenantA)).toHaveLength(1);
    });

    it('limpar a seleção volta a exigir um cliente', async () => {
      const admin = await sessionFor(null, 'admin_verax');
      const select = () =>
        request(app.getHttpServer())
          .post('/v1/session/tenant')
          .set('Cookie', admin.cookie)
          .set('Origin', TEST_WEB_ORIGIN)
          .set('X-CSRF-Token', admin.csrfToken)
          .send({ tenantId: tenantA });
      await select().expect(200);
      await request(app.getHttpServer())
        .delete('/v1/session/tenant')
        .set('Cookie', admin.cookie)
        .set('Origin', TEST_WEB_ORIGIN)
        .set('X-CSRF-Token', admin.csrfToken)
        .expect(204);
      await request(app.getHttpServer())
        .get('/v1/isolation-probe/users')
        .set('Cookie', admin.cookie)
        .expect(409);
    });

    it.each([
      ['cliente inexistente', '018f0000-0000-7000-8000-0000000000ff', 404],
      ['valor que não é UUID', 'cliente-b', 400],
    ] as const)('recusa %s', async (_label, tenantId, status) => {
      const admin = await sessionFor(null, 'admin_verax');
      await request(app.getHttpServer())
        .post('/v1/session/tenant')
        .set('Cookie', admin.cookie)
        .set('Origin', TEST_WEB_ORIGIN)
        .set('X-CSRF-Token', admin.csrfToken)
        .send({ tenantId })
        .expect(status);
    });

    it('recusa cliente inativo', async () => {
      const inactive = await createTenant(app, 'Cliente inativo');
      await prisma.tenant.update({ where: { id: inactive }, data: { status: 'inactive' } });
      const admin = await sessionFor(null, 'admin_verax');
      await request(app.getHttpServer())
        .post('/v1/session/tenant')
        .set('Cookie', admin.cookie)
        .set('Origin', TEST_WEB_ORIGIN)
        .set('X-CSRF-Token', admin.csrfToken)
        .send({ tenantId: inactive })
        .expect(404);
    });

    it('usuário de cliente não troca de cliente, e a tentativa fica na auditoria', async () => {
      const denied = await request(app.getHttpServer())
        .post('/v1/session/tenant')
        .set('Cookie', sessionA.cookie)
        .set('Origin', TEST_WEB_ORIGIN)
        .set('X-CSRF-Token', sessionA.csrfToken)
        .send({ tenantId: tenantB })
        .expect(403);
      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { requestId: denied.headers['x-request-id'] },
      });
      expect(entry).toMatchObject({
        action: 'POST /v1/session/tenant',
        actorId: sessionA.user.id,
        tenantId: tenantA,
        outcome: 'denied',
        statusCode: 403,
      });
    });

    it('cliente selecionado que é desativado deixa de valer na sessão do admin_verax', async () => {
      const tenant = await createTenant(app, 'Cliente desativado depois');
      const admin = await sessionFor(null, 'admin_verax');
      await request(app.getHttpServer())
        .post('/v1/session/tenant')
        .set('Cookie', admin.cookie)
        .set('Origin', TEST_WEB_ORIGIN)
        .set('X-CSRF-Token', admin.csrfToken)
        .send({ tenantId: tenant })
        .expect(200);
      await prisma.tenant.update({ where: { id: tenant }, data: { status: 'inactive' } });

      const me = await request(app.getHttpServer()).get('/v1/me').set('Cookie', admin.cookie).expect(200);
      expect(me.body).toMatchObject({ activeTenantId: null, scopeTenantId: null });
      await request(app.getHttpServer())
        .get('/v1/isolation-probe/users')
        .set('Cookie', admin.cookie)
        .expect(409);
    });

    it('um activeTenantId gravado na sessão de um usuário de cliente é ignorado', async () => {
      const reader = await sessionFor(tenantA, 'leitura');
      await prisma.session.updateMany({
        where: { userId: reader.user.id },
        data: { activeTenantId: tenantB },
      });
      const me = await request(app.getHttpServer()).get('/v1/me').set('Cookie', reader.cookie).expect(200);
      expect(me.body).toMatchObject({ scopeTenantId: tenantA, activeTenantId: null });
    });
  });

  it('desativar o cliente derruba as sessões abertas dos usuários dele', async () => {
    const tenant = await createTenant(app, 'Cliente a desativar');
    const member = await sessionFor(tenant, 'leitura');
    await request(app.getHttpServer()).get('/v1/me').set('Cookie', member.cookie).expect(200);

    await prisma.tenant.update({ where: { id: tenant }, data: { status: 'inactive' } });

    await request(app.getHttpServer()).get('/v1/me').set('Cookie', member.cookie).expect(401);
    expect(await prisma.session.count({ where: { userId: member.user.id } })).toBe(0);
  });

  it('todo model com tenantId no schema está na lista protegida pelo escopo', () => {
    const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
    const modelsWithTenant = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)]
      .filter(([, , body]) => /^\s+tenantId\s/m.test(body ?? ''))
      .map(([, name]) => (name ?? '').charAt(0).toLowerCase() + (name ?? '').slice(1));
    expect(modelsWithTenant.length).toBeGreaterThan(0);
    expect([...modelsWithTenant].sort()).toEqual([...TENANT_SCOPED_MODELS].sort());
  });
});
