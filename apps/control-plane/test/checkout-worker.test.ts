import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './support/create-app.js';
import { fakeStripeKey } from './support/fake-stripe.js';

const SITE = 'https://veraxsistemas.com.br';

/**
 * O cp-worker não registra as rotas públicas do checkout nem responde CORS, mesmo com a configuração do site e da
 * Stripe no ambiente (o Terraform dá as variáveis comuns aos dois serviços). Um app por arquivo.
 */
describe('cp-worker sem as rotas do checkout (CP-03)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createApp({
      role: 'worker',
      env: {
        SITE_ORIGINS: SITE,
        SITE_SUCCESS_URL: `${SITE}/checkout/sucesso?cs={CHECKOUT_SESSION_ID}`,
        SITE_CANCEL_URL: `${SITE}/#planos`,
        TERMS_VERSION: '2026-11-04',
        PRIVACY_VERSION: '2026-11-04',
        DPA_VERSION: '2026-11-04',
        STRIPE_SECRET_KEY: fakeStripeKey('test', 'rk'),
        STRIPE_PRICE_LOOKUP_ESSENCIAL: 'verax_control_essencial_mensal',
        STRIPE_PRICE_LOOKUP_PROFISSIONAL: 'verax_control_profissional_mensal',
      },
    });
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /v1/public/checkout e GET /v1/public/slugs/:slug não existem no worker', async () => {
    await request(app.getHttpServer())
      .post('/v1/public/checkout')
      .set('Origin', SITE)
      .send({ plan: 'essencial' })
      .expect(404);
    await request(app.getHttpServer()).get('/v1/public/slugs/cliente-demo-a').expect(404);
    await request(app.getHttpServer()).get('/health').expect(200);
  });

  it('nem a origem do site recebe cabeçalho de CORS no worker', async () => {
    const preflight = await request(app.getHttpServer())
      .options('/v1/public/checkout')
      .set('Origin', SITE)
      .set('Access-Control-Request-Method', 'POST');
    expect(preflight.status).toBe(404);
    expect(Object.keys(preflight.headers).filter((header) => header.startsWith('access-control-'))).toEqual(
      [],
    );
  });
});
