import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { expect } from 'vitest';
import { AUTH } from '../../src/auth/auth.constants.js';
import type { Auth } from '../../src/auth/auth.factory.js';
import { type NewUser, provisionUser } from '../../src/auth/user-provisioning.js';
import { PrismaService } from '../../src/common/prisma/prisma.service.js';
import { TEST_WEB_ORIGIN } from './create-app.js';
import { secretFromUri, totp } from './totp.js';

/** Senha válida para usuários de teste (só existe no banco de teste). */
export const TEST_PASSWORD = 'senha-de-teste-longa-1';

export async function createTenant(app: NestExpressApplication, name = 'Cliente demo'): Promise<string> {
  const tenant = await app.get(PrismaService).tenant.create({ data: { name }, select: { id: true } });
  return tenant.id;
}

/** Cria um usuário ativo com senha. Cada chamada gera um e-mail único. */
export async function createUser(
  app: NestExpressApplication,
  overrides: Partial<NewUser> = {},
): Promise<{ id: string; email: string; password: string }> {
  const email = overrides.email ?? `usuario-${randomUUID()}@cliente.example`;
  const password = overrides.password ?? TEST_PASSWORD;
  const role = overrides.role ?? 'admin_verax';
  const tenantId =
    overrides.tenantId !== undefined
      ? overrides.tenantId
      : role === 'admin_verax'
        ? null
        : await createTenant(app);
  const { id } = await provisionUser(app.get<Auth>(AUTH), {
    email,
    name: overrides.name ?? 'Usuário de teste',
    role,
    tenantId,
    status: overrides.status ?? 'active',
    password,
  });
  return { id, email, password };
}

export function signInRequest(app: NestExpressApplication, email: string, password: string) {
  return request(app.getHttpServer())
    .post('/v1/auth/sign-in/email')
    .set('Origin', TEST_WEB_ORIGIN)
    .send({ email, password });
}

/** Faz login e devolve o header Cookie para as próximas requisições. */
export async function signIn(app: NestExpressApplication, email: string, password: string): Promise<string> {
  const response = await signInRequest(app, email, password);
  expect(response.status).toBe(200);
  return cookieHeader(response.headers['set-cookie']);
}

/** Converte os Set-Cookie de uma resposta no header Cookie (o supertest não reenvia cookies `Secure` em http). */
export function cookieHeader(setCookie: string | string[] | undefined): string {
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return cookies.map((cookie) => cookie.split(';', 1)[0]).join('; ');
}

export function authPost(app: NestExpressApplication, path: string, cookie: string, body: object = {}) {
  return request(app.getHttpServer())
    .post(`/v1/auth${path}`)
    .set('Origin', TEST_WEB_ORIGIN)
    .set('Cookie', cookie)
    .send(body);
}

/** Junta cookies novos aos atuais (o Better Auth troca o cookie de sessão em alguns passos). */
export function mergeCookies(current: string, setCookie: string | string[] | undefined): string {
  const jar = new Map(
    current
      .split('; ')
      .filter(Boolean)
      .map((pair) => [pair.split('=', 1)[0] ?? '', pair] as const),
  );
  for (const pair of cookieHeader(setCookie).split('; ').filter(Boolean)) {
    jar.set(pair.split('=', 1)[0] ?? '', pair);
  }
  return [...jar.values()].join('; ');
}

export interface MfaEnrollment {
  secret: string;
  backupCodes: string[];
  cookie: string;
}

/** Cadastra o MFA de uma sessão recém-aberta: gera o segredo e confirma com o primeiro código. */
export async function enrollMfa(
  app: NestExpressApplication,
  cookie: string,
  password: string,
): Promise<MfaEnrollment> {
  const enable = await authPost(app, '/two-factor/enable', cookie, { password }).expect(200);
  const { totpURI, backupCodes } = enable.body as { totpURI: string; backupCodes: string[] };
  const secret = secretFromUri(totpURI);
  const withEnableCookies = mergeCookies(cookie, enable.headers['set-cookie']);
  const verify = await authPost(app, '/two-factor/verify-totp', withEnableCookies, {
    code: totp(secret),
  }).expect(200);
  return { secret, backupCodes, cookie: mergeCookies(withEnableCookies, verify.headers['set-cookie']) };
}

/** Login completo de quem já tem MFA: senha, depois o código. Devolve o cookie da sessão. */
export async function signInWithMfa(
  app: NestExpressApplication,
  email: string,
  password: string,
  secret: string,
): Promise<string> {
  const first = await signInRequest(app, email, password).expect(200);
  expect(first.body).toMatchObject({ twoFactorRedirect: true });
  const challenge = cookieHeader(first.headers['set-cookie']);
  // Código da próxima janela de 30 s: o da janela atual pode já ter sido usado no cadastro.
  const verify = await authPost(app, '/two-factor/verify-totp', challenge, {
    code: totp(secret, Date.now() + 30_000),
  }).expect(200);
  return mergeCookies(challenge, verify.headers['set-cookie']);
}

/** Usuário ativo com MFA cadastrado e sessão aberta: o ponto de partida dos testes de permissão. */
export async function createSignedInUser(
  app: NestExpressApplication,
  overrides: Partial<NewUser> = {},
): Promise<{ id: string; email: string; password: string; secret: string; cookie: string }> {
  const user = await createUser(app, overrides);
  const firstSession = await signIn(app, user.email, user.password);
  const { secret, cookie } = await enrollMfa(app, firstSession, user.password);
  return { ...user, secret, cookie };
}

/** Há um cookie de sessão com valor (cookie vazio é só a ordem de apagar). */
export function hasSessionCookie(cookies: string): boolean {
  return /session_token=[^;\s]+/.test(cookies);
}

/** Busca o token CSRF da sessão; devolve o cookie atualizado (com o cookie do token) e o token. */
export async function withCsrf(
  app: NestExpressApplication,
  cookie: string,
): Promise<{ cookie: string; token: string }> {
  const response = await request(app.getHttpServer()).get('/v1/csrf-token').set('Cookie', cookie).expect(200);
  return {
    cookie: mergeCookies(cookie, response.headers['set-cookie']),
    token: (response.body as { token: string }).token,
  };
}
