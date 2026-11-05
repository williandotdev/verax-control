import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { notificationPreferencesSchema, userSchema } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { TenantScopeViolation } from '../src/common/prisma/tenant-scope.js';
import { createSignedInUser, createTenant, createUser, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import type { TestSession } from './support/tenant-isolation.js';

type Session = TestSession & { userId: string };
type Role = 'admin_cliente' | 'analista_cliente' | 'leitura' | 'admin_verax';

/**
 * Preferência de aviso por e-mail (fase 2, PR-17'): cada pessoa lê e muda só a dela, a mudança entra na auditoria, o
 * administrador só vê (na lista de usuários), e quem não recebe avisos tem uma resposta clara.
 */
describe("preferência de aviso por e-mail (PR-17')", () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;

  async function sessionFor(tenantId: string | null, role: Role): Promise<Session> {
    const user = await createSignedInUser(app, { role, tenantId });
    const { cookie, token } = await withCsrf(app, user.cookie);
    return { cookie, csrfToken: token, userId: user.id };
  }

  const call = (session: Session) => {
    const server = request(app.getHttpServer());
    const write = (method: 'put' | 'patch' | 'post', path: string) =>
      server[method](path)
        .set('Cookie', session.cookie)
        .set('Origin', TEST_WEB_ORIGIN)
        .set('X-CSRF-Token', session.csrfToken);
    return {
      get: (path: string) => server.get(path).set('Cookie', session.cookie),
      put: (path: string, body: object) => write('put', path).send(body),
      patch: (path: string, body: object) => write('patch', path).send(body),
      post: (path: string, body: object = {}) => write('post', path).send(body),
    };
  };
  const PATH = '/v1/notification-preferences';
  const entryOf = (response: request.Response) =>
    prisma.auditLog.findFirstOrThrow({ where: { requestId: response.headers['x-request-id'] } });
  const stored = (userId: string) =>
    prisma.notificationPreference.findUnique({
      where: { userId },
      select: { tenantId: true, incidentEmails: true },
    });

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente demo A (preferência)');
    tenantB = await createTenant(app, 'Cliente demo B (preferência)');
  });

  afterAll(async () => {
    await app.close();
  });

  it('padrão: recebe; desligar e religar a própria, com o estado anterior e o novo na auditoria do cliente', async () => {
    const analyst = await sessionFor(tenantA, 'analista_cliente');
    const initial = await call(analyst).get(PATH).expect(200);
    expect(notificationPreferencesSchema.parse(initial.body)).toEqual({
      incidentEmails: true,
      eligible: true,
    });
    expect(await stored(analyst.userId)).toBeNull();

    const off = await call(analyst).put(PATH, { incidentEmails: false }).expect(200);
    expect(off.body).toEqual({ incidentEmails: false, eligible: true });
    expect(await stored(analyst.userId)).toEqual({ tenantId: tenantA, incidentEmails: false });
    expect(await entryOf(off)).toMatchObject({
      action: 'user.notification_preference',
      resourceType: 'user',
      resourceId: analyst.userId,
      tenantId: tenantA,
      outcome: 'success',
      before: { incidentEmails: true },
      after: { incidentEmails: false },
    });
    expect((await call(analyst).get(PATH).expect(200)).body).toEqual({
      incidentEmails: false,
      eligible: true,
    });

    const on = await call(analyst).put(PATH, { incidentEmails: true }).expect(200);
    expect(on.body).toEqual({ incidentEmails: true, eligible: true });
    expect(await entryOf(on)).toMatchObject({
      before: { incidentEmails: false },
      after: { incidentEmails: true },
    });
  });

  it('o corpo é estrito: nada de outra pessoa, de papel nem de valor que não seja booleano', async () => {
    const admin = await sessionFor(tenantA, 'admin_cliente');
    const other = await createUser(app, { role: 'analista_cliente', tenantId: tenantA });
    for (const body of [
      {},
      { incidentEmails: 'false' },
      { incidentEmails: null },
      { incidentEmails: false, userId: other.id },
      { incidentEmails: false, tenantId: tenantB },
      { incidentEmails: false, eligible: true },
    ]) {
      await call(admin).put(PATH, body).expect(400);
    }
    expect(await stored(other.id)).toBeNull();
    expect(await stored(admin.userId)).toBeNull();
  });

  it('cada pessoa muda só a própria: o administrador só vê a dos outros, na lista de usuários', async () => {
    const admin = await sessionFor(tenantA, 'admin_cliente');
    const analyst = await sessionFor(tenantA, 'analista_cliente');
    await call(analyst).put(PATH, { incidentEmails: false }).expect(200);
    // A do administrador não mudou.
    expect((await call(admin).get(PATH).expect(200)).body).toEqual({ incidentEmails: true, eligible: true });

    const list = await call(admin).get('/v1/users?pageSize=100').expect(200);
    const users = (list.body as { items: unknown[] }).items.map((item) => userSchema.parse(item));
    expect(users.find((user) => user.id === analyst.userId)?.incidentEmails).toBe(false);
    expect(users.find((user) => user.id === admin.userId)?.incidentEmails).toBe(true);
    expect((await call(admin).get(`/v1/users/${analyst.userId}`).expect(200)).body).toMatchObject({
      incidentEmails: false,
    });

    // Pela gestão de usuários, o campo não existe: o administrador não muda a escolha de ninguém.
    await call(admin).patch(`/v1/users/${analyst.userId}`, { incidentEmails: true }).expect(400);
    expect(await stored(analyst.userId)).toMatchObject({ incidentEmails: false });
    // Nem há rota com o id de outra pessoa.
    await call(admin).put(`${PATH}/${analyst.userId}`, { incidentEmails: true }).expect(404);
  });

  it('leitura não recebe avisos: a leitura diz isso, e a mudança é negada (e auditada)', async () => {
    const reader = await sessionFor(tenantA, 'leitura');
    expect((await call(reader).get(PATH).expect(200)).body).toEqual({
      incidentEmails: false,
      eligible: false,
    });
    const denied = await call(reader).put(PATH, { incidentEmails: true }).expect(403);
    expect(await entryOf(denied)).toMatchObject({ outcome: 'denied' });
    expect(await stored(reader.userId)).toBeNull();
  });

  it('equipe da Verax: não recebe avisos dos clientes, com ou sem cliente selecionado', async () => {
    const verax = await sessionFor(null, 'admin_verax');
    expect((await call(verax).get(PATH).expect(200)).body).toEqual({
      incidentEmails: false,
      eligible: false,
    });
    const refused = await call(verax).put(PATH, { incidentEmails: true }).expect(403);
    expect(refused.body).toMatchObject({
      code: 'NOTICES_NOT_FOR_ROLE',
      message: 'O seu papel não recebe avisos por e-mail',
    });
    await call(verax).post('/v1/session/tenant', { tenantId: tenantA }).expect(200);
    expect((await call(verax).get(PATH).expect(200)).body).toEqual({
      incidentEmails: false,
      eligible: false,
    });
    await call(verax).put(PATH, { incidentEmails: false }).expect(403);
    expect(await stored(verax.userId)).toBeNull();
  });

  it('sem o token CSRF, a mudança é recusada', async () => {
    const analyst = await sessionFor(tenantA, 'analista_cliente');
    await request(app.getHttpServer())
      .put(PATH)
      .set('Cookie', analyst.cookie)
      .set('Origin', TEST_WEB_ORIGIN)
      .send({ incidentEmails: false })
      .expect(403);
    expect(await stored(analyst.userId)).toBeNull();
  });

  describe('isolamento por cliente (A/B)', () => {
    it('a pessoa de B muda a dela, no cliente B; nada de A muda, e a lista de A não mostra B', async () => {
      const adminA = await sessionFor(tenantA, 'admin_cliente');
      const analystA = await sessionFor(tenantA, 'analista_cliente');
      const analystB = await sessionFor(tenantB, 'analista_cliente');
      await call(analystB).put(PATH, { incidentEmails: false }).expect(200);
      expect(await stored(analystB.userId)).toEqual({ tenantId: tenantB, incidentEmails: false });
      expect((await call(analystA).get(PATH).expect(200)).body).toEqual({
        incidentEmails: true,
        eligible: true,
      });
      expect(await stored(analystA.userId)).toBeNull();

      const list = await call(adminA).get('/v1/users?pageSize=100').expect(200);
      const ids = (list.body as { items: { id: string }[] }).items.map((user) => user.id);
      expect(ids).not.toContain(analystB.userId);
      // A trilha da mudança de B é a de B.
      const trail = await prisma.auditLog.findMany({
        where: { action: 'user.notification_preference', resourceId: analystB.userId },
        select: { tenantId: true },
      });
      expect(trail).toEqual([{ tenantId: tenantB }]);
    });

    it('o escopo de B não lê nem altera a preferência de A, e não grava preferência em A', async () => {
      const personA = await createUser(app, { role: 'analista_cliente', tenantId: tenantA });
      const scopedA = prisma.forTenant(tenantA);
      await scopedA.notificationPreference.create({
        data: { tenantId: tenantA, userId: personA.id, incidentEmails: false },
      });
      const scopedB = prisma.forTenant(tenantB);
      expect(await scopedB.notificationPreference.findUnique({ where: { userId: personA.id } })).toBeNull();
      expect(
        (
          await scopedB.notificationPreference.updateMany({
            where: { userId: personA.id },
            data: { incidentEmails: true },
          })
        ).count,
      ).toBe(0);
      expect(() =>
        scopedB.notificationPreference.create({ data: { tenantId: tenantA, userId: personA.id } }),
      ).toThrow(TenantScopeViolation);
      expect(await stored(personA.id)).toEqual({ tenantId: tenantA, incidentEmails: false });
    });

    it('o banco recusa preferência de uma pessoa de outro cliente, e da equipe da Verax', async () => {
      const personA = await createUser(app, { role: 'analista_cliente', tenantId: tenantA });
      const verax = await createUser(app, { role: 'admin_verax', tenantId: null });
      await expect(
        prisma.notificationPreference.create({ data: { tenantId: tenantB, userId: personA.id } }),
      ).rejects.toThrow();
      await expect(
        prisma.notificationPreference.create({ data: { tenantId: tenantA, userId: verax.id } }),
      ).rejects.toThrow();
    });
  });
});
