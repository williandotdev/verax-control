import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  NODE_SYNC_POLL_MIN_SECONDS,
  NODE_SYNC_RESPONSE_MAX_BYTES,
  type NodeSyncRequest,
  type NodeSyncResponse,
  nodeSyncResponseSchema,
} from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import { DEFAULT_NODE_SYNC_AUDIENCE } from '../src/common/config/env.schema.js';
import { enrollmentHash, newEnrollmentSecret } from '../src/enrollment/enrollment.js';
import { COLLECTIONS } from '../src/firestore/collections.js';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import type { NodeSyncCredential } from '../src/node-sync/node-identity.js';
import {
  LOG_SOURCE_SECRET_TTL_MS,
  logSourceSchema,
  logSourceSecretSchema,
  NODE_SYNC_DESIRED_DOC,
  NODE_SYNC_STATE_DOC,
  nodeSyncDesiredSchema,
  nodeSyncStateSchema,
  nodeUserSchema,
  nodeUserSecretSchema,
} from '../src/node-sync/node-sync.schema.js';
import { TenantStore } from '../src/tenants/tenant-store.js';
import { type TenantRecord, tenantSchema } from '../src/tenants/tenant.schema.js';
import { TestGoogleIdentity } from './support/access-fakes.js';
import { tenantIn } from './support/access-store-contract.js';
import { createApp } from './support/create-app.js';
import { FakeClock, MINUTE_MS } from './support/fake-clock.js';
import { LogCapture } from './support/log-capture.js';
import {
  fakeEnvelope,
  fakeNodeIdentity,
  type FakeNodeIdentity,
  nodeSyncRequest,
  sourceId,
  sourceReport,
  userCreated,
  userFailed,
  userRequestId,
} from './support/node-sync-fixtures.js';
import { demoTenant } from './support/tenant-store-contract.js';

const WORKER_URL = 'https://cp-worker-123456789012.southamerica-east1.run.app';
const INVOKER = 'cp-invoker@projeto-exemplo.iam.gserviceaccount.com';
const PUBLIC_SA = 'cp-public@projeto-exemplo.iam.gserviceaccount.com';
const OWNER = 'responsavel@exemplo.example';
const NODES = 'projeto-dos-nos-demo';
/** Antes do relógio do sistema: os tokens de teste vencem em 1 h pelo relógio real, e o worker confere pelos dois. */
const START = new Date(Date.now() - 24 * 60 * MINUTE_MS);
const AUDIENCE = DEFAULT_NODE_SYNC_AUDIENCE;
const ACTOR = `owner:${OWNER}`;
const SPEC = { provider: 'cloudflare' as const, accountId: 'a'.repeat(32), zones: ['exemplo.example'] };

interface ManagedNode {
  tenant: TenantRecord;
  sub: string;
  instance: string;
  identity: FakeNodeIdentity;
  sequence: number;
}

/**
 * A sincronização do nó pelo cp-worker inteiro (`POST /internal/node-sync/managed|customer`, como o cp-public a
 * repassa, com o token
 * dele), sobre o Firestore em memória: a credencial conferida de novo e o cliente derivado só dela (o token do nó
 * gerenciado, assinado pelo "Google" do teste, ou a chave do nó da VM do cliente), o estado do nó, os relatos só sob o
 * cliente certo, a sequência e o intervalo, o relógio, os envelopes consumidos, as capacidades e a troca de identidade.
 */
describe('cp-worker: sincronização do nó dedicado', () => {
  const capture = new LogCapture();
  const clock = new FakeClock(START);
  const documents = new MemoryDocumentStore();
  const google = new TestGoogleIdentity();
  const audit = new AuditService(documents, clock);
  const tenants = new TenantStore(documents, clock, audit);
  let app: NestExpressApplication;
  let slugs = 0;
  let subs = 0;

  beforeAll(async () => {
    app = await createApp({
      role: 'worker',
      clock,
      documentStore: documents,
      idTokenKeys: google,
      capture,
      env: {
        LOG_LEVEL: 'debug',
        WORKER_URL,
        WORKER_SA_EMAIL: INVOKER,
        SCHEDULER_SA_EMAIL: INVOKER,
        OWNER_PRINCIPALS: OWNER,
        PUBLIC_SA_EMAIL: PUBLIC_SA,
      },
    });
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    // Cada teste começa mais de 20 s depois do anterior: o intervalo mínimo por cliente não vaza.
    clock.advance(MINUTE_MS);
  });

  function bearer(email: string): string {
    return `Bearer ${google.token({ email, aud: WORKER_URL })}`;
  }

  function nodeToken(
    node: Pick<ManagedNode, 'sub' | 'instance'>,
    payload: Record<string, unknown> = {},
  ): string {
    return google.token({
      email: `${node.instance}@${NODES}.iam.gserviceaccount.com`,
      aud: AUDIENCE,
      payload: {
        sub: node.sub,
        google: {
          compute_engine: { project_id: NODES, instance_name: node.instance, zone: 'southamerica-east1-b' },
        },
        ...payload,
      },
    });
  }

  /** Um cliente gerenciado com a VM registrada (o que o `terraform.apply` grava em `resources`). */
  async function managed(state: 'provisioning' | 'active' | 'canceled' = 'active'): Promise<ManagedNode> {
    slugs += 1;
    subs += 1;
    const slug = `gerido-sync-${slugs}`;
    const sub = `1${String(subs).padStart(20, '0')}`;
    const instance = `vx-${slug}`;
    const created = await tenantIn(tenants, slug, state);
    const tenant = (
      await tenants.change(created.id, () => ({
        reason: 'teste',
        audit: { actor: 'system' },
        mutate: (t) => ({
          ...t,
          resources: { nodesProject: NODES, instanceName: instance, serviceAccountUniqueId: sub },
        }),
      }))
    ).tenant;
    return { tenant, sub, instance, identity: fakeNodeIdentity(), sequence: 0 };
  }

  /** Um contrato direto na VM do cliente, já registrado (a chave do nó guardada só como hash). */
  async function customer(): Promise<{ tenant: TenantRecord; nodeKey: string }> {
    slugs += 1;
    const seed = demoTenant(`vm-sync-${slugs}`);
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
    const tenant = (
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
            codeCreatedBy: ACTOR,
            claimedAt: now,
            nodeKeyHash: enrollmentHash(nodeKey),
          },
        }),
      }))
    ).tenant;
    return { tenant, nodeKey };
  }

  /** Como o cp-public repassa: o token do nó gerenciado em `/managed`, a chave da VM do cliente em `/customer`. */
  function call(credential: NodeSyncCredential, body: NodeSyncRequest): request.Test {
    const http = request(app.getHttpServer());
    return credential.kind === 'gcp_identity'
      ? http
          .post('/internal/node-sync/managed')
          .set('Authorization', bearer(PUBLIC_SA))
          .send({ token: credential.token, request: body })
      : http
          .post('/internal/node-sync/customer')
          .set('Authorization', bearer(PUBLIC_SA))
          .send({ nodeKey: credential.nodeKey, request: body });
  }

  /** Uma chamada do nó gerenciado, com a próxima sequência e o relógio agora. */
  function syncManaged(
    node: ManagedNode,
    options: Partial<Parameters<typeof nodeSyncRequest>[0]> = {},
    token = nodeToken(node),
  ): request.Test {
    node.sequence += 1;
    return call(
      { kind: 'gcp_identity', token },
      nodeSyncRequest({
        sequence: node.sequence,
        sentAt: clock.now(),
        identity: node.identity,
        serviceAccountId: node.sub,
        ...options,
      }),
    );
  }

  async function seed(
    write: (tx: { set: (collection: string, id: string, data: Record<string, unknown>) => void }) => void,
  ): Promise<void> {
    await documents.runTransaction((tx) => {
      write(tx);
      return Promise.resolve();
    });
  }

  async function seedSource(
    tenantId: string,
    options: {
      state?: 'active' | 'removed';
      revision?: number;
      secret?: { revision: number; identity: FakeNodeIdentity; envelope?: string };
    } = {},
  ): Promise<{ id: string; envelope: string | undefined }> {
    const id = sourceId();
    const now = clock.now();
    const envelope = options.secret === undefined ? undefined : (options.secret.envelope ?? fakeEnvelope());
    await seed((tx) => {
      tx.set(
        COLLECTIONS.logSources(tenantId),
        id,
        logSourceSchema.parse({
          spec: SPEC,
          state: options.state ?? 'active',
          revision: options.revision ?? 1,
          credentialMeta:
            options.secret === undefined
              ? null
              : {
                  revision: options.secret.revision,
                  kind: 'cloudflare_api_token',
                  keyVersion: options.secret.identity.keyVersion,
                  fingerprint: options.secret.identity.fingerprint,
                  submittedAt: now,
                  submittedBy: ACTOR,
                },
          createdAt: now,
          createdBy: ACTOR,
          updatedAt: now,
          updatedBy: ACTOR,
        }),
      );
      if (options.secret !== undefined) {
        tx.set(
          COLLECTIONS.logSourceSecrets(tenantId),
          id,
          logSourceSecretSchema.parse({
            revision: options.secret.revision,
            kind: 'cloudflare_api_token',
            envelope,
            fingerprint: options.secret.identity.fingerprint,
            nodeTenantId: options.secret.identity.tenantId,
            createdAt: now,
            expiresAt: new Date(now.getTime() + LOG_SOURCE_SECRET_TTL_MS),
          }),
        );
      }
    });
    return { id, envelope };
  }

  async function seedUser(
    tenantId: string,
    identity: FakeNodeIdentity,
    notAfter = new Date(clock.now().getTime() + 72 * 60 * MINUTE_MS),
  ): Promise<{ id: string; envelope: string; email: string }> {
    const id = userRequestId(clock.now().getTime());
    const envelope = fakeEnvelope(256);
    const email = `pessoa-${id.toLowerCase()}@cliente-demo-a.example`;
    const now = clock.now();
    await seed((tx) => {
      tx.set(
        COLLECTIONS.nodeUsers(tenantId),
        id,
        nodeUserSchema.parse({
          name: 'Pessoa Demo',
          email,
          role: 'analista_cliente',
          notAfter,
          createdAt: now,
          createdBy: ACTOR,
        }),
      );
      tx.set(
        COLLECTIONS.nodeUserSecrets(tenantId),
        id,
        nodeUserSecretSchema.parse({
          envelope,
          fingerprint: identity.fingerprint,
          nodeTenantId: identity.tenantId,
          createdAt: now,
          expiresAt: new Date(notAfter.getTime() + 24 * 60 * MINUTE_MS),
        }),
      );
    });
    return { id, envelope, email };
  }

  async function ids(collection: string): Promise<string[]> {
    return (await documents.query(collection)).map((doc) => doc.id).sort();
  }

  async function auditActions(tenantId: string): Promise<string[]> {
    return (await audit.listForTenant(tenantId)).map((record) => record.action);
  }

  it('conexão do Cloudflare por OAuth desligada (o padrão): quem anuncia recebe null', async () => {
    const node = await managed();
    const response = await syncManaged(node, { capabilities: ['log_sources', 'users', 'cloudflare_oauth'] });
    expect(response.status).toBe(200);
    expect(nodeSyncResponseSchema.parse(response.body).cloudflareOauth).toBeNull();
  });

  it('primeira chamada do nó gerenciado: grava o estado do nó e responde o desejado vazio', async () => {
    const node = await managed();
    const token = nodeToken(node);
    const response = await syncManaged(node, {}, token);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      protocol: 1,
      generation: 0,
      pollAfterSeconds: 300,
      sources: [],
      users: [],
    });
    const state = nodeSyncStateSchema.parse(
      await documents.get(COLLECTIONS.nodeSync(node.tenant.id), NODE_SYNC_STATE_DOC),
    );
    expect(state).toMatchObject({
      lastSeenAt: clock.now(),
      sequence: 1,
      authKind: 'gcp_identity',
      platform: 'gcp',
      nodeTenantId: node.identity.tenantId,
      vaultKey: { fingerprint: node.identity.fingerprint, version: 1, since: clock.now() },
      serviceAccountId: node.sub,
      capabilities: ['log_sources', 'users'],
      error: null,
    });
    // A primeira vez não é troca de identidade.
    expect(await auditActions(node.tenant.id)).not.toContain('node_sync.identity_changed');
    expect(capture.text).not.toContain(token);
  });

  it('o desejado: fontes (com a credencial pendente e a lápide), usuários no prazo e a geração do console', async () => {
    const node = await managed();
    const tenantId = node.tenant.id;
    const withCredential = await seedSource(tenantId, {
      revision: 2,
      secret: { revision: 1, identity: node.identity },
    });
    const tombstone = await seedSource(tenantId, { state: 'removed', revision: 3 });
    const pendingUser = await seedUser(tenantId, node.identity);
    const expiredUser = await seedUser(tenantId, node.identity, new Date(clock.now().getTime() - MINUTE_MS));
    await seed((tx) =>
      tx.set(
        COLLECTIONS.nodeSync(tenantId),
        NODE_SYNC_DESIRED_DOC,
        nodeSyncDesiredSchema.parse({ generation: 5, updatedAt: clock.now() }),
      ),
    );

    const first = await syncManaged(node);
    expect(first.status).toBe(200);
    const body = nodeSyncResponseSchema.parse(first.body);
    expect(body.generation).toBe(5);
    expect(body.sources).toEqual(
      expect.arrayContaining([
        {
          id: withCredential.id,
          revision: 2,
          state: 'active',
          spec: SPEC,
          credential: { revision: 1, kind: 'cloudflare_api_token', envelope: withCredential.envelope },
        },
        { id: tombstone.id, revision: 3, state: 'removed', spec: SPEC, credential: null },
      ]),
    );
    expect(body.sources).toHaveLength(2);
    expect(body.users).toEqual([
      {
        requestId: pendingUser.id,
        name: 'Pessoa Demo',
        email: pendingUser.email,
        role: 'analista_cliente',
        envelope: pendingUser.envelope,
        notAfter: expect.any(String) as unknown,
      },
    ]);
    // O pedido vencido nunca vai, e o envelope dele sai (o TTL é só a rede de segurança).
    expect(await ids(COLLECTIONS.nodeUserSecrets(tenantId))).toEqual([pendingUser.id]);
    expect(expiredUser.id).not.toBe(pendingUser.id);

    // O nó aplicou a credencial e criou o usuário: os dois envelopes saem, e o desejado vem sem eles.
    clock.advance(MINUTE_MS);
    const second = await syncManaged(node, {
      sources: [sourceReport(withCredential.id, 2, { revision: 1, outcome: 'applied' })],
      users: [userCreated(pendingUser.id)],
    });
    expect(second.status).toBe(200);
    const after = nodeSyncResponseSchema.parse(second.body);
    expect(after.sources?.find((source) => source.id === withCredential.id)?.credential).toBeNull();
    expect(after.users).toEqual([]);
    expect(await ids(COLLECTIONS.logSourceSecrets(tenantId))).toEqual([]);
    expect(await ids(COLLECTIONS.nodeUserSecrets(tenantId))).toEqual([]);
    expect(await ids(COLLECTIONS.logSourceReports(tenantId))).toEqual([withCredential.id]);
    expect(await ids(COLLECTIONS.nodeUserReports(tenantId))).toEqual([pendingUser.id]);
    for (const secret of [withCredential.envelope ?? '', pendingUser.envelope, pendingUser.email]) {
      expect(capture.text).not.toContain(secret);
    }
  });

  it('capacidades: cada seção só vem quando o nó a anunciou', async () => {
    const node = await managed();
    await seedSource(node.tenant.id);
    const onlySources = await syncManaged(node, { capabilities: ['log_sources'] });
    expect(onlySources.status).toBe(200);
    expect(onlySources.body).toHaveProperty('sources');
    expect(onlySources.body).not.toHaveProperty('users');
    clock.advance(MINUTE_MS);
    const onlyUsers = await syncManaged(node, { capabilities: ['users'] });
    expect(onlyUsers.body).toEqual({ protocol: 1, generation: 0, pollAfterSeconds: 300, users: [] });
    clock.advance(MINUTE_MS);
    const none = await syncManaged(node, { capabilities: [] });
    expect(none.body).toEqual({ protocol: 1, generation: 0, pollAfterSeconds: 300 });
  });

  it('relatos só sob o cliente da credencial: ids de outro cliente ou desconhecidos são ignorados e contados', async () => {
    const mine = await managed();
    const other = await managed();
    const otherSource = await seedSource(other.tenant.id, {
      secret: { revision: 1, identity: other.identity },
    });
    const otherUser = await seedUser(other.tenant.id, other.identity);
    const ownSource = await seedSource(mine.tenant.id);
    const response = await syncManaged(mine, {
      sources: [
        sourceReport(otherSource.id, 1, { revision: 1, outcome: 'applied' }),
        sourceReport(sourceId(), 1),
        sourceReport(ownSource.id, 1),
      ],
      users: [userCreated(otherUser.id)],
    });
    expect(response.status).toBe(200);
    // Nada do outro cliente vai na resposta, e nada dele muda: nem relato nem envelope.
    expect((response.body as NodeSyncResponse).sources?.map((source) => source.id)).toEqual([ownSource.id]);
    expect(await ids(COLLECTIONS.logSourceReports(mine.tenant.id))).toEqual([ownSource.id]);
    expect(await ids(COLLECTIONS.logSourceReports(other.tenant.id))).toEqual([]);
    expect(await ids(COLLECTIONS.nodeUserReports(other.tenant.id))).toEqual([]);
    expect(await ids(COLLECTIONS.logSourceSecrets(other.tenant.id))).toEqual([otherSource.id]);
    expect(await ids(COLLECTIONS.nodeUserSecrets(other.tenant.id))).toEqual([otherUser.id]);
    const line = capture
      .entries()
      .filter((entry) => entry['event'] === 'node_sync' && entry['tenantId'] === mine.tenant.id)
      .at(-1);
    expect(line).toMatchObject({ unknownSources: 2, unknownUsers: 1, reportsWritten: 1 });
  });

  it('um relato igual ao gravado não é regravado (o estado do nó diz que ele está vivo)', async () => {
    const node = await managed();
    const source = await seedSource(node.tenant.id);
    expect((await syncManaged(node, { sources: [sourceReport(source.id, 1)] })).status).toBe(200);
    const first = await documents.get(COLLECTIONS.logSourceReports(node.tenant.id), source.id);
    clock.advance(MINUTE_MS);
    expect((await syncManaged(node, { sources: [sourceReport(source.id, 1)] })).status).toBe(200);
    expect(await documents.get(COLLECTIONS.logSourceReports(node.tenant.id), source.id)).toEqual(first);
    clock.advance(MINUTE_MS);
    const failed = {
      ...sourceReport(source.id, 1),
      outcome: 'failed' as const,
      code: 'origin_conflict' as const,
    };
    expect((await syncManaged(node, { sources: [failed] })).status).toBe(200);
    expect(await documents.get(COLLECTIONS.logSourceReports(node.tenant.id), source.id)).toMatchObject({
      report: { outcome: 'failed', code: 'origin_conflict' },
      reportedAt: clock.now(),
    });
  });

  it('a fonte que o cliente excluiu no painel: o relato com deleted_in_panel, sem a conta, é aceito e gravado', async () => {
    const node = await managed();
    const source = await seedSource(node.tenant.id);
    const deleted = {
      ...sourceReport(source.id, 1),
      outcome: 'failed' as const,
      code: 'deleted_in_panel' as const,
      account: null,
    };
    expect((await syncManaged(node, { sources: [deleted] })).status).toBe(200);
    expect(await documents.get(COLLECTIONS.logSourceReports(node.tenant.id), source.id)).toMatchObject({
      report: { revision: 1, outcome: 'failed', code: 'deleted_in_panel', credential: null, account: null },
    });
  });

  it('sequência e intervalo: repetição ou sequência menor é 409; mais de uma chamada em 20 s é 429', async () => {
    const node = await managed();
    expect((await syncManaged(node)).status).toBe(200);
    clock.advance(MINUTE_MS);
    expect((await syncManaged(node)).status).toBe(200);
    clock.advance(MINUTE_MS);
    // A mesma sequência de novo (um replay) e uma menor.
    node.sequence = 1;
    const replay = await syncManaged(node);
    expect(replay.status).toBe(409);
    expect(replay.body).toMatchObject({ code: 'stale_sequence' });
    node.sequence = 0;
    expect((await syncManaged(node)).status).toBe(409);
    node.sequence = 2;
    expect((await syncManaged(node)).status).toBe(200);
    clock.advance(5_000);
    const soon = await syncManaged(node);
    expect(soon.status).toBe(429);
    expect(soon.body).toMatchObject({ code: 'rate_limited' });
    expect(soon.headers['retry-after']).toBe('15');
    // A recusa não grava nada: a sequência aceita continua a anterior.
    const state = nodeSyncStateSchema.parse(
      await documents.get(COLLECTIONS.nodeSync(node.tenant.id), NODE_SYNC_STATE_DOC),
    );
    expect(state.sequence).toBe(3);
    clock.advance(20_000);
    expect((await syncManaged(node)).status).toBe(200);
  });

  it('relógio do nó a mais de 10 min do plano de controle: 400 clock_skew, nada gravado', async () => {
    const node = await managed();
    for (const offset of [-11 * MINUTE_MS, 11 * MINUTE_MS]) {
      const response = await syncManaged(node, { sentAt: new Date(clock.now().getTime() + offset) });
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: 'clock_skew' });
    }
    expect(await documents.get(COLLECTIONS.nodeSync(node.tenant.id), NODE_SYNC_STATE_DOC)).toBeUndefined();
    expect(
      (await syncManaged(node, { sentAt: new Date(clock.now().getTime() - 9 * MINUTE_MS) })).status,
    ).toBe(200);
  });

  it('envelopes: falha passageira fica e volta; falha definitiva sai; revisão nova continua pendente', async () => {
    const node = await managed();
    const tenantId = node.tenant.id;
    const transient = await seedSource(tenantId, { secret: { revision: 1, identity: node.identity } });
    const rejected = await seedSource(tenantId, { secret: { revision: 1, identity: node.identity } });
    const newer = await seedSource(tenantId, {
      revision: 2,
      secret: { revision: 2, identity: node.identity },
    });
    const failedUser = await seedUser(tenantId, node.identity);
    const response = await syncManaged(node, {
      sources: [
        sourceReport(transient.id, 1, { revision: 1, outcome: 'failed', code: 'source_unavailable' }),
        sourceReport(rejected.id, 1, { revision: 1, outcome: 'failed', code: 'credential_rejected_invalid' }),
        sourceReport(newer.id, 2, { revision: 1, outcome: 'applied' }),
      ],
      users: [userFailed(failedUser.id, 'email_taken')],
    });
    expect(response.status).toBe(200);
    const body = nodeSyncResponseSchema.parse(response.body);
    const credentialOf = (id: string) => body.sources?.find((source) => source.id === id)?.credential;
    expect(credentialOf(transient.id)).toMatchObject({ revision: 1, envelope: transient.envelope });
    expect(credentialOf(rejected.id)).toBeNull();
    expect(credentialOf(newer.id)).toMatchObject({ revision: 2, envelope: newer.envelope });
    expect(body.users).toEqual([]);
    expect(await ids(COLLECTIONS.logSourceSecrets(tenantId))).toEqual([transient.id, newer.id].sort());
    expect(await ids(COLLECTIONS.nodeUserSecrets(tenantId))).toEqual([]);
  });

  it('um envelope cifrado para outra chave do cofre não vai ao nó', async () => {
    const node = await managed();
    const stale = await seedSource(node.tenant.id, {
      secret: { revision: 1, identity: { ...node.identity, fingerprint: fakeNodeIdentity().fingerprint } },
    });
    const response = await syncManaged(node);
    expect(nodeSyncResponseSchema.parse(response.body).sources).toEqual([
      expect.objectContaining({ id: stale.id, credential: null }),
    ]);
  });

  it('reinstalação (outro cliente no banco do nó ou outra chave): audita e descarta os envelopes pendentes', async () => {
    const node = await managed();
    const tenantId = node.tenant.id;
    expect((await syncManaged(node)).status).toBe(200);
    const pending = await seedSource(tenantId, { secret: { revision: 1, identity: node.identity } });
    await seedUser(tenantId, node.identity);
    clock.advance(MINUTE_MS);
    const previous = node.identity;
    node.identity = fakeNodeIdentity();
    const response = await syncManaged(node);
    expect(response.status).toBe(200);
    const body = nodeSyncResponseSchema.parse(response.body);
    expect(body.sources).toEqual([expect.objectContaining({ id: pending.id, credential: null })]);
    expect(body.users).toEqual([]);
    expect(await ids(COLLECTIONS.logSourceSecrets(tenantId))).toEqual([]);
    expect(await ids(COLLECTIONS.nodeUserSecrets(tenantId))).toEqual([]);
    const changed = (await audit.listForTenant(tenantId)).find(
      (record) => record.action === 'node_sync.identity_changed',
    );
    expect(changed).toMatchObject({
      actor: 'system',
      details: {
        previousNodeTenantId: previous.tenantId,
        nodeTenantId: node.identity.tenantId,
        previousFingerprint: previous.fingerprint,
        fingerprint: node.identity.fingerprint,
        discardedEnvelopes: 2,
      },
    });
    const state = nodeSyncStateSchema.parse(
      await documents.get(COLLECTIONS.nodeSync(tenantId), NODE_SYNC_STATE_DOC),
    );
    expect(state.vaultKey?.since).toEqual(clock.now());
  });

  it('o token tem de casar com o cliente: outro projeto ou VM é 401; sem cliente, da célula, cancelado ou duplicado é 404', async () => {
    const node = await managed();
    const otherProject = google.token({
      email: 'x@y.iam.gserviceaccount.com',
      aud: AUDIENCE,
      payload: {
        sub: node.sub,
        google: { compute_engine: { project_id: 'outro-projeto-demo', instance_name: node.instance } },
      },
    });
    expect((await syncManaged(node, {}, otherProject)).status).toBe(401);
    expect((await syncManaged(node, {}, nodeToken({ sub: node.sub, instance: 'vx-outra-vm' }))).status).toBe(
      401,
    );
    // O token sem assinatura nem passa do corpo (o cp-public não manda um assim); outro aud é 401.
    const [header, payload] = nodeToken(node).split('.');
    expect((await syncManaged(node, {}, `${header}.${payload}.SIGNATURE_REMOVED_BY_GOOGLE`)).status).toBe(
      400,
    );
    expect(
      (await syncManaged(node, {}, nodeToken(node, { aud: 'https://conta.veraxsistemas.com.br/v1/outra' })))
        .status,
    ).toBe(401);
    // Uma conta de serviço que nenhum cliente tem.
    const stranger = { sub: '199999999999999999999', instance: node.instance };
    const unknown = await syncManaged(node, { serviceAccountId: stranger.sub }, nodeToken(stranger));
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: 'not_found' });

    const canceled = await managed('canceled');
    expect((await syncManaged(canceled)).status).toBe(404);

    const cell = await managed();
    await documents.runTransaction(async (tx) => {
      const current = tenantSchema.parse(await tx.get(COLLECTIONS.tenants, cell.tenant.id));
      tx.set(
        COLLECTIONS.tenants,
        cell.tenant.id,
        tenantSchema.parse({ ...current, placement: { kind: 'cell', cellId: 'celula-sp-1' } }),
      );
    });
    expect((await syncManaged(cell)).status).toBe(404);
    expect(
      capture
        .entries()
        .some((entry) => entry['tenantId'] === cell.tenant.id && entry['reason'] === 'tenant_not_eligible'),
    ).toBe(true);

    // Dois clientes com a mesma conta de serviço: recusado e avisado, nunca um escolhido.
    const twin = await managed();
    await tenants.change(twin.tenant.id, () => ({
      reason: 'teste',
      audit: { actor: 'system' },
      mutate: (t) => ({ ...t, resources: { ...t.resources, serviceAccountUniqueId: node.sub } }),
    }));
    expect((await syncManaged(node)).status).toBe(404);
    expect(capture.text).toContain('node_sync_identity_ambiguous');
  });

  it('a plataforma do corpo tem de ser a da credencial, e a conta de serviço a do token', async () => {
    const node = await managed();
    expect((await syncManaged(node, { platform: 'vm', serviceAccountId: null })).status).toBe(401);
    expect((await syncManaged(node, { serviceAccountId: '188888888888888888888' })).status).toBe(401);
    const vm = await customer();
    // A chave do nó com o corpo de um nó gerenciado.
    const mismatch = await call(
      { kind: 'node_key', nodeKey: vm.nodeKey },
      nodeSyncRequest({ sequence: 1, sentAt: clock.now(), platform: 'gcp' }),
    );
    expect(mismatch.status).toBe(401);
    expect(await documents.get(COLLECTIONS.nodeSync(vm.tenant.id), NODE_SYNC_STATE_DOC)).toBeUndefined();
  });

  it('VM do cliente: a chave do nó escolhe o cliente; desconhecida é 401; cancelado é 404', async () => {
    const vm = await customer();
    const identity = fakeNodeIdentity();
    const source = await seedSource(vm.tenant.id, { secret: { revision: 1, identity } });
    const ok = await call(
      { kind: 'node_key', nodeKey: vm.nodeKey },
      nodeSyncRequest({ sequence: 1, sentAt: clock.now(), platform: 'vm', identity }),
    );
    expect(ok.status).toBe(200);
    expect(nodeSyncResponseSchema.parse(ok.body).sources).toEqual([
      expect.objectContaining({
        id: source.id,
        credential: expect.objectContaining({ envelope: source.envelope }) as unknown,
      }),
    ]);
    expect(
      nodeSyncStateSchema.parse(await documents.get(COLLECTIONS.nodeSync(vm.tenant.id), NODE_SYNC_STATE_DOC)),
    ).toMatchObject({ authKind: 'node_key', platform: 'vm', serviceAccountId: null });
    clock.advance(MINUTE_MS);
    const unknown = await call(
      { kind: 'node_key', nodeKey: newEnrollmentSecret() },
      nodeSyncRequest({ sequence: 2, sentAt: clock.now(), platform: 'vm', identity }),
    );
    expect(unknown.status).toBe(401);
    await tenants.change(vm.tenant.id, () => ({
      to: 'canceled',
      reason: 'teste',
      audit: { actor: 'system' },
    }));
    const canceled = await call(
      { kind: 'node_key', nodeKey: vm.nodeKey },
      nodeSyncRequest({ sequence: 3, sentAt: clock.now(), platform: 'vm', identity }),
    );
    expect(canceled.status).toBe(404);
    expect(capture.text).not.toContain(vm.nodeKey);
  });

  it('reinstalação com o banco novo: a sequência recomeça do 1; o pedido capturado da instalação anterior não volta', async () => {
    const node = await managed();
    const tenantId = node.tenant.id;
    // A instalação anterior já ia na sequência 41; o pedido dela fica guardado, como um atacante o guardaria.
    const oldToken = nodeToken(node);
    const oldBody = nodeSyncRequest({
      sequence: 41,
      sentAt: clock.now(),
      identity: node.identity,
      serviceAccountId: node.sub,
    });
    expect((await call({ kind: 'gcp_identity', token: oldToken }, oldBody)).status).toBe(200);
    const pending = await seedSource(tenantId, { secret: { revision: 1, identity: node.identity } });

    // Reinstalada: outro cliente no banco do nó, outra chave do cofre e a sequência do 1.
    clock.advance(MINUTE_MS);
    const previous = node.identity;
    node.identity = fakeNodeIdentity();
    node.sequence = 0;
    const fresh = await syncManaged(node);
    expect(fresh.status).toBe(200);
    expect(nodeSyncResponseSchema.parse(fresh.body).sources).toEqual([
      expect.objectContaining({ id: pending.id, credential: null }),
    ]);
    const stateOf = async () =>
      nodeSyncStateSchema.parse(await documents.get(COLLECTIONS.nodeSync(tenantId), NODE_SYNC_STATE_DOC));
    expect(await stateOf()).toMatchObject({ sequence: 1, nodeTenantId: node.identity.tenantId });
    expect(await ids(COLLECTIONS.logSourceSecrets(tenantId))).toEqual([]);
    const changed = (await audit.listForTenant(tenantId)).find(
      (record) => record.action === 'node_sync.identity_changed',
    );
    expect(changed?.details).toMatchObject({
      previousNodeTenantId: previous.tenantId,
      nodeTenantId: node.identity.tenantId,
      newInstallation: true,
      previousSequence: 41,
      sequence: 1,
    });

    // O pedido capturado da instalação anterior (outra identidade, sequência maior, ainda dentro dos 10 min): recusado,
    // e a identidade fica a da instalação nova.
    clock.advance(MINUTE_MS);
    const replay = await call({ kind: 'gcp_identity', token: oldToken }, oldBody);
    expect(replay.status).toBe(409);
    expect(replay.body).toMatchObject({ code: 'stale_sequence' });
    expect(await stateOf()).toMatchObject({ sequence: 1, nodeTenantId: node.identity.tenantId });
    expect(
      (await audit.listForTenant(tenantId)).filter(
        (record) => record.action === 'node_sync.identity_changed',
      ),
    ).toHaveLength(1);
    // A instalação nova segue a própria sequência.
    expect((await syncManaged(node)).status).toBe(200);
    expect(await stateOf()).toMatchObject({ sequence: 2 });
  });

  it('VM do cliente reinstalada: a chave nova e o banco novo começam do 1 sem 409', async () => {
    const vm = await customer();
    const before = await call(
      { kind: 'node_key', nodeKey: vm.nodeKey },
      nodeSyncRequest({ sequence: 900, sentAt: clock.now(), platform: 'vm', identity: fakeNodeIdentity() }),
    );
    expect(before.status).toBe(200);
    // O código novo troca a chave do nó (o registro); o nó novo manda a sequência 1.
    const nodeKey = newEnrollmentSecret();
    await tenants.change(vm.tenant.id, () => ({
      reason: 'teste',
      audit: { actor: 'system' },
      mutate: (t) => ({
        ...t,
        enrollment: { ...t.enrollment!, nodeKeyHash: enrollmentHash(nodeKey) },
      }),
    }));
    clock.advance(MINUTE_MS);
    const after = await call(
      { kind: 'node_key', nodeKey },
      nodeSyncRequest({ sequence: 1, sentAt: clock.now(), platform: 'vm', identity: fakeNodeIdentity() }),
    );
    expect(after.status).toBe(200);
  });

  it('desejado maior que o nó lê: 200 dentro do teto, o que pede ação primeiro, e o resto nas chamadas seguintes', async () => {
    const node = await managed();
    const tenantId = node.tenant.id;
    const now = clock.now();
    // 200 fontes do Cloudflare com 50 zonas longas cada (~10 KB por fonte, ~2 MB ao todo), sem nenhum envelope.
    const big = Array.from({ length: 200 }, (_, index) => ({
      id: sourceId(),
      spec: {
        provider: 'cloudflare' as const,
        accountId: randomBytes(16).toString('hex'),
        zones: Array.from(
          { length: 50 },
          (_, zone) => `z${index}-${zone}-${'a'.repeat(50)}.${'b'.repeat(60)}.${'c'.repeat(60)}.example`,
        ),
      },
    }));
    for (let start = 0; start < big.length; start += 50) {
      await seed((tx) => {
        for (const source of big.slice(start, start + 50)) {
          tx.set(
            COLLECTIONS.logSources(tenantId),
            source.id,
            logSourceSchema.parse({
              spec: source.spec,
              state: 'active',
              revision: 1,
              credentialMeta: null,
              createdAt: now,
              createdBy: ACTOR,
              updatedAt: now,
              updatedBy: ACTOR,
            }),
          );
        }
      });
    }
    // Uma credencial pendente e um usuário pedido: vão na primeira resposta, antes do resto.
    const withCredential = await seedSource(tenantId, { secret: { revision: 1, identity: node.identity } });
    const user = await seedUser(tenantId, node.identity);
    const all = new Set([...big.map((source) => source.id), withCredential.id]);

    const received = new Set<string>();
    let calls = 0;
    while (received.size < all.size && calls < 5) {
      calls += 1;
      // O nó conta o que já aplicou (tudo o que recebeu até aqui).
      const response = await syncManaged(node, {
        sources: [...received].map((id) =>
          id === withCredential.id
            ? sourceReport(id, 1, { revision: 1, outcome: 'applied' })
            : sourceReport(id, 1),
        ),
        users: calls > 1 ? [userCreated(user.id)] : [],
      });
      expect(response.status, `chamada ${calls}`).toBe(200);
      expect(Buffer.byteLength(JSON.stringify(response.body))).toBeLessThanOrEqual(
        NODE_SYNC_RESPONSE_MAX_BYTES,
      );
      const body = nodeSyncResponseSchema.parse(response.body);
      const sent = (body.sources ?? []).map((source) => source.id);
      if (calls === 1) {
        expect(sent).toContain(withCredential.id);
        expect(body.users?.map((entry) => entry.requestId)).toEqual([user.id]);
        expect(sent.length).toBeLessThan(all.size);
        expect(body.pollAfterSeconds).toBe(NODE_SYNC_POLL_MIN_SECONDS);
      } else {
        // O que já foi aplicado fica para o fim: o que faltava vem agora, antes de repetir o que o nó já tem.
        const missing = [...all].filter((id) => !received.has(id));
        expect(sent).toEqual(expect.arrayContaining(missing.slice(0, Math.min(missing.length, 50))));
      }
      for (const id of sent) received.add(id);
      clock.advance(MINUTE_MS);
    }
    expect(received).toEqual(all);
    expect(calls).toBeGreaterThan(1);
  });

  it('o relato cheio (500 fontes) passa pelo leitor próprio da rota, acima dos 16 KB das outras', async () => {
    const node = await managed();
    const sources = Array.from({ length: 500 }, () => sourceReport(sourceId(), 1));
    const response = await syncManaged(node, { sources });
    expect(response.status).toBe(200);
    const line = capture
      .entries()
      .filter((entry) => entry['event'] === 'node_sync' && entry['tenantId'] === node.tenant.id)
      .at(-1);
    expect(line).toMatchObject({ sources: 500, unknownSources: 500, reportsWritten: 0 });
  });

  it('só o cp-public chama; cada rota só com a sua credencial; corpo fora do protocolo é 400', async () => {
    const node = await managed();
    const vm = await customer();
    const token = nodeToken(node);
    const syncBody = nodeSyncRequest({
      sequence: 1,
      sentAt: clock.now(),
      identity: node.identity,
      serviceAccountId: node.sub,
    });
    const post = (path: string, email: string, body: unknown): request.Test =>
      request(app.getHttpServer())
        .post(path)
        .set('Authorization', bearer(email))
        .send(body as object);
    for (const email of [OWNER, INVOKER]) {
      expect((await post('/internal/node-sync/managed', email, { token, request: syncBody })).status).toBe(
        403,
      );
      expect(
        (await post('/internal/node-sync/customer', email, { nodeKey: vm.nodeKey, request: syncBody }))
          .status,
      ).toBe(403);
    }
    // A rota antiga, com a credencial dentro do corpo, não existe mais.
    const legacy = await post('/internal/node-sync', PUBLIC_SA, {
      credential: { kind: 'gcp_identity', token },
      request: syncBody,
    });
    expect(legacy.status).toBe(404);
    for (const [path, bad] of [
      // A credencial da outra rota, no campo desta ou no da outra: recusada pelo corpo estrito.
      ['/internal/node-sync/customer', { nodeKey: token, request: syncBody }],
      ['/internal/node-sync/customer', { token, request: syncBody }],
      ['/internal/node-sync/managed', { token: vm.nodeKey, request: syncBody }],
      ['/internal/node-sync/managed', { nodeKey: vm.nodeKey, request: syncBody }],
      // O formato antigo, um campo a mais e um corpo fora do protocolo.
      ['/internal/node-sync/managed', { credential: { kind: 'gcp_identity', token }, request: syncBody }],
      ['/internal/node-sync/managed', { token, request: syncBody, kind: 'node_key' }],
      ['/internal/node-sync/customer', { nodeKey: 'curta', request: syncBody }],
      ['/internal/node-sync/managed', { token, request: { ...syncBody, protocol: 2 } }],
    ] as const) {
      expect((await post(path, PUBLIC_SA, bad)).status, path).toBe(400);
    }
    expect(await documents.get(COLLECTIONS.nodeSync(node.tenant.id), NODE_SYNC_STATE_DOC)).toBeUndefined();
    expect(await documents.get(COLLECTIONS.nodeSync(vm.tenant.id), NODE_SYNC_STATE_DOC)).toBeUndefined();
    expect(capture.text).not.toContain(vm.nodeKey);
  });
});
