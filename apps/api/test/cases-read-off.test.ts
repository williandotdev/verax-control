import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { caseStatusSchema, ROLES, type Role } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { createSignedInUser, createTenant, withCsrf } from './support/auth-helpers.js';
import { cleanCases, insertCase, insertFinding } from './support/cases.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';

/** Com `CASES_MODE=off`, as rotas dos casos não existem para ninguém. */
describe('leitura dos casos desligada (CASES_MODE=off)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let caseId: string;
  let findingId: string;
  const cookies = new Map<Role, string>();

  beforeAll(async () => {
    // Sem informar o modo: o padrão.
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
    tenantId = await createTenant(app, 'Cliente Demo (casos desligados)');
    caseId = await insertCase(prisma, tenantId);
    findingId = await insertFinding(prisma, tenantId, { caseId });
    await insertFinding(prisma, tenantId, { createdAt: new Date(Date.now() - 3_600_000) });
    for (const role of ROLES) {
      const user = await createSignedInUser(app, {
        role,
        tenantId: role === 'admin_verax' ? null : tenantId,
      });
      if (role !== 'admin_verax') {
        cookies.set(role, user.cookie);
        continue;
      }
      const { cookie, token } = await withCsrf(app, user.cookie);
      await request(app.getHttpServer())
        .post('/v1/session/tenant')
        .set('Cookie', cookie)
        .set('Origin', TEST_WEB_ORIGIN)
        .set('X-CSRF-Token', token)
        .send({ tenantId })
        .expect(200);
      cookies.set(role, cookie);
    }
  }, 60_000);

  afterAll(async () => {
    await cleanCases(prisma, [tenantId]);
    await app.close();
  }, 60_000);

  const paths = () => [
    '/v1/cases',
    '/v1/cases/groups?by=package',
    `/v1/cases/${caseId}`,
    `/v1/cases/${caseId}/findings`,
    `/v1/cases/${caseId}/timeline`,
    `/v1/findings/${findingId}/triage`,
    // Também com um pedido inválido: nada diz que a rota existe.
    '/v1/cases?x=1',
    '/v1/cases/abc',
    '/v1/cases/groups',
    `/v1/cases/${randomUUID()}`,
    `/v1/cases/${caseId}/findings?cursor=%00`,
    '/v1/findings/abc/triage',
  ];

  it.each(ROLES)('%s recebe a resposta de uma rota que não existe', async (role) => {
    const cookie = cookies.get(role) ?? '';
    const none = await request(app.getHttpServer())
      .get('/v1/rota-que-nao-existe')
      .set('Cookie', cookie)
      .expect(404);
    const shape = (body: unknown) => ({ ...(body as object), requestId: undefined });
    for (const path of paths()) {
      const response = await request(app.getHttpServer()).get(path).set('Cookie', cookie).expect(404);
      expect(shape(response.body), path).toEqual(shape(none.body));
    }
  });

  it.each(ROLES)('%s: a situação é desligada, sem ler o banco de casos', async (role) => {
    const spy = vi.spyOn(prisma, '$queryRaw');
    try {
      const response = await request(app.getHttpServer())
        .get('/v1/cases/status')
        .set('Cookie', cookies.get(role) ?? '')
        .expect(200);
      expect(caseStatusSchema.parse(response.body)).toEqual({
        mode: 'off',
        asOf: null,
        oldestUnassignedMinutes: null,
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('sem sessão, 401 como em qualquer rota', async () => {
    for (const path of ['/v1/cases/status', ...paths()]) {
      await request(app.getHttpServer()).get(path).expect(401);
    }
  });

  it('a lista e o detalhe dos alertas não mudam', async () => {
    const cookie = cookies.get('leitura') ?? '';
    await request(app.getHttpServer()).get('/v1/findings').set('Cookie', cookie).expect(200);
    const response = await request(app.getHttpServer())
      .get(`/v1/findings/${findingId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(JSON.stringify(response.body)).not.toContain(caseId);
  });
});
