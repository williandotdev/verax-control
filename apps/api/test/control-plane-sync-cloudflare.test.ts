import 'reflect-metadata';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import {
  type CloudflareOauthConfig,
  NODE_SYNC_CAPABILITIES,
  type NodeSyncDesiredSource,
  type NodeSyncRequest,
  nodeSyncRequestSchema,
  resolvePlan,
} from '@verax/shared';
import { sealCloudflareOauthTokens } from '@verax/vault-envelope';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { ControlPlaneNodeKey } from '../src/common/config/control-plane-sync.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { SyncLogger } from '../src/control-plane-sync/apply-source.js';
import {
  CLOUDFLARE_OAUTH_REFUSED_MS,
  ControlPlaneSync,
  type ControlPlaneSyncOptions,
} from '../src/control-plane-sync/control-plane-sync.js';
import type { SourceCredentialChecks } from '../src/control-plane-sync/credential-checks.js';
import { parsePrivateKeys, type VaultKeyring } from '../src/credentials/credential-keys.js';
import { CloudflareToken, credentialBinding, seal } from '../src/credentials/credential-vault.js';
import { fixedTenantPlans } from '../src/plan/tenant-plan.js';
import { ControlPlaneSyncRowLock } from './support/control-plane-sync-lock.js';

/** Versão da chave do nó, exclusiva deste arquivo: os arquivos rodam em paralelo no mesmo banco. */
const KEY_VERSION = 931;
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const ORIGIN = 'https://conta.exemplo.com.br';
const START = new Date('2026-11-25T12:00:00.000Z');
const MINUTE = 60_000;
const CONFIG: CloudflareOauthConfig = {
  clientId: 'appdeteste0000000001',
  redirectUri: `${ORIGIN}/v1/public/cloudflare/callback`,
  scopes: ['account-settings.read', 'zone.read', 'offline_access'],
};
const cloudflareId = () => randomBytes(16).toString('hex');

/** O que o plano de controle responde, e o que ele recebeu. */
class FakeControlPlane {
  readonly received: NodeSyncRequest[] = [];
  /** O plano de controle anterior: 400 à capacidade que não conhece. */
  legacy = false;
  refuseAll = false;
  /** 400 com este relógio. */
  badRequestDate: Date | undefined;
  rejected = 0;
  sources: NodeSyncDesiredSource[] = [];
  /** A seção: ausente (`undefined`), desligada (null) ou a configuração. */
  cloudflareOauth: CloudflareOauthConfig | null | undefined;

  readonly fetch: typeof fetch = (_input, init) => {
    const body = JSON.parse(init?.body as string) as NodeSyncRequest;
    const bad = (headers: Record<string, string> = {}) => {
      this.rejected += 1;
      return Promise.resolve(new Response('{"error":"invalid_request"}', { status: 400, headers }));
    };
    if (this.refuseAll) return bad();
    if (this.badRequestDate !== undefined) return bad({ date: this.badRequestDate.toUTCString() });
    const known: readonly string[] = this.legacy
      ? NODE_SYNC_CAPABILITIES.filter((capability) => capability !== 'cloudflare_oauth')
      : NODE_SYNC_CAPABILITIES;
    if (body.capabilities.some((capability) => !known.includes(capability))) return bad();
    this.received.push(nodeSyncRequestSchema.parse(body));
    return Promise.resolve(
      Response.json({
        protocol: 1,
        generation: 1,
        pollAfterSeconds: 300,
        sources: this.sources,
        users: [],
        ...(body.capabilities.includes('cloudflare_oauth') &&
          this.cloudflareOauth !== undefined && { cloudflareOauth: this.cloudflareOauth }),
      }),
    );
  };

  reset(): void {
    this.received.length = 0;
    this.legacy = false;
    this.refuseAll = false;
    this.badRequestDate = undefined;
    this.rejected = 0;
    this.sources = [];
    this.cloudflareOauth = undefined;
  }
}

describe('sincronização com o plano de controle: conexão do Cloudflare por OAuth', () => {
  const cp = new FakeControlPlane();
  const prisma = new PrismaService({ DATABASE_URL: inject('testDatabaseUrl') });
  /** A linha de `ControlPlaneSync` é do banco inteiro: um teste por vez entre os arquivos da tarefa. */
  const rowLock = new ControlPlaneSyncRowLock(inject('testDatabaseUrl'));
  const lines: { level: string; fields: object; message: string }[] = [];
  const logger: SyncLogger = {
    info: (fields, message) => lines.push({ level: 'info', fields, message }),
    warn: (fields, message) => lines.push({ level: 'warn', fields, message }),
    error: (fields, message) => lines.push({ level: 'error', fields, message }),
  };
  let keyring: VaultKeyring;
  let tenantId: string;
  /** Os clientes criados aqui: a limpeza é só deles. */
  const tenantIds: string[] = [];
  let clock: Date;
  let checked: number;

  const checks: SourceCredentialChecks = {
    check: () => {
      checked += 1;
      return Promise.resolve({ keyIdSuffix: 'c0de', issuedAt: null, expiresAt: null });
    },
  };

  beforeAll(() => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const pem = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
    keyring = parsePrivateKeys(`${KEY_VERSION}:${pem}`, KEY_VERSION);
  });

  beforeEach(async () => {
    await rowLock.acquire();
    cp.reset();
    lines.length = 0;
    clock = START;
    checked = 0;
    const tenant = await prisma.tenant.create({
      data: { name: 'Cliente Demo A (OAuth na sincronização)' },
    });
    tenantId = tenant.id;
    tenantIds.push(tenantId);
    await prisma.controlPlaneSync.deleteMany({});
  });

  afterEach(async () => {
    // A configuração ligada não pode ficar para os outros arquivos.
    await prisma.controlPlaneSync.deleteMany({});
    await rowLock.release();
  });

  afterAll(async () => {
    const mine = { tenantId: { in: tenantIds } };
    await prisma.cloudCredential.deleteMany({ where: mine });
    await prisma.cloudAccount.deleteMany({ where: mine });
    await prisma.cloudflareGrant.deleteMany({ where: mine });
    await prisma.$disconnect();
  });

  function syncFor(overrides: Partial<ControlPlaneSyncOptions> = {}) {
    return new ControlPlaneSync(prisma, {
      config: {
        origin: ORIGIN,
        url: `${ORIGIN}/v1/node-sync`,
        commit: COMMIT,
        users: true,
        credential: { kind: 'node_key', key: new ControlPlaneNodeKey('a'.repeat(43)) },
      },
      platform: 'gcp',
      keyring,
      node: {
        egressIps: ['203.0.113.10/32'],
        serviceAccountId: '123456789012345678901',
        audience: 'https://verax.exemplo.com.br',
      },
      plans: fixedTenantPlans(resolvePlan('interno')),
      checks,
      announceCloudflareOauth: true,
      logger,
      fetch: cp.fetch,
      now: () => clock,
      random: () => 0.5,
      tenants: () => Promise.resolve([tenantId]),
      ...overrides,
    });
  }
  const run = (sync: ControlPlaneSync) => sync.runOnce(new AbortController().signal);
  const stored = async () =>
    (await prisma.controlPlaneSync.findUniqueOrThrow({ where: { id: 'node' } })).cloudflareOauth;
  const later = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };

  function source(revision = 1): NodeSyncDesiredSource {
    return {
      id: randomUUID(),
      revision,
      state: 'active',
      spec: { provider: 'cloudflare', accountId: cloudflareId(), zones: [] },
      credential: null,
    };
  }
  function withToken(of: NodeSyncDesiredSource, revision = 1): NodeSyncDesiredSource {
    const binding = credentialBinding(
      { id: of.id, tenantId, provider: 'cloudflare', accountId: of.spec.accountId },
      'cloudflare_api_token',
    );
    const value = new CloudflareToken(`token-de-teste-${randomBytes(16).toString('hex')}`);
    const { ciphertext } = seal(keyring.publicKey(), binding, value);
    return { ...of, credential: { revision, kind: 'cloudflare_api_token', envelope: ciphertext } };
  }
  async function connectByOauth(cloudAccountId: string) {
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 60 * MINUTE);
    await prisma.forTenant(tenantId).cloudflareGrant.create({
      data: {
        id,
        tenantId,
        clientId: CONFIG.clientId,
        ciphertext: sealCloudflareOauthTokens(
          keyring.publicKey(),
          { tenantId, subjectId: id },
          { accessToken: 'a'.repeat(32), refreshToken: 'r'.repeat(32), accessExpiresAt: expiresAt },
        ),
        keyVersion: KEY_VERSION,
        accessExpiresAt: expiresAt,
        scopes: CONFIG.scopes,
        consentedAt: new Date(),
        consentedBy: 'usuario-de-teste',
      },
    });
    await prisma.cloudAccount.update({ where: { id: cloudAccountId }, data: { cloudflareGrantId: id } });
    await prisma.cloudCredential.deleteMany({ where: { cloudAccountId } });
    return id;
  }
  const credentialItem = (id: string) =>
    prisma.controlPlaneSyncItem.findUnique({
      where: { kind_itemId: { kind: 'log_source_credential', itemId: id } },
    });

  it('sem a opção, a capacidade não é anunciada nem a configuração guardada', async () => {
    cp.cloudflareOauth = CONFIG;
    await run(syncFor({ announceCloudflareOauth: false }));
    expect(cp.received[0]?.capabilities).toEqual(['log_sources', 'users']);
    expect(await stored()).toBeNull();
  });

  it('guarda a configuração que vier; a seção que falta mantém a última; null desliga', async () => {
    const sync = syncFor();
    cp.cloudflareOauth = CONFIG;
    await run(sync);
    expect(cp.received[0]?.capabilities).toEqual(['log_sources', 'users', 'cloudflare_oauth']);
    expect(await stored()).toEqual(CONFIG);
    cp.cloudflareOauth = undefined;
    later(6 * MINUTE);
    await run(sync);
    expect(cp.received).toHaveLength(2);
    expect(await stored()).toEqual(CONFIG);
    cp.cloudflareOauth = null;
    later(6 * MINUTE);
    await run(sync);
    expect(await stored()).toBeNull();
  });

  it('o retorno de outro endereço desliga, com erro no log', async () => {
    cp.cloudflareOauth = {
      ...CONFIG,
      redirectUri: 'https://outra.exemplo.com.br/v1/public/cloudflare/callback',
    };
    await run(syncFor());
    expect(await stored()).toBeNull();
    expect(lines.find((line) => line.level === 'error')?.fields).toEqual({
      code: 'cloudflare_oauth_redirect_mismatch',
    });
  });

  it('um escopo que não é de leitura recusa a resposta inteira, e a última configuração fica', async () => {
    const sync = syncFor();
    cp.cloudflareOauth = CONFIG;
    await run(sync);
    cp.cloudflareOauth = { ...CONFIG, scopes: ['zone.write', 'offline_access'] };
    later(6 * MINUTE);
    expect(await run(sync)).toMatchObject({ error: 'invalid_response' });
    expect(await stored()).toEqual(CONFIG);
  });

  it('com um plano de controle anterior (400), refaz sem a capacidade: as fontes seguem, sem insistir por 1 h', async () => {
    cp.legacy = true;
    const desired = withToken(source());
    cp.sources = [desired];
    const sync = syncFor();
    expect(await run(sync)).toMatchObject({ error: null, roundTrips: 2, changed: 1, failed: 0 });
    expect(cp.rejected).toBe(1);
    expect(cp.received[0]?.capabilities).toEqual(['log_sources', 'users']);
    expect(await prisma.cloudAccount.count({ where: { id: desired.id, tenantId } })).toBe(1);
    expect(await prisma.cloudCredential.count({ where: { cloudAccountId: desired.id } })).toBe(1);
    expect(await stored()).toBeNull();

    later(6 * MINUTE);
    expect(await run(sync)).toMatchObject({ error: null });
    expect(cp.rejected).toBe(1);
    // O plano de controle subiu: depois da espera, a capacidade volta.
    cp.legacy = false;
    cp.cloudflareOauth = CONFIG;
    later(CLOUDFLARE_OAUTH_REFUSED_MS);
    await run(sync);
    expect(cp.received.at(-1)?.capabilities).toContain('cloudflare_oauth');
    expect(await stored()).toEqual(CONFIG);
  });

  it('o 400 que não é da capacidade continua falha, com no máximo duas chamadas; o do relógio, uma', async () => {
    cp.refuseAll = true;
    expect(await run(syncFor())).toMatchObject({ error: 'bad_request', roundTrips: 2 });
    expect(cp.rejected).toBe(2);
    await prisma.controlPlaneSync.deleteMany({});
    cp.reset();
    cp.badRequestDate = new Date(START.getTime() + 30 * MINUTE);
    expect(await run(syncFor())).toMatchObject({ error: 'bad_request', roundTrips: 1 });
    expect(cp.rejected).toBe(1);
  });

  it('o plano de controle que volta de versão não derruba as conexões nem apaga a configuração', async () => {
    const sync = syncFor();
    cp.cloudflareOauth = CONFIG;
    const desired = source();
    cp.sources = [desired];
    await run(sync);
    const grantId = await connectByOauth(desired.id);
    cp.legacy = true;
    later(6 * MINUTE);
    expect(await run(sync)).toMatchObject({ error: null });
    expect(await stored()).toEqual(CONFIG);
    expect(await prisma.cloudAccount.findUniqueOrThrow({ where: { id: desired.id } })).toMatchObject({
      cloudflareGrantId: grantId,
      status: 'active',
    });
  });

  it('com o OAuth ligado, o token novo do console é recusado sem conferir; o já aplicado segue', async () => {
    const sync = syncFor();
    const existing = withToken(source());
    cp.sources = [existing];
    await run(sync);
    expect(checked).toBe(1);
    cp.cloudflareOauth = CONFIG;
    const fresh = withToken(source());
    cp.sources = [existing, fresh];
    later(6 * MINUTE);
    expect(await run(sync)).toMatchObject({ failed: 1 });
    expect(checked).toBe(1);
    expect(await credentialItem(fresh.id)).toMatchObject({
      outcome: 'failed',
      code: 'credential_kind_not_allowed',
      nextAttemptAt: null,
    });
    expect(await credentialItem(existing.id)).toMatchObject({ outcome: 'applied' });
    expect(await prisma.cloudCredential.count({ where: { cloudAccountId: existing.id } })).toBe(1);
    // Um token de revisão nova na mesma conta também é novo: o guardado continua.
    cp.sources = [withToken(existing, 2), fresh];
    later(6 * MINUTE);
    await run(sync);
    expect(await credentialItem(existing.id)).toMatchObject({ outcome: 'failed', revision: 2 });
    expect(
      await prisma.cloudCredential.findUniqueOrThrow({ where: { cloudAccountId: existing.id } }),
    ).toMatchObject({ controlPlaneRevision: 1 });
  });

  it('a conta conectada por OAuth não é trocada pelo token do console, nem com o OAuth desligado', async () => {
    const sync = syncFor({ announceCloudflareOauth: false });
    const desired = withToken(source());
    cp.sources = [desired];
    await run(sync);
    const grantId = await connectByOauth(desired.id);
    later(6 * MINUTE);
    expect(await run(sync)).toMatchObject({ failed: 0 });
    // O relato da credencial vai sem nada: ela é do cliente.
    expect(cp.received.at(-1)?.sources.find((report) => report.id === desired.id)).toMatchObject({
      outcome: 'applied',
      credential: null,
    });
    cp.sources = [withToken(desired, 2)];
    later(6 * MINUTE);
    expect(await run(sync)).toMatchObject({ failed: 1 });
    // Recusado antes de chamar a origem: só o primeiro foi conferido.
    expect(checked).toBe(1);
    expect(await credentialItem(desired.id)).toMatchObject({ outcome: 'failed', code: 'origin_conflict' });
    expect(await prisma.cloudCredential.count({ where: { cloudAccountId: desired.id } })).toBe(0);
    expect(
      (await prisma.cloudAccount.findUniqueOrThrow({ where: { id: desired.id } })).cloudflareGrantId,
    ).toBe(grantId);
  });

  it('conectada enquanto a origem respondia: o token do console não entra', async () => {
    const desired = withToken(source());
    cp.sources = [desired];
    let grantId = '';
    const sync = syncFor({
      announceCloudflareOauth: false,
      checks: {
        check: async () => {
          grantId = await connectByOauth(desired.id);
          return { keyIdSuffix: 'c0de', issuedAt: null, expiresAt: null };
        },
      },
    });
    expect(await run(sync)).toMatchObject({ failed: 1 });
    expect(await credentialItem(desired.id)).toMatchObject({ outcome: 'failed', code: 'origin_conflict' });
    expect(await prisma.cloudCredential.count({ where: { cloudAccountId: desired.id } })).toBe(0);
    expect(
      (await prisma.cloudAccount.findUniqueOrThrow({ where: { id: desired.id } })).cloudflareGrantId,
    ).toBe(grantId);
  });

  it('a lápide do console solta a concessão da conta e a manda revogar', async () => {
    const sync = syncFor();
    const desired = source();
    cp.sources = [desired];
    await run(sync);
    const grantId = await connectByOauth(desired.id);
    cp.sources = [{ ...desired, revision: 2, state: 'removed' }];
    later(6 * MINUTE);
    await run(sync);
    expect(await prisma.cloudAccount.findUniqueOrThrow({ where: { id: desired.id } })).toMatchObject({
      status: 'inactive',
      cloudflareGrantId: null,
    });
    expect(await prisma.cloudflareGrant.findUniqueOrThrow({ where: { id: grantId } })).toMatchObject({
      status: 'revoking',
    });
    expect(
      await prisma.auditLog.count({
        where: { tenantId, action: 'cloudflare_grant.release', resourceId: grantId },
      }),
    ).toBe(1);
  });
});
