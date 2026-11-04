import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../test/support/fake-clock.js';
import { forgetLiveSecret, scrubString } from '../common/logger/sanitize.js';
import { MetadataIdTokenSource } from './id-token.js';
import { RevealGatewayError, WorkerRevealGateway } from './reveal-gateway.js';

const WORKER = 'https://cp-worker-123456789012.southamerica-east1.run.app';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(responses: Response[]): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: input instanceof Request ? input.url : input.toString(), init });
    const next = responses.shift();
    return next === undefined ? Promise.reject(new Error('sem resposta')) : Promise.resolve(next);
  }) as typeof fetch;
  return { fetchFn, calls };
}

function jwt(exp: number): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part({ exp })}.assinatura`;
}

const identity = {
  get: (): Promise<string> => Promise.resolve('eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjF9.assinatura'),
};

describe('WorkerRevealGateway', () => {
  it('chama o worker com o token do cp-public e devolve a revelação, com a senha já na máscara', async () => {
    const password = `Tmp-${randomBytes(15).toString('base64url')}`;
    const body = {
      panelUrl: 'https://cliente-demo-a.control.veraxsistemas.com.br',
      adminEmail: 'admin@cliente-demo-a.example',
      password,
      passwordExpiresAt: '2026-11-07T12:00:00.000Z',
    };
    const { fetchFn, calls } = fakeFetch([new Response(JSON.stringify(body), { status: 200 })]);
    const gateway = new WorkerRevealGateway(WORKER, identity, fetchFn);

    const revealed = await gateway.reveal({
      kind: 'cookie',
      token: 'v'.repeat(43),
      requestId: 'req-demo-00001',
    });

    expect(revealed).toEqual(body);
    expect(scrubString(`resposta com ${password}`)).not.toContain(password);
    forgetLiveSecret(password);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${WORKER}/internal/access/reveal`);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.redirect).toBe('error');
    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjF9.assinatura',
      'content-type': 'application/json',
      'x-request-id': 'req-demo-00001',
    });
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({ kind: 'cookie', token: 'v'.repeat(43) });
  });

  it.each([
    [404, { code: 'not_found' }, 'not_found'],
    [409, { code: 'already_revealed' }, 'already_revealed'],
    [409, { code: 'reveal_not_available' }, 'reveal_not_available'],
    [409, { code: 'inventado' }, 'already_revealed'],
    [410, {}, 'password_expired'],
    [503, { code: 'reveal_unavailable' }, 'reveal_unavailable'],
    [401, { code: 'unauthenticated' }, 'reveal_unavailable'],
    [500, 'não é JSON', 'reveal_unavailable'],
  ])('HTTP %i %j vira %s', async (status, body, code) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const { fetchFn } = fakeFetch([new Response(text, { status })]);
    const gateway = new WorkerRevealGateway(WORKER, identity, fetchFn);
    await expect(gateway.reveal({ kind: 'cookie', token: 'v'.repeat(43) })).rejects.toEqual(
      new RevealGatewayError(code as RevealGatewayError['code']),
    );
  });

  it('resposta 200 fora do contrato não passa', async () => {
    const { fetchFn } = fakeFetch([new Response(JSON.stringify({ panelUrl: 'http://x' }), { status: 200 })]);
    const gateway = new WorkerRevealGateway(WORKER, identity, fetchFn);
    await expect(gateway.reveal({ kind: 'email_reveal', token: 'v'.repeat(43) })).rejects.toBeInstanceOf(
      RevealGatewayError,
    );
  });
});

describe('MetadataIdTokenSource', () => {
  it('pede ao servidor de metadados com a audiência e o cabeçalho, e guarda até perto do vencimento', async () => {
    const clock = new FakeClock(new Date('2026-11-04T12:00:00.000Z'));
    const exp = Math.floor(clock.now().getTime() / 1000) + 3600;
    const first = jwt(exp);
    const second = jwt(exp + 3600);
    const { fetchFn, calls } = fakeFetch([
      new Response(first, { status: 200 }),
      new Response(second, { status: 200 }),
    ]);
    const source = new MetadataIdTokenSource(clock, fetchFn);

    expect(await source.get(WORKER)).toBe(first);
    expect(await source.get(WORKER)).toBe(first);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]?.url ?? '');
    expect(`${url.origin}${url.pathname}`).toBe(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity',
    );
    expect(url.searchParams.get('audience')).toBe(WORKER);
    expect(url.searchParams.get('format')).toBe('full');
    expect(calls[0]?.init?.headers).toEqual({ 'Metadata-Flavor': 'Google' });

    clock.advance(56 * 60_000);
    expect(await source.get(WORKER)).toBe(second);
    expect(calls).toHaveLength(2);
  });

  it('falha alto quando o servidor de metadados recusa ou devolve outra coisa', async () => {
    const clock = new FakeClock();
    const { fetchFn } = fakeFetch([new Response('', { status: 404 }), new Response('lixo', { status: 200 })]);
    const source = new MetadataIdTokenSource(clock, fetchFn);
    await expect(source.get(WORKER)).rejects.toThrow('404');
    await expect(source.get(WORKER)).rejects.toThrow('formato');
  });
});
