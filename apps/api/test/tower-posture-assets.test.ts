import 'reflect-metadata';
import { randomInt, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  accessKeyAssetSchema,
  inventorySummarySchema,
  paginatedSchema,
  postureCheckSchema,
  postureOverviewSchema,
  towerSummarySchema,
} from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { createSignedInUser, createTenant, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('Torre, postura e ativos (T5.8 a T5.10)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  /** Um cliente novo com uma conta AWS ativa, e a sessão de leitura dele. */
  async function setup(role: 'leitura' | 'admin_verax' = 'leitura') {
    const tenantId = await createTenant(app, `Cliente ${randomInt(1e6, 9e6)}`);
    const accountId = String(randomInt(100_000_000_000, 999_999_999_999));
    await prisma.cloudAccount.create({
      data: { tenantId, accountId, regions: ['sa-east-1'], externalId: 'x'.repeat(43) },
    });
    const user =
      role === 'admin_verax'
        ? await createSignedInUser(app, { role: 'admin_verax' })
        : await createSignedInUser(app, { role, tenantId });
    let cookie = user.cookie;
    if (role === 'admin_verax') {
      // admin_verax escolhe o cliente da sessão (T2.5), pelo próprio endpoint.
      const csrf = await withCsrf(app, user.cookie);
      cookie = csrf.cookie;
      await request(app.getHttpServer())
        .post('/v1/session/tenant')
        .set('Cookie', cookie)
        .set('Origin', TEST_WEB_ORIGIN)
        .set('X-CSRF-Token', csrf.token)
        .send({ tenantId })
        .expect(200);
    }
    const get = (path: string) => request(app.getHttpServer()).get(path).set('Cookie', cookie);
    return { tenantId, accountId, get };
  }

  async function insertScan(
    tenantId: string,
    accountId: string,
    scannedAt: Date,
    weights: { passed: number; total: number },
    failures: { severity: 'critical' | 'high' | 'low'; checkId: string }[] = [],
  ) {
    return prisma.postureScan.create({
      data: {
        tenantId,
        accountId,
        scannedAt,
        score: weights.total === 0 ? null : Math.round((weights.passed / weights.total) * 100),
        weightPassed: weights.passed,
        weightTotal: weights.total,
        passed: 10,
        failed: failures.length,
        failedCritical: failures.filter((f) => f.severity === 'critical').length,
        failedHigh: failures.filter((f) => f.severity === 'high').length,
        failedMedium: 0,
        failedLow: failures.filter((f) => f.severity === 'low').length,
        failedInformational: 0,
        failures: {
          // O cliente da reprovação vem da varredura (chave composta).
          create: failures.map((failure) => ({
            findingUid: `${failure.checkId}-${randomUUID()}`,
            checkId: failure.checkId,
            title: `Checagem ${failure.checkId}`,
            severity: failure.severity,
            region: 'sa-east-1',
            references: ['https://docs.aws.amazon.com/'],
          })),
        },
      },
    });
  }

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Torre', () => {
    it('cliente sem nada: verde, sem decisões, conta que nunca coletou aparece como silenciosa', async () => {
      const { accountId, get } = await setup();
      const summary = towerSummarySchema.parse((await get('/v1/tower').expect(200)).body);
      expect(summary).toMatchObject({
        light: 'green',
        reasons: [],
        pendingDecisions: [],
        openIncidents: { critical: 0, high: 0, medium: 0, low: 0 },
        posture: { score: null, scannedAt: null, warningBelow: 70 },
        coverage: {
          connectedAccounts: 0,
          lastCollectedAt: null,
          lastEventAt: null,
          silentAccounts: [accountId],
        },
      });
    });

    it('cobertura pela última coleta: conta lida sem evento não fica silenciosa, e só a conectada entra na contagem', async () => {
      const { tenantId, get } = await setup();
      const collected = new Date(Date.now() - HOUR);
      await prisma.cloudAccount.updateMany({
        where: { tenantId },
        data: { connection: 'connected', lastCollectedAt: collected },
      });
      const newAccount = (owner: string, data: object) =>
        prisma.cloudAccount.create({
          data: {
            tenantId: owner,
            accountId: String(randomInt(100_000_000_000, 999_999_999_999)),
            regions: ['sa-east-1'],
            externalId: 'x'.repeat(43),
            ...data,
          },
        });
      // Uma segunda conta, com erro e sem coleta há dois dias: silenciosa e fora das conectadas.
      const stalled = await newAccount(tenantId, {
        connection: 'error',
        connectionError: 'AccessDenied',
        lastCollectedAt: new Date(Date.now() - 2 * DAY),
      });
      // Conta de outro cliente, coletada agora: não entra na cobertura deste.
      await newAccount(await createTenant(app, `Cliente ${randomInt(1e6, 9e6)}`), {
        connection: 'connected',
        lastCollectedAt: new Date(),
        lastEventAt: new Date(),
      });

      const summary = towerSummarySchema.parse((await get('/v1/tower').expect(200)).body);
      expect(summary.coverage).toEqual({
        connectedAccounts: 1,
        lastCollectedAt: collected.toISOString(),
        lastEventAt: null,
        silentAccounts: [stalled.accountId],
        silentAfterHours: 24,
      });
    });

    it('incidente crítico aberto sem responsável e achado alto sem triagem: vermelho, com as decisões', async () => {
      const { tenantId, accountId, get } = await setup();
      const at = new Date(Date.now() - HOUR);
      await prisma.incident.create({
        data: {
          tenantId,
          severity: 'critical',
          riskScore: 90,
          findingCount: 1,
          firstSeenAt: at,
          lastSeenAt: at,
          keys: ['ip:198.51.100.1'],
          accounts: [accountId],
          resources: [],
          mitreTactics: [],
          mitreTechniques: [],
        },
      });
      await prisma.finding.create({
        data: {
          tenantId,
          accountId,
          source: 'wazuh',
          sourceEventId: randomUUID(),
          logSource: 'cloudtrail',
          occurredAt: at,
          severity: 'high',
          ruleId: '80202',
          ruleLevel: 10,
          title: 'Trilha desligada',
          mitreTactics: [],
          mitreTechniques: [],
        },
      });
      await prisma.cloudAccount.updateMany({ where: { tenantId }, data: { lastEventAt: at } });
      const summary = towerSummarySchema.parse((await get('/v1/tower').expect(200)).body);
      expect(summary).toMatchObject({
        light: 'red',
        reasons: ['critical_incident'],
        pendingDecisions: [
          { kind: 'unassigned_incident', count: 1 },
          { kind: 'untriaged_finding', count: 1 },
        ],
        openIncidents: { critical: 1 },
        coverage: { silentAccounts: [], lastEventAt: at.toISOString() },
      });
    });

    it('postura abaixo de 70: amarelo', async () => {
      const { tenantId, accountId, get } = await setup();
      await insertScan(tenantId, accountId, new Date(Date.now() - HOUR), { passed: 5, total: 10 });
      const summary = towerSummarySchema.parse((await get('/v1/tower').expect(200)).body);
      expect(summary).toMatchObject({ light: 'yellow', reasons: ['low_posture'], posture: { score: 50 } });
    });

    it('fila sem dono: só a equipe da Verax recebe a contagem', async () => {
      await prisma.unownedAlert.create({
        data: { source: 'wazuh', sourceEventId: randomUUID(), reason: 'unknown_account', accounts: [] },
      });
      const client = await setup();
      const verax = await setup('admin_verax');
      const kinds = async (get: typeof client.get) =>
        towerSummarySchema
          .parse((await get('/v1/tower').expect(200)).body)
          .pendingDecisions.map((d) => d.kind);
      expect(await kinds(client.get)).not.toContain('unowned_alert');
      expect(await kinds(verax.get)).toContain('unowned_alert');
    });
  });

  describe('postura', () => {
    it('sem varredura: conta com nota vazia e nenhuma checagem', async () => {
      const { accountId, get } = await setup();
      expect(postureOverviewSchema.parse((await get('/v1/posture').expect(200)).body)).toMatchObject({
        score: null,
        accounts: [{ accountId, score: null, scannedAt: null, history: [] }],
      });
      expect((await get('/v1/posture/checks').expect(200)).body).toMatchObject({ items: [], total: 0 });
    });

    it('nota da última varredura, uma por dia na evolução, e só as reprovações da última', async () => {
      const { tenantId, accountId, get } = await setup();
      await insertScan(tenantId, accountId, new Date(Date.now() - 2 * DAY), { passed: 10, total: 20 }, [
        { severity: 'low', checkId: 'antiga' },
      ]);
      await insertScan(tenantId, accountId, new Date(Date.now() - 1 * DAY), { passed: 30, total: 40 }, [
        { severity: 'low', checkId: 'iam_user_mfa' },
        { severity: 'critical', checkId: 'root_mfa' },
      ]);
      const overview = postureOverviewSchema.parse((await get('/v1/posture').expect(200)).body);
      expect(overview.score).toBe(75);
      expect(overview.accounts[0]?.history.map((point) => point.score)).toEqual([50, 75]);
      expect(overview.accounts[0]?.failedBySeverity).toMatchObject({ critical: 1, low: 1 });

      const checks = paginatedSchema(postureCheckSchema).parse(
        (await get('/v1/posture/checks').expect(200)).body,
      );
      // A mais grave primeiro; a reprovação da varredura antiga não aparece.
      expect(checks.items.map((check) => check.checkId)).toEqual(['root_mfa', 'iam_user_mfa']);
      expect(checks.items[0]?.accountId).toBe(accountId);
      const critical = await get('/v1/posture/checks?severity=critical').expect(200);
      expect(critical.body).toMatchObject({ total: 1 });
    });

    it('a nota do cliente soma os pesos das contas, sem tirar média das notas', async () => {
      const { tenantId, accountId, get } = await setup();
      const other = String(randomInt(100_000_000_000, 999_999_999_999));
      await prisma.cloudAccount.create({
        data: { tenantId, accountId: other, regions: ['sa-east-1'], externalId: 'y'.repeat(43) },
      });
      // 9/10 (90) e 1/30 (3): média das notas daria 47; os pesos dão 10/40 = 25.
      await insertScan(tenantId, accountId, new Date(Date.now() - HOUR), { passed: 9, total: 10 });
      await insertScan(tenantId, other, new Date(Date.now() - HOUR), { passed: 1, total: 30 });
      expect(postureOverviewSchema.parse((await get('/v1/posture').expect(200)).body).score).toBe(25);
    });
  });

  describe('ativos', () => {
    it('sem retrato: conta sem dados e contagens zeradas', async () => {
      const { accountId, get } = await setup();
      expect(inventorySummarySchema.parse((await get('/v1/assets').expect(200)).body)).toMatchObject({
        accounts: [{ accountId, collectedAt: null, root: null }],
        counts: { users: { total: 0, atRisk: 0 }, keys: { total: 0, atRisk: 0 } },
      });
      expect((await get('/v1/assets/keys').expect(200)).body).toMatchObject({ items: [], total: 0 });
    });

    it('último retrato vale; itens fora do formato não vão para a tela; risco primeiro', async () => {
      const { tenantId, accountId, get } = await setup();
      const key = (id: string, risk: string) => ({
        accountId,
        id,
        userName: 'deploy-bot',
        status: 'Active',
        createdAt: null,
        lastUsedAt: null,
        risk,
        reasons: risk === 'none' ? [] : ['old_access_key'],
      });
      await prisma.inventorySnapshot.create({
        data: {
          tenantId,
          accountId,
          collectedAt: new Date(Date.now() - 2 * DAY),
          items: { keys: [key('DEMOANTIGA0000000001', 'high')] },
        },
      });
      await prisma.inventorySnapshot.create({
        data: {
          tenantId,
          accountId,
          collectedAt: new Date(Date.now() - HOUR),
          root: {
            mfaEnabled: false,
            accessKeysPresent: false,
            risk: 'critical',
            reasons: ['root_without_mfa'],
          },
          items: {
            keys: [key('DEMOSEMRISCO00000001', 'none'), key('DEMOCOMRISCO00000001', 'high'), { lixo: true }],
          },
        },
      });
      const summary = inventorySummarySchema.parse((await get('/v1/assets').expect(200)).body);
      expect(summary.counts.keys).toEqual({ total: 2, atRisk: 1 });
      expect(summary.accounts[0]?.root).toMatchObject({ mfaEnabled: false, risk: 'critical' });

      const keys = paginatedSchema(accessKeyAssetSchema).parse(
        (await get('/v1/assets/keys').expect(200)).body,
      );
      expect(keys.items.map((item) => item.id)).toEqual(['DEMOCOMRISCO00000001', 'DEMOSEMRISCO00000001']);
      expect((await get('/v1/assets/keys?atRisk=true').expect(200)).body).toMatchObject({ total: 1 });
      await get('/v1/assets/discos').expect(400);
    });
  });
});
