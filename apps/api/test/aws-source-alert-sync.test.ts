import 'reflect-metadata';
import { randomInt, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { findingSchema } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AlertSync, type AlertSearchClient } from '../src/alerts/alert-sync.js';
import { CloudWatchAlertSync } from '../src/alerts/cloudwatch-alert-sync.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { cloudTrailAlert, cloudWatchAlert, vpcFlowAlert } from './alerts/fixtures.js';
import { createSignedInUser, createTenant } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';
import { FakeIndexer, wazuhTime } from './support/fake-indexer.js';

const MINUTE = 60_000;
const account = () => String(randomInt(100_000_000_000, 999_999_999_999));
const bucket = (prefix: string) => `${prefix}-${randomInt(1_000_000, 9_999_999)}`;

interface Cloud {
  id: string;
  tenantId: string;
  accountId: string;
}

/**
 * Os alertas das fontes do onboarding self-service da AWS lidas pelo Wazuh: os flow logs da VPC e os buckets das fontes
 * descobertas (pelo sync da AWS) e os grupos do CloudWatch Logs (pelo sync próprio).
 */
describe('sync dos alertas das fontes autorizadas: flow logs da VPC e CloudWatch Logs', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;

  function cloudAccount(
    tenantId: string,
    data: Partial<Prisma.CloudAccountUncheckedCreateInput> = {},
  ): Promise<Cloud> {
    return prisma.cloudAccount.create({
      data: {
        tenantId,
        provider: 'aws',
        accountId: account(),
        regions: ['sa-east-1'],
        connection: 'connected',
        ingestFrom: new Date('2026-11-01T00:00:00.000Z'),
        ...data,
      },
      select: { id: true, tenantId: true, accountId: true },
    });
  }

  /** Uma fonte descoberta com a autorização valendo. */
  function source(cloud: Cloud, data: Partial<Prisma.AwsSourceUncheckedCreateInput>) {
    const now = new Date();
    return prisma.awsSource.create({
      data: {
        tenantId: cloud.tenantId,
        cloudAccountId: cloud.id,
        kind: 'vpc_flow_logs',
        region: 'sa-east-1',
        resourceId: `recurso-${randomInt(1e6, 9e6)}`,
        name: 'fonte',
        method: 's3',
        availability: 'available',
        permission: 'granted',
        authorizedAt: now,
        authorizedBy: 'usuario-de-teste',
        collectFrom: new Date(now.toISOString().slice(0, 10)),
        state: 'collecting',
        ...data,
      },
    });
  }
  const logGroup = (cloud: Cloud, name = `/aws/lambda/funcao-${randomInt(1e6, 9e6)}`) =>
    source(cloud, {
      kind: 'cloudwatch_log_group',
      method: 'cloudwatch',
      resourceId: name,
      name,
      details: { logGroup: name },
      sensitive: true,
    });
  const revoke = (id: string) =>
    prisma.awsSource.update({
      where: { id },
      data: { revokedAt: new Date(), state: 'revoked', stateCode: null },
    });

  /** O documento com id e horário próprios, `minutesAgo` minutos atrás. */
  const at = (
    document: Record<string, unknown>,
    minutesAgo = 5,
  ): Record<string, unknown> & { id: string } => ({
    ...document,
    id: `${Date.now()}.${randomInt(1e6, 9e6)}`,
    timestamp: wazuhTime(new Date(Date.now() - minutesAgo * MINUTE)),
  });
  const awsSync = (indexer: AlertSearchClient) =>
    new AlertSync(prisma, indexer, { name: `teste-${randomUUID().slice(0, 8)}` });
  const cloudWatchSync = (indexer: AlertSearchClient, tenantIds: string[]) =>
    new CloudWatchAlertSync(prisma, indexer, { name: `teste-${randomUUID().slice(0, 8)}`, tenantIds });
  const findingsOf = (rawEventIds: string[]) =>
    prisma.finding.findMany({ where: { rawEventId: { in: rawEventIds } }, orderBy: { rawEventId: 'asc' } });
  const unownedOf = (ids: string[]) =>
    prisma.unownedAlert.findMany({
      where: { sourceEventId: { in: ids } },
      select: { sourceEventId: true, reason: true, accounts: true, title: true },
      orderBy: { sourceEventId: 'asc' },
    });

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente Demo A (alertas das fontes)');
    tenantB = await createTenant(app, 'Cliente Demo B (alertas das fontes)');
  });

  afterAll(async () => {
    await app.close();
  });

  describe('flow logs da VPC e buckets das fontes descobertas (sync da AWS)', () => {
    it('o alerta do bucket de uma fonte autorizada vira achado do cliente dela; o mesmo registro duas vezes, um achado só', async () => {
      const cloud = await cloudAccount(tenantA);
      const flowBucket = bucket('fluxo');
      const trailBucket = bucket('trilha-descoberta');
      await source(cloud, { details: { bucket: flowBucket, flowLogId: 'fl-0123456789abcdef0' } });
      // Outro flow log da mesma conta no mesmo bucket: o bucket entra uma vez só no cadastro.
      await source(cloud, { details: { bucket: flowBucket, flowLogId: 'fl-0fedcba9876543210' } });
      await source(cloud, { kind: 'cloudtrail', details: { bucket: trailBucket } });

      const flow = at(vpcFlowAlert({ account: cloud.accountId, bucket: flowBucket }));
      // O mesmo registro lido de novo pelo Wazuh: outro alerta, a mesma identidade.
      const again = at(vpcFlowAlert({ account: cloud.accountId, bucket: flowBucket }), 4);
      const other = at(vpcFlowAlert({ account: cloud.accountId, bucket: flowBucket, sourcePort: 50_000 }), 3);
      const trail = at(cloudTrailAlert({ account: cloud.accountId, bucket: trailBucket }), 2);
      const report = await awsSync(new FakeIndexer([flow, again, other, trail])).runOnce();
      expect(report).toMatchObject({ read: 4, created: 3, duplicates: 1, unowned: 0 });

      const findings = await findingsOf([flow.id, again.id, other.id, trail.id]);
      expect(findings.map((finding) => finding.rawEventId).sort()).toEqual(
        [flow.id, other.id, trail.id].sort(),
      );
      expect(findings.find((finding) => finding.rawEventId === flow.id)).toMatchObject({
        tenantId: tenantA,
        accountId: cloud.accountId,
        source: 'wazuh',
        logSource: 'vpc_flow',
        severity: 'low',
        status: 'new',
        eventName: 'REJECT',
        region: 'sa-east-1',
        resource: 'eni:eni-0123456789abcdef0',
        sourceIp: '203.0.113.50',
        ruleId: '100400',
      });
      expect(findings.find((finding) => finding.rawEventId === trail.id)).toMatchObject({
        tenantId: tenantA,
        logSource: 'cloudtrail',
      });
      // A conta mostra o evento mais recente.
      const row = await prisma.cloudAccount.findUniqueOrThrow({ where: { id: cloud.id } });
      expect(row.lastEventAt).not.toBeNull();

      // Outra execução relê tudo: nada novo.
      expect(await awsSync(new FakeIndexer([flow, again, other, trail])).runOnce()).toMatchObject({
        created: 0,
        duplicates: 4,
      });
    });

    it('a API devolve o achado dos flow logs com a fonte de log dele, só ao cliente dono (A/B)', async () => {
      const cloud = await cloudAccount(tenantA);
      const flowBucket = bucket('fluxo');
      await source(cloud, { details: { bucket: flowBucket } });
      const flow = at(vpcFlowAlert({ account: cloud.accountId, bucket: flowBucket }));
      await awsSync(new FakeIndexer([flow])).runOnce();

      const adminA = await createSignedInUser(app, { role: 'admin_cliente', tenantId: tenantA });
      const adminB = await createSignedInUser(app, { role: 'admin_cliente', tenantId: tenantB });
      const list = (cookie: string) =>
        request(app.getHttpServer()).get('/v1/findings?source=vpc_flow&pageSize=100').set('Cookie', cookie);
      const ofA = (await list(adminA.cookie).expect(200)).body as { items: unknown[] };
      const items = ofA.items.map((item) => findingSchema.parse(item));
      expect(items.find((item) => item.accountId === cloud.accountId)).toMatchObject({
        source: 'vpc_flow',
        eventName: 'REJECT',
      });
      const ofB = (await list(adminB.cookie).expect(200)).body as { items: unknown[] };
      expect(ofB.items).toEqual([]);
    });

    it('o bucket só vale enquanto a autorização vale, para a fonte dele e para o cliente que o autorizou', async () => {
      const cloudA = await cloudAccount(tenantA);
      const cloudB = await cloudAccount(tenantB);
      const flowBucket = bucket('fluxo');
      const revokedBucket = bucket('fluxo-revogado');
      await source(cloudA, { details: { bucket: flowBucket } });
      const revoked = await source(cloudA, { details: { bucket: revokedBucket } });
      await revoke(revoked.id);

      const fromRevoked = at(vpcFlowAlert({ account: cloudA.accountId, bucket: revokedBucket }));
      // O bucket dos flow logs não vale como origem de CloudTrail.
      const wrongSource = at(cloudTrailAlert({ account: cloudA.accountId, bucket: flowBucket }), 4);
      // A pasta da conta de outro cliente no bucket que A autorizou.
      const otherTenant = at(vpcFlowAlert({ account: cloudB.accountId, bucket: flowBucket }), 3);
      const report = await awsSync(new FakeIndexer([fromRevoked, wrongSource, otherTenant])).runOnce();
      expect(report).toMatchObject({ read: 3, created: 0, unowned: 3 });
      expect(await unownedOf([fromRevoked.id, wrongSource.id, otherTenant.id])).toEqual(
        [
          { sourceEventId: fromRevoked.id, reason: 'unknown_source', accounts: [cloudA.accountId] },
          { sourceEventId: wrongSource.id, reason: 'unknown_source', accounts: [cloudA.accountId] },
          { sourceEventId: otherTenant.id, reason: 'source_mismatch', accounts: [cloudB.accountId] },
        ]
          .map((item) => ({ ...item, title: expect.any(String) as string }))
          .sort((a, b) => a.sourceEventId.localeCompare(b.sourceEventId)),
      );
      expect(await findingsOf([fromRevoked.id, wrongSource.id, otherTenant.id])).toEqual([]);
    });

    it('o mesmo bucket autorizado por dois clientes não vale para nenhum', async () => {
      const cloudA = await cloudAccount(tenantA);
      const cloudB = await cloudAccount(tenantB);
      const shared = bucket('fluxo-dos-dois');
      await source(cloudA, { details: { bucket: shared } });
      await source(cloudB, { details: { bucket: shared } });
      const flow = at(vpcFlowAlert({ account: cloudA.accountId, bucket: shared }));
      expect(await awsSync(new FakeIndexer([flow])).runOnce()).toMatchObject({ created: 0, unowned: 1 });
      expect(await unownedOf([flow.id])).toMatchObject([{ reason: 'ambiguous_source' }]);
    });
  });

  describe('grupos do CloudWatch Logs (sync próprio)', () => {
    it('com um só cliente e uma só conta com grupo autorizado, o alerta vira achado dele; relido, não duplica', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (CloudWatch Logs)');
      const cloud = await cloudAccount(tenant);
      await logGroup(cloud);
      await logGroup(cloud);
      const alert = at(cloudWatchAlert());
      const low = at(cloudWatchAlert({ level: 5 }), 4);
      // O que não é do CloudWatch Logs nunca é atribuído por este caminho, mesmo se chegasse à página.
      const fromBucket = at(cloudTrailAlert({ account: cloud.accountId }), 3);
      const fromAgent = at(cloudWatchAlert({ agentId: '001' }), 2);
      const indexer = new FakeIndexer([alert, low, fromBucket, fromAgent]);
      const sync = cloudWatchSync(indexer, [tenant]);

      expect(await sync.runOnce()).toMatchObject({
        status: 'done',
        read: 4,
        created: 1,
        duplicates: 0,
        unowned: 0,
        skipped: 2,
        belowLevel: 1,
      });
      expect(await findingsOf([alert.id, low.id, fromBucket.id, fromAgent.id])).toMatchObject([
        {
          tenantId: tenant,
          accountId: cloud.accountId,
          source: 'wazuh',
          sourceEventId: `wazuh/${cloud.accountId}/alert:${alert.id}:5712`,
          rawEventId: alert.id,
          logSource: 'cloudwatch_logs',
          severity: 'high',
          status: 'new',
          ruleId: '5712',
          title: 'sshd: brute force trying to get access to the system.',
          eventName: 'sshd',
          resource: null,
          region: null,
          actorUser: 'root',
          sourceIp: '203.0.113.50',
          mitreTechniques: ['T1110'],
        },
      ]);
      // A consulta: só os do manager, do módulo da AWS, que não são de bucket, do nível 7 para cima.
      expect(indexer.requests[0]?.body['query']).toMatchObject({
        bool: {
          filter: expect.arrayContaining([
            { term: { 'agent.id': '000' } },
            { term: { location: 'Wazuh-AWS' } },
            { range: { 'rule.level': { gte: 7 } } },
          ]) as unknown[],
          must_not: [{ term: { 'data.integration': 'aws' } }],
        },
      });
      // O mesmo alerta relido (a sobreposição da janela, outra execução): um achado só.
      expect(await sync.runOnce()).toMatchObject({ created: 0, duplicates: 1 });
      expect(await cloudWatchSync(new FakeIndexer([alert]), [tenant]).runOnce()).toMatchObject({
        created: 0,
        duplicates: 1,
      });
      expect(await findingsOf([alert.id])).toHaveLength(1);
      expect(
        (await prisma.cloudAccount.findUniqueOrThrow({ where: { id: cloud.id } })).lastEventAt,
      ).not.toBeNull();
    });

    it('com mais de um cliente com grupo autorizado no nó, o alerta não é de ninguém: fila sem dono, sem as contas', async () => {
      const first = await createTenant(app, 'Cliente Demo A (CloudWatch Logs, dois clientes)');
      const second = await createTenant(app, 'Cliente Demo B (CloudWatch Logs, dois clientes)');
      const cloudA = await cloudAccount(first);
      const cloudB = await cloudAccount(second);
      await logGroup(cloudA);
      const groupB = await logGroup(cloudB);
      const alert = at(cloudWatchAlert());
      expect(await cloudWatchSync(new FakeIndexer([alert]), [first, second]).runOnce()).toMatchObject({
        created: 0,
        unowned: 1,
      });
      expect(await unownedOf([alert.id])).toEqual([
        {
          sourceEventId: alert.id,
          reason: 'ambiguous_source',
          accounts: [],
          title: 'sshd: brute force trying to get access to the system.',
        },
      ]);
      expect(await findingsOf([alert.id])).toEqual([]);
      // Nenhum achado em nenhum dos dois clientes.
      expect(await prisma.finding.count({ where: { tenantId: { in: [first, second] } } })).toBe(0);

      // O segundo cliente tira a autorização: os alertas seguintes são do primeiro.
      await revoke(groupB.id);
      const next = at(cloudWatchAlert(), 1);
      expect(await cloudWatchSync(new FakeIndexer([next]), [first, second]).runOnce()).toMatchObject({
        created: 1,
        unowned: 0,
      });
      expect(await findingsOf([next.id])).toMatchObject([{ tenantId: first, accountId: cloudA.accountId }]);
    });

    it('sem grupo autorizado, com a conta desativada ou com grupos em duas contas, o alerta vai para a fila com o motivo', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (CloudWatch Logs, sem dono)');
      const cloud = await cloudAccount(tenant);
      const group = await logGroup(cloud);
      // Um grupo só descoberto (sem autorização) e uma fonte de bucket autorizada não contam.
      await source(cloud, {
        kind: 'cloudwatch_log_group',
        method: 'cloudwatch',
        resourceId: '/aws/lambda/so-descoberto',
        authorizedAt: null,
        authorizedBy: null,
        collectFrom: null,
        state: 'available',
      });
      await revoke(group.id);
      await source(cloud, { details: { bucket: bucket('fluxo') } });
      const none = at(cloudWatchAlert());
      expect(await cloudWatchSync(new FakeIndexer([none]), [tenant]).runOnce()).toMatchObject({ unowned: 1 });

      // Duas contas do mesmo cliente com grupo autorizado: o alerta é dele, mas não há como dizer de que conta.
      const other = await cloudAccount(tenant);
      await logGroup(cloud);
      await logGroup(other);
      const twoAccounts = at(cloudWatchAlert(), 4);
      expect(await cloudWatchSync(new FakeIndexer([twoAccounts]), [tenant]).runOnce()).toMatchObject({
        unowned: 1,
      });

      // Uma das contas desativada: sobra uma, e o alerta volta a ter dono.
      await prisma.cloudAccount.update({ where: { id: other.id }, data: { status: 'inactive' } });
      const owned = at(cloudWatchAlert(), 3);
      expect(await cloudWatchSync(new FakeIndexer([owned]), [tenant]).runOnce()).toMatchObject({
        created: 1,
      });

      expect(await unownedOf([none.id, twoAccounts.id])).toMatchObject(
        [
          { sourceEventId: none.id, reason: 'unknown_source', accounts: [] },
          {
            sourceEventId: twoAccounts.id,
            reason: 'no_account',
            accounts: [cloud.accountId, other.accountId].sort(),
          },
        ].sort((a, b) => a.sourceEventId.localeCompare(b.sourceEventId)),
      );
      expect(await findingsOf([none.id, twoAccounts.id, owned.id])).toMatchObject([
        { rawEventId: owned.id, tenantId: tenant, accountId: cloud.accountId },
      ]);
    });

    it('o alerta fora do formato vai para a fila como inválido, sem derrubar os outros', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (CloudWatch Logs, inválido)');
      const cloud = await cloudAccount(tenant);
      await logGroup(cloud);
      const good = at(cloudWatchAlert());
      const broken = { ...at(cloudWatchAlert(), 4), rule: 'não é objeto' };
      expect(await cloudWatchSync(new FakeIndexer([broken, good]), [tenant]).runOnce()).toMatchObject({
        read: 2,
        created: 1,
        unowned: 1,
      });
      expect(await unownedOf([broken.id])).toMatchObject([{ reason: 'invalid_alert', accounts: [] }]);
    });
  });
});
