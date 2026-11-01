import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './support/create-app.js';
import { LogCapture } from './support/log-capture.js';

describe('health check com banco indisponível (T1.1)', () => {
  // Porta 1 em localhost: conexão recusada na hora. A senha marcada não pode aparecer em lugar nenhum.
  const unreachable = 'postgresql://verax:leak-db-password-2001@127.0.0.1:1/verax_test';
  const capture = new LogCapture();
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createApp({ databaseUrl: unreachable, capture });
  });

  afterAll(async () => {
    await app.close();
  });

  it('a API sobe e /health continua 200, para o ECS não reiniciar as tasks', async () => {
    await request(app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
  });

  it('GET /health/ready responde 503 genérico e o detalhe vai só para o log', async () => {
    const response = await request(app.getHttpServer()).get('/health/ready').expect(503);

    expect(response.body).toEqual({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'Serviço temporariamente indisponível',
      requestId: response.headers['x-request-id'],
    });
    expect(JSON.stringify(response.body)).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|leak-db-password/);

    const warning = capture.entries().find((entry) => entry['msg'] === 'banco indisponível no health check');
    expect(warning).toBeDefined();
    expect(capture.text).not.toContain('leak-db-password-2001');
  });
});
