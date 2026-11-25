import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { DAY_MS } from '../src/retention/retention-policy.js';
import { createSignedInUser, createTenant, withCsrf } from './support/auth-helpers.js';
import {
  assignAll,
  assignJob,
  cleanCases,
  expectSettled,
  insertMixed,
  loops,
  muteNotices,
  recentIds,
  STATUSES,
  watchedLogger,
} from './support/cases.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';

/**
 * A atribuição dos casos rodando enquanto uma pessoa usa a API (triagem com e sem comentário, promover, anexar, remover e
 * resolver): nenhuma requisição falha, nenhum alerta fica sem caso e as contagens fecham. Com todas as escritas ao mesmo
 * tempo, em `case-assign-concurrency.test.ts`.
 */
describe('case-assign com a API em uso', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const tenants: string[] = [];

  beforeAll(async () => {
    app = await createApp();
    // Uma porta só para o arquivo: sem isto, cada requisição ao mesmo tempo abriria e fecharia o próprio servidor.
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await cleanCases(prisma, tenants);
    await app.close();
  });

  async function sessionFor(tenantId: string) {
    const user = await createSignedInUser(app, { role: 'analista_cliente', tenantId });
    const { cookie, token } = await withCsrf(app, user.cookie);
    return (method: 'post' | 'patch' | 'delete', path: string, body?: object) => {
      const server = request(app.getHttpServer());
      const sent = server[method](path)
        .set('Cookie', cookie)
        .set('Origin', TEST_WEB_ORIGIN)
        .set('X-CSRF-Token', token);
      return (body === undefined ? sent : sent.send(body)).then((response) => ({
        status: response.status,
        body: response.body as { id?: string },
      }));
    };
  }

  it('a triagem, o promover, o anexar, o remover e o resolver pela API, com a atribuição rodando', async () => {
    const tenantId = await createTenant(app, 'Cliente Demo API (casos ao mesmo tempo)');
    tenants.push(tenantId);
    const write = await sessionFor(tenantId);
    await insertMixed(prisma, tenantId, 24, new Date());
    const ids = await recentIds(prisma, tenantId, new Date(Date.now() - DAY_MS));
    const { errors, logger } = watchedLogger();
    const job = assignJob(prisma, [tenantId], { batch: 5, logger });
    const background = loops(() => job.runOnce());
    const triage = async () => {
      const statuses: number[] = [];
      for (const [index, id] of ids.entries()) {
        const body = { status: STATUSES[index % 4], ...(index % 5 === 0 && { comment: 'visto' }) };
        statuses.push((await write('patch', `/v1/findings/${id}/status`, body)).status);
      }
      return statuses;
    };
    const incidents = async () => {
      const statuses: number[] = [];
      for (let round = 0; round < 3; round += 1) {
        const [first, second, third] = ids.slice(round * 8, round * 8 + 3);
        const created = await write('post', '/v1/incidents', { findingIds: [first, second] });
        await muteNotices(prisma, [tenantId]);
        const path = `/v1/incidents/${created.body.id as string}`;
        statuses.push(created.status);
        statuses.push((await write('post', `${path}/findings`, { findingIds: [third] })).status);
        await muteNotices(prisma, [tenantId]);
        statuses.push((await write('delete', `${path}/findings/${second as string}`)).status);
        statuses.push((await write('patch', path, { status: 'resolved' })).status);
      }
      return statuses;
    };
    try {
      const [triaged, incidentStatuses] = await Promise.all([triage(), incidents()]);
      expect(triaged).toEqual(ids.map(() => 200));
      expect(incidentStatuses).toEqual(Array.from({ length: 3 }, () => [201, 200, 200, 200]).flat());
    } finally {
      await background.stop();
    }
    expect(errors.filter(({ sqlState }) => sqlState !== '55P03')).toEqual([]);
    await assignAll(prisma, [tenantId]);
    await expectSettled(prisma, tenantId, 24);
    expect(await prisma.finding.count({ where: { tenantId, incidentId: { not: null } } })).toBe(6);
  });
});
