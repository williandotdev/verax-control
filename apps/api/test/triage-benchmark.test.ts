import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FindingDraft } from '../src/alerts/finding-draft.js';
import { FindingStore } from '../src/alerts/finding-store.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { createTenant } from './support/auth-helpers.js';
import { assignAll, casesOf, cleanCases } from './support/cases.js';
import { createApp } from './support/create-app.js';
import {
  expectNoDrift,
  operate,
  operation,
  type Operator,
  operatorFor,
  statusRequest,
  triageJob,
  undo,
} from './support/triage.js';

/**
 * Medição de carga da triagem em massa, fora do CI: só roda com `CASES_BENCH=1`
 * (`CASES_BENCH=1 pnpm --filter @verax/api exec vitest run test/triage-benchmark.test.ts --silent=false`).
 * 24 mil alertas pendentes (`CASES_BENCH_ALERTS`) em centenas de casos, numa tabela com 200 mil a mais, e um coletor
 * gravando sem parar: o tempo do pedido, o de cada lote com o lock do cliente na mão e o que o coletor espera.
 */
const ALERTS = Number(process.env['CASES_BENCH_ALERTS'] ?? 24_000);
const OTHERS = Number(process.env['CASES_BENCH_OTHERS'] ?? 200_000);

function percentiles(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (share: number) =>
    Math.round((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0) * 10) / 10;
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
}

describe.skipIf(process.env['CASES_BENCH'] !== '1')('medição de carga da triagem em massa', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let who: Operator;
  const lines: Record<string, unknown> = {};

  const seed = (count: number, marker: string, status: string, offset: number) => prisma.$executeRaw`
    INSERT INTO "Finding" ("id", "tenantId", "accountId", "source", "sourceEventId", "logSource", "occurredAt",
      "severity", "status", "ruleId", "ruleLevel", "title", "eventName", "resource", "caseGroup",
      "mitreTactics", "mitreTechniques", "createdAt", "updatedAt")
    SELECT gen_random_uuid(), ${tenantId}::uuid, '111122223333', 'aws', ${marker}::text || n, 'inspector',
      now() - interval '1 day' + n * interval '1 millisecond',
      (ARRAY['high', 'medium', 'low'])[1 + n % 3]::"FindingSeverity", ${status}::text::"FindingStatus", '990511', 10,
      'CVE-2026-' || n || ' - pacote-' || (n % 40), 'CVE-2026-' || n, 'ec2:i-' || lpad(((n / 40) % 30)::text, 17, '0'),
      'pacote-' || (n % 40), '{}', '{}',
      now() - interval '1 day' + (n + ${offset}::integer) * interval '1 millisecond', now() - interval '1 day'
    FROM generate_series(1, ${count}::integer) AS n`;

  const draft = (): FindingDraft => ({
    tenantId,
    accountId: '111122223333',
    source: 'wazuh',
    sourceEventId: `carga-coletor-${randomUUID()}`,
    occurredAt: new Date().toISOString(),
    severity: 'low',
    ruleId: '100305',
    ruleLevel: 3,
    title: 'Alerta de carga',
    logSource: 'cloudtrail',
    eventName: null,
    region: null,
    resource: null,
    actorUser: 'coletor',
    actorType: null,
    accessKeyId: null,
    sourceIp: null,
    mitreTactics: [],
    mitreTechniques: [],
  });
  const persist = async (store: FindingStore): Promise<number> => {
    const startedAt = performance.now();
    await store.persist(draft(), null, new Date());
    return performance.now() - startedAt;
  };

  /** Roda um trabalho com um coletor gravando ao mesmo tempo. */
  async function whileCollecting<T>(
    work: () => Promise<T>,
  ): Promise<{ result: T; waits: number[]; ms: number }> {
    const store = new FindingStore(prisma);
    const waits: number[] = [];
    let running = true;
    const collector = (async () => {
      while (running) waits.push(await persist(store));
    })();
    const startedAt = performance.now();
    const result = await work();
    const ms = performance.now() - startedAt;
    running = false;
    await collector;
    return { result, waits, ms };
  }

  /** A fila inteira, com a pausa de produção, e o que cada lote segurou o lock do cliente. */
  async function runQueue(name: string): Promise<void> {
    const locks: number[] = [];
    const { waits, ms } = await whileCollecting(async () => {
      const report = await triageJob(prisma, [tenantId], {
        pauseMs: 100,
        workMs: 600_000,
        onBatch: ({ lockMs }) => void locks.push(lockMs),
      }).runOnce();
      expect(report).toMatchObject({ status: 'done', stalled: 0, isolated: 0 });
    });
    lines[name] = {
      totalMs: Math.round(ms),
      lotes: locks.length,
      lockMs: percentiles(locks),
      coletorMs: percentiles(waits),
    };
  }

  beforeAll(async () => {
    app = await createApp({ casesMode: 'on' });
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
    tenantId = await createTenant(app, 'Cliente Demo (carga da triagem)');
    who = await operatorFor(app, tenantId, 'admin_cliente');
    await seed(OTHERS, 'antigo-', 'resolved', -OTHERS * 2);
    await seed(ALERTS, 'novo-', 'new', 0);
    await prisma.$executeRaw`ANALYZE "Finding"`;
    await assignAll(prisma, [tenantId], { workMs: 3_600_000 });
    await prisma.$executeRaw`ANALYZE "AlertCase"`;
    lines['casos'] = (await casesOf(prisma, tenantId)).length;
  }, 1_200_000);

  afterAll(async () => {
    console.log(JSON.stringify(lines, null, 2));
    await prisma.triageOperationItem.deleteMany({ where: { tenantId } });
    await cleanCases(prisma, [tenantId]);
    await app.close();
  }, 1_200_000);

  it('24 mil alertas: status, desfazer, promover e desfazer', { timeout: 3_600_000 }, async () => {
    const alone: number[] = [];
    const store = new FindingStore(prisma);
    for (let index = 0; index < 300; index += 1) alone.push(await persist(store));
    lines['coletor sozinho'] = percentiles(alone);

    const filter = { queue: 'vulnerability', source: 'inspector' };
    const request = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
      const startedAt = performance.now();
      const result = await work();
      lines[name] = Math.round(performance.now() - startedAt);
      return result;
    };
    const made = await request('pedido de status (ms)', () =>
      operate(app, who, statusRequest({ filter }, ALERTS), 202),
    );
    expect(made.matched).toBe(ALERTS);
    const { target } = await prisma.triageOperation.findUniqueOrThrow({ where: { id: made.id } });
    lines['alvo congelado (KB de JSON)'] = Math.round(JSON.stringify(target).length / 1024);
    await runQueue('status');
    expect(await operation(app, who, made.id)).toMatchObject({ state: 'done', changed: ALERTS, skipped: 0 });

    const undone = await request('pedido de desfazer (ms)', () => undo(app, who, made.id, 202));
    await runQueue('desfazer');
    expect(await operation(app, who, undone.id)).toMatchObject({ state: 'done', changed: ALERTS });

    const promoted = await request('pedido de promover (ms)', () =>
      operate(app, who, { ...statusRequest({ filter }, ALERTS), action: 'promote', status: undefined }, 202),
    );
    await runQueue('promover');
    expect(await operation(app, who, promoted.id)).toMatchObject({ state: 'done', changed: ALERTS });
    const detached = await request('pedido de desfazer o promover (ms)', () =>
      undo(app, who, promoted.id, 202),
    );
    await runQueue('desfazer o promover');
    expect(await operation(app, who, detached.id)).toMatchObject({ state: 'done', changed: ALERTS - 1 });
    await expectNoDrift(prisma, [tenantId]);
  });

  it('200 alertas na requisição, com o coletor gravando: cabe nos 15 s', { timeout: 600_000 }, async () => {
    const times: number[] = [];
    const undos: number[] = [];
    const { waits } = await whileCollecting(async () => {
      for (let round = 0; round < 25; round += 1) {
        const rows = await prisma.finding.findMany({
          where: { tenantId, status: 'new', incidentId: null, logSource: 'inspector' },
          select: { id: true },
          take: 200,
          skip: round * 200,
        });
        const findingIds = rows.map((row) => row.id);
        let startedAt = performance.now();
        const made = await operate(app, who, statusRequest({ findingIds }, 200));
        times.push(performance.now() - startedAt);
        expect(made.changed).toBe(200);
        startedAt = performance.now();
        await undo(app, who, made.id);
        undos.push(performance.now() - startedAt);
      }
    });
    lines['200 na requisição (ms)'] = percentiles(times);
    lines['desfazer 200 na requisição (ms)'] = percentiles(undos);
    lines['coletor com as de 200'] = percentiles(waits);
    expect(Math.max(...times, ...undos)).toBeLessThan(15_000);
  });
});
