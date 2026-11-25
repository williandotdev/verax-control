import { randomUUID } from 'node:crypto';
import {
  type CaseFindingsQuery,
  caseFindingsQuerySchema,
  type CaseGroupsQuery,
  caseGroupsQuerySchema,
  type CaseListQuery,
  caseListQuerySchema,
} from '@verax/shared';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { CasesService, DEFAULT_CASE_READ_LIMITS } from '../src/cases/cases.service.js';
import type { RequestAuth } from '../src/common/auth/request-auth.js';
import { requestContext } from '../src/common/context/request-context.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { percentiles, seedBenchCases, seedBenchFindings } from './support/case-bench.js';
import { cleanCases } from './support/cases.js';

/**
 * Medição de carga da leitura dos casos, fora do CI: só roda com `CASES_BENCH=1`
 * (`CASES_BENCH=1 pnpm --filter @verax/api exec vitest run test/cases-read-benchmark.test.ts --silent=false`).
 *
 * Semeia 250 mil alertas em 3 mil casos (1.800 de pacote, 700 de postura e 500 de detecção, 40% já tratados), um deles
 * com 20 mil alertas, e mais 50 mil de outro cliente; mede cada rota pelo service, sem o HTTP.
 */
const ROWS = Number(process.env['CASES_BENCH_ROWS'] ?? 250_000);
const CASES = Number(process.env['CASES_BENCH_CASES'] ?? 3_000);
const BIG = 20_000;
const ROUNDS = Number(process.env['CASES_BENCH_ROUNDS'] ?? 60);

describe.skipIf(process.env['CASES_BENCH'] !== '1')('medição de carga da leitura dos casos', () => {
  let prisma: PrismaService;
  let service: CasesService;
  let tenantId: string;
  let otherTenant: string;
  let bigCase: string;

  beforeAll(async () => {
    prisma = new PrismaService({ DATABASE_URL: inject('testDatabaseUrl') });
    service = new CasesService(prisma, { CASES_MODE: 'on' }, DEFAULT_CASE_READ_LIMITS);
    tenantId = (await prisma.tenant.create({ data: { name: 'Cliente Demo A (medição da leitura)' } })).id;
    otherTenant = (await prisma.tenant.create({ data: { name: 'Cliente Demo B (medição da leitura)' } })).id;
    await seedBenchCases(prisma, otherTenant, Math.ceil(CASES / 5));
    await seedBenchFindings(prisma, otherTenant, Math.ceil(ROWS / 5), Math.ceil(CASES / 5), 0);
    await seedBenchCases(prisma, tenantId, CASES);
    await seedBenchFindings(prisma, tenantId, ROWS, CASES, BIG);
    const author = await prisma.user.create({
      data: {
        id: randomUUID(),
        name: 'Admin Demo',
        email: `medicao-${randomUUID()}@cliente.example`,
        emailVerified: true,
        role: 'admin_cliente',
        status: 'active',
        tenantId,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    await prisma.protectedResource.createMany({
      data: Array.from({ length: 30 }, (_, index) => ({
        tenantId,
        type: 's3_bucket' as const,
        identifier: `bucket-protegido-${index}`,
        reason: 'medição',
        createdById: author.id,
      })),
    });
    // Na ordem do tempo, como no nó: os alertas de um caso ficam espalhados pela tabela.
    await prisma.$executeRaw`CLUSTER "Finding" USING "Finding_tenantId_occurredAt_idx"`;
    await prisma.$executeRaw`VACUUM (ANALYZE) "Finding"`;
    await prisma.$executeRaw`VACUUM (ANALYZE) "AlertCase"`;
    bigCase = (
      await prisma.alertCase.findFirstOrThrow({
        where: { tenantId },
        orderBy: { total: 'desc' },
        select: { id: true },
      })
    ).id;
  }, 1_200_000);

  afterAll(async () => {
    // Os dados ficam para olhar os planos à mão (o banco é recriado na rodada seguinte).
    if (process.env['CASES_BENCH_KEEP'] === '1') return prisma.$disconnect();
    await cleanCases(prisma, [tenantId, otherTenant]);
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.$disconnect();
  }, 1_200_000);

  it('cada rota', { timeout: 3_600_000 }, async () => {
    const auth = { role: 'analista_cliente', scopeTenantId: tenantId } as unknown as RequestAuth;
    const inSession = <T>(work: () => Promise<T>): Promise<T> => requestContext.run({ auth }, work);
    const list = (query: Partial<Record<keyof CaseListQuery, string>>) => () =>
      service.list(caseListQuerySchema.parse(query));
    const groups = (query: Partial<Record<keyof CaseGroupsQuery, string>>) => () =>
      service.groups(caseGroupsQuerySchema.parse(query));
    const findings = (query: Partial<Record<keyof CaseFindingsQuery, string>>) => () =>
      service.findings(bigCase, caseFindingsQuerySchema.parse(query));
    const small = await prisma.alertCase.findFirstOrThrow({
      where: { tenantId, queue: 'vulnerability', pending: true, total: { lt: 1_000 } },
      select: { id: true },
    });
    // Um cursor no fim do caso grande: a profundidade não pode custar.
    let cursor: string | null = null;
    for (let page = 0; page < 190; page += 1) {
      const { nextCursor } = await inSession(() =>
        service.findings(
          bigCase,
          caseFindingsQuerySchema.parse({ pageSize: '100', ...(cursor !== null && { cursor }) }),
        ),
      );
      cursor = nextCursor;
    }
    expect(cursor).not.toBeNull();

    const routes: Record<string, () => Promise<unknown>> = {
      'lista, prioridade': list({}),
      'lista, prioridade, fila': list({ queue: 'vulnerability' }),
      'lista, todos, página 20': list({ state: 'all', sort: 'recent', page: '20', pageSize: '100' }),
      'lista, volume, 100': list({ sort: 'volume', pageSize: '100' }),
      'lista, filtros juntos': list({
        severity: 'high',
        accountId: '111122223333',
        tactic: 'Impact',
        period: '7d',
      }),
      'lista, fonte': list({ source: 'inspector' }),
      'lista, busca com resultado': list({ q: 'papel-7/' }),
      'lista, busca sem resultado': list({ q: 'nada-disso', state: 'all' }),
      'lista, grupo': list({ queue: 'vulnerability', groupBy: 'package', group: 'pacote-7' }),
      'grupos, pacote': groups({ by: 'package' }),
      'grupos, recurso': groups({ by: 'resource' }),
      'grupos, conta': groups({ by: 'account' }),
      'grupos, busca': groups({ by: 'package', q: 'pacote-1' }),
      'detalhe, caso comum': () => service.get(auth, small.id),
      'detalhe, 20 mil alertas': () => service.get(auth, bigCase),
      'alertas, começo': findings({}),
      'alertas, fim (19 mil antes)': findings({ pageSize: '100', cursor: cursor as string }),
      'alertas, filtro que acha': findings({ status: 'investigating', severity: 'critical' }),
      'alertas, filtro que não acha': findings({ group: 'nenhum' }),
      'linha do tempo, caso comum': () => service.timeline(small.id),
      'linha do tempo, 20 mil': () => service.timeline(bigCase),
      situação: () => service.status(auth),
    };
    const lines: Record<string, unknown> = {
      alertas: await prisma.finding.count({ where: { tenantId } }),
      casos: await prisma.alertCase.count({ where: { tenantId } }),
      pendentes: await prisma.alertCase.count({ where: { tenantId, pending: true } }),
      casoGrande: await prisma.finding.count({ where: { tenantId, caseId: bigCase } }),
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
    process.stdout.write(`\nmedição da leitura: ${JSON.stringify(lines, null, 1)}\n`);
    expect(lines['casoGrande']).toBeGreaterThanOrEqual(BIG);
  });
});
