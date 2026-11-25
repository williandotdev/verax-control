import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * A migration das exceções amplas (`20261204120000_scoped_exceptions`), num banco descartável só deste arquivo, com as
 * migrations anteriores aplicadas uma a uma, dados no formato de antes e então a nova. Nele roda a simulação da imagem
 * anterior do nó no esquema novo: os comandos dela, só com as colunas que ela conhece (lidas do banco antes da migration).
 */

const MIGRATION = '20261204120000_scoped_exceptions';
const migrationsDir = fileURLToPath(new URL('../prisma/migrations', import.meta.url));
const migrations = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const sqlOf = (name: string) => readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8');
const testUrl = new URL(inject('testDatabaseUrl'));
const DAY_MS = 24 * 60 * 60 * 1000;

function connect(database: string): pg.Client {
  return new pg.Client({
    host: testUrl.hostname,
    port: Number(testUrl.port || 5432),
    user: decodeURIComponent(testUrl.username),
    password: decodeURIComponent(testUrl.password),
    database,
  });
}

async function insert(
  client: pg.Client,
  table: string,
  row: Record<string, unknown>,
): Promise<pg.QueryResult> {
  const columns = Object.keys(row);
  return client.query(
    `INSERT INTO ${client.escapeIdentifier(table)} (${columns.map((column) => client.escapeIdentifier(column)).join(', ')})
     VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
    Object.values(row),
  );
}

async function sqlState(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe(`migration ${MIGRATION}`, () => {
  const database = `scoped_exc_${randomUUID().slice(0, 8)}_test`;
  const admin = connect(testUrl.pathname.slice(1));
  let client: pg.Client;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const userId = randomUUID();
  const seeded = randomUUID();
  const old = new Date(Date.now() - 10 * DAY_MS);
  let previousFinding: string[] = [];

  const findingRow = (tenantId: string, overrides: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    tenantId,
    accountId: '111111111111',
    source: 'aws',
    sourceEventId: `amplas-${randomUUID()}`,
    logSource: 'inspector',
    occurredAt: new Date(),
    severity: 'medium',
    status: 'new',
    ruleId: '990511',
    ruleLevel: 7,
    title: 'Alerta de teste da migration',
    mitreTactics: [],
    mitreTechniques: [],
    updatedAt: new Date(),
    ...overrides,
  });
  const exceptionRow = (tenantId: string, overrides: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    tenantId,
    ruleId: '990511',
    logSource: 'inspector',
    accountId: '111111111111',
    eventName: 'CVE-2026-0001',
    reason: 'Teste',
    expiresAt: new Date(Date.now() + 30 * DAY_MS),
    createdById: userId,
    updatedAt: new Date(),
    ...overrides,
  });

  /** Recusa, no próprio teste, uma coluna que a imagem anterior não conhece. */
  const insertAsPrevious = (row: Record<string, unknown>) => {
    const unknown = Object.keys(row).filter((name) => !previousFinding.includes(name));
    if (unknown.length > 0) throw new Error(`a imagem anterior não conhece ${unknown.join(', ')}`);
    return insert(client, 'Finding', row);
  };

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(database)}`);
    client = connect(database);
    await client.connect();
    for (const name of migrations.slice(0, migrations.indexOf(MIGRATION))) await client.query(sqlOf(name));
    await client.query(
      `INSERT INTO "Tenant" ("id", "name", "updatedAt") VALUES ($1, 'Cliente Demo A', now()), ($2, 'Cliente Demo B', now())`,
      [tenantA, tenantB],
    );
    await client.query(
      `INSERT INTO "User" ("id", "name", "email", "role", "tenantId", "status", "updatedAt")
       VALUES ($1, 'Administrador de teste', $2, 'admin_cliente', $3, 'active', now())`,
      [userId, `admin-${randomUUID()}@cliente.example`, tenantA],
    );
    await insert(client, 'Finding', findingRow(tenantA, { id: seeded, createdAt: old, updatedAt: old }));
    previousFinding = (
      await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'Finding'`,
      )
    ).rows.map((row) => row.column_name);
    await client.query(sqlOf(MIGRATION));
  }, 120_000);

  afterAll(async () => {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(database)} WITH (FORCE)`);
    await admin.end();
  });

  it('só acrescenta: nada é apagado, reescrito ou atualizado; o alerta que existia fica como estava', async () => {
    const sql = sqlOf(MIGRATION);
    expect(sql).not.toMatch(/\bDROP\b|DELETE FROM|^\s*UPDATE\b|\bTRUNCATE\b|ALTER COLUMN|ALTER TYPE/im);
    const { rows } = await client.query(
      `SELECT "scopedExceptionId", "updatedAt", status FROM "Finding" WHERE id = $1`,
      [seeded],
    );
    expect(rows).toEqual([{ scopedExceptionId: null, updatedAt: old, status: 'new' }]);
  });

  it('a imagem anterior grava, muda o status, lê as exceções de sempre e expurga alertas no esquema novo', async () => {
    const row = findingRow(tenantA);
    await insertAsPrevious(row);
    await client.query(`UPDATE "Finding" SET status = 'resolved', "triagedAt" = now() WHERE id = $1`, [
      row.id,
    ]);
    await client.query(
      `SELECT id, "tenantId", "ruleId", field, value, "expiresAt" FROM "AlertException"
       WHERE "expiresAt" IS NULL OR "expiresAt" > now() ORDER BY "createdAt", id`,
    );
    // Um alerta marcado pela exceção ampla (gravado pela imagem nova) também sai no expurgo da imagem anterior.
    const exception = exceptionRow(tenantA);
    await insert(client, 'ScopedException', exception);
    const marked = findingRow(tenantA, { status: 'legitimate', scopedExceptionId: exception.id });
    await insert(client, 'Finding', marked);
    const { rowCount } = await client.query(`DELETE FROM "Finding" WHERE id = ANY($1::uuid[])`, [
      [row.id, marked.id],
    ]);
    expect(rowCount).toBe(2);
  });

  it('apagar a exceção só anula a coluna do alerta, nunca o cliente', async () => {
    const exception = exceptionRow(tenantA);
    await insert(client, 'ScopedException', exception);
    const marked = findingRow(tenantA, { status: 'legitimate', scopedExceptionId: exception.id });
    await insert(client, 'Finding', marked);
    await client.query(`DELETE FROM "ScopedException" WHERE id = $1`, [exception.id]);
    const { rows } = await client.query(
      `SELECT "tenantId", "scopedExceptionId" FROM "Finding" WHERE id = $1`,
      [marked.id],
    );
    expect(rows).toEqual([{ tenantId: tenantA, scopedExceptionId: null }]);
  });

  it('o alerta nunca aponta para a exceção de outro cliente', async () => {
    const exception = exceptionRow(tenantA);
    await insert(client, 'ScopedException', exception);
    expect(
      await sqlState(insert(client, 'Finding', findingRow(tenantB, { scopedExceptionId: exception.id }))),
    ).toBe('23503');
  });

  it('o banco recusa crítico, validade acima de 90 dias e revogação sem autor', async () => {
    expect(
      await sqlState(insert(client, 'ScopedException', exceptionRow(tenantA, { maxSeverity: 'critical' }))),
    ).toBe('23514');
    const createdAt = new Date();
    const tooLong = exceptionRow(tenantA, {
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 91 * DAY_MS),
    });
    expect(await sqlState(insert(client, 'ScopedException', tooLong))).toBe('23514');
    expect(
      await sqlState(insert(client, 'ScopedException', exceptionRow(tenantA, { revokedAt: new Date() }))),
    ).toBe('23514');
    expect(await sqlState(insert(client, 'ScopedException', exceptionRow(tenantA, { accountId: '' })))).toBe(
      '23514',
    );
    expect(
      await sqlState(
        insert(
          client,
          'ScopedException',
          exceptionRow(tenantA, { createdAt, expiresAt: new Date(createdAt.getTime() + 90 * DAY_MS) }),
        ),
      ),
    ).toBeUndefined();
  });
});
