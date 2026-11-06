import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CLOUDFLARE_API_BASE_URL,
  CLOUDFLARE_CHECK_TIMEOUT_MS,
  CloudflareTokenCheck,
} from '../../src/cloudflare/cloudflare-token-check.js';
import { CredentialRejected, CredentialSourceUnavailable } from '../../src/credentials/credential-check.js';
import { CloudflareToken } from '../../src/credentials/credential-vault.js';
import { fakeCloudflare, FakeCloudflareServer } from '../support/fake-cloudflare.js';

const NOW = new Date('2026-11-04T12:00:00.000Z');
const inDays = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString();

async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CredentialRejected) return `rejected:${error.reason}`;
    if (error instanceof CredentialSourceUnavailable) return `unavailable:${error.code}`;
    throw error;
  }
  throw new Error('a conferência deveria ter falhado');
}

describe('conferência do token do Cloudflare (servidor falso)', () => {
  const cloudflare = new FakeCloudflareServer();
  let check: CloudflareTokenCheck;
  const account = fakeCloudflare.accountId();

  beforeAll(async () => {
    await cloudflare.start();
    check = new CloudflareTokenCheck({ baseUrl: cloudflare.baseUrl, timeoutMs: 2_000 });
  });

  afterAll(async () => {
    await cloudflare.stop();
  });

  it('só chama o host oficial, ou um servidor falso em 127.0.0.1 nos testes; o tempo padrão é 5 s', () => {
    expect(CLOUDFLARE_API_BASE_URL).toBe('https://api.cloudflare.com/client/v4');
    expect(CLOUDFLARE_CHECK_TIMEOUT_MS).toBe(5_000);
    expect(() => new CloudflareTokenCheck()).not.toThrow();
    for (const baseUrl of [
      'https://api.cloudflare.com.example/client/v4',
      'https://api.cloudflare.com/client/v4/',
      'http://localhost:8080',
      'https://127.0.0.1:8080',
      'http://169.254.169.254',
      'não é url',
    ]) {
      expect(() => new CloudflareTokenCheck({ baseUrl })).toThrow(/host oficial/);
    }
  });

  it('token de conta (cfat_): só o verify da conta e a leitura de prova da auditoria, com o Bearer', async () => {
    const id = fakeCloudflare.tokenId();
    const token = cloudflare.readableAccountToken(account, { id, expiresOn: inDays(30) });
    const result = await check.check(new CloudflareToken(token), account, NOW);
    expect(result).toEqual({ keyIdSuffix: id.slice(-4), issuedAt: null, expiresAt: new Date(inDays(30)) });
    const calls = cloudflare.callsWith(token);
    expect(calls.map((call) => call.path)).toEqual([
      `/accounts/${account}/tokens/verify`,
      `/accounts/${account}/logs/audit`,
    ]);
    // A leitura de prova pede uma entrada da última hora (since e before em RFC 3339).
    expect(Object.fromEntries(calls[1]?.query ?? [])).toEqual({
      since: '2026-11-04T11:00:00Z',
      before: '2026-11-04T12:00:00Z',
      limit: '1',
    });
  });

  it('token de usuário (cfut_): só o verify do usuário; sem validade, expiresAt null', async () => {
    const token = fakeCloudflare.userToken();
    cloudflare.tokens.set(token, { id: fakeCloudflare.tokenId(), owner: 'user', auditAccounts: [account] });
    expect((await check.check(new CloudflareToken(token), account, NOW)).expiresAt).toBeNull();
    expect(cloudflare.callsWith(token).map((call) => call.path)).toEqual([
      '/user/tokens/verify',
      `/accounts/${account}/logs/audit`,
    ]);
  });

  it('formato antigo, sem prefixo: tenta o verify da conta e, recusado, o do usuário', async () => {
    const accountOwned = fakeCloudflare.legacyToken();
    cloudflare.tokens.set(accountOwned, {
      id: fakeCloudflare.tokenId(),
      owner: 'account',
      accountId: account,
      auditAccounts: [account],
    });
    await check.check(new CloudflareToken(accountOwned), account, NOW);
    expect(cloudflare.callsWith(accountOwned)).toHaveLength(2);

    const userOwned = fakeCloudflare.legacyToken();
    cloudflare.tokens.set(userOwned, {
      id: fakeCloudflare.tokenId(),
      owner: 'user',
      auditAccounts: [account],
    });
    await check.check(new CloudflareToken(userOwned), account, NOW);
    expect(cloudflare.callsWith(userOwned).map((call) => call.path)).toEqual([
      `/accounts/${account}/tokens/verify`,
      '/user/tokens/verify',
      `/accounts/${account}/logs/audit`,
    ]);
  });

  it('recusas: desconhecido, de outra conta, desativado, vencido, ainda não vale e sem a auditoria da conta', async () => {
    const other = fakeCloudflare.accountId();
    const cases: [string, string][] = [
      [fakeCloudflare.accountToken(), 'rejected:invalid'],
      [cloudflare.readableAccountToken(other), 'rejected:invalid'],
      [cloudflare.readableAccountToken(account, { status: 'disabled' }), 'rejected:inactive'],
      [cloudflare.readableAccountToken(account, { status: 'expired' }), 'rejected:expired'],
      [cloudflare.readableAccountToken(account, { expiresOn: inDays(-1) }), 'rejected:expired'],
      [cloudflare.readableAccountToken(account, { notBefore: inDays(2) }), 'rejected:not_yet_valid'],
      [cloudflare.readableAccountToken(account, { auditAccounts: [] }), 'rejected:no_account_access'],
    ];
    for (const [token, expected] of cases) {
      expect(await failureOf(check.check(new CloudflareToken(token), account, NOW))).toBe(expected);
    }
    // Recusado antes da leitura de prova, o token não chega à auditoria.
    const disabled = cases[2]?.[0] ?? '';
    expect(cloudflare.callsWith(disabled).map((call) => call.path)).toEqual([
      `/accounts/${account}/tokens/verify`,
    ]);
  });

  it('indisponível: 5xx, limite de requisições (429) e resposta fora do formato', async () => {
    for (const [overrides, expected] of [
      [{ verifyStatus: 500 }, 'unavailable:http_500'],
      [{ verifyStatus: 429 }, 'unavailable:http_429'],
      [
        { verifyBody: '{"success":true,"result":{"id":"<script>","status":"active"}}' },
        'unavailable:bad_response',
      ],
      [{ verifyBody: 'não é json' }, 'unavailable:bad_response'],
    ] as const) {
      const token = cloudflare.readableAccountToken(account, overrides);
      expect(await failureOf(check.check(new CloudflareToken(token), account, NOW))).toBe(expected);
    }
  });

  it('o ID da conta entra na URL só no formato do cadastro', async () => {
    const token = cloudflare.readableAccountToken(account);
    expect(await failureOf(check.check(new CloudflareToken(token), '../user', NOW))).toBe('rejected:invalid');
    expect(cloudflare.callsWith(token)).toEqual([]);
  });

  it(
    'tempo limite de 5 s: o Cloudflare que não responde vira indisponível, sem esperar mais',
    { timeout: 15_000 },
    async () => {
      const token = cloudflare.readableAccountToken(account, { hang: true });
      const started = performance.now();
      expect(
        await failureOf(
          new CloudflareTokenCheck({ baseUrl: cloudflare.baseUrl }).check(
            new CloudflareToken(token),
            account,
            NOW,
          ),
        ),
      ).toBe('unavailable:timeout');
      const elapsed = performance.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(4_900);
      expect(elapsed).toBeLessThan(8_000);
    },
  );
});
