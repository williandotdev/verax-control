import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  incidentAssigneesSchema,
  incidentDetailSchema,
  incidentSchema,
  paginatedSchema,
} from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { createSignedInUser, createTenant, createUser, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import { describeTenantIsolation, type TestSession } from './support/tenant-isolation.js';

const incidentPage = paginatedSchema(incidentSchema);
const HOUR = 3_600_000;

describe('incidentes (T5.7)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let analystA: TestSession;
  let analystB: TestSession;
  let readerA: TestSession;
  let colleagueA: string;
  let userOfB: string;

  async function sessionFor(tenantId: string, role: 'analista_cliente' | 'leitura') {
    const user = await createSignedInUser(app, { role, tenantId });
    const { cookie, token } = await withCsrf(app, user.cookie);
    return { cookie, csrfToken: token };
  }

  const call = (session: TestSession) => {
    const server = request(app.getHttpServer());
    return {
      get: (path: string) => server.get(path).set('Cookie', session.cookie),
      patch: (path: string, body: object) =>
        server
          .patch(path)
          .set('Cookie', session.cookie)
          .set('Origin', TEST_WEB_ORIGIN)
          .set('X-CSRF-Token', session.csrfToken)
          .send(body),
    };
  };

  /** Incidente com um achado, gravado como o sync grava. */
  async function insertIncident(
    tenantId: string,
    overrides: Partial<Prisma.IncidentUncheckedCreateInput> = {},
  ) {
    const at = new Date(Date.now() - HOUR);
    const incident = await prisma.incident.create({
      data: {
        tenantId,
        severity: 'high',
        riskScore: 50,
        findingCount: 1,
        firstSeenAt: at,
        lastSeenAt: at,
        keys: ['ip:198.51.100.23'],
        accounts: ['111122223333'],
        resources: [],
        mitreTactics: ['Credential Access'],
        mitreTechniques: ['T1110'],
        ...overrides,
      },
    });
    await prisma.finding.create({
      data: {
        tenantId,
        incidentId: incident.id,
        accountId: '111122223333',
        source: 'wazuh',
        sourceEventId: randomUUID(),
        logSource: 'cloudtrail',
        occurredAt: at,
        severity: 'high',
        ruleId: '80255',
        ruleLevel: 10,
        title: 'Possível força bruta no console',
        sourceIp: '198.51.100.23',
        mitreTactics: ['Credential Access'],
        mitreTechniques: ['T1110'],
      },
    });
    return incident;
  }

  const entryOf = (response: request.Response) =>
    prisma.auditLog.findFirstOrThrow({ where: { requestId: response.headers['x-request-id'] } });

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente A (incidentes)');
    tenantB = await createTenant(app, 'Cliente B (incidentes)');
    analystA = await sessionFor(tenantA, 'analista_cliente');
    analystB = await sessionFor(tenantB, 'analista_cliente');
    readerA = await sessionFor(tenantA, 'leitura');
    colleagueA = (await createUser(app, { role: 'analista_cliente', tenantId: tenantA, status: 'active' }))
      .id;
    userOfB = (await createUser(app, { role: 'analista_cliente', tenantId: tenantB, status: 'active' })).id;
  });

  afterAll(async () => {
    await app.close();
  });

  describeTenantIsolation({
    resource: 'incidentes',
    basePath: '/v1/incidents',
    context: () => ({ app, sessionA: analystA, sessionB: analystB }),
    createInTenantB: async () => (await insertIncident(tenantB)).id,
    readDirect: (id) => prisma.incident.findUniqueOrThrow({ where: { id } }),
    patchBody: { status: 'investigating' },
  });

  it('lista pela nota de risco, no formato do contrato, com filtros', async () => {
    const tenant = await createTenant(app, 'Cliente com lista');
    const session = await sessionFor(tenant, 'leitura');
    const low = await insertIncident(tenant, { riskScore: 30, severity: 'medium' });
    const high = await insertIncident(tenant, { riskScore: 85, severity: 'critical' });
    const resolved = await insertIncident(tenant, { riskScore: 60, status: 'resolved' });
    const ids = async (query = '') =>
      incidentPage
        .parse((await call(session).get(`/v1/incidents?${query}`).expect(200)).body)
        .items.map((i) => i.id);
    expect(await ids()).toEqual([high.id, resolved.id, low.id]);
    expect(await ids('severity=critical')).toEqual([high.id]);
    expect(await ids('status=resolved')).toEqual([resolved.id]);
    expect(await ids('unassigned=true')).toHaveLength(3);
  });

  it('detalhe com a linha do tempo dos achados, que apontam para o incidente', async () => {
    const incident = await insertIncident(tenantA);
    const detail = incidentDetailSchema.parse(
      (await call(readerA).get(`/v1/incidents/${incident.id}`).expect(200)).body,
    );
    expect(detail).toMatchObject({ id: incident.id, mitreTechniques: ['T1110'], assignee: null });
    expect(detail.findings).toHaveLength(1);
    expect(detail.findings[0]?.incidentId).toBe(incident.id);
  });

  it('responsáveis possíveis: só do próprio cliente e da equipe da Verax', async () => {
    const { items } = incidentAssigneesSchema.parse(
      (await call(readerA).get('/v1/incidents/assignees').expect(200)).body,
    );
    const ids = items.map((user) => user.id);
    expect(ids).toContain(colleagueA);
    expect(ids).not.toContain(userOfB);
  });

  it('muda status e responsável, audita, marca a resolução e limpa ao reabrir', async () => {
    const incident = await insertIncident(tenantA);
    const response = await call(analystA)
      .patch(`/v1/incidents/${incident.id}`, { status: 'resolved', assigneeId: colleagueA })
      .expect(200);
    expect(incidentDetailSchema.parse(response.body)).toMatchObject({
      status: 'resolved',
      assignee: { id: colleagueA },
    });
    expect(await entryOf(response)).toMatchObject({
      action: 'incident.update',
      tenantId: tenantA,
      before: { status: 'open', assigneeId: null },
      after: { status: 'resolved', assigneeId: colleagueA },
    });
    expect(
      (await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).resolvedAt,
    ).not.toBeNull();

    await call(analystA)
      .patch(`/v1/incidents/${incident.id}`, { status: 'investigating', assigneeId: null })
      .expect(200);
    expect(await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).toMatchObject({
      status: 'investigating',
      assigneeId: null,
      resolvedAt: null,
    });
  });

  it('responsável de outro cliente é recusado, e nada muda', async () => {
    const incident = await insertIncident(tenantA);
    await call(analystA).patch(`/v1/incidents/${incident.id}`, { assigneeId: userOfB }).expect(400);
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).assigneeId).toBeNull();
  });

  it('leitura vê, mas não muda', async () => {
    const incident = await insertIncident(tenantA);
    await call(readerA).patch(`/v1/incidents/${incident.id}`, { status: 'resolved' }).expect(403);
  });

  it('o banco não deixa um achado entrar em incidente de outro cliente', async () => {
    const incidentOfB = await insertIncident(tenantB);
    const own = await insertIncident(tenantA);
    const finding = await prisma.finding.findFirstOrThrow({ where: { incidentId: own.id } });
    await expect(
      prisma.finding.update({ where: { id: finding.id }, data: { incidentId: incidentOfB.id } }),
    ).rejects.toThrow();
  });
});
