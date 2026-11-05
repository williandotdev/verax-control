import 'reflect-metadata';
import { randomBytes, randomInt } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { EC2Client } from '@aws-sdk/client-ec2';
import type { IAMClient } from '@aws-sdk/client-iam';
import type { S3Client } from '@aws-sdk/client-s3';
import type { STSClient } from '@aws-sdk/client-sts';
import {
  accessKeyAssetSchema,
  inventorySummarySchema,
  paginatedSchema,
  postureOverviewSchema,
} from '@verax/shared';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AwsConnectionError,
  type AwsCredentialProvider,
  type ReaderSession,
  WebIdentityCredentials,
} from '../src/aws/web-identity.js';
import { buildPinoOptions } from '../src/common/logger/logger.options.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import type { InventoryClientFactory } from '../src/inventory/inventory.js';
import {
  AWS_INVENTORY_BACKOFF,
  AWS_INVENTORY_INTERVAL_MS,
  AWS_INVENTORY_JITTER_MS,
  AWS_INVENTORY_STREAM,
  AwsInventorySync,
  type AwsInventoryOptions,
  type InventoryCredentials,
} from '../src/inventory/inventory-job.js';
import { TemporaryCredentials } from '../src/inventory/read-only-session.js';
import { Scheduler } from '../src/worker/scheduler.js';
import { fakeAccount, type FakeAccountOptions, REFUSED_ACL } from './inventory/fake-account.js';
import { awsError, fakeClient } from './inventory/fake-aws.js';
import { createSignedInUser, createTenant } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';

const HOUR = 3_600_000;
const START = new Date('2026-11-05T10:00:00.000Z');
const accountId = () => String(randomInt(100_000_000_000, 999_999_999_999));

/** Um relógio do teste, que só anda quando o teste manda. */
function clockAt(start: Date) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

/**
 * O provedor falso das sessões: cada entrada no papel anotada, um erro programado por conta, e o provedor de cada conta
 * marcado com ela (a fábrica de clientes falsa descobre de que conta é a coleta).
 */
class FakeCredentials implements InventoryCredentials {
  readonly sessions: { accountId: string; region: string }[] = [];
  readonly forgotten: string[] = [];
  readonly failures = new Map<string, AwsConnectionError>();
  readonly owners = new Map<AwsCredentialProvider, string>();

  session(accountId: string, region: string): Promise<ReaderSession> {
    this.sessions.push({ accountId, region });
    const failure = this.failures.get(accountId);
    if (failure !== undefined) return Promise.reject(failure);
    return Promise.resolve({
      credentials: new TemporaryCredentials({
        accessKeyId: 'ASIAEXEMPLO000000000',
        secretAccessKey: 'segredo-de-teste-da-sessao-0000',
        sessionToken: 'token-de-teste-da-sessao-0000',
      }),
      stsRegion: region,
      regionFallback: false,
    });
  }

  credentialsFor(accountId: string): AwsCredentialProvider {
    const provider: AwsCredentialProvider = () => Promise.reject(new Error('o falso não resolve credencial'));
    this.owners.set(provider, accountId);
    return provider;
  }

  forget(accountId: string): void {
    this.forgotten.push(accountId);
  }
}

/** A fábrica de clientes falsa: a conta fictícia de `fake-account.ts`, com o comportamento programado por conta AWS. */
function factoryFor(
  owners: (provider: AwsCredentialProvider) => string | undefined,
  behavior: Record<string, FakeAccountOptions> = {},
) {
  const calls: { accountId: string; service: string; command: string }[] = [];
  const factory: InventoryClientFactory = (credentials) => {
    const owner = owners(credentials) ?? 'desconhecida';
    const account = fakeAccount(behavior[owner] ?? {});
    const traced = <T extends { send: unknown }>(service: string, client: Pick<T, 'send'>) => ({
      send: ((command: { constructor: { name: string } }) => {
        calls.push({ accountId: owner, service, command: command.constructor.name });
        return (client as unknown as { send: (c: unknown) => Promise<unknown> }).send(command);
      }) as unknown as T['send'],
    });
    return {
      iam: () => traced<IAMClient>('iam', account.clients.iam()),
      s3: (region) => traced<S3Client>('s3', account.clients.s3(region)),
      ec2: (region) => traced<EC2Client>('ec2', account.clients.ec2(region)),
    };
  };
  return { factory, calls };
}

describe('tarefa aws-inventory: inventário nativo da AWS pelo papel sem chave (fase 2, PR-14)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Uma conta AWS já verificada (com `ingestFrom`) e conectada, num cliente do teste. */
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

  /**
   * A tarefa com o provedor e a fábrica falsos. O comportamento de cada conta AWS é lido a cada coleta: o teste pode
   * trocá-lo entre uma execução e outra.
   */
  function setup(
    tenantIds: string[],
    {
      behavior = {},
      ...options
    }: AwsInventoryOptions & { behavior?: Record<string, FakeAccountOptions> } = {},
  ) {
    const clock = clockAt(START);
    const credentials = new FakeCredentials();
    const { factory, calls } = factoryFor((provider) => credentials.owners.get(provider), behavior);
    const name = `inv-${randomInt(1e6, 9e6)}`;
    const sync = new AwsInventorySync(prisma, credentials, factory, {
      name,
      now: clock.now,
      random: () => 0.5,
      tenantIds,
      ...options,
    });
    return { sync, name, clock, credentials, calls, behavior };
  }

  const snapshotsOf = (awsAccountId: string) =>
    prisma.inventorySnapshot.findMany({
      where: { accountId: awsAccountId },
      orderBy: { collectedAt: 'asc' },
    });
  const cursorOf = (cloudAccountId: string) =>
    prisma.collectorCursor.findUniqueOrThrow({
      where: {
        cloudAccountId_stream_region: { cloudAccountId, stream: AWS_INVENTORY_STREAM, region: '' },
      },
    });

  it('a conta que nunca coletou entra já; depois, só quando a última coleta tem mais de 24 h, com o sorteio', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (inventário)');
    const account = await verifiedAccount(tenant);
    const { sync, clock, credentials } = setup([tenant]);

    expect(await sync.runOnce()).toEqual({
      status: 'done',
      accounts: 1,
      waiting: 0,
      notDue: 0,
      collected: 1,
      partial: 0,
      duplicates: 0,
      stale: 0,
      failed: 0,
      droppedItems: 0,
    });
    // A sessão no papel pela primeira região monitorada (a mesma da conferência da conexão).
    expect(credentials.sessions).toEqual([{ accountId: account.accountId, region: 'sa-east-1' }]);
    const [first] = await snapshotsOf(account.accountId);
    expect(first).toMatchObject({ tenantId: tenant, collectedAt: START, errors: [], truncated: false });
    expect(first?.root).toMatchObject({ mfaEnabled: false, risk: 'critical' });
    const items = first?.items as Record<string, unknown[]>;
    expect(items['users']).toHaveLength(2);
    expect(items['keys']).toHaveLength(1);
    expect(items['instances']).toHaveLength(4);
    expect(items['buckets']).toHaveLength(3);
    expect(items['security-groups']).toHaveLength(2);

    // 24 h depois do início, mais metade do sorteio de 1 h.
    const cursor = await cursorOf(account.id);
    expect(cursor.nextRunAt).toEqual(
      new Date(START.getTime() + AWS_INVENTORY_INTERVAL_MS + AWS_INVENTORY_JITTER_MS / 2),
    );
    expect(cursor.lastSuccessAt).not.toBeNull();

    // Menos de 24 h: nada.
    clock.advance(23 * HOUR);
    expect(await sync.runOnce()).toMatchObject({ notDue: 1, collected: 0 });
    clock.advance(HOUR);
    expect(await sync.runOnce()).toMatchObject({ notDue: 1, collected: 0 });
    // Passado o sorteio, a segunda coleta: um retrato novo, o anterior fica.
    clock.advance(AWS_INVENTORY_JITTER_MS / 2);
    expect(await sync.runOnce()).toMatchObject({ notDue: 0, collected: 1 });
    expect(await snapshotsOf(account.accountId)).toHaveLength(2);
    expect(credentials.sessions).toHaveLength(2);
  });

  it('o sorteio do horário: de 24 h a 24 h + 1 h, pela fonte de sorteio', () => {
    const at = (random: number) => {
      const { sync } = setup([], { random: () => random });
      return sync.nextRunAfter(START).getTime() - START.getTime();
    };
    expect(at(0)).toBe(AWS_INVENTORY_INTERVAL_MS);
    expect(at(0.25)).toBe(AWS_INVENTORY_INTERVAL_MS + AWS_INVENTORY_JITTER_MS / 4);
    expect(at(0.999_999)).toBeLessThan(AWS_INVENTORY_INTERVAL_MS + AWS_INVENTORY_JITTER_MS);
    // Uma fonte fora da faixa não passa do limite.
    expect(at(7)).toBe(AWS_INVENTORY_INTERVAL_MS + AWS_INVENTORY_JITTER_MS);
    expect(at(-1)).toBe(AWS_INVENTORY_INTERVAL_MS);
  });

  it('quem entra: ativa, já verificada, conectada ou com erro só de bucket; nunca a que aguarda', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (inventário, quem entra)');
    const connected = await verifiedAccount(tenant);
    const bucketError = await verifiedAccount(tenant, {
      connection: 'error',
      connectionError: 'bucket_denied:waf',
    });
    const trustDenied = await verifiedAccount(tenant, {
      connection: 'error',
      connectionError: 'trust_denied',
    });
    const waiting = await verifiedAccount(tenant, { connection: 'waiting' });
    const neverVerified = await verifiedAccount(tenant, { ingestFrom: null });
    const inactive = await verifiedAccount(tenant, { status: 'inactive' });
    await prisma.cloudAccount.create({
      data: { tenantId: tenant, provider: 'gcp', accountId: `vx-inv-${randomInt(1e6, 9e6)}`, regions: [] },
    });
    const { sync, credentials } = setup([tenant]);
    expect(await sync.runOnce()).toMatchObject({ accounts: 3, waiting: 1, collected: 2, failed: 0 });
    expect(new Set(credentials.sessions.map((session) => session.accountId))).toEqual(
      new Set([connected.accountId, bucketError.accountId]),
    );
    for (const skipped of [trustDenied, waiting, neverVerified, inactive]) {
      expect(await snapshotsOf(skipped.accountId)).toEqual([]);
      expect(await prisma.collectorCursor.count({ where: { cloudAccountId: skipped.id } })).toBe(0);
    }
  });

  it('o lote: as mais atrasadas primeiro, as outras na volta seguinte', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (inventário, lote)');
    const accounts = [
      await verifiedAccount(tenant),
      await verifiedAccount(tenant),
      await verifiedAccount(tenant),
    ];
    const { sync } = setup([tenant], { batch: 2 });
    expect(await sync.runOnce()).toMatchObject({ accounts: 3, collected: 2, notDue: 1 });
    expect(await sync.runOnce()).toMatchObject({ accounts: 3, collected: 1, notDue: 2 });
    for (const account of accounts) expect(await snapshotsOf(account.accountId)).toHaveLength(1);
  });

  it('idempotente pelo início da coleta: a mesma coleta gravada de novo não duplica o retrato', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (inventário, idempotência)');
    const account = await verifiedAccount(tenant);
    const { sync } = setup([tenant]);
    expect(await sync.runOnce()).toMatchObject({ collected: 1 });
    // O cursor volta para "agora" (uma gravação que não chegou a avançar o cursor), e o relógio não andou.
    await prisma.collectorCursor.updateMany({
      where: { cloudAccountId: account.id },
      data: { nextRunAt: START },
    });
    expect(await sync.runOnce()).toMatchObject({ collected: 0, duplicates: 1 });
    expect(await snapshotsOf(account.accountId)).toHaveLength(1);
    expect((await cursorOf(account.id)).nextRunAt.getTime()).toBeGreaterThan(START.getTime());
  });

  it('parte recusada: retrato parcial gravado, a API mostra as partes; o retrato anterior não some', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (inventário, parcial)');
    const account = await verifiedAccount(tenant);
    const { sync } = setup([tenant], {
      behavior: {
        [account.accountId]: {
          iam: {
            ListUsersCommand: () => {
              throw awsError('AccessDenied', 403);
            },
          },
          ec2: {
            'us-east-1': {
              DescribeInstancesCommand: () => {
                throw awsError('UnauthorizedOperation', 403);
              },
            },
          },
        },
      },
    });
    expect(await sync.runOnce()).toMatchObject({ collected: 1, partial: 1, failed: 0 });
    const [snapshot] = await snapshotsOf(account.accountId);
    expect(snapshot?.errors).toEqual(['iam:AccessDenied', 'ec2:us-east-1:UnauthorizedOperation']);
    expect(snapshot?.truncated).toBe(false);
    // A coleta parcial vale como bem-sucedida: a próxima é daqui a 24 h.
    expect((await cursorOf(account.id)).failures).toBe(0);

    const user = await createSignedInUser(app, { role: 'leitura', tenantId: tenant });
    const summary = inventorySummarySchema.parse(
      (await request(app.getHttpServer()).get('/v1/assets').set('Cookie', user.cookie).expect(200)).body,
    );
    expect(summary.accounts).toHaveLength(1);
    expect(summary.accounts[0]?.root).toMatchObject({ risk: 'critical' });
    expect(summary.accounts).toMatchObject([
      {
        accountId: account.accountId,
        collectedAt: START.toISOString(),
        errors: [
          { section: 'iam', region: null, code: 'AccessDenied' },
          { section: 'ec2', region: 'us-east-1', code: 'UnauthorizedOperation' },
        ],
        truncated: false,
      },
    ]);
    expect(summary.counts.users).toEqual({ total: 0, atRisk: 0 });
    expect(summary.counts.instances.total).toBe(2);
  });

  it('valor de errors fora do formato no banco não vai para a tela; teto de itens aparece', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (inventário, leitura)');
    const account = await verifiedAccount(tenant);
    await prisma.inventorySnapshot.create({
      data: {
        tenantId: tenant,
        accountId: account.accountId,
        collectedAt: START,
        items: {},
        errors: ['iam:AccessDenied', 'rds:AccessDenied', 'iam:Access Denied com detalhe', 'iam:AccessDenied'],
        truncated: true,
      },
    });
    const user = await createSignedInUser(app, { role: 'leitura', tenantId: tenant });
    const summary = inventorySummarySchema.parse(
      (await request(app.getHttpServer()).get('/v1/assets').set('Cookie', user.cookie).expect(200)).body,
    );
    expect(summary.accounts[0]).toMatchObject({
      errors: [{ section: 'iam', region: null, code: 'AccessDenied' }],
      truncated: true,
    });
  });

  it('falha passageira: nada gravado, o retrato anterior fica, e a próxima tentativa recua', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (inventário, falha)');
    const account = await verifiedAccount(tenant);
    const { sync, clock, behavior } = setup([tenant]);
    expect(await sync.runOnce()).toMatchObject({ collected: 1 });

    behavior[account.accountId] = {
      s3: {
        ListBucketsCommand: () => {
          throw awsError('ServiceUnavailable', 503);
        },
      },
    };
    clock.advance(AWS_INVENTORY_INTERVAL_MS + AWS_INVENTORY_JITTER_MS);
    const report = await sync.runOnce();
    expect(report).toMatchObject({ collected: 0, failed: 1, failures: { aws_unavailable: 1 } });
    expect(await snapshotsOf(account.accountId)).toHaveLength(1);
    const cursor = await cursorOf(account.id);
    expect(cursor).toMatchObject({ failures: 1, lastErrorKind: 'aws_unavailable' });
    expect(cursor.nextRunAt).toEqual(new Date(clock.now().getTime() + AWS_INVENTORY_BACKOFF.baseMs));
    // Recuo dobrando; a coleta que volta a dar certo zera as falhas.
    clock.advance(AWS_INVENTORY_BACKOFF.baseMs);
    expect(await sync.runOnce()).toMatchObject({ failed: 1 });
    expect((await cursorOf(account.id)).nextRunAt).toEqual(
      new Date(clock.now().getTime() + 2 * AWS_INVENTORY_BACKOFF.baseMs),
    );
    delete behavior[account.accountId];
    clock.advance(2 * AWS_INVENTORY_BACKOFF.baseMs);
    expect(await sync.runOnce()).toMatchObject({ collected: 1, failed: 0 });
    expect(await cursorOf(account.id)).toMatchObject({ failures: 0, lastErrorKind: null });
    expect(await snapshotsOf(account.accountId)).toHaveLength(2);
  });

  it('a entrada no papel recusada: nenhuma chamada de inventário; tudo recusado descarta a sessão', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (inventário, recusa)');
    const denied = await verifiedAccount(tenant);
    const refusedAll = await verifiedAccount(tenant);
    const everything = (code: string) => () => {
      throw awsError(code, 403);
    };
    const { sync, name, credentials, calls } = setup([tenant], {
      behavior: {
        [refusedAll.accountId]: {
          iam: {
            GetAccountSummaryCommand: everything('AccessDenied'),
            ListUsersCommand: everything('AccessDenied'),
          },
          s3: { ListBucketsCommand: everything('AccessDenied') },
          ec2: Object.fromEntries(
            ['sa-east-1', 'us-east-1'].map((region) => [
              region,
              {
                DescribeInstancesCommand: everything('UnauthorizedOperation'),
                DescribeSecurityGroupsCommand: everything('UnauthorizedOperation'),
              },
            ]),
          ),
        },
      },
    });
    credentials.failures.set(denied.accountId, new AwsConnectionError('trust_denied', true));
    const report = await sync.runOnce();
    expect(report).toMatchObject({
      collected: 0,
      failed: 2,
      failures: { trust_denied: 1, inventory_refused: 1 },
    });
    expect(calls.filter((call) => call.accountId === denied.accountId)).toEqual([]);
    expect(credentials.forgotten).toEqual([refusedAll.accountId]);
    expect(await snapshotsOf(refusedAll.accountId)).toEqual([]);
    expect(await cursorOf(denied.id)).toMatchObject({ failures: 1, lastErrorKind: 'trust_denied' });
    expect(await cursorOf(refusedAll.id)).toMatchObject({ failures: 1, lastErrorKind: 'inventory_refused' });
    const state = await prisma.syncState.findUniqueOrThrow({ where: { name } });
    expect(state.lastError).toBe('trust_denied');
  });

  it('leitura de bucket: a recusa vira coleta parcial; a falha passageira não grava e recua', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (inventário, buckets)');
    const refused = await verifiedAccount(tenant);
    const throttled = await verifiedAccount(tenant);
    const { sync } = setup([tenant], {
      behavior: {
        [refused.accountId]: { s3: REFUSED_ACL },
        [throttled.accountId]: {
          s3: {
            GetPublicAccessBlockCommand: () => {
              throw awsError('SlowDown', 503);
            },
          },
        },
      },
    });
    expect(await sync.runOnce()).toMatchObject({
      collected: 1,
      partial: 1,
      failed: 1,
      failures: { aws_unavailable: 1 },
    });
    const [snapshot] = await snapshotsOf(refused.accountId);
    expect(snapshot?.errors).toEqual(['s3:AccessDenied']);
    expect(await snapshotsOf(throttled.accountId)).toEqual([]);
    expect(await cursorOf(throttled.id)).toMatchObject({ failures: 1, lastErrorKind: 'aws_unavailable' });
  });

  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const leaseOf = (name: string) => prisma.syncState.findUniqueOrThrow({ where: { name } });

  it('a concessão é renovada durante a coleta de uma conta (a cada terço da validade)', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (inventário, concessão)');
    const account = await verifiedAccount(tenant);
    const seen: number[] = [];
    let name = '';
    const { sync, name: leaseName } = setup([tenant], {
      leaseMs: 900,
      behavior: {
        [account.accountId]: {
          s3: {
            ListBucketsCommand: async () => {
              // Uma coleta mais longa que a validade da concessão.
              await pause(450);
              seen.push((await leaseOf(name)).leaseUntil?.getTime() ?? 0);
              await pause(750);
              seen.push((await leaseOf(name)).leaseUntil?.getTime() ?? 0);
              return { Buckets: [] };
            },
          },
        },
      },
    });
    name = leaseName;
    expect(await sync.runOnce()).toMatchObject({ status: 'done', collected: 1 });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeGreaterThan(seen[0] ?? Number.MAX_SAFE_INTEGER);
    expect(await snapshotsOf(account.accountId)).toHaveLength(1);
  });

  it('concessão tomada por outra réplica no meio da coleta: a coleta para, nada é gravado e o cursor fica', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (inventário, concessão perdida)');
    const account = await verifiedAccount(tenant);
    let name = '';
    const {
      sync,
      name: leaseName,
      calls,
    } = setup([tenant], {
      leaseMs: 900,
      behavior: {
        [account.accountId]: {
          s3: {
            ListBucketsCommand: async () => {
              // A concessão venceu e outra réplica a tomou; a renovação seguinte descobre.
              await prisma.syncState.update({
                where: { name },
                data: { leaseOwner: 'outra-replica', leaseUntil: new Date(Date.now() + HOUR) },
              });
              await pause(700);
              return { Buckets: [{ Name: 'depois-da-perda', BucketRegion: 'sa-east-1' }] };
            },
          },
        },
      },
    });
    name = leaseName;
    expect(await sync.runOnce()).toMatchObject({ status: 'lease_lost', collected: 0, failed: 0 });
    expect(await snapshotsOf(account.accountId)).toEqual([]);
    // Nenhuma chamada depois da perda: nem os buckets listados, nem o EC2.
    const after = calls.filter((call) => call.accountId === account.accountId);
    expect(after.map((call) => call.command)).not.toContain('GetBucketAclCommand');
    expect(after.filter((call) => call.service === 'ec2')).toEqual([]);
    // O cursor não mudou (nem sucesso nem falha), e a concessão e o estado ficam com a outra réplica.
    expect(await cursorOf(account.id)).toMatchObject({ failures: 0, lastErrorKind: null, nextRunAt: START });
    expect(await leaseOf(name)).toMatchObject({ leaseOwner: 'outra-replica', lastError: null });
  });

  it('concessão tomada logo antes da gravação: a transação confere e não grava', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (inventário, concessão na gravação)');
    const account = await verifiedAccount(tenant);
    let name = '';
    const { sync, name: leaseName } = setup([tenant], {
      behavior: {
        [account.accountId]: {
          ec2: {
            'us-east-1': {
              // A última chamada da coleta: a renovação periódica (a cada 5 min) não chega a ver a troca.
              DescribeSecurityGroupsCommand: async () => {
                await prisma.syncState.update({
                  where: { name },
                  data: { leaseOwner: 'outra-replica', leaseUntil: new Date(Date.now() + HOUR) },
                });
                return { SecurityGroups: [] };
              },
            },
          },
        },
      },
    });
    name = leaseName;
    expect(await sync.runOnce()).toMatchObject({ status: 'lease_lost', collected: 0 });
    expect(await snapshotsOf(account.accountId)).toEqual([]);
    expect(await cursorOf(account.id)).toMatchObject({ failures: 0, nextRunAt: START });
    expect((await leaseOf(name)).leaseOwner).toBe('outra-replica');
  });

  it('a conta desativada no meio da coleta: o retrato é descartado', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (inventário, desativada)');
    const account = await verifiedAccount(tenant);
    const { sync } = setup([tenant], {
      behavior: {
        [account.accountId]: {
          s3: {
            ListBucketsCommand: async () => {
              await prisma.cloudAccount.update({ where: { id: account.id }, data: { status: 'inactive' } });
              return { Buckets: [] };
            },
          },
        },
      },
    });
    expect(await sync.runOnce()).toMatchObject({ collected: 0, stale: 1 });
    expect(await snapshotsOf(account.accountId)).toEqual([]);
  });

  it('A/B: cada retrato no cliente da conta; um cliente nunca vê o inventário nem a coleta parcial do outro', async () => {
    const tenantA = await createTenant(app, 'Cliente Demo A (inventário A/B)');
    const tenantB = await createTenant(app, 'Cliente Demo B (inventário A/B)');
    const accountA = await verifiedAccount(tenantA);
    const accountB = await verifiedAccount(tenantB);
    const { sync } = setup([tenantA, tenantB], {
      behavior: {
        [accountB.accountId]: {
          ec2: {
            'sa-east-1': {
              DescribeInstancesCommand: () => {
                throw awsError('UnauthorizedOperation', 403);
              },
            },
          },
        },
      },
    });
    expect(await sync.runOnce()).toMatchObject({ collected: 2 });
    expect((await snapshotsOf(accountA.accountId)).map((snapshot) => snapshot.tenantId)).toEqual([tenantA]);
    expect((await snapshotsOf(accountB.accountId)).map((snapshot) => snapshot.tenantId)).toEqual([tenantB]);
    // Os itens de cada retrato são da conta dele.
    const [snapshotB] = await snapshotsOf(accountB.accountId);
    expect(JSON.stringify(snapshotB?.items)).not.toContain(accountA.accountId);

    const userA = await createSignedInUser(app, { role: 'leitura', tenantId: tenantA });
    const get = (path: string) => request(app.getHttpServer()).get(path).set('Cookie', userA.cookie);
    const summary = inventorySummarySchema.parse((await get('/v1/assets').expect(200)).body);
    expect(summary.accounts.map((item) => item.accountId)).toEqual([accountA.accountId]);
    expect(summary.accounts[0]?.errors).toEqual([]);
    const keys = paginatedSchema(accessKeyAssetSchema).parse((await get('/v1/assets/keys').expect(200)).body);
    expect(keys.items.map((key) => key.accountId)).toEqual([accountA.accountId]);
    // O filtro pela conta do outro cliente não traz nada.
    expect((await get(`/v1/assets/keys?accountId=${accountB.accountId}`).expect(200)).body).toMatchObject({
      items: [],
      total: 0,
    });
  });

  it('postura e ativos só das contas AWS: o cliente sem conta AWS recebe a lista vazia ("em breve" no painel)', async () => {
    const tenant = await createTenant(app, 'Cliente Demo B (só GCP e Cloudflare)');
    await prisma.cloudAccount.create({
      data: { tenantId: tenant, provider: 'gcp', accountId: `vx-inv-${randomInt(1e6, 9e6)}`, regions: [] },
    });
    await prisma.cloudAccount.create({
      data: {
        tenantId: tenant,
        provider: 'cloudflare',
        accountId: randomBytes(16).toString('hex'),
        regions: [],
      },
    });
    const user = await createSignedInUser(app, { role: 'leitura', tenantId: tenant });
    const get = (path: string) => request(app.getHttpServer()).get(path).set('Cookie', user.cookie);
    expect(postureOverviewSchema.parse((await get('/v1/posture').expect(200)).body)).toEqual({
      score: null,
      warningBelow: 70,
      accounts: [],
    });
    expect(inventorySummarySchema.parse((await get('/v1/assets').expect(200)).body).accounts).toEqual([]);
  });

  it('nenhuma credencial, token ou mensagem da AWS no log do worker, no relatório nem no retrato', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (inventário, log)');
    const ok = await verifiedAccount(tenant);
    const partial = await verifiedAccount(tenant);
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
    const factory: InventoryClientFactory = (provider) => {
      const account = fakeAccount({
        ec2: {
          'us-east-1': {
            DescribeInstancesCommand: () => {
              throw awsError('UnauthorizedOperation', 403);
            },
          },
        },
      });
      const signed = <T extends { send: unknown }>(client: Pick<T, 'send'>) => ({
        send: (async (command: unknown) => {
          resolved.push((await provider()).accessKeyId);
          return (client as unknown as { send: (c: unknown) => Promise<unknown> }).send(command);
        }) as unknown as T['send'],
      });
      return {
        iam: () => signed<IAMClient>(account.clients.iam()),
        s3: (region) => signed<S3Client>(account.clients.s3(region)),
        ec2: (region) => signed<EC2Client>(account.clients.ec2(region)),
      };
    };
    const sync = new AwsInventorySync(prisma, credentials, factory, {
      name: `inv-${randomInt(1e6, 9e6)}`,
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
    expect(secrets).toHaveLength(4);
    const log = lines.join('');
    expect(log).toContain('"collected":2');
    expect(log).toContain('"partial":2');
    const rows = JSON.stringify([
      ...(await snapshotsOf(ok.accountId)),
      ...(await snapshotsOf(partial.accountId)),
    ]);
    for (const value of [...secrets, ...tokens]) {
      expect(log).not.toContain(value);
      expect(rows).not.toContain(value);
    }
    expect(log).not.toMatch(/eyJ|ASIA|detalhe-interno/);
    expect(rows).not.toMatch(/ASIA|detalhe-interno/);
    // Nada da conta no log: nem o ID da conta AWS.
    expect(log).not.toContain(ok.accountId);
    expect(log).not.toContain(partial.accountId);
  });
});
