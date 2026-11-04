import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from './support/create-app.js';
import { LogCapture } from './support/log-capture.js';

describe('cp-public: health, cabeçalhos e erros (CP-01)', () => {
  const capture = new LogCapture();
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createApp({ role: 'public', capture });
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health responde 200 fora do prefixo /v1, sem consultar dependência', async () => {
    await request(app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
    await request(app.getHttpServer()).get('/v1/health').expect(404);
  });

  it('aplica os cabeçalhos de segurança da API e devolve o request id', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['cross-origin-resource-policy']).toBe('same-site');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reaproveita um request id válido vindo do proxy e troca um inválido', async () => {
    const valid = await request(app.getHttpServer())
      .get('/health')
      .set('x-request-id', 'hosting-trace-12345678');
    expect(valid.headers['x-request-id']).toBe('hosting-trace-12345678');
    const invalid = await request(app.getHttpServer())
      .get('/health')
      .set('x-request-id', '<script>alert(1)</script>');
    expect(invalid.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rota inexistente e JSON malformado saem com a resposta genérica e o request id', async () => {
    const notFound = await request(app.getHttpServer()).get('/v1/public/nada').expect(404);
    expect(notFound.body).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'Recurso não encontrado',
      requestId: notFound.headers['x-request-id'],
    });

    const malformed = await request(app.getHttpServer())
      .post('/v1/public/nada')
      .set('Content-Type', 'application/json')
      .send('{"quebrado":')
      .expect(400);
    expect(malformed.body).toMatchObject({ statusCode: 400, message: 'Requisição inválida' });
  });

  it('não gera log por requisição para o health check', async () => {
    const before = capture.lines.length;
    await request(app.getHttpServer()).get('/health').expect(200);
    // Uma requisição de controle depois garante que o log do health, se existisse, já teria sido escrito.
    await request(app.getHttpServer()).get('/v1/public/nada').expect(404);
    const newEntries = (): Record<string, unknown>[] => capture.entries().slice(before);
    await vi.waitFor(() =>
      expect(newEntries().some((entry) => entry['message'] === 'request completed')).toBe(true),
    );

    expect(newEntries().some((entry) => JSON.stringify(entry).includes('/health'))).toBe(false);
    const completed = newEntries().find((entry) => entry['message'] === 'request completed');
    expect(completed).toMatchObject({ severity: 'WARNING', req: { method: 'GET', url: '/v1/public/nada' } });
    expect(completed?.['req']).not.toHaveProperty('headers');
  });
});
