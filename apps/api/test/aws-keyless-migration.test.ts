import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * A migration do PR-V3' (`20261107100000_aws_keyless_connect`): o ExternalId deixa de ser exigido e perde os valores,
 * a verificação e o início da coleta ganham coluna (só na AWS) e o tipo `aws_access_key` sai do cofre.
 *
 * Duas frentes:
 * - banco novo: o banco de teste, migrado do zero pelo `prisma migrate deploy` do `global-setup`;
 * - banco existente: um banco descartável, só deste arquivo, com as migrations anteriores aplicadas uma a uma (cada
 *   arquivo numa chamada só, como o Prisma faz), dados no formato de antes e então a migration nova. Com uma credencial
 *   `aws_access_key`, ela para inteira e não muda nada.
 */

const MIGRATION = '20261107100000_aws_keyless_connect';
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

async function enumValues(client: pg.Client, type: string): Promise<string[]> {
  const result = await client.query<{ value: string }>(
    'SELECT e.enumlabel AS value FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = $1 ORDER BY e.enumsortorder',
    [type],
  );
  return result.rows.map((row) => row.value);
}

async function checks(client: pg.Client): Promise<string[]> {
  const result = await client.query<{ name: string }>(
    `SELECT conname AS name FROM pg_constraint WHERE conrelid = '"CloudAccount"'::regclass AND contype = 'c' ORDER BY 1`,
  );
  return result.rows.map((row) => row.name);
}

describe(`migration ${MIGRATION}`, () => {
  it('é a única que mexe no ExternalId e no enum do cofre desde o PR-V1: nenhuma depois dela toca neles', () => {
    expect(migrations).toContain(MIGRATION);
    // As migrations seguintes (a dos motivos da fila sem dono dos agentes, por exemplo) não podem mexer no que esta
    // deixou: o ExternalId fora do cadastro e o cofre só com o token do Cloudflare.
    for (const name of migrations.filter((candidate) => candidate > MIGRATION)) {
      expect(sqlOf(name)).not.toMatch(/externalId|CloudCredential/i);
    }
  });

  describe('banco novo (o banco de teste, migrado do zero)', () => {
    let client: pg.Client;

    beforeAll(async () => {
      client = connect(decodeURIComponent(testUrl.pathname.slice(1)));
      await client.connect();
    });

    afterAll(async () => {
      await client.end();
    });

    it('sem o CHECK do ExternalId, com o das colunas da AWS, e o cofre só com o token do Cloudflare', async () => {
      expect(await checks(client)).toEqual([
        'CloudAccount_aws_check_fields_check',
        'CloudAccount_gcp_sinkWriterIdentity_check',
      ]);
      expect(await enumValues(client, 'CloudCredentialKind')).toEqual(['cloudflare_api_token']);
      const leftovers = await client.query(
        `SELECT 1 FROM pg_type WHERE typname LIKE 'CloudCredentialKind\\_%'`,
      );
      expect(leftovers.rowCount).toBe(0);
      const columns = await client.query<{ name: string; type: string }>(
        `SELECT column_name AS name, data_type AS type FROM information_schema.columns
         WHERE table_name = 'CloudAccount' AND column_name IN ('checkRequestedAt', 'ingestFrom', 'externalId')
         ORDER BY 1`,
      );
      expect(columns.rows).toEqual([
        { name: 'checkRequestedAt', type: 'timestamp with time zone' },
        // Fica, vazia e sem uso, para a versão anterior da API numa volta de versão.
        { name: 'externalId', type: 'character varying' },
        { name: 'ingestFrom', type: 'date' },
      ]);
    });
  });

  describe('banco existente (as migrations anteriores, os dados de antes e então a nova)', () => {
    const database = `verax_mig_v3_${randomBytes(4).toString('hex')}_test`;
    const admin = connect(decodeURIComponent(testUrl.pathname.slice(1)));
    let client: pg.Client;
    const tenantId = randomUUID();
    const awsId = randomUUID();
    const gcpId = randomUUID();
    const cloudflareId = randomUUID();
    // Valores fictícios, no formato de antes: o ExternalId do conector antigo e um envelope do cofre.
    const externalId = randomBytes(32).toString('base64url');
    const ciphertext = `v1:${randomBytes(384).toString('base64')}`;

    async function applyBefore(target: pg.Client): Promise<void> {
      for (const name of migrations.filter((candidate) => candidate < MIGRATION)) {
        await target.query(sqlOf(name));
      }
    }

    async function seedPreviousState(target: pg.Client): Promise<void> {
      await target.query(
        `INSERT INTO "Tenant" ("id", "name", "updatedAt") VALUES ($1, 'Cliente Demo A', now())`,
        [tenantId],
      );
      await target.query(
        `INSERT INTO "CloudAccount" ("id", "tenantId", "provider", "accountId", "regions", "externalId", "updatedAt")
         VALUES ($1, $2, 'aws', '111122223333', ARRAY['sa-east-1'], $3, now()),
                ($4, $2, 'gcp', 'loja-alfa-demo', ARRAY[]::text[], NULL, now()),
                ($5, $2, 'cloudflare', $6, ARRAY[]::text[], NULL, now())`,
        [awsId, tenantId, externalId, gcpId, cloudflareId, 'a'.repeat(32)],
      );
      await target.query(
        `INSERT INTO "CloudCredential" ("cloudAccountId", "tenantId", "kind", "ciphertext", "keyVersion", "keyIdSuffix", "verifiedAt", "updatedAt")
         VALUES ($1, $2, 'cloudflare_api_token', $3, 1, 'a1b2', now(), now())`,
        [cloudflareId, tenantId, ciphertext],
      );
    }

    beforeAll(async () => {
      await admin.connect();
      await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(database)}`);
      client = connect(database);
      await client.connect();
      await applyBefore(client);
      await seedPreviousState(client);
    });

    afterAll(async () => {
      await client.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(database)} WITH (FORCE)`);
      await admin.end();
    });

    it('antes: toda conta AWS exige ExternalId, e o cofre aceita o tipo aws_access_key', async () => {
      expect(await checks(client)).toContain('CloudAccount_aws_externalId_check');
      expect(await enumValues(client, 'CloudCredentialKind')).toEqual([
        'aws_access_key',
        'cloudflare_api_token',
      ]);
    });

    it('com uma credencial aws_access_key no cofre, a migration para inteira e não muda nada', async () => {
      const awsCredentialAccount = randomUUID();
      await client.query(
        `INSERT INTO "CloudAccount" ("id", "tenantId", "provider", "accountId", "regions", "externalId", "updatedAt")
         VALUES ($1, $2, 'aws', '444455556666', ARRAY['sa-east-1'], $3, now())`,
        [awsCredentialAccount, tenantId, randomBytes(32).toString('base64url')],
      );
      await client.query(
        `INSERT INTO "CloudCredential" ("cloudAccountId", "tenantId", "kind", "ciphertext", "keyVersion", "keyIdSuffix", "verifiedAt", "updatedAt")
         VALUES ($1, $2, 'aws_access_key', $3, 1, 'w1x2', now(), now())`,
        [awsCredentialAccount, tenantId, ciphertext],
      );
      await expect(client.query(sqlOf(MIGRATION))).rejects.toThrow(/aws_access_key no cofre/);
      // O BEGIN da migration deixa a sessão na transação abortada: o ROLLBACK a encerra sem gravar nada.
      await client.query('ROLLBACK');
      expect(await checks(client)).toContain('CloudAccount_aws_externalId_check');
      expect(await enumValues(client, 'CloudCredentialKind')).toEqual([
        'aws_access_key',
        'cloudflare_api_token',
      ]);
      const kept = await client.query<{ externalId: string | null }>(
        'SELECT "externalId" FROM "CloudAccount" WHERE "id" = $1',
        [awsId],
      );
      expect(kept.rows[0]?.externalId).toBe(externalId);
      const columns = await client.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'CloudAccount' AND column_name = 'ingestFrom'`,
      );
      expect(columns.rowCount).toBe(0);
      // Sem a linha (o que nunca existiu em produção), a migration passa.
      await client.query('DELETE FROM "CloudCredential" WHERE "cloudAccountId" = $1', [awsCredentialAccount]);
      await client.query('DELETE FROM "CloudAccount" WHERE "id" = $1', [awsCredentialAccount]);
    });

    it('depois: o ExternalId sai (o valor e a exigência), as colunas novas nascem vazias e o token do Cloudflare fica', async () => {
      await client.query(sqlOf(MIGRATION));

      expect(await checks(client)).toEqual([
        'CloudAccount_aws_check_fields_check',
        'CloudAccount_gcp_sinkWriterIdentity_check',
      ]);
      expect(await enumValues(client, 'CloudCredentialKind')).toEqual(['cloudflare_api_token']);
      const accounts = await client.query<{
        id: string;
        externalId: string | null;
        checkRequestedAt: Date | null;
        ingestFrom: Date | null;
        connection: string;
      }>(
        'SELECT "id", "externalId", "checkRequestedAt", "ingestFrom", "connection" FROM "CloudAccount" ORDER BY "id"',
      );
      expect(accounts.rows).toHaveLength(3);
      for (const row of accounts.rows) {
        expect(row).toMatchObject({
          externalId: null,
          checkRequestedAt: null,
          ingestFrom: null,
          connection: 'waiting',
        });
      }
      // A credencial do Cloudflare continua igual, já no tipo novo do enum.
      const credential = await client.query<{ kind: string; ciphertext: string }>(
        'SELECT "kind"::text AS kind, "ciphertext" FROM "CloudCredential" WHERE "cloudAccountId" = $1',
        [cloudflareId],
      );
      expect(credential.rows).toEqual([{ kind: 'cloudflare_api_token', ciphertext }]);

      // A conta AWS nova não precisa mais de ExternalId; o tipo antigo não entra no cofre.
      await client.query(
        `INSERT INTO "CloudAccount" ("id", "tenantId", "provider", "accountId", "regions", "updatedAt")
         VALUES ($1, $2, 'aws', '777788889999', ARRAY['sa-east-1'], now())`,
        [randomUUID(), tenantId],
      );
      await expect(
        client.query(
          `INSERT INTO "CloudCredential" ("cloudAccountId", "tenantId", "kind", "ciphertext", "keyVersion", "keyIdSuffix", "verifiedAt", "updatedAt")
           VALUES ($1, $2, 'aws_access_key', $3, 1, 'w1x2', now(), now())`,
          [awsId, tenantId, ciphertext],
        ),
      ).rejects.toThrow(/invalid input value for enum/);
      // Verificação e início da coleta só na conta AWS.
      await client.query(
        'UPDATE "CloudAccount" SET "checkRequestedAt" = now(), "ingestFrom" = $2 WHERE "id" = $1',
        [awsId, '2026-11-03'],
      );
      await expect(
        client.query('UPDATE "CloudAccount" SET "checkRequestedAt" = now() WHERE "id" = $1', [gcpId]),
      ).rejects.toThrow(/CloudAccount_aws_check_fields_check/);
      await expect(
        client.query('UPDATE "CloudAccount" SET "ingestFrom" = $2 WHERE "id" = $1', [
          cloudflareId,
          '2026-11-03',
        ]),
      ).rejects.toThrow(/CloudAccount_aws_check_fields_check/);
    });
  });
});
