import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { Prisma } from '../src/generated/prisma/client.js';

/**
 * A migration da base dos casos e da triagem em massa (`20261127120000_alert_cases`). Duas frentes, como em
 * `aws-onboarding-migration.test.ts`:
 * - banco novo: o banco de teste, migrado do zero pelo `prisma migrate deploy` do `global-setup`;
 * - banco existente: um banco descartável, só deste arquivo, com as migrations anteriores aplicadas uma a uma, dados no
 *   formato de antes e então a migration nova. Nele roda também a simulação da imagem anterior do nó no esquema novo: os
 *   comandos dela, só com as colunas que ela conhece (lidas do banco antes da migration).
 */

const MIGRATION = '20261127120000_alert_cases';
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

const DAY_MS = 24 * 60 * 60 * 1000;
const hexKey = () => randomBytes(32).toString('hex');

/** Só os comandos: sem comentário e sem o corpo das funções (que só mexe nas tabelas novas). */
function statements(sql: string): string[] {
  return sql
    .replace(/^--.*$/gm, '')
    .replace(/\$\$[\s\S]*?\$\$/g, '$$ $$')
    .split(';')
    .map((statement) => statement.trim().replace(/\s+/g, ' '))
    .filter((statement) => statement.length > 0);
}

async function insert(
  client: pg.Client,
  table: string,
  row: Record<string, unknown>,
): Promise<pg.QueryResult> {
  const columns = Object.keys(row);
  return client.query(
    `INSERT INTO ${client.escapeIdentifier(table)} (${columns.map((column) => client.escapeIdentifier(column)).join(', ')})
     VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')}) ON CONFLICT DO NOTHING`,
    Object.values(row),
  );
}

const caseRow = (tenantId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => {
  const groupKey = (overrides['groupKey'] as string | undefined) ?? hexKey();
  return {
    id: randomUUID(),
    tenantId,
    queue: 'detection',
    keyVersion: 1,
    groupKey,
    openKey: groupKey,
    family: 'cloudtrail',
    title: 'Caso de teste',
    keyParts: JSON.stringify([{ name: 'rule', value: '100305' }]),
    anchorFindingId: randomUUID(),
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    lastAlertAt: new Date(),
    ...overrides,
  };
};

const operationRow = (
  tenantId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: randomUUID(),
  tenantId,
  requestId: randomUUID(),
  action: 'promote',
  target: JSON.stringify({ caseIds: [] }),
  cutoffAt: new Date(),
  expectedCount: 1,
  updatedAt: new Date(),
  ...overrides,
});

describe(`migration ${MIGRATION}`, () => {
  it('só acrescenta: tabelas, tipo, colunas vazias, índices, chaves, CHECKs e gatilhos; nada do que existe muda', () => {
    expect(migrations).toContain(MIGRATION);
    const found = statements(sqlOf(MIGRATION));
    // Numa transação só: o `prisma migrate deploy` não abre uma por arquivo.
    expect([found.at(0), found.at(-1)]).toEqual(['BEGIN', 'COMMIT']);
    const allowed = [
      /^CREATE TYPE "CaseQueue" AS ENUM \('detection', 'vulnerability', 'posture'\)$/,
      /^CREATE TABLE "(?:AlertCase|TriageOperation|TriageOperationItem)" \(/,
      /^CREATE (?:UNIQUE )?INDEX "(?:AlertCase|TriageOperation|TriageOperationItem)_\w+" ON "(?:AlertCase|TriageOperation|TriageOperationItem)"/,
      /^CREATE INDEX "Finding_(?:tenantId_caseId_occurredAt_id|case_outbox|mitre_tactics)_idx" ON "Finding"/,
      /^ALTER TABLE "(?:AlertCase|TriageOperation|TriageOperationItem)" ADD CONSTRAINT "/,
      /^ALTER TABLE "AlertCase" SET \(fillfactor = 70\)$/,
      /^ALTER TABLE "Finding" ADD COLUMN "caseGroup" VARCHAR\(128\), ADD COLUMN "caseId" UUID, ADD COLUMN "triageOpId" UUID$/,
      /^ALTER TABLE "Finding" ADD CONSTRAINT "Finding_caseId_tenantId_fkey" FOREIGN KEY/,
      /^ALTER TABLE "Notification" ADD COLUMN "caseId" UUID$/,
      /^CREATE FUNCTION "(?:alert_case_incident_same_tenant|finding_case_counters_on_(?:insert|update|delete))"\(\) RETURNS trigger/,
      /^CREATE TRIGGER "AlertCase_incident_same_tenant" BEFORE INSERT OR UPDATE OF "incidentId", "tenantId" ON "AlertCase"/,
      /^CREATE TRIGGER "Finding_case_counters_(?:insert|update|delete)" AFTER (?:INSERT|UPDATE|DELETE) ON "Finding"/,
    ];
    for (const statement of found.slice(1, -1)) {
      expect(
        allowed.some((pattern) => pattern.test(statement)),
        statement,
      ).toBe(true);
    }
    // Nenhuma chave estrangeira RESTRICT nova aponta para o alerta, o incidente, o aviso ou a pessoa: a imagem anterior
    // os apaga sem conhecer as tabelas novas.
    const references = found.filter((statement) => statement.includes(' FOREIGN KEY '));
    expect(references).toHaveLength(9);
    const known = references.filter((statement) =>
      ['Finding', 'Incident', 'User', 'Notification'].some((table) =>
        statement.includes(`REFERENCES "${table}"(`),
      ),
    );
    expect(known).toHaveLength(3);
    for (const statement of known) expect(statement).toMatch(/ ON DELETE (?:CASCADE|SET NULL) ON UPDATE /);
  });

  describe('banco novo (o banco de teste, migrado do zero)', () => {
    let client: pg.Client;
    const tenantId = randomUUID();

    beforeAll(async () => {
      client = connect(decodeURIComponent(testUrl.pathname.slice(1)));
      await client.connect();
      await client.query(
        `INSERT INTO "Tenant" ("id", "name", "updatedAt") VALUES ($1, 'Cliente Demo A (migration casos)', now())`,
        [tenantId],
      );
    });

    afterAll(async () => {
      for (const table of ['TriageOperation', 'AlertCase']) {
        await client.query(`DELETE FROM ${client.escapeIdentifier(table)} WHERE "tenantId" = $1`, [tenantId]);
      }
      await client.query('DELETE FROM "Tenant" WHERE "id" = $1', [tenantId]);
      await client.end();
    });

    it('as chaves compostas levam o cliente e não se propagam na troca dele', async () => {
      const { rows } = await client.query<{ name: string; definition: string }>(
        `SELECT conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint
         WHERE contype = 'f' AND conname = ANY($1) AND convalidated ORDER BY conname`,
        [
          [
            'Finding_caseId_tenantId_fkey',
            'TriageOperationItem_findingId_tenantId_fkey',
            'TriageOperationItem_operationId_tenantId_fkey',
            'TriageOperation_undoOfId_tenantId_fkey',
          ],
        ],
      );
      const key = (column: string, table: string, rest: string) =>
        `FOREIGN KEY ("${column}", "tenantId") REFERENCES "${table}"(id, "tenantId") ${rest}`;
      expect(Object.fromEntries(rows.map((row) => [row.name, row.definition]))).toEqual({
        Finding_caseId_tenantId_fkey: key('caseId', 'AlertCase', 'ON UPDATE RESTRICT ON DELETE RESTRICT'),
        TriageOperationItem_findingId_tenantId_fkey: key(
          'findingId',
          'Finding',
          'ON UPDATE RESTRICT ON DELETE CASCADE',
        ),
        TriageOperationItem_operationId_tenantId_fkey: key(
          'operationId',
          'TriageOperation',
          'ON UPDATE RESTRICT ON DELETE RESTRICT',
        ),
        TriageOperation_undoOfId_tenantId_fkey: key('undoOfId', 'TriageOperation', 'ON UPDATE RESTRICT'),
      });
    });

    it('os índices parciais servem às consultas com os valores escritos; com o enum em parâmetro, a fila não', async () => {
      const plan = async (sql: string, values: unknown[] = []) => {
        await client.query('BEGIN');
        try {
          await client.query('SET LOCAL enable_seqscan = off');
          await client.query('SET LOCAL enable_bitmapscan = off');
          // E sem ordenar: com as estatísticas que as outras suítes deixam, o plano de uma tabela pequena varia.
          await client.query('SET LOCAL enable_sort = off');
          const { rows } = await client.query<{ 'QUERY PLAN': unknown }>(
            `EXPLAIN (FORMAT JSON) ${sql}`,
            values,
          );
          return JSON.stringify(rows);
        } finally {
          await client.query('ROLLBACK');
        }
      };
      const outbox = (status: string) =>
        `SELECT "id" FROM "Finding" WHERE "tenantId" = $1 AND "caseId" IS NULL AND "incidentId" IS NULL AND ${status}
         ORDER BY "createdAt", "id" LIMIT 200`;
      const written = await plan(outbox(`"status" IN ('new', 'investigating')`), [tenantId]);
      expect(written).toContain('Finding_case_outbox_idx');
      // Em ordem de chegada, sem ordenar depois.
      expect(written).not.toContain('"Sort"');
      // É a forma que o Prisma gera: o texto vira enum na execução, e o predicado não é provado.
      expect(
        await plan(
          outbox('"status" IN (CAST($2::text AS "FindingStatus"), CAST($3::text AS "FindingStatus"))'),
          [tenantId, 'new', 'investigating'],
        ),
      ).not.toContain('Finding_case_outbox_idx');
      expect(
        await plan(
          `SELECT "mitreTactics" FROM "Finding" WHERE "tenantId" = $1 AND "occurredAt" >= $2 AND cardinality("mitreTactics") > 0`,
          [tenantId, new Date()],
        ),
      ).toContain('Finding_mitre_tactics_idx');
      expect(
        await plan(
          `SELECT "id" FROM "Finding" WHERE "tenantId" = $1 AND "caseId" = $2 ORDER BY "occurredAt" DESC, "id" DESC LIMIT 50`,
          [tenantId, randomUUID()],
        ),
      ).toContain('Finding_tenantId_caseId_occurredAt_id_idx');
    });

    it('nenhum índice do caso cobre contagem nem horário que muda, e há espaço na página para o update HOT', async () => {
      const indexed = await client.query<{ name: string }>(
        `SELECT DISTINCT a.attname AS name FROM pg_index AS i
         JOIN pg_attribute AS a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = '"AlertCase"'::regclass ORDER BY 1`,
      );
      expect(indexed.rows.map((row) => row.name).sort()).toEqual(
        ['id', 'tenantId', 'queue', 'pending', 'openedAt', 'groupKey', 'openKey', 'incidentId'].sort(),
      );
      const { rows } = await client.query<{ options: string[] | null }>(
        `SELECT reloptions AS options FROM pg_class WHERE oid = '"AlertCase"'::regclass`,
      );
      expect(rows[0]?.options).toEqual(['fillfactor=70']);
    });

    it('o caso recusa chave, estado e amostra fora do formato', async () => {
      const refused: [Record<string, unknown>, RegExp][] = [
        [{ groupKey: 'A'.repeat(64) }, /AlertCase_key_check/],
        [{ groupKey: `${'a'.repeat(63)} ` }, /AlertCase_key_check/],
        [{ openKey: hexKey() }, /AlertCase_key_check/],
        [{ keyVersion: 0 }, /AlertCase_key_check/],
        [{ keyParts: JSON.stringify({ rule: '100305' }) }, /AlertCase_key_check/],
        // Selado é sem a chave aberta, com o horário e o motivo; aberto é sem os dois.
        [{ openKey: null }, /AlertCase_seal_check/],
        [{ openKey: null, sealedAt: new Date() }, /AlertCase_seal_check/],
        [{ openKey: null, sealReason: 'idle' }, /AlertCase_seal_check/],
        [{ sealedAt: new Date(), sealReason: 'idle' }, /AlertCase_seal_check/],
        [{ openKey: null, sealedAt: new Date(), sealReason: 'closed' }, /AlertCase_seal_check/],
        [{ ruleIds: Array.from({ length: 21 }, String) }, /AlertCase_samples_check/],
        [{ accounts: Array.from({ length: 51 }, String) }, /AlertCase_samples_check/],
        [{ actors: Array.from({ length: 21 }, String) }, /AlertCase_samples_check/],
        [{ ips: Array.from({ length: 21 }, String) }, /AlertCase_samples_check/],
        [{ resources: Array.from({ length: 21 }, String) }, /AlertCase_samples_check/],
        [{ mitreTactics: Array.from({ length: 21 }, String) }, /AlertCase_samples_check/],
        [{ mitreTechniques: Array.from({ length: 51 }, String) }, /AlertCase_samples_check/],
      ];
      for (const [overrides, error] of refused) {
        await expect(
          insert(client, 'AlertCase', caseRow(tenantId, overrides)),
          JSON.stringify(overrides),
        ).rejects.toThrow(error);
      }
      for (const sealReason of ['window', 'treated', 'idle', 'split']) {
        await insert(
          client,
          'AlertCase',
          caseRow(tenantId, { openKey: null, sealedAt: new Date(), sealReason }),
        );
      }
      await insert(
        client,
        'AlertCase',
        caseRow(tenantId, {
          ruleIds: Array.from({ length: 20 }, String),
          accounts: Array.from({ length: 50 }, String),
          mitreTechniques: Array.from({ length: 50 }, String),
        }),
      );
    });

    it('a operação recusa ação, estado e alvo fora do formato', async () => {
      const refused: [Record<string, unknown>, RegExp][] = [
        [{ action: 'close' }, /TriageOperation_request_check/],
        // O status pedido existe só na ação de status; o "desfaz qual", só no desfazer.
        [{ action: 'status' }, /TriageOperation_request_check/],
        [{ action: 'promote', status: 'resolved' }, /TriageOperation_request_check/],
        [{ action: 'undo' }, /TriageOperation_request_check/],
        [{ target: JSON.stringify(['a']) }, /TriageOperation_request_check/],
        [{ expectedCount: -1 }, /TriageOperation_request_check/],
        [{ state: 'finished' }, /TriageOperation_state_check/],
        [{ matched: -1 }, /TriageOperation_state_check/],
        [{ changed: -1 }, /TriageOperation_state_check/],
        [{ skipped: -1 }, /TriageOperation_state_check/],
      ];
      for (const [overrides, error] of refused) {
        await expect(
          insert(client, 'TriageOperation', operationRow(tenantId, overrides)),
          JSON.stringify(overrides),
        ).rejects.toThrow(error);
      }
      for (const state of [
        'queued',
        'running',
        'done',
        'partial',
        'failed',
        'canceled',
        'undoing',
        'undone',
      ]) {
        await insert(client, 'TriageOperation', operationRow(tenantId, { state }));
      }
      for (const action of ['promote', 'attach', 'undo_all_of']) {
        await insert(client, 'TriageOperation', operationRow(tenantId, { action }));
      }
      await insert(
        client,
        'TriageOperation',
        operationRow(tenantId, { action: 'status', status: 'legitimate' }),
      );
    });
  });

  describe('banco existente: migrado até antes, com dados, e então a migration nova', () => {
    const admin = connect(decodeURIComponent(testUrl.pathname.slice(1)));
    const database = `verax_cases_${randomBytes(6).toString('hex')}_test`;
    let client: pg.Client;

    const [tenantA, tenantB] = [randomUUID(), randomUUID()];
    const userId = `user-${randomBytes(4).toString('hex')}`;
    const incidentId = randomUUID();
    const seeded = {
      loose: randomUUID(),
      triaged: randomUUID(),
      inIncident: randomUUID(),
      other: randomUUID(),
    };
    /** O que a imagem anterior conhece: as colunas e os enums de antes da migration. */
    const previousColumns: Record<string, string[]> = {};
    let previousEnums: string[] = [];
    const previousRows: Record<string, unknown> = {};
    const previousFiles: Record<string, string> = {};

    const TABLES = ['Finding', 'Notification', 'Incident', 'FindingComment'] as const;

    const columnsOf = async (table: string): Promise<string[]> =>
      (
        await client.query<{ name: string }>(
          `SELECT column_name AS name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
          [table],
        )
      ).rows.map((row) => row.name);
    const enums = async (): Promise<string[]> =>
      (
        await client.query<{ value: string }>(
          `SELECT t.typname || '.' || e.enumlabel AS value FROM pg_enum AS e JOIN pg_type AS t ON t.oid = e.enumtypid
           ORDER BY t.typname, e.enumsortorder`,
        )
      ).rows.map((row) => row.value);
    const rowsOf = async (table: string, columns: readonly string[]) =>
      (
        await client.query<{ row: unknown }>(
          `SELECT to_jsonb(r) AS row FROM (SELECT ${columns.map((name) => client.escapeIdentifier(name)).join(', ')}
           FROM ${client.escapeIdentifier(table)} ORDER BY "id") AS r`,
        )
      ).rows.map(({ row }) => row);
    const fileOf = async (table: string) =>
      (
        await client.query<{ file: string }>(`SELECT pg_relation_filenode($1::regclass)::text AS file`, [
          client.escapeIdentifier(table),
        ])
      ).rows[0]?.file ?? '';

    const old = new Date(Date.now() - 200 * DAY_MS);

    /** Um alerta como a imagem anterior grava: só as colunas dela. */
    const findingRow = (
      tenantId: string,
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      id: randomUUID(),
      tenantId,
      accountId: '111111111111',
      source: 'wazuh',
      sourceEventId: `previa-${randomUUID()}`,
      logSource: 'cloudtrail',
      occurredAt: new Date(),
      severity: 'high',
      status: 'new',
      ruleId: '100305',
      ruleLevel: 10,
      title: 'Alerta de teste da migration',
      mitreTactics: [],
      mitreTechniques: [],
      updatedAt: new Date(),
      ...overrides,
    });

    /** Recusa, no próprio teste, uma coluna que a imagem anterior não conhece. */
    const insertAsPrevious = (table: string, row: Record<string, unknown>) => {
      const unknown = Object.keys(row).filter((name) => !(previousColumns[table] ?? []).includes(name));
      if (unknown.length > 0) throw new Error(`a imagem anterior não conhece ${unknown.join(', ')}`);
      return insert(client, table, row);
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
         VALUES ($1, 'Analista de teste', $2, 'analista_cliente', $3, 'active', now())`,
        [userId, `analista-${randomUUID()}@cliente.example`, tenantA],
      );
      await client.query(
        `INSERT INTO "Incident" ("id", "tenantId", "severity", "riskScore", "findingCount", "firstSeenAt", "lastSeenAt",
           "keys", "accounts", "resources", "mitreTactics", "mitreTechniques", "createdAt", "updatedAt")
         VALUES ($1, $2, 'high', 50, 1, $3, $3, '{}', '{}', '{}', '{}', '{}', $3, $3)`,
        [incidentId, tenantA, old],
      );
      const aged = { occurredAt: old, createdAt: old, updatedAt: old };
      await insert(client, 'Finding', findingRow(tenantA, { ...aged, id: seeded.loose }));
      await insert(
        client,
        'Finding',
        findingRow(tenantA, { ...aged, id: seeded.triaged, status: 'resolved', triagedAt: old }),
      );
      await insert(client, 'Finding', findingRow(tenantA, { ...aged, id: seeded.inIncident, incidentId }));
      await insert(client, 'Finding', findingRow(tenantB, { id: seeded.other }));
      await insert(client, 'FindingComment', {
        id: randomUUID(),
        tenantId: tenantA,
        findingId: seeded.triaged,
        authorId: userId,
        body: 'Conferido',
        createdAt: old,
      });
      await insert(client, 'Notification', {
        id: randomUUID(),
        tenantId: tenantA,
        kind: 'high_finding',
        dedupeKey: `finding:${seeded.loose}`,
        severity: 'high',
        findingId: seeded.loose,
        updatedAt: new Date(),
      });

      for (const table of TABLES) {
        const columns = await columnsOf(table);
        previousColumns[table] = columns;
        previousRows[table] = await rowsOf(table, columns);
        previousFiles[table] = await fileOf(table);
      }
      previousEnums = await enums();

      // Uma falha no último passo não deixa nada para trás: a migration é uma transação só.
      await client.query(
        'CREATE FUNCTION "finding_case_counters_on_insert"() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$',
      );
      await expect(client.query(sqlOf(MIGRATION))).rejects.toThrow(
        /cannot change return type|already exists/,
      );
      await client.query('ROLLBACK');
      expect(await columnsOf('Finding')).toEqual(previousColumns['Finding']);
      expect(await columnsOf('AlertCase')).toEqual([]);
      expect(await enums()).toEqual(previousEnums);
      await client.query('DROP FUNCTION "finding_case_counters_on_insert"()');

      await client.query(sqlOf(MIGRATION));
    });

    afterAll(async () => {
      await client.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(database)} WITH (FORCE)`);
      await admin.end();
    });

    it('as linhas de antes ficam iguais (o updatedAt também), as colunas novas nascem vazias e nenhum caso nasce', async () => {
      for (const table of TABLES) {
        expect(await rowsOf(table, previousColumns[table] ?? []), table).toEqual(previousRows[table]);
        // Nem a tabela é reescrita.
        expect(await fileOf(table), table).toBe(previousFiles[table]);
      }
      const { rows } = await client.query(
        `SELECT DISTINCT "caseId", "caseGroup", "triageOpId" FROM "Finding"
         UNION SELECT "caseId", NULL, NULL FROM "Notification"`,
      );
      expect(rows).toEqual([{ caseId: null, caseGroup: null, triageOpId: null }]);
      for (const table of ['AlertCase', 'TriageOperation', 'TriageOperationItem']) {
        expect((await client.query(`SELECT 1 FROM ${client.escapeIdentifier(table)}`)).rowCount, table).toBe(
          0,
        );
      }
      expect(
        (await columnsOf('Finding')).filter((name) => !(previousColumns['Finding'] ?? []).includes(name)),
      ).toEqual(['caseGroup', 'caseId', 'triageOpId']);
    });

    it('nenhum enum de antes ganhou ou perdeu valor (a imagem anterior falharia ao ler um valor novo)', async () => {
      const after = await enums();
      expect(after.filter((value) => !value.startsWith('CaseQueue.'))).toEqual(previousEnums);
      expect(after.filter((value) => value.startsWith('CaseQueue.'))).toEqual([
        'CaseQueue.detection',
        'CaseQueue.vulnerability',
        'CaseQueue.posture',
      ]);
    });

    it('as colunas que a imagem anterior conhece são as do model de hoje, menos as novas', () => {
      const today = Object.keys(Prisma.FindingScalarFieldEnum).sort();
      expect([...(previousColumns['Finding'] ?? []), 'caseGroup', 'caseId', 'triageOpId'].sort()).toEqual(
        today,
      );
    });

    describe('a imagem anterior do nó no esquema novo, com casos que a versão nova deixou', () => {
      let caseId: string;
      let operationId: string;
      const inCase = {
        patched: randomUUID(),
        promoted: randomUUID(),
        attached: randomUUID(),
        revised: randomUUID(),
      };

      const counters = async () =>
        (
          await client.query(
            `SELECT "total", "pending", "newCount", "investigatingCount", "legitimateCount", "resolvedCount", "incidentCount",
               "pendingCritical", "pendingHigh", "pendingMedium", "pendingLow" FROM "AlertCase" WHERE "id" = $1`,
            [caseId],
          )
        ).rows[0] as Record<string, unknown>;

      beforeAll(async () => {
        const row = caseRow(tenantA, { incidentId });
        caseId = row['id'] as string;
        await insert(client, 'AlertCase', row);
        for (const id of Object.values(inCase))
          await insertAsPrevious('Finding', findingRow(tenantA, { id }));
        await client.query(
          `UPDATE "Finding" SET "caseId" = $1, "caseGroup" = 'grupo', "triageOpId" = $2 WHERE "tenantId" = $3`,
          [caseId, randomUUID(), tenantA],
        );
        const operation = operationRow(tenantA, { createdById: userId });
        operationId = operation['id'] as string;
        await insert(client, 'TriageOperation', operation);
        for (const findingId of [seeded.loose, seeded.inIncident, inCase.patched]) {
          await insert(client, 'TriageOperationItem', {
            tenantId: tenantA,
            operationId,
            findingId,
            previousStatus: 'new',
          });
        }
        await client.query(`UPDATE "Notification" SET "caseId" = $1 WHERE "tenantId" = $2`, [
          caseId,
          tenantA,
        ]);
      });

      it('grava o alerta e o aviso sem as colunas novas; a releitura cai como duplicada', async () => {
        const row = findingRow(tenantA);
        expect((await insertAsPrevious('Finding', row)).rowCount).toBe(1);
        expect((await insertAsPrevious('Finding', { ...row, id: randomUUID() })).rowCount).toBe(0);
        expect(
          (
            await insertAsPrevious('Notification', {
              id: randomUUID(),
              tenantId: tenantA,
              kind: 'high_finding',
              dedupeKey: `finding:${String(row['id'])}`,
              severity: 'high',
              findingId: row['id'],
              updatedAt: new Date(),
            })
          ).rowCount,
        ).toBe(1);
        const { rows } = await client.query('SELECT "caseId" FROM "Finding" WHERE "id" = $1', [row['id']]);
        expect(rows).toEqual([{ caseId: null }]);
      });

      it('lê, com a lista de colunas dela, os alertas e os avisos que já têm caso', async () => {
        for (const table of TABLES) {
          const rows = await rowsOf(table, previousColumns[table] ?? []);
          expect(rows.length, table).toBeGreaterThan(0);
        }
      });

      it('a triagem, a severidade nova, o promover, o anexar e o remover acertam o caso, que ela não conhece', async () => {
        expect(await counters()).toMatchObject({ total: 7, newCount: 5, resolvedCount: 1, incidentCount: 1 });
        // PATCH /v1/findings/:id/status
        await client.query(
          `UPDATE "Finding" SET "status" = 'investigating', "triagedAt" = now(), "updatedAt" = now()
           WHERE "id" = $1 AND "tenantId" = $2 RETURNING "id"`,
          [inCase.patched, tenantA],
        );
        expect(await counters()).toMatchObject({ newCount: 4, investigatingCount: 1, pendingHigh: 5 });
        // FindingStore.revise
        await client.query(
          `UPDATE "Finding" SET "lastSeenAt" = now(), "severity" = 'critical', "ruleLevel" = 12, "updatedAt" = now()
           WHERE "id" = $1 AND "tenantId" = $2`,
          [inCase.revised, tenantA],
        );
        expect(await counters()).toMatchObject({ pendingCritical: 1, pendingHigh: 4 });
        // POST /v1/incidents e /v1/incidents/:id/findings, DELETE /v1/incidents/:id/findings/:findingId
        const fresh = randomUUID();
        await client.query(
          `INSERT INTO "Incident" ("id", "tenantId", "severity", "riskScore", "findingCount", "firstSeenAt", "lastSeenAt",
             "keys", "accounts", "resources", "mitreTactics", "mitreTechniques", "updatedAt")
           VALUES ($1, $2, 'high', 50, 1, now(), now(), '{}', '{}', '{}', '{}', '{}', now())`,
          [fresh, tenantA],
        );
        const join = (id: string, incident: string | null) =>
          client.query(
            `UPDATE "Finding" SET "incidentId" = $1, "updatedAt" = now()
             WHERE "id" = ANY($2::uuid[]) AND "tenantId" = $3`,
            [incident, [id], tenantA],
          );
        await join(inCase.promoted, fresh);
        await join(inCase.attached, fresh);
        expect(await counters()).toMatchObject({ incidentCount: 3, newCount: 2, pendingHigh: 2 });
        await join(inCase.attached, null);
        expect(await counters()).toMatchObject({ incidentCount: 2, newCount: 3, pendingHigh: 3, total: 7 });
      });

      it('o expurgo leva os alertas antigos, soltos e de incidente, com comentário, item e aviso; nada o segura', async () => {
        const purge = async (ids: string[]) => {
          await client.query('BEGIN');
          try {
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`verax:findings:${tenantA}`]);
            await client.query(
              'SELECT 1 FROM "Finding" WHERE "id" = ANY($1::uuid[]) AND "tenantId" = $2 ORDER BY "id" FOR UPDATE',
              [ids, tenantA],
            );
            await client.query('SELECT verax_purge_finding_comments($1::uuid[])', [ids]);
            const { rowCount } = await client.query(
              'DELETE FROM "Finding" WHERE "id" = ANY($1::uuid[]) AND "tenantId" = $2',
              [ids, tenantA],
            );
            await client.query('COMMIT');
            return rowCount;
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          }
        };
        expect(await purge([seeded.loose, seeded.triaged])).toBe(2);
        expect(await counters()).toMatchObject({ total: 5, resolvedCount: 0, newCount: 2 });
        expect(await purge([seeded.inIncident])).toBe(1);
        // O incidente sai também: o caso que apontava para ele fica, sem ele.
        expect((await client.query('DELETE FROM "Incident" WHERE "id" = $1', [incidentId])).rowCount).toBe(1);
        expect(await counters()).toMatchObject({ total: 4, incidentCount: 1 });
        const left = await client.query('SELECT "findingId" FROM "TriageOperationItem"');
        expect(left.rows).toEqual([{ findingId: inCase.patched }]);
        const { rows } = await client.query('SELECT "incidentId" FROM "AlertCase" WHERE "id" = $1', [caseId]);
        expect(rows).toEqual([{ incidentId: null }]);
      });

      it('a pessoa excluída sai sem levar a operação dela', async () => {
        await client.query('DELETE FROM "User" WHERE "id" = $1', [userId]);
        const { rows } = await client.query('SELECT "createdById" FROM "TriageOperation" WHERE "id" = $1', [
          operationId,
        ]);
        expect(rows).toEqual([{ createdById: null }]);
      });

      it('o cliente sem caso nenhum não é tocado', async () => {
        const { rows } = await client.query('SELECT "caseId", "status" FROM "Finding" WHERE "id" = $1', [
          seeded.other,
        ]);
        expect(rows).toEqual([{ caseId: null, status: 'new' }]);
      });
    });
  });
});
