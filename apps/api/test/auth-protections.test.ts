import 'reflect-metadata';
import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import {
  authPost,
  cookieHeader,
  createSignedInUser,
  createUser,
  signInRequest,
  TEST_PASSWORD,
  withCsrf,
} from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import { totp } from './support/totp.js';

/** Escrita comum, protegida por sessão + MFA + CSRF. */
@Controller('csrf-probe')
class CsrfProbeController {
  @Post()
  create(@Body({ schema: z.strictObject({ name: z.string() }) }) body: { name: string }): { name: string } {
    return body;
  }

  @Get()
  read(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [CsrfProbeController] })
class CsrfProbeModule {}

describe('proteções de login e sessão (T2.3)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createApp({ imports: [CsrfProbeModule] });
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('bloqueio por conta', () => {
    it('5 senhas erradas bloqueiam a conta: nem a senha certa entra', async () => {
      const user = await createUser(app);
      for (let i = 0; i < 5; i += 1) await signInRequest(app, user.email, 'senha-errada-longa').expect(401);

      const locked = await signInRequest(app, user.email, user.password).expect(429);
      expect(locked.body).toMatchObject({ code: 'ACCOUNT_LOCKED' });
      expect(locked.headers['set-cookie']).toBeUndefined();
    });

    it('e-mail inexistente é bloqueado do mesmo jeito (não revela quem existe)', async () => {
      const email = 'nao-existe-bloqueio@cliente.example';
      for (let i = 0; i < 5; i += 1) await signInRequest(app, email, 'senha-errada-longa').expect(401);
      const locked = await signInRequest(app, email, TEST_PASSWORD).expect(429);
      expect(locked.body).toMatchObject({ code: 'ACCOUNT_LOCKED' });
    });

    it('login certo zera a contagem', async () => {
      const user = await createUser(app);
      for (let i = 0; i < 4; i += 1) await signInRequest(app, user.email, 'senha-errada-longa').expect(401);
      await signInRequest(app, user.email, user.password).expect(200);
      for (let i = 0; i < 4; i += 1) await signInRequest(app, user.email, 'senha-errada-longa').expect(401);
      await signInRequest(app, user.email, user.password).expect(200);
    });

    it('o bloqueio expira', async () => {
      const user = await createUser(app);
      for (let i = 0; i < 5; i += 1) await signInRequest(app, user.email, 'senha-errada-longa').expect(401);
      await prisma.loginAttempt.update({
        where: { email: user.email },
        data: {
          lockedUntil: new Date(Date.now() - 1000),
          firstFailureAt: new Date(Date.now() - 16 * 60_000),
        },
      });
      await signInRequest(app, user.email, user.password).expect(200);
    });
  });

  describe('eventos de login na auditoria', () => {
    it('grava login com sucesso e com falha, com IP e request id', async () => {
      const user = await createUser(app);
      const ok = await signInRequest(app, user.email, user.password).expect(200);
      const fail = await signInRequest(app, user.email, 'senha-errada-longa').expect(401);

      const success = await prisma.auditLog.findFirstOrThrow({
        where: { requestId: ok.headers['x-request-id'] },
      });
      expect(success).toMatchObject({
        action: 'auth.sign_in',
        outcome: 'success',
        actorType: 'user',
        actorId: user.id,
        resourceId: user.email,
        statusCode: 200,
      });
      expect(success.ip).toMatch(/127\.0\.0\.1|::1/);

      const failure = await prisma.auditLog.findFirstOrThrow({
        where: { requestId: fail.headers['x-request-id'] },
      });
      expect(failure).toMatchObject({
        action: 'auth.sign_in',
        outcome: 'denied',
        actorType: 'anonymous',
        resourceId: user.email,
        statusCode: 401,
      });
      expect(JSON.stringify(failure)).not.toContain('senha-errada-longa');
    });

    it('grava a conta bloqueada, a verificação do MFA e o logout', async () => {
      const user = await createSignedInUser(app);

      const first = await signInRequest(app, user.email, user.password).expect(200);
      const verify = await authPost(
        app,
        '/two-factor/verify-totp',
        cookieHeader(first.headers['set-cookie']),
        {
          code: totp(user.secret, Date.now() + 30_000),
        },
      ).expect(200);
      const mfaEvent = await prisma.auditLog.findFirstOrThrow({
        where: { requestId: verify.headers['x-request-id'] },
      });
      expect(mfaEvent).toMatchObject({ action: 'auth.mfa_verify', outcome: 'success', actorId: user.id });

      const signOut = await authPost(app, '/sign-out', user.cookie).expect(200);
      const signOutEvent = await prisma.auditLog.findFirstOrThrow({
        where: { requestId: signOut.headers['x-request-id'] },
      });
      expect(signOutEvent).toMatchObject({ action: 'auth.sign_out', outcome: 'success' });

      const lockedUser = await createUser(app);
      for (let i = 0; i < 5; i += 1) await signInRequest(app, lockedUser.email, 'senha-errada-longa');
      const locked = await signInRequest(app, lockedUser.email, lockedUser.password).expect(429);
      const lockedEvent = await prisma.auditLog.findFirstOrThrow({
        where: { requestId: locked.headers['x-request-id'] },
      });
      expect(lockedEvent).toMatchObject({ action: 'auth.sign_in', outcome: 'denied', statusCode: 429 });
    });
  });

  describe('CSRF em escritas autenticadas', () => {
    it('sem token, recusa; com o token da sessão e a origem do painel, aceita', async () => {
      const user = await createSignedInUser(app);
      const post = (cookie: string) =>
        request(app.getHttpServer())
          .post('/v1/csrf-probe')
          .set('Cookie', cookie)
          .set('Origin', TEST_WEB_ORIGIN);

      const noToken = await post(user.cookie).send({ name: 'x' }).expect(403);
      expect(noToken.body).toMatchObject({ code: 'CSRF_INVALID' });

      const { cookie, token } = await withCsrf(app, user.cookie);
      await post(cookie).set('X-CSRF-Token', token).send({ name: 'x' }).expect(201, { name: 'x' });
    });

    it('token de outra sessão não vale', async () => {
      const alice = await createSignedInUser(app);
      const bob = await createSignedInUser(app);
      const aliceCsrf = await withCsrf(app, alice.cookie);
      const bobCsrf = await withCsrf(app, bob.cookie);

      await request(app.getHttpServer())
        .post('/v1/csrf-probe')
        .set('Cookie', bobCsrf.cookie)
        .set('Origin', TEST_WEB_ORIGIN)
        .set('X-CSRF-Token', aliceCsrf.token)
        .send({ name: 'x' })
        .expect(403);
    });

    it('token válido vindo de outra origem não vale', async () => {
      const user = await createSignedInUser(app);
      const { cookie, token } = await withCsrf(app, user.cookie);
      await request(app.getHttpServer())
        .post('/v1/csrf-probe')
        .set('Cookie', cookie)
        .set('Origin', 'https://site-malicioso.example')
        .set('X-CSRF-Token', token)
        .send({ name: 'x' })
        .expect(403);
    });

    it('leitura não pede token', async () => {
      const user = await createSignedInUser(app);
      await request(app.getHttpServer()).get('/v1/csrf-probe').set('Cookie', user.cookie).expect(200);
    });

    it('o cookie do token é __Host-, HttpOnly, Secure e SameSite=Strict', async () => {
      const user = await createSignedInUser(app);
      const response = await request(app.getHttpServer())
        .get('/v1/csrf-token')
        .set('Cookie', user.cookie)
        .expect(200);
      const cookie = ([] as string[])
        .concat(response.headers['set-cookie'] ?? [])
        .find((c) => c.startsWith('__Host-'));
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/Secure/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
      expect(cookie).not.toMatch(/Domain=/i);
    });
  });

  describe('CORS', () => {
    it('libera o painel, com cookies', async () => {
      const response = await request(app.getHttpServer())
        .options('/v1/me')
        .set('Origin', TEST_WEB_ORIGIN)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type,x-csrf-token');
      expect(response.headers['access-control-allow-origin']).toBe(TEST_WEB_ORIGIN);
      expect(response.headers['access-control-allow-credentials']).toBe('true');
      expect(response.headers['access-control-allow-headers']).toMatch(/x-csrf-token/i);
    });

    it('não libera nenhuma outra origem', async () => {
      const response = await request(app.getHttpServer())
        .options('/v1/me')
        .set('Origin', 'https://site-malicioso.example')
        .set('Access-Control-Request-Method', 'POST');
      expect(response.headers['access-control-allow-origin']).toBeUndefined();

      const simple = await request(app.getHttpServer())
        .get('/health')
        .set('Origin', 'https://site-malicioso.example');
      expect(simple.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
