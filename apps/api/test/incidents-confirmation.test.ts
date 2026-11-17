import 'reflect-metadata';
import { randomInt, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { incidentDetailSchema, relatedFindingsSchema } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { FindingSeverity, FindingStatus } from '../src/generated/prisma/client.js';
import { createSignedInUser, createTenant, createUser, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import type { TestSession } from './support/tenant-isolation.js';

const MINUTE = 60_000;

/**
 * Alerta → validação → incidente (decisão do responsável de 17/11/2026): o incidente só nasce quando uma pessoa promove
 * alertas; quem opera anexa e remove alertas; a correlação só sugere relacionados. Tudo pelo escopo do cliente da sessão,
 * auditado, e com os testes negativos A/B.
 */
describe('incidentes confirmados por uma pessoa (promover, anexar, remover, relacionados)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let analystA: TestSession & { userId: string };
  let analystB: TestSession & { userId: string };
  let readerA: TestSession & { userId: string };
  let colleagueA: string;
  let userOfB: string;

  async function sessionFor(tenantId: string, role: 'analista_cliente' | 'leitura') {
    const user = await createSignedInUser(app, { role, tenantId });
    const { cookie, token } = await withCsrf(app, user.cookie);
    return { cookie, csrfToken: token, userId: user.id };
  }

  const call = (session: TestSession) => {
    const server = request(app.getHttpServer());
    const write = (method: 'post' | 'delete', path: string) =>
      server[method](path)
        .set('Cookie', session.cookie)
        .set('Origin', TEST_WEB_ORIGIN)
        .set('X-CSRF-Token', session.csrfToken);
    return {
      get: (path: string) => server.get(path).set('Cookie', session.cookie),
      post: (path: string, body: object) => write('post', path).send(body),
      delete: (path: string) => write('delete', path),
    };
  };

  /** IP próprio de cada teste: os alertas de um teste não aparecem como relacionados nos de outro. */
  const ip = () => `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}`;

  async function insertFinding(
    tenantId: string,
    overrides: {
      severity?: FindingSeverity;
      status?: FindingStatus;
      sourceIp?: string | null;
      actorUser?: string | null;
      resource?: string | null;
      occurredAt?: Date;
      incidentId?: string;
    } = {},
  ) {
    return prisma.finding.create({
      data: {
        tenantId,
        accountId: '111111111111',
        source: 'wazuh',
        sourceEventId: randomUUID(),
        logSource: 'cloudtrail',
        occurredAt: overrides.occurredAt ?? new Date(Date.now() - 30 * MINUTE),
        severity: overrides.severity ?? 'medium',
        status: overrides.status ?? 'new',
        ruleId: '80255',
        ruleLevel: 8,
        title: 'Alerta de teste',
        sourceIp: overrides.sourceIp === undefined ? ip() : overrides.sourceIp,
        actorUser: overrides.actorUser ?? null,
        resource: overrides.resource ?? null,
        mitreTactics: ['Credential Access'],
        mitreTechniques: ['T1110'],
        ...(overrides.incidentId && { incidentId: overrides.incidentId }),
      },
    });
  }

  /** Incidente de um cliente com os alertas dados, gravado direto (como a promoção grava). */
  async function insertIncident(
    tenantId: string,
    severities: FindingSeverity[],
    status: 'open' | 'resolved' = 'open',
  ) {
    const at = new Date(Date.now() - 30 * MINUTE);
    const incident = await prisma.incident.create({
      data: {
        tenantId,
        severity: severities.includes('critical')
          ? 'critical'
          : severities.includes('high')
            ? 'high'
            : 'medium',
        status,
        riskScore: 30,
        findingCount: severities.length,
        firstSeenAt: at,
        lastSeenAt: at,
        keys: [],
        accounts: ['111111111111'],
        resources: [],
        mitreTactics: [],
        mitreTechniques: [],
      },
    });
    const findings = [];
    for (const severity of severities) {
      findings.push(await insertFinding(tenantId, { severity, incidentId: incident.id, occurredAt: at }));
    }
    return { incident, findings };
  }

  const entryOf = (response: request.Response) =>
    prisma.auditLog.findFirstOrThrow({ where: { requestId: response.headers['x-request-id'] } });
  const noticesOf = (tenantId: string, incidentId: string) =>
    prisma.notification.findMany({
      where: { tenantId, incidentId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { kind: true, severity: true, dedupeKey: true },
    });

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente A (confirmação)');
    tenantB = await createTenant(app, 'Cliente B (confirmação)');
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

  describe('promover alertas a incidente (POST /v1/incidents)', () => {
    it('cria o incidente com os alertas, quem confirmou e o responsável; resume, audita e avisa em qualquer severidade', async () => {
      const sharedIp = ip();
      const first = await insertFinding(tenantA, { severity: 'medium', sourceIp: sharedIp });
      const second = await insertFinding(tenantA, {
        severity: 'low',
        status: 'investigating',
        sourceIp: sharedIp,
        actorUser: 'arn:aws:iam::111111111111:user/admin-ficticio',
      });
      const response = await call(analystA)
        .post('/v1/incidents', { findingIds: [first.id, second.id], assigneeId: colleagueA })
        .expect(201);
      const detail = incidentDetailSchema.parse(response.body);
      expect(detail).toMatchObject({
        severity: 'medium',
        status: 'open',
        findingCount: 2,
        // Médio (30) + identidade admin (10) + um alerta a mais (3).
        riskScore: 43,
        assignee: { id: colleagueA },
        createdBy: { id: analystA.userId },
      });
      expect(detail.keys).toEqual(
        expect.arrayContaining([`ip:${sharedIp}`, 'user:arn:aws:iam::111111111111:user/admin-ficticio']),
      );
      expect(detail.findings.map((finding) => finding.id).sort()).toEqual([first.id, second.id].sort());
      // Os alertas mantêm o status que tinham.
      expect(detail.findings.map((finding) => finding.status).sort()).toEqual(['investigating', 'new']);

      expect(await entryOf(response)).toMatchObject({
        action: 'incident.create',
        resourceType: 'incident',
        resourceId: detail.id,
        tenantId: tenantA,
        actorId: analystA.userId,
        outcome: 'success',
        after: {
          findingIds: [first.id, second.id],
          assigneeId: colleagueA,
          severity: 'medium',
          riskScore: 43,
          findingCount: 2,
        },
      });
      expect(await noticesOf(tenantA, detail.id)).toEqual([
        { kind: 'incident_opened', severity: 'medium', dedupeKey: `incident:${detail.id}:medium` },
      ]);
    });

    it('item da lista de proteção soma 15 na nota', async () => {
      const bucket = `relatorios-${randomInt(1e6, 9e6)}`;
      await prisma.protectedResource.create({
        data: {
          tenantId: tenantA,
          type: 's3_bucket',
          identifier: bucket,
          reason: 'Dados de clientes',
          createdById: analystA.userId,
        },
      });
      const finding = await insertFinding(tenantA, { severity: 'high', resource: `s3:${bucket}` });
      const detail = incidentDetailSchema.parse(
        (
          await call(analystA)
            .post('/v1/incidents', { findingIds: [finding.id] })
            .expect(201)
        ).body,
      );
      expect(detail).toMatchObject({ severity: 'high', riskScore: 65, assignee: null });
    });

    it('alerta sem usuário, chave, IP nem recurso também pode ser confirmado (incidente sem chave)', async () => {
      const bare = await insertFinding(tenantA, { sourceIp: null });
      const detail = incidentDetailSchema.parse(
        (
          await call(analystA)
            .post('/v1/incidents', { findingIds: [bare.id] })
            .expect(201)
        ).body,
      );
      expect(detail.keys).toEqual([]);
    });

    it('alerta que já está num incidente: 409, e nada muda', async () => {
      const { incident, findings } = await insertIncident(tenantA, ['high']);
      const free = await insertFinding(tenantA);
      const response = await call(analystA)
        .post('/v1/incidents', { findingIds: [free.id, findings[0]?.id] })
        .expect(409);
      expect(response.body).toMatchObject({ code: 'FINDING_IN_INCIDENT' });
      expect((await prisma.finding.findUniqueOrThrow({ where: { id: free.id } })).incidentId).toBeNull();
      expect(await prisma.finding.count({ where: { incidentId: incident.id } })).toBe(1);
    });

    it('responsável de outro cliente: 400, e nenhum incidente nasce', async () => {
      const finding = await insertFinding(tenantA);
      await call(analystA)
        .post('/v1/incidents', { findingIds: [finding.id], assigneeId: userOfB })
        .expect(400);
      expect((await prisma.finding.findUniqueOrThrow({ where: { id: finding.id } })).incidentId).toBeNull();
    });

    it('leitura não promove (403); corpo com cliente ou lista vazia é recusado (400)', async () => {
      const finding = await insertFinding(tenantA);
      await call(readerA)
        .post('/v1/incidents', { findingIds: [finding.id] })
        .expect(403);
      await call(analystA).post('/v1/incidents', { findingIds: [] }).expect(400);
      await call(analystA)
        .post('/v1/incidents', { findingIds: [finding.id], tenantId: tenantB })
        .expect(400);
      expect((await prisma.finding.findUniqueOrThrow({ where: { id: finding.id } })).incidentId).toBeNull();
    });
  });

  describe('anexar e remover alertas', () => {
    it('anexar recalcula o resumo, audita e avisa quando a severidade sobe para alta ou crítica', async () => {
      const { incident } = await insertIncident(tenantA, ['medium']);
      const high = await insertFinding(tenantA, { severity: 'high' });
      const response = await call(analystA)
        .post(`/v1/incidents/${incident.id}/findings`, { findingIds: [high.id] })
        .expect(200);
      const detail = incidentDetailSchema.parse(response.body);
      expect(detail).toMatchObject({ severity: 'high', findingCount: 2, riskScore: 53 });
      expect(await entryOf(response)).toMatchObject({
        action: 'incident.attach',
        resourceId: incident.id,
        tenantId: tenantA,
        before: { severity: 'medium', findingCount: 1 },
        after: { findingIds: [high.id], severity: 'high', findingCount: 2, riskScore: 53 },
      });
      expect(await noticesOf(tenantA, incident.id)).toEqual([
        { kind: 'incident_escalated', severity: 'high', dedupeKey: `incident:${incident.id}:high` },
      ]);

      // Anexar sem subir a severidade não avisa.
      const low = await insertFinding(tenantA, { severity: 'low' });
      await call(analystA)
        .post(`/v1/incidents/${incident.id}/findings`, { findingIds: [low.id] })
        .expect(200);
      expect(await noticesOf(tenantA, incident.id)).toHaveLength(1);
    });

    it('remover devolve o alerta à fila com o status dele, recalcula e audita; o último alerta não sai (409)', async () => {
      const { incident, findings } = await insertIncident(tenantA, ['critical', 'medium']);
      const [critical, medium] = findings;
      if (!critical || !medium) throw new Error('alertas não gravados');
      await prisma.finding.update({ where: { id: critical.id }, data: { status: 'investigating' } });
      const response = await call(analystA)
        .delete(`/v1/incidents/${incident.id}/findings/${critical.id}`)
        .expect(200);
      expect(incidentDetailSchema.parse(response.body)).toMatchObject({
        severity: 'medium',
        findingCount: 1,
      });
      expect(await prisma.finding.findUniqueOrThrow({ where: { id: critical.id } })).toMatchObject({
        incidentId: null,
        status: 'investigating',
      });
      expect(await entryOf(response)).toMatchObject({
        action: 'incident.detach',
        resourceId: incident.id,
        before: { findingId: critical.id, severity: 'critical', findingCount: 2 },
        after: { findingId: critical.id, severity: 'medium', findingCount: 1 },
      });

      const last = await call(analystA)
        .delete(`/v1/incidents/${incident.id}/findings/${medium.id}`)
        .expect(409);
      expect(last.body).toMatchObject({ code: 'INCIDENT_LAST_FINDING' });
      expect((await prisma.finding.findUniqueOrThrow({ where: { id: medium.id } })).incidentId).toBe(
        incident.id,
      );
      // Alerta que não está neste incidente: 404.
      await call(analystA).delete(`/v1/incidents/${incident.id}/findings/${critical.id}`).expect(404);
    });

    it('incidente resolvido não ganha nem perde alerta (409); leitura não mexe (403)', async () => {
      const { incident, findings } = await insertIncident(tenantA, ['high', 'low'], 'resolved');
      const free = await insertFinding(tenantA);
      const attach = await call(analystA)
        .post(`/v1/incidents/${incident.id}/findings`, { findingIds: [free.id] })
        .expect(409);
      expect(attach.body).toMatchObject({ code: 'INCIDENT_RESOLVED' });
      await call(analystA).delete(`/v1/incidents/${incident.id}/findings/${findings[0]?.id}`).expect(409);
      const open = await insertIncident(tenantA, ['high', 'low']);
      await call(readerA)
        .post(`/v1/incidents/${open.incident.id}/findings`, { findingIds: [free.id] })
        .expect(403);
      await call(readerA)
        .delete(`/v1/incidents/${open.incident.id}/findings/${open.findings[0]?.id}`)
        .expect(403);
      expect((await prisma.finding.findUniqueOrThrow({ where: { id: free.id } })).incidentId).toBeNull();
    });
  });

  describe('isolamento entre clientes (A/B)', () => {
    it('A não promove alerta de B, nem misturado com os seus: 404, e nada muda', async () => {
      const ofB = await insertFinding(tenantB);
      const ofA = await insertFinding(tenantA);
      await call(analystA)
        .post('/v1/incidents', { findingIds: [ofB.id] })
        .expect(404);
      await call(analystA)
        .post('/v1/incidents', { findingIds: [ofA.id, ofB.id] })
        .expect(404);
      expect((await prisma.finding.findUniqueOrThrow({ where: { id: ofB.id } })).incidentId).toBeNull();
      expect((await prisma.finding.findUniqueOrThrow({ where: { id: ofA.id } })).incidentId).toBeNull();
      expect(
        await prisma.incident.count({ where: { createdById: analystA.userId, tenantId: tenantB } }),
      ).toBe(0);
    });

    it('A não anexa ao incidente de B nem anexa alerta de B ao seu: 404, e nada muda', async () => {
      const ofB = await insertIncident(tenantB, ['medium']);
      const ofA = await insertIncident(tenantA, ['medium']);
      const freeA = await insertFinding(tenantA);
      const freeB = await insertFinding(tenantB);
      const before = await prisma.incident.findUniqueOrThrow({ where: { id: ofB.incident.id } });
      await call(analystA)
        .post(`/v1/incidents/${ofB.incident.id}/findings`, { findingIds: [freeA.id] })
        .expect(404);
      await call(analystA)
        .post(`/v1/incidents/${ofA.incident.id}/findings`, { findingIds: [freeB.id] })
        .expect(404);
      expect(await prisma.incident.findUniqueOrThrow({ where: { id: ofB.incident.id } })).toEqual(before);
      expect((await prisma.finding.findUniqueOrThrow({ where: { id: freeA.id } })).incidentId).toBeNull();
      expect((await prisma.finding.findUniqueOrThrow({ where: { id: freeB.id } })).incidentId).toBeNull();
    });

    it('A não remove alerta do incidente de B: 404, e nada muda', async () => {
      const ofB = await insertIncident(tenantB, ['high', 'low']);
      await call(analystA)
        .delete(`/v1/incidents/${ofB.incident.id}/findings/${ofB.findings[0]?.id}`)
        .expect(404);
      expect(await prisma.finding.count({ where: { incidentId: ofB.incident.id } })).toBe(2);
    });

    it('B confirma os próprios alertas; os incidentes e avisos de cada um ficam no próprio cliente', async () => {
      const ofB = await insertFinding(tenantB, { severity: 'critical' });
      const detail = incidentDetailSchema.parse(
        (
          await call(analystB)
            .post('/v1/incidents', { findingIds: [ofB.id] })
            .expect(201)
        ).body,
      );
      expect((await prisma.incident.findUniqueOrThrow({ where: { id: detail.id } })).tenantId).toBe(tenantB);
      expect(await noticesOf(tenantB, detail.id)).toHaveLength(1);
      await call(analystA).get(`/v1/incidents/${detail.id}`).expect(404);
    });
  });

  describe('alertas relacionados (GET /v1/findings/:id/related)', () => {
    it('do mesmo cliente, em validação, fora de incidente, com chave em comum e dentro de 60 min', async () => {
      const sharedIp = ip();
      const at = new Date(Date.now() - 2 * 60 * MINUTE);
      const anchor = await insertFinding(tenantA, { sourceIp: sharedIp, occurredAt: at });
      const near = await insertFinding(tenantA, {
        sourceIp: sharedIp,
        status: 'investigating',
        occurredAt: new Date(at.getTime() + 20 * MINUTE),
      });
      const before = await insertFinding(tenantA, {
        sourceIp: sharedIp,
        occurredAt: new Date(at.getTime() - 50 * MINUTE),
      });
      // Fora: longe no tempo, já triado, em incidente, sem chave em comum, ou de outro cliente com o mesmo IP.
      await insertFinding(tenantA, { sourceIp: sharedIp, occurredAt: new Date(at.getTime() + 61 * MINUTE) });
      await insertFinding(tenantA, { sourceIp: sharedIp, status: 'legitimate', occurredAt: at });
      await insertFinding(tenantA, { sourceIp: sharedIp, status: 'resolved', occurredAt: at });
      const { incident } = await insertIncident(tenantA, ['high']);
      await insertFinding(tenantA, { sourceIp: sharedIp, incidentId: incident.id, occurredAt: at });
      await insertFinding(tenantA, { occurredAt: at });
      const ofB = await insertFinding(tenantB, { sourceIp: sharedIp, occurredAt: at });

      const response = await call(readerA).get(`/v1/findings/${anchor.id}/related`).expect(200);
      const { items } = relatedFindingsSchema.parse(response.body);
      expect(items.map((item) => item.id)).toEqual([near.id, before.id]);
      expect(JSON.stringify(response.body)).not.toContain(ofB.id);
    });

    it('A não pede os relacionados de um alerta de B (404)', async () => {
      const ofB = await insertFinding(tenantB);
      await call(analystA).get(`/v1/findings/${ofB.id}/related`).expect(404);
    });
  });
});
