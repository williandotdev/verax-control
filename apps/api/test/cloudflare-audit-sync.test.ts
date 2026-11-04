import 'reflect-metadata';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncLease } from '../src/alerts/finding-store.js';
import {
  CLOUDFLARE_AUDIT_STREAM,
  CLOUDFLARE_CHECK_STREAM,
  CloudflareAuditSync,
  type CloudflareAuditSyncOptions,
} from '../src/cloudflare/cloudflare-audit-sync.js';
import { CloudflareApiError, CloudflareClient } from '../src/cloudflare/cloudflare.client.js';
import { CloudflareTokenCheck } from '../src/cloudflare/cloudflare-token-check.js';
import { RESET_CONNECTION } from '../src/cloud-accounts/cloud-accounts.service.js';
import { buildPinoOptions } from '../src/common/logger/logger.options.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import {
  parsePrivateKeys,
  parsePublicKey,
  type VaultKeyring,
  type VaultPublicKey,
} from '../src/credentials/credential-keys.js';
import { CloudflareToken, credentialBinding, seal } from '../src/credentials/credential-vault.js';
import { Scheduler } from '../src/worker/scheduler.js';
import { entryFactory, hex } from './cloudflare/fixtures.js';
import { createTenant, createUser } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';
import { fakeCloudflare, FakeCloudflareServer } from './support/fake-cloudflare.js';
import { LogCapture } from './support/log-capture.js';

/**
 * Versão da chave do nó neste arquivo: fora das que a recifragem de `cloud-credentials.test.ts` usa como corrente (2 e
 * 3) e da do recebimento (900), para as linhas daqui nunca entrarem na varredura de outro arquivo.
 */
const KEY_VERSION = 901;
const NOW = new Date('2026-11-04T12:00:00.000Z');
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const iso = (minutes: number) => at(minutes).toISOString();
const pem64 = (key: KeyObject, type: 'spki' | 'pkcs8') =>
  Buffer.from(key.export({ type, format: 'pem' })).toString('base64');

interface Account {
  id: string;
  tenantId: string;
  provider: 'cloudflare';
  accountId: string;
}

describe('coletor da auditoria do Cloudflare (banco real e Cloudflare falso)', () => {
  const cloudflare = new FakeCloudflareServer();
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let keyring: VaultKeyring;
  let publicKey: VaultPublicKey;
  let otherPublicKey: VaultPublicKey;
  let run = 0;

  const syncFor = (options: CloudflareAuditSyncOptions = {}) => {
    run += 1;
    return new CloudflareAuditSync(prisma, keyring, {
      name: `cf-teste-${run}`,
      client: new CloudflareClient({ baseUrl: cloudflare.baseUrl, timeoutMs: 300, retryDelaysMs: [10, 10] }),
      tokenCheck: new CloudflareTokenCheck({ baseUrl: cloudflare.baseUrl, timeoutMs: 2_000 }),
      tenantIds: [tenantA, tenantB],
      pageSize: 2,
      maxPages: 3,
      ...options,
    });
  };

  async function newAccount(
    tenantId: string,
    { zones = [], status = 'active' }: { zones?: string[]; status?: 'active' | 'inactive' } = {},
  ): Promise<Account> {
    const account = await prisma.forTenant(tenantId).cloudAccount.create({
      data: {
        tenantId,
        provider: 'cloudflare',
        accountId: fakeCloudflare.accountId(),
        regions: [],
        zones,
        status,
      },
      select: { id: true, tenantId: true, accountId: true },
    });
    return { ...account, provider: 'cloudflare' };
  }

  /** Guarda o token como o painel guarda (cifrado com a pública do nó), e devolve o texto cifrado. */
  async function store(
    account: Account,
    value: string,
    { expiresAt = null as Date | null, key = publicKey } = {},
  ) {
    const sealed = seal(key, credentialBinding(account, 'cloudflare_api_token'), new CloudflareToken(value));
    const data = {
      kind: 'cloudflare_api_token' as const,
      ciphertext: sealed.ciphertext,
      keyVersion: sealed.keyVersion,
      keyIdSuffix: 'c0de',
      expiresAt,
      verifiedAt: at(-60),
    };
    await prisma.forTenant(account.tenantId).cloudCredential.upsert({
      where: { cloudAccountId: account.id },
      create: { cloudAccountId: account.id, tenantId: account.tenantId, ...data },
      update: data,
    });
    return sealed.ciphertext;
  }

  /** Uma conta com token que lê a própria auditoria, sem a conferência de hora em hora (só a auditoria). */
  async function readyAccount(tenantId: string, options: { zones?: string[]; check?: boolean } = {}) {
    const account = await newAccount(tenantId, options);
    const value = cloudflare.readableAccountToken(account.accountId);
    await store(account, value);
    if (options.check !== true) {
      await prisma.collectorCursor.create({
        data: {
          cloudAccountId: account.id,
          stream: CLOUDFLARE_CHECK_STREAM,
          nextRunAt: new Date('2100-01-01'),
        },
      });
    }
    return { account, value, entry: entryFactory(account.accountId) };
  }

  const accountRow = (id: string) =>
    prisma.cloudAccount.findUniqueOrThrow({
      where: { id },
      select: { connection: true, connectionError: true, lastCollectedAt: true, lastEventAt: true },
    });
  const cursorOf = (cloudAccountId: string, stream = CLOUDFLARE_AUDIT_STREAM) =>
    prisma.collectorCursor.findUniqueOrThrow({
      where: { cloudAccountId_stream_region: { cloudAccountId, stream, region: '' } },
    });
  const findingsOf = (accountId: string) =>
    prisma.finding.findMany({ where: { source: 'cloudflare', accountId }, orderBy: { occurredAt: 'asc' } });
  /** Pedidos feitos com o token, de qualquer tipo (verify, auditoria, zonas). */
  const callsWith = (value: string) => cloudflare.callsWith(value).length;

  beforeAll(async () => {
    await cloudflare.start();
    app = await createApp();
    prisma = app.get(PrismaService);
    const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const other = generateKeyPairSync('rsa', { modulusLength: 3072 });
    keyring = parsePrivateKeys(`${KEY_VERSION}:${pem64(pair.privateKey, 'pkcs8')}`, KEY_VERSION);
    publicKey = parsePublicKey(pem64(pair.publicKey, 'spki'), KEY_VERSION);
    otherPublicKey = parsePublicKey(pem64(other.publicKey, 'spki'), KEY_VERSION);
  });

  // Clientes novos a cada teste: as execuções do coletor ficam restritas a eles (`tenantIds`), e as contas de um teste
  // (com o cursor, a conexão e as respostas roteirizadas do Cloudflare falso) nunca entram na execução de outro.
  beforeEach(async () => {
    tenantA = await createTenant(app, 'Cliente Demo A (Cloudflare)');
    tenantB = await createTenant(app, 'Cliente Demo B (Cloudflare)');
  });

  afterAll(async () => {
    await prisma.cloudCredential.deleteMany({ where: { keyVersion: KEY_VERSION } });
    await app.close();
    await cloudflare.stop();
  });

  it('lê as páginas da janela, valida cada entrada, grava os achados do cliente e conecta a conta', async () => {
    const { account, value, entry } = await readyAccount(tenantA, { check: true });
    const tokenId = hex(16);
    cloudflare.addAudit(
      account.accountId,
      {
        at: iso(-50),
        entry: entry({ id: 'zona-apagada', time: iso(-50), method: 'DELETE', uri: `/zones/${hex(16)}` }),
      },
      {
        at: iso(-40),
        entry: entry({
          id: 'membro',
          time: iso(-40),
          method: 'POST',
          uri: `/accounts/${account.accountId}/members`,
          zone: null,
          actor: {
            email: null,
            token_name: 'automacao',
            token_id: tokenId,
            context: 'api_token',
            type: 'account',
          },
        }),
      },
      // Fora do formato (sem horário): vai para a fila sem dono, e as seguintes seguem.
      { at: iso(-35), entry: { id: 'sem-horario', action: { type: 'create' } } },
      {
        at: iso(-30),
        entry: entry({ id: 'leitura', time: iso(-30), method: 'GET', uri: `/zones/${hex(16)}/dns_records` }),
      },
      {
        at: iso(-20),
        entry: entry({
          id: 'dns',
          time: iso(-20),
          method: 'POST',
          uri: `/zones/${hex(16)}/dns_records`,
          request: { type: 'A', name: 'www', content: '192.0.2.10' },
        }),
      },
    );

    const report = await syncFor().runOnce(NOW);
    expect(report).toMatchObject({
      status: 'done',
      accounts: 1,
      pages: 3,
      read: 5,
      created: 3,
      invalid: 1,
      ignored: 1,
      unowned: 0,
      duplicates: 0,
      failedAccounts: 0,
      blocked: 0,
    });

    // A janela da primeira leitura: 7 dias até um minuto antes de agora.
    const reads = cloudflare.auditReads(value);
    expect(reads).toHaveLength(3);
    expect(reads[0]?.query.get('since')).toBe('2026-10-28T12:00:00Z');
    expect(reads[0]?.query.get('before')).toBe('2026-11-04T11:59:00Z');
    expect(reads[0]?.query.get('limit')).toBe('2');
    expect(reads.slice(1).every((read) => read.query.get('cursor'))).toBe(true);

    const findings = await findingsOf(account.accountId);
    expect(findings.map((finding) => [finding.ruleId, finding.severity])).toEqual([
      ['990306', 'critical'],
      ['990312', 'medium'],
      ['990309', 'low'],
    ]);
    expect(findings[1]).toMatchObject({
      tenantId: tenantA,
      source: 'cloudflare',
      sourceEventId: `cf/${account.accountId}/membro`,
      logSource: 'cloudflare_audit',
      actorUser: 'automacao',
      actorType: 'account',
      accessKeyId: tokenId,
      sourceIp: '203.0.113.10',
      rawEventId: null,
      status: 'new',
    });
    expect(findings[0]?.incidentId).not.toBeNull();

    const invalid = await prisma.unownedAlert.findUniqueOrThrow({
      where: {
        source_sourceEventId: { source: 'cloudflare', sourceEventId: `cf/${account.accountId}/sem-horario` },
      },
    });
    expect(invalid.reason).toBe('invalid_alert');

    expect(await accountRow(account.id)).toEqual({
      connection: 'connected',
      connectionError: null,
      lastCollectedAt: NOW,
      lastEventAt: at(-20),
    });
    const cursor = await cursorOf(account.id);
    expect(cursor).toMatchObject({ cursorAt: at(-1), continuation: null, nextRunAt: at(5), failures: 0 });
    // A conferência de hora em hora rodou: a última conferência do token é a desta execução.
    expect((await cursorOf(account.id, CLOUDFLARE_CHECK_STREAM)).nextRunAt).toEqual(at(60));
    const credential = await prisma.cloudCredential.findUniqueOrThrow({
      where: { cloudAccountId: account.id },
    });
    expect(credential.verifiedAt).toEqual(NOW);

    const usage = await prisma.ingestUsage.findMany({ where: { tenantId: tenantA, source: 'cloudflare' } });
    expect(usage).toHaveLength(1);
    expect(usage[0]?.events).toBe(5n);
    expect(usage[0]?.bytes).toBeGreaterThan(0n);
  });

  it('teto de páginas: grava a continuação, segue dela na execução seguinte e a releitura não duplica', async () => {
    const { account, value, entry } = await readyAccount(tenantA);
    const uri = `/accounts/${account.accountId}/members`;
    cloudflare.addAudit(
      account.accountId,
      ...Array.from({ length: 7 }, (_, index) => ({
        at: iso(-30 + index),
        entry: entry({ id: `convite-${index}`, time: iso(-30 + index), method: 'POST', uri, zone: null }),
      })),
    );

    const first = await syncFor({ maxPages: 2 }).runOnce(NOW);
    expect(first).toMatchObject({ pages: 2, read: 4, created: 4 });
    const cut = await cursorOf(account.id);
    expect(cut.continuation).not.toBeNull();
    // Cortada no teto: o cursor fica no evento mais recente lido, e a próxima leitura é já.
    expect(cut.cursorAt).toEqual(at(-27));
    expect(cut.nextRunAt).toEqual(NOW);
    const firstWindow = cloudflare.auditReads(value)[0];

    const second = await syncFor({ maxPages: 2 }).runOnce(at(1));
    expect(second).toMatchObject({ pages: 2, read: 3, created: 3, duplicates: 0 });
    const resumed = cloudflare.auditReads(value)[2];
    // Seguiu da continuação: a mesma janela, com o cursor do Cloudflare, sem reler do começo.
    expect(resumed?.query.get('since')).toBe(firstWindow?.query.get('since'));
    expect(resumed?.query.get('before')).toBe(firstWindow?.query.get('before'));
    expect(resumed?.query.get('cursor')).toBeTruthy();
    const done = await cursorOf(account.id);
    expect(done).toMatchObject({ continuation: null, cursorAt: at(-1), nextRunAt: at(6) });

    // A janela seguinte relê os 10 minutos de sobreposição: nada é gravado de novo.
    const third = await syncFor({ maxPages: 2 }).runOnce(at(30));
    expect(cloudflare.auditReads(value).at(-1)?.query.get('since')).toBe('2026-11-04T11:49:00Z');
    expect(third).toMatchObject({ created: 0 });
    // Uma leitura forçada da janela inteira de novo: só duplicados.
    await prisma.collectorCursor.update({
      where: { id: done.id },
      data: { cursorAt: at(-60), nextRunAt: at(30) },
    });
    const reread = await syncFor({ maxPages: 5 }).runOnce(at(31));
    expect(reread).toMatchObject({ read: 7, created: 0, duplicates: 7 });
    expect(await findingsOf(account.accountId)).toHaveLength(7);
  });

  it('continuação vencida (400): recomeça a janela pelo cursor da conta, na mesma execução', async () => {
    const { account, value, entry } = await readyAccount(tenantA);
    cloudflare.addAudit(
      account.accountId,
      ...Array.from({ length: 5 }, (_, index) => ({
        at: iso(-20 + index),
        entry: entry({
          id: `dns-${index}`,
          time: iso(-20 + index),
          method: 'DELETE',
          uri: `/zones/${hex(16)}/dns_records/${hex(16)}`,
        }),
      })),
    );
    await syncFor({ maxPages: 1 }).runOnce(NOW);
    const cut = await cursorOf(account.id);
    const saved = JSON.parse(cut.continuation ?? '{}') as { c: string };
    cloudflare.expiredCursors.add(saved.c);
    const report = await syncFor({ maxPages: 5 }).runOnce(at(1));
    expect(report).toMatchObject({ failedAccounts: 0, created: 3 });
    const reads = cloudflare.auditReads(value);
    // Depois do 400, a janela nova parte do cursor gravado menos a sobreposição, sem cursor do Cloudflare.
    const restarted = reads.find((read, index) => index > 1 && !read.query.has('cursor'));
    expect(restarted?.query.get('since')).toBe('2026-11-04T11:31:00Z');
    expect(await findingsOf(account.accountId)).toHaveLength(5);
  });

  it('401: erro de token no cartão, nenhuma nova tentativa, e a coleta só volta com outro token', async () => {
    const { account, value, entry } = await readyAccount(tenantA);
    cloudflare.addAudit(account.accountId, {
      at: iso(-10),
      entry: entry({ id: 'depois', time: iso(-10), method: 'DELETE', uri: `/zones/${hex(16)}` }),
    });
    cloudflare.auditScript.push({ status: 401 });
    const first = await syncFor().runOnce(NOW);
    expect(first).toMatchObject({ failedAccounts: 1, created: 0 });
    expect(cloudflare.auditReads(value)).toHaveLength(1);
    expect(await accountRow(account.id)).toMatchObject({
      connection: 'error',
      connectionError: 'credential_rejected',
    });

    // Execuções seguintes, mesmo com o cursor na hora: nenhuma chamada com o token recusado.
    const calls = callsWith(value);
    for (const minutes of [6, 30, 120]) {
      const report = await syncFor().runOnce(at(minutes));
      expect(report).toMatchObject({ blocked: 1, pages: 0 });
    }
    expect(callsWith(value)).toBe(calls);

    // Um admin cola outro token: a conexão recomeça (como o PUT da credencial faz), e a coleta volta sozinha.
    const replacement = cloudflare.readableAccountToken(account.accountId);
    await store(account, replacement);
    await prisma
      .forTenant(tenantA)
      .cloudAccount.update({ where: { id: account.id }, data: RESET_CONNECTION });
    const resumed = await syncFor().runOnce(at(130));
    expect(resumed).toMatchObject({ blocked: 0, created: 1 });
    expect(await accountRow(account.id)).toMatchObject({ connection: 'connected', connectionError: null });
    expect(callsWith(value)).toBe(calls);
  });

  it('token trocado no painel durante a leitura: a recusa do token antigo não para a coleta do novo', async () => {
    const { account } = await readyAccount(tenantA);
    const replacement = cloudflare.readableAccountToken(account.accountId);
    /** O Cloudflare recusa o token antigo no mesmo instante em que um admin cola o novo (o PUT da credencial). */
    class SwappingClient extends CloudflareClient {
      override async auditPage(): Promise<never> {
        await store(account, replacement);
        await prisma
          .forTenant(tenantA)
          .cloudAccount.update({ where: { id: account.id }, data: RESET_CONNECTION });
        throw new CloudflareApiError('credential_rejected', 401);
      }
    }
    const report = await syncFor({ client: new SwappingClient({ baseUrl: cloudflare.baseUrl }) }).runOnce(
      NOW,
    );
    expect(report.failedAccounts).toBe(1);
    expect(await accountRow(account.id)).toMatchObject({ connection: 'waiting', connectionError: null });
    // A execução seguinte lê com o token novo.
    await prisma.collectorCursor.updateMany({
      where: { cloudAccountId: account.id, stream: CLOUDFLARE_AUDIT_STREAM },
      data: { nextRunAt: NOW },
    });
    expect(await syncFor().runOnce(at(1))).toMatchObject({ blocked: 0, failedAccounts: 0 });
    expect(cloudflare.auditReads(replacement)).toHaveLength(1);
    expect(await accountRow(account.id)).toMatchObject({ connection: 'connected' });
  });

  it('403 (sem acesso à auditoria desta conta) e token vencido também param a coleta, sem chamada a mais', async () => {
    const forbidden = await readyAccount(tenantA);
    cloudflare.auditScript.push({ status: 403 });
    await syncFor().runOnce(NOW);
    expect(await accountRow(forbidden.account.id)).toMatchObject({ connectionError: 'credential_forbidden' });
    expect(cloudflare.auditReads(forbidden.value)).toHaveLength(1);
    expect(await cursorOf(forbidden.account.id)).toMatchObject({
      lastErrorKind: 'credential_forbidden',
      failures: 1,
    });

    const expired = await newAccount(tenantA);
    const value = cloudflare.readableAccountToken(expired.accountId);
    await store(expired, value, { expiresAt: at(-1) });
    const report = await syncFor().runOnce(at(10));
    expect(report.blocked).toBeGreaterThanOrEqual(2);
    expect(callsWith(value)).toBe(0);
    expect(await accountRow(expired.id)).toMatchObject({
      connection: 'error',
      connectionError: 'credential_expired',
    });
  });

  it('429: respeita o retry-after, sem novas tentativas; volta depois da espera', async () => {
    const { account, value, entry } = await readyAccount(tenantA);
    cloudflare.addAudit(account.accountId, {
      at: iso(-5),
      entry: entry({
        id: 'tunel',
        time: iso(-5),
        method: 'POST',
        uri: `/accounts/${account.accountId}/cfd_tunnel`,
        zone: null,
      }),
    });
    cloudflare.auditScript.push({ status: 429, headers: { 'retry-after': '120' } });
    const limited = await syncFor().runOnce(NOW);
    expect(limited.failedAccounts).toBe(1);
    expect(cloudflare.auditReads(value)).toHaveLength(1);
    expect(await cursorOf(account.id)).toMatchObject({ lastErrorKind: 'rate_limited', nextRunAt: at(2) });
    expect(await accountRow(account.id)).toMatchObject({
      connection: 'error',
      connectionError: 'rate_limited',
    });

    const waiting = await syncFor().runOnce(at(1));
    expect(waiting).toMatchObject({ notDue: 1, pages: 0 });
    expect(cloudflare.auditReads(value)).toHaveLength(1);

    const back = await syncFor().runOnce(at(2));
    expect(back).toMatchObject({ created: 1, failedAccounts: 0 });
    expect(await accountRow(account.id)).toMatchObject({ connection: 'connected', connectionError: null });
  });

  it('tempo esgotado: três tentativas, erro "timeout" e recuo de 1 minuto; a leitura seguinte reconecta', async () => {
    const { account, value } = await readyAccount(tenantA);
    cloudflare.auditScript.push(
      { status: 0, hang: true },
      { status: 0, hang: true },
      { status: 0, hang: true },
    );
    const report = await syncFor().runOnce(NOW);
    expect(report.failedAccounts).toBe(1);
    expect(cloudflare.auditReads(value)).toHaveLength(3);
    expect(await cursorOf(account.id)).toMatchObject({
      lastErrorKind: 'timeout',
      failures: 1,
      nextRunAt: at(1),
    });
    expect(await accountRow(account.id)).toMatchObject({ connection: 'error', connectionError: 'timeout' });

    await syncFor().runOnce(at(1));
    expect(await accountRow(account.id)).toMatchObject({ connection: 'connected', connectionError: null });
    expect(await cursorOf(account.id)).toMatchObject({ failures: 0, lastErrorKind: null });
  });

  it('A/B: cada conta com o próprio token; entrada de outra conta vai para a fila sem dono, nunca para o outro cliente', async () => {
    const a = await readyAccount(tenantA);
    const b = await readyAccount(tenantB);
    cloudflare.addAudit(
      a.account.accountId,
      {
        at: iso(-9),
        entry: a.entry({ id: 'a-1', time: iso(-9), method: 'DELETE', uri: `/zones/${hex(16)}` }),
      },
      // Uma entrada que diz ser da conta do B, vinda da leitura da conta do A.
      {
        at: iso(-8),
        entry: entryFactory(b.account.accountId)({
          id: 'disfarce',
          time: iso(-8),
          method: 'DELETE',
          uri: `/zones/${hex(16)}`,
        }),
      },
    );
    cloudflare.addAudit(b.account.accountId, {
      at: iso(-7),
      entry: b.entry({
        id: 'b-1',
        time: iso(-7),
        method: 'POST',
        uri: `/accounts/${b.account.accountId}/members`,
        zone: null,
      }),
    });

    const report = await syncFor().runOnce(NOW);
    expect(report).toMatchObject({ unowned: 1 });
    const findingsA = await findingsOf(a.account.accountId);
    const findingsB = await findingsOf(b.account.accountId);
    expect(findingsA.map((finding) => [finding.tenantId, finding.sourceEventId])).toEqual([
      [tenantA, `cf/${a.account.accountId}/a-1`],
    ]);
    expect(findingsB.map((finding) => [finding.tenantId, finding.sourceEventId])).toEqual([
      [tenantB, `cf/${b.account.accountId}/b-1`],
    ]);
    // O cliente B não vê nada do A pelo escopo dele.
    expect(await prisma.forTenant(tenantB).finding.count({ where: { accountId: a.account.accountId } })).toBe(
      0,
    );
    const unowned = await prisma.unownedAlert.findUniqueOrThrow({
      where: {
        source_sourceEventId: { source: 'cloudflare', sourceEventId: `cf/${a.account.accountId}/disfarce` },
      },
    });
    expect(unowned).toMatchObject({
      reason: 'source_mismatch',
      accounts: [b.account.accountId],
      ruleId: '990306',
    });
    // Cada token só foi à conta dele.
    expect(cloudflare.callsWith(a.value).every((call) => call.path.includes(a.account.accountId))).toBe(true);
    expect(cloudflare.callsWith(b.value).every((call) => call.path.includes(b.account.accountId))).toBe(true);
  });

  it('exceção do cliente por IP e por usuário: o achado nasce legítimo e conta o uso', async () => {
    const { account, entry } = await readyAccount(tenantA);
    const creator = (await createUser(app, { role: 'admin_cliente', tenantId: tenantA })).id;
    const byUser = await prisma.alertException.create({
      data: {
        tenantId: tenantA,
        ruleId: '990312',
        field: 'user',
        value: 'rh@exemplo.com.br',
        reason: 'Convites do RH',
        createdById: creator,
      },
    });
    const byIp = await prisma.alertException.create({
      data: {
        tenantId: tenantA,
        ruleId: '990317',
        field: 'ip',
        value: '198.51.100.0/24',
        reason: 'Deploy do CI',
        createdById: creator,
      },
    });
    cloudflare.addAudit(
      account.accountId,
      {
        at: iso(-6),
        entry: entry({
          id: 'convite-rh',
          time: iso(-6),
          method: 'POST',
          uri: `/accounts/${account.accountId}/members`,
          zone: null,
          actor: { email: 'rh@exemplo.com.br' },
        }),
      },
      {
        at: iso(-5),
        entry: entry({
          id: 'deploy',
          time: iso(-5),
          method: 'PUT',
          uri: `/accounts/${account.accountId}/workers/scripts/site`,
          zone: null,
          actor: { ip_address: '198.51.100.20' },
        }),
      },
    );
    const report = await syncFor().runOnce(NOW);
    expect(report).toMatchObject({ created: 2, excepted: 2 });
    const findings = await findingsOf(account.accountId);
    expect(findings.map((finding) => [finding.status, finding.exceptionId])).toEqual([
      ['legitimate', byUser.id],
      ['legitimate', byIp.id],
    ]);
    expect(await prisma.alertException.findUniqueOrThrow({ where: { id: byIp.id } })).toMatchObject({
      matchedCount: 1,
    });
  });

  it('conta inativa, conta sem token e token que não abre: nenhuma chamada ao Cloudflare', async () => {
    const inactive = await newAccount(tenantA, { status: 'inactive' });
    const inactiveToken = cloudflare.readableAccountToken(inactive.accountId);
    await store(inactive, inactiveToken);
    const withoutToken = await newAccount(tenantA);
    const unreadable = await newAccount(tenantA);
    const unreadableToken = cloudflare.readableAccountToken(unreadable.accountId);
    // Cifrado com outra chave da mesma versão (texto adulterado ou chave trocada): não abre no worker.
    await store(unreadable, unreadableToken, { key: otherPublicKey });

    const report = await syncFor().runOnce(NOW);
    expect(report.unreadable).toBe(1);
    expect(callsWith(inactiveToken)).toBe(0);
    expect(callsWith(unreadableToken)).toBe(0);
    expect(cloudflare.requests.some((request) => request.path.includes(withoutToken.accountId))).toBe(false);
    expect(await prisma.collectorCursor.count({ where: { cloudAccountId: withoutToken.id } })).toBe(0);
    expect(await prisma.collectorCursor.count({ where: { cloudAccountId: inactive.id } })).toBe(0);
    expect(await accountRow(unreadable.id)).toMatchObject({
      connection: 'error',
      connectionError: 'credential_unreadable',
    });
    expect(await accountRow(inactive.id)).toMatchObject({ connection: 'waiting' });
  });

  it('concessão: com outro worker na fonte, a execução não faz nada', async () => {
    const { value } = await readyAccount(tenantA);
    const name = `cf-concessao-${run}`;
    const other = new SyncLease(prisma, name, 'outro-worker', 60_000);
    expect(await other.acquire(new Date())).toBe(true);
    const report = await syncFor({ name }).runOnce(new Date());
    expect(report.status).toBe('locked');
    expect(callsWith(value)).toBe(0);
    await other.release();
  });

  it('zonas: a lista cadastrada filtra a auditoria; zona que não existe na conta deixa a conexão em erro', async () => {
    const zones = ['loja.exemplo.com.br', 'blog.exemplo.com.br'];
    const { account, value, entry } = await readyAccount(tenantA, { zones, check: true });
    cloudflare.zones.set(account.accountId, ['loja.exemplo.com.br', 'outra.exemplo.com.br']);
    cloudflare.addAudit(
      account.accountId,
      {
        at: iso(-4),
        entry: entry({
          id: 'fora',
          time: iso(-4),
          method: 'DELETE',
          uri: `/zones/${hex(16)}`,
          zone: { id: hex(16), name: 'outra.exemplo.com.br' },
        }),
      },
      {
        at: iso(-3),
        entry: entry({
          id: 'dentro',
          time: iso(-3),
          method: 'DELETE',
          uri: `/zones/${hex(16)}`,
          zone: { id: hex(16), name: 'loja.exemplo.com.br' },
        }),
      },
    );
    const report = await syncFor().runOnce(NOW);
    expect(report).toMatchObject({ outOfScope: 1, created: 1 });
    expect((await findingsOf(account.accountId)).map((finding) => finding.resource)).toEqual([
      'loja.exemplo.com.br',
    ]);
    // A auditoria foi lida, mas a zona "blog" não existe na conta: erro na conexão, com a coleta registrada.
    expect(await accountRow(account.id)).toMatchObject({
      connection: 'error',
      connectionError: 'zone_not_found',
      lastCollectedAt: NOW,
    });
    expect(callsWith(value)).toBeGreaterThan(0);
    // A auditoria seguinte (antes da próxima conferência) mantém o erro das zonas.
    await syncFor().runOnce(at(6));
    expect(await accountRow(account.id)).toMatchObject({ connectionError: 'zone_not_found' });

    // A zona passa a existir: a conferência seguinte limpa o erro.
    cloudflare.zones.set(account.accountId, zones);
    await syncFor().runOnce(at(61));
    expect(await accountRow(account.id)).toMatchObject({ connection: 'connected', connectionError: null });
  });

  it('conferência de hora em hora: token sem Zone Read avisa sem parar; token desativado para a coleta', async () => {
    const noZones = await newAccount(tenantB, { zones: ['loja.exemplo.com.br'] });
    const noZonesToken = cloudflare.readableAccountToken(noZones.accountId, { zoneRead: false });
    await store(noZones, noZonesToken);
    await syncFor().runOnce(NOW);
    expect(await accountRow(noZones.id)).toMatchObject({
      connection: 'error',
      connectionError: 'zones_forbidden',
    });
    expect(cloudflare.auditReads(noZonesToken)).toHaveLength(1);

    const disabled = await newAccount(tenantB);
    const disabledToken = cloudflare.readableAccountToken(disabled.accountId, {
      status: 'disabled',
      expiresOn: iso(60 * 24 * 30),
    });
    await store(disabled, disabledToken);
    await syncFor().runOnce(NOW);
    expect(await accountRow(disabled.id)).toMatchObject({
      connection: 'error',
      connectionError: 'credential_disabled',
    });
    expect(cloudflare.auditReads(disabledToken)).toHaveLength(0);
  });

  it('a validade vinda do verify atualiza o token guardado (o cartão mostra a nova)', async () => {
    const account = await newAccount(tenantB);
    const value = cloudflare.readableAccountToken(account.accountId, { expiresOn: iso(60 * 24 * 40) });
    await store(account, value, { expiresAt: at(60 * 24 * 10) });
    await syncFor().runOnce(NOW);
    const credential = await prisma.cloudCredential.findUniqueOrThrow({
      where: { cloudAccountId: account.id },
    });
    expect(credential).toMatchObject({ expiresAt: at(60 * 24 * 40), verifiedAt: NOW });
  });

  it('log do worker: o token nunca aparece, nem quando a origem o repete nas mensagens de erro', async () => {
    const { account, value, entry } = await readyAccount(tenantA, { check: true });
    cloudflare.addAudit(account.accountId, {
      at: iso(-2),
      entry: entry({ id: 'zona', time: iso(-2), method: 'DELETE', uri: `/zones/${hex(16)}` }),
    });
    // Respostas de erro com o token no corpo (o fake repete o Bearer recebido) e um 5xx antes do sucesso.
    cloudflare.auditScript.push({ status: 500 });
    const capture = new LogCapture();
    const logger = pino(buildPinoOptions({ LOG_LEVEL: 'trace' }), capture);
    const sync = syncFor();
    const scheduler = new Scheduler(
      [
        {
          name: 'cloudflare',
          intervalMs: 60_000,
          budgetMs: 60_000,
          run: (signal) => sync.runOnce(NOW, signal),
        },
      ],
      logger,
    );
    scheduler.start();
    await vi.waitFor(() => expect(capture.text).toContain('tarefa concluída'), { timeout: 20_000 });
    await scheduler.stop();
    expect(capture.text).not.toContain(value);
    expect(capture.text).not.toContain('Bearer');
    const [line] = capture.entries().filter((logged) => logged['task'] === 'cloudflare');
    expect(line?.['report']).toMatchObject({ created: 1 });
    expect(JSON.stringify(line?.['report'])).not.toContain('REDACTED');

    // E a falha também: 403 com o token no corpo vira só o código.
    const tenantC = await createTenant(app, 'Cliente Demo C (Cloudflare)');
    const failing = await readyAccount(tenantC);
    cloudflare.auditScript.push({ status: 403 });
    const failCapture = new LogCapture();
    const failScheduler = new Scheduler(
      [
        {
          name: 'cloudflare',
          intervalMs: 60_000,
          budgetMs: 60_000,
          run: (signal) => syncFor({ tenantIds: [tenantC] }).runOnce(at(10), signal),
        },
      ],
      pino(buildPinoOptions({ LOG_LEVEL: 'trace' }), failCapture),
    );
    failScheduler.start();
    await vi.waitFor(() => expect(failCapture.text).toContain('tarefa concluída'), { timeout: 20_000 });
    await failScheduler.stop();
    expect(failCapture.text).not.toContain(failing.value);
    expect(await accountRow(failing.account.id)).toMatchObject({ connectionError: 'credential_forbidden' });
  });
});
