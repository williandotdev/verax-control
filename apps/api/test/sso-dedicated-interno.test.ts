import 'reflect-metadata';
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, randomUUID, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SSO_CLIENT_ID } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// O console de verdade (o cp-admin do plano de controle), no mesmo processo: o fluxo inteiro passa pelos dois apps.
import { AdminAuthService } from '../../control-plane/src/admin/auth/admin-auth.service.js';
import { newTotpSecret } from '../../control-plane/src/admin/auth/totp.js';
import { parseSsoSigningKey } from '../../control-plane/src/admin/sso/sso-keys.js';
import { MemoryDocumentStore } from '../../control-plane/src/firestore/memory-document-store.js';
import {
  MemoryAdminSecrets,
  sessionCookie,
  sessionIdFrom,
  totpAt,
} from '../../control-plane/test/support/admin-auth.js';
import { createApp as createConsoleApp } from '../../control-plane/test/support/create-app.js';
import { FakeClock } from '../../control-plane/test/support/fake-clock.js';
import { SSO_ATTEMPT_COOKIE } from '../src/auth/sso/sso-plugin.js';
import { SSO_FETCH, type SsoFetch } from '../src/auth/sso/token-exchange.js';
import { APP_CONFIG, type AppConfig } from '../src/common/config/config.module.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import {
  cookieHeader,
  createSignedInUser,
  createTenant,
  createUser,
  signInRequest,
} from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import { LogCapture } from './support/log-capture.js';

/** O console fictício (RFC 2606): o `iss` dos tokens. A troca chega ao console local pelo `SSO_FETCH` do teste. */
const ISSUER = 'https://admin.example.com';
/** O endereço da API do nó da Verax (fictício): o retorno da entrada única, na lista do console. */
const API_ORIGIN = 'https://api.verax.example.com';
const CALLBACK = `${API_ORIGIN}/v1/auth/sso/callback`;
const OWNER = `responsavel-${randomBytes(4).toString('hex')}@verax.example`;
const REFUSED = `${TEST_WEB_ORIGIN}/login?sso=recusado`;

const b64 = (value: unknown): string =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const opaque = (): string => randomBytes(32).toString('base64url');

/** O cookie do navegador para um nome (`nome=valor`), dos `Set-Cookie` de uma resposta. */
function cookieFrom(setCookie: string | string[] | undefined, name: string): string | undefined {
  return cookieHeader(setCookie)
    .split('; ')
    .find((pair) => pair.startsWith(`${name}=`));
}

/**
 * Entrada única no nó DEDICADO da Verax (`NODE_MODE=dedicated` com `PLAN=interno`; decisão de 16/11/2026): o servidor
 * do SIEM da própria Verax, que ainda não virou célula. O nó inteiro é o da equipe (sem endereço por cliente): o pedido
 * nasce sem cliente do endereço, a sessão é a de sempre do nó dedicado, e as conferências são as mesmas da célula
 * (`sso-admin-master.test.ts`): `state`, `nonce` e PKCE de uso único, `jti` gasto, `iss`, `aud` e validade, e só o
 * `admin_verax` que já existe, ativo, sem cliente e com o MFA do painel.
 */
describe('nó dedicado da Verax (PLAN=interno): entrada única pelo console', () => {
  const apiLog = new LogCapture();
  const consoleClock = new FakeClock(new Date(Date.now() - 60_000));
  const consoleSecrets = new MemoryAdminSecrets();
  const consoleKey = parseSsoSigningKey(consoleSecrets.sso ?? '');
  /** Troca o que o console responde na troca do código (o token forjado chega por aqui). */
  let exchangeOverride: ((init: RequestInit) => Promise<Response>) | undefined;
  let exchangeCalls = 0;
  let api: NestExpressApplication;
  let consoleApp: NestExpressApplication;
  let consolePort = 0;
  let consoleCookie = '';
  let prisma: PrismaService;
  const ownerPassword = `senha-${randomBytes(9).toString('base64url')}`;
  const ownerSecret = newTotpSecret();

  const fetcher: SsoFetch = async (input, init) => {
    exchangeCalls += 1;
    const url = new URL(input);
    if (url.origin !== ISSUER) throw new Error('a troca só vai ao console');
    if (exchangeOverride !== undefined) return exchangeOverride(init);
    return fetch(`http://127.0.0.1:${consolePort}${url.pathname}${url.search}`, init);
  };

  /** O início no SIEM: o cookie de pré-login e o pedido ao console. */
  async function start(): Promise<{ authorize: URL; ssoCookie: string }> {
    const response = await request(api.getHttpServer()).get('/v1/auth/sso/start').expect(302);
    const authorize = new URL(String(response.headers['location']));
    const ssoCookie = cookieFrom(response.headers['set-cookie'], SSO_ATTEMPT_COOKIE);
    expect(ssoCookie).toBeDefined();
    return { authorize, ssoCookie: ssoCookie ?? '' };
  }

  /** O console com a sessão do responsável: o retorno ao SIEM com o código. */
  async function authorizeAtConsole(authorize: URL): Promise<URL> {
    const response = await request(consoleApp.getHttpServer())
      .get(`${authorize.pathname}${authorize.search}`)
      .set('Cookie', consoleCookie)
      .set('Sec-Fetch-Site', 'same-site')
      .expect(303);
    return new URL(String(response.headers['location']));
  }

  function callback(url: URL, ssoCookie?: string) {
    const call = request(api.getHttpServer()).get(`${url.pathname}${url.search}`);
    return ssoCookie === undefined ? call : call.set('Cookie', ssoCookie);
  }

  async function flowUntilCallback(): Promise<{ back: URL; ssoCookie: string; nonce: string }> {
    const { authorize, ssoCookie } = await start();
    const back = await authorizeAtConsole(authorize);
    return { back, ssoCookie, nonce: authorize.searchParams.get('nonce') ?? '' };
  }

  function expectRefused(response: request.Response): void {
    expect(response.status).toBe(302);
    expect(response.headers['location']).toBe(REFUSED);
    expect(cookieHeader(response.headers['set-cookie'])).not.toMatch(/session_token=[^;\s]/);
  }

  async function refusalReasons(): Promise<string[]> {
    const rows = await prisma.auditLog.findMany({
      where: { action: 'auth.sso_login', outcome: 'denied' },
      select: { after: true },
    });
    return rows.map((row) => String((row.after as { reason?: unknown } | null)?.reason));
  }

  function idToken(claims: Record<string, unknown>, key?: KeyObject): string {
    const input = `${b64({ alg: 'EdDSA', typ: 'JWT', kid: consoleKey?.jwk.kid })}.${b64(claims)}`;
    const signer = key ?? consoleKey?.privateKey;
    if (signer === undefined) throw new Error('sem chave');
    return `${input}.${sign(null, Buffer.from(input), signer).toString('base64url')}`;
  }

  function claimsFor(nonce: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    return {
      iss: ISSUER,
      aud: SSO_CLIENT_ID,
      sub: 'b'.repeat(64),
      email: OWNER,
      nonce,
      iat: now,
      exp: now + 300,
      auth_time: now - 60,
      jti: opaque(),
      amr: ['pwd', 'otp'],
      ...overrides,
    };
  }

  function respondWith(token: string): void {
    exchangeOverride = () =>
      Promise.resolve(
        new Response(JSON.stringify({ id_token: token, token_type: 'Bearer', expires_in: 300 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
  }

  beforeAll(async () => {
    if (consoleKey === undefined) throw new Error('chave de teste inválida');
    api = await createApp({
      plan: { PLAN: 'interno' },
      apiOrigin: API_ORIGIN,
      capture: apiLog,
      sso: { issuer: ISSUER, publicKey: consoleKey.jwk.x },
      overrideProviders: [{ provide: SSO_FETCH, useValue: fetcher }],
    });
    prisma = api.get(PrismaService);
    // A conta da equipe no painel já existe (o SSO não cria ninguém), com a senha definitiva e o MFA do painel.
    await createSignedInUser(api, { email: OWNER, role: 'admin_verax', tenantId: null });

    consoleApp = await createConsoleApp({
      role: 'admin',
      nodeEnv: 'production',
      trustProxyHops: 1,
      documentStore: new MemoryDocumentStore(),
      clock: consoleClock,
      adminSecrets: consoleSecrets,
      env: {
        ADMIN_SECRETS_PROJECT_ID: 'projeto-exemplo',
        OWNER_PRINCIPALS: OWNER,
        SSO_ISSUER: ISSUER,
        SSO_REDIRECT_URIS: CALLBACK,
      },
    });
    await consoleApp.listen(0, '127.0.0.1');
    consolePort = (consoleApp.getHttpServer().address() as AddressInfo).port;
    await consoleApp.get(AdminAuthService).enrollOwner(
      {
        email: OWNER,
        password: ownerPassword,
        secret: ownerSecret,
        code: await totpAt(ownerSecret, consoleClock.now()),
        replace: false,
      },
      { email: 'operador@verax.example' },
    );
    consoleClock.advance(30_000);
    const login = await request(consoleApp.getHttpServer())
      .post('/v1/admin/login')
      .set('Content-Type', 'application/json')
      .send(
        JSON.stringify({
          email: OWNER,
          password: ownerPassword,
          code: await totpAt(ownerSecret, consoleClock.now()),
        }),
      )
      .expect(200);
    consoleCookie = sessionCookie(sessionIdFrom(login.headers['set-cookie']) ?? '');
  });

  beforeEach(() => {
    exchangeOverride = undefined;
    exchangeCalls = 0;
  });

  afterAll(async () => {
    await consoleApp.close();
    await api.close();
  });

  it('a configuração: o nó dedicado, sem célula, com a chave PÚBLICA do console', () => {
    const config = api.get<AppConfig>(APP_CONFIG);
    expect(config.NODE_MODE).toBe('dedicated');
    expect(config.PLAN).toBe('interno');
    expect(config.cell).toBeNull();
    expect(config.sso?.publicKey.type).toBe('public');
  });

  it('caminho feliz: SIEM → console → SIEM com a sessão normal do admin_verax, sem cliente do endereço', async () => {
    const { authorize, ssoCookie } = await start();
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${ISSUER}/sso/authorize`);
    expect(authorize.searchParams.get('redirect_uri')).toBe(CALLBACK);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    // O pedido gravado (pelo SHA-256 do cookie de pré-login) não tem cliente do endereço: o nó inteiro é o da equipe.
    const attemptId = createHash('sha256')
      .update(ssoCookie.slice(`${SSO_ATTEMPT_COOKIE}=`.length), 'utf8')
      .digest('hex');
    const attempt = await prisma.ssoLoginAttempt.findUnique({ where: { id: attemptId } });
    expect(attempt).not.toBeNull();
    expect(attempt?.hostTenantId).toBeNull();

    const back = await authorizeAtConsole(authorize);
    expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
    const response = await callback(back, ssoCookie).expect(302);
    expect(response.headers['location']).toBe(`${TEST_WEB_ORIGIN}/`);
    expect(response.headers['cache-control']).toContain('no-store');
    const cookies = cookieHeader(response.headers['set-cookie']);
    expect(cookies).toMatch(/session_token=[^;\s]/);
    expect(cookieFrom(response.headers['set-cookie'], SSO_ATTEMPT_COOKIE)).toBe(`${SSO_ATTEMPT_COOKIE}=`);

    const me = await request(api.getHttpServer()).get('/v1/me').set('Cookie', cookies).expect(200);
    expect(me.body).toMatchObject({ email: OWNER, role: 'admin_verax', mfaEnabled: true });
    const session = await prisma.session.findFirst({
      where: { user: { email: OWNER } },
      orderBy: { createdAt: 'desc' },
      select: { hostTenantId: true },
    });
    expect(session?.hostTenantId).toBeNull();
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'auth.sso_login', outcome: 'success', resourceId: OWNER },
      select: { resourceId: true },
    });
    expect(audit?.resourceId).toBe(OWNER);
    // O pedido foi gasto, e nada do código nem do state vai ao log.
    expect(await prisma.ssoLoginAttempt.count({ where: { id: attemptId } })).toBe(0);
    expect(apiLog.text).not.toContain(back.searchParams.get('code') ?? '-');
    expect(apiLog.text).not.toContain(back.searchParams.get('state') ?? '-');
  });

  it('o mesmo retorno de novo, ou sem o cookie de pré-login: recusado, sem sessão', async () => {
    const { back, ssoCookie } = await flowUntilCallback();
    await callback(back, ssoCookie).expect(302);
    expectRefused(await callback(back, ssoCookie));
    const fresh = await flowUntilCallback();
    expectRefused(await callback(fresh.back));
    expect(await refusalReasons()).toEqual(expect.arrayContaining(['unknown_attempt', 'missing_attempt']));
  });

  it('o mesmo jti duas vezes (token reaproveitado): a segunda é recusada', async () => {
    const jti = opaque();
    const first = await flowUntilCallback();
    respondWith(idToken(claimsFor(first.nonce, { jti })));
    const opened = await callback(first.back, first.ssoCookie).expect(302);
    expect(opened.headers['location']).toBe(`${TEST_WEB_ORIGIN}/`);
    const second = await flowUntilCallback();
    respondWith(idToken(claimsFor(second.nonce, { jti })));
    expectRefused(await callback(second.back, second.ssoCookie));
    expect(await refusalReasons()).toContain('replayed_token');
  });

  it('state trocado, iss diferente, token de outra chave ou de outro público: recusados', async () => {
    const victim = await flowUntilCallback();
    const attacker = await flowUntilCallback();
    expectRefused(await callback(attacker.back, victim.ssoCookie));
    const mixed = await flowUntilCallback();
    mixed.back.searchParams.set('iss', 'https://evil.example');
    expectRefused(await callback(mixed.back, mixed.ssoCookie));
    expect(exchangeCalls).toBe(0);

    const otherKey = await flowUntilCallback();
    respondWith(idToken(claimsFor(otherKey.nonce), generateKeyPairSync('ed25519').privateKey));
    expectRefused(await callback(otherKey.back, otherKey.ssoCookie));
    const otherAudience = await flowUntilCallback();
    respondWith(idToken(claimsFor(otherAudience.nonce, { aud: 'outro-cliente' })));
    expectRefused(await callback(otherAudience.back, otherAudience.ssoCookie));
    expect(await refusalReasons()).toEqual(
      expect.arrayContaining(['state_mismatch', 'issuer_mismatch', 'token_rejected']),
    );
  });

  describe('quem o nó aceita (nenhum usuário é criado)', () => {
    async function refusedFor(email: string): Promise<void> {
      const { back, ssoCookie, nonce } = await flowUntilCallback();
      respondWith(idToken(claimsFor(nonce, { email })));
      expectRefused(await callback(back, ssoCookie));
    }

    it('outro e-mail (desconhecido): recusado, e nenhum usuário nasce', async () => {
      const email = `desconhecido-${randomUUID()}@verax.example`;
      await refusedFor(email);
      expect(await prisma.user.count({ where: { email } })).toBe(0);
    });

    it('outro papel (do cliente do nó), inativo ou sem MFA: recusados', async () => {
      const tenant = await createTenant(api);
      const customerAdmin = await createSignedInUser(api, { role: 'admin_cliente', tenantId: tenant });
      const analyst = await createSignedInUser(api, { role: 'analista_cliente', tenantId: tenant });
      const disabled = await createUser(api, { role: 'admin_verax', tenantId: null, status: 'disabled' });
      const withoutMfa = await createUser(api, { role: 'admin_verax', tenantId: null });
      const users = [customerAdmin, analyst, disabled, withoutMfa];
      for (const user of users) await refusedFor(user.email);
      const rows = await prisma.auditLog.findMany({
        where: {
          action: 'auth.sso_login',
          outcome: 'denied',
          resourceId: { in: users.map((user) => user.email) },
        },
        select: { after: true },
      });
      expect(rows.map((row) => (row.after as { reason?: unknown } | null)?.reason)).toEqual(
        users.map(() => 'user_refused'),
      );
    });
  });

  it('a configuração pública mostra o console (o botão e o item do menu do painel)', async () => {
    const response = await request(api.getHttpServer()).get('/v1/auth/client-config').expect(200);
    expect(response.body).toEqual({
      turnstileSiteKey: null,
      adminMasterUrl: `${ISSUER}/`,
      nodePlatform: 'gcp',
    });
  });

  it('o login com senha do painel continua valendo para a equipe (o interruptor vem desligado)', async () => {
    const user = await createUser(api, { role: 'admin_verax', tenantId: null });
    expect((await signInRequest(api, user.email, user.password)).status).toBe(200);
  });
});
