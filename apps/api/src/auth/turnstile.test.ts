import { describe, expect, it, vi } from 'vitest';
import { createTurnstileVerifier, TURNSTILE_TOKEN_MAX_LENGTH } from './turnstile.js';

const SECRET = 'segredo-de-teste-nao-pode-vazar';
const URL = 'http://127.0.0.1:1/siteverify';
/** Chave de site de teste da Cloudflare: o hostname do siteverify não é conferido. */
const TEST_SITE_KEY = '1x00000000000000000000AA';
/** No formato de uma chave real (`0x…`), sem ser uma: liga a conferência do hostname. */
const REAL_SHAPED_SITE_KEY = '0x0000000000000000000000AA';
const WEB_ORIGIN = 'https://painel.example';

function setup(response: () => Promise<Response>, siteKey = TEST_SITE_KEY) {
  const fetchImpl = vi.fn((_input: string | URL | Request, _init?: RequestInit) => response());
  const logger = { warn: vi.fn(), error: vi.fn() };
  const verifier = createTurnstileVerifier(
    {
      TURNSTILE_SECRET_KEY: SECRET,
      TURNSTILE_SITE_KEY: siteKey,
      TURNSTILE_SITEVERIFY_URL: URL,
      WEB_ORIGIN,
    },
    logger,
    fetchImpl,
  );
  if (!verifier) throw new Error('com a chave secreta, o verificador existe');
  const logged = () => JSON.stringify([...logger.warn.mock.calls, ...logger.error.mock.calls]);
  return { verifier, fetchImpl, logger, logged };
}

const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );

describe('verificador do Turnstile', () => {
  it('sem a chave secreta, não existe (Turnstile desligado)', () => {
    const verifier = createTurnstileVerifier(
      {
        TURNSTILE_SECRET_KEY: undefined,
        TURNSTILE_SITE_KEY: undefined,
        TURNSTILE_SITEVERIFY_URL: URL,
        WEB_ORIGIN,
      },
      { warn: vi.fn(), error: vi.fn() },
    );
    expect(verifier).toBeUndefined();
  });

  it('manda chave, token e IP ao siteverify, sem seguir redirecionamento, e aceita a resposta de sucesso', async () => {
    const { verifier, fetchImpl } = setup(() => json({ success: true, 'error-codes': [], extra: 1 }));
    expect(await verifier.verify('token-abc', '203.0.113.9', 'login')).toBe('ok');
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(URL);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      secret: SECRET,
      response: 'token-abc',
      remoteip: '203.0.113.9',
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    // Um redirecionamento levaria a chave secreta (no corpo) a outro endereço: vira erro de rede.
    expect(init?.redirect).toBe('error');
  });

  it('sem token (ou vazio) é "required", sem chamar a rede', async () => {
    const { verifier, fetchImpl } = setup(() => json({ success: true }));
    expect(await verifier.verify(undefined, undefined, 'login')).toBe('required');
    expect(await verifier.verify(null, undefined, 'login')).toBe('required');
    expect(await verifier.verify('', undefined, 'login')).toBe('required');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('token acima do limite é recusado sem ir à rede, e o token não vai para o log', async () => {
    const { verifier, fetchImpl, logged } = setup(() => json({ success: true }));
    const token = 'x'.repeat(TURNSTILE_TOKEN_MAX_LENGTH + 1);
    expect(await verifier.verify(token, undefined, 'login')).toBe('failed');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logged()).not.toContain(token);
  });

  it('resposta de recusa vira "failed", com só os códigos de erro no log', async () => {
    const { verifier, logged } = setup(() =>
      json({ success: false, 'error-codes': ['timeout-or-duplicate'], hostname: 'painel.example' }),
    );
    expect(await verifier.verify('token-abc', undefined, 'login')).toBe('failed');
    expect(logged()).toContain('timeout-or-duplicate');
    expect(logged()).not.toContain('token-abc');
    expect(logged()).not.toContain(SECRET);
  });

  describe('action do widget', () => {
    it('a mesma da rota (ou ausente na resposta): "ok"', async () => {
      const same = setup(() => json({ success: true, action: 'login' }));
      expect(await same.verifier.verify('token-abc', undefined, 'login')).toBe('ok');
      const absent = setup(() => json({ success: true }));
      expect(await absent.verifier.verify('token-abc', undefined, 'password-reset')).toBe('ok');
    });

    it.each([
      ['login', 'password-reset'],
      ['password-reset', 'login'],
      ['outra', 'login'],
    ])(
      'token resolvido com a action "%s" não vale na rota "%s": "failed", com o motivo e sem o token no log',
      async (solved, expected) => {
        const { verifier, logged, logger } = setup(() => json({ success: true, action: solved }));
        expect(await verifier.verify('token-abc', undefined, expected)).toBe('failed');
        expect(logger.warn).toHaveBeenCalledOnce();
        expect(logged()).toContain('action-mismatch');
        expect(logged()).not.toContain('token-abc');
        expect(logged()).not.toContain(SECRET);
      },
    );
  });

  describe('hostname do siteverify', () => {
    it('com chave de teste, qualquer hostname (ou nenhum) passa', async () => {
      const other = setup(() => json({ success: true, hostname: 'outro.example' }));
      expect(await other.verifier.verify('token-abc', undefined, 'login')).toBe('ok');
      const absent = setup(() => json({ success: true }));
      expect(await absent.verifier.verify('token-abc', undefined, 'login')).toBe('ok');
    });

    it('com chave real, só o hostname do WEB_ORIGIN passa', async () => {
      const same = setup(() => json({ success: true, hostname: 'painel.example' }), REAL_SHAPED_SITE_KEY);
      expect(await same.verifier.verify('token-abc', undefined, 'login')).toBe('ok');
    });

    it('na célula (CE-01), com chave real, vale o painel do cliente do endereço, não o WEB_ORIGIN', async () => {
      const tenantPanel = 'cliente-a.control.exemplo.com.br';
      const own = setup(() => json({ success: true, hostname: tenantPanel }), REAL_SHAPED_SITE_KEY);
      expect(await own.verifier.verify('token-abc', undefined, 'login', tenantPanel)).toBe('ok');
      for (const hostname of ['painel.example', 'cliente-b.control.exemplo.com.br']) {
        const other = setup(() => json({ success: true, hostname }), REAL_SHAPED_SITE_KEY);
        expect(await other.verifier.verify('token-abc', undefined, 'login', tenantPanel)).toBe('failed');
        expect(other.logged()).toContain('hostname-mismatch');
      }
    });

    it.each([
      ['outro site', 'outro.example'],
      ['subdomínio do painel', 'app.painel.example'],
      ['sem hostname', undefined],
    ])('com chave real, %s: "failed", com o motivo e sem o token no log', async (_label, hostname) => {
      const { verifier, logged, logger } = setup(
        () => json({ success: true, ...(hostname !== undefined && { hostname }) }),
        REAL_SHAPED_SITE_KEY,
      );
      expect(await verifier.verify('token-abc', undefined, 'login')).toBe('failed');
      expect(logger.warn).toHaveBeenCalledOnce();
      expect(logged()).toContain('hostname-mismatch');
      expect(logged()).not.toContain('token-abc');
      expect(logged()).not.toContain(SECRET);
    });
  });

  it.each([
    ['erro HTTP', () => json({ error: 'interno' }, 502)],
    ['JSON fora do formato', () => json({ ok: 'sim' })],
    ['corpo que não é JSON', () => Promise.resolve(new Response('nada', { status: 200 }))],
    [
      'falha de rede',
      () => Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })),
    ],
    // O que o `fetch` lança com `redirect: 'error'` ao receber um 3xx.
    ['redirecionamento', () => Promise.reject(new TypeError('fetch failed: unexpected redirect'))],
  ])('%s: "unavailable" (fecha), sem a chave nem o token no log', async (_label, response) => {
    const { verifier, logged, logger } = setup(response);
    expect(await verifier.verify('token-abc', undefined, 'login')).toBe('unavailable');
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logged()).not.toContain('token-abc');
    expect(logged()).not.toContain(SECRET);
  });
});
