import 'reflect-metadata';
import { createHash, generateKeyPairSync, type KeyObject, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  CLOUDFLARE_OAUTH_ONLY_CODE,
  CLOUDFLARE_OAUTH_REFUSED_CODE,
  type CloudflareOauthAttempt,
  cloudflareOauthAttemptSchema,
  type CloudflareOauthConfig,
  cloudflareOauthStartedSchema,
  cloudflareConnectOptionsSchema,
  resolvePlan,
  type ResolvedPlan,
  type Role,
} from '@verax/shared';
import {
  openCloudflareOauthCode,
  openCloudflareOauthTokens,
  openCloudflareOauthVerifier,
  sealCloudflareOauthTokens,
} from '@verax/vault-envelope';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLOUDFLARE_AUDIT_STREAM,
  CLOUDFLARE_CHECK_STREAM,
  CloudflareAuditSync,
} from '../src/cloudflare/cloudflare-audit-sync.js';
import { CloudflareClient } from '../src/cloudflare/cloudflare.client.js';
import { CloudflareTokenCheck } from '../src/cloudflare/cloudflare-token-check.js';
import {
  CONNECT_ATTEMPTS_PER_TENANT,
  CONNECT_ATTEMPTS_PER_USER,
  hashState,
} from '../src/cloudflare/oauth/cloudflare-connect.service.js';
import {
  CLOUDFLARE_REVOKE_GIVE_UP_MS,
  CloudflareConnectJob,
  type CloudflareConnectOptions as JobOptions,
} from '../src/cloudflare/oauth/connect-job.js';
import { CloudflareGrants } from '../src/cloudflare/oauth/cloudflare-grants.js';
import { linkAccounts } from '../src/cloudflare/oauth/link-accounts.js';
import { CloudflareOauthSettings, slugOfApiOrigin } from '../src/cloudflare/oauth/oauth-settings.js';
import { PublicClientTokens } from '../src/cloudflare/oauth/oauth-tokens.js';
import { AuditService } from '../src/common/audit/audit.service.js';
import { scrubString } from '../src/common/logger/sanitize.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import {
  parsePrivateKeys,
  parsePublicKey,
  type VaultKeyring,
  type VaultPublicKey,
} from '../src/credentials/credential-keys.js';
import { lockCredential, lockGrant } from '../src/credentials/credential-rekey.js';
import { CloudflareToken, credentialBinding, seal } from '../src/credentials/credential-vault.js';
import { fixedTenantPlans } from '../src/plan/tenant-plan.js';
import { entryFactory, hex } from './cloudflare/fixtures.js';
import { createSignedInUser, createTenant, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import { fakeCloudflare, FakeCloudflareServer } from './support/fake-cloudflare.js';
import { FakeCloudflareOAuthServer } from './support/fake-cloudflare-oauth.js';
import { LogCapture } from './support/log-capture.js';
import type { TestSession } from './support/tenant-isolation.js';

/** Versão da chave do nó, exclusiva deste arquivo: os arquivos rodam em paralelo no mesmo banco. */
const KEY_VERSION = 930;
const MINUTE = 60_000;
const SLUG = 'cliente-demo';
const CONFIG: CloudflareOauthConfig = {
  clientId: 'appdeteste0000000001',
  redirectUri: 'https://conta.verax.example/v1/public/cloudflare/callback',
  scopes: ['account-settings.read', 'zone.read', 'offline_access'],
};
const pem64 = (key: KeyObject, type: 'spki' | 'pkcs8') =>
  Buffer.from(key.export({ type, format: 'pem' })).toString('base64');

interface Session extends TestSession {
  userId: string;
}

describe('conectar o Cloudflare por OAuth (API e worker, banco real, Cloudflare e OAuth falsos)', () => {
  const capture = new LogCapture();
  const cloudflare = new FakeCloudflareServer();
  const oauth = new FakeCloudflareOAuthServer(cloudflare);
  const settings: { current: () => Promise<{ config: CloudflareOauthConfig; slug: string } | null> } = {
    current: () => Promise.resolve({ config: CONFIG, slug: SLUG }),
  };
  /** Todo código, verificador e token do arquivo: nenhum pode aparecer em log, trilha ou resposta. */
  const secrets = new Set<string>();
  const bodies: string[] = [];
  const warnings: string[] = [];
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let keyring: VaultKeyring;
  let publicKey: VaultPublicKey;
  let tenantA: string;
  let tenantB: string;
  let adminA: Session;
  let adminB: Session;
  let run = 0;

  async function sessionFor(tenantId: string, role: Role = 'admin_cliente'): Promise<Session> {
    const user = await createSignedInUser(app, { role, tenantId });
    const { cookie, token } = await withCsrf(app, user.cookie);
    return { cookie, csrfToken: token, userId: user.id };
  }
  const write = (session: TestSession, method: 'post' | 'put' | 'patch' | 'delete', path: string) => {
    const agent = request(app.getHttpServer());
    return agent[method](path)
      .set('Cookie', session.cookie)
      .set('Origin', TEST_WEB_ORIGIN)
      .set('X-CSRF-Token', session.csrfToken);
  };
  const read = (session: TestSession, path: string) =>
    request(app.getHttpServer()).get(path).set('Cookie', session.cookie);
  const errorOf = (response: request.Response) => response.body as { message?: string; code?: string };
  const auditOf = (response: request.Response) =>
    prisma.auditLog.findFirstOrThrow({ where: { requestId: response.headers['x-request-id'] } });

  async function start(session: Session, cloudAccountId?: string) {
    const response = await write(session, 'post', '/v1/cloudflare-oauth/start')
      .send(cloudAccountId === undefined ? {} : { cloudAccountId })
      .expect(200);
    bodies.push(JSON.stringify({ ...(response.body as object), authorizeUrl: '' }));
    return cloudflareOauthStartedSchema.parse(response.body);
  }
  const complete = (session: TestSession, body: object) => {
    if ('code' in body) secrets.add(String(body.code));
    return write(session, 'post', '/v1/cloudflare-oauth/complete').send(body);
  };
  /** Do clique à volta da tela do Cloudflare. */
  async function authorized(
    session: Session,
    access: Parameters<FakeCloudflareOAuthServer['authorize']>[1],
    cloudAccountId?: string,
  ) {
    const started = await start(session, cloudAccountId);
    const callback = oauth.authorize(started.authorizeUrl, access);
    await complete(session, callback).expect(200);
    return { attemptId: started.attemptId, callback };
  }
  async function attemptOf(session: Session, id: string): Promise<CloudflareOauthAttempt> {
    const response = await read(session, `/v1/cloudflare-oauth/attempts/${id}`).expect(200);
    bodies.push(JSON.stringify(response.body));
    return cloudflareOauthAttemptSchema.parse(response.body);
  }
  const choose = (session: TestSession, id: string, accountIds: string[]) =>
    write(session, 'post', `/v1/cloudflare-oauth/attempts/${id}/accounts`).send({ accountIds });
  const row = (id: string) => prisma.cloudflareConnectAttempt.findUniqueOrThrow({ where: { id } });
  const grantRow = (id: string) => prisma.cloudflareGrant.findUnique({ where: { id } });

  const jobFor = (options: Partial<JobOptions> = {}, plan: ResolvedPlan | null = resolvePlan('interno')) => {
    run += 1;
    return new CloudflareConnectJob(prisma, keyring, fixedTenantPlans(plan), {
      oauth: new PublicClientTokens({
        tokenUrl: oauth.tokenUrl,
        revokeUrl: oauth.revokeUrl,
        timeoutMs: 1_500,
      }),
      client: new CloudflareClient({ baseUrl: cloudflare.baseUrl, timeoutMs: 1_500, retryDelaysMs: [] }),
      logger: { warn: (fields, message) => warnings.push(JSON.stringify({ ...fields, message })) },
      name: `cf-connect-teste-${run}`,
      tenantIds: [tenantA, tenantB],
      saveDelaysMs: [0, 10, 10],
      ...options,
    });
  };
  const collectorFor = () => {
    run += 1;
    return new CloudflareAuditSync(prisma, keyring, {
      name: `cf-connect-coletor-${run}`,
      client: new CloudflareClient({ baseUrl: cloudflare.baseUrl, timeoutMs: 2_000, retryDelaysMs: [] }),
      tokenCheck: new CloudflareTokenCheck({ baseUrl: cloudflare.baseUrl, timeoutMs: 2_000 }),
      oauthTokens: new PublicClientTokens({ tokenUrl: oauth.tokenUrl, revokeUrl: oauth.revokeUrl }),
      tenantIds: [tenantA, tenantB],
      securityEvents: false,
    });
  };

  async function tokenAccount(tenantId = tenantA, zones: string[] = ['a.example.com']) {
    const accountId = fakeCloudflare.accountId();
    const account = await prisma.forTenant(tenantId).cloudAccount.create({
      data: { tenantId, provider: 'cloudflare', accountId, regions: [], zones },
      select: { id: true, tenantId: true, accountId: true },
    });
    const value = cloudflare.readableAccountToken(accountId);
    secrets.add(value);
    const sealed = seal(
      publicKey,
      credentialBinding({ ...account, provider: 'cloudflare' }, 'cloudflare_api_token'),
      new CloudflareToken(value),
    );
    await prisma.forTenant(tenantId).cloudCredential.create({
      data: {
        cloudAccountId: account.id,
        tenantId,
        kind: 'cloudflare_api_token',
        ciphertext: sealed.ciphertext,
        keyVersion: sealed.keyVersion,
        keyIdSuffix: 'c0de',
        verifiedAt: new Date(),
      },
    });
    return { ...account, value };
  }

  /** Uma concessão como o worker a grava, com uma conta para cada ID. */
  async function connected(
    tenantId: string,
    accountIds: string[],
    { status = 'active', revokeRequestedAt = null as Date | null } = {},
  ) {
    const fake = oauth.grant({ auditAccounts: accountIds });
    secrets.add(fake.accessToken).add(fake.refreshToken);
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 60 * MINUTE);
    await prisma.forTenant(tenantId).cloudflareGrant.create({
      data: {
        id,
        tenantId,
        clientId: fake.clientId,
        ciphertext: sealCloudflareOauthTokens(
          publicKey,
          { tenantId, subjectId: id },
          { accessToken: fake.accessToken, refreshToken: fake.refreshToken, accessExpiresAt: expiresAt },
        ),
        keyVersion: KEY_VERSION,
        accessExpiresAt: expiresAt,
        scopes: CONFIG.scopes,
        consentedAt: new Date(),
        consentedBy: 'usuario-de-teste',
        status,
        revokeRequestedAt,
      },
    });
    const accounts = [];
    for (const accountId of accountIds) {
      accounts.push(
        await prisma.forTenant(tenantId).cloudAccount.create({
          data: {
            tenantId,
            provider: 'cloudflare',
            accountId,
            regions: [],
            cloudflareGrantId: id,
            ...(status === 'reconnect' && {
              connection: 'error',
              connectionError: 'oauth_reconnect_required',
            }),
          },
          select: { id: true, accountId: true },
        }),
      );
    }
    return { id, fake, accounts };
  }
  const accountBy = (accountId: string) =>
    prisma.cloudAccount.findFirst({ where: { provider: 'cloudflare', accountId } });

  beforeAll(async () => {
    await cloudflare.start();
    await oauth.start();
    const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
    keyring = parsePrivateKeys(`${KEY_VERSION}:${pem64(pair.privateKey, 'pkcs8')}`, KEY_VERSION);
    publicKey = parsePublicKey(pem64(pair.publicKey, 'spki'), KEY_VERSION);
    app = await createApp({
      capture,
      apiOrigin: `https://api-${SLUG}.verax.example`,
      plan: {
        PLAN: 'enterprise',
        PLAN_MAX_CLOUD_ACCOUNTS: '200',
        PLAN_MAX_USERS: '50',
        PLAN_MONTHLY_GIB: '50',
        PLAN_HISTORY_DAYS: '90',
      },
      vault: { publicKey: pem64(pair.publicKey, 'spki'), version: KEY_VERSION },
      overrideProviders: [
        { provide: CloudflareOauthSettings, useValue: settings },
        {
          provide: CloudflareTokenCheck,
          useValue: new CloudflareTokenCheck({ baseUrl: cloudflare.baseUrl, timeoutMs: 1_500 }),
        },
      ],
    });
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente Demo A (conectar Cloudflare)');
    tenantB = await createTenant(app, 'Cliente Demo B (conectar Cloudflare)');
    adminA = await sessionFor(tenantA);
    adminB = await sessionFor(tenantB);
  });

  beforeEach(async () => {
    oauth.reset();
    cloudflare.auditScript.length = 0;
    settings.current = () => Promise.resolve({ config: CONFIG, slug: SLUG });
    // Cada teste começa sem tentativa: o limite por hora não atravessa testes.
    const mine = { tenantId: { in: [tenantA, tenantB] } };
    await prisma.cloudflareConnectAttempt.deleteMany({ where: mine });
    await prisma.cloudAccount.deleteMany({ where: mine });
    await prisma.cloudflareGrant.deleteMany({ where: mine });
  });

  afterAll(async () => {
    const mine = { tenantId: { in: [tenantA, tenantB] } };
    await prisma.cloudflareConnectAttempt.deleteMany({ where: mine });
    await prisma.cloudAccount.deleteMany({ where: mine });
    await prisma.cloudflareGrant.deleteMany({ where: mine });
    await app.close();
    await oauth.stop();
    await cloudflare.stop();
  });

  describe('interruptor', () => {
    it('desligado, as rotas respondem 404 e o token colado segue como sempre', async () => {
      settings.current = () => Promise.resolve(null);
      const id = randomUUID();
      await read(adminA, '/v1/cloudflare-oauth/options').expect(404);
      await read(adminA, `/v1/cloudflare-oauth/attempts/${id}`).expect(404);
      await write(adminA, 'post', '/v1/cloudflare-oauth/start').send({}).expect(404);
      await complete(adminA, {
        state: `${SLUG}.${'a'.repeat(43)}`,
        code: 'codigo-de-teste',
        iss: 'https://dash.cloudflare.com',
      }).expect(404);
      await choose(adminA, id, [fakeCloudflare.accountId()]).expect(404);
      const account = await prisma.forTenant(tenantA).cloudAccount.create({
        data: {
          tenantId: tenantA,
          provider: 'cloudflare',
          accountId: fakeCloudflare.accountId(),
          regions: [],
        },
        select: { id: true, accountId: true },
      });
      const token = cloudflare.readableAccountToken(account.accountId);
      secrets.add(token);
      await write(adminA, 'put', `/v1/cloud-accounts/${account.id}/credential`)
        .send({ kind: 'cloudflare_api_token', token })
        .expect(200);
      expect(oauth.requests).toHaveLength(0);
    });

    it('ligado, o painel sabe o modo, e o token novo é recusado sem chamar o Cloudflare; quem já usa token segue', async () => {
      const options = await read(adminA, '/v1/cloudflare-oauth/options').expect(200);
      expect(cloudflareConnectOptionsSchema.parse(options.body)).toEqual({ mode: 'oauth' });
      const account = await tokenAccount();
      const token = cloudflare.readableAccountToken(account.accountId);
      secrets.add(token);
      const before = cloudflare.requests.length;
      const response = await write(adminA, 'put', `/v1/cloud-accounts/${account.id}/credential`)
        .send({ kind: 'cloudflare_api_token', token })
        .expect(409);
      expect(errorOf(response).code).toBe(CLOUDFLARE_OAUTH_ONLY_CODE);
      expect(cloudflare.requests).toHaveLength(before);
      await prisma.collectorCursor.create({
        data: {
          cloudAccountId: account.id,
          stream: CLOUDFLARE_CHECK_STREAM,
          nextRunAt: new Date('2100-01-01'),
        },
      });
      expect(await collectorFor().runOnce()).toMatchObject({ pages: 1, blocked: 0 });
    });

    it('só o nó dedicado gerenciado de cliente, com o cofre, o endereço e a configuração válida', async () => {
      const stored: { value: unknown } = { value: CONFIG };
      const db = {
        controlPlaneSync: { findUnique: () => Promise.resolve({ cloudflareOauth: stored.value }) },
      } as unknown as PrismaService;
      const base = {
        NODE_PLATFORM: 'gcp' as const,
        PLAN: 'essencial' as const,
        cell: null,
        credentialsPublicKey: publicKey,
        API_ORIGIN: `https://api-${SLUG}.verax.example`,
      };
      const of = (changes: object) => new CloudflareOauthSettings(db, { ...base, ...changes }).current();
      expect(await of({})).toEqual({ config: CONFIG, slug: SLUG });
      expect(await of({ NODE_PLATFORM: 'vm' })).toBeNull();
      expect(await of({ PLAN: 'interno' })).toBeNull();
      expect(await of({ cell: { domain: 'verax.example', staffSlug: 'equipe' } })).toBeNull();
      expect(await of({ credentialsPublicKey: null })).toBeNull();
      expect(await of({ API_ORIGIN: 'http://localhost:3000' })).toBeNull();
      for (const value of [null, {}, { ...CONFIG, scopes: ['zone.write', 'offline_access'] }]) {
        stored.value = value;
        expect(await of({})).toBeNull();
      }
    });

    it('o subdomínio sai só do endereço da API', () => {
      expect(slugOfApiOrigin('https://api-cliente-a.verax.example')).toBe('cliente-a');
      for (const origin of [
        'http://api-cliente-a.verax.example',
        'https://api-cliente-a.verax.example:8443',
        'https://api-cliente-a',
        'https://cliente-a.verax.example',
        'https://api-.verax.example',
        'https://api-ab--cd.verax.example',
        'https://api-1cliente.verax.example',
        'nada',
      ]) {
        expect(slugOfApiOrigin(origin)).toBeNull();
      }
    });
  });

  describe('início', () => {
    it('monta a URL só da configuração e guarda o state resumido e o verificador cifrado', async () => {
      const started = await start(adminA);
      const url = new URL(started.authorizeUrl);
      expect(url.origin + url.pathname).toBe('https://dash.cloudflare.com/oauth2/auth');
      const query = Object.fromEntries(url.searchParams);
      expect(query).toEqual({
        response_type: 'code',
        client_id: CONFIG.clientId,
        redirect_uri: CONFIG.redirectUri,
        scope: CONFIG.scopes.join(' '),
        state: expect.stringMatching(/^cliente-demo[.][A-Za-z0-9_-]{43}$/) as string,
        code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as string,
        code_challenge_method: 'S256',
      });
      const stored = await row(started.attemptId);
      expect(stored).toMatchObject({
        tenantId: tenantA,
        userId: adminA.userId,
        status: 'started',
        stateHash: hashState(String(query['state'])),
        config: CONFIG,
      });
      expect(JSON.stringify(stored)).not.toContain(String(query['state']));
      const verifier = openCloudflareOauthVerifier(
        keyring,
        { tenantId: tenantA, subjectId: started.attemptId },
        stored.verifierCiphertext ?? '',
      );
      secrets.add(verifier);
      expect(createHash('sha256').update(verifier).digest('base64url')).toBe(query['code_challenge']);
      expect(scrubString(verifier)).toBe(verifier);
    });

    it('só administrador, com CSRF', async () => {
      for (const role of ['analista_cliente', 'leitura'] as const) {
        const session = await sessionFor(tenantA, role);
        await write(session, 'post', '/v1/cloudflare-oauth/start').send({}).expect(403);
        await read(session, '/v1/cloudflare-oauth/options').expect(200);
        await read(session, `/v1/cloudflare-oauth/attempts/${randomUUID()}`).expect(403);
      }
      await request(app.getHttpServer())
        .post('/v1/cloudflare-oauth/start')
        .set('Cookie', adminA.cookie)
        .set('Origin', TEST_WEB_ORIGIN)
        .send({})
        .expect(403);
      await request(app.getHttpServer()).get('/v1/cloudflare-oauth/options').expect(401);
      expect(await prisma.cloudflareConnectAttempt.count({ where: { tenantId: tenantA } })).toBe(0);
    });

    it('a conta a reconectar é do cliente, do Cloudflare e ativa', async () => {
      const ofB = await tokenAccount(tenantB);
      await write(adminA, 'post', '/v1/cloudflare-oauth/start').send({ cloudAccountId: ofB.id }).expect(404);
      const inactive = await tokenAccount();
      await prisma.cloudAccount.update({ where: { id: inactive.id }, data: { status: 'inactive' } });
      await write(adminA, 'post', '/v1/cloudflare-oauth/start')
        .send({ cloudAccountId: inactive.id })
        .expect(400);
      const aws = await prisma.forTenant(tenantA).cloudAccount.create({
        data: { tenantId: tenantA, provider: 'aws', accountId: '333333333333', regions: ['sa-east-1'] },
        select: { id: true },
      });
      await write(adminA, 'post', '/v1/cloudflare-oauth/start').send({ cloudAccountId: aws.id }).expect(400);
      await write(adminA, 'post', '/v1/cloudflare-oauth/start').send({ clientId: 'x' }).expect(400);
    });

    it('limita as tentativas por usuário e por cliente, sem afetar o outro cliente', async () => {
      const seed = (userId: string, count: number) =>
        prisma.cloudflareConnectAttempt.createMany({
          data: Array.from({ length: count }, () => ({
            tenantId: tenantA,
            userId,
            sessionId: 'sessao',
            stateHash: hex(32),
            status: 'failed',
            errorCode: 'oauth_denied',
            expiresAt: new Date(Date.now() + MINUTE),
          })),
        });
      await seed(adminA.userId, CONNECT_ATTEMPTS_PER_USER - 1);
      await start(adminA);
      await write(adminA, 'post', '/v1/cloudflare-oauth/start').send({}).expect(429);
      const colleague = await sessionFor(tenantA);
      await start(colleague);
      await seed('outro-usuario', CONNECT_ATTEMPTS_PER_TENANT - CONNECT_ATTEMPTS_PER_USER - 1);
      await write(colleague, 'post', '/v1/cloudflare-oauth/start').send({}).expect(429);
      await start(adminB);
    });
  });

  describe('retorno', () => {
    it('na mesma sessão, guarda o código cifrado, uma vez', async () => {
      const started = await start(adminA);
      const callback = oauth.authorize(started.authorizeUrl, {});
      const response = await complete(adminA, callback).expect(200);
      expect(response.body).toEqual({ attemptId: started.attemptId });
      const stored = await row(started.attemptId);
      expect(stored.status).toBe('code_received');
      expect(stored.consumedAt).not.toBeNull();
      expect(
        openCloudflareOauthCode(
          keyring,
          { tenantId: tenantA, subjectId: started.attemptId },
          stored.codeCiphertext ?? '',
        ),
      ).toBe(callback.code);
      expect(scrubString(callback.code)).toBe(callback.code);
      const entry = await auditOf(response);
      expect(entry).toMatchObject({ action: 'cloudflare_oauth.complete', outcome: 'success' });
      expect(JSON.stringify(entry)).not.toContain(callback.code);
      // A API nunca chama o Cloudflare.
      expect(oauth.requests).toHaveLength(0);
    });

    it('recusa igual outra sessão, outro usuário, outro cliente, vencida, repetida, desconhecida e outro emissor', async () => {
      const colleague = await sessionFor(tenantA);
      const second = await (async () => {
        // O mesmo usuário em outra sessão: só o identificador da sessão muda.
        const started = await start(adminA);
        await prisma.cloudflareConnectAttempt.update({
          where: { id: started.attemptId },
          data: { sessionId: 'outra-sessao' },
        });
        return started;
      })();
      const fresh = async (session: Session = adminA) => {
        const started = await start(session);
        return { id: started.attemptId, callback: oauth.authorize(started.authorizeUrl, {}) };
      };
      const refusals: request.Response[] = [];
      const refuse = async (session: TestSession, body: object, reason: string, id?: string) => {
        const response = await complete(session, body).expect(400);
        refusals.push(response);
        const entry = await auditOf(response);
        expect(entry).toMatchObject({
          action: 'cloudflare_oauth.refused',
          outcome: 'failure',
          after: { reason },
        });
        if (id !== undefined) {
          expect(await row(id)).toMatchObject({ status: 'started', codeCiphertext: null, consumedAt: null });
        }
      };

      await refuse(adminA, oauth.authorize(second.authorizeUrl, {}), 'other_session', second.attemptId);
      const a = await fresh();
      await refuse(colleague, a.callback, 'other_user', a.id);
      // Outro cliente: no escopo dele, a tentativa não existe.
      await refuse(adminB, a.callback, 'unknown', a.id);
      await refuse(adminA, { ...a.callback, state: `${SLUG}.${'b'.repeat(43)}` }, 'unknown');
      // Sessão própria: o relógio adiantado a encerra.
      const traveller = await sessionFor(tenantA);
      const b = await fresh(traveller);
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10 * MINUTE + 1_000 });
      try {
        await refuse(traveller, b.callback, 'expired', b.id);
      } finally {
        vi.useRealTimers();
      }
      const c = await fresh();
      await complete(adminA, c.callback).expect(200);
      await refuse(adminA, c.callback, 'repeated');
      const d = await fresh();
      for (const iss of ['https://dash.cloudflare.com/', 'https://dash.cloudflare.com.mal.example']) {
        await refuse(adminA, { ...d.callback, iss }, iss.endsWith('/') ? 'issuer' : 'repeated');
      }
      // O emissor errado gasta a tentativa.
      expect(await row(d.id)).toMatchObject({ status: 'failed', errorCode: 'oauth_code_rejected' });
      await refuse(adminA, d.callback, 'repeated');

      const shapes = new Set(
        refusals.map((response) => {
          const { code, message } = errorOf(response);
          return JSON.stringify({ code, message, status: response.status });
        }),
      );
      expect(shapes.size).toBe(1);
      expect(errorOf(refusals[0] as request.Response).code).toBe(CLOUDFLARE_OAUTH_REFUSED_CODE);
      // Sem o emissor, nem chega à regra.
      const { iss: _iss, ...withoutIssuer } = d.callback;
      await complete(adminA, withoutIssuer).expect(400);
    });

    it('dois retornos ao mesmo tempo: um passa', async () => {
      const started = await start(adminA);
      const callback = oauth.authorize(started.authorizeUrl, {});
      const responses = await Promise.all([1, 2, 3, 4].map(() => complete(adminA, callback)));
      expect(responses.map((response) => response.status).sort()).toEqual([200, 400, 400, 400]);
      expect((await row(started.attemptId)).status).toBe('code_received');
    });

    it('dois retornos que já leram a tentativa aberta: a escrita condicional deixa passar um', async () => {
      const started = await start(adminA);
      const callback = oauth.authorize(started.authorizeUrl, {});
      const gate = Promise.withResolvers<undefined>();
      const held = Promise.withResolvers<undefined>();
      // A linha presa: os dois leem `started` e param na escrita.
      const holding = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "CloudflareConnectAttempt" WHERE "id" = ${started.attemptId}::uuid FOR UPDATE`;
          held.resolve(undefined);
          await gate.promise;
        },
        { timeout: 10_000 },
      );
      await held.promise;
      const responses = Promise.all(
        [1, 2].map(() => complete(adminA, callback).then((response) => response)),
      );
      await vi.waitFor(
        async () => {
          const [waiting] = await prisma.$queryRaw<{ count: bigint }[]>`
            SELECT count(*) AS count FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND query LIKE '%CloudflareConnectAttempt%'`;
          expect(Number(waiting?.count)).toBeGreaterThanOrEqual(2);
        },
        { timeout: 5_000 },
      );
      gate.resolve(undefined);
      await holding;
      expect((await responses).map((response) => response.status).sort()).toEqual([200, 400]);
    });

    it('o erro do Cloudflare termina a tentativa com o código, sem guardar a descrição', async () => {
      for (const [error, errorCode] of [
        ['access_denied', 'oauth_denied'],
        ['invalid_scope', 'oauth_client_rejected'],
        ['temporarily_unavailable', 'source_unavailable'],
        ['other', 'internal_error'],
      ] as const) {
        const started = await start(adminA);
        const state = new URL(started.authorizeUrl).searchParams.get('state');
        await complete(adminA, { state, error }).expect(200);
        expect(await attemptOf(adminA, started.attemptId)).toMatchObject({ status: 'failed', errorCode });
        expect((await row(started.attemptId)).verifierCiphertext).toBeNull();
        await complete(adminA, { state, error }).expect(400);
      }
    });

    it('isolamento: só quem começou vê e escolhe', async () => {
      const ids = [fakeCloudflare.accountId(), fakeCloudflare.accountId()];
      const { attemptId } = await authorized(adminA, { auditAccounts: ids });
      await jobFor().runOnce();
      const colleague = await sessionFor(tenantA);
      for (const session of [adminB, colleague]) {
        await read(session, `/v1/cloudflare-oauth/attempts/${attemptId}`).expect(404);
        await choose(session, attemptId, ids).expect(404);
      }
      expect((await row(attemptId)).chosenAccountIds).toEqual([]);
      expect((await attemptOf(adminA, attemptId)).status).toBe('choosing');
    });
  });

  describe('troca, descoberta e ligação no worker', () => {
    it('uma conta: troca com o PKCE, prova, liga e nada sai em claro', async () => {
      const accountId = fakeCloudflare.accountId();
      const { attemptId, callback } = await authorized(adminA, {
        auditAccounts: [accountId],
        accounts: [{ id: accountId, name: 'Conta\n fictícia ' }],
      });
      expect((await attemptOf(adminA, attemptId)).status).toBe('code_received');
      expect(await jobFor().runOnce()).toMatchObject({ exchanged: 1, linked: 1, failed: 0, choosing: 0 });

      const form = oauth.requests[0];
      expect(form?.get('grant_type')).toBe('authorization_code');
      expect(form?.get('code')).toBe(callback.code);
      expect(form?.get('redirect_uri')).toBe(CONFIG.redirectUri);
      expect(form?.get('client_id')).toBe(CONFIG.clientId);
      secrets.add(form?.get('code_verifier') ?? '');
      const account = await accountBy(accountId);
      expect(account).toMatchObject({
        tenantId: tenantA,
        zones: [],
        status: 'active',
        origin: 'panel',
        connection: 'waiting',
      });
      const attempt = await row(attemptId);
      expect(attempt).toMatchObject({ status: 'done', verifierCiphertext: null, codeCiphertext: null });
      expect(await attemptOf(adminA, attemptId)).toMatchObject({
        status: 'done',
        cloudAccountIds: [account?.id],
      });
      const grant = await grantRow(account?.cloudflareGrantId ?? '');
      expect(grant).toMatchObject({
        status: 'active',
        clientId: CONFIG.clientId,
        scopes: CONFIG.scopes,
        generation: 1,
        consentedBy: adminA.userId,
      });
      const fake = oauth.grants.at(-1);
      secrets.add(fake?.accessToken ?? '').add(fake?.refreshToken ?? '');
      expect(
        openCloudflareOauthTokens(
          keyring,
          { tenantId: tenantA, subjectId: grant?.id ?? '' },
          grant?.ciphertext ?? '',
        ),
      ).toMatchObject({ accessToken: fake?.accessToken, refreshToken: fake?.refreshToken });
      // Fora da memória, o logger não guarda o que já não está em uso.
      expect(scrubString(fake?.refreshToken ?? '')).toBe(fake?.refreshToken);
      // E o coletor lê a conta pelo acesso novo.
      expect(await collectorFor().runOnce()).toMatchObject({ pages: 1, blocked: 0 });
      expect((await accountBy(accountId))?.connection).toBe('connected');
    });

    it('mais de uma: o cliente escolhe, e a que ficou de fora nunca é lida de novo', async () => {
      const [one, two, denied] = [1, 2, 3].map(() => fakeCloudflare.accountId()) as [string, string, string];
      const { attemptId } = await authorized(adminA, {
        auditAccounts: [one, two],
        accounts: [{ id: one, name: 'Um' }, { id: two }, { id: denied, name: 'Sem leitura' }],
      });
      expect(await jobFor().runOnce()).toMatchObject({ exchanged: 1, choosing: 1, linked: 0 });
      const offered = await attemptOf(adminA, attemptId);
      expect(offered).toMatchObject({ status: 'choosing', accountIdRequired: false });
      expect(offered.accounts).toEqual([
        { accountId: one, name: 'Um', state: 'available' },
        { accountId: two, name: null, state: 'available' },
        { accountId: denied, name: 'Sem leitura', state: 'forbidden' },
      ]);
      expect(await accountBy(one)).toBeNull();
      await choose(adminA, attemptId, [denied]).expect(400);
      await choose(adminA, attemptId, [fakeCloudflare.accountId()]).expect(400);
      const accepted = await choose(adminA, attemptId, [one]).expect(202);
      expect(cloudflareOauthAttemptSchema.parse(accepted.body).status).toBe('code_received');
      await choose(adminA, attemptId, [two]).expect(409);

      const before = cloudflare.requests.length;
      expect(await jobFor().runOnce()).toMatchObject({ linked: 1 });
      expect(await accountBy(two)).toBeNull();
      expect((await accountBy(one))?.cloudflareGrantId).toBe((await row(attemptId)).grantId);
      await collectorFor().runOnce();
      expect(
        cloudflare.requests
          .slice(before)
          .some((call) => call.path.includes(two) || call.path.includes(denied)),
      ).toBe(false);
      await choose(adminA, attemptId, [two]).expect(409);
    });

    it.each([
      [
        'sem a renovação',
        () => {
          oauth.noRefresh = true;
        },
        'oauth_no_refresh',
      ],
      [
        'com escopo a menos',
        () => {
          oauth.scope = 'zone.read';
        },
        'oauth_scope_missing',
      ],
      [
        'com escopo a mais',
        () => {
          oauth.scope = 'account-settings.read zone.read zone.write';
        },
        'oauth_scope_unexpected',
      ],
    ] as const)(
      '%s: não conecta, e o que foi emitido é revogado no Cloudflare',
      async (_name, arrange, code) => {
        arrange();
        const accountId = fakeCloudflare.accountId();
        const { attemptId } = await authorized(adminA, { auditAccounts: [accountId] });
        const report = await jobFor().runOnce();
        expect(report).toMatchObject({ failed: 1, linked: 0, revoked: 1 });
        const issued = oauth.grants.at(-1);
        expect(issued?.revoked).toBe(true);
        expect(oauth.revocations).toEqual([oauth.noRefresh ? issued?.accessToken : issued?.refreshToken]);
        expect(await prisma.cloudflareGrant.count({ where: { tenantId: tenantA } })).toBe(0);
        // A tentativa continua legível depois de a concessão sair.
        expect(await attemptOf(adminA, attemptId)).toMatchObject({ status: 'failed', errorCode: code });
        expect(await accountBy(accountId)).toBeNull();
        expect(cloudflare.requests.some((call) => call.path.includes(accountId))).toBe(false);
      },
    );

    it('a resposta fora do formato é revogada na hora', async () => {
      const { attemptId } = await authorized(adminA, {});
      oauth.script.push({
        status: 200,
        body: JSON.stringify({ access_token: 'a b', token_type: 'mac', refresh_token: 'token com espaço' }),
      });
      expect(await jobFor().runOnce()).toMatchObject({ failed: 1 });
      expect(oauth.revocations).toEqual(['token com espaço']);
      expect(await attemptOf(adminA, attemptId)).toMatchObject({ errorCode: 'internal_error' });
    });

    it('a tentativa que vence durante a troca não deixa token sem dono', async () => {
      const accountId = fakeCloudflare.accountId();
      const { attemptId } = await authorized(adminA, { auditAccounts: [accountId] });
      oauth.beforeReply = async () => {
        oauth.beforeReply = undefined;
        await prisma.cloudflareConnectAttempt.update({
          where: { id: attemptId },
          data: { status: 'expired', verifierCiphertext: null, codeCiphertext: null },
        });
      };
      expect(await jobFor().runOnce()).toMatchObject({ exchanged: 1, linked: 0, revoked: 1 });
      expect(oauth.grants.at(-1)?.revoked).toBe(true);
      expect(await prisma.cloudflareGrant.count({ where: { tenantId: tenantA } })).toBe(0);
      expect(await accountBy(accountId)).toBeNull();
    });

    it('a conta excluída durante a troca também não', async () => {
      const account = await tokenAccount();
      await authorized(adminA, { auditAccounts: [account.accountId] }, account.id);
      oauth.beforeReply = async () => {
        oauth.beforeReply = undefined;
        await prisma.cloudAccount.delete({ where: { id: account.id } });
      };
      expect(await jobFor().runOnce()).toMatchObject({ linked: 0, revoked: 1 });
      expect(oauth.grants.at(-1)?.revoked).toBe(true);
      expect(await accountBy(account.accountId)).toBeNull();
    });

    it('a origem fora do ar adia o passo; o código recusado ou o app recusado terminam', async () => {
      const accountId = fakeCloudflare.accountId();
      const first = await authorized(adminA, { auditAccounts: [accountId] });
      oauth.script.push({ dropBefore: true }, { status: 503 });
      let at = Date.now();
      const job = jobFor({ now: () => new Date(at) });
      expect(await job.runOnce()).toMatchObject({ postponed: 1, failed: 0 });
      // A espera vale: nenhuma chamada antes dela.
      expect(await job.runOnce()).toMatchObject({ postponed: 0 });
      expect(oauth.requests).toHaveLength(1);
      at += 6_000;
      expect(await job.runOnce()).toMatchObject({ postponed: 1 });
      at += 11_000;
      expect(await job.runOnce()).toMatchObject({ linked: 1 });
      expect((await row(first.attemptId)).status).toBe('done');

      const limited = await authorized(adminA, { auditAccounts: [fakeCloudflare.accountId()] });
      oauth.script.push({ status: 429, headers: { 'retry-after': '120' } });
      expect(await job.runOnce()).toMatchObject({ postponed: 1 });
      at += 119_000;
      const calls = oauth.requests.length;
      await job.runOnce();
      expect(oauth.requests).toHaveLength(calls);
      at += 2_000;
      expect(await job.runOnce()).toMatchObject({ linked: 1 });
      expect((await row(limited.attemptId)).status).toBe('done');

      // A resposta perdida depois de processada: o código já foi usado, e o reuso derruba o que foi emitido.
      const lost = await authorized(adminA, { auditAccounts: [fakeCloudflare.accountId()] });
      oauth.script.push({ dropAfter: true });
      await job.runOnce();
      at += 6_000;
      await job.runOnce();
      expect(await row(lost.attemptId)).toMatchObject({
        status: 'failed',
        errorCode: 'oauth_code_rejected',
      });
      expect(oauth.grants.at(-1)?.revoked).toBe(true);

      const rejected = await authorized(adminA, {});
      oauth.script.push({ status: 401, body: JSON.stringify({ error: 'invalid_client' }) });
      await job.runOnce();
      expect(await row(rejected.attemptId)).toMatchObject({
        status: 'failed',
        errorCode: 'oauth_client_rejected',
        verifierCiphertext: null,
        codeCiphertext: null,
      });
    });

    it('sem a lista das contas, vale a das zonas; sem as duas, o ID digitado e provado', async () => {
      const byZones = fakeCloudflare.accountId();
      cloudflare.zones.set(byZones, ['b.example.com']);
      await authorized(adminA, { auditAccounts: [byZones], accountsStatus: 403 });
      expect(await jobFor().runOnce()).toMatchObject({ linked: 1 });
      expect(await accountBy(byZones)).not.toBeNull();

      const typed = fakeCloudflare.accountId();
      const wrong = fakeCloudflare.accountId();
      const { attemptId } = await authorized(adminA, {
        auditAccounts: [typed],
        accountsStatus: 403,
        zoneRead: false,
      });
      await jobFor().runOnce();
      expect(await attemptOf(adminA, attemptId)).toMatchObject({
        status: 'choosing',
        accountIdRequired: true,
        accounts: [],
      });
      await choose(adminA, attemptId, [wrong]).expect(202);
      await jobFor().runOnce();
      expect(await attemptOf(adminA, attemptId)).toMatchObject({
        status: 'choosing',
        accountIdRequired: true,
        accounts: [{ accountId: wrong, name: null, state: 'forbidden' }],
      });
      await choose(adminA, attemptId, [typed]).expect(202);
      expect(await jobFor().runOnce()).toMatchObject({ linked: 1 });
      expect((await accountBy(typed))?.tenantId).toBe(tenantA);
      expect(await accountBy(wrong)).toBeNull();
    });

    it('nenhuma conta com leitura da auditoria: falha e revoga', async () => {
      const id = fakeCloudflare.accountId();
      const { attemptId } = await authorized(adminA, { auditAccounts: [], accounts: [{ id }] });
      expect(await jobFor().runOnce()).toMatchObject({ failed: 1, revoked: 1 });
      expect(await row(attemptId)).toMatchObject({ errorCode: 'oauth_no_account', grantId: null });
    });

    it('a descoberta sem resposta é tentada de novo, sem conectar pela metade', async () => {
      const id = fakeCloudflare.accountId();
      const { attemptId } = await authorized(adminA, { auditAccounts: [id] });
      cloudflare.auditScript.push({ status: 500 });
      let at = Date.now();
      const job = jobFor({ now: () => new Date(at) });
      expect(await job.runOnce()).toMatchObject({ exchanged: 1, postponed: 1, linked: 0 });
      expect((await attemptOf(adminA, attemptId)).status).toBe('code_received');
      cloudflare.auditScript.push({ status: 429, headers: { 'retry-after': '30' } });
      at += 6_000;
      expect(await job.runOnce()).toMatchObject({ postponed: 1 });
      at += 29_000;
      expect(await job.runOnce()).toMatchObject({ postponed: 0, linked: 0 });
      at += 2_000;
      expect(await job.runOnce()).toMatchObject({ linked: 1 });
      // Uma troca só: o código vale uma vez.
      expect(oauth.requests).toHaveLength(1);
    });

    it('a conta de outro cliente nunca é ligada nem identificada; a desativada pede para reativar', async () => {
      const ofB = await tokenAccount(tenantB);
      const mine = fakeCloudflare.accountId();
      const { attemptId } = await authorized(adminA, { auditAccounts: [ofB.accountId, mine] });
      await jobFor().runOnce();
      const offered = await attemptOf(adminA, attemptId);
      expect(offered.accounts.find((account) => account.accountId === ofB.accountId)?.state).toBe(
        'forbidden',
      );
      await choose(adminA, attemptId, [ofB.accountId]).expect(400);
      expect(await prisma.cloudCredential.count({ where: { cloudAccountId: ofB.id } })).toBe(1);

      const inactive = await tokenAccount();
      await prisma.cloudAccount.update({ where: { id: inactive.id }, data: { status: 'inactive' } });
      const second = await authorized(adminA, { auditAccounts: [inactive.accountId, mine] });
      await jobFor().runOnce();
      const refused = await choose(adminA, second.attemptId, [inactive.accountId]).expect(409);
      expect(errorOf(refused).code).toBe('CLOUD_ACCOUNT_INACTIVE');
      await authorized(adminA, { auditAccounts: [inactive.accountId] });
      expect(await jobFor().runOnce()).toMatchObject({ failed: 1 });
    });

    it('a conta tomada por outro cliente no meio recusa a ligação inteira, sem mexer em nada', async () => {
      const ids = [fakeCloudflare.accountId(), fakeCloudflare.accountId()] as const;
      const { attemptId } = await authorized(adminA, { auditAccounts: [...ids] });
      await jobFor().runOnce();
      await choose(adminA, attemptId, [...ids]).expect(202);
      const job = jobFor();
      await prisma.forTenant(tenantB).cloudAccount.create({
        data: { tenantId: tenantB, provider: 'cloudflare', accountId: ids[1], regions: [] },
      });
      await job.runOnce();
      expect(await accountBy(ids[0])).toBeNull();
      expect((await accountBy(ids[1]))?.tenantId).toBe(tenantB);
      expect((await row(attemptId)).status).toBe('choosing');
    });

    it('a ligação recusa a conta de outro cliente sem tocar nela', async () => {
      const ofB = await tokenAccount(tenantB);
      const mine = fakeCloudflare.accountId();
      const { attemptId } = await authorized(adminA, {
        auditAccounts: [mine, fakeCloudflare.accountId()],
      });
      await jobFor().runOnce();
      const { grantId } = await row(attemptId);
      await expect(
        linkAccounts(
          { prisma, plans: fixedTenantPlans(resolvePlan('interno')), audit: new AuditService() },
          { tenantId: tenantA, attemptId, grantId: grantId ?? '', accountIds: [mine, ofB.accountId] },
          new Date(),
        ),
      ).rejects.toMatchObject({ code: 'account_exists' });
      expect(await accountBy(mine)).toBeNull();
      expect(await accountBy(ofB.accountId)).toMatchObject({ tenantId: tenantB, cloudflareGrantId: null });
      expect(await prisma.cloudCredential.count({ where: { cloudAccountId: ofB.id } })).toBe(1);
      expect((await row(attemptId)).status).toBe('choosing');
    });

    it('sem vaga no plano: a API avisa antes, e o worker garante', async () => {
      const ids = [1, 2, 3].map(() => fakeCloudflare.accountId());
      const { attemptId } = await authorized(adminA, { auditAccounts: ids });
      await jobFor().runOnce();
      await prisma.forTenant(tenantA).cloudAccount.createMany({
        data: Array.from({ length: 198 }, () => ({
          tenantId: tenantA,
          provider: 'cloudflare' as const,
          accountId: fakeCloudflare.accountId(),
          regions: [],
        })),
      });
      const refused = await choose(adminA, attemptId, ids).expect(409);
      expect(errorOf(refused).code).toBe('PLAN_LIMIT_REACHED');
      await choose(adminA, attemptId, ids.slice(0, 2)).expect(202);
      // O plano do worker é menor: nada é ligado pela metade.
      expect(await jobFor({}, resolvePlan('essencial')).runOnce()).toMatchObject({ failed: 1, linked: 0 });
      expect(await row(attemptId)).toMatchObject({ errorCode: 'plan_limit_reached' });
      for (const id of ids) expect(await accountBy(id)).toBeNull();
    });

    it('um worker por vez', async () => {
      const { attemptId } = await authorized(adminA, { auditAccounts: [fakeCloudflare.accountId()] });
      const jobs = [jobFor({ name: 'cf-connect-unico' }), jobFor({ name: 'cf-connect-unico' })];
      const reports = await Promise.all(jobs.map((job) => job.runOnce()));
      expect(reports.map((report) => report.status).sort()).toEqual(['done', 'locked']);
      expect(oauth.requests).toHaveLength(1);
      expect((await row(attemptId)).status).toBe('done');
    });

    it('a gravação que falha e volta não perde a autorização; a que não volta é revogada', async () => {
      const id = fakeCloudflare.accountId();
      await authorized(adminA, { auditAccounts: [id] });
      const real = prisma.$transaction.bind(prisma);
      let failures = 2;
      const spy = vi.spyOn(prisma, '$transaction').mockImplementation(((...args: unknown[]) => {
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(new Error('banco fora do ar'));
        }
        return (real as unknown as (...inner: unknown[]) => unknown)(...args);
      }) as never);
      try {
        expect(await jobFor().runOnce()).toMatchObject({ exchanged: 1, linked: 1 });
        await authorized(adminA, { auditAccounts: [fakeCloudflare.accountId()] });
        failures = 3;
        expect(await jobFor().runOnce()).toMatchObject({ exchanged: 0, postponed: 1 });
        expect(oauth.grants.at(-1)?.revoked).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('migração do token colado', () => {
    it('só depois da prova: o token sai, e cursores, zonas e achados ficam intactos', async () => {
      const account = await tokenAccount(tenantA, []);
      const entry = entryFactory(account.accountId);
      const when = new Date(Date.now() - 20 * MINUTE).toISOString();
      cloudflare.addAudit(account.accountId, {
        at: when,
        entry: entry({ id: `m-${hex(4)}`, time: when, method: 'DELETE', uri: `/zones/${hex(16)}` }),
      });
      const collector = collectorFor();
      await prisma.collectorCursor.create({
        data: {
          cloudAccountId: account.id,
          stream: CLOUDFLARE_CHECK_STREAM,
          nextRunAt: new Date('2100-01-01'),
        },
      });
      await collector.runOnce();
      await prisma.cloudAccount.update({ where: { id: account.id }, data: { zones: ['a.example.com'] } });
      const state = async () => ({
        cursors: await prisma.collectorCursor.findMany({
          where: { cloudAccountId: account.id },
          orderBy: { stream: 'asc' },
        }),
        findings: await prisma.finding.findMany({
          where: { source: 'cloudflare', accountId: account.accountId },
          orderBy: { id: 'asc' },
        }),
        zones: (await accountBy(account.accountId))?.zones,
      });
      const before = await state();
      expect(before.findings).toHaveLength(1);

      const { attemptId } = await authorized(adminA, { auditAccounts: [account.accountId] }, account.id);
      // Até a ligação, o token colado continua no cofre.
      expect(await prisma.cloudCredential.count({ where: { cloudAccountId: account.id } })).toBe(1);
      expect(await jobFor().runOnce()).toMatchObject({ linked: 1 });
      expect(await state()).toEqual(before);
      expect(await prisma.cloudCredential.count({ where: { cloudAccountId: account.id } })).toBe(0);
      const migrated = await accountBy(account.accountId);
      expect(migrated).toMatchObject({ id: account.id, connection: 'waiting', zones: ['a.example.com'] });
      expect(migrated?.cloudflareGrantId).toBe((await row(attemptId)).grantId);
      const audits = await prisma.auditLog.findMany({
        where: {
          tenantId: tenantA,
          resourceId: account.id,
          action: { in: ['cloud_credential.wipe', 'cloud_account.cloudflare_connect'] },
        },
      });
      expect(audits.map((entryOf) => entryOf.action).sort()).toEqual([
        'cloud_account.cloudflare_connect',
        'cloud_credential.wipe',
      ]);

      // A leitura segue do cursor, sem duplicar nem perder.
      await prisma.collectorCursor.updateMany({
        where: { cloudAccountId: account.id, stream: CLOUDFLARE_AUDIT_STREAM },
        data: { nextRunAt: new Date(Date.now() - 1_000) },
      });
      expect(await collectorFor().runOnce()).toMatchObject({ pages: 1 });
      expect((await state()).findings).toEqual(before.findings);
    });

    it('com uma leitura pelo token em curso, ela termina, e a seguinte não duplica nem perde nada', async () => {
      const account = await tokenAccount(tenantA, []);
      await prisma.collectorCursor.create({
        data: {
          cloudAccountId: account.id,
          stream: CLOUDFLARE_CHECK_STREAM,
          nextRunAt: new Date('2100-01-01'),
        },
      });
      const entry = entryFactory(account.accountId);
      const when = new Date(Date.now() - 20 * MINUTE).toISOString();
      cloudflare.addAudit(account.accountId, {
        at: when,
        entry: entry({ id: `l-${hex(4)}`, time: when, method: 'DELETE', uri: `/zones/${hex(16)}` }),
      });
      await authorized(adminA, { auditAccounts: [account.accountId] }, account.id);
      // A leitura do coletor fica presa na origem enquanto a ligação acontece (as provas não usam o roteiro dele).
      cloudflare.auditScript.push({ status: 200, pass: true, delayMs: 900 });
      const reading = collectorFor().runOnce();
      await vi.waitFor(() => expect(cloudflare.auditScript).toHaveLength(0));
      expect(await jobFor().runOnce()).toMatchObject({ linked: 1 });
      await reading;
      // O evento lido pelo token conta como atividade (a regra de sempre, `LastEvents`); nenhum erro é herdado.
      expect(await accountBy(account.accountId)).toMatchObject({ connectionError: null });
      const findings = () =>
        prisma.finding.findMany({ where: { source: 'cloudflare', accountId: account.accountId } });
      expect(await findings()).toHaveLength(1);
      await prisma.collectorCursor.updateMany({
        where: { cloudAccountId: account.id, stream: CLOUDFLARE_AUDIT_STREAM },
        data: { nextRunAt: new Date(Date.now() - 1_000) },
      });
      await collectorFor().runOnce();
      expect(await findings()).toHaveLength(1);
      expect((await accountBy(account.accountId))?.connection).toBe('connected');
    });

    it('a leitura pelo token que falha no meio não passa o erro para a conexão nova', async () => {
      const account = await tokenAccount(tenantA, []);
      await prisma.collectorCursor.create({
        data: {
          cloudAccountId: account.id,
          stream: CLOUDFLARE_CHECK_STREAM,
          nextRunAt: new Date('2100-01-01'),
        },
      });
      await authorized(adminA, { auditAccounts: [account.accountId] }, account.id);
      cloudflare.auditScript.push({ status: 200, hang: true });
      const reading = collectorFor().runOnce();
      await vi.waitFor(() => expect(cloudflare.auditScript).toHaveLength(0));
      expect(await jobFor().runOnce()).toMatchObject({ linked: 1 });
      expect(await reading).toMatchObject({ failedAccounts: 1 });
      expect(await accountBy(account.accountId)).toMatchObject({
        connection: 'waiting',
        connectionError: null,
      });
    });

    it.each([
      ['a conta autorizada é outra', 'oauth_account_mismatch'],
      ['sem a leitura da auditoria', 'oauth_no_account'],
    ])('%s: fica tudo no token colado, e a autorização é revogada', async (_name, code) => {
      const account = await tokenAccount();
      const other = fakeCloudflare.accountId();
      const { attemptId } = await authorized(
        adminA,
        code === 'oauth_account_mismatch'
          ? { auditAccounts: [other] }
          : { auditAccounts: [], accounts: [{ id: account.accountId }] },
        account.id,
      );
      expect(await jobFor().runOnce()).toMatchObject({ failed: 1, linked: 0, revoked: 1 });
      expect(await row(attemptId)).toMatchObject({ errorCode: code });
      expect(await prisma.cloudCredential.count({ where: { cloudAccountId: account.id } })).toBe(1);
      expect((await accountBy(account.accountId))?.cloudflareGrantId).toBeNull();
      expect(await accountBy(other)).toBeNull();
    });
  });

  describe('reconexão', () => {
    it('move a conta e as que dividiam a concessão e foram autorizadas; a antiga, vazia, é revogada', async () => {
      const ids = [fakeCloudflare.accountId(), fakeCloudflare.accountId()];
      const old = await connected(tenantA, ids, { status: 'reconnect' });
      const { attemptId } = await authorized(adminA, { auditAccounts: ids }, old.accounts[0]?.id);
      expect(await jobFor().runOnce()).toMatchObject({ linked: 2, revoked: 1 });
      const { grantId } = await row(attemptId);
      expect(grantId).not.toBe(old.id);
      for (const id of ids) {
        expect(await accountBy(id)).toMatchObject({
          cloudflareGrantId: grantId,
          connection: 'waiting',
          connectionError: null,
        });
      }
      expect(await grantRow(old.id)).toBeNull();
      expect(oauth.revocations).toEqual([old.fake.refreshToken]);
      expect(await collectorFor().runOnce()).toMatchObject({ blocked: 0, pages: 2 });
    });

    it('a que não foi autorizada fica na concessão antiga, que continua viva', async () => {
      const [kept, moved] = [fakeCloudflare.accountId(), fakeCloudflare.accountId()];
      const old = await connected(tenantA, [kept, moved]);
      const target = old.accounts.find((account) => account.accountId === moved);
      await authorized(adminA, { auditAccounts: [moved] }, target?.id);
      expect(await jobFor().runOnce()).toMatchObject({ linked: 1, revoked: 0 });
      expect((await accountBy(kept))?.cloudflareGrantId).toBe(old.id);
      expect(await grantRow(old.id)).toMatchObject({ status: 'active' });
    });

    it('um resultado da leitura anterior não alcança a conexão nova', async () => {
      const id = fakeCloudflare.accountId();
      const old = await connected(tenantA, [id]);
      const grants = new CloudflareGrants(prisma, keyring, {
        refresh: () => Promise.reject(new Error('não chamado')),
      });
      await authorized(adminA, { auditAccounts: [id] }, old.accounts[0]?.id);
      await jobFor().runOnce();
      await grants.reject({ tenantId: tenantA, grantId: old.id }, 1, 'credential_rejected');
      const account = await accountBy(id);
      expect(await grantRow(account?.cloudflareGrantId ?? '')).toMatchObject({ status: 'active' });
    });
  });

  describe('soltar e revogar', () => {
    it.each([
      ['desativar (DELETE)', (id: string) => write(adminA, 'delete', `/v1/cloud-accounts/${id}`).expect(204)],
      [
        'desativar (PATCH)',
        (id: string) =>
          write(adminA, 'patch', `/v1/cloud-accounts/${id}`).send({ status: 'inactive' }).expect(200),
      ],
      [
        'excluir',
        async (id: string) => {
          const { accountId } = await prisma.cloudAccount.findUniqueOrThrow({ where: { id } });
          return write(adminA, 'post', `/v1/cloud-accounts/${id}/delete`)
            .send({ confirmAccountId: accountId })
            .expect(204);
        },
      ],
    ])('%s solta a concessão; só a última conta a revoga', async (_name, act) => {
      const grant = await connected(tenantA, [fakeCloudflare.accountId(), fakeCloudflare.accountId()]);
      const [first, second] = grant.accounts;
      await act(first?.id ?? '');
      expect(await grantRow(grant.id)).toMatchObject({ status: 'active' });
      await jobFor().runOnce();
      expect(oauth.revocations).toEqual([]);
      const response = await act(second?.id ?? '');
      expect(await grantRow(grant.id)).toMatchObject({ status: 'revoking' });
      const actions = (
        await prisma.auditLog.findMany({ where: { requestId: response.headers['x-request-id'] } })
      ).map((entry) => entry.action);
      expect(actions).toContain('cloudflare_grant.release');
      expect(await jobFor().runOnce()).toMatchObject({ revoked: 1 });
      expect(oauth.revocations).toEqual([grant.fake.refreshToken]);
      expect(await grantRow(grant.id)).toBeNull();
      expect(
        await prisma.auditLog.count({
          where: { tenantId: tenantA, action: 'cloudflare_grant.revoke', resourceId: grant.id },
        }),
      ).toBe(1);
    });

    it('com o OAuth desligado depois, o token colado toma o lugar e solta a concessão', async () => {
      const id = fakeCloudflare.accountId();
      const grant = await connected(tenantA, [id]);
      settings.current = () => Promise.resolve(null);
      const token = cloudflare.readableAccountToken(id);
      secrets.add(token);
      await write(adminA, 'put', `/v1/cloud-accounts/${grant.accounts[0]?.id}/credential`)
        .send({ kind: 'cloudflare_api_token', token })
        .expect(200);
      expect((await accountBy(id))?.cloudflareGrantId).toBeNull();
      // A revogação roda com o OAuth desligado.
      expect(await jobFor().runOnce()).toMatchObject({ revoked: 1 });
    });

    it('tenta de novo com espera e, depois de 24 h, apaga só no nó', async () => {
      const grant = await connected(tenantA, [], { status: 'revoking', revokeRequestedAt: new Date() });
      let at = Date.now();
      const job = jobFor({ now: () => new Date(at) });
      oauth.revokeScript.push({ status: 503 }, { status: 503 }, { status: 503 });
      expect(await job.runOnce()).toMatchObject({ revoked: 0, revokeFailed: 1, abandoned: 0 });
      expect(await job.runOnce()).toMatchObject({ revokeFailed: 0 });
      at += MINUTE + 1;
      expect(await job.runOnce()).toMatchObject({ revokeFailed: 1 });
      at = Date.now() + CLOUDFLARE_REVOKE_GIVE_UP_MS + MINUTE;
      expect(await job.runOnce()).toMatchObject({ revokeFailed: 1, abandoned: 1 });
      expect(await grantRow(grant.id)).toBeNull();
      expect(
        await prisma.auditLog.findFirstOrThrow({
          where: { tenantId: tenantA, action: 'cloudflare_grant.abandon', resourceId: grant.id },
        }),
      ).toMatchObject({ outcome: 'failure' });
    });

    it('o token que o Cloudflare diz que já não vale conta como revogado', async () => {
      const grant = await connected(tenantA, [], { status: 'revoking', revokeRequestedAt: new Date() });
      oauth.revokeScript.push({ status: 400, body: JSON.stringify({ error: 'invalid_grant' }) });
      expect(await jobFor().runOnce()).toMatchObject({ revoked: 1 });
      expect(await grantRow(grant.id)).toBeNull();
    });

    it('espera a renovação em curso, e o token trocado no meio é revogado na passada seguinte', async () => {
      const grant = await connected(tenantA, [], { status: 'revoking', revokeRequestedAt: new Date() });
      await prisma.cloudflareGrant.update({
        where: { id: grant.id },
        data: { refreshStartedAt: new Date() },
      });
      expect(await jobFor().runOnce()).toMatchObject({ revoked: 0, revokeFailed: 0 });
      expect(oauth.revocations).toEqual([]);
      await prisma.cloudflareGrant.update({ where: { id: grant.id }, data: { refreshStartedAt: null } });
      const next = oauth.grant({});
      next.clientId = grant.fake.clientId;
      secrets.add(next.accessToken).add(next.refreshToken);
      oauth.beforeReply = async () => {
        oauth.beforeReply = undefined;
        await prisma.cloudflareGrant.update({
          where: { id: grant.id },
          data: {
            generation: 2,
            ciphertext: sealCloudflareOauthTokens(
              publicKey,
              { tenantId: tenantA, subjectId: grant.id },
              {
                accessToken: next.accessToken,
                refreshToken: next.refreshToken,
                accessExpiresAt: new Date(Date.now() + MINUTE),
              },
            ),
          },
        });
      };
      expect(await jobFor().runOnce()).toMatchObject({ revoked: 0 });
      expect(await grantRow(grant.id)).toMatchObject({ generation: 2 });
      expect(await jobFor().runOnce()).toMatchObject({ revoked: 1 });
      expect(oauth.revocations).toEqual([grant.fake.refreshToken, next.refreshToken]);
    });

    it('a renovação que amplia os escopos pede a reconexão, e os tokens dela são revogados', async () => {
      const id = fakeCloudflare.accountId();
      const grant = await connected(tenantA, [id]);
      await prisma.cloudflareGrant.update({
        where: { id: grant.id },
        data: { clientId: grant.fake.clientId },
      });
      const expired = new Date(Date.now() - MINUTE);
      await prisma.cloudflareGrant.update({
        where: { id: grant.id },
        data: {
          accessExpiresAt: expired,
          ciphertext: sealCloudflareOauthTokens(
            publicKey,
            { tenantId: tenantA, subjectId: grant.id },
            {
              accessToken: grant.fake.accessToken,
              refreshToken: grant.fake.refreshToken,
              accessExpiresAt: expired,
            },
          ),
        },
      });
      oauth.scope = 'account-settings.read zone.read zone.write';
      expect(await collectorFor().runOnce()).toMatchObject({ blocked: 1 });
      expect(await grantRow(grant.id)).toMatchObject({ status: 'reconnect' });
      secrets.add(grant.fake.accessToken).add(grant.fake.refreshToken);
      oauth.scope = undefined;
      expect(await jobFor().runOnce()).toMatchObject({ revoked: 1 });
      expect(oauth.revocations).toEqual([grant.fake.refreshToken]);
      expect(grant.fake.revoked).toBe(true);
      expect(await prisma.cloudflareGrant.count({ where: { tenantId: tenantA } })).toBe(1);
    });

    it('excluir a conta e ligar ou renovar ao mesmo tempo não trava nem deixa token sem dono', async () => {
      for (let round = 0; round < 6; round += 1) {
        const account = await tokenAccount();
        await authorized(adminA, { auditAccounts: [account.accountId] }, account.id);
        const [, deleted] = await Promise.all([
          jobFor().runOnce(),
          write(adminA, 'post', `/v1/cloud-accounts/${account.id}/delete`).send({
            confirmAccountId: account.accountId,
          }),
        ]);
        expect(deleted.status).toBe(204);
        expect(await accountBy(account.accountId)).toBeNull();
        await jobFor().runOnce();
        // O que sobrou, se sobrou, é uma concessão sem conta: em revogação ou à espera da faxina (1 h).
        const left = await prisma.cloudflareGrant.findMany({
          where: { tenantId: tenantA },
          select: { status: true, _count: { select: { cloudAccounts: true } } },
        });
        for (const grant of left) expect(grant._count.cloudAccounts).toBe(0);
        await prisma.cloudflareGrant.deleteMany({ where: { tenantId: tenantA } });
      }
    });

    it('a ordem dos locks é a mesma: quem segura a credencial não trava quem segura a concessão', async () => {
      const id = fakeCloudflare.accountId();
      const grant = await connected(tenantA, [id]);
      const account = grant.accounts[0]?.id ?? '';
      const results = await Promise.allSettled([
        prisma.$transaction(async (tx) => {
          await lockCredential(tx, account);
          await new Promise((resolve) => setTimeout(resolve, 100));
          await lockGrant(tx, grant.id);
        }),
        write(adminA, 'delete', `/v1/cloud-accounts/${account}`).expect(204),
        jobFor().runOnce(),
      ]);
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    });
  });

  it('nada de código, verificador ou token em log, trilha, resposta ou coluna em claro', async () => {
    const accountId = fakeCloudflare.accountId();
    const { attemptId } = await authorized(adminA, { auditAccounts: [accountId] });
    await jobFor().runOnce();
    const fake = oauth.grants.at(-1);
    secrets.add(fake?.accessToken ?? '').add(fake?.refreshToken ?? '');
    for (const form of oauth.requests) {
      for (const key of ['code', 'code_verifier', 'refresh_token']) secrets.add(form.get(key) ?? '');
    }
    const mine = { tenantId: { in: [tenantA, tenantB] } };
    const haystack = [
      capture.text,
      warnings.join('\n'),
      bodies.join('\n'),
      JSON.stringify(await prisma.auditLog.findMany({ where: mine })),
      JSON.stringify(await prisma.cloudflareConnectAttempt.findMany({ where: mine })),
      JSON.stringify(await prisma.cloudflareGrant.findMany({ where: mine })),
      JSON.stringify(await prisma.cloudAccount.findMany({ where: mine })),
    ].join('\n');
    expect((await row(attemptId)).status).toBe('done');
    for (const secret of secrets) {
      if (secret.length >= 8) expect(haystack.includes(secret)).toBe(false);
    }
  });
});
