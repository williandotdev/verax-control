import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { expect } from 'vitest';
import { AUTH } from '../../src/auth/auth.constants.js';
import type { Auth } from '../../src/auth/auth.factory.js';
import { type NewUser, provisionUser } from '../../src/auth/user-provisioning.js';
import { PrismaService } from '../../src/common/prisma/prisma.service.js';
import { TEST_WEB_ORIGIN } from './create-app.js';

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
