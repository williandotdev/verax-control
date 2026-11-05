import 'reflect-metadata';
import { generateKeyPairSync, type KeyObject, randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildPinoOptions } from '../src/common/logger/logger.options.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { TenantScopeViolation } from '../src/common/prisma/tenant-scope.js';
import {
  parsePrivateKeys,
  parsePublicKey,
  type VaultKeyring,
  type VaultPublicKey,
} from '../src/credentials/credential-keys.js';
import { CredentialRekey } from '../src/credentials/credential-rekey.js';
import {
  CloudflareToken,
  CredentialVaultError,
  credentialBinding,
  open,
  seal,
  type VaultSecret,
} from '../src/credentials/credential-vault.js';
import type { CloudProvider } from '../src/generated/prisma/enums.js';
import { Scheduler } from '../src/worker/scheduler.js';
import { createSignedInUser, createTenant } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';
import { LogCapture } from './support/log-capture.js';

// Chaves e segredos gerados na hora: nenhum valor real nem fixo no repositório.
const pem64 = (key: KeyObject, type: 'spki' | 'pkcs8') =>
  Buffer.from(key.export({ type, format: 'pem' })).toString('base64');
const cloudflareAccountId = () => randomBytes(16).toString('hex');
const cloudflareToken = () => randomBytes(30).toString('base64url');

function vaultErrorOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof CredentialVaultError) return error.code;
    throw error;
  }
  throw new Error('a operação deveria ter falhado');
}

interface Account {
  id: string;
  tenantId: string;
  provider: CloudProvider;
  accountId: string;
}

describe('cofre de credenciais no banco (CloudCredential)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let publicV1: VaultPublicKey;
  let publicV2: VaultPublicKey;
  let onlyV1: VaultKeyring;
  let bothCurrentV2: VaultKeyring;
  let onlyV2: VaultKeyring;
  /** A versão 2 desativada antes da recifragem: o worker tem a 1 e a 3 (corrente). */
  let v1v3Current3: VaultKeyring;
  let allCurrent3: VaultKeyring;
  /** Contas criadas por cada teste: as credenciais delas saem no fim do teste (a recifragem varre a tabela toda). */
  const created: string[] = [];

  /** Uma conta do Cloudflare: o único provedor com credencial no cofre (a AWS é lida pelo papel sem chave). */
  async function newAccount(tenantId: string): Promise<Account> {
    const account = await prisma.forTenant(tenantId).cloudAccount.create({
      data: { tenantId, provider: 'cloudflare', accountId: cloudflareAccountId(), regions: [] },
      select: { id: true, tenantId: true, provider: true, accountId: true },
    });
    created.push(account.id);
    return account;
  }

  /** Grava a credencial como a tela grava (PR-11'): cifrada com a pública, pelo escopo do cliente. */
  async function store(account: Account, secret: VaultSecret, publicKey = publicV1) {
    const binding = credentialBinding(account, secret.kind);
    const sealed = seal(publicKey, binding, secret);
    await prisma.forTenant(account.tenantId).cloudCredential.create({
      data: {
        cloudAccountId: account.id,
        tenantId: account.tenantId,
        kind: secret.kind,
        ciphertext: sealed.ciphertext,
        keyVersion: sealed.keyVersion,
        keyIdSuffix: 'a1b2',
        verifiedAt: new Date(),
      },
    });
    return { binding, ...sealed };
  }

  const rowOf = (cloudAccountId: string) =>
    prisma.cloudCredential.findUniqueOrThrow({
      where: { cloudAccountId },
      select: {
        tenantId: true,
        kind: true,
        ciphertext: true,
        keyVersion: true,
        keyIdSuffix: true,
        updatedAt: true,
      },
    });

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente Demo A (cofre)');
    tenantB = await createTenant(app, 'Cliente Demo B (cofre)');
    const v1 = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const v2 = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const v3 = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const private1 = `1:${pem64(v1.privateKey, 'pkcs8')}`;
    const private2 = `2:${pem64(v2.privateKey, 'pkcs8')}`;
    const private3 = `3:${pem64(v3.privateKey, 'pkcs8')}`;
    publicV1 = parsePublicKey(pem64(v1.publicKey, 'spki'), 1);
    publicV2 = parsePublicKey(pem64(v2.publicKey, 'spki'), 2);
    onlyV1 = parsePrivateKeys(private1, 1);
    bothCurrentV2 = parsePrivateKeys(`${private1}\n${private2}`, 2);
    onlyV2 = parsePrivateKeys(private2, 2);
    v1v3Current3 = parsePrivateKeys(`${private1}\n${private3}`, 3);
    allCurrent3 = parsePrivateKeys(`${private1}\n${private2}\n${private3}`, 3);
  });

  afterEach(async () => {
    await prisma.cloudCredential.deleteMany({ where: { cloudAccountId: { in: created } } });
    created.length = 0;
  });

  afterAll(async () => {
    await app.close();
  });

  it('A/B: pelo escopo do cliente A, a credencial do B não existe, não muda e não sai', async () => {
    const accountA = await newAccount(tenantA);
    const accountB = await newAccount(tenantB);
    const freeAccountB = await newAccount(tenantB);
    await store(accountA, new CloudflareToken(cloudflareToken()));
    const storedB = await store(accountB, new CloudflareToken(cloudflareToken()));
    const scopedA = prisma.forTenant(tenantA).cloudCredential;

    expect(
      (await scopedA.findMany({ select: { cloudAccountId: true } })).map((row) => row.cloudAccountId),
    ).toEqual([accountA.id]);
    expect(await scopedA.findUnique({ where: { cloudAccountId: accountB.id } })).toBeNull();
    expect(
      await scopedA.updateMany({ where: { cloudAccountId: accountB.id }, data: { keyIdSuffix: 'ZZZZ' } }),
    ).toEqual({ count: 0 });
    expect(await scopedA.deleteMany({ where: { cloudAccountId: accountB.id } })).toEqual({ count: 0 });
    await expect(
      scopedA.update({ where: { cloudAccountId: accountB.id }, data: { keyIdSuffix: 'ZZZZ' } }),
    ).rejects.toThrow();
    // Gravar no cliente B pelo escopo de A é recusado antes do banco.
    expect(() =>
      scopedA.create({
        data: {
          tenantId: tenantB,
          cloudAccountId: freeAccountB.id,
          kind: 'cloudflare_api_token',
          ciphertext: storedB.ciphertext,
          keyVersion: 1,
          keyIdSuffix: 'ZZZZ',
          verifiedAt: new Date(),
        },
      }),
    ).toThrow(TenantScopeViolation);
    // Com o cliente do escopo (A) e a conta de B: a chave estrangeira composta recusa, com ou sem credencial lá.
    for (const cloudAccountId of [freeAccountB.id, accountB.id]) {
      await expect(
        scopedA.upsert({
          where: { cloudAccountId },
          create: {
            cloudAccountId,
            tenantId: tenantA,
            kind: 'cloudflare_api_token',
            ciphertext: storedB.ciphertext,
            keyVersion: 1,
            keyIdSuffix: 'ZZZZ',
            verifiedAt: new Date(),
          },
          update: { keyIdSuffix: 'ZZZZ' },
        }),
      ).rejects.toThrow();
    }

    const rowB = await rowOf(accountB.id);
    expect(rowB).toMatchObject({ tenantId: tenantB, ciphertext: storedB.ciphertext, keyVersion: 1 });
    expect(rowB.keyIdSuffix).not.toBe('ZZZZ');
    expect(
      await prisma.cloudCredential.findUnique({ where: { cloudAccountId: freeAccountB.id } }),
    ).toBeNull();
  });

  it('o banco amarra a credencial à conta e ao cliente, confere o envelope e apaga junto com a conta', async () => {
    const accountA = await newAccount(tenantA);
    const accountB = await newAccount(tenantB);
    const { ciphertext } = seal(
      publicV1,
      credentialBinding(accountA, 'cloudflare_api_token'),
      new CloudflareToken(cloudflareToken()),
    );
    const row = {
      cloudAccountId: accountA.id,
      tenantId: tenantA,
      kind: 'cloudflare_api_token' as const,
      ciphertext,
      keyVersion: 1,
      keyIdSuffix: 'WXYZ',
      verifiedAt: new Date(),
    };
    // Sem escopo nenhum (um erro da aplicação): o cliente da credencial tem de ser o da conta.
    await expect(
      prisma.cloudCredential.create({ data: { ...row, cloudAccountId: accountB.id } }),
    ).rejects.toThrow();
    for (const invalid of [
      { keyVersion: 0, ciphertext: ciphertext.replace(/^v1:/, 'v0:') },
      { keyIdSuffix: 'ab' },
      { keyIdSuffix: 'ab:c' },
      { ciphertext: ciphertext.replace(/^v1:/, 'v2:') },
      { ciphertext: ciphertext.slice(3) },
      { ciphertext: `${ciphertext}\n` },
    ]) {
      await expect(prisma.cloudCredential.create({ data: { ...row, ...invalid } })).rejects.toThrow();
    }
    await prisma.cloudCredential.create({ data: row });
    // A conta sai (cascade): a credencial vai junto.
    await prisma.cloudAccount.delete({ where: { id: accountA.id } });
    expect(await prisma.cloudCredential.findUnique({ where: { cloudAccountId: accountA.id } })).toBeNull();
  });

  it('a credencial não sai pela API de contas cloud, nem para o admin do próprio cliente', async () => {
    const account = await newAccount(tenantA);
    const { ciphertext } = await store(account, new CloudflareToken(cloudflareToken()));
    const admin = await createSignedInUser(app, { role: 'admin_cliente', tenantId: tenantA });
    const server = request(app.getHttpServer());
    for (const path of ['/v1/cloud-accounts', `/v1/cloud-accounts/${account.id}`]) {
      const response = await server.get(path).set('Cookie', admin.cookie).expect(200);
      expect(response.text).not.toContain(ciphertext.slice(3, 60));
      expect(response.text).not.toMatch(/ciphertext|keyVersion|"credential"/);
    }
  });

  it('recifragem: v1 para v2 em todos os clientes, pelo escopo de cada um, com auditoria na trilha dele', async () => {
    const accountA = await newAccount(tenantA);
    const accountB = await newAccount(tenantB);
    const current = await newAccount(tenantB);
    const secret = cloudflareToken();
    const token = cloudflareToken();
    const storedA = await store(accountA, new CloudflareToken(secret));
    const storedB = await store(accountB, new CloudflareToken(token));
    await store(current, new CloudflareToken(cloudflareToken()), bothCurrentV2.publicKey());
    const before = await rowOf(accountA.id);

    const report = await new CredentialRekey(prisma, bothCurrentV2).runOnce();
    expect(report).toEqual({ stale: 2, rekeyed: 2, skipped: 0, failed: 0 });

    const rowA = await rowOf(accountA.id);
    const rowB = await rowOf(accountB.id);
    expect(rowA).toMatchObject({ tenantId: tenantA, keyVersion: 2 });
    expect(rowA.ciphertext).toMatch(/^v2:/);
    expect(rowA.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
    expect(rowB).toMatchObject({ tenantId: tenantB, kind: 'cloudflare_api_token', keyVersion: 2 });
    // A v1 pode sair do Secret Manager: tudo abre só com a v2, e nada abre mais só com a v1.
    expect(open(onlyV2, storedA.binding, rowA.ciphertext).value()).toBe(secret);
    expect(open(onlyV2, storedB.binding, rowB.ciphertext).value()).toBe(token);
    expect(vaultErrorOf(() => open(onlyV1, storedA.binding, rowA.ciphertext))).toBe('key_version_missing');

    const audit = await prisma.auditLog.findMany({
      where: { action: 'cloud_credential.rekey', resourceId: { in: [accountA.id, accountB.id, current.id] } },
      orderBy: { occurredAt: 'asc' },
    });
    expect(audit.map((entry) => [entry.resourceId, entry.tenantId]).sort()).toEqual(
      [
        [accountA.id, tenantA],
        [accountB.id, tenantB],
      ].sort(),
    );
    for (const entry of audit) {
      expect(entry).toMatchObject({
        actorType: 'system',
        outcome: 'success',
        resourceType: 'cloud_credential',
      });
      expect(entry.before).toMatchObject({ keyVersion: 1 });
      expect(entry.after).toMatchObject({ keyVersion: 2 });
      expect(JSON.stringify(entry)).not.toMatch(/v[12]:[A-Za-z0-9+/]{20}/);
    }

    // De novo: nada a fazer.
    expect(await new CredentialRekey(prisma, bothCurrentV2).runOnce()).toEqual({
      stale: 0,
      rekeyed: 0,
      skipped: 0,
      failed: 0,
    });
  });

  it('A/B: a linha copiada para a conta de outro cliente não abre, e a recifragem não a conserta', async () => {
    const accountA = await newAccount(tenantA);
    const accountB = await newAccount(tenantB);
    const storedA = await store(accountA, new CloudflareToken(cloudflareToken()));
    // Quem tem o banco copia o texto de A para a linha da conta de B (a linha em si é válida para B).
    await prisma.cloudCredential.create({
      data: {
        cloudAccountId: accountB.id,
        tenantId: tenantB,
        kind: 'cloudflare_api_token',
        ciphertext: storedA.ciphertext,
        keyVersion: 1,
        keyIdSuffix: 'ZZZZ',
        verifiedAt: new Date(),
      },
    });
    const bindingB = credentialBinding(accountB, 'cloudflare_api_token');
    expect(vaultErrorOf(() => open(onlyV1, bindingB, storedA.ciphertext))).toBe('decrypt_failed');

    const report = await new CredentialRekey(prisma, bothCurrentV2).runOnce();
    expect(report).toEqual({ stale: 2, rekeyed: 1, skipped: 0, failed: 1, failures: { decrypt_failed: 1 } });
    expect(await rowOf(accountB.id)).toMatchObject({ ciphertext: storedA.ciphertext, keyVersion: 1 });
    expect(await rowOf(accountA.id)).toMatchObject({ keyVersion: 2 });
    expect(
      await prisma.auditLog.count({ where: { action: 'cloud_credential.rekey', resourceId: accountB.id } }),
    ).toBe(0);
  });

  it('versão da chave ausente e texto adulterado: a recifragem falha fechado e não mexe na linha', async () => {
    const missing = await newAccount(tenantA);
    const tampered = await newAccount(tenantB);
    const storedMissing = await store(missing, new CloudflareToken(cloudflareToken()));
    const storedTampered = await store(tampered, new CloudflareToken(cloudflareToken()));
    const body = Buffer.from(storedTampered.ciphertext.slice(3), 'base64');
    body[10] = (body[10] ?? 0) ^ 0x80;
    const tamperedText = `v1:${body.toString('base64')}`;
    await prisma.cloudCredential.update({
      where: { cloudAccountId: tampered.id },
      data: { ciphertext: tamperedText },
    });

    // Só a v2 no worker (a v1 foi desativada antes da recifragem): a linha da v1 fica como está.
    const report = await new CredentialRekey(prisma, onlyV2).runOnce();
    expect(report).toEqual({
      stale: 2,
      rekeyed: 0,
      skipped: 0,
      failed: 2,
      failures: { key_version_missing: 2 },
    });
    expect(await rowOf(missing.id)).toMatchObject({ ciphertext: storedMissing.ciphertext, keyVersion: 1 });

    // Com a v1 de volta, a adulterada continua sem abrir; a outra recifra.
    expect(await new CredentialRekey(prisma, bothCurrentV2).runOnce()).toEqual({
      stale: 2,
      rekeyed: 1,
      skipped: 0,
      failed: 1,
      failures: { decrypt_failed: 1 },
    });
    expect(await rowOf(tampered.id)).toMatchObject({ ciphertext: tamperedText, keyVersion: 1 });
    expect(await rowOf(missing.id)).toMatchObject({ keyVersion: 2 });
  });

  it('log-capture: a recifragem pelo agendador não põe segredo nem texto cifrado no log', async () => {
    const accountA = await newAccount(tenantA);
    const accountB = await newAccount(tenantB);
    const secret = cloudflareToken();
    const token = cloudflareToken();
    const storedA = await store(accountA, new CloudflareToken(secret));
    const storedB = await store(accountB, new CloudflareToken(token));

    const capture = new LogCapture();
    const logger = pino(buildPinoOptions({ LOG_LEVEL: 'trace' }), capture);
    const rekey = new CredentialRekey(prisma, bothCurrentV2);
    const scheduler = new Scheduler(
      [
        {
          name: 'credential-rekey',
          intervalMs: 60_000,
          budgetMs: 60_000,
          run: (signal) => rekey.runOnce(signal),
        },
      ],
      logger,
    );
    scheduler.start();
    await vi.waitFor(() => expect(capture.text).toContain('tarefa concluída'), { timeout: 20_000 });
    await scheduler.stop();

    // Depois de decifrados no processo, os segredos somem até de uma mensagem que os repita sem nome de campo.
    logger.error({ detail: { reason: `a origem recusou ${secret}` } }, `o Cloudflare recusou ${token}`);
    const rows = [await rowOf(accountA.id), await rowOf(accountB.id)];
    const text = capture.text;
    for (const value of [
      secret,
      token,
      storedA.ciphertext.slice(3, 60),
      storedB.ciphertext.slice(3, 60),
      ...rows.map((row) => row.ciphertext.slice(3, 60)),
    ]) {
      expect(text).not.toContain(value);
    }
    const done = capture.entries().find((entry) => entry['msg'] === 'tarefa concluída');
    expect(done).toMatchObject({
      task: 'credential-rekey',
      report: { stale: 2, rekeyed: 2, skipped: 0, failed: 0 },
    });
    expect(text).toContain('[REDACTED]');
  });

  it('recifragem: a linha que não abre não segura as seguintes (páginas de 1 linha), e a execução seguinte a tenta de novo', async () => {
    // Três contas, na ordem da varredura (o ID da conta). A primeira fica cifrada com a versão 2, que o chaveiro da
    // primeira execução não tem (só a 1 e a 3, corrente 3): ela não abre, e as outras duas, na versão 1, têm de ser
    // recifradas na mesma execução, mesmo com uma linha por página (sem o cursor, a página seria sempre a primeira).
    const accounts = [await newAccount(tenantA), await newAccount(tenantB), await newAccount(tenantA)].sort(
      (a, b) => (a.id < b.id ? -1 : 1),
    );
    const [first, second, third] = accounts as [Account, Account, Account];
    const secrets = [cloudflareToken(), cloudflareToken(), cloudflareToken()] as const;
    const storedFirst = await store(first, new CloudflareToken(secrets[0]), publicV2);
    const storedSecond = await store(second, new CloudflareToken(secrets[1]));
    const storedThird = await store(third, new CloudflareToken(secrets[2]));

    const capture = new LogCapture();
    const logger = pino(buildPinoOptions({ LOG_LEVEL: 'trace' }), capture);
    const rekey = new CredentialRekey(prisma, v1v3Current3, { batch: 1 });
    const scheduler = new Scheduler(
      [
        {
          name: 'credential-rekey',
          intervalMs: 60_000,
          budgetMs: 60_000,
          run: (signal) => rekey.runOnce(signal),
        },
      ],
      logger,
    );
    scheduler.start();
    await vi.waitFor(() => expect(capture.text).toContain('tarefa concluída'), { timeout: 20_000 });
    await scheduler.stop();

    const done = capture.entries().find((entry) => entry['msg'] === 'tarefa concluída');
    expect(done).toMatchObject({
      task: 'credential-rekey',
      report: { stale: 3, rekeyed: 2, skipped: 0, failed: 1, failures: { key_version_missing: 1 } },
    });
    expect(await rowOf(first.id)).toMatchObject({ ciphertext: storedFirst.ciphertext, keyVersion: 2 });
    const rowSecond = await rowOf(second.id);
    const rowThird = await rowOf(third.id);
    expect(rowSecond).toMatchObject({ tenantId: tenantB, keyVersion: 3 });
    expect(rowThird).toMatchObject({ tenantId: tenantA, keyVersion: 3 });
    for (const value of [
      ...secrets,
      ...[storedFirst, storedSecond, storedThird, rowSecond, rowThird].map((row) =>
        row.ciphertext.slice(3, 60),
      ),
    ]) {
      expect(capture.text).not.toContain(value);
    }

    // A execução seguinte, com a versão 2 de volta no chaveiro: só a primeira está pendente, e agora abre.
    expect(await new CredentialRekey(prisma, allCurrent3, { batch: 1 }).runOnce()).toEqual({
      stale: 1,
      rekeyed: 1,
      skipped: 0,
      failed: 0,
    });
    const rowFirst = await rowOf(first.id);
    expect(rowFirst).toMatchObject({ tenantId: tenantA, keyVersion: 3 });
    expect(open(allCurrent3, storedFirst.binding, rowFirst.ciphertext).value()).toBe(secrets[0]);
    // Uma entrada de auditoria por linha recifrada (duas na primeira execução, uma na segunda), nenhuma pela falha.
    const audit = await prisma.auditLog.findMany({
      where: { action: 'cloud_credential.rekey', resourceId: { in: accounts.map((account) => account.id) } },
      select: { resourceId: true, tenantId: true, after: true },
    });
    expect(audit.map((entry) => [entry.resourceId, entry.tenantId]).sort()).toEqual(
      accounts.map((account) => [account.id, account.tenantId]).sort(),
    );
    for (const entry of audit) expect(entry.after).toMatchObject({ keyVersion: 3 });
  });
});
