import { describe, expect, it, vi } from 'vitest';
import { createTurnstileVerifier, TURNSTILE_TOKEN_MAX_LENGTH } from './turnstile.js';

const SECRET = 'segredo-de-teste-nao-pode-vazar';
const URL = 'http://127.0.0.1:1/siteverify';

function setup(response: () => Promise<Response>) {
  const fetchImpl = vi.fn((_input: string | URL | Request, _init?: RequestInit) => response());
  const logger = { warn: vi.fn(), error: vi.fn() };
  const verifier = createTurnstileVerifier(
    { TURNSTILE_SECRET_KEY: SECRET, TURNSTILE_SITEVERIFY_URL: URL },
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
      { TURNSTILE_SECRET_KEY: undefined, TURNSTILE_SITEVERIFY_URL: URL },
      { warn: vi.fn(), error: vi.fn() },
    );
    expect(verifier).toBeUndefined();
  });

  it('manda chave, token e IP ao siteverify e aceita a resposta de sucesso', async () => {
    const { verifier, fetchImpl } = setup(() => json({ success: true, 'error-codes': [], extra: 1 }));
    expect(await verifier.verify('token-abc', '203.0.113.9')).toBe('ok');
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(URL);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      secret: SECRET,
      response: 'token-abc',
      remoteip: '203.0.113.9',
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('sem token (ou vazio) é "required", sem chamar a rede', async () => {
    const { verifier, fetchImpl } = setup(() => json({ success: true }));
    expect(await verifier.verify(undefined, undefined)).toBe('required');
    expect(await verifier.verify(null, undefined)).toBe('required');
    expect(await verifier.verify('', undefined)).toBe('required');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('token acima do limite é recusado sem ir à rede, e o token não vai para o log', async () => {
    const { verifier, fetchImpl, logged } = setup(() => json({ success: true }));
    const token = 'x'.repeat(TURNSTILE_TOKEN_MAX_LENGTH + 1);
    expect(await verifier.verify(token, undefined)).toBe('failed');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logged()).not.toContain(token);
  });

  it('resposta de recusa vira "failed", com só os códigos de erro no log', async () => {
    const { verifier, logged } = setup(() =>
      json({ success: false, 'error-codes': ['timeout-or-duplicate'], hostname: 'painel.example' }),
    );
    expect(await verifier.verify('token-abc', undefined)).toBe('failed');
    expect(logged()).toContain('timeout-or-duplicate');
    expect(logged()).not.toContain('token-abc');
    expect(logged()).not.toContain(SECRET);
  });

  it.each([
    ['erro HTTP', () => json({ error: 'interno' }, 502)],
    ['JSON fora do formato', () => json({ ok: 'sim' })],
    ['corpo que não é JSON', () => Promise.resolve(new Response('nada', { status: 200 }))],
    [
      'falha de rede',
      () => Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })),
    ],
  ])('%s: "unavailable" (fecha), sem a chave nem o token no log', async (_label, response) => {
    const { verifier, logged, logger } = setup(response);
    expect(await verifier.verify('token-abc', undefined)).toBe('unavailable');
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logged()).not.toContain('token-abc');
    expect(logged()).not.toContain(SECRET);
  });
});
