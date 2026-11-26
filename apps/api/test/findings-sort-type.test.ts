import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type CaseQueueName, findingSchema, paginatedSchema } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { FindingSeverity, Prisma } from '../src/generated/prisma/client.js';
import { createSignedInUser, createTenant, withCsrf } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';
import type { TestSession } from './support/tenant-isolation.js';

const findingPage = paginatedSchema(findingSchema);
const HOUR = 3_600_000;

/**
 * E-06: a lista de alertas ordenada pela gravidade (`sort=severity`) e filtrada pelo tipo (`type`, a fila do caso). Os
 * dois são opcionais: sem eles, a lista é a de sempre; valor desconhecido é recusado, como qualquer filtro.
 */
describe('alertas: ordem por gravidade e filtro por tipo (E-06)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let analystA: TestSession;
  let analystB: TestSession;

  const get = (session: TestSession, path: string) =>
    request(app.getHttpServer()).get(path).set('Cookie', session.cookie);

  async function insertFinding(
    tenantId: string,
    overrides: Partial<Prisma.FindingUncheckedCreateInput> = {},
  ): Promise<string> {
    const { id } = await prisma.finding.create({
      data: {
        tenantId,
        accountId: '111122223333',
        source: 'wazuh',
        sourceEventId: `wazuh/111122223333/cloudtrail:${randomUUID()}:80202`,
        rawEventId: `1793527200.${randomUUID().slice(0, 6)}`,
        logSource: 'cloudtrail',
        occurredAt: new Date(),
        severity: 'high',
        ruleId: '80202',
        ruleLevel: 10,
        title: 'AWS CloudTrail: trilha desligada',
        eventName: 'StopLogging',
        region: 'sa-east-1',
        resource: null,
        actorUser: null,
        actorType: null,
        accessKeyId: null,
        sourceIp: null,
        mitreTactics: [],
        mitreTechniques: [],
        ...overrides,
      },
      select: { id: true },
    });
    return id;
  }

  async function insertCase(tenantId: string, queue: CaseQueueName): Promise<string> {
    const groupKey = randomBytes(32).toString('hex');
    const now = new Date();
    const { id } = await prisma.alertCase.create({
      data: {
        tenantId,
        queue,
        keyVersion: 1,
        groupKey,
        openKey: groupKey,
        family: 'teste',
        title: 'Caso de teste',
        keyParts: [],
        anchorFindingId: randomUUID(),
        firstSeenAt: now,
        lastSeenAt: now,
        lastAlertAt: now,
      },
      select: { id: true },
    });
    return id;
  }

  const ids = async (session: TestSession, query: string) =>
    findingPage
      .parse((await get(session, `/v1/findings?${query}`).expect(200)).body)
      .items.map((item) => item.id);

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente Demo A');
    tenantB = await createTenant(app, 'Cliente Demo B');
    const sessionOf = async (tenantId: string) => {
      const signedIn = await createSignedInUser(app, { role: 'analista_cliente', tenantId });
      const { cookie, token } = await withCsrf(app, signedIn.cookie);
      return { cookie, csrfToken: token };
    };
    analystA = await sessionOf(tenantA);
    analystB = await sessionOf(tenantB);
  });

  afterAll(async () => {
    await app.close();
  });

  it('sem `sort`, a mais recente primeiro; com `sort=severity`, a mais grave primeiro e, nela, a mais recente', async () => {
    const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR);
    const severities: [FindingSeverity, number][] = [
      ['low', 1],
      ['critical', 5],
      ['medium', 2],
      ['high', 3],
      ['critical', 4],
    ];
    const created: string[] = [];
    for (const [severity, hoursAgo] of severities) {
      created.push(await insertFinding(tenantA, { severity, occurredAt: at(hoursAgo) }));
    }
    const [low, criticalOld, medium, high, criticalNew] = created;
    // Os outros testes deste arquivo gravam alertas no mesmo cliente: a conferência é só destes cinco.
    const recent = (await ids(analystA, 'pageSize=100')).filter((id) => created.includes(id));
    expect(recent).toEqual([low, medium, high, criticalNew, criticalOld]);
    const bySeverity = (await ids(analystA, 'sort=severity&pageSize=100')).filter((id) =>
      created.includes(id),
    );
    expect(bySeverity).toEqual([criticalNew, criticalOld, high, medium, low]);
    // A ordem vale com a paginação: a primeira página é a dos mais graves.
    const first = findingPage.parse(
      (await get(analystA, '/v1/findings?sort=severity&pageSize=1').expect(200)).body,
    );
    expect(first.items[0]?.severity).toBe('critical');
  });

  it('`type` filtra pela fila do caso do alerta; o alerta sem caso não entra', async () => {
    const vulnerabilityCase = await insertCase(tenantA, 'vulnerability');
    const postureCase = await insertCase(tenantA, 'posture');
    const vulnerability = await insertFinding(tenantA, { caseId: vulnerabilityCase });
    const posture = await insertFinding(tenantA, { caseId: postureCase });
    const loose = await insertFinding(tenantA);

    const ofType = async (type: string) => ids(analystA, `type=${type}&pageSize=100`);
    expect(await ofType('vulnerability')).toEqual([vulnerability]);
    expect(await ofType('posture')).toEqual([posture]);
    expect(await ofType('detection')).not.toContain(loose);
    // Combina com a ordem e com os outros filtros.
    expect(await ids(analystA, 'type=vulnerability&sort=severity&severity=high&pageSize=100')).toEqual([
      vulnerability,
    ]);
  });

  it('o cliente B não vê os alertas do cliente A, com ou sem os filtros novos', async () => {
    const caseA = await insertCase(tenantA, 'vulnerability');
    const findingA = await insertFinding(tenantA, { caseId: caseA, severity: 'critical' });
    for (const query of ['sort=severity', 'type=vulnerability', 'type=vulnerability&sort=severity']) {
      expect(await ids(analystB, `${query}&pageSize=100`)).not.toContain(findingA);
    }
  });

  it('valor desconhecido é recusado (400), como qualquer filtro', async () => {
    for (const query of ['sort=asc', 'sort=SEVERITY', 'type=incident', 'type=', 'ordem=severidade']) {
      await get(analystA, `/v1/findings?${query}`).expect(400);
    }
  });
});
