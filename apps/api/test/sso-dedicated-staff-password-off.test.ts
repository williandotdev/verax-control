import 'reflect-metadata';
import { generateKeyPairSync } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SSO_FETCH, type SsoFetch } from '../src/auth/sso/token-exchange.js';
import { createTenant, createUser, signInRequest } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';

/** A recusa do login com senha errada, do Better Auth: a do interruptor é a mesma. */
const INVALID_CREDENTIALS = { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' };

/**
 * O interruptor `STAFF_PASSWORD_LOGIN_DISABLED` no nó dedicado da Verax (`PLAN=interno`): ligado, o `admin_verax` só
 * entra pelo "Entrar com o Admin master", com a recusa da senha errada; os outros papéis do nó entram com senha como
 * sempre. A mesma regra da célula (`sso-staff-password-off.test.ts`), no nó inteiro.
 */
describe('nó dedicado da Verax: login da equipe só pela entrada única', () => {
  let app: NestExpressApplication;
  const consoleKey = generateKeyPairSync('ed25519');
  const fetcher: SsoFetch = () => Promise.reject(new Error('nenhuma troca neste teste'));

  beforeAll(async () => {
    app = await createApp({
      plan: { PLAN: 'interno' },
      apiOrigin: 'https://api.verax.example.com',
      sso: {
        issuer: 'https://admin.example.com',
        publicKey: String(consoleKey.publicKey.export({ format: 'jwk' }).x),
        staffPasswordLoginDisabled: true,
      },
      overrideProviders: [{ provide: SSO_FETCH, useValue: fetcher }],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('o admin_verax com a senha certa recebe a recusa da senha errada; nenhuma sessão nasce', async () => {
    const staff = await createUser(app, { role: 'admin_verax', tenantId: null });
    const right = await signInRequest(app, staff.email, staff.password);
    const wrong = await signInRequest(app, staff.email, `${staff.password}-errada`);
    expect(right.status).toBe(401);
    expect(right.body).toEqual(INVALID_CREDENTIALS);
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual(INVALID_CREDENTIALS);
    expect(right.headers['set-cookie'] ?? []).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/session_token=[^;\s]/)]),
    );
  });

  it('o usuário do cliente do nó entra com senha como sempre', async () => {
    const tenant = await createTenant(app);
    const customer = await createUser(app, { role: 'admin_cliente', tenantId: tenant });
    expect((await signInRequest(app, customer.email, customer.password)).status).toBe(200);
  });

  it('a entrada única continua no ar (o início manda ao console)', async () => {
    const response = await request(app.getHttpServer()).get('/v1/auth/sso/start').expect(302);
    expect(String(response.headers['location'])).toMatch(/^https:\/\/admin\.example\.com\/sso\/authorize\?/);
  });
});
