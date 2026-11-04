import 'reflect-metadata';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TURNSTILE_TOKEN_HEADER } from '../src/auth/turnstile.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import {
  authPost,
  cookieHeader,
  createUser,
  enrollMfa,
  hasSessionCookie,
  mergeCookies,
  signInRequest,
} from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import { LogCapture } from './support/log-capture.js';
import { MemoryMailTransport } from './support/memory-mail.js';
import { totp } from './support/totp.js';

// Marcados para a busca nos logs e nas respostas: nenhum dos dois pode aparecer em lugar nenhum.
const LEAK = { secretKey: 'leak-ts-secret-1', token: 'leak-ts-token-2' };
// Chave de site de teste da Cloudflare (sempre passa); só o formato importa aqui, o siteverify é o falso.
const SITE_KEY = '1x00000000000000000000AA';

type SiteverifyMode = 'ok' | 'fail' | 'error' | 'garbage' | 'hang' | 'redirect';

interface SiteverifyCall {
  url: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

describe('Cloudflare Turnstile no login e no pedido de redefinição', () => {
  const capture = new LogCapture();
  const mailbox = new MemoryMailTransport();
  let siteverify: Server;
  let mode: SiteverifyMode = 'ok';
  let calls: SiteverifyCall[] = [];
  /** O que o siteverify falso diz sobre o token aceito: a `action` do widget que o gerou e o hostname da página. */
  let solved: { action?: string; hostname?: string } = {};
  const hanging: ServerResponse[] = [];
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    // Siteverify falso em 127.0.0.1: guarda cada chamada e responde conforme o cenário do teste.
    siteverify = createServer((incoming, response) => {
      let raw = '';
      incoming.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      incoming.on('end', () => {
        calls.push({
          url: incoming.url,
          headers: incoming.headers,
          body: JSON.parse(raw) as Record<string, unknown>,
        });
        if (mode === 'hang') {
          hanging.push(response);
          return;
        }
        if (mode === 'redirect' && incoming.url === '/siteverify') {
          // 307 preserva método e corpo: quem o seguisse levaria a chave secreta ao outro endereço, que aceita tudo.
          response.statusCode = 307;
          response.setHeader('location', '/siteverify-redirecionado');
          response.end();
          return;
        }
        response.setHeader('content-type', 'application/json');
        if (mode === 'error') {
          response.statusCode = 500;
          response.end('{"error":"detalhe interno do siteverify"}');
        } else if (mode === 'garbage') {
          response.end('isto não é JSON');
        } else if (mode === 'fail') {
          response.end(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }));
        } else {
          response.end(
            JSON.stringify({
              success: true,
              'error-codes': [],
              challenge_ts: '2026-11-04T12:00:00.000Z',
              hostname: 'localhost',
              metadata: { ignorado: true },
              ...solved,
            }),
          );
        }
      });
    });
    await new Promise<void>((resolve) => siteverify.listen(0, '127.0.0.1', resolve));
    const { port } = siteverify.address() as AddressInfo;
    app = await createApp({
      capture,
      mailbox,
      turnstile: {
        secretKey: LEAK.secretKey,
        siteKey: SITE_KEY,
        siteverifyUrl: `http://127.0.0.1:${port}/siteverify`,
      },
    });
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    for (const response of hanging) response.destroy();
    await app.close();
    await new Promise<void>((resolve) => siteverify.close(() => resolve()));
  });

  beforeEach(() => {
    mode = 'ok';
    calls = [];
    solved = {};
  });

  const withToken = (test: request.Test, token = LEAK.token) => test.set(TURNSTILE_TOKEN_HEADER, token);
  const requestReset = (email: string) =>
    request(app.getHttpServer())
      .post('/v1/auth/request-password-reset')
      .set('Origin', TEST_WEB_ORIGIN)
      .send({ email });

  it('a configuração pública entrega a chave do site, com cache e sem a chave secreta', async () => {
    const response = await request(app.getHttpServer()).get('/v1/auth/client-config').expect(200);
    expect(response.body).toEqual({ turnstileSiteKey: SITE_KEY });
    expect(response.headers['cache-control']).toBe('public, max-age=300');
    expect(JSON.stringify(response.body)).not.toContain(LEAK.secretKey);
    // Pública: nem sessão nem origem do painel são exigidas.
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
  });

  describe('login', () => {
    it('sem o token: 400 antes da senha, sem gastar nenhuma tentativa e sem falar com a Cloudflare', async () => {
      const user = await createUser(app);
      // Seis vezes: se cada uma contasse como tentativa, a sexta já viria como conta bloqueada (429).
      for (let i = 0; i < 6; i += 1) {
        const response = await signInRequest(app, user.email, user.password).expect(400);
        expect(response.body).toMatchObject({ code: 'TURNSTILE_REQUIRED' });
        expect(hasSessionCookie(cookieHeader(response.headers['set-cookie']))).toBe(false);
      }
      expect(calls).toHaveLength(0);
      expect(await prisma.loginAttempt.findUnique({ where: { email: user.email } })).toBeNull();
      // Token vazio é o mesmo que nenhum.
      await withToken(signInRequest(app, user.email, user.password), '').expect(400);
      // Com o token, a senha certa entra: a conta não ficou bloqueada pelas recusas.
      await withToken(signInRequest(app, user.email, user.password)).expect(200);
    });

    it('token recusado pela Cloudflare: 400 genérico, sem olhar a senha e sem gastar tentativa', async () => {
      mode = 'fail';
      const user = await createUser(app);
      const response = await withToken(signInRequest(app, user.email, user.password)).expect(400);
      expect(response.body).toMatchObject({ code: 'TURNSTILE_FAILED' });
      expect(JSON.stringify(response.body)).not.toMatch(/invalid-input-response|siteverify/);
      expect(hasSessionCookie(cookieHeader(response.headers['set-cookie']))).toBe(false);
      expect(await prisma.loginAttempt.findUnique({ where: { email: user.email } })).toBeNull();

      // O siteverify recebeu a chave secreta, o token e o IP de quem pediu, em JSON.
      expect(calls).toHaveLength(1);
      expect(calls[0]?.headers['content-type']).toBe('application/json');
      expect(calls[0]?.body).toEqual({
        secret: LEAK.secretKey,
        response: LEAK.token,
        remoteip: expect.stringMatching(/127\.0\.0\.1|::1/) as string,
      });

      // A recusa entra na trilha, como o bloqueio por conta, sem o token.
      const event = await prisma.auditLog.findFirstOrThrow({
        where: { requestId: response.headers['x-request-id'] },
      });
      expect(event).toMatchObject({
        action: 'auth.sign_in',
        outcome: 'denied',
        actorType: 'anonymous',
        resourceId: user.email,
        statusCode: 400,
      });
      expect(JSON.stringify(event)).not.toContain(LEAK.token);
    });

    it('token aceito: o fluxo de sempre, inclusive senha errada, bloqueio e o desafio do MFA', async () => {
      const user = await createUser(app);
      const wrong = await withToken(signInRequest(app, user.email, 'senha-errada-longa')).expect(401);
      expect(wrong.body).toMatchObject({ code: 'INVALID_EMAIL_OR_PASSWORD' });
      // Com o token, a tentativa conta (o Turnstile não substitui o bloqueio por conta).
      expect(await prisma.loginAttempt.findUniqueOrThrow({ where: { email: user.email } })).toMatchObject({
        failures: 1,
      });

      const first = await withToken(signInRequest(app, user.email, user.password)).expect(200);
      const { secret } = await enrollMfa(app, cookieHeader(first.headers['set-cookie']), user.password);

      const challenge = await withToken(signInRequest(app, user.email, user.password)).expect(200);
      expect(challenge.body).toMatchObject({ twoFactorRedirect: true });
      // O código do MFA não pede o token: o desafio já veio de um login verificado.
      const verified = await authPost(
        app,
        '/two-factor/verify-totp',
        cookieHeader(challenge.headers['set-cookie']),
        {
          code: totp(secret, Date.now() + 30_000),
        },
      ).expect(200);
      const cookie = mergeCookies(
        cookieHeader(challenge.headers['set-cookie']),
        verified.headers['set-cookie'],
      );
      await request(app.getHttpServer()).get('/v1/me').set('Cookie', cookie).expect(200);
      expect(calls).toHaveLength(3);
    });

    it.each([
      ['responde 500', 'error'],
      ['responde fora do formato', 'garbage'],
    ] as const)('siteverify %s: 503 genérico, com o motivo só no log', async (_label, scenario) => {
      mode = scenario;
      const user = await createUser(app);
      const response = await withToken(signInRequest(app, user.email, user.password)).expect(503);
      expect(response.body).toEqual({
        code: 'TURNSTILE_UNAVAILABLE',
        message: 'Serviço temporariamente indisponível',
      });
      expect(JSON.stringify(response.body)).not.toMatch(/detalhe interno|127\.0\.0\.1/);
      expect(hasSessionCookie(cookieHeader(response.headers['set-cookie']))).toBe(false);
      expect(await prisma.loginAttempt.findUnique({ where: { email: user.email } })).toBeNull();
      const event = await prisma.auditLog.findFirstOrThrow({
        where: { requestId: response.headers['x-request-id'] },
      });
      expect(event).toMatchObject({ action: 'auth.sign_in', outcome: 'failure', statusCode: 503 });
    });

    it('siteverify redireciona: 503 sem seguir (a chave secreta não vai a outro endereço)', async () => {
      mode = 'redirect';
      const user = await createUser(app);
      const response = await withToken(signInRequest(app, user.email, user.password)).expect(503);
      expect(response.body).toMatchObject({ code: 'TURNSTILE_UNAVAILABLE' });
      expect(calls.map((call) => call.url)).toEqual(['/siteverify']);
      expect(hasSessionCookie(cookieHeader(response.headers['set-cookie']))).toBe(false);
    });

    it('token resolvido no widget do "esqueci a senha" não vale no login: 400 genérico, com o motivo só no log', async () => {
      solved = { action: 'password-reset' };
      const user = await createUser(app);
      const response = await withToken(signInRequest(app, user.email, user.password)).expect(400);
      expect(response.body).toEqual(expect.objectContaining({ code: 'TURNSTILE_FAILED' }));
      expect(JSON.stringify(response.body)).not.toMatch(/action|password-reset/);
      expect(hasSessionCookie(cookieHeader(response.headers['set-cookie']))).toBe(false);
      // Antes da senha: nenhuma tentativa gasta, e a recusa entra na trilha como as outras.
      expect(await prisma.loginAttempt.findUnique({ where: { email: user.email } })).toBeNull();
      const event = await prisma.auditLog.findFirstOrThrow({
        where: { requestId: response.headers['x-request-id'] },
      });
      expect(event).toMatchObject({ action: 'auth.sign_in', outcome: 'denied', statusCode: 400 });
      expect(capture.text).toContain('action-mismatch');

      // A action do próprio login passa.
      solved = { action: 'login' };
      await withToken(signInRequest(app, user.email, user.password)).expect(200);
    });

    it('com chave de site de teste, o hostname do siteverify não é conferido', async () => {
      solved = { hostname: 'outro.example' };
      const user = await createUser(app);
      await withToken(signInRequest(app, user.email, user.password)).expect(200);
    });

    it('siteverify sem resposta: 5 s e 503 (fecha, não abre)', async () => {
      mode = 'hang';
      const user = await createUser(app);
      const started = Date.now();
      const response = await withToken(signInRequest(app, user.email, user.password)).expect(503);
      expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
      expect(response.body).toMatchObject({ code: 'TURNSTILE_UNAVAILABLE' });
      expect(capture.text).toContain('siteverify do Turnstile fora do ar');
    }, 20_000);

    it('token maior que o limite da Cloudflare nem vai ao siteverify', async () => {
      const user = await createUser(app);
      const response = await withToken(
        signInRequest(app, user.email, user.password),
        'x'.repeat(2049),
      ).expect(400);
      expect(response.body).toMatchObject({ code: 'TURNSTILE_FAILED' });
      expect(calls).toHaveLength(0);
    });

    it('o token no corpo não vale: só o header', async () => {
      const user = await createUser(app);
      const response = await request(app.getHttpServer())
        .post('/v1/auth/sign-in/email')
        .set('Origin', TEST_WEB_ORIGIN)
        .send({ email: user.email, password: user.password, turnstileToken: LEAK.token });
      expect(response.status).toBe(400);
      expect(calls).toHaveLength(0);
    });
  });

  describe('pedido de redefinição de senha', () => {
    it('sem o token ou com token recusado, nada é enviado; com o token, o pedido segue', async () => {
      const user = await createUser(app);
      const missing = await requestReset(user.email).expect(400);
      expect(missing.body).toMatchObject({ code: 'TURNSTILE_REQUIRED' });

      mode = 'fail';
      const failed = await withToken(requestReset(user.email)).expect(400);
      expect(failed.body).toMatchObject({ code: 'TURNSTILE_FAILED' });
      const event = await prisma.auditLog.findFirstOrThrow({
        where: { requestId: failed.headers['x-request-id'] },
      });
      expect(event).toMatchObject({
        action: 'auth.password_reset_request',
        outcome: 'denied',
        statusCode: 400,
      });
      expect(mailbox.to(user.email)).toHaveLength(0);

      mode = 'ok';
      await withToken(requestReset(user.email)).expect(200);
      await expect.poll(() => mailbox.to(user.email).length, { timeout: 5_000 }).toBe(1);
    });

    it('siteverify fora do ar: 503, e o e-mail não sai', async () => {
      mode = 'error';
      const user = await createUser(app);
      await withToken(requestReset(user.email)).expect(503);
      expect(mailbox.to(user.email)).toHaveLength(0);
    });

    it('token resolvido no widget do login não vale aqui: 400 e nada é enviado; com a action certa, o pedido segue', async () => {
      solved = { action: 'login' };
      const user = await createUser(app);
      const failed = await withToken(requestReset(user.email)).expect(400);
      expect(failed.body).toMatchObject({ code: 'TURNSTILE_FAILED' });
      expect(mailbox.to(user.email)).toHaveLength(0);

      solved = { action: 'password-reset' };
      await withToken(requestReset(user.email)).expect(200);
      await expect.poll(() => mailbox.to(user.email).length, { timeout: 5_000 }).toBe(1);
    });
  });

  it('as outras rotas da autenticação não pedem o token', async () => {
    const user = await createUser(app);
    const first = await withToken(signInRequest(app, user.email, user.password)).expect(200);
    const cookie = cookieHeader(first.headers['set-cookie']);
    calls = [];
    await request(app.getHttpServer()).get('/v1/auth/get-session').set('Cookie', cookie).expect(200);
    await authPost(app, '/two-factor/enable', cookie, { password: user.password }).expect(200);
    await authPost(app, '/sign-out', cookie).expect(200);
    expect(calls).toHaveLength(0);
  });

  it('nem a chave secreta nem o token vão para o log', () => {
    expect(capture.text).toContain('token do Turnstile recusado');
    expect(capture.text).not.toContain(LEAK.secretKey);
    expect(capture.text).not.toContain(LEAK.token);
  });
});
