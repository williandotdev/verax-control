import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AWS_DISCOVERY_STATUSES,
  AWS_DISCOVERY_TRIGGERS,
  AWS_READER_CAPABILITIES,
  AWS_SOURCE_AVAILABILITIES,
  AWS_SOURCE_KINDS,
  AWS_SOURCE_LOGGING_STATES,
  AWS_SOURCE_METHODS,
  AWS_SOURCE_NOTES,
  AWS_SOURCE_ORIGINS,
  AWS_SOURCE_PERMISSIONS,
  AWS_SOURCE_STATES,
} from '@verax/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * A migration do onboarding self-service da AWS (`20261124120000_aws_onboarding`): as colunas novas da conta, as tabelas
 * `AwsDiscoveryRun` e `AwsSource`, os CHECKs (os mesmos valores do contrato) e as fontes dos buckets já cadastrados.
 *
 * Duas frentes, como em `aws-keyless-migration.test.ts`:
 * - banco novo: o banco de teste, migrado do zero pelo `prisma migrate deploy` do `global-setup`;
 * - banco existente: um banco descartável, só deste arquivo, com as migrations anteriores aplicadas uma a uma, contas
 *   no formato de antes (com e sem bucket, verificadas ou não) e então a migration nova.
 */

const MIGRATION = '20261124120000_aws_onboarding';
const migrationsDir = fileURLToPath(new URL('../prisma/migrations', import.meta.url));
const migrations = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const sqlOf = (name: string) => readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8');

const testUrl = new URL(inject('testDatabaseUrl'));

function connect(database: string): pg.Client {
  return new pg.Client({
    host: testUrl.hostname,
    port: Number(testUrl.port || 5432),
    user: decodeURIComponent(testUrl.username),
    password: decodeURIComponent(testUrl.password),
    database,
  });
}

async function constraint(client: pg.Client, name: string): Promise<string> {
  const result = await client.query<{ definition: string }>(
    'SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = $1',
    [name],
  );
  const definition = result.rows[0]?.definition;
  if (definition === undefined) throw new Error(`constraint ${name} não existe`);
  return definition;
}

/**
 * Os valores entre aspas simples da primeira lista (`ARRAY[...]`) depois de `marker`, na definição como o Postgres a
 * devolve: `(kind)::text = ANY ((ARRAY['cloudtrail'::character varying, ...])::text[])`.
 */
function listedAfter(definition: string, marker: string): string[] {
  const start = definition.indexOf(marker);
  if (start < 0) throw new Error(`"${marker}" não aparece na constraint`);
  const open = definition.indexOf('[', start);
  const close = definition.indexOf(']', open);
  return [...definition.slice(open, close).matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
}

describe(`migration ${MIGRATION}`, () => {
  it('é a última da lista e só acrescenta: nada é apagado nem reescrito', () => {
    expect(migrations.at(-1)).toBe(MIGRATION);
    const sql = sqlOf(MIGRATION);
    expect(sql).not.toMatch(/\bDROP\b|DELETE FROM|^\s*UPDATE\b|\bTRUNCATE\b|ALTER COLUMN/im);
    // Os buckets cadastrados continuam nas colunas da conta.
    expect(sql).not.toMatch(/DROP COLUMN/i);
  });

  describe('banco novo (o banco de teste, migrado do zero)', () => {
    let client: pg.Client;
    const tenantId = randomUUID();
    const otherTenantId = randomUUID();
    const awsId = randomUUID();
    const gcpId = randomUUID();

    beforeAll(async () => {
      client = connect(decodeURIComponent(testUrl.pathname.slice(1)));
      await client.connect();
      await client.query(
        `INSERT INTO "Tenant" ("id", "name", "updatedAt") VALUES ($1, 'Cliente Demo A (migration onboarding)', now()),
                                                                 ($2, 'Cliente Demo B (migration onboarding)', now())`,
        [tenantId, otherTenantId],
      );
      await client.query(
        `INSERT INTO "CloudAccount" ("id", "tenantId", "provider", "accountId", "regions", "updatedAt")
         VALUES ($1, $3, 'aws', $4, ARRAY['sa-east-1'], now()),
                ($2, $3, 'gcp', $5, ARRAY[]::text[], now())`,
        [
          awsId,
          gcpId,
          tenantId,
          `9${randomBytes(6).toString('hex').replace(/\D/g, '1').padEnd(11, '0').slice(0, 11)}`,
          `vx-mig-${randomBytes(4).toString('hex')}`,
        ],
      );
    });

    afterAll(async () => {
      await client.query('DELETE FROM "AwsSource" WHERE "tenantId" IN ($1, $2)', [tenantId, otherTenantId]);
      await client.query('DELETE FROM "AwsDiscoveryRun" WHERE "tenantId" IN ($1, $2)', [
        tenantId,
        otherTenantId,
      ]);
      await client.query('DELETE FROM "CloudAccount" WHERE "tenantId" IN ($1, $2)', [
        tenantId,
        otherTenantId,
      ]);
      await client.query('DELETE FROM "Tenant" WHERE "id" IN ($1, $2)', [tenantId, otherTenantId]);
      await client.end();
    });

    const insertSource = (overrides: Record<string, unknown> = {}, account = awsId, tenant = tenantId) => {
      const row: Record<string, unknown> = {
        id: randomUUID(),
        tenantId: tenant,
        cloudAccountId: account,
        kind: 'cloudtrail',
        region: 'sa-east-1',
        resourceId: `trilha-${randomBytes(4).toString('hex')}`,
        name: 'principal',
        method: 's3',
        availability: 'available',
        state: 'available',
        updatedAt: new Date(),
        ...overrides,
      };
      const columns = Object.keys(row);
      return client.query(
        `INSERT INTO "AwsSource" (${columns.map((column) => `"${column}"`).join(', ')})
         VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
        Object.values(row),
      );
    };

    it('os CHECKs repetem os valores do contrato compartilhado, sem faltar nem sobrar', async () => {
      const kind = await constraint(client, 'AwsSource_kind_check');
      expect(listedAfter(kind, '(kind)::text').sort()).toEqual([...AWS_SOURCE_KINDS].sort());
      expect(listedAfter(kind, '(method)::text').sort()).toEqual([...AWS_SOURCE_METHODS].sort());
      expect(listedAfter(kind, '(origin)::text').sort()).toEqual([...AWS_SOURCE_ORIGINS].sort());

      const discovery = await constraint(client, 'AwsSource_discovery_check');
      expect(listedAfter(discovery, '(availability)::text').sort()).toEqual(
        [...AWS_SOURCE_AVAILABILITIES].sort(),
      );
      expect(listedAfter(discovery, '"loggingState")::text = ANY').sort()).toEqual(
        [...AWS_SOURCE_LOGGING_STATES].sort(),
      );
      expect(listedAfter(discovery, '(permission)::text').sort()).toEqual([...AWS_SOURCE_PERMISSIONS].sort());
      expect(listedAfter(discovery, 'notes <@').sort()).toEqual([...AWS_SOURCE_NOTES].sort());

      const state = await constraint(client, 'AwsSource_state_check');
      expect(listedAfter(state, '(state)::text').sort()).toEqual([...AWS_SOURCE_STATES].sort());

      expect(
        listedAfter(await constraint(client, 'AwsDiscoveryRun_trigger_check'), '(trigger)::text').sort(),
      ).toEqual([...AWS_DISCOVERY_TRIGGERS].sort());
      expect(
        listedAfter(await constraint(client, 'AwsDiscoveryRun_status_check'), '(status)::text').sort(),
      ).toEqual([...AWS_DISCOVERY_STATUSES].sort());
      expect(
        listedAfter(
          await constraint(client, 'CloudAccount_aws_onboarding_check'),
          '"awsCapabilities" <@',
        ).sort(),
      ).toEqual([...AWS_READER_CAPABILITIES].sort());
    });

    it('as colunas do onboarding só existem na conta AWS', async () => {
      await client.query(
        `UPDATE "CloudAccount" SET "awsConnectRequestedAt" = now(), "awsTemplateVersion" = 2,
           "awsCapabilities" = ARRAY['discovery', 'findings'], "awsCapabilitiesCheckedAt" = now(),
           "awsDiscoveredRegions" = ARRAY['sa-east-1'] WHERE "id" = $1`,
        [awsId],
      );
      for (const assignment of [
        `"awsConnectRequestedAt" = now()`,
        `"awsTemplateVersion" = 2`,
        `"awsCapabilities" = ARRAY['discovery']`,
        `"awsCapabilitiesCheckedAt" = now()`,
        `"awsDiscoveredRegions" = ARRAY['sa-east-1']`,
      ]) {
        await expect(
          client.query(`UPDATE "CloudAccount" SET ${assignment} WHERE "id" = $1`, [gcpId]),
        ).rejects.toThrow(/CloudAccount_aws_onboarding_check/);
      }
      await expect(
        client.query(`UPDATE "CloudAccount" SET "awsTemplateVersion" = 0 WHERE "id" = $1`, [awsId]),
      ).rejects.toThrow(/CloudAccount_aws_onboarding_check/);
      await expect(
        client.query(
          `UPDATE "CloudAccount" SET "awsCapabilities" = ARRAY['discovery', 'resposta'] WHERE "id" = $1`,
          [awsId],
        ),
      ).rejects.toThrow(/CloudAccount_aws_onboarding_check/);
    });

    it('a fonte recusa valor fora do contrato', async () => {
      await insertSource();
      const refused: [Record<string, unknown>, RegExp][] = [
        [{ kind: 'route53' }, /AwsSource_kind_check/],
        [{ method: 'firehose' }, /AwsSource_kind_check/],
        [{ origin: 'manual' }, /AwsSource_kind_check/],
        [{ region: 'brasil' }, /AwsSource_region_check/],
        [{ availability: 'enabled' }, /AwsSource_discovery_check/],
        [{ loggingState: 'on' }, /AwsSource_discovery_check/],
        [{ permission: 'denied' }, /AwsSource_discovery_check/],
        [{ permissionDetail: 'mensagem da AWS com espaço' }, /AwsSource_discovery_check/],
        [{ notes: ['custo'] }, /AwsSource_discovery_check/],
        [{ details: JSON.stringify(['lista']) }, /AwsSource_discovery_check/],
        [{ state: 'active' }, /AwsSource_state_check/],
        [{ lagSeconds: -1 }, /AwsSource_health_check/],
      ];
      for (const [overrides, error] of refused) await expect(insertSource(overrides)).rejects.toThrow(error);
      // A região global e uma região de partição com qualificador valem.
      await insertSource({
        region: 'global',
        resourceId: 'none',
        availability: 'not_enabled',
        state: 'unavailable',
      });
      await insertSource({ region: 'us-gov-west-1' });
    });

    it('o estado e a autorização andam juntos', async () => {
      const now = new Date();
      // Um estado de coleta exige a autorização valendo.
      for (const state of [
        'authorized',
        'configuring',
        'waiting_events',
        'collecting',
        'stalled',
        'permission_error',
        'ingestion_error',
      ]) {
        await expect(insertSource({ state })).rejects.toThrow(/AwsSource_state_check/);
        await expect(insertSource({ state, authorizedAt: now, revokedAt: now })).rejects.toThrow(
          /AwsSource_state_check/,
        );
        await insertSource({ state, authorizedAt: now, collectFrom: '2026-11-22' });
      }
      // Revogada: só com o horário da revogação, e só ela o tem.
      await expect(insertSource({ state: 'revoked', authorizedAt: now })).rejects.toThrow(
        /AwsSource_state_check/,
      );
      await expect(insertSource({ state: 'available', authorizedAt: now, revokedAt: now })).rejects.toThrow(
        /AwsSource_state_check/,
      );
      await insertSource({ state: 'revoked', authorizedAt: now, revokedAt: now });
      // Quem autorizou e a data de início só existem com a autorização.
      await expect(insertSource({ authorizedBy: 'usuario-1' })).rejects.toThrow(/AwsSource_state_check/);
      await expect(insertSource({ collectFrom: '2026-11-22' })).rejects.toThrow(/AwsSource_state_check/);
      // A fonte autorizada que sumiu continua com a autorização.
      await insertSource({ state: 'source_missing', authorizedAt: now, missingSince: now });
    });

    it('a linha de um bucket cadastrado: uma por tipo e conta, só dos tipos lidos de bucket', async () => {
      const now = new Date();
      const legacy = {
        origin: 'legacy',
        region: 'global',
        resourceId: 'legacy',
        state: 'authorized',
        authorizedAt: now,
      };
      await insertSource({ ...legacy, kind: 'cloudtrail' });
      await expect(insertSource({ ...legacy, kind: 'cloudtrail' })).rejects.toThrow(
        /AwsSource_cloudAccountId_kind_region_resourceId_key/,
      );
      await expect(insertSource({ ...legacy, kind: 'guardduty', method: 'api' })).rejects.toThrow(
        /AwsSource_legacy_check/,
      );
      await expect(insertSource({ ...legacy, kind: 'waf', region: 'sa-east-1' })).rejects.toThrow(
        /AwsSource_legacy_check/,
      );
      await expect(insertSource({ ...legacy, kind: 'waf', resourceId: 'outro' })).rejects.toThrow(
        /AwsSource_legacy_check/,
      );
      await expect(insertSource({ resourceId: 'legacy' })).rejects.toThrow(/AwsSource_legacy_check/);
    });

    it('a fonte e a execução são sempre do mesmo cliente da conta (chave estrangeira composta)', async () => {
      await expect(insertSource({}, awsId, otherTenantId)).rejects.toThrow(
        /AwsSource_cloudAccountId_tenantId_fkey/,
      );
      await expect(
        client.query(
          `INSERT INTO "AwsDiscoveryRun" ("id", "tenantId", "cloudAccountId", "trigger", "updatedAt")
           VALUES ($1, $2, $3, 'connect', now())`,
          [randomUUID(), otherTenantId, awsId],
        ),
      ).rejects.toThrow(/AwsDiscoveryRun_cloudAccountId_tenantId_fkey/);
    });

    it('a execução: o gatilho, o estado e os horários coerentes', async () => {
      const run = (overrides: Record<string, unknown>) => {
        const row: Record<string, unknown> = {
          id: randomUUID(),
          tenantId,
          cloudAccountId: awsId,
          trigger: 'connect',
          updatedAt: new Date(),
          ...overrides,
        };
        const columns = Object.keys(row);
        return client.query(
          `INSERT INTO "AwsDiscoveryRun" (${columns.map((column) => `"${column}"`).join(', ')})
           VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
          Object.values(row),
        );
      };
      const now = new Date();
      await run({});
      await run({ status: 'running', startedAt: now });
      await run({
        status: 'partial',
        startedAt: now,
        finishedAt: now,
        errors: JSON.stringify([{ service: 'rds', region: 'sa-east-1', code: 'AccessDenied' }]),
      });
      await run({ trigger: 'manual', requestedBy: 'usuario-1' });
      await expect(run({ trigger: 'webhook' })).rejects.toThrow(/AwsDiscoveryRun_trigger_check/);
      await expect(run({ status: 'done' })).rejects.toThrow(/AwsDiscoveryRun_status_check/);
      await expect(run({ status: 'pending', startedAt: now })).rejects.toThrow(
        /AwsDiscoveryRun_status_check/,
      );
      await expect(run({ status: 'running' })).rejects.toThrow(/AwsDiscoveryRun_status_check/);
      await expect(run({ status: 'succeeded', startedAt: now })).rejects.toThrow(
        /AwsDiscoveryRun_status_check/,
      );
      await expect(run({ errors: JSON.stringify({ erro: true }) })).rejects.toThrow(
        /AwsDiscoveryRun_payload_check/,
      );
      await expect(run({ summary: JSON.stringify([1]) })).rejects.toThrow(/AwsDiscoveryRun_payload_check/);
      // Só a descoberta manual tem quem pediu.
      await expect(run({ trigger: 'scheduled', requestedBy: 'usuario-1' })).rejects.toThrow(
        /AwsDiscoveryRun_payload_check/,
      );
    });
  });

  describe('banco existente (as migrations anteriores, as contas de antes e então a nova)', () => {
    const database = `verax_mig_onb_${randomBytes(4).toString('hex')}_test`;
    const admin = connect(decodeURIComponent(testUrl.pathname.slice(1)));
    let client: pg.Client;
    const tenantId = randomUUID();
    const ids = {
      verified: randomUUID(),
      unverified: randomUUID(),
      inactive: randomUUID(),
      noBuckets: randomUUID(),
      gcp: randomUUID(),
    };

    beforeAll(async () => {
      await admin.connect();
      await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(database)}`);
      client = connect(database);
      await client.connect();
      for (const name of migrations.filter((candidate) => candidate < MIGRATION))
        await client.query(sqlOf(name));
      await client.query(
        `INSERT INTO "Tenant" ("id", "name", "updatedAt") VALUES ($1, 'Cliente Demo A', now())`,
        [tenantId],
      );
      // Contas no formato de antes: a verificada com os três buckets (dois iguais), a que ainda não foi verificada, a
      // desativada, a AWS sem bucket e um projeto da GCP.
      await client.query(
        `INSERT INTO "CloudAccount" ("id", "tenantId", "provider", "accountId", "regions", "cloudtrailBucket",
           "guarddutyBucket", "wafBucket", "connection", "ingestFrom", "meteredFrom", "status", "updatedAt")
         VALUES ($1, $6, 'aws', '111111111111', ARRAY['sa-east-1'], 'central-111111111111', 'central-111111111111',
                   'aws-waf-logs-111111111111', 'connected', '2026-11-01', '2026-11-02T10:00:00Z', 'active', now()),
                ($2, $6, 'aws', '222222222222', ARRAY['us-east-1'], 'trilha-222222222222', NULL, NULL, 'waiting',
                   NULL, NULL, 'active', now()),
                ($3, $6, 'aws', '333333333333', ARRAY['us-east-1'], NULL, 'achados-333333333333', NULL, 'waiting',
                   '2026-10-15', '2026-10-16T10:00:00Z', 'inactive', now()),
                ($4, $6, 'aws', '444444444444', ARRAY['us-east-1'], NULL, NULL, NULL, 'connected', '2026-11-10',
                   '2026-11-11T10:00:00Z', 'active', now()),
                ($5, $6, 'gcp', 'loja-alfa-demo', ARRAY[]::text[], NULL, NULL, NULL, 'waiting', NULL, NULL,
                   'active', now())`,
        [ids.verified, ids.unverified, ids.inactive, ids.noBuckets, ids.gcp, tenantId],
      );
    });

    afterAll(async () => {
      await client.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(database)} WITH (FORCE)`);
      await admin.end();
    });

    it('cada bucket cadastrado vira uma fonte autorizada, com a coleta a partir do ingestFrom da conta', async () => {
      const before = await client.query(
        'SELECT "id", "cloudtrailBucket", "guarddutyBucket", "wafBucket", "connection", "ingestFrom", "status", "regions" FROM "CloudAccount" ORDER BY "id"',
      );
      await client.query(sqlOf(MIGRATION));

      const sources = await client.query<{
        cloudAccountId: string;
        tenantId: string;
        kind: string;
        region: string;
        resourceId: string;
        name: string;
        details: unknown;
        method: string;
        availability: string;
        permission: string;
        origin: string;
        sensitive: boolean;
        state: string;
        stateCode: string;
        authorized: boolean;
        authorizedBy: string | null;
        revokedAt: Date | null;
        collectFrom: string | null;
      }>(
        `SELECT "cloudAccountId", "tenantId", "kind", "region", "resourceId", "name", "details", "method",
                "availability", "permission", "origin", "sensitive", "state", "stateCode",
                "authorizedAt" IS NOT NULL AS authorized, "authorizedBy", "revokedAt",
                to_char("collectFrom", 'YYYY-MM-DD') AS "collectFrom"
         FROM "AwsSource" ORDER BY "cloudAccountId", "kind"`,
      );
      const summary = sources.rows.map((row) => [row.cloudAccountId, row.kind, row.name, row.collectFrom]);
      expect(summary.sort()).toEqual(
        [
          [ids.verified, 'cloudtrail', 'central-111111111111', '2026-11-01'],
          [ids.verified, 'guardduty_export', 'central-111111111111', '2026-11-01'],
          [ids.verified, 'waf', 'aws-waf-logs-111111111111', '2026-11-01'],
          // Ainda não verificada: sem data de início (a primeira verificação a preenche).
          [ids.unverified, 'cloudtrail', 'trilha-222222222222', null],
          // A conta desativada também: reativada, a fonte já está lá.
          [ids.inactive, 'guardduty_export', 'achados-333333333333', '2026-10-15'],
        ].sort(),
      );
      for (const row of sources.rows) {
        expect(row).toMatchObject({
          tenantId,
          region: 'global',
          resourceId: 'legacy',
          method: 's3',
          availability: 'available',
          permission: 'unknown',
          origin: 'legacy',
          sensitive: false,
          state: 'authorized',
          stateCode: 'awaiting_collector',
          authorized: true,
          authorizedBy: null,
          revokedAt: null,
        });
      }
      expect(
        sources.rows.find((row) => row.cloudAccountId === ids.verified && row.kind === 'guardduty_export')
          ?.details,
      ).toEqual({ bucket: 'central-111111111111', legacySource: 'guardduty' });

      // Nada mudou nas contas: os buckets, a conexão e o início da coleta ficam como estavam.
      const after = await client.query(
        'SELECT "id", "cloudtrailBucket", "guarddutyBucket", "wafBucket", "connection", "ingestFrom", "status", "regions" FROM "CloudAccount" ORDER BY "id"',
      );
      expect(after.rows).toEqual(before.rows);
      const fresh = await client.query<{
        awsConnectRequestedAt: Date | null;
        awsTemplateVersion: number | null;
        awsCapabilities: string[];
        awsCapabilitiesCheckedAt: Date | null;
        awsDiscoveredRegions: string[];
      }>(
        'SELECT "awsConnectRequestedAt", "awsTemplateVersion", "awsCapabilities", "awsCapabilitiesCheckedAt", "awsDiscoveredRegions" FROM "CloudAccount"',
      );
      for (const row of fresh.rows) {
        expect(row).toEqual({
          awsConnectRequestedAt: null,
          awsTemplateVersion: null,
          awsCapabilities: [],
          awsCapabilitiesCheckedAt: null,
          awsDiscoveredRegions: [],
        });
      }
      expect((await client.query('SELECT 1 FROM "AwsDiscoveryRun"')).rowCount).toBe(0);
    });

    it('apagar a conta leva as fontes e as execuções dela junto', async () => {
      await client.query(
        `INSERT INTO "AwsDiscoveryRun" ("id", "tenantId", "cloudAccountId", "trigger", "updatedAt")
         VALUES ($1, $2, $3, 'scheduled', now())`,
        [randomUUID(), tenantId, ids.unverified],
      );
      await client.query('DELETE FROM "CloudAccount" WHERE "id" = $1', [ids.unverified]);
      expect(
        (await client.query('SELECT 1 FROM "AwsSource" WHERE "cloudAccountId" = $1', [ids.unverified]))
          .rowCount,
      ).toBe(0);
      expect(
        (await client.query('SELECT 1 FROM "AwsDiscoveryRun" WHERE "cloudAccountId" = $1', [ids.unverified]))
          .rowCount,
      ).toBe(0);
    });
  });
});
