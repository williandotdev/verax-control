import 'reflect-metadata';
import { randomInt } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { usageDailyReportSchema } from '@verax/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { TenantScopeViolation } from '../src/common/prisma/tenant-scope.js';
import { GcpAuditSync, publishedAt } from '../src/gcp/gcp-audit-sync.js';
import type { PubsubMessage, PubsubReader } from '../src/gcp/pubsub.client.js';
import { usageDailyReports } from '../src/usage/usage-daily.js';
import { UsageMeter } from '../src/usage/usage-meter.js';
import { auditEntry, pubsubMessage } from './gcp/fixtures.js';
import { createTenant } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));

/** Os arquivos `.ts` de `src`, sem o client gerado do Prisma e sem os testes. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'generated' ? [] : sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

const WRITE_OPERATIONS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
]);

/** Quem grava o model, pela busca no código-fonte (`<model>.<escrita>`). */
function writersOf(model: string): string[] {
  const writes = (text: string): boolean =>
    [...text.matchAll(/(\w+)\s*\.\s*(\w+)\s*\(/g)].some(
      ([, name, operation]) => name === model && WRITE_OPERATIONS.has(operation ?? ''),
    );
  return sourceFiles(srcDir)
    .filter((file) => writes(readFileSync(file, 'utf8')))
    .map((file) => relative(srcDir, file).split(sep).join('/'))
    .sort();
}

/** Pub/Sub falso: cada assinatura entrega o que foi publicado nela e some com o que foi confirmado. */
class FakePubsub implements PubsubReader {
  private readonly queues = new Map<string, PubsubMessage[]>();
  publish(subscription: string, ...messages: PubsubMessage[]): void {
    this.queues.set(subscription, [...(this.queues.get(subscription) ?? []), ...messages]);
  }
  pull(subscription: string, max: number): Promise<PubsubMessage[]> {
    return Promise.resolve((this.queues.get(subscription) ?? []).slice(0, max));
  }
  acknowledge(subscription: string, ackIds: readonly string[]): Promise<void> {
    this.queues.set(
      subscription,
      (this.queues.get(subscription) ?? []).filter((message) => !ackIds.includes(message.ackId)),
    );
    return Promise.resolve();
  }
}

describe('volume por dia (CE-09): IngestUsageDay e o relatório usage.daily', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  /** O volume por dia do cliente, lido pelo escopo dele. */
  const daysOf = async (tenantId: string) =>
    (
      await prisma
        .forTenant(tenantId)
        .ingestUsageDay.findMany({ orderBy: [{ day: 'asc' }, { source: 'asc' }] })
    ).map((row) => ({
      day: row.day.toISOString().slice(0, 10),
      source: row.source,
      bytes: row.bytes,
      events: row.events,
    }));

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('o dia é o de Brasília do registro: 02:59 UTC é a véspera, 03:00 UTC é o dia; o mês continua pela leitura', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (dia de Brasília)');
    const meter = new UsageMeter();
    const readAt = new Date('2026-12-01T12:00:00.000Z');
    meter.add(tenant, 'gcp', 300, 3, readAt);
    meter.addDaily(tenant, 'gcp', 100, 1, new Date('2026-12-01T02:59:59.999Z'));
    meter.addDaily(tenant, 'gcp', 200, 2, new Date('2026-12-01T03:00:00.000Z'));
    await meter.flush(prisma);
    expect(meter.isEmpty).toBe(true);
    expect(await daysOf(tenant)).toEqual([
      { day: '2026-11-30', source: 'gcp', bytes: 100n, events: 1n },
      { day: '2026-12-01', source: 'gcp', bytes: 200n, events: 2n },
    ]);
    const month = await prisma
      .forTenant(tenant)
      .ingestUsage.findMany({ select: { month: true, bytes: true } });
    expect(month).toEqual([{ month: new Date('2026-12-01T00:00:00Z'), bytes: 300n }]);

    // Outra leitura do mesmo dia soma na mesma linha.
    const again = new UsageMeter();
    again.addDaily(tenant, 'gcp', 50, 1, new Date('2026-12-01T10:00:00.000Z'));
    await again.flush(prisma);
    expect((await daysOf(tenant)).at(-1)).toEqual({
      day: '2026-12-01',
      source: 'gcp',
      bytes: 250n,
      events: 3n,
    });
  });

  it('GCP: a mensagem conta no dia do publishTime, não no da leitura; A/B pela assinatura', async () => {
    const tenantA = await createTenant(app, 'Cliente Demo A (publishTime)');
    const tenantB = await createTenant(app, 'Cliente Demo B (publishTime)');
    const project = `vx-${randomInt(1_000_000, 9_999_999)}-dia`;
    const subscription = `projects/projeto-no/subscriptions/verax-node-security-${project}`;
    await prisma.cloudAccount.create({
      data: {
        tenantId: tenantA,
        provider: 'gcp',
        accountId: project,
        regions: [],
        pubsubSubscription: subscription,
      },
    });
    const pubsub = new FakePubsub();
    // Publicada às 23:59 de Brasília do dia 10, lida às 00:30 do dia 11.
    const late = { ...pubsubMessage(auditEntry({ project, methodName: 'v1.compute.instances.list' })) };
    late.publishTime = '2026-11-11T02:59:00.123456Z';
    const onTime = { ...pubsubMessage(auditEntry({ project, methodName: 'v1.compute.instances.get' })) };
    onTime.publishTime = '2026-11-11T03:20:00Z';
    // Sem publishTime: o dia da leitura.
    const without = pubsubMessage(auditEntry({ project, methodName: 'v1.compute.disks.list' }));
    pubsub.publish(subscription, late, onTime, without);
    const sync = new GcpAuditSync(prisma, pubsub, { name: `gcp-dia-${project}`, pullSize: 10 });
    await sync.runOnce(new Date('2026-11-11T03:30:00.000Z'));

    const size = (message: PubsubMessage) => BigInt(Buffer.from(message.data ?? '', 'base64').length);
    expect(await daysOf(tenantA)).toEqual([
      { day: '2026-11-10', source: 'gcp', bytes: size(late), events: 1n },
      { day: '2026-11-11', source: 'gcp', bytes: size(onTime) + size(without), events: 2n },
    ]);
    expect(await daysOf(tenantB)).toEqual([]);
    // O publishTime fora do formato vale como ausente.
    const now = new Date('2026-11-11T12:00:00Z');
    expect(publishedAt({ publishTime: 'ontem' }, now)).toBe(now);
  });

  it('usage.daily: valores absolutos, todas as fontes, idempotente; final só depois das 06:00 de Brasília do dia seguinte', async () => {
    const tenantA = await createTenant(app, 'Cliente Demo A (usage.daily)');
    const tenantB = await createTenant(app, 'Cliente Demo B (usage.daily)');
    const meter = new UsageMeter();
    meter.addDaily(tenantA, 'gcp', 1_000, 4, new Date('2026-11-10T15:00:00Z'));
    meter.addDaily(tenantA, 'cloudflare', 500, 2, new Date('2026-11-11T15:00:00Z'));
    meter.addDaily(tenantB, 'gcp', 7, 1, new Date('2026-11-11T15:00:00Z'));
    await meter.flush(prisma);
    await prisma.ingestUsageDay.create({
      data: {
        tenantId: tenantA,
        day: new Date('2026-11-11T00:00:00Z'),
        source: 'aws',
        bytes: 9_000n,
        events: 0n,
      },
    });

    // 11/11, 05:59 de Brasília: o dia 10 ainda não fechou.
    const early = new Date('2026-11-11T08:59:00Z');
    const reports = await usageDailyReports(prisma, [tenantA], early);
    expect(reports).toEqual([
      {
        tenantId: tenantA,
        day: '2026-11-10',
        sources: {
          aws: { bytes: 0, events: 0 },
          gcp: { bytes: 1_000, events: 4 },
          cloudflare: { bytes: 0, events: 0 },
        },
        final: false,
      },
      {
        tenantId: tenantA,
        day: '2026-11-11',
        sources: {
          aws: { bytes: 9_000, events: 0 },
          gcp: { bytes: 0, events: 0 },
          cloudflare: { bytes: 500, events: 2 },
        },
        final: false,
      },
    ]);
    for (const report of reports) expect(usageDailyReportSchema.parse(report)).toEqual(report);
    // Chamar de novo, sem leitura nova, dá o mesmo: os valores são absolutos.
    expect(await usageDailyReports(prisma, [tenantA], early)).toEqual(reports);

    // 06:00 de Brasília: o dia 10 fecha; o 11 continua provisório.
    const closed = await usageDailyReports(prisma, [tenantA], new Date('2026-11-11T09:00:00Z'));
    expect(closed.map(({ day, final }) => ({ day, final }))).toEqual([
      { day: '2026-11-10', final: true },
      { day: '2026-11-11', final: false },
    ]);

    // Só os clientes pedidos; o de B só tem o dele.
    const onlyB = await usageDailyReports(prisma, [tenantB], early, { lookbackDays: 0 });
    expect(onlyB).toEqual([
      {
        tenantId: tenantB,
        day: '2026-11-11',
        sources: {
          aws: { bytes: 0, events: 0 },
          gcp: { bytes: 7, events: 1 },
          cloudflare: { bytes: 0, events: 0 },
        },
        final: false,
      },
    ]);
    expect(await usageDailyReports(prisma, [], early)).toEqual([]);
    await expect(usageDailyReports(prisma, [tenantA], early, { lookbackDays: -1 })).rejects.toThrow(
      RangeError,
    );
  });

  it('só o sistema grava o volume por dia: o escopo do cliente lê, mas recusa gravar; e só o medidor e a medição na origem gravam', async () => {
    const tenant = await createTenant(app, 'Cliente Demo C (escopo do dia)');
    const scoped = prisma.forTenant(tenant);
    expect(await scoped.ingestUsageDay.findMany({})).toEqual([]);
    expect(() =>
      scoped.ingestUsageDay.create({
        data: {
          tenantId: tenant,
          day: new Date('2026-11-11T00:00:00Z'),
          source: 'gcp',
          bytes: 1n,
          events: 1n,
        },
      }),
    ).toThrow(TenantScopeViolation);
    expect(() => scoped.ingestUsageDay.deleteMany({})).toThrow(TenantScopeViolation);
    expect(() => scoped.awsVolumeObject.deleteMany({})).toThrow(TenantScopeViolation);

    expect(writersOf('ingestUsageDay')).toEqual(['usage/aws-volume.ts', 'usage/usage-meter.ts']);
    expect(writersOf('awsVolumeObject')).toEqual(['usage/aws-volume.ts']);
    expect(writersOf('nodeUsageDay')).toEqual(['usage/wazuh-usage.ts']);
  });

  it('o banco recusa fonte desconhecida e contador negativo', async () => {
    const tenant = await createTenant(app, 'Cliente Demo D (CHECK do dia)');
    const day = new Date('2026-11-11T00:00:00Z');
    await expect(
      prisma.ingestUsageDay.create({
        data: { tenantId: tenant, day, source: 'azure', bytes: 1n, events: 0n },
      }),
    ).rejects.toThrow(/IngestUsageDay_source_check/);
    await expect(
      prisma.ingestUsageDay.create({
        data: { tenantId: tenant, day, source: 'gcp', bytes: -1n, events: 0n },
      }),
    ).rejects.toThrow(/IngestUsageDay_counters_check/);
  });
});
