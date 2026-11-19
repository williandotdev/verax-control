import 'reflect-metadata';
import { generateKeyPairSync } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_CONFIG, type AppConfig } from '../src/common/config/config.module.js';
import { ConfigValidationError, loadConfig } from '../src/common/config/load-config.js';
import { createUser, signInRequest } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';

const consoleKey = generateKeyPairSync('ed25519');
const ssoEnv = {
  SSO_ISSUER: 'https://admin.example.com',
  SSO_CLIENT_ID: 'verax-siem',
  SSO_PUBLIC_KEY: String(consoleKey.publicKey.export({ format: 'jwk' }).x),
};

/**
 * O nó dedicado de um CLIENTE (qualquer plano que não o `interno`) nunca tem a entrada única pelo console: a
 * configuração recusa as variáveis (a API não sobe com elas), e sem elas as rotas não existem (404) e a configuração
 * pública não mostra o console. Fecha em falha: só o nó da própria Verax (`PLAN=interno`) a ganha.
 */
describe('nó dedicado de cliente: sem a entrada única', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createApp({ plan: { PLAN: 'profissional' } });
  });

  afterAll(async () => {
    await app.close();
  });

  it('a configuração com as variáveis da entrada única é recusada (a API não sobe)', () => {
    const base = {
      NODE_ENV: 'test',
      WEB_ORIGIN: 'http://localhost:5173',
      API_ORIGIN: 'https://api.cliente.example.com',
      BETTER_AUTH_SECRET: 'x'.repeat(43),
      CSRF_SECRET: 'y'.repeat(43),
      MAIL_FROM: 'nao-responda@verax.example',
      DATABASE_URL: 'postgresql://verax:secret@localhost:5432/verax',
    };
    for (const plan of ['essencial', 'profissional']) {
      expect(() => loadConfig({ ...base, PLAN: plan, ...ssoEnv }), plan).toThrow(ConfigValidationError);
      expect(
        () => loadConfig({ ...base, PLAN: plan, ...ssoEnv, STAFF_PASSWORD_LOGIN_DISABLED: 'true' }),
        plan,
      ).toThrow(ConfigValidationError);
    }
    // O mesmo ambiente com PLAN=interno (o nó da Verax) sobe com a entrada única.
    expect(loadConfig({ ...base, PLAN: 'interno', ...ssoEnv }).sso).not.toBeNull();
    expect(app.get<AppConfig>(APP_CONFIG).sso).toBeNull();
  });

  it('as rotas da entrada única não existem (404)', async () => {
    for (const path of ['/v1/auth/sso/start', '/v1/auth/sso/callback']) {
      await request(app.getHttpServer()).get(path).expect(404);
    }
  });

  it('a configuração pública não mostra o console, e o login com senha da equipe segue', async () => {
    const response = await request(app.getHttpServer()).get('/v1/auth/client-config').expect(200);
    expect(response.body).toEqual({ turnstileSiteKey: null, adminMasterUrl: null, nodePlatform: 'gcp' });
    const staff = await createUser(app, { role: 'admin_verax', tenantId: null });
    expect((await signInRequest(app, staff.email, staff.password)).status).toBe(200);
  });
});
