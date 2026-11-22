import 'reflect-metadata';
import { generateKeyPairSync, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CONTROL_PLANE_AUDIT_ACTOR_ID,
  type CloudAccountCreate,
  type NodePlatform,
  type NodeSyncDesiredSource,
  type NodeSyncRequest,
  nodeSyncRequestSchema,
  resolvePlan,
} from '@verax/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { SyncLogger } from '../src/control-plane-sync/apply-source.js';
import {
  ControlPlaneSync,
  type ControlPlaneSyncOptions,
  NOT_FOUND_RETRY_MS,
  UNAUTHENTICATED_RETRY_MS,
} from '../src/control-plane-sync/control-plane-sync.js';
import type { SourceCredentialChecks } from '../src/control-plane-sync/credential-checks.js';
import { ControlPlaneNodeKey } from '../src/common/config/control-plane-sync.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import {
  type CheckedCredential,
  CredentialRejected,
  CredentialSourceUnavailable,
} from '../src/credentials/credential-check.js';
import { parsePrivateKeys, type VaultKeyring } from '../src/credentials/credential-keys.js';
import {
  AwsAccessKey,
  CloudflareToken,
  credentialBinding,
  seal,
  type VaultSecret,
} from '../src/credentials/credential-vault.js';
import { fixedTenantPlans, type TenantPlans } from '../src/plan/tenant-plan.js';

/** Versão da chave do nó neste arquivo, fora das dos outros arquivos (900 a 902 e 910), para a recifragem não se cruzar. */
const KEY_VERSION = 903;
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const NODE_KEY = 'a'.repeat(43);
const START = new Date('2026-11-22T12:00:00.000Z');
const MINUTE = 60_000;

const cloudflareId = () => randomBytes(16).toString('hex');
const awsId = () => String(randomInt(100_000_000_000, 999_999_999_999));
const bucket = (label: string) => `verax-teste-${label}-${randomBytes(4).toString('hex')}`;
const zone = () => `cliente-${randomBytes(4).toString('hex')}.example.com`;
const tokenValue = () => `token-de-teste-${randomBytes(16).toString('hex')}`;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** Um ID de chave de acesso no formato da AWS, sorteado (nenhum é real). */
const awsKeyId = () => `AKIA${Array.from(randomBytes(16), (byte) => BASE32.charAt(byte % 32)).join('')}`;

interface Received {
  headers: IncomingHttpHeaders;
  body: NodeSyncRequest;
}

interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * Plano de controle falso, em 127.0.0.1: confere cada pedido pelo contrato (`nodeSyncRequestSchema`; fora dele, 400 e o
 * teste falha) e responde o que o teste mandar (por padrão, a resposta de `desired`).
 */
class FakeControlPlane {
  readonly received: Received[] = [];
  invalid = 0;
  desired: NodeSyncDesiredSource[] = [];
  pollAfterSeconds = 300;
  /** Respostas na fila (uma por pedido); vazia, a resposta padrão com `desired`. */
  readonly replies: Reply[] = [];
  private server: Server | undefined;

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const parsed = nodeSyncRequestSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (!parsed.success) {
          this.invalid += 1;
          response.writeHead(400).end('{"error":"invalid_request"}');
          return;
        }
        this.received.push({ headers: request.headers, body: parsed.data });
        const reply = this.replies.shift() ?? {
          status: 200,
          body: {
            protocol: 1,
            generation: 1,
            pollAfterSeconds: this.pollAfterSeconds,
            sources: this.desired,
          },
        };
        response
          .writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers })
          .end(reply.body === undefined ? '' : JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/v1/node-sync`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  reset(): void {
    this.received.length = 0;
    this.replies.length = 0;
    this.desired = [];
    this.invalid = 0;
    this.pollAfterSeconds = 300;
  }

  last(): NodeSyncRequest {
    const last = this.received.at(-1);
    if (last === undefined) throw new Error('nenhum pedido recebido');
    return last.body;
  }
}

/** A conferência na origem, programável: aceita, recusa ou fica fora do ar. */
class FakeChecks implements SourceCredentialChecks {
  calls = 0;
  behavior: 'ok' | 'rejected' | 'unavailable' = 'ok';
  check(_secret: VaultSecret): Promise<CheckedCredential> {
    this.calls += 1;
    if (this.behavior === 'rejected') return Promise.reject(new CredentialRejected('expired', 401));
    if (this.behavior === 'unavailable') return Promise.reject(new CredentialSourceUnavailable('timeout'));
    return Promise.resolve({ keyIdSuffix: 'c0de', issuedAt: null, expiresAt: null });
  }
}

class RecordingLogger implements SyncLogger {
  readonly lines: { level: string; fields: object; message: string }[] = [];
  info(fields: object, message: string) {
    this.lines.push({ level: 'info', fields, message });
  }
  warn(fields: object, message: string) {
    this.lines.push({ level: 'warn', fields, message });
  }
  error(fields: object, message: string) {
    this.lines.push({ level: 'error', fields, message });
  }
}

describe('tarefa control-plane-sync do worker: fontes de log do console (banco real e plano de controle falso)', () => {
  const cp = new FakeControlPlane();
  const prisma = new PrismaService({ DATABASE_URL: inject('testDatabaseUrl') });
  let url: string;
  let keyring: VaultKeyring;
  let tenantA: string;
  let tenantB: string;
  let clock: Date;
  let checks: FakeChecks;
  let logger: RecordingLogger;

  beforeAll(async () => {
    url = await cp.start();
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const pem = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
    keyring = parsePrivateKeys(`${KEY_VERSION}:${pem}`, KEY_VERSION);
  });

  afterAll(async () => {
    await cp.stop();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    cp.reset();
    clock = START;
    checks = new FakeChecks();
    logger = new RecordingLogger();
    // Um cliente novo por teste: o nó dedicado tem um cliente só, e cada teste é um nó.
    tenantA = (await prisma.tenant.create({ data: { name: 'Cliente Demo A (sincronização)' } })).id;
    tenantB = (await prisma.tenant.create({ data: { name: 'Cliente Demo B (sincronização)' } })).id;
    await prisma.controlPlaneSync.deleteMany({});
  });

  function syncFor(
    overrides: Partial<ControlPlaneSyncOptions> & {
      tenants?: () => Promise<string[]>;
      platform?: NodePlatform;
    } = {},
  ) {
    const platform = overrides.platform ?? 'gcp';
    return new ControlPlaneSync(prisma, {
      config: {
        origin: 'https://conta.exemplo.com.br',
        url,
        commit: COMMIT,
        credential:
          platform === 'vm'
            ? { kind: 'node_key', key: new ControlPlaneNodeKey(NODE_KEY) }
            : { kind: 'gcp_identity' },
      },
      platform,
      keyring,
      node: {
        egressIps: ['203.0.113.10/32'],
        serviceAccountId: platform === 'gcp' ? '123456789012345678901' : null,
        audience: 'https://verax.exemplo.com.br',
      },
      plans: fixedTenantPlans(resolvePlan('interno')),
      checks,
      logger,
      idToken: () => Promise.resolve('cabecalho.corpo.assinatura'),
      now: () => clock,
      random: () => 0.5,
      tenants: () => Promise.resolve([tenantA]),
      ...overrides,
    });
  }

  const run = (sync = syncFor()) => sync.runOnce(new AbortController().signal);

  function cloudflareSource(
    spec: Partial<Extract<CloudAccountCreate, { provider: 'cloudflare' }>> = {},
    revision = 1,
  ): NodeSyncDesiredSource {
    return {
      id: randomUUID(),
      revision,
      state: 'active',
      spec: { provider: 'cloudflare', accountId: cloudflareId(), zones: [zone()], ...spec },
      credential: null,
    };
  }

  function withCredential(
    source: NodeSyncDesiredSource,
    revision = 1,
    { tenantId = tenantA, value = tokenValue() } = {},
  ): NodeSyncDesiredSource {
    const binding = credentialBinding(
      { id: source.id, tenantId, provider: source.spec.provider, accountId: source.spec.accountId },
      'cloudflare_api_token',
    );
    const sealed = seal(keyring.publicKey(), binding, new CloudflareToken(value));
    return { ...source, credential: { revision, kind: 'cloudflare_api_token', envelope: sealed.ciphertext } };
  }

  const accountOf = (id: string) =>
    prisma.cloudAccount.findUnique({
      where: { id },
      select: {
        tenantId: true,
        origin: true,
        controlPlaneRevision: true,
        status: true,
        zones: true,
        regions: true,
        cloudtrailBucket: true,
        connection: true,
        credential: {
          select: { ciphertext: true, origin: true, controlPlaneRevision: true, keyVersion: true },
        },
      },
    });
  const itemOf = (kind: 'log_source' | 'log_source_credential', itemId: string) =>
    prisma.controlPlaneSyncItem.findUnique({ where: { kind_itemId: { kind, itemId } } });
  const syncRow = () => prisma.controlPlaneSync.findUniqueOrThrow({ where: { id: 'node' } });

  it('cria a conta e guarda a credencial como veio; conta de volta na segunda chamada da mesma execução', async () => {
    const source = withCredential(cloudflareSource());
    cp.desired = [source];

    const report = await run();

    expect(report).toMatchObject({ due: true, roundTrips: 2, changed: 1, failed: 0, error: null });
    expect(cp.invalid).toBe(0);
    const account = await accountOf(source.id);
    expect(account).toMatchObject({
      tenantId: tenantA,
      origin: 'control_plane',
      controlPlaneRevision: 1,
      status: 'active',
      zones: source.spec.provider === 'cloudflare' ? source.spec.zones : [],
      connection: 'waiting',
    });
    expect(account?.credential).toEqual({
      ciphertext: source.credential?.envelope,
      origin: 'control_plane',
      controlPlaneRevision: 1,
      keyVersion: KEY_VERSION,
    });
    // O primeiro pedido: o nó, a chave do cofre e nenhuma fonte ainda; o segundo já conta a fonte e a credencial.
    const [first, second] = cp.received;
    expect(first?.headers.authorization).toBe('Bearer cabecalho.corpo.assinatura');
    expect(first?.body).toMatchObject({
      protocol: 1,
      capabilities: ['log_sources'],
      users: [],
      sources: [],
      node: {
        commit: COMMIT,
        platform: 'gcp',
        mode: 'dedicated',
        tenantId: tenantA,
        serviceAccountId: '123456789012345678901',
        egressIps: ['203.0.113.10/32'],
        error: null,
        vaultKey: { version: KEY_VERSION },
      },
    });
    expect(first?.body.node.vaultKey?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(second?.body.sequence).toBeGreaterThan(first?.body.sequence ?? Infinity);
    expect(second?.body.sources).toEqual([
      expect.objectContaining({
        id: source.id,
        revision: 1,
        outcome: 'applied',
        code: null,
        credential: expect.objectContaining({
          revision: 1,
          outcome: 'applied',
          kind: 'cloudflare_api_token',
        }) as unknown,
        account: expect.objectContaining({ status: 'active', connection: 'waiting' }) as unknown,
      }),
    ]);
    // A trilha do cliente: o sistema, com o ator do console, sem segredo.
    const entries = await prisma.auditLog.findMany({
      where: { tenantId: tenantA, resourceId: source.id },
      orderBy: { occurredAt: 'asc' },
    });
    expect(entries.map((entry) => entry.action)).toEqual(['cloud_account.create', 'cloud_credential.set']);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        actorType: 'system',
        actorId: CONTROL_PLANE_AUDIT_ACTOR_ID,
        outcome: 'success',
      });
      expect(JSON.stringify(entry.after)).not.toContain(source.credential?.envelope ?? 'x');
    }
    // A próxima chamada: o pollAfterSeconds (o sorteio no meio não muda nada).
    expect((await syncRow()).nextAttemptAt).toEqual(new Date(START.getTime() + 300_000));
  });

  it('a mesma resposta de novo não muda nada (uma chamada só, sem trilha nova)', async () => {
    const source = withCredential(cloudflareSource());
    cp.desired = [source];
    await run();
    const audits = await prisma.auditLog.count({ where: { tenantId: tenantA } });
    clock = new Date(START.getTime() + 10 * MINUTE);

    const report = await run();

    expect(report).toMatchObject({ roundTrips: 1, changed: 0, failed: 0 });
    expect(await prisma.auditLog.count({ where: { tenantId: tenantA } })).toBe(audits);
    expect(checks.calls).toBe(1);
  });

  it('antes da próxima chamada, não chama o plano de controle', async () => {
    cp.desired = [];
    await run();
    clock = new Date(START.getTime() + 2 * MINUTE);
    expect(await run()).toMatchObject({ due: false, roundTrips: 0 });
    // Mesmo noutra instância (outra partida do worker): a próxima chamada está no banco.
    expect(await run(syncFor())).toMatchObject({ due: false });
    expect(cp.received).toHaveLength(1);
  });

  it('altera só com revisão nova, com as regras de conexão do painel (outros buckets recomeçam; regiões não)', async () => {
    const id = randomUUID();
    const accountId = awsId();
    const first = bucket('trilha');
    const spec = (revision: number, regions: string[], cloudtrail: string): NodeSyncDesiredSource => ({
      id,
      revision,
      state: 'active',
      spec: { provider: 'aws', accountId, regions, buckets: { cloudtrail } },
      credential: null,
    });
    cp.desired = [spec(1, ['us-east-1'], first)];
    await run();
    await prisma.cloudAccount.update({ where: { id }, data: { connection: 'connected' } });

    clock = new Date(START.getTime() + 10 * MINUTE);
    cp.desired = [spec(2, ['us-east-1', 'sa-east-1'], first)];
    await run();
    expect(await accountOf(id)).toMatchObject({
      controlPlaneRevision: 2,
      regions: ['us-east-1', 'sa-east-1'],
      connection: 'connected',
    });

    // A mesma revisão com outro conteúdo é ignorada: só uma revisão maior muda o nó.
    clock = new Date(START.getTime() + 20 * MINUTE);
    const second = bucket('trilha-nova');
    cp.desired = [spec(2, ['us-east-1'], second)];
    await run();
    expect(await accountOf(id)).toMatchObject({ controlPlaneRevision: 2, cloudtrailBucket: first });

    clock = new Date(START.getTime() + 30 * MINUTE);
    cp.desired = [spec(3, ['us-east-1'], second)];
    await run();
    expect(await accountOf(id)).toMatchObject({
      controlPlaneRevision: 3,
      cloudtrailBucket: second,
      connection: 'waiting',
    });
    const actions = await prisma.auditLog.findMany({
      where: { tenantId: tenantA, resourceId: id },
      select: { action: true },
      orderBy: { occurredAt: 'asc' },
    });
    expect(actions.map((entry) => entry.action)).toEqual([
      'cloud_account.create',
      'cloud_account.update',
      'cloud_account.update',
    ]);
  });

  it('trocar o provedor ou o ID da conta numa revisão nova é recusado (immutable_changed)', async () => {
    const source = cloudflareSource();
    cp.desired = [source];
    await run();
    clock = new Date(START.getTime() + 10 * MINUTE);
    cp.desired = [{ ...source, revision: 2, spec: { ...source.spec, accountId: cloudflareId() } }];

    expect(await run()).toMatchObject({ failed: 1 });
    expect(await itemOf('log_source', source.id)).toMatchObject({
      revision: 2,
      outcome: 'failed',
      code: 'immutable_changed',
    });
    expect(await accountOf(source.id)).toMatchObject({ controlPlaneRevision: 1 });
    // A falha é contada na chamada seguinte (só o que mudou o nó pede a segunda chamada na mesma execução).
    clock = new Date(START.getTime() + 20 * MINUTE);
    await run();
    expect(cp.last().sources).toEqual([
      expect.objectContaining({ id: source.id, revision: 2, outcome: 'failed', code: 'immutable_changed' }),
    ]);
  });

  it('a lápide desativa a conta e apaga a credencial; conta `removed`', async () => {
    const source = withCredential(cloudflareSource());
    cp.desired = [source];
    await run();
    clock = new Date(START.getTime() + 10 * MINUTE);
    cp.desired = [{ ...source, revision: 2, state: 'removed', credential: null }];

    const report = await run();

    expect(report).toMatchObject({ changed: 1, roundTrips: 2 });
    expect(await accountOf(source.id)).toMatchObject({
      status: 'inactive',
      controlPlaneRevision: 2,
      credential: null,
    });
    expect(cp.last().sources).toEqual([
      expect.objectContaining({
        id: source.id,
        revision: 2,
        outcome: 'removed',
        credential: null,
        account: expect.objectContaining({ status: 'inactive' }) as unknown,
      }),
    ]);
    const actions = await prisma.auditLog.findMany({
      where: {
        tenantId: tenantA,
        resourceId: source.id,
        action: { in: ['cloud_account.deactivate', 'cloud_credential.wipe'] },
      },
      select: { action: true, actorId: true },
    });
    expect(actions).toHaveLength(2);
    expect(actions.every((entry) => entry.actorId === CONTROL_PLANE_AUDIT_ACTOR_ID)).toBe(true);
  });

  it('nunca toca na conta que o cliente cadastrou no painel (account_exists_panel)', async () => {
    const accountId = cloudflareId();
    const panel = await prisma.cloudAccount.create({
      data: {
        tenantId: tenantA,
        provider: 'cloudflare',
        accountId,
        regions: [],
        zones: ['painel.example.com'],
      },
    });
    const source = withCredential(cloudflareSource({ accountId }));
    cp.desired = [source];

    expect(await run()).toMatchObject({ failed: 1, changed: 0 });

    expect(await accountOf(source.id)).toBeNull();
    const after = await prisma.cloudAccount.findUniqueOrThrow({
      where: { id: panel.id },
      select: { origin: true, zones: true, updatedAt: true, credential: true },
    });
    expect(after).toEqual({
      origin: 'panel',
      zones: ['painel.example.com'],
      updatedAt: panel.updatedAt,
      credential: null,
    });
    expect(await itemOf('log_source', source.id)).toMatchObject({
      outcome: 'failed',
      code: 'account_exists_panel',
    });
    // A lápide de um id que é de uma conta do painel também não a toca.
    clock = new Date(START.getTime() + 10 * MINUTE);
    cp.desired = [{ id: panel.id, revision: 1, state: 'removed', spec: source.spec, credential: null }];
    await run();
    expect(await prisma.cloudAccount.findUniqueOrThrow({ where: { id: panel.id } })).toMatchObject({
      status: 'active',
      origin: 'panel',
    });
  });

  it('sem vaga no plano, plan_limit_reached; tenta de novo a cada hora, e entra quando a vaga aparece', async () => {
    await prisma.cloudAccount.create({
      data: { tenantId: tenantA, provider: 'cloudflare', accountId: cloudflareId(), regions: [], zones: [] },
    });
    const full = fixedTenantPlans(resolvePlan('essencial', { maxCloudAccounts: 1 }));
    const source = cloudflareSource();
    cp.desired = [source];

    expect(await run(syncFor({ plans: full }))).toMatchObject({ failed: 1 });
    const item = await itemOf('log_source', source.id);
    expect(item).toMatchObject({ outcome: 'failed', code: 'plan_limit_reached' });
    expect(item?.nextAttemptAt).toEqual(new Date(START.getTime() + 60 * MINUTE));

    // Antes da hora, a mesma revisão não é tentada de novo (nem com a vaga).
    clock = new Date(START.getTime() + 30 * MINUTE);
    const roomy: TenantPlans = fixedTenantPlans(resolvePlan('essencial', { maxCloudAccounts: 5 }));
    expect(await run(syncFor({ plans: roomy }))).toMatchObject({ changed: 0, failed: 0 });
    expect(await accountOf(source.id)).toBeNull();

    clock = new Date(START.getTime() + 61 * MINUTE);
    expect(await run(syncFor({ plans: roomy }))).toMatchObject({ changed: 1 });
    expect(await accountOf(source.id)).toMatchObject({ origin: 'control_plane', status: 'active' });
  });

  it('uma zona que já é de outro cliente: origin_conflict, sem criar nada', async () => {
    const taken = zone();
    await prisma.cloudAccount.create({
      data: {
        tenantId: tenantB,
        provider: 'cloudflare',
        accountId: cloudflareId(),
        regions: [],
        zones: [taken],
      },
    });
    const source = cloudflareSource({ zones: [taken] });
    cp.desired = [source];

    expect(await run()).toMatchObject({ failed: 1 });
    expect(await accountOf(source.id)).toBeNull();
    expect(await itemOf('log_source', source.id)).toMatchObject({
      outcome: 'failed',
      code: 'origin_conflict',
    });
  });

  it('o envelope amarrado a outro cliente não abre: credential_unreadable, e a conta fica', async () => {
    const source = withCredential(cloudflareSource(), 1, { tenantId: tenantB });
    cp.desired = [source];

    expect(await run()).toMatchObject({ changed: 1, failed: 1 });

    expect(await accountOf(source.id)).toMatchObject({ origin: 'control_plane', credential: null });
    expect(await itemOf('log_source_credential', source.id)).toMatchObject({
      revision: 1,
      outcome: 'failed',
      code: 'credential_unreadable',
    });
    expect(checks.calls).toBe(0);
    expect(cp.last().sources[0]?.credential).toMatchObject({
      revision: 1,
      outcome: 'failed',
      code: 'credential_unreadable',
      kind: null,
    });
  });

  it('a origem recusa: credential_rejected_<motivo>, e a mesma revisão não é conferida de novo', async () => {
    checks.behavior = 'rejected';
    const source = withCredential(cloudflareSource());
    cp.desired = [source];

    await run();
    expect(await itemOf('log_source_credential', source.id)).toMatchObject({
      outcome: 'failed',
      code: 'credential_rejected_expired',
      nextAttemptAt: null,
    });
    expect((await accountOf(source.id))?.credential).toBeNull();

    clock = new Date(START.getTime() + 10 * MINUTE);
    checks.behavior = 'ok';
    await run();
    expect(checks.calls).toBe(1);

    // Uma revisão nova da credencial é conferida.
    clock = new Date(START.getTime() + 20 * MINUTE);
    cp.desired = [withCredential({ ...source, credential: null }, 2)];
    await run();
    expect(checks.calls).toBe(2);
    expect((await accountOf(source.id))?.credential).toMatchObject({
      origin: 'control_plane',
      controlPlaneRevision: 2,
    });
  });

  it('a origem fora do ar: source_unavailable com espera crescente (1 min, 2 min) e depois guarda', async () => {
    checks.behavior = 'unavailable';
    const source = withCredential(cloudflareSource());
    cp.desired = [source];
    cp.pollAfterSeconds = 60;

    await run();
    let item = await itemOf('log_source_credential', source.id);
    expect(item).toMatchObject({ code: 'source_unavailable', attempts: 1 });
    expect(item?.nextAttemptAt).toEqual(new Date(START.getTime() + MINUTE));

    // Antes da espera, não confere de novo (a chamada adiantada, como numa partida do worker sem a espera gravada).
    await prisma.controlPlaneSync.update({ where: { id: 'node' }, data: { nextAttemptAt: null } });
    clock = new Date(START.getTime() + 30_000);
    await run();
    // A primeira execução fez duas chamadas (criou a conta); esta, uma, sem conferir a credencial.
    expect(cp.received).toHaveLength(3);
    expect(checks.calls).toBe(1);

    clock = new Date(START.getTime() + 2 * MINUTE);
    await run();
    item = await itemOf('log_source_credential', source.id);
    expect(item).toMatchObject({ code: 'source_unavailable', attempts: 2 });
    expect(item?.nextAttemptAt).toEqual(new Date(clock.getTime() + 2 * MINUTE));

    checks.behavior = 'ok';
    clock = new Date(clock.getTime() + 3 * MINUTE);
    await run();
    expect(checks.calls).toBe(3);
    expect(await itemOf('log_source_credential', source.id)).toMatchObject({
      outcome: 'applied',
      code: null,
    });
    expect((await accountOf(source.id))?.credential).toMatchObject({ origin: 'control_plane' });
  });

  it('a credencial colada no painel vale até o console mandar uma revisão nova', async () => {
    const source = withCredential(cloudflareSource());
    cp.desired = [source];
    await run();
    // O cliente cola outra no painel (como o PUT da credencial grava).
    await prisma.cloudCredential.update({
      where: { cloudAccountId: source.id },
      data: { origin: 'panel', controlPlaneRevision: null, ciphertext: 'v903:cGFpbmVs', keyIdSuffix: 'pain' },
    });

    clock = new Date(START.getTime() + 10 * MINUTE);
    await run();
    expect((await accountOf(source.id))?.credential).toMatchObject({
      origin: 'panel',
      ciphertext: 'v903:cGFpbmVs',
    });
    expect(cp.last().sources[0]?.credential).toMatchObject({
      revision: null,
      outcome: 'applied',
      keyIdSuffix: 'pain',
    });

    clock = new Date(START.getTime() + 20 * MINUTE);
    const newer = withCredential({ ...source, credential: null }, 2);
    cp.desired = [newer];
    await run();
    expect((await accountOf(source.id))?.credential).toEqual({
      origin: 'control_plane',
      controlPlaneRevision: 2,
      ciphertext: newer.credential?.envelope,
      keyVersion: KEY_VERSION,
    });
  });

  it('o tipo de credencial que não vale na plataforma: credential_kind_not_allowed', async () => {
    const id = randomUUID();
    const accountId = awsId();
    const sealed = seal(
      keyring.publicKey(),
      credentialBinding({ id, tenantId: tenantA, provider: 'aws', accountId }, 'aws_access_key'),
      new AwsAccessKey(awsKeyId(), 'x'.repeat(40)),
    );
    cp.desired = [
      {
        id,
        revision: 1,
        state: 'active',
        spec: { provider: 'aws', accountId, regions: ['us-east-1'] },
        credential: { revision: 1, kind: 'aws_access_key', envelope: sealed.ciphertext },
      },
    ];

    await run();
    expect(await itemOf('log_source_credential', id)).toMatchObject({ code: 'credential_kind_not_allowed' });

    // Na VM própria, a mesma chave vale (com a chave do nó no cabeçalho).
    const vmTenant = (await prisma.tenant.create({ data: { name: 'Cliente Demo C (VM)' } })).id;
    const vmId = randomUUID();
    const vmAccount = awsId();
    const vmSealed = seal(
      keyring.publicKey(),
      credentialBinding(
        { id: vmId, tenantId: vmTenant, provider: 'aws', accountId: vmAccount },
        'aws_access_key',
      ),
      new AwsAccessKey(awsKeyId(), 'y'.repeat(40)),
    );
    await prisma.controlPlaneSync.deleteMany({});
    cp.desired = [
      {
        id: vmId,
        revision: 1,
        state: 'active',
        spec: { provider: 'aws', accountId: vmAccount, regions: ['us-east-1'] },
        credential: { revision: 1, kind: 'aws_access_key', envelope: vmSealed.ciphertext },
      },
    ];
    await run(syncFor({ platform: 'vm', tenants: () => Promise.resolve([vmTenant]) }));
    expect(cp.received.at(-1)?.headers.authorization).toBe(`Bearer ${NODE_KEY}`);
    expect(cp.last().node).toMatchObject({ platform: 'vm', serviceAccountId: null, tenantId: vmTenant });
    expect(await itemOf('log_source_credential', vmId)).toMatchObject({ outcome: 'applied' });
  });

  it('com mais de um cliente no banco, informa tenant_ambiguous e não aplica nada', async () => {
    const source = cloudflareSource();
    cp.desired = [source];

    const report = await run(syncFor({ tenants: () => Promise.resolve([tenantA, tenantB]) }));

    expect(report).toMatchObject({ roundTrips: 1, changed: 0 });
    expect(cp.last().node).toMatchObject({ tenantId: null, error: 'tenant_ambiguous' });
    expect(cp.last().sources).toEqual([]);
    expect(await accountOf(source.id)).toBeNull();
  });

  it('as falhas da chamada: 401 espera 1 h, 404 espera 6 h, 5xx espera 1, 2... min; nada é aplicado', async () => {
    cp.replies.push({ status: 401, body: { error: 'unauthenticated' } });
    expect(await run()).toMatchObject({ error: 'unauthenticated' });
    expect(await syncRow()).toMatchObject({
      lastErrorCode: 'unauthenticated',
      nextAttemptAt: new Date(START.getTime() + UNAUTHENTICATED_RETRY_MS),
    });
    expect(
      logger.lines.some((line) => JSON.stringify(line.fields).includes('control_plane_unauthenticated')),
    ).toBe(true);

    clock = new Date(START.getTime() + UNAUTHENTICATED_RETRY_MS);
    cp.replies.push({ status: 404, body: { error: 'not_found' } });
    expect(await run()).toMatchObject({ error: 'not_found' });
    expect((await syncRow()).nextAttemptAt).toEqual(new Date(clock.getTime() + NOT_FOUND_RETRY_MS));

    clock = new Date(clock.getTime() + NOT_FOUND_RETRY_MS);
    cp.replies.push({ status: 503, body: { error: 'unavailable' } });
    await run();
    const failures = (await syncRow()).failures;
    expect((await syncRow()).nextAttemptAt).toEqual(
      new Date(clock.getTime() + Math.min(30, 2 ** (failures - 1)) * MINUTE),
    );

    // Uma resposta fora do contrato (campo a mais) não aplica nada.
    clock = new Date(clock.getTime() + 60 * MINUTE);
    const source = cloudflareSource();
    cp.replies.push({
      status: 200,
      body: { protocol: 1, generation: 1, pollAfterSeconds: 300, sources: [source], extra: 1 },
    });
    expect(await run()).toMatchObject({ error: 'invalid_response' });
    expect(await accountOf(source.id)).toBeNull();

    // Um redirecionamento não é seguido (`redirect: 'error'`): conta como o plano de controle fora do ar.
    clock = new Date(clock.getTime() + 60 * MINUTE);
    cp.replies.push({ status: 302, headers: { location: 'http://127.0.0.1:9/outro' } });
    expect(await run()).toMatchObject({ error: 'unavailable' });
    expect(cp.received.at(-1)?.body).toBeDefined();

    // Depois de um sucesso, a contagem das falhas recomeça.
    clock = new Date(clock.getTime() + 60 * MINUTE);
    expect(await run()).toMatchObject({ error: null });
    expect(await syncRow()).toMatchObject({ failures: 0, lastErrorCode: null, generation: 1 });
  });

  it('409 stale_sequence: a sequência avança além da aceita e a chamada é repetida na mesma execução', async () => {
    const accepted = START.getTime() + 1_000_000;
    cp.replies.push({ status: 409, body: { error: 'stale_sequence', sequence: accepted } });

    const report = await run();

    expect(report).toMatchObject({ roundTrips: 2, error: null });
    expect(cp.received).toHaveLength(2);
    expect(cp.received[1]?.body.sequence).toBeGreaterThan(accepted);
    expect(Number((await syncRow()).sequence)).toBe(cp.received[1]?.body.sequence);
  });

  it('o relógio fora dos 10 min (400 com o Date do plano de controle) vai para o log', async () => {
    cp.replies.push({
      status: 400,
      body: { error: 'invalid_request' },
      headers: { date: new Date(START.getTime() + 30 * MINUTE).toUTCString() },
    });
    expect(await run()).toMatchObject({ error: 'bad_request' });
    expect(logger.lines.some((line) => JSON.stringify(line.fields).includes('clock_skew'))).toBe(true);
  });

  it('nenhum texto do token, da chave do nó ou do envelope vai para o log', async () => {
    const source = withCredential(cloudflareSource());
    cp.desired = [source];
    checks.behavior = 'rejected';
    await run(syncFor({ platform: 'vm' }));
    const logged = JSON.stringify(logger.lines);
    expect(logged).not.toContain(NODE_KEY);
    expect(logged).not.toContain(source.credential?.envelope ?? 'x');
  });
});
