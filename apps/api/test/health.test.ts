import 'reflect-metadata';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, inject, it } from 'vitest';
import { createApp } from './support/create-app.js';
import { LogCapture } from './support/log-capture.js';

describe('health check com banco disponível (T1.1)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp(inject('testDatabaseUrl'), new LogCapture());
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health responde 200 sem consultar o banco', async () => {
    await request(app.getHttpServer() as Server)
      .get('/health')
      .expect(200, { status: 'ok' });
  });

  it('GET /health/ready responde 200 quando o banco responde', async () => {
    await request(app.getHttpServer() as Server)
      .get('/health/ready')
      .expect(200, { status: 'ok' });
  });
});
