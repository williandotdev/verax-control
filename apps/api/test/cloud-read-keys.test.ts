import 'reflect-metadata';
import { generateKeyPairSync, type KeyObject, randomBytes, randomInt } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { authClientConfigSchema, cloudAccountSchema } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AwsAccessKeyCheck } from '../src/aws/aws-key-check.js';
import { scrubString } from '../src/common/logger/sanitize.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import {
  type CheckedCredential,
  CredentialRejected,
  CredentialSourceUnavailable,
} from '../src/credentials/credential-check.js';
import { parsePrivateKeys, type VaultKeyring } from '../src/credentials/credential-keys.js';
import {
  AwsAccessKey,
  credentialBinding,
  GcpServiceAccountKey,
  open,
} from '../src/credentials/credential-vault.js';
import { GcpServiceAccountKeyCheck } from '../src/gcp/gcp-key-check.js';
import { createSignedInUser, createTenant, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import { LogCapture } from './support/log-capture.js';
import type { TestSession } from './support/tenant-isolation.js';

// Chaves geradas na hora, no formato da AWS e do Google: nenhuma chave real no repositório.
const pem64 = (key: KeyObject, type: 'spki' | 'pkcs8') =>
  Buffer.from(key.export({ type, format: 'pem' })).toString('base64');
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const awsKeyId = () => `AKIA${Array.from(randomBytes(16), (byte) => BASE32.charAt(byte % 32)).join('')}`;
const awsSecret = () => randomBytes(30).toString('base64');
const gcpKey = (projectId: string) => ({
  projectId,
  clientEmail: `verax-control-reader@${projectId}.iam.gserviceaccount.com`,
  privateKeyId: randomBytes(20).toString('hex'),
  privateKey: generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString(),
});
/** Versão da chave do nó neste arquivo: longe das que os outros arquivos usam, para a recifragem não pegar as linhas. */
const KEY_VERSION = 910;

/** As conferências na origem, falsas: o que cada chave responde e quem foi chamado (sem a AWS nem o Google). */
class FakeChecks {
  readonly awsCalls: string[] = [];
  readonly gcpCalls: string[] = [];
  awsOutcome: 'ok' | 'invalid' | 'root' | 'down' = 'ok';
  gcpOutcome: 'ok' | 'no_access' = 'ok';

  readonly aws = {
    check: (key: AwsAccessKey, accountId: string): Promise<CheckedCredential> => {
      this.awsCalls.push(accountId);
      switch (this.awsOutcome) {
        case 'invalid':
          return Promise.reject(new CredentialRejected('invalid', 403));
        case 'root':
          return Promise.reject(new CredentialRejected('wrong_identity'));
        case 'down':
          return Promise.reject(new CredentialSourceUnavailable('timeout'));
        default:
          return Promise.resolve({ keyIdSuffix: key.accessKeyId.slice(-4), issuedAt: null, expiresAt: null });
      }
    },
  };

  readonly gcp = {
    check: (key: GcpServiceAccountKey, subscription: string): Promise<CheckedCredential> => {
      this.gcpCalls.push(subscription);
      if (this.gcpOutcome === 'no_access')
        return Promise.reject(new CredentialRejected('no_account_access', 403));
      return Promise.resolve({ keyIdSuffix: key.privateKeyId.slice(-4), issuedAt: null, expiresAt: null });
    },
  };
}

interface Setup {
  app: NestExpressApplication;
  prisma: PrismaService;
  checks: FakeChecks;
  capture: LogCapture;
}

async function setup(nodePlatform: 'gcp' | 'vm', publicKey: string): Promise<Setup> {
  const capture = new LogCapture();
  const checks = new FakeChecks();
  const app = await createApp({
    capture,
    nodePlatform,
    vault: { publicKey, version: KEY_VERSION },
    overrideProviders: [
      { provide: AwsAccessKeyCheck, useValue: checks.aws },
      { provide: GcpServiceAccountKeyCheck, useValue: checks.gcp },
    ],
  });
  return { app, prisma: app.get(PrismaService), checks, capture };
}

async function adminOf(app: NestExpressApplication, tenantId: string): Promise<TestSession> {
  const user = await createSignedInUser(app, { role: 'admin_cliente', tenantId });
  const { cookie, token } = await withCsrf(app, user.cookie);
  return { cookie, csrfToken: token };
}

function put(app: NestExpressApplication, session: TestSession, id: string, body: object) {
  return request(app.getHttpServer())
    .put(`/v1/cloud-accounts/${id}/credential`)
    .set('Cookie', session.cookie)
    .set('Origin', TEST_WEB_ORIGIN)
    .set('X-CSRF-Token', session.csrfToken)
    .send(body);
}

async function account(
  prisma: PrismaService,
  tenantId: string,
  provider: 'aws' | 'gcp',
  subscription = true,
) {
  const accountId =
    provider === 'aws'
      ? String(randomInt(100_000_000_000, 999_999_999_999))
      : `cliente-demo-${randomBytes(4).toString('hex')}`;
  return prisma.forTenant(tenantId).cloudAccount.create({
    data: {
      tenantId,
      provider,
      accountId,
      regions: provider === 'aws' ? ['sa-east-1'] : [],
      ...(provider === 'gcp' &&
        subscription && { pubsubSubscription: `projects/${accountId}/subscriptions/verax-control-security` }),
    },
    select: { id: true, tenantId: true, provider: true, accountId: true, pubsubSubscription: true },
  });
}

describe('chaves de leitura da VM própria do cliente (NODE_PLATFORM=vm)', () => {
  const pasted: string[] = [];
  let vm: Setup;
  let keyring: VaultKeyring;
  let tenantA: string;
  let tenantB: string;
  let adminA: TestSession;
  let adminB: TestSession;

  beforeAll(async () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
    keyring = parsePrivateKeys(`${KEY_VERSION}:${pem64(pair.privateKey, 'pkcs8')}`, KEY_VERSION);
    vm = await setup('vm', pem64(pair.publicKey, 'spki'));
    tenantA = await createTenant(vm.app, 'Cliente Demo A (chaves de leitura)');
    tenantB = await createTenant(vm.app, 'Cliente Demo B (chaves de leitura)');
    adminA = await adminOf(vm.app, tenantA);
    adminB = await adminOf(vm.app, tenantB);
  });

  afterAll(async () => {
    await vm.prisma.cloudCredential.deleteMany({ where: { keyVersion: KEY_VERSION } });
    // Nenhuma chave colada aparece no log do arquivo inteiro.
    const log = vm.capture.lines.join('\n');
    for (const secret of pasted) expect(log).not.toContain(secret);
    await vm.app.close();
  });

  it('o painel sabe que o nó é a VM própria (client-config)', async () => {
    const response = await request(vm.app.getHttpServer()).get('/v1/auth/client-config').expect(200);
    expect(authClientConfigSchema.parse(response.body).nodePlatform).toBe('vm');
  });

  it('a chave do usuário IAM: conferida, cifrada no cofre, só os metadados saem, e só o worker abre', async () => {
    const aws = await account(vm.prisma, tenantA, 'aws');
    const accessKeyId = awsKeyId();
    const secretAccessKey = awsSecret();
    pasted.push(secretAccessKey);
    const response = await put(vm.app, adminA, aws.id, {
      kind: 'aws_access_key',
      accessKeyId,
      secretAccessKey,
    }).expect(200);
    expect(cloudAccountSchema.parse(response.body).keyStatus).toMatchObject({
      kind: 'aws_access_key',
      keyIdSuffix: accessKeyId.slice(-4),
      expiresAt: null,
    });
    expect(response.text).not.toContain(secretAccessKey);
    expect(vm.checks.awsCalls).toContain(aws.accountId);
    const row = await vm.prisma.cloudCredential.findUniqueOrThrow({ where: { cloudAccountId: aws.id } });
    expect(JSON.stringify(row)).not.toContain(secretAccessKey);
    expect(row).toMatchObject({ kind: 'aws_access_key', keyVersion: KEY_VERSION });
    // A API esqueceu o segredo no fim da requisição (o logger não o guarda mais).
    expect(scrubString(secretAccessKey)).toBe(secretAccessKey);
    const opened = open(keyring, credentialBinding(aws, 'aws_access_key'), row.ciphertext);
    expect(opened).toBeInstanceOf(AwsAccessKey);
    expect((opened as AwsAccessKey).secret()).toBe(secretAccessKey);
    const entry = await vm.prisma.auditLog.findFirstOrThrow({
      where: { requestId: response.headers['x-request-id'] },
    });
    expect(entry).toMatchObject({
      action: 'cloud_credential.set',
      after: { kind: 'aws_access_key', keyIdSuffix: accessKeyId.slice(-4), expiresAt: null },
    });
    expect(JSON.stringify(entry)).not.toContain(secretAccessKey);
  });

  it('a chave da AWS recusada (inválida, do root) é 400 na trilha; a AWS fora é 503; nada gravado', async () => {
    const aws = await account(vm.prisma, tenantA, 'aws');
    for (const [outcome, status, message] of [
      ['invalid', 400, /A AWS não aceitou a chave/],
      ['root', 400, /não é de um usuário IAM/],
      // 5xx sai sempre com a mensagem genérica do filtro global (o detalhe fica só no log).
      ['down', 503, /Serviço temporariamente indisponível/],
    ] as const) {
      vm.checks.awsOutcome = outcome;
      const secretAccessKey = awsSecret();
      pasted.push(secretAccessKey);
      const response = await put(vm.app, adminA, aws.id, {
        kind: 'aws_access_key',
        accessKeyId: awsKeyId(),
        secretAccessKey,
      }).expect(status);
      expect((response.body as { message?: string }).message).toMatch(message);
      expect(response.text).not.toContain(secretAccessKey);
    }
    vm.checks.awsOutcome = 'ok';
    expect(await vm.prisma.cloudCredential.count({ where: { cloudAccountId: aws.id } })).toBe(0);
  });

  it('a chave da conta de serviço: conferida na assinatura da conta e guardada no envelope híbrido', async () => {
    const gcp = await account(vm.prisma, tenantA, 'gcp');
    const key = gcpKey(gcp.accountId);
    pasted.push(key.privateKey.split('\n')[3] ?? '');
    const response = await put(vm.app, adminA, gcp.id, { kind: 'gcp_service_account_key', ...key }).expect(
      200,
    );
    expect(cloudAccountSchema.parse(response.body).keyStatus).toMatchObject({
      kind: 'gcp_service_account_key',
      keyIdSuffix: key.privateKeyId.slice(-4),
    });
    expect(vm.checks.gcpCalls).toContain(gcp.pubsubSubscription);
    expect(response.text).not.toContain('PRIVATE KEY');
    const row = await vm.prisma.cloudCredential.findUniqueOrThrow({ where: { cloudAccountId: gcp.id } });
    expect(row.ciphertext.length).toBeGreaterThan(1024);
    const opened = open(keyring, credentialBinding(gcp, 'gcp_service_account_key'), row.ciphertext);
    expect((opened as GcpServiceAccountKey).privateKey()).toBe(key.privateKey);
  });

  it('a chave da GCP sem a assinatura cadastrada, ou sem acesso a ela, é recusada', async () => {
    const withoutSubscription = await account(vm.prisma, tenantA, 'gcp', false);
    const calls = vm.checks.gcpCalls.length;
    await put(vm.app, adminA, withoutSubscription.id, {
      kind: 'gcp_service_account_key',
      ...gcpKey(withoutSubscription.accountId),
    }).expect(400);
    expect(vm.checks.gcpCalls).toHaveLength(calls);
    const gcp = await account(vm.prisma, tenantA, 'gcp');
    vm.checks.gcpOutcome = 'no_access';
    const refused = await put(vm.app, adminA, gcp.id, {
      kind: 'gcp_service_account_key',
      ...gcpKey(gcp.accountId),
    }).expect(400);
    vm.checks.gcpOutcome = 'ok';
    expect((refused.body as { message?: string }).message).toMatch(/roles\/pubsub\.subscriber/);
  });

  it('o tipo é o do provedor da conta: a chave da AWS numa conta GCP é 400, sem chamar a origem', async () => {
    const gcp = await account(vm.prisma, tenantA, 'gcp');
    const calls = vm.checks.awsCalls.length;
    await put(vm.app, adminA, gcp.id, {
      kind: 'aws_access_key',
      accessKeyId: awsKeyId(),
      secretAccessKey: awsSecret(),
    }).expect(400);
    expect(vm.checks.awsCalls).toHaveLength(calls);
  });

  it('A/B: o admin de B não cola chave na conta de A (404 sem chamar a origem e sem gravar)', async () => {
    const aws = await account(vm.prisma, tenantA, 'aws');
    const calls = vm.checks.awsCalls.length;
    await put(vm.app, adminB, aws.id, {
      kind: 'aws_access_key',
      accessKeyId: awsKeyId(),
      secretAccessKey: awsSecret(),
    }).expect(404);
    expect(vm.checks.awsCalls).toHaveLength(calls);
    expect(await vm.prisma.cloudCredential.count({ where: { cloudAccountId: aws.id } })).toBe(0);
  });
});

describe('chaves de leitura num nó da GCP (o gerenciado): recusadas no servidor', () => {
  let gcpNode: Setup;
  let tenant: string;
  let admin: TestSession;

  beforeAll(async () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
    gcpNode = await setup('gcp', pem64(pair.publicKey, 'spki'));
    tenant = await createTenant(gcpNode.app, 'Cliente Demo A (nó da GCP)');
    admin = await adminOf(gcpNode.app, tenant);
  });

  afterAll(async () => {
    await gcpNode.app.close();
  });

  it('o painel sabe que o nó é da GCP (client-config)', async () => {
    const response = await request(gcpNode.app.getHttpServer()).get('/v1/auth/client-config').expect(200);
    expect(authClientConfigSchema.parse(response.body).nodePlatform).toBe('gcp');
  });

  it('a chave da AWS e a da GCP: 400 CREDENTIAL_KIND_NOT_ALLOWED, sem conferir nem gravar, na trilha', async () => {
    const aws = await account(gcpNode.prisma, tenant, 'aws');
    const gcp = await account(gcpNode.prisma, tenant, 'gcp');
    const secretAccessKey = awsSecret();
    const awsResponse = await put(gcpNode.app, admin, aws.id, {
      kind: 'aws_access_key',
      accessKeyId: awsKeyId(),
      secretAccessKey,
    }).expect(400);
    const gcpResponse = await put(gcpNode.app, admin, gcp.id, {
      kind: 'gcp_service_account_key',
      ...gcpKey(gcp.accountId),
    }).expect(400);
    for (const response of [awsResponse, gcpResponse]) {
      expect((response.body as { code?: string }).code).toBe('CREDENTIAL_KIND_NOT_ALLOWED');
      const entry = await gcpNode.prisma.auditLog.findFirstOrThrow({
        where: { requestId: response.headers['x-request-id'] },
      });
      expect(entry).toMatchObject({ action: 'cloud_credential.set', outcome: 'failure', statusCode: 400 });
      expect(JSON.stringify(entry)).not.toContain(secretAccessKey);
    }
    expect(gcpNode.checks.awsCalls).toEqual([]);
    expect(gcpNode.checks.gcpCalls).toEqual([]);
    expect(
      await gcpNode.prisma.cloudCredential.count({ where: { cloudAccountId: { in: [aws.id, gcp.id] } } }),
    ).toBe(0);
  });
});
