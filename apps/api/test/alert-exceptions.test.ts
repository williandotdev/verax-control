import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { alertExceptionSchema } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { createSignedInUser, createTenant, createUser, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import { describeTenantIsolation, type TestSession } from './support/tenant-isolation.js';

type Session = TestSession & { userId: string };
const DAY = 24 * 60 * 60 * 1000;

describe('exceções de alerta (T3.5)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let analystA: Session;
  let analystB: Session;
  let readerA: Session;
  let rule = 100000;

  async function sessionFor(tenantId: string, role: 'analista_cliente' | 'leitura'): Promise<Session> {
    const user = await createSignedInUser(app, { role, tenantId });
    const { cookie, token } = await withCsrf(app, user.cookie);
    return { cookie, csrfToken: token, userId: user.id };
  }
  const call = (session: Session) => {
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
  const nextRule = () => String((rule += 1));
  const entryOf = (response: request.Response) =>
    prisma.auditLog.findFirstOrThrow({ where: { requestId: response.headers['x-request-id'] } });

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente A');
    tenantB = await createTenant(app, 'Cliente B');
    analystA = await sessionFor(tenantA, 'analista_cliente');
    analystB = await sessionFor(tenantB, 'analista_cliente');
    readerA = await sessionFor(tenantA, 'leitura');
  });

  afterAll(async () => {
    await app.close();
  });

  describeTenantIsolation({
    resource: 'exceções de alerta',
    basePath: '/v1/alert-exceptions',
    context: () => ({ app, sessionA: analystA, sessionB: analystB }),
    createInTenantB: async () => {
      const author = await createUser(app, { role: 'analista_cliente', tenantId: tenantB });
      const exception = await prisma.alertException.create({
        data: {
          tenantId: tenantB,
          ruleId: nextRule(),
          field: 'user',
          value: 'automacao',
          reason: 'Job noturno',
          createdById: author.id,
        },
      });
      return exception.id;
    },
    readDirect: (id) => prisma.alertException.findUniqueOrThrow({ where: { id } }),
    patchBody: { reason: 'Alterado por outro cliente' },
    hasDelete: true,
  });

  it('analista cria com o autor da sessão; repetida responde 409; auditada', async () => {
    const body = {
      ruleId: nextRule(),
      field: 'ip',
      value: '203.0.113.0/24',
      reason: 'Varredura autorizada do fornecedor',
      expiresAt: new Date(Date.now() + 30 * DAY).toISOString(),
    };
    const created = await call(analystA).post('/v1/alert-exceptions', body).expect(201);
    const exception = alertExceptionSchema.parse(created.body);
    expect(exception).toMatchObject({ active: true, matchedCount: 0, createdBy: { id: analystA.userId } });
    expect(await entryOf(created)).toMatchObject({ action: 'alert_exception.create', tenantId: tenantA });
    await call(analystA).post('/v1/alert-exceptions', body).expect(409);
  });

  it.each([
    ['regra que não é número', { ruleId: 'abc' }],
    ['IP inválido', { field: 'ip', value: 'servidor-1' }],
    ['validade no passado', { expiresAt: new Date(Date.now() - DAY).toISOString() }],
    ['validade de mais de um ano', { expiresAt: new Date(Date.now() + 400 * DAY).toISOString() }],
    ['contagem no corpo', { matchedCount: 10 }],
    ['autor no corpo', { createdById: 'x' }],
  ])('recusa %s (400)', async (_label, overrides) => {
    await call(analystA)
      .post('/v1/alert-exceptions', {
        ruleId: nextRule(),
        field: 'user',
        value: 'ana',
        reason: 'x',
        ...overrides,
      })
      .expect(400);
  });

  it('exceção vencida continua listada como inativa, e o filtro separa as duas', async () => {
    const author = await createUser(app, { role: 'analista_cliente', tenantId: tenantA });
    const expired = await prisma.alertException.create({
      data: {
        tenantId: tenantA,
        ruleId: nextRule(),
        field: 'resource',
        value: 'arn:aws:s3:::antigo',
        reason: 'Migração encerrada',
        expiresAt: new Date(Date.now() - DAY),
        createdById: author.id,
      },
    });
    const seen = await call(readerA).get(`/v1/alert-exceptions/${expired.id}`).expect(200);
    expect(seen.body).toMatchObject({ active: false });

    const active = await call(readerA).get('/v1/alert-exceptions?active=true&pageSize=100').expect(200);
    const inactive = await call(readerA).get('/v1/alert-exceptions?active=false&pageSize=100').expect(200);
    const ids = (page: request.Response) =>
      (page.body as { items: { id: string }[] }).items.map((item) => item.id);
    expect(ids(active)).not.toContain(expired.id);
    expect(ids(inactive)).toContain(expired.id);
  });

  it('altera motivo e validade, remove; leitura não altera', async () => {
    const created = alertExceptionSchema.parse(
      (
        await call(analystA)
          .post('/v1/alert-exceptions', {
            ruleId: nextRule(),
            field: 'user',
            value: 'deploy',
            reason: 'Antes',
          })
          .expect(201)
      ).body,
    );
    expect(created.expiresAt).toBeNull();
    await call(readerA).patch(`/v1/alert-exceptions/${created.id}`, { reason: 'x' }).expect(403);

    const expiresAt = new Date(Date.now() + 7 * DAY).toISOString();
    const updated = await call(analystA)
      .patch(`/v1/alert-exceptions/${created.id}`, { reason: 'Depois', expiresAt })
      .expect(200);
    expect(updated.body).toMatchObject({ reason: 'Depois', expiresAt });
    expect(await entryOf(updated)).toMatchObject({
      before: { reason: 'Antes' },
      after: { reason: 'Depois' },
    });
    await call(analystA).patch(`/v1/alert-exceptions/${created.id}`, { value: 'outro' }).expect(400);

    await call(readerA).delete(`/v1/alert-exceptions/${created.id}`).expect(403);
    const removed = await call(analystA).delete(`/v1/alert-exceptions/${created.id}`).expect(204);
    expect(await entryOf(removed)).toMatchObject({
      action: 'alert_exception.delete',
      before: { value: 'deploy' },
    });
  });
});
