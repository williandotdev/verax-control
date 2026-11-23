import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { publicKeyFingerprint } from '@verax/vault-envelope';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LogSourceWriteResult, NodeSyncOverview } from '../src/admin/admin-log-sources.schema.js';
import { AuditService } from '../src/audit/audit.service.js';
import { COLLECTIONS } from '../src/firestore/collections.js';
import {
  NODE_SYNC_CLOUDFLARE_OAUTH_DOC,
  NODE_SYNC_STATE_DOC,
  nodeCloudflareOauthSchema,
  nodeSyncStateSchema,
} from '../src/node-sync/node-sync.schema.js';
import { TenantStore } from '../src/tenants/tenant-store.js';
import type { TenantRecord } from '../src/tenants/tenant.schema.js';
import { tenantIn } from './support/access-store-contract.js';
import { MemoryAdminSecrets, seedOwnerSession } from './support/admin-auth.js';
import { createApp } from './support/create-app.js';
import { FakeClock, MINUTE_MS } from './support/fake-clock.js';
import { LogCapture } from './support/log-capture.js';
import { RecordingDocumentStore } from './support/recording-document-store.js';
import { demoTenant } from './support/tenant-store-contract.js';

const OWNER = 'responsavel@verax.example';
const CLOUDFLARE_SPEC = { provider: 'cloudflare', accountId: 'b'.repeat(32) } as const;

function cloudflareToken(): string {
  return `cfut_${randomBytes(30).toString('base64url')}`;
}

/**
 * O token colado do Cloudflare no console quando o cliente o conecta por OAuth: o cp-admin o recusa (não só a tela), e
 * só nesse cliente: o do nó que ainda não anuncia a conexão, o não liberado e o da VM do cliente seguem no token.
 */
describe('cp-admin: token do Cloudflare com a conexão por OAuth ligada', () => {
  const clock = new FakeClock(new Date('2026-11-20T12:00:00.000Z'));
  const documents = new RecordingDocumentStore();
  const audit = new AuditService(documents, clock);
  const tenants = new TenantStore(documents, clock, audit);
  const capture = new LogCapture();
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  let app: NestExpressApplication;
  let cookie = '';

  beforeAll(async () => {
    app = await createApp({
      role: 'admin',
      nodeEnv: 'production',
      trustProxyHops: 1,
      capture,
      documentStore: documents,
      clock,
      adminSecrets: new MemoryAdminSecrets(),
      env: {
        ADMIN_SECRETS_PROJECT_ID: 'projeto-exemplo',
        OWNER_PRINCIPALS: OWNER,
        CLOUDFLARE_OAUTH_CLIENT_ID: 'appdetestedemo01',
        CLOUDFLARE_OAUTH_SCOPES: 'zone.read,offline_access',
        CLOUDFLARE_OAUTH_TENANT_SLUGS: 'liberado-a,liberado-velho,liberado-vm,liberado-volta',
      },
    });
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    clock.advance(2 * 60 * MINUTE_MS);
    cookie = await seedOwnerSession(documents, clock, OWNER);
  });

  function customer(slug: string): Promise<TenantRecord> {
    const seed = demoTenant(slug);
    return tenants.create(
      {
        ...seed,
        consent: undefined,
        stripe: undefined,
        billing: { mode: 'contract' },
        hosting: 'customer',
        configuration: { ...seed.configuration, mode: 'self_hosted' },
      },
      { reason: 'teste', audit: { actor: 'system' }, initialState: 'waiting_customer_install' },
    );
  }

  /** O nó sincronizado com o cofre; `announce`, o anúncio da conexão na mesma chamada (ou numa anterior). */
  async function seedNode(tenant: TenantRecord, announce: 'now' | 'before' | 'never'): Promise<void> {
    const platform = tenant.hosting === 'customer' ? 'vm' : 'gcp';
    const now = clock.now();
    const state = nodeSyncStateSchema.parse({
      lastSeenAt: now,
      lastSentAt: now,
      sequence: 5,
      authKind: platform === 'gcp' ? 'gcp_identity' : 'node_key',
      platform,
      commit: 'c'.repeat(40),
      capabilities: ['log_sources', 'users'],
      nodeTenantId: randomUUID(),
      vaultKey: {
        version: 1,
        publicKey: Buffer.from(pem, 'utf8').toString('base64'),
        fingerprint: publicKeyFingerprint(pem),
        since: now,
      },
      serviceAccountId: null,
      egressIps: [],
      audience: 'https://conta.example.com/aws-reader',
      error: null,
    });
    await documents.runTransaction((tx) => {
      const collection = COLLECTIONS.nodeSync(tenant.id);
      tx.set(collection, NODE_SYNC_STATE_DOC, state);
      if (announce !== 'never') {
        tx.set(
          collection,
          NODE_SYNC_CLOUDFLARE_OAUTH_DOC,
          nodeCloudflareOauthSchema.parse({
            sequence: announce === 'now' ? 5 : 4,
            seenAt: announce === 'now' ? now : new Date(now.getTime() - 5 * MINUTE_MS),
          }),
        );
      }
      return Promise.resolve();
    });
  }

  const base = (tenant: TenantRecord) => `/v1/admin/tenants/${tenant.id}`;

  function send(method: 'post' | 'put', path: string, body: unknown): request.Test {
    const http = request(app.getHttpServer());
    return (method === 'post' ? http.post(path) : http.put(path))
      .set('Content-Type', 'application/json')
      .set('Cookie', cookie)
      .send(JSON.stringify(body));
  }

  async function overview(tenant: TenantRecord): Promise<NodeSyncOverview> {
    const response = await request(app.getHttpServer())
      .get(`${base(tenant)}/node-sync`)
      .set('Cookie', cookie);
    expect(response.status).toBe(200);
    return response.body as NodeSyncOverview;
  }

  it('cliente que conecta por OAuth: recusa no cadastro e no envio, nada é cifrado, e a tela não oferece', async () => {
    const tenant = await tenantIn(tenants, 'liberado-a', 'active');
    await seedNode(tenant, 'now');
    const token = cloudflareToken();
    const credential = { kind: 'cloudflare_api_token', token };

    const created = await send('post', `${base(tenant)}/log-sources`, { spec: CLOUDFLARE_SPEC, credential });
    expect(created.status).toBe(409);
    expect(created.body).toMatchObject({ code: 'cloudflare_oauth_only' });
    expect(await documents.query(COLLECTIONS.logSources(tenant.id))).toEqual([]);

    // Sem token, o cadastro continua: o cliente a conecta no painel dele.
    const bare = await send('post', `${base(tenant)}/log-sources`, { spec: CLOUDFLARE_SPEC });
    expect(bare.status).toBe(201);
    const { source } = bare.body as LogSourceWriteResult;
    expect(source.cloudflareToken).toBeNull();

    const sent = await send('put', `${base(tenant)}/log-sources/${source.id}/credential`, credential);
    expect(sent.status).toBe(409);
    expect(sent.body).toMatchObject({ code: 'cloudflare_oauth_only' });
    expect(await documents.query(COLLECTIONS.logSourceSecrets(tenant.id))).toEqual([]);

    const view = await overview(tenant);
    expect(view.credentialKinds).toEqual([]);
    expect(view.sources[0]?.cloudflareToken).toBeNull();
    const refused = (await audit.listForTenant(tenant.id)).filter(
      (entry) => entry.action === 'tenant.console_request_refused',
    );
    expect(refused.map((entry) => entry.details?.['code'])).toEqual([
      'cloudflare_oauth_only',
      'cloudflare_oauth_only',
    ]);
    expect(capture.text).not.toContain(token);
    expect(JSON.stringify(created.body) + JSON.stringify(sent.body)).not.toContain(token);
  });

  it.each([
    ['nó que ainda não anuncia', 'liberado-velho', 'never'],
    ['nó que voltou de versão (o anúncio é de antes)', 'liberado-volta', 'before'],
    ['cliente fora da lista', 'fora-da-lista', 'now'],
  ] as const)('%s: segue no token, como sempre', async (_name, slug, announce) => {
    const tenant = await tenantIn(tenants, slug, 'active');
    await seedNode(tenant, announce);
    expect((await overview(tenant)).credentialKinds).toEqual(['cloudflare_api_token']);
    const created = await send('post', `${base(tenant)}/log-sources`, {
      spec: CLOUDFLARE_SPEC,
      credential: { kind: 'cloudflare_api_token', token: cloudflareToken() },
    });
    expect(created.status).toBe(201);
    expect((created.body as LogSourceWriteResult).source.cloudflareToken).not.toBeNull();
  });

  it('o retorno do Cloudflare não existe no cp-admin', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/public/cloudflare/callback')
      .set('Cookie', cookie);
    expect(response.status).toBe(404);
  });

  it('VM do cliente: o token continua, mesmo na lista e com anúncio', async () => {
    const tenant = await customer('liberado-vm');
    await seedNode(tenant, 'now');
    expect((await overview(tenant)).credentialKinds).toContain('cloudflare_api_token');
    const created = await send('post', `${base(tenant)}/log-sources`, {
      spec: CLOUDFLARE_SPEC,
      credential: { kind: 'cloudflare_api_token', token: cloudflareToken() },
    });
    expect(created.status).toBe(201);
  });
});
