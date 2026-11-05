import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '@/mocks/server';
import { ApiError, api, request, SessionExpiredError } from './api';

describe('cliente do console', () => {
  it('manda JSON na mesma origem, com o pedido de 401 ao IAP em vez do redirecionamento', async () => {
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
    expect(seen?.get('x-requested-with')).toBe('XMLHttpRequest');
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

  it('o IAP respondeu no lugar do console (sessão vencida): pede para recarregar', async () => {
    server.use(
      http.get(
        '*/v1/admin/me',
        () =>
          new HttpResponse('<html>login</html>', { status: 401, headers: { 'Content-Type': 'text/html' } }),
      ),
    );
    await expect(request('GET', '/v1/admin/me')).rejects.toBeInstanceOf(SessionExpiredError);
  });
});
