import { randomUUID } from 'node:crypto';
import { caseListQuerySchema, reportQueryWindow, triageFilterSchema } from '@verax/shared';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { caseOutcomes, mitreWithCases, pendingCases, radarCases } from '../src/cases/case-summary-store.js';
import { CasesService, DEFAULT_CASE_READ_LIMITS } from '../src/cases/cases.service.js';
import { DEFAULT_TRIAGE_LIMITS, TriageOperationsService } from '../src/cases/triage-operations.service.js';
import type { RequestAuth } from '../src/common/auth/request-auth.js';
import { requestContext } from '../src/common/context/request-context.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { PostureService } from '../src/posture/posture.service.js';
import { DEFAULT_REPORT_BATCH_SIZE, ReportsService } from '../src/reports/reports.service.js';
import { TowerService } from '../src/tower/tower.service.js';
import { percentiles, seedBenchCases, seedBenchFindings } from './support/case-bench.js';
import { cleanCases } from './support/cases.js';

/**
 * Medição de carga da Torre, do radar e dos relatórios com os casos, fora do CI: só roda com `CASES_BENCH=1`
 * (`CASES_BENCH=1 pnpm --filter @verax/api exec vitest run test/cases-tower-benchmark.test.ts --silent=false`).
 *
 * O banco da medição da leitura (250 mil alertas, todos com tática, um caso de 20 mil), com 2 mil casos, e mais 50 mil
 * alertas de outro cliente. Pelo service, sem o HTTP.
 */
const ROWS = Number(process.env['CASES_BENCH_ROWS'] ?? 250_000);
const CASES = Number(process.env['CASES_BENCH_CASES'] ?? 2_000);
const BIG = 20_000;
const ROUNDS = Number(process.env['CASES_BENCH_ROUNDS'] ?? 60);
const DAY_MS = 24 * 3_600_000;

describe.skipIf(process.env['CASES_BENCH'] !== '1')('medição de carga da Torre com os casos', () => {
  let prisma: PrismaService;
  let tenantId: string;
  let otherTenant: string;

  beforeAll(async () => {
    prisma = new PrismaService({ DATABASE_URL: inject('testDatabaseUrl') });
    tenantId = (await prisma.tenant.create({ data: { name: 'Cliente Demo A (medição da Torre)' } })).id;
    otherTenant = (await prisma.tenant.create({ data: { name: 'Cliente Demo B (medição da Torre)' } })).id;
    await seedBenchCases(prisma, otherTenant, Math.ceil(CASES / 5));
    await seedBenchFindings(prisma, otherTenant, Math.ceil(ROWS / 5), Math.ceil(CASES / 5), 0);
    await seedBenchCases(prisma, tenantId, CASES);
    await seedBenchFindings(prisma, tenantId, ROWS, CASES, BIG);
    // Os casos terminam a semente com a atividade espalhada por um mês: metade dos de detecção fica ativa agora.
    await prisma.$executeRaw`
      UPDATE "AlertCase" SET "lastSeenAt" = now() - interval '1 hour', "lastAlertAt" = now() - interval '1 hour'
      WHERE "tenantId" = ${tenantId}::uuid AND "queue" = 'detection'
        AND ('x' || substr("groupKey", 1, 2))::bit(8)::integer % 2 = 0`;
    // Um incidente com 10 mil alertas, e 300 alertas ainda sem caso.
    const incident = await prisma.incident.create({
      data: {
        tenantId,
        severity: 'high',
        riskScore: 50,
        findingCount: 10_000,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        keys: [],
        accounts: [],
        resources: [],
        mitreTactics: [],
        mitreTechniques: [],
      },
    });
    await prisma.$executeRaw`
      UPDATE "Finding" SET "incidentId" = ${incident.id}::uuid
      WHERE "id" IN (SELECT f."id" FROM "Finding" AS f WHERE f."tenantId" = ${tenantId}::uuid
        ORDER BY f."id" LIMIT 10000)`;
    await prisma.finding.createMany({
      data: Array.from({ length: 300 }, (_, index) => ({
        tenantId,
        accountId: '111122223333',
        source: 'wazuh',
        sourceEventId: `sem-caso-${randomUUID()}`,
        logSource: 'cloudtrail',
        occurredAt: new Date(Date.now() - index * 1_000),
        severity: 'high' as const,
        ruleId: '100305',
        ruleLevel: 10,
        title: 'Alerta sem caso',
        mitreTactics: ['Impact'],
        mitreTechniques: [],
      })),
    });
    await prisma.$executeRaw`CLUSTER "Finding" USING "Finding_tenantId_occurredAt_idx"`;
    await prisma.$executeRaw`VACUUM (ANALYZE) "Finding"`;
    await prisma.$executeRaw`VACUUM (ANALYZE) "AlertCase"`;
  }, 1_200_000);

  afterAll(async () => {
    if (process.env['CASES_BENCH_KEEP'] === '1') return prisma.$disconnect();
    await cleanCases(prisma, [tenantId, otherTenant]);
    await prisma.$disconnect();
  }, 1_200_000);

  it('cada leitura', { timeout: 3_600_000 }, async () => {
    const auth = {
      role: 'analista_cliente',
      userId: 'medicao',
      scopeTenantId: tenantId,
    } as unknown as RequestAuth;
    const inSession = <T>(work: () => Promise<T>): Promise<T> => requestContext.run({ auth }, work);
    const reports = new ReportsService(prisma, DEFAULT_REPORT_BATCH_SIZE);
    const none = undefined as never;
    const tower = () =>
      new TowerService(prisma, new PostureService(prisma, none), reports, { CASES_MODE: 'on' });
    const warm = tower();
    const cases = new CasesService(prisma, { CASES_MODE: 'on' }, DEFAULT_CASE_READ_LIMITS);
    const triage = new TriageOperationsService(
      prisma,
      none,
      none,
      none,
      none,
      { CASES_MODE: 'on' },
      DEFAULT_TRIAGE_LIMITS,
    );
    const now = new Date();
    const month = { from: new Date(now.getTime() - 30 * DAY_MS), to: now };
    const window = reportQueryWindow({ period: '30d' }, now);
    const preview = (filter: object) => () => triage.preview(triageFilterSchema.parse(filter));

    const routes: Record<string, () => Promise<unknown>> = {
      'comando: casos pendentes': () => pendingCases(prisma, tenantId),
      'comando: casos do radar': () =>
        radarCases(prisma, tenantId, { since: new Date(now.getTime() - DAY_MS), now, limit: 100 }),
      'comando: MITRE com casos, 30 dias': () => mitreWithCases(prisma, tenantId, month),
      'comando: casos do período, 30 dias': () => caseOutcomes(prisma, tenantId, month),
      'Torre de sempre, MITRE guardado': () => warm.summary(auth, {}),
      'Torre com casos, MITRE guardado': () => warm.summary(auth, { cases: 'true' }),
      'Torre de sempre, MITRE frio': () => tower().summary(auth, {}),
      'Torre com casos, MITRE frio': () => tower().summary(auth, { cases: 'true' }),
      'relatório MITRE de sempre': () => reports.report('mitre', window),
      'relatório MITRE com casos': () => reports.report('mitre', window, { cases: true }),
      'prévia de um filtro grande': preview({ q: 'pacote', queue: 'vulnerability' }),
      'prévia por severidade': preview({ severity: 'high' }),
      'autores das operações': () => triage.authors(),
      'lista, com as voltas depois de tratado': () =>
        cases.list(caseListQuerySchema.parse({ pageSize: '100' })),
    };
    const lines: Record<string, unknown> = {
      alertas: await prisma.finding.count({ where: { tenantId } }),
      casos: await prisma.alertCase.count({ where: { tenantId } }),
      pendentes: await prisma.alertCase.count({ where: { tenantId, pending: true } }),
    };
    for (const [name, run] of Object.entries(routes)) {
      const times: number[] = [];
      let bytes = 0;
      for (let round = 0; round < ROUNDS + 3; round += 1) {
        const startedAt = performance.now();
        const result = await inSession(run);
        // As três primeiras aquecem.
        if (round >= 3) times.push(performance.now() - startedAt);
        bytes = JSON.stringify(result).length;
      }
      lines[name] = { ...percentiles(times), kB: Math.round(bytes / 102.4) / 10 };
    }
    // O resumo lê o período inteiro, alerta por alerta: poucas rodadas, e uma de cada por vez, porque o processo varia mais
    // que a diferença entre as duas.
    const summaries = { 'de sempre': [] as number[], 'com casos': [] as number[] };
    for (let round = 0; round < 6; round += 1) {
      for (const [name, times] of Object.entries(summaries)) {
        const startedAt = performance.now();
        await inSession(() => reports.report('summary', window, { cases: name === 'com casos' }));
        if (round > 0) times.push(performance.now() - startedAt);
      }
    }
    for (const [name, times] of Object.entries(summaries)) {
      lines[`relatório de resumo ${name}`] = percentiles(times);
    }
    // Dez painéis pedindo juntos.
    for (const query of [{}, { cases: 'true' as const }]) {
      const cold = tower();
      const startedAt = performance.now();
      await Promise.all(Array.from({ length: 10 }, () => inSession(() => cold.summary(auth, query))));
      lines[`dez painéis juntos, MITRE frio${query.cases ? ', com casos' : ''}`] = Math.round(
        performance.now() - startedAt,
      );
    }
    process.stdout.write(`\nmedição da Torre: ${JSON.stringify(lines, null, 1)}\n`);
    expect(lines['alertas']).toBeGreaterThanOrEqual(ROWS);
  });
});
