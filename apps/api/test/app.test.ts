import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_CONFIG, type AppConfig } from '../src/common/config/config.module.js';
import { createApp } from './support/create-app.js';

describe('AppModule', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('expõe a configuração validada por injeção de dependência', () => {
    expect(app.get<AppConfig>(APP_CONFIG).NODE_ENV).toBe('test');
  });

  it('responde 404 genérico para rota inexistente, sem repetir o caminho pedido', async () => {
    const response = await request(app.getHttpServer()).get('/v1/<script>alert(1)</script>').expect(404);
    expect(response.body).toMatchObject({ statusCode: 404, message: 'Recurso não encontrado' });
    expect(JSON.stringify(response.body)).not.toContain('script');
  });

  it('responde ao health check sem sessão, fora do prefixo /v1, e devolve o request id', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
    expect(response.headers['x-request-id']).toBeTypeOf('string');
    await request(app.getHttpServer()).get('/v1/health').expect(404);
  });
});
