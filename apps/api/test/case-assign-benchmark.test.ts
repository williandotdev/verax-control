import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { FindingStore } from '../src/alerts/finding-store.js';
import { CaseAssignJob } from '../src/cases/case-assign-job.js';
import { CaseReconcileJob } from '../src/cases/case-reconcile-job.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { cleanCases } from './support/cases.js';

/**
 * Medição de carga da atribuição dos casos, fora do CI: só roda com `CASES_BENCH=1`
 * (`CASES_BENCH=1 pnpm --filter @verax/api exec vitest run test/case-assign-benchmark.test.ts --silent=false`).
 * Semeia 250 mil alertas (`CASES_BENCH_ROWS`) e mede o tempo de cada lote, o tempo com o lock do cliente na mão e o que
 * um coletor espera para gravar enquanto a fila é atribuída.
 */
const ROWS = Number(process.env['CASES_BENCH_ROWS'] ?? 250_000);

function percentiles(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (share: number) =>
    Math.round((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0) * 10) / 10;
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
}

describe.skipIf(process.env['CASES_BENCH'] !== '1')('medição de carga do case-assign', () => {
  let prisma: PrismaService;
  let tenantId: string;

  beforeAll(async () => {
    prisma = new PrismaService({ DATABASE_URL: inject('testDatabaseUrl') });
    tenantId = (await prisma.tenant.create({ data: { name: 'Cliente Demo (medição de carga)' } })).id;
    // A mistura: 40% pacotes do Inspector (30 instâncias, 40 pacotes), 25% controles do Security Hub, 10% GuardDuty,
    // 10% CloudTrail, 10% flow logs de muitas redes e 5% de login em instância, ao longo de 30 dias.
    await prisma.$executeRaw`
      INSERT INTO "Finding" ("id", "tenantId", "accountId", "source", "sourceEventId", "logSource", "occurredAt",
        "severity", "ruleId", "ruleLevel", "title", "eventName", "resource", "actorUser", "sourceIp", "caseGroup",
        "mitreTactics", "mitreTechniques", "createdAt", "updatedAt")
      SELECT gen_random_uuid(), ${tenantId}::uuid, '111122223333',
        CASE WHEN n % 100 < 65 THEN 'aws' ELSE 'wazuh' END, 'carga-' || n,
        CASE WHEN n % 100 < 40 THEN 'inspector' WHEN n % 100 < 65 THEN 'security_hub' WHEN n % 100 < 75 THEN 'guardduty'
          WHEN n % 100 < 85 THEN 'cloudtrail' WHEN n % 100 < 95 THEN 'vpc_flow' ELSE 'wazuh_agent' END,
        now() - interval '30 days' + n * (interval '30 days' / ${ROWS}::integer),
        (ARRAY['critical', 'high', 'medium', 'low'])[1 + (n / 100) % 4]::"FindingSeverity",
        CASE WHEN n % 100 < 40 THEN '990511' WHEN n % 100 < 65 THEN '990501' WHEN n % 100 < 75 THEN '80303'
          WHEN n % 100 < 85 THEN '10030' || (n % 5) WHEN n % 100 < 95 THEN '100400' ELSE '5763' END,
        10, 'Alerta de carga ' || n,
        CASE WHEN n % 100 < 65 THEN 'S3.' || ((n / 100) % 30) WHEN n % 100 < 75 THEN 'Recon:EC2/Portscan' END,
        'ec2:i-' || lpad((n % 30)::text, 17, '0'),
        CASE WHEN n % 100 BETWEEN 75 AND 84 THEN 'pessoa-' || ((n / 100) % 20) END,
        CASE WHEN n % 100 >= 85 THEN '203.' || (n % 250) || '.113.7' END,
        CASE WHEN n % 100 < 40 THEN 'pacote-' || ((n / 100) % 40) END,
        '{}', '{}',
        now() - interval '30 days' + n * (interval '30 days' / ${ROWS}::integer), now()
      FROM generate_series(1, ${ROWS}::integer) AS n`;
    await prisma.$executeRaw`ANALYZE "Finding"`;
  }, 600_000);

  afterAll(async () => {
    if (tenantId !== undefined) await cleanCases(prisma, [tenantId]);
    await prisma.$disconnect();
  }, 600_000);

  it('a fila inteira, com um coletor gravando ao mesmo tempo', { timeout: 3_600_000 }, async () => {
    const batches: { rows: number; totalMs: number; lockMs: number }[] = [];
    const job = new CaseAssignJob(prisma, {
      name: `carga-${randomBytes(6).toString('hex')}`,
      tenantIds: [tenantId],
      onBatch: (batch) => void batches.push(batch),
    });
    const store = new FindingStore(prisma);
    const persist = async (index: number): Promise<number> => {
      const startedAt = performance.now();
      await store.persist(
        {
          tenantId,
          accountId: '111122223333',
          source: 'wazuh',
          sourceEventId: `carga-coletor-${index}-${randomUUID()}`,
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
        },
        null,
        new Date(),
      );
      return performance.now() - startedAt;
    };
    const alone: number[] = [];
    for (let index = 0; index < 300; index += 1) alone.push(await persist(index));

    const during: number[] = [];
    let running = true;
    const collector = (async () => {
      for (let index = 300; running; index += 1) during.push(await persist(index));
    })();
    const startedAt = performance.now();
    let ticks = 0;
    let assigned = 0;
    let tickMs = 0;
    for (;;) {
      const tickStartedAt = performance.now();
      const report = await job.runOnce();
      tickMs = Math.max(tickMs, performance.now() - tickStartedAt);
      expect(report).toMatchObject({ status: 'done', failedTenants: 0, quarantined: 0 });
      ticks += 1;
      assigned += report.assigned;
      if (report.unfinishedTenants === 0) break;
    }
    const drainedMs = performance.now() - startedAt;
    running = false;
    await collector;
    const idleStartedAt = performance.now();
    await job.runOnce();
    await job.runOnce();
    const idleMs = (performance.now() - idleStartedAt) / 2;

    const cases = await prisma.alertCase.count({ where: { tenantId } });
    const reconcileStartedAt = performance.now();
    const reconcile = await new CaseReconcileJob(prisma, {
      tenantIds: [tenantId],
      name: `carga-${randomBytes(6).toString('hex')}`,
      maxRunMs: 600_000,
    }).runOnce();
    const reconcileMs = performance.now() - reconcileStartedAt;

    const tenth = Math.floor(batches.length / 10);
    const lines = {
      alertas: ROWS,
      atribuidos: assigned,
      casos: cases,
      lotes: batches.length,
      passagens: ticks,
      filaInteiraSegundos: Math.round(drainedMs / 1000),
      // Cada passagem trabalha até 2 s e espera 10 s: é o tempo de verdade no nó.
      estimativaNoNoMinutos: Math.round((ticks * 10_000 + drainedMs) / 60_000),
      passagemMaisLongaMs: Math.round(tickMs),
      passagemSemFilaMs: Math.round(idleMs * 10) / 10,
      loteMs: percentiles(batches.map((batch) => batch.totalMs)),
      lockMs: percentiles(batches.map((batch) => batch.lockMs)),
      lockMsPrimeiroDecimo: percentiles(batches.slice(0, tenth).map((batch) => batch.lockMs)),
      lockMsUltimoDecimo: percentiles(batches.slice(-tenth).map((batch) => batch.lockMs)),
      coletorSozinhoMs: percentiles(alone),
      coletorDuranteMs: percentiles(during),
      conferencia: { ...reconcile, segundos: Math.round(reconcileMs / 100) / 10 },
    };
    process.stdout.write(`\nmedição de carga: ${JSON.stringify(lines, null, 2)}\n`);
    expect(assigned).toBeGreaterThanOrEqual(ROWS);
    expect(reconcile).toMatchObject({ status: 'done', drifted: 0, failed: 0 });
    expect(
      await prisma.finding.count({
        where: { tenantId, caseId: null, status: { in: ['new', 'investigating'] } },
      }),
    ).toBeLessThan(200);
  });
});
