import type { NestExpressApplication } from '@nestjs/platform-express';
import Stripe from 'stripe';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import { createApp } from './support/create-app.js';
import { fakeStripeKey, fakeWebhookSigningValue } from './support/fake-stripe.js';

/**
 * O cp-worker não registra o webhook da Stripe (nem o leitor de corpo bruto), mesmo com a chave no ambiente: um
 * evento assinado recebe 404 e nada é gravado. Um app por arquivo.
 */
describe('cp-worker sem o webhook da Stripe (CP-04)', () => {
  const documents = new MemoryDocumentStore();
  const signingValue = fakeWebhookSigningValue();
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createApp({
      role: 'worker',
      documentStore: documents,
      // O segredo do webhook é só do cp-public (ROLE_ONLY): o worker nem sobe com ele.
      env: { STRIPE_SECRET_KEY: fakeStripeKey('test', 'rk') },
    });
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /v1/stripe/webhook não existe no worker', async () => {
    const payload = JSON.stringify({
      id: 'evt_test_fake_worker',
      object: 'event',
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      data: { object: { id: 'cs_test_fake_worker' } },
    });
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: signingValue });

    await request(app.getHttpServer())
      .post('/v1/stripe/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', header)
      .send(payload)
      .expect(404);
    expect(await documents.query('stripeEvents')).toHaveLength(0);
    await request(app.getHttpServer()).get('/health').expect(200);
  });
});
