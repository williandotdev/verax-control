import 'reflect-metadata';
import { randomInt } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { setTenantLifecycleStatus } from '../src/tenants/tenant-lifecycle.js';
import {
  type AwsSessionSource,
  AwsVolumeAudit,
  ISIZE_FALLBACK_RATIO,
  type ListPage,
  pendingCellIdentity,
  type TenantAwsIdentity,
  type VolumeS3,
  volumeCursorStream,
} from '../src/usage/aws-volume.js';
import { createTenant } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';

const HOUR = 3_600_000;

interface FakeObject {
  key: string;
  size: number;
  lastModified: Date;
  /** O tamanho descompactado que o fim do gzip diz (ISIZE). */
  isize: number;
}

/**
 * Um S3 falso, de um cliente só (a identidade dele): os buckets, a listagem em páginas de 2 (para a continuação) com
 * `delimiter`, e o fim de cada objeto com o ISIZE. Conta as chamadas.
 */
class FakeS3 implements VolumeS3 {
  readonly buckets = new Map<string, FakeObject[]>();
  lists = 0;
  tails = 0;
  failing: string | null = null;

  put(bucket: string, object: FakeObject): void {
    this.buckets.set(bucket, [...(this.buckets.get(bucket) ?? []), object]);
  }

  list({
    bucket,
    prefix,
    delimiter,
    continuation,
  }: {
    bucket: string;
    prefix: string;
    delimiter?: string;
    continuation?: string | null;
  }): Promise<ListPage> {
    this.lists += 1;
    if (this.failing === bucket) {
      const error = new Error('negado');
      error.name = 'AccessDenied';
      return Promise.reject(error);
    }
    const keys = (this.buckets.get(bucket) ?? []).filter((object) => object.key.startsWith(prefix));
    if (delimiter !== undefined) {
      const folders = [
        ...new Set(
          keys.flatMap((object) => {
            const rest = object.key.slice(prefix.length);
            const cut = rest.indexOf(delimiter);
            return cut < 0 ? [] : [`${prefix}${rest.slice(0, cut + 1)}`];
          }),
        ),
      ].sort();
      return Promise.resolve({ objects: [], prefixes: folders, next: null });
    }
    const sorted = [...keys].sort((a, b) => a.key.localeCompare(b.key));
    const start = continuation === null || continuation === undefined ? 0 : Number(continuation);
    const page = sorted.slice(start, start + 2);
    return Promise.resolve({
      objects: page.map(({ key, size, lastModified }) => ({ key, size, lastModified })),
      prefixes: [],
      next: start + 2 < sorted.length ? String(start + 2) : null,
    });
  }

  tail(bucket: string, key: string): Promise<Uint8Array> {
    this.tails += 1;
    const object = (this.buckets.get(bucket) ?? []).find((candidate) => candidate.key === key);
    const tail = new Uint8Array(4);
    new DataView(tail.buffer).setUint32(0, object?.isize ?? 0, true);
    return Promise.resolve(tail);
  }
}

/** A identidade falsa: cada cliente com o S3 dele. Pedir a de outro cliente não dá a sessão de ninguém. */
class FakeIdentity implements TenantAwsIdentity {
  readonly s3 = new Map<string, FakeS3>();
  readonly asked: string[] = [];

  sessionsFor(tenantId: string): AwsSessionSource | null {
    this.asked.push(tenantId);
    if (!this.s3.has(tenantId)) return null;
    return {
      credentialsFor: () => () =>
        Promise.resolve({ accessKeyId: tenantId, secretAccessKey: 'x', sessionToken: 'y' }),
    };
  }
}

describe('medição da AWS na origem: a tarefa aws-volume (CE-09)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  const awsAccountId = () => String(randomInt(100_000_000_000, 999_999_999_999));

  async function account(
    tenantId: string,
    meteredFrom: Date,
    buckets: { cloudtrailBucket?: string; guarddutyBucket?: string; wafBucket?: string },
  ) {
    const accountId = awsAccountId();
    const row = await prisma.cloudAccount.create({
      data: {
        tenantId,
        provider: 'aws',
        accountId,
        regions: ['sa-east-1'],
        connection: 'connected',
        ingestFrom: new Date(
          Date.UTC(meteredFrom.getUTCFullYear(), meteredFrom.getUTCMonth(), meteredFrom.getUTCDate() - 1),
        ),
        meteredFrom,
        ...buckets,
      },
      select: { id: true },
    });
    return { id: row.id, accountId };
  }

  /** A tarefa com o S3 de cada cliente pela identidade dele, e o S3 que a identidade devolveu. */
  function audit(identity: FakeIdentity, now: () => Date, tenantIds: string[], maxGetsPerCursor?: number) {
    return new AwsVolumeAudit(
      prisma,
      identity,
      (credentials) => {
        // O S3 é o do cliente cuja identidade emitiu a sessão (a chave falsa carrega o cliente).
        const s3 = { tenant: null as string | null };
        const route = async () => {
          s3.tenant ??= (await credentials()).accessKeyId;
          const fake = identity.s3.get(s3.tenant);
          if (fake === undefined) throw new Error('sem S3');
          return fake;
        };
        return {
          list: async (input) => (await route()).list(input),
          tail: async (bucket, key) => (await route()).tail(bucket, key),
        };
      },
      { now, tenantIds, ...(maxGetsPerCursor !== undefined && { maxGetsPerCursor }) },
    );
  }

  const daysOf = async (tenantId: string) =>
    (
      await prisma.forTenant(tenantId).ingestUsageDay.findMany({
        where: { source: 'aws' },
        orderBy: { day: 'asc' },
      })
    ).map((row) => ({ day: row.day.toISOString().slice(0, 10), bytes: row.bytes }));
  const monthOf = async (tenantId: string) =>
    (
      await prisma
        .forTenant(tenantId)
        .ingestUsage.findMany({ where: { source: 'aws' }, orderBy: { month: 'asc' } })
    ).map((row) => ({ month: row.month.toISOString().slice(0, 10), bytes: row.bytes }));

  beforeAll(async () => {
    app = await createApp({
      cell: { domain: 'example.com', staffSlug: `equipe-${randomInt(10_000, 99_999)}` },
    });
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('conta cada objeto novo uma vez, pelo ISIZE, no dia de Brasília da criação; o histórico antes da verificação não conta', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (volume AWS)');
    const meteredFrom = new Date('2026-11-10T12:00:00Z');
    const { accountId } = await account(tenant, meteredFrom, { cloudtrailBucket: 'trilha-a' });
    const s3 = new FakeS3();
    const ct = (day: string, name: string) =>
      `AWSLogs/${accountId}/CloudTrail/sa-east-1/${day}/${accountId}_${name}.json.gz`;
    // Antes da verificação: nunca conta.
    s3.put('trilha-a', {
      key: ct('2026/11/10', 'antes'),
      size: 100,
      lastModified: new Date('2026-11-10T11:00:00Z'),
      isize: 1_000,
    });
    // 10/11, 21:30 de Brasília (pasta UTC do dia 11).
    s3.put('trilha-a', {
      key: ct('2026/11/11', 'noite'),
      size: 100,
      lastModified: new Date('2026-11-11T00:30:00Z'),
      isize: 1_500,
    });
    s3.put('trilha-a', {
      key: ct('2026/11/11', 'manha'),
      size: 200,
      lastModified: new Date('2026-11-11T13:00:00Z'),
      isize: 3_000,
    });
    // ISIZE impossível: a estimativa, marcada.
    s3.put('trilha-a', {
      key: ct('2026/11/11', 'estranho'),
      size: 50,
      lastModified: new Date('2026-11-11T14:00:00Z'),
      isize: 10,
    });
    // Outra conta no mesmo bucket (organização): fora do prefixo desta conta.
    s3.put('trilha-a', {
      key: 'AWSLogs/111111111111/CloudTrail/sa-east-1/2026/11/11/x.json.gz',
      size: 999,
      lastModified: new Date('2026-11-11T13:00:00Z'),
      isize: 9_999,
    });
    const identity = new FakeIdentity();
    identity.s3.set(tenant, s3);
    let now = new Date('2026-11-11T15:00:00Z');
    const task = audit(identity, () => now, [tenant]);

    const report = await task.runOnce();
    expect(report).toMatchObject({
      accounts: 1,
      identityUnavailable: 0,
      cursors: 1,
      failed: 0,
      counted: 3,
      fallbacks: 1,
    });
    expect(await daysOf(tenant)).toEqual([
      { day: '2026-11-10', bytes: 1_500n },
      { day: '2026-11-11', bytes: BigInt(3_000 + 50 * ISIZE_FALLBACK_RATIO) },
    ]);
    expect(await monthOf(tenant)).toEqual([{ month: '2026-11-01', bytes: BigInt(1_500 + 3_000 + 500) }]);
    expect(s3.tails).toBe(3);

    // Em dia: a próxima leitura é daqui a uma hora; antes disso, nada.
    now = new Date(now.getTime() + 30 * 60_000);
    expect(await task.runOnce()).toMatchObject({ cursors: 0, counted: 0 });

    // Uma hora depois: relê as pastas, mas só mede o objeto novo; o total do dia é regravado (absoluto).
    s3.put('trilha-a', {
      key: ct('2026/11/11', 'tarde'),
      size: 10,
      lastModified: new Date('2026-11-11T15:40:00Z'),
      isize: 100,
    });
    now = new Date(now.getTime() + HOUR);
    expect(await task.runOnce()).toMatchObject({ cursors: 1, counted: 1, fallbacks: 0 });
    expect(s3.tails).toBe(4);
    expect((await daysOf(tenant)).at(-1)).toEqual({ day: '2026-11-11', bytes: BigInt(3_000 + 500 + 100) });
    expect(await monthOf(tenant)).toEqual([
      { month: '2026-11-01', bytes: BigInt(1_500 + 3_000 + 500 + 100) },
    ]);

    // Outra instância da tarefa (outra réplica, ou o cursor perdido) não conta nada de novo.
    await prisma.collectorCursor.updateMany({
      where: { stream: volumeCursorStream('cloudtrail'), cloudAccount: { tenantId: tenant } },
      data: { cursorAt: null, nextRunAt: now },
    });
    expect(await audit(identity, () => now, [tenant]).runOnce()).toMatchObject({ counted: 0 });
    expect(await monthOf(tenant)).toEqual([
      { month: '2026-11-01', bytes: BigInt(1_500 + 3_000 + 500 + 100) },
    ]);
    // O total do dia continua o mesmo, mesmo se alguém o tivesse mexido: a releitura regrava a soma.
    await prisma.ingestUsageDay.updateMany({
      where: { tenantId: tenant, source: 'aws' },
      data: { bytes: 1n },
    });
    await prisma.collectorCursor.updateMany({
      where: { stream: volumeCursorStream('cloudtrail'), cloudAccount: { tenantId: tenant } },
      data: { nextRunAt: now },
    });
    await task.runOnce();
    expect(await daysOf(tenant)).toEqual([
      { day: '2026-11-10', bytes: 1_500n },
      { day: '2026-11-11', bytes: BigInt(3_000 + 500 + 100) },
    ]);
  });

  it('atribuição: cada cliente com a própria identidade e os próprios buckets; trilha de organização, GuardDuty e WAF', async () => {
    const tenantA = await createTenant(app, 'Cliente Demo A (fontes)');
    const tenantB = await createTenant(app, 'Cliente Demo B (fontes)');
    const meteredFrom = new Date('2026-11-01T00:00:00Z');
    const a = await account(tenantA, meteredFrom, {
      cloudtrailBucket: 'org-a',
      guarddutyBucket: 'gd-a',
      wafBucket: 'waf-a',
    });
    const b = await account(tenantB, meteredFrom, { cloudtrailBucket: 'trilha-b' });
    const when = new Date('2026-11-05T15:00:00Z');
    const s3A = new FakeS3();
    s3A.put('org-a', {
      key: `AWSLogs/o-abcdefghij/${a.accountId}/CloudTrail/sa-east-1/2026/11/05/t.json.gz`,
      size: 10,
      lastModified: when,
      isize: 100,
    });
    s3A.put('gd-a', {
      key: `AWSLogs/${a.accountId}/GuardDuty/sa-east-1/2026/11/05/f.jsonl.gz`,
      size: 10,
      lastModified: when,
      isize: 200,
    });
    s3A.put('waf-a', {
      key: `AWSLogs/${a.accountId}/WAFLogs/sa-east-1/loja-acl/2026/11/05/15/00/w.log.gz`,
      size: 10,
      lastModified: when,
      isize: 400,
    });
    s3A.put('waf-a', {
      key: `AWSLogs/${a.accountId}/WAFLogs/cloudfront/site-acl/2026/11/05/15/00/w.log.gz`,
      size: 10,
      lastModified: when,
      isize: 800,
    });
    const s3B = new FakeS3();
    s3B.put('trilha-b', {
      key: `AWSLogs/${b.accountId}/CloudTrail/sa-east-1/2026/11/05/t.json.gz`,
      size: 10,
      lastModified: when,
      isize: 7_000,
    });
    const identity = new FakeIdentity();
    identity.s3.set(tenantA, s3A);
    identity.s3.set(tenantB, s3B);
    const now = new Date('2026-11-05T16:00:00Z');

    const report = await audit(identity, () => now, [tenantA, tenantB]).runOnce();
    expect(report).toMatchObject({ accounts: 2, failed: 0, counted: 5 });
    expect(await daysOf(tenantA)).toEqual([{ day: '2026-11-05', bytes: 1_500n }]);
    expect(await daysOf(tenantB)).toEqual([{ day: '2026-11-05', bytes: 7_000n }]);
    // A identidade pedida para cada conta é a do cliente dela.
    expect(new Set(identity.asked)).toEqual(new Set([tenantA, tenantB]));
    const streams = await prisma.collectorCursor.findMany({
      where: { cloudAccountId: a.id },
      select: { stream: true, region: true },
      orderBy: [{ stream: 'asc' }, { region: 'asc' }],
    });
    expect(streams).toEqual([
      { stream: 'aws_volume_cloudtrail', region: 'sa-east-1' },
      { stream: 'aws_volume_guardduty', region: 'sa-east-1' },
      { stream: 'aws_volume_waf', region: 'cloudfront' },
      { stream: 'aws_volume_waf', region: 'sa-east-1' },
    ]);
  });

  it('na célula, até o CE-11: sem identidade de cliente, nada é pedido à AWS', async () => {
    const tenant = await createTenant(app, 'Cliente Demo C (sem identidade)');
    await account(tenant, new Date('2026-11-01T00:00:00Z'), { cloudtrailBucket: 'trilha-c' });
    let built = 0;
    const task = new AwsVolumeAudit(
      prisma,
      pendingCellIdentity(),
      () => {
        built += 1;
        throw new Error('não deveria criar o S3');
      },
      { now: () => new Date('2026-11-05T16:00:00Z'), tenantIds: [tenant] },
    );
    expect(await task.runOnce()).toMatchObject({
      accounts: 1,
      identityUnavailable: 1,
      cursors: 0,
      counted: 0,
    });
    expect(built).toBe(0);
    expect(await daysOf(tenant)).toEqual([]);
  });

  it('atraso, limite de leituras, falha da AWS e cliente fora de active', async () => {
    const tenant = await createTenant(app, 'Cliente Demo D (recuperação)');
    const { accountId } = await account(tenant, new Date('2026-10-01T00:00:00Z'), {
      cloudtrailBucket: 'trilha-d',
    });
    const s3 = new FakeS3();
    const days = Array.from({ length: 10 }, (_, index) => `2026/10/${String(index + 1).padStart(2, '0')}`);
    for (const day of days) {
      for (const name of ['a', 'b', 'c']) {
        s3.put('trilha-d', {
          key: `AWSLogs/${accountId}/CloudTrail/sa-east-1/${day}/${name}.json.gz`,
          size: 10,
          lastModified: new Date(`${day.replaceAll('/', '-')}T12:00:00Z`),
          isize: 100,
        });
      }
    }
    const identity = new FakeIdentity();
    identity.s3.set(tenant, s3);
    const now = new Date('2026-10-10T18:00:00Z');
    // No máximo 16 leituras de objeto por execução (lotes de 8): a recuperação segue na execução seguinte.
    const task = audit(identity, () => now, [tenant], 16);
    expect(await task.runOnce()).toMatchObject({ counted: 16 });
    const cursor = () =>
      prisma.collectorCursor.findFirstOrThrow({
        where: { stream: volumeCursorStream('cloudtrail'), cloudAccount: { tenantId: tenant } },
      });
    expect((await cursor()).nextRunAt).toEqual(now);
    let total = 16;
    for (let run = 0; run < 5 && total < 30; run += 1) total += (await task.runOnce()).counted;
    expect(total).toBe(30);
    expect((await daysOf(tenant)).length).toBe(10);
    expect((await cursor()).nextRunAt.getTime()).toBe(now.getTime() + HOUR);

    // Falha da AWS: o cursor guarda o tipo do erro e recua.
    s3.failing = 'trilha-d';
    await prisma.collectorCursor.updateMany({
      where: { stream: volumeCursorStream('cloudtrail'), cloudAccount: { tenantId: tenant } },
      data: { nextRunAt: now },
    });
    expect(await task.runOnce()).toMatchObject({ failed: 1 });
    expect(await cursor()).toMatchObject({ lastErrorKind: 'AccessDenied', failures: 1 });

    // Cliente suspenso: fora da medição.
    await setTenantLifecycleStatus(prisma, tenant, 'suspended');
    expect(await task.runOnce()).toMatchObject({ accounts: 0 });
  });
});
