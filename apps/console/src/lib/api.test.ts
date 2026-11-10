import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '@/mocks/server';
import { LOGIN_FAILED_MESSAGE } from '@/mocks/fake-auth';
import { ApiError, api, authApi, request, SessionExpiredError } from './api';

describe('cliente do console', () => {
  it('manda JSON na mesma origem, com o cookie da sessão e sem cabeçalho a mais', async () => {
    let seen: Headers | undefined;
    let body: unknown;
    server.use(
      http.put('*/v1/admin/cost-models/custos-teste-v2', async ({ request: incoming }) => {
        seen = incoming.headers;
        body = await incoming.json();
        return HttpResponse.json({ version: 'custos-teste-v2' });
      }),
    );
    await api.update('cost-models', 'custos-teste-v2', { currency: 'brl' });
    expect(seen?.get('content-type')).toBe('application/json');
    expect(seen?.get('x-requested-with')).toBeNull();
    expect(body).toEqual({ content: { currency: 'brl' } });
  });

  it('erro da API: status, código, problemas por campo e o relatório da recusa', async () => {
    server.use(
      http.post('*/v1/admin/pricing-tables/teste-v3/publish', () =>
        HttpResponse.json(
          {
            statusCode: 422,
            message: 'A tabela não passou na checagem de publicação.',
            code: 'publish_guard_failed',
            details: {
              costModelVersion: 'custos-teste-v1',
              report: { ok: false },
              issues: [{ path: 'a.b', message: 'x' }],
            },
          },
          { status: 422 },
        ),
      ),
    );
    const error = await api.publish('pricing-tables', 'teste-v3').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 422,
      code: 'publish_guard_failed',
      costModelVersion: 'custos-teste-v1',
      report: { ok: false },
      issues: [{ path: 'a.b', message: 'x' }],
    });
  });

  it('401 unauthenticated numa rota protegida é a sessão que terminou', async () => {
    server.use(
      http.get('*/v1/admin/me', () =>
        HttpResponse.json(
          { statusCode: 401, message: 'Não autenticado', code: 'unauthenticated' },
          { status: 401 },
        ),
      ),
    );
    await expect(request('GET', '/v1/admin/me')).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('o 401 da entrada é um erro comum, com a mensagem genérica da API', async () => {
    server.use(
      http.post('*/v1/admin/login', () =>
        HttpResponse.json(
          { statusCode: 401, message: LOGIN_FAILED_MESSAGE, code: 'login_failed' },
          { status: 401 },
        ),
      ),
    );
    const error = await authApi
      .login({ email: 'a@b.example', password: 'x', code: '000000' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(SessionExpiredError);
    expect(error).toMatchObject({ status: 401, code: 'login_failed', message: LOGIN_FAILED_MESSAGE });
  });

  it('204 da saída devolve undefined; resposta sem JSON é erro, não sessão vencida', async () => {
    server.use(
      http.post('*/v1/admin/logout', () => new HttpResponse(null, { status: 204 })),
      http.get(
        '*/v1/admin/me',
        () => new HttpResponse('<html>x</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
      ),
    );
    await expect(authApi.logout()).resolves.toBeUndefined();
    const error = await request('GET', '/v1/admin/me').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(SessionExpiredError);
  });
});
