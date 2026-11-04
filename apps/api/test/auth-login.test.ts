import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import {
  authPost,
  cookieHeader,
  createSignedInUser,
  hasSessionCookie,
  createTenant,
  createUser,
  signIn,
  signInRequest,
  TEST_PASSWORD,
} from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';

describe('login com Better Auth (T2.1)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('login e sessão', () => {
    it('login correto cria sessão em cookie HttpOnly, Secure e SameSite=Strict', async () => {
      const user = await createUser(app);
      const response = await signInRequest(app, user.email, user.password).expect(200);

      const cookies = ([] as string[]).concat(response.headers['set-cookie'] ?? []);
      const sessionCookie = cookies.find((cookie) => cookie.startsWith('__Secure-verax.session_token='));
      expect(sessionCookie).toBeDefined();
      expect(sessionCookie).toMatch(/;\s*HttpOnly/i);
      expect(sessionCookie).toMatch(/;\s*Secure/i);
      expect(sessionCookie).toMatch(/;\s*SameSite=Strict/i);
      expect(sessionCookie).toMatch(/;\s*Path=\//i);
      // Sem dados sensíveis no corpo. O Better Auth devolve o token da sessão, mas sozinho ele não abre sessão:
      // o cookie leva o token assinado com a chave do servidor. Os nomes dos marcadores da senha temporária saem da
      // conferência: são só a flag e o prazo, nunca a senha.
      const body = JSON.stringify(response.body).replace(
        /"(mustChangePassword|temporaryPasswordExpiresAt)"/g,
        '',
      );
      expect(body).not.toMatch(/password|hash/i);
      const { token } = response.body as { token: string };
      await request(app.getHttpServer())
        .get('/v1/me')
        .set('Cookie', `__Secure-verax.session_token=${token}`)
        .expect(401);
      await request(app.getHttpServer()).get('/v1/me').set('Cookie', cookieHeader(sessionCookie)).expect(200);
    });

    it('"lembrar de mim" é recusado: toda sessão tem o limite de inatividade', async () => {
      const user = await createUser(app);
      await signInRequest(app, user.email, user.password)
        .send({ email: user.email, password: user.password, rememberMe: false })
        .expect(400);
    });

    it('a sessão dá acesso à identidade; sem sessão, 401', async () => {
      const tenantId = await createTenant(app);
      const user = await createUser(app, { role: 'analista_cliente', tenantId });
      const cookie = await signIn(app, user.email, user.password);

      const me = await request(app.getHttpServer()).get('/v1/me').set('Cookie', cookie).expect(200);
      expect(me.body).toMatchObject({
        userId: user.id,
        email: user.email,
        role: 'analista_cliente',
        tenantId,
        mfaEnabled: false,
      });

      await request(app.getHttpServer()).get('/v1/me').expect(401);
      await request(app.getHttpServer())
        .get('/v1/me')
        .set('Cookie', '__Secure-verax.session_token=forjado')
        .expect(401);
    });

    it('logout revoga a sessão no servidor: o cookie antigo deixa de valer', async () => {
      const user = await createUser(app);
      const cookie = await signIn(app, user.email, user.password);

      await request(app.getHttpServer())
        .post('/v1/auth/sign-out')
        .set('Origin', TEST_WEB_ORIGIN)
        .set('Cookie', cookie)
        .send({})
        .expect(200);

      await request(app.getHttpServer()).get('/v1/me').set('Cookie', cookie).expect(401);
      expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    });
  });

  describe('credenciais inválidas', () => {
    it('senha errada e e-mail inexistente têm a mesma resposta (não revela usuários)', async () => {
      const user = await createUser(app);
      const wrongPassword = await signInRequest(app, user.email, 'senha-errada-mas-longa').expect(401);
      const unknownEmail = await signInRequest(app, 'ninguem@cliente.example', TEST_PASSWORD).expect(401);

      expect(wrongPassword.body).toEqual(unknownEmail.body);
      expect(wrongPassword.headers['set-cookie']).toBeUndefined();
    });

    /** Resposta de senha errada, para comparar: conta bloqueada não pode revelar que a senha bateu. */
    async function wrongPasswordBody(): Promise<unknown> {
      const other = await createUser(app);
      return (await signInRequest(app, other.email, 'senha-errada-mas-longa').expect(401)).body;
    }

    it.each([
      ['desativado', 'disabled'],
      ['convidado que ainda não definiu senha', 'invited'],
    ] as const)('usuário %s não recebe sessão, com a resposta da senha errada', async (_label, status) => {
      const user = await createUser(app, { status });
      const response = await signInRequest(app, user.email, user.password).expect(401);
      expect(response.body).toEqual(await wrongPasswordBody());
      expect(hasSessionCookie(cookieHeader(response.headers['set-cookie']))).toBe(false);
    });

    it('usuário de cliente inativo não recebe sessão, com a resposta da senha errada', async () => {
      const tenantId = await createTenant(app);
      await prisma.tenant.update({ where: { id: tenantId }, data: { status: 'inactive' } });
      const user = await createUser(app, { role: 'admin_cliente', tenantId });

      const response = await signInRequest(app, user.email, user.password).expect(401);
      expect(response.body).toEqual(await wrongPasswordBody());
      expect(hasSessionCookie(cookieHeader(response.headers['set-cookie']))).toBe(false);
    });
  });

  describe('senha', () => {
    it('o banco guarda só o hash da biblioteca, nunca a senha', async () => {
      const user = await createUser(app);
      const account = await prisma.account.findFirstOrThrow({
        where: { userId: user.id, providerId: 'credential' },
      });

      expect(account.password).toBeTruthy();
      expect(account.password).not.toContain(user.password);
      // Formato do scrypt do Better Auth: salt e hash em hexadecimal.
      expect(account.password).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    });
  });

  describe('superfície exposta', () => {
    it.each([
      ['cadastro público', 'post', '/v1/auth/sign-up/email'],
      ['alteração de dados do usuário', 'post', '/v1/auth/update-user'],
      ['exclusão de conta', 'post', '/v1/auth/delete-user'],
      ['troca de e-mail', 'post', '/v1/auth/change-email'],
      ['login social', 'post', '/v1/auth/sign-in/social'],
      ['rota inexistente', 'get', '/v1/auth/qualquer-coisa'],
    ] as const)('%s não existe (404)', async (_label, method, path) => {
      const agent = request(app.getHttpServer());
      await agent[method](path)
        .set('Origin', TEST_WEB_ORIGIN)
        .send({ email: 'novo@cliente.example', password: TEST_PASSWORD, name: 'x', role: 'admin_verax' })
        .expect(404);
    });

    it('login por formulário é recusado (415)', async () => {
      const user = await createUser(app);
      await request(app.getHttpServer())
        .post('/v1/auth/sign-in/email')
        .set('Origin', TEST_WEB_ORIGIN)
        .type('form')
        .send({ email: user.email, password: user.password })
        .expect(415);
    });

    it('login vindo de outra origem é recusado (CSRF)', async () => {
      const user = await createUser(app);
      const response = await request(app.getHttpServer())
        .post('/v1/auth/sign-in/email')
        .set('Origin', 'https://site-malicioso.example')
        .send({ email: user.email, password: user.password });
      expect(response.status).toBe(403);
      expect(response.headers['set-cookie']).toBeUndefined();
    });
  });

  describe('expiração', () => {
    it('sessão parada além do limite de inatividade expira', async () => {
      const user = await createUser(app);
      const cookie = await signIn(app, user.email, user.password);
      await prisma.session.updateMany({
        where: { userId: user.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await request(app.getHttpServer()).get('/v1/me').set('Cookie', cookie).expect(401);
    });

    it('sessão com mais de 12 h é encerrada mesmo com uso contínuo', async () => {
      const user = await createUser(app);
      const cookie = await signIn(app, user.email, user.password);
      await prisma.session.updateMany({
        where: { userId: user.id },
        data: { createdAt: new Date(Date.now() - 12 * 60 * 60 * 1000 - 60_000) },
      });

      await request(app.getHttpServer()).get('/v1/me').set('Cookie', cookie).expect(401);
      expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    });

    it('usuário desativado perde o acesso na hora, mesmo com sessão aberta', async () => {
      const user = await createUser(app);
      const cookie = await signIn(app, user.email, user.password);
      await prisma.user.update({ where: { id: user.id }, data: { status: 'disabled' } });
      await request(app.getHttpServer()).get('/v1/me').set('Cookie', cookie).expect(401);
    });

    it('sessão com validade além do limite de inatividade é recusada', async () => {
      const user = await createUser(app);
      const cookie = await signIn(app, user.email, user.password);
      await prisma.session.updateMany({
        where: { userId: user.id },
        data: { expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
      });
      await request(app.getHttpServer()).get('/v1/me').set('Cookie', cookie).expect(401);
    });
  });

  describe('rotas de sessão do Better Auth seguem as regras da API', () => {
    const authGet = (path: string, cookie: string) =>
      request(app.getHttpServer()).get(`/v1/auth${path}`).set('Cookie', cookie);

    it('usuário desativado não lê, lista nem renova a sessão aberta', async () => {
      const user = await createSignedInUser(app);
      await authGet('/get-session', user.cookie).expect(200);
      await prisma.user.update({ where: { id: user.id }, data: { status: 'disabled' } });

      await authGet('/get-session', user.cookie).expect(401);
      await authGet('/list-sessions', user.cookie).expect(401);
      expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    });

    it('sessão com mais de 12 h não é renovada nem troca a senha', async () => {
      const user = await createSignedInUser(app);
      await prisma.session.updateMany({
        where: { userId: user.id },
        data: { createdAt: new Date(Date.now() - 12 * 60 * 60 * 1000 - 60_000) },
      });
      // Sem sessão, o /get-session do Better Auth responde 200 com null; por isso ele vem primeiro.
      await authGet('/get-session', user.cookie).expect(401);
      expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
      await authPost(app, '/change-password', user.cookie, {
        currentPassword: user.password,
        newPassword: 'senha-nova-bem-longa-2',
      }).expect(401);
    });

    it('sessão velha também não troca a senha', async () => {
      const user = await createSignedInUser(app);
      await prisma.session.updateMany({
        where: { userId: user.id },
        data: { createdAt: new Date(Date.now() - 12 * 60 * 60 * 1000 - 60_000) },
      });
      await authPost(app, '/change-password', user.cookie, {
        currentPassword: user.password,
        newPassword: 'senha-nova-bem-longa-2',
      }).expect(401);
      expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    });

    it('sessão sem MFA só alcança o cadastro do MFA', async () => {
      const user = await createUser(app);
      const cookie = await signIn(app, user.email, user.password);

      await authGet('/get-session', cookie).expect(200);
      const list = await authGet('/list-sessions', cookie).expect(403);
      expect(list.body).toMatchObject({ code: 'MFA_REQUIRED' });
      await authPost(app, '/change-password', cookie, {
        currentPassword: user.password,
        newPassword: 'senha-nova-bem-longa-2',
      }).expect(403);
      await authPost(app, '/two-factor/enable', cookie, { password: user.password }).expect(200);
    });
  });

  it('sem o Turnstile configurado, a configuração pública diz null e o login não pede token', async () => {
    const config = await request(app.getHttpServer()).get('/v1/auth/client-config').expect(200);
    expect(config.body).toEqual({ turnstileSiteKey: null });
    // Chegou ao controller próprio, e não ao 404 das rotas fechadas do Better Auth.
    await request(app.getHttpServer()).get('/v1/auth/client-config?x=1').expect(400);
    const user = await createUser(app);
    await signInRequest(app, user.email, user.password).expect(200);
  });

  it('o IP da sessão vem do Express; um header de IP mandado pelo cliente é ignorado', async () => {
    const user = await createUser(app);
    await signInRequest(app, user.email, user.password)
      .set('x-verax-client-ip', '198.51.100.250')
      .expect(200);
    const session = await prisma.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(session.ipAddress).not.toBe('198.51.100.250');
    expect(session.ipAddress).toMatch(/127\.0\.0\.1|::1/);
  });

  it('o banco recusa admin_verax com cliente e papel de cliente sem cliente', async () => {
    const tenantId = await createTenant(app);
    await expect(createUser(app, { role: 'admin_verax', tenantId })).rejects.toThrow();
    await expect(createUser(app, { role: 'leitura', tenantId: null })).rejects.toThrow();
  });
});
