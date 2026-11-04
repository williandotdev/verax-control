import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { TenantScopeViolation } from '../src/common/prisma/tenant-scope.js';
import { UsageMeter } from '../src/usage/usage-meter.js';
import { createTenant } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('medidor de uso (IngestUsage)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;

  /** Uso gravado de um cliente, lido pelo escopo dele, como a API vai ler. */
  const usageOf = async (tenantId: string) =>
    (
      await prisma.forTenant(tenantId).ingestUsage.findMany({
        orderBy: [{ month: 'asc' }, { source: 'asc' }],
      })
    ).map((row) => ({
      tenantId: row.tenantId,
      month: row.month.toISOString().slice(0, 10),
      source: row.source,
      bytes: row.bytes,
      events: row.events,
    }));

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente Demo A (uso)');
    tenantB = await createTenant(app, 'Cliente Demo B (uso)');
  });

  afterAll(async () => {
    await app.close();
  });

  it('soma por cliente, mês e fonte; cada gravação incrementa a linha do mês', async () => {
    const tenantId = await createTenant(app, 'Cliente Demo (soma)');
    const at = new Date('2026-11-10T15:00:00.000Z');
    const meter = new UsageMeter();
    meter.add(tenantId, 'gcp', 1000, 1, at);
    meter.add(tenantId, 'gcp', 500, 1, at);
    meter.add(tenantId, 'aws', 2048, 3, at);
    await meter.flush(prisma);
    expect(meter.isEmpty).toBe(true);
    expect(await usageOf(tenantId)).toEqual([
      { tenantId, month: '2026-11-01', source: 'aws', bytes: 2048n, events: 3n },
      { tenantId, month: '2026-11-01', source: 'gcp', bytes: 1500n, events: 2n },
    ]);

    // Outra execução no mesmo mês: soma na mesma linha. Gravar de novo sem nada novo não muda nada.
    meter.add(tenantId, 'gcp', 250, 1, at);
    await meter.flush(prisma);
    await meter.flush(prisma);
    expect(await usageOf(tenantId)).toContainEqual({
      tenantId,
      month: '2026-11-01',
      source: 'gcp',
      bytes: 1750n,
      events: 3n,
    });
  });

  it('a virada do mês às 03:00 UTC cria a linha do mês novo', async () => {
    const tenantId = await createTenant(app, 'Cliente Demo (virada)');
    const meter = new UsageMeter();
    meter.add(tenantId, 'gcp', 100, 1, new Date('2026-12-01T02:59:59.999Z'));
    meter.add(tenantId, 'gcp', 200, 2, new Date('2026-12-01T03:00:00.000Z'));
    await meter.flush(prisma);
    expect(await usageOf(tenantId)).toEqual([
      { tenantId, month: '2026-11-01', source: 'gcp', bytes: 100n, events: 1n },
      { tenantId, month: '2026-12-01', source: 'gcp', bytes: 200n, events: 2n },
    ]);
  });

  it('o volume passa do inteiro de 32 bits sem perder precisão (BigInt)', async () => {
    const tenantId = await createTenant(app, 'Cliente Demo (volume)');
    const fiveGib = 5 * 1024 ** 3;
    const meter = new UsageMeter();
    meter.add(tenantId, 'aws', fiveGib, 1_000_000, new Date('2026-11-15T12:00:00.000Z'));
    await meter.flush(prisma);
    meter.add(tenantId, 'aws', fiveGib, 1_000_000, new Date('2026-11-16T12:00:00.000Z'));
    await meter.flush(prisma);
    expect(await usageOf(tenantId)).toEqual([
      { tenantId, month: '2026-11-01', source: 'aws', bytes: BigInt(2 * fiveGib), events: 2_000_000n },
    ]);
  });

  it('A/B: o uso do cliente B nunca conta para o A, nem na mesma gravação', async () => {
    const at = new Date('2026-10-20T12:00:00.000Z');
    const meter = new UsageMeter();
    meter.add(tenantA, 'gcp', 111, 1, at);
    meter.add(tenantB, 'gcp', 999_999, 50, at);
    meter.add(tenantB, 'cloudflare', 4096, 2, at);
    await meter.flush(prisma);

    expect(await usageOf(tenantA)).toEqual([
      { tenantId: tenantA, month: '2026-10-01', source: 'gcp', bytes: 111n, events: 1n },
    ]);
    expect(await usageOf(tenantB)).toEqual([
      { tenantId: tenantB, month: '2026-10-01', source: 'cloudflare', bytes: 4096n, events: 2n },
      { tenantId: tenantB, month: '2026-10-01', source: 'gcp', bytes: 999_999n, events: 50n },
    ]);
    // Pelo escopo de A, a linha de B não existe, nem pedindo pela chave dela.
    expect(
      await prisma.forTenant(tenantA).ingestUsage.findUnique({
        where: { tenantId_month_source: { tenantId: tenantB, month: day('2026-10-01'), source: 'gcp' } },
      }),
    ).toBeNull();
  });

  it('A/B: o escopo de A não grava nem altera a linha de B', async () => {
    const month = day('2026-09-01');
    await prisma.forTenant(tenantB).ingestUsage.create({
      data: { tenantId: tenantB, month, source: 'gcp', bytes: 10n, events: 1n },
    });
    expect(() =>
      prisma.forTenant(tenantA).ingestUsage.upsert({
        where: { tenantId_month_source: { tenantId: tenantB, month, source: 'gcp' } },
        create: { tenantId: tenantB, month, source: 'gcp', bytes: 1n, events: 1n },
        update: { bytes: { increment: 1n } },
      }),
    ).toThrow(TenantScopeViolation);
    expect(
      await prisma.forTenant(tenantA).ingestUsage.updateMany({
        where: { month, source: 'gcp' },
        data: { bytes: { increment: 1000n } },
      }),
    ).toEqual({ count: 0 });
    expect(await usageOf(tenantB)).toContainEqual({
      tenantId: tenantB,
      month: '2026-09-01',
      source: 'gcp',
      bytes: 10n,
      events: 1n,
    });
  });

  it('o banco recusa mês fora do primeiro dia e contador negativo', async () => {
    const tenantId = await createTenant(app, 'Cliente Demo (regras)');
    await expect(
      prisma.ingestUsage.create({
        data: { tenantId, month: day('2026-11-15'), source: 'gcp', bytes: 1n, events: 1n },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.ingestUsage.create({
        data: { tenantId, month: day('2026-11-01'), source: 'gcp', bytes: -1n, events: 1n },
      }),
    ).rejects.toThrow();
    expect(await usageOf(tenantId)).toEqual([]);
  });
});
