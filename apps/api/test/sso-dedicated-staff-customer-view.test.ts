import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { meSchema, permissionsOf } from '@verax/shared';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SSO_FETCH, type SsoFetch } from '../src/auth/sso/token-exchange.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { createSignedInUser, createTenant, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';

/**
 * A visão de cliente da equipe (`STAFF_CUSTOMER_VIEW`; decisão de 17/11/2026) no nó dedicado da Verax (`PLAN=interno`):
 * com um cliente ativo só (a própria Verax), o `admin_verax` vale como o administrador desse cliente, e o painel é o
 * mesmo que o cliente vê. O "Entrar com o Admin master" do login continua.
 *
 * A regra depende de quantos clientes ativos o banco tem, e o banco de teste é dividido com os outros arquivos (que criam
 * clientes em paralelo): este arquivo usa um banco só dele, criado e migrado aqui e apagado no fim.
 */
const testUrl = new URL(inject('testDatabaseUrl'));
const database = `verax_visao_t${randomBytes(4).toString('hex')}_test`;
const apiDir = fileURLToPath(new URL('..', import.meta.url));
const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');

async function onServer(work: (client: pg.Client) => Promise<unknown>): Promise<void> {
  const client = new pg.Client({ connectionString: testUrl.toString() });
  await client.connect();
  try {
    await work(client);
  } finally {
    await client.end();
  }
}

describe('nó dedicado da Verax: a equipe vê o painel como o cliente', () => {
  let app: NestExpressApplication | undefined;
  let prisma: PrismaService;
  let tenantId: string;
  let staff: { id: string; cookie: string };
  const consoleKey = generateKeyPairSync('ed25519');
  const fetcher: SsoFetch = () => Promise.reject(new Error('nenhuma troca neste teste'));

  const server = () => request((app as NestExpressApplication).getHttpServer());
  const me = async () =>
    meSchema.parse((await server().get('/v1/me').set('Cookie', staff.cookie).expect(200)).body);

  beforeAll(async () => {
    await onServer((client) => client.query(`CREATE DATABASE ${client.escapeIdentifier(database)}`));
    const url = new URL(testUrl);
    url.pathname = `/${database}`;
    execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      cwd: apiDir,
      env: { ...process.env, DATABASE_URL: url.toString(), CHECKPOINT_DISABLE: '1' },
      stdio: 'pipe',
    });
    app = await createApp({
      databaseUrl: url.toString(),
      plan: { PLAN: 'interno' },
      apiOrigin: 'https://api.verax.example.com',
      sso: {
        issuer: 'https://admin.example.com',
        publicKey: String(consoleKey.publicKey.export({ format: 'jwk' }).x),
        staffCustomerView: true,
      },
      overrideProviders: [{ provide: SSO_FETCH, useValue: fetcher }],
    });
    prisma = app.get(PrismaService);
    tenantId = await createTenant(app, 'Cliente Demo A');
    staff = await createSignedInUser(app, { role: 'admin_verax', tenantId: null });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await onServer((client) =>
      client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(database)} WITH (FORCE)`),
    );
  }, 60_000);

  it('o /v1/me é o do administrador do cliente: papel, cliente e permissões dele', async () => {
    const identity = await me();
    expect(identity).toMatchObject({
      userId: staff.id,
      role: 'admin_cliente',
      tenantId,
      activeTenantId: null,
      scopeTenantId: tenantId,
    });
    expect(identity.permissions).toEqual(permissionsOf('admin_cliente'));
    expect(identity.permissions).not.toContain('tenants:read');
  });

  it('as rotas só da Verax respondem 403 (a lista de clientes, a troca de cliente)', async () => {
    await server().get('/v1/tenants').set('Cookie', staff.cookie).expect(403);
    const csrf = await withCsrf(app as NestExpressApplication, staff.cookie);
    await server()
      .post('/v1/session/tenant')
      .set('Cookie', csrf.cookie)
      .set('Origin', TEST_WEB_ORIGIN)
      .set('X-CSRF-Token', csrf.token)
      .send({ tenantId })
      .expect(403);
    // A recusa entra na trilha do cliente com a pessoa de verdade (que continua sendo da Verax no banco).
    const denied = await prisma.auditLog.findFirst({
      where: { actorId: staff.id, action: 'POST /v1/session/tenant' },
      select: { tenantId: true, outcome: true, statusCode: true },
    });
    expect(denied).toMatchObject({ tenantId, statusCode: 403 });
    expect((await prisma.user.findUnique({ where: { id: staff.id }, select: { role: true } }))?.role).toBe(
      'admin_verax',
    );
  });

  it('o que o cliente vê responde no escopo dele (os usuários do cliente)', async () => {
    await server().get('/v1/users').set('Cookie', staff.cookie).expect(200);
  });

  it('os avisos por e-mail não se aplicam (só vão a quem é do cliente)', async () => {
    const response = await server()
      .get('/v1/notification-preferences')
      .set('Cookie', staff.cookie)
      .expect(200);
    expect(response.body).toEqual({ incidentEmails: false, eligible: false });
  });

  it('o login continua com o "Entrar com o Admin master"', async () => {
    const response = await server().get('/v1/auth/client-config').expect(200);
    expect((response.body as { adminMasterUrl: unknown }).adminMasterUrl).toBe('https://admin.example.com/');
  });

  it('com um segundo cliente ativo, a equipe volta à visão dela (nunca cai num cliente qualquer)', async () => {
    await createTenant(app as NestExpressApplication, 'Cliente Demo B');
    const identity = await me();
    expect(identity).toMatchObject({ role: 'admin_verax', tenantId: null, scopeTenantId: null });
    await server().get('/v1/tenants').set('Cookie', staff.cookie).expect(200);
  });
});
