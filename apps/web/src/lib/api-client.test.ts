import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiClient, ApiRequestError, UnexpectedResponseError } from './api-client';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function setup(responses: Response[], hooks = {}) {
  const queue = [...responses];
  const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => {
    const next = queue.shift();
    if (!next) throw new Error('fetch não esperado');
    return Promise.resolve(next);
  });
  const client = new ApiClient('https://api.example', hooks, fetchMock);
  const call = (index: number) => {
    const [input, init] = fetchMock.mock.calls[index] ?? [];
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input?.url ?? '');
    return { url, init: init ?? {} };
  };
  return { client, fetchMock, call };
}

const itemSchema = z.strictObject({ id: z.string() });

describe('ApiClient', () => {
  it('manda o cookie de sessão e valida a resposta', async () => {
    const { client, call } = setup([json(200, { id: 'a' })]);
    await expect(client.get('/v1/x', itemSchema)).resolves.toEqual({ id: 'a' });
    expect(call(0).url).toBe('https://api.example/v1/x');
    expect(call(0).init.credentials).toBe('include');
  });

  it('resposta fora do formato esperado vira erro, não chega à tela', async () => {
    const { client } = setup([json(200, { id: 'a', extra: 'inesperado' })]);
    await expect(client.get('/v1/x', itemSchema)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it('em escrita, busca o token CSRF uma vez e manda no header', async () => {
    const { client, call, fetchMock } = setup([
      json(200, { token: 'tok-1' }),
      json(201, { id: 'a' }),
      json(201, { id: 'b' }),
    ]);
    await client.post('/v1/x', { name: 'a' }, itemSchema);
    await client.post('/v1/x', { name: 'b' }, itemSchema);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(call(0).url).toBe('https://api.example/v1/csrf-token');
    expect((call(1).init.headers as Record<string, string>)['X-CSRF-Token']).toBe('tok-1');
    expect((call(2).init.headers as Record<string, string>)['X-CSRF-Token']).toBe('tok-1');
    expect(call(1).init.body).toBe(JSON.stringify({ name: 'a' }));
  });

  it('token recusado: renova e tenta de novo uma única vez', async () => {
    const { client, call } = setup([
      json(200, { token: 'velho' }),
      json(403, { code: 'CSRF_INVALID', message: 'x' }),
      json(200, { token: 'novo' }),
      json(201, { id: 'a' }),
    ]);
    await expect(client.post('/v1/x', {}, itemSchema)).resolves.toEqual({ id: 'a' });
    expect((call(3).init.headers as Record<string, string>)['X-CSRF-Token']).toBe('novo');
  });

  it('rotas de autenticação não pedem token CSRF (têm checagem de origem própria)', async () => {
    const { client, call, fetchMock } = setup([json(200, {})]);
    await client.post('/v1/auth/sign-out', {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((call(0).init.headers as Record<string, string>)['X-CSRF-Token']).toBeUndefined();
  });

  it('401 chama o login', async () => {
    const onUnauthorized = vi.fn();
    const { client } = setup([json(401, { message: 'Não autenticado' })], { onUnauthorized });
    await expect(client.get('/v1/me')).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('401 de rota de autenticação (senha errada) não é tratado como sessão expirada', async () => {
    const onUnauthorized = vi.fn();
    const { client } = setup([json(401, { message: 'Invalid' })], { onUnauthorized });
    await expect(client.post('/v1/auth/sign-in/email', {})).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('403 MFA_REQUIRED leva ao cadastro do MFA', async () => {
    const onMfaRequired = vi.fn();
    const { client } = setup([json(403, { code: 'MFA_REQUIRED', message: 'x' })], { onMfaRequired });
    await expect(client.get('/v1/x')).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    expect(onMfaRequired).toHaveBeenCalledOnce();
  });

  it('demais erros trazem status, mensagem, código, request id e problemas de validação', async () => {
    const { client } = setup([
      json(400, {
        message: 'Dados inválidos',
        requestId: 'req-1',
        issues: [{ path: 'name', code: 'too_small', message: 'Muito curto' }],
      }),
    ]);
    const error = await client.get('/v1/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({
      status: 400,
      message: 'Dados inválidos',
      requestId: 'req-1',
      issues: [{ path: 'name', message: 'Muito curto' }],
    });
  });

  it('204 resolve sem corpo', async () => {
    const { client } = setup([json(200, { token: 't' }), new Response(null, { status: 204 })]);
    await expect(client.delete('/v1/x/1')).resolves.toBeUndefined();
  });
});
