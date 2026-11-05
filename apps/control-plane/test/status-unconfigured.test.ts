import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import { createApp } from './support/create-app.js';
import { fakeStripeKey } from './support/fake-stripe.js';
import { LogCapture } from './support/log-capture.js';

/**
 * Página de status sem a `COOKIE_KEY` (o segredo `cp-cookie-key` ainda vazio): o serviço sobe, avisa na partida o
 * nome do que falta e as três rotas respondem 503 `status_unavailable`, sem gravar nada nem chamar a Stripe. Um app
 * por arquivo.
 */
describe('cp-public sem a configuração da página de status (CP-05)', () => {
  const capture = new LogCapture();
  const documents = new MemoryDocumentStore();
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createApp({
      role: 'public',
      capture,
      documentStore: documents,
      env: { STRIPE_SECRET_KEY: fakeStripeKey('test', 'rk') },
    });
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  it('as rotas de status respondem 503 status_unavailable e nada é gravado', async () => {
    const server = app.getHttpServer();
    for (const call of [
      request(server).post('/v1/public/status/claim').send({ sessionId: 'cs_test_0123456789abcdef' }),
      request(server).get('/v1/public/status'),
      request(server).post('/v1/public/status/reveal').send({}),
    ]) {
      const response = await call.expect(503);
      expect(response.body).toMatchObject({ code: 'status_unavailable' });
    }
    expect(await documents.query('statusTokens')).toEqual([]);
  });

  it('avisa na partida só o nome do que falta', () => {
    expect(capture.entries().find((entry) => entry['event'] === 'status_unconfigured')).toMatchObject({
      severity: 'WARNING',
      missing: ['COOKIE_KEY'],
    });
  });
});
