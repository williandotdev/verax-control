import 'reflect-metadata';
import { createHmac, generateKeyPairSync, type KeyObject, randomBytes, randomUUID, sign } from 'node:crypto';
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
import { cookieHeader, createUser } from './support/auth-helpers.js';
import {
  apiHostOf,
  createCellTenant,
  createSignedInUserOnHost,
  onHost,
  panelOf,
  testCell,
  uniqueSlug,
} from './support/cell.js';
import { createApp } from './support/create-app.js';
import { LogCapture } from './support/log-capture.js';

const CELL = testCell();
const STAFF = CELL.staffSlug;
const CUSTOMER = uniqueSlug('cliente');
/** O console fictício (RFC 2606): o `iss` dos tokens. A troca chega ao console local pelo `SSO_FETCH` do teste. */
const ISSUER = 'https://admin.example.com';
const CALLBACK = `https://${apiHostOf(STAFF)}/v1/auth/sso/callback`;
const OWNER = `responsavel-${randomBytes(4).toString('hex')}@verax.example`;
const REFUSED = `${panelOf(STAFF)}/login?sso=recusado`;

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
 * Entrada única no SIEM da Verax pelo console do responsável, de ponta a ponta, com os DOIS apps de verdade: o console
 * (`cp-admin`, Firestore em memória) e a API da célula (Postgres de teste), no endereço da equipe. O "navegador" é o
 * teste: guarda o cookie de cada endereço e segue os redirecionamentos. A troca do código vai da API ao console local
 * pelo `SSO_FETCH` (em produção, o `fetch` do Node até `https://admin...`).
 *
 * Além do caminho feliz: o token forjado (outra chave, `alg: none`, HS256 com a chave pública, vencido, `aud`, `iss` e
 * `nonce` errados, `jti` repetido), o código reusado, o `state` trocado (CSRF), o retorno de outro endereço, o e-mail
 * desconhecido ou de quem não é `admin_verax`, a saída do console que derruba o código e a célula sem como assinar nada.
 */
describe('entrada única: o console como provedor de identidade do SIEM', () => {
  const apiLog = new LogCapture();
  const consoleClock = new FakeClock(new Date(Date.now() - 60_000));
  const consoleDocuments = new MemoryDocumentStore();
  const consoleSecrets = new MemoryAdminSecrets();
  const consoleKey = parseSsoSigningKey(consoleSecrets.sso ?? '');
  /** Troca o que o console responde na troca do código (o token forjado chega por aqui). */
  let exchangeOverride: ((init: RequestInit) => Promise<Response>) | undefined;
  let exchangeCalls = 0;
  let api: NestExpressApplication;
  let consoleApp: NestExpressApplication;
  let consolePort = 0;
  let consoleCookie = '';
  let staffTenant = '';
  let customerTenant = '';
  let prisma: PrismaService;
  const ownerPassword = `senha-${randomBytes(9).toString('base64url')}`;
  const ownerSecret = newTotpSecret();

  /** O login do responsável no console (a senha e o código do próximo passo do aplicativo). */
  async function loginToConsole(): Promise<void> {
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
  }

  const fetcher: SsoFetch = async (input, init) => {
    exchangeCalls += 1;
    const url = new URL(input);
    if (url.origin !== ISSUER) throw new Error('a troca só vai ao console');
    if (exchangeOverride !== undefined) return exchangeOverride(init);
    return fetch(`http://127.0.0.1:${consolePort}${url.pathname}${url.search}`, init);
  };

  const staff = () => onHost(api, STAFF);

  /** O início no SIEM: o cookie de pré-login e o pedido ao console. */
  async function start(): Promise<{ authorize: URL; ssoCookie: string }> {
    const response = await staff()('get', '/v1/auth/sso/start').expect(302);
    const authorize = new URL(String(response.headers['location']));
    const ssoCookie = cookieFrom(response.headers['set-cookie'], SSO_ATTEMPT_COOKIE);
    expect(ssoCookie).toBeDefined();
    const line = [response.headers['set-cookie']]
      .flat()
      .find((value) => value?.startsWith(SSO_ATTEMPT_COOKIE));
    expect(line).toMatch(/HttpOnly/i);
    expect(line).toMatch(/Secure/i);
    expect(line).toMatch(/SameSite=Strict/i);
    expect(line).toMatch(/Path=\//);
    return { authorize, ssoCookie: ssoCookie ?? '' };
  }

  /** O console com a sessão do responsável: o retorno ao SIEM com o código. */
  async function authorizeAtConsole(authorize: URL, cookie = consoleCookie): Promise<URL> {
    const response = await request(consoleApp.getHttpServer())
      .get(`${authorize.pathname}${authorize.search}`)
      .set('Cookie', cookie)
      .set('Sec-Fetch-Site', 'same-site')
      .expect(303);
    return new URL(String(response.headers['location']));
  }

  function callback(target: URL | string, ssoCookie?: string) {
    const url = typeof target === 'string' ? new URL(target) : target;
    const call = staff()('get', `${url.pathname}${url.search}`);
    return ssoCookie === undefined ? call : call.set('Cookie', ssoCookie);
  }

  /** O fluxo inteiro até o retorno (sem segui-lo). */
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

  /** As recusas gravadas na trilha (o motivo fica em `after.reason`). */
  async function refusalReasons(): Promise<string[]> {
    const rows = await prisma.auditLog.findMany({
      where: { action: 'auth.sso_login', outcome: 'denied' },
      select: { after: true },
    });
    return rows.map((row) => String((row.after as { reason?: unknown } | null)?.reason));
  }

  /** Um token assinado com a chave dada (o console de verdade, ou a de um atacante). */
  function idToken(
    claims: Record<string, unknown>,
    options: { key?: KeyObject; header?: Record<string, unknown> } = {},
  ): string {
    const header = options.header ?? { alg: 'EdDSA', typ: 'JWT', kid: consoleKey?.jwk.kid };
    const input = `${b64(header)}.${b64(claims)}`;
    const key = options.key ?? consoleKey?.privateKey;
    if (key === undefined) throw new Error('sem chave');
    return `${input}.${sign(null, Buffer.from(input), key).toString('base64url')}`;
  }

  function claimsFor(nonce: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    return {
      iss: ISSUER,
      aud: SSO_CLIENT_ID,
      sub: 'a'.repeat(64),
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
      cell: CELL,
      capture: apiLog,
      sso: { issuer: ISSUER, publicKey: consoleKey.jwk.x },
      overrideProviders: [{ provide: SSO_FETCH, useValue: fetcher }],
    });
    prisma = api.get(PrismaService);
    staffTenant = await createCellTenant(api, STAFF);
    customerTenant = await createCellTenant(api, CUSTOMER);
    // A conta da equipe no painel já existe (o SSO não cria ninguém), com a senha definitiva e o MFA do painel.
    await createSignedInUserOnHost(api, STAFF, { email: OWNER, role: 'admin_verax', tenantId: null });

    consoleApp = await createConsoleApp({
      role: 'admin',
      nodeEnv: 'production',
      trustProxyHops: 1,
      documentStore: consoleDocuments,
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

    // A conta do console, como a linha de comando cria, e o login de verdade (senha e TOTP).
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
    await loginToConsole();
  });

  beforeEach(() => {
    exchangeOverride = undefined;
    exchangeCalls = 0;
  });

  afterAll(async () => {
    await consoleApp.close();
    await api.close();
  });

  it('caminho feliz: SIEM → console (login próprio) → SIEM com a sessão normal do admin_verax', async () => {
    const { authorize, ssoCookie } = await start();
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${ISSUER}/sso/authorize`);
    expect(authorize.searchParams.get('redirect_uri')).toBe(CALLBACK);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');

    // Sem a sessão do console: o login dele, que volta ao mesmo pedido.
    const noSession = await request(consoleApp.getHttpServer())
      .get(`${authorize.pathname}${authorize.search}`)
      .set('Sec-Fetch-Site', 'same-site')
      .expect(303);
    const voltar = new URL(String(noSession.headers['location']), ISSUER).searchParams.get('voltar') ?? '';
    expect(voltar.startsWith('/sso/authorize?')).toBe(true);

    // Já com a sessão (o login do console), o mesmo pedido devolve o código ao SIEM.
    const back = await authorizeAtConsole(new URL(voltar, ISSUER));
    expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
    expect(back.searchParams.get('state')).toBe(authorize.searchParams.get('state'));

    const response = await callback(back, ssoCookie).expect(302);
    expect(response.headers['location']).toBe(`${panelOf(STAFF)}/`);
    expect(response.headers['cache-control']).toContain('no-store');
    const cookies = cookieHeader(response.headers['set-cookie']);
    expect(cookies).toMatch(/session_token=[^;\s]/);
    expect(cookieFrom(response.headers['set-cookie'], SSO_ATTEMPT_COOKIE)).toBe(`${SSO_ATTEMPT_COOKIE}=`);
    const sessionLine = [response.headers['set-cookie']]
      .flat()
      .find((line) => line?.includes('session_token'));
    expect(sessionLine).toMatch(/HttpOnly/i);
    expect(sessionLine).toMatch(/SameSite=Strict/i);

    // A sessão é a de sempre: vale no endereço da equipe, para o admin_verax, presa ao endereço.
    const me = await staff()('get', '/v1/me').set('Cookie', cookies).expect(200);
    expect(me.body).toMatchObject({ email: OWNER, role: 'admin_verax', mfaEnabled: true });
    await staff()('get', '/v1/csrf-token').set('Cookie', cookies).expect(200);
    await onHost(api, CUSTOMER)('get', '/v1/me').set('Cookie', cookies).expect(401);
    const session = await prisma.session.findFirst({
      where: { user: { email: OWNER } },
      orderBy: { createdAt: 'desc' },
      select: { hostTenantId: true },
    });
    expect(session?.hostTenantId).toBe(staffTenant);
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'auth.sso_login', outcome: 'success', resourceId: OWNER },
      select: { resourceId: true },
    });
    expect(audit?.resourceId).toBe(OWNER);
    // Nada do código, do token nem do state no log da API.
    expect(apiLog.text).not.toContain(back.searchParams.get('code') ?? '-');
    expect(apiLog.text).not.toContain(back.searchParams.get('state') ?? '-');
  });

  it('o mesmo retorno de novo (ou outro navegador com ele): recusado, sem sessão', async () => {
    const { back, ssoCookie } = await flowUntilCallback();
    await callback(back, ssoCookie).expect(302);
    expectRefused(await callback(back, ssoCookie));
    // Outro navegador, sem o cookie de pré-login.
    const fresh = await flowUntilCallback();
    expectRefused(await callback(fresh.back));
    expect(await refusalReasons()).toEqual(expect.arrayContaining(['unknown_attempt', 'missing_attempt']));
  });

  it('código reusado num pedido novo: o console recusa a troca', async () => {
    const first = await flowUntilCallback();
    await callback(first.back, first.ssoCookie).expect(302);
    const second = await start();
    const reused = new URL(CALLBACK);
    reused.searchParams.set('code', first.back.searchParams.get('code') ?? '');
    reused.searchParams.set('state', second.authorize.searchParams.get('state') ?? '');
    reused.searchParams.set('iss', ISSUER);
    expectRefused(await callback(reused, second.ssoCookie));
    expect(await refusalReasons()).toContain('exchange_refused');
  });

  it('state trocado (login forçado, CSRF): recusado, e o pedido do navegador não vale mais', async () => {
    const victim = await flowUntilCallback();
    const attacker = await flowUntilCallback();
    // O atacante leva o navegador da vítima ao retorno com o código e o state DELE.
    expectRefused(await callback(attacker.back, victim.ssoCookie));
    // O pedido da vítima foi gasto na recusa: nem o retorno certo vale depois.
    expectRefused(await callback(victim.back, victim.ssoCookie));
    expect(await refusalReasons()).toContain('state_mismatch');
  });

  it('iss diferente no retorno (mistura de provedores) ou erro do provedor: recusado sem trocar o código', async () => {
    const mixed = await flowUntilCallback();
    mixed.back.searchParams.set('iss', 'https://evil.example');
    expectRefused(await callback(mixed.back, mixed.ssoCookie));
    const failed = await start();
    const error = new URL(CALLBACK);
    error.searchParams.set('error', 'access_denied');
    error.searchParams.set('state', failed.authorize.searchParams.get('state') ?? '');
    expectRefused(await callback(error, failed.ssoCookie));
    expect(exchangeCalls).toBe(0);
  });

  describe('token forjado (a célula só aceita o que a chave fixada assinou)', () => {
    const attacker = generateKeyPairSync('ed25519');

    async function refusedWith(build: (nonce: string) => string): Promise<void> {
      const { back, ssoCookie, nonce } = await flowUntilCallback();
      respondWith(build(nonce));
      expectRefused(await callback(back, ssoCookie));
    }

    it('outra chave, alg none, HS256 com a chave pública e kid de outra chave', async () => {
      await refusedWith((nonce) => idToken(claimsFor(nonce), { key: attacker.privateKey }));
      await refusedWith((nonce) => `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claimsFor(nonce))}.`);
      await refusedWith((nonce) => {
        const input = `${b64({ alg: 'HS256', typ: 'JWT', kid: consoleKey?.jwk.kid })}.${b64(claimsFor(nonce))}`;
        return `${input}.${createHmac('sha256', consoleKey?.jwk.x ?? '')
          .update(input)
          .digest('base64url')}`;
      });
      await refusedWith((nonce) =>
        idToken(claimsFor(nonce), {
          key: attacker.privateKey,
          header: { alg: 'EdDSA', typ: 'JWT', kid: opaque() },
        }),
      );
      expect(
        (await refusalReasons()).filter((reason) => reason === 'token_rejected').length,
      ).toBeGreaterThanOrEqual(4);
    });

    it('vencido, aud, iss ou nonce errados, sem o segundo fator', async () => {
      const now = Math.floor(Date.now() / 1000);
      await refusedWith((nonce) => idToken(claimsFor(nonce, { iat: now - 600, exp: now - 300 })));
      await refusedWith((nonce) => idToken(claimsFor(nonce, { aud: 'outro-cliente' })));
      await refusedWith((nonce) => idToken(claimsFor(nonce, { iss: 'https://evil.example' })));
      await refusedWith(() => idToken(claimsFor(opaque())));
      await refusedWith((nonce) => idToken(claimsFor(nonce, { amr: ['pwd'] })));
    });

    it('o mesmo jti duas vezes (token reaproveitado): a segunda é recusada', async () => {
      const jti = opaque();
      const first = await flowUntilCallback();
      respondWith(idToken(claimsFor(first.nonce, { jti })));
      await callback(first.back, first.ssoCookie).expect(302);
      expect(cookieHeader((await callback(first.back, first.ssoCookie)).headers['set-cookie'])).not.toMatch(
        /session_token=[^;\s]/,
      );
      await refusedWith((nonce) => idToken(claimsFor(nonce, { jti })));
      expect(await refusalReasons()).toContain('replayed_token');
    });

    it('resposta da troca fora do contrato, erro do console ou console fora do ar', async () => {
      const cases: (() => Promise<Response>)[] = [
        () => Promise.resolve(new Response('{"id_token":"x"}', { status: 200 })),
        () => Promise.resolve(new Response('não é json', { status: 200 })),
        () =>
          Promise.resolve(new Response('', { status: 302, headers: { location: 'https://evil.example' } })),
        () => Promise.resolve(new Response('{}', { status: 500 })),
        () => Promise.reject(new Error('rede fora')),
      ];
      for (const build of cases) {
        const { back, ssoCookie } = await flowUntilCallback();
        exchangeOverride = build;
        expectRefused(await callback(back, ssoCookie));
      }
    });
  });

  describe('quem a célula aceita (nenhum usuário é criado)', () => {
    async function refusedFor(email: string): Promise<void> {
      const { back, ssoCookie, nonce } = await flowUntilCallback();
      respondWith(idToken(claimsFor(nonce, { email })));
      expectRefused(await callback(back, ssoCookie));
    }

    it('e-mail desconhecido: recusado, e nenhum usuário nasce', async () => {
      const email = `desconhecido-${randomUUID()}@verax.example`;
      await refusedFor(email);
      expect(await prisma.user.count({ where: { email } })).toBe(0);
    });

    it('quem não é admin_verax (de um cliente, ou da equipe com outro papel), inativo ou sem a conta pronta', async () => {
      const customerAdmin = await createUser(api, { role: 'admin_cliente', tenantId: customerTenant });
      const staffAnalyst = await createUser(api, { role: 'analista_cliente', tenantId: staffTenant });
      const disabled = await createUser(api, { role: 'admin_verax', tenantId: null, status: 'disabled' });
      const withoutMfa = await createUser(api, { role: 'admin_verax', tenantId: null });
      for (const user of [customerAdmin, staffAnalyst, disabled, withoutMfa]) await refusedFor(user.email);
      expect(await refusalReasons()).toContain('user_refused');
    });
  });

  describe('onde a entrada única existe', () => {
    it('só no endereço da equipe: no de um cliente e num desconhecido, 404', async () => {
      for (const path of ['/v1/auth/sso/start', '/v1/auth/sso/callback']) {
        await onHost(api, CUSTOMER)('get', path).expect(404);
        await request(api.getHttpServer())
          .get(path)
          .set('Host', apiHostOf(uniqueSlug('x')))
          .expect(404);
      }
    });

    it('o retorno de um pedido começado no endereço da equipe não vale no de um cliente', async () => {
      const { back, ssoCookie } = await flowUntilCallback();
      await onHost(api, CUSTOMER)('get', `${back.pathname}${back.search}`)
        .set('Cookie', ssoCookie)
        .expect(404);
    });

    it('a configuração pública mostra o console só no endereço da equipe', async () => {
      const own = await staff()('get', '/v1/auth/client-config').expect(200);
      expect(own.body).toEqual({ turnstileSiteKey: null, adminMasterUrl: `${ISSUER}/`, nodePlatform: 'gcp' });
      const customer = await onHost(api, CUSTOMER)('get', '/v1/auth/client-config').expect(200);
      expect(customer.body).toEqual({ turnstileSiteKey: null, adminMasterUrl: null, nodePlatform: 'gcp' });
    });

    it('o login com senha do painel continua valendo para a equipe (o interruptor vem desligado)', async () => {
      const user = await createUser(api, { role: 'admin_verax', tenantId: null });
      const response = await staff()('post', '/v1/auth/sign-in/email').send({
        email: user.email,
        password: user.password,
      });
      expect(response.status).toBe(200);
    });
  });

  it('sair do console antes do retorno revoga o código: a troca é recusada', async () => {
    const { authorize, ssoCookie } = await start();
    const back = await authorizeAtConsole(authorize);
    await request(consoleApp.getHttpServer())
      .post('/v1/admin/logout')
      .set('Content-Type', 'application/json')
      .set('Cookie', consoleCookie)
      .send('{}')
      .expect(204);
    expectRefused(await callback(back, ssoCookie));
    expect(await refusalReasons()).toContain('exchange_refused');
    // Sem a sessão do console, o próximo pedido vai ao login dele.
    const next = await start();
    await request(consoleApp.getHttpServer())
      .get(`${next.authorize.pathname}${next.authorize.search}`)
      .set('Cookie', consoleCookie)
      .set('Sec-Fetch-Site', 'same-site')
      .expect(303)
      .expect('location', /^\/entrar\?voltar=/);
    // O responsável entra de novo no console (os testes seguintes usam a sessão).
    await loginToConsole();
  });

  describe('a célula não tem como assinar um login', () => {
    it('a configuração da API guarda só a chave PÚBLICA, e a célula recusa um par de chaves no lugar dela', () => {
      const config = api.get<AppConfig>(APP_CONFIG);
      expect(config.sso?.publicKey.type).toBe('public');
      expect(config.sso?.publicKey.asymmetricKeyType).toBe('ed25519');
      const text = JSON.stringify(config);
      expect(text).not.toMatch(/PRIVATE KEY/);
      expect(Object.keys(config).filter((key) => /private/i.test(key))).toEqual([]);
    });

    it('o token assinado pela célula com a chave dela (não a do console) nunca vale', async () => {
      const cellKey = generateKeyPairSync('ed25519');
      const { back, ssoCookie, nonce } = await flowUntilCallback();
      respondWith(idToken(claimsFor(nonce), { key: cellKey.privateKey }));
      expectRefused(await callback(back, ssoCookie));
    });

    it('o login do SIEM nunca abre o console: a sessão do painel não é sessão do cp-admin', async () => {
      const { back, ssoCookie } = await flowUntilCallback();
      const response = await callback(back, ssoCookie).expect(302);
      const panelCookies = cookieHeader(response.headers['set-cookie']);
      await request(consoleApp.getHttpServer()).get('/v1/admin/me').set('Cookie', panelCookies).expect(401);
    });
  });
});
