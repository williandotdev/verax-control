import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, inject, it } from 'vitest';
import { createApp } from './support/create-app.js';

describe('health check com banco disponível (T1.1)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createApp({ databaseUrl: inject('testDatabaseUrl') });
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health responde 200 sem consultar o banco', async () => {
    await request(app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
  });

  it('GET /health/ready responde 200 quando o banco responde', async () => {
    await request(app.getHttpServer()).get('/health/ready').expect(200, { status: 'ok' });
  });
});
