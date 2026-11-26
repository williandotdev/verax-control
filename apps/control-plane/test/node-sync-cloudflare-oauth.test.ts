import type { NestExpressApplication } from '@nestjs/platform-express';
import { type NodeSyncCapability, type NodeSyncResponse, nodeSyncResponseSchema } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AuditService } from '../src/audit/audit.service.js';
import { DEFAULT_NODE_SYNC_AUDIENCE } from '../src/common/config/env.schema.js';
import { enrollmentHash, newEnrollmentSecret } from '../src/enrollment/enrollment.js';
import { COLLECTIONS } from '../src/firestore/collections.js';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import { purgeNodeSync } from '../src/node-sync/node-sync-purge.js';
import {
  announcesCloudflareOauth,
  NODE_SYNC_CLOUDFLARE_OAUTH_DOC,
  NODE_SYNC_STATE_DOC,
  nodeSyncStateSchema,
} from '../src/node-sync/node-sync.schema.js';
import { TenantStore } from '../src/tenants/tenant-store.js';
import type { TenantRecord } from '../src/tenants/tenant.schema.js';
import { TestGoogleIdentity } from './support/access-fakes.js';
import { tenantIn } from './support/access-store-contract.js';
import { createApp } from './support/create-app.js';
import { FakeClock, MINUTE_MS } from './support/fake-clock.js';
import { LogCapture } from './support/log-capture.js';
import { fakeNodeIdentity, type FakeNodeIdentity, nodeSyncRequest } from './support/node-sync-fixtures.js';
import { demoTenant } from './support/tenant-store-contract.js';

const WORKER_URL = 'https://cp-worker-123456789012.southamerica-east1.run.app';
const INVOKER = 'cp-invoker@projeto-exemplo.iam.gserviceaccount.com';
const PUBLIC_SA = 'cp-public@projeto-exemplo.iam.gserviceaccount.com';
const NODES = 'projeto-dos-nos-demo';
const START = new Date(Date.now() - 24 * 60 * MINUTE_MS);
const ALL: NodeSyncCapability[] = ['log_sources', 'users', 'cloudflare_oauth'];
const CONFIG = {
  clientId: 'appdetestedemo01',
  redirectUri: 'https://conta.veraxsistemas.com.br/v1/public/cloudflare/callback',
  scopes: ['account-settings.read', 'zone.read', 'offline_access'],
};

/** O `nodeSync/state` como a versão anterior do plano de controle o lê: as duas capacidades que ela conhece, estrito. */
const previousStateSchema = nodeSyncStateSchema.extend({
  capabilities: z.array(z.enum(['log_sources', 'users'])).max(8),
});

interface ManagedNode {
  tenant: TenantRecord;
  sub: string;
  instance: string;
  identity: FakeNodeIdentity;
  sequence: number;
}

/** A seção `cloudflareOauth` da sincronização do nó, com a conexão por OAuth ligada para uma lista de clientes. */
describe('cp-worker: configuração do Cloudflare na sincronização do nó', () => {
  const clock = new FakeClock(START);
  const documents = new MemoryDocumentStore();
  const google = new TestGoogleIdentity();
  const tenants = new TenantStore(documents, clock, new AuditService(documents, clock));
  const capture = new LogCapture();
  let app: NestExpressApplication;
  let subs = 0;

  beforeAll(async () => {
    app = await createApp({
      role: 'worker',
      clock,
      documentStore: documents,
      idTokenKeys: google,
      capture,
      env: {
        WORKER_URL,
        WORKER_SA_EMAIL: INVOKER,
        SCHEDULER_SA_EMAIL: INVOKER,
        OWNER_PRINCIPALS: 'responsavel@exemplo.example',
        PUBLIC_SA_EMAIL: PUBLIC_SA,
        CLOUDFLARE_OAUTH_CLIENT_ID: CONFIG.clientId,
        CLOUDFLARE_OAUTH_SCOPES: CONFIG.scopes.join(','),
        CLOUDFLARE_OAUTH_TENANT_SLUGS: 'liberado-a,liberado-b,liberado-vm',
      },
    });
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    clock.advance(MINUTE_MS);
  });

  async function managed(slug: string): Promise<ManagedNode> {
    subs += 1;
    const sub = `3${String(subs).padStart(20, '0')}`;
    const instance = `vx-${slug}`;
    const created = await tenantIn(tenants, slug, 'active');
    const { tenant } = await tenants.change(created.id, () => ({
      reason: 'teste',
      audit: { actor: 'system' },
      mutate: (t) => ({
        ...t,
        resources: { nodesProject: NODES, instanceName: instance, serviceAccountUniqueId: sub },
      }),
    }));
    return { tenant, sub, instance, identity: fakeNodeIdentity(), sequence: 0 };
  }

  async function sync(
    node: ManagedNode,
    capabilities: NodeSyncCapability[],
    identity: FakeNodeIdentity = node.identity,
  ): Promise<NodeSyncResponse> {
    clock.advance(MINUTE_MS);
    node.sequence += 1;
    const token = google.token({
      email: `${node.instance}@${NODES}.iam.gserviceaccount.com`,
      aud: DEFAULT_NODE_SYNC_AUDIENCE,
      payload: {
        sub: node.sub,
        google: {
          compute_engine: {
            project_id: NODES,
            instance_name: node.instance,
            zone: 'southamerica-east1-b',
          },
        },
      },
    });
    const response = await request(app.getHttpServer())
      .post('/internal/node-sync/managed')
      .set('Authorization', `Bearer ${google.token({ email: PUBLIC_SA, aud: WORKER_URL })}`)
      .send({
        token,
        request: nodeSyncRequest({
          sequence: node.sequence,
          sentAt: clock.now(),
          identity,
          serviceAccountId: node.sub,
          capabilities,
        }),
      });
    expect(response.status).toBe(200);
    return nodeSyncResponseSchema.parse(response.body);
  }

  async function announced(tenantId: string): Promise<boolean> {
    const collection = COLLECTIONS.nodeSync(tenantId);
    const state = nodeSyncStateSchema.parse(await documents.get(collection, NODE_SYNC_STATE_DOC));
    return announcesCloudflareOauth(state, await documents.get(collection, NODE_SYNC_CLOUDFLARE_OAUTH_DOC));
  }

  it('nó gerenciado de cliente liberado que anuncia: recebe a configuração, sem nada além dela', async () => {
    const node = await managed('liberado-a');
    const response = await sync(node, ALL);
    expect(response.cloudflareOauth).toEqual(CONFIG);
    expect(response.sources).toEqual([]);
    expect(response.users).toEqual([]);
    expect(await announced(node.tenant.id)).toBe(true);
  });

  it('nó anterior (não anuncia): a resposta é a de sempre, sem a seção', async () => {
    const node = await managed('liberado-b');
    const response = await sync(node, ['log_sources', 'users']);
    expect(Object.keys(response).sort()).toEqual([
      'generation',
      'pollAfterSeconds',
      'protocol',
      'sources',
      'users',
    ]);
    const collection = COLLECTIONS.nodeSync(node.tenant.id);
    expect(await documents.get(collection, NODE_SYNC_CLOUDFLARE_OAUTH_DOC)).toBeUndefined();
    expect(await announced(node.tenant.id)).toBe(false);
  });

  it('cliente não liberado que anuncia: null (desligada)', async () => {
    const node = await managed('fora-da-lista');
    expect((await sync(node, ALL)).cloudflareOauth).toBeNull();
  });

  it('VM do cliente que anuncia, mesmo na lista: null', async () => {
    const seed = demoTenant('liberado-vm');
    const created = await tenants.create(
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
    const nodeKey = newEnrollmentSecret();
    const now = clock.now();
    await tenants.change(created.id, () => ({
      to: 'provisioning',
      reason: 'teste',
      audit: { actor: 'system' },
      mutate: (t) => ({
        ...t,
        enrollment: {
          codeHash: enrollmentHash(newEnrollmentSecret()),
          codeExpiresAt: new Date(now.getTime() + 60 * MINUTE_MS),
          codeCreatedAt: now,
          codeCreatedBy: 'owner:responsavel@exemplo.example',
          claimedAt: now,
          nodeKeyHash: enrollmentHash(nodeKey),
        },
      }),
    }));
    const response = await request(app.getHttpServer())
      .post('/internal/node-sync/customer')
      .set('Authorization', `Bearer ${google.token({ email: PUBLIC_SA, aud: WORKER_URL })}`)
      .send({
        nodeKey,
        request: nodeSyncRequest({
          sequence: 1,
          sentAt: clock.now(),
          platform: 'vm',
          capabilities: ALL,
        }),
      });
    expect(response.status).toBe(200);
    expect(nodeSyncResponseSchema.parse(response.body).cloudflareOauth).toBeNull();
  });

  it('volta de versão do plano de controle: a anterior lê o estado do nó que anunciou a capacidade', async () => {
    const node = await managed('volta-versao');
    await sync(node, ALL);
    const stored = await documents.get(COLLECTIONS.nodeSync(node.tenant.id), NODE_SYNC_STATE_DOC);
    expect(previousStateSchema.parse(stored).capabilities).toEqual(['log_sources', 'users']);
  });

  it('o anúncio só vale junto do estado da mesma chamada: nó que volta de versão deixa de anunciar', async () => {
    const node = await managed('anuncio');
    await sync(node, ALL);
    expect(await announced(node.tenant.id)).toBe(true);
    await sync(node, ['log_sources', 'users']);
    expect(await announced(node.tenant.id)).toBe(false);
    await sync(node, ALL);
    expect(await announced(node.tenant.id)).toBe(true);
    // Mesmo instante e outra sequência (ou o contrário): não é a mesma chamada.
    const collection = COLLECTIONS.nodeSync(node.tenant.id);
    const state = nodeSyncStateSchema.parse(await documents.get(collection, NODE_SYNC_STATE_DOC));
    const same = { sequence: state.sequence, seenAt: state.lastSeenAt };
    expect(announcesCloudflareOauth(state, same)).toBe(true);
    expect(announcesCloudflareOauth(state, { ...same, sequence: state.sequence - 1 })).toBe(false);
    expect(announcesCloudflareOauth(state, { ...same, seenAt: new Date(0) })).toBe(false);
    expect(announcesCloudflareOauth(state, { ...same, extra: true })).toBe(false);
    expect(announcesCloudflareOauth(undefined, same)).toBe(false);
    // Instalação nova, com a sequência repetida do começo: o documento da anterior não vale por acaso.
    const stale = await documents.get(COLLECTIONS.nodeSync(node.tenant.id), NODE_SYNC_CLOUDFLARE_OAUTH_DOC);
    node.sequence = 2;
    await sync(node, ['log_sources', 'users'], fakeNodeIdentity());
    expect(stale).toMatchObject({ sequence: 3 });
    expect(await announced(node.tenant.id)).toBe(false);
  });

  it('o retorno do Cloudflare não existe no cp-worker', async () => {
    await request(app.getHttpServer()).get('/v1/public/cloudflare/callback').expect(404);
  });

  it('a exclusão do cliente apaga também o anúncio', async () => {
    const node = await managed('exclusao');
    await sync(node, ALL);
    expect((await purgeNodeSync(documents, node.tenant.id))['nodeSync']).toBe(2);
    expect(await documents.query(COLLECTIONS.nodeSync(node.tenant.id))).toEqual([]);
  });
});
