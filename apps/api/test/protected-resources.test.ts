import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { protectedResourceSchema } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { createSignedInUser, createTenant, createUser, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import { describeTenantIsolation, type TestSession } from './support/tenant-isolation.js';

type Session = TestSession & { userId: string };

describe('lista de proteção (T3.4)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let adminA: Session;
  let adminB: Session;
  let analystA: Session;
  let counter = 0;

  async function sessionFor(tenantId: string, role: 'admin_cliente' | 'analista_cliente'): Promise<Session> {
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
  const bucketName = () => `dados-criticos-${(counter += 1)}-${Date.now()}`;
  const entryOf = (response: request.Response) =>
    prisma.auditLog.findFirstOrThrow({ where: { requestId: response.headers['x-request-id'] } });

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente A');
    tenantB = await createTenant(app, 'Cliente B');
    adminA = await sessionFor(tenantA, 'admin_cliente');
    adminB = await sessionFor(tenantB, 'admin_cliente');
    analystA = await sessionFor(tenantA, 'analista_cliente');
  });

  afterAll(async () => {
    await app.close();
  });

  describeTenantIsolation({
    resource: 'lista de proteção',
    basePath: '/v1/protected-resources',
    context: () => ({ app, sessionA: adminA, sessionB: adminB }),
    createInTenantB: async () => {
      const author = await createUser(app, { role: 'admin_cliente', tenantId: tenantB });
      const item = await prisma.protectedResource.create({
        data: {
          tenantId: tenantB,
          type: 's3_bucket',
          identifier: bucketName(),
          reason: 'Backups',
          createdById: author.id,
        },
      });
      return item.id;
    },
    readDirect: (id) => prisma.protectedResource.findUniqueOrThrow({ where: { id } }),
    patchBody: { reason: 'Alterado por outro cliente' },
    hasDelete: true,
  });

  it('inclui com o autor da sessão e audita; repetido responde 409', async () => {
    const body = { type: 's3_bucket', identifier: bucketName(), reason: 'Backups de produção' };
    const created = await call(adminA).post('/v1/protected-resources', body).expect(201);
    const item = protectedResourceSchema.parse(created.body);
    expect(item.createdBy.id).toBe(adminA.userId);
    expect(await entryOf(created)).toMatchObject({
      action: 'protected_resource.create',
      tenantId: tenantA,
      after: { identifier: body.identifier },
    });
    await call(adminA).post('/v1/protected-resources', body).expect(409);
  });

  it.each([
    ['chave de acesso fora do formato', { type: 'access_key', identifier: 'chave-qualquer' }],
    ['instância fora do formato', { type: 'ec2_instance', identifier: 'servidor-1' }],
    ['IP inválido', { type: 'ip_address', identifier: '300.1.1.1' }],
    [
      'papel de IAM com ARN de usuário',
      { type: 'iam_role', identifier: 'arn:aws:iam::123456789012:user/ana' },
    ],
    ['autor no corpo', { type: 'aws_account', identifier: '123456789012', createdById: 'x' }],
    [
      'motivo com caractere de controle',
      { type: 'aws_account', identifier: '123456789012', reason: 'a\u0000b' },
    ],
  ])('recusa %s (400)', async (_label, body) => {
    await call(adminA)
      .post('/v1/protected-resources', { reason: 'Motivo', ...body })
      .expect(400);
  });

  it.each([
    ['aws_account', '123456789012'],
    ['iam_user', 'arn:aws:iam::123456789012:user/automacao'],
    ['iam_role', 'deploy-producao'],
    ['access_key', 'AKIAIOSFODNN7EXAMPLE'],
    ['ec2_instance', 'i-0abcd1234ef567890'],
    ['security_group', 'sg-0123456789abcdef0'],
    ['ip_address', '203.0.113.0/24'],
  ])('aceita %s no formato da AWS', async (type, identifier) => {
    await call(adminA).post('/v1/protected-resources', { type, identifier, reason: 'Crítico' }).expect(201);
  });

  it('altera o motivo e remove, sempre auditado; o identificador não muda', async () => {
    const created = protectedResourceSchema.parse(
      (
        await call(adminA)
          .post('/v1/protected-resources', { type: 's3_bucket', identifier: bucketName(), reason: 'Antes' })
          .expect(201)
      ).body,
    );
    const updated = await call(adminA)
      .patch(`/v1/protected-resources/${created.id}`, { reason: 'Depois' })
      .expect(200);
    expect(await entryOf(updated)).toMatchObject({
      before: { reason: 'Antes' },
      after: { reason: 'Depois' },
    });
    await call(adminA).patch(`/v1/protected-resources/${created.id}`, { identifier: 'outro' }).expect(400);

    const removed = await call(adminA).delete(`/v1/protected-resources/${created.id}`).expect(204);
    expect(await prisma.protectedResource.count({ where: { id: created.id } })).toBe(0);
    expect(await entryOf(removed)).toMatchObject({
      action: 'protected_resource.delete',
      before: { identifier: created.identifier },
    });
  });

  it('analista lê, mas não altera', async () => {
    await call(analystA).get('/v1/protected-resources').expect(200);
    await call(analystA)
      .post('/v1/protected-resources', { type: 'aws_account', identifier: '123456789013', reason: 'x' })
      .expect(403);
  });
});
