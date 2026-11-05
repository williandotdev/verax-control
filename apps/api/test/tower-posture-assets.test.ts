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
import type { Prisma } from '../src/generated/prisma/client.js';
import { usageMonth } from '../src/usage/usage-meter.js';
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
      data: { tenantId, accountId, regions: ['sa-east-1'] },
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
    return { tenantId, accountId, get, userId: user.id };
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

    it('cobertura por provedor: AWS e GCP só pelo evento, Cloudflare também pela coleta; só a conectada entra na contagem', async () => {
      const { tenantId, accountId, get } = await setup();
      const event = new Date(Date.now() - 2 * HOUR);
      const collected = new Date(Date.now() - HOUR);
      // A conta AWS do cliente, lida pelo Wazuh: conectada pelo evento recebido, sem coleta por conta.
      await prisma.cloudAccount.updateMany({
        where: { tenantId },
        data: { connection: 'connected', lastEventAt: event },
      });
      const newAccount = (owner: string, data: Partial<Prisma.CloudAccountUncheckedCreateInput>) =>
        prisma.cloudAccount.create({
          data: {
            tenantId: owner,
            accountId: String(randomInt(100_000_000_000, 999_999_999_999)),
            regions: ['sa-east-1'],
            ...data,
          },
        });
      // Sem assinatura do Pub/Sub, para o sync da GCP de outro arquivo de teste não ler estas contas.
      const gcp = (data: Partial<Prisma.CloudAccountUncheckedCreateInput>) =>
        newAccount(tenantId, {
          provider: 'gcp',
          accountId: `vx-torre-${randomInt(1e6, 9e6)}`,
          regions: [],
          ...data,
        });
      // Cloudflare lida sem erro, sem nenhum evento: a leitura bem-sucedida já é sinal de vida.
      await newAccount(tenantId, {
        provider: 'cloudflare',
        accountId: randomUUID().replace(/-/g, ''),
        regions: [],
        connection: 'connected',
        lastCollectedAt: collected,
      });
      // GCP lida agora há pouco, sem entrada nenhuma ainda: a assinatura lida é o sinal de vida (OP-02).
      const empty = await gcp({ lastCollectedAt: new Date(Date.now() - 5 * 60_000) });
      // GCP com erro e o último evento há dois dias: silenciosa e fora das conectadas.
      const stalled = await gcp({
        connection: 'error',
        connectionError: 'PermissionDenied',
        lastCollectedAt: new Date(Date.now() - 2 * DAY),
        lastEventAt: new Date(Date.now() - 2 * DAY),
      });
      // Conta de outro cliente, coletada agora: não entra na cobertura deste.
      await newAccount(await createTenant(app, `Cliente ${randomInt(1e6, 9e6)}`), {
        connection: 'connected',
        lastCollectedAt: new Date(),
        lastEventAt: new Date(),
      });

      const summary = towerSummarySchema.parse((await get('/v1/tower').expect(200)).body);
      expect(summary.coverage).toEqual({
        connectedAccounts: 2,
        lastCollectedAt: empty.lastCollectedAt?.toISOString(),
        lastEventAt: event.toISOString(),
        silentAccounts: [stalled.accountId],
        silentAfterHours: 24,
        // PR-V6: sem a saúde da ingestão gravada (nenhuma leitura do Wazuh do nó), nada a afirmar.
        awsLogsStalledSince: null,
        awsStalledAfterHours: 2,
        // OP-01 e OP-02: o último dado é a leitura da GCP (a mais recente), à parte do último evento.
        lastDataAt: empty.lastCollectedAt?.toISOString(),
        sources: [
          // Sem a observação do Wazuh do nó, só o alerta prova que os logs chegaram: há 2 horas, a fonte está parada.
          {
            source: 'aws',
            state: 'stalled',
            lastDataAt: event.toISOString(),
            lastEventAt: event.toISOString(),
            delayedAfterMinutes: 30,
            stalledAfterMinutes: 120,
          },
          // A assinatura do projeto vazio foi lida há 5 min: a fonte coleta. A última entrada é a do projeto com erro.
          {
            source: 'gcp',
            state: 'collecting',
            lastDataAt: empty.lastCollectedAt?.toISOString(),
            lastEventAt: stalled.lastEventAt?.toISOString(),
            delayedAfterMinutes: 15,
            stalledAfterMinutes: 60,
          },
          {
            source: 'cloudflare',
            state: 'delayed',
            lastDataAt: collected.toISOString(),
            lastEventAt: null,
            delayedAfterMinutes: 30,
            stalledAfterMinutes: 120,
          },
          {
            source: 'agents',
            state: 'not_configured',
            lastDataAt: null,
            delayedAfterMinutes: 15,
            stalledAfterMinutes: 60,
          },
          {
            source: 'posture',
            state: 'waiting',
            lastDataAt: null,
            delayedAfterMinutes: 1560,
            stalledAfterMinutes: 3000,
          },
        ],
      });
      expect(summary.coverage.silentAccounts).not.toContain(accountId);
      // A AWS parada (sem a observação do Wazuh, o alerta de 2 horas atrás) deixa a Torre amarela (05/11/2026).
      expect(summary).toMatchObject({ light: 'yellow', reasons: ['collection_stalled'] });
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

  describe('Torre: saúde da coleta e pulso da operação (OP-01 e OP-02)', () => {
    const MINUTE = 60_000;
    const agentNumber = () => String(randomInt(10_000_000, 99_999_999));

    it('conta AWS calma, sem alerta, com os eventos andando no Wazuh: coleta ativa, não silenciosa, verde', async () => {
      const { tenantId, accountId, get } = await setup();
      await prisma.cloudAccount.updateMany({ where: { tenantId }, data: { connection: 'connected' } });
      const progress = new Date(Date.now() - 4 * MINUTE);
      await prisma.forTenant(tenantId).ingestHealth.create({
        data: { tenantId, source: 'aws', lastProgressAt: progress },
      });
      await insertScan(tenantId, accountId, new Date(Date.now() - HOUR), { passed: 9, total: 10 });
      const summary = towerSummarySchema.parse((await get('/v1/tower').expect(200)).body);
      expect(summary).toMatchObject({
        light: 'green',
        reasons: [],
        coverage: { silentAccounts: [], lastEventAt: null, lastDataAt: progress.toISOString() },
      });
      expect(summary.coverage.sources?.find((source) => source.source === 'aws')).toEqual({
        source: 'aws',
        state: 'collecting',
        lastDataAt: progress.toISOString(),
        lastEventAt: null,
        delayedAfterMinutes: 30,
        stalledAfterMinutes: 120,
      });
      // Sem inventário, a postura vale pela varredura.
      expect(summary.coverage.sources?.find((source) => source.source === 'posture')).toMatchObject({
        state: 'collecting',
      });
    });

    it('projeto da GCP calmo, com a assinatura lida e sem entrada há 3 dias: coletando, não silencioso, verde; leituras falhando param', async () => {
      const { tenantId, get } = await setup();
      // Sem assinatura do Pub/Sub, para o sync da GCP de outro arquivo de teste não ler esta conta.
      const project = await prisma.cloudAccount.create({
        data: {
          tenantId,
          provider: 'gcp',
          accountId: `vx-calmo-${randomInt(1e6, 9e6)}`,
          regions: [],
          connection: 'connected',
          lastCollectedAt: new Date(Date.now() - MINUTE),
          lastEventAt: new Date(Date.now() - 3 * DAY),
        },
      });
      const quiet = towerSummarySchema.parse((await get('/v1/tower').expect(200)).body);
      expect(quiet).toMatchObject({ light: 'green', reasons: [] });
      expect(quiet.coverage.silentAccounts).not.toContain(project.accountId);
      expect(quiet.coverage.sources?.find((source) => source.source === 'gcp')).toEqual({
        source: 'gcp',
        state: 'collecting',
        lastDataAt: project.lastCollectedAt?.toISOString(),
        lastEventAt: project.lastEventAt?.toISOString(),
        delayedAfterMinutes: 15,
        stalledAfterMinutes: 60,
      });

      // As leituras falham há 20 min (a falha não grava a coleta): atrasada; há 2 horas: parada e amarelo.
      await prisma.cloudAccount.update({
        where: { id: project.id },
        data: {
          connection: 'error',
          connectionError: 'PermissionDenied',
          lastCollectedAt: new Date(Date.now() - 20 * MINUTE),
        },
      });
      const late = towerSummarySchema.parse((await get('/v1/tower').expect(200)).body);
      expect(late).toMatchObject({ light: 'green', reasons: [] });
      expect(late.coverage.sources?.find((source) => source.source === 'gcp')?.state).toBe('delayed');
      await prisma.cloudAccount.update({
        where: { id: project.id },
        data: { lastCollectedAt: new Date(Date.now() - 2 * HOUR) },
      });
      const stalled = towerSummarySchema.parse((await get('/v1/tower').expect(200)).body);
      expect(stalled).toMatchObject({ light: 'yellow', reasons: ['collection_stalled'] });
      expect(stalled.coverage.sources?.find((source) => source.source === 'gcp')?.state).toBe('stalled');
    });

    it('A/B: a coleta parada de um cliente deixa só a Torre dele amarela; fonte não configurada nunca para', async () => {
      const a = await setup();
      const b = await setup();
      // A: Cloudflare lido pela última vez há 3 horas (o token recusado, por exemplo).
      await prisma.cloudAccount.create({
        data: {
          tenantId: a.tenantId,
          provider: 'cloudflare',
          accountId: randomUUID().replace(/-/g, ''),
          regions: [],
          connection: 'error',
          lastCollectedAt: new Date(Date.now() - 3 * HOUR),
        },
      });
      // B: o Cloudflare lido agora; a conta AWS de B cadastrada, sem dado ainda (aguarda).
      await prisma.cloudAccount.create({
        data: {
          tenantId: b.tenantId,
          provider: 'cloudflare',
          accountId: randomUUID().replace(/-/g, ''),
          regions: [],
          connection: 'connected',
          lastCollectedAt: new Date(),
        },
      });
      const towerA = towerSummarySchema.parse((await a.get('/v1/tower').expect(200)).body);
      const towerB = towerSummarySchema.parse((await b.get('/v1/tower').expect(200)).body);
      expect(towerA).toMatchObject({ light: 'yellow', reasons: ['collection_stalled'] });
      expect(towerA.coverage.sources?.map((source) => [source.source, source.state])).toEqual([
        ['aws', 'waiting'],
        ['gcp', 'not_configured'],
        ['cloudflare', 'stalled'],
        ['agents', 'not_configured'],
        ['posture', 'waiting'],
      ]);
      expect(towerB).toMatchObject({ light: 'green', reasons: [] });
      expect(towerB.coverage.sources?.find((source) => source.source === 'cloudflare')?.state).toBe(
        'collecting',
      );
    });

    it('pulso: achados de 24 h por hora, esperados, tempo até detectar, agentes e eventos do mês, só do cliente', async () => {
      const a = await setup();
      const b = await setup();
      const finding = (
        tenantId: string,
        accountId: string,
        occurredAt: Date,
        createdAt: Date,
        exceptionId: string | null = null,
      ) =>
        prisma.finding.create({
          data: {
            tenantId,
            accountId,
            source: 'wazuh',
            sourceEventId: randomUUID(),
            logSource: 'cloudtrail',
            occurredAt,
            createdAt,
            severity: 'low',
            ruleId: '80202',
            ruleLevel: 5,
            title: 'Evento de teste',
            mitreTactics: [],
            mitreTechniques: [],
            exceptionId,
          },
        });
      const exception = await prisma.alertException.create({
        data: {
          tenantId: a.tenantId,
          ruleId: '80202',
          field: 'user',
          value: `deploy-${randomInt(1e6, 9e6)}`,
          reason: 'Rotina conhecida',
          createdById: a.userId,
        },
      });
      const now = Date.now();
      await finding(a.tenantId, a.accountId, new Date(now - 30 * MINUTE), new Date(now - 28 * MINUTE));
      await finding(a.tenantId, a.accountId, new Date(now - 3 * HOUR), new Date(now - 3 * HOUR + 4 * MINUTE));
      await finding(
        a.tenantId,
        a.accountId,
        new Date(now - 5 * HOUR),
        new Date(now - 5 * HOUR + 10 * MINUTE),
        exception.id,
      );
      // Fora da janela de 24 horas.
      await finding(a.tenantId, a.accountId, new Date(now - 30 * HOUR), new Date(now - 30 * HOUR));
      // De B: nunca na Torre de A.
      for (let index = 0; index < 4; index += 1) {
        await finding(b.tenantId, b.accountId, new Date(now - HOUR), new Date(now - HOUR));
      }
      await prisma.wazuhAgent.createMany({
        data: [
          {
            tenantId: a.tenantId,
            agentId: agentNumber(),
            name: 'web-01',
            status: 'active',
            lastKeepAliveAt: new Date(),
          },
          {
            tenantId: a.tenantId,
            agentId: agentNumber(),
            name: 'web-02',
            status: 'disconnected',
            lastKeepAliveAt: new Date(now - 26 * HOUR),
          },
          {
            tenantId: b.tenantId,
            agentId: agentNumber(),
            name: 'b-01',
            status: 'active',
            lastKeepAliveAt: new Date(),
          },
        ],
      });
      const month = usageMonth(new Date());
      await prisma.ingestUsage.createMany({
        data: [
          { tenantId: a.tenantId, month, source: 'aws', bytes: 1_000n, events: 1_204n },
          { tenantId: a.tenantId, month, source: 'cloudflare', bytes: 500n, events: 9n },
          { tenantId: b.tenantId, month, source: 'gcp', bytes: 1_000n, events: 77n },
        ],
      });

      const summary = towerSummarySchema.parse((await a.get('/v1/tower').expect(200)).body);
      const pulse = summary.pulse;
      expect(pulse?.findings).toMatchObject({ total: 3, expected: 1 });
      expect(pulse?.findings.hourly.reduce((sum, value) => sum + value, 0)).toBe(3);
      // Mediana de 2, 4 e 10 minutos.
      expect(pulse?.timeToDetectSeconds).toBe(240);
      expect(pulse?.agents).toEqual({ online: 1, total: 2 });
      // Só a AWS e a GCP; o Cloudflare mede entradas, não eventos.
      expect(pulse?.monthEvents).toEqual({
        month: month.toISOString().slice(0, 7),
        sources: [{ source: 'aws', events: 1_204 }],
      });
      expect(summary.coverage.sources?.find((source) => source.source === 'agents')).toMatchObject({
        state: 'collecting',
      });

      const other = towerSummarySchema.parse((await b.get('/v1/tower').expect(200)).body).pulse;
      expect(other).toMatchObject({
        findings: { total: 4, expected: 0 },
        timeToDetectSeconds: 0,
        agents: { online: 1, total: 1 },
        monthEvents: { sources: [{ source: 'gcp', events: 77 }] },
      });
    });

    it('cliente sem achado, agente nem uso: pulso vazio, sem agentes e sem eventos do mês', async () => {
      const { get } = await setup();
      const pulse = towerSummarySchema.parse((await get('/v1/tower').expect(200)).body).pulse;
      expect(pulse).toMatchObject({
        findings: { total: 0, expected: 0 },
        timeToDetectSeconds: null,
        agents: null,
        monthEvents: { sources: [] },
      });
      expect(pulse?.findings.hourly).toEqual(Array.from({ length: 24 }, () => 0));
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
        data: { tenantId, accountId: other, regions: ['sa-east-1'] },
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
