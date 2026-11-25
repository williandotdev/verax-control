import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import {
  customer,
  draft,
  HOUR_MS,
  member,
  MINUTE_MS,
  type NoticeWorld,
  noticeWorld,
} from './support/case-notices.js';
import { MemoryMailTransport } from './support/memory-mail.js';
import { createOwnDatabase, type OwnDatabase } from './support/own-database.js';

/**
 * Medição de carga dos avisos por caso, fora do CI: só roda com `CASES_BENCH=1`
 * (`CASES_BENCH=1 pnpm --filter @verax/api exec vitest run test/case-notices-benchmark.test.ts --silent=false`).
 * 60 mil alertas em 3 mil casos de detecção, 10 mil casos de vulnerabilidade, e mais 200 mil alertas tratados e avisos antigos
 * na mesma tabela: quanto leva uma execução (a da virada, a parada e a com novidade) e o que um coletor espera.
 */
const DETECTION = Number(process.env['CASES_BENCH_ALERTS'] ?? 60_000);
const CASES = 3_000;
const VULNERABILITIES = 10_000;
const OLD = Number(process.env['CASES_BENCH_OTHERS'] ?? 200_000);

function percentiles(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (share: number) =>
    Math.round((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0) * 10) / 10;
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: at(1) };
}

describe.skipIf(process.env['CASES_BENCH'] !== '1')('medição de carga dos avisos por caso', () => {
  let database: OwnDatabase;
  let prisma: PrismaService;
  let tenantId: string;
  let world: NoticeWorld;
  const lines: Record<string, unknown> = {};
  const start = new Date();

  const seed = (input: {
    count: number;
    marker: string;
    source: string;
    status: string;
    cases: number;
    minutes: number;
  }) => prisma.$executeRaw`
    INSERT INTO "Finding" ("id", "tenantId", "accountId", "source", "sourceEventId", "logSource", "occurredAt",
      "severity", "status", "ruleId", "ruleLevel", "title", "eventName", "resource", "actorUser", "caseGroup",
      "mitreTactics", "mitreTechniques", "createdAt", "updatedAt")
    SELECT gen_random_uuid(), ${tenantId}::uuid, '111122223333', 'aws', ${input.marker}::text || n, ${input.source}::text,
      now(), (ARRAY['critical', 'high'])[1 + (n % ${input.cases}::integer) % 2]::"FindingSeverity",
      ${input.status}::text::"FindingStatus",
      CASE WHEN ${input.source}::text = 'inspector' THEN '990511' ELSE (100000 + (n % ${input.cases}::integer) % 30)::text END, 10, 'Alerta de carga',
      'CVE-2026-' || n % ${input.cases}::integer, 'ec2:i-' || lpad((n % ${input.cases}::integer)::text, 17, '0'),
      'pessoa-' || (n % ${input.cases}::integer), 'pacote-' || n % ${input.cases}::integer, '{Persistence}', '{}',
      ${start.toISOString()}::timestamptz - make_interval(mins => ${input.minutes}::integer),
      ${start.toISOString()}::timestamptz - make_interval(mins => ${input.minutes}::integer)
    FROM generate_series(1, ${input.count}::integer) AS n`;
  const notice = (marker: string, status: 'sent' | 'pending') => prisma.$executeRaw`
    INSERT INTO "Notification" ("id", "tenantId", "kind", "dedupeKey", "severity", "findingId", "status", "attempts",
      "createdAt", "updatedAt", "nextAttemptAt")
    SELECT gen_random_uuid(), f."tenantId",
      (CASE WHEN f."severity" = 'critical' THEN 'critical_finding' ELSE 'high_finding' END)::"NotificationKind",
      'finding:' || f."id"::text, f."severity", f."id", ${status}::text::"NotificationStatus",
      CASE WHEN ${status}::text = 'sent' THEN 1 ELSE 0 END, f."createdAt", f."createdAt", f."createdAt"
    FROM "Finding" AS f WHERE f."tenantId" = ${tenantId}::uuid AND f."sourceEventId" LIKE ${marker}::text || '%'
      AND f."severity" IN ('critical', 'high')`;

  /** Um trabalho com um coletor gravando ao mesmo tempo: o tempo dele e o que o coletor esperou. */
  async function measure<T>(name: string, work: () => Promise<T>): Promise<T> {
    const waits: number[] = [];
    let running = true;
    const collector = (async () => {
      while (running) {
        const startedAt = performance.now();
        await world.store.persist(
          draft(tenantId, { severity: 'low', sourceEventId: `coletor-${randomUUID()}` }),
          null,
          new Date(),
        );
        waits.push(performance.now() - startedAt);
      }
    })();
    const startedAt = performance.now();
    const result = await work();
    const ms = Math.round(performance.now() - startedAt);
    running = false;
    await collector;
    lines[name] = { ms, coletorMs: percentiles(waits), relatorio: result };
    return result;
  }

  beforeAll(async () => {
    database = await createOwnDatabase('avisos_carga');
    prisma = new PrismaService({ DATABASE_URL: database.url });
    tenantId = await customer(prisma, 'Cliente Demo (carga dos avisos)');
    await member(prisma, tenantId);
    await seed({
      count: OLD,
      marker: 'antigo-',
      source: 'cloudtrail',
      status: 'resolved',
      cases: 5_000,
      minutes: 9_000,
    });
    await notice('antigo-', 'sent');
    await seed({
      count: DETECTION,
      marker: 'det-',
      source: 'cloudtrail',
      status: 'new',
      cases: CASES,
      minutes: 600,
    });
    await seed({
      count: VULNERABILITIES,
      marker: 'vul-',
      source: 'inspector',
      status: 'new',
      cases: VULNERABILITIES,
      minutes: 600,
    });
    await prisma.$executeRaw`ANALYZE`;
    world = noticeWorld(prisma, [tenantId], new Date());
    await world.assign();
    await prisma.$executeRaw`ANALYZE`;
    lines['casos'] = await prisma.alertCase.groupBy({ by: ['queue'], _count: true });
  }, 1_800_000);

  afterAll(async () => {
    console.log(JSON.stringify(lines, null, 2));
    await prisma.$disconnect();
    await database.drop();
  }, 300_000);

  it('a virada, com tudo já enviado: marca, e não avisa', async () => {
    await notice('det-', 'sent');
    await notice('vul-', 'sent');
    world.clock.now = new Date();
    await world.activate();
    const report = await measure('virada, tudo enviado', () => world.check());
    expect(report).toMatchObject({ opened: 0, critical: 0 });
    await measure('parada', () => world.check());
    await measure('parada de novo', () => world.check());
  }, 600_000);

  it('com novidade: 200 casos novos, e um caso com 20 mil alertas a mais', async () => {
    world.clock.now = new Date(start.getTime() + 2 * HOUR_MS);
    await seed({ count: 600, marker: 'novo-', source: 'gcp_audit', status: 'new', cases: 200, minutes: -60 });
    await world.assign();
    const report = await measure('200 casos novos', () => world.check());
    expect(report.opened).toBe(200);
    await seed({
      count: 20_000,
      marker: 'mar-',
      source: 'gcp_audit',
      status: 'new',
      cases: 1,
      minutes: -121,
    });
    world.clock.now = new Date(start.getTime() + 2 * HOUR_MS + 2 * MINUTE_MS);
    await world.assign();
    await measure('20 mil alertas a mais num caso avisado', () => world.check());
    await seed({
      count: 5_000,
      marker: 'mar2-',
      source: 'gcp_audit',
      status: 'new',
      cases: 1,
      minutes: -123,
    });
    world.clock.now = new Date(start.getTime() + 2 * HOUR_MS + 4 * MINUTE_MS);
    await world.assign();
    await measure('mais 5 mil no mesmo caso', () => world.check());
    await measure('parada, com o caso grande', () => world.check());
  }, 900_000);

  it('a virada com 24 mil avisos na fila', async () => {
    await seed({
      count: 24_000,
      marker: 'fila-',
      source: 'cloudflare_audit',
      status: 'new',
      cases: 2_000,
      minutes: -124,
    });
    await notice('fila-', 'pending');
    world.clock.now = new Date(start.getTime() + 2 * HOUR_MS + 6 * MINUTE_MS);
    await world.assign();
    const report = await measure('virada, 24 mil na fila', () => world.check());
    expect(report).toMatchObject({ opened: 2_000, superseded: 24_000 });
    await measure('entrega', () => world.deliver(new MemoryMailTransport()));
  }, 900_000);
});
