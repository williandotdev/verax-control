import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './support/create-app.js';
import { fakeStripeKey } from './support/fake-stripe.js';
import { LogCapture } from './support/log-capture.js';

/**
 * Configuração do checkout incompleta (aqui: a chave da Stripe e as origens, sem as páginas de retorno, as versões
 * dos textos e os preços): o serviço sobe e responde `/health`, avisa na partida quais variáveis faltam (só os
 * nomes) e o checkout responde 503 `checkout_unavailable` em vez de derrubar o processo. A consulta de subdomínio
 * não depende dessa configuração. Um app por arquivo.
 */
describe('cp-public com a configuração do checkout incompleta (CP-03)', () => {
  const capture = new LogCapture();
  const stripeKey = fakeStripeKey('test', 'rk');
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createApp({
      role: 'public',
      capture,
      env: { SITE_ORIGINS: 'https://veraxsistemas.com.br', STRIPE_SECRET_KEY: stripeKey },
    });
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  it('sobe e responde /health', async () => {
    await request(app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
  });

  it('o checkout responde 503 checkout_unavailable, com a mensagem genérica', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/public/checkout')
      .send({ plan: 'essencial' })
      .expect(503);
    expect(response.body).toEqual({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'Serviço temporariamente indisponível',
      code: 'checkout_unavailable',
      requestId: response.headers['x-request-id'],
    });
  });

  it('a consulta de subdomínio funciona sem a configuração do checkout', async () => {
    await request(app.getHttpServer())
      .get('/v1/public/slugs/cliente-demo-a')
      .expect(200, { available: true });
  });

  it('avisa na partida quais variáveis faltam, só pelos nomes, sem o valor da chave', () => {
    const warning = capture.entries().find((entry) => entry['event'] === 'checkout_unconfigured');
    expect(warning).toMatchObject({
      severity: 'WARNING',
      missing: [
        'SITE_SUCCESS_URL',
        'SITE_CANCEL_URL',
        'TERMS_VERSION',
        'PRIVACY_VERSION',
        'DPA_VERSION',
        'STRIPE_PRICE_LOOKUP_ESSENCIAL',
        'STRIPE_PRICE_LOOKUP_PROFISSIONAL',
      ],
    });
    expect(capture.text).not.toContain(stripeKey);
  });
});
