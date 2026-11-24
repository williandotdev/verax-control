import 'reflect-metadata';
import { generateKeyPairSync, type KeyObject, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type CloudflareZone, cloudflareConnectionSchema, cloudflareZonesSchema } from '@verax/shared';
import { sealCloudflareOauthTokens } from '@verax/vault-envelope';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import {
  CLOUDFLARE_AUDIT_STREAM,
  CLOUDFLARE_CHECK_STREAM,
  CLOUDFLARE_SECURITY_STREAM,
  CloudflareAuditSync,
  type CloudflareAuditSyncOptions,
} from '../src/cloudflare/cloudflare-audit-sync.js';
import { CloudflareClient } from '../src/cloudflare/cloudflare.client.js';
import { CloudflareTokenCheck } from '../src/cloudflare/cloudflare-token-check.js';
import { SECURITY_MAX_ZONES } from '../src/cloudflare/security-events.js';
import {
  ZONE_HEALTH_MAX_ROWS,
  ZONE_READ_REFRESH_MS,
  ZONE_SEEN_REFRESH_MS,
  ZoneObserver,
} from '../src/cloudflare/zone-health.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import {
  parsePrivateKeys,
  parsePublicKey,
  type VaultKeyring,
  type VaultPublicKey,
} from '../src/credentials/credential-keys.js';
import { CloudflareToken, credentialBinding, seal } from '../src/credentials/credential-vault.js';
import { hex } from './cloudflare/fixtures.js';
import { createSignedInUser, createTenant, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import { DEFAULT_ZONE_LIMITS, fakeCloudflare, FakeCloudflareServer } from './support/fake-cloudflare.js';

/** Versão da chave do nó, exclusiva deste arquivo: os arquivos rodam em paralelo no mesmo banco. */
const KEY_VERSION = 940;
/** 12:20 UTC: a última janela que dá para ler é a de 12:00 a 12:15 (fechada há 5 min). */
const NOW = new Date('2026-11-04T12:20:00.000Z');
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const FAR = new Date('2100-01-01T00:00:00.000Z');
const pem64 = (key: KeyObject, type: 'spki' | 'pkcs8') =>
  Buffer.from(key.export({ type, format: 'pem' })).toString('base64');

interface Account {
  id: string;
  tenantId: string;
  accountId: string;
  provider: 'cloudflare';
}
interface Warning {
  cloudAccountId?: string;
  code?: string;
  dropped?: number;
}

describe('saúde das zonas do Cloudflare (banco real e Cloudflare falso)', () => {
  const cloudflare = new FakeCloudflareServer();
  const tenants: string[] = [];
  const warnings: Warning[] = [];
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let keyring: VaultKeyring;
  let publicKey: VaultPublicKey;
  let run = 0;

  const syncFor = (options: CloudflareAuditSyncOptions = {}) => {
    run += 1;
    return new CloudflareAuditSync(prisma, keyring, {
      name: `cf-zonas-teste-${run}`,
      client: new CloudflareClient({ baseUrl: cloudflare.baseUrl, timeoutMs: 400, retryDelaysMs: [5, 5] }),
      tokenCheck: new CloudflareTokenCheck({ baseUrl: cloudflare.baseUrl, timeoutMs: 2_000 }),
      oauthTokens: { refresh: () => Promise.reject(new Error('sem renovação neste teste')) },
      tenantIds: [tenantA, tenantB],
      securityEvents: { firstReadMs: 60 * 60_000 },
      logger: { warn: (fields) => warnings.push(fields) },
      ...options,
    });
  };

  async function newAccount(
    tenantId: string,
    {
      zones = [],
      grantId = null,
      accountId = fakeCloudflare.accountId(),
    }: { zones?: string[]; grantId?: string | null; accountId?: string } = {},
  ): Promise<Account> {
    const account = await prisma.forTenant(tenantId).cloudAccount.create({
      data: { tenantId, provider: 'cloudflare', accountId, regions: [], zones, cloudflareGrantId: grantId },
      select: { id: true, tenantId: true, accountId: true },
    });
    // Só os eventos de segurança na hora; a auditoria e a conferência ficam para 2100.
    for (const stream of [CLOUDFLARE_AUDIT_STREAM, CLOUDFLARE_CHECK_STREAM]) {
      await prisma.collectorCursor.create({
        data: { cloudAccountId: account.id, stream, nextRunAt: FAR },
      });
    }
    return { ...account, provider: 'cloudflare' };
  }

  async function storeToken(account: Account, value: string): Promise<void> {
    const sealed = seal(
      publicKey,
      credentialBinding(account, 'cloudflare_api_token'),
      new CloudflareToken(value),
    );
    await prisma.forTenant(account.tenantId).cloudCredential.create({
      data: {
        cloudAccountId: account.id,
        tenantId: account.tenantId,
        kind: 'cloudflare_api_token',
        ciphertext: sealed.ciphertext,
        keyVersion: sealed.keyVersion,
        keyIdSuffix: 'c0de',
        verifiedAt: at(-60),
      },
    });
  }

  async function tokenAccount(
    tenantId: string,
    {
      listed = ['loja.exemplo.com.br'],
      zones = [],
      limits = {},
      token = {},
    }: {
      listed?: string[];
      zones?: string[];
      limits?: Record<string, Partial<typeof DEFAULT_ZONE_LIMITS> | null>;
      token?: Parameters<FakeCloudflareServer['readableAccountToken']>[1];
    } = {},
  ) {
    const account = await newAccount(tenantId, { zones });
    const tags = listed.map((name) =>
      cloudflare.addSecurityZone(account.accountId, name, {
        limits: limits[name] === null ? null : { ...DEFAULT_ZONE_LIMITS, ...limits[name] },
      }),
    );
    const value = cloudflare.readableAccountToken(account.accountId, token);
    await storeToken(account, value);
    return { account, value, tags };
  }

  async function newGrant(tenantId: string, accountId: string) {
    const id = randomUUID();
    const value = `at_${hex(24)}`;
    cloudflare.tokens.set(value, { id: hex(16), owner: 'user', accountId, auditAccounts: [accountId] });
    await prisma.forTenant(tenantId).cloudflareGrant.create({
      data: {
        id,
        tenantId,
        clientId: 'clientedeteste0001',
        ciphertext: sealCloudflareOauthTokens(
          publicKey,
          { tenantId, subjectId: id },
          { accessToken: value, refreshToken: `rt_${hex(24)}`, accessExpiresAt: FAR },
        ),
        keyVersion: publicKey.version,
        accessExpiresAt: FAR,
        scopes: ['zone.read', 'offline_access'],
        consentedAt: at(-30),
        consentedBy: 'usuario-de-teste',
        lastRefreshAt: at(-10),
      },
    });
    return { id, value };
  }

  const rowsOf = (cloudAccountId: string) =>
    prisma.cloudflareZone.findMany({ where: { cloudAccountId }, orderBy: { name: 'asc' } });
  const statesOf = async (cloudAccountId: string) =>
    Object.fromEntries((await rowsOf(cloudAccountId)).map((row) => [row.name, row.state]));
  const securityCursor = (cloudAccountId: string) =>
    prisma.collectorCursor.findUniqueOrThrow({
      where: {
        cloudAccountId_stream_region: { cloudAccountId, stream: CLOUDFLARE_SECURITY_STREAM, region: '' },
      },
    });

  async function session(tenantId: string, role: 'admin_cliente' | 'leitura' = 'admin_cliente') {
    const user = await createSignedInUser(app, { role, tenantId });
    return withCsrf(app, user.cookie);
  }
  const get = (cookie: string, path: string) => request(app.getHttpServer()).get(path).set('Cookie', cookie);
  const zonesOf = async (cookie: string, id: string) =>
    cloudflareZonesSchema.parse(
      (await get(cookie, `/v1/cloud-accounts/${id}/cloudflare-zones`).expect(200)).body,
    );
  const byName = (zones: readonly CloudflareZone[]) =>
    Object.fromEntries(zones.map((zone) => [zone.name, zone.state]));

  beforeAll(async () => {
    await cloudflare.start();
    app = await createApp();
    prisma = app.get(PrismaService);
    const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
    keyring = parsePrivateKeys(`${KEY_VERSION}:${pem64(pair.privateKey, 'pkcs8')}`, KEY_VERSION);
    publicKey = parsePublicKey(pem64(pair.publicKey, 'spki'), KEY_VERSION);
  });

  beforeEach(async () => {
    warnings.length = 0;
    cloudflare.graphqlScript.length = 0;
    tenantA = await createTenant(app, 'Cliente Demo A (zonas do Cloudflare)');
    tenantB = await createTenant(app, 'Cliente Demo B (zonas do Cloudflare)');
    tenants.push(tenantA, tenantB);
  });

  afterAll(async () => {
    const own = { tenantId: { in: tenants } };
    await prisma.cloudCredential.deleteMany({ where: own });
    await prisma.cloudAccount.updateMany({ where: own, data: { cloudflareGrantId: null } });
    await prisma.cloudflareGrant.deleteMany({ where: own });
    await app.close();
    await cloudflare.stop();
  });

  describe('o que o worker grava', () => {
    it('cada zona com a situação, o plano e a leitura, sem consulta a mais no Cloudflare', async () => {
      const { account, value, tags } = await tokenAccount(tenantA, {
        listed: ['a.exemplo.com.br', 'b.exemplo.com.br', 'c.exemplo.com.br', 'd.exemplo.com.br'],
        limits: { 'b.exemplo.com.br': { enabled: false } },
      });
      const [a, b, c, d] = tags as [string, string, string, string];
      const access = cloudflare.tokens.get(value);
      if (!access) throw new Error('sem acesso');
      access.analyticsZones = [a, b, d];
      cloudflare.zonePlans.set(a, { name: 'Pro Website', legacy_id: 'pro' });
      cloudflare.zonePlans.set(b, 'fora do formato');
      cloudflare.zonePlans.set(d, { name: ` ${'p'.repeat(90)}\u0007` });

      await syncFor().runOnce(NOW);
      const rows = await rowsOf(account.id);
      expect(rows.map((row) => [row.zoneId, row.name, row.plan, row.state])).toEqual([
        [a, 'a.exemplo.com.br', 'Pro Website', 'reading'],
        [b, 'b.exemplo.com.br', null, 'not_entitled'],
        [c, 'c.exemplo.com.br', null, 'forbidden'],
        [d, 'd.exemplo.com.br', 'p'.repeat(64), 'reading'],
      ]);
      for (const row of rows) {
        expect(row).toMatchObject({ tenantId: tenantA, lastErrorCode: null, missingSince: null });
        expect(row.lastReadAt !== null).toBe(row.state === 'reading');
        expect(row.lastReadAt?.getTime() ?? NOW.getTime()).toBeGreaterThanOrEqual(NOW.getTime());
      }
      // A mesma quantidade de pedidos de sempre: uma lista, os limites e as quatro janelas.
      expect(cloudflare.callsWith(value).filter((call) => call.path === '/zones')).toHaveLength(1);
      expect(cloudflare.graphqlReads(value, 'settings')).toHaveLength(1);
      expect(cloudflare.graphqlReads(value, 'events')).toHaveLength(4);
      expect(warnings).toEqual([]);
    });

    it('a conta por OAuth tem a mesma saúde', async () => {
      const accountId = fakeCloudflare.accountId();
      const grant = await newGrant(tenantA, accountId);
      const account = await newAccount(tenantA, { grantId: grant.id, accountId });
      cloudflare.addSecurityZone(accountId, 'oauth.exemplo.com.br');
      const report = await syncFor().runOnce(NOW);
      expect(report).toMatchObject({ accounts: 1, securityWindows: 4 });
      expect(await statesOf(account.id)).toEqual({ 'oauth.exemplo.com.br': 'reading' });
    });

    it('além do máximo de zonas, as de fora aparecem como tal e o total é o da conta', async () => {
      const listed = Array.from(
        { length: SECURITY_MAX_ZONES + 3 },
        (_, index) => `z${String(index).padStart(3, '0')}.exemplo.com.br`,
      );
      const { account } = await tokenAccount(tenantA, { listed });
      const report = await syncFor().runOnce(NOW);
      expect(report.securitySkippedZones).toBe(3);
      const rows = await rowsOf(account.id);
      expect(rows).toHaveLength(53);
      expect(rows.filter((row) => row.state === 'over_limit').map((row) => row.name)).toEqual(
        listed.slice(SECURITY_MAX_ZONES),
      );
      expect(rows.filter((row) => row.state === 'reading')).toHaveLength(50);
      const { cookie } = await session(tenantA, 'leitura');
      const view = await zonesOf(cookie, account.id);
      expect(view).toMatchObject({ monitored: 'all', limit: 50 });
      expect(view.zones).toHaveLength(53);
    });

    it('a zona nova entra, a que some fica com a data, e a que volta é lida de novo', async () => {
      const { account, tags } = await tokenAccount(tenantA, {
        listed: ['fica.exemplo.com.br', 'some.exemplo.com.br'],
      });
      const sync = syncFor();
      await sync.runOnce(NOW);
      cloudflare.zones.set(account.accountId, ['fica.exemplo.com.br']);
      cloudflare.addSecurityZone(account.accountId, 'nova.exemplo.com.br');
      await sync.runOnce(at(16));
      expect(await statesOf(account.id)).toEqual({
        'fica.exemplo.com.br': 'reading',
        'nova.exemplo.com.br': 'reading',
        'some.exemplo.com.br': 'missing',
      });
      const gone = await prisma.cloudflareZone.findFirstOrThrow({
        where: { cloudAccountId: account.id, zoneId: tags[1] as string },
      });
      expect(gone.missingSince?.getTime()).toBeGreaterThanOrEqual(at(16).getTime());
      expect(gone.lastReadAt).not.toBeNull();

      cloudflare.zones.set(account.accountId, ['fica.exemplo.com.br', 'some.exemplo.com.br']);
      await sync.runOnce(at(31));
      const back = await prisma.cloudflareZone.findUniqueOrThrow({ where: { id: gone.id } });
      expect(back).toMatchObject({ state: 'reading', missingSince: null, firstSeenAt: gone.firstSeenAt });
      expect((await statesOf(account.id))['nova.exemplo.com.br']).toBe('missing');
    });

    it('a falha da origem fica na zona do pedido, some na leitura seguinte, e o 429 não vira erro da zona', async () => {
      const { account } = await tokenAccount(tenantA);
      const sync = syncFor();
      await sync.runOnce(NOW);
      const unavailable = { status: 503 };
      cloudflare.graphqlScript.push({ status: 200, pass: true }, unavailable, unavailable, unavailable);
      await sync.runOnce(at(16));
      const [failed] = await rowsOf(account.id);
      expect(failed).toMatchObject({ state: 'reading', lastErrorCode: 'http_503' });
      await sync.runOnce(at(20));
      expect((await rowsOf(account.id))[0]).toMatchObject({ state: 'reading', lastErrorCode: null });

      cloudflare.graphqlScript.push({ status: 429, headers: { 'retry-after': '60' } });
      await sync.runOnce(at(36));
      expect((await rowsOf(account.id))[0]).toMatchObject({ state: 'reading', lastErrorCode: null });
    });

    it('sem a lista de zonas (403), as que eram lidas dizem o motivo, e nenhuma some', async () => {
      const { account, value } = await tokenAccount(tenantA, {
        listed: ['a.exemplo.com.br', 'b.exemplo.com.br'],
        limits: { 'b.exemplo.com.br': { enabled: false } },
      });
      const sync = syncFor();
      await sync.runOnce(NOW);
      const access = cloudflare.tokens.get(value);
      if (!access) throw new Error('sem acesso');
      access.zoneRead = false;
      await sync.runOnce(at(16));
      expect((await rowsOf(account.id)).map((row) => [row.state, row.lastErrorCode])).toEqual([
        ['reading', 'zones_forbidden'],
        ['not_entitled', null],
      ]);
    });

    it('nada mudou: nada é gravado; a leitura nova é gravada uma vez por janela', async () => {
      const { account } = await tokenAccount(tenantA, {
        listed: ['a.exemplo.com.br', 'b.exemplo.com.br'],
        limits: { 'b.exemplo.com.br': { enabled: false } },
      });
      const version = async () =>
        Object.fromEntries(
          (
            await prisma.$queryRaw<{ name: string; xmin: string }[]>`
              SELECT "name", xmin::text AS "xmin" FROM "CloudflareZone" WHERE "cloudAccountId" = ${account.id}::uuid`
          ).map((row) => [row.name, row.xmin]),
        );
      const sync = syncFor();
      await sync.runOnce(NOW);
      const first = await version();
      // Nenhum fluxo na hora: nada foi lido.
      await sync.runOnce(at(5));
      expect(await version()).toEqual(first);
      await sync.runOnce(at(16));
      const second = await version();
      expect(second['a.exemplo.com.br']).not.toBe(first['a.exemplo.com.br']);
      // A que não é lida não é regravada.
      expect(second['b.exemplo.com.br']).toBe(first['b.exemplo.com.br']);
    });
  });

  describe('à parte da coleta', () => {
    /** Segura a tabela das zonas: toda gravação da saúde espera o lock e desiste. */
    async function withTableLocked<T>(work: () => Promise<T>): Promise<T> {
      const client = new pg.Client({ connectionString: inject('testDatabaseUrl') });
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query('LOCK TABLE "CloudflareZone" IN ACCESS EXCLUSIVE MODE');
        return await work();
      } finally {
        await client.query('ROLLBACK');
        await client.end();
      }
    }

    it('com o banco recusando a saúde, a leitura das contas termina igual, e só o código vai ao log', async () => {
      const first = await tokenAccount(tenantA);
      const second = await tokenAccount(tenantB, { listed: ['outra.exemplo.com.br'] });
      for (const { tags } of [first, second]) {
        cloudflare.addSecurityEvents(tags[0] as string, {
          at: at(-15).toISOString(),
          action: 'block',
          source: 'firewallManaged',
          ip: '203.0.113.9',
          count: 6000,
        });
      }
      // A segunda conta começa a ser lida sem esperar a gravação da saúde da primeira.
      const pending: number[] = [];
      const client = new CloudflareClient({ baseUrl: cloudflare.baseUrl, timeoutMs: 400 });
      const zones = client.zones.bind(client);
      client.zones = (...args) => {
        pending.push(warnings.length);
        return zones(...args);
      };
      const sync = syncFor({ client });
      const started = performance.now();
      const report = await withTableLocked(() => sync.runOnce(NOW));
      // Uma gravação desiste no lock (1 s); as outras da execução nem tentam.
      expect(performance.now() - started).toBeLessThan(20_000);
      expect(report).toMatchObject({ status: 'done', accounts: 2, failedAccounts: 0, securityWindows: 8 });
      expect(report.created).toBeGreaterThan(0);
      expect(pending).toEqual([0, 0]);
      for (const { account, value } of [first, second]) {
        expect(cloudflare.graphqlReads(value, 'events')).toHaveLength(4);
        expect(await securityCursor(account.id)).toMatchObject({
          cursorAt: new Date('2026-11-04T12:15:00.000Z'),
          failures: 0,
          lastErrorKind: null,
        });
        expect(
          await prisma.cloudAccount.findUniqueOrThrow({
            where: { id: account.id },
            select: { connection: true, connectionError: true },
          }),
        ).toEqual({ connection: 'connected', connectionError: null });
        expect(await rowsOf(account.id)).toEqual([]);
      }
      expect(warnings).toHaveLength(1);
      expect(Object.keys(warnings[0] as object).sort()).toEqual(['cloudAccountId', 'code']);
      expect(
        (await prisma.syncState.findFirstOrThrow({ where: { name: `cf-zonas-teste-${run}` } })).lastError,
      ).toBeNull();

      // Com o banco de volta, a leitura seguinte grava.
      await sync.runOnce(at(16));
      expect(await statesOf(first.account.id)).toEqual({ 'loja.exemplo.com.br': 'reading' });
      expect(await statesOf(second.account.id)).toEqual({ 'outra.exemplo.com.br': 'reading' });
    });

    it('a parada do worker no meio não deixa gravação para trás', async () => {
      const { account } = await tokenAccount(tenantA);
      const stop = new AbortController();
      cloudflare.graphqlScript.push({ status: 200, pass: true }, { status: 200, pass: true, delayMs: 200 });
      const running = syncFor().runOnce(NOW, stop.signal);
      setTimeout(() => stop.abort(new Error('parada')), 100);
      await expect(running).rejects.toThrow();
      expect(await rowsOf(account.id)).toEqual([]);
      expect(warnings).toEqual([]);
    });

    it('a conta excluída no meio da execução só deixa o código no log', async () => {
      const { account } = await tokenAccount(tenantA);
      const sync = syncFor();
      const client = new CloudflareClient({ baseUrl: cloudflare.baseUrl, timeoutMs: 400 });
      const zones = client.zones.bind(client);
      client.zones = async (...args) => {
        const found = await zones(...args);
        await prisma.cloudAccount.delete({ where: { id: account.id } });
        return found;
      };
      await expect(syncFor({ client }).runOnce(NOW)).resolves.toMatchObject({ status: 'done' });
      expect(await rowsOf(account.id)).toEqual([]);
      await expect(sync.runOnce(NOW)).resolves.toMatchObject({ accounts: 0 });
    });
  });

  describe('as rotas', () => {
    it('a lista cadastrada vale já: "só as marcadas", "monitorar todas" e a conta desativada', async () => {
      const { account } = await tokenAccount(tenantA, {
        listed: ['a.exemplo.com.br', 'b.exemplo.com.br'],
      });
      const { cookie, token } = await session(tenantA);
      const patch = (body: object) =>
        request(app.getHttpServer())
          .patch(`/v1/cloud-accounts/${account.id}`)
          .set('Cookie', cookie)
          .set('Origin', TEST_WEB_ORIGIN)
          .set('X-CSRF-Token', token)
          .send(body)
          .expect(200);
      const sync = syncFor();
      await sync.runOnce(NOW);
      expect(byName((await zonesOf(cookie, account.id)).zones)).toEqual({
        'a.exemplo.com.br': 'reading',
        'b.exemplo.com.br': 'reading',
      });

      await patch({ zones: ['a.exemplo.com.br'] });
      const listed = await zonesOf(cookie, account.id);
      expect(listed.monitored).toBe('listed');
      expect(byName(listed.zones)).toEqual({
        'a.exemplo.com.br': 'reading',
        'b.exemplo.com.br': 'not_monitored',
      });
      await sync.runOnce(at(16));
      expect(await statesOf(account.id)).toEqual({
        'a.exemplo.com.br': 'reading',
        'b.exemplo.com.br': 'not_monitored',
      });

      // Todas de novo: a que volta espera a próxima leitura.
      await patch({ zones: [] });
      const all = await zonesOf(cookie, account.id);
      expect(all.monitored).toBe('all');
      expect(byName(all.zones)['b.exemplo.com.br']).toBe('pending');
      await sync.runOnce(at(31));
      expect((await statesOf(account.id))['b.exemplo.com.br']).toBe('reading');

      await patch({ status: 'inactive' });
      const inactive = await zonesOf(cookie, account.id);
      expect(inactive.zones.map((zone) => [zone.state, zone.lastErrorCode])).toEqual([
        ['not_monitored', null],
        ['not_monitored', null],
      ]);
      expect(inactive.audit.lastErrorCode).toBeNull();

      await prisma.cloudAccount.delete({ where: { id: account.id } });
      expect(await rowsOf(account.id)).toEqual([]);
    });

    it('a auditoria tem a própria linha: a última leitura e o código do erro', async () => {
      const { account } = await tokenAccount(tenantA);
      const { cookie } = await session(tenantA, 'leitura');
      expect((await zonesOf(cookie, account.id)).audit).toEqual({ lastReadAt: null, lastErrorCode: null });
      await prisma.collectorCursor.updateMany({
        where: { cloudAccountId: account.id, stream: CLOUDFLARE_AUDIT_STREAM },
        data: { lastSuccessAt: at(-5), lastErrorKind: 'http_503' },
      });
      expect((await zonesOf(cookie, account.id)).audit).toEqual({
        lastReadAt: at(-5).toISOString(),
        lastErrorCode: 'http_503',
      });
      // Desativada: a última leitura fica, e o erro antigo deixa de ser aviso.
      await prisma.cloudAccount.update({ where: { id: account.id }, data: { status: 'inactive' } });
      expect((await zonesOf(cookie, account.id)).audit).toEqual({
        lastReadAt: at(-5).toISOString(),
        lastErrorCode: null,
      });
    });

    it('a zona que sumiu aparece como sumida mesmo fora da lista ou com a conta desativada', async () => {
      const { account } = await tokenAccount(tenantA, { listed: ['a.exemplo.com.br'] });
      const { cookie } = await session(tenantA, 'leitura');
      await syncFor().runOnce(NOW);
      await prisma.cloudflareZone.updateMany({
        where: { cloudAccountId: account.id },
        data: { state: 'missing', missingSince: NOW },
      });
      const states = async () => (await zonesOf(cookie, account.id)).zones.map((zone) => zone.state);
      await prisma.cloudAccount.update({
        where: { id: account.id },
        data: { zones: ['outra.exemplo.com.br'] },
      });
      expect(await states()).toEqual(['missing']);
      await prisma.cloudAccount.update({ where: { id: account.id }, data: { status: 'inactive' } });
      expect(await states()).toEqual(['missing']);
    });

    it('a conexão: token colado, OAuth (sem segredo na resposta) e nenhuma, com o OAuth desligado no nó', async () => {
      const { cookie } = await session(tenantA, 'leitura');
      const connection = async (id: string) =>
        (await get(cookie, `/v1/cloud-accounts/${id}/cloudflare-connection`).expect(200)).body as unknown;
      await get(cookie, '/v1/cloudflare-oauth/options').expect(404);

      const { account } = await tokenAccount(tenantA);
      expect(cloudflareConnectionSchema.parse(await connection(account.id))).toEqual({
        method: 'token',
        grant: null,
      });
      const bare = await newAccount(tenantA);
      expect(cloudflareConnectionSchema.parse(await connection(bare.id))).toEqual({
        method: null,
        grant: null,
      });
      const accountId = fakeCloudflare.accountId();
      const grant = await newGrant(tenantA, accountId);
      const oauth = await newAccount(tenantA, { grantId: grant.id, accountId });
      await newAccount(tenantA, { grantId: grant.id });
      const body = await connection(oauth.id);
      expect(cloudflareConnectionSchema.parse(body)).toEqual({
        method: 'oauth',
        grant: {
          status: 'active',
          consentedAt: at(-30).toISOString(),
          lastRefreshAt: at(-10).toISOString(),
          scopes: ['zone.read', 'offline_access'],
          accounts: 2,
        },
      });
      expect(JSON.stringify(body)).not.toContain('ciphertext');
      expect(JSON.stringify(body)).not.toContain(grant.value);
    });

    it('isolamento: o cliente B não vê a conta de A; sem sessão, 401; outro provedor, 400', async () => {
      const { account } = await tokenAccount(tenantA);
      await syncFor().runOnce(NOW);
      const other = await session(tenantB);
      const own = await session(tenantA);
      const aws = await prisma.forTenant(tenantA).cloudAccount.create({
        data: {
          tenantId: tenantA,
          provider: 'aws',
          accountId: String(100_000_000_000 + Math.trunc(Math.random() * 1e9)),
          regions: ['sa-east-1'],
        },
        select: { id: true },
      });
      for (const path of ['cloudflare-zones', 'cloudflare-connection']) {
        await get(other.cookie, `/v1/cloud-accounts/${account.id}/${path}`).expect(404);
        await get(own.cookie, `/v1/cloud-accounts/${randomUUID()}/${path}`).expect(404);
        await get(own.cookie, `/v1/cloud-accounts/nao-e-uuid/${path}`).expect(400);
        await get(own.cookie, `/v1/cloud-accounts/${aws.id}/${path}`).expect(400);
        await request(app.getHttpServer()).get(`/v1/cloud-accounts/${account.id}/${path}`).expect(401);
      }
      expect((await zonesOf(own.cookie, account.id)).zones).toHaveLength(1);
    });
  });
});

describe('o que a leitura viu de cada zona (sem banco)', () => {
  const tag = (index: number) => index.toString(16).padStart(32, '0');
  type Stored = Parameters<ZoneObserver['changes']>[0][number];
  const stored = (index: number, changes: Partial<Stored> = {}): Stored => ({
    zoneId: tag(index),
    name: `z${index}.exemplo.com.br`,
    plan: null,
    state: 'reading',
    lastReadAt: NOW,
    lastErrorCode: null,
    lastSeenAt: NOW,
    missingSince: null,
    ...changes,
  });
  function seen(
    indexes: number[],
    { complete = true, selected = indexes }: { complete?: boolean; selected?: number[] } = {},
  ) {
    const observer = new ZoneObserver();
    observer.listed({
      ids: new Map(indexes.map((index) => [tag(index), `z${index}.exemplo.com.br`])),
      plans: new Map(),
      complete,
      selected: selected.map(tag),
      overLimit: [],
    });
    return observer;
  }
  const summary = (rows: readonly Stored[]) => rows.map((row) => [row.zoneId, row.state, row.lastErrorCode]);

  it('a lista incompleta não prova que uma zona sumiu', () => {
    expect(seen([1], { complete: false }).changes([stored(1), stored(2)], NOW).rows).toEqual([]);
    expect(summary(seen([1]).changes([stored(1), stored(2)], NOW).rows)).toEqual([[tag(2), 'missing', null]]);
  });

  it('a leitura recente e a zona vista há menos de um dia não são regravadas', () => {
    const observer = seen([1]);
    observer.access(tag(1), 'usable');
    observer.read([tag(1)], new Date(NOW.getTime() + ZONE_READ_REFRESH_MS - 1));
    expect(observer.changes([stored(1)], NOW).rows).toEqual([]);
    observer.read([tag(1)], new Date(NOW.getTime() + ZONE_READ_REFRESH_MS));
    expect(observer.changes([stored(1)], NOW).rows).toHaveLength(1);

    const day = new Date(NOW.getTime() + ZONE_SEEN_REFRESH_MS);
    expect(seen([1]).changes([stored(1)], new Date(day.getTime() - 1)).rows).toEqual([]);
    expect(seen([1]).changes([stored(1)], day).rows).toHaveLength(1);
  });

  it('sem chegar a ler (orçamento, limites não consultados), a situação anterior continua', () => {
    const before = [
      stored(1),
      stored(2, { state: 'forbidden' }),
      stored(3, { state: 'not_entitled' }),
      stored(4, { state: 'over_limit' }),
      stored(5, { state: 'pending' }),
    ];
    expect(summary(seen([1, 2, 3, 4, 5]).changes(before, NOW).rows)).toEqual([[tag(4), 'pending', null]]);
    // Os limites disseram que dá para ler, mas nada foi lido ainda.
    const usable = seen([2]);
    usable.access(tag(2), 'usable');
    expect(summary(usable.changes([before[1] as Stored], NOW).rows)).toEqual([[tag(2), 'pending', null]]);
  });

  it('a falha é só das zonas do pedido em curso, e o orçamento esgotado não é falha', () => {
    const observer = seen([1, 2]);
    observer.asking([tag(1)]);
    observer.failed('timeout');
    observer.failed('network');
    expect(summary(observer.changes([stored(1), stored(2)], NOW).rows)).toEqual([
      [tag(1), 'reading', 'timeout'],
    ]);
    const idle = seen([1]);
    idle.asking([tag(1)]);
    idle.idle();
    idle.failed('timeout');
    expect(idle.changes([stored(1)], NOW).rows).toEqual([]);
  });

  it('depois de a janela ser lida e gravada, uma falha seguinte não é daquelas zonas', () => {
    const observer = seen([1]);
    observer.access(tag(1), 'usable');
    observer.asking([tag(1)]);
    observer.read([tag(1)], new Date(NOW.getTime() + ZONE_READ_REFRESH_MS));
    observer.failed('timeout');
    expect(summary(observer.changes([stored(1)], NOW).rows)).toEqual([[tag(1), 'reading', null]]);
  });

  it('o plano da zona é texto de fora: sem caractere de controle, sem sobra e no tamanho da coluna', () => {
    const observer = new ZoneObserver();
    const plans = [' Free\u0000 Website\n\u007f ', '\u0001\u0002', 'p'.repeat(80)];
    observer.listed({
      ids: new Map(plans.map((_, index) => [tag(index), `z${index}.exemplo.com.br`])),
      plans: new Map(plans.map((plan, index) => [tag(index), plan])),
      complete: true,
      selected: plans.map((_, index) => tag(index)),
      overLimit: [],
    });
    expect(observer.changes([], NOW).rows.map((row) => row.plan)).toEqual([
      'Free Website',
      null,
      'p'.repeat(64),
    ]);
  });

  it('o teto de linhas: a zona nova além dele não ganha linha, e as guardadas seguem', () => {
    const before = Array.from({ length: ZONE_HEALTH_MAX_ROWS - 1 }, (_, index) =>
      stored(index, { state: 'missing', missingSince: NOW }),
    );
    const { rows, dropped } = seen([5_001, 5_002, 5_003]).changes(before, NOW);
    expect(rows.map((row) => row.zoneId)).toEqual([tag(5_001)]);
    expect(dropped).toBe(2);
  });

  it('sem nada visto, nada a gravar', () => {
    const observer = new ZoneObserver();
    expect(observer.empty).toBe(true);
    expect(observer.changes([stored(1)], NOW)).toEqual({ rows: [], dropped: 0 });
    observer.failed('rate_limited');
    expect(observer.empty).toBe(true);
  });
});
