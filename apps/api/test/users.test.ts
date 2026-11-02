import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { userSchema } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { createSignedInUser, createTenant, createUser, signIn, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import { MemoryMailTransport } from './support/memory-mail.js';
import { describeTenantIsolation, type TestSession } from './support/tenant-isolation.js';

type Session = TestSession & { userId: string };

describe('usuários do cliente (T3.2)', () => {
  const mailbox = new MemoryMailTransport();
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let adminA: Session;
  let adminB: Session;

  async function sessionFor(
    tenantId: string | null,
    role: 'admin_cliente' | 'analista_cliente' | 'leitura' | 'admin_verax',
  ): Promise<Session> {
    const user = await createSignedInUser(app, { role, tenantId });
    const { cookie, token } = await withCsrf(app, user.cookie);
    return { cookie, csrfToken: token, userId: user.id };
  }

  const call = (session: Session) => {
    const server = request(app.getHttpServer());
    const write = (method: 'post' | 'patch' | 'delete', path: string) =>
      server[method](path)
        .set('Cookie', session.cookie)
        .set('Origin', TEST_WEB_ORIGIN)
        .set('X-CSRF-Token', session.csrfToken);
    return {
      get: (path: string) => server.get(path).set('Cookie', session.cookie),
      post: (path: string, body: object = {}) => write('post', path).send(body),
      patch: (path: string, body: object) => write('patch', path).send(body),
      delete: (path: string) => write('delete', path),
    };
  };
  const entryOf = (response: request.Response) =>
    prisma.auditLog.findFirstOrThrow({ where: { requestId: response.headers['x-request-id'] } });
  let counter = 0;
  const email = () => `convidado-${(counter += 1)}-${Date.now()}@cliente.example`;

  beforeAll(async () => {
    app = await createApp({ mailbox });
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente A');
    tenantB = await createTenant(app, 'Cliente B');
    adminA = await sessionFor(tenantA, 'admin_cliente');
    adminB = await sessionFor(tenantB, 'admin_cliente');
  });

  afterAll(async () => {
    await app.close();
  });

  describeTenantIsolation({
    resource: 'usuários',
    basePath: '/v1/users',
    context: () => ({ app, sessionA: adminA, sessionB: adminB }),
    createInTenantB: async () => (await createUser(app, { role: 'leitura', tenantId: tenantB })).id,
    readDirect: (id) => prisma.user.findUniqueOrThrow({ where: { id } }),
    patchBody: { role: 'admin_cliente' },
    hasDelete: true,
  });

  describe('permissões', () => {
    it.each(['analista_cliente', 'leitura'] as const)('%s não lê nem gerencia usuários', async (role) => {
      const session = await sessionFor(tenantA, role);
      const target = await createUser(app, { role: 'leitura', tenantId: tenantA });
      await call(session).get('/v1/users').expect(403);
      await call(session).post('/v1/users', { email: email(), name: 'X', role: 'leitura' }).expect(403);
      await call(session).patch(`/v1/users/${target.id}`, { role: 'admin_cliente' }).expect(403);
      await call(session).delete(`/v1/users/${target.id}`).expect(403);
      await call(session).post(`/v1/users/${target.id}/mfa-reset`).expect(403);
    });

    it('admin_verax gerencia o cliente selecionado; sem seleção, 409 TENANT_REQUIRED', async () => {
      const verax = await sessionFor(null, 'admin_verax');
      const blocked = await call(verax).get('/v1/users').expect(409);
      expect(blocked.body).toMatchObject({ code: 'TENANT_REQUIRED' });
      await call(verax).post('/v1/session/tenant', { tenantId: tenantA }).expect(200);
      const list = await call(verax).get('/v1/users?pageSize=100').expect(200);
      const ids = (list.body as { items: { id: string }[] }).items.map((user) => user.id);
      expect(ids).toContain(adminA.userId);
    });
  });

  describe('listagem', () => {
    it('só usuários do próprio cliente, nunca admin_verax', async () => {
      await sessionFor(null, 'admin_verax');
      const response = await call(adminA).get('/v1/users?pageSize=100').expect(200);
      const { items } = response.body as { items: unknown[] };
      for (const item of items) userSchema.parse(item);
      const inA = await prisma.user.count({ where: { tenantId: tenantA } });
      expect(items).toHaveLength(inA);
    });
  });

  describe('convite', () => {
    it('convida no cliente da sessão, manda o link e audita na trilha do cliente', async () => {
      const address = email();
      const created = await call(adminA)
        .post('/v1/users', { email: address, name: 'Nova', role: 'analista_cliente' })
        .expect(201);
      expect(userSchema.parse(created.body)).toMatchObject({
        email: address,
        status: 'invited',
        mfaEnabled: false,
      });
      const stored = await prisma.user.findUniqueOrThrow({ where: { email: address } });
      expect(stored.tenantId).toBe(tenantA);
      await vi.waitFor(() => expect(mailbox.lastToken(address)).toBeDefined());
      expect(await entryOf(created)).toMatchObject({
        action: 'user.invite',
        tenantId: tenantA,
        outcome: 'success',
      });
    });

    it.each([
      ['papel admin_verax', { role: 'admin_verax' }],
      ['cliente no corpo', { role: 'leitura', tenantId: 'x' }],
      ['status no corpo', { role: 'leitura', status: 'active' }],
    ])('recusa %s (400)', async (_label, extra) => {
      await call(adminA)
        .post('/v1/users', { email: email(), name: 'X', ...extra })
        .expect(400);
    });

    it('e-mail já cadastrado responde 409', async () => {
      const existing = await createUser(app, { role: 'leitura', tenantId: tenantB });
      await call(adminA).post('/v1/users', { email: existing.email, name: 'X', role: 'leitura' }).expect(409);
    });

    it('reenvio só para convidado', async () => {
      const address = email();
      const created = await call(adminA)
        .post('/v1/users', { email: address, name: 'Reenvio', role: 'leitura' })
        .expect(201);
      const id = (created.body as { id: string }).id;
      await vi.waitFor(() => expect(mailbox.to(address)).toHaveLength(1));
      await call(adminA).post(`/v1/users/${id}/invitation`).expect(204);
      await vi.waitFor(() => expect(mailbox.to(address)).toHaveLength(2));

      const active = await createUser(app, { role: 'leitura', tenantId: tenantA });
      await call(adminA).post(`/v1/users/${active.id}/invitation`).expect(409);
    });
  });

  describe('papel e status', () => {
    it('troca o papel com estado anterior e novo na auditoria', async () => {
      const target = await createUser(app, { role: 'leitura', tenantId: tenantA });
      const updated = await call(adminA)
        .patch(`/v1/users/${target.id}`, { role: 'analista_cliente' })
        .expect(200);
      expect(updated.body).toMatchObject({ role: 'analista_cliente' });
      expect(await entryOf(updated)).toMatchObject({
        action: 'user.update',
        tenantId: tenantA,
        before: { role: 'leitura' },
        after: { role: 'analista_cliente' },
      });
    });

    it('ninguém altera o próprio papel, status nem MFA', async () => {
      await call(adminA).patch(`/v1/users/${adminA.userId}`, { role: 'leitura' }).expect(403);
      await call(adminA).delete(`/v1/users/${adminA.userId}`).expect(403);
      await call(adminA).post(`/v1/users/${adminA.userId}/mfa-reset`).expect(403);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: adminA.userId } })).role).toBe(
        'admin_cliente',
      );
    });

    it('desativar derruba as sessões na hora; reativar devolve o acesso', async () => {
      const target = await createUser(app, { role: 'leitura', tenantId: tenantA });
      const cookie = await signIn(app, target.email, target.password);
      const removed = await call(adminA).delete(`/v1/users/${target.id}`).expect(204);
      expect(await prisma.session.count({ where: { userId: target.id } })).toBe(0);
      await request(app.getHttpServer()).get('/v1/me').set('Cookie', cookie).expect(401);
      expect(await entryOf(removed)).toMatchObject({
        action: 'user.deactivate',
        after: { status: 'disabled' },
      });

      await call(adminA).patch(`/v1/users/${target.id}`, { status: 'active' }).expect(200);
      await signIn(app, target.email, target.password);
    });

    it('convidado não vira ativo por aqui', async () => {
      const target = await createUser(app, { role: 'leitura', tenantId: tenantA, status: 'invited' });
      await call(adminA).patch(`/v1/users/${target.id}`, { status: 'active' }).expect(409);
    });
  });

  it('redefinir o MFA de quem perdeu o autenticador: sessões caem e o próximo login pede o cadastro', async () => {
    const target = await createSignedInUser(app, { role: 'leitura', tenantId: tenantA });
    const reset = await call(adminA).post(`/v1/users/${target.id}/mfa-reset`).expect(204);

    expect(await prisma.twoFactor.count({ where: { userId: target.id } })).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).twoFactorEnabled).toBe(false);
    await request(app.getHttpServer()).get('/v1/me').set('Cookie', target.cookie).expect(401);
    const fresh = await signIn(app, target.email, target.password);
    const me = await request(app.getHttpServer()).get('/v1/me').set('Cookie', fresh).expect(200);
    expect(me.body).toMatchObject({ mfaEnabled: false });
    expect(await entryOf(reset)).toMatchObject({ action: 'user.reset_mfa', tenantId: tenantA });
  });
});
