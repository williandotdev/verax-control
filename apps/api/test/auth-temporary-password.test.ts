import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  meSchema,
  CREDENTIAL_CHANGE_REQUIRED_CODE,
  TEMPORARY_PASSWORD_HOURS,
  temporaryPasswordSchema,
  userCreatedSchema,
  userSchema,
} from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateTemporaryPassword } from '../src/auth/temporary-password.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import {
  authPost,
  createSignedInUser,
  createTenant,
  createUser,
  enrollMfa,
  signIn,
  signInRequest,
  withCsrf,
} from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import { LogCapture } from './support/log-capture.js';

const NEW_PASSWORD = 'senha-nova-bem-longa-2';

describe('senha temporária: criada pelo administrador, troca obrigatória e depois o MFA', () => {
  const capture = new LogCapture();
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let admin: { cookie: string; csrf: string; userId: string };
  let counter = 0;

  const get = (cookie: string, path: string) => request(app.getHttpServer()).get(path).set('Cookie', cookie);
  const post = (path: string, body: object = {}) =>
    request(app.getHttpServer())
      .post(path)
      .set('Cookie', admin.cookie)
      .set('Origin', TEST_WEB_ORIGIN)
      .set('X-CSRF-Token', admin.csrf)
      .send(body);
  const entryOf = (response: request.Response) =>
    prisma.auditLog.findFirstOrThrow({ where: { requestId: response.headers['x-request-id'] } });

  async function createViaApi(role = 'leitura') {
    const email = `temporaria-${(counter += 1)}-${Date.now()}@cliente.example`;
    const response = await post('/v1/users', { email, name: 'Pessoa Nova', role }).expect(201);
    const created = userCreatedSchema.parse(response.body);
    return { ...created, email, response };
  }

  beforeAll(async () => {
    app = await createApp({ capture });
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente A (senha temporária)');
    const signedIn = await createSignedInUser(app, { role: 'admin_cliente', tenantId: tenantA });
    const csrf = await withCsrf(app, signedIn.cookie);
    admin = { cookie: csrf.cookie, csrf: csrf.token, userId: signedIn.id };
  });

  afterAll(async () => {
    await app.close();
  });

  it('a senha gerada é longa, sem caracteres ambíguos e diferente a cada vez', () => {
    const passwords = Array.from({ length: 200 }, generateTemporaryPassword);
    for (const password of passwords) {
      const groups = password.split('-');
      expect(groups).toHaveLength(4);
      for (const group of groups) expect(group).toMatch(/^[A-HJ-NP-Za-km-z2-9]{5}$/);
    }
    expect(new Set(passwords).size).toBe(passwords.length);
  });

  it('criar devolve a senha uma vez; a conta nasce ativa e com troca obrigatória; a senha não vai para a auditoria nem para o log', async () => {
    const before = Date.now();
    const created = await createViaApi();
    expect(created.user).toMatchObject({ status: 'active', mustChangePassword: true, mfaEnabled: false });
    const expiresAt = Date.parse(created.expiresAt);
    expect(expiresAt - before).toBeGreaterThan((TEMPORARY_PASSWORD_HOURS - 1) * 3_600_000);
    expect(expiresAt - before).toBeLessThanOrEqual(TEMPORARY_PASSWORD_HOURS * 3_600_000 + 60_000);

    // Lida de novo, a conta não traz senha nenhuma.
    const read = await get(admin.cookie, `/v1/users/${created.user.id}`).expect(200);
    expect(userSchema.parse(read.body)).toMatchObject({ mustChangePassword: true });
    expect(JSON.stringify(read.body)).not.toContain(created.temporaryPassword);

    const audit = await entryOf(created.response);
    expect(audit).toMatchObject({ action: 'user.create', tenantId: tenantA, outcome: 'success' });
    expect(JSON.stringify(audit)).not.toContain(created.temporaryPassword);
    expect(capture.text).not.toContain(created.temporaryPassword);
    // No banco, só o hash.
    const stored = await prisma.account.findFirstOrThrow({ where: { userId: created.user.id } });
    expect(stored.password).not.toContain(created.temporaryPassword);
  });

  it('com a senha temporária, a sessão só alcança a identidade, o token CSRF e a troca de senha', async () => {
    const created = await createViaApi();
    const cookie = await signIn(app, created.email, created.temporaryPassword);

    const me = meSchema.parse((await get(cookie, '/v1/me').expect(200)).body);
    expect(me).toMatchObject({ mustChangePassword: true, mfaEnabled: false });
    await get(cookie, '/v1/csrf-token').expect(200);

    const blocked = await get(cookie, '/v1/findings').expect(403);
    expect(blocked.body).toMatchObject({ code: CREDENTIAL_CHANGE_REQUIRED_CODE });
    // Nem o cadastro do MFA, nem as rotas de sessão da autenticação, antes de trocar a senha.
    const enable = await authPost(app, '/two-factor/enable', cookie, { password: created.temporaryPassword });
    expect(enable.status).toBe(403);
    expect(enable.body).toMatchObject({ code: CREDENTIAL_CHANGE_REQUIRED_CODE });
    await request(app.getHttpServer()).get('/v1/auth/list-sessions').set('Cookie', cookie).expect(403);
  });

  it('trocar a senha leva ao cadastro do MFA; a temporária deixa de valer', async () => {
    const created = await createViaApi();
    const cookie = await signIn(app, created.email, created.temporaryPassword);

    await authPost(app, '/change-password', cookie, {
      currentPassword: created.temporaryPassword,
      newPassword: NEW_PASSWORD,
    }).expect(200);

    const me = meSchema.parse((await get(cookie, '/v1/me').expect(200)).body);
    expect(me).toMatchObject({ mustChangePassword: false, mfaEnabled: false });
    const next = await get(cookie, '/v1/findings').expect(403);
    expect(next.body).toMatchObject({ code: 'MFA_REQUIRED' });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: created.user.id } })).toMatchObject({
      mustChangePassword: false,
      temporaryPasswordExpiresAt: null,
    });

    await signInRequest(app, created.email, created.temporaryPassword).expect(401);
    // Com a senha nova, o cadastro do MFA funciona e abre o painel.
    const fresh = await signIn(app, created.email, NEW_PASSWORD);
    const { cookie: full } = await enrollMfa(app, fresh, NEW_PASSWORD);
    await get(full, '/v1/findings').expect(200);
  });

  it('senha temporária vencida: o login não abre sessão que sirva', async () => {
    const created = await createViaApi();
    await prisma.user.update({
      where: { id: created.user.id },
      data: { temporaryPasswordExpiresAt: new Date(Date.now() - 60_000) },
    });
    const cookie = await signIn(app, created.email, created.temporaryPassword);
    await get(cookie, '/v1/me').expect(401);
    await authPost(app, '/change-password', cookie, {
      currentPassword: created.temporaryPassword,
      newPassword: NEW_PASSWORD,
    }).expect(401);
  });

  it('o administrador gera outra: a anterior para de valer e as sessões abertas caem', async () => {
    const created = await createViaApi();
    const cookie = await signIn(app, created.email, created.temporaryPassword);

    const response = await post(`/v1/users/${created.user.id}/temporary-password`).expect(200);
    const renewed = temporaryPasswordSchema.parse(response.body);
    expect(renewed.temporaryPassword).not.toBe(created.temporaryPassword);

    await get(cookie, '/v1/me').expect(401);
    await signInRequest(app, created.email, created.temporaryPassword).expect(401);
    const fresh = await signIn(app, created.email, renewed.temporaryPassword);
    expect(meSchema.parse((await get(fresh, '/v1/me').expect(200)).body).mustChangePassword).toBe(true);

    const audit = await entryOf(response);
    expect(audit).toMatchObject({ action: 'user.temporary_password', tenantId: tenantA });
    expect(JSON.stringify(audit)).not.toContain(renewed.temporaryPassword);
  });

  it('quem esqueceu a senha e tem MFA recebe a temporária sem perder o MFA; o bloqueio por tentativas zera', async () => {
    const user = await createSignedInUser(app, { role: 'leitura', tenantId: tenantA });
    await prisma.loginAttempt.upsert({
      where: { email: user.email },
      create: {
        email: user.email,
        failures: 5,
        firstFailureAt: new Date(),
        lockedUntil: new Date(Date.now() + 600_000),
      },
      update: { failures: 5, lockedUntil: new Date(Date.now() + 600_000) },
    });
    const renewed = temporaryPasswordSchema.parse(
      (await post(`/v1/users/${user.id}/temporary-password`).expect(200)).body,
    );
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({
      twoFactorEnabled: true,
      mustChangePassword: true,
    });
    expect(await prisma.loginAttempt.count({ where: { email: user.email } })).toBe(0);
    // Com MFA, o login com a temporária ainda pede o código.
    const first = await signInRequest(app, user.email, renewed.temporaryPassword).expect(200);
    expect(first.body).toMatchObject({ twoFactorRedirect: true });
  });

  it('não para a própria conta (403), nem para desativada (409), nem para conta de outro cliente (404)', async () => {
    await post(`/v1/users/${admin.userId}/temporary-password`).expect(403);
    const disabled = await createUser(app, { role: 'leitura', tenantId: tenantA, status: 'disabled' });
    await post(`/v1/users/${disabled.id}/temporary-password`).expect(409);
    const tenantB = await createTenant(app, 'Cliente B (senha temporária)');
    const other = await createUser(app, { role: 'leitura', tenantId: tenantB });
    await post(`/v1/users/${other.id}/temporary-password`).expect(404);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: other.id } })).toMatchObject({
      mustChangePassword: false,
    });
  });

  it('quem não gerencia usuários não cria conta nem gera senha (403)', async () => {
    const analyst = await createSignedInUser(app, { role: 'analista_cliente', tenantId: tenantA });
    const csrf = await withCsrf(app, analyst.cookie);
    const target = await createUser(app, { role: 'leitura', tenantId: tenantA });
    for (const [path, body] of [
      ['/v1/users', { email: `x-${Date.now()}@cliente.example`, name: 'X', role: 'leitura' }],
      [`/v1/users/${target.id}/temporary-password`, {}],
    ] as const) {
      await request(app.getHttpServer())
        .post(path)
        .set('Cookie', csrf.cookie)
        .set('Origin', TEST_WEB_ORIGIN)
        .set('X-CSRF-Token', csrf.token)
        .send(body)
        .expect(403);
    }
  });

  it('conta do antigo convite, ainda sem senha definida, fica ativa com a temporária', async () => {
    const invited = await createUser(app, { role: 'leitura', tenantId: tenantA, status: 'invited' });
    const renewed = temporaryPasswordSchema.parse(
      (await post(`/v1/users/${invited.id}/temporary-password`).expect(200)).body,
    );
    expect((await prisma.user.findUniqueOrThrow({ where: { id: invited.id } })).status).toBe('active');
    await signIn(app, invited.email, renewed.temporaryPassword);
  });
});
