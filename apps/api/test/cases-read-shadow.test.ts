import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { casePageSchema, caseStatusSchema } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { createSignedInUser, createTenant, withCsrf } from './support/auth-helpers.js';
import { cleanCases, insertCase, insertFinding } from './support/cases.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';

/** Com `CASES_MODE=shadow`, só a equipe da Verax lê os casos, no cliente escolhido: é a conferência do nó piloto. */
describe('leitura dos casos em medição (CASES_MODE=shadow)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let caseA: string;
  let caseB: string;
  let findingA: string;
  let verax: { cookie: string; token: string };

  const get = (path: string, cookie: string) => request(app.getHttpServer()).get(path).set('Cookie', cookie);
  const choose = (tenantId: string) =>
    request(app.getHttpServer())
      .post('/v1/session/tenant')
      .set('Cookie', verax.cookie)
      .set('Origin', TEST_WEB_ORIGIN)
      .set('X-CSRF-Token', verax.token)
      .send({ tenantId })
      .expect(200);

  beforeAll(async () => {
    app = await createApp({ casesMode: 'shadow' });
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente Demo A (casos em medição)');
    tenantB = await createTenant(app, 'Cliente Demo B (casos em medição)');
    caseA = await insertCase(prisma, tenantA);
    findingA = await insertFinding(prisma, tenantA, { caseId: caseA });
    await insertFinding(prisma, tenantA, { createdAt: new Date(Date.now() - 12 * 60_000) });
    caseB = await insertCase(prisma, tenantB);
    await insertFinding(prisma, tenantB, { caseId: caseB });
    verax = await withCsrf(app, (await createSignedInUser(app, { role: 'admin_verax' })).cookie);
  }, 60_000);

  afterAll(async () => {
    await cleanCases(prisma, [tenantA, tenantB]);
    await app.close();
  }, 60_000);

  it.each(['admin_cliente', 'analista_cliente', 'leitura'] as const)(
    '%s: as rotas não existem, e a situação é desligada',
    async (role) => {
      const { cookie } = await createSignedInUser(app, { role, tenantId: tenantA });
      const none = await get('/v1/rota-que-nao-existe', cookie).expect(404);
      const shape = (body: unknown) => ({ ...(body as object), requestId: undefined });
      for (const path of [
        '/v1/cases',
        '/v1/cases?x=1',
        '/v1/cases/groups?by=package',
        `/v1/cases/${caseA}`,
        `/v1/cases/${caseA}/findings`,
        `/v1/cases/${caseA}/timeline`,
        `/v1/findings/${findingA}/triage`,
      ]) {
        const response = await get(path, cookie).expect(404);
        expect(shape(response.body), path).toEqual(shape(none.body));
      }
      const status = await get('/v1/cases/status', cookie).expect(200);
      expect(caseStatusSchema.parse(status.body)).toEqual({
        mode: 'off',
        asOf: null,
        oldestUnassignedMinutes: null,
      });
    },
  );

  it('a equipe da Verax lê só o cliente escolhido, e troca de cliente com ele', async () => {
    await get('/v1/cases', verax.cookie).expect(409);
    const listed = async () =>
      casePageSchema
        .parse((await get('/v1/cases', verax.cookie).expect(200)).body)
        .items.map((item) => item.id);
    await choose(tenantA);
    expect(await listed()).toEqual([caseA]);
    await get(`/v1/cases/${caseA}`, verax.cookie).expect(200);
    await get(`/v1/cases/${caseA}/findings`, verax.cookie).expect(200);
    await get(`/v1/cases/${caseA}/timeline`, verax.cookie).expect(200);
    await get(`/v1/findings/${findingA}/triage`, verax.cookie).expect(200);
    await get('/v1/cases/groups?by=account', verax.cookie).expect(200);
    await get(`/v1/cases/${caseB}`, verax.cookie).expect(404);
    const status = caseStatusSchema.parse((await get('/v1/cases/status', verax.cookie).expect(200)).body);
    expect(status).toMatchObject({ mode: 'shadow', oldestUnassignedMinutes: 12 });
    await choose(tenantB);
    expect(await listed()).toEqual([caseB]);
    await get(`/v1/cases/${caseA}`, verax.cookie).expect(404);
    const other = caseStatusSchema.parse((await get('/v1/cases/status', verax.cookie).expect(200)).body);
    expect(other).toMatchObject({ mode: 'shadow', oldestUnassignedMinutes: null });
  });

  it('o pedido inválido é recusado só para quem vê os casos', async () => {
    await choose(tenantA);
    await get('/v1/cases?x=1', verax.cookie).expect(400);
  });
});
