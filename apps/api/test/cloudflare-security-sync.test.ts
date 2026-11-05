import 'reflect-metadata';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLOUDFLARE_AUDIT_STREAM,
  CLOUDFLARE_CHECK_STREAM,
  CLOUDFLARE_SECURITY_STREAM,
  CloudflareAuditSync,
  type CloudflareAuditSyncOptions,
} from '../src/cloudflare/cloudflare-audit-sync.js';
import { CloudflareClient } from '../src/cloudflare/cloudflare.client.js';
import type { CloudflareSecurityEventsOptions } from '../src/cloudflare/cloudflare-security-sync.js';
import { CloudflareTokenCheck } from '../src/cloudflare/cloudflare-token-check.js';
import { decodeState, securityEventId } from '../src/cloudflare/security-events.js';
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
import type { Prisma } from '../src/generated/prisma/client.js';
import { IncidentGrouping } from '../src/incidents/incident-grouping.js';
import { Scheduler } from '../src/worker/scheduler.js';
import { entryFactory, hex } from './cloudflare/fixtures.js';
import { createTenant, createUser } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';
import {
  DEFAULT_ZONE_LIMITS,
  fakeCloudflare,
  FakeCloudflareServer,
  type FakeSecurityEvent,
} from './support/fake-cloudflare.js';
import { LogCapture } from './support/log-capture.js';

/** Versão da chave do nó neste arquivo: fora das de outros arquivos (2, 3, 900 e 901). */
const KEY_VERSION = 902;
/** 12:20 UTC: a última janela que dá para ler é a de 12:00 a 12:15 (fechada há 5 min). */
const NOW = new Date('2026-11-04T12:20:00.000Z');
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const iso = (minutes: number) => at(minutes).toISOString();
const FAR = new Date('2100-01-01T00:00:00.000Z');
const pem64 = (key: KeyObject, type: 'spki' | 'pkcs8') =>
  Buffer.from(key.export({ type, format: 'pem' })).toString('base64');

interface Account {
  id: string;
  tenantId: string;
  provider: 'cloudflare';
  accountId: string;
}

/** Eventos de um IP num minuto (a contagem agregada). */
const events = (minutes: number, event: Omit<FakeSecurityEvent, 'at'>): FakeSecurityEvent => ({
  at: iso(minutes),
  ...event,
});

describe('eventos de segurança do Cloudflare (banco real e GraphQL falso)', () => {
  const cloudflare = new FakeCloudflareServer();
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let keyring: VaultKeyring;
  let publicKey: VaultPublicKey;
  let run = 0;

  const syncFor = (
    options: CloudflareAuditSyncOptions = {},
    security: CloudflareSecurityEventsOptions = {},
  ) => {
    run += 1;
    return new CloudflareAuditSync(prisma, keyring, {
      name: `cf-sec-teste-${run}`,
      client: new CloudflareClient({ baseUrl: cloudflare.baseUrl, timeoutMs: 300, retryDelaysMs: [10, 10] }),
      tokenCheck: new CloudflareTokenCheck({ baseUrl: cloudflare.baseUrl, timeoutMs: 2_000 }),
      tenantIds: [tenantA, tenantB],
      pageSize: 50,
      maxPages: 3,
      // A primeira leitura de 1 h: as janelas de 11:15, 11:30, 11:45 e 12:00.
      securityEvents: { firstReadMs: 60 * 60_000, ...security },
      ...options,
    });
  };

  async function newAccount(tenantId: string, zones: string[] = []): Promise<Account> {
    const account = await prisma.forTenant(tenantId).cloudAccount.create({
      data: { tenantId, provider: 'cloudflare', accountId: fakeCloudflare.accountId(), regions: [], zones },
      select: { id: true, tenantId: true, accountId: true },
    });
    return { ...account, provider: 'cloudflare' };
  }

  async function store(account: Account, value: string): Promise<void> {
    const sealed = seal(
      publicKey,
      credentialBinding(account, 'cloudflare_api_token'),
      new CloudflareToken(value),
    );
    await prisma.forTenant(account.tenantId).cloudCredential.create({
      data: {
        cloudAccountId: account.id,
        tenantId: account.tenantId,
        kind: 'cloudflare_api_token',
        ciphertext: sealed.ciphertext,
        keyVersion: sealed.keyVersion,
        keyIdSuffix: 'c0de',
        verifiedAt: at(-60),
      },
    });
  }

  /**
   * Conta com token e zonas no Cloudflare falso. Por padrão, só os eventos de segurança rodam (a auditoria e a
   * conferência ficam para 2100); `audit: true` deixa a auditoria na hora também.
   */
  async function readyAccount(
    tenantId: string,
    {
      zones = ['loja.exemplo.com.br'],
      audit = false,
      token = {},
      limits = {},
    }: {
      zones?: string[];
      audit?: boolean;
      token?: Parameters<FakeCloudflareServer['readableAccountToken']>[1];
      limits?: Record<string, Partial<typeof DEFAULT_ZONE_LIMITS> | null>;
    } = {},
  ) {
    const account = await newAccount(tenantId);
    const tags = zones.map((name) =>
      cloudflare.addSecurityZone(account.accountId, name, {
        limits: limits[name] === null ? null : { ...DEFAULT_ZONE_LIMITS, ...limits[name] },
      }),
    );
    const value = cloudflare.readableAccountToken(account.accountId, token);
    await store(account, value);
    await prisma.collectorCursor.create({
      data: { cloudAccountId: account.id, stream: CLOUDFLARE_CHECK_STREAM, nextRunAt: FAR },
    });
    if (!audit) {
      await prisma.collectorCursor.create({
        data: { cloudAccountId: account.id, stream: CLOUDFLARE_AUDIT_STREAM, nextRunAt: FAR },
      });
    }
    return { account, value, tags };
  }

  const accountRow = (id: string) =>
    prisma.cloudAccount.findUniqueOrThrow({
      where: { id },
      select: { connection: true, connectionError: true, lastCollectedAt: true, lastEventAt: true },
    });
  const cursorOf = (cloudAccountId: string, stream = CLOUDFLARE_SECURITY_STREAM) =>
    prisma.collectorCursor.findUniqueOrThrow({
      where: { cloudAccountId_stream_region: { cloudAccountId, stream, region: '' } },
    });
  const findingsOf = (accountId: string, where: Prisma.FindingWhereInput = {}) =>
    prisma.finding.findMany({
      where: { source: 'cloudflare', accountId, logSource: 'cloudflare_waf', ...where },
      orderBy: [{ occurredAt: 'asc' }, { ruleId: 'asc' }, { sourceIp: 'asc' }],
    });
  const eventReads = (value: string) => cloudflare.graphqlReads(value, 'events');

  beforeAll(async () => {
    await cloudflare.start();
    app = await createApp();
    prisma = app.get(PrismaService);
    const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
    keyring = parsePrivateKeys(`${KEY_VERSION}:${pem64(pair.privateKey, 'pkcs8')}`, KEY_VERSION);
    publicKey = parsePublicKey(pem64(pair.publicKey, 'spki'), KEY_VERSION);
  });

  beforeEach(async () => {
    tenantA = await createTenant(app, 'Cliente Demo A (eventos do Cloudflare)');
    tenantB = await createTenant(app, 'Cliente Demo B (eventos do Cloudflare)');
  });

  afterAll(async () => {
    await prisma.cloudCredential.deleteMany({ where: { keyVersion: KEY_VERSION } });
    await app.close();
    await cloudflare.stop();
  });

  it('lê as janelas fechadas em lotes de zonas, grava os achados agregados do cliente e conecta a conta', async () => {
    const { account, value, tags } = await readyAccount(tenantA, {
      zones: ['blog.exemplo.com.br', 'loja.exemplo.com.br', 'api.exemplo.com.br'],
    });
    const [api, blog, loja] = tags.length === 3 ? [tags[2], tags[0], tags[1]] : [];
    if (api === undefined || blog === undefined || loja === undefined) throw new Error('zonas');
    const creator = (await createUser(app, { role: 'admin_cliente', tenantId: tenantA })).id;
    const exception = await prisma.alertException.create({
      data: {
        tenantId: tenantA,
        ruleId: '990331',
        field: 'ip',
        value: '203.0.113.0/24',
        reason: 'Varredura contratada',
        createdById: creator,
      },
    });
    // Janela 11:30: rajada de 6000 bloqueios de um IP na loja (dois hosts, dois minutos): um achado, nível 10.
    cloudflare.addSecurityEvents(
      loja,
      events(-48, {
        action: 'block',
        source: 'firewallCustom',
        ip: '198.51.100.7',
        host: 'loja.exemplo.com.br',
        count: 3500,
      }),
      events(-46, {
        action: 'block',
        source: 'firewallCustom',
        ip: '198.51.100.7',
        host: 'www.loja.exemplo.com.br',
        count: 2500,
      }),
      // Abaixo de todos os limites: nada.
      events(-45, { action: 'managed_challenge', source: 'botFight', ip: '198.51.100.9', count: 30 }),
    );
    // Janela 12:00: WAF gerenciado contra a API; o IP da varredura contratada nasce legítimo.
    cloudflare.addSecurityEvents(
      api,
      events(-15, {
        action: 'block',
        source: 'firewallManaged',
        ip: '192.0.2.44',
        host: 'api.exemplo.com.br',
        count: 25,
      }),
      events(-14, {
        action: 'block',
        source: 'firewallManaged',
        ip: '203.0.113.5',
        host: 'api.exemplo.com.br',
        count: 80,
      }),
    );

    const report = await syncFor({}, { zonesPerQuery: 2 }).runOnce(NOW);
    expect(report).toMatchObject({
      status: 'done',
      accounts: 1,
      securityWindows: 4,
      // Limites: um lote de 2 e um de 1; eventos: 4 janelas e 2 lotes.
      securityQueries: 2 + 8,
      created: 4,
      excepted: 1,
      duplicates: 0,
      failedAccounts: 0,
      budgetWaits: 0,
    });

    const reads = eventReads(value);
    expect(reads).toHaveLength(8);
    // Zonas pelo nome (api, blog, loja) em lotes de 2, janela a janela, desde 1 h antes da última fechada.
    expect(
      reads.map((read) => [read.variables['since'], (read.variables['zoneTags'] as string[]).length]),
    ).toEqual([
      ['2026-11-04T11:15:00Z', 2],
      ['2026-11-04T11:15:00Z', 1],
      ['2026-11-04T11:30:00Z', 2],
      ['2026-11-04T11:30:00Z', 1],
      ['2026-11-04T11:45:00Z', 2],
      ['2026-11-04T11:45:00Z', 1],
      ['2026-11-04T12:00:00Z', 2],
      ['2026-11-04T12:00:00Z', 1],
    ]);
    expect(reads[0]?.variables).toMatchObject({
      zoneTags: [api, blog],
      until: '2026-11-04T11:30:00Z',
      baselineSince: '2026-11-03T11:15:00Z',
    });
    expect(reads.every((read) => read.limit === 1000)).toBe(true);

    const findings = await findingsOf(account.accountId);
    // A rajada também é um pico da zona (a base de 24 h está vazia): o achado da zona inteira, sem IP.
    expect(
      findings.map((finding) => [finding.ruleId, finding.ruleLevel, finding.severity, finding.sourceIp]),
    ).toEqual([
      ['990330', 10, 'high', '198.51.100.7'],
      ['990334', 7, 'medium', null],
      ['990331', 7, 'medium', '192.0.2.44'],
      ['990331', 7, 'medium', '203.0.113.5'],
    ]);
    expect(findings[0]).toMatchObject({
      tenantId: tenantA,
      sourceEventId: securityEventId(account.accountId, '990330', loja, '198.51.100.7', at(-50)),
      occurredAt: at(-50),
      resource: 'loja.exemplo.com.br',
      eventName: '6000 requisições bloqueadas em 15 min',
      title: expect.stringContaining('Rajada de bloqueios') as unknown,
      status: 'new',
      mitreTechniques: ['T1595'],
    });
    expect(findings[1]).toMatchObject({
      sourceEventId: securityEventId(account.accountId, '990334', loja, '', at(-50)),
      eventName: '6030 eventos de segurança em 15 min (média de 0 por 15 min nas 24 h anteriores)',
      resource: 'loja.exemplo.com.br',
    });
    // O host é o nome da própria zona: o nome do evento não o repete.
    expect(findings[2]?.eventName).toBe('25 requisições barradas pelo WAF gerenciado em 15 min');
    expect(findings[3]).toMatchObject({ status: 'legitimate', exceptionId: exception.id });

    // Conectada, com a coleta e o último evento; o cursor no fim da última janela, e a próxima leitura às 12:35.
    expect(await accountRow(account.id)).toMatchObject({
      connection: 'connected',
      connectionError: null,
      lastCollectedAt: NOW,
      lastEventAt: at(-20),
    });
    const cursor = await cursorOf(account.id);
    expect(cursor).toMatchObject({ cursorAt: at(-5), nextRunAt: at(15), failures: 0 });
    expect(decodeState(cursor.continuation).progress).toBeNull();
    // O medidor: os bytes das respostas e as linhas lidas.
    const usage = await prisma.ingestUsage.findFirstOrThrow({
      where: { tenantId: tenantA, source: 'cloudflare' },
    });
    expect(usage.events).toBe(5n);
    expect(usage.bytes).toBeGreaterThan(0n);

    // Antes de a janela seguinte poder ser lida, nada; às 12:35, só ela.
    expect(await syncFor({}, { zonesPerQuery: 2 }).runOnce(at(14))).toMatchObject({
      notDue: 1,
      securityQueries: 0,
    });
    const next = await syncFor({}, { zonesPerQuery: 2 }).runOnce(at(15));
    expect(next).toMatchObject({ securityWindows: 1, created: 0 });
    expect(eventReads(value).slice(-1)[0]?.variables['since']).toBe('2026-11-04T12:15:00Z');
  });

  it('idempotência: reler as mesmas janelas não duplica os achados', async () => {
    const { account, tags } = await readyAccount(tenantA);
    const [zone = ''] = tags;
    cloudflare.addSecurityEvents(
      zone,
      events(-40, { action: 'block', source: 'firewallCustom', ip: '198.51.100.20', count: 700 }),
      events(-10, { action: 'block', source: 'waf', ip: '198.51.100.21', count: 30 }),
    );
    // A rajada de bloqueios, o pico da zona (base vazia) e o WAF gerenciado.
    expect(await syncFor().runOnce(NOW)).toMatchObject({ created: 3 });
    await prisma.collectorCursor.update({
      where: {
        cloudAccountId_stream_region: {
          cloudAccountId: account.id,
          stream: CLOUDFLARE_SECURITY_STREAM,
          region: '',
        },
      },
      data: { cursorAt: at(-65), nextRunAt: NOW },
    });
    const reread = await syncFor().runOnce(NOW);
    expect(reread).toMatchObject({ securityWindows: 4, created: 0, duplicates: 3 });
    expect(await findingsOf(account.accountId)).toHaveLength(3);
  });

  it('falha da origem no meio da janela: o lote gravado fica, e a execução seguinte segue do lote que faltou', async () => {
    const { account, value, tags } = await readyAccount(tenantA, {
      zones: ['a.exemplo.com.br', 'b.exemplo.com.br'],
    });
    const [first = '', second = ''] = tags;
    cloudflare.addSecurityEvents(
      first,
      events(-62, { action: 'block', source: 'waf', ip: '198.51.100.30', count: 50 }),
    );
    cloudflare.addSecurityEvents(
      second,
      events(-61, { action: 'block', source: 'waf', ip: '198.51.100.31', count: 50 }),
    );
    // Limites (1 lote por zona: 2 pedidos), o primeiro lote da janela 11:15 e, no segundo, 5xx nas três tentativas.
    cloudflare.graphqlScript.push(
      { status: 200, pass: true },
      { status: 200, pass: true },
      { status: 200, pass: true },
      { status: 503 },
      { status: 503 },
      { status: 503 },
    );
    const failed = await syncFor({}, { zonesPerQuery: 1 }).runOnce(NOW);
    expect(failed).toMatchObject({ failedAccounts: 1, created: 1, securityWindows: 0 });
    expect(await accountRow(account.id)).toMatchObject({ connection: 'error', connectionError: 'http_503' });
    const cut = await cursorOf(account.id);
    expect(cut).toMatchObject({ cursorAt: null, failures: 1, lastErrorKind: 'http_503', nextRunAt: at(1) });
    expect(decodeState(cut.continuation).progress).toMatchObject({ windowStart: at(-65), done: 1 });

    const before = eventReads(value).length;
    const resumed = await syncFor({}, { zonesPerQuery: 1 }).runOnce(at(1));
    expect(resumed).toMatchObject({ failedAccounts: 0, created: 1, duplicates: 0, securityWindows: 4 });
    // Seguiu do segundo lote da janela 11:15, sem repetir o primeiro.
    expect(eventReads(value)[before]?.variables).toMatchObject({
      zoneTags: [second],
      since: '2026-11-04T11:15:00Z',
    });
    expect(await findingsOf(account.accountId)).toHaveLength(2);
    expect(await accountRow(account.id)).toMatchObject({ connection: 'connected', connectionError: null });
  });

  it('primeira leitura que parou no meio da primeira janela: depois da virada dos 15 min, segue da mesma janela', async () => {
    const { account, value, tags } = await readyAccount(tenantA, {
      zones: ['a.exemplo.com.br', 'b.exemplo.com.br'],
    });
    const [first = '', second = ''] = tags;
    cloudflare.addSecurityEvents(
      first,
      events(-62, { action: 'block', source: 'waf', ip: '198.51.100.32', count: 50 }),
    );
    cloudflare.addSecurityEvents(
      second,
      events(-61, { action: 'block', source: 'waf', ip: '198.51.100.33', count: 50 }),
    );
    // Limites (um pedido por zona), o primeiro lote da janela 11:15 e, no segundo, 5xx nas três tentativas.
    cloudflare.graphqlScript.push(
      { status: 200, pass: true },
      { status: 200, pass: true },
      { status: 200, pass: true },
      { status: 503 },
      { status: 503 },
      { status: 503 },
    );
    expect(await syncFor({}, { zonesPerQuery: 1 }).runOnce(NOW)).toMatchObject({
      failedAccounts: 1,
      created: 1,
    });
    expect(await cursorOf(account.id)).toMatchObject({ cursorAt: null });

    // A nova tentativa só sai às 12:35, depois da virada: a última janela fechada passou de 12:15 para 12:30, e a
    // primeira leitura recalculada começaria em 11:30. Ela segue da janela de 11:15, do lote que faltou.
    await prisma.collectorCursor.updateMany({
      where: { cloudAccountId: account.id, stream: CLOUDFLARE_SECURITY_STREAM },
      data: { nextRunAt: at(15) },
    });
    const before = eventReads(value).length;
    const resumed = await syncFor({}, { zonesPerQuery: 1 }).runOnce(at(15));
    expect(resumed).toMatchObject({ failedAccounts: 0, created: 1, duplicates: 0, securityWindows: 5 });
    const reads = eventReads(value).slice(before);
    expect(reads[0]?.variables).toMatchObject({ zoneTags: [second], since: '2026-11-04T11:15:00Z' });
    // A janela de 11:15 foi lida uma vez por zona: a primeira na execução anterior, a segunda agora.
    const firstWindow = eventReads(value).filter(
      (read) =>
        read.variables['since'] === '2026-11-04T11:15:00Z' && read.authorization === `Bearer ${value}`,
    );
    expect(firstWindow.filter((read) => (read.variables['zoneTags'] as string[])[0] === first)).toHaveLength(
      1,
    );
    expect(reads.filter((read) => read.variables['since'] === '2026-11-04T11:15:00Z')).toHaveLength(1);
    expect((await findingsOf(account.accountId)).map((finding) => finding.sourceIp)).toEqual([
      '198.51.100.32',
      '198.51.100.33',
    ]);
    expect(await cursorOf(account.id)).toMatchObject({ cursorAt: at(10), nextRunAt: at(30) });
  });

  it('falha no meio da gravação do lote: nada do lote se perde, e a releitura não duplica o que ficou', async () => {
    const { account, tags } = await readyAccount(tenantA);
    const [zone = ''] = tags;
    cloudflare.addSecurityEvents(
      zone,
      ...['198.51.100.40', '198.51.100.41', '198.51.100.42'].map((ip, index) =>
        events(-40, { action: 'block', source: 'waf', ip, count: 30 + index }),
      ),
    );
    /** O banco falha ao agrupar o segundo achado do lote: a transação dele volta, e a execução para ali. */
    class FailingGrouping extends IncidentGrouping {
      private calls = 0;
      override place(...args: Parameters<IncidentGrouping['place']>) {
        this.calls += 1;
        if (this.calls === 2) return Promise.reject(new Error('falha do banco no meio do lote'));
        return super.place(...args);
      }
    }
    const broken = await syncFor({ grouping: new FailingGrouping() }).runOnce(NOW);
    expect(broken).toMatchObject({ failedAccounts: 1, created: 1 });
    expect(await findingsOf(account.accountId)).toHaveLength(1);
    const cut = await cursorOf(account.id);
    // O lote da janela 11:30 não terminou: o cursor está no fim da janela anterior.
    expect(cut.cursorAt).toEqual(at(-50));
    expect(cut.nextRunAt.getTime()).toBeLessThanOrEqual(NOW.getTime());

    const again = await syncFor().runOnce(NOW);
    expect(again).toMatchObject({ failedAccounts: 0, created: 2, duplicates: 1 });
    expect(await findingsOf(account.accountId)).toHaveLength(3);
    expect(await cursorOf(account.id)).toMatchObject({ cursorAt: at(-5) });
  });

  it('429 no GraphQL: espera o retry-after em todos os fluxos da conta, sem nenhuma chamada antes', async () => {
    const { account, value } = await readyAccount(tenantA, { audit: true });
    cloudflare.addAudit(account.accountId, {
      at: iso(-3),
      entry: entryFactory(account.accountId)({
        id: 'zona',
        time: iso(-3),
        method: 'DELETE',
        uri: `/zones/${hex(16)}`,
      }),
    });
    cloudflare.graphqlScript.push({ status: 429, headers: { 'retry-after': '600' } });
    const limited = await syncFor().runOnce(NOW);
    // A auditoria foi lida antes (achado gravado); o 429 dos eventos adia os três fluxos.
    expect(limited).toMatchObject({ failedAccounts: 1, created: 1 });
    expect(await cursorOf(account.id)).toMatchObject({ lastErrorKind: 'rate_limited', nextRunAt: at(10) });
    expect(await cursorOf(account.id, CLOUDFLARE_AUDIT_STREAM)).toMatchObject({
      nextRunAt: at(10),
      failures: 0,
    });
    expect(await accountRow(account.id)).toMatchObject({
      connection: 'error',
      connectionError: 'rate_limited',
    });
    // O orçamento ficou esgotado: o fluxo não gasta antes de ele voltar.
    expect(decodeState((await cursorOf(account.id)).continuation).budget.length).toBeGreaterThan(0);

    const calls = cloudflare.callsWith(value).length;
    expect(await syncFor().runOnce(at(6))).toMatchObject({ notDue: 1 });
    expect(cloudflare.callsWith(value).length).toBe(calls);
    const back = await syncFor().runOnce(at(10));
    expect(back).toMatchObject({ failedAccounts: 0 });
    expect(await accountRow(account.id)).toMatchObject({ connection: 'connected', connectionError: null });

    // "rate limiter budget depleted" no corpo 200 vale como 429 (5 min).
    const other = await readyAccount(tenantB);
    cloudflare.graphqlScript.push({
      status: 200,
      body: JSON.stringify({
        data: null,
        errors: [{ message: 'rate limiter budget depleted, try again after 5 minutes' }],
      }),
    });
    await syncFor().runOnce(NOW);
    expect(await cursorOf(other.account.id)).toMatchObject({
      lastErrorKind: 'rate_limited',
      nextRunAt: at(5),
    });
  });

  it('429 na auditoria adia também os eventos de segurança', async () => {
    const { account, value } = await readyAccount(tenantA, { audit: true });
    cloudflare.auditScript.push({ status: 429, headers: { 'retry-after': '1200' } });
    await syncFor().runOnce(NOW);
    expect(await cursorOf(account.id)).toMatchObject({ nextRunAt: at(20), failures: 0, lastErrorKind: null });
    expect(cloudflare.graphqlReads(value)).toHaveLength(0);
    expect(await syncFor().runOnce(at(10))).toMatchObject({ notDue: 1 });
    expect(cloudflare.graphqlReads(value)).toHaveLength(0);
  });

  it('cada nova tentativa do cliente cobra o orçamento: sem ele, a execução para antes de passar do limite', async () => {
    const { account, value } = await readyAccount(tenantA);
    // 5 unidades: os limites (1) e duas tentativas dos eventos (2 nós cada); a terceira não cabe.
    const options = { budgetUnits: 5 };
    cloudflare.graphqlScript.push(
      { status: 200, pass: true },
      { status: 0, hang: true },
      { status: 0, hang: true },
      { status: 0, hang: true },
    );
    const report = await syncFor({}, options).runOnce(NOW);
    expect(report).toMatchObject({
      securityQueries: 3,
      budgetWaits: 1,
      failedAccounts: 0,
      securityWindows: 0,
    });
    // Só três envios: a terceira tentativa do cliente nem saiu.
    expect(cloudflare.graphqlReads(value)).toHaveLength(3);
    const cut = await cursorOf(account.id);
    const state = decodeState(cut.continuation);
    expect(state.budget.reduce((sum, [, units]) => sum + units, 0)).toBe(5);
    expect(state.progress).toMatchObject({ windowStart: at(-65), done: 0 });
    expect(cut).toMatchObject({ cursorAt: null, nextRunAt: at(6) });
    // A tentativa que não saiu fica no roteiro do Cloudflare falso: tira, para a execução seguinte ler normalmente.
    cloudflare.graphqlScript.length = 0;

    expect(await syncFor({}, options).runOnce(at(5))).toMatchObject({ notDue: 1 });
    const next = await syncFor({}, options).runOnce(at(6));
    expect(next).toMatchObject({ failedAccounts: 0 });
    expect(eventReads(value).at(2)?.variables['since']).toBe('2026-11-04T11:15:00Z');
    expect(await accountRow(account.id)).toMatchObject({ connection: 'connected' });
  });

  it('orçamento de consultas do token: para no limite e segue quando ele volta, sem passar dele', async () => {
    const { account, value } = await readyAccount(tenantA);
    // 5 unidades a cada 5 min: os limites da zona (1) e duas janelas (2 nós cada: os eventos e a base).
    const options = { budgetUnits: 5, firstReadMs: 2 * 60 * 60_000 };
    const first = await syncFor({}, options).runOnce(NOW);
    expect(first).toMatchObject({ securityWindows: 2, budgetWaits: 1, failedAccounts: 0 });
    const cut = await cursorOf(account.id);
    // As janelas de 10:15 e 10:30 lidas; o orçamento volta quando o balde de 12:20 sair (12:26).
    expect(cut).toMatchObject({ cursorAt: at(-95), nextRunAt: at(6) });
    expect(cloudflare.graphqlReads(value)).toHaveLength(3);

    expect(await syncFor({}, options).runOnce(at(5))).toMatchObject({ notDue: 1 });
    expect(cloudflare.graphqlReads(value)).toHaveLength(3);
    const second = await syncFor({}, options).runOnce(at(6));
    expect(second).toMatchObject({ securityWindows: 2, budgetWaits: 1 });
    expect(await cursorOf(account.id)).toMatchObject({ cursorAt: at(-65), nextRunAt: at(12) });
    expect(await accountRow(account.id)).toMatchObject({ connection: 'connected' });
  });

  it('plano sem os eventos de segurança: estado claro na conexão, sem laço de erro, e a auditoria segue', async () => {
    const { account, value } = await readyAccount(tenantA, {
      audit: true,
      limits: { 'loja.exemplo.com.br': { enabled: false } },
    });
    cloudflare.addAudit(account.accountId, {
      at: iso(-3),
      entry: entryFactory(account.accountId)({
        id: 'membro',
        time: iso(-3),
        method: 'POST',
        uri: `/accounts/${account.accountId}/members`,
        zone: null,
      }),
    });
    const report = await syncFor().runOnce(NOW);
    expect(report).toMatchObject({
      created: 1,
      failedAccounts: 0,
      securitySkippedZones: 1,
      securityQueries: 1,
    });
    expect(eventReads(value)).toHaveLength(0);
    expect(await accountRow(account.id)).toMatchObject({
      connection: 'error',
      connectionError: 'security_events_not_entitled',
      lastCollectedAt: NOW,
    });
    expect(await cursorOf(account.id)).toMatchObject({
      lastErrorKind: 'security_events_not_entitled',
      nextRunAt: at(60),
    });
    // Na hora seguinte da auditoria, nenhuma consulta GraphQL; o estado continua no cartão.
    const graphql = cloudflare.graphqlReads(value).length;
    await syncFor().runOnce(at(6));
    expect(cloudflare.graphqlReads(value)).toHaveLength(graphql);
    expect(await accountRow(account.id)).toMatchObject({ connectionError: 'security_events_not_entitled' });
    // Uma hora depois, confere de novo (e a zona passou a ter o conjunto de dados).
    const zone = cloudflare.securityZones.get(
      fakeCloudflare.zoneTag(account.accountId, 'loja.exemplo.com.br'),
    );
    if (zone?.limits) zone.limits.enabled = true;
    await syncFor().runOnce(at(60));
    expect(await accountRow(account.id)).toMatchObject({ connection: 'connected', connectionError: null });

    // Uma zona sem o conjunto de dados não esconde a outra.
    const mixed = await readyAccount(tenantB, {
      zones: ['loja.exemplo.com.br', 'blog.exemplo.com.br'],
      limits: { 'blog.exemplo.com.br': { enabled: false } },
    });
    const mixedReport = await syncFor().runOnce(NOW);
    expect(mixedReport.securitySkippedZones).toBeGreaterThanOrEqual(1);
    expect(
      eventReads(mixed.value).every((read) => (read.variables['zoneTags'] as string[]).length === 1),
    ).toBe(true);
    expect(eventReads(mixed.value)[0]?.variables['zoneTags']).toEqual([mixed.tags[0]]);
    expect(await accountRow(mixed.account.id)).toMatchObject({ connection: 'connected' });

    // A recusa vinda da própria consulta dos eventos ("does not have access to the path") também vira o estado.
    const late = await readyAccount(tenantB, { zones: ['api.exemplo.com.br'] });
    cloudflare.graphqlScript.push(
      { status: 200, pass: true },
      {
        status: 200,
        body: JSON.stringify({ data: null, errors: [{ message: 'zone does not have access to the path' }] }),
      },
    );
    await syncFor({ tenantIds: [tenantB] }).runOnce(at(1));
    expect(await accountRow(late.account.id)).toMatchObject({
      connectionError: 'security_events_not_entitled',
    });
    // Sem laço de erro: a próxima tentativa é uma hora depois, e não no recuo de 1 minuto.
    expect(await cursorOf(late.account.id)).toMatchObject({
      lastErrorKind: 'security_events_not_entitled',
      nextRunAt: at(61),
    });
  });

  it('token sem Analytics: Read: estado na conexão sem parar a auditoria; zona que o token não lê fica de fora', async () => {
    const { account, value } = await readyAccount(tenantA, { audit: true, token: { analyticsRead: false } });
    await syncFor().runOnce(NOW);
    expect(await accountRow(account.id)).toMatchObject({
      connection: 'error',
      connectionError: 'security_events_forbidden',
      lastCollectedAt: NOW,
    });
    expect(cloudflare.auditReads(value)).toHaveLength(1);
    expect(await cursorOf(account.id)).toMatchObject({ nextRunAt: at(60) });

    // Token que lê só uma das zonas: a outra some da resposta dos limites e fica de fora.
    const partial = await readyAccount(tenantB, { zones: ['loja.exemplo.com.br', 'blog.exemplo.com.br'] });
    const readable = partial.tags[0] ?? '';
    const token = cloudflare.tokens.get(partial.value);
    if (token) token.analyticsZones = [readable];
    const report = await syncFor({ tenantIds: [tenantB] }).runOnce(NOW);
    expect(report).toMatchObject({ securitySkippedZones: 1, failedAccounts: 0 });
    expect(
      eventReads(partial.value).every((read) => (read.variables['zoneTags'] as string[])[0] === readable),
    ).toBe(true);
    expect(await accountRow(partial.account.id)).toMatchObject({ connection: 'connected' });

    // Sem Zone: Read, nem as zonas: o estado das zonas, sem parar a auditoria.
    const noZones = await readyAccount(tenantB, { token: { zoneRead: false } });
    await syncFor({ tenantIds: [tenantB] }).runOnce(at(1));
    expect(await accountRow(noZones.account.id)).toMatchObject({ connectionError: 'zones_forbidden' });
    expect(cloudflare.graphqlReads(noZones.value)).toHaveLength(0);
  });

  it('resposta fora do formato é recusada inteira: nenhum achado, cursor parado e recuo', async () => {
    const { account, value, tags } = await readyAccount(tenantA);
    const [zone = ''] = tags;
    cloudflare.addSecurityEvents(
      zone,
      events(-62, { action: 'block', source: 'waf', ip: '198.51.100.50', count: 50 }),
    );
    const other = fakeCloudflare.zoneTag(fakeCloudflare.accountId(), 'de-outro.exemplo.com.br');
    const row = (count: unknown) => ({
      count,
      dimensions: { action: 'block', source: 'waf', clientIP: '198.51.100.50', clientRequestHTTPHost: null },
    });
    const bodies = [
      'não é json',
      JSON.stringify({ data: { viewer: { zones: [{ zoneTag: zone, events: [row(-5)], baseline: [] }] } } }),
      JSON.stringify({
        data: { viewer: { zones: [{ zoneTag: zone, events: [{ count: 50 }], baseline: [] }] } },
      }),
      // Uma zona que não foi pedida (de outra conta): nada da resposta é aproveitado.
      JSON.stringify({
        data: { viewer: { zones: [{ zoneTag: other, events: [row(5000)], baseline: [] }] } },
      }),
      // errors[] com parte dos dados: é erro.
      JSON.stringify({
        data: { viewer: { zones: [{ zoneTag: zone, events: [row(50)], baseline: [] }] } },
        errors: [{ message: 'algo deu errado' }],
      }),
    ];
    const codes: (string | null)[] = [];
    for (const [index, body] of bodies.entries()) {
      cloudflare.graphqlScript.push({ status: 200, pass: true }, { status: 200, body });
      await prisma.collectorCursor.updateMany({
        where: { cloudAccountId: account.id, stream: CLOUDFLARE_SECURITY_STREAM },
        data: { nextRunAt: at(index) },
      });
      const report = await syncFor().runOnce(at(index));
      expect(report.failedAccounts).toBe(1);
      codes.push((await accountRow(account.id)).connectionError);
    }
    expect(codes).toEqual(['bad_response', 'bad_response', 'bad_response', 'bad_response', 'graphql_error']);
    expect(await findingsOf(account.accountId)).toHaveLength(0);
    expect(
      await prisma.finding.count({ where: { logSource: 'cloudflare_waf', accountId: account.accountId } }),
    ).toBe(0);
    expect(await cursorOf(account.id)).toMatchObject({ cursorAt: null, failures: 5 });
    expect(eventReads(value).length).toBeGreaterThanOrEqual(5);

    // A janela que já saiu da retenção é pulada, sem laço.
    await prisma.collectorCursor.updateMany({
      where: { cloudAccountId: account.id, stream: CLOUDFLARE_SECURITY_STREAM },
      data: { nextRunAt: at(10) },
    });
    cloudflare.graphqlScript.push(
      { status: 200, pass: true },
      {
        status: 400,
        body: JSON.stringify({ data: null, errors: [{ message: 'cannot request data older than 31d' }] }),
      },
    );
    const skipped = await syncFor().runOnce(at(10));
    expect(skipped).toMatchObject({ securityExpired: 1, failedAccounts: 0 });
  });

  it('A/B: cada token só nas zonas da própria conta; cada achado só no próprio cliente', async () => {
    const a = await readyAccount(tenantA);
    const b = await readyAccount(tenantB, { zones: ['loja.exemplo.com.br', 'b.exemplo.com.br'] });
    const [zoneA = ''] = a.tags;
    const [zoneB = ''] = b.tags;
    cloudflare.addSecurityEvents(
      zoneA,
      events(-30, { action: 'block', source: 'waf', ip: '198.51.100.60', count: 40 }),
    );
    cloudflare.addSecurityEvents(
      zoneB,
      events(-30, { action: 'block', source: 'waf', ip: '198.51.100.61', count: 40 }),
    );
    await syncFor().runOnce(NOW);

    const findingsA = await findingsOf(a.account.accountId);
    const findingsB = await findingsOf(b.account.accountId);
    expect(findingsA.map((finding) => [finding.tenantId, finding.sourceIp])).toEqual([
      [tenantA, '198.51.100.60'],
    ]);
    expect(findingsB.map((finding) => [finding.tenantId, finding.sourceIp])).toEqual([
      [tenantB, '198.51.100.61'],
    ]);
    // O B não vê nada do A pelo escopo dele, e o contrário.
    expect(await prisma.forTenant(tenantB).finding.count({ where: { accountId: a.account.accountId } })).toBe(
      0,
    );
    expect(await prisma.forTenant(tenantA).finding.count({ where: { accountId: b.account.accountId } })).toBe(
      0,
    );
    // Cada token só consultou as zonas da própria conta (as zonas têm o mesmo nome nas duas contas, e IDs diferentes).
    const zonesOf = (value: string) =>
      new Set(cloudflare.graphqlReads(value).flatMap((read) => read.variables['zoneTags'] as string[]));
    expect([...zonesOf(a.value)]).toEqual([zoneA]);
    expect(zonesOf(b.value).has(zoneA)).toBe(false);
    expect(
      cloudflare
        .callsWith(a.value)
        .every((call) => call.path === '/graphql' || call.query.get('account.id') === a.account.accountId),
    ).toBe(true);

    // Uma resposta à consulta do A que traz a zona do B é recusada: nada vai para cliente nenhum.
    await prisma.collectorCursor.updateMany({
      where: { cloudAccountId: a.account.id, stream: CLOUDFLARE_SECURITY_STREAM },
      data: { cursorAt: at(-20), nextRunAt: at(15) },
    });
    cloudflare.addSecurityEvents(
      zoneB,
      events(1, { action: 'block', source: 'waf', ip: '198.51.100.62', count: 900 }),
    );
    cloudflare.graphqlScript.push(
      { status: 200, pass: true },
      {
        status: 200,
        body: JSON.stringify({
          data: {
            viewer: {
              zones: [
                {
                  zoneTag: zoneB,
                  events: [
                    {
                      count: 900,
                      dimensions: {
                        action: 'block',
                        source: 'waf',
                        clientIP: '198.51.100.62',
                        clientRequestHTTPHost: null,
                      },
                    },
                  ],
                  baseline: [],
                },
              ],
            },
          },
        }),
      },
    );
    const report = await syncFor({ tenantIds: [tenantA] }).runOnce(at(15));
    expect(report.failedAccounts).toBe(1);
    expect(await prisma.finding.count({ where: { sourceIp: '198.51.100.62' } })).toBe(0);
  });

  it('401 no GraphQL para a coleta da conta até um token novo', async () => {
    const { account, value } = await readyAccount(tenantA);
    cloudflare.graphqlScript.push({ status: 401 });
    await syncFor().runOnce(NOW);
    expect(await accountRow(account.id)).toMatchObject({
      connection: 'error',
      connectionError: 'credential_rejected',
    });
    const calls = cloudflare.callsWith(value).length;
    for (const minutes of [61, 180]) {
      expect(await syncFor().runOnce(at(minutes))).toMatchObject({ blocked: 1 });
    }
    expect(cloudflare.callsWith(value).length).toBe(calls);
    await prisma
      .forTenant(tenantA)
      .cloudAccount.update({ where: { id: account.id }, data: RESET_CONNECTION });
    await syncFor().runOnce(at(181));
    expect(await accountRow(account.id)).toMatchObject({ connection: 'connected' });
  });

  it('limite de taxa contra rota de login: nível 10; nas outras rotas, 7 (uma consulta a mais, só com limite disparado)', async () => {
    const { account, value, tags } = await readyAccount(tenantA);
    const [zone = ''] = tags;
    cloudflare.addSecurityEvents(
      zone,
      events(-25, {
        action: 'block',
        source: 'rateLimit',
        ip: '198.51.100.70',
        path: '/wp-login.php',
        count: 12,
      }),
      events(-25, { action: 'block', source: 'rateLimit', ip: '198.51.100.71', path: '/produtos', count: 8 }),
      events(-24, {
        action: 'managed_challenge_interactive_solved',
        source: 'rateLimit',
        ip: '198.51.100.72',
        path: '/login',
        count: 3,
      }),
    );
    await syncFor().runOnce(NOW);
    const findings = await findingsOf(account.accountId, { ruleId: '990332' });
    expect(findings.map((finding) => [finding.sourceIp, finding.ruleLevel])).toEqual([
      ['198.51.100.70', 10],
      ['198.51.100.71', 7],
    ]);
    expect(findings[0]?.eventName).toContain('rota de login');
    const paths = cloudflare.graphqlReads(value, 'paths');
    expect(paths).toHaveLength(1);
    expect(paths[0]?.variables['clientIPs']).toEqual(['198.51.100.70', '198.51.100.71']);
  });

  it('log do worker: o token nunca aparece, nem quando a origem o repete nas mensagens de erro', async () => {
    const { account, value, tags } = await readyAccount(tenantA);
    const [zone = ''] = tags;
    cloudflare.addSecurityEvents(
      zone,
      events(-30, { action: 'block', source: 'waf', ip: '198.51.100.80', count: 40 }),
    );
    // Erros com o token no corpo: 5xx (tentado de novo) e um 403 classificado pelas mensagens.
    cloudflare.graphqlScript.push({ status: 500 }, { status: 200, pass: true });
    const capture = new LogCapture();
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
      pino(buildPinoOptions({ LOG_LEVEL: 'trace' }), capture),
    );
    scheduler.start();
    await vi.waitFor(() => expect(capture.text).toContain('tarefa concluída'), { timeout: 20_000 });
    await scheduler.stop();
    expect(capture.text).not.toContain(value);
    expect(capture.text).not.toContain('Bearer');
    const [line] = capture.entries().filter((logged) => logged['task'] === 'cloudflare');
    expect(line?.['report']).toMatchObject({ created: 1 });
    expect(JSON.stringify(line?.['report'])).not.toContain('REDACTED');

    const failing = await readyAccount(tenantB, { token: { analyticsRead: false } });
    const failCapture = new LogCapture();
    const failScheduler = new Scheduler(
      [
        {
          name: 'cloudflare',
          intervalMs: 60_000,
          budgetMs: 60_000,
          run: (signal) => syncFor({ tenantIds: [tenantB] }).runOnce(NOW, signal),
        },
      ],
      pino(buildPinoOptions({ LOG_LEVEL: 'trace' }), failCapture),
    );
    failScheduler.start();
    await vi.waitFor(() => expect(failCapture.text).toContain('tarefa concluída'), { timeout: 20_000 });
    await failScheduler.stop();
    expect(failCapture.text).not.toContain(failing.value);
    expect(await accountRow(failing.account.id)).toMatchObject({
      connectionError: 'security_events_forbidden',
    });
    expect(await accountRow(account.id)).toMatchObject({ connection: 'connected' });
  });
});
