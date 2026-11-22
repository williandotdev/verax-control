import { generateKeyPairSync, type KeyObject, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  AWS_READER_AUDIENCE,
  type NodeSyncRequest,
  type NodeSyncResponse,
  nodeSyncResponseSchema,
  type NodeSyncUserReport,
  TEMPORARY_PASSWORD_HOURS,
} from '@verax/shared';
import { openUserPassword, publicKeyFingerprint } from '@verax/vault-envelope';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NodeSyncOverview } from '../src/admin/admin-log-sources.schema.js';
import type { NodeUserCreated, NodeUserView } from '../src/admin/admin-node-users.schema.js';
import { AuditService } from '../src/audit/audit.service.js';
import { enrollmentHash, newEnrollmentSecret } from '../src/enrollment/enrollment.js';
import { COLLECTIONS } from '../src/firestore/collections.js';
import {
  NODE_SYNC_DESIRED_DOC,
  NODE_SYNC_STATE_DOC,
  NODE_USER_SECRET_GRACE_MS,
  nodeSyncDesiredSchema,
  nodeSyncStateSchema,
  nodeUserReportSchema,
  nodeUserSchema,
  nodeUserSecretSchema,
} from '../src/node-sync/node-sync.schema.js';
import { TenantStore } from '../src/tenants/tenant-store.js';
import { type TenantRecord, tenantSchema } from '../src/tenants/tenant.schema.js';
import { TestGoogleIdentity } from './support/access-fakes.js';
import { tenantIn } from './support/access-store-contract.js';
import { MemoryAdminSecrets, seedOwnerSession } from './support/admin-auth.js';
import { createApp } from './support/create-app.js';
import { FakeClock, MINUTE_MS } from './support/fake-clock.js';
import { LogCapture } from './support/log-capture.js';
import { nodeSyncRequest, userCreated, userFailed } from './support/node-sync-fixtures.js';
import { RecordingDocumentStore } from './support/recording-document-store.js';
import { demoTenant } from './support/tenant-store-contract.js';

const WORKER_URL = 'https://cp-worker-123456789012.southamerica-east1.run.app';
const INVOKER = 'cp-invoker@projeto-exemplo.iam.gserviceaccount.com';
const PUBLIC_SA = 'cp-public@projeto-exemplo.iam.gserviceaccount.com';
const OWNER = 'responsavel@verax.example';
const STRANGER = 'outra-pessoa@verax.example';
const NODES = 'projeto-dos-nos-demo';
const ACTOR = `owner:${OWNER}`;
const HOUR_MS = 60 * MINUTE_MS;
/** Antes do relógio do sistema: os tokens de teste vencem em 1 h pelo relógio real, e o worker confere pelos dois. */
const START = new Date(Math.floor((Date.now() - 24 * HOUR_MS) / 1000) * 1000);

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
 * Os usuários do cliente que a Verax cria pelo console (`POST /v1/admin/tenants/:id/users` e a lista no
 * `GET .../node-sync`), com o cp-admin e o cp-worker de verdade sobre o mesmo Firestore em memória (que guarda o texto
 * de toda gravação): a senha temporária gerada no cp-admin, mostrada uma vez, cifrada para o cofre do nó e amarrada ao
 * pedido; o "nó" do teste (a VM do cliente, pela chave do registro) recebe o pedido na sincronização e abre o envelope
 * com a chave privada dele; o envelope sai do Firestore quando o nó conta o resultado; as recusas; o limite; a situação
 * de cada pedido pelo relato do nó; e a senha em lugar nenhum. Dados FICTÍCIOS.
 */
describe('cp-admin e cp-worker: usuários do cliente pelo console', () => {
  const capture = new LogCapture();
  const clock = new FakeClock(START);
  const documents = new RecordingDocumentStore();
  const google = new TestGoogleIdentity();
  const audit = new AuditService(documents, clock);
  const tenants = new TenantStore(documents, clock, audit);
  /** Toda senha que o console devolveu no arquivo: nenhuma pode aparecer no log, na auditoria ou no Firestore. */
  const passwords = new Set<string>();
  let worker: NestExpressApplication;
  let admin: NestExpressApplication;
  let ownerCookie = '';
  let strangerCookie = '';
  let vault: TestVault;
  let slugs = 0;
  let subs = 0;

  beforeAll(async () => {
    vault = newVault();
    worker = await createApp({
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
    await worker.listen(0, '127.0.0.1');
    admin = await createApp({
      role: 'admin',
      nodeEnv: 'production',
      trustProxyHops: 1,
      capture,
      documentStore: documents,
      clock,
      adminSecrets: new MemoryAdminSecrets(),
      env: { LOG_LEVEL: 'debug', ADMIN_SECRETS_PROJECT_ID: 'projeto-exemplo', OWNER_PRINCIPALS: OWNER },
    });
    await admin.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await admin.close();
    await worker.close();
  });

  beforeEach(async () => {
    // O limite das operações (20 por hora) volta cheio a cada teste; as sessões, novas (a ociosa vence). Também passa
    // o intervalo mínimo entre duas chamadas do mesmo nó.
    clock.advance(2 * HOUR_MS);
    ownerCookie = await seedOwnerSession(documents, clock, OWNER);
    strangerCookie = await seedOwnerSession(documents, clock, STRANGER);
  });

  const base = (tenant: TenantRecord) => `/v1/admin/tenants/${tenant.id}`;

  function read(path: string, cookie: string | null = ownerCookie): request.Test {
    const test = request(admin.getHttpServer()).get(path);
    return cookie === null ? test : test.set('Cookie', cookie);
  }

  function post(path: string, body: unknown, cookie: string | null = ownerCookie): request.Test {
    const test = request(admin.getHttpServer()).post(path).set('Content-Type', 'application/json');
    return (cookie === null ? test : test.set('Cookie', cookie)).send(JSON.stringify(body));
  }

  async function createUser(tenant: TenantRecord, body: unknown): Promise<NodeUserCreated> {
    const response = await post(`${base(tenant)}/users`, body).expect(201);
    const created = response.body as NodeUserCreated;
    passwords.add(created.temporaryPassword);
    return created;
  }

  async function overview(tenant: TenantRecord): Promise<NodeSyncOverview> {
    return (await read(`${base(tenant)}/node-sync`).expect(200)).body as NodeSyncOverview;
  }

  async function generation(tenant: TenantRecord): Promise<number> {
    const data = await documents.get(COLLECTIONS.nodeSync(tenant.id), NODE_SYNC_DESIRED_DOC);
    return data === undefined ? 0 : nodeSyncDesiredSchema.parse(data).generation;
  }

  async function storedSecret(tenant: TenantRecord, requestId: string) {
    const data = await documents.get(COLLECTIONS.nodeUserSecrets(tenant.id), requestId);
    return data === undefined ? undefined : nodeUserSecretSchema.parse(data);
  }

  /** O "nó" abre o envelope com a chave privada dele e a amarração que monta do próprio banco. */
  function open(envelope: string, binding: { nodeTenantId: string; requestId: string; email: string }) {
    return openUserPassword(
      { privateKey: (version) => (version === 1 ? vault.privateKey : undefined) },
      binding,
      envelope,
    );
  }

  /** Um cliente gerenciado com a VM registrada (o que o `terraform.apply` grava em `resources`). */
  async function managed(state: 'active' | 'canceled' = 'active'): Promise<TenantRecord> {
    slugs += 1;
    subs += 1;
    const created = await tenantIn(tenants, `us-gerido-${slugs}`, state);
    return (
      await tenants.change(created.id, () => ({
        reason: 'teste',
        audit: { actor: 'system' },
        mutate: (t) => ({
          ...t,
          resources: {
            nodesProject: NODES,
            instanceName: `vx-${t.slug}`,
            serviceAccountUniqueId: `3${String(subs).padStart(20, '0')}`,
          },
        }),
      }))
    ).tenant;
  }

  /** Um contrato direto na VM do cliente, já registrado (a chave do nó guardada só como hash). */
  async function customer(): Promise<{ tenant: TenantRecord; nodeKey: string }> {
    slugs += 1;
    const seed = demoTenant(`us-vm-${slugs}`);
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
            codeExpiresAt: new Date(now.getTime() + HOUR_MS),
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

  /** O que o cp-worker gravaria na última chamada do nó (`nodeSync/state`), para os testes só do cp-admin. */
  async function seedNode(
    tenant: TenantRecord,
    options: {
      nodeTenantId?: string | null;
      vault?: TestVault | null;
      fingerprint?: string;
      platform?: 'gcp' | 'vm';
      capabilities?: ('log_sources' | 'users')[];
    } = {},
  ): Promise<string> {
    const nodeTenantId = options.nodeTenantId === undefined ? randomUUID() : options.nodeTenantId;
    const platform = options.platform ?? (tenant.hosting === 'customer' ? 'vm' : 'gcp');
    const key = options.vault === undefined ? vault : options.vault;
    const state = nodeSyncStateSchema.parse({
      lastSeenAt: clock.now(),
      lastSentAt: clock.now(),
      sequence: 1,
      authKind: platform === 'gcp' ? 'gcp_identity' : 'node_key',
      platform,
      commit: 'c'.repeat(40),
      capabilities: options.capabilities ?? ['log_sources', 'users'],
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
      serviceAccountId: platform === 'gcp' ? (tenant.resources?.serviceAccountUniqueId ?? null) : null,
      egressIps: ['198.51.100.7/32'],
      audience: AWS_READER_AUDIENCE,
      error: null,
    });
    await documents.runTransaction((tx) => {
      tx.set(COLLECTIONS.nodeSync(tenant.id), NODE_SYNC_STATE_DOC, state);
      return Promise.resolve();
    });
    return nodeTenantId ?? '';
  }

  /** O relato do nó gravado como o cp-worker grava (para os testes da situação de cada pedido). */
  async function seedReport(tenant: TenantRecord, report: NodeSyncUserReport): Promise<void> {
    await documents.runTransaction((tx) => {
      tx.set(
        COLLECTIONS.nodeUserReports(tenant.id),
        report.requestId,
        nodeUserReportSchema.parse({ report, reportedAt: clock.now() }),
      );
      return Promise.resolve();
    });
  }

  /** Uma chamada da VM do cliente ao cp-worker, como o cp-public repassa, com a chave pública real do cofre. */
  function sync(
    node: { nodeKey: string; nodeTenantId: string; sequence: number },
    options: { capabilities?: NodeSyncRequest['capabilities']; users?: NodeSyncUserReport[] } = {},
  ): request.Test {
    node.sequence += 1;
    const body = nodeSyncRequest({
      sequence: node.sequence,
      sentAt: clock.now(),
      platform: 'vm',
      identity: { tenantId: node.nodeTenantId, fingerprint: vault.fingerprint, keyVersion: 1 },
      ...options,
    });
    body.node.vaultKey = {
      version: 1,
      publicKey: Buffer.from(vault.publicPem, 'utf8').toString('base64'),
      fingerprint: vault.fingerprint,
    };
    return request(worker.getHttpServer())
      .post('/internal/node-sync/customer')
      .set('Authorization', `Bearer ${google.token({ email: PUBLIC_SA, aud: WORKER_URL })}`)
      .send({ nodeKey: node.nodeKey, request: body });
  }

  it('sem sessão: 401; quem não é responsável: 403; sem JSON: 415; cliente inexistente: 404', async () => {
    const tenant = await managed();
    await seedNode(tenant);
    const body = { name: 'Pessoa Demo', email: 'pessoa@cliente-demo.example', role: 'leitura' };
    await post(`${base(tenant)}/users`, body, null).expect(401);
    await post(`${base(tenant)}/users`, body, strangerCookie).expect(403);
    await request(admin.getHttpServer())
      .post(`${base(tenant)}/users`)
      .set('Cookie', ownerCookie)
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify(body))
      .expect(415);
    await post('/v1/admin/tenants/01JZZZZZZZZZZZZZZZZZZZZZZZ/users', body).expect(404);
    await post('/v1/admin/tenants/nao-e-ulid/users', body).expect(404);
    expect(await documents.query(COLLECTIONS.nodeUsers(tenant.id))).toEqual([]);
    expect(await generation(tenant)).toBe(0);
  });

  it('do console ao nó: a senha mostrada uma vez, o envelope que só o nó abre e apagado depois do relato', async () => {
    const { tenant, nodeKey } = await customer();
    const node = { nodeKey, nodeTenantId: randomUUID(), sequence: 0 };
    // A primeira chamada do nó grava o estado dele (a chave do cofre e a capacidade `users`).
    const first = await sync(node).expect(200);
    expect((first.body as NodeSyncResponse).users).toEqual([]);
    const writesBefore = documents.writes.length;
    const linesBefore = capture.lines.length;
    clock.advance(MINUTE_MS);

    const response = await post(`${base(tenant)}/users`, {
      name: '  Pessoa Demo  ',
      email: 'Pessoa.Demo@Cliente-Demo.example',
      role: 'analista_cliente',
    }).expect(201);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const created = response.body as NodeUserCreated;
    passwords.add(created.temporaryPassword);
    const notAfter = clock.now().getTime() + TEMPORARY_PASSWORD_HOURS * HOUR_MS;
    expect(created).toEqual({
      requestId: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/) as unknown,
      panelUrl: `https://${tenant.slug}.control.veraxsistemas.com.br`,
      email: 'pessoa.demo@cliente-demo.example',
      role: 'analista_cliente',
      temporaryPassword: expect.stringMatching(
        /^[A-Za-z2-9]{5}-[A-Za-z2-9]{5}-[A-Za-z2-9]{5}-[A-Za-z2-9]{5}$/,
      ) as unknown,
      notAfter: new Date(notAfter).toISOString(),
    });
    const { requestId, temporaryPassword } = created;

    // O pedido, o envelope (válido 1 dia além do prazo) e a geração, na mesma transação.
    const user = nodeUserSchema.parse(await documents.get(COLLECTIONS.nodeUsers(tenant.id), requestId));
    expect(user).toEqual({
      name: 'Pessoa Demo',
      email: 'pessoa.demo@cliente-demo.example',
      role: 'analista_cliente',
      notAfter: new Date(notAfter),
      createdAt: clock.now(),
      createdBy: ACTOR,
    });
    const secret = await storedSecret(tenant, requestId);
    expect(secret).toMatchObject({ fingerprint: vault.fingerprint, nodeTenantId: node.nodeTenantId });
    expect(secret?.expiresAt.getTime()).toBe(notAfter + NODE_USER_SECRET_GRACE_MS);
    expect(await generation(tenant)).toBe(1);

    // Amarrado ao cliente do banco do nó, ao pedido e ao e-mail: só essa combinação abre.
    const binding = { nodeTenantId: node.nodeTenantId, requestId, email: created.email };
    expect(open(secret?.envelope ?? '', binding)).toBe(temporaryPassword);
    expect(open(secret?.envelope ?? '', { ...binding, email: 'PESSOA.DEMO@cliente-demo.example' })).toBe(
      temporaryPassword,
    );
    expect(() => open(secret?.envelope ?? '', { ...binding, email: 'outra@cliente-demo.example' })).toThrow();
    expect(() =>
      open(secret?.envelope ?? '', { ...binding, requestId: '01JZZZZZZZZZZZZZZZZZZZZZZZ' }),
    ).toThrow();
    expect(() => open(secret?.envelope ?? '', { ...binding, nodeTenantId: randomUUID() })).toThrow();

    // A lista do console: pendente, sem a senha e sem o envelope.
    const pending = await read(`${base(tenant)}/node-sync`).expect(200);
    expect((pending.body as NodeSyncOverview).users).toEqual([
      {
        requestId,
        name: 'Pessoa Demo',
        email: 'pessoa.demo@cliente-demo.example',
        role: 'analista_cliente',
        notAfter: new Date(notAfter).toISOString(),
        createdAt: clock.now().toISOString(),
        createdBy: ACTOR,
        status: 'pending',
      },
    ]);
    expect(pending.body).toMatchObject({ usersSupported: true, usersBlockedBy: null });
    expect(pending.text).not.toContain(temporaryPassword);
    expect(pending.text).not.toContain(secret?.envelope ?? 'x');

    // O nó que anuncia `users` recebe o pedido com o envelope, e abre a senha.
    clock.advance(MINUTE_MS);
    const served = nodeSyncResponseSchema.parse((await sync(node).expect(200)).body);
    expect(served.generation).toBe(1);
    expect(served.users).toEqual([
      {
        requestId,
        name: 'Pessoa Demo',
        email: 'pessoa.demo@cliente-demo.example',
        role: 'analista_cliente',
        envelope: secret?.envelope,
        notAfter: new Date(notAfter).toISOString(),
      },
    ]);
    expect(open(served.users?.[0]?.envelope ?? '', binding)).toBe(temporaryPassword);
    // O nó sem a capacidade não recebe a seção.
    clock.advance(MINUTE_MS);
    const old = nodeSyncResponseSchema.parse(
      (await sync(node, { capabilities: ['log_sources'] }).expect(200)).body,
    );
    expect(old.users).toBeUndefined();

    // O nó conta que criou: o envelope sai do Firestore, e o pedido não volta mais.
    clock.advance(MINUTE_MS);
    const after = nodeSyncResponseSchema.parse(
      (await sync(node, { users: [userCreated(requestId)] }).expect(200)).body,
    );
    expect(after.users).toEqual([]);
    expect(await storedSecret(tenant, requestId)).toBeUndefined();
    const view = await overview(tenant);
    expect(view.users[0]).toMatchObject({
      requestId,
      status: 'created',
      user: { status: 'active', mfaEnabled: false, mustChangePassword: true },
      reportedAt: clock.now().toISOString(),
    });

    // A auditoria do plano de controle: o pedido, o papel e a chave, nunca a senha nem o envelope.
    const entries = (await audit.listForTenant(tenant.id)).filter(
      (record) => record.action === 'tenant.console_request',
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: ACTOR,
      details: {
        operation: 'node_user.create',
        outcome: 'ok',
        userRequestId: requestId,
        email: 'pessoa.demo@cliente-demo.example',
        role: 'analista_cliente',
        keyVersion: 1,
        fingerprint: vault.fingerprint,
        generation: 1,
      },
    });
    const logs = capture.lines.slice(linesBefore).join('');
    const written = documents.writes.slice(writesBefore).join('\n');
    expect(logs).toContain('admin_node_user');
    expect(logs).not.toContain(temporaryPassword);
    expect(written).not.toContain(temporaryPassword);
    expect(JSON.stringify(entries)).not.toContain(temporaryPassword);
    expect(JSON.stringify(entries)).not.toContain(secret?.envelope ?? 'x');
    // O e-mail da pessoa só na auditoria e nos documentos, nunca no log.
    expect(logs).not.toContain('pessoa.demo@cliente-demo.example');
  });

  it('a falha contada pelo nó também apaga o envelope; o pedido falhado libera um novo para o e-mail', async () => {
    const { tenant, nodeKey } = await customer();
    const node = { nodeKey, nodeTenantId: randomUUID(), sequence: 0 };
    await sync(node).expect(200);
    const email = 'falha@cliente-demo.example';
    const first = await createUser(tenant, { name: 'Pessoa Falha', email, role: 'leitura' });
    clock.advance(MINUTE_MS);
    await sync(node, { users: [userFailed(first.requestId, 'email_taken')] }).expect(200);
    expect(await storedSecret(tenant, first.requestId)).toBeUndefined();
    expect((await overview(tenant)).users[0]).toMatchObject({ status: 'failed', code: 'email_taken' });
    const second = await createUser(tenant, { name: 'Pessoa Falha', email, role: 'leitura' });
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.temporaryPassword).not.toBe(first.temporaryPassword);
  });

  it('recusas sem nada gravado: nó sem sincronizar, sem cofre, de versão antiga, chave que não confere', async () => {
    const body = { name: 'Pessoa Demo', email: 'pessoa@cliente-demo.example', role: 'admin_cliente' };
    const cases: {
      seed: (tenant: TenantRecord) => Promise<unknown>;
      code: string;
    }[] = [
      { seed: () => Promise.resolve(), code: 'node_not_synced' },
      { seed: (tenant) => seedNode(tenant, { nodeTenantId: null }), code: 'node_not_synced' },
      { seed: (tenant) => seedNode(tenant, { vault: null }), code: 'vault_disabled' },
      { seed: (tenant) => seedNode(tenant, { capabilities: ['log_sources'] }), code: 'node_outdated' },
      { seed: (tenant) => seedNode(tenant, { fingerprint: 'f'.repeat(64) }), code: 'vault_key_invalid' },
      { seed: (tenant) => seedNode(tenant, { platform: 'vm' }), code: 'platform_mismatch' },
    ];
    for (const entry of cases) {
      const tenant = await managed();
      await entry.seed(tenant);
      const response = await post(`${base(tenant)}/users`, body);
      expect(response.status, entry.code).toBe(409);
      expect(response.body).toMatchObject({ code: entry.code });
      expect(await documents.query(COLLECTIONS.nodeUsers(tenant.id))).toEqual([]);
      expect(await documents.query(COLLECTIONS.nodeUserSecrets(tenant.id))).toEqual([]);
      expect(await generation(tenant)).toBe(0);
      // A leitura diz o mesmo motivo, para o console desligar o formulário.
      expect((await overview(tenant)).usersBlockedBy).toBe(entry.code);
      const refused = (await audit.listForTenant(tenant.id)).filter(
        (record) => record.action === 'tenant.console_request_refused',
      );
      expect(refused.map((record) => record.details)).toEqual([
        expect.objectContaining({ operation: 'node_user.create', code: entry.code }),
      ]);
    }
    const outdated = await managed();
    await seedNode(outdated, { capabilities: ['log_sources'] });
    const refused = await post(`${base(outdated)}/users`, body);
    expect(refused.body).toMatchObject({
      message: 'O servidor do cliente precisa da versão nova para receber usuários.',
    });
    expect((await overview(outdated)).usersSupported).toBe(false);
  });

  it('cliente cancelado e cliente da célula recusados; papel, e-mail e campos fora da regra: 400', async () => {
    const body = { name: 'Pessoa Demo', email: 'pessoa@cliente-demo.example', role: 'leitura' };
    const canceled = await managed('canceled');
    await seedNode(canceled);
    const notAllowed = await post(`${base(canceled)}/users`, body);
    expect(notAllowed.status).toBe(409);
    expect(notAllowed.body).toMatchObject({ code: 'not_allowed' });

    const cell = await managed();
    await seedNode(cell);
    await documents.runTransaction(async (tx) => {
      const current = tenantSchema.parse(await tx.get(COLLECTIONS.tenants, cell.id));
      tx.set(
        COLLECTIONS.tenants,
        cell.id,
        tenantSchema.parse({ ...current, placement: { kind: 'cell', cellId: 'celula-sp-1' } }),
      );
    });
    const inCell = await post(`${base(cell)}/users`, body);
    expect(inCell.status).toBe(409);
    expect(inCell.body).toMatchObject({ code: 'placement_unsupported' });

    const tenant = await managed();
    await seedNode(tenant);
    for (const invalid of [
      { ...body, role: 'admin_verax' },
      { ...body, role: 'dono' },
      { ...body, email: 'nao-e-email' },
      { ...body, name: '   ' },
      { ...body, extra: true },
      { name: body.name, email: body.email },
    ]) {
      const response = await post(`${base(tenant)}/users`, invalid);
      expect(response.status, JSON.stringify(invalid)).toBe(400);
      expect(response.body).toMatchObject({ code: 'invalid_request' });
    }
    expect(await generation(tenant)).toBe(0);
    // Os três papéis do cliente valem.
    for (const [index, role] of (['admin_cliente', 'analista_cliente', 'leitura'] as const).entries()) {
      const created = await createUser(tenant, {
        ...body,
        email: `papel-${index}@cliente-demo.example`,
        role,
      });
      expect(created.role).toBe(role);
    }
    expect(await generation(tenant)).toBe(3);
  });

  it('um pedido pendente por e-mail (sem diferença de maiúsculas); o vencido libera o e-mail', async () => {
    const tenant = await managed();
    await seedNode(tenant);
    const body = { name: 'Pessoa Demo', email: 'pendente@cliente-demo.example', role: 'leitura' };
    const first = await createUser(tenant, body);
    const again = await post(`${base(tenant)}/users`, { ...body, email: 'PENDENTE@cliente-demo.example' });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'user_pending', details: { issues: [{ path: 'email' }] } });
    expect(await generation(tenant)).toBe(1);
    // Outro e-mail passa.
    await createUser(tenant, { ...body, email: 'outra-pessoa@cliente-demo.example' });

    clock.advance(TEMPORARY_PASSWORD_HOURS * HOUR_MS + MINUTE_MS);
    ownerCookie = await seedOwnerSession(documents, clock, OWNER);
    const view = await overview(tenant);
    expect(view.users.find((user) => user.requestId === first.requestId)).toMatchObject({
      status: 'expired',
    });
    expect(view.users.find((user) => user.requestId === first.requestId)?.code).toBeUndefined();
    const renewed = await createUser(tenant, body);
    expect(renewed.requestId).not.toBe(first.requestId);
  });

  it('a situação de cada pedido pelo relato do nó, do mais novo ao mais antigo', async () => {
    const tenant = await managed();
    await seedNode(tenant);
    const make = (email: string) => createUser(tenant, { name: 'Pessoa Demo', email, role: 'leitura' });
    const created = await make('criada@cliente-demo.example');
    const failed = await make('falhou@cliente-demo.example');
    const late = await make('vencida@cliente-demo.example');
    const pending = await make('pendente@cliente-demo.example');
    await seedReport(tenant, {
      requestId: created.requestId,
      outcome: 'created',
      code: null,
      user: { status: 'active', mfaEnabled: true, mustChangePassword: false },
    });
    await seedReport(tenant, userFailed(failed.requestId, 'plan_limit_reached'));
    await seedReport(tenant, userFailed(late.requestId, 'expired'));
    const users = (await overview(tenant)).users;
    expect(users.map((user) => user.requestId)).toEqual([
      pending.requestId,
      late.requestId,
      failed.requestId,
      created.requestId,
    ]);
    const byId = new Map<string, NodeUserView>(users.map((user) => [user.requestId, user]));
    expect(byId.get(created.requestId)).toMatchObject({
      status: 'created',
      user: { status: 'active', mfaEnabled: true, mustChangePassword: false },
    });
    expect(byId.get(created.requestId)?.code).toBeUndefined();
    expect(byId.get(failed.requestId)).toMatchObject({ status: 'failed', code: 'plan_limit_reached' });
    expect(byId.get(failed.requestId)?.user).toBeUndefined();
    expect(byId.get(late.requestId)).toMatchObject({ status: 'expired', code: 'expired' });
    expect(byId.get(pending.requestId)).toMatchObject({ status: 'pending' });
    expect(byId.get(pending.requestId)?.reportedAt).toBeUndefined();

    // O envelope descartado (o nó foi reinstalado, com outra chave): o pedido não chega mais, e o e-mail fica livre.
    await documents.runTransaction((tx) => {
      tx.delete(COLLECTIONS.nodeUserSecrets(tenant.id), pending.requestId);
      return Promise.resolve();
    });
    expect((await overview(tenant)).users[0]).toMatchObject({ status: 'expired' });
    await make('pendente@cliente-demo.example');
  });

  it('limite das operações por responsável: 429 e a recusa na auditoria; a leitura não gasta', async () => {
    const tenant = await managed();
    await seedNode(tenant);
    const statuses: number[] = [];
    for (let index = 0; index < 23; index += 1) {
      const response = await post(`${base(tenant)}/users`, {
        name: 'Pessoa Demo',
        email: `limite-${index}@cliente-demo.example`,
        role: 'leitura',
      });
      statuses.push(response.status);
      if (response.status === 201) passwords.add((response.body as NodeUserCreated).temporaryPassword);
      if (response.status === 429) expect(response.body).toMatchObject({ code: 'rate_limited' });
    }
    expect(statuses.filter((status) => status === 201)).toHaveLength(20);
    expect(statuses.slice(20).every((status) => status === 429)).toBe(true);
    expect(await generation(tenant)).toBe(20);
    const limited = (await audit.listForTenant(tenant.id)).filter(
      (record) =>
        record.action === 'tenant.console_request_refused' && record.details?.['code'] === 'rate_limited',
    );
    expect(limited).toHaveLength(3);
    await read(`${base(tenant)}/node-sync`).expect(200);
  });

  it('nenhuma senha devolvida no arquivo aparece no log, na auditoria ou no Firestore', () => {
    expect(passwords.size).toBeGreaterThan(20);
    const written = documents.writes.join('\n');
    for (const password of passwords) {
      expect(capture.text).not.toContain(password);
      expect(written).not.toContain(password);
    }
  });
});
