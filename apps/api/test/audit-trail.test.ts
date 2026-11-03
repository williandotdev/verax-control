import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { auditEntryDetailSchema, auditEntrySchema, paginatedSchema } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { createSignedInUser, createTenant, createUser, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';

const HOUR = 3_600_000;
const pageSchema = paginatedSchema(auditEntrySchema);

describe('tela Auditoria: leitura da trilha', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let adminA: Awaited<ReturnType<typeof createSignedInUser>>;
  let verax: { cookie: string; csrfToken: string; id: string };
  const rows: Record<string, string> = {};

  async function insert(name: string, data: Prisma.AuditLogUncheckedCreateInput) {
    rows[name] = (await prisma.auditLog.create({ data, select: { id: true } })).id;
  }

  const as = (cookie: string) => (path: string) =>
    request(app.getHttpServer()).get(path).set('Cookie', cookie);
  const ids = (body: unknown) => pageSchema.parse(body).items.map((item) => item.id);

  async function selectTenant(tenantId: string | null) {
    const call =
      tenantId === null
        ? request(app.getHttpServer()).delete('/v1/session/tenant')
        : request(app.getHttpServer()).post('/v1/session/tenant').send({ tenantId });
    await call
      .set('Cookie', verax.cookie)
      .set('Origin', TEST_WEB_ORIGIN)
      .set('X-CSRF-Token', verax.csrfToken)
      .expect(tenantId === null ? 204 : 200);
  }

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente A (auditoria)');
    tenantB = await createTenant(app, 'Cliente B (auditoria)');
    adminA = await createSignedInUser(app, { role: 'admin_cliente', tenantId: tenantA, name: 'Ana Admin' });
    const userB = await createUser(app, { role: 'admin_cliente', tenantId: tenantB, name: 'Bruno de B' });
    const veraxUser = await createSignedInUser(app, { role: 'admin_verax', name: 'Vera da Verax' });
    const csrf = await withCsrf(app, veraxUser.cookie);
    verax = { cookie: csrf.cookie, csrfToken: csrf.token, id: veraxUser.id };

    const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR);
    await insert('accountCreated', {
      occurredAt: at(1),
      actorType: 'user',
      actorId: adminA.id,
      tenantId: tenantA,
      action: 'cloud_account.create',
      resourceType: 'cloud_account',
      resourceId: 'conta-a',
      outcome: 'success',
      statusCode: 201,
      after: { accountId: '111122223333', regions: ['sa-east-1'] },
      ip: '203.0.113.10',
      userAgent: 'Navegador de Ana',
      requestId: 'req-a-1',
    });
    await insert('veraxEntered', {
      occurredAt: at(2),
      actorType: 'user',
      actorId: veraxUser.id,
      tenantId: tenantA,
      action: 'session.switch_tenant',
      resourceType: 'tenant',
      resourceId: tenantA,
      outcome: 'success',
      statusCode: 200,
      ip: '198.51.100.7',
      userAgent: 'Navegador da Verax',
    });
    await insert('oldDeniedLogin', {
      occurredAt: at(24 * 10),
      actorType: 'user',
      actorId: adminA.id,
      tenantId: tenantA,
      action: 'auth.sign_in',
      resourceType: 'login',
      outcome: 'denied',
      statusCode: 401,
    });
    // Registro que (por defeito ou adulteração) cita na trilha de A uma pessoa de B: o nome dela não pode vazar.
    await insert('foreignActor', {
      occurredAt: at(3),
      actorType: 'user',
      actorId: userB.id,
      tenantId: tenantA,
      action: 'finding.status',
      resourceType: 'finding',
      outcome: 'success',
    });
    await insert('otherTenant', {
      occurredAt: at(1),
      actorType: 'user',
      actorId: userB.id,
      tenantId: tenantB,
      action: 'cloud_account.create',
      resourceType: 'cloud_account',
      outcome: 'success',
    });
    await insert('platform', {
      occurredAt: at(1),
      actorType: 'user',
      actorId: veraxUser.id,
      tenantId: null,
      action: 'tenant.create',
      resourceType: 'tenant',
      outcome: 'success',
      ip: '198.51.100.7',
    });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('admin do cliente', () => {
    it('vê só a trilha do próprio cliente, da mais recente para trás', async () => {
      const response = await as(adminA.cookie)('/v1/audit?pageSize=100').expect(200);
      const seen = ids(response.body);
      expect(seen).toEqual(
        expect.arrayContaining([
          rows.accountCreated,
          rows.veraxEntered,
          rows.oldDeniedLogin,
          rows.foreignActor,
        ]),
      );
      expect(seen).not.toContain(rows.otherTenant);
      expect(seen).not.toContain(rows.platform);
      const times = pageSchema.parse(response.body).items.map((item) => item.occurredAt);
      expect(times).toEqual([...times].sort().reverse());
    });

    it('a equipe da Verax aparece com o nome, mas sem o IP nem o navegador', async () => {
      const page = pageSchema.parse(
        (await as(adminA.cookie)('/v1/audit?resourceType=tenant').expect(200)).body,
      );
      expect(page.items.find((item) => item.id === rows.veraxEntered)).toMatchObject({
        actor: { type: 'user', id: verax.id, name: 'Vera da Verax', verax: true },
        action: 'session.switch_tenant',
        ip: null,
      });
      const detail = auditEntryDetailSchema.parse(
        (await as(adminA.cookie)(`/v1/audit/${rows.veraxEntered}`).expect(200)).body,
      );
      expect(detail).toMatchObject({ ip: null, userAgent: null });
    });

    it('quem é do próprio cliente aparece inteiro; quem é de outro cliente, sem nome', async () => {
      const page = pageSchema.parse((await as(adminA.cookie)('/v1/audit?pageSize=100').expect(200)).body);
      expect(page.items.find((item) => item.id === rows.accountCreated)).toMatchObject({
        actor: { id: adminA.id, name: 'Ana Admin', verax: false },
        ip: '203.0.113.10',
        requestId: 'req-a-1',
      });
      expect(page.items.find((item) => item.id === rows.foreignActor)?.actor).toEqual({
        type: 'user',
        id: null,
        name: null,
        verax: false,
      });
    });

    it('filtros: resultado, área, pessoa e período', async () => {
      const get = as(adminA.cookie);
      expect(ids((await get('/v1/audit?outcome=denied&resourceType=login').expect(200)).body)).toEqual([
        rows.oldDeniedLogin,
      ]);
      expect(
        ids((await get('/v1/audit?outcome=denied&resourceType=login&period=7d').expect(200)).body),
      ).toEqual([]);
      const byVerax = ids((await get(`/v1/audit?actorId=${verax.id}`).expect(200)).body);
      expect(byVerax).toEqual([rows.veraxEntered]);
      const cloud = ids((await get('/v1/audit?resourceType=cloud_account').expect(200)).body);
      expect(cloud).toEqual([rows.accountCreated]);
    });

    it('detalhe com o estado novo; registro de outro cliente ou da Verax não existe', async () => {
      const detail = auditEntryDetailSchema.parse(
        (await as(adminA.cookie)(`/v1/audit/${rows.accountCreated}`).expect(200)).body,
      );
      expect(detail).toMatchObject({
        before: null,
        after: { accountId: '111122223333', regions: ['sa-east-1'] },
        userAgent: 'Navegador de Ana',
      });
      await as(adminA.cookie)(`/v1/audit/${rows.otherTenant}`).expect(404);
      await as(adminA.cookie)(`/v1/audit/${rows.platform}`).expect(404);
    });

    it('paginação', async () => {
      const first = pageSchema.parse((await as(adminA.cookie)('/v1/audit?pageSize=1').expect(200)).body);
      const second = pageSchema.parse(
        (await as(adminA.cookie)('/v1/audit?pageSize=1&page=2').expect(200)).body,
      );
      expect(first.items).toHaveLength(1);
      expect(second.items).toHaveLength(1);
      expect(first.total).toBeGreaterThanOrEqual(4);
      expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    });
  });

  describe('equipe da Verax', () => {
    it('sem cliente escolhido, vê a trilha da própria Verax, sem os registros dos clientes', async () => {
      await selectTenant(null);
      const seen = ids((await as(verax.cookie)(`/v1/audit?actorId=${verax.id}`).expect(200)).body);
      expect(seen).toContain(rows.platform);
      expect(seen).not.toContain(rows.veraxEntered);
      await as(verax.cookie)(`/v1/audit/${rows.accountCreated}`).expect(404);
    });

    it('com o cliente A escolhido, vê a trilha de A inteira, com IP e navegador', async () => {
      await selectTenant(tenantA);
      const page = pageSchema.parse((await as(verax.cookie)('/v1/audit?pageSize=100').expect(200)).body);
      const seen = page.items.map((item) => item.id);
      expect(seen).toEqual(expect.arrayContaining([rows.accountCreated, rows.veraxEntered]));
      expect(seen).not.toContain(rows.platform);
      expect(seen).not.toContain(rows.otherTenant);
      expect(page.items.find((item) => item.id === rows.veraxEntered)?.ip).toBe('198.51.100.7');
      // A equipe da Verax vê o nome de quem é de qualquer cliente.
      expect(page.items.find((item) => item.id === rows.foreignActor)?.actor.name).toBe('Bruno de B');
      const detail = auditEntryDetailSchema.parse(
        (await as(verax.cookie)(`/v1/audit/${rows.veraxEntered}`).expect(200)).body,
      );
      expect(detail.userAgent).toBe('Navegador da Verax');
      await selectTenant(null);
    });
  });

  it.each(['analista_cliente', 'leitura'] as const)('%s não lê a auditoria', async (role) => {
    const user = await createSignedInUser(app, { role, tenantId: tenantA });
    await as(user.cookie)('/v1/audit').expect(403);
    await as(user.cookie)(`/v1/audit/${rows.accountCreated}`).expect(403);
  });

  it.each([
    '/v1/audit?outra=1',
    '/v1/audit?pageSize=101',
    '/v1/audit?outcome=talvez',
    '/v1/audit?resourceType=widget',
    '/v1/audit?period=1y',
    '/v1/audit/nao-e-uuid',
  ])('parâmetro inválido é recusado: %s', async (path) => {
    await as(adminA.cookie)(path).expect(400);
  });

  it('não há rota que altere ou apague a trilha', async () => {
    const csrf = await withCsrf(app, adminA.cookie);
    const path = `/v1/audit/${rows.accountCreated}`;
    for (const method of ['patch', 'put', 'delete'] as const) {
      const call = request(app.getHttpServer())[method](path);
      await call
        .set('Cookie', csrf.cookie)
        .set('Origin', TEST_WEB_ORIGIN)
        .set('X-CSRF-Token', csrf.token)
        .send({})
        .expect(404);
    }
  });
});
