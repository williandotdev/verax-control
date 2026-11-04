import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Authenticated } from '../src/auth/decorators.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import {
  authPost,
  cookieHeader,
  hasSessionCookie,
  createSignedInUser,
  createUser,
  enrollMfa,
  mergeCookies,
  signIn,
  signInRequest,
  signInWithMfa,
} from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import { secretFromUri, totp } from './support/totp.js';

/** Rota comum, protegida: só responde a sessão com MFA. */
@Controller('mfa-probe')
@Authenticated()
class MfaProbeController {
  @Get()
  ok(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [MfaProbeController] })
class MfaProbeModule {}

describe('MFA obrigatório (T2.2)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createApp({ imports: [MfaProbeModule] });
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  const probe = (cookie: string) => request(app.getHttpServer()).get('/v1/mfa-probe').set('Cookie', cookie);

  describe('primeiro login, sem MFA cadastrado', () => {
    it('a sessão só alcança a identidade; o resto responde MFA_REQUIRED', async () => {
      const user = await createUser(app);
      const cookie = await signIn(app, user.email, user.password);

      const me = await request(app.getHttpServer()).get('/v1/me').set('Cookie', cookie).expect(200);
      expect(me.body).toMatchObject({ mfaEnabled: false });

      const blocked = await probe(cookie).expect(403);
      expect(blocked.body).toMatchObject({ code: 'MFA_REQUIRED' });
    });

    it('cadastro: gera segredo, exige a senha e só ativa depois do primeiro código', async () => {
      const user = await createUser(app);
      const cookie = await signIn(app, user.email, user.password);

      await authPost(app, '/two-factor/enable', cookie, { password: 'senha-errada-longa' }).expect(400);

      const enable = await authPost(app, '/two-factor/enable', cookie, { password: user.password }).expect(
        200,
      );
      const { totpURI, backupCodes } = enable.body as { totpURI: string; backupCodes: string[] };
      expect(totpURI).toMatch(/^otpauth:\/\/totp\/Verax%20Control:/);
      expect(backupCodes).toHaveLength(10);

      // Antes de confirmar com um código, o MFA não está ativo.
      expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).twoFactorEnabled).toBe(false);
      const pending = mergeCookies(cookie, enable.headers['set-cookie']);
      await probe(pending).expect(403);

      const verify = await authPost(app, '/two-factor/verify-totp', pending, {
        code: totp(secretFromUri(totpURI)),
      }).expect(200);
      const active = mergeCookies(pending, verify.headers['set-cookie']);

      expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).twoFactorEnabled).toBe(true);
      await probe(active).expect(200, { ok: true });
    });

    it('segredo e códigos de recuperação ficam cifrados no banco', async () => {
      const user = await createUser(app);
      const { secret, backupCodes } = await enrollMfa(
        app,
        await signIn(app, user.email, user.password),
        user.password,
      );

      const stored = await prisma.twoFactor.findFirstOrThrow({ where: { userId: user.id } });
      expect(stored.secret).not.toContain(secret);
      for (const code of backupCodes) expect(stored.backupCodes).not.toContain(code);
    });
  });

  describe('logins seguintes', () => {
    it('a senha sozinha não abre sessão; o código abre', async () => {
      const user = await createSignedInUser(app);

      const first = await signInRequest(app, user.email, user.password).expect(200);
      expect(first.body).toMatchObject({ twoFactorRedirect: true });
      const challenge = cookieHeader(first.headers['set-cookie']);
      expect(hasSessionCookie(challenge)).toBe(false);
      await probe(challenge).expect(401);

      const session = await signInWithMfa(app, user.email, user.password, user.secret);
      await probe(session).expect(200);
    });

    it('código errado não abre sessão', async () => {
      const user = await createSignedInUser(app);
      const first = await signInRequest(app, user.email, user.password).expect(200);
      const challenge = cookieHeader(first.headers['set-cookie']);

      const wrong = await authPost(app, '/two-factor/verify-totp', challenge, { code: '000000' });
      expect(wrong.status).toBeGreaterThanOrEqual(400);
      expect(wrong.body).toMatchObject({ code: 'INVALID_CODE' });
      expect(hasSessionCookie(cookieHeader(wrong.headers['set-cookie']))).toBe(false);
    });

    it('código de recuperação funciona uma vez só', async () => {
      const user = await createUser(app);
      const { backupCodes } = await enrollMfa(
        app,
        await signIn(app, user.email, user.password),
        user.password,
      );
      const code = backupCodes[0] as string;

      const login = async () => {
        const first = await signInRequest(app, user.email, user.password).expect(200);
        return authPost(app, '/two-factor/verify-backup-code', cookieHeader(first.headers['set-cookie']), {
          code,
        });
      };
      const firstUse = await login();
      expect(firstUse.status).toBe(200);
      expect(hasSessionCookie(cookieHeader(firstUse.headers['set-cookie']))).toBe(true);

      const secondUse = await login();
      expect(secondUse.status).toBeGreaterThanOrEqual(400);
    });

    it('"confiar neste dispositivo" é recusado', async () => {
      const user = await createSignedInUser(app);
      const first = await signInRequest(app, user.email, user.password).expect(200);
      await authPost(app, '/two-factor/verify-totp', cookieHeader(first.headers['set-cookie']), {
        code: totp(user.secret),
        trustDevice: true,
      }).expect(400);
    });

    it('depois de 5 códigos errados, nem o código certo entra, nem num login novo (bloqueio da conta)', async () => {
      const user = await createSignedInUser(app);
      const first = await signInRequest(app, user.email, user.password).expect(200);
      const challenge = cookieHeader(first.headers['set-cookie']);
      for (let i = 0; i < 5; i += 1) {
        // Só o INVALID_CODE conta para o bloqueio. Desafio que sumiu responde INVALID_TWO_FACTOR_COOKIE, também
        // com 401, sem nem avaliar o código; conferir o motivo mostra a causa se o bloqueio falhar adiante.
        const wrong = await authPost(app, '/two-factor/verify-totp', challenge, { code: '000000' });
        expect(wrong.status).toBe(401);
        expect(wrong.body).toMatchObject({ code: 'INVALID_CODE' });
      }
      const counted = await prisma.twoFactor.findFirstOrThrow({ where: { userId: user.id } });
      expect(counted.failedVerificationCount).toBe(5);
      expect(counted.lockedUntil?.getTime()).toBeGreaterThan(Date.now());

      // Desafio novo (o limite por desafio não vale aqui): o bloqueio é da conta.
      const second = await signInRequest(app, user.email, user.password).expect(200);
      const blocked = await authPost(
        app,
        '/two-factor/verify-totp',
        cookieHeader(second.headers['set-cookie']),
        {
          code: totp(user.secret, Date.now() + 30_000),
        },
      ).expect(429);
      expect(blocked.body).toMatchObject({ code: 'ACCOUNT_TEMPORARILY_LOCKED' });
      expect(hasSessionCookie(cookieHeader(blocked.headers['set-cookie']))).toBe(false);
    });

    it('o mesmo código TOTP não abre uma segunda sessão', async () => {
      const user = await createSignedInUser(app);
      const code = totp(user.secret, Date.now() + 30_000);
      const login = async () => {
        const first = await signInRequest(app, user.email, user.password).expect(200);
        return authPost(app, '/two-factor/verify-totp', cookieHeader(first.headers['set-cookie']), { code });
      };

      const firstUse = await login();
      expect(firstUse.status).toBe(200);
      const replay = await login();
      expect(replay.status).toBe(401);
      expect(replay.body).toMatchObject({ code: 'INVALID_CODE' });
      expect(hasSessionCookie(cookieHeader(replay.headers['set-cookie']))).toBe(false);
    });

    it('dois logins simultâneos com o mesmo código: só um abre sessão', async () => {
      const user = await createSignedInUser(app);
      const code = totp(user.secret, Date.now() + 30_000);
      const challenges = await Promise.all(
        [1, 2].map(async () =>
          cookieHeader(
            (await signInRequest(app, user.email, user.password).expect(200)).headers['set-cookie'],
          ),
        ),
      );
      const results = await Promise.all(
        challenges.map((challenge) => authPost(app, '/two-factor/verify-totp', challenge, { code })),
      );
      expect(results.map((result) => result.status).sort()).toEqual([200, 401]);
    });
  });

  describe('o MFA não pode ser desligado nem trocado pelo próprio usuário', () => {
    it('não existe rota para desligar', async () => {
      const user = await createSignedInUser(app);
      await authPost(app, '/two-factor/disable', user.cookie, { password: user.password }).expect(404);
    });

    it('quem já tem MFA não recadastra (trocaria o autenticador sem o código atual)', async () => {
      const user = await createSignedInUser(app);
      await authPost(app, '/two-factor/enable', user.cookie, { password: user.password }).expect(403);
    });

    it('rotas de OTP por e-mail não existem', async () => {
      const user = await createSignedInUser(app);
      await authPost(app, '/two-factor/send-otp', user.cookie).expect(404);
    });

    it('o segredo do TOTP não pode ser relido depois do cadastro, nem com a senha', async () => {
      const user = await createSignedInUser(app);
      await authPost(app, '/two-factor/get-totp-uri', user.cookie, { password: user.password }).expect(404);
    });
  });

  it('escrita recusada por falta de MFA vai para a auditoria', async () => {
    const user = await createUser(app);
    const cookie = await signIn(app, user.email, user.password);
    const response = await request(app.getHttpServer())
      .post('/v1/session/tenant')
      .set('Cookie', cookie)
      .set('Origin', TEST_WEB_ORIGIN)
      .send({ tenantId: '018f0000-0000-7000-8000-0000000000ff' })
      .expect(403);
    expect(response.body).toMatchObject({ code: 'MFA_REQUIRED' });
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { requestId: response.headers['x-request-id'] },
    });
    expect(entry).toMatchObject({
      action: 'POST /v1/session/tenant',
      actorId: user.id,
      outcome: 'denied',
      statusCode: 403,
    });
  });
});
