import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { expect } from 'vitest';
import type { NewUser } from '../../src/auth/user-provisioning.js';
import { PrismaService } from '../../src/common/prisma/prisma.service.js';
import { assignTenantHost } from '../../src/tenants/tenant-host.js';
import { cookieHeader, createTenant, createUser, mergeCookies } from './auth-helpers.js';
import { secretFromUri, totp } from './totp.js';

/** Domínio da célula dos testes (CE-01): reservado para exemplos (RFC 2606). */
export const TEST_CELL_DOMAIN = 'example.com';

/**
 * Subdomínio novo a cada chamada (`<prefixo>-<8 hex>`): os arquivos de teste rodam em paralelo no mesmo banco, e um
 * endereço é de um cliente só.
 */
export function uniqueSlug(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

/** A célula de um arquivo de teste: o domínio e um subdomínio da equipe só dele. */
export function testCell(): { domain: string; staffSlug: string } {
  return { domain: TEST_CELL_DOMAIN, staffSlug: uniqueSlug('equipe') };
}

/** `api-<slug>.example.com`: o `Host` que o túnel repassa. */
export const apiHostOf = (slug: string): string => `api-${slug}.${TEST_CELL_DOMAIN}`;
/** `https://<slug>.control.example.com`: a origem do painel do cliente. */
export const panelOf = (slug: string): string => `https://${slug}.control.${TEST_CELL_DOMAIN}`;

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'options';

/**
 * Requisições a um endereço da célula: o `Host` do cliente e a origem do painel dele (que o navegador manda nas
 * escritas). `origin` troca a origem, para os testes de outro painel.
 */
export function onHost(app: NestExpressApplication, slug: string, origin: string = panelOf(slug)) {
  const server = app.getHttpServer();
  return (method: Method, path: string) =>
    request(server)[method](path).set('Host', apiHostOf(slug)).set('Origin', origin);
}

/** Cliente com endereço na célula, como o provisionamento grava. */
export async function createCellTenant(app: NestExpressApplication, slug: string): Promise<string> {
  const tenantId = await createTenant(app, `Cliente ${slug}`);
  await assignTenantHost(app.get(PrismaService), tenantId, slug);
  return tenantId;
}

export function signInOnHost(app: NestExpressApplication, slug: string, email: string, password: string) {
  return onHost(app, slug)('post', '/v1/auth/sign-in/email').send({ email, password });
}

/** Usuário ativo, com o MFA cadastrado e a sessão aberta no endereço `slug`. */
export async function createSignedInUserOnHost(
  app: NestExpressApplication,
  slug: string,
  overrides: Partial<NewUser> = {},
): Promise<{ id: string; email: string; password: string; secret: string; cookie: string }> {
  const user = await createUser(app, overrides);
  const call = onHost(app, slug);
  const first = await signInOnHost(app, slug, user.email, user.password);
  expect(first.status).toBe(200);
  const session = cookieHeader(first.headers['set-cookie']);
  const enable = await call('post', '/v1/auth/two-factor/enable')
    .set('Cookie', session)
    .send({ password: user.password })
    .expect(200);
  const secret = secretFromUri((enable.body as { totpURI: string }).totpURI);
  const withEnable = mergeCookies(session, enable.headers['set-cookie']);
  const verify = await call('post', '/v1/auth/two-factor/verify-totp')
    .set('Cookie', withEnable)
    .send({ code: totp(secret) })
    .expect(200);
  return { ...user, secret, cookie: mergeCookies(withEnable, verify.headers['set-cookie']) };
}

interface ExpressLayer {
  route?: { path: string | string[]; methods: Record<string, boolean | undefined> };
}

/** Os métodos que a API declara. */
const ROUTE_METHODS: ReadonlySet<string> = new Set(['get', 'post', 'put', 'patch', 'delete']);

/**
 * Todas as rotas que o Express de fato atende (com o prefixo `/v1` e as rotas de teste), como o roteador as registrou.
 * Lido do próprio roteador, e não dos decorators: uma rota registrada por outro caminho também entra na varredura.
 *
 * Uma rota "todos os métodos" (o Express 5 marca cada verbo, até WebDAV e CONNECT) é o `@All` do Better Auth e entra
 * como GET e POST. As do próprio Nest para os middlewares (`/v1{/*splat}`, e as de um caminho que já tem rota de método
 * declarado, como o health check) não são rotas da API e ficam de fora.
 */
export function listHttpRoutes(app: NestExpressApplication): { method: Method; path: string }[] {
  const express = app.getHttpAdapter().getInstance() as { router: { stack: ExpressLayer[] } };
  const layers = express.router.stack.flatMap((layer) => {
    if (!layer.route) return [];
    const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
    const names = Object.entries(layer.route.methods)
      .filter(([, enabled]) => enabled === true)
      .map(([name]) => name);
    const everyMethod = names.includes('_all') || names.some((name) => !ROUTE_METHODS.has(name));
    return paths.map((path) => ({ path, names, everyMethod }));
  });
  const declaredPaths = new Set(layers.filter((layer) => !layer.everyMethod).map((layer) => layer.path));
  const routes: { method: Method; path: string }[] = [];
  for (const { path, names, everyMethod } of layers) {
    if (!everyMethod) {
      for (const name of names) routes.push({ method: name as Method, path });
    } else if (!path.includes('{') && !declaredPaths.has(path)) {
      routes.push({ method: 'get', path }, { method: 'post', path });
    }
  }
  return routes;
}

/** Caminho concreto de uma rota: cada `:param` com o valor dado, e o `*resto` do Better Auth com uma rota dele. */
export function fillPath(path: string, value: string): string {
  return path.replace(/:\w+/g, encodeURIComponent(value)).replace(/\*\w+/g, 'get-session');
}

/** Sessão pronta para escrever num endereço: o cookie com o do token CSRF, e o token. */
export async function csrfOnHost(
  app: NestExpressApplication,
  slug: string,
  cookie: string,
): Promise<{ cookie: string; token: string }> {
  const response = await onHost(app, slug)('get', '/v1/csrf-token').set('Cookie', cookie).expect(200);
  return {
    cookie: mergeCookies(cookie, response.headers['set-cookie']),
    token: (response.body as { token: string }).token,
  };
}
