import 'reflect-metadata';
import { generateKeyPairSync, type KeyObject, randomInt } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { cloudAccountSchema, GLOBAL_KEY_REFUSED_MESSAGE, type Role } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CloudflareTokenCheck } from '../src/cloudflare/cloudflare-token-check.js';
import { scrubString } from '../src/common/logger/sanitize.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { parsePrivateKeys, type VaultKeyring } from '../src/credentials/credential-keys.js';
import {
  CREDENTIAL_ATTEMPT_WINDOW_MS,
  CREDENTIAL_ATTEMPTS_PER_ACCOUNT,
  CREDENTIAL_ATTEMPTS_PER_TENANT,
} from '../src/credentials/credential-intake.service.js';
import { CloudflareToken, credentialBinding, open } from '../src/credentials/credential-vault.js';
import { createSignedInUser, createTenant, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import { fakeCloudflare, FakeCloudflareServer } from './support/fake-cloudflare.js';
import { LogCapture } from './support/log-capture.js';
import type { TestSession } from './support/tenant-isolation.js';

const pem64 = (key: KeyObject, type: 'spki' | 'pkcs8') =>
  Buffer.from(key.export({ type, format: 'pem' })).toString('base64');
const EGRESS = '203.0.113.10/32';
/**
 * Versão da chave do nó neste arquivo: acima das que a recifragem de `cloud-credentials.test.ts` usa como corrente (2
 * e 3), para as linhas daqui, cifradas com outra chave, nunca entrarem como pendentes na varredura dela.
 */
const KEY_VERSION = 900;
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

describe('credencial colada no painel: token do Cloudflare no cofre (fase 2, PR-11)', () => {
  const capture = new LogCapture();
  const cloudflare = new FakeCloudflareServer();
  /** Todo token usado no arquivo: nenhum pode aparecer no log, na trilha ou numa resposta. */
  const pasted: string[] = [];
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let keyring: VaultKeyring;
  let tenantA: string;
  let tenantB: string;
  let adminA: TestSession;
  let adminB: TestSession;
  const sessions = new Map<Role, TestSession>();

  async function sessionFor(tenantId: string | null, role: Role): Promise<TestSession> {
    const user = await createSignedInUser(app, { role, ...(tenantId !== null && { tenantId }) });
    const { cookie, token } = await withCsrf(app, user.cookie);
    return { cookie, csrfToken: token };
  }

  const write = (session: TestSession, method: 'put' | 'delete' | 'patch' | 'post', path: string) => {
    const agent = request(app.getHttpServer());
    return agent[method](path)
      .set('Cookie', session.cookie)
      .set('Origin', TEST_WEB_ORIGIN)
      .set('X-CSRF-Token', session.csrfToken);
  };
  /** O corpo de erro da API (`ErrorResponseBody`), só com o que os testes leem. */
  const errorOf = (response: request.Response) =>
    response.body as { message?: string; code?: string; issues?: { path: string; message: string }[] };
  const put = (session: TestSession, id: string, token: string) => {
    pasted.push(token);
    return write(session, 'put', `/v1/cloud-accounts/${id}/credential`).send({
      kind: 'cloudflare_api_token',
      token,
    });
  };
  const remove = (session: TestSession, id: string) =>
    write(session, 'delete', `/v1/cloud-accounts/${id}/credential`);
  const entryOf = (response: request.Response) =>
    prisma.auditLog.findFirstOrThrow({ where: { requestId: response.headers['x-request-id'] } });
  const entriesOf = (response: request.Response) =>
    prisma.auditLog.findMany({
      where: { requestId: response.headers['x-request-id'] },
      orderBy: { action: 'asc' },
    });

  async function cloudflareAccount(tenantId: string, provider: 'cloudflare' | 'aws' = 'cloudflare') {
    return prisma.forTenant(tenantId).cloudAccount.create({
      data: {
        tenantId,
        provider,
        accountId:
          provider === 'cloudflare'
            ? fakeCloudflare.accountId()
            : String(randomInt(100_000_000_000, 999_999_999_999)),
        regions: provider === 'aws' ? ['sa-east-1'] : [],
        externalId: provider === 'aws' ? 'x'.repeat(43) : null,
        connection: 'error',
        connectionError: 'TokenInvalido',
      },
      select: { id: true, tenantId: true, provider: true, accountId: true },
    });
  }

  beforeAll(async () => {
    await cloudflare.start();
    const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
    keyring = parsePrivateKeys(`${KEY_VERSION}:${pem64(pair.privateKey, 'pkcs8')}`, KEY_VERSION);
    app = await createApp({
      capture,
      vault: { publicKey: pem64(pair.publicKey, 'spki'), version: KEY_VERSION },
      nodeEgressIps: EGRESS,
      // A API conversa com o Cloudflare falso; o tempo limite curto mantém o teste de indisponibilidade rápido.
      overrideProviders: [
        {
          provide: CloudflareTokenCheck,
          useValue: new CloudflareTokenCheck({ baseUrl: cloudflare.baseUrl, timeoutMs: 1_500 }),
        },
      ],
    });
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente Demo A (token do Cloudflare)');
    tenantB = await createTenant(app, 'Cliente Demo B (token do Cloudflare)');
    adminA = await sessionFor(tenantA, 'admin_cliente');
    adminB = await sessionFor(tenantB, 'admin_cliente');
    sessions.set('admin_cliente', adminA);
    sessions.set('analista_cliente', await sessionFor(tenantA, 'analista_cliente'));
    sessions.set('leitura', await sessionFor(tenantA, 'leitura'));
    const verax = await sessionFor(null, 'admin_verax');
    await write(verax, 'post', '/v1/session/tenant').send({ tenantId: tenantA }).expect(200);
    sessions.set('admin_verax', verax);
  });

  afterAll(async () => {
    // As credenciais deste arquivo saem: a tabela é varrida inteira pela recifragem dos outros testes.
    await prisma.cloudCredential.deleteMany({ where: { keyVersion: KEY_VERSION } });
    await app.close();
    await cloudflare.stop();
  });

  it('cola o token: confere no Cloudflare, guarda só o texto cifrado e os metadados, e nada do token sai', async () => {
    const account = await cloudflareAccount(tenantA);
    const id = fakeCloudflare.tokenId();
    const expiresOn = inDays(90);
    const token = cloudflare.readableAccountToken(account.accountId, { id, expiresOn });

    const response = await put(adminA, account.id, token).expect(200);
    const body = cloudAccountSchema.parse(response.body);
    expect(body).toMatchObject({
      id: account.id,
      connection: 'waiting',
      connectionError: null,
      egressIps: [EGRESS],
      keyStatus: {
        kind: 'cloudflare_api_token',
        keyIdSuffix: id.slice(-4),
        issuedAt: null,
        status: 'active',
      },
    });
    expect(body.keyStatus?.expiresAt).toBe(expiresOn);
    expect(response.text).not.toContain(token);

    // O Cloudflare recebeu o token só no header, no verify da conta e na leitura de prova da auditoria.
    expect(cloudflare.callsWith(token).map((call) => call.path)).toEqual([
      `/accounts/${account.accountId}/tokens/verify`,
      `/accounts/${account.accountId}/logs/audit`,
    ]);

    // No banco, a linha inteira sem o token: o texto cifrado é o envelope da versão da chave, e só o worker o abre.
    const row = await prisma.cloudCredential.findUniqueOrThrow({ where: { cloudAccountId: account.id } });
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row).toMatchObject({
      tenantId: tenantA,
      kind: 'cloudflare_api_token',
      keyVersion: KEY_VERSION,
      keyIdSuffix: id.slice(-4),
      issuedAt: null,
      rotationNoticeAt: null,
    });
    expect(row.ciphertext.startsWith(`v${KEY_VERSION}:`)).toBe(true);
    // A API esqueceu o token no fim da requisição: o logger não o guarda mais. Conferido antes do `open` abaixo, que
    // faz o papel do worker e registra o valor de novo neste processo.
    expect(scrubString(token)).toBe(token);
    const opened = open(keyring, credentialBinding(account, 'cloudflare_api_token'), row.ciphertext);
    expect(opened).toBeInstanceOf(CloudflareToken);
    expect((opened as CloudflareToken).value()).toBe(token);

    // Na trilha, só tipo, sufixo e validade.
    const entry = await entryOf(response);
    expect(entry).toMatchObject({
      action: 'cloud_credential.set',
      resourceType: 'cloud_credential',
      resourceId: account.id,
      tenantId: tenantA,
      outcome: 'success',
      before: null,
      after: {
        kind: 'cloudflare_api_token',
        keyIdSuffix: id.slice(-4),
        expiresAt: row.expiresAt?.toISOString(),
      },
    });
    expect(JSON.stringify(entry)).not.toContain(token);
  });

  it('trocar: o token novo substitui o antigo (uma linha só), com o antes e o depois na trilha', async () => {
    const account = await cloudflareAccount(tenantA);
    const firstId = fakeCloudflare.tokenId();
    const secondId = fakeCloudflare.tokenId();
    await put(adminA, account.id, cloudflare.readableAccountToken(account.accountId, { id: firstId })).expect(
      200,
    );
    const second = cloudflare.readableAccountToken(account.accountId, {
      id: secondId,
      expiresOn: inDays(10),
    });
    const response = await put(adminA, account.id, second).expect(200);
    // Vence em 10 dias: aceito, com o aviso de troca na situação.
    expect(response.body).toMatchObject({
      keyStatus: { keyIdSuffix: secondId.slice(-4), status: 'expiring' },
    });
    expect(await prisma.cloudCredential.count({ where: { cloudAccountId: account.id } })).toBe(1);
    expect(await entryOf(response)).toMatchObject({
      action: 'cloud_credential.rotate',
      before: { kind: 'cloudflare_api_token', keyIdSuffix: firstId.slice(-4), expiresAt: null },
      after: { keyIdSuffix: secondId.slice(-4) },
    });
  });

  it('a lista e o detalhe mostram só os metadados, para todos os papéis; nunca o texto cifrado', async () => {
    const account = await cloudflareAccount(tenantA);
    const id = fakeCloudflare.tokenId();
    await put(adminA, account.id, cloudflare.readableAccountToken(account.accountId, { id })).expect(200);
    const reader = sessions.get('leitura') as TestSession;
    const { ciphertext } = await prisma.cloudCredential.findUniqueOrThrow({
      where: { cloudAccountId: account.id },
    });
    for (const path of [`/v1/cloud-accounts/${account.id}`, '/v1/cloud-accounts?pageSize=100']) {
      const response = await request(app.getHttpServer()).get(path).set('Cookie', reader.cookie).expect(200);
      expect(response.text).toContain(`"keyIdSuffix":"${id.slice(-4)}"`);
      expect(response.text).not.toContain(ciphertext.slice(3, 60));
      expect(response.text).not.toMatch(/ciphertext|keyVersion|"credential"/);
    }
  });

  it('Global API Key e formato inválido: 400 pelo schema, sem chamar o Cloudflare e sem gravar', async () => {
    const account = await cloudflareAccount(tenantA);
    const before = cloudflare.requests.length;
    for (const token of [fakeCloudflare.globalApiKey(), `cfk_${fakeCloudflare.legacyToken()}`]) {
      const response = await put(adminA, account.id, token).expect(400);
      expect(errorOf(response).issues).toEqual([
        { path: 'token', code: 'custom', message: GLOBAL_KEY_REFUSED_MESSAGE },
      ]);
      expect(response.text).not.toContain(token);
    }
    await put(adminA, account.id, `${fakeCloudflare.legacyToken()} `).expect(400);
    expect(cloudflare.requests.length).toBe(before);
    expect(await prisma.cloudCredential.count({ where: { cloudAccountId: account.id } })).toBe(0);
  });

  it('recusas do Cloudflare (inválido, desativado, vencido, ainda não vale, sem a auditoria da conta): 400 genérico', async () => {
    const account = await cloudflareAccount(tenantA);
    const cases: [string, RegExp][] = [
      [fakeCloudflare.accountToken(), /não aceitou o token/],
      [cloudflare.readableAccountToken(account.accountId, { status: 'disabled' }), /desativado/],
      [cloudflare.readableAccountToken(account.accountId, { expiresOn: inDays(-1) }), /venceu/],
      [cloudflare.readableAccountToken(account.accountId, { notBefore: inDays(3) }), /ainda não começou/],
      [
        cloudflare.readableAccountToken(account.accountId, { auditAccounts: [] }),
        /não lê a auditoria desta conta/,
      ],
    ];
    for (const [token, message] of cases) {
      const response = await put(adminA, account.id, token).expect(400);
      expect(errorOf(response).code).toBe('CREDENTIAL_REJECTED');
      expect(errorOf(response).message).toMatch(message);
      // A mensagem do Cloudflare (que repete o token) não chega ao painel.
      expect(response.text).not.toContain(token);
      expect(response.text).not.toMatch(/Invalid API Token|Authentication error/);
      const entry = await entryOf(response);
      expect(entry).toMatchObject({
        action: 'cloud_credential.set',
        outcome: 'failure',
        statusCode: 400,
        resourceId: account.id,
      });
      expect(JSON.stringify(entry)).not.toContain(token);
    }
    expect(await prisma.cloudCredential.count({ where: { cloudAccountId: account.id } })).toBe(0);
  });

  it('Cloudflare fora (5xx, 429 ou sem resposta no tempo): 503, nada gravado e a tentativa não conta no limite', async () => {
    const account = await cloudflareAccount(tenantA);
    for (const overrides of [{ verifyStatus: 502 }, { verifyStatus: 429 }, { hang: true }]) {
      const token = cloudflare.readableAccountToken(account.accountId, overrides);
      const response = await put(adminA, account.id, token).expect(503);
      expect(response.text).not.toContain(token);
      expect(await entryOf(response)).toMatchObject({
        action: 'cloud_credential.set',
        outcome: 'failure',
        statusCode: 503,
      });
    }
    expect(await prisma.cloudCredential.count({ where: { cloudAccountId: account.id } })).toBe(0);
    // Três indisponibilidades não gastam nenhuma das 5 tentativas.
    await put(adminA, account.id, cloudflare.readableAccountToken(account.accountId)).expect(200);
  });

  it('limite por conta: depois de 5 recusas na hora, 429 sem chamar o Cloudflare (as outras contas seguem)', async () => {
    const account = await cloudflareAccount(tenantA);
    for (let attempt = 0; attempt < CREDENTIAL_ATTEMPTS_PER_ACCOUNT; attempt += 1) {
      await put(adminA, account.id, fakeCloudflare.accountToken()).expect(400);
    }
    const valid = cloudflare.readableAccountToken(account.accountId);
    const blocked = await put(adminA, account.id, valid).expect(429);
    expect(blocked.body).toMatchObject({ code: 'CREDENTIAL_ATTEMPTS_EXCEEDED' });
    expect(cloudflare.callsWith(valid)).toEqual([]);
    expect(await entryOf(blocked)).toMatchObject({ outcome: 'failure', statusCode: 429 });

    // Não contam: recusa com mais de uma hora, indisponibilidade, o próprio 429 e a remoção recusada. A trilha só
    // aceita inserção, então o passado entra direto com o horário antigo.
    const other = await cloudflareAccount(tenantA);
    const failure = (occurredAt: Date, statusCode: number, action = 'cloud_credential.set') => ({
      occurredAt,
      actorType: 'user' as const,
      tenantId: tenantA,
      action,
      resourceType: 'cloud_credential',
      resourceId: other.id,
      outcome: 'failure' as const,
      statusCode,
    });
    const anHourAgo = new Date(Date.now() - CREDENTIAL_ATTEMPT_WINDOW_MS - 60_000);
    await prisma.auditLog.createMany({
      data: [
        ...[1, 2, 3, 4, 5].map(() => failure(anHourAgo, 400)),
        ...[1, 2, 3, 4, 5].map(() => failure(new Date(), 503)),
        ...[1, 2, 3, 4, 5].map(() => failure(new Date(), 429)),
        ...[1, 2, 3, 4, 5].map(() => failure(new Date(), 400, 'cloud_credential.remove')),
      ],
    });
    await put(adminA, other.id, cloudflare.readableAccountToken(other.accountId)).expect(200);
  });

  it('limite por cliente: 20 recusas na hora em qualquer conta bloqueiam todas as contas do cliente, não as de outro', async () => {
    const tenantC = await createTenant(app, 'Cliente Demo C (limite)');
    const adminC = await sessionFor(tenantC, 'admin_cliente');
    const accounts = await Promise.all([1, 2, 3, 4, 5].map(() => cloudflareAccount(tenantC)));
    // 4 recusas em cada uma das 5 contas: nenhuma chega ao limite da conta, mas o cliente chega aos 20.
    for (const account of accounts) {
      for (let attempt = 0; attempt < CREDENTIAL_ATTEMPTS_PER_TENANT / accounts.length; attempt += 1) {
        await put(adminC, account.id, fakeCloudflare.accountToken()).expect(400);
      }
    }
    const fresh = await cloudflareAccount(tenantC);
    await put(adminC, fresh.id, cloudflare.readableAccountToken(fresh.accountId)).expect(429);
    // O cliente B não é afetado pelas recusas do C.
    const accountB = await cloudflareAccount(tenantB);
    await put(adminB, accountB.id, cloudflare.readableAccountToken(accountB.accountId)).expect(200);
  });

  it('A/B: o admin de A não grava, não troca e não remove a credencial da conta de B (404), sem chamar o Cloudflare', async () => {
    const accountB = await cloudflareAccount(tenantB);
    const idB = fakeCloudflare.tokenId();
    await put(adminB, accountB.id, cloudflare.readableAccountToken(accountB.accountId, { id: idB })).expect(
      200,
    );
    const rowBefore = await prisma.cloudCredential.findUniqueOrThrow({
      where: { cloudAccountId: accountB.id },
    });

    const token = cloudflare.readableAccountToken(accountB.accountId);
    const attempt = await put(adminA, accountB.id, token).expect(404);
    expect(errorOf(attempt).message).toBe('Conta não encontrada');
    await remove(adminA, accountB.id).expect(404);
    expect(cloudflare.callsWith(token)).toEqual([]);
    expect(
      await prisma.cloudCredential.findUniqueOrThrow({ where: { cloudAccountId: accountB.id } }),
    ).toEqual(rowBefore);
    // A tentativa fica na trilha de A (quem tentou), nunca na de B.
    expect(await entryOf(attempt)).toMatchObject({ tenantId: tenantA, outcome: 'failure', statusCode: 404 });
    const listA = await request(app.getHttpServer())
      .get('/v1/cloud-accounts?pageSize=100')
      .set('Cookie', adminA.cookie)
      .expect(200);
    expect(listA.text).not.toContain(accountB.id);
    expect(listA.text).not.toContain(`"keyIdSuffix":"${idB.slice(-4)}"`);
  });

  it('papéis: só admin_cliente e admin_verax (com o cliente selecionado) colam e removem; analista e leitura, 403', async () => {
    const expected: Record<Role, number> = {
      admin_verax: 200,
      admin_cliente: 200,
      analista_cliente: 403,
      leitura: 403,
    };
    for (const [role, status] of Object.entries(expected) as [Role, number][]) {
      const account = await cloudflareAccount(tenantA);
      const token = cloudflare.readableAccountToken(account.accountId);
      const session = sessions.get(role) as TestSession;
      await put(session, account.id, token).expect(status);
      expect(cloudflare.callsWith(token)).toHaveLength(status === 200 ? 2 : 0);
      if (status === 403) {
        await put(adminA, account.id, cloudflare.readableAccountToken(account.accountId)).expect(200);
      }
      await remove(session, account.id).expect(status === 200 ? 204 : 403);
      expect(await prisma.cloudCredential.count({ where: { cloudAccountId: account.id } })).toBe(
        status === 200 ? 0 : 1,
      );
    }
  });

  it('tipo de outro provedor (token numa conta AWS) e conta inativa: 400, sem chamar o Cloudflare', async () => {
    const aws = await cloudflareAccount(tenantA, 'aws');
    const inactive = await cloudflareAccount(tenantA);
    await prisma.cloudAccount.update({ where: { id: inactive.id }, data: { status: 'inactive' } });
    const before = cloudflare.requests.length;
    const wrongProvider = await put(adminA, aws.id, fakeCloudflare.accountToken()).expect(400);
    expect(errorOf(wrongProvider).message).toMatch(/não vale para esta conta/);
    const inactiveResponse = await put(
      adminA,
      inactive.id,
      cloudflare.readableAccountToken(inactive.accountId),
    ).expect(400);
    expect(errorOf(inactiveResponse).message).toMatch(/Reative a conta/);
    expect(cloudflare.requests.length).toBe(before);
  });

  it('remover: apaga a linha, volta a conexão para aguardando e registra só os metadados; de novo, 404', async () => {
    const account = await cloudflareAccount(tenantA);
    const id = fakeCloudflare.tokenId();
    await put(adminA, account.id, cloudflare.readableAccountToken(account.accountId, { id })).expect(200);
    await prisma.cloudAccount.update({ where: { id: account.id }, data: { connection: 'connected' } });
    const response = await remove(adminA, account.id).expect(204);
    expect(await prisma.cloudCredential.count({ where: { cloudAccountId: account.id } })).toBe(0);
    expect(await entryOf(response)).toMatchObject({
      action: 'cloud_credential.remove',
      before: { kind: 'cloudflare_api_token', keyIdSuffix: id.slice(-4) },
      after: null,
    });
    const detail = await request(app.getHttpServer())
      .get(`/v1/cloud-accounts/${account.id}`)
      .set('Cookie', adminA.cookie)
      .expect(200);
    expect(detail.body).toMatchObject({ keyStatus: null, connection: 'waiting' });
    await remove(adminA, account.id).expect(404);
  });

  it('desativar a conta apaga a credencial na mesma requisição (cloud_credential.wipe); reativada, fica sem', async () => {
    for (const deactivate of [
      (id: string) => write(adminA, 'delete', `/v1/cloud-accounts/${id}`),
      (id: string) => write(adminA, 'patch', `/v1/cloud-accounts/${id}`).send({ status: 'inactive' }),
    ]) {
      const account = await cloudflareAccount(tenantA);
      const id = fakeCloudflare.tokenId();
      await put(adminA, account.id, cloudflare.readableAccountToken(account.accountId, { id })).expect(200);
      const response = await deactivate(account.id);
      expect(response.status).toBeLessThan(300);
      expect(await prisma.cloudCredential.count({ where: { cloudAccountId: account.id } })).toBe(0);
      const entries = await entriesOf(response);
      expect(entries.map((entry) => [entry.action, entry.tenantId])).toEqual([
        [expect.stringMatching(/^cloud_account\.(deactivate|update)$/), tenantA],
        ['cloud_credential.wipe', tenantA],
      ]);
      expect(entries[1]).toMatchObject({ before: { keyIdSuffix: id.slice(-4) }, after: null });
      const reactivated = await write(adminA, 'patch', `/v1/cloud-accounts/${account.id}`)
        .send({ status: 'active' })
        .expect(200);
      expect(reactivated.body).toMatchObject({ status: 'active', keyStatus: null });
    }
  });

  it('log-capture: nenhum token colado no arquivo aparece no log; as recusas têm só os códigos', () => {
    expect(pasted.length).toBeGreaterThan(30);
    for (const token of pasted) expect(capture.text).not.toContain(token);
    expect(capture.text).not.toMatch(/Invalid API Token|Authentication error/);
    const refusals = capture.entries().filter((entry) => entry['msg'] === 'credencial recusada na origem');
    expect(refusals.length).toBeGreaterThan(0);
    for (const entry of refusals) {
      expect(entry['kind']).toBe('cloudflare_api_token');
      expect(typeof entry['reason']).toBe('string');
    }
  });

  it('a trilha inteira dos clientes do arquivo não tem nenhum token colado', async () => {
    const entries = JSON.stringify(
      await prisma.auditLog.findMany({ where: { tenantId: { in: [tenantA, tenantB] } } }),
    );
    for (const token of pasted) expect(entries).not.toContain(token);
    const rows = JSON.stringify(await prisma.cloudCredential.findMany());
    for (const token of pasted) expect(rows).not.toContain(token);
  });
});
