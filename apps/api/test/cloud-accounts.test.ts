import 'reflect-metadata';
import { randomInt } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { cloudAccountSchema } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { createSignedInUser, createTenant, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import { describeTenantIsolation, type TestSession } from './support/tenant-isolation.js';

/** IDs de conta fictícios (12 dígitos), diferentes a cada chamada. */
const accountId = () => String(randomInt(100_000_000_000, 999_999_999_999));
const bucket = (prefix = 'trilha') => `${prefix}-${randomInt(1_000_000, 9_999_999)}`;

describe('contas cloud (T3.3)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let adminA: TestSession;
  let adminB: TestSession;
  let readerA: TestSession;

  async function sessionFor(tenantId: string, role: 'admin_cliente' | 'leitura' | 'analista_cliente') {
    const user = await createSignedInUser(app, { role, tenantId });
    const { cookie, token } = await withCsrf(app, user.cookie);
    return { cookie, csrfToken: token };
  }

  const call = (session: TestSession) => {
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
  const newAccount = (overrides: object = {}) => ({
    provider: 'aws',
    accountId: accountId(),
    regions: ['sa-east-1', 'us-east-1'],
    ...overrides,
  });
  const entryOf = (response: request.Response) =>
    prisma.auditLog.findFirstOrThrow({ where: { requestId: response.headers['x-request-id'] } });

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente A');
    tenantB = await createTenant(app, 'Cliente B');
    adminA = await sessionFor(tenantA, 'admin_cliente');
    adminB = await sessionFor(tenantB, 'admin_cliente');
    readerA = await sessionFor(tenantA, 'leitura');
  });

  afterAll(async () => {
    await app.close();
  });

  describeTenantIsolation({
    resource: 'contas cloud',
    basePath: '/v1/cloud-accounts',
    context: () => ({ app, sessionA: adminA, sessionB: adminB }),
    createInTenantB: async () =>
      (
        await prisma.cloudAccount.create({
          data: {
            tenantId: tenantB,
            accountId: accountId(),
            regions: ['sa-east-1'],
            externalId: 'x'.repeat(43),
          },
        })
      ).id,
    readDirect: (id) => prisma.cloudAccount.findUniqueOrThrow({ where: { id } }),
    patchBody: { regions: ['eu-west-1'] },
    hasDelete: true,
  });

  describe('cadastro', () => {
    it('gera o ExternalId no servidor, deriva o papel e audita sem o ExternalId', async () => {
      const body = newAccount({
        buckets: { cloudtrail: bucket(), waf: `aws-waf-logs-${randomInt(1e6, 9e6)}` },
      });
      const created = await call(adminA).post('/v1/cloud-accounts', body).expect(201);
      const account = cloudAccountSchema.parse(created.body);
      expect(account.externalId).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(account.roleArn).toBe(`arn:aws:iam::${account.accountId}:role/VeraxControlReadOnly`);
      expect(account.buckets.guardduty).toBeNull();

      const entry = await entryOf(created);
      expect(entry).toMatchObject({ action: 'cloud_account.create', tenantId: tenantA });
      expect(JSON.stringify(entry)).not.toContain(account.externalId as string);
    });

    it.each([
      ['ExternalId no corpo', { externalId: 'escolhido-pelo-cliente-0000000000000000' }],
      ['chave de acesso', { accessKeyId: 'AKIAEXEMPLO0000000000', secretAccessKey: 'x'.repeat(40) }],
      ['papel escolhido', { roleArn: 'arn:aws:iam::123456789012:role/Admin' }],
      ['cliente no corpo', { tenantId: '018f0000-0000-7000-8000-00000000000b' }],
      ['ID de conta curto', { accountId: '12345' }],
      ['região inválida', { regions: ['marte-1'] }],
      ['região repetida', { regions: ['sa-east-1', 'sa-east-1'] }],
      ['bucket do WAF sem o prefixo da AWS', { buckets: { waf: 'logs-do-waf' } }],
      ['nome de bucket inválido', { buckets: { cloudtrail: 'Bucket_Maiusculo' } }],
    ])('recusa %s (400)', async (_label, overrides) => {
      await call(adminA).post('/v1/cloud-accounts', newAccount(overrides)).expect(400);
    });

    it('um ID de conta não pertence a dois clientes', async () => {
      const id = accountId();
      await call(adminA)
        .post('/v1/cloud-accounts', newAccount({ accountId: id }))
        .expect(201);
      const conflict = await call(adminB)
        .post('/v1/cloud-accounts', newAccount({ accountId: id }))
        .expect(409);
      expect(conflict.body).toMatchObject({ message: 'Esta conta AWS já está cadastrada' });
      expect(await prisma.cloudAccount.count({ where: { accountId: id } })).toBe(1);
    });

    it('um bucket de log é de um cliente só; contas do mesmo cliente podem dividi-lo', async () => {
      const shared = bucket();
      await call(adminA)
        .post('/v1/cloud-accounts', newAccount({ buckets: { cloudtrail: shared } }))
        .expect(201);
      await call(adminA)
        .post('/v1/cloud-accounts', newAccount({ buckets: { cloudtrail: shared } }))
        .expect(201);
      await call(adminB)
        .post('/v1/cloud-accounts', newAccount({ buckets: { cloudtrail: shared } }))
        .expect(409);
    });

    it('dois clientes registrando o mesmo bucket ao mesmo tempo: só um consegue', async () => {
      const contested = bucket('disputado');
      const results = await Promise.all([
        call(adminA).post('/v1/cloud-accounts', newAccount({ buckets: { guardduty: contested } })),
        call(adminB).post('/v1/cloud-accounts', newAccount({ buckets: { guardduty: contested } })),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    });
  });

  describe('leitura', () => {
    it('leitura vê a conta, mas não o ExternalId; não cadastra nem altera', async () => {
      const created = cloudAccountSchema.parse(
        (await call(adminA).post('/v1/cloud-accounts', newAccount()).expect(201)).body,
      );
      const seen = await call(readerA).get(`/v1/cloud-accounts/${created.id}`).expect(200);
      expect(seen.body).toMatchObject({ id: created.id, externalId: null });
      const list = await call(readerA).get('/v1/cloud-accounts?pageSize=100').expect(200);
      expect(JSON.stringify(list.body)).not.toContain(created.externalId as string);

      await call(readerA).post('/v1/cloud-accounts', newAccount()).expect(403);
      await call(readerA)
        .patch(`/v1/cloud-accounts/${created.id}`, { regions: ['us-east-1'] })
        .expect(403);
      await call(readerA).delete(`/v1/cloud-accounts/${created.id}`).expect(403);
    });
  });

  describe('alteração', () => {
    it('regiões e buckets mudam; null apaga um bucket; o ID da conta não muda', async () => {
      const created = cloudAccountSchema.parse(
        (
          await call(adminA)
            .post('/v1/cloud-accounts', newAccount({ buckets: { cloudtrail: bucket() } }))
            .expect(201)
        ).body,
      );
      const updated = await call(adminA)
        .patch(`/v1/cloud-accounts/${created.id}`, { regions: ['eu-west-1'], buckets: { cloudtrail: null } })
        .expect(200);
      expect(updated.body).toMatchObject({ regions: ['eu-west-1'], buckets: { cloudtrail: null } });
      expect(await entryOf(updated)).toMatchObject({ action: 'cloud_account.update', tenantId: tenantA });

      await call(adminA).patch(`/v1/cloud-accounts/${created.id}`, { accountId: accountId() }).expect(400);
    });

    it('desativar é exclusão lógica, auditada', async () => {
      const created = cloudAccountSchema.parse(
        (await call(adminA).post('/v1/cloud-accounts', newAccount()).expect(201)).body,
      );
      const removed = await call(adminA).delete(`/v1/cloud-accounts/${created.id}`).expect(204);
      expect((await prisma.cloudAccount.findUniqueOrThrow({ where: { id: created.id } })).status).toBe(
        'inactive',
      );
      expect(await entryOf(removed)).toMatchObject({
        action: 'cloud_account.deactivate',
        before: { status: 'active' },
        after: { status: 'inactive' },
      });
    });
  });
});
