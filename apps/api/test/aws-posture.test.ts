import 'reflect-metadata';
import { randomBytes, randomInt } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { STSClient } from '@aws-sdk/client-sts';
import {
  inventorySummarySchema,
  paginatedSchema,
  postureCheckSchema,
  postureOverviewSchema,
} from '@verax/shared';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebIdentityCredentials } from '../src/aws/web-identity.js';
import { buildPinoOptions } from '../src/common/logger/logger.options.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import type { InventoryClientFactory } from '../src/inventory/inventory.js';
import {
  AWS_INVENTORY_BACKOFF,
  AWS_INVENTORY_STREAM,
  AwsInventorySync,
  type AwsInventoryOptions,
} from '../src/inventory/inventory-job.js';
import { RetentionJob } from '../src/retention/retention-job.js';
import { Scheduler } from '../src/worker/scheduler.js';
import { fakeAccount, type FakeAccountOptions } from './inventory/fake-account.js';
import { awsError, fakeClient } from './inventory/fake-aws.js';
import { clockAt, FakeCredentials, factoryFor, factoryOf } from './inventory/fake-job.js';
import { createSignedInUser, createTenant } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = new Date('2026-11-05T10:00:00.000Z');
const accountId = () => String(randomInt(100_000_000_000, 999_999_999_999));
const refuse =
  (name: string, status = 403) =>
  () => {
    throw awsError(name, status);
  };

/** As leituras da postura recusadas numa conta: o bloqueio da conta, o GuardDuty de us-east-1 e o EBS de lá. */
const POSTURE_REFUSED: FakeAccountOptions = {
  s3control: { GetPublicAccessBlockCommand: refuse('AccessDenied') },
  guardduty: { 'us-east-1': { ListDetectorsCommand: refuse('AccessDeniedException') } },
  ec2: {
    'us-east-1': {
      GetEbsEncryptionByDefaultCommand: refuse('UnauthorizedOperation'),
      DescribeSecurityGroupsCommand: refuse('UnauthorizedOperation'),
    },
  },
};

describe('postura nativa da AWS na tarefa aws-inventory (fase 2, PR-15)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  function verifiedAccount(tenantId: string, data: Partial<Prisma.CloudAccountUncheckedCreateInput> = {}) {
    return prisma.cloudAccount.create({
      data: {
        tenantId,
        provider: 'aws',
        accountId: accountId(),
        regions: ['sa-east-1', 'us-east-1'],
        connection: 'connected',
        ingestFrom: new Date('2026-11-01T00:00:00.000Z'),
        ...data,
      },
    });
  }

  function setup(
    tenantIds: string[],
    {
      behavior = {},
      start = START,
      ...options
    }: AwsInventoryOptions & { behavior?: Record<string, FakeAccountOptions>; start?: Date } = {},
  ) {
    const clock = clockAt(start);
    const credentials = new FakeCredentials();
    const { factory, calls } = factoryFor((provider) => credentials.owners.get(provider), behavior);
    const sync = new AwsInventorySync(prisma, credentials, factory, {
      name: `pos-${randomInt(1e6, 9e6)}`,
      now: clock.now,
      random: () => 0.5,
      tenantIds,
      ...options,
    });
    return { sync, clock, calls, behavior };
  }

  const scansOf = (awsAccountId: string) =>
    prisma.postureScan.findMany({
      where: { accountId: awsAccountId },
      orderBy: { scannedAt: 'asc' },
      include: { failures: { orderBy: { findingUid: 'asc' } } },
    });
  const cursorOf = (cloudAccountId: string) =>
    prisma.collectorCursor.findUniqueOrThrow({
      where: {
        cloudAccountId_stream_region: { cloudAccountId, stream: AWS_INVENTORY_STREAM, region: '' },
      },
    });

  async function reader(tenantId: string) {
    const user = await createSignedInUser(app, { role: 'leitura', tenantId });
    return (path: string) => request(app.getHttpServer()).get(path).set('Cookie', user.cookie);
  }

  it('a varredura entra com o retrato, na mesma coleta e com o mesmo início; a API mostra o catálogo e as reprovações', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (postura)');
    const account = await verifiedAccount(tenant);
    const { sync } = setup([tenant]);
    expect(await sync.runOnce()).toMatchObject({
      collected: 1,
      partial: 0,
      postureScans: 1,
      posturePartial: 0,
      failed: 0,
    });

    const [snapshot] = await prisma.inventorySnapshot.findMany({ where: { accountId: account.accountId } });
    const [scan, ...more] = await scansOf(account.accountId);
    expect(more).toEqual([]);
    // A conta fictícia de fake-account.ts: a mesma nota do teste de unidade (47, pela fórmula de sempre).
    expect(scan).toMatchObject({
      tenantId: tenant,
      scannedAt: START,
      score: 47,
      weightPassed: 84,
      weightTotal: 178,
      passed: 15,
      failed: 16,
      unknown: 0,
      failedCritical: 4,
      failedHigh: 10,
      failedMedium: 2,
      failedLow: 0,
      failedInformational: 0,
      errors: [],
    });
    expect(snapshot?.collectedAt).toEqual(scan?.scannedAt);
    expect(scan?.checks).toHaveLength(18);
    expect(scan?.failures).toHaveLength(16);
    for (const failure of scan?.failures ?? []) expect(failure.tenantId).toBe(tenant);

    const get = await reader(tenant);
    const overview = postureOverviewSchema.parse((await get('/v1/posture').expect(200)).body);
    expect(overview.score).toBe(47);
    const [item] = overview.accounts;
    expect(item).toMatchObject({
      accountId: account.accountId,
      score: 47,
      scannedAt: START.toISOString(),
      passed: 15,
      failed: 16,
      unknown: 0,
      errors: [],
    });
    expect(item?.checks).toHaveLength(18);
    expect(item?.checks.find((check) => check.checkId === 'cloudtrail_multi_region_enabled')).toEqual({
      checkId: 'cloudtrail_multi_region_enabled',
      title: 'Trilha do CloudTrail multirregião gravando',
      severity: 'high',
      passed: 1,
      failed: 0,
      unknown: 0,
      status: 'pass',
    });
    expect(
      item?.checks.find((check) => check.checkId === 'iam_user_mfa_enabled_console_access')?.status,
    ).toBe('fail');

    const failures = paginatedSchema(postureCheckSchema).parse(
      (await get('/v1/posture/checks?pageSize=50').expect(200)).body,
    );
    expect(failures.total).toBe(16);
    expect(failures.items.slice(0, 4).map((failure) => failure.severity)).toEqual([
      'critical',
      'critical',
      'critical',
      'critical',
    ]);
    const bucket = failures.items.find(
      (failure) => failure.checkId === 's3_bucket_public_access' && failure.resource === 'site-publico',
    );
    expect(bucket).toMatchObject({
      title: 'Bucket S3 público',
      region: 'sa-east-1',
      resourceType: 'AwsS3Bucket',
      accountId: account.accountId,
    });
    expect(bucket?.remediation).toContain('--bucket site-publico ');
    expect(bucket?.references.every((reference) => reference.startsWith('https://'))).toBe(true);
    expect(JSON.stringify(overview)).not.toMatch(/Prowler/);
  });

  it('idempotente pelo início da coleta: a mesma coleta não duplica a varredura nem as reprovações', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (postura, idempotência)');
    const account = await verifiedAccount(tenant);
    const { sync } = setup([tenant]);
    expect(await sync.runOnce()).toMatchObject({ postureScans: 1 });
    await prisma.collectorCursor.updateMany({
      where: { cloudAccountId: account.id },
      data: { nextRunAt: START },
    });
    expect(await sync.runOnce()).toMatchObject({ collected: 0, duplicates: 1, postureScans: 0 });
    const scans = await scansOf(account.accountId);
    expect(scans).toHaveLength(1);
    expect(scans[0]?.failures).toHaveLength(16);
  });

  it('leituras recusadas: a varredura parcial, as checagens não lidas fora da nota, e a faixa de Ativos só com o inventário', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (postura, parcial)');
    const account = await verifiedAccount(tenant);
    const { sync } = setup([tenant], { behavior: { [account.accountId]: POSTURE_REFUSED } });
    expect(await sync.runOnce()).toMatchObject({
      collected: 1,
      partial: 1,
      postureScans: 1,
      posturePartial: 1,
      failed: 0,
    });
    const [scan] = await scansOf(account.accountId);
    expect(scan?.errors).toEqual([
      'sg:us-east-1:UnauthorizedOperation',
      's3_account:AccessDenied',
      'ebs:us-east-1:UnauthorizedOperation',
      'guardduty:us-east-1:AccessDeniedException',
    ]);
    expect(scan?.unknown).toBeGreaterThan(0);
    // A coleta parcial vale como bem-sucedida: a próxima é daqui a 24 h.
    expect((await cursorOf(account.id)).failures).toBe(0);

    const get = await reader(tenant);
    const [item] = postureOverviewSchema.parse((await get('/v1/posture').expect(200)).body).accounts;
    expect(item?.errors).toEqual([
      { section: 'sg', region: 'us-east-1', code: 'UnauthorizedOperation' },
      { section: 's3_account', region: null, code: 'AccessDenied' },
      { section: 'ebs', region: 'us-east-1', code: 'UnauthorizedOperation' },
      { section: 'guardduty', region: 'us-east-1', code: 'AccessDeniedException' },
    ]);
    const status = (id: string) => item?.checks.find((check) => check.checkId === id)?.status;
    expect(status('s3_account_level_public_access_blocks')).toBe('unknown');
    expect(status('guardduty_is_enabled')).toBe('unknown');
    // Uma região aprovada e a outra não lida: a reprovação de sa-east-1 continua (o grupo com SSH aberto).
    expect(status('ec2_securitygroup_allow_ingress_from_internet_to_tcp_port_22')).toBe('fail');
    expect(status('ec2_securitygroup_allow_ingress_from_internet_to_all_ports')).toBe('unknown');
    // Nenhuma reprovação vem de uma leitura recusada.
    const failures = paginatedSchema(postureCheckSchema).parse(
      (await get('/v1/posture/checks?pageSize=50').expect(200)).body,
    );
    expect(
      failures.items.filter(
        (failure) => failure.region === 'us-east-1' && failure.checkId.startsWith('ec2_securitygroup'),
      ),
    ).toEqual([]);
    expect(failures.items.map((failure) => failure.checkId)).not.toContain(
      's3_account_level_public_access_blocks',
    );
    expect(failures.items.map((failure) => failure.checkId)).not.toContain('guardduty_is_enabled');
    // A faixa de Ativos só mostra o que é do inventário (as leituras próprias da postura ficam na tela de Postura).
    const summary = inventorySummarySchema.parse((await get('/v1/assets').expect(200)).body);
    expect(summary.accounts[0]?.errors).toEqual([
      { section: 'sg', region: 'us-east-1', code: 'UnauthorizedOperation' },
    ]);
  });

  it('falha passageira numa leitura da postura: nem o retrato nem a varredura são gravados, e a tarefa recua', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (postura, falha)');
    const account = await verifiedAccount(tenant);
    const { sync, clock } = setup([tenant], {
      behavior: {
        [account.accountId]: { cloudtrail: { GetTrailStatusCommand: refuse('ThrottlingException', 400) } },
      },
    });
    expect(await sync.runOnce()).toMatchObject({
      collected: 0,
      postureScans: 0,
      failed: 1,
      failures: { aws_unavailable: 1 },
    });
    expect(await scansOf(account.accountId)).toEqual([]);
    expect(await prisma.inventorySnapshot.count({ where: { accountId: account.accountId } })).toBe(0);
    expect((await cursorOf(account.id)).nextRunAt).toEqual(
      new Date(clock.now().getTime() + AWS_INVENTORY_BACKOFF.baseMs),
    );
  });

  it('a conta desativada durante a coleta: nenhuma varredura gravada', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (postura, desativada)');
    const account = await verifiedAccount(tenant);
    const { sync } = setup([tenant], {
      behavior: {
        [account.accountId]: {
          cloudtrail: {
            DescribeTrailsCommand: async () => {
              await prisma.cloudAccount.update({ where: { id: account.id }, data: { status: 'inactive' } });
              return { trailList: [] };
            },
          },
        },
      },
    });
    expect(await sync.runOnce()).toMatchObject({ stale: 1, postureScans: 0 });
    expect(await scansOf(account.accountId)).toEqual([]);
  });

  it('A/B: cada varredura no cliente da conta; um cliente nunca vê a postura, as reprovações nem a varredura parcial do outro', async () => {
    const tenantA = await createTenant(app, 'Cliente Demo A (postura A/B)');
    const tenantB = await createTenant(app, 'Cliente Demo B (postura A/B)');
    const accountA = await verifiedAccount(tenantA);
    const accountB = await verifiedAccount(tenantB);
    const { sync } = setup([tenantA, tenantB], { behavior: { [accountB.accountId]: POSTURE_REFUSED } });
    expect(await sync.runOnce()).toMatchObject({ postureScans: 2, posturePartial: 1 });
    const [scanA] = await scansOf(accountA.accountId);
    const [scanB] = await scansOf(accountB.accountId);
    expect(scanA?.tenantId).toBe(tenantA);
    expect(scanB?.tenantId).toBe(tenantB);
    expect(new Set(scanB?.failures.map((failure) => failure.tenantId))).toEqual(new Set([tenantB]));

    const getA = await reader(tenantA);
    const overview = postureOverviewSchema.parse((await getA('/v1/posture').expect(200)).body);
    expect(overview.accounts.map((item) => item.accountId)).toEqual([accountA.accountId]);
    expect(overview.accounts[0]?.errors).toEqual([]);
    const failures = paginatedSchema(postureCheckSchema).parse(
      (await getA('/v1/posture/checks?pageSize=50').expect(200)).body,
    );
    expect(new Set(failures.items.map((failure) => failure.accountId))).toEqual(
      new Set([accountA.accountId]),
    );
    expect(JSON.stringify(failures)).not.toContain(accountB.accountId);
    // O filtro pela conta do outro cliente não traz nada.
    expect((await getA(`/v1/posture/checks?accountId=${accountB.accountId}`).expect(200)).body).toMatchObject(
      {
        items: [],
        total: 0,
      },
    );
  });

  it('o expurgo do PR-19: a varredura antiga sai com as reprovações; a mais recente de cada conta fica', async () => {
    // O expurgo também limpa tabelas globais (sessões, fila sem dono) pelo horário: roda no horário de hoje, nunca no
    // futuro, para não apagar o que os outros arquivos de teste usam ao mesmo tempo.
    const real = new Date();
    const today = new Date(Date.UTC(real.getUTCFullYear(), real.getUTCMonth(), real.getUTCDate(), 5));
    const tenant = await createTenant(app, 'Cliente Demo A (postura, expurgo)');
    const daily = await verifiedAccount(tenant);
    const { sync, clock } = setup([tenant], { start: new Date(today.getTime() - 100 * DAY) });
    expect(await sync.runOnce()).toMatchObject({ postureScans: 1 });
    // Uma segunda conta que só coletou no primeiro dia: a única varredura dela fica, mesmo antiga.
    const once = await verifiedAccount(tenant);
    expect(await sync.runOnce()).toMatchObject({ postureScans: 1 });
    await prisma.cloudAccount.update({ where: { id: once.id }, data: { connection: 'waiting' } });
    clock.advance(100 * DAY);
    expect(await sync.runOnce()).toMatchObject({ postureScans: 1 });
    const [old, latest] = await scansOf(daily.accountId);

    const retention = new RetentionJob(prisma, {
      historyDays: 30,
      name: `ret-${randomBytes(4).toString('hex')}`,
      pauseMs: 0,
      tenantIds: [tenant],
    });
    expect(await retention.maybeRun(today)).toMatchObject({
      status: 'done',
      deleted: { postureScans: 1, postureFailures: old?.failures.length },
    });
    const kept = await scansOf(daily.accountId);
    expect(kept.map((scan) => scan.id)).toEqual([latest?.id]);
    expect(kept[0]?.failures).toHaveLength(latest?.failures.length ?? -1);
    expect(kept[0]?.checks).toHaveLength(18);
    expect(await prisma.postureFailure.count({ where: { scanId: old?.id } })).toBe(0);
    expect(await scansOf(once.accountId)).toHaveLength(1);
  });

  it('valores fora do formato no banco não vão para a tela', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (postura, leitura)');
    const account = await verifiedAccount(tenant);
    await prisma.postureScan.create({
      data: {
        tenantId: tenant,
        accountId: account.accountId,
        scannedAt: START,
        score: 50,
        weightPassed: 5,
        weightTotal: 10,
        passed: 1,
        failed: 1,
        failedCritical: 0,
        failedHigh: 1,
        failedMedium: 0,
        failedLow: 0,
        failedInformational: 0,
        unknown: 1,
        checks: [
          {
            checkId: 'guardduty_is_enabled',
            title: 'GuardDuty ligado',
            severity: 'high',
            passed: 1,
            failed: 1,
            unknown: 0,
          },
          { checkId: 'Fora Do Formato', title: 'x', severity: 'high', passed: 0, failed: 0, unknown: 0 },
          {
            checkId: 'ec2_ebs_default_encryption',
            title: 'EBS',
            severity: 'high',
            passed: 0,
            failed: 0,
            unknown: 1,
            extra: 1,
          },
          'texto solto',
        ],
        errors: [
          'guardduty:us-east-1:AccessDeniedException',
          'rds:AccessDenied',
          'ebs:lua-1:AccessDenied',
          'iam:Access Denied',
        ],
      },
    });
    const get = await reader(tenant);
    const [item] = postureOverviewSchema.parse((await get('/v1/posture').expect(200)).body).accounts;
    expect(item?.checks).toEqual([
      {
        checkId: 'guardduty_is_enabled',
        title: 'GuardDuty ligado',
        severity: 'high',
        passed: 1,
        failed: 1,
        unknown: 0,
        status: 'fail',
      },
    ]);
    expect(item?.errors).toEqual([
      { section: 'guardduty', region: 'us-east-1', code: 'AccessDeniedException' },
    ]);
    expect(item?.unknown).toBe(1);
  });

  it('nenhuma credencial, token ou mensagem da AWS no log do worker nem na varredura (com leituras recusadas)', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (postura, log)');
    const account = await verifiedAccount(tenant);
    const lines: string[] = [];
    const logger = pino(buildPinoOptions({ LOG_LEVEL: 'debug' }), {
      write: (line: string) => {
        lines.push(line);
      },
    });
    const secrets: string[] = [];
    const tokens: string[] = [];
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const credentials = new WebIdentityCredentials({
      audience: 'https://aws.verax.example/reader',
      logger,
      idToken: () => {
        const token = `${part({ alg: 'RS256' })}.${part({ sub: '123456789012345678901' })}.${randomBytes(48).toString('base64url')}`;
        tokens.push(token);
        return Promise.resolve(token);
      },
      sts: () =>
        fakeClient<STSClient>({
          AssumeRoleWithWebIdentityCommand: () => {
            const secret = randomBytes(30).toString('base64');
            const sessionToken = randomBytes(96).toString('base64');
            secrets.push(secret, sessionToken);
            return {
              Credentials: {
                AccessKeyId: 'ASIAEXEMPLO000000000',
                SecretAccessKey: secret,
                SessionToken: sessionToken,
                Expiration: new Date(Date.now() + HOUR),
              },
            };
          },
        }).client,
    });
    // A fábrica falsa resolve o provedor da sessão, como o SDK faria antes de assinar.
    const resolved: string[] = [];
    const factory: InventoryClientFactory = (provider) =>
      factoryOf(fakeAccount(POSTURE_REFUSED).clients, (_service, client) => ({
        send: async (command: unknown) => {
          resolved.push((await provider()).accessKeyId);
          return (client as unknown as { send: (c: unknown) => Promise<unknown> }).send(command);
        },
      }));
    const sync = new AwsInventorySync(prisma, credentials, factory, {
      name: `pos-${randomInt(1e6, 9e6)}`,
      tenantIds: [tenant],
    });
    const scheduler = new Scheduler(
      [{ name: 'aws-inventory', intervalMs: HOUR, budgetMs: HOUR, run: (signal) => sync.runOnce(signal) }],
      logger,
    );
    scheduler.start();
    await expect
      .poll(() => lines.some((line) => line.includes('tarefa concluída')), { timeout: 20_000 })
      .toBe(true);
    await scheduler.stop();

    expect(resolved.length).toBeGreaterThan(0);
    const log = lines.join('');
    expect(log).toContain('"postureScans":1');
    expect(log).toContain('"posturePartial":1');
    const rows = JSON.stringify(await scansOf(account.accountId));
    expect(rows).toContain('s3_account:AccessDenied');
    for (const value of [...secrets, ...tokens]) {
      expect(log).not.toContain(value);
      expect(rows).not.toContain(value);
    }
    expect(log).not.toMatch(/eyJ|ASIA|detalhe-interno/);
    expect(rows).not.toMatch(/ASIA|detalhe-interno|is not authorized/);
    expect(log).not.toContain(account.accountId);
  });
});
