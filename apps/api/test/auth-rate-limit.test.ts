import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH_RATE_LIMIT_RULES } from '../src/auth/auth.constants.js';
import { authPost, signInRequest, TEST_PASSWORD } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';

/**
 * Limite por IP ligado, atrás de um proxy confiável: cada teste usa um IP próprio no X-Forwarded-For
 * (o que só funciona porque o app confia em 1 salto, como atrás do ALB).
 */
describe('limite de tentativas por IP (T2.3)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createApp({ authRateLimit: true, trustProxyHops: 1 });
  });

  afterAll(async () => {
    await app.close();
  });

  it('login: passa do limite da janela, o IP recebe 429; outro IP continua liberado', async () => {
    const { max } = AUTH_RATE_LIMIT_RULES['/sign-in/email'];
    for (let i = 0; i < max; i += 1) {
      const response = await signInRequest(app, `ip-${i}@cliente.example`, TEST_PASSWORD).set(
        'X-Forwarded-For',
        '203.0.113.21',
      );
      expect(response.status).toBe(401);
    }
    await signInRequest(app, 'mais-um@cliente.example', TEST_PASSWORD)
      .set('X-Forwarded-For', '203.0.113.21')
      .expect(429);
    await signInRequest(app, 'outro-ip@cliente.example', TEST_PASSWORD)
      .set('X-Forwarded-For', '203.0.113.22')
      .expect(401);
  });

  it('verificação do código MFA: 5 por minuto por IP', async () => {
    const { max } = AUTH_RATE_LIMIT_RULES['/two-factor/verify-totp'];
    const statuses: number[] = [];
    for (let i = 0; i <= max; i += 1) {
      const response = await authPost(app, '/two-factor/verify-totp', '', { code: '000000' }).set(
        'X-Forwarded-For',
        '203.0.113.31',
      );
      statuses.push(response.status);
    }
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.slice(0, max)).not.toContain(429);
  });
});
