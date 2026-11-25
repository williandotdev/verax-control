import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../../src/common/prisma/prisma.service.js';

/** O banco das medições de carga dos casos (`CASES_BENCH=1`), o mesmo para a leitura e para a Torre. */

export function percentiles(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (share: number) =>
    Math.round((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0) * 10) / 10;
  return { p50: at(0.5), p95: at(0.95), max: at(1) };
}

/** Os casos: 60% de pacote, 23% de postura e 17% de detecção; o primeiro é o grande. */
export async function seedBenchCases(prisma: PrismaService, tenant: string, cases: number): Promise<void> {
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

/** Os alertas, espalhados por seis dias, e em que caso cada um está; `big` deles num caso só. */
export async function seedBenchFindings(
  prisma: PrismaService,
  tenant: string,
  rows: number,
  cases: number,
  big: number,
): Promise<void> {
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
