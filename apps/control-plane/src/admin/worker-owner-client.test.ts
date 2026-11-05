import { describe, expect, it } from 'vitest';
import { HttpWorkerOwnerClient } from './worker-owner-client.js';

const WORKER_URL = 'https://cp-worker-123456789012.southamerica-east1.run.app';
const TENANT = '01JBTESTE0000000000000TEN1';
const OWNER = 'responsavel@exemplo.example';

function harness(response: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const audiences: string[] = [];
  const client = new HttpWorkerOwnerClient(
    `${WORKER_URL}/`,
    {
      get: (audience) => {
        audiences.push(audience);
        return Promise.resolve('token-de-identidade-de-teste');
      },
    },
    (input, init) => {
      calls.push({ url: input instanceof Request ? input.url : input.toString(), init: init ?? {} });
      return Promise.resolve(response());
    },
  );
  return { client, calls, audiences };
}

describe('cliente do console para as operações do responsável no cp-worker (CP-11)', () => {
  it('POST na rota interna com o token da conta do console (aud = WORKER_URL) e quem agiu no corpo', async () => {
    const h = harness(() => Response.json({ deletion: 'started', phase: 'delete', runId: 'x' }));
    const result = await h.client.deleteNow(TENANT, 'cliente-demo-a', OWNER);
    expect(result).toEqual({
      ok: true,
      status: 200,
      body: { deletion: 'started', phase: 'delete', runId: 'x' },
    });
    expect(h.audiences).toEqual([WORKER_URL]);
    expect(h.calls[0]?.url).toBe(`${WORKER_URL}/internal/tenants/${TENANT}/delete-now`);
    expect(h.calls[0]?.init.method).toBe('POST');
    expect(h.calls[0]?.init.redirect).toBe('error');
    expect((h.calls[0]?.init.headers as Record<string, string>).Authorization).toBe(
      'Bearer token-de-identidade-de-teste',
    );
    expect(JSON.parse(h.calls[0]?.init.body as string)).toEqual({
      confirmSlug: 'cliente-demo-a',
      actor: OWNER,
    });
  });

  it('cada operação no caminho e com o corpo dela', async () => {
    const h = harness(() => Response.json({}));
    await h.client.provision(TENANT, 'cliente-demo-a', OWNER);
    await h.client.resume(TENANT, OWNER);
    await h.client.exportLink(TENANT, 'postgres/verax-20261115T063000Z.dump', OWNER);
    await h.client.cancel(TENANT, 'cliente-demo-a', OWNER, new Date('2027-01-31T00:00:00Z'));
    await h.client.suspend(TENANT, 'cliente-demo-a', OWNER);
    await h.client.reactivate(TENANT, 'cliente-demo-a', OWNER);
    expect(h.calls.map((c) => c.url.split('/').at(-1))).toEqual([
      'provision',
      'resume',
      'export',
      'cancel',
      'suspend',
      'reactivate',
    ]);
    expect(JSON.parse(h.calls[0]?.init.body as string)).toEqual({
      confirmSlug: 'cliente-demo-a',
      actor: OWNER,
    });
    expect(JSON.parse(h.calls[3]?.init.body as string)).toEqual({
      confirmSlug: 'cliente-demo-a',
      actor: OWNER,
      at: '2027-01-31T00:00:00.000Z',
    });
  });

  it('erro do worker vira o código curto; sem resposta, worker_unreachable; id inválido nem sai', async () => {
    const refused = harness(() => Response.json({ code: 'not_canceled', message: 'x' }, { status: 409 }));
    expect(await refused.client.deleteNow(TENANT, 'a', OWNER)).toEqual({
      ok: false,
      status: 409,
      code: 'not_canceled',
    });
    const odd = harness(() => new Response('<html>', { status: 502 }));
    expect(await odd.client.suspend(TENANT, 'a', OWNER)).toEqual({
      ok: false,
      status: 502,
      code: 'worker_error',
    });
    const down = new HttpWorkerOwnerClient(WORKER_URL, { get: () => Promise.resolve('t') }, () =>
      Promise.reject(new Error(`falhou ${WORKER_URL}`)),
    );
    expect(await down.resume(TENANT, OWNER)).toEqual({ ok: false, status: 0, code: 'worker_unreachable' });
    await expect(refused.client.resume('../x', OWNER)).rejects.toThrow(TypeError);
    expect(
      () => new HttpWorkerOwnerClient('http://worker.example', { get: () => Promise.resolve('t') }),
    ).toThrow(TypeError);
  });
});
