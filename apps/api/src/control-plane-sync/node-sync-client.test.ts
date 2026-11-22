import { NODE_SYNC_RESPONSE_MAX_BYTES, type NodeSyncRequest } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { clockSkewExceeded, postNodeSync } from './node-sync-client.js';

const URL_ = 'https://conta.exemplo.com.br/v1/node-sync';
const CREDENTIAL = 'cabecalho.corpo.assinatura';

const request: NodeSyncRequest = {
  protocol: 1,
  sequence: 1,
  sentAt: '2026-11-22T12:00:00.000Z',
  capabilities: ['log_sources'],
  node: {
    commit: '0123456789abcdef0123456789abcdef01234567',
    platform: 'gcp',
    mode: 'dedicated',
    tenantId: null,
    vaultKey: null,
    serviceAccountId: '123456789012345678901',
    egressIps: [],
    audience: 'https://verax.exemplo.com.br',
    error: null,
  },
  sources: [],
  users: [],
};

const okBody = { protocol: 1, generation: 3, pollAfterSeconds: 300, sources: [] };

/** Um fetch falso que guarda o pedido e responde o que o teste mandar. */
function fakeFetch(response: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    calls.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      init,
    });
    return Promise.resolve(response());
  };
  return { fetchImpl, calls };
}

const post = (fetchImpl: typeof fetch, signal = new AbortController().signal, extra = {}) =>
  postNodeSync(request, signal, { url: URL_, credential: CREDENTIAL, fetch: fetchImpl, ...extra });

describe('chamada ao POST /v1/node-sync', () => {
  it('manda o pedido conferido, com o Bearer, sem seguir redirecionamento, e lê a resposta pelo contrato', async () => {
    const { fetchImpl, calls } = fakeFetch(() => Response.json(okBody));
    expect(await post(fetchImpl)).toEqual({ ok: true, response: okBody });
    const init = calls[0]?.init;
    expect(calls[0]?.url).toBe(URL_);
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${CREDENTIAL}`);
    expect(JSON.parse(init?.body as string)).toEqual(request);
  });

  it('um pedido fora do contrato não sai (erro do nó)', async () => {
    const { fetchImpl, calls } = fakeFetch(() => Response.json(okBody));
    await expect(
      postNodeSync({ ...request, sequence: 0 }, new AbortController().signal, {
        url: URL_,
        credential: CREDENTIAL,
        fetch: fetchImpl,
      }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it.each([
    [401, 'unauthenticated'],
    [404, 'not_found'],
    [400, 'bad_request'],
    [429, 'rate_limited'],
    [500, 'unavailable'],
    [503, 'unavailable'],
    [418, 'unexpected_status'],
  ] as const)('%i vira %s', async (status, code) => {
    const { fetchImpl } = fakeFetch(() => new Response('{"error":"x"}', { status }));
    expect(await post(fetchImpl)).toMatchObject({ ok: false, code, status });
  });

  it('429 traz o Retry-After; 400 traz a diferença do relógio; 409 traz a sequência aceita, se vier', async () => {
    const rate = fakeFetch(() => new Response('', { status: 429, headers: { 'retry-after': '120' } }));
    expect(await post(rate.fetchImpl)).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 120 });

    const now = Date.parse('2026-11-22T12:00:00.000Z');
    const skewed = fakeFetch(
      () => new Response('', { status: 400, headers: { date: new Date(now + 15 * 60_000).toUTCString() } }),
    );
    const result = await post(skewed.fetchImpl, undefined, { now: () => now });
    expect(result).toMatchObject({ code: 'bad_request', clockSkewMs: 15 * 60_000 });
    expect(clockSkewExceeded(result.ok ? undefined : result.clockSkewMs)).toBe(true);
    expect(clockSkewExceeded(60_000)).toBe(false);

    const stale = fakeFetch(() => Response.json({ error: 'stale_sequence', sequence: 42 }, { status: 409 }));
    expect(await post(stale.fetchImpl)).toEqual({
      ok: false,
      code: 'stale_sequence',
      status: 409,
      acceptedSequence: 42,
    });
    const generic = fakeFetch(() => Response.json({ error: 'stale_sequence' }, { status: 409 }));
    expect(await post(generic.fetchImpl)).toEqual({ ok: false, code: 'stale_sequence', status: 409 });
  });

  it('resposta fora do contrato, que não é JSON ou maior que o limite: invalid_response', async () => {
    for (const body of [
      JSON.stringify({ ...okBody, extra: true }),
      JSON.stringify({ ...okBody, protocol: 2 }),
      JSON.stringify({ ...okBody, pollAfterSeconds: 5 }),
      'não é json',
      ' '.repeat(NODE_SYNC_RESPONSE_MAX_BYTES + 1),
    ]) {
      const { fetchImpl } = fakeFetch(() => new Response(body, { status: 200 }));
      expect(await post(fetchImpl)).toMatchObject({ ok: false, code: 'invalid_response' });
    }
    const declared = fakeFetch(
      () =>
        new Response('{}', {
          status: 200,
          headers: { 'content-length': String(NODE_SYNC_RESPONSE_MAX_BYTES + 1) },
        }),
    );
    expect(await post(declared.fetchImpl)).toMatchObject({ code: 'invalid_response' });
  });

  it('rede fora ou tempo esgotado: unavailable; o cancelamento do worker passa adiante', async () => {
    const down: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    expect(await post(down)).toEqual({ ok: false, code: 'unavailable' });
    const slow: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
      });
    expect(await post(slow, undefined, { timeoutMs: 20 })).toEqual({ ok: false, code: 'unavailable' });
    const controller = new AbortController();
    const pending = post(slow, controller.signal);
    controller.abort(new DOMException('o worker está parando', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
