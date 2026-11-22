import type { NodeSyncRequest } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { NodeSyncGatewayError, WorkerNodeSyncGateway } from './node-sync-gateway.js';

const WORKER_URL = 'https://cp-worker-123456789012.southamerica-east1.run.app';
const IDENTITY = { get: (audience: string) => Promise.resolve(`identidade-para-${audience}`) };
const CREDENTIAL = { kind: 'node_key', nodeKey: 'A'.repeat(43) } as const;
const REQUEST = { protocol: 1 } as unknown as NodeSyncRequest;
const RESPONSE = { protocol: 1, generation: 3, pollAfterSeconds: 300, sources: [] };

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: Call[] = [];
  const fn: typeof fetch = (url, init) => {
    calls.push({ url: url instanceof Request ? url.url : url.toString(), init: init ?? {} });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return Promise.resolve(new Response(text, { status, headers }));
  };
  return { calls, fn };
}

async function failure(promise: Promise<unknown>): Promise<NodeSyncGatewayError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof NodeSyncGatewayError) return error;
    throw error;
  }
  throw new Error('esperava a recusa');
}

/** O caminho do cp-public até o cp-worker (`POST /internal/node-sync`), com o `fetch` num dublê. */
describe('WorkerNodeSyncGateway', () => {
  it('manda a credencial e o pedido com o token do cp-public e confere a resposta do protocolo', async () => {
    const fetch = fakeFetch(200, RESPONSE);
    const gateway = new WorkerNodeSyncGateway(WORKER_URL, IDENTITY, fetch.fn);
    expect(await gateway.sync(CREDENTIAL, REQUEST, 'req-00000001')).toEqual(RESPONSE);
    const [call] = fetch.calls;
    expect(call?.url).toBe(`${WORKER_URL}/internal/node-sync`);
    expect(call?.init.method).toBe('POST');
    expect(call?.init.redirect).toBe('error');
    expect(call?.init.headers).toMatchObject({
      authorization: `Bearer identidade-para-${WORKER_URL}`,
      'x-request-id': 'req-00000001',
    });
    expect(JSON.parse(call?.init.body as string)).toEqual({ credential: CREDENTIAL, request: REQUEST });
  });

  it('traduz o status do worker no código que o nó vê; o resto é unavailable', async () => {
    const cases: [number, unknown, string][] = [
      [400, { code: 'invalid_request' }, 'invalid_request'],
      [400, { code: 'clock_skew' }, 'clock_skew'],
      [400, 'não é JSON', 'invalid_request'],
      [401, {}, 'unauthenticated'],
      [403, {}, 'unavailable'],
      [404, {}, 'not_found'],
      [409, {}, 'stale_sequence'],
      [500, {}, 'unavailable'],
      [503, {}, 'unavailable'],
    ];
    for (const [status, body, code] of cases) {
      const gateway = new WorkerNodeSyncGateway(WORKER_URL, IDENTITY, fakeFetch(status, body).fn);
      expect((await failure(gateway.sync(CREDENTIAL, REQUEST))).code, String(status)).toBe(code);
    }
  });

  it('429 leva o Retry-After do worker (fora da faixa, 20 s)', async () => {
    const limited = new WorkerNodeSyncGateway(
      WORKER_URL,
      IDENTITY,
      fakeFetch(429, {}, { 'retry-after': '7' }).fn,
    );
    expect(await failure(limited.sync(CREDENTIAL, REQUEST))).toMatchObject({
      code: 'too_soon',
      retryAfterSeconds: 7,
    });
    const odd = new WorkerNodeSyncGateway(
      WORKER_URL,
      IDENTITY,
      fakeFetch(429, {}, { 'retry-after': 'x' }).fn,
    );
    expect(await failure(odd.sync(CREDENTIAL, REQUEST))).toMatchObject({ retryAfterSeconds: 20 });
  });

  it('uma resposta 200 fora do protocolo não chega ao nó', async () => {
    for (const body of ['{', { ...RESPONSE, extra: true }, { ...RESPONSE, pollAfterSeconds: 5 }]) {
      const gateway = new WorkerNodeSyncGateway(WORKER_URL, IDENTITY, fakeFetch(200, body).fn);
      expect((await failure(gateway.sync(CREDENTIAL, REQUEST))).code).toBe('unavailable');
    }
  });
});
