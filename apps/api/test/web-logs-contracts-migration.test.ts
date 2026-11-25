import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AWS_SOURCE_NOTES, WEB_ESTIMATE_STATUSES } from '@verax/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * A migration dos contratos dos logs do ALB (`20261201120000_web_logs_contracts`): a nota a mais no CHECK da descoberta e a
 * tabela da estimativa. O banco novo é o de teste; o existente, um descartável só deste arquivo, com as migrations anteriores,
 * linhas no formato de antes e a nova por cima (e, nele, o que a imagem anterior do nó faz no esquema novo).
 */

const MIGRATION = '20261201120000_web_logs_contracts';
const FLOW_NOTE = '20261124140000_aws_source_note_flow_logs';
const CHECK = 'AwsSource_discovery_check';
const NOTE = 'aws_cost_alb_logs';

const migrationsDir = fileURLToPath(new URL('../prisma/migrations', import.meta.url));
const migrations = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const sqlOf = (name: string) => readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8');
/** Só os comandos: sem comentário. */
const lines = (name: string) =>
  sqlOf(name)
    .split('\n')
    .filter((line) => line.trim().length > 0 && !line.startsWith('--'));

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

async function insert(client: pg.Client, table: string, row: Record<string, unknown>): Promise<void> {
  const columns = Object.keys(row);
  await client.query(
    `INSERT INTO ${client.escapeIdentifier(table)} (${columns.map((column) => client.escapeIdentifier(column)).join(', ')})
     VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
    Object.values(row),
  );
}

interface Seeded {
  tenantId: string;
  accountId: string;
  sourceId: string;
}

const sourceRow = (ids: Seeded, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: ids.sourceId,
  tenantId: ids.tenantId,
  cloudAccountId: ids.accountId,
  kind: 'elb_logs',
  region: 'sa-east-1',
  resourceId: `loja-${randomBytes(4).toString('hex')}`,
  name: 'loja',
  method: 's3',
  availability: 'available',
  state: 'unavailable',
  stateCode: 'not_collectable_yet',
  notes: ['not_collected_yet'],
  updatedAt: new Date(),
  ...overrides,
});

async function seed(client: pg.Client, name: string): Promise<Seeded> {
  const ids = { tenantId: randomUUID(), accountId: randomUUID(), sourceId: randomUUID() };
  await insert(client, 'Tenant', { id: ids.tenantId, name, updatedAt: new Date() });
  await insert(client, 'CloudAccount', {
    id: ids.accountId,
    tenantId: ids.tenantId,
    provider: 'aws',
    accountId: String(100_000_000_000 + Math.floor(Math.random() * 8e11)),
    regions: ['sa-east-1'],
    updatedAt: new Date(),
  });
  await insert(client, 'AwsSource', sourceRow(ids));
  return ids;
}

const AT = new Date('2026-11-24T12:00:00.000Z');
const estimateRow = (ids: Seeded, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  sourceId: ids.sourceId,
  tenantId: ids.tenantId,
  lastRequestAt: AT,
  updatedAt: AT,
  ...overrides,
});
const READY = {
  status: 'ready',
  computedAt: AT,
  day: '2026-11-23',
  objects: 864,
  sampledObjects: 20,
  bytesPerDay: 2_400_000_000,
};

async function noteList(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query<{ definition: string }>(
    'SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = $1',
    [CHECK],
  );
  const definition = rows[0]?.definition ?? '';
  const open = definition.indexOf('[', definition.indexOf('notes <@'));
  return [...definition.slice(open, definition.indexOf(']', open)).matchAll(/'([^']+)'/g)].map(
    (match) => match[1] ?? '',
  );
}

describe(`migration ${MIGRATION}`, () => {
  it('vem depois da dos logs web, e só troca o CHECK da descoberta pelo mesmo com a nota a mais e cria uma tabela', () => {
    expect(migrations.slice(-2)).toEqual(['20261130120000_web_logs', MIGRATION]);
    const own = lines(MIGRATION);
    expect([own.at(0), own.at(-1)]).toEqual(['BEGIN;', 'COMMIT;']);
    // O CHECK de antes, linha a linha, com a nota no fim da lista.
    const before = lines(FLOW_NOTE);
    expect(own.slice(1, 1 + before.length)).toEqual(
      before.map((line) => (line.endsWith("'flow_logs_read_together'") ? `${line}, '${NOTE}'` : line)),
    );
    const rest = own.slice(1 + before.length, -1).join('\n');
    expect(rest).not.toMatch(/\bDROP\b|DELETE FROM|^\s*UPDATE\b|\bTRUNCATE\b|ALTER COLUMN|"AwsSource" /im);
    expect(rest.match(/CREATE TABLE/g)).toHaveLength(1);
    const references = rest.match(/FOREIGN KEY[^;]+;/g) ?? [];
    expect(references).toHaveLength(2);
    for (const reference of references) expect(reference).toContain('ON DELETE CASCADE');
    // A da fonte leva o cliente, e a troca do dono não a arrasta.
    expect(references[1]).toContain('("sourceId", "tenantId") REFERENCES "AwsSource"("id", "tenantId")');
    expect(references[1]).toContain('ON UPDATE RESTRICT');
  });

  describe('banco novo', () => {
    let client: pg.Client;
    let a: Seeded;
    let b: Seeded;

    beforeAll(async () => {
      client = connect(decodeURIComponent(testUrl.pathname.slice(1)));
      await client.connect();
      a = await seed(client, 'Cliente Demo A (contratos web)');
      b = await seed(client, 'Cliente Demo B (contratos web)');
    });

    afterAll(async () => {
      for (const { tenantId } of [a, b]) {
        await client.query('DELETE FROM "CloudAccount" WHERE "tenantId" = $1', [tenantId]);
        await client.query('DELETE FROM "Tenant" WHERE "id" = $1', [tenantId]);
      }
      await client.end();
    });

    const attempt = async (overrides: Record<string, unknown>): Promise<string | null> => {
      await client.query('BEGIN');
      try {
        await insert(client, 'WebSourceEstimate', estimateRow(a, overrides));
        return null;
      } catch (error) {
        return (error as { constraint?: string }).constraint ?? String(error);
      } finally {
        await client.query('ROLLBACK');
      }
    };

    it('o CHECK da descoberta tem as notas do contrato, e nada mais', async () => {
      expect((await noteList(client)).sort()).toEqual([...AWS_SOURCE_NOTES].sort());
    });

    it('a estimativa: pedida, com o volume, sem amostra ou com o motivo da falha; nada no meio', async () => {
      const failed = { status: 'failed', computedAt: AT, errorCode: 'AccessDenied' };
      const empty = { ...READY, status: 'no_sample', bytesPerDay: null, objects: 0, sampledObjects: 0 };
      for (const overrides of [
        {},
        { requestedAt: AT, requestedBy: 'usuario' },
        READY,
        { ...READY, truncated: true, requestedAt: AT },
        { ...READY, sampledObjects: null },
        { ...READY, bytesPerDay: '9007199254740991' },
        empty,
        failed,
        { ...failed, day: '2026-11-23' },
      ]) {
        expect(await attempt(overrides), JSON.stringify(overrides)).toBeNull();
      }
      for (const overrides of [
        { status: 'ready' },
        { computedAt: AT },
        { ...READY, status: 'pending' },
        { ...READY, bytesPerDay: null },
        { ...READY, bytesPerDay: -1 },
        { ...READY, bytesPerDay: '9007199254740992' },
        { ...READY, day: null },
        { ...READY, objects: null },
        { ...READY, objects: null, sampledObjects: null },
        { ...READY, objects: -1, sampledObjects: null },
        { ...READY, sampledObjects: 865 },
        { ...READY, sampledObjects: -1 },
        { ...READY, errorCode: 'AccessDenied' },
        { ...empty, bytesPerDay: 0 },
        { ...failed, errorCode: null },
        { ...failed, errorCode: 'mensagem com espaço' },
        { bytesPerDay: 1 },
        { errorCode: 'AccessDenied' },
        { requestedBy: '  ' },
      ]) {
        expect(await attempt(overrides), JSON.stringify(overrides)).toBe('WebSourceEstimate_values_check');
      }
      expect([...WEB_ESTIMATE_STATUSES].sort()).toEqual(['failed', 'no_sample', 'ready']);
    });

    it('uma por fonte, sempre do cliente da fonte, e sai com ela', async () => {
      expect(await attempt({ sourceId: b.sourceId })).toBe('WebSourceEstimate_sourceId_tenantId_fkey');
      expect(await attempt({ tenantId: b.tenantId })).toBe('WebSourceEstimate_sourceId_tenantId_fkey');
      await insert(client, 'WebSourceEstimate', estimateRow(a, READY));
      await expect(insert(client, 'WebSourceEstimate', estimateRow(a))).rejects.toThrow(/_pkey/);
      await client.query('DELETE FROM "AwsSource" WHERE "id" = $1', [a.sourceId]);
      const { rowCount } = await client.query('SELECT 1 FROM "WebSourceEstimate" WHERE "tenantId" = $1', [
        a.tenantId,
      ]);
      expect(rowCount).toBe(0);
    });
  });

  describe('banco existente, e a imagem anterior do nó no esquema novo', () => {
    const database = `verax_web_contracts_${randomBytes(6).toString('hex')}`;
    let admin: pg.Client;
    let client: pg.Client;
    let a: Seeded;
    let before: Record<string, unknown>[];
    const sources = async () =>
      (
        await client.query<Record<string, unknown>>(
          'SELECT * FROM "AwsSource" WHERE "tenantId" = $1 ORDER BY "id"',
          [a.tenantId],
        )
      ).rows;
    const setNotes = (notes: string[]) =>
      client.query('UPDATE "AwsSource" SET "notes" = $2 WHERE "id" = $1', [a.sourceId, notes]);

    beforeAll(async () => {
      admin = connect(decodeURIComponent(testUrl.pathname.slice(1)));
      await admin.connect();
      await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(database)}`);
      client = connect(database);
      await client.connect();
      for (const name of migrations.filter((candidate) => candidate < MIGRATION)) {
        await client.query(sqlOf(name));
      }
      a = await seed(client, 'Cliente Demo A');
      // Uma linha por nota de antes, para o CHECK novo passar por todas.
      for (const note of AWS_SOURCE_NOTES.filter((value) => value !== NOTE)) {
        await insert(client, 'AwsSource', sourceRow({ ...a, sourceId: randomUUID() }, { notes: [note] }));
      }
      before = await sources();
      await expect(setNotes([NOTE])).rejects.toThrow(CHECK);

      // Uma falha no fim não deixa nada para trás.
      const broken = `${sqlOf(MIGRATION).slice(0, sqlOf(MIGRATION).lastIndexOf('COMMIT;'))}SELECT 1 / 0;\nCOMMIT;`;
      await expect(client.query(broken)).rejects.toThrow(/division by zero/);
      await client.query('ROLLBACK');
      expect(await noteList(client)).not.toContain(NOTE);

      await client.query(sqlOf(MIGRATION));
    });

    afterAll(async () => {
      await client.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(database)} WITH (FORCE)`);
      await admin.end();
    });

    it('nenhuma linha muda, a nota nova cabe, e uma que não existe segue recusada', async () => {
      expect(await sources()).toEqual(before);
      await setNotes([NOTE, 'high_volume']);
      await expect(setNotes(['nota_que_nao_existe'])).rejects.toThrow(CHECK);
      expect((await client.query('SELECT 1 FROM "WebSourceEstimate"')).rowCount).toBe(0);
    });

    it('a imagem anterior grava fonte como sempre, por cima do que a nova deixou, e apaga fonte, conta e cliente', async () => {
      await setNotes([NOTE]);
      await insert(client, 'WebSourceEstimate', estimateRow(a, READY));
      // A descoberta dela, com os ataques web desconhecidos: regrava a fonte que voltou a ter log, e esquece a sem log.
      await client.query(
        `UPDATE "AwsSource" SET "notes" = '{not_collected_yet}', "availability" = 'available', "state" = 'unavailable',
           "stateCode" = 'not_collectable_yet', "permission" = 'unknown', "lastSeenAt" = now() WHERE "id" = $1`,
        [a.sourceId],
      );
      const other = { ...a, sourceId: randomUUID() };
      await insert(client, 'AwsSource', sourceRow(other));
      await insert(client, 'WebSourceEstimate', estimateRow(other));
      await client.query('DELETE FROM "AwsSource" WHERE "id" = $1 AND "authorizedAt" IS NULL', [
        other.sourceId,
      ]);
      const estimates = async () =>
        (await client.query('SELECT 1 FROM "WebSourceEstimate" WHERE "tenantId" = $1', [a.tenantId]))
          .rowCount;
      expect(await estimates()).toBe(1);
      await client.query('DELETE FROM "CloudAccount" WHERE "id" = $1', [a.accountId]);
      expect(await estimates()).toBe(0);
      await client.query('DELETE FROM "Tenant" WHERE "id" = $1', [a.tenantId]);
    });
  });
});
