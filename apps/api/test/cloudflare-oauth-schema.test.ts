import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  CLOUDFLARE_GRANT_STATUSES,
  CLOUDFLARE_OAUTH_ATTEMPT_ERRORS,
  CLOUDFLARE_OAUTH_ATTEMPT_RETENTION_MS,
  CLOUDFLARE_OAUTH_ATTEMPT_STATUSES,
  CLOUDFLARE_ZONE_STATES,
} from '@verax/shared';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { ConnectAttemptsPurge } from '../src/cloudflare/oauth/connect-attempts.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { TenantScopeViolation } from '../src/common/prisma/tenant-scope.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { createTenant } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';

/**
 * As tabelas da conexão do Cloudflare por OAuth (`20261125120000_cloudflare_oauth`): os CHECKs (os mesmos valores do
 * contrato), as amarrações entre clientes, o escopo, a faxina das tentativas e a migration sobre um banco com contas e
 * credenciais já cadastradas.
 */

const MIGRATION = '20261125120000_cloudflare_oauth';
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

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
/** Um envelope de formato válido, de uma versão da chave que a recifragem dos outros testes não alcança. */
const ENVELOPE = 'v9:QUJD';

describe(`migration ${MIGRATION}`, () => {
  it('só acrescenta: nada é apagado, reescrito nem tornado obrigatório no que já existe', () => {
    const sql = sqlOf(MIGRATION);
    expect(sql).not.toMatch(
      /\bDROP\b|DELETE FROM|^\s*UPDATE\b|\bTRUNCATE\b|ALTER COLUMN|ALTER TYPE|INSERT INTO/im,
    );
    // O enum do banco não ganha tipo: a versão anterior do nó não leria a linha numa volta de versão.
    expect(sql).not.toContain('CloudCredentialKind');
    const alters = sql
      .split('\n')
      .filter(
        (line) => line.startsWith('ALTER TABLE') && !/"Cloudflare(ConnectAttempt|Grant|Zone)" /.test(line),
      );
    expect(alters).toEqual([
      'ALTER TABLE "CloudAccount" ADD COLUMN     "cloudflareGrantId" UUID;',
      expect.stringContaining('ADD CONSTRAINT "CloudAccount_cloudflareGrantId_tenantId_fkey" FOREIGN KEY'),
      'ALTER TABLE "CloudAccount" ADD CONSTRAINT "CloudAccount_cloudflare_grant_check" CHECK (',
    ]);
  });

  it('a da conexão (CF-4) só acrescenta colunas, vazias nas linhas que já existem', () => {
    const statements = sqlOf('20261126120000_cloudflare_oauth_connect')
      .split('\n')
      .filter((line) => line.trim().length > 0 && !line.startsWith('--'));
    expect(statements).toEqual([
      'ALTER TABLE "ControlPlaneSync" ADD COLUMN     "cloudflareOauth" JSONB;',
      'ALTER TABLE "CloudflareConnectAttempt" ADD COLUMN     "accountIdRequired" BOOLEAN NOT NULL DEFAULT false,',
      'ADD COLUMN     "chosenAccountIds" TEXT[] DEFAULT ARRAY[]::TEXT[],',
      'ADD COLUMN     "config" JSONB,',
      'ADD COLUMN     "discoveredAt" TIMESTAMPTZ(3);',
    ]);
  });

  describe('banco existente', () => {
    const database = `cf_oauth_mig_${hex(6)}_test`;
    let admin: pg.Client;
    let client: pg.Client;

    beforeAll(async () => {
      admin = connect(testUrl.pathname.slice(1));
      await admin.connect();
      await admin.query(`CREATE DATABASE "${database}"`);
      client = connect(database);
      await client.connect();
      for (const name of migrations.slice(0, migrations.indexOf(MIGRATION))) await client.query(sqlOf(name));
    }, 120_000);

    afterAll(async () => {
      await client.end();
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
      await admin.end();
    });

    it('as contas, a credencial colada e o cursor ficam iguais, e a conta nasce sem concessão', async () => {
      const tenantId = randomUUID();
      const accountId = randomUUID();
      await client.query(
        `INSERT INTO "Tenant" ("id", "name", "updatedAt") VALUES ($1, 'Cliente Demo A', now())`,
        [tenantId],
      );
      await client.query(
        `INSERT INTO "CloudAccount" ("id", "tenantId", "provider", "accountId", "regions", "zones", "connection", "updatedAt")
         VALUES ($1, $2, 'cloudflare', $3, '{}', ARRAY['exemplo.com.br'], 'connected', now())`,
        [accountId, tenantId, hex(16)],
      );
      await client.query(
        `INSERT INTO "CloudCredential"
           ("cloudAccountId", "tenantId", "kind", "ciphertext", "keyVersion", "keyIdSuffix", "verifiedAt", "updatedAt")
         VALUES ($1, $2, 'cloudflare_api_token', $3, 9, 'a1b2', now(), now())`,
        [accountId, tenantId, ENVELOPE],
      );
      await client.query(
        `INSERT INTO "CollectorCursor" ("id", "cloudAccountId", "stream", "cursorAt", "updatedAt")
         VALUES ($1, $2, 'cloudflare_audit', now(), now())`,
        [randomUUID(), accountId],
      );
      const snapshot = async () => {
        const rows: Record<string, unknown>[][] = [];
        for (const table of ['CloudAccount', 'CloudCredential', 'CollectorCursor']) {
          rows.push((await client.query<Record<string, unknown>>(`SELECT * FROM "${table}"`)).rows);
        }
        return rows;
      };
      const before = await snapshot();
      await client.query(sqlOf(MIGRATION));
      const [accounts, ...others] = await snapshot();
      expect(accounts).toEqual(before[0]?.map((row) => ({ ...row, cloudflareGrantId: null })));
      expect(others).toEqual(before.slice(1));
      // A versão anterior continua gravando sem conhecer a coluna.
      await client.query(`UPDATE "CloudAccount" SET "connection" = 'error', "connectionError" = 'timeout'`);
    });
  });
});

describe('tabelas da conexão do Cloudflare por OAuth', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let client: pg.Client;
  let tenantA: string;
  let tenantB: string;
  let accountA: string;
  let accountB: string;
  let awsA: string;

  const grantData = (
    tenantId: string,
    changes: Partial<Prisma.CloudflareGrantUncheckedCreateInput> = {},
  ) => ({
    tenantId,
    clientId: 'clientedeteste0001',
    ciphertext: ENVELOPE,
    keyVersion: 9,
    accessExpiresAt: new Date(Date.now() + 3_600_000),
    scopes: ['zone.read', 'offline_access'],
    consentedAt: new Date(),
    consentedBy: 'usuario-de-teste',
    ...changes,
  });
  const attemptData = (
    tenantId: string,
    changes: Partial<Prisma.CloudflareConnectAttemptUncheckedCreateInput> = {},
  ) => ({
    tenantId,
    userId: 'usuario-de-teste',
    sessionId: 'sessao-de-teste',
    stateHash: hex(32),
    verifierCiphertext: ENVELOPE,
    expiresAt: new Date(Date.now() + 600_000),
    ...changes,
  });
  const zoneData = (
    tenantId: string,
    cloudAccountId: string,
    changes: Partial<Prisma.CloudflareZoneUncheckedCreateInput> = {},
  ) => ({ tenantId, cloudAccountId, zoneId: hex(16), name: 'exemplo.com.br', ...changes });
  const newGrant = (tenantId: string, changes = {}) =>
    prisma.cloudflareGrant.create({ data: grantData(tenantId, changes) });

  async function constraintValues(name: string, marker: string): Promise<string[]> {
    const { rows } = await client.query<{ definition: string }>(
      'SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = $1',
      [name],
    );
    const definition = rows[0]?.definition ?? '';
    const start = definition.indexOf(marker);
    if (start < 0) throw new Error(`"${marker}" não aparece em ${name}`);
    const open = definition.indexOf('[', start);
    return [...definition.slice(open, definition.indexOf(']', open)).matchAll(/'([^']+)'/g)]
      .map((match) => match[1] ?? '')
      .sort();
  }

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    client = connect(testUrl.pathname.slice(1));
    await client.connect();
    tenantA = await createTenant(app, 'Cliente Demo A (Cloudflare OAuth)');
    tenantB = await createTenant(app, 'Cliente Demo B (Cloudflare OAuth)');
    const account = async (tenantId: string, provider: 'aws' | 'cloudflare') =>
      (
        await prisma.cloudAccount.create({
          data: {
            tenantId,
            provider,
            accountId:
              provider === 'aws' ? String(100_000_000_000 + Math.trunc(Math.random() * 1e9)) : hex(16),
            regions: provider === 'aws' ? ['sa-east-1'] : [],
          },
          select: { id: true },
        })
      ).id;
    accountA = await account(tenantA, 'cloudflare');
    accountB = await account(tenantB, 'cloudflare');
    awsA = await account(tenantA, 'aws');
  });

  afterEach(async () => {
    const mine = { tenantId: { in: [tenantA, tenantB] } };
    await prisma.cloudflareZone.deleteMany({ where: mine });
    await prisma.cloudAccount.updateMany({ where: mine, data: { cloudflareGrantId: null } });
    await prisma.cloudflareConnectAttempt.deleteMany({ where: mine });
    await prisma.cloudflareGrant.deleteMany({ where: mine });
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  it('os CHECKs repetem os valores do contrato, sem faltar nem sobrar', async () => {
    expect(await constraintValues('CloudflareConnectAttempt_status_check', '(status)::text')).toEqual(
      [...CLOUDFLARE_OAUTH_ATTEMPT_STATUSES].sort(),
    );
    expect(await constraintValues('CloudflareConnectAttempt_error_check', '("errorCode")::text')).toEqual(
      [...CLOUDFLARE_OAUTH_ATTEMPT_ERRORS].sort(),
    );
    expect(await constraintValues('CloudflareGrant_status_check', '(status)::text')).toEqual(
      [...CLOUDFLARE_GRANT_STATUSES].sort(),
    );
    expect(await constraintValues('CloudflareZone_state_check', '(state)::text')).toEqual(
      [...CLOUDFLARE_ZONE_STATES].sort(),
    );
  });

  it('tentativa: o segredo só existe no passo que o usa', async () => {
    const grant = await newGrant(tenantA);
    const at = new Date();
    const open = { verifierCiphertext: ENVELOPE, codeCiphertext: null, consumedAt: null, grantId: null };
    const closed = { verifierCiphertext: null, codeCiphertext: null, consumedAt: at, grantId: grant.id };
    const valid: Partial<Prisma.CloudflareConnectAttemptUncheckedCreateInput>[] = [
      { ...open, status: 'started' },
      { ...open, status: 'code_received', codeCiphertext: ENVELOPE, consumedAt: at },
      { ...closed, status: 'choosing' },
      { ...closed, status: 'done' },
      { ...closed, status: 'failed', grantId: null, errorCode: 'oauth_denied' },
      { ...closed, status: 'expired', consumedAt: null, grantId: null },
    ];
    for (const row of valid) {
      await prisma.cloudflareConnectAttempt.create({ data: attemptData(tenantA, row) });
    }
    const invalid: Partial<Prisma.CloudflareConnectAttemptUncheckedCreateInput>[] = [
      { ...open, status: 'started', verifierCiphertext: null },
      { ...open, status: 'started', codeCiphertext: ENVELOPE },
      { ...open, status: 'started', consumedAt: at },
      { ...open, status: 'code_received', consumedAt: at },
      { ...open, status: 'code_received', codeCiphertext: ENVELOPE },
      // Terminada, vencida ou já trocada: nenhum segredo fica.
      { ...closed, status: 'done', verifierCiphertext: ENVELOPE },
      { ...closed, status: 'choosing', codeCiphertext: ENVELOPE },
      { ...closed, status: 'expired', verifierCiphertext: ENVELOPE },
      { ...closed, status: 'failed', errorCode: 'oauth_denied', codeCiphertext: ENVELOPE },
      { ...closed, status: 'failed', errorCode: null },
      { ...closed, status: 'done', errorCode: 'oauth_denied' },
      { ...closed, status: 'failed', errorCode: 'mensagem livre' },
      { ...closed, status: 'done', grantId: null },
      { ...closed, status: 'outro' },
      { stateHash: 'curto' },
      { verifierCiphertext: 'verificador-em-claro' },
      { userId: '' },
      { sessionId: '' },
      { accounts: { nao: 'lista' } },
      { expiresAt: new Date(Date.now() - 60_000) },
    ];
    for (const row of invalid) {
      await expect(
        prisma.cloudflareConnectAttempt.create({ data: attemptData(tenantA, row) }),
        JSON.stringify(row),
      ).rejects.toThrow();
    }
    // O mesmo state não entra duas vezes, nem em outro cliente.
    const repeated = attemptData(tenantA);
    await prisma.cloudflareConnectAttempt.create({ data: repeated });
    await expect(
      prisma.cloudflareConnectAttempt.create({ data: { ...repeated, tenantId: tenantB } }),
    ).rejects.toThrow();
  });

  it('concessão: o envelope é o da versão gravada, e a data da revogação só enquanto espera', async () => {
    await newGrant(tenantA, { status: 'reconnect' });
    await newGrant(tenantA, { status: 'revoking', revokeRequestedAt: new Date() });
    const invalid: Partial<Prisma.CloudflareGrantUncheckedCreateInput>[] = [
      { ciphertext: 'v8:QUJD' },
      { ciphertext: 'token-em-claro' },
      { keyVersion: 0, ciphertext: 'v0:QUJD' },
      { status: 'outro' },
      { status: 'revoking' },
      { status: 'active', revokeRequestedAt: new Date() },
      { scopes: [] },
      { generation: 0 },
      { clientId: 'com espaço' },
      { consentedBy: '' },
      { lastErrorKind: 'mensagem com espaço' },
    ];
    for (const row of invalid) {
      await expect(newGrant(tenantA, row), JSON.stringify(row)).rejects.toThrow();
    }
  });

  it('zona: a que sumiu tem a data; uma por conta', async () => {
    const zone = zoneData(tenantA, accountA);
    await prisma.cloudflareZone.create({ data: zone });
    await expect(prisma.cloudflareZone.create({ data: zone })).rejects.toThrow();
    for (const row of [
      { state: 'missing' },
      { missingSince: new Date() },
      { state: 'outro' },
      { zoneId: 'curto' },
      { name: '' },
      { lastErrorCode: 'com espaço' },
    ]) {
      await expect(
        prisma.cloudflareZone.create({ data: zoneData(tenantA, accountA, row) }),
        JSON.stringify(row),
      ).rejects.toThrow();
    }
  });

  it('o banco recusa a concessão, a tentativa e a zona de um cliente na linha de outro, e a concessão fora do Cloudflare', async () => {
    const grantA = await newGrant(tenantA);
    // Sem escopo nenhum (um erro da aplicação): as chaves estrangeiras compostas.
    await expect(
      prisma.cloudAccount.update({ where: { id: accountB }, data: { cloudflareGrantId: grantA.id } }),
    ).rejects.toThrow();
    await expect(
      prisma.cloudAccount.update({ where: { id: awsA }, data: { cloudflareGrantId: grantA.id } }),
    ).rejects.toThrow(/CloudAccount_cloudflare_grant_check/);
    await expect(
      prisma.cloudflareConnectAttempt.create({ data: attemptData(tenantB, { cloudAccountId: accountA }) }),
    ).rejects.toThrow();
    await expect(
      prisma.cloudflareConnectAttempt.create({
        data: attemptData(tenantB, {
          status: 'done',
          verifierCiphertext: null,
          consumedAt: new Date(),
          grantId: grantA.id,
        }),
      }),
    ).rejects.toThrow();
    await expect(prisma.cloudflareZone.create({ data: zoneData(tenantB, accountA) })).rejects.toThrow();
    await prisma.cloudAccount.update({ where: { id: accountA }, data: { cloudflareGrantId: grantA.id } });
  });

  it('a concessão em uso não sai; excluir a conta leva as zonas e as tentativas dela, e a concessão fica', async () => {
    const grant = await newGrant(tenantA);
    const { id } = await prisma.cloudAccount.create({
      data: {
        tenantId: tenantA,
        provider: 'cloudflare',
        accountId: hex(16),
        regions: [],
        cloudflareGrantId: grant.id,
      },
      select: { id: true },
    });
    await prisma.cloudflareZone.create({ data: zoneData(tenantA, id) });
    await prisma.cloudflareConnectAttempt.create({ data: attemptData(tenantA, { cloudAccountId: id }) });
    await expect(prisma.cloudflareGrant.delete({ where: { id: grant.id } })).rejects.toThrow();

    await prisma.cloudAccount.delete({ where: { id } });
    expect(await prisma.cloudflareZone.count({ where: { tenantId: tenantA } })).toBe(0);
    expect(await prisma.cloudflareConnectAttempt.count({ where: { tenantId: tenantA } })).toBe(0);
    expect(await prisma.cloudflareGrant.count({ where: { id: grant.id } })).toBe(1);
    await prisma.cloudflareGrant.delete({ where: { id: grant.id } });
  });

  it('A/B: pelo escopo do cliente A, nada do B existe, muda ou sai; as zonas só se leem', async () => {
    const grantB = await newGrant(tenantB);
    const attemptB = await prisma.cloudflareConnectAttempt.create({ data: attemptData(tenantB) });
    const zoneB = await prisma.cloudflareZone.create({ data: zoneData(tenantB, accountB) });
    const scopedA = prisma.forTenant(tenantA);

    expect(await scopedA.cloudflareGrant.findUnique({ where: { id: grantB.id } })).toBeNull();
    expect(await scopedA.cloudflareGrant.findMany()).toEqual([]);
    expect(
      await scopedA.cloudflareGrant.updateMany({ where: { id: grantB.id }, data: { status: 'reconnect' } }),
    ).toEqual({ count: 0 });
    expect(await scopedA.cloudflareGrant.deleteMany({ where: { id: grantB.id } })).toEqual({ count: 0 });
    expect(() => scopedA.cloudflareGrant.create({ data: grantData(tenantB) })).toThrow(TenantScopeViolation);

    const byState = { stateHash: attemptB.stateHash };
    expect(await scopedA.cloudflareConnectAttempt.findUnique({ where: byState })).toBeNull();
    expect(
      await scopedA.cloudflareConnectAttempt.updateMany({
        where: byState,
        data: { status: 'expired', verifierCiphertext: null },
      }),
    ).toEqual({ count: 0 });
    expect(await scopedA.cloudflareConnectAttempt.deleteMany({ where: byState })).toEqual({ count: 0 });
    expect(() => scopedA.cloudflareConnectAttempt.create({ data: attemptData(tenantB) })).toThrow(
      TenantScopeViolation,
    );

    expect(await scopedA.cloudflareZone.findUnique({ where: { id: zoneB.id } })).toBeNull();
    expect(await prisma.forTenant(tenantB).cloudflareZone.count()).toBe(1);
    // A gravação da zona é recusada no escopo, até a do próprio cliente.
    expect(() => scopedA.cloudflareZone.create({ data: zoneData(tenantA, accountA) })).toThrow(
      TenantScopeViolation,
    );
    expect(() => scopedA.cloudflareZone.updateMany({ data: { state: 'reading' } })).toThrow(
      TenantScopeViolation,
    );
    expect(() => scopedA.cloudflareZone.deleteMany({})).toThrow(TenantScopeViolation);

    expect(await prisma.cloudflareGrant.findUniqueOrThrow({ where: { id: grantB.id } })).toEqual(grantB);
    expect(await prisma.cloudflareConnectAttempt.findUniqueOrThrow({ where: byState })).toEqual(attemptB);
  });

  describe('faxina das tentativas', () => {
    const now = new Date();
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const MINUTE = 60_000;
    const statusOf = async (id: string) =>
      prisma.cloudflareConnectAttempt.findUnique({
        where: { id },
        select: { status: true, verifierCiphertext: true, codeCiphertext: true },
      });

    it('a aberta vencida perde o verificador e o código; a que ainda vale e a concessão não são tocadas', async () => {
      const grant = await newGrant(tenantA);
      const past = { createdAt: ago(15 * MINUTE), expiresAt: ago(5 * MINUTE) };
      const create = async (changes: Partial<Prisma.CloudflareConnectAttemptUncheckedCreateInput>) =>
        (await prisma.cloudflareConnectAttempt.create({ data: attemptData(tenantA, changes) })).id;
      const started = await create(past);
      const received = await create({
        ...past,
        status: 'code_received',
        codeCiphertext: ENVELOPE,
        consumedAt: ago(10 * MINUTE),
      });
      const choosing = await create({
        ...past,
        status: 'choosing',
        verifierCiphertext: null,
        consumedAt: ago(10 * MINUTE),
        grantId: grant.id,
      });
      const alive = await create({});

      expect(await new ConnectAttemptsPurge(prisma).runOnce(now)).toEqual({
        expired: 3,
        purged: 0,
        orphaned: 0,
      });
      for (const id of [started, received, choosing]) {
        expect(await statusOf(id)).toEqual({
          status: 'expired',
          verifierCiphertext: null,
          codeCiphertext: null,
        });
      }
      expect(await statusOf(alive)).toEqual({
        status: 'started',
        verifierCiphertext: ENVELOPE,
        codeCiphertext: null,
      });
      expect(await prisma.cloudflareGrant.findUniqueOrThrow({ where: { id: grant.id } })).toEqual(grant);
      // Rodar de novo não muda nada.
      expect(await new ConnectAttemptsPurge(prisma).runOnce(now)).toEqual({
        expired: 0,
        purged: 0,
        orphaned: 0,
      });
    });

    it('a terminada some 24 h depois de criada, em qualquer cliente; a vencida há mais tempo, na mesma passada', async () => {
      const day = CLOUDFLARE_OAUTH_ATTEMPT_RETENTION_MS;
      const ended = (createdAt: Date) => ({
        status: 'failed',
        errorCode: 'oauth_denied',
        verifierCiphertext: null,
        consumedAt: createdAt,
        createdAt,
        expiresAt: new Date(createdAt.getTime() + 10 * MINUTE),
      });
      const old = await prisma.cloudflareConnectAttempt.create({
        data: attemptData(tenantA, ended(ago(day + MINUTE))),
      });
      const oldB = await prisma.cloudflareConnectAttempt.create({
        data: attemptData(tenantB, ended(ago(day + MINUTE))),
      });
      const recent = await prisma.cloudflareConnectAttempt.create({
        data: attemptData(tenantA, ended(ago(day - MINUTE))),
      });
      const abandoned = await prisma.cloudflareConnectAttempt.create({
        data: attemptData(tenantA, { createdAt: ago(2 * day), expiresAt: ago(2 * day - 10 * MINUTE) }),
      });

      expect(await new ConnectAttemptsPurge(prisma).runOnce(now)).toEqual({
        expired: 1,
        purged: 3,
        orphaned: 0,
      });
      for (const { id } of [old, oldB, abandoned]) expect(await statusOf(id)).toBeNull();
      expect(await statusOf(recent.id)).not.toBeNull();
    });

    it('a concessão sem conta e sem tentativa aberta vai para a revogação, uma vez, com a trilha no cliente dela', async () => {
      const old = { createdAt: ago(2 * 60 * MINUTE) };
      const make = (tenantId: string, changes = {}) =>
        prisma.cloudflareGrant.create({ data: grantData(tenantId, { ...old, ...changes }) });
      const abandoned = await make(tenantA);
      await prisma.cloudflareConnectAttempt.create({
        data: attemptData(tenantA, {
          status: 'choosing',
          verifierCiphertext: null,
          consumedAt: ago(10 * MINUTE),
          createdAt: ago(15 * MINUTE),
          expiresAt: ago(5 * MINUTE),
          grantId: abandoned.id,
        }),
      });
      const orphanB = await make(tenantB, { status: 'reconnect' });
      const choosing = await make(tenantA);
      await prisma.cloudflareConnectAttempt.create({
        data: attemptData(tenantA, {
          status: 'choosing',
          verifierCiphertext: null,
          consumedAt: now,
          grantId: choosing.id,
        }),
      });
      const used = await make(tenantA);
      const { id: accountId } = await prisma.cloudAccount.create({
        data: {
          tenantId: tenantA,
          provider: 'cloudflare',
          accountId: hex(16),
          regions: [],
          cloudflareGrantId: used.id,
        },
      });
      const fresh = await newGrant(tenantA);

      const before = await prisma.auditLog.count({ where: { action: 'cloudflare_grant.release' } });
      expect(await new ConnectAttemptsPurge(prisma).runOnce(now)).toEqual({
        expired: 1,
        purged: 0,
        orphaned: 2,
      });
      for (const { id, tenantId } of [abandoned, orphanB]) {
        expect(await prisma.cloudflareGrant.findUniqueOrThrow({ where: { id } })).toMatchObject({
          status: 'revoking',
          revokeRequestedAt: now,
        });
        expect(
          await prisma.auditLog.count({
            where: { tenantId, action: 'cloudflare_grant.release', resourceId: id },
          }),
        ).toBe(1);
      }
      for (const row of [choosing, used, fresh]) {
        expect(await prisma.cloudflareGrant.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
      }
      expect(await new ConnectAttemptsPurge(prisma).runOnce(now)).toMatchObject({ orphaned: 0 });
      expect(await prisma.auditLog.count({ where: { action: 'cloudflare_grant.release' } })).toBe(before + 2);

      // A última conta excluída também solta a concessão.
      await prisma.cloudAccount.delete({ where: { id: accountId } });
      expect(await new ConnectAttemptsPurge(prisma).runOnce(now)).toMatchObject({ orphaned: 1 });
    });

    it('a parada do worker interrompe antes de escrever', async () => {
      const row = await prisma.cloudflareConnectAttempt.create({
        data: attemptData(tenantA, { createdAt: ago(15 * MINUTE), expiresAt: ago(5 * MINUTE) }),
      });
      await expect(
        new ConnectAttemptsPurge(prisma).runOnce(now, AbortSignal.abort(new Error('parada'))),
      ).rejects.toThrow('parada');
      expect((await statusOf(row.id))?.status).toBe('started');
    });
  });
});
