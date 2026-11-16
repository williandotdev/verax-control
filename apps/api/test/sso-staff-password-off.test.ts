import 'reflect-metadata';
import { generateKeyPairSync } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH_RATE_LIMIT_RULES } from '../src/auth/auth.constants.js';
import { SSO_FETCH, type SsoFetch } from '../src/auth/sso/token-exchange.js';
import { createUser } from './support/auth-helpers.js';
import { createCellTenant, onHost, signInOnHost, testCell, uniqueSlug } from './support/cell.js';
import { createApp } from './support/create-app.js';

const CELL = testCell();
const STAFF = CELL.staffSlug;
const CUSTOMER = uniqueSlug('cliente');

/** A recusa do login com senha errada, do Better Auth: a do interruptor é a mesma. */
const INVALID_CREDENTIALS = { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' };

/**
 * O interruptor `STAFF_PASSWORD_LOGIN_DISABLED` (desligado por padrão): ligado, o `admin_verax` só entra pelo
 * "Entrar com o Admin master" no endereço da equipe, e a recusa do login com senha é a mesma da senha errada. Os clientes
 * da célula não mudam. E o limite por IP das rotas da entrada única, com o limite ligado como em produção.
 */
describe('célula: login da equipe só pela entrada única', () => {
  let app: NestExpressApplication;
  let customerTenant = '';
  const consoleKey = generateKeyPairSync('ed25519');
  const fetcher: SsoFetch = () => Promise.reject(new Error('nenhuma troca neste teste'));

  beforeAll(async () => {
    app = await createApp({
      cell: CELL,
      authRateLimit: true,
      sso: {
        issuer: 'https://admin.example.com',
        publicKey: String(consoleKey.publicKey.export({ format: 'jwk' }).x),
        staffPasswordLoginDisabled: true,
      },
      overrideProviders: [{ provide: SSO_FETCH, useValue: fetcher }],
    });
    await createCellTenant(app, STAFF);
    customerTenant = await createCellTenant(app, CUSTOMER);
  });

  afterAll(async () => {
    await app.close();
  });

  it('o admin_verax com a senha certa recebe a recusa da senha errada; nenhuma sessão nasce', async () => {
    const staff = await createUser(app, { role: 'admin_verax', tenantId: null });
    const right = await signInOnHost(app, STAFF, staff.email, staff.password);
    const wrong = await signInOnHost(app, STAFF, staff.email, `${staff.password}-errada`);
    expect(right.status).toBe(401);
    expect(right.body).toEqual(INVALID_CREDENTIALS);
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual(INVALID_CREDENTIALS);
    expect(right.headers['set-cookie'] ?? []).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/session_token=[^;\s]/)]),
    );
  });

  it('o cliente da célula entra com senha como sempre', async () => {
    const customer = await createUser(app, { role: 'admin_cliente', tenantId: customerTenant });
    const response = await signInOnHost(app, CUSTOMER, customer.email, customer.password);
    expect(response.status).toBe(200);
  });

  it('o início da entrada única tem limite por IP (429 depois do teto)', async () => {
    const { max } = AUTH_RATE_LIMIT_RULES['/sso/start'];
    const statuses: number[] = [];
    for (let index = 0; index <= max; index += 1) {
      const response = await onHost(app, STAFF)('get', '/v1/auth/sso/start').set(
        'X-Forwarded-For',
        '203.0.113.9',
      );
      statuses.push(response.status);
    }
    expect(statuses.slice(0, max).every((status) => status === 302)).toBe(true);
    expect(statuses[max]).toBe(429);
  });
});
