import { generateKeyPairSync, type KeyObject, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AWS_READER_AUDIENCE } from '@verax/shared';
import { type CredentialBinding, openCredential, publicKeyFingerprint } from '@verax/vault-envelope';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  LogSourceView,
  LogSourceWriteResult,
  NodeSyncOverview,
} from '../src/admin/admin-log-sources.schema.js';
import { AuditService } from '../src/audit/audit.service.js';
import { COLLECTIONS } from '../src/firestore/collections.js';
import {
  LOG_SOURCE_SECRET_TTL_MS,
  logSourceReportSchema,
  logSourceSchema,
  logSourceSecretSchema,
  NODE_SYNC_DESIRED_DOC,
  NODE_SYNC_STATE_DOC,
  nodeSyncDesiredSchema,
  nodeSyncStateSchema,
} from '../src/node-sync/node-sync.schema.js';
import { TenantStore } from '../src/tenants/tenant-store.js';
import { type TenantRecord, tenantSchema } from '../src/tenants/tenant.schema.js';
import { tenantIn } from './support/access-store-contract.js';
import { MemoryAdminSecrets, seedOwnerSession } from './support/admin-auth.js';
import { createApp } from './support/create-app.js';
import { FakeClock, MINUTE_MS } from './support/fake-clock.js';
import { LogCapture } from './support/log-capture.js';
import { sourceReport } from './support/node-sync-fixtures.js';
import { RecordingDocumentStore } from './support/recording-document-store.js';
import { demoTenant } from './support/tenant-store-contract.js';

const START = new Date('2026-11-20T12:00:00.000Z');
const OWNER = 'responsavel@verax.example';
const STRANGER = 'outra-pessoa@verax.example';
const NODES = 'projeto-dos-nos-demo';
/** IPs da faixa de documentação (RFC 5737). */
const NAT_IP = '203.0.113.20';
const ACTOR = `owner:${OWNER}`;

const AWS_SPEC = { provider: 'aws', accountId: '123456789012', regions: ['sa-east-1'] } as const;
const CLOUDFLARE_SPEC = {
  provider: 'cloudflare',
  accountId: 'b'.repeat(32),
  zones: ['exemplo.example'],
} as const;
const GCP_SPEC = { provider: 'gcp', accountId: 'projeto-cliente-demo' } as const;

/** Um token do Cloudflare gerado no teste (40 caracteres do base64url: nunca a Global API Key). */
function cloudflareToken(): string {
  return `cfut_${randomBytes(30).toString('base64url')}`;
}

/** Uma chave de acesso de usuário IAM gerada no teste (`AKIA` e 16 do base32 da AWS; o segredo, 40 de base64). */
function awsKey(): { accessKeyId: string; secretAccessKey: string } {
  const base32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const id = Array.from({ length: 16 }, () => base32.charAt(randomInt(base32.length))).join('');
  return { accessKeyId: `AKIA${id}`, secretAccessKey: randomBytes(30).toString('base64') };
}

/** A chave de uma conta de serviço da GCP, com a chave privada RSA gerada no teste. */
function gcpKey(): {
  projectId: string;
  clientEmail: string;
  privateKeyId: string;
  privateKey: string;
} {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    projectId: GCP_SPEC.accountId,
    clientEmail: `verax-control-reader@${GCP_SPEC.accountId}.iam.gserviceaccount.com`,
    privateKeyId: randomBytes(20).toString('hex'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** O cofre do nó do teste: a chave privada fica aqui; o "nó" informa só a pública (como na sincronização). */
interface TestVault {
  privateKey: KeyObject;
  publicPem: string;
  fingerprint: string;
}

function newVault(): TestVault {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { privateKey, publicPem, fingerprint: publicKeyFingerprint(publicPem) };
}

/**
 * As fontes de log no console do responsável (`/v1/admin/tenants/:id/node-sync` e `.../log-sources...`, `ROLE=admin`)
 * pelo app inteiro, sobre o Firestore em memória que guarda o texto de toda gravação: o cadastro, a alteração, a
 * credencial e a remoção, cada uma subindo a revisão e a geração na mesma transação; as regras do lugar do cliente
 * (GCP só na VM do cliente, os tipos de credencial por plataforma); o nó sincronizado com o cofre; o envelope que o
 * "nó" do teste abre com a chave privada dele; o texto claro em lugar nenhum; o subdomínio na remoção; o limite; a
 * pilha da AWS com os valores do plano de controle; e o relato do nó. Dados FICTÍCIOS. Um app por arquivo.
 */
describe('cp-admin: fontes de log do nó do cliente', () => {
  const capture = new LogCapture();
  const clock = new FakeClock(START);
  const documents = new RecordingDocumentStore();
  const audit = new AuditService(documents, clock);
  const tenants = new TenantStore(documents, clock, audit);
  let app: NestExpressApplication;
  let ownerCookie = '';
  let strangerCookie = '';
  let vault: TestVault;
  let slugs = 0;
  let subs = 0;

  beforeAll(async () => {
    vault = newVault();
    app = await createApp({
      role: 'admin',
      nodeEnv: 'production',
      trustProxyHops: 1,
      capture,
      documentStore: documents,
      clock,
      adminSecrets: new MemoryAdminSecrets(),
      env: { LOG_LEVEL: 'debug', ADMIN_SECRETS_PROJECT_ID: 'projeto-exemplo', OWNER_PRINCIPALS: OWNER },
    });
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // O limite das operações (20 por hora) volta cheio a cada teste; as sessões, novas (a ociosa vence).
    clock.advance(2 * 60 * MINUTE_MS);
    ownerCookie = await seedOwnerSession(documents, clock, OWNER);
    strangerCookie = await seedOwnerSession(documents, clock, STRANGER);
  });

  function read(path: string, cookie: string | null = ownerCookie): request.Test {
    const test = request(app.getHttpServer()).get(path);
    return cookie === null ? test : test.set('Cookie', cookie);
  }

  function send(
    method: 'post' | 'patch' | 'put',
    path: string,
    body: unknown,
    cookie: string | null = ownerCookie,
  ): request.Test {
    const test = request(app.getHttpServer())[method](path).set('Content-Type', 'application/json');
    return (cookie === null ? test : test.set('Cookie', cookie)).send(JSON.stringify(body));
  }

  const base = (tenant: TenantRecord) => `/v1/admin/tenants/${tenant.id}`;

  /** Um cliente gerenciado com a VM registrada (o que o `terraform.apply` grava em `resources`). */
  async function managed(): Promise<TenantRecord> {
    slugs += 1;
    subs += 1;
    const created = await tenantIn(tenants, `ls-gerido-${slugs}`, 'active');
    return (
      await tenants.change(created.id, () => ({
        reason: 'teste',
        audit: { actor: 'system' },
        mutate: (t) => ({
          ...t,
          resources: {
            nodesProject: NODES,
            instanceName: `vx-${t.slug}`,
            serviceAccountUniqueId: `2${String(subs).padStart(20, '0')}`,
            natIp: NAT_IP,
          },
        }),
      }))
    ).tenant;
  }

  /** Um contrato direto na VM do cliente. */
  async function customer(): Promise<TenantRecord> {
    slugs += 1;
    const seed = demoTenant(`ls-vm-${slugs}`);
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

  /** O que o cp-worker gravaria na última chamada do nó (`nodeSync/state`). */
  async function seedNode(
    tenant: TenantRecord,
    options: {
      platform?: 'gcp' | 'vm';
      nodeTenantId?: string | null;
      vault?: TestVault | null;
      fingerprint?: string;
      serviceAccountId?: string | null;
      egressIps?: string[];
      audience?: string;
      error?: 'vault_unreadable' | null;
      lastSeenAt?: Date;
    } = {},
  ): Promise<string> {
    const nodeTenantId = options.nodeTenantId === undefined ? randomUUID() : options.nodeTenantId;
    const platform = options.platform ?? (tenant.hosting === 'customer' ? 'vm' : 'gcp');
    const key = options.vault === undefined ? vault : options.vault;
    const state = nodeSyncStateSchema.parse({
      lastSeenAt: options.lastSeenAt ?? clock.now(),
      lastSentAt: options.lastSeenAt ?? clock.now(),
      sequence: 1,
      authKind: platform === 'gcp' ? 'gcp_identity' : 'node_key',
      platform,
      commit: 'c'.repeat(40),
      capabilities: ['log_sources', 'users'],
      nodeTenantId,
      vaultKey:
        key === null
          ? null
          : {
              version: 1,
              publicKey: Buffer.from(key.publicPem, 'utf8').toString('base64'),
              fingerprint: options.fingerprint ?? key.fingerprint,
              since: clock.now(),
            },
      serviceAccountId:
        options.serviceAccountId === undefined
          ? platform === 'gcp'
            ? (tenant.resources?.serviceAccountUniqueId ?? null)
            : null
          : options.serviceAccountId,
      egressIps: options.egressIps ?? (platform === 'gcp' ? [`${NAT_IP}/32`] : ['198.51.100.7/32']),
      audience: options.audience ?? AWS_READER_AUDIENCE,
      error: options.error ?? null,
    });
    await documents.runTransaction((tx) => {
      tx.set(COLLECTIONS.nodeSync(tenant.id), NODE_SYNC_STATE_DOC, state);
      return Promise.resolve();
    });
    return nodeTenantId ?? '';
  }

  async function generation(tenant: TenantRecord): Promise<number> {
    const data = await documents.get(COLLECTIONS.nodeSync(tenant.id), NODE_SYNC_DESIRED_DOC);
    return data === undefined ? 0 : nodeSyncDesiredSchema.parse(data).generation;
  }

  async function storedSource(tenant: TenantRecord, id: string) {
    return logSourceSchema.parse(await documents.get(COLLECTIONS.logSources(tenant.id), id));
  }

  async function storedSecret(tenant: TenantRecord, id: string) {
    const data = await documents.get(COLLECTIONS.logSourceSecrets(tenant.id), id);
    return data === undefined ? undefined : logSourceSecretSchema.parse(data);
  }

  async function auditOf(tenant: TenantRecord) {
    return audit.listForTenant(tenant.id);
  }

  /** O "nó" abre o envelope com a chave privada dele e a amarração que ele monta do próprio banco. */
  function open(envelope: string, binding: CredentialBinding) {
    return openCredential(
      { privateKey: (version) => (version === 1 ? vault.privateKey : undefined) },
      binding,
      envelope,
    );
  }

  async function create(tenant: TenantRecord, body: unknown): Promise<LogSourceWriteResult> {
    const response = await send('post', `${base(tenant)}/log-sources`, body).expect(201);
    return response.body as LogSourceWriteResult;
  }

  async function overview(tenant: TenantRecord): Promise<NodeSyncOverview> {
    return (await read(`${base(tenant)}/node-sync`).expect(200)).body as NodeSyncOverview;
  }

  it('sem sessão: 401; sessão de quem não é responsável: 403; escrita sem JSON: 415; cliente inexistente: 404', async () => {
    const tenant = await managed();
    await read(`${base(tenant)}/node-sync`, null).expect(401);
    await read(`${base(tenant)}/node-sync`, strangerCookie).expect(403);
    await send('post', `${base(tenant)}/log-sources`, { spec: CLOUDFLARE_SPEC }, null).expect(401);
    await request(app.getHttpServer())
      .post(`${base(tenant)}/log-sources`)
      .set('Cookie', ownerCookie)
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify({ spec: CLOUDFLARE_SPEC }))
      .expect(415);
    await read('/v1/admin/tenants/01JZZZZZZZZZZZZZZZZZZZZZZZ/node-sync').expect(404);
    await read('/v1/admin/tenants/nao-e-ulid/node-sync').expect(404);
    expect(await documents.query(COLLECTIONS.logSources(tenant.id))).toEqual([]);
  });

  it('nó que nunca sincronizou: o resumo vazio, a plataforma e os tipos de credencial de cada lugar', async () => {
    const verax = await overview(await managed());
    expect(verax).toMatchObject({
      hosting: 'verax',
      platform: 'gcp',
      credentialKinds: ['cloudflare_api_token'],
      generation: 0,
      node: null,
      sources: [],
      templateUrl: '/v1/admin/aws-reader/verax-control-reader.yaml',
    });
    const vm = await overview(await customer());
    expect(vm).toMatchObject({
      hosting: 'customer',
      platform: 'vm',
      credentialKinds: ['cloudflare_api_token', 'aws_access_key', 'gcp_service_account_key'],
      node: null,
    });
  });

  it('cadastro, alteração e remoção: revisão e geração na mesma transação, imutáveis recusados', async () => {
    const tenant = await managed();
    const created = await create(tenant, {
      spec: { ...AWS_SPEC, buckets: { cloudtrail: 'verax-demo-trilha', guardduty: null } },
    });
    const id = created.source.id;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(created.generation).toBe(1);
    expect(created.source).toMatchObject({
      state: 'active',
      revision: 1,
      status: 'pending',
      pending: true,
      credential: null,
      report: null,
      // A fonte sem bucket (null) sai do cadastro gravado.
      spec: { ...AWS_SPEC, buckets: { cloudtrail: 'verax-demo-trilha' } },
      createdBy: ACTOR,
    });
    expect(await storedSource(tenant, id)).toMatchObject({
      revision: 1,
      state: 'active',
      credentialMeta: null,
    });
    expect(await generation(tenant)).toBe(1);

    // A mesma conta de novo: 409, nada gravado.
    const duplicate = await send('post', `${base(tenant)}/log-sources`, { spec: AWS_SPEC }).expect(409);
    expect(duplicate.body).toMatchObject({ code: 'source_exists' });
    expect(await generation(tenant)).toBe(1);

    const patched = await send('patch', `${base(tenant)}/log-sources/${id}`, {
      regions: ['sa-east-1', 'us-east-1'],
      buckets: { waf: 'aws-waf-logs-demo', cloudtrail: null },
    }).expect(200);
    const afterPatch = patched.body as LogSourceWriteResult;
    expect(afterPatch.generation).toBe(2);
    expect(afterPatch.source).toMatchObject({
      revision: 2,
      spec: { ...AWS_SPEC, regions: ['sa-east-1', 'us-east-1'], buckets: { waf: 'aws-waf-logs-demo' } },
    });
    expect(afterPatch.source.awsStack?.bucketArns).toEqual(['arn:aws:s3:::aws-waf-logs-demo']);

    // Igual ao que está: nada sobe.
    const same = await send('patch', `${base(tenant)}/log-sources/${id}`, {
      regions: ['sa-east-1', 'us-east-1'],
    });
    expect(same.status).toBe(409);
    expect(same.body).toMatchObject({ code: 'no_change' });
    // O provedor e o ID não mudam; o status não é do console; um campo de outro provedor, recusado.
    const immutable = await send('patch', `${base(tenant)}/log-sources/${id}`, { accountId: '210987654321' });
    expect(immutable.status).toBe(400);
    expect(immutable.body).toMatchObject({
      code: 'invalid_request',
      details: { issues: [{ path: 'accountId' }] },
    });
    await send('patch', `${base(tenant)}/log-sources/${id}`, { provider: 'cloudflare' }).expect(400);
    const status = await send('patch', `${base(tenant)}/log-sources/${id}`, { status: 'inactive' }).expect(
      400,
    );
    expect(status.body).toMatchObject({ details: { issues: [{ path: 'status' }] } });
    const outside = await send('patch', `${base(tenant)}/log-sources/${id}`, { zones: ['exemplo.example'] });
    expect(outside.status).toBe(400);
    expect(outside.body).toMatchObject({ details: { issues: [{ path: 'zones' }] } });
    await send('patch', `${base(tenant)}/log-sources/00000000-0000-4000-8000-000000000000`, {
      regions: ['sa-east-1'],
    }).expect(404);
    expect(await generation(tenant)).toBe(2);
    expect((await storedSource(tenant, id)).revision).toBe(2);

    // Remoção: o subdomínio digitado; errado, 400 e a recusa na auditoria.
    const wrong = await send('post', `${base(tenant)}/log-sources/${id}/remove`, { confirmSlug: 'outro' });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toMatchObject({
      code: 'confirmation_mismatch',
      details: { issues: [{ path: 'confirmSlug' }] },
    });
    const removed = await send('post', `${base(tenant)}/log-sources/${id}/remove`, {
      confirmSlug: tenant.slug,
    }).expect(200);
    expect(removed.body).toMatchObject({
      generation: 3,
      source: { state: 'removed', revision: 3, status: 'removing', pending: true },
    });
    expect(await storedSource(tenant, id)).toMatchObject({ state: 'removed', revision: 3 });
    // A lápide fica; nada mais muda nela.
    const again = await send('patch', `${base(tenant)}/log-sources/${id}`, { regions: ['sa-east-1'] });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'source_removed' });
    await send('post', `${base(tenant)}/log-sources/${id}/remove`, { confirmSlug: tenant.slug }).expect(409);
    // A mesma conta pode voltar como fonte nova (outro id).
    const back = await create(tenant, { spec: AWS_SPEC });
    expect(back.source.id).not.toBe(id);
    expect(back.generation).toBe(4);

    const records = await auditOf(tenant);
    const operations = records
      .filter((record) => record.action === 'tenant.console_request')
      .map((record) => record.details?.['operation']);
    expect(operations).toEqual([
      'log_source.create',
      'log_source.update',
      'log_source.remove',
      'log_source.create',
    ]);
    const refused = records
      .filter((record) => record.action === 'tenant.console_request_refused')
      .map((record) => record.details?.['code']);
    expect(refused).toEqual(
      expect.arrayContaining(['source_exists', 'no_change', 'confirmation_mismatch', 'source_removed']),
    );
    expect(records.every((record) => record.actor === ACTOR || record.actor === 'system')).toBe(true);
  });

  it('GCP só na VM do cliente; cliente cancelado e cliente da célula recusados', async () => {
    const tenant = await managed();
    const gcp = await send('post', `${base(tenant)}/log-sources`, { spec: GCP_SPEC });
    expect(gcp.status).toBe(422);
    expect(gcp.body).toMatchObject({
      code: 'gcp_unsupported_managed',
      details: { issues: [{ path: 'spec.provider' }] },
    });
    expect(await generation(tenant)).toBe(0);

    const vm = await customer();
    const created = await create(vm, { spec: GCP_SPEC });
    expect(created.source.readKeys).toMatchObject({
      provider: 'gcp',
      subscription: `projects/${GCP_SPEC.accountId}/subscriptions/verax-control-security`,
      serviceAccountEmail: `verax-control-reader@${GCP_SPEC.accountId}.iam.gserviceaccount.com`,
      role: 'roles/pubsub.subscriber',
    });
    expect(created.source.awsStack).toBeNull();

    const canceled = await tenantIn(tenants, `ls-cancel-${slugs}`, 'canceled');
    const refused = await send('post', `${base(canceled)}/log-sources`, { spec: CLOUDFLARE_SPEC });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'not_allowed' });

    const cell = await managed();
    await documents.runTransaction(async (tx) => {
      const current = tenantSchema.parse(await tx.get(COLLECTIONS.tenants, cell.id));
      tx.set(
        COLLECTIONS.tenants,
        cell.id,
        tenantSchema.parse({ ...current, placement: { kind: 'cell', cellId: 'celula-sp-1' } }),
      );
    });
    const inCell = await send('post', `${base(cell)}/log-sources`, { spec: CLOUDFLARE_SPEC });
    expect(inCell.status).toBe(409);
    expect(inCell.body).toMatchObject({ code: 'placement_unsupported' });
  });

  it('credencial: o nó sincronizado com o cofre, a chave conferida e o tipo da plataforma; senão nada é gravado', async () => {
    const tenant = await managed();
    const body = {
      spec: CLOUDFLARE_SPEC,
      credential: { kind: 'cloudflare_api_token', token: cloudflareToken() },
    };

    const neverSynced = await send('post', `${base(tenant)}/log-sources`, body);
    expect(neverSynced.status).toBe(409);
    expect(neverSynced.body).toMatchObject({ code: 'node_not_synced' });

    await seedNode(tenant, { nodeTenantId: null });
    expect((await send('post', `${base(tenant)}/log-sources`, body)).body).toMatchObject({
      code: 'node_not_synced',
    });

    await seedNode(tenant, { vault: null });
    const noVault = await send('post', `${base(tenant)}/log-sources`, body);
    expect(noVault.status).toBe(409);
    expect(noVault.body).toMatchObject({ code: 'vault_disabled' });
    await seedNode(tenant, { error: 'vault_unreadable' });
    expect((await send('post', `${base(tenant)}/log-sources`, body)).body).toMatchObject({
      code: 'vault_disabled',
    });

    await seedNode(tenant, { platform: 'vm' });
    expect((await send('post', `${base(tenant)}/log-sources`, body)).body).toMatchObject({
      code: 'platform_mismatch',
    });

    // A impressão digital informada não é a da chave: nada é cifrado.
    await seedNode(tenant, { fingerprint: 'f'.repeat(64) });
    const badKey = await send('post', `${base(tenant)}/log-sources`, body);
    expect(badKey.status).toBe(409);
    expect(badKey.body).toMatchObject({ code: 'vault_key_invalid' });

    // A chave de acesso da AWS não vale no nó gerenciado (a AWS é lida pelo papel sem chave).
    await seedNode(tenant);
    const awsOnManaged = await send('post', `${base(tenant)}/log-sources`, {
      spec: AWS_SPEC,
      credential: { kind: 'aws_access_key', ...awsKey() },
    });
    expect(awsOnManaged.status).toBe(422);
    expect(awsOnManaged.body).toMatchObject({ code: 'credential_kind_not_allowed' });
    // Credencial de outro provedor.
    const mismatch = await send('post', `${base(tenant)}/log-sources`, {
      spec: AWS_SPEC,
      credential: body.credential,
    });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body).toMatchObject({ code: 'credential_provider_mismatch' });
    // A Global API Key do Cloudflare, como no painel.
    const globalKey = await send('post', `${base(tenant)}/log-sources`, {
      spec: CLOUDFLARE_SPEC,
      credential: { kind: 'cloudflare_api_token', token: randomBytes(20).toString('hex').slice(0, 37) },
    });
    expect(globalKey.status).toBe(400);
    expect(globalKey.body).toMatchObject({
      code: 'invalid_request',
      details: { issues: [{ path: 'credential.token' }] },
    });

    expect(await documents.query(COLLECTIONS.logSources(tenant.id))).toEqual([]);
    expect(await documents.query(COLLECTIONS.logSourceSecrets(tenant.id))).toEqual([]);
    expect(await generation(tenant)).toBe(0);
    const codes = (await auditOf(tenant))
      .filter((record) => record.action === 'tenant.console_request_refused')
      .map((record) => record.details?.['code']);
    expect(codes).toEqual(
      expect.arrayContaining([
        'node_not_synced',
        'vault_disabled',
        'platform_mismatch',
        'vault_key_invalid',
        'credential_kind_not_allowed',
        'credential_provider_mismatch',
      ]),
    );
  });

  it('o envelope cifrado aqui abre no nó, e o texto claro não aparece em lugar nenhum', async () => {
    const tenant = await managed();
    const nodeTenantId = await seedNode(tenant);
    const token = cloudflareToken();
    const writesBefore = documents.writes.length;
    const linesBefore = capture.lines.length;

    const response = await send('post', `${base(tenant)}/log-sources`, {
      spec: CLOUDFLARE_SPEC,
      credential: { kind: 'cloudflare_api_token', token },
    }).expect(201);
    const created = response.body as LogSourceWriteResult;
    const id = created.source.id;
    expect(created.source.credential).toMatchObject({
      kind: 'cloudflare_api_token',
      revision: 1,
      keyVersion: 1,
      fingerprint: vault.fingerprint,
      submittedBy: ACTOR,
      envelopeStored: true,
    });
    expect(created.source.cloudflareToken).toMatchObject({ egressIps: [`${NAT_IP}/32`] });
    const secret = await storedSecret(tenant, id);
    expect(secret).toMatchObject({
      revision: 1,
      kind: 'cloudflare_api_token',
      fingerprint: vault.fingerprint,
      nodeTenantId,
    });
    expect(secret?.expiresAt.getTime()).toBe(clock.now().getTime() + LOG_SOURCE_SECRET_TTL_MS);
    const binding: CredentialBinding = {
      tenantId: nodeTenantId,
      cloudAccountId: id,
      kind: 'cloudflare_api_token',
      accountId: CLOUDFLARE_SPEC.accountId,
    };
    expect(open(secret?.envelope ?? '', binding)).toEqual({
      kind: 'cloudflare_api_token',
      payload: { t: token },
    });
    // Amarrado à fonte e ao cliente do banco do nó: outra fonte (ou outro cliente) não abre.
    expect(() => open(secret?.envelope ?? '', { ...binding, cloudAccountId: randomUUID() })).toThrow();
    expect(() => open(secret?.envelope ?? '', { ...binding, tenantId: randomUUID() })).toThrow();

    // A troca: revisão 2 da credencial, a revisão da fonte igual, a geração sobe.
    const replacement = cloudflareToken();
    const put = await send('put', `${base(tenant)}/log-sources/${id}/credential`, {
      kind: 'cloudflare_api_token',
      token: replacement,
    }).expect(200);
    expect(put.body).toMatchObject({ generation: 2, source: { revision: 1, credential: { revision: 2 } } });
    const second = await storedSecret(tenant, id);
    expect(second?.revision).toBe(2);
    expect(open(second?.envelope ?? '', binding).payload).toEqual({ t: replacement });

    const entries = (await auditOf(tenant)).filter((record) => record.action === 'tenant.console_request');
    expect(entries.map((record) => record.details)).toEqual([
      expect.objectContaining({
        operation: 'log_source.create',
        keyKind: 'cloudflare_api_token',
        keyRevision: 1,
      }),
      expect.objectContaining({
        operation: 'log_source.credential',
        keyRevision: 2,
        fingerprint: vault.fingerprint,
      }),
    ]);

    // Nem a resposta, nem o log, nem a auditoria, nem documento algum gravado (inclusive os sobrescritos).
    const logs = capture.lines.slice(linesBefore).join('');
    const written = documents.writes.slice(writesBefore).join('\n');
    expect(logs).toContain('admin_log_source');
    for (const value of [token, replacement]) {
      expect(JSON.stringify(response.body)).not.toContain(value);
      expect(JSON.stringify(put.body)).not.toContain(value);
      expect(logs).not.toContain(value);
      expect(written).not.toContain(value);
    }
    // E o envelope não sai na leitura do console.
    const view = await read(`${base(tenant)}/node-sync`).expect(200);
    expect(view.text).not.toContain(second?.envelope ?? 'x');
    expect(view.text).not.toContain(replacement);
  });

  it('VM do cliente: a chave da AWS e a da GCP cifradas para o nó, sem o segredo em lugar nenhum', async () => {
    const tenant = await customer();
    const nodeTenantId = await seedNode(tenant);
    const writesBefore = documents.writes.length;
    const linesBefore = capture.lines.length;

    const aws = await create(tenant, { spec: AWS_SPEC });
    expect(aws.source.awsStack).toBeNull();
    expect(aws.source.readKeys).toMatchObject({
      provider: 'aws',
      userArn: 'arn:aws:iam::123456789012:user/verax/verax-control-reader',
      egressIps: ['198.51.100.7/32'],
    });
    const key = awsKey();
    const put = await send('put', `${base(tenant)}/log-sources/${aws.source.id}/credential`, {
      kind: 'aws_access_key',
      ...key,
    }).expect(200);
    expect(put.body).toMatchObject({ source: { credential: { kind: 'aws_access_key', revision: 1 } } });
    const awsSecret = await storedSecret(tenant, aws.source.id);
    expect(
      open(awsSecret?.envelope ?? '', {
        tenantId: nodeTenantId,
        cloudAccountId: aws.source.id,
        kind: 'aws_access_key',
        accountId: AWS_SPEC.accountId,
      }).payload,
    ).toEqual({ i: key.accessKeyId, s: key.secretAccessKey });

    const gcp = gcpKey();
    const created = await send('post', `${base(tenant)}/log-sources`, {
      spec: GCP_SPEC,
      credential: { kind: 'gcp_service_account_key', ...gcp },
    }).expect(201);
    const gcpId = (created.body as LogSourceWriteResult).source.id;
    const gcpSecret = await storedSecret(tenant, gcpId);
    expect(
      open(gcpSecret?.envelope ?? '', {
        tenantId: nodeTenantId,
        cloudAccountId: gcpId,
        kind: 'gcp_service_account_key',
        accountId: GCP_SPEC.accountId,
      }).payload,
    ).toEqual({ p: gcp.projectId, e: gcp.clientEmail, d: gcp.privateKeyId, k: gcp.privateKey });

    const logs = capture.lines.slice(linesBefore).join('');
    const written = documents.writes.slice(writesBefore).join('\n');
    const responses = JSON.stringify([put.body, created.body]);
    // A chave privada vai ao JSON com `\n` escapado: o texto escapado e uma linha do base64 dela.
    const pemLine = gcp.privateKey.split('\n')[5] ?? 'x';
    const escapedPem = JSON.stringify(gcp.privateKey).slice(1, -1);
    for (const value of [key.secretAccessKey, key.accessKeyId, escapedPem, pemLine]) {
      expect(responses).not.toContain(value);
      expect(logs).not.toContain(value);
      expect(written).not.toContain(value);
    }
  });

  it('remoção apaga o envelope pendente; credencial numa fonte removida é recusada', async () => {
    const tenant = await managed();
    await seedNode(tenant);
    const created = await create(tenant, {
      spec: CLOUDFLARE_SPEC,
      credential: { kind: 'cloudflare_api_token', token: cloudflareToken() },
    });
    const id = created.source.id;
    expect(await storedSecret(tenant, id)).toBeDefined();
    await send('post', `${base(tenant)}/log-sources/${id}/remove`, { confirmSlug: tenant.slug }).expect(200);
    expect(await storedSecret(tenant, id)).toBeUndefined();
    const refused = await send('put', `${base(tenant)}/log-sources/${id}/credential`, {
      kind: 'cloudflare_api_token',
      token: cloudflareToken(),
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'source_removed' });
    expect(await storedSecret(tenant, id)).toBeUndefined();
  });

  it('limite das operações por responsável: 429 e a recusa na auditoria', async () => {
    const tenant = await managed();
    const accounts = Array.from({ length: 25 }, (_, index) => index.toString(16).padStart(32, 'c'));
    const statuses: number[] = [];
    for (const accountId of accounts) {
      const response = await send('post', `${base(tenant)}/log-sources`, {
        spec: { provider: 'cloudflare', accountId },
      });
      statuses.push(response.status);
      if (response.status === 429) expect(response.body).toMatchObject({ code: 'rate_limited' });
    }
    expect(statuses.filter((status) => status === 201)).toHaveLength(20);
    expect(statuses.slice(20).every((status) => status === 429)).toBe(true);
    expect(await generation(tenant)).toBe(20);
    const limited = (await auditOf(tenant)).filter(
      (record) =>
        record.action === 'tenant.console_request_refused' && record.details?.['code'] === 'rate_limited',
    );
    expect(limited).toHaveLength(5);
    // A leitura não gasta o limite.
    await read(`${base(tenant)}/node-sync`).expect(200);
  });

  it('a pilha da AWS com os valores do plano de controle, e o aviso quando o nó informa outros', async () => {
    const tenant = await managed();
    const created = await create(tenant, {
      spec: { ...AWS_SPEC, buckets: { cloudtrail: 'verax-demo-trilha' } },
    });
    const sa = tenant.resources?.serviceAccountUniqueId ?? '';
    const { deployCommand: command = '', ...stack } = created.source.awsStack ?? {};
    expect(stack).toEqual({
      stackName: 'verax-control-reader',
      roleArn: 'arn:aws:iam::123456789012:role/verax/verax-control-reader',
      nodeServiceAccountId: sa,
      egressIps: [`${NAT_IP}/32`],
      audience: AWS_READER_AUDIENCE,
      bucketArns: ['arn:aws:s3:::verax-demo-trilha'],
      consoleUrl: 'https://console.aws.amazon.com/cloudformation/home?region=sa-east-1#/stacks/create',
      templateUrl: '/v1/admin/aws-reader/verax-control-reader.yaml',
      mismatch: false,
      mismatches: [],
    });
    expect(command).toContain(`NodeServiceAccountId=${sa}`);
    expect(command).toContain(`NodeEgressIps=${NAT_IP}/32`);
    expect(command).toContain(`Audience=${AWS_READER_AUDIENCE}`);
    expect(command).toContain('LogBucketArns=arn:aws:s3:::verax-demo-trilha');

    // O nó informa os mesmos valores: sem aviso.
    await seedNode(tenant);
    const same = (await overview(tenant)).sources[0];
    expect(same?.awsStack).toMatchObject({ mismatch: false, mismatches: [] });

    // O nó informa outros (a VM recriada, outro IP, outro audience no node.conf): aviso, e a pilha segue o plano
    // de controle.
    await seedNode(tenant, {
      serviceAccountId: '300000000000000000009',
      egressIps: ['203.0.113.99/32'],
      audience: 'https://outro.example/aws-reader',
    });
    const view = await overview(tenant);
    expect(view.sources[0]?.awsStack).toMatchObject({
      mismatch: true,
      mismatches: ['serviceAccountId', 'egressIps', 'audience'],
      nodeServiceAccountId: sa,
      egressIps: [`${NAT_IP}/32`],
      audience: AWS_READER_AUDIENCE,
    });
    expect(view.node).toMatchObject({
      platform: 'gcp',
      platformMismatch: false,
      vaultReady: true,
      fingerprint: vault.fingerprint,
      keyVersion: 1,
      serviceAccountId: '300000000000000000009',
      stale: false,
    });
  });

  it('o relato do nó: aplicada, credencial recusada, removida e o nó parado', async () => {
    const tenant = await managed();
    await seedNode(tenant);
    const created = await create(tenant, {
      spec: CLOUDFLARE_SPEC,
      credential: { kind: 'cloudflare_api_token', token: cloudflareToken() },
    });
    const id = created.source.id;

    async function report(value: ReturnType<typeof sourceReport>): Promise<LogSourceView | undefined> {
      await documents.runTransaction((tx) => {
        tx.set(
          COLLECTIONS.logSourceReports(tenant.id),
          id,
          logSourceReportSchema.parse({ report: value, reportedAt: clock.now() }),
        );
        return Promise.resolve();
      });
      return (await overview(tenant)).sources.find((source) => source.id === id);
    }

    // A fonte aplicada, mas a credencial ainda não: pendente.
    expect(await report(sourceReport(id, 1))).toMatchObject({ status: 'pending', pending: true, code: null });
    // As duas aplicadas.
    const applied = await report(sourceReport(id, 1, { revision: 1, outcome: 'applied' }));
    expect(applied).toMatchObject({
      status: 'applied',
      pending: false,
      report: { revision: 1, outcome: 'applied', credential: { revision: 1, outcome: 'applied' } },
    });
    expect(applied?.report?.reportedAt).toBe(clock.now().toISOString());

    // Credencial nova recusada na origem pelo nó.
    await send('put', `${base(tenant)}/log-sources/${id}/credential`, {
      kind: 'cloudflare_api_token',
      token: cloudflareToken(),
    }).expect(200);
    expect((await overview(tenant)).sources[0]).toMatchObject({ status: 'pending', pending: true });
    const rejected = await report(
      sourceReport(id, 1, { revision: 2, outcome: 'failed', code: 'credential_rejected_invalid' }),
    );
    expect(rejected).toMatchObject({ status: 'failed', code: 'credential_rejected_invalid', pending: true });

    // A revisão desejada falhou no nó.
    await send('patch', `${base(tenant)}/log-sources/${id}`, { zones: ['outro.example'] }).expect(200);
    const failed = await report({ ...sourceReport(id, 2), outcome: 'failed', code: 'origin_conflict' });
    expect(failed).toMatchObject({ status: 'failed', code: 'origin_conflict' });

    // A lápide: removendo até o nó contar, removida depois.
    await send('post', `${base(tenant)}/log-sources/${id}/remove`, { confirmSlug: tenant.slug }).expect(200);
    expect((await overview(tenant)).sources[0]).toMatchObject({ status: 'removing', pending: true });
    const gone = await report({ ...sourceReport(id, 3), outcome: 'removed', account: null });
    expect(gone).toMatchObject({ status: 'removed', pending: false });

    // O nó sem chamar há mais de 15 minutos.
    await seedNode(tenant, { lastSeenAt: new Date(clock.now().getTime() - 16 * MINUTE_MS) });
    expect((await overview(tenant)).node).toMatchObject({ stale: true });
  });

  it('o template do papel de leitura, do commit da imagem, atrás da sessão', async () => {
    await read('/v1/admin/aws-reader/verax-control-reader.yaml', null).expect(401);
    const response = await read('/v1/admin/aws-reader/verax-control-reader.yaml')
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(response.headers['content-type']).toBe('text/yaml; charset=utf-8');
    expect(response.headers['content-disposition']).toBe('attachment; filename="verax-control-reader.yaml"');
    expect(response.headers['cache-control']).toBe('private, no-store');
    const file = readFileSync(
      fileURLToPath(new URL('../../../infra/cloudformation/verax-control-reader.yaml', import.meta.url)),
    );
    expect(Buffer.compare(response.body as Buffer, file)).toBe(0);
  });
});
