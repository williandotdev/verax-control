import 'reflect-metadata';
import { randomInt, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { awsOnboardingSchema, resolvePlan } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AlertSync } from '../src/alerts/alert-sync.js';
import { FindingStore, SyncLease } from '../src/alerts/finding-store.js';
import type { DiscoveryClientFactory } from '../src/aws/discovery/clients.js';
import { isReadOnlyCommand } from '../src/aws/discovery/read-only.js';
import {
  AWS_FINDINGS_BACKOFF,
  AWS_FINDINGS_INTERVAL_MS,
  AWS_FINDINGS_REFUSAL_BACKOFF,
  AwsFindings,
  type AwsFindingsOptions,
  findingsStream,
} from '../src/aws/findings/findings-job.js';
import { parseInspectorFinding } from '../src/aws/findings/inspector.js';
import { AwsConnectionError } from '../src/aws/web-identity.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { AlertNotices } from '../src/notifications/finding-notices.js';
import { BYTES_PER_GIB, UsageNotices } from '../src/notifications/usage-notices.js';
import { fixedTenantPlans } from '../src/plan/tenant-plan.js';
import { UsageMeter, usageDay, usageMonth } from '../src/usage/usage-meter.js';
import { guardDutyAlert } from './alerts/fixtures.js';
import {
  analyzerFinding,
  awsError,
  externalAccessDetail,
  type FakeFindingsAccount,
  fakeFindings,
  guardDutyFinding,
  inspectorFinding,
  portProbeAction,
  securityHubFinding,
} from './aws/findings/fake-findings.js';
import { clockAt, FakeCredentials } from './inventory/fake-job.js';
import { createSignedInUser, createTenant, createUser } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';
import { FakeIndexer, wazuhTime } from './support/fake-indexer.js';

const HOUR = 3_600_000;
const MINUTE = 60_000;
/** O horário da primeira execução dos testes, o da autorização das fontes e o começo da primeira leitura. */
const START = new Date('2026-11-22T10:00:00.000Z');
const AUTHORIZED = new Date('2026-11-22T08:30:00.000Z');
const COLLECT_FROM = new Date('2026-11-22T00:00:00.000Z');
const FLOOR = new Date('2026-11-21T00:00:00.000Z');
const AUDIT = 'cloud_account.aws_source_collection';
const accountId = () => String(randomInt(100_000_000_000, 999_999_999_999));
const bytesOf = (record: unknown) => Buffer.byteLength(JSON.stringify(record), 'utf8');
const analyzerArn = (account: string, name = 'conta', region = 'sa-east-1') =>
  `arn:aws:access-analyzer:${region}:${account}:analyzer/${name}`;

type Kind = 'guardduty' | 'security_hub' | 'inspector' | 'access_analyzer';
interface Cloud {
  id: string;
  tenantId: string;
  accountId: string;
}

describe('tarefa aws-findings: os achados das fontes autorizadas lidas por API', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Uma conta AWS já verificada e conectada, com as tags do papel lidas (template v2, tudo ligado). */
  function connectedAccount(tenantId: string, data: Partial<Prisma.CloudAccountUncheckedCreateInput> = {}) {
    return prisma.cloudAccount.create({
      data: {
        tenantId,
        provider: 'aws',
        accountId: accountId(),
        regions: ['sa-east-1'],
        connection: 'connected',
        ingestFrom: new Date('2026-11-21T00:00:00.000Z'),
        awsTemplateVersion: 2,
        awsCapabilities: ['discovery', 'service-logs', 'findings', 'log-groups'],
        awsCapabilitiesCheckedAt: START,
        ...data,
      },
    });
  }

  /** Uma fonte lida por API, descoberta e autorizada (o que a descoberta e o painel gravam), aguardando o coletor. */
  function source(cloud: Cloud, kind: Kind, data: Partial<Prisma.AwsSourceUncheckedCreateInput> = {}) {
    const resource = {
      guardduty: 'det1',
      security_hub: 'hub',
      inspector: 'account',
      access_analyzer: 'conta',
    };
    const details = {
      guardduty: { detectorId: 'det1' },
      security_hub: {},
      inspector: {},
      access_analyzer: { arn: analyzerArn(cloud.accountId), analyzerType: 'ACCOUNT' },
    };
    return prisma.awsSource.create({
      data: {
        tenantId: cloud.tenantId,
        cloudAccountId: cloud.id,
        kind,
        region: 'sa-east-1',
        resourceId: resource[kind],
        name: kind,
        details: details[kind],
        method: 'api',
        availability: 'available',
        loggingState: 'enabled',
        permission: 'granted',
        permissionCheckedAt: AUTHORIZED,
        origin: 'discovered',
        authorizedAt: AUTHORIZED,
        authorizedBy: 'usuario-de-teste',
        collectFrom: COLLECT_FROM,
        state: 'authorized',
        stateCode: 'awaiting_collector',
        ...data,
      },
    });
  }

  /** A tarefa com o provedor de sessões e as contas falsas. O conteúdo de cada conta pode mudar entre as execuções. */
  function setup(tenantIds: string[], accounts: FakeFindingsAccount[], options: AwsFindingsOptions = {}) {
    const clock = clockAt(START);
    const credentials = new FakeCredentials();
    const fakes = new Map(accounts.map((account) => [account.accountId, fakeFindings(account)]));
    const sleeps: number[] = [];
    const factory: DiscoveryClientFactory = (provider, home) => {
      const fake = fakes.get(credentials.owners.get(provider) ?? '');
      if (fake === undefined) throw new Error('conta sem resposta programada');
      return fake.factory(provider, home);
    };
    const name = `achados-${randomInt(1e6, 9e6)}`;
    const task = new AwsFindings(prisma, credentials, factory, {
      name,
      now: clock.now,
      random: () => 0.5,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      tenantIds,
      ...options,
    });
    const fakeOf = (account: string) => {
      const fake = fakes.get(account);
      if (fake === undefined) throw new Error('conta sem resposta programada');
      return fake;
    };
    return { task, name, clock, credentials, sleeps, fakeOf };
  }

  const sourceRow = (id: string) => prisma.awsSource.findUniqueOrThrow({ where: { id } });
  const findingsOf = (tenantId: string) =>
    prisma.finding.findMany({
      where: { tenantId },
      orderBy: [{ occurredAt: 'asc' }, { sourceEventId: 'asc' }],
    });
  const auditOf = (cloudAccountId: string) =>
    prisma.auditLog.findMany({
      where: { action: AUDIT, resourceId: cloudAccountId },
      orderBy: { occurredAt: 'asc' },
    });
  const cursorOf = (cloudAccountId: string, kind: Kind, region = 'sa-east-1', resourceId = 'conta') =>
    prisma.collectorCursor.findUniqueOrThrow({
      where: {
        cloudAccountId_stream_region: { cloudAccountId, stream: findingsStream(kind, resourceId), region },
      },
    });
  const usageOf = async (tenantId: string, at = START) => {
    const month = await prisma.ingestUsage.findUnique({
      where: { tenantId_month_source: { tenantId, month: usageMonth(at), source: 'aws' } },
    });
    const day = await prisma.ingestUsageDay.findUnique({
      where: { tenantId_day_source: { tenantId, day: usageDay(at), source: 'aws' } },
    });
    return {
      month: month === null ? null : { bytes: Number(month.bytes), events: Number(month.events) },
      day: day === null ? null : { bytes: Number(day.bytes), events: Number(day.events) },
    };
  };
  const unownedOf = (account: string) =>
    prisma.unownedAlert.findMany({ where: { source: 'aws', accounts: { has: account } } });
  /** O cursor de uma fonte que já vinha sendo lida: até onde ela leu e quando volta a ser lida. */
  const cursorAt = (cloud: Cloud, kind: Kind, position: Date | null, nextRunAt: Date, resourceId = 'det1') =>
    prisma.collectorCursor.create({
      data: {
        cloudAccountId: cloud.id,
        stream: findingsStream(kind, resourceId),
        region: 'sa-east-1',
        cursorAt: position,
        nextRunAt,
        lastSuccessAt: position,
      },
    });

  // --- GuardDuty ---

  describe('GuardDuty', () => {
    it('a primeira leitura começa 24 h antes do dia da autorização, pagina, grava os achados e a saúde da fonte', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (achados, GuardDuty)');
      const cloud = await connectedAccount(tenant);
      const row = await source(cloud, 'guardduty');
      const account = cloud.accountId;
      const active = [
        guardDutyFinding({ account, severity: 2, updatedAt: '2026-11-21T03:00:00.000Z' }),
        guardDutyFinding({ account, severity: 5, updatedAt: '2026-11-22T08:00:00.000Z' }),
        guardDutyFinding({ account, severity: 8, updatedAt: '2026-11-22T09:00:00.000Z' }),
        guardDutyFinding({ account, severity: 9, updatedAt: '2026-11-22T09:30:00.000Z' }),
        guardDutyFinding({ account, severity: 8, updatedAt: '2026-11-22T09:55:00.000Z' }),
      ];
      const fakeAccount: FakeFindingsAccount = {
        accountId: account,
        pageSize: 2,
        guardduty: {
          'sa-east-1': {
            detectorId: 'det1',
            findings: [
              // Atualizado antes do começo da primeira leitura: histórico, nunca buscado.
              guardDutyFinding({ account, updatedAt: '2026-11-20T23:59:00.000Z' }),
              ...active,
              // Arquivado na origem: fora da listagem.
              guardDutyFinding({ account, updatedAt: '2026-11-22T09:40:00.000Z', archived: true }),
            ],
          },
        },
      };
      const { task, fakeOf, credentials } = setup([tenant], [fakeAccount]);
      const fake = fakeOf(account);

      const report = await task.runOnce();
      expect(report).toMatchObject({
        status: 'done',
        accounts: 1,
        waiting: 0,
        sources: 1,
        notDue: 0,
        synced: 1,
        capped: 0,
        failed: 0,
        pages: 3,
        read: 5,
        created: 5,
        updated: 0,
        duplicates: 0,
        unowned: 0,
        invalid: 0,
        transitions: 1,
      });
      const volume = active.reduce((sum, finding) => sum + bytesOf(finding), 0);
      expect(report.bytes).toBe(volume);
      // O relatório vai para o log: só contagens e códigos, nada do achado.
      const logged = JSON.stringify(report);
      for (const finding of active) expect(logged).not.toContain(finding['Id'] as string);
      expect(logged).not.toMatch(/Credenciais|papel-da-aplicacao|198\.51\.100/);

      // A mesma entrada no papel da conferência e da descoberta, e só chamadas de leitura.
      expect(credentials.sessions).toEqual([{ accountId: account, region: 'sa-east-1' }]);
      for (const call of fake.calls) {
        expect(isReadOnlyCommand({ constructor: { name: call.command } }), call.command).toBe(true);
      }
      expect(fake.count('guardduty', 'ListFindingsCommand')).toBe(3);
      expect(fake.count('guardduty', 'GetFindingsCommand')).toBe(3);
      expect(fake.inputs('guardduty', 'ListFindingsCommand')[0]).toMatchObject({
        DetectorId: 'det1',
        MaxResults: 50,
        FindingCriteria: {
          Criterion: {
            updatedAt: { GreaterThanOrEqual: FLOOR.getTime() },
            'service.archived': { Equals: ['false'] },
          },
        },
      });
      expect(fake.inputs('guardduty', 'ListFindingsCommand')[0]).not.toHaveProperty('NextToken');

      const stored = await findingsOf(tenant);
      expect(stored.map((finding) => finding.severity)).toEqual([
        'low',
        'medium',
        'high',
        'critical',
        'high',
      ]);
      expect(stored.map((finding) => finding.sourceEventId)).toEqual(
        active.map(
          (finding, index) =>
            `wazuh/${account}/guardduty:${String(finding['Id'])}:${['80301', '80302', '80303', '80303', '80303'][index]}`,
        ),
      );
      for (const finding of stored) {
        expect(finding).toMatchObject({
          tenantId: tenant,
          accountId: account,
          source: 'wazuh',
          logSource: 'guardduty',
          status: 'new',
          rawEventId: null,
          region: 'sa-east-1',
          resource: 'ec2:i-0abc1234def567890',
        });
        expect(finding.lastSeenAt).toEqual(finding.occurredAt);
      }
      // O alto e o crítico avisam por e-mail, como em todo coletor.
      expect(
        (await prisma.notification.findMany({ where: { tenantId: tenant } }))
          .map((notice) => notice.kind)
          .sort(),
      ).toEqual(['critical_finding', 'high_finding', 'high_finding']);

      const newest = new Date('2026-11-22T09:55:00.000Z');
      expect(await sourceRow(row.id)).toMatchObject({
        state: 'collecting',
        stateCode: null,
        stateSince: START,
        lastSyncAt: START,
        lastEventAt: newest,
        lastIngestedAt: START,
        lagSeconds: 0,
        eventsLast24h: 5,
        bytesLast24h: BigInt(volume),
        permission: 'granted',
      });
      expect((await prisma.cloudAccount.findUniqueOrThrow({ where: { id: cloud.id } })).lastEventAt).toEqual(
        newest,
      );
      expect(await cursorOf(cloud.id, 'guardduty')).toMatchObject({
        cursorAt: START,
        nextRunAt: new Date(START.getTime() + AWS_FINDINGS_INTERVAL_MS),
        lastSuccessAt: START,
        lastErrorKind: null,
        failures: 0,
      });
      // O volume: os bytes do JSON de cada achado, no mês e no dia da leitura.
      expect(await usageOf(tenant)).toEqual({
        month: { bytes: volume, events: 5 },
        day: { bytes: volume, events: 5 },
      });
      // A trilha: só a mudança de estado, pelo sistema, no cliente da conta.
      const audit = await auditOf(cloud.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        tenantId: tenant,
        actorType: 'system',
        outcome: 'success',
        resourceType: 'cloud_account',
        before: { sourceId: row.id, kind: 'guardduty', region: 'sa-east-1', state: 'authorized' },
        after: {
          sourceId: row.id,
          kind: 'guardduty',
          region: 'sa-east-1',
          state: 'collecting',
          stateCode: null,
        },
      });
    });

    it('as leituras seguintes relêem só os últimos 10 min, não duplicam, e o achado atualizado só avança a versão', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (achados, incremental)');
      const cloud = await connectedAccount(tenant);
      const row = await source(cloud, 'guardduty');
      const account = cloud.accountId;
      const early = guardDutyFinding({ account, severity: 5, updatedAt: '2026-11-22T09:00:00.000Z' });
      const recent = guardDutyFinding({ account, severity: 8, updatedAt: '2026-11-22T09:53:00.000Z' });
      const findings = [early, recent];
      const { task, fakeOf, clock } = setup(
        [tenant],
        [{ accountId: account, guardduty: { 'sa-east-1': { detectorId: 'det1', findings } } }],
      );
      const fake = fakeOf(account);
      expect(await task.runOnce()).toMatchObject({ created: 2, pages: 1, transitions: 1 });
      const first = await usageOf(tenant);

      // Antes da hora: nenhuma chamada.
      clock.advance(2 * MINUTE);
      expect(await task.runOnce()).toMatchObject({ sources: 1, notDue: 1, synced: 0, read: 0 });
      expect(fake.count('guardduty', 'ListFindingsCommand')).toBe(1);

      // 5 min depois: a janela começa 10 min antes da posição, e o achado relido não duplica nem é medido de novo.
      clock.advance(3 * MINUTE);
      expect(await task.runOnce()).toMatchObject({
        synced: 1,
        read: 1,
        created: 0,
        updated: 0,
        duplicates: 1,
        bytes: 0,
        transitions: 0,
      });
      expect(fake.inputs('guardduty', 'ListFindingsCommand')[1]).toMatchObject({
        FindingCriteria: { Criterion: { updatedAt: { GreaterThanOrEqual: START.getTime() - 10 * MINUTE } } },
      });
      expect(await usageOf(tenant)).toEqual(first);
      expect(await findingsOf(tenant)).toHaveLength(2);
      expect((await sourceRow(row.id)).lastSyncAt).toEqual(clock.now());

      // O achado ganha atividade nova na origem (mesmo ID, `UpdatedAt` mais novo): a versão avança, sem outro achado.
      const updatedAt = new Date(START.getTime() + 7 * MINUTE).toISOString();
      early['UpdatedAt'] = updatedAt;
      clock.advance(5 * MINUTE);
      const before = (await findingsOf(tenant)).find((finding) =>
        finding.sourceEventId.includes(String(early['Id'])),
      );
      expect(await task.runOnce()).toMatchObject({ read: 1, created: 0, updated: 1, duplicates: 0 });
      const after = await prisma.finding.findUniqueOrThrow({ where: { id: before?.id ?? '' } });
      expect(after.lastSeenAt).toEqual(new Date(updatedAt));
      expect(after.occurredAt).toEqual(before?.occurredAt);
      expect(await findingsOf(tenant)).toHaveLength(2);
      // A versão nova conta no volume, uma vez; o evento mais recente da fonte acompanha.
      expect((await usageOf(tenant)).month).toEqual({
        bytes: (first.month?.bytes ?? 0) + bytesOf(early),
        events: 3,
      });
      expect(await sourceRow(row.id)).toMatchObject({ lastEventAt: new Date(updatedAt), eventsLast24h: 3 });
      // Nenhuma mudança de estado desde a primeira leitura: nada novo na trilha.
      expect(await auditOf(cloud.id)).toHaveLength(1);
    });

    it('o achado já triado que ganha atividade nova vira uma recorrência, como no caminho do bucket', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (achados, recorrência)');
      const cloud = await connectedAccount(tenant);
      await source(cloud, 'guardduty');
      const account = cloud.accountId;
      const finding = guardDutyFinding({ account, severity: 8, updatedAt: '2026-11-22T09:55:00.000Z' });
      const { task, clock } = setup(
        [tenant],
        [{ accountId: account, guardduty: { 'sa-east-1': { detectorId: 'det1', findings: [finding] } } }],
      );
      await task.runOnce();
      const [original] = await findingsOf(tenant);
      await prisma.finding.update({
        where: { id: original?.id ?? '' },
        data: { status: 'resolved', triagedAt: START },
      });

      const updatedAt = new Date(START.getTime() + 3 * MINUTE).toISOString();
      finding['UpdatedAt'] = updatedAt;
      clock.advance(5 * MINUTE);
      expect(await task.runOnce()).toMatchObject({ read: 1, created: 1, updated: 0 });
      const all = await findingsOf(tenant);
      expect(all).toHaveLength(2);
      const recurrence = all.find((item) => item.id !== original?.id);
      expect(recurrence).toMatchObject({
        sourceEventId: `${original?.sourceEventId}@${updatedAt}`,
        recurrenceOfId: original?.id,
        chainKey: original?.sourceEventId,
        status: 'new',
      });
      // O original não muda, e reler a mesma versão não abre outra recorrência.
      expect(await prisma.finding.findUniqueOrThrow({ where: { id: original?.id ?? '' } })).toMatchObject({
        status: 'resolved',
        lastSeenAt: original?.lastSeenAt,
      });
      clock.advance(5 * MINUTE);
      expect(await task.runOnce()).toMatchObject({ read: 1, created: 0, duplicates: 1 });
      expect(await findingsOf(tenant)).toHaveLength(2);
    });

    it('o mesmo achado pelo bucket (Wazuh) e pela API termina em um achado só, nas duas ordens', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (achados, dois caminhos)');
      const bucket = `guardduty-${randomInt(1e6, 9e6)}`;
      const cloud = await connectedAccount(tenant, { guarddutyBucket: bucket });
      await source(cloud, 'guardduty');
      const account = cloud.accountId;
      const workerFirst = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';
      const bucketFirst = 'f9e8d7c6b5a4039281706f5e4d3c2b1a';
      const updatedAt = '2026-11-22T09:55:00.000Z';
      /** O alerta do Wazuh do mesmo achado: a regra de fábrica da severidade 8 e a descrição que ela monta. */
      const viaBucket = (findingId: string) => ({
        ...guardDutyAlert({
          account,
          bucket,
          findingId,
          severity: 8,
          updatedAt,
          rule: {
            id: '80303',
            level: 10,
            description: 'AWS GuardDuty: AWS_API_CALL - Credenciais usadas de fora da AWS.',
          },
        }),
        id: `${Date.now()}.${randomInt(1e6, 9e6)}`,
        timestamp: wazuhTime(new Date(Date.now() - 5 * MINUTE)),
      });
      const wazuh = (documents: Record<string, unknown>[]) =>
        new AlertSync(prisma, new FakeIndexer(documents), {
          name: `dois-${randomUUID().slice(0, 8)}`,
        }).runOnce();
      const { task, clock } = setup(
        [tenant],
        [
          {
            accountId: account,
            guardduty: {
              'sa-east-1': {
                detectorId: 'det1',
                findings: [guardDutyFinding({ account, id: workerFirst, severity: 8, updatedAt })],
              },
            },
          },
        ],
      );
      // Pela API primeiro, depois pelo bucket: o alerta do Wazuh cai como duplicado.
      expect(await task.runOnce()).toMatchObject({ created: 1 });
      expect(await wazuh([viaBucket(workerFirst)])).toMatchObject({
        read: 1,
        created: 0,
        duplicates: 1,
        unowned: 0,
      });
      const key = (id: string) => `wazuh/${account}/guardduty:${id}:80303`;
      expect(await prisma.finding.count({ where: { tenantId: tenant } })).toBe(1);
      expect(
        await prisma.finding.findUniqueOrThrow({
          where: { source_sourceEventId: { source: 'wazuh', sourceEventId: key(workerFirst) } },
        }),
      ).toMatchObject({ tenantId: tenant, accountId: account, logSource: 'guardduty', severity: 'high' });

      // Pelo bucket primeiro, depois pela API: a leitura da API não cria outro.
      expect(await wazuh([viaBucket(bucketFirst)])).toMatchObject({ read: 1, created: 1 });
      const second = setup(
        [tenant],
        [
          {
            accountId: account,
            guardduty: {
              'sa-east-1': {
                detectorId: 'det1',
                findings: [
                  guardDutyFinding({ account, id: workerFirst, severity: 8, updatedAt }),
                  guardDutyFinding({ account, id: bucketFirst, severity: 8, updatedAt }),
                ],
              },
            },
          },
        ],
        { now: () => new Date(clock.now().getTime() + 5 * MINUTE) },
      );
      expect(await second.task.runOnce()).toMatchObject({
        read: 2,
        created: 0,
        updated: 0,
        duplicates: 2,
        bytes: 0,
      });
      expect(await prisma.finding.count({ where: { tenantId: tenant } })).toBe(2);
      const fromBucket = await prisma.finding.findUniqueOrThrow({
        where: { source_sourceEventId: { source: 'wazuh', sourceEventId: key(bucketFirst) } },
      });
      // O que chegou pelo bucket fica com o evento bruto do indexer.
      expect(fromBucket.rawEventId).not.toBeNull();
      expect(fromBucket.title).toBe('AWS GuardDuty: AWS_API_CALL - Credenciais usadas de fora da AWS.');
    });

    it('a sondagem de porta vira um achado por IP e porta', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (achados, sondagem)');
      const cloud = await connectedAccount(tenant);
      await source(cloud, 'guardduty');
      const account = cloud.accountId;
      const id = randomUUID().replace(/-/g, '');
      const probe = guardDutyFinding({
        account,
        id,
        severity: 5,
        type: 'Recon:EC2/PortProbeUnprotectedPort',
        action: portProbeAction([
          { ip: '198.51.100.20', port: 22 },
          { ip: '198.51.100.21', port: 3389 },
        ]),
      });
      const { task } = setup(
        [tenant],
        [{ accountId: account, guardduty: { 'sa-east-1': { detectorId: 'det1', findings: [probe] } } }],
      );
      expect(await task.runOnce()).toMatchObject({ read: 1, created: 1 });
      const stored = await findingsOf(tenant);
      expect(stored.map((finding) => finding.sourceEventId).sort()).toEqual([
        `wazuh/${account}/guardduty:${id}/198.51.100.20:22:80306`,
        `wazuh/${account}/guardduty:${id}/198.51.100.21:3389:80306`,
      ]);
      expect(new Set(stored.map((finding) => finding.chainKey))).toEqual(
        new Set([`wazuh/${account}/guardduty:${id}:80306`]),
      );
      // O volume é o do registro, uma vez, por mais itens que ele tenha.
      expect((await usageOf(tenant)).month).toEqual({ bytes: bytesOf(probe), events: 1 });
    });

    it('várias regiões: cada uma com o próprio cursor, e a recusa de uma não para a outra', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (achados, regiões)');
      const cloud = await connectedAccount(tenant, { regions: ['sa-east-1', 'us-east-1'] });
      const south = await source(cloud, 'guardduty');
      const north = await source(cloud, 'guardduty', {
        region: 'us-east-1',
        resourceId: 'det2',
        details: { detectorId: 'det2' },
      });
      const account = cloud.accountId;
      const { task, fakeOf } = setup(
        [tenant],
        [
          {
            accountId: account,
            guardduty: {
              'sa-east-1': { detectorId: 'det1', findings: [guardDutyFinding({ account })] },
              'us-east-1': {
                detectorId: 'det2',
                findings: [guardDutyFinding({ account, region: 'us-east-1' })],
              },
            },
            failures: { 'guardduty:sa-east-1:ListFindingsCommand': [awsError('AccessDeniedException', 403)] },
          },
        ],
      );
      expect(await task.runOnce()).toMatchObject({
        sources: 2,
        synced: 1,
        failed: 1,
        created: 1,
        failures: { 'guardduty:ListFindings': 1 },
      });
      expect(fakeOf(account).count('guardduty', 'ListFindingsCommand', 'us-east-1')).toBe(1);
      expect(await sourceRow(north.id)).toMatchObject({ state: 'collecting', stateCode: null });
      expect(await sourceRow(south.id)).toMatchObject({
        state: 'permission_error',
        stateCode: 'guardduty:ListFindings',
        permission: 'missing',
        permissionDetail: 'guardduty:ListFindings',
        lastSyncAt: null,
      });
      expect((await findingsOf(tenant)).map((finding) => finding.region)).toEqual(['us-east-1']);
      expect((await cursorOf(cloud.id, 'guardduty', 'us-east-1')).cursorAt).toEqual(START);
      expect(await cursorOf(cloud.id, 'guardduty', 'sa-east-1')).toMatchObject({
        cursorAt: null,
        failures: 1,
        lastErrorKind: 'guardduty:ListFindings',
        nextRunAt: new Date(START.getTime() + AWS_FINDINGS_REFUSAL_BACKOFF.baseMs),
      });
    });

    it('o detector apagado depois da autorização: a fonte fica source_missing e sai da coleta', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (achados, detector apagado)');
      const cloud = await connectedAccount(tenant);
      const row = await source(cloud, 'guardduty', {
        resourceId: 'antigo',
        details: { detectorId: 'antigo' },
      });
      const account = cloud.accountId;
      const { task, fakeOf, clock } = setup(
        [tenant],
        // A região tem outro detector: o autorizado não existe mais.
        [{ accountId: account, guardduty: { 'sa-east-1': { detectorId: 'det1', findings: [] } } }],
      );
      expect(await task.runOnce()).toMatchObject({ failed: 1, failures: { not_found: 1 }, transitions: 1 });
      expect(await sourceRow(row.id)).toMatchObject({
        state: 'source_missing',
        stateCode: 'not_found',
        missingSince: START,
      });
      expect(fakeOf(account).count('guardduty', 'ListDetectorsCommand')).toBe(1);
      // Fora da coleta até a descoberta vê-la de novo: nenhuma chamada a mais.
      clock.advance(24 * HOUR);
      expect(await task.runOnce()).toMatchObject({ sources: 0, accounts: 0 });
      expect(fakeOf(account).count('guardduty', 'ListFindingsCommand')).toBe(1);
    });
  });

  // --- Security Hub ---

  describe('Security Hub', () => {
    it('lê só os ativos e em aberto, pagina, e a versão nova só atualiza o achado que já existe, mesmo triado', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (achados, Security Hub)');
      const cloud = await connectedAccount(tenant);
      const row = await source(cloud, 'security_hub');
      const account = cloud.accountId;
      const control = securityHubFinding({ account, label: 'MEDIUM', updatedAt: '2026-11-22T09:00:00.000Z' });
      const findings = [
        control,
        securityHubFinding({
          account,
          label: 'CRITICAL',
          controlId: 'IAM.6',
          updatedAt: '2026-11-22T09:10:00.000Z',
        }),
        securityHubFinding({
          account,
          label: 'LOW',
          controlId: 'EC2.2',
          updatedAt: '2026-11-22T09:20:00.000Z',
        }),
        // Fora do que é lido: suprimido, resolvido e arquivado.
        securityHubFinding({ account, workflow: 'SUPPRESSED' }),
        securityHubFinding({ account, workflow: 'RESOLVED' }),
        securityHubFinding({ account, recordState: 'ARCHIVED' }),
      ];
      const { task, fakeOf, clock, sleeps } = setup(
        [tenant],
        [{ accountId: account, pageSize: 2, securityhub: { 'sa-east-1': { findings } } }],
        // O relógio do espaçamento parado: a segunda chamada chega "na mesma hora" da primeira.
        { elapsed: () => 0 },
      );
      const fake = fakeOf(account);
      expect(await task.runOnce()).toMatchObject({ synced: 1, pages: 2, read: 3, created: 3, inactive: 0 });
      expect(fake.inputs('securityhub', 'GetFindingsCommand')[0]).toEqual({
        Filters: {
          UpdatedAt: [{ Start: FLOOR.toISOString(), End: START.toISOString() }],
          RecordState: [{ Comparison: 'EQUALS', Value: 'ACTIVE' }],
          WorkflowStatus: [
            { Comparison: 'EQUALS', Value: 'NEW' },
            { Comparison: 'EQUALS', Value: 'NOTIFIED' },
          ],
        },
        MaxResults: 100,
      });
      expect(fake.inputs('securityhub', 'GetFindingsCommand')[1]).toMatchObject({ NextToken: 'pos-2' });
      // As chamadas ao Security Hub saem espaçadas (3 por segundo é o limite da AWS): a segunda espera 350 ms.
      expect(sleeps).toEqual([350]);

      const stored = await findingsOf(tenant);
      expect(stored.map((finding) => [finding.severity, finding.ruleId, finding.eventName])).toEqual([
        ['medium', '990501', 'S3.8'],
        ['critical', '990501', 'IAM.6'],
        ['low', '990501', 'EC2.2'],
      ]);
      for (const finding of stored) {
        expect(finding).toMatchObject({
          source: 'aws',
          logSource: 'security_hub',
          accountId: account,
          chainKey: null,
        });
        const [prefix, digest] = finding.sourceEventId.split(':sha256-');
        expect(prefix).toBe(`aws/${account}/securityhub`);
        expect(digest).toMatch(/^[0-9a-f]{40}$/);
      }
      expect(await sourceRow(row.id)).toMatchObject({ state: 'collecting', eventsLast24h: 3 });

      // O cliente marca o achado como legítimo; o controle é reavaliado na origem, com outra severidade e outro título.
      const [first] = stored;
      await prisma.finding.update({
        where: { id: first?.id ?? '' },
        data: { status: 'legitimate', triagedAt: START },
      });
      const updatedAt = new Date(START.getTime() + 2 * MINUTE).toISOString();
      control['UpdatedAt'] = updatedAt;
      control['Severity'] = { Label: 'HIGH', Normalized: 70 };
      control['Title'] = 'S3 buckets should block public access (revised)';
      clock.advance(5 * MINUTE);
      expect(await task.runOnce()).toMatchObject({ read: 1, created: 0, updated: 1 });
      expect(await findingsOf(tenant)).toHaveLength(3);
      expect(await prisma.finding.findUniqueOrThrow({ where: { id: first?.id ?? '' } })).toMatchObject({
        status: 'legitimate',
        severity: 'high',
        ruleLevel: 10,
        title: 'Controle de segurança reprovado (S3.8): S3 buckets should block public access (revised)',
        lastSeenAt: new Date(updatedAt),
        occurredAt: first?.occurredAt,
        recurrenceOfId: null,
      });
      // O achado marcado como legítimo não avisa, mesmo com a severidade mais alta.
      expect(
        await prisma.notification.count({ where: { tenantId: tenant, findingId: first?.id ?? '' } }),
      ).toBe(0);
    });

    it('pula os achados do GuardDuty e do Inspector só quando a conta tem a fonte própria coletando na mesma região', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (achados, sem duplicar)');
      const withOwn = await connectedAccount(tenant, { regions: ['sa-east-1', 'us-east-1'] });
      const without = await connectedAccount(tenant);
      const hub = await source(withOwn, 'security_hub');
      await source(withOwn, 'guardduty');
      const inspector = await source(withOwn, 'inspector');
      await source(without, 'security_hub');
      const records = (account: string) => [
        securityHubFinding({ account, product: 'guardduty', title: 'Achado do GuardDuty' }),
        securityHubFinding({ account, product: 'inspector', title: 'Achado do Inspector' }),
        // De outra região (a agregação entre regiões): a conta não tem a fonte própria lá.
        securityHubFinding({
          account,
          product: 'guardduty',
          region: 'us-east-1',
          title: 'Achado de outra região',
        }),
        securityHubFinding({ account, product: 'macie', title: 'Achado do Macie' }),
        securityHubFinding({ account, title: 'Controle reprovado' }),
      ];
      // Os mesmos registros nas duas execuções: é a mesma conta, lida de novo.
      const ofWithOwn = records(withOwn.accountId);
      const ofWithout = records(without.accountId);
      const fakes = (): FakeFindingsAccount[] => [
        {
          accountId: withOwn.accountId,
          securityhub: { 'sa-east-1': { findings: ofWithOwn } },
          guardduty: { 'sa-east-1': { detectorId: 'det1', findings: [] } },
          inspector: { 'sa-east-1': { findings: [] } },
        },
        { accountId: without.accountId, securityhub: { 'sa-east-1': { findings: ofWithout } } },
      ];
      const first = setup([tenant], fakes());
      expect(await first.task.runOnce()).toMatchObject({
        sources: 4,
        synced: 4,
        read: 10,
        skipped: 2,
        created: 8,
      });
      const titles = async (account: string) =>
        (await prisma.finding.findMany({ where: { tenantId: tenant, accountId: account } }))
          .map((finding) => finding.title.replace(/^.*: /, ''))
          .sort();
      // Com as fontes próprias: os dois da mesma região ficam para o coletor de cada serviço.
      expect(await titles(withOwn.accountId)).toEqual([
        'Achado de outra região',
        'Achado do Macie',
        'Controle reprovado',
      ]);
      // Sem elas: tudo entra pelo Security Hub.
      expect(await titles(without.accountId)).toEqual([
        'Achado de outra região',
        'Achado do GuardDuty',
        'Achado do Inspector',
        'Achado do Macie',
        'Controle reprovado',
      ]);
      // Os pulados não contam no volume.
      const counted = [...ofWithOwn.slice(2), ...ofWithout];
      expect(await usageOf(tenant)).toMatchObject({
        month: { events: counted.length, bytes: counted.reduce((sum, record) => sum + bytesOf(record), 0) },
      });

      // A fonte do Inspector revogada deixa de cobrir: o achado dele volta a entrar pelo Security Hub.
      await prisma.awsSource.update({
        where: { id: inspector.id },
        data: { revokedAt: START, state: 'revoked', stateCode: null },
      });
      await prisma.collectorCursor.updateMany({
        where: { cloudAccountId: withOwn.id },
        data: { cursorAt: null, nextRunAt: START },
      });
      const second = setup([tenant], fakes());
      expect(await second.task.runOnce()).toMatchObject({ skipped: 1, created: 1 });
      expect(await titles(withOwn.accountId)).toEqual([
        'Achado de outra região',
        'Achado do Inspector',
        'Achado do Macie',
        'Controle reprovado',
      ]);
      expect((await sourceRow(hub.id)).state).toBe('collecting');
    });

    describe('o achado do GuardDuty que chega pelo Security Hub só é pulado com a fonte própria de fato coletando', () => {
      const minutesAgo = (minutes: number) => new Date(START.getTime() - minutes * MINUTE);
      /** Um achado do GuardDuty como o Security Hub o entrega, atualizado `minutes` minutos antes da primeira execução. */
      const viaHub = (account: string, minutes: number, title = 'Achado do GuardDuty') =>
        securityHubFinding({
          account,
          product: 'guardduty',
          title,
          updatedAt: minutesAgo(minutes).toISOString(),
        });
      /** Os títulos (sem o prefixo da regra) dos achados que entraram pelo Security Hub. */
      const hubTitles = async (tenantId: string, account?: string) =>
        (
          await prisma.finding.findMany({
            where: {
              tenantId,
              logSource: 'security_hub',
              ...(account !== undefined && { accountId: account }),
            },
          })
        )
          .map((finding) => finding.title.replace(/^.*: /, ''))
          .sort();
      const sourcesOf = async (tenantId: string, account: string) =>
        (await prisma.finding.findMany({ where: { tenantId, accountId: account } }))
          .map((finding) => finding.logSource)
          .sort();

      it('a fonte própria sumida (o detector apagado e trocado por outro) não cobre nada: o achado entra pelo Security Hub', async () => {
        const tenant = await createTenant(app, 'Cliente Demo A (achados, detector trocado)');
        const cloud = await connectedAccount(tenant);
        const account = cloud.accountId;
        const hub = await source(cloud, 'security_hub');
        // O detector autorizado foi apagado: a fonte ficou `source_missing`, com o cursor de quando era lida...
        await source(cloud, 'guardduty', {
          resourceId: 'antigo',
          details: { detectorId: 'antigo' },
          state: 'source_missing',
          stateCode: 'not_found',
          missingSince: minutesAgo(60),
          lastSyncAt: minutesAgo(120),
        });
        await cursorAt(cloud, 'guardduty', minutesAgo(120), START);
        // ...e o detector que o substituiu ainda não foi autorizado: o coletor próprio não lê nenhum dos dois.
        await source(cloud, 'guardduty', {
          resourceId: 'novo',
          details: { detectorId: 'novo' },
          authorizedAt: null,
          authorizedBy: null,
          collectFrom: null,
          state: 'available',
          stateCode: null,
        });
        const { task, fakeOf } = setup(
          [tenant],
          [
            {
              accountId: account,
              guardduty: { 'sa-east-1': { detectorId: 'novo', findings: [guardDutyFinding({ account })] } },
              securityhub: {
                'sa-east-1': {
                  findings: [viaHub(account, 5), viaHub(account, 45, 'Achado mais antigo do GuardDuty')],
                },
              },
            },
          ],
        );
        expect(await task.runOnce()).toMatchObject({
          sources: 1,
          synced: 1,
          read: 2,
          skipped: 0,
          created: 2,
        });
        // O coletor próprio não leu o GuardDuty: sem o Security Hub, os achados do detector novo ficariam de fora.
        expect(fakeOf(account).count('guardduty', 'ListFindingsCommand')).toBe(0);
        expect(await hubTitles(tenant)).toEqual(['Achado do GuardDuty', 'Achado mais antigo do GuardDuty']);
        // O cursor do Security Hub andou, e nada do que ficou para trás deixou de ser gravado.
        expect((await cursorOf(cloud.id, 'security_hub')).cursorAt).toEqual(START);
        expect((await sourceRow(hub.id)).state).toBe('collecting');
      });

      it('a fonte própria com erro de permissão, com erro de ingestão ou revogada não cobre nada', async () => {
        const tenant = await createTenant(app, 'Cliente Demo A (achados, fonte própria com erro)');
        const states: Partial<Prisma.AwsSourceUncheckedCreateInput>[] = [
          {
            state: 'permission_error',
            stateCode: 'guardduty:ListFindings',
            permission: 'missing',
            permissionDetail: 'guardduty:ListFindings',
          },
          { state: 'ingestion_error', stateCode: 'throttled' },
          { state: 'revoked', stateCode: null, revokedAt: minutesAgo(60) },
        ];
        const clouds: Cloud[] = [];
        const accounts: FakeFindingsAccount[] = [];
        for (const data of states) {
          const cloud = await connectedAccount(tenant);
          await source(cloud, 'security_hub');
          await source(cloud, 'guardduty', { lastSyncAt: minutesAgo(120), ...data });
          // Já foi lida, até duas horas atrás, e está no recuo: não é lida nesta execução.
          await cursorAt(cloud, 'guardduty', minutesAgo(120), new Date(START.getTime() + HOUR));
          clouds.push(cloud);
          accounts.push({
            accountId: cloud.accountId,
            guardduty: { 'sa-east-1': { detectorId: 'det1', findings: [] } },
            securityhub: { 'sa-east-1': { findings: [viaHub(cloud.accountId, 5)] } },
          });
        }
        const { task, fakeOf } = setup([tenant], accounts);
        expect(await task.runOnce()).toMatchObject({
          sources: 5,
          notDue: 2,
          synced: 3,
          read: 3,
          skipped: 0,
          created: 3,
        });
        for (const cloud of clouds) {
          expect(fakeOf(cloud.accountId).count('guardduty', 'ListFindingsCommand')).toBe(0);
          expect(await hubTitles(tenant, cloud.accountId)).toEqual(['Achado do GuardDuty']);
        }
      });

      it('a fonte própria coletando cobre o que já leu e o que é recente; o que ela não alcança entra pelo Security Hub', async () => {
        const tenant = await createTenant(app, 'Cliente Demo A (achados, fonte própria coletando)');
        const cloud = await connectedAccount(tenant);
        const account = cloud.accountId;
        // O Security Hub foi autorizado dois dias antes do GuardDuty: a janela dele vai mais longe do que a da fonte própria.
        await source(cloud, 'security_hub', {
          authorizedAt: new Date('2026-11-20T08:30:00.000Z'),
          collectFrom: new Date('2026-11-20T00:00:00.000Z'),
        });
        await source(cloud, 'guardduty', { state: 'collecting', stateCode: null, lastSyncAt: minutesAgo(5) });
        // Lida sem erro há 5 min, e só volta a ser lida daqui a 5: nesta execução vale o que o cursor dela diz.
        await cursorAt(cloud, 'guardduty', minutesAgo(5), new Date(START.getTime() + 5 * MINUTE));
        const { task, fakeOf } = setup(
          [tenant],
          [
            {
              accountId: account,
              guardduty: { 'sa-east-1': { detectorId: 'det1', findings: [] } },
              securityhub: {
                'sa-east-1': {
                  findings: [
                    viaHub(account, 30, 'Já lido pela fonte própria'),
                    viaHub(account, 2, 'Recente, ainda por ler'),
                    securityHubFinding({
                      account,
                      product: 'guardduty',
                      title: 'Anterior ao que a fonte própria lê',
                      updatedAt: '2026-11-20T12:00:00.000Z',
                    }),
                    securityHubFinding({ account, title: 'Controle reprovado' }),
                  ],
                },
              },
            },
          ],
        );
        expect(await task.runOnce()).toMatchObject({
          sources: 2,
          notDue: 1,
          synced: 1,
          read: 4,
          skipped: 2,
          created: 2,
        });
        expect(fakeOf(account).count('guardduty', 'ListFindingsCommand')).toBe(0);
        expect(await hubTitles(tenant)).toEqual(['Anterior ao que a fonte própria lê', 'Controle reprovado']);
      });

      it('autorizadas juntas: a fonte própria é lida antes do Security Hub na mesma execução, e só cobre se a leitura dela terminar', async () => {
        const tenant = await createTenant(app, 'Cliente Demo A (achados, autorizadas juntas)');
        // Três contas, as duas fontes autorizadas e ainda sem leitura: a primeira leitura da fonte própria termina, falha
        // ou para no teto de páginas.
        const done = await connectedAccount(tenant);
        const failing = await connectedAccount(tenant);
        const cut = await connectedAccount(tenant);
        for (const cloud of [done, failing, cut]) {
          await source(cloud, 'security_hub');
          await source(cloud, 'guardduty');
        }
        const own = (account: string, minutes: number) =>
          guardDutyFinding({ account, updatedAt: minutesAgo(minutes).toISOString() });
        const limited = () => awsError('ThrottlingException', 429);
        const { task, fakeOf, clock } = setup(
          [tenant],
          [
            {
              accountId: done.accountId,
              guardduty: { 'sa-east-1': { detectorId: 'det1', findings: [own(done.accountId, 30)] } },
              securityhub: { 'sa-east-1': { findings: [viaHub(done.accountId, 30)] } },
            },
            {
              accountId: failing.accountId,
              guardduty: { 'sa-east-1': { detectorId: 'det1', findings: [own(failing.accountId, 30)] } },
              securityhub: { 'sa-east-1': { findings: [viaHub(failing.accountId, 30)] } },
              failures: { 'guardduty:sa-east-1:ListFindingsCommand': [limited(), limited(), limited()] },
            },
            {
              accountId: cut.accountId,
              // Uma por página: com o teto de 2 páginas, a primeira leitura do GuardDuty não termina a janela.
              pageSize: 1,
              guardduty: {
                'sa-east-1': {
                  detectorId: 'det1',
                  findings: [own(cut.accountId, 40), own(cut.accountId, 30), own(cut.accountId, 20)],
                },
              },
              securityhub: {
                'sa-east-1': { findings: [viaHub(cut.accountId, 30), viaHub(cut.accountId, 2, 'Recente')] },
              },
            },
          ],
          { maxPages: 2 },
        );

        expect(await task.runOnce()).toMatchObject({
          sources: 6,
          synced: 5,
          capped: 1,
          failed: 1,
          failures: { throttled: 1 },
          skipped: 2,
          created: 5,
        });
        // A leitura da fonte própria terminou antes de o Security Hub ser lido: o achado entra uma vez só, por ela.
        const calls = fakeOf(done.accountId).calls.map((call) => `${call.service}:${call.command}`);
        expect(calls.indexOf('guardduty:ListFindingsCommand')).toBeGreaterThanOrEqual(0);
        expect(calls.indexOf('guardduty:ListFindingsCommand')).toBeLessThan(
          calls.indexOf('securityhub:GetFindingsCommand'),
        );
        expect(await sourcesOf(tenant, done.accountId)).toEqual(['guardduty']);
        // A leitura da fonte própria falhou: ela ainda não coleta, e o achado entra pelo Security Hub.
        expect(await sourcesOf(tenant, failing.accountId)).toEqual(['security_hub']);
        // A leitura da fonte própria parou no teto: o que ela ainda não confirmou entra pelo Security Hub; o recente
        // espera a sobreposição.
        expect(await sourcesOf(tenant, cut.accountId)).toEqual(['guardduty', 'guardduty', 'security_hub']);
        expect(await hubTitles(tenant, cut.accountId)).toEqual(['Achado do GuardDuty']);

        // Na execução seguinte, a fonte que falhou lê o mesmo achado: fica repetido (um por cada caminho), nunca perdido.
        // A que parou no teto termina a janela, e o achado recente que o Security Hub relê já está coberto por ela.
        clock.advance(5 * MINUTE);
        expect(await task.runOnce()).toMatchObject({
          synced: 6,
          capped: 0,
          failed: 0,
          skipped: 1,
          created: 2,
        });
        expect(await sourcesOf(tenant, failing.accountId)).toEqual(['guardduty', 'security_hub']);
        expect(await sourcesOf(tenant, cut.accountId)).toEqual([
          'guardduty',
          'guardduty',
          'guardduty',
          'security_hub',
        ]);
        expect(await sourcesOf(tenant, done.accountId)).toEqual(['guardduty']);
      });

      it('a fonte própria que parou de ser lida deixa de cobrir: o recente espera a sobreposição e depois entra, sem buraco', async () => {
        const tenant = await createTenant(app, 'Cliente Demo A (achados, fonte própria parada)');
        const cloud = await connectedAccount(tenant);
        const account = cloud.accountId;
        await source(cloud, 'security_hub');
        const direct = await source(cloud, 'guardduty', {
          state: 'collecting',
          stateCode: null,
          lastSyncAt: minutesAgo(120),
        });
        // No estado "coletando", mas sem leitura há 2 h e só de volta daqui a 6 h (uma falha passageira em recuo): a
        // posição dela ficou para trás.
        await cursorAt(cloud, 'guardduty', minutesAgo(120), new Date(START.getTime() + 6 * HOUR));
        const { task, fakeOf, clock } = setup(
          [tenant],
          [
            {
              accountId: account,
              guardduty: { 'sa-east-1': { detectorId: 'det1', findings: [] } },
              securityhub: {
                'sa-east-1': {
                  findings: [
                    viaHub(account, 60, 'Depois de onde a fonte própria parou'),
                    viaHub(account, 2, 'Recente'),
                  ],
                },
              },
            },
          ],
        );
        // O que ela não leu e já saiu da sobreposição entra pelo Security Hub; o recente ainda pode ser lido por ela.
        expect(await task.runOnce()).toMatchObject({ notDue: 1, read: 2, skipped: 1, created: 1 });
        expect(await hubTitles(tenant)).toEqual(['Depois de onde a fonte própria parou']);
        // 5 min depois o recente é relido (está na sobreposição) e ainda é recente.
        clock.advance(5 * MINUTE);
        expect(await task.runOnce()).toMatchObject({ read: 1, skipped: 1, created: 0 });
        // Mais 5 min: relido de novo, já fora dos últimos 10 min, e a fonte própria continua sem tê-lo lido: entra.
        clock.advance(5 * MINUTE);
        expect(await task.runOnce()).toMatchObject({ read: 1, skipped: 0, created: 1 });
        expect(await hubTitles(tenant)).toEqual(['Depois de onde a fonte própria parou', 'Recente']);
        expect(fakeOf(account).count('guardduty', 'ListFindingsCommand')).toBe(0);
        expect((await sourceRow(direct.id)).state).toBe('collecting');
      });
    });

    it('a chamada limitada é repetida com recuo; o limite que persiste fica na fonte e só vira erro na terceira vez', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (achados, limite)');
      const cloud = await connectedAccount(tenant);
      const row = await source(cloud, 'security_hub');
      const account = cloud.accountId;
      const throttled = () => awsError('TooManyRequestsException', 429);
      const fakeAccount: FakeFindingsAccount = {
        accountId: account,
        securityhub: { 'sa-east-1': { findings: [securityHubFinding({ account })] } },
        failures: { 'securityhub:sa-east-1:GetFindingsCommand': [throttled(), throttled()] },
      };
      const { task, fakeOf, clock, sleeps } = setup([tenant], [fakeAccount], { securityHubIntervalMs: 0 });
      const fake = fakeOf(account);

      // Duas respostas de limite e a terceira dá certo: a leitura termina, com o recuo dobrando (e o sorteio no meio).
      expect(await task.runOnce()).toMatchObject({ synced: 1, created: 1, throttled: 2, failed: 0 });
      expect(fake.count('securityhub', 'GetFindingsCommand')).toBe(3);
      expect(sleeps).toEqual([750, 1_500]);
      expect((await sourceRow(row.id)).state).toBe('collecting');

      // O limite persiste por três execuções: as duas primeiras só recuam; a terceira marca a fonte.
      const queue = fakeAccount.failures?.['securityhub:sa-east-1:GetFindingsCommand'];
      for (let i = 0; i < 9; i += 1) queue?.push(throttled());
      clock.advance(5 * MINUTE);
      expect(await task.runOnce()).toMatchObject({ synced: 0, failed: 1, failures: { throttled: 1 } });
      expect(await sourceRow(row.id)).toMatchObject({ state: 'collecting', lagSeconds: 300 });
      expect(await cursorOf(cloud.id, 'security_hub')).toMatchObject({
        failures: 1,
        lastErrorKind: 'throttled',
        cursorAt: START,
        nextRunAt: new Date(clock.now().getTime() + AWS_FINDINGS_BACKOFF.baseMs),
      });
      clock.advance(AWS_FINDINGS_BACKOFF.baseMs);
      await task.runOnce();
      expect((await sourceRow(row.id)).state).toBe('collecting');
      clock.advance(2 * AWS_FINDINGS_BACKOFF.baseMs);
      expect(await task.runOnce()).toMatchObject({ failed: 1, transitions: 1 });
      expect(await sourceRow(row.id)).toMatchObject({ state: 'ingestion_error', stateCode: 'throttled' });
      expect((await cursorOf(cloud.id, 'security_hub')).failures).toBe(3);

      // A AWS volta a responder: a fonte volta a coletar, de onde a posição ficou.
      clock.advance(4 * AWS_FINDINGS_BACKOFF.baseMs);
      expect(await task.runOnce()).toMatchObject({ synced: 1, failed: 0, transitions: 1 });
      expect(await sourceRow(row.id)).toMatchObject({ state: 'collecting', stateCode: null, lagSeconds: 0 });
      expect((await cursorOf(cloud.id, 'security_hub')).failures).toBe(0);
      const states = (await auditOf(cloud.id)).map((entry) => (entry.after as { state: string }).state);
      expect(states).toEqual(['collecting', 'ingestion_error', 'collecting']);
    });

    it('o Security Hub desligado depois da autorização: source_missing, e nada mais é chamado', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (achados, hub desligado)');
      const cloud = await connectedAccount(tenant);
      const row = await source(cloud, 'security_hub');
      const guard = await source(cloud, 'guardduty');
      const account = cloud.accountId;
      const { task, fakeOf } = setup(
        [tenant],
        // A região só tem o GuardDuty: o Security Hub responde que a conta não o assina.
        [{ accountId: account, guardduty: { 'sa-east-1': { detectorId: 'det1', findings: [] } } }],
      );
      expect(await task.runOnce()).toMatchObject({ synced: 1, failed: 1, failures: { not_enabled: 1 } });
      expect(await sourceRow(row.id)).toMatchObject({ state: 'source_missing', stateCode: 'not_enabled' });
      // A outra fonte da conta segue: sem achado nenhum, e mesmo assim coletando.
      expect(await sourceRow(guard.id)).toMatchObject({
        state: 'collecting',
        stateCode: 'no_findings_yet',
        lastSyncAt: START,
        lastEventAt: null,
        eventsLast24h: 0,
      });
      expect(fakeOf(account).count('securityhub', 'GetFindingsCommand')).toBe(1);
    });
  });

  // --- Inspector ---

  describe('Inspector', () => {
    it('o CRITICAL vira achado crítico, com aviso; o filtro pede os ativos atualizados na janela', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (achados, Inspector)');
      const cloud = await connectedAccount(tenant);
      await source(cloud, 'inspector');
      const account = cloud.accountId;
      const findings = [
        inspectorFinding({ account, severity: 'CRITICAL', cve: 'CVE-2026-1111' }),
        inspectorFinding({ account, severity: 'HIGH', cve: 'CVE-2026-2222' }),
        inspectorFinding({
          account,
          severity: 'MEDIUM',
          type: 'NETWORK_REACHABILITY',
          title: 'Port 22 reachable',
        }),
        inspectorFinding({ account, status: 'CLOSED' }),
        inspectorFinding({ account, updatedAt: new Date('2026-11-20T10:00:00.000Z') }),
      ];
      const { task, fakeOf } = setup(
        [tenant],
        [{ accountId: account, pageSize: 2, inspector: { 'sa-east-1': { findings } } }],
      );
      expect(await task.runOnce()).toMatchObject({ synced: 1, pages: 2, read: 3, created: 3 });
      const fake = fakeOf(account);
      expect(fake.inputs('inspector2', 'ListFindingsCommand')[0]).toEqual({
        filterCriteria: {
          updatedAt: [{ startInclusive: FLOOR, endInclusive: START }],
          findingStatus: [{ comparison: 'EQUALS', value: 'ACTIVE' }],
        },
        maxResults: 100,
      });
      const stored = await prisma.finding.findMany({
        where: { tenantId: tenant },
        orderBy: { ruleLevel: 'desc' },
      });
      expect(
        stored.map((finding) => [finding.severity, finding.ruleId, finding.ruleLevel, finding.eventName]),
      ).toEqual([
        ['critical', '990511', 12, 'CVE-2026-1111'],
        ['high', '990511', 10, 'CVE-2026-2222'],
        ['medium', '990512', 7, 'TCP/22'],
      ]);
      expect(stored[0]).toMatchObject({
        source: 'aws',
        logSource: 'inspector',
        title: 'Vulnerabilidade em pacote: CVE-2026-1111 - openssl',
        resource: 'ec2:i-0abc1234def567890',
        sourceEventId: `aws/${account}/inspector:${String(findings[0]?.['findingArn'])}`,
      });
      const notices = await prisma.notification.findMany({ where: { tenantId: tenant } });
      expect(notices.map((notice) => notice.kind).sort()).toEqual(['critical_finding', 'high_finding']);
    });

    it('a permissão negada fica na fonte, com a ação e o recuo; de volta à coleta, é lida já', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (achados, permissão)');
      const cloud = await connectedAccount(tenant);
      const row = await source(cloud, 'inspector');
      const account = cloud.accountId;
      const fakeAccount: FakeFindingsAccount = {
        accountId: account,
        inspector: { 'sa-east-1': { findings: [inspectorFinding({ account })] } },
        failures: { 'inspector2:sa-east-1:ListFindingsCommand': [awsError('AccessDeniedException', 403)] },
      };
      const { task, fakeOf, clock } = setup([tenant], [fakeAccount]);
      const fake = fakeOf(account);
      expect(await task.runOnce()).toMatchObject({
        synced: 0,
        failed: 1,
        created: 0,
        transitions: 1,
        failures: { 'inspector2:ListFindings': 1 },
      });
      // O Inspector está ligado (o estado da conta diz): é permissão, e não serviço desligado.
      expect(fake.count('inspector2', 'BatchGetAccountStatusCommand')).toBe(1);
      expect(await sourceRow(row.id)).toMatchObject({
        state: 'permission_error',
        stateCode: 'inspector2:ListFindings',
        permission: 'missing',
        permissionDetail: 'inspector2:ListFindings',
        permissionCheckedAt: START,
      });
      // No recuo (15 min), nada é chamado: cada tentativa é uma linha de acesso negado no CloudTrail do cliente.
      clock.advance(5 * MINUTE);
      expect(await task.runOnce()).toMatchObject({ notDue: 1, failed: 0 });
      expect(fake.count('inspector2', 'ListFindingsCommand')).toBe(1);

      // O cliente atualiza a pilha, e a sondagem da descoberta devolve a fonte à coleta: a leitura é na hora.
      await prisma.awsSource.update({
        where: { id: row.id },
        data: {
          state: 'authorized',
          stateCode: 'awaiting_collector',
          permission: 'granted',
          permissionDetail: null,
        },
      });
      expect(await task.runOnce()).toMatchObject({ synced: 1, created: 1, transitions: 1 });
      expect(await sourceRow(row.id)).toMatchObject({
        state: 'collecting',
        stateCode: null,
        permission: 'granted',
      });
      const states = (await auditOf(cloud.id)).map((entry) => (entry.after as { state: string }).state);
      expect(states).toEqual(['permission_error', 'collecting']);
    });

    it('o Inspector desligado responde acesso negado: a fonte fica source_missing, e não erro de permissão', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (achados, Inspector desligado)');
      const cloud = await connectedAccount(tenant);
      const row = await source(cloud, 'inspector');
      const guard = await source(cloud, 'guardduty');
      const account = cloud.accountId;
      const { task } = setup(
        [tenant],
        [{ accountId: account, guardduty: { 'sa-east-1': { detectorId: 'det1', findings: [] } } }],
      );
      expect(await task.runOnce()).toMatchObject({ failed: 1, failures: { not_enabled: 1 } });
      expect(await sourceRow(row.id)).toMatchObject({
        state: 'source_missing',
        stateCode: 'not_enabled',
        permission: 'granted',
      });
      expect((await sourceRow(guard.id)).state).toBe('collecting');
    });
  });

  // --- Access Analyzer ---

  describe('Access Analyzer', () => {
    it('lista os analisadores, lê os ativos de cada um autorizado, e só pede o detalhe do achado novo ou atualizado', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (achados, Access Analyzer)');
      const cloud = await connectedAccount(tenant);
      const row = await source(cloud, 'access_analyzer');
      const account = cloud.accountId;
      const open = analyzerFinding({ account, resource: 'arn:aws:s3:::bucket-aberto' });
      const shared = analyzerFinding({
        account,
        resource: `arn:aws:iam::${account}:role/terceiro`,
        resourceType: 'AWS::IAM::Role',
      });
      const unused = analyzerFinding({
        account,
        findingType: 'UnusedIAMUserAccessKey',
        resource: `arn:aws:iam::${account}:user/antigo`,
        resourceType: 'AWS::IAM::User',
        // Ativo desde antes da autorização: entra assim mesmo (a condição continua valendo).
        updatedAt: new Date('2026-10-01T10:00:00.000Z'),
      });
      const analyzer = {
        name: 'conta',
        arn: analyzerArn(account),
        findings: [open, shared, unused, analyzerFinding({ account, status: 'ARCHIVED' })],
        details: {
          [open['id'] as string]: externalAccessDetail(true),
          [shared['id'] as string]: externalAccessDetail(false),
        },
      };
      const fakeAccount: FakeFindingsAccount = {
        accountId: account,
        pageSize: 2,
        analyzers: {
          'sa-east-1': [
            analyzer,
            // Outro analisador da região, que o cliente não autorizou: nunca é lido.
            {
              name: 'organizacao',
              arn: analyzerArn(account, 'organizacao'),
              findings: [analyzerFinding({ account })],
            },
          ],
        },
      };
      const { task, fakeOf, clock } = setup([tenant], [fakeAccount]);
      const fake = fakeOf(account);

      expect(await task.runOnce()).toMatchObject({ synced: 1, pages: 2, read: 3, created: 3, duplicates: 0 });
      expect(fake.count('accessanalyzer', 'ListAnalyzersCommand')).toBe(1);
      expect(fake.inputs('accessanalyzer', 'ListFindingsV2Command')).toEqual([
        { analyzerArn: analyzer.arn, filter: { status: { eq: ['ACTIVE'] } }, maxResults: 100 },
        {
          analyzerArn: analyzer.arn,
          filter: { status: { eq: ['ACTIVE'] } },
          maxResults: 100,
          nextToken: 'pos-2',
        },
      ]);
      // O detalhe só do acesso externo.
      expect(fake.inputs('accessanalyzer', 'GetFindingV2Command').map((input) => input['id'])).toEqual([
        open['id'],
        shared['id'],
      ]);
      const stored = await prisma.finding.findMany({
        where: { tenantId: tenant },
        orderBy: { ruleId: 'asc' },
      });
      expect(
        stored.map((finding) => [finding.severity, finding.ruleId, finding.title, finding.resource]),
      ).toEqual([
        ['high', '990521', 'Recurso aberto ao público: bucket S3', 's3:bucket-aberto'],
        [
          'medium',
          '990522',
          'Recurso acessível por outra conta ou identidade: papel IAM',
          'iam-role:terceiro',
        ],
        ['low', '990523', 'Acesso sem uso: chave de acesso de usuário IAM', 'iam-user:antigo'],
      ]);
      expect(stored[0]).toMatchObject({
        source: 'aws',
        logSource: 'access_analyzer',
        sourceEventId: `aws/${account}/access-analyzer:sa-east-1/conta/${String(open['id'])}`,
      });
      // O volume do acesso externo é o do resumo mais o do detalhe.
      const detailOf = (finding: Record<string, unknown>, isPublic: boolean) => ({
        ...finding,
        ...externalAccessDetail(isPublic),
      });
      const volume =
        bytesOf(open) +
        bytesOf(detailOf(open, true)) +
        bytesOf(shared) +
        bytesOf(detailOf(shared, false)) +
        bytesOf(unused);
      expect((await usageOf(tenant)).month).toEqual({ bytes: volume, events: 3 });
      expect(await sourceRow(row.id)).toMatchObject({ state: 'collecting', eventsLast24h: 3 });

      // A listagem seguinte é inteira de novo, e nada do que já está gravado pede detalhe nem conta no volume.
      clock.advance(5 * MINUTE);
      expect(await task.runOnce()).toMatchObject({
        read: 3,
        created: 0,
        updated: 0,
        duplicates: 3,
        bytes: 0,
      });
      expect(fake.count('accessanalyzer', 'GetFindingV2Command')).toBe(2);
      expect((await usageOf(tenant)).month).toEqual({ bytes: volume, events: 3 });

      // O acesso a outra conta vira público na origem: o mesmo achado sobe de severidade, muda de regra e avisa.
      const updatedAt = new Date(START.getTime() + 8 * MINUTE);
      shared['updatedAt'] = updatedAt;
      analyzer.details[shared['id'] as string] = externalAccessDetail(true);
      clock.advance(5 * MINUTE);
      expect(await task.runOnce()).toMatchObject({ read: 3, created: 0, updated: 1, duplicates: 2 });
      expect(fake.count('accessanalyzer', 'GetFindingV2Command')).toBe(3);
      const revised = await prisma.finding.findUniqueOrThrow({ where: { id: stored[1]?.id ?? '' } });
      expect(revised).toMatchObject({
        severity: 'high',
        ruleId: '990521',
        ruleLevel: 10,
        title: 'Recurso aberto ao público: papel IAM',
        lastSeenAt: updatedAt,
        status: 'new',
      });
      expect(await prisma.finding.count({ where: { tenantId: tenant } })).toBe(3);
      expect(
        (await prisma.notification.findMany({ where: { tenantId: tenant, findingId: revised.id } })).map(
          (notice) => notice.kind,
        ),
      ).toEqual(['high_finding']);
    });

    it('no teto de páginas, a continuação fica no cursor e a execução seguinte segue dela', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (achados, teto de páginas)');
      const cloud = await connectedAccount(tenant);
      const row = await source(cloud, 'access_analyzer');
      const account = cloud.accountId;
      const findings = Array.from({ length: 5 }, (_, index) =>
        analyzerFinding({
          account,
          findingType: 'UnusedIAMRole',
          resource: `arn:aws:iam::${account}:role/papel-${index}`,
        }),
      );
      const { task, fakeOf, clock } = setup(
        [tenant],
        [
          {
            accountId: account,
            pageSize: 2,
            analyzers: { 'sa-east-1': [{ name: 'conta', arn: analyzerArn(account), findings }] },
          },
        ],
        { maxPages: 2 },
      );
      const fake = fakeOf(account);
      expect(await task.runOnce()).toMatchObject({ synced: 1, capped: 1, pages: 2, created: 4 });
      const capped = await cursorOf(cloud.id, 'access_analyzer');
      // A posição não anda, a fonte volta na execução seguinte, e a continuação aponta a página que falta.
      expect(capped).toMatchObject({ cursorAt: null, nextRunAt: START, failures: 0 });
      expect(JSON.parse(capped.continuation ?? '{}')).toMatchObject({ w: { t: 'pos-4' } });
      // Mesmo cortada, a leitura deu certo: a fonte está coletando.
      expect((await sourceRow(row.id)).state).toBe('collecting');

      clock.advance(5 * MINUTE);
      expect(await task.runOnce()).toMatchObject({
        synced: 1,
        capped: 0,
        pages: 1,
        created: 1,
        duplicates: 0,
      });
      expect(
        fake.inputs('accessanalyzer', 'ListFindingsV2Command').map((input) => input['nextToken']),
      ).toEqual([undefined, 'pos-2', 'pos-4']);
      const done = await cursorOf(cloud.id, 'access_analyzer');
      expect(done.cursorAt).toEqual(clock.now());
      expect(JSON.parse(done.continuation ?? '{}')).not.toHaveProperty('w');
      expect(await prisma.finding.count({ where: { tenantId: tenant } })).toBe(5);
    });

    it('a continuação que a AWS não aceita mais faz a listagem recomeçar, sem duplicar', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (achados, continuação vencida)');
      const cloud = await connectedAccount(tenant);
      await source(cloud, 'access_analyzer');
      const account = cloud.accountId;
      const findings = Array.from({ length: 3 }, (_, index) =>
        analyzerFinding({
          account,
          findingType: 'UnusedIAMRole',
          resource: `arn:aws:iam::${account}:role/papel-${index}`,
        }),
      );
      const fakeAccount: FakeFindingsAccount = {
        accountId: account,
        pageSize: 2,
        analyzers: { 'sa-east-1': [{ name: 'conta', arn: analyzerArn(account), findings }] },
      };
      const { task, fakeOf, clock } = setup([tenant], [fakeAccount], { maxPages: 1 });
      expect(await task.runOnce()).toMatchObject({ capped: 1, created: 2 });
      fakeAccount.failures = {
        'accessanalyzer:sa-east-1:ListFindingsV2Command': [awsError('ValidationException')],
      };
      clock.advance(5 * MINUTE);
      const second = setup([tenant], [fakeAccount], { maxPages: 5, now: clock.now });
      expect(await second.task.runOnce()).toMatchObject({
        synced: 1,
        failed: 0,
        read: 3,
        created: 1,
        duplicates: 2,
      });
      expect(
        fakeOf(account)
          .inputs('accessanalyzer', 'ListFindingsV2Command')
          .concat(second.fakeOf(account).inputs('accessanalyzer', 'ListFindingsV2Command'))
          .map((input) => input['nextToken']),
      ).toEqual([undefined, 'pos-2', undefined, 'pos-2']);
      expect(await prisma.finding.count({ where: { tenantId: tenant } })).toBe(3);
    });

    it('o analisador apagado fica source_missing; o outro da mesma região segue', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (achados, analisador apagado)');
      const cloud = await connectedAccount(tenant);
      const account = cloud.accountId;
      const gone = await source(cloud, 'access_analyzer', {
        resourceId: 'apagado',
        details: { arn: analyzerArn(account, 'apagado') },
      });
      const kept = await source(cloud, 'access_analyzer');
      const { task, fakeOf } = setup(
        [tenant],
        [
          {
            accountId: account,
            analyzers: {
              'sa-east-1': [
                {
                  name: 'conta',
                  arn: analyzerArn(account),
                  findings: [analyzerFinding({ account, findingType: 'UnusedIAMRole' })],
                },
              ],
            },
          },
        ],
      );
      expect(await task.runOnce()).toMatchObject({
        sources: 2,
        synced: 1,
        failed: 1,
        created: 1,
        failures: { not_found: 1 },
      });
      expect(await sourceRow(gone.id)).toMatchObject({ state: 'source_missing', stateCode: 'not_found' });
      expect((await sourceRow(kept.id)).state).toBe('collecting');
      // Os analisadores da região são listados uma vez só por execução, e cada um tem o próprio cursor.
      expect(fakeOf(account).count('accessanalyzer', 'ListAnalyzersCommand')).toBe(1);
      expect((await cursorOf(cloud.id, 'access_analyzer', 'sa-east-1', 'conta')).cursorAt).toEqual(START);
      expect((await cursorOf(cloud.id, 'access_analyzer', 'sa-east-1', 'apagado')).failures).toBe(1);
    });
  });

  // --- Falhas da AWS, coletor a coletor ---

  describe('as falhas da AWS em cada coletor', () => {
    it('a permissão negada fica na fonte com a ação do IAM da chamada recusada, e não para as outras fontes', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (achados, ações negadas)');
      const cloud = await connectedAccount(tenant, { regions: ['sa-east-1', 'us-east-1', 'eu-west-1'] });
      const account = cloud.accountId;
      const guard = await source(cloud, 'guardduty');
      const hub = await source(cloud, 'security_hub');
      const analyzer = (region: string) =>
        source(cloud, 'access_analyzer', { region, details: { arn: analyzerArn(account, 'conta', region) } });
      const listing = await analyzer('sa-east-1');
      const reading = await analyzer('us-east-1');
      const detailing = await analyzer('eu-west-1');
      const kept = await source(cloud, 'inspector');
      const denied = () => awsError('AccessDeniedException', 403);
      const analyzers = (region: string) => [
        {
          name: 'conta',
          arn: analyzerArn(account, 'conta', region),
          findings: [analyzerFinding({ account })],
        },
      ];
      const { task, fakeOf } = setup(
        [tenant],
        [
          {
            accountId: account,
            guardduty: { 'sa-east-1': { detectorId: 'det1', findings: [guardDutyFinding({ account })] } },
            securityhub: { 'sa-east-1': { findings: [securityHubFinding({ account })] } },
            inspector: { 'sa-east-1': { findings: [inspectorFinding({ account })] } },
            analyzers: {
              'sa-east-1': analyzers('sa-east-1'),
              'us-east-1': analyzers('us-east-1'),
              'eu-west-1': analyzers('eu-west-1'),
            },
            failures: {
              // A listagem passa e a leitura dos achados é que é negada.
              'guardduty:sa-east-1:GetFindingsCommand': [denied()],
              'securityhub:sa-east-1:GetFindingsCommand': [denied()],
              'accessanalyzer:sa-east-1:ListAnalyzersCommand': [denied()],
              'accessanalyzer:us-east-1:ListFindingsV2Command': [denied()],
              'accessanalyzer:eu-west-1:GetFindingV2Command': [denied()],
            },
          },
        ],
      );
      const report = await task.runOnce();
      expect(report).toMatchObject({
        sources: 6,
        synced: 1,
        failed: 5,
        created: 1,
        failures: {
          'guardduty:GetFindings': 1,
          'securityhub:GetFindings': 1,
          'access-analyzer:ListAnalyzers': 1,
          'access-analyzer:ListFindings': 1,
          'access-analyzer:GetFinding': 1,
        },
      });
      // O código do erro e a ação: nunca a mensagem da AWS (que cita o papel e a conta).
      expect(JSON.stringify(report)).not.toMatch(/not authorized|detalhe-interno|arn:aws:iam/);
      const actions = new Map([
        [guard.id, 'guardduty:GetFindings'],
        [hub.id, 'securityhub:GetFindings'],
        [listing.id, 'access-analyzer:ListAnalyzers'],
        [reading.id, 'access-analyzer:ListFindings'],
        [detailing.id, 'access-analyzer:GetFinding'],
      ]);
      for (const [id, action] of actions) {
        expect(await sourceRow(id), action).toMatchObject({
          state: 'permission_error',
          stateCode: action,
          permission: 'missing',
          permissionDetail: action,
          lastSyncAt: null,
        });
      }
      expect(await sourceRow(kept.id)).toMatchObject({ state: 'collecting', lastSyncAt: START });
      // Só o achado da fonte que foi lida entrou; a página negada no meio não deixou nada pela metade.
      expect((await findingsOf(tenant)).map((finding) => finding.logSource)).toEqual(['inspector']);
      expect(
        (await auditOf(cloud.id)).map((entry) => (entry.after as { state: string }).state).sort(),
      ).toEqual([
        'collecting',
        'permission_error',
        'permission_error',
        'permission_error',
        'permission_error',
        'permission_error',
      ]);
      // Nenhuma chamada repetida para a recusa (só o limite de requisições é tentado de novo).
      expect(fakeOf(account).count('securityhub', 'GetFindingsCommand')).toBe(1);
      expect(fakeOf(account).count('guardduty', 'GetFindingsCommand')).toBe(1);
    });

    it('o limite de requisições é tentado de novo em todo coletor; a falha da AWS que pode passar fica com o código', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (achados, limites)');
      const cloud = await connectedAccount(tenant);
      const account = cloud.accountId;
      const guard = await source(cloud, 'guardduty');
      const inspector = await source(cloud, 'inspector');
      const analyzer = await source(cloud, 'access_analyzer');
      const hub = await source(cloud, 'security_hub');
      const { task, fakeOf, sleeps } = setup(
        [tenant],
        [
          {
            accountId: account,
            guardduty: { 'sa-east-1': { detectorId: 'det1', findings: [guardDutyFinding({ account })] } },
            securityhub: { 'sa-east-1': { findings: [securityHubFinding({ account })] } },
            inspector: { 'sa-east-1': { findings: [inspectorFinding({ account })] } },
            analyzers: {
              'sa-east-1': [
                {
                  name: 'conta',
                  arn: analyzerArn(account),
                  findings: [analyzerFinding({ account, findingType: 'UnusedIAMRole' })],
                },
              ],
            },
            failures: {
              'guardduty:sa-east-1:ListFindingsCommand': [awsError('ThrottlingException', 400)],
              'guardduty:sa-east-1:GetFindingsCommand': [awsError('ThrottlingException', 400)],
              'inspector2:sa-east-1:ListFindingsCommand': [awsError('ThrottlingException', 429)],
              'accessanalyzer:sa-east-1:ListFindingsV2Command': [awsError('ThrottlingException', 429)],
              // Um erro do próprio serviço: não é limite, não é recusa.
              'securityhub:sa-east-1:GetFindingsCommand': [awsError('InternalException', 500)],
            },
          },
        ],
        { securityHubIntervalMs: 0 },
      );
      expect(await task.runOnce()).toMatchObject({
        synced: 3,
        failed: 1,
        created: 3,
        throttled: 4,
        failures: { InternalException: 1 },
      });
      // Uma nova tentativa por chamada limitada, cada uma depois do recuo (1 s, com metade sorteada).
      expect(sleeps).toEqual([750, 750, 750, 750]);
      expect(fakeOf(account).count('guardduty', 'ListFindingsCommand')).toBe(2);
      expect(fakeOf(account).count('guardduty', 'GetFindingsCommand')).toBe(2);
      for (const row of [guard, inspector, analyzer]) {
        expect(await sourceRow(row.id)).toMatchObject({ state: 'collecting', lastSyncAt: START });
      }
      // A primeira falha não muda o estado da fonte: ela é tentada de novo depois do recuo.
      expect(await sourceRow(hub.id)).toMatchObject({ state: 'authorized', stateCode: 'awaiting_collector' });
      expect(await cursorOf(cloud.id, 'security_hub')).toMatchObject({
        failures: 1,
        lastErrorKind: 'InternalException',
        nextRunAt: new Date(START.getTime() + AWS_FINDINGS_BACKOFF.baseMs),
      });
    });
  });

  // --- Dono, isolamento e segurança ---

  describe('dono do achado e isolamento por cliente', () => {
    it('a conta do achado que não é do cliente da fonte manda o achado para a fila sem dono, com o motivo', async () => {
      const tenantA = await createTenant(app, 'Cliente Demo A (achados, dono)');
      const tenantB = await createTenant(app, 'Cliente Demo B (achados, dono)');
      const admin = await connectedAccount(tenantA);
      const member = await connectedAccount(tenantA);
      const other = await connectedAccount(tenantB);
      await source(admin, 'guardduty');
      await source(admin, 'security_hub');
      await source(admin, 'inspector');
      const stranger = accountId();
      const { task } = setup(
        [tenantA],
        [
          {
            accountId: admin.accountId,
            guardduty: {
              'sa-east-1': {
                detectorId: 'det1',
                findings: [
                  // O detector administra contas-membro: a do mesmo cliente é dele; as outras, de ninguém.
                  guardDutyFinding({ account: member.accountId }),
                  guardDutyFinding({ account: other.accountId }),
                  guardDutyFinding({ account: stranger }),
                ],
              },
            },
            securityhub: { 'sa-east-1': { findings: [securityHubFinding({ account: other.accountId })] } },
            inspector: {
              'sa-east-1': {
                findings: [
                  inspectorFinding({ account: stranger }),
                  { ...inspectorFinding({ account: admin.accountId }), awsAccountId: 'fora-do-formato' },
                ],
              },
            },
          },
        ],
      );
      expect(await task.runOnce()).toMatchObject({ read: 6, created: 1, unowned: 5 });
      // Só o achado da conta-membro do mesmo cliente virou achado, na conta dele.
      const stored = await findingsOf(tenantA);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ tenantId: tenantA, accountId: member.accountId });
      expect(stored[0]?.sourceEventId.startsWith(`wazuh/${member.accountId}/guardduty:`)).toBe(true);
      // Nada no outro cliente: nem achado, nem volume, nem aviso.
      expect(await prisma.finding.count({ where: { tenantId: tenantB } })).toBe(0);
      expect(await usageOf(tenantB)).toEqual({ month: null, day: null });
      expect(await prisma.notification.count({ where: { tenantId: tenantB } })).toBe(0);

      const reasons = async (account: string) =>
        (await unownedOf(account)).map((alert) => [alert.reason, alert.ruleId]).sort();
      expect(await reasons(other.accountId)).toEqual([
        ['source_mismatch', '80303'],
        ['source_mismatch', '990501'],
      ]);
      expect(await reasons(stranger)).toEqual([
        ['unknown_account', '80303'],
        ['unknown_account', '990511'],
      ]);
      const invalid = await prisma.unownedAlert.findMany({
        where: {
          source: 'aws',
          reason: 'invalid_alert',
          sourceEventId: { startsWith: `aws/${admin.accountId}/` },
        },
      });
      expect(invalid).toHaveLength(1);
      // A fila guarda a conta da fonte na chave e o mínimo para a triagem, nunca o achado inteiro.
      for (const alert of await unownedOf(other.accountId)) {
        expect(alert.sourceEventId.startsWith(`aws/${admin.accountId}/`)).toBe(true);
        expect(alert.title).not.toBeNull();
      }
      // Só os achados com dono contam no volume do cliente.
      expect((await usageOf(tenantA)).month?.events).toBe(1);
    });

    it('o coletor de um cliente nunca grava no outro, mesmo com os dois na mesma execução', async () => {
      const tenantA = await createTenant(app, 'Cliente Demo A (achados, isolamento)');
      const tenantB = await createTenant(app, 'Cliente Demo B (achados, isolamento)');
      const cloudA = await connectedAccount(tenantA);
      const cloudB = await connectedAccount(tenantB);
      const rowA = await source(cloudA, 'inspector');
      const rowB = await source(cloudB, 'inspector');
      const shared = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';
      const { task } = setup(
        [tenantA, tenantB],
        [
          {
            accountId: cloudA.accountId,
            inspector: {
              'sa-east-1': {
                findings: [
                  inspectorFinding({ account: cloudA.accountId, id: shared }),
                  // Um achado que cita a conta do outro cliente: de ninguém.
                  inspectorFinding({ account: cloudB.accountId }),
                ],
              },
            },
          },
          {
            accountId: cloudB.accountId,
            // O mesmo ID de achado na conta do outro cliente: outra chave, outro achado.
            inspector: {
              'sa-east-1': { findings: [inspectorFinding({ account: cloudB.accountId, id: shared })] },
            },
          },
        ],
      );
      expect(await task.runOnce()).toMatchObject({ accounts: 2, synced: 2, read: 3, created: 2, unowned: 1 });
      const [a] = await findingsOf(tenantA);
      const [b] = await findingsOf(tenantB);
      expect(await prisma.finding.count({ where: { tenantId: { in: [tenantA, tenantB] } } })).toBe(2);
      expect(a).toMatchObject({ tenantId: tenantA, accountId: cloudA.accountId });
      expect(b).toMatchObject({ tenantId: tenantB, accountId: cloudB.accountId });
      expect(a?.sourceEventId).not.toBe(b?.sourceEventId);
      // Cada trilha, cada volume e cada fonte no próprio cliente.
      for (const [tenant, cloud, row] of [
        [tenantA, cloudA, rowA],
        [tenantB, cloudB, rowB],
      ] as const) {
        const audit = await auditOf(cloud.id);
        expect(audit.map((entry) => entry.tenantId)).toEqual([tenant]);
        expect((await usageOf(tenant)).month?.events).toBe(1);
        expect(await sourceRow(row.id)).toMatchObject({
          tenantId: tenant,
          state: 'collecting',
          eventsLast24h: 1,
        });
      }
      // Com a execução restrita ao cliente B, a conta do A nem é lida.
      const onlyB = setup(
        [tenantB],
        [{ accountId: cloudB.accountId, inspector: { 'sa-east-1': { findings: [] } } }],
        {
          now: () => new Date(START.getTime() + 10 * MINUTE),
        },
      );
      expect(await onlyB.task.runOnce()).toMatchObject({ accounts: 1, sources: 1 });
      expect(onlyB.credentials.sessions.map((session) => session.accountId)).toEqual([cloudB.accountId]);
    });

    it('a exceção do cliente marca o achado como esperado já na chegada', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (achados, exceção)');
      const creator = await createUser(app, { role: 'admin_cliente', tenantId: tenant });
      const cloud = await connectedAccount(tenant);
      await source(cloud, 'inspector');
      const account = cloud.accountId;
      const exception = await prisma.alertException.create({
        data: {
          tenantId: tenant,
          ruleId: '990511',
          field: 'resource',
          value: 'ec2:i-0abc1234def567890',
          reason: 'Instância de laboratório',
          createdById: creator.id,
        },
      });
      const { task } = setup(
        [tenant],
        [{ accountId: account, inspector: { 'sa-east-1': { findings: [inspectorFinding({ account })] } } }],
      );
      expect(await task.runOnce()).toMatchObject({ created: 1, excepted: 1 });
      expect((await findingsOf(tenant))[0]).toMatchObject({
        status: 'legitimate',
        exceptionId: exception.id,
      });
      // Esperado por exceção: sem aviso, mesmo crítico.
      expect(await prisma.notification.count({ where: { tenantId: tenant } })).toBe(0);
      expect(
        (await prisma.alertException.findUniqueOrThrow({ where: { id: exception.id } })).matchedCount,
      ).toBe(1);
    });
  });

  // --- Coleta: quem entra, parada no meio, revogação, orçamento ---

  describe('quem entra na coleta e o que acontece no meio', () => {
    it('a fonte revogada sai na execução seguinte; a revogada no meio da leitura não volta a coletar', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (achados, revogação)');
      const cloud = await connectedAccount(tenant);
      const row = await source(cloud, 'inspector');
      const other = await source(cloud, 'guardduty');
      const account = cloud.accountId;
      const fakeAccount: FakeFindingsAccount = {
        accountId: account,
        inspector: { 'sa-east-1': { findings: [inspectorFinding({ account })] } },
        guardduty: { 'sa-east-1': { detectorId: 'det1', findings: [] } },
      };
      const { task, fakeOf, clock } = setup([tenant], [fakeAccount]);
      const fake = fakeOf(account);
      expect(await task.runOnce()).toMatchObject({ sources: 2, synced: 2, created: 1 });

      // O cliente desautoriza a fonte no painel.
      const revokedAt = new Date(START.getTime() + MINUTE);
      await prisma.awsSource.update({
        where: { id: row.id },
        data: { revokedAt, state: 'revoked', stateCode: null, stateSince: revokedAt },
      });
      fakeAccount.inspector?.['sa-east-1']?.findings.push(
        inspectorFinding({ account, cve: 'CVE-2026-9999' }),
      );
      clock.advance(5 * MINUTE);
      expect(await task.runOnce()).toMatchObject({ sources: 1, synced: 1, created: 0 });
      expect(fake.count('inspector2', 'ListFindingsCommand')).toBe(1);
      expect(await sourceRow(row.id)).toMatchObject({ state: 'revoked', revokedAt, lastSyncAt: START });
      expect(await prisma.finding.count({ where: { tenantId: tenant } })).toBe(1);

      // A revogação que chega no meio de uma leitura: a fonte não é marcada como coletando por cima dela.
      const during = new Date(START.getTime() + 11 * MINUTE);
      fakeAccount.handlers = {
        'guardduty:sa-east-1': {
          ListFindingsCommand: async () => {
            await prisma.awsSource.update({
              where: { id: other.id },
              data: { revokedAt: during, state: 'revoked', stateCode: null, stateSince: during },
            });
            return { FindingIds: [] };
          },
        },
      };
      clock.advance(5 * MINUTE);
      const again = setup([tenant], [fakeAccount], { now: clock.now });
      expect(await again.task.runOnce()).toMatchObject({ sources: 1, synced: 1, transitions: 0 });
      // A saúde fica a da última leitura antes da revogação.
      expect(await sourceRow(other.id)).toMatchObject({
        state: 'revoked',
        revokedAt: during,
        lastSyncAt: new Date(START.getTime() + 5 * MINUTE),
      });
    });

    it('uma execução que para no meio de uma página retoma dali: nada duplica, e a posição só anda com a página gravada', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (achados, parada no meio)');
      const cloud = await connectedAccount(tenant);
      const row = await source(cloud, 'security_hub');
      const account = cloud.accountId;
      const findings = Array.from({ length: 6 }, (_, index) =>
        securityHubFinding({
          account,
          label: 'HIGH',
          controlId: `EC2.${index + 1}`,
          updatedAt: new Date(START.getTime() - (10 - index) * MINUTE).toISOString(),
        }),
      );
      const fakeAccount: FakeFindingsAccount = {
        accountId: account,
        pageSize: 2,
        securityhub: { 'sa-east-1': { findings } },
      };
      /** O aviso por e-mail falha no 4º achado: o segundo da segunda página. */
      class FailingAtFourth extends AlertNotices {
        calls = 0;
        override async enqueue(...args: Parameters<AlertNotices['enqueue']>): Promise<number> {
          this.calls += 1;
          if (this.calls === 4) throw new Error('falha de propósito no meio da página');
          return super.enqueue(...args);
        }
      }
      const broken = setup([tenant], [fakeAccount], { notices: new FailingAtFourth() });
      const report = await broken.task.runOnce();
      // O erro é do banco (a gravação), não da AWS: a conta para nesta execução, e a fonte fica como estava.
      expect(report).toMatchObject({ failedAccounts: 1, synced: 0, failed: 0, pages: 1 });
      expect(await prisma.finding.count({ where: { tenantId: tenant } })).toBe(3);
      const cursor = await cursorOf(cloud.id, 'security_hub');
      // A posição não andou; a continuação é a da página em que parou (a primeira, já gravada, ficou para trás).
      expect(cursor).toMatchObject({ cursorAt: null, lastSuccessAt: null, failures: 0 });
      expect(JSON.parse(cursor.continuation ?? '{}')).toMatchObject({
        w: { s: FLOOR.toISOString(), b: START.toISOString(), t: 'pos-2' },
      });
      expect(await sourceRow(row.id)).toMatchObject({ state: 'authorized', lastSyncAt: null });
      // O volume só do que ficou confirmado: a primeira página. O achado gravado na página que não fechou não é medido
      // (na releitura ele já está gravado): a dúvida fica a favor do cliente.
      expect((await usageOf(tenant)).month?.events).toBe(2);
      expect((await prisma.syncState.findUniqueOrThrow({ where: { name: broken.name } })).lastError).toBe(
        'Error',
      );

      // A execução seguinte segue da página em que parou, na mesma janela.
      const resumed = setup([tenant], [fakeAccount], { now: () => new Date(START.getTime() + 5 * MINUTE) });
      expect(await resumed.task.runOnce()).toMatchObject({
        synced: 1,
        pages: 2,
        read: 4,
        created: 3,
        duplicates: 1,
        failedAccounts: 0,
      });
      expect(
        resumed
          .fakeOf(account)
          .inputs('securityhub', 'GetFindingsCommand')
          .map((input) => [
            input['NextToken'],
            (input['Filters'] as { UpdatedAt: { Start: string; End: string }[] }).UpdatedAt[0],
          ]),
      ).toEqual([
        ['pos-2', { Start: FLOOR.toISOString(), End: START.toISOString() }],
        ['pos-4', { Start: FLOOR.toISOString(), End: START.toISOString() }],
      ]);
      const stored = await findingsOf(tenant);
      expect(stored).toHaveLength(6);
      expect(new Set(stored.map((finding) => finding.sourceEventId)).size).toBe(6);
      // Nenhum achado medido duas vezes; a posição vai para o fim da janela lida.
      expect((await usageOf(tenant)).month?.events).toBe(5);
      expect((await cursorOf(cloud.id, 'security_hub')).cursorAt).toEqual(START);
      expect(await sourceRow(row.id)).toMatchObject({ state: 'collecting', eventsLast24h: 5 });
    });

    it('a parada do worker no meio da leitura deixa a continuação da última página gravada', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (achados, worker parado)');
      const cloud = await connectedAccount(tenant);
      await source(cloud, 'inspector');
      const account = cloud.accountId;
      const findings = Array.from({ length: 4 }, (_, index) =>
        inspectorFinding({ account, severity: 'LOW', cve: `CVE-2026-000${index}` }),
      );
      const controller = new AbortController();
      let listed = 0;
      const fakeAccount: FakeFindingsAccount = {
        accountId: account,
        pageSize: 2,
        inspector: { 'sa-east-1': { findings } },
        // O agendador aborta o sinal quando o pedido da segunda página sai.
        onCall: (service, _region, command) => {
          if (service !== 'inspector2' || command !== 'ListFindingsCommand') return;
          listed += 1;
          if (listed === 2) controller.abort(new DOMException('o worker está parando', 'AbortError'));
        },
      };
      const { task, name } = setup([tenant], [fakeAccount]);
      await expect(task.runOnce(controller.signal)).rejects.toThrow();
      expect(await prisma.finding.count({ where: { tenantId: tenant } })).toBe(2);
      const cursor = await cursorOf(cloud.id, 'inspector');
      expect(cursor.cursorAt).toBeNull();
      expect(JSON.parse(cursor.continuation ?? '{}')).toMatchObject({ w: { t: 'pos-2' } });
      // A concessão foi solta: a execução seguinte não espera ela vencer.
      expect((await prisma.syncState.findUniqueOrThrow({ where: { name } })).leaseOwner).toBeNull();
    });

    it('não chama a AWS: a conta que não entra no papel, o papel sem a leitura de achados e o cliente parado', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (achados, fora da coleta)');
      const suspended = await createTenant(app, 'Cliente Demo B (achados, suspenso)');
      const refused = await connectedAccount(tenant, {
        connection: 'error',
        connectionError: 'trust_denied',
      });
      const withoutFindings = await connectedAccount(tenant, {
        awsCapabilities: ['discovery', 'service-logs'],
      });
      const inactive = await connectedAccount(tenant, { status: 'inactive' });
      const ofSuspended = await connectedAccount(suspended);
      await prisma.tenant.update({ where: { id: suspended }, data: { status: 'suspended' } });
      await source(refused, 'guardduty');
      const off = await source(withoutFindings, 'guardduty');
      await source(inactive, 'guardduty');
      await source(ofSuspended, 'guardduty');
      // Fontes que não são deste coletor: a lida pelo Wazuh e a que nunca foi autorizada.
      await source(withoutFindings, 'security_hub', {
        authorizedAt: null,
        authorizedBy: null,
        collectFrom: null,
        state: 'available',
        stateCode: null,
      });
      const { task, credentials, clock } = setup([tenant, suspended], []);
      expect(await task.runOnce()).toMatchObject({
        accounts: 2,
        sources: 2,
        waiting: 1,
        synced: 0,
        failed: 1,
        failures: { capability_off: 1 },
        transitions: 1,
      });
      // Nem a entrada no papel é tentada.
      expect(credentials.sessions).toEqual([]);
      expect(await sourceRow(off.id)).toMatchObject({
        state: 'permission_error',
        stateCode: 'capability_off',
        permission: 'missing',
        permissionDetail: 'capability_off',
      });
      // Na execução seguinte, nada a gravar de novo.
      clock.advance(5 * MINUTE);
      expect(await task.runOnce()).toMatchObject({ failures: { capability_off: 1 }, transitions: 0 });
      expect(await auditOf(withoutFindings.id)).toHaveLength(1);
    });

    it('a entrada no papel recusada não muda as fontes: quem trata é a conferência da conexão', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (achados, sessão recusada)');
      const cloud = await connectedAccount(tenant);
      const other = await connectedAccount(tenant);
      const row = await source(cloud, 'guardduty');
      const kept = await source(other, 'guardduty');
      const { task, credentials } = setup(
        [tenant],
        [
          { accountId: cloud.accountId, guardduty: { 'sa-east-1': { detectorId: 'det1', findings: [] } } },
          { accountId: other.accountId, guardduty: { 'sa-east-1': { detectorId: 'det1', findings: [] } } },
        ],
      );
      credentials.failures.set(cloud.accountId, new AwsConnectionError('trust_denied', true));
      const report = await task.runOnce();
      expect(report).toMatchObject({
        accounts: 2,
        synced: 1,
        failed: 1,
        failures: { trust_denied: 1 },
        failedAccounts: 0,
      });
      expect(await sourceRow(row.id)).toMatchObject({ state: 'authorized', stateCode: 'awaiting_collector' });
      expect((await sourceRow(kept.id)).state).toBe('collecting');
      expect(await auditOf(cloud.id)).toHaveLength(0);
    });

    it('um worker por vez; passado o orçamento de tempo, as fontes que faltam ficam para a execução seguinte', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (achados, concessão e orçamento)');
      const cloud = await connectedAccount(tenant, { regions: ['sa-east-1', 'us-east-1'] });
      const first = await source(cloud, 'guardduty');
      const second = await source(cloud, 'guardduty', {
        region: 'us-east-1',
        resourceId: 'det2',
        details: { detectorId: 'det2' },
      });
      const account = cloud.accountId;
      const fakeAccount: FakeFindingsAccount = {
        accountId: account,
        guardduty: {
          'sa-east-1': { detectorId: 'det1', findings: [] },
          'us-east-1': { detectorId: 'det2', findings: [] },
        },
      };
      // O relógio do orçamento anda 1 min a cada consulta, e o orçamento é de 2,5 min: a primeira fonte entra, a
      // segunda não.
      let elapsed = 0;
      const { task, name, fakeOf, clock } = setup([tenant], [fakeAccount], {
        runBudgetMs: 2.5 * MINUTE,
        elapsed: () => {
          elapsed += MINUTE;
          return elapsed;
        },
      });

      // Outra réplica com a concessão: nada é lido.
      const lease = new SyncLease(prisma, name, 'outra-replica', 5 * MINUTE);
      expect(await lease.acquire(START)).toBe(true);
      expect(await task.runOnce()).toMatchObject({ status: 'locked', sources: 0 });
      expect(fakeOf(account).calls).toHaveLength(0);
      await lease.release();

      expect(await task.runOnce()).toMatchObject({ status: 'done', sources: 2, synced: 1, deferred: 1 });
      const states = [await sourceRow(first.id), await sourceRow(second.id)].map((row) => row.state).sort();
      expect(states).toEqual(['authorized', 'collecting']);
      // A que ficou para trás entra na execução seguinte, sem esperar o intervalo.
      clock.advance(MINUTE);
      expect(await task.runOnce()).toMatchObject({ synced: 1, deferred: 0, notDue: 1 });
      expect((await sourceRow(first.id)).state).toBe('collecting');
      expect((await sourceRow(second.id)).state).toBe('collecting');
    });
  });

  // --- O volume ---

  describe('o volume dos achados no plano do cliente', () => {
    it('soma no volume da AWS do mês, e os avisos de 80% e 100% do plano seguem valendo; nada é barrado', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (achados, volume do plano)');
      const cloud = await connectedAccount(tenant);
      await source(cloud, 'inspector');
      const account = cloud.accountId;
      // Um mês só deste teste: a conferência dos avisos olha todos os clientes do nó.
      const when = new Date('2033-07-10T10:00:00.000Z');
      const month = usageMonth(when);
      const findings = [inspectorFinding({ account, severity: 'LOW' })];
      const volume = bytesOf(findings[0]);
      // O Wazuh do nó já mediu quase 80% de 1 GiB neste mês: faltam menos bytes do que os de um achado.
      const meter = new UsageMeter();
      meter.add(tenant, 'aws', Math.round(0.8 * Number(BYTES_PER_GIB)) - 100, 1_000, when);
      await meter.flush(prisma);
      const notices = new UsageNotices(prisma, fixedTenantPlans(resolvePlan('essencial', { monthlyGib: 1 })));
      const plan = () =>
        prisma.notification.findMany({
          where: { tenantId: tenant, kind: 'plan_usage', usageMonth: month },
          orderBy: { usagePercent: 'asc' },
        });
      await notices.check(when);
      expect(await plan()).toEqual([]);

      const fakeAccount: FakeFindingsAccount = {
        accountId: account,
        inspector: { 'sa-east-1': { findings } },
      };
      const { task } = setup([tenant], [fakeAccount], { now: () => when });
      expect(await task.runOnce()).toMatchObject({ created: 1, bytes: volume });
      const usage = await prisma.ingestUsage.findUniqueOrThrow({
        where: { tenantId_month_source: { tenantId: tenant, month, source: 'aws' } },
      });
      expect(Number(usage.bytes)).toBe(Math.round(0.8 * Number(BYTES_PER_GIB)) - 100 + volume);
      expect(Number(usage.events)).toBe(1_001);
      await notices.check(when);
      expect((await plan()).map((notice) => notice.usagePercent)).toEqual([80]);

      // Acima de 100% do plano, a coleta continua: nenhum achado é descartado nem barrado por volume.
      const over = new UsageMeter();
      over.add(tenant, 'aws', Number(BYTES_PER_GIB), 1, when);
      await over.flush(prisma);
      await notices.check(when);
      expect((await plan()).map((notice) => notice.usagePercent)).toEqual([80, 100]);
      const later = new Date(when.getTime() + 5 * MINUTE);
      findings.push(
        inspectorFinding({
          account,
          severity: 'LOW',
          cve: 'CVE-2026-7777',
          updatedAt: new Date(when.getTime() + 2 * MINUTE),
        }),
      );
      const again = setup([tenant], [fakeAccount], { now: () => later });
      expect(await again.task.runOnce()).toMatchObject({ created: 1, failed: 0 });
      expect(await prisma.finding.count({ where: { tenantId: tenant } })).toBe(2);
    });
  });

  // --- A versão do achado de estado, na gravação ---

  describe('a versão de um achado de estado (Security Hub, Inspector, Access Analyzer) na gravação', () => {
    const draftOf = (raw: Record<string, unknown>, owner: { tenantId: string; accountId: string }) => {
      const parsed = parseInspectorFinding(raw, new Date('2026-11-23T00:00:00.000Z'));
      if (!parsed.ok) throw new Error(parsed.reason);
      const [draft] = parsed.finding.drafts(owner);
      if (draft === undefined) throw new Error('sem rascunho');
      return draft;
    };

    it('a versão igual ou mais antiga não muda nada; a mais nova só atualiza; a severidade que cai não avisa', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (achados, versão)');
      const account = accountId();
      const owner = { tenantId: tenant, accountId: account };
      const store = new FindingStore(prisma);
      const id = randomUUID().replace(/-/g, '');
      const at = (minutes: number) => new Date(START.getTime() + minutes * MINUTE);
      const version = (minutes: number, severity: string, title = 'CVE-2026-0001 - openssl') =>
        draftOf(inspectorFinding({ account, id, severity, updatedAt: at(minutes), title }), owner);

      expect(await store.persist(version(0, 'MEDIUM'), null, START)).toBe('created');
      const key = {
        source_sourceEventId: { source: 'aws', sourceEventId: version(0, 'MEDIUM').sourceEventId },
      };
      const created = await prisma.finding.findUniqueOrThrow({ where: key });
      expect(created).toMatchObject({
        severity: 'medium',
        lastSeenAt: at(0),
        occurredAt: at(0),
        chainKey: null,
      });

      // A mesma versão e uma mais antiga, mesmo com outro conteúdo: nada muda.
      expect(await store.persist(version(0, 'CRITICAL', 'Outro título'), null, START)).toBe('duplicate');
      expect(await store.persist(version(-30, 'CRITICAL', 'Outro título'), null, START)).toBe('duplicate');
      expect(await prisma.finding.findUniqueOrThrow({ where: key })).toMatchObject({
        severity: 'medium',
        title: created.title,
        lastSeenAt: at(0),
        updatedAt: created.updatedAt,
      });
      expect(await prisma.notification.count({ where: { tenantId: tenant } })).toBe(0);

      // A versão mais nova, crítica: o mesmo achado, com a severidade e o título novos, e o aviso sai agora.
      expect(
        await store.persist(version(10, 'CRITICAL', 'CVE-2026-0001 - openssl (exploit)'), null, START),
      ).toBe('duplicate');
      expect(await prisma.finding.findUniqueOrThrow({ where: key })).toMatchObject({
        id: created.id,
        severity: 'critical',
        ruleLevel: 12,
        title: 'Vulnerabilidade em pacote: CVE-2026-0001 - openssl (exploit)',
        lastSeenAt: at(10),
        occurredAt: at(0),
        status: 'new',
      });
      expect(
        (await prisma.notification.findMany({ where: { tenantId: tenant } })).map((notice) => notice.kind),
      ).toEqual(['critical_finding']);

      // A severidade que cai acompanha, sem aviso novo.
      expect(await store.persist(version(20, 'LOW'), null, START)).toBe('duplicate');
      expect(await prisma.finding.findUniqueOrThrow({ where: key })).toMatchObject({
        severity: 'low',
        ruleLevel: 3,
        lastSeenAt: at(20),
      });
      expect(await prisma.notification.count({ where: { tenantId: tenant } })).toBe(1);
      expect(await prisma.finding.count({ where: { tenantId: tenant } })).toBe(1);
    });

    it('a chave que já é de outro cliente não é tocada', async () => {
      const tenantA = await createTenant(app, 'Cliente Demo A (achados, chave de outro)');
      const tenantB = await createTenant(app, 'Cliente Demo B (achados, chave de outro)');
      const account = accountId();
      const store = new FindingStore(prisma);
      const id = randomUUID().replace(/-/g, '');
      const raw = (minutes: number, severity: string) =>
        inspectorFinding({ account, id, severity, updatedAt: new Date(START.getTime() + minutes * MINUTE) });
      // A conta foi do cliente A e hoje está cadastrada no B: a chave (que leva a conta) já existe no A.
      const original = draftOf(raw(0, 'LOW'), { tenantId: tenantA, accountId: account });
      expect(await store.persist(original, null, START)).toBe('created');
      const newer = draftOf(raw(10, 'CRITICAL'), { tenantId: tenantB, accountId: account });
      expect(newer.sourceEventId).toBe(original.sourceEventId);
      expect(await store.persist(newer, null, START)).toBe('duplicate');
      expect(await prisma.finding.count({ where: { tenantId: tenantB } })).toBe(0);
      expect((await findingsOf(tenantA))[0]).toMatchObject({
        tenantId: tenantA,
        severity: 'low',
        lastSeenAt: START,
      });
      expect(await prisma.notification.count({ where: { tenantId: { in: [tenantA, tenantB] } } })).toBe(0);
    });
  });

  // --- O painel ---

  describe('o estado da conexão que o painel lê', () => {
    it('com as fontes de achados lidas sem erro, a conta está coletando e as conferências passam, mesmo sem achado', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (achados, painel)');
      const admin = await createSignedInUser(app, { role: 'admin_cliente', tenantId: tenant });
      const cloud = await connectedAccount(tenant, { awsCapabilitiesCheckedAt: new Date() });
      const finished = new Date(Date.now() - HOUR);
      await prisma.awsDiscoveryRun.create({
        data: {
          tenantId: tenant,
          cloudAccountId: cloud.id,
          trigger: 'connect',
          status: 'succeeded',
          requestedAt: finished,
          startedAt: finished,
          finishedAt: finished,
          regions: ['sa-east-1'],
        },
      });
      const today = new Date(new Date().toISOString().slice(0, 10));
      const authorization = { authorizedAt: new Date(Date.now() - 30 * MINUTE), collectFrom: today };
      const guard = await source(cloud, 'guardduty', authorization);
      const inspector = await source(cloud, 'inspector', authorization);
      const account = cloud.accountId;
      const onboarding = async () =>
        awsOnboardingSchema.parse(
          (
            await request(app.getHttpServer())
              .get(`/v1/cloud-accounts/${cloud.id}/aws/onboarding`)
              .set('Cookie', admin.cookie)
              .expect(200)
          ).body,
        );
      const check = (view: Awaited<ReturnType<typeof onboarding>>, id: string) =>
        view.checks.find((item) => item.id === id);

      // Antes do coletor: autorizadas, aguardando.
      const before = await onboarding();
      expect(before.state).toBe('configuring');
      expect(check(before, 'collector_config')).toMatchObject({
        status: 'pending',
        code: 'awaiting_collector',
      });
      expect(check(before, 'last_sync')).toMatchObject({ status: 'pending', code: 'no_data' });

      // O relógio de verdade: é o painel que calcula o atraso na leitura.
      const credentials = new FakeCredentials();
      const fake = fakeFindings({
        accountId: account,
        guardduty: {
          'sa-east-1': {
            detectorId: 'det1',
            findings: [
              guardDutyFinding({ account, updatedAt: new Date(Date.now() - 10 * MINUTE).toISOString() }),
            ],
          },
        },
        inspector: { 'sa-east-1': { findings: [] } },
      });
      const task = new AwsFindings(prisma, credentials, fake.factory, {
        name: `achados-${randomInt(1e6, 9e6)}`,
        tenantIds: [tenant],
      });
      expect(await task.runOnce()).toMatchObject({ synced: 2, created: 1 });

      const after = await onboarding();
      expect(after.state).toBe('collecting');
      for (const id of ['permission', 'collector_config', 'events', 'last_sync', 'lag']) {
        expect(check(after, id), id).toMatchObject({ status: 'ok' });
      }
      const sources = Object.fromEntries(after.sources.map((item) => [item.id, item]));
      expect(sources[guard.id]).toMatchObject({ state: 'collecting', stateCode: null });
      expect(sources[guard.id]?.health).toMatchObject({ eventsLast24h: 1 });
      expect(sources[guard.id]?.health.lastEventAt).not.toBeNull();
      // Sem achado nenhum, a fonte está saudável: lida sem erro, e nunca "parada".
      expect(sources[inspector.id]).toMatchObject({ state: 'collecting', stateCode: 'no_findings_yet' });
      expect(sources[inspector.id]?.health).toMatchObject({
        lastEventAt: null,
        eventsLast24h: 0,
        bytesLast24h: 0,
      });
      expect(sources[inspector.id]?.health.lastSyncAt).not.toBeNull();
      expect(sources[inspector.id]?.health.lagSeconds).toBeLessThan(120);

      // O coletor para de rodar por 3 h: o atraso é calculado na leitura, e a conferência acusa a leitura atrasada.
      await prisma.awsSource.updateMany({
        where: { cloudAccountId: cloud.id },
        data: { lastSyncAt: new Date(Date.now() - 3 * HOUR) },
      });
      const late = await onboarding();
      expect(check(late, 'lag')).toMatchObject({ status: 'failed', code: 'sync_delayed' });
      expect(late.sources.find((item) => item.id === inspector.id)?.health.lagSeconds).toBeGreaterThanOrEqual(
        3 * 3600,
      );
      // A fonte segue "coletando": fonte de achados não fica parada por falta de achado.
      expect(late.sources.every((item) => item.state === 'collecting')).toBe(true);
    });
  });
});
