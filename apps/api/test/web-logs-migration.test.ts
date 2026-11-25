import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { Prisma } from '../src/generated/prisma/client.js';
import { MAX_ROUTES, WEB_ROUTE_KINDS, webRouteSchema } from '../src/weblogs/routes.js';
import { WEB_LOG_OBJECT_STATUSES } from '../src/weblogs/store/web-object-ledger.js';
import { TRAFFIC_CLASSES } from '../src/weblogs/store/web-traffic-store.js';
import { TRUSTED_KINDS, webTrustedSourceSchema } from '../src/weblogs/trusted-sources.js';

/**
 * A migration dos ataques web pelos logs do ALB (`20261130120000_web_logs`). Duas frentes, como em
 * `aws-onboarding-migration.test.ts`:
 * - banco novo: o banco de teste, migrado do zero pelo `prisma migrate deploy` do `global-setup`;
 * - banco existente: um banco descartável, só deste arquivo, com as migrations anteriores aplicadas uma a uma, dados no
 *   formato de antes e então a migration nova. Nele roda também a simulação da imagem anterior do nó no esquema novo: os
 *   comandos dela, só com as tabelas e as colunas que ela conhece (lidas do banco antes da migration).
 */

const MIGRATION = '20261130120000_web_logs';
const TABLES = [
  'WebSourceSettings',
  'WebTrustedSource',
  'WebRoute',
  'WebLogObject',
  'FindingEvidence',
  'WebEngineState',
  'WebTrafficSlot',
  'WebTrafficHour',
] as const;
/** As tabelas que já existem e para as quais as novas apontam. */
const TOUCHED = ['Tenant', 'CloudAccount', 'AwsSource', 'Finding'] as const;

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
const SLOT = new Date('2026-11-24T12:05:00.000Z');
const HOUR = new Date('2026-11-24T12:00:00.000Z');

/** Só os comandos: sem comentário. */
function statements(sql: string): string[] {
  return sql
    .replace(/^--.*$/gm, '')
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

interface Seeded {
  tenantId: string;
  accountId: string;
  sourceId: string;
}

/** Um cliente com uma conta e um balanceador. */
async function seedTenant(client: pg.Client, name: string): Promise<Seeded> {
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

const sourceRow = (
  ids: Pick<Seeded, 'tenantId' | 'accountId'> & { sourceId?: string },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: ids.sourceId ?? randomUUID(),
  tenantId: ids.tenantId,
  cloudAccountId: ids.accountId,
  kind: 'elb_logs',
  region: 'sa-east-1',
  resourceId: `loja-${randomBytes(4).toString('hex')}`,
  name: 'loja',
  method: 's3',
  availability: 'available',
  state: 'available',
  updatedAt: new Date(),
  ...overrides,
});

const findingRow = (tenantId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  tenantId,
  accountId: '111111111111',
  source: 'aws',
  sourceEventId: `aws/111111111111/alb:${randomBytes(20).toString('hex')}`,
  logSource: 'waf',
  occurredAt: new Date(),
  severity: 'high',
  ruleId: '990405',
  ruleLevel: 10,
  title: 'Achado de teste',
  mitreTactics: [],
  mitreTechniques: [],
  updatedAt: new Date(),
  ...overrides,
});

type Overrides = Record<string, unknown>;
const rows: Readonly<
  Record<(typeof TABLES)[number], (ids: Seeded & { findingId?: string }, over?: Overrides) => Overrides>
> = {
  WebSourceSettings: ({ tenantId, sourceId }, over = {}) => ({
    tenantId,
    sourceId,
    updatedAt: new Date(),
    ...over,
  }),
  WebTrustedSource: ({ tenantId, sourceId }, over = {}) => ({
    id: randomUUID(),
    tenantId,
    sourceId,
    cidr: '198.51.100.0/24',
    kind: 'office',
    reason: 'Escritório de teste',
    expiresAt: new Date(Date.now() + 30 * DAY_MS),
    updatedAt: new Date(),
    ...over,
  }),
  WebRoute: ({ tenantId, sourceId }, over = {}) => ({
    id: randomUUID(),
    tenantId,
    sourceId,
    path: '/entrar',
    kind: 'login',
    updatedAt: new Date(),
    ...over,
  }),
  WebLogObject: ({ tenantId, sourceId, accountId }, over = {}) => ({
    tenantId,
    sourceId,
    cloudAccountId: accountId,
    objectHash: randomBytes(32).toString('hex'),
    status: 'read',
    slotStart: SLOT,
    ...over,
  }),
  FindingEvidence: ({ tenantId, findingId }, over = {}) => ({
    tenantId,
    findingId,
    version: 1,
    data: JSON.stringify({ version: 1 }),
    firstSeenAt: SLOT,
    lastSeenAt: SLOT,
    updatedAt: new Date(),
    ...over,
  }),
  WebEngineState: ({ tenantId, sourceId }, over = {}) => ({
    tenantId,
    sourceId,
    loadBalancer: 'app/loja/0123456789abcdef',
    version: 1,
    state: JSON.stringify({ version: 1, settledThrough: null, days: [], tracks: [] }),
    updatedAt: new Date(),
    ...over,
  }),
  WebTrafficSlot: ({ tenantId, sourceId }, over = {}) => ({
    tenantId,
    sourceId,
    slotStart: SLOT,
    country: 'BR',
    clientClass: 'direct',
    requests: 1,
    blocked: 0,
    clientErrors: 0,
    serverErrors: 0,
    flagged: 0,
    ...over,
  }),
  WebTrafficHour: ({ tenantId, sourceId }, over = {}) => ({
    tenantId,
    sourceId,
    hourStart: HOUR,
    country: 'BR',
    clientClass: 'direct',
    requests: 1,
    blocked: 0,
    clientErrors: 0,
    serverErrors: 0,
    flagged: 0,
    ...over,
  }),
};

describe(`migration ${MIGRATION}`, () => {
  it('só acrescenta: tabelas, índices, chaves em cascata e CHECKs novos; nada do que existe muda', () => {
    expect(migrations).toContain(MIGRATION);
    const found = statements(sqlOf(MIGRATION));
    // Numa transação só: o `prisma migrate deploy` não abre uma por arquivo.
    expect([found.at(0), found.at(-1)]).toEqual(['BEGIN', 'COMMIT']);
    const own: ReadonlySet<string | undefined> = new Set(TABLES);
    const shapes = [
      /^CREATE TABLE "(\w+)" \(/,
      /^CREATE (?:UNIQUE )?INDEX "\w+" ON "(\w+)"\(/,
      /^ALTER TABLE "(\w+)" ADD CONSTRAINT "\w+" (?:FOREIGN KEY|CHECK) \(/,
      /^ALTER TABLE "(WebTrafficSlot)" SET \(fillfactor = 70\)$/,
    ];
    // O único comando numa tabela de antes: um índice único sobre o id, que já é único (o alvo das chaves compostas).
    const index = 'CREATE UNIQUE INDEX "AwsSource_id_tenantId_key" ON "AwsSource"("id", "tenantId")';
    expect(found.filter((statement) => statement === index)).toHaveLength(1);
    for (const statement of found.slice(1, -1).filter((candidate) => candidate !== index)) {
      const tables = shapes.flatMap((shape) => shape.exec(statement)?.[1] ?? []);
      expect(tables, statement).toHaveLength(1);
      expect(own.has(tables[0]), statement).toBe(true);
    }
    expect(found.filter((statement) => statement.startsWith('CREATE TABLE'))).toHaveLength(TABLES.length);
    // Toda chave é em cascata: a imagem anterior apaga cliente, conta, fonte e achado sem conhecer as tabelas novas.
    const references = found.filter((statement) => statement.includes(' FOREIGN KEY '));
    expect(references).toHaveLength(17);
    for (const statement of references) expect(statement).toContain(' ON DELETE CASCADE ');
    expect(references.filter((statement) => statement.endsWith('ON UPDATE RESTRICT'))).toHaveLength(9);
  });

  describe('banco novo (o banco de teste, migrado do zero)', () => {
    let client: pg.Client;
    let a: Seeded;
    let b: Seeded;

    beforeAll(async () => {
      client = connect(decodeURIComponent(testUrl.pathname.slice(1)));
      await client.connect();
      a = await seedTenant(client, 'Cliente Demo A (migration web)');
      b = await seedTenant(client, 'Cliente Demo B (migration web)');
    });

    afterAll(async () => {
      for (const { tenantId } of [a, b]) {
        for (const table of ['Finding', 'CloudAccount']) {
          await client.query(`DELETE FROM ${client.escapeIdentifier(table)} WHERE "tenantId" = $1`, [
            tenantId,
          ]);
        }
        await client.query('DELETE FROM "Tenant" WHERE "id" = $1', [tenantId]);
      }
      await client.end();
    });

    const refuses = async (
      table: (typeof TABLES)[number],
      cases: [Overrides, RegExp][],
      extra: { findingId?: string } = {},
    ) => {
      for (const [overrides, error] of cases) {
        await expect(
          insert(client, table, rows[table]({ ...a, ...extra }, overrides)),
          `${table} ${JSON.stringify(overrides)}`,
        ).rejects.toThrow(error);
      }
    };
    const accepts = async (table: (typeof TABLES)[number], cases: Overrides[]) => {
      for (const overrides of cases) {
        await client.query('BEGIN');
        const { rowCount } = await insert(client, table, rows[table](a, overrides));
        await client.query('ROLLBACK');
        expect(rowCount, `${table} ${JSON.stringify(overrides)}`).toBe(1);
      }
    };

    it('toda chave de fonte, conta e achado leva o cliente: nada cruza de um cliente para outro', async () => {
      const findingB = randomUUID();
      await insert(client, 'Finding', findingRow(b.tenantId, { id: findingB }));
      const crossed = /violates (?:RESTRICT setting of )?foreign key constraint/;
      for (const table of TABLES) {
        if (table === 'FindingEvidence') continue;
        // A fonte de B na linha de A.
        await expect(
          insert(client, table, rows[table]({ ...a, sourceId: b.sourceId })),
          table,
        ).rejects.toThrow(crossed);
      }
      await expect(
        insert(client, 'FindingEvidence', rows.FindingEvidence({ ...a, findingId: findingB })),
      ).rejects.toThrow(crossed);
      await expect(
        insert(client, 'WebLogObject', rows.WebLogObject({ ...a, accountId: b.accountId })),
      ).rejects.toThrow(crossed);
      // E o dono não muda por baixo: trocar o cliente da fonte ou do achado não arrasta o que é dele.
      await insert(client, 'WebSourceSettings', rows.WebSourceSettings(b));
      await insert(client, 'FindingEvidence', rows.FindingEvidence({ ...b, findingId: findingB }));
      await expect(
        client.query('UPDATE "Finding" SET "tenantId" = $1 WHERE "id" = $2', [a.tenantId, findingB]),
      ).rejects.toThrow(crossed);
    });

    it('a configuração recusa modo e multiplicador fora do contrato', async () => {
      const error = /WebSourceSettings_values_check/;
      await refuses('WebSourceSettings', [
        [{ mode: 'off' }, error],
        [{ thresholdMultiplier: 0.49 }, error],
        [{ thresholdMultiplier: 10.01 }, error],
        [{ thresholdMultiplier: 'NaN' }, error],
      ]);
      await accepts('WebSourceSettings', [
        {},
        { mode: 'alert', thresholdMultiplier: 0.5 },
        { mode: 'observe', thresholdMultiplier: 10, observeUntil: new Date() },
      ]);
    });

    it('a fonte confiável tem os mesmos pisos do motor, e não se repete', async () => {
      const error = /WebTrustedSource_values_check|invalid (?:cidr value|input syntax for type cidr)/;
      const source = (cidr: string) => ({
        id: 'x',
        cidr,
        kind: 'office',
        reason: 'teste',
        expiresAt: new Date().toISOString(),
      });
      const good = [
        '198.51.0.0/16',
        '198.51.100.7/32',
        '2001:db8::/32',
        '2001:db8:1:2::/64',
        '2001:db8:0:1::/64',
      ];
      const bad = [
        '198.50.0.0/15',
        '0.0.0.0/0',
        '198.51.100.1/24',
        '2001::/31',
        '2001:db8::/65',
        '2001:db8::1/128',
        '198.51.100.0',
        '198.51.100.0/33',
        'escritorio',
        '',
      ];
      for (const cidr of good)
        expect(webTrustedSourceSchema.safeParse(source(cidr)).success, cidr).toBe(true);
      for (const cidr of bad)
        expect(webTrustedSourceSchema.safeParse(source(cidr)).success, cidr).toBe(false);
      await accepts(
        'WebTrustedSource',
        good.map((cidr) => ({ cidr })),
      );
      await refuses(
        'WebTrustedSource',
        bad.map((cidr): [Overrides, RegExp] => [{ cidr }, error]),
      );
      await refuses('WebTrustedSource', [
        [{ kind: 'vpn' }, error],
        [{ reason: '  ' }, error],
        // Um ano, com um dia de folga entre relógios.
        [{ expiresAt: new Date(Date.now() + 367 * DAY_MS) }, error],
      ]);
      await accepts('WebTrustedSource', [
        ...TRUSTED_KINDS.map((kind) => ({ kind })),
        { expiresAt: new Date(Date.now() + 365 * DAY_MS) },
        { sourceId: null },
      ]);
      // Repetida na mesma fonte, e entre as que valem para todos os balanceadores (sem fonte).
      for (const sourceId of [a.sourceId, null]) {
        await insert(client, 'WebTrustedSource', rows.WebTrustedSource(a, { sourceId }));
        expect(
          (await insert(client, 'WebTrustedSource', rows.WebTrustedSource(a, { sourceId }))).rowCount,
        ).toBe(0);
      }
    });

    it('a rota declarada tem o mesmo formato do motor, e não se repete', async () => {
      const error = /WebRoute_values_check/;
      const route = (over: Overrides) => ({
        id: 'x',
        host: null,
        method: 'ANY',
        path: '/entrar',
        kind: 'login',
        failureCodes: [],
        successCodes: [],
        multiplier: 1,
        ...over,
      });
      const good: Overrides[] = [
        {},
        { path: '/' },
        { path: '/a/*/c.d_e-f~g' },
        { path: '/1/2/3/4/5/6/7/8' },
        { path: '/*' },
        { host: 'loja.example' },
        { method: 'POST' },
        ...WEB_ROUTE_KINDS.map((kind) => ({ kind })),
        { failureCodes: [100, 599], successCodes: [302] },
        { failureCodes: Array.from({ length: 20 }, () => 401) },
        { multiplier: 0.5 },
        { multiplier: 10 },
      ];
      const bad: Overrides[] = [
        { path: '' },
        { path: 'entrar' },
        { path: '/Entrar' },
        { path: '/a//b' },
        { path: '/a/' },
        { path: '/a*' },
        { path: '/a?b=c' },
        { path: '/1/2/3/4/5/6/7/8/9' },
        { path: '/á' },
        { host: '' },
        { host: 'Loja.example' },
        { host: 'a b' },
        { method: 'HEAD' },
        { kind: 'admin' },
        { failureCodes: [99] },
        { failureCodes: [600] },
        { successCodes: [99] },
        { successCodes: [200, 600] },
        { failureCodes: Array.from({ length: 21 }, () => 401) },
        { successCodes: Array.from({ length: 21 }, () => 302) },
        { multiplier: 0.4 },
        { multiplier: 10.5 },
      ];
      for (const over of good) {
        expect(webRouteSchema.safeParse(route(over)).success, JSON.stringify(over)).toBe(true);
      }
      for (const over of bad) {
        expect(webRouteSchema.safeParse(route(over)).success, JSON.stringify(over)).toBe(false);
      }
      await accepts('WebRoute', good);
      await refuses(
        'WebRoute',
        bad.map((over): [Overrides, RegExp] => [over, error]),
      );
      for (const host of ['loja.example', null]) {
        expect((await insert(client, 'WebRoute', rows.WebRoute(a, { host }))).rowCount).toBe(1);
        expect((await insert(client, 'WebRoute', rows.WebRoute(a, { host }))).rowCount).toBe(0);
      }
      // O teto de rotas por balanceador é do motor (o banco não conta linhas): a gravação, na PR do painel, o confere.
      expect(MAX_ROUTES).toBe(50);
    });

    it('o objeto tratado recusa hash, estado, intervalo e contador fora do contrato', async () => {
      const error = /WebLogObject_values_check/;
      await refuses('WebLogObject', [
        [{ objectHash: 'A'.repeat(64) }, error],
        [{ objectHash: 'a'.repeat(63) }, error],
        [{ status: 'skipped' }, error],
        [{ slotStart: null }, error],
        [{ status: 'late', slotStart: null }, error],
        [{ slotStart: new Date('2026-11-24T12:04:59.999Z') }, error],
        [{ slotStart: new Date('2026-11-24T12:05:00.001Z') }, error],
        ...['lines', 'bytes', 'malformed', 'oversize', 'foreign'].map((column): [Overrides, RegExp] => [
          { [column]: -1 },
          error,
        ]),
      ]);
      await accepts('WebLogObject', [
        ...WEB_LOG_OBJECT_STATUSES.map((status) => ({ status })),
        { status: 'quarantined', slotStart: null },
        { status: 'gap', slotStart: null },
        { bytes: '536870912' },
      ]);
    });

    it('a evidência tem o teto de 16 KB, a versão de dentro e as datas em ordem', async () => {
      const error = /FindingEvidence_data_check/;
      const findingId = randomUUID();
      await insert(client, 'Finding', findingRow(a.tenantId, { id: findingId }));
      // `{"a": "…", "version": 1}`: o texto do `jsonb` tem 23 bytes além do valor.
      const sized = (bytes: number) => JSON.stringify({ a: 'x'.repeat(bytes - 23), version: 1 });
      await refuses(
        'FindingEvidence',
        [
          [{ data: JSON.stringify([]) }, error],
          [{ data: JSON.stringify({}) }, error],
          [{ data: JSON.stringify({ version: 2 }) }, error],
          [{ version: 0, data: JSON.stringify({ version: 0 }) }, error],
          [{ data: sized(16_385) }, error],
          [{ firstSeenAt: new Date(SLOT.getTime() + 1) }, error],
        ],
        { findingId },
      );
      const { rowCount } = await insert(
        client,
        'FindingEvidence',
        rows.FindingEvidence({ ...a, findingId }, { data: sized(16_384) }),
      );
      expect(rowCount).toBe(1);
      // Uma por achado.
      expect(
        (await insert(client, 'FindingEvidence', rows.FindingEvidence({ ...a, findingId }))).rowCount,
      ).toBe(0);
    });

    it('o estado do motor tem teto de 4 MiB', async () => {
      const error = /WebEngineState_state_check/;
      // `{"a": "…"}`: 9 bytes além do valor.
      const sized = (bytes: number) => JSON.stringify({ a: 'x'.repeat(bytes - 9) });
      await refuses('WebEngineState', [
        [{ state: JSON.stringify([]) }, error],
        [{ version: 0 }, error],
        [{ state: sized(4_194_305) }, error],
      ]);
      await accepts('WebEngineState', [{}, { state: sized(4_194_304) }]);
    });

    it('o tráfego recusa país, classe, intervalo e contador fora do contrato', async () => {
      for (const [table, column, misaligned, error] of [
        ['WebTrafficSlot', 'slotStart', new Date('2026-11-24T12:06:00.000Z'), /WebTrafficSlot_values_check/],
        ['WebTrafficHour', 'hourStart', new Date('2026-11-24T12:05:00.000Z'), /WebTrafficHour_values_check/],
      ] as const) {
        await refuses(table, [
          [{ country: 'br' }, error],
          [{ country: 'B' }, error],
          [{ country: '1A' }, error],
          [{ clientClass: 'cdn' }, error],
          [{ [column]: misaligned }, error],
          ...['requests', 'blocked', 'clientErrors', 'serverErrors', 'flagged'].map(
            (counter): [Overrides, RegExp] => [{ [counter]: -1 }, error],
          ),
        ]);
        await expect(insert(client, table, rows[table](a, { country: 'BRA' }))).rejects.toThrow(/too long/);
        await accepts(table, [
          ...TRAFFIC_CLASSES.map((clientClass) => ({ clientClass })),
          { country: 'ZZ' },
          { requests: '9007199254740991' },
        ]);
      }
    });

    it('as chaves do tráfego começam pelo cliente, e nenhum índice dele cobre contagem (a soma é update HOT)', async () => {
      const { rows: found } = await client.query<{ table: string; primary: boolean; columns: string[] }>(
        `SELECT i.indrelid::regclass::text AS table, i.indisprimary AS primary,
           array_agg(a.attname::text ORDER BY k.ord) AS columns
         FROM pg_index AS i, unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord), pg_attribute AS a
         WHERE i.indrelid IN ('"WebTrafficSlot"'::regclass, '"WebTrafficHour"'::regclass)
           AND a.attrelid = i.indrelid AND a.attnum = k.attnum
         GROUP BY i.indrelid, i.indexrelid, i.indisprimary ORDER BY 1, 2`,
      );
      for (const [table, at] of [
        ['"WebTrafficSlot"', 'slotStart'],
        ['"WebTrafficHour"', 'hourStart'],
      ] as const) {
        expect(found.filter((index) => index.table === table)).toEqual([
          { table, primary: false, columns: ['tenantId', at] },
          { table, primary: true, columns: ['tenantId', 'sourceId', at, 'country', 'clientClass'] },
        ]);
      }
      const { rows: options } = await client.query<{ options: string[] | null }>(
        `SELECT reloptions AS options FROM pg_class WHERE oid = '"WebTrafficSlot"'::regclass`,
      );
      expect(options[0]?.options).toEqual(['fillfactor=70']);
    });

    it('nenhuma coluna das tabelas novas guarda IP, caminho ou host fora da evidência e da configuração do cliente', () => {
      const columns = {
        WebLogObject: Object.keys(Prisma.WebLogObjectScalarFieldEnum),
        WebTrafficSlot: Object.keys(Prisma.WebTrafficSlotScalarFieldEnum),
        WebTrafficHour: Object.keys(Prisma.WebTrafficHourScalarFieldEnum),
      };
      const counters = ['requests', 'blocked', 'clientErrors', 'serverErrors', 'flagged'];
      expect(columns).toEqual({
        WebLogObject: [
          'cloudAccountId',
          'objectHash',
          'tenantId',
          'sourceId',
          'status',
          'slotStart',
          'lines',
          'bytes',
          'malformed',
          'oversize',
          'foreign',
          'readAt',
        ],
        WebTrafficSlot: ['tenantId', 'sourceId', 'slotStart', 'country', 'clientClass', ...counters],
        WebTrafficHour: ['tenantId', 'sourceId', 'hourStart', 'country', 'clientClass', ...counters],
      });
    });
  });

  describe('banco existente: as migrations anteriores, dados de antes e a nova por cima', () => {
    const database = `verax_web_logs_${randomBytes(6).toString('hex')}`;
    let admin: pg.Client;
    let client: pg.Client;
    let a: Seeded;
    let b: Seeded;
    const previousColumns: Record<string, string[]> = {};
    const previousRows: Record<string, unknown[]> = {};
    const previousFiles: Record<string, unknown> = {};
    let previousSchema: unknown;
    const old = new Date(Date.now() - 200 * DAY_MS);
    const userId = randomUUID();
    const findings = {
      loose: randomUUID(),
      recent: randomUUID(),
      original: randomUUID(),
      other: randomUUID(),
    };

    const columnsOf = async (table: string) =>
      (
        await client.query<{ name: string }>(
          `SELECT column_name AS name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1 ORDER BY 1`,
          [table],
        )
      ).rows.map((row) => row.name);
    const rowsOf = async (table: string, columns: readonly string[]): Promise<unknown[]> =>
      (
        await client.query<Record<string, unknown>>(
          `SELECT ${columns.map((column) => client.escapeIdentifier(column)).join(', ')}
           FROM ${client.escapeIdentifier(table)} ORDER BY "id"`,
        )
      ).rows;
    const fileOf = async (table: string) =>
      (await client.query('SELECT pg_relation_filenode($1::regclass) AS file', [`"${table}"`]))
        .rows[0] as unknown;
    /** Colunas, tipos, padrões, obrigatoriedade, constraints, enums e gatilhos de tudo o que já existia. */
    const schemaOf = async (tables: readonly string[]) => {
      const { rows: columns } = await client.query(
        `SELECT table_name, column_name, data_type, character_maximum_length, is_nullable, column_default
         FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1) ORDER BY 1, 2`,
        [tables],
      );
      const { rows: constraints } = await client.query(
        `SELECT conrelid::regclass::text AS "table", conname, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint WHERE conrelid = ANY($1::regclass[]) ORDER BY 1, 2`,
        [tables.map((table) => `"${table}"`)],
      );
      const { rows: enums } = await client.query(
        `SELECT t.typname, e.enumlabel FROM pg_enum AS e JOIN pg_type AS t ON t.oid = e.enumtypid ORDER BY 1, e.enumsortorder`,
      );
      const { rows: triggers } = await client.query(
        `SELECT tgrelid::regclass::text AS "table", tgname FROM pg_trigger
         WHERE NOT tgisinternal AND tgrelid = ANY($1::regclass[]) ORDER BY 1, 2`,
        [tables.map((table) => `"${table}"`)],
      );
      return { columns, constraints, enums, triggers };
    };
    let previousTables: string[] = [];

    beforeAll(async () => {
      admin = connect(decodeURIComponent(testUrl.pathname.slice(1)));
      await admin.connect();
      await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(database)}`);
      client = connect(database);
      await client.connect();
      for (const name of migrations.filter((candidate) => candidate < MIGRATION)) {
        await client.query(sqlOf(name));
      }

      a = await seedTenant(client, 'Cliente Demo A');
      b = await seedTenant(client, 'Cliente Demo B');
      await insert(client, 'User', {
        id: userId,
        name: 'Analista de teste',
        email: `analista-${randomUUID()}@cliente.example`,
        role: 'analista_cliente',
        tenantId: a.tenantId,
        status: 'active',
        updatedAt: new Date(),
      });
      const aged = { occurredAt: old, createdAt: old, updatedAt: old };
      await insert(client, 'Finding', findingRow(a.tenantId, { ...aged, id: findings.loose }));
      await insert(client, 'Finding', findingRow(a.tenantId, { id: findings.recent }));
      await insert(
        client,
        'Finding',
        findingRow(a.tenantId, { ...aged, id: findings.original, status: 'resolved', triagedAt: old }),
      );
      await insert(client, 'Finding', findingRow(b.tenantId, { id: findings.other }));
      await insert(client, 'FindingComment', {
        id: randomUUID(),
        tenantId: a.tenantId,
        findingId: findings.original,
        authorId: userId,
        body: 'Conferido',
        createdAt: old,
      });

      previousTables = (
        await client.query<{ name: string }>(
          `SELECT relname AS name FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace ORDER BY 1`,
        )
      ).rows.map((row) => row.name);
      for (const table of TOUCHED) {
        previousColumns[table] = await columnsOf(table);
        previousRows[table] = await rowsOf(table, previousColumns[table]);
        previousFiles[table] = await fileOf(table);
      }
      previousSchema = await schemaOf(previousTables);

      // Uma falha no último passo não deixa nada para trás: a migration é uma transação só.
      const broken = sqlOf(MIGRATION).replace(/\bCOMMIT;\s*$/, 'SELECT 1 / 0;\nCOMMIT;');
      await expect(client.query(broken)).rejects.toThrow(/division by zero/);
      await client.query('ROLLBACK');
      expect(await schemaOf(previousTables)).toEqual(previousSchema);
      expect(await columnsOf('FindingEvidence')).toEqual([]);

      await client.query(sqlOf(MIGRATION));
    });

    afterAll(async () => {
      await client.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(database)} WITH (FORCE)`);
      await admin.end();
    });

    it('as linhas de antes ficam iguais (o updatedAt também), nenhuma tabela é reescrita e as novas nascem vazias', async () => {
      for (const table of TOUCHED) {
        expect(await rowsOf(table, previousColumns[table] ?? []), table).toEqual(previousRows[table]);
        expect(await fileOf(table), table).toEqual(previousFiles[table]);
      }
      for (const table of TABLES) {
        expect((await client.query(`SELECT 1 FROM ${client.escapeIdentifier(table)}`)).rowCount, table).toBe(
          0,
        );
      }
    });

    it('nenhuma coluna, padrão, CHECK, enum ou gatilho de antes mudou: a imagem anterior lê e grava como sempre', async () => {
      expect(await schemaOf(previousTables)).toEqual(previousSchema);
    });

    describe('a imagem anterior do nó no esquema novo, com as linhas que a versão nova deixou', () => {
      const removable = randomUUID();

      beforeAll(async () => {
        await insert(client, 'AwsSource', sourceRow({ ...a, sourceId: removable }));
        for (const source of [a.sourceId, removable]) {
          for (const table of TABLES) {
            if (table === 'FindingEvidence') continue;
            await insert(client, table, rows[table]({ ...a, sourceId: source }));
          }
        }
        for (const table of TABLES) {
          if (table !== 'FindingEvidence') await insert(client, table, rows[table](b));
        }
        for (const [seeded, findingId] of [
          [a, findings.loose],
          [a, findings.recent],
          [a, findings.original],
          [b, findings.other],
        ] as const) {
          await insert(client, 'FindingEvidence', rows.FindingEvidence({ ...seeded, findingId }));
        }
      });

      const insertAsPrevious = (table: (typeof TOUCHED)[number], row: Record<string, unknown>) => {
        const known = new Set(previousColumns[table]);
        expect(Object.keys(row).filter((column) => !known.has(column))).toEqual([]);
        return insert(client, table, row);
      };
      const count = async (table: string, column: string, value: string) =>
        (
          await client.query(
            `SELECT 1 FROM ${client.escapeIdentifier(table)} WHERE ${client.escapeIdentifier(column)} = $1`,
            [value],
          )
        ).rowCount;

      it('grava achado e fonte; a releitura cai como duplicada; a triagem e a revisão não esbarram na evidência', async () => {
        const row = findingRow(a.tenantId);
        expect((await insertAsPrevious('Finding', row)).rowCount).toBe(1);
        expect((await insertAsPrevious('Finding', { ...row, id: randomUUID() })).rowCount).toBe(0);
        expect(
          (await insertAsPrevious('AwsSource', sourceRow({ tenantId: a.tenantId, accountId: a.accountId })))
            .rowCount,
        ).toBe(1);
        for (const sql of [
          `UPDATE "Finding" SET "status" = 'investigating', "triagedAt" = now(), "updatedAt" = now() WHERE "id" = $1`,
          `UPDATE "Finding" SET "lastSeenAt" = now(), "severity" = 'critical', "title" = 'Outro', "updatedAt" = now() WHERE "id" = $1`,
        ]) {
          expect((await client.query(sql, [findings.recent])).rowCount).toBe(1);
        }
        await client.query(
          `UPDATE "AwsSource" SET "state" = 'authorized', "authorizedAt" = now(), "updatedAt" = now() WHERE "id" = $1`,
          [a.sourceId],
        );
        expect(await count('FindingEvidence', 'findingId', findings.recent)).toBe(1);
      });

      it('o expurgo dela leva o achado com evidência (solto, com comentário e recorrência): nada o segura', async () => {
        const recurrence = findingRow(a.tenantId, {
          recurrenceOfId: findings.original,
          occurredAt: old,
          updatedAt: old,
        });
        await insertAsPrevious('Finding', recurrence);
        const purge = async (ids: string[]) => {
          await client.query('BEGIN');
          try {
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
              `verax:findings:${a.tenantId}`,
            ]);
            await client.query(
              'SELECT 1 FROM "Finding" WHERE "id" = ANY($1::uuid[]) AND "tenantId" = $2 ORDER BY "id" FOR UPDATE',
              [ids, a.tenantId],
            );
            await client.query('SELECT verax_purge_finding_comments($1::uuid[])', [ids]);
            const { rowCount } = await client.query(
              'DELETE FROM "Finding" WHERE "id" = ANY($1::uuid[]) AND "tenantId" = $2',
              [ids, a.tenantId],
            );
            await client.query('COMMIT');
            return rowCount;
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          }
        };
        expect(await purge([findings.loose, recurrence['id'] as string])).toBe(2);
        expect(await purge([findings.original])).toBe(1);
        for (const id of [findings.loose, findings.original]) {
          expect(await count('FindingEvidence', 'findingId', id)).toBe(0);
        }
        expect(await count('FindingEvidence', 'findingId', findings.recent)).toBe(1);
      });

      it('a descoberta dela esquece a fonte não autorizada, com tudo o que é dela', async () => {
        const { rowCount } = await client.query(
          'DELETE FROM "AwsSource" WHERE "id" = ANY($1::uuid[]) AND "authorizedAt" IS NULL AND "tenantId" = $2',
          [[removable, a.sourceId], a.tenantId],
        );
        expect(rowCount).toBe(1);
        for (const table of TABLES) {
          if (table === 'FindingEvidence') continue;
          expect(await count(table, 'sourceId', removable), table).toBe(0);
          expect(await count(table, 'sourceId', a.sourceId), table).toBe(1);
        }
      });

      it('a exclusão da conta dela leva as fontes e tudo o que é delas; os achados e a evidência ficam', async () => {
        expect(
          (await client.query('DELETE FROM "CloudAccount" WHERE "id" = $1', [a.accountId])).rowCount,
        ).toBe(1);
        for (const table of TABLES) {
          expect(await count(table, 'tenantId', a.tenantId), table).toBe(table === 'FindingEvidence' ? 1 : 0);
        }
        // O outro cliente não é tocado.
        for (const table of TABLES) expect(await count(table, 'tenantId', b.tenantId), table).toBe(1);
      });
    });
  });
});
