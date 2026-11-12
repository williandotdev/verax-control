import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import {
  apiHostOf,
  createCellTenant,
  createSignedInUserOnHost,
  csrfOnHost,
  fillPath,
  listHttpRoutes,
  onHost,
  panelOf,
  TEST_CELL_DOMAIN,
  testCell,
  uniqueSlug,
} from './support/cell.js';
import { createApp } from './support/create-app.js';
import { ProbeModule } from './support/probe.module.js';

const A = uniqueSlug('rotas');
const HEALTH_PATHS = new Set(['/health', '/health/ready']);
/** A resposta de toda rota num endereço desconhecido: o 404 genérico, igual ao de uma rota que não existe. */
const NOT_FOUND = { statusCode: 404, error: 'Not Found', message: 'Recurso não encontrado' };
/**
 * O IP de quem chama na varredura (TEST-NET-2, um por execução) e o e-mail do corpo das escritas: as contagens de
 * tentativa e de limite olham só para eles. O banco de teste é dividido com arquivos que rodam em paralelo e fazem
 * login de verdade, então uma contagem da tabela inteira pode subir sem nada desta varredura.
 */
const CLIENT_IP = `198.51.100.${1 + Math.floor(Math.random() * 254)}`;
const PROBE_EMAIL = 'x@cliente.example';

/**
 * Meta-teste da célula (CE-01), no estilo do de contratos de rota: varre todas as rotas que o Express atende e prova que
 * nenhuma responde num endereço sem cliente. Uma rota nova entra na varredura sozinha; a única exceção é o health check
 * (`@AnyHost`), conferida também pela lista das marcações em `route-contracts.test.ts`.
 */
describe('célula: toda rota atrás do endereço do cliente (CE-01)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let session: { cookie: string; token: string };

  beforeAll(async () => {
    app = await createApp({
      cell: testCell(),
      imports: [ProbeModule],
      trustProxyHops: 1,
      authRateLimit: true,
    });
    // Um servidor só, escutando, para as centenas de requisições da varredura (sem um `listen` por requisição).
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
    const tenantA = await createCellTenant(app, A);
    const admin = await createSignedInUserOnHost(app, A, { role: 'admin_cliente', tenantId: tenantA });
    session = await csrfOnHost(app, A, admin.cookie);
  });

  afterAll(async () => {
    await app.close();
  });

  it('a varredura enxerga as rotas da API, inclusive a autenticação e as rotas de teste', () => {
    const paths = new Set(listHttpRoutes(app).map((route) => route.path));
    expect(paths.size).toBeGreaterThan(50);
    for (const path of ['/v1/me', '/v1/auth/*path', '/v1/session/tenant', '/v1/probe', '/health']) {
      expect(paths, path).toContain(path);
    }
  });

  it('endereço sem cliente: toda rota responde 404, sem CORS e antes de sessão, login ou CSRF', async () => {
    const server = app.getHttpServer();
    const attemptsBefore = await prisma.loginAttempt.count({ where: { email: PROBE_EMAIL } });
    const rateLimitBefore = await prisma.rateLimit.count({ where: { key: { contains: CLIENT_IP } } });
    const unexpected: string[] = [];
    // Um endereço bem formado, sem cliente: a sessão válida de A (cookie, token CSRF e origem do painel de A) não ajuda.
    const host = apiHostOf(uniqueSlug('sem-cliente'));
    for (const { method, path } of listHttpRoutes(app)) {
      const agent = request(server);
      const call = agent[method](fillPath(path, randomUUID()))
        .set('Host', host)
        .set('X-Forwarded-For', CLIENT_IP)
        .set('Origin', panelOf(A))
        .set('Cookie', session.cookie)
        .set('X-CSRF-Token', session.token);
      let response: request.Response;
      try {
        response = await (method === 'get' ? call : call.send({ email: PROBE_EMAIL, password: 'x' }));
      } catch (error) {
        unexpected.push(`${method.toUpperCase()} ${path}: ${(error as Error).message}`);
        continue;
      }
      if (HEALTH_PATHS.has(path)) {
        if (response.status !== 200) unexpected.push(`${method.toUpperCase()} ${path}: ${response.status}`);
        continue;
      }
      const body = response.body as Record<string, unknown>;
      const { requestId: _requestId, ...rest } = body;
      if (response.status !== 404 || JSON.stringify(rest) !== JSON.stringify(NOT_FOUND)) {
        unexpected.push(`${method.toUpperCase()} ${path}: ${response.status} ${JSON.stringify(rest)}`);
      }
      if (response.headers['access-control-allow-origin'] !== undefined) {
        unexpected.push(`${method.toUpperCase()} ${path}: CORS liberado`);
      }
    }
    expect(unexpected).toEqual([]);
    // Nem o login no endereço desconhecido gastou tentativa da conta ou do IP: o 404 vem antes.
    expect(await prisma.loginAttempt.count({ where: { email: PROBE_EMAIL } })).toBe(attemptsBefore);
    expect(await prisma.rateLimit.count({ where: { key: { contains: CLIENT_IP } } })).toBe(rateLimitBefore);
    // Prova de que a contagem enxerga este IP: o mesmo login no endereço de A (que existe) passa pelo limite e grava.
    await request(server)
      .post('/v1/auth/sign-in/email')
      .set('Host', apiHostOf(A))
      .set('X-Forwarded-For', CLIENT_IP)
      .set('Origin', panelOf(A))
      .send({ email: PROBE_EMAIL, password: 'x' });
    expect(await prisma.rateLimit.count({ where: { key: { contains: CLIENT_IP } } })).toBeGreaterThan(
      rateLimitBefore,
    );
  });

  it.each([
    ['com porta', `${apiHostOf(A)}:443`],
    ['com ponto no fim', `${apiHostOf(A)}.`],
    ['em maiúsculas', apiHostOf(A).toUpperCase()],
    ['o endereço do painel', `${A}.control.${TEST_CELL_DOMAIN}`],
    ['outro domínio', `api-${A}.outro.example`],
    ['um rótulo a mais', `x.${apiHostOf(A)}`],
    ['o IP do nó', '127.0.0.1'],
  ])('endereço fora do formato (%s): 404, mesmo com a sessão de A', async (_label, host) => {
    const response = await request(app.getHttpServer())
      .get('/v1/me')
      .set('Host', host)
      .set('Cookie', session.cookie)
      .expect(404);
    expect(response.body).toMatchObject(NOT_FOUND);
    await request(app.getHttpServer())
      .post('/v1/auth/sign-in/email')
      .set('Host', host)
      .set('Origin', panelOf(A))
      .send({ email: 'x@cliente.example', password: 'senha-qualquer-longa' })
      .expect(404);
  });

  it('no endereço do cliente, a mesma sessão passa do guard do endereço', async () => {
    const response = await onHost(app, A)('get', '/v1/me').set('Cookie', session.cookie).expect(200);
    expect(response.body).toMatchObject({ role: 'admin_cliente' });
  });

  it('o health check responde em qualquer endereço (o Docker chama pelo IP)', async () => {
    await request(app.getHttpServer()).get('/health').set('Host', '127.0.0.1:3000').expect(200);
    await request(app.getHttpServer())
      .get('/health')
      .set('Host', apiHostOf(uniqueSlug('z')))
      .expect(200);
  });
});
