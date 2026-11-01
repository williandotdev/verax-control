import 'reflect-metadata';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { APP_CONFIG, type AppConfig } from '../src/common/config/config.module.js';
import { loadConfig } from '../src/common/config/load-config.js';
import { LogCapture } from './support/log-capture.js';

const testConfig: AppConfig = loadConfig({
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://localhost:5173',
  DATABASE_URL: 'postgresql://verax:unused@localhost:5432/verax_test',
});

describe('AppModule', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(testConfig, { logger: { destination: new LogCapture() } })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('expõe a configuração validada por injeção de dependência', () => {
    expect(app.get(APP_CONFIG)).toBe(testConfig);
  });

  it('responde 404 para rota inexistente', async () => {
    await request(app.getHttpServer() as Server)
      .get('/')
      .expect(404);
  });

  it('responde ao health check sem sessão e devolve o request id', async () => {
    const response = await request(app.getHttpServer() as Server)
      .get('/health')
      .expect(200, { status: 'ok' });
    expect(response.headers['x-request-id']).toBeTypeOf('string');
  });
});
