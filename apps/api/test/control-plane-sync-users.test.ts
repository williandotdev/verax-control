import 'reflect-metadata';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  CONTROL_PLANE_AUDIT_ACTOR_ID,
  CREDENTIAL_CHANGE_REQUIRED_CODE,
  meSchema,
  type NodeSyncDesiredUser,
  type NodeSyncRequest,
  nodeSyncRequestSchema,
  resolvePlan,
} from '@verax/shared';
import { generateTemporaryPassword, sealUserPassword } from '@verax/vault-envelope';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { SyncLogger } from '../src/control-plane-sync/apply-source.js';
import {
  ControlPlaneSync,
  type ControlPlaneSyncOptions,
} from '../src/control-plane-sync/control-plane-sync.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { parsePrivateKeys, type VaultKeyring } from '../src/credentials/credential-keys.js';
import { fixedTenantPlans } from '../src/plan/tenant-plan.js';
import { authPost, createUser, enrollMfa, signIn } from './support/auth-helpers.js';
import { ControlPlaneSyncRowLock } from './support/control-plane-sync-lock.js';
import { createApp } from './support/create-app.js';

/** Versão da chave do nó neste arquivo, fora das dos outros arquivos (900 a 903 e 910). */
const KEY_VERSION = 904;
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NEW_PASSWORD = 'senha-nova-bem-longa-do-cliente-7';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Um id de pedido no formato ULID (sorteado). */
const ulid = () => Array.from(randomBytes(26), (byte) => CROCKFORD.charAt(byte % 32)).join('');
const email = () => `pedido-${randomBytes(6).toString('hex')}@cliente.example`;

/**
 * Plano de controle falso, em 127.0.0.1: confere cada pedido pelo contrato (fora dele, 400 e o teste falha) e responde
 * os usuários pedidos. Como o de verdade, deixa de mandar o pedido que o nó já contou (o envelope é apagado com
 * qualquer relato), a não ser com `keepUsers` (o relato que não chegou).
 */
class FakeControlPlane {
  readonly received: NodeSyncRequest[] = [];
  invalid = 0;
  users: NodeSyncDesiredUser[] = [];
  keepUsers = false;
  private server: Server | undefined;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const parsed = nodeSyncRequestSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (!parsed.success) {
          this.invalid += 1;
          res.writeHead(400).end('{"error":"invalid_request"}');
          return;
        }
        this.received.push(parsed.data);
        if (!this.keepUsers) {
          const reported = new Set(parsed.data.users.map((user) => user.requestId));
          this.users = this.users.filter((user) => !reported.has(user.requestId));
        }
        const body = { protocol: 1, generation: 1, pollAfterSeconds: 300, sources: [], users: this.users };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
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
    this.users = [];
    this.invalid = 0;
    this.keepUsers = false;
  }

  last(): NodeSyncRequest {
    const last = this.received.at(-1);
    if (last === undefined) throw new Error('nenhum pedido recebido');
    return last;
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

describe('tarefa control-plane-sync do worker: usuários pedidos no console (banco real e plano de controle falso)', () => {
  const cp = new FakeControlPlane();
  const prisma = new PrismaService({ DATABASE_URL: inject('testDatabaseUrl') });
  /** Um teste por vez entre este arquivo e o outro da tarefa: a linha única de `ControlPlaneSync` é do banco inteiro. */
  const rowLock = new ControlPlaneSyncRowLock(inject('testDatabaseUrl'));
  let url: string;
  let keyring: VaultKeyring;
  let tenantA: string;
  let tenantB: string;
  let clock: Date;
  let logger: RecordingLogger;
  /** A API do mesmo banco, para o login com a senha temporária pelo caminho de verdade. */
  let app: NestExpressApplication;

  beforeAll(async () => {
    url = await cp.start();
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const pem = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
    keyring = parsePrivateKeys(`${KEY_VERSION}:${pem}`, KEY_VERSION);
    app = await createApp();
  });

  afterAll(async () => {
    await app.close();
    await cp.stop();
    await prisma.$disconnect();
  });

  afterEach(async () => {
    await rowLock.release();
  });

  beforeEach(async () => {
    await rowLock.acquire();
    cp.reset();
    // O relógio de verdade: o login confere a validade da senha temporária com ele.
    clock = new Date();
    logger = new RecordingLogger();
    tenantA = (await prisma.tenant.create({ data: { name: 'Cliente Demo A (usuários do console)' } })).id;
    tenantB = (await prisma.tenant.create({ data: { name: 'Cliente Demo B (usuários do console)' } })).id;
    await prisma.controlPlaneSync.deleteMany({});
  });

  function syncFor(overrides: Partial<ControlPlaneSyncOptions> & { users?: boolean } = {}) {
    const { users = true, ...options } = overrides;
    return new ControlPlaneSync(prisma, {
      config: {
        origin: 'https://conta.exemplo.com.br',
        url,
        commit: COMMIT,
        users,
        credential: { kind: 'gcp_identity' },
      },
      platform: 'gcp',
      keyring,
      node: {
        egressIps: [],
        serviceAccountId: '123456789012345678901',
        audience: 'https://verax.exemplo.com.br',
      },
      plans: fixedTenantPlans(resolvePlan('interno')),
      checks: { check: () => Promise.reject(new Error('sem fontes neste arquivo')) },
      logger,
      idToken: () => Promise.resolve('cabecalho.corpo.assinatura'),
      now: () => clock,
      random: () => 0.5,
      tenants: () => Promise.resolve([tenantA]),
      ...options,
    });
  }

  const run = (sync = syncFor()) => sync.runOnce(new AbortController().signal);
  /** A próxima chamada: depois do intervalo de 5 min. */
  const later = () => {
    clock = new Date(clock.getTime() + 10 * MINUTE);
  };

  /** Um pedido de usuário como o console o manda: a senha cifrada para o cofre do nó, amarrada ao pedido. */
  function desiredUser(
    overrides: Partial<NodeSyncDesiredUser> = {},
    { tenantId = tenantA, sealedEmail }: { tenantId?: string; sealedEmail?: string } = {},
  ): { user: NodeSyncDesiredUser; password: string } {
    const requestId = overrides.requestId ?? ulid();
    const address = overrides.email ?? email();
    const password = generateTemporaryPassword();
    const envelope = sealUserPassword(
      keyring.publicKey(),
      { nodeTenantId: tenantId, requestId, email: sealedEmail ?? address },
      password,
    );
    return {
      user: {
        requestId,
        name: 'Pessoa do Cliente',
        email: address,
        role: 'analista_cliente',
        envelope,
        notAfter: new Date(clock.getTime() + 72 * HOUR).toISOString(),
        ...overrides,
      },
      password,
    };
  }

  const itemOf = (requestId: string) =>
    prisma.controlPlaneSyncItem.findUnique({ where: { kind_itemId: { kind: 'user', itemId: requestId } } });
  const userOf = (requestId: string) =>
    prisma.user.findUnique({ where: { controlPlaneRequestId: requestId } });
  const reportOf = (body: NodeSyncRequest, requestId: string) =>
    body.users.find((user) => user.requestId === requestId);

  /** Nem o texto da senha nem o envelope no log, na trilha ou no que foi ao plano de controle. */
  async function expectNoSecret(secret: string, envelope: string) {
    const logs = JSON.stringify(logger.lines);
    const audits = JSON.stringify(await prisma.auditLog.findMany({ where: { tenantId: tenantA } }));
    const sent = JSON.stringify(cp.received);
    for (const value of [secret, envelope]) {
      expect(logs).not.toContain(value);
      expect(audits).not.toContain(value);
      expect(sent).not.toContain(value);
    }
  }

  it('cria a conta com a senha do pedido: troca obrigatória, validade no prazo do pedido, trilha da Verax; conta de volta', async () => {
    const { user: desired, password } = desiredUser({ email: 'Pessoa.Nova@Cliente.Example' });
    cp.users = [desired];

    const report = await run();

    expect(report).toMatchObject({ roundTrips: 2, usersCreated: 1, usersFailed: 0, error: null });
    expect(cp.invalid).toBe(0);
    expect(cp.received[0]?.capabilities).toEqual(['log_sources', 'users']);
    const created = await userOf(desired.requestId);
    expect(created).toMatchObject({
      tenantId: tenantA,
      email: 'pessoa.nova@cliente.example',
      name: 'Pessoa do Cliente',
      role: 'analista_cliente',
      status: 'active',
      mustChangePassword: true,
      twoFactorEnabled: false,
      temporaryPasswordExpiresAt: new Date(desired.notAfter),
    });
    expect(created?.id).toMatch(/^[A-Za-z0-9]{32}$/);
    const account = await prisma.account.findFirstOrThrow({ where: { userId: created?.id } });
    expect(account).toMatchObject({ providerId: 'credential' });
    expect(account.password).not.toContain(password);
    expect(await itemOf(desired.requestId)).toMatchObject({
      tenantId: tenantA,
      outcome: 'created',
      code: null,
    });
    // A segunda chamada conta a conta criada, com a situação dela (a senha nunca volta).
    expect(reportOf(cp.last(), desired.requestId)).toEqual({
      requestId: desired.requestId,
      outcome: 'created',
      code: null,
      user: { status: 'active', mfaEnabled: false, mustChangePassword: true },
    });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId: tenantA, action: 'user.create', resourceId: created?.id },
    });
    expect(audit).toMatchObject({
      actorType: 'system',
      actorId: CONTROL_PLANE_AUDIT_ACTOR_ID,
      outcome: 'success',
    });
    expect(audit.after).toMatchObject({
      email: 'pessoa.nova@cliente.example',
      role: 'analista_cliente',
      status: 'active',
      mustChangePassword: true,
      mfaEnabled: false,
      requestId: desired.requestId,
      origin: 'control_plane',
    });
    await expectNoSecret(password, desired.envelope);

    // O login com a senha do pedido: a sessão só alcança a troca de senha; depois da troca, o cadastro do MFA.
    const get = (cookie: string, path: string) =>
      request(app.getHttpServer()).get(path).set('Cookie', cookie);
    const cookie = await signIn(app, 'pessoa.nova@cliente.example', password);
    expect(meSchema.parse((await get(cookie, '/v1/me').expect(200)).body)).toMatchObject({
      mustChangePassword: true,
      mfaEnabled: false,
    });
    const blocked = await get(cookie, '/v1/findings').expect(403);
    expect(blocked.body).toMatchObject({ code: CREDENTIAL_CHANGE_REQUIRED_CODE });
    await authPost(app, '/change-password', cookie, {
      currentPassword: password,
      newPassword: NEW_PASSWORD,
    }).expect(200);
    const next = await get(cookie, '/v1/findings').expect(403);
    expect(next.body).toMatchObject({ code: 'MFA_REQUIRED' });
    const fresh = await signIn(app, 'pessoa.nova@cliente.example', NEW_PASSWORD);
    const { cookie: enrolled } = await enrollMfa(app, fresh, NEW_PASSWORD);
    await get(enrolled, '/v1/findings').expect(200);
  });

  it('o mesmo pedido de novo não cria outra conta (nem trilha nova) e continua contado como criado', async () => {
    const { user: desired } = desiredUser();
    cp.users = [desired];
    cp.keepUsers = true;
    await run();
    const audits = await prisma.auditLog.count({ where: { tenantId: tenantA } });
    later();

    const report = await run();

    expect(report).toMatchObject({ roundTrips: 1, usersCreated: 0, usersFailed: 0 });
    expect(await prisma.user.count({ where: { tenantId: tenantA } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { tenantId: tenantA } })).toBe(audits);
    expect(reportOf(cp.last(), desired.requestId)).toMatchObject({ outcome: 'created' });

    // A conta do pedido já existe, mas o resultado não foi gravado (o worker caiu no meio): conta como criada.
    await prisma.controlPlaneSyncItem.delete({
      where: { kind_itemId: { kind: 'user', itemId: desired.requestId } },
    });
    later();
    expect(await run()).toMatchObject({ usersCreated: 1 });
    expect(await prisma.user.count({ where: { tenantId: tenantA } })).toBe(1);
    expect(await itemOf(desired.requestId)).toMatchObject({ outcome: 'created' });
  });

  it('o prazo do pedido passou: expired, sem conta; o resultado é final', async () => {
    const { user: desired } = desiredUser({ notAfter: new Date(clock.getTime() - MINUTE).toISOString() });
    cp.users = [desired];
    cp.keepUsers = true;

    expect(await run()).toMatchObject({ roundTrips: 2, usersCreated: 0, usersFailed: 1 });

    expect(await userOf(desired.requestId)).toBeNull();
    expect(await itemOf(desired.requestId)).toMatchObject({ outcome: 'failed', code: 'expired' });
    expect(reportOf(cp.last(), desired.requestId)).toEqual({
      requestId: desired.requestId,
      outcome: 'failed',
      code: 'expired',
      user: null,
    });
    // O mesmo pedido de novo não é tentado: o console faz outro pedido.
    later();
    expect(await run()).toMatchObject({ usersCreated: 0, usersFailed: 0 });
    expect(await userOf(desired.requestId)).toBeNull();
  });

  it('com CONTROL_PLANE_USERS=false: o nó anuncia os usuários e recusa cada pedido com users_disabled', async () => {
    const { user: desired, password } = desiredUser();
    cp.users = [desired];

    expect(await run(syncFor({ users: false }))).toMatchObject({ usersFailed: 1 });

    expect(cp.received[0]?.capabilities).toContain('users');
    expect(await userOf(desired.requestId)).toBeNull();
    expect(await prisma.user.count({ where: { email: desired.email } })).toBe(0);
    expect(reportOf(cp.last(), desired.requestId)).toMatchObject({
      outcome: 'failed',
      code: 'users_disabled',
    });
    await expectNoSecret(password, desired.envelope);
  });

  it('sem o cofre: vault_disabled', async () => {
    const { user: desired } = desiredUser();
    cp.users = [desired];

    expect(await run(syncFor({ keyring: null }))).toMatchObject({ usersFailed: 1 });

    expect(await itemOf(desired.requestId)).toMatchObject({ outcome: 'failed', code: 'vault_disabled' });
  });

  it('o envelope amarrado a outro cliente ou a outro e-mail não abre: envelope_unreadable, sem conta', async () => {
    const otherTenant = desiredUser({}, { tenantId: tenantB });
    const otherEmail = desiredUser({}, { sealedEmail: email() });
    cp.users = [otherTenant.user, otherEmail.user];

    expect(await run()).toMatchObject({ usersFailed: 2, usersCreated: 0 });

    for (const { user: desired, password } of [otherTenant, otherEmail]) {
      expect(await userOf(desired.requestId)).toBeNull();
      expect(await itemOf(desired.requestId)).toMatchObject({
        outcome: 'failed',
        code: 'envelope_unreadable',
      });
      await expectNoSecret(password, desired.envelope);
    }
    expect(await prisma.user.count({ where: { tenantId: { in: [tenantA, tenantB] } } })).toBe(0);
  });

  it('sem vaga no plano: plan_limit_reached; sem o plano: tenant_plan_missing; a senha aberta não vai para lugar nenhum', async () => {
    await createUser(app, { role: 'leitura', tenantId: tenantA });
    const full = desiredUser();
    cp.users = [full.user];

    expect(
      await run(syncFor({ plans: fixedTenantPlans(resolvePlan('essencial', { maxUsers: 1 })) })),
    ).toMatchObject({ usersFailed: 1 });

    expect(await itemOf(full.user.requestId)).toMatchObject({
      outcome: 'failed',
      code: 'plan_limit_reached',
    });
    expect(await prisma.user.count({ where: { tenantId: tenantA } })).toBe(1);
    await expectNoSecret(full.password, full.user.envelope);

    const missing = desiredUser();
    cp.users = [missing.user];
    later();
    expect(await run(syncFor({ plans: fixedTenantPlans(null) }))).toMatchObject({ usersFailed: 1 });
    expect(await itemOf(missing.user.requestId)).toMatchObject({
      outcome: 'failed',
      code: 'tenant_plan_missing',
    });
  });

  it('o e-mail já é de outra conta (de qualquer cliente): email_taken, e a outra conta fica como estava', async () => {
    const taken = await createUser(app, { role: 'leitura', tenantId: tenantB });
    const { user: desired } = desiredUser({ email: taken.email });
    cp.users = [desired];

    expect(await run()).toMatchObject({ usersFailed: 1 });

    expect(await itemOf(desired.requestId)).toMatchObject({ outcome: 'failed', code: 'email_taken' });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: taken.id } })).toMatchObject({
      tenantId: tenantB,
      mustChangePassword: false,
      controlPlaneRequestId: null,
    });
    expect(await prisma.user.count({ where: { tenantId: tenantA } })).toBe(0);
  });

  it('isolamento: a conta de um pedido que é de outro cliente não é contada nem tocada; os itens dele não vão no pedido', async () => {
    const other = await createUser(app, { role: 'leitura', tenantId: tenantB });
    const requestId = ulid();
    await prisma.user.update({ where: { id: other.id }, data: { controlPlaneRequestId: requestId } });
    const failedOfB = ulid();
    await prisma.controlPlaneSyncItem.create({
      data: {
        kind: 'user',
        itemId: failedOfB,
        tenantId: tenantB,
        revision: 1,
        outcome: 'failed',
        code: 'expired',
      },
    });
    const { user: desired } = desiredUser({ requestId });
    cp.users = [desired];
    cp.keepUsers = true;

    expect(await run()).toMatchObject({ usersCreated: 0, usersFailed: 0 });

    expect(await prisma.user.count({ where: { tenantId: tenantA } })).toBe(0);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: other.id } })).toMatchObject({
      tenantId: tenantB,
      email: other.email,
    });
    expect(await itemOf(requestId)).toBeNull();
    for (const body of cp.received) {
      expect(body.users.map((user) => user.requestId)).not.toContain(requestId);
      expect(body.users.map((user) => user.requestId)).not.toContain(failedOfB);
    }
    expect(JSON.stringify(logger.lines)).not.toContain(other.email);
  });

  it('nas chamadas seguintes, a conta criada é contada com a situação de agora (o que mudou vai primeiro)', async () => {
    const { user: desired } = desiredUser();
    cp.users = [desired];
    await run();
    const created = await userOf(desired.requestId);
    later();
    await run();
    expect(reportOf(cp.last(), desired.requestId)).toMatchObject({
      user: { status: 'active', mfaEnabled: false, mustChangePassword: true },
    });
    const accepted = await itemOf(desired.requestId);
    expect(accepted?.reportedHash).toMatch(/^[0-9a-f]{64}$/);

    // A pessoa entrou e trocou a senha; depois cadastrou o MFA; depois o administrador do cliente a desativou. Cada
    // mudança sozinha muda a marca do último relato aceito (vai como mudado na chamada seguinte).
    const steps = [
      { mustChangePassword: false },
      { twoFactorEnabled: true },
      { status: 'disabled' as const },
    ];
    let previous = accepted?.reportedHash;
    for (const data of steps) {
      await prisma.user.update({ where: { id: created?.id }, data });
      later();
      await run();
      const hash = (await itemOf(desired.requestId))?.reportedHash;
      expect(hash, JSON.stringify(data)).toMatch(/^[0-9a-f]{64}$/);
      expect(hash, JSON.stringify(data)).not.toBe(previous);
      previous = hash;
    }

    expect(reportOf(cp.last(), desired.requestId)).toEqual({
      requestId: desired.requestId,
      outcome: 'created',
      code: null,
      user: { status: 'disabled', mfaEnabled: true, mustChangePassword: false },
    });
    // Sem mudança, a mesma marca.
    later();
    await run();
    expect((await itemOf(desired.requestId))?.reportedHash).toBe(previous);
  });

  it('os relatos dos usuários cabem no limite do pedido junto com o resto', async () => {
    // Cinco pedidos recusados (cada relato perto de 90 bytes); a segunda chamada leva os cinco.
    const expired = new Date(clock.getTime() - MINUTE).toISOString();
    cp.users = Array.from({ length: 5 }, () => desiredUser({ notAfter: expired }).user);
    await run();
    expect(cp.last().users).toHaveLength(5);
    const full = Buffer.byteLength(JSON.stringify(cp.last()), 'utf8');
    later();

    // Um limite 150 bytes menor que o pedido inteiro: ficam de fora dois relatos, que vão na chamada seguinte.
    const limit = full - 150;
    await run(syncFor({ requestMaxBytes: limit }));

    const sent = cp.last();
    expect(sent.users).toHaveLength(3);
    expect(Buffer.byteLength(JSON.stringify(sent), 'utf8')).toBeLessThanOrEqual(limit);
    expect(logger.lines.some((line) => line.message.includes('relatos de fora pelo limite do pedido'))).toBe(
      true,
    );
    later();
    await run(syncFor({ requestMaxBytes: limit }));
    const twoCalls = new Set([...sent.users, ...cp.last().users].map((user) => user.requestId));
    expect(twoCalls.size).toBe(5);
  });

  it('com mais de um cliente no banco, nenhum pedido de usuário é aplicado', async () => {
    const { user: desired } = desiredUser();
    cp.users = [desired];

    await run(syncFor({ tenants: () => Promise.resolve([tenantA, tenantB]) }));

    expect(cp.last().node.error).toBe('tenant_ambiguous');
    expect(cp.last().users).toEqual([]);
    expect(await userOf(desired.requestId)).toBeNull();
    expect(await itemOf(desired.requestId)).toBeNull();
  });

  it('o banco garante: um pedido é de uma conta só, e só conta de cliente tem pedido', async () => {
    const { user: desired } = desiredUser();
    cp.users = [desired];
    await run();
    const created = await userOf(desired.requestId);
    const another = await createUser(app, { role: 'leitura', tenantId: tenantA });
    await expect(
      prisma.user.update({ where: { id: another.id }, data: { controlPlaneRequestId: desired.requestId } }),
    ).rejects.toThrow();
    // Só conta de cliente tem pedido (CHECK do banco).
    await expect(
      prisma.user.create({
        data: {
          id: randomUUID(),
          email: email(),
          name: 'Equipe',
          role: 'admin_verax',
          tenantId: null,
          controlPlaneRequestId: ulid(),
        },
      }),
    ).rejects.toThrow();
    expect(created?.controlPlaneRequestId).toBe(desired.requestId);
  });
});
