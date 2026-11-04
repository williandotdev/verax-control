import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './support/create-app.js';

// Um app por arquivo: o nestjs-pino guarda o logger raiz em estado estático.
describe('cp-worker: health (CP-01)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createApp({ role: 'worker', nodeEnv: 'production', trustProxyHops: 1 });
  });

  afterAll(async () => {
    await app.close();
  });

  it('sobe com ROLE=worker em modo produção e responde /health', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
  });
});
