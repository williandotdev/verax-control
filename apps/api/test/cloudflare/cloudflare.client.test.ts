import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CLOUDFLARE_MAX_BODY_BYTES,
  CLOUDFLARE_REQUEST_TIMEOUT_MS,
  CloudflareApiError,
  CloudflareClient,
  retryAfterMs,
} from '../../src/cloudflare/cloudflare.client.js';
import { CloudflareToken } from '../../src/credentials/credential-vault.js';
import { fakeCloudflare, FakeCloudflareServer } from '../support/fake-cloudflare.js';
import { auditLogEntry } from './fixtures.js';

const SINCE = new Date('2026-11-04T10:00:00.000Z');
const BEFORE = new Date('2026-11-04T12:00:00.000Z');
const minute = (n: number) => new Date(SINCE.getTime() + n * 60_000).toISOString();

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CloudflareApiError) return error.code;
    throw error;
  }
  throw new Error('a chamada deveria ter falhado');
}

describe('cliente da API do Cloudflare (servidor falso)', () => {
  const cloudflare = new FakeCloudflareServer();
  const account = fakeCloudflare.accountId();
  let value: string;
  let token: CloudflareToken;
  let client: CloudflareClient;

  beforeAll(async () => {
    await cloudflare.start();
    value = cloudflare.readableAccountToken(account);
    token = new CloudflareToken(value);
    client = new CloudflareClient({ baseUrl: cloudflare.baseUrl, timeoutMs: 300, retryDelaysMs: [10, 10] });
    cloudflare.addAudit(
      account,
      ...Array.from({ length: 5 }, (_, index) => ({
        at: minute(index),
        entry: auditLogEntry({ accountId: account, id: `entrada-${index}`, time: minute(index) }),
      })),
    );
  });

  afterAll(async () => {
    await cloudflare.stop();
  });

  it('só o host oficial, ou 127.0.0.1 nos testes; padrões de tempo e de tamanho', () => {
    expect(CLOUDFLARE_REQUEST_TIMEOUT_MS).toBe(20_000);
    expect(CLOUDFLARE_MAX_BODY_BYTES).toBe(16 * 1024 * 1024);
    expect(() => new CloudflareClient()).not.toThrow();
    for (const baseUrl of [
      'https://api.cloudflare.com.example/client/v4',
      'http://localhost:1',
      'http://10.0.0.1',
    ]) {
      expect(() => new CloudflareClient({ baseUrl })).toThrow(/host oficial/);
    }
  });

  it('auditoria: Bearer, since e before em RFC 3339, ordem crescente, limite e o cursor da resposta', async () => {
    const first = await client.auditPage(token, account, { since: SINCE, before: BEFORE, limit: 2 });
    expect(first.entries.map((entry) => (entry as { id: string }).id)).toEqual(['entrada-0', 'entrada-1']);
    expect(first.cursor).not.toBeNull();
    expect(first.bytes).toBeGreaterThan(0);
    const [request] = cloudflare.auditReads(value).slice(-1);
    expect(request?.authorization).toBe(`Bearer ${value}`);
    expect(request?.path).toBe(`/accounts/${account}/logs/audit`);
    expect(Object.fromEntries(request?.query ?? [])).toEqual({
      since: '2026-11-04T10:00:00Z',
      before: '2026-11-04T12:00:00Z',
      direction: 'asc',
      limit: '2',
    });

    const second = await client.auditPage(token, account, {
      since: SINCE,
      before: BEFORE,
      limit: 2,
      cursor: first.cursor,
    });
    expect(second.entries.map((entry) => (entry as { id: string }).id)).toEqual(['entrada-2', 'entrada-3']);
    expect(cloudflare.auditReads(value).at(-1)?.query.get('cursor')).toBe(first.cursor);
    const last = await client.auditPage(token, account, {
      since: SINCE,
      before: BEFORE,
      limit: 2,
      cursor: second.cursor,
    });
    expect(last.entries).toHaveLength(1);
    // Cursor vazio no fim vira null.
    expect(last.cursor).toBeNull();
  });

  it('401 e 403 não são tentados de novo; o corpo do erro (que repete o token) nunca é lido', async () => {
    const before = cloudflare.auditReads().length;
    cloudflare.auditScript.push({ status: 401 });
    expect(await codeOf(client.auditPage(token, account, { since: SINCE, before: BEFORE, limit: 10 }))).toBe(
      'credential_rejected',
    );
    cloudflare.auditScript.push({ status: 403 });
    const error = await client
      .auditPage(token, account, { since: SINCE, before: BEFORE, limit: 10 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect((error as Error).name).toBe('credential_forbidden');
    expect(String((error as Error).message)).not.toContain(value);
    expect(cloudflare.auditReads().length - before).toBe(2);
  });

  it('429 não é tentado de novo e devolve a espera do retry-after', async () => {
    const before = cloudflare.auditReads().length;
    cloudflare.auditScript.push({ status: 429, headers: { 'retry-after': '120' } });
    const error = await client
      .auditPage(token, account, { since: SINCE, before: BEFORE, limit: 10 })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'rate_limited', status: 429, retryAfterMs: 120_000 });
    expect(cloudflare.auditReads().length - before).toBe(1);
  });

  it('5xx é tentado de novo (duas vezes) e passa quando a origem volta', async () => {
    const before = cloudflare.auditReads().length;
    cloudflare.auditScript.push({ status: 502 }, { status: 503 });
    const page = await client.auditPage(token, account, { since: SINCE, before: BEFORE, limit: 1 });
    expect(page.entries).toHaveLength(1);
    expect(cloudflare.auditReads().length - before).toBe(3);

    cloudflare.auditScript.push({ status: 500 }, { status: 500 }, { status: 503 });
    expect(await codeOf(client.auditPage(token, account, { since: SINCE, before: BEFORE, limit: 1 }))).toBe(
      'http_503',
    );
  });

  it('tempo esgotado em cada tentativa: três tentativas e o erro "timeout"', async () => {
    const before = cloudflare.auditReads().length;
    cloudflare.auditScript.push(
      { status: 0, hang: true },
      { status: 0, hang: true },
      { status: 0, hang: true },
    );
    const started = Date.now();
    expect(await codeOf(client.auditPage(token, account, { since: SINCE, before: BEFORE, limit: 1 }))).toBe(
      'timeout',
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(cloudflare.auditReads().length - before).toBe(3);
  });

  it('o sinal do agendador interrompe a chamada como cancelamento, sem virar erro da origem', async () => {
    cloudflare.auditScript.push({ status: 0, hang: true });
    const controller = new AbortController();
    const patient = new CloudflareClient({
      baseUrl: cloudflare.baseUrl,
      timeoutMs: 10_000,
      retryDelaysMs: [],
    });
    const pending = patient.auditPage(
      token,
      account,
      { since: SINCE, before: BEFORE, limit: 1 },
      controller.signal,
    );
    setTimeout(() => controller.abort(new DOMException('parando', 'AbortError')), 50);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('corpo acima do teto: erro, sem guardar o resto; envelope fora do formato: bad_response', async () => {
    const small = new CloudflareClient({ baseUrl: cloudflare.baseUrl, maxBodyBytes: 500, retryDelaysMs: [] });
    expect(await codeOf(small.auditPage(token, account, { since: SINCE, before: BEFORE, limit: 5 }))).toBe(
      'response_too_large',
    );
    cloudflare.auditScript.push({ status: 200, body: JSON.stringify({ success: false, result: [] }) });
    expect(await codeOf(client.auditPage(token, account, { since: SINCE, before: BEFORE, limit: 5 }))).toBe(
      'bad_response',
    );
    cloudflare.auditScript.push({ status: 200, body: '<html>não é JSON</html>' });
    expect(await codeOf(client.auditPage(token, account, { since: SINCE, before: BEFORE, limit: 5 }))).toBe(
      'bad_response',
    );
  });

  it('zonas: todas as páginas, só as da conta, em minúsculas', async () => {
    const names = Array.from({ length: 60 }, (_, index) => `zona${index}.exemplo.com.br`);
    cloudflare.zones.set(account, names);
    const zones = await client.zones(token, account);
    expect(zones.complete).toBe(true);
    expect(zones.names.size).toBe(60);
    const calls = cloudflare.callsWith(value).filter((request) => request.path === '/zones');
    expect(calls.map((request) => request.query.get('page'))).toEqual(['1', '2']);
    expect(calls[0]?.query.get('account.id')).toBe(account);
    expect(calls[0]?.query.get('per_page')).toBe('50');
  });

  it('retry-after: segundos ou data HTTP, com piso de 1 s e teto de 1 h', () => {
    const now = Date.parse('2026-11-04T12:00:00.000Z');
    expect(retryAfterMs('120', now)).toBe(120_000);
    expect(retryAfterMs('0', now)).toBe(1_000);
    expect(retryAfterMs('999999', now)).toBe(3_600_000);
    expect(retryAfterMs('Wed, 04 Nov 2026 12:05:00 GMT', now)).toBe(300_000);
    expect(retryAfterMs(null, now)).toBeUndefined();
    expect(retryAfterMs('', now)).toBeUndefined();
    expect(retryAfterMs('-5', now)).toBeUndefined();
    expect(retryAfterMs('depois', now)).toBeUndefined();
  });
});
