import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AWS_DISCOVERY_STATUSES,
  AWS_DISCOVERY_TRIGGERS,
  AWS_READER_AUTHORIZATIONS,
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
/** A que veio depois, no mesmo trabalho: a coluna do limite do "Tentar de novo" de uma fonte. */
const RETRY_LIMIT = '20261124130000_aws_source_retry_limit';
/** E a da nota dos flow logs lidos juntos: o CHECK da descoberta com um valor a mais na lista de notas. */
const FLOW_NOTE = '20261124140000_aws_source_note_flow_logs';
/** E a da prova do dono dos alertas do CloudWatch Logs: uma tabela nova, do sistema. */
const OWNERSHIP = '20261124150000_cloudwatch_alert_ownership';
/** E a da escolha do cliente no "Conectar": uma coluna na conta, com o CHECK dela. */
const CHOSEN = '20261124160000_aws_chosen_capabilities';
/** E a do número de sequência do sinal `applied` na prova do dono: uma coluna, com o CHECK dela. */
const APPLIED_SEQ = '20261124170000_cloudwatch_ownership_applied_seq';
/** A seguinte, de outro trabalho: a base dos casos (`alert-cases-migration.test.ts`). */
const ALERT_CASES = '20261127120000_alert_cases';
/** E, de outro trabalho, só índices: os alertas a validar da Torre e os e-mails ao contato de escalonamento na hora. */
const UNTRIAGED_INDEX = '20261128120000_finding_untriaged_index';
const NOTICE_INDEX = '20261128120000_notification_escalation_index';
/** E a do autovacuum da tabela de alertas, que a atribuição dos casos atualiza (`case-assign.test.ts`). */
const FINDING_AUTOVACUUM = '20261129120000_finding_autovacuum';
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
  it('só acrescenta, ela e a do limite do "Tentar de novo", que vem depois: nada é apagado nem reescrito', () => {
    expect(migrations.slice(migrations.indexOf(MIGRATION) + 1)).toEqual([
      RETRY_LIMIT,
      FLOW_NOTE,
      OWNERSHIP,
      CHOSEN,
      APPLIED_SEQ,
      ALERT_CASES,
      UNTRIAGED_INDEX,
      NOTICE_INDEX,
      FINDING_AUTOVACUUM,
    ]);
    const additive = [MIGRATION, RETRY_LIMIT, OWNERSHIP, CHOSEN, APPLIED_SEQ, UNTRIAGED_INDEX, NOTICE_INDEX];
    for (const name of additive) {
      const sql = sqlOf(name);
      expect(sql, name).not.toMatch(/\bDROP\b|DELETE FROM|^\s*UPDATE\b|\bTRUNCATE\b|ALTER COLUMN/im);
      // Os buckets cadastrados continuam nas colunas da conta.
      expect(sql, name).not.toMatch(/DROP COLUMN/i);
    }
    // A segunda é uma coluna só, sem valor obrigatório: as fontes que já existem ficam como estão.
    const statements = sqlOf(RETRY_LIMIT)
      .split('\n')
      .filter((line) => line.trim().length > 0 && !line.startsWith('--'));
    expect(statements).toEqual([
      'ALTER TABLE "AwsSource" ADD COLUMN     "lastProbeRequestAt" TIMESTAMPTZ(3);',
    ]);
  });

  it('a da nota dos flow logs só troca o CHECK da descoberta pelo mesmo, com a nota a mais', () => {
    const statements = (name: string) =>
      sqlOf(name)
        .split('\n')
        .filter((line) => line.trim().length > 0 && !line.startsWith('--'));
    const opening = 'ALTER TABLE "AwsSource" ADD CONSTRAINT "AwsSource_discovery_check" CHECK (';
    const original = statements(MIGRATION);
    const from = original.indexOf(opening);
    const check = original.slice(from, original.indexOf(');', from) + 1);
    expect(check.length).toBeGreaterThan(5);
    // Uma constraint sai e a mesma volta: nenhuma tabela, coluna ou linha é tocada.
    expect(statements(FLOW_NOTE)).toEqual([
      'ALTER TABLE "AwsSource" DROP CONSTRAINT "AwsSource_discovery_check";',
      ...check.map((line) =>
        line.replace("'not_collected_yet'", "'not_collected_yet', 'flow_logs_read_together'"),
      ),
    ]);
    expect(AWS_SOURCE_NOTES).toContain('flow_logs_read_together');
  });

  it('a da prova do dono dos alertas do CloudWatch Logs só cria a tabela dela, do sistema: sem cliente e sem chave estrangeira', () => {
    const sql = sqlOf(OWNERSHIP);
    const statements = sql
      .split('\n')
      .filter((line) => line.trim().length > 0 && !line.startsWith('--'))
      .join('\n');
    // Uma tabela e o CHECK dela; nada do que já existe é citado.
    expect(statements.match(/^(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b.*$/gm)).toEqual([
      'CREATE TABLE "CloudWatchAlertOwnership" (',
      'ALTER TABLE "CloudWatchAlertOwnership" ADD CONSTRAINT "CloudWatchAlertOwnership_owner_check" CHECK (',
    ]);
    // Não é dado do cliente: sem `tenantId` (o escopo do cliente nunca a alcança) e sem chave estrangeira.
    expect(statements).not.toMatch(/"tenantId"|FOREIGN KEY|REFERENCES/);
  });

  it('a da escolha do "Conectar" e a do número de sequência só acrescentam uma coluna vazia e o CHECK dela', () => {
    const statements = (name: string) =>
      sqlOf(name)
        .split('\n')
        .filter((line) => line.trim().length > 0 && !line.startsWith('--'))
        .join('\n')
        .match(/^(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b.*$/gm);
    // Sem valor obrigatório nem padrão: as linhas que já existem ficam como estão (null).
    expect(statements(CHOSEN)).toEqual([
      'ALTER TABLE "CloudAccount" ADD COLUMN     "awsChosenCapabilities" VARCHAR(64);',
      'ALTER TABLE "CloudAccount" ADD CONSTRAINT "CloudAccount_aws_chosen_capabilities_check" CHECK (',
    ]);
    expect(statements(APPLIED_SEQ)).toEqual([
      'ALTER TABLE "CloudWatchAlertOwnership" ADD COLUMN     "appliedSeq" BIGINT;',
      'ALTER TABLE "CloudWatchAlertOwnership" ADD CONSTRAINT "CloudWatchAlertOwnership_applied_seq_check" CHECK (',
    ]);
    for (const name of [CHOSEN, APPLIED_SEQ]) expect(sqlOf(name), name).not.toMatch(/NOT NULL|DEFAULT/);
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

    it('a escolha do "Conectar": só na conta AWS, só as três autorizações, sem repetir e na ordem do catálogo', async () => {
      const set = (id: string, value: string | null) =>
        client.query(`UPDATE "CloudAccount" SET "awsChosenCapabilities" = $2 WHERE "id" = $1`, [id, value]);
      // Toda combinação das autorizações do contrato, na ordem dele, vale (a vazia também: só a descoberta).
      const combinations = AWS_READER_AUTHORIZATIONS.reduce<string[][]>(
        (all, authorization) => [...all, ...all.map((chosen) => [...chosen, authorization])],
        [[]],
      );
      expect(combinations).toHaveLength(8);
      for (const chosen of combinations) await set(awsId, chosen.join(' '));
      await set(awsId, null);
      for (const value of [
        'discovery',
        'discovery findings',
        'findings service-logs',
        'findings findings',
        'findings,log-groups',
        'findings ',
        ' findings',
        'service-logs  findings',
        'resposta',
      ]) {
        await expect(set(awsId, value), value).rejects.toThrow(/CloudAccount_aws_chosen_capabilities_check/);
      }
      await expect(set(gcpId, 'findings')).rejects.toThrow(/CloudAccount_aws_chosen_capabilities_check/);
      await expect(set(gcpId, '')).rejects.toThrow(/CloudAccount_aws_chosen_capabilities_check/);
      await set(gcpId, null);
    });

    it('o número de sequência da prova do dono: vazio ou a partir de zero', async () => {
      const id = `mig-${randomBytes(6).toString('hex')}`;
      const insert = (appliedSeq: string | null) =>
        client.query(
          `INSERT INTO "CloudWatchAlertOwnership" ("id", "generation", "since", "confirmedAt", "updatedAt", "appliedSeq")
           VALUES ($1, $2, now(), now(), now(), $3)
           ON CONFLICT ("id") DO UPDATE SET "appliedSeq" = EXCLUDED."appliedSeq"`,
          [id, 'a'.repeat(64), appliedSeq],
        );
      try {
        await insert(null);
        await insert('0');
        // Cabe o contador que começa na hora do host, em segundos, por muitos anos.
        await insert('9007199254740991');
        await expect(insert('-1')).rejects.toThrow(/CloudWatchAlertOwnership_applied_seq_check/);
      } finally {
        await client.query('DELETE FROM "CloudWatchAlertOwnership" WHERE "id" = $1', [id]);
      }
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

    it('as duas seguintes não tocam nas fontes que já existem, e a nota dos flow logs passa a caber no CHECK', async () => {
      const sources = () =>
        client.query<{ id: string }>(
          'SELECT "id", "kind", "notes", "state", "details" FROM "AwsSource" ORDER BY "id"',
        );
      const before = await sources();
      expect(before.rows.length).toBeGreaterThan(0);
      const id = before.rows[0]?.id;
      const note = (value: string) =>
        client.query('UPDATE "AwsSource" SET "notes" = ARRAY[$2]::text[] WHERE "id" = $1', [id, value]);
      // Antes da migration da nota, o CHECK a recusa.
      await expect(note('flow_logs_read_together')).rejects.toThrow(/AwsSource_discovery_check/);

      await client.query(sqlOf(RETRY_LIMIT));
      await client.query(sqlOf(FLOW_NOTE));
      expect((await sources()).rows).toEqual(before.rows);
      expect(listedAfter(await constraint(client, 'AwsSource_discovery_check'), 'notes <@').sort()).toEqual(
        [...AWS_SOURCE_NOTES].sort(),
      );
      // Depois, a nota nova cabe, e uma que não existe segue recusada.
      await note('flow_logs_read_together');
      await expect(note('nota_que_nao_existe')).rejects.toThrow(/AwsSource_discovery_check/);
    });
  });
});
