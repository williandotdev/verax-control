import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  SSO_CLIENT_ID,
  SSO_ID_TOKEN_TTL_SECONDS,
  ssoIdTokenClaimsSchema,
  ssoIdTokenHeaderSchema,
  ssoJwksSchema,
  ssoThumbprintInput,
} from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accountRef, opaqueRef } from '../src/admin/auth/admin-auth.schema.js';
import { AdminAuthService } from '../src/admin/auth/admin-auth.service.js';
import { newTotpSecret } from '../src/admin/auth/totp.js';
import { SSO_PER_IP } from '../src/admin/sso/sso.controller.js';
import { parseSsoSigningKey } from '../src/admin/sso/sso-keys.js';
import { COLLECTIONS } from '../src/firestore/collections.js';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import {
  MemoryAdminSecrets,
  seedOwnerSession,
  sessionCookie,
  sessionIdFrom,
  totpAt,
} from './support/admin-auth.js';
import { createApp } from './support/create-app.js';
import { FakeClock, MINUTE_MS } from './support/fake-clock.js';
import { LogCapture } from './support/log-capture.js';

const START = new Date('2026-11-15T12:00:00.000Z');
/** Endereços fictícios (RFC 2606): o console e a API da equipe na célula. */
const ISSUER = 'https://admin.example.com';
const CALLBACK = 'https://api-equipe.example.com/v1/auth/sso/callback';
const OWNER = 'responsavel@verax.example';
const OPERATOR = 'operador@verax.example';

const opaque = (): string => randomBytes(32).toString('base64url');
const challengeOf = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

interface Flow {
  state: string;
  nonce: string;
  verifier: string;
  query: Record<string, string>;
}

function newFlow(overrides: Record<string, string> = {}): Flow {
  const state = opaque();
  const nonce = opaque();
  const verifier = opaque();
  return {
    state,
    nonce,
    verifier,
    query: {
      response_type: 'code',
      client_id: SSO_CLIENT_ID,
      redirect_uri: CALLBACK,
      state,
      nonce,
      code_challenge: challengeOf(verifier),
      code_challenge_method: 'S256',
      ...overrides,
    },
  };
}

function decodePart(part: string | undefined): unknown {
  return JSON.parse(Buffer.from(part ?? '', 'base64url').toString('utf8'));
}

/**
 * O console como provedor de identidade do SIEM da Verax (`admin/sso/`): o `authorize` (lista exata, sessão do console,
 * nada de redirecionamento aberto), a troca do código (uso único, PKCE, 60 s, a sessão ainda viva), o token assinado
 * (Ed25519, as declarações exatas) e o que o console nunca aceita de volta. O Firestore e o cofre em memória.
 */
describe('cp-admin: entrada única no SIEM (provedor de identidade)', () => {
  const capture = new LogCapture();
  const clock = new FakeClock(START);
  const documents = new MemoryDocumentStore();
  const secrets = new MemoryAdminSecrets();
  let app: NestExpressApplication;
  let ip = '';
  let ipSequence = 0;
  let round = 0;

  function authorize(query: Record<string, string>, cookie?: string): request.Test {
    const call = request(app.getHttpServer())
      .get('/sso/authorize')
      .query(query)
      .set('X-Forwarded-For', ip)
      .set('Sec-Fetch-Site', 'same-site');
    return cookie === undefined ? call : call.set('Cookie', cookie);
  }

  function token(body: Record<string, unknown>): request.Test {
    return request(app.getHttpServer())
      .post('/sso/token')
      .set('X-Forwarded-For', ip)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(body));
  }

  function tokenRequest(code: string, flow: Flow, overrides: Record<string, unknown> = {}) {
    return {
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK,
      client_id: SSO_CLIENT_ID,
      code_verifier: flow.verifier,
      ...overrides,
    };
  }

  /** O código no endereço de retorno (e o retorno conferido: só o endereço da lista, com `state` e `iss`). */
  async function codeFor(flow: Flow, cookie: string): Promise<string> {
    const response = await authorize(flow.query, cookie).expect(303);
    const location = new URL(String(response.headers['location']));
    expect(`${location.origin}${location.pathname}`).toBe(CALLBACK);
    expect(location.searchParams.get('state')).toBe(flow.state);
    expect(location.searchParams.get('iss')).toBe(ISSUER);
    expect([...location.searchParams.keys()].sort()).toEqual(['code', 'iss', 'state']);
    return location.searchParams.get('code') ?? '';
  }

  async function ownerCookie(): Promise<string> {
    return seedOwnerSession(documents, clock, OWNER);
  }

  async function auditActions(): Promise<string[]> {
    const docs = await documents.query(COLLECTIONS.auditLog);
    return docs.map((doc) => String(doc.data['action']));
  }

  beforeAll(async () => {
    app = await createApp({
      role: 'admin',
      nodeEnv: 'production',
      trustProxyHops: 1,
      capture,
      documentStore: documents,
      clock,
      adminSecrets: secrets,
      env: {
        LOG_LEVEL: 'debug',
        ADMIN_SECRETS_PROJECT_ID: 'projeto-exemplo',
        OWNER_PRINCIPALS: OWNER,
        SSO_ISSUER: ISSUER,
        SSO_REDIRECT_URIS: CALLBACK,
      },
    });
    await app.listen(0, '127.0.0.1');
  });

  beforeEach(() => {
    round += 1;
    clock.set(new Date(START.getTime() + round * 60 * MINUTE_MS));
    documents.clear();
    ipSequence += 1;
    ip = `198.51.100.${ipSequence}`;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('authorize', () => {
    it('sem sessão do console: vai ao login do console, que volta ao mesmo pedido (remontado), e nada é emitido', async () => {
      const flow = newFlow();
      const response = await authorize(flow.query).expect(303);
      const location = String(response.headers['location']);
      expect(location.startsWith('/entrar?voltar=')).toBe(true);
      const back = new URL(decodeURIComponent(location.slice('/entrar?voltar='.length)), ISSUER);
      expect(back.pathname).toBe('/sso/authorize');
      expect(Object.fromEntries(back.searchParams)).toEqual(flow.query);
      expect(await documents.query(COLLECTIONS.adminSsoCodes)).toHaveLength(0);
    });

    it('com a sessão: o código vai ao endereço da lista; no Firestore só o SHA-256, preso a tudo do pedido', async () => {
      const cookie = await ownerCookie();
      const flow = newFlow();
      const code = await codeFor(flow, cookie);
      expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const stored = await documents.query(COLLECTIONS.adminSsoCodes);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.id).toBe(opaqueRef(code));
      expect(JSON.stringify(stored[0]?.data)).not.toContain(code);
      expect(stored[0]?.data).toMatchObject({
        clientId: SSO_CLIENT_ID,
        redirectUri: CALLBACK,
        codeChallenge: challengeOf(flow.verifier),
        nonce: flow.nonce,
        email: OWNER,
      });
      const expiresAt = stored[0]?.data['expiresAt'] as Date;
      expect(expiresAt.getTime() - clock.now().getTime()).toBe(60_000);
      expect(await auditActions()).toContain('admin.sso_code_issued');
    });

    it('endereço de retorno fora da lista (redirecionamento aberto): tela de recusa, sem Location, nada emitido', async () => {
      const cookie = await ownerCookie();
      const attempts = [
        'https://evil.example/v1/auth/sso/callback',
        'http://api-equipe.example.com/v1/auth/sso/callback',
        'https://api-equipe.example.com/v1/auth/sso/callback/',
        'https://api-equipe.example.com/v1/auth/sso/callback?x=1',
        'https://api-equipe.example.com/v1/auth/sso/callback#x',
        'https://API-EQUIPE.example.com/v1/auth/sso/callback',
        'https://api-equipe.example.com:443/v1/auth/sso/callback',
        'https://api-equipe.example.com.evil.example/v1/auth/sso/callback',
        'https://api-equipe.example.com@evil.example/v1/auth/sso/callback',
        'https://api-equipe.example.com/v1/auth/sso/%63allback',
        '//evil.example/v1/auth/sso/callback',
        '/v1/auth/sso/callback',
        'javascript:alert(1)',
      ];
      for (const redirect of attempts) {
        const response = await authorize(newFlow({ redirect_uri: redirect }).query, cookie);
        expect(response.status, redirect).toBe(400);
        expect(response.headers['location'], redirect).toBeUndefined();
        expect(response.headers['content-type']).toMatch(/^text\/html/);
        expect(response.text).not.toContain('evil');
      }
      expect(await documents.query(COLLECTIONS.adminSsoCodes)).toHaveLength(0);
    });

    it('cliente desconhecido, PKCE ausente ou `plain`, parâmetro repetido ou a mais: recusado sem redirecionar', async () => {
      const cookie = await ownerCookie();
      const flow = newFlow();
      const variants: Record<string, string | undefined>[] = [
        { client_id: 'outro-cliente' },
        { code_challenge: undefined },
        { code_challenge_method: 'plain' },
        { code_challenge_method: undefined },
        { response_type: 'token' },
        { state: undefined },
        { nonce: undefined },
        { state: 'curto' },
        { prompt: 'none' },
      ];
      for (const variant of variants) {
        const query: Record<string, string> = { ...flow.query };
        for (const [key, value] of Object.entries(variant)) {
          if (value === undefined) delete query[key];
          else query[key] = value;
        }
        const response = await authorize(query, cookie);
        expect(response.status, JSON.stringify(variant)).toBe(400);
        expect(response.headers['location']).toBeUndefined();
      }
      const repeated = await request(app.getHttpServer())
        .get(`/sso/authorize?${new URLSearchParams(flow.query).toString()}&state=${opaque()}`)
        .set('X-Forwarded-For', ip)
        .set('Cookie', cookie);
      expect(repeated.status).toBe(400);
      expect(await documents.query(COLLECTIONS.adminSsoCodes)).toHaveLength(0);
    });

    it('pedido vindo de outro site (Sec-Fetch-Site: cross-site): recusado, mesmo com a sessão', async () => {
      const cookie = await ownerCookie();
      const response = await authorize(newFlow().query, cookie).set('Sec-Fetch-Site', 'cross-site');
      expect(response.status).toBe(403);
      expect(response.headers['location']).toBeUndefined();
      expect(await documents.query(COLLECTIONS.adminSsoCodes)).toHaveLength(0);
    });

    it('limite: pedidos recusados em série esgotam o balde do IP (429), os bons não contam', async () => {
      const cookie = await ownerCookie();
      for (let index = 0; index < 5; index += 1) await codeFor(newFlow(), cookie);
      for (let index = 0; index < SSO_PER_IP.capacity; index += 1) {
        await authorize(newFlow({ client_id: 'outro' }).query, cookie).expect(400);
      }
      const blocked = await authorize(newFlow().query, cookie);
      expect(blocked.status).toBe(429);
      expect(blocked.headers['retry-after']).toBeDefined();
    });
  });

  describe('token', () => {
    it('troca o código por um token Ed25519 com as declarações exatas, conferível pela chave do JWKS', async () => {
      const cookie = await ownerCookie();
      const flow = newFlow();
      const code = await codeFor(flow, cookie);
      const response = await token(tokenRequest(code, flow)).expect(200);
      expect(response.headers['cache-control']).toContain('no-store');
      const body = response.body as { id_token: string; token_type: string; expires_in: number };
      expect(Object.keys(body).sort()).toEqual(['expires_in', 'id_token', 'token_type']);
      expect(body).toMatchObject({ token_type: 'Bearer', expires_in: SSO_ID_TOKEN_TTL_SECONDS });

      const jwks = ssoJwksSchema.parse(
        (await request(app.getHttpServer()).get('/sso/jwks').expect(200)).body,
      );
      const [jwk] = jwks.keys;
      expect(jwk?.kid).toBe(
        createHash('sha256')
          .update(ssoThumbprintInput(jwk?.x ?? ''))
          .digest('base64url'),
      );
      const [headerPart, payloadPart, signaturePart] = body.id_token.split('.');
      const header = ssoIdTokenHeaderSchema.parse(decodePart(headerPart));
      expect(header).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: jwk?.kid });
      const publicKey = createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: jwk?.x ?? '' },
        format: 'jwk',
      });
      expect(
        verify(
          null,
          Buffer.from(`${headerPart}.${payloadPart}`),
          publicKey,
          Buffer.from(signaturePart ?? '', 'base64url'),
        ),
      ).toBe(true);
      const claims = ssoIdTokenClaimsSchema.parse(decodePart(payloadPart));
      const now = Math.floor(clock.now().getTime() / 1000);
      expect(claims).toMatchObject({
        iss: ISSUER,
        aud: SSO_CLIENT_ID,
        sub: accountRef(OWNER),
        email: OWNER,
        nonce: flow.nonce,
        iat: now,
        exp: now + SSO_ID_TOKEN_TTL_SECONDS,
        amr: ['pwd', 'otp'],
      });
      expect(claims.auth_time).toBeLessThanOrEqual(now);
      expect(claims.jti).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await documents.query(COLLECTIONS.adminSsoCodes)).toHaveLength(0);
      expect(await auditActions()).toContain('admin.sso_token_issued');
      // Nada do token nem do código no log.
      expect(capture.text).not.toContain(body.id_token);
      expect(capture.text).not.toContain(code);
    });

    it('o código vale uma vez: a segunda troca é recusada', async () => {
      const cookie = await ownerCookie();
      const flow = newFlow();
      const code = await codeFor(flow, cookie);
      await token(tokenRequest(code, flow)).expect(200);
      const again = await token(tokenRequest(code, flow)).expect(400);
      expect(again.body).toMatchObject({ code: 'invalid_grant' });
    });

    it('PKCE errado: recusado e o código sai (nem o verificador certo vale depois)', async () => {
      const cookie = await ownerCookie();
      const flow = newFlow();
      const code = await codeFor(flow, cookie);
      await token(tokenRequest(code, flow, { code_verifier: opaque() })).expect(400);
      await token(tokenRequest(code, flow)).expect(400);
      expect(await auditActions()).toContain('admin.sso_refused');
    });

    it('endereço de retorno ou cliente diferentes do pedido: recusado', async () => {
      const cookie = await ownerCookie();
      const first = newFlow();
      const code = await codeFor(first, cookie);
      await token(tokenRequest(code, first, { redirect_uri: `${CALLBACK}/x` })).expect(400);
      const second = newFlow();
      const other = await codeFor(second, cookie);
      await token(tokenRequest(other, second, { client_id: 'outro-cliente' })).expect(400);
    });

    it('código vencido (60 s): recusado', async () => {
      const cookie = await ownerCookie();
      const flow = newFlow();
      const code = await codeFor(flow, cookie);
      clock.advance(60_000);
      await token(tokenRequest(code, flow)).expect(400);
    });

    it('sair do console revoga os códigos pendentes da sessão', async () => {
      const cookie = await ownerCookie();
      const flow = newFlow();
      const code = await codeFor(flow, cookie);
      await request(app.getHttpServer())
        .post('/v1/admin/logout')
        .set('X-Forwarded-For', ip)
        .set('Content-Type', 'application/json')
        .set('Cookie', cookie)
        .send('{}')
        .expect(204);
      expect(await documents.query(COLLECTIONS.adminSsoCodes)).toHaveLength(0);
      await token(tokenRequest(code, flow)).expect(400);
      const logout = (await documents.query(COLLECTIONS.auditLog)).find(
        (doc) => doc.data['action'] === 'admin.logout',
      );
      expect(logout?.data['details']).toEqual({ ssoCodesRevoked: 1 });
    });

    it('a sessão do console caiu de outro jeito (vencida, apagada): o código não vira token', async () => {
      const cookie = await ownerCookie();
      const flow = newFlow();
      const code = await codeFor(flow, cookie);
      await documents.runTransaction(async (tx) => {
        for (const session of await tx.query(COLLECTIONS.adminSessions)) {
          tx.delete(COLLECTIONS.adminSessions, session.id);
        }
      });
      await token(tokenRequest(code, flow)).expect(400);
    });

    it('formulário ou chamada de outro site: recusados antes de olhar o código', async () => {
      await request(app.getHttpServer())
        .post('/sso/token')
        .set('X-Forwarded-For', ip)
        .type('form')
        .send({ grant_type: 'authorization_code' })
        .expect(415);
      await token({}).set('Sec-Fetch-Site', 'cross-site').expect(403);
      const malformed = await token({ grant_type: 'authorization_code', code: 'x' }).expect(400);
      expect(malformed.body).toMatchObject({ code: 'invalid_request' });
    });

    it('limite: palpites de código em série esgotam o balde (429)', async () => {
      const flow = newFlow();
      for (let index = 0; index < SSO_PER_IP.capacity; index += 1) {
        await token(tokenRequest(opaque(), flow)).expect(400);
      }
      await token(tokenRequest(opaque(), flow)).expect(429);
    });
  });

  describe('o token nunca abre o console', () => {
    it('Authorization com o token de identidade não é sessão do console (401)', async () => {
      const cookie = await ownerCookie();
      const flow = newFlow();
      const code = await codeFor(flow, cookie);
      const { id_token: idToken } = (await token(tokenRequest(code, flow)).expect(200)).body as {
        id_token: string;
      };
      await request(app.getHttpServer())
        .get('/v1/admin/me')
        .set('X-Forwarded-For', ip)
        .set('Authorization', `Bearer ${idToken}`)
        .expect(401);
      await request(app.getHttpServer())
        .get('/v1/admin/me')
        .set('X-Forwarded-For', ip)
        .set('Cookie', `__session=${idToken}`)
        .expect(401);
    });

    it('o login de verdade (senha e TOTP) leva ao código, e a sessão do console continua só no cookie dele', async () => {
      const password = `senha-${randomBytes(9).toString('base64url')}`;
      const secret = newTotpSecret();
      await app
        .get(AdminAuthService)
        .enrollOwner(
          { email: OWNER, password, secret, code: await totpAt(secret, clock.now()), replace: false },
          { email: OPERATOR },
        );
      clock.advance(30_000);
      const login = await request(app.getHttpServer())
        .post('/v1/admin/login')
        .set('X-Forwarded-For', ip)
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ email: OWNER, password, code: await totpAt(secret, clock.now()) }))
        .expect(200);
      const id = sessionIdFrom(login.headers['set-cookie']) ?? '';
      const flow = newFlow();
      const code = await codeFor(flow, sessionCookie(id));
      const response = await token(tokenRequest(code, flow)).expect(200);
      expect(response.headers['set-cookie']).toBeUndefined();
    });
  });

  describe('a chave de assinatura', () => {
    it('só Ed25519 privada: outra curva, RSA, chave pública ou texto solto não assinam nada', () => {
      const pem = (pair: { privateKey: { export: (o: object) => string | Buffer } }) =>
        pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
      expect(parseSsoSigningKey(pem(generateKeyPairSync('ec', { namedCurve: 'P-256' })))).toBeUndefined();
      expect(parseSsoSigningKey(pem(generateKeyPairSync('rsa', { modulusLength: 2048 })))).toBeUndefined();
      const ed = generateKeyPairSync('ed25519');
      expect(
        parseSsoSigningKey(ed.publicKey.export({ format: 'pem', type: 'spki' }).toString()),
      ).toBeUndefined();
      expect(parseSsoSigningKey('não é uma chave')).toBeUndefined();
      const parsed = parseSsoSigningKey(pem(ed));
      expect(parsed?.jwk.x).toBe(ed.publicKey.export({ format: 'jwk' }).x);
      // A assinatura do Node com ela confere com a parte pública.
      const data = Buffer.from('teste');
      expect(verify(null, data, ed.publicKey, sign(null, data, parsed?.privateKey ?? ed.privateKey))).toBe(
        true,
      );
    });
  });
});
