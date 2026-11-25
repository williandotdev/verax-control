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

function percentiles(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (share: number) =>
    Math.round((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0) * 10) / 10;
  return { p50: at(0.5), p95: at(0.95), max: at(1) };
}

describe.skipIf(process.env['CASES_BENCH'] !== '1')('medição de carga da leitura dos casos', () => {
  let prisma: PrismaService;
  let service: CasesService;
  let tenantId: string;
  let otherTenant: string;
  let bigCase: string;

  /** Os casos: 60% de pacote, 23% de postura e 17% de detecção; o primeiro é o grande. */
  async function seedCases(tenant: string, cases: number): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO "AlertCase" ("id", "tenantId", "queue", "keyVersion", "groupKey", "openKey", "family", "title",
        "keyParts", "anchorFindingId", "openedAt", "firstSeenAt", "lastSeenAt", "lastAlertAt", "recurrence",
        "ruleIds", "accounts", "actors", "ips", "resources", "mitreTactics", "mitreTechniques")
      SELECT gen_random_uuid(), ${tenant}::uuid,
        (CASE WHEN n % 100 < 60 THEN 'vulnerability' WHEN n % 100 < 83 THEN 'posture' ELSE 'detection' END)::"CaseQueue",
        1, encode(sha256((${tenant}::text || n)::bytea), 'hex'), encode(sha256((${tenant}::text || n)::bytea), 'hex'),
        CASE WHEN n % 100 < 60 THEN 'package' WHEN n % 100 < 83 THEN 'control' ELSE 'cloudtrail' END,
        CASE WHEN n % 100 < 60 THEN 'Vulnerabilidade em pacote' WHEN n % 100 < 83 THEN 'Controle de segurança reprovado'
          ELSE 'Atividade suspeita na conta da AWS' END,
        CASE WHEN n % 100 < 60 THEN jsonb_build_array(
            jsonb_build_object('name', 'package', 'value', 'pacote-' || (n % 61)),
            jsonb_build_object('name', 'resource', 'value', 'ec2:i-' || lpad((n % 30)::text, 17, '0')))
          WHEN n % 100 < 83 THEN jsonb_build_array(jsonb_build_object('name', 'control', 'value', 'S3.' || n))
          ELSE jsonb_build_array(jsonb_build_object('name', 'rule', 'value', '10030' || (n % 5)),
            jsonb_build_object('name', 'actor', 'value', 'pessoa-' || n)) END,
        gen_random_uuid(), t.at, t.at, t.at + interval '1 day', t.at + interval '1 day', n % 4,
        CASE WHEN n % 100 < 60 THEN ARRAY['990511', '990502'] WHEN n % 100 < 83 THEN ARRAY['990501']
          ELSE ARRAY['10030' || (n % 5)] END,
        ARRAY[CASE WHEN n % 2 = 0 THEN '111122223333' ELSE '222233334444' END],
        ARRAY(SELECT 'arn:aws:sts::111122223333:assumed-role/papel-' || (n % 40) || '/sessao-' || i
          FROM generate_series(1, CASE WHEN n % 100 < 83 THEN 0 ELSE 1 + n % 20 END) AS i),
        ARRAY(SELECT '203.0.' || (n % 250) || '.' || i
          FROM generate_series(1, CASE WHEN n % 100 < 83 THEN 0 ELSE 1 + n % 20 END) AS i),
        ARRAY(SELECT 'arn:aws:s3:::bucket-demo-' || n || '-' || i
          FROM generate_series(1, CASE WHEN n % 100 < 60 THEN 1 ELSE 1 + n % 20 END) AS i),
        CASE WHEN n % 3 = 0 THEN ARRAY['Impact', 'Discovery'] ELSE ARRAY[]::text[] END,
        CASE WHEN n % 3 = 0 THEN ARRAY['T1485', 'T1562.008'] ELSE ARRAY[]::text[] END
      FROM generate_series(1, ${cases}::integer) AS n,
        LATERAL (SELECT now() - interval '30 days' + n * (interval '29 days' / ${cases}::integer) AS at) AS t`;
  }

  async function seedFindings(tenant: string, rows: number, cases: number, big: number): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO "Finding" ("id", "tenantId", "accountId", "source", "sourceEventId", "logSource", "occurredAt",
        "severity", "status", "triagedAt", "lastSeenAt", "ruleId", "ruleLevel", "title", "eventName", "resource",
        "actorUser", "accessKeyId", "sourceIp", "caseGroup", "mitreTactics", "mitreTechniques", "createdAt", "updatedAt")
      SELECT gen_random_uuid(), ${tenant}::uuid, '111122223333', 'aws', ${`leitura-${randomUUID()}-`}::text || n,
        'cloudtrail', t.at,
        (ARRAY['critical', 'high', 'medium', 'low'])[1 + (n / 7) % 4]::"FindingSeverity",
        (CASE WHEN n % 10 < 4 THEN 'resolved' WHEN n % 10 = 4 THEN 'investigating' ELSE 'new' END)::"FindingStatus",
        CASE WHEN n % 10 < 5 THEN t.at + interval '1 hour' END,
        CASE WHEN n % 20 = 0 THEN t.at + interval '2 hours' END,
        '100305', 10, 'Permissão de administrador concedida ' || n, 'AttachUserPolicy',
        'arn:aws:iam::111122223333:user/recurso-' || (n % 500),
        'arn:aws:sts::111122223333:assumed-role/papel-' || (n % 40) || '/sessao-' || (n % 900),
        'DEMOKEY' || (n % 200), '198.51.' || (n % 120) || '.' || (n % 250), 'grupo-' || (n % 400),
        ARRAY['Persistence'], ARRAY['T1098'], t.at, t.at
      FROM generate_series(1, ${rows}::integer) AS n,
        LATERAL (SELECT now() - interval '6 days' + n * (interval '6 days' / ${rows}::integer) AS at) AS t`;
    await prisma.$executeRaw`ANALYZE "Finding"`;
    // Num comando só, como o gatilho das contagens espera: o caso grande leva um alerta a cada tantos.
    await prisma.$executeRaw`
      WITH numbered AS MATERIALIZED (
        SELECT o."id", CASE WHEN ${big}::integer > 0 AND o.n % (${rows}::integer / greatest(${big}::integer, 1)) = 0
          THEN 1 ELSE 2 + (o.n * 7919) % (${cases}::integer - 1) END AS k
        FROM (
          SELECT f."id", row_number() OVER (ORDER BY f."occurredAt", f."id") AS n
          FROM "Finding" AS f WHERE f."tenantId" = ${tenant}::uuid
        ) AS o
      ), ranked AS MATERIALIZED (
        SELECT c."id", row_number() OVER (ORDER BY c."groupKey") AS k FROM "AlertCase" AS c
        WHERE c."tenantId" = ${tenant}::uuid
      )
      UPDATE "Finding" AS f SET "caseId" = r."id"
      FROM numbered AS s JOIN ranked AS r ON r.k = s.k
      WHERE f."id" = s."id"`;
    // 40% dos casos (menos o grande) ficam tratados.
    await prisma.$executeRaw`
      UPDATE "Finding" AS f SET "status" = 'resolved', "triagedAt" = f."occurredAt" + interval '1 hour'
      FROM "AlertCase" AS c
      WHERE c."id" = f."caseId" AND c."tenantId" = ${tenant}::uuid AND f."tenantId" = ${tenant}::uuid
        AND c."total" < 10000 AND ('x' || substr(c."groupKey", 1, 4))::bit(16)::integer % 10 < 4`;
  }

  beforeAll(async () => {
    prisma = new PrismaService({ DATABASE_URL: inject('testDatabaseUrl') });
    service = new CasesService(prisma, { CASES_MODE: 'on' }, DEFAULT_CASE_READ_LIMITS);
    tenantId = (await prisma.tenant.create({ data: { name: 'Cliente Demo A (medição da leitura)' } })).id;
    otherTenant = (await prisma.tenant.create({ data: { name: 'Cliente Demo B (medição da leitura)' } })).id;
    await seedCases(otherTenant, Math.ceil(CASES / 5));
    await seedFindings(otherTenant, Math.ceil(ROWS / 5), Math.ceil(CASES / 5), 0);
    await seedCases(tenantId, CASES);
    await seedFindings(tenantId, ROWS, CASES, BIG);
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
