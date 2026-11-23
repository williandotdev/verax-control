import 'reflect-metadata';
import { generateKeyPairSync, type KeyObject, randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { CLOUDFLARE_BLOCKING_ERRORS, CLOUDFLARE_OAUTH_RECONNECT_ERROR } from '@verax/shared';
import { openCloudflareOauthTokens, sealCloudflareOauthTokens } from '@verax/vault-envelope';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RESET_CONNECTION } from '../src/cloud-accounts/cloud-accounts.service.js';
import {
  CLOUDFLARE_AUDIT_STREAM,
  CLOUDFLARE_CHECK_STREAM,
  CLOUDFLARE_SECURITY_STREAM,
  CloudflareAuditSync,
  type CloudflareAuditSyncOptions,
} from '../src/cloudflare/cloudflare-audit-sync.js';
import { CloudflareApiError, CloudflareClient } from '../src/cloudflare/cloudflare.client.js';
import { CloudflareTokenCheck } from '../src/cloudflare/cloudflare-token-check.js';
import { CloudflareGrants, GRANT_INTENT_HOLD_MS } from '../src/cloudflare/oauth/cloudflare-grants.js';
import {
  CloudflareOAuthError,
  type CloudflareOAuthTokens,
  PublicClientTokens,
} from '../src/cloudflare/oauth/oauth-tokens.js';
import { decodeState } from '../src/cloudflare/security-events.js';
import { buildPinoOptions } from '../src/common/logger/logger.options.js';
import { scrubString } from '../src/common/logger/sanitize.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import {
  parsePrivateKeys,
  parsePublicKey,
  type VaultKeyring,
  type VaultPublicKey,
} from '../src/credentials/credential-keys.js';
import { CredentialRekey, lockCredential, lockGrant } from '../src/credentials/credential-rekey.js';
import { CloudflareToken, credentialBinding, seal } from '../src/credentials/credential-vault.js';
import { Scheduler } from '../src/worker/scheduler.js';
import { entryFactory, hex } from './cloudflare/fixtures.js';
import { createTenant } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';
import { fakeCloudflare, FakeCloudflareServer, DEFAULT_ZONE_LIMITS } from './support/fake-cloudflare.js';
import { FakeCloudflareOAuthServer, type FakeGrant, oauthToken } from './support/fake-cloudflare-oauth.js';
import { LogCapture } from './support/log-capture.js';

/** Versões da chave do nó neste arquivo: fora das de outros arquivos (2, 3, 900 a 902). */
const KEY_VERSION = 903;
const NEXT_KEY_VERSION = 904;
const NOW = new Date('2026-11-04T12:20:00.000Z');
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const iso = (minutes: number) => at(minutes).toISOString();
const FAR = new Date('2100-01-01T00:00:00.000Z');
const SCOPES = ['account-settings.read', 'analytics.read', 'zone.read', 'offline_access'];
const pem64 = (key: KeyObject, type: 'spki' | 'pkcs8') =>
  Buffer.from(key.export({ type, format: 'pem' })).toString('base64');

interface Account {
  id: string;
  tenantId: string;
  accountId: string;
  provider: 'cloudflare';
}

describe('coletor do Cloudflare por OAuth (banco real, Cloudflare e OAuth falsos)', () => {
  const cloudflare = new FakeCloudflareServer();
  const oauth = new FakeCloudflareOAuthServer(cloudflare);
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let keyring: VaultKeyring;
  let nextKeyring: VaultKeyring;
  let publicKey: VaultPublicKey;
  let otherPublicKey: VaultPublicKey;
  let run = 0;

  const tokensClient = (timeoutMs = 400) => new PublicClientTokens({ tokenUrl: oauth.tokenUrl, timeoutMs });

  const syncFor = (options: CloudflareAuditSyncOptions = {}) => {
    run += 1;
    return new CloudflareAuditSync(prisma, keyring, {
      name: `cf-oauth-teste-${run}`,
      client: new CloudflareClient({ baseUrl: cloudflare.baseUrl, timeoutMs: 400, retryDelaysMs: [10, 10] }),
      tokenCheck: new CloudflareTokenCheck({ baseUrl: cloudflare.baseUrl, timeoutMs: 2_000 }),
      oauthTokens: tokensClient(),
      grants: { saveDelaysMs: [0, 10, 10] },
      tenantIds: [tenantA, tenantB],
      pageSize: 50,
      maxPages: 3,
      securityEvents: false,
      ...options,
    });
  };

  /** Uma concessão gravada como o CF-4 a grava: o envelope dos tokens e a validade. */
  async function newGrant(
    tenantId: string,
    access: Parameters<FakeCloudflareOAuthServer['grant']>[0],
    {
      expiresAt = at(60),
      consentedAt = at(0),
      key = publicKey,
    }: { expiresAt?: Date; consentedAt?: Date; key?: VaultPublicKey } = {},
  ) {
    const fake = oauth.grant(access);
    const id = randomUUID();
    const ciphertext = sealCloudflareOauthTokens(
      key,
      { tenantId, subjectId: id },
      { accessToken: fake.accessToken, refreshToken: fake.refreshToken, accessExpiresAt: expiresAt },
    );
    await prisma.forTenant(tenantId).cloudflareGrant.create({
      data: {
        id,
        tenantId,
        clientId: fake.clientId,
        ciphertext,
        keyVersion: key.version,
        accessExpiresAt: expiresAt,
        scopes: SCOPES,
        consentedAt,
        consentedBy: 'usuario-de-teste',
      },
    });
    return { id, tenantId, fake, ref: { tenantId, grantId: id } };
  }

  async function newAccount(
    tenantId: string,
    grantId: string | null,
    {
      accountId = fakeCloudflare.accountId(),
      zones = [],
      streams = ['audit'],
    }: { accountId?: string; zones?: string[]; streams?: ('audit' | 'check' | 'security')[] } = {},
  ): Promise<Account> {
    const account = await prisma.forTenant(tenantId).cloudAccount.create({
      data: { tenantId, provider: 'cloudflare', accountId, regions: [], zones, cloudflareGrantId: grantId },
      select: { id: true, tenantId: true, accountId: true },
    });
    const names = {
      audit: CLOUDFLARE_AUDIT_STREAM,
      check: CLOUDFLARE_CHECK_STREAM,
      security: CLOUDFLARE_SECURITY_STREAM,
    };
    for (const stream of ['audit', 'check', 'security'] as const) {
      if (streams.includes(stream)) continue;
      await prisma.collectorCursor.create({
        data: { cloudAccountId: account.id, stream: names[stream], nextRunAt: FAR },
      });
    }
    return { ...account, provider: 'cloudflare' };
  }

  /** Uma conta conectada por OAuth que lê a própria auditoria (só a auditoria na hora). */
  async function readyAccount(
    tenantId: string,
    options: {
      expiresAt?: Date;
      consentedAt?: Date;
      zones?: string[];
      streams?: ('audit' | 'check' | 'security')[];
    } = {},
  ) {
    const accountId = fakeCloudflare.accountId();
    const grant = await newGrant(tenantId, { accountId, auditAccounts: [accountId] }, options);
    const account = await newAccount(tenantId, grant.id, { accountId, ...options });
    return { account, grant, entry: entryFactory(accountId) };
  }

  const storeToken = async (account: Account, value: string) => {
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
  };

  const grantRow = (id: string) => prisma.cloudflareGrant.findUniqueOrThrow({ where: { id } });
  const stored = async (grant: { id: string; tenantId: string }, ring = keyring) =>
    openCloudflareOauthTokens(
      ring,
      { tenantId: grant.tenantId, subjectId: grant.id },
      (await grantRow(grant.id)).ciphertext,
    );
  const accountRow = (id: string) =>
    prisma.cloudAccount.findUniqueOrThrow({
      where: { id },
      select: { connection: true, connectionError: true, lastCollectedAt: true },
    });
  const cursorOf = (cloudAccountId: string, stream = CLOUDFLARE_AUDIT_STREAM) =>
    prisma.collectorCursor.findUniqueOrThrow({
      where: { cloudAccountId_stream_region: { cloudAccountId, stream, region: '' } },
    });
  const findingsOf = (accountId: string) =>
    prisma.finding.findMany({ where: { source: 'cloudflare', accountId } });
  const callsWith = (value: string) => cloudflare.callsWith(value).length;
  const suspicious = (entry: ReturnType<typeof entryFactory>, minutes: number, id = `e-${hex(4)}`) => ({
    at: iso(minutes),
    entry: entry({ id, time: iso(minutes), method: 'DELETE', uri: `/zones/${hex(16)}` }),
  });

  beforeAll(async () => {
    await cloudflare.start();
    await oauth.start();
    app = await createApp();
    prisma = app.get(PrismaService);
    const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const next = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const other = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const first = `${KEY_VERSION}:${pem64(pair.privateKey, 'pkcs8')}`;
    keyring = parsePrivateKeys(first, KEY_VERSION);
    nextKeyring = parsePrivateKeys(
      [first, `${NEXT_KEY_VERSION}:${pem64(next.privateKey, 'pkcs8')}`].join('\n'),
      NEXT_KEY_VERSION,
    );
    publicKey = parsePublicKey(pem64(pair.publicKey, 'spki'), KEY_VERSION);
    otherPublicKey = parsePublicKey(pem64(other.publicKey, 'spki'), KEY_VERSION);
  });

  beforeEach(async () => {
    oauth.reset();
    cloudflare.auditScript.length = 0;
    cloudflare.graphqlScript.length = 0;
    tenantA = await createTenant(app, 'Cliente Demo A (Cloudflare OAuth)');
    tenantB = await createTenant(app, 'Cliente Demo B (Cloudflare OAuth)');
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await prisma.cloudCredential.deleteMany({ where: { keyVersion: KEY_VERSION } });
    await prisma.cloudAccount.updateMany({
      where: { cloudflareGrant: { keyVersion: { in: [KEY_VERSION, NEXT_KEY_VERSION] } } },
      data: { cloudflareGrantId: null },
    });
    await prisma.cloudflareGrant.deleteMany({
      where: { keyVersion: { in: [KEY_VERSION, NEXT_KEY_VERSION] } },
    });
    await app.close();
    await cloudflare.stop();
    await oauth.stop();
  });

  describe('leitura com o acesso da concessão', () => {
    it('lê a auditoria, grava o achado e conecta a conta, sem renovar o acesso que ainda vale', async () => {
      const { account, grant, entry } = await readyAccount(tenantA);
      cloudflare.addAudit(account.accountId, suspicious(entry, -50));
      const before = await grantRow(grant.id);
      const report = await syncFor().runOnce(NOW);
      expect(report).toMatchObject({
        accounts: 1,
        created: 1,
        failedAccounts: 0,
        blocked: 0,
        grantsRenewed: 0,
        grantsFailed: 0,
        grantsAppRejected: 0,
      });
      expect(await findingsOf(account.accountId)).toHaveLength(1);
      expect(await accountRow(account.id)).toEqual({
        connection: 'connected',
        connectionError: null,
        lastCollectedAt: NOW,
      });
      expect(oauth.requests).toHaveLength(0);
      expect(await grantRow(grant.id)).toEqual(before);
    });

    it('a conferência de hora em hora é só a leitura de prova, sem o verify do token', async () => {
      const { account, grant } = await readyAccount(tenantA, {
        streams: ['check'],
        zones: ['a.exemplo.com.br'],
      });
      cloudflare.zones.set(account.accountId, ['a.exemplo.com.br']);
      await syncFor().runOnce(NOW);
      const calls = cloudflare.callsWith(grant.fake.accessToken);
      expect(calls.map((call) => call.path)).toEqual([`/accounts/${account.accountId}/logs/audit`, '/zones']);
      expect(calls[0]?.query.get('limit')).toBe('1');
      expect((await cursorOf(account.id, CLOUDFLARE_CHECK_STREAM)).nextRunAt).toEqual(at(60));

      // Uma zona que não existe deixa a conexão em erro, como no token colado.
      await prisma.cloudAccount.update({
        where: { id: account.id },
        data: { zones: ['outra.exemplo.com.br'] },
      });
      await syncFor().runOnce(at(61));
      expect(await accountRow(account.id)).toMatchObject({ connectionError: 'zone_not_found' });
    });

    it('403 na auditoria para só aquela conta, e a concessão continua valendo para as outras', async () => {
      const grant = await newGrant(tenantA, { auditAccounts: [] });
      const denied = await newAccount(tenantA, grant.id);
      const allowed = await newAccount(tenantA, grant.id);
      grant.fake.access.auditAccounts = [allowed.accountId];
      const report = await syncFor().runOnce(NOW);
      expect(report).toMatchObject({ accounts: 2, blocked: 0, failedAccounts: 1 });
      expect(await accountRow(denied.id)).toMatchObject({ connectionError: 'credential_forbidden' });
      expect(await accountRow(allowed.id)).toMatchObject({ connection: 'connected' });
      expect((await grantRow(grant.id)).status).toBe('active');
      expect(oauth.requests).toHaveLength(0);
    });

    it('isolamento: a conta do cliente A nunca abre a concessão do cliente B', async () => {
      const { grant } = await readyAccount(tenantB);
      const grants = new CloudflareGrants(prisma, keyring, tokensClient());
      const other = await grants.open({ tenantId: tenantA, grantId: grant.id }, () => NOW);
      expect(other).toEqual({ kind: 'gone' });
      await grants.reject({ tenantId: tenantA, grantId: grant.id }, 1, 'credential_rejected');
      expect((await grantRow(grant.id)).status).toBe('active');
    });

    it('envelope que não abre: nenhuma chamada, e a conexão diz que a autorização não abriu', async () => {
      const accountId = fakeCloudflare.accountId();
      const grant = await newGrant(tenantA, { auditAccounts: [accountId] }, { key: otherPublicKey });
      const account = await newAccount(tenantA, grant.id, { accountId });
      const report = await syncFor().runOnce(NOW);
      expect(report).toMatchObject({ unreadable: 1, pages: 0 });
      expect(await accountRow(account.id)).toMatchObject({ connectionError: 'oauth_unreadable' });
      expect(callsWith(grant.fake.accessToken)).toBe(0);
      expect(oauth.requests).toHaveLength(0);
    });

    it('concessão em revogação: a conta não é lida nem marcada', async () => {
      const { account, grant } = await readyAccount(tenantA, { expiresAt: at(-5), consentedAt: at(-65) });
      await prisma.cloudflareGrant.update({
        where: { id: grant.id },
        data: { status: 'revoking', revokeRequestedAt: NOW },
      });
      await syncFor().runOnce(NOW);
      expect(oauth.requests).toHaveLength(0);
      expect(callsWith(grant.fake.accessToken)).toBe(0);
      expect(await accountRow(account.id)).toMatchObject({ connection: 'waiting', connectionError: null });
    });
  });

  describe('renovação', () => {
    it.each([
      ['com a troca do token de renovação', true],
      ['sem a troca', false],
    ])(
      'perto de vencer, renova antes de ler e só usa o acesso novo depois de gravado (%s)',
      async (_, rotate) => {
        oauth.rotate = rotate;
        const { account, grant, entry } = await readyAccount(tenantA, {
          expiresAt: at(5),
          consentedAt: at(-55),
        });
        const old = { access: grant.fake.accessToken, refresh: grant.fake.refreshToken };
        cloudflare.addAudit(account.accountId, suspicious(entry, -50));
        let generationAtFirstRead: number | null = null;
        const client = new CloudflareClient({
          baseUrl: cloudflare.baseUrl,
          timeoutMs: 400,
          retryDelaysMs: [],
        });
        const auditPage = client.auditPage.bind(client);
        vi.spyOn(client, 'auditPage').mockImplementation(async (...args) => {
          generationAtFirstRead ??= (await grantRow(grant.id)).generation;
          return auditPage(...args);
        });
        const report = await syncFor({ client }).runOnce(NOW);
        expect(report).toMatchObject({ created: 1, grantsRenewed: 1, failedAccounts: 0 });
        // O acesso antigo não fez nenhum pedido, e o novo só depois de a geração nova estar gravada.
        expect(callsWith(old.access)).toBe(0);
        expect(generationAtFirstRead).toBe(2);

        expect(oauth.requests).toHaveLength(1);
        const [request] = oauth.requests;
        expect(Object.fromEntries(request ?? [])).toEqual({
          grant_type: 'refresh_token',
          refresh_token: old.refresh,
          client_id: grant.fake.clientId,
        });
        const row = await grantRow(grant.id);
        expect(row).toMatchObject({
          generation: 2,
          refreshStartedAt: null,
          lastErrorKind: null,
          status: 'active',
          keyVersion: KEY_VERSION,
        });
        expect(row.lastRefreshAt?.getTime()).toBeGreaterThanOrEqual(NOW.getTime());
        const tokens = await stored(grant);
        expect(tokens.accessToken).toBe(grant.fake.accessToken);
        expect(tokens.refreshToken).toBe(grant.fake.refreshToken);
        expect(tokens.refreshToken === old.refresh).toBe(!rotate);
        // A validade é a da resposta, contada de antes do pedido.
        expect(row.accessExpiresAt).toEqual(tokens.accessExpiresAt);
        expect(Math.abs(row.accessExpiresAt.getTime() - at(60).getTime())).toBeLessThan(10_000);
        // A vez seguinte lê com o mesmo acesso, sem renovar de novo.
        await syncFor().runOnce(at(6));
        expect(oauth.requests).toHaveLength(1);
        expect((await accountRow(account.id)).connection).toBe('connected');
      },
    );

    it('um acesso curto renova com um quinto do prazo, e não com dez minutos', async () => {
      // 20 min de prazo: renova faltando 4, não 10.
      const { grant } = await readyAccount(tenantA, { expiresAt: at(8), consentedAt: at(-12) });
      await syncFor().runOnce(NOW);
      expect(oauth.requests).toHaveLength(0);
      const short = await readyAccount(tenantB, { expiresAt: at(3), consentedAt: at(-17) });
      await syncFor().runOnce(NOW);
      expect(oauth.requests.map((request) => request.get('refresh_token'))).not.toContain(
        grant.fake.refreshToken,
      );
      expect((await grantRow(short.grant.id)).generation).toBe(2);
    });

    it('as contas da mesma concessão renovam uma vez só', async () => {
      const grant = await newGrant(tenantA, {}, { expiresAt: at(-1), consentedAt: at(-61) });
      const accounts = [await newAccount(tenantA, grant.id), await newAccount(tenantA, grant.id)];
      grant.fake.access.auditAccounts = accounts.map(({ accountId }) => accountId);
      const report = await syncFor().runOnce(NOW);
      expect(report).toMatchObject({ accounts: 2, grantsRenewed: 1, failedAccounts: 0 });
      expect(oauth.requests).toHaveLength(1);
    });

    it('a resposta sem a validade (ou com uma inválida) não perde o token novo: vale por pouco tempo', async () => {
      for (const expiresIn of [undefined, 'uma hora', 0, -5]) {
        oauth.expiresIn = expiresIn;
        const { grant } = await readyAccount(tenantA, { expiresAt: at(-1), consentedAt: at(-61) });
        await syncFor().runOnce(NOW);
        const row = await grantRow(grant.id);
        expect(row.generation).toBe(2);
        expect((await stored(grant)).refreshToken).toBe(grant.fake.refreshToken);
        expect(row.accessExpiresAt.getTime()).toBeLessThanOrEqual(at(11).getTime());
      }
    });

    it.each([
      ['5xx', { status: 503 }, 'http_503', true],
      ['sem resposta', { hang: true }, 'timeout', true],
      ['conexão fechada', { dropBefore: true }, 'network', true],
      ['limite de requisições', { status: 429, headers: { 'retry-after': '120' } }, 'rate_limited', false],
      ['fora do formato', { status: 200, body: '{"access_token":1}' }, 'bad_response', true],
      ['página de bloqueio', { status: 403, body: '<html>bloqueado</html>' }, 'http_403', false],
      ['401 sem explicação', { status: 401, body: 'não' }, 'http_401', false],
      ['resposta enorme', { status: 200, body: 'x'.repeat(70 * 1024) }, 'response_too_large', true],
    ])(
      '%s: com o acesso ainda válido, a leitura segue; vencido, espera',
      async (_, reply, code, ambiguous) => {
        const valid = await readyAccount(tenantA, { expiresAt: at(5), consentedAt: at(-55) });
        oauth.script.push(reply);
        const sync = syncFor();
        const report = await sync.runOnce(NOW);
        expect(report).toMatchObject({ failedAccounts: 0, grantsFailed: 1, grantsRenewed: 0, pages: 1 });
        expect(await accountRow(valid.account.id)).toMatchObject({ connection: 'connected' });
        const row = await grantRow(valid.grant.id);
        expect(row).toMatchObject({ generation: 1, status: 'active', lastErrorKind: code });
        // A resposta em dúvida deixa a intenção gravada; a recusa clara, não.
        expect(row.refreshStartedAt !== null).toBe(ambiguous);

        // O acesso vence e o Cloudflare continua sem renovar: nenhuma chamada à API, e a coleta espera sem parar.
        const calls = callsWith(valid.grant.fake.accessToken);
        oauth.script.push(reply);
        const later = await sync.runOnce(at(10));
        expect(later).toMatchObject({ failedAccounts: 1, blocked: 0, pages: 0 });
        expect(callsWith(valid.grant.fake.accessToken)).toBe(calls);
        expect(await accountRow(valid.account.id)).toMatchObject({
          connection: 'error',
          connectionError: 'oauth_refresh_unavailable',
        });
        const cursor = await cursorOf(valid.account.id);
        expect(cursor.failures).toBe(0);
        expect(cursor.nextRunAt.getTime()).toBeGreaterThan(at(10).getTime());

        // Volta sozinha, sem perder nada.
        const back = await sync.runOnce(at(40));
        expect(back).toMatchObject({ failedAccounts: 0, grantsRenewed: 1, pages: 1 });
        expect(await accountRow(valid.account.id)).toMatchObject({
          connection: 'connected',
          connectionError: null,
        });
      },
    );

    it('a espera entre as tentativas dobra e respeita o retry-after', async () => {
      await readyAccount(tenantA, { expiresAt: at(-1), consentedAt: at(-61) });
      const sync = syncFor();
      const refreshes = () => oauth.requests.length;
      oauth.script.push({ status: 503 }, { status: 503 }, { status: 429, headers: { 'retry-after': '600' } });
      await sync.runOnce(NOW);
      expect(refreshes()).toBe(1);
      await sync.runOnce(at(0.5));
      expect(refreshes()).toBe(1);
      await sync.runOnce(at(2));
      expect(refreshes()).toBe(2);
      await sync.runOnce(at(3));
      expect(refreshes()).toBe(2);
      await sync.runOnce(at(5));
      expect(refreshes()).toBe(3);
      await sync.runOnce(at(14));
      expect(refreshes()).toBe(3);
      await sync.runOnce(at(16));
      expect(refreshes()).toBe(4);
    });

    it('invalid_grant: a concessão espera o cliente, todas as contas dela param e nada mais é chamado', async () => {
      const grant = await newGrant(tenantA, {}, { expiresAt: at(5), consentedAt: at(-55) });
      const accounts = [await newAccount(tenantA, grant.id), await newAccount(tenantA, grant.id)];
      oauth.revoke(grant.fake);
      const sync = syncFor();
      const report = await sync.runOnce(NOW);
      expect(report).toMatchObject({ blocked: 2, failedAccounts: 0, pages: 0 });
      expect(await grantRow(grant.id)).toMatchObject({
        status: 'reconnect',
        lastErrorKind: 'invalid_grant',
        refreshStartedAt: null,
        generation: 1,
      });
      for (const account of accounts) {
        expect(await accountRow(account.id)).toMatchObject({
          connection: 'error',
          connectionError: CLOUDFLARE_OAUTH_RECONNECT_ERROR,
        });
      }
      expect(CLOUDFLARE_BLOCKING_ERRORS).toContain(CLOUDFLARE_OAUTH_RECONNECT_ERROR);
      const calls = cloudflare.requests.length;
      expect(await sync.runOnce(at(30))).toMatchObject({ blocked: 2 });
      expect(await syncFor().runOnce(at(60))).toMatchObject({ blocked: 2 });
      expect(oauth.requests).toHaveLength(1);
      expect(cloudflare.requests).toHaveLength(calls);
    });

    it.each(['invalid_client', 'unauthorized_client', 'invalid_scope', 'invalid_request'])(
      '%s: é do app da Verax; não para a coleta nem pede reconexão, e espera uma hora',
      async (code) => {
        const { account, grant } = await readyAccount(tenantA, { expiresAt: at(5), consentedAt: at(-55) });
        const reply = {
          status: code === 'invalid_client' ? 401 : 400,
          body: JSON.stringify({ error: code }),
        };
        oauth.script.push(reply, reply);
        const sync = syncFor();
        expect(await sync.runOnce(NOW)).toMatchObject({ grantsAppRejected: 1, pages: 1, blocked: 0 });
        expect(await accountRow(account.id)).toMatchObject({ connection: 'connected' });
        expect(await grantRow(grant.id)).toMatchObject({ status: 'active', lastErrorKind: code });
        // Vencido, dentro da hora: nenhuma tentativa nova, e a conta diz o motivo sem parar a coleta.
        expect(await sync.runOnce(at(20))).toMatchObject({ failedAccounts: 1, blocked: 0, pages: 0 });
        expect(oauth.requests).toHaveLength(1);
        const state = await accountRow(account.id);
        expect(state).toMatchObject({ connection: 'error', connectionError: 'oauth_client_rejected' });
        expect(CLOUDFLARE_BLOCKING_ERRORS).not.toContain(state.connectionError);
        const retryAt = (await cursorOf(account.id)).nextRunAt.getTime();
        expect(retryAt).toBeGreaterThanOrEqual(at(60).getTime());
        expect(retryAt).toBeLessThan(at(60.5).getTime());
        await sync.runOnce(at(61));
        expect(oauth.requests).toHaveLength(2);
        expect(await sync.runOnce(at(125))).toMatchObject({ grantsRenewed: 1, pages: 1 });
      },
    );

    it('uma renovação que amplia os escopos não é guardada nem usada: pede a reconexão', async () => {
      oauth.scope = 'account-settings.read analytics.read zone.read zone.write';
      const { account, grant } = await readyAccount(tenantA, { expiresAt: at(-1), consentedAt: at(-61) });
      const before = await grantRow(grant.id);
      await syncFor().runOnce(NOW);
      const row = await grantRow(grant.id);
      expect(row).toMatchObject({ status: 'reconnect', lastErrorKind: 'oauth_scope_unexpected' });
      expect(row.ciphertext).toBe(before.ciphertext);
      expect(callsWith(grant.fake.accessToken)).toBe(0);
      expect(await accountRow(account.id)).toMatchObject({
        connectionError: CLOUDFLARE_OAUTH_RECONNECT_ERROR,
      });
    });

    it('os escopos repetidos na resposta, sem o da renovação, são aceitos', async () => {
      oauth.scope = 'zone.read analytics.read account-settings.read';
      const { grant } = await readyAccount(tenantA, { expiresAt: at(-1), consentedAt: at(-61) });
      await syncFor().runOnce(NOW);
      expect(await grantRow(grant.id)).toMatchObject({ status: 'active', generation: 2 });
    });
  });

  describe('acesso recusado pela API (401)', () => {
    it('renova uma vez, repete o pedido e segue: a conta não vê o erro', async () => {
      const { account, grant, entry } = await readyAccount(tenantA);
      cloudflare.addAudit(account.accountId, suspicious(entry, -50));
      cloudflare.tokens.delete(grant.fake.accessToken);
      const report = await syncFor().runOnce(NOW);
      expect(report).toMatchObject({ created: 1, blocked: 0, failedAccounts: 0, grantsRenewed: 1 });
      expect(oauth.requests).toHaveLength(1);
      expect(await grantRow(grant.id)).toMatchObject({ status: 'active', generation: 2 });
      expect(await accountRow(account.id)).toMatchObject({ connection: 'connected', connectionError: null });
    });

    it('recusado de novo depois de renovar: para a coleta e pede a reconexão, sem laço', async () => {
      const { account, grant } = await readyAccount(tenantA);
      cloudflare.auditScript.push({ status: 401 }, { status: 401 });
      const report = await syncFor().runOnce(NOW);
      expect(report).toMatchObject({ failedAccounts: 1, grantsRenewed: 1 });
      expect(oauth.requests).toHaveLength(1);
      expect(await grantRow(grant.id)).toMatchObject({
        status: 'reconnect',
        lastErrorKind: 'credential_rejected',
      });
      expect(await accountRow(account.id)).toMatchObject({
        connectionError: CLOUDFLARE_OAUTH_RECONNECT_ERROR,
      });
    });

    it('recusado e sem como renovar agora: espera, sem parar a coleta nem pedir a reconexão', async () => {
      const { account, grant } = await readyAccount(tenantA);
      cloudflare.auditScript.push({ status: 401 });
      oauth.script.push({ status: 503 });
      expect(await syncFor().runOnce(NOW)).toMatchObject({ blocked: 0, failedAccounts: 1, grantsFailed: 1 });
      expect(await grantRow(grant.id)).toMatchObject({ status: 'active', generation: 1 });
      expect(await accountRow(account.id)).toMatchObject({ connectionError: 'oauth_refresh_unavailable' });
      expect((await cursorOf(account.id)).failures).toBe(1);
    });

    it('nos eventos de segurança, o novo envio também gasta o orçamento', async () => {
      const { account, grant } = await readyAccount(tenantA, { streams: ['security'] });
      const tag = cloudflare.addSecurityZone(account.accountId, 'loja.exemplo.com.br');
      grant.fake.access.analyticsZones = [tag];
      cloudflare.graphqlScript.push({ status: 401 });
      const report = await syncFor({ securityEvents: { firstReadMs: 15 * 60_000 } }).runOnce(NOW);
      expect(report).toMatchObject({ securityWindows: 1, grantsRenewed: 1, blocked: 0, failedAccounts: 0 });
      // Os limites (recusado e repetido) e os eventos: três consultas.
      expect(report.securityQueries).toBe(3);
    });

    it('o acesso já renovado por outra leitura é usado sem renovar de novo', async () => {
      const { grant } = await readyAccount(tenantA);
      const grants = new CloudflareGrants(prisma, keyring, tokensClient());
      const first = await grants.open(grant.ref, () => NOW);
      const second = await grants.open(grant.ref, () => NOW);
      if (first.kind !== 'ready' || second.kind !== 'ready') throw new Error('acesso esperado');
      expect(await first.bearer.renew()).toBe('renewed');
      expect(await second.bearer.renew()).toBe('renewed');
      expect(oauth.requests).toHaveLength(1);
      expect(second.bearer.value()).toBe(first.bearer.value());
      expect(second.bearer.generation).toBe(2);
      // Uma vez por leitura.
      expect(await second.bearer.renew()).toBe('rejected');
      expect(oauth.requests).toHaveLength(1);
    });
  });

  describe('quedas no meio da renovação', () => {
    it('antes de o Cloudflare processar: a tentativa seguinte, com o mesmo token, dá certo', async () => {
      const { grant } = await readyAccount(tenantA, { expiresAt: at(-1), consentedAt: at(-61) });
      oauth.script.push({ dropBefore: true });
      await syncFor().runOnce(NOW);
      expect((await grantRow(grant.id)).refreshStartedAt).not.toBeNull();
      // Outro worker (o processo caiu): a intenção antiga não o impede.
      expect(await syncFor().runOnce(at(2))).toMatchObject({ grantsRenewed: 1, pages: 1 });
      expect(await grantRow(grant.id)).toMatchObject({ generation: 2, refreshStartedAt: null });
    });

    it('depois de o Cloudflare trocar o token e sem a resposta: uma tentativa, e pede a reconexão', async () => {
      const { account, grant } = await readyAccount(tenantA, { expiresAt: at(-1), consentedAt: at(-61) });
      oauth.script.push({ dropAfter: true });
      await syncFor().runOnce(NOW);
      expect(await grantRow(grant.id)).toMatchObject({ status: 'active', lastErrorKind: 'network' });
      await syncFor().runOnce(at(2));
      expect(oauth.requests).toHaveLength(2);
      expect(await grantRow(grant.id)).toMatchObject({ status: 'reconnect', lastErrorKind: 'invalid_grant' });
      expect(await accountRow(account.id)).toMatchObject({
        connectionError: CLOUDFLARE_OAUTH_RECONNECT_ERROR,
      });
    });

    it('sem a troca a cada uso, a mesma queda se resolve sozinha', async () => {
      oauth.rotate = false;
      const { grant } = await readyAccount(tenantA, { expiresAt: at(-1), consentedAt: at(-61) });
      oauth.script.push({ dropAfter: true });
      await syncFor().runOnce(NOW);
      expect(await syncFor().runOnce(at(2))).toMatchObject({ grantsRenewed: 1, pages: 1 });
      expect(await grantRow(grant.id)).toMatchObject({ status: 'active', generation: 2 });
    });

    it('uma intenção recente de outro worker não deixa usar o mesmo token de renovação ao mesmo tempo', async () => {
      const { account, grant } = await readyAccount(tenantA, { expiresAt: at(-1), consentedAt: at(-61) });
      await prisma.cloudflareGrant.update({
        where: { id: grant.id },
        data: { refreshStartedAt: new Date(NOW.getTime() - 5_000) },
      });
      expect(await syncFor().runOnce(NOW)).toMatchObject({ failedAccounts: 1, pages: 0 });
      expect(oauth.requests).toHaveLength(0);
      expect(await accountRow(account.id)).toMatchObject({ connectionError: 'oauth_refresh_unavailable' });
      const later = new Date(NOW.getTime() + GRANT_INTENT_HOLD_MS + 1_000);
      expect(await syncFor().runOnce(later)).toMatchObject({ grantsRenewed: 1, pages: 1 });
    });

    it('a parada do worker no meio do pedido não perde o token novo', async () => {
      const { grant } = await readyAccount(tenantA, { expiresAt: at(-1), consentedAt: at(-61) });
      oauth.script.push({ delayMs: 250 });
      const controller = new AbortController();
      oauth.beforeReply = () => controller.abort(new DOMException('o worker está parando', 'AbortError'));
      await expect(syncFor().runOnce(NOW, controller.signal)).rejects.toThrow();
      expect(await grantRow(grant.id)).toMatchObject({ generation: 2, refreshStartedAt: null });
      expect(await stored(grant)).toMatchObject({
        accessToken: grant.fake.accessToken,
        refreshToken: grant.fake.refreshToken,
      });
    });

    it('a parada do worker espera a gravação terminar (agendador de verdade)', async () => {
      const { grant } = await readyAccount(tenantA, { expiresAt: at(-1), consentedAt: at(-61) });
      let asked: () => void = () => undefined;
      const received = new Promise<void>((resolve) => {
        asked = resolve;
      });
      oauth.script.push({ delayMs: 300 });
      oauth.beforeReply = () => asked();
      const sync = syncFor();
      const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
      const scheduler = new Scheduler(
        [
          {
            name: 'cloudflare',
            intervalMs: 60_000,
            budgetMs: 60_000,
            run: (signal) => sync.runOnce(NOW, signal),
          },
        ],
        log,
      );
      scheduler.start();
      await received;
      await scheduler.stop();
      expect(await stored(grant)).toMatchObject({ refreshToken: grant.fake.refreshToken });
    });

    it('banco fora na gravação: tenta de novo na mesma execução', async () => {
      const { account, grant } = await readyAccount(tenantA, { expiresAt: at(-1), consentedAt: at(-61) });
      const transaction = prisma.$transaction.bind(prisma);
      let failures = 0;
      const spy = vi.spyOn(prisma, '$transaction');
      oauth.beforeReply = () => {
        spy.mockImplementation((...args: Parameters<typeof transaction>) => {
          if (failures < 2) {
            failures += 1;
            return Promise.reject(new Error('banco fora'));
          }
          return transaction(...args);
        });
      };
      try {
        expect(await syncFor().runOnce(NOW)).toMatchObject({ grantsRenewed: 1, pages: 1 });
      } finally {
        spy.mockRestore();
      }
      expect(failures).toBe(2);
      expect((await stored(grant)).refreshToken).toBe(grant.fake.refreshToken);
      expect(await accountRow(account.id)).toMatchObject({ connection: 'connected' });
    });

    it('banco fora por mais tempo: o token novo fica na memória e é gravado antes de qualquer outra coisa', async () => {
      const { account, grant } = await readyAccount(tenantA, { expiresAt: at(-1), consentedAt: at(-61) });
      const spy = vi.spyOn(prisma, '$transaction');
      oauth.beforeReply = () => {
        spy.mockImplementation(() => Promise.reject(new Error('banco fora')));
      };
      const sync = syncFor();
      let report;
      try {
        report = await sync.runOnce(NOW);
      } finally {
        spy.mockRestore();
      }
      // Nada foi lido com um acesso que não está gravado.
      expect(report).toMatchObject({ failedAccounts: 1, pages: 0 });
      expect(callsWith(grant.fake.accessToken)).toBe(0);
      expect(await grantRow(grant.id)).toMatchObject({ generation: 1 });

      oauth.beforeReply = undefined;
      expect(await sync.runOnce(at(1))).toMatchObject({ grantsRenewed: 1, pages: 1, failedAccounts: 0 });
      expect(oauth.requests).toHaveLength(1);
      expect(await grantRow(grant.id)).toMatchObject({ generation: 2, refreshStartedAt: null });
      expect((await stored(grant)).refreshToken).toBe(grant.fake.refreshToken);
      expect(await accountRow(account.id)).toMatchObject({ connection: 'connected' });
    });

    it('por gravar e já sem conta: ainda assim é gravado (a revogação precisa do token atual)', async () => {
      const { account, grant } = await readyAccount(tenantA, { expiresAt: at(-1), consentedAt: at(-61) });
      const spy = vi.spyOn(prisma, '$transaction');
      oauth.beforeReply = () => {
        spy.mockImplementation(() => Promise.reject(new Error('banco fora')));
      };
      const sync = syncFor();
      try {
        await sync.runOnce(NOW);
      } finally {
        spy.mockRestore();
      }
      await prisma.cloudAccount.delete({ where: { id: account.id } });
      await prisma.cloudflareGrant.update({
        where: { id: grant.id },
        data: { status: 'revoking', revokeRequestedAt: NOW },
      });
      await sync.runOnce(at(1));
      expect(await grantRow(grant.id)).toMatchObject({ generation: 2, status: 'revoking' });
      expect((await stored(grant)).refreshToken).toBe(grant.fake.refreshToken);
    });
  });

  describe('concorrência', () => {
    it('invalid_grant do token que outro worker acabou de trocar não pede a reconexão', async () => {
      const { grant } = await readyAccount(tenantA, { expiresAt: at(-1), consentedAt: at(-61) });
      const renewed = { accessToken: oauthToken(), refreshToken: oauthToken(), accessExpiresAt: at(60) };
      cloudflare.tokens.set(renewed.accessToken, grant.fake.access);
      const racing: CloudflareOAuthTokens = {
        refresh: async () => {
          await prisma.cloudflareGrant.update({
            where: { id: grant.id },
            data: {
              ciphertext: sealCloudflareOauthTokens(
                publicKey,
                { tenantId: tenantA, subjectId: grant.id },
                renewed,
              ),
              accessExpiresAt: renewed.accessExpiresAt,
              generation: 2,
            },
          });
          throw new CloudflareOAuthError('grant_rejected', 'invalid_grant', false);
        },
      };
      expect(await syncFor({ oauthTokens: racing }).runOnce(NOW)).toMatchObject({ pages: 1, blocked: 0 });
      expect(await grantRow(grant.id)).toMatchObject({ status: 'active', generation: 2 });
      expect(callsWith(renewed.accessToken)).toBe(1);
    });

    it('a renovação que chega depois de uma reconexão é descartada', async () => {
      const { account, grant } = await readyAccount(tenantA, { expiresAt: at(-1), consentedAt: at(-61) });
      const fresh = { accessToken: oauthToken(), refreshToken: oauthToken(), accessExpiresAt: at(60) };
      cloudflare.tokens.set(fresh.accessToken, grant.fake.access);
      oauth.beforeReply = async () => {
        await prisma.cloudflareGrant.update({
          where: { id: grant.id },
          data: {
            ciphertext: sealCloudflareOauthTokens(
              publicKey,
              { tenantId: tenantA, subjectId: grant.id },
              fresh,
            ),
            accessExpiresAt: fresh.accessExpiresAt,
            consentedAt: at(1),
            generation: 5,
          },
        });
      };
      await syncFor().runOnce(NOW);
      expect(await stored(grant)).toMatchObject({ refreshToken: fresh.refreshToken });
      expect((await grantRow(grant.id)).generation).toBe(5);
      // Vale o que está gravado: a leitura usa o acesso da autorização nova, e o que chegou atrasado não é usado.
      expect(callsWith(fresh.accessToken)).toBe(1);
      expect(callsWith(grant.fake.accessToken)).toBe(0);
      expect(await accountRow(account.id)).toMatchObject({ connection: 'connected' });
    });

    it('com a recifragem no meio: o envelope novo prevalece, e a renovação seguinte usa a chave corrente', async () => {
      const { grant } = await readyAccount(tenantA, { expiresAt: at(-1), consentedAt: at(-61) });
      const rekey = new CredentialRekey(prisma, nextKeyring);
      oauth.beforeReply = async () => {
        // As linhas de outros arquivos de teste contam como falha (não abrem aqui), mas a desta recifra.
        await rekey.runOnce();
        expect((await grantRow(grant.id)).keyVersion).toBe(NEXT_KEY_VERSION);
      };
      run += 1;
      const sync = new CloudflareAuditSync(prisma, nextKeyring, {
        name: `cf-oauth-teste-${run}`,
        client: new CloudflareClient({ baseUrl: cloudflare.baseUrl, timeoutMs: 400, retryDelaysMs: [] }),
        oauthTokens: tokensClient(2_000),
        tenantIds: [tenantA],
        securityEvents: false,
      });
      expect(await sync.runOnce(NOW)).toMatchObject({ grantsRenewed: 1, pages: 1 });
      expect(await grantRow(grant.id)).toMatchObject({ generation: 2, keyVersion: NEXT_KEY_VERSION });
      expect((await stored(grant, nextKeyring)).refreshToken).toBe(grant.fake.refreshToken);
    });

    it('a gravação espera o lock da concessão de quem já o tem', async () => {
      const { grant } = await readyAccount(tenantA, { expiresAt: at(-1), consentedAt: at(-61) });
      let generationWhileHeld: number | undefined;
      let holder: Promise<unknown> = Promise.resolve();
      oauth.beforeReply = async () => {
        let locked: () => void = () => undefined;
        const held = new Promise<void>((resolve) => {
          locked = resolve;
        });
        // Só o lock, sem escrever na linha: o que faz esperar é ele.
        holder = prisma.$transaction(async (tx) => {
          await lockGrant(tx, grant.id);
          locked();
          await new Promise((resolve) => setTimeout(resolve, 300));
          generationWhileHeld = (await grantRow(grant.id)).generation;
        });
        await held;
      };
      expect(await syncFor({ oauthTokens: tokensClient(3_000) }).runOnce(NOW)).toMatchObject({ pages: 1 });
      await holder;
      expect(generationWhileHeld).toBe(1);
      expect((await grantRow(grant.id)).generation).toBe(2);
    });

    it('com a exclusão da conta ao mesmo tempo: sem deadlock, e o token novo fica na concessão', async () => {
      const { account, grant } = await readyAccount(tenantA, { expiresAt: at(-1), consentedAt: at(-61) });
      let deletion: Promise<unknown> = Promise.resolve();
      let holding: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        holding = resolve;
      });
      oauth.beforeReply = async () => {
        // A ordem do CF-4: o lock da credencial, depois o da concessão, e a conta sai.
        deletion = prisma.$transaction(async (tx) => {
          await lockCredential(tx, account.id);
          await lockGrant(tx, grant.id);
          await tx.cloudAccount.delete({ where: { id: account.id } });
          await tx.cloudflareGrant.update({
            where: { id: grant.id },
            data: { status: 'revoking', revokeRequestedAt: NOW },
          });
          holding();
          // Segura os dois locks enquanto a gravação da renovação espera o da concessão.
          await new Promise((resolve) => setTimeout(resolve, 300));
        });
        await held;
      };
      const report = await syncFor({ oauthTokens: tokensClient(3_000) }).runOnce(NOW);
      await deletion;
      expect(report.status).toBe('done');
      expect(await prisma.cloudAccount.findUnique({ where: { id: account.id } })).toBeNull();
      expect(await grantRow(grant.id)).toMatchObject({ status: 'revoking', generation: 2 });
      expect((await stored(grant)).refreshToken).toBe(grant.fake.refreshToken);
      // Um deadlock derrubaria uma das duas transações: a exclusão (acima) ou a gravação da renovação.
      expect(report.failedAccounts).toBe(0);
    });
  });

  describe('limites da concessão', () => {
    it('um 429 adia todas as contas da concessão, e nenhuma outra', async () => {
      const grant = await newGrant(tenantA, {});
      const first = await newAccount(tenantA, grant.id);
      const second = await newAccount(tenantA, grant.id);
      grant.fake.access.auditAccounts = [first.accountId, second.accountId];
      const other = await readyAccount(tenantA);
      cloudflare.auditScript.push({ status: 429, headers: { 'retry-after': '600' } });
      const report = await syncFor().runOnce(NOW);
      expect(report).toMatchObject({ accounts: 3, failedAccounts: 1, notDue: 1 });
      for (const id of [first.id, second.id]) {
        for (const stream of [CLOUDFLARE_AUDIT_STREAM, CLOUDFLARE_CHECK_STREAM]) {
          expect((await cursorOf(id, stream)).nextRunAt.getTime()).toBeGreaterThanOrEqual(at(10).getTime());
        }
      }
      expect((await cursorOf(second.id)).failures).toBe(0);
      expect(await accountRow(second.id)).toMatchObject({ connection: 'waiting', connectionError: null });
      expect(await accountRow(other.account.id)).toMatchObject({ connection: 'connected' });
    });

    it('um 429 com token colado adia só a conta dele', async () => {
      const tokens = await Promise.all(
        [0, 1].map(async () => {
          const account = await newAccount(tenantA, null);
          await storeToken(account, cloudflare.readableAccountToken(account.accountId));
          return account;
        }),
      );
      cloudflare.auditScript.push({ status: 429, headers: { 'retry-after': '600' } });
      expect(await syncFor().runOnce(NOW)).toMatchObject({
        accounts: 2,
        failedAccounts: 1,
        notDue: 0,
        pages: 1,
      });
      const states = await Promise.all(tokens.map(({ id }) => accountRow(id)));
      expect(states.map(({ connection }) => connection).sort()).toEqual(['connected', 'error']);
    });

    it('as contas da concessão dividem o orçamento do GraphQL, e a soma nunca passa dele', async () => {
      const grant = await newGrant(tenantA, { analyticsZones: [] });
      const accounts: Account[] = [];
      for (let index = 0; index < 3; index += 1) {
        const account = await newAccount(tenantA, grant.id, { streams: ['security'] });
        for (let zone = 0; zone < 4; zone += 1) {
          const tag = cloudflare.addSecurityZone(account.accountId, `z${zone}.exemplo.com.br`, {
            limits: DEFAULT_ZONE_LIMITS,
          });
          grant.fake.access.analyticsZones?.push(tag);
        }
        accounts.push(account);
      }
      const budgetUnits = 30;
      const sync = syncFor({ securityEvents: { firstReadMs: 4 * 60 * 60_000, budgetUnits } });
      const report = await sync.runOnce(NOW);
      expect(report.budgetWaits).toBeGreaterThan(0);
      const spent = await Promise.all(
        accounts.map(async ({ id }) => {
          const { budget } = decodeState((await cursorOf(id, CLOUDFLARE_SECURITY_STREAM)).continuation);
          return budget.reduce((sum, [, units]) => sum + units, 0);
        }),
      );
      // Cada conta leu alguma coisa, dentro da parte dela (um terço), e a soma cabe no orçamento da concessão.
      for (const units of spent) {
        expect(units).toBeGreaterThan(0);
        expect(units).toBeLessThanOrEqual(budgetUnits / 3);
      }
      expect(spent.reduce((sum, units) => sum + units, 0)).toBeLessThanOrEqual(budgetUnits);
    });

    it('o gasto recente das outras contas conta, mesmo com a parte desta livre', async () => {
      const grant = await newGrant(tenantA, { analyticsZones: [] });
      const account = await newAccount(tenantA, grant.id, { streams: ['security'] });
      const sibling = await newAccount(tenantA, grant.id, { streams: [] });
      const tag = cloudflare.addSecurityZone(account.accountId, 'loja.exemplo.com.br');
      grant.fake.access.analyticsZones?.push(tag);
      // A outra conta já gastou tudo neste minuto (de quando ela lia sozinha).
      await prisma.collectorCursor.updateMany({
        where: { cloudAccountId: sibling.id, stream: CLOUDFLARE_SECURITY_STREAM },
        data: { continuation: JSON.stringify({ v: 1, b: [[Math.floor(NOW.getTime() / 60_000), 250]] }) },
      });
      const report = await syncFor({ securityEvents: {} }).runOnce(NOW);
      expect(report).toMatchObject({ securityQueries: 0, budgetWaits: 1 });
      expect(cloudflare.graphqlReads(grant.fake.accessToken)).toHaveLength(0);
      expect((await cursorOf(account.id, CLOUDFLARE_SECURITY_STREAM)).nextRunAt.getTime()).toBeGreaterThan(
        NOW.getTime(),
      );
    });

    it('com muitas contas na concessão, a consulta leva menos zonas e a leitura anda', async () => {
      const grant = await newGrant(tenantA, { analyticsZones: [] });
      const account = await newAccount(tenantA, grant.id, { streams: ['security'] });
      for (let index = 0; index < 9; index += 1) await newAccount(tenantA, grant.id, { streams: [] });
      for (let zone = 0; zone < 6; zone += 1) {
        const tag = cloudflare.addSecurityZone(account.accountId, `z${zone}.exemplo.com.br`);
        grant.fake.access.analyticsZones?.push(tag);
      }
      const securityEvents = { firstReadMs: 15 * 60_000, budgetUnits: 50 };
      // 50 entre 10 contas: 5 unidades, 2 zonas por consulta.
      const sync = syncFor({ securityEvents });
      for (let minutes = 0; minutes <= 60; minutes += 7) await sync.runOnce(at(minutes));
      const sizes = cloudflare
        .graphqlReads(grant.fake.accessToken)
        .map((request) => (request.variables['zoneTags'] as string[]).length);
      expect(Math.max(...sizes)).toBe(2);
      expect(await accountRow(account.id)).toMatchObject({ connection: 'connected' });
    });
  });

  describe('versão da sessão', () => {
    it('a renovação no meio da leitura não descarta o resultado dela', async () => {
      const { account, grant } = await readyAccount(tenantA);
      // O acesso deixa de valer: o envelope muda durante a leitura.
      cloudflare.tokens.delete(grant.fake.accessToken);
      const before = (await grantRow(grant.id)).ciphertext;
      await syncFor().runOnce(NOW);
      expect((await grantRow(grant.id)).ciphertext).not.toBe(before);
      expect(await accountRow(account.id)).toMatchObject({ connection: 'connected', lastCollectedAt: NOW });
    });

    it.each([
      [
        'a conta foi solta da concessão',
        async (id: string) => {
          await prisma.cloudAccount.update({ where: { id }, data: { cloudflareGrantId: null } });
        },
      ],
      [
        'o cliente reconectou',
        async (id: string) => {
          const row = await prisma.cloudAccount.findUniqueOrThrow({ where: { id } });
          await prisma.cloudflareGrant.update({
            where: { id: row.cloudflareGrantId ?? '' },
            data: { consentedAt: at(1) },
          });
        },
      ],
    ])('%s durante a leitura: a conexão não é tocada', async (_, change) => {
      const { account } = await readyAccount(tenantA);
      const client = new CloudflareClient({ baseUrl: cloudflare.baseUrl, timeoutMs: 400, retryDelaysMs: [] });
      const auditPage = client.auditPage.bind(client);
      vi.spyOn(client, 'auditPage').mockImplementation(async (...args) => {
        await change(account.id);
        return auditPage(...args);
      });
      await syncFor({ client }).runOnce(NOW);
      expect(await accountRow(account.id)).toEqual({
        connection: 'waiting',
        connectionError: null,
        lastCollectedAt: null,
      });
    });

    it('do token colado para o OAuth no meio da leitura: cursor e achados ficam, sem duplicar, e a conexão é da nova', async () => {
      const account = await newAccount(tenantA, null);
      const value = cloudflare.readableAccountToken(account.accountId);
      await storeToken(account, value);
      const entry = entryFactory(account.accountId);
      cloudflare.addAudit(account.accountId, suspicious(entry, -50), suspicious(entry, -5));
      const grant = await newGrant(tenantA, { auditAccounts: [account.accountId] });
      const client = new CloudflareClient({ baseUrl: cloudflare.baseUrl, timeoutMs: 400, retryDelaysMs: [] });
      const auditPage = client.auditPage.bind(client);
      vi.spyOn(client, 'auditPage').mockImplementationOnce(async (...args) => {
        // A passagem do CF-8: numa transação, sob o lock da credencial, e recomeça a conexão.
        await prisma.$transaction(async (tx) => {
          await lockCredential(tx, account.id);
          await tx.cloudCredential.delete({ where: { cloudAccountId: account.id } });
          await tx.cloudAccount.update({
            where: { id: account.id },
            data: { cloudflareGrantId: grant.id, ...RESET_CONNECTION },
          });
        });
        return auditPage(...args);
      });
      await syncFor({ client }).runOnce(NOW);
      expect(await findingsOf(account.accountId)).toHaveLength(2);
      const cursor = await cursorOf(account.id);
      expect(cursor.cursorAt).toEqual(at(-1));
      // A leitura do token não marca a conta já passada para o OAuth (o evento recebido só a tira de "aguardando").
      expect(await accountRow(account.id)).toMatchObject({ connectionError: null, lastCollectedAt: null });

      cloudflare.addAudit(account.accountId, suspicious(entry, 2));
      // A sobreposição de 10 min relê a entrada de -5 min e não a duplica.
      const report = await syncFor().runOnce(at(6));
      expect(report).toMatchObject({ created: 1, duplicates: 1 });
      expect(await findingsOf(account.accountId)).toHaveLength(3);
      expect(await accountRow(account.id)).toMatchObject({ connection: 'connected', lastCollectedAt: at(6) });
      expect(callsWith(value)).toBe(1);
      expect(callsWith(grant.fake.accessToken)).toBe(1);
    });
  });

  describe('token colado, sem concessão', () => {
    it('nunca chama o OAuth, nem consulta nem trava concessão nenhuma, e o 401 sobe na hora', async () => {
      const account = await newAccount(tenantA, null);
      const value = cloudflare.readableAccountToken(account.accountId);
      await storeToken(account, value);
      const refused = await newAccount(tenantB, null);
      const revoked = fakeCloudflare.accountToken();
      await storeToken(refused, revoked);
      const refresh = vi.fn();
      const findGrant = vi.spyOn(CloudflareGrants.prototype, 'open');
      const reject = vi.spyOn(CloudflareGrants.prototype, 'reject');
      try {
        await syncFor({ oauthTokens: { refresh } }).runOnce(NOW);
        expect(findGrant).not.toHaveBeenCalled();
        expect(reject).not.toHaveBeenCalled();
      } finally {
        findGrant.mockRestore();
        reject.mockRestore();
      }
      expect(refresh).not.toHaveBeenCalled();
      expect(oauth.requests).toHaveLength(0);
      expect(await accountRow(account.id)).toMatchObject({ connection: 'connected' });
      expect(callsWith(revoked)).toBe(1);
      expect(await accountRow(refused.id)).toMatchObject({ connectionError: 'credential_rejected' });
    });
  });

  describe('segredos', () => {
    it('nenhum token no log, no relatório, na auditoria ou no texto do acesso; os que saem de uso saem da máscara', async () => {
      const capture = new LogCapture();
      const logger = pino(buildPinoOptions({ LOG_LEVEL: 'trace' }), capture);
      const { account, grant } = await readyAccount(tenantA, { expiresAt: at(5), consentedAt: at(-55) });
      const old = { access: grant.fake.accessToken, refresh: grant.fake.refreshToken };
      const sync = syncFor();
      const report = await sync.runOnce(NOW);
      const now = { access: grant.fake.accessToken, refresh: grant.fake.refreshToken };
      logger.info({ report }, `pedido com ${now.access} e ${now.refresh}`);
      logger.error({ err: new Error(`falhou ${now.refresh}`) }, 'erro');
      for (const value of Object.values(now)) {
        expect(capture.text).not.toContain(value);
        expect(scrubString(`x ${value}`)).not.toContain(value);
      }
      // Os trocados não valem mais: guardar cada um faria o conjunto crescer de hora em hora.
      for (const value of Object.values(old)) expect(scrubString(`x ${value}`)).toContain(value);
      const trail = await prisma.auditLog.findMany({ where: { tenantId: tenantA } });
      const row = await grantRow(grant.id);
      const text = JSON.stringify([
        report,
        trail,
        row,
        await cursorOf(account.id),
        await accountRow(account.id),
      ]);
      for (const value of [...Object.values(old), ...Object.values(now)]) expect(text).not.toContain(value);

      // A conta sai: na execução seguinte, os tokens dela deixam a máscara.
      await prisma.cloudAccount.delete({ where: { id: account.id } });
      await sync.runOnce(at(1));
      for (const value of Object.values(now)) expect(scrubString(`x ${value}`)).toContain(value);
    });

    it('a autorização que acabou também sai da máscara, e o acesso nunca vira texto', async () => {
      const { grant } = await readyAccount(tenantA);
      const grants = new CloudflareGrants(prisma, keyring, tokensClient());
      const opened = await grants.open(grant.ref, () => NOW);
      if (opened.kind !== 'ready') throw new Error('acesso esperado');
      const value = opened.bearer.value();
      for (const text of [JSON.stringify(opened), String(opened.bearer), inspect(opened, { depth: 5 })]) {
        expect(text).not.toContain(value);
      }
      expect(scrubString(value)).not.toContain(value);
      await grants.reject(grant.ref, 1, 'credential_rejected');
      expect(scrubString(value)).toBe(value);
    });

    it('o erro da renovação só leva o código, e a mensagem do Cloudflare não vai a lugar nenhum', async () => {
      const { grant } = await readyAccount(tenantA, { expiresAt: at(-1), consentedAt: at(-61) });
      oauth.revoke(grant.fake);
      const error = await tokensClient()
        .refresh(grant.fake.clientId, grant.fake.refreshToken)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CloudflareOAuthError);
      expect(inspect(error)).not.toContain(grant.fake.refreshToken);
      await syncFor().runOnce(NOW);
      expect(JSON.stringify(await grantRow(grant.id))).not.toContain(grant.fake.refreshToken);
    });

    it('o token que não cabe no header nem no envelope é recusado sem ir para a concessão', async () => {
      for (const body of [
        { access_token: 'com espaco no meio do token', token_type: 'bearer', expires_in: 60 },
        { access_token: `${oauthToken()}\r\nx: y`, token_type: 'bearer', expires_in: 60 },
        { access_token: 'x'.repeat(4097), token_type: 'bearer', expires_in: 60 },
        { access_token: oauthToken(), token_type: 'mac', expires_in: 60 },
      ]) {
        oauth.script.push({ status: 200, body: JSON.stringify(body) });
        await expect(tokensClient().refresh('cliente0001', oauthToken('rt'))).rejects.toMatchObject({
          code: 'bad_response',
          failure: 'unavailable',
          ambiguous: true,
        });
      }
      // Dois tokens grandes demais juntos: não cabem no envelope, e nada é gravado.
      const { account, grant } = await readyAccount(tenantA, { expiresAt: at(-1), consentedAt: at(-61) });
      const before = await grantRow(grant.id);
      oauth.script.push({
        status: 200,
        body: JSON.stringify({
          access_token: 'a'.repeat(4000),
          refresh_token: 'b'.repeat(4000),
          token_type: 'bearer',
          expires_in: 3600,
        }),
      });
      expect(await syncFor().runOnce(NOW)).toMatchObject({ failedAccounts: 1, grantsFailed: 1, pages: 0 });
      expect(await grantRow(grant.id)).toMatchObject({
        ciphertext: before.ciphertext,
        generation: 1,
        lastErrorKind: 'oauth_unstorable',
      });
      expect(await accountRow(account.id)).toMatchObject({ connectionError: 'oauth_refresh_unavailable' });
    });

    it('só o endereço oficial (ou 127.0.0.1, nos testes), sem seguir redirecionamento', async () => {
      for (const tokenUrl of [
        'https://dash.cloudflare.com.exemplo.com.br/oauth2/token',
        'https://dash.cloudflare.com/oauth2/token?x=1',
        'http://dash.cloudflare.com/oauth2/token',
        'http://localhost:1234/oauth2/token',
        'https://127.0.0.1/oauth2/token',
        'http://127.0.0.1@exemplo.com.br/oauth2/token',
        'nada',
      ]) {
        expect(() => new PublicClientTokens({ tokenUrl })).toThrow('endereço oficial');
      }
      expect(() => new PublicClientTokens()).not.toThrow();
      oauth.script.push({ status: 307, headers: { location: oauth.tokenUrl } });
      await expect(tokensClient().refresh('cliente0001', oauthToken('rt'))).rejects.toMatchObject({
        code: 'network',
      });
      expect(oauth.requests).toHaveLength(1);
    });
  });

  it('o cliente só renova quem se renova, e uma vez por pedido', async () => {
    const client = new CloudflareClient({
      baseUrl: cloudflare.baseUrl,
      timeoutMs: 400,
      retryDelaysMs: [10, 10],
    });
    const accountId = fakeCloudflare.accountId();
    const request = { since: at(-60), before: NOW, limit: 1 };
    const fixed = { value: () => 'x'.repeat(40) };
    await expect(client.auditPage(fixed, accountId, request)).rejects.toMatchObject({
      code: 'credential_rejected',
    });
    const renew = vi.fn(() => Promise.resolve('renewed' as const));
    const calls = cloudflare.requests.length;
    await expect(client.auditPage({ ...fixed, renew }, accountId, request)).rejects.toBeInstanceOf(
      CloudflareApiError,
    );
    expect(renew).toHaveBeenCalledTimes(1);
    expect(cloudflare.requests).toHaveLength(calls + 2);
    const unavailable = vi.fn(() => Promise.resolve('unavailable' as const));
    await expect(
      client.auditPage({ ...fixed, renew: unavailable }, accountId, request),
    ).rejects.toMatchObject({
      code: 'oauth_refresh_unavailable',
    });
    const grant: FakeGrant = oauth.grant({ auditAccounts: [accountId] });
    let value = 'x'.repeat(40);
    const bearer = {
      value: () => value,
      renew: () => {
        value = grant.accessToken;
        return Promise.resolve('renewed' as const);
      },
    };
    await expect(client.auditPage(bearer, accountId, request)).resolves.toMatchObject({ entries: [] });
  });
});
