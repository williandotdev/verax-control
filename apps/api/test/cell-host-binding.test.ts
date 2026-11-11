import 'reflect-metadata';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { escalationTokenHash } from '../src/escalation/escalation-tokens.js';
import { assignTenantHost, TenantHostConflict } from '../src/tenants/tenant-host.js';
import { cookieHeader, createTenant, createUser, hasSessionCookie } from './support/auth-helpers.js';
import {
  apiHostOf,
  createCellTenant,
  createSignedInUserOnHost,
  csrfOnHost,
  fillPath,
  listHttpRoutes,
  onHost,
  panelOf,
  signInOnHost,
  testCell,
  uniqueSlug,
} from './support/cell.js';
import { createApp } from './support/create-app.js';
import { LogCapture } from './support/log-capture.js';
import { MemoryMailTransport } from './support/memory-mail.js';
import { totp } from './support/totp.js';

const CELL = testCell();
const A = uniqueSlug('a');
const B = uniqueSlug('b');
const STAFF = CELL.staffSlug;

/** A recusa do login com senha errada, do Better Auth (a resposta que nenhum outro caso pode distinguir). */
const INVALID_CREDENTIALS = { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' };

/**
 * Corpo válido das escritas com parâmetro, para a varredura chegar ao escopo do cliente (e não parar na validação).
 * Rota de escrita fora daqui vai com `{}`: a recusa da validação também não alcança nada.
 */
const WRITE_BODIES: Readonly<Record<string, object>> = {
  'patch /v1/users/:id': { status: 'disabled' },
  'patch /v1/cloud-accounts/:id': { status: 'inactive' },
  'patch /v1/findings/:id/status': { status: 'resolved' },
  'post /v1/findings/:id/comments': { body: 'Comentário vindo de A' },
  'patch /v1/incidents/:id': { status: 'resolved' },
  'patch /v1/protected-resources/:id': { reason: 'Alterado por A' },
  'patch /v1/alert-exceptions/:id': { reason: 'Alterado por A' },
  'patch /v1/tenants/:id': { name: 'Alterado por A' },
};

/** O corpo de uma resposta da API, nos campos que os testes leem. */
const bodyOf = (response: request.Response) =>
  response.body as { id: string; message?: string; code?: string; user: { id: string } };

const accountId = (): string => String(randomInt(100_000_000_000, 999_999_999_999));
const bucket = (): string => `vx-ce01-${randomUUID().slice(0, 18)}`;

/**
 * Célula compartilhada (CE-01): dois clientes (A e B) e a equipe da Verax no mesmo nó, cada um no próprio endereço. O
 * endereço (`Host`) decide de quem é a requisição: a sessão de um não vale no endereço do outro, o login só olha o
 * cliente do endereço, a origem aceita é a do painel do endereço, e os IDs de B usados no endereço de A não alcançam
 * nada de B.
 */
describe('célula: cada requisição presa ao cliente do endereço (CE-01)', () => {
  const capture = new LogCapture();
  const mailbox = new MemoryMailTransport();
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let staffTenant: string;
  let adminA: Awaited<ReturnType<typeof createSignedInUserOnHost>>;
  let adminB: Awaited<ReturnType<typeof createSignedInUserOnHost>>;

  /** Escrita autenticada no endereço `slug`, com a sessão e o token CSRF dela. */
  async function writer(slug: string, cookie: string, origin = panelOf(slug)) {
    const session = await csrfOnHost(app, slug, cookie);
    const call = onHost(app, slug, origin);
    return (method: 'post' | 'put' | 'patch' | 'delete', path: string) =>
      call(method, path).set('Cookie', session.cookie).set('X-CSRF-Token', session.token);
  }

  beforeAll(async () => {
    app = await createApp({ cell: CELL, capture, mailbox });
    // Um servidor só, escutando, para as centenas de requisições da varredura (sem um `listen` por requisição).
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
    tenantA = await createCellTenant(app, A);
    tenantB = await createCellTenant(app, B);
    staffTenant = await createCellTenant(app, STAFF);
    adminA = await createSignedInUserOnHost(app, A, { role: 'admin_cliente', tenantId: tenantA });
    adminB = await createSignedInUserOnHost(app, B, { role: 'admin_cliente', tenantId: tenantB });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('endereço do cliente (gravado só pelo sistema)', () => {
    it('grava uma vez; repetir o mesmo par não muda nada; outro par é recusado', async () => {
      const tenant = await createTenant(app, 'Cliente endereço');
      const slug = uniqueSlug('e');
      await assignTenantHost(prisma, tenant, slug);
      await assignTenantHost(prisma, tenant, slug);
      await expect(assignTenantHost(prisma, tenant, uniqueSlug('f'))).rejects.toBeInstanceOf(
        TenantHostConflict,
      );
      await expect(assignTenantHost(prisma, tenantB, slug)).rejects.toBeInstanceOf(TenantHostConflict);
      await expect(assignTenantHost(prisma, tenant, 'xn--abc')).rejects.toBeInstanceOf(TenantHostConflict);
      expect(await prisma.tenantHost.findMany({ where: { slug } })).toEqual([
        expect.objectContaining({ tenantId: tenant, slug }),
      ]);
    });

    it('o banco recusa trocar o endereço de dono ou de nome, e subdomínio fora do formato', async () => {
      await expect(
        prisma.tenantHost.update({ where: { tenantId: tenantA }, data: { tenantId: tenantB } }),
      ).rejects.toThrow();
      await expect(
        prisma.tenantHost.update({ where: { tenantId: tenantA }, data: { slug: uniqueSlug('x') } }),
      ).rejects.toThrow();
      const tenant = await createTenant(app, 'Cliente formato');
      await expect(
        prisma.tenantHost.create({ data: { tenantId: tenant, slug: 'Cliente' } }),
      ).rejects.toThrow();
      expect(await prisma.tenantHost.findUniqueOrThrow({ where: { tenantId: tenantA } })).toMatchObject({
        slug: A,
      });
    });
  });

  describe('a sessão só vale no endereço onde nasceu', () => {
    it('grava o cliente do endereço na sessão e vale nele', async () => {
      const me = await onHost(app, A)('get', '/v1/me').set('Cookie', adminA.cookie).expect(200);
      expect(me.body).toMatchObject({ tenantId: tenantA, scopeTenantId: tenantA });
      const sessions = await prisma.session.findMany({ where: { userId: adminA.id } });
      expect(sessions.length).toBeGreaterThan(0);
      expect(sessions.every((session) => session.hostTenantId === tenantA)).toBe(true);
    });

    it.each([
      ['no endereço de B', B],
      ['no endereço da equipe', STAFF],
    ])('o cookie de A levado %s: 401, e a sessão cai também em A', async (_label, other) => {
      const user = await createSignedInUserOnHost(app, A, { role: 'leitura', tenantId: tenantA });
      await onHost(app, other)('get', '/v1/me').set('Cookie', user.cookie).expect(401);
      expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
      await onHost(app, A)('get', '/v1/me').set('Cookie', user.cookie).expect(401);
    });

    it('nas rotas de sessão do Better Auth também (listar sessões), e a sessão cai', async () => {
      const user = await createSignedInUserOnHost(app, A, { role: 'leitura', tenantId: tenantA });
      await onHost(app, B)('get', '/v1/auth/list-sessions').set('Cookie', user.cookie).expect(401);
      expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
      // Sem sessão, o Better Auth responde a leitura com nada (e o painel volta ao login).
      await onHost(app, A)('get', '/v1/auth/get-session').set('Cookie', user.cookie).expect(200, 'null');
    });

    it('a sessão sem endereço gravado (de antes da célula) não vale', async () => {
      const user = await createSignedInUserOnHost(app, A, { role: 'leitura', tenantId: tenantA });
      await prisma.session.updateMany({ where: { userId: user.id }, data: { hostTenantId: null } });
      await onHost(app, A)('get', '/v1/me').set('Cookie', user.cookie).expect(401);
    });

    it('a sessão gravada com o endereço de outro cliente não vale em nenhum dos dois', async () => {
      const user = await createSignedInUserOnHost(app, A, { role: 'leitura', tenantId: tenantA });
      await prisma.session.updateMany({ where: { userId: user.id }, data: { hostTenantId: tenantB } });
      await onHost(app, B)('get', '/v1/me').set('Cookie', user.cookie).expect(401);
    });
  });

  describe('o login olha só o cliente do endereço', () => {
    it('usuário de A no endereço de B, com a senha certa: a mesma recusa da senha errada e do e-mail que não existe', async () => {
      const user = await createUser(app, { role: 'leitura', tenantId: tenantA });
      const elsewhere = await signInOnHost(app, B, user.email, user.password);
      const wrongPassword = await signInOnHost(app, A, user.email, 'senha-errada-bem-longa-1');
      const unknown = await signInOnHost(app, B, `ninguem-${randomUUID()}@cliente.example`, user.password);
      for (const response of [elsewhere, wrongPassword, unknown]) {
        expect(response.status).toBe(401);
        expect(response.body).toEqual(INVALID_CREDENTIALS);
        expect(hasSessionCookie(cookieHeader(response.headers['set-cookie']))).toBe(false);
      }
      expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    });

    it('a recusa gasta a tentativa da conta: na sexta, o bloqueio vale até no endereço certo', async () => {
      const user = await createUser(app, { role: 'leitura', tenantId: tenantA });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await signInOnHost(app, B, user.email, user.password).expect(401);
      }
      expect(await prisma.loginAttempt.findUnique({ where: { email: user.email } })).toMatchObject({
        failures: 5,
      });
      const locked = await signInOnHost(app, A, user.email, user.password).expect(429);
      expect(locked.body).toMatchObject({ code: 'ACCOUNT_LOCKED' });
    });

    it('a recusa entra na trilha igual à da senha errada (anônima, 401, sem cliente)', async () => {
      const user = await createUser(app, { role: 'leitura', tenantId: tenantA });
      await signInOnHost(app, B, user.email, user.password).expect(401);
      await signInOnHost(app, A, user.email, 'senha-errada-bem-longa-1').expect(401);
      const entries = await prisma.auditLog.findMany({
        where: { action: 'auth.sign_in', resourceId: user.email },
        select: {
          actorType: true,
          actorId: true,
          tenantId: true,
          outcome: true,
          statusCode: true,
          resourceType: true,
        },
      });
      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual(entries[1]);
      expect(entries[0]).toMatchObject({
        actorType: 'anonymous',
        outcome: 'denied',
        statusCode: 401,
        tenantId: null,
      });
    });

    it('o admin_verax só entra no endereço da equipe', async () => {
      const admin = await createUser(app, { role: 'admin_verax' });
      for (const slug of [A, B]) {
        const refused = await signInOnHost(app, slug, admin.email, admin.password).expect(401);
        expect(refused.body).toEqual(INVALID_CREDENTIALS);
      }
      const accepted = await signInOnHost(app, STAFF, admin.email, admin.password).expect(200);
      expect(hasSessionCookie(cookieHeader(accepted.headers['set-cookie']))).toBe(true);
    });

    it('a pessoa do cliente da equipe entra no endereço da equipe; a de A, não', async () => {
      const staffUser = await createUser(app, { role: 'analista_cliente', tenantId: staffTenant });
      await signInOnHost(app, STAFF, staffUser.email, staffUser.password).expect(200);
      const userA = await createUser(app, { role: 'admin_cliente', tenantId: tenantA });
      await signInOnHost(app, STAFF, userA.email, userA.password).expect(401);
    });

    it('o código do MFA da senha certa em A, levado ao endereço de B: recusado, sem sessão', async () => {
      const user = await createSignedInUserOnHost(app, A, { role: 'leitura', tenantId: tenantA });
      const before = await prisma.session.count({ where: { userId: user.id } });
      const first = await signInOnHost(app, A, user.email, user.password).expect(200);
      expect(first.body).toMatchObject({ twoFactorRedirect: true });
      const challenge = cookieHeader(first.headers['set-cookie']);
      const verify = await onHost(app, B)('post', '/v1/auth/two-factor/verify-totp')
        .set('Cookie', challenge)
        .send({ code: totp(user.secret, Date.now() + 30_000) });
      expect(verify.status).toBe(401);
      expect(hasSessionCookie(cookieHeader(verify.headers['set-cookie']))).toBe(false);
      expect(await prisma.session.count({ where: { userId: user.id } })).toBe(before);
    });
  });

  describe('só o painel do cliente do endereço chama a API', () => {
    it('CORS: o painel de A recebe a permissão no endereço de A; o de B e o da equipe, não', async () => {
      const preflight = (origin: string) =>
        request(app.getHttpServer())
          .options('/v1/me')
          .set('Host', apiHostOf(A))
          .set('Origin', origin)
          .set('Access-Control-Request-Method', 'GET');
      const own = await preflight(panelOf(A));
      expect(own.headers['access-control-allow-origin']).toBe(panelOf(A));
      expect(own.headers['access-control-allow-credentials']).toBe('true');
      for (const origin of [panelOf(B), panelOf(STAFF), 'https://outro.example']) {
        expect((await preflight(origin)).headers['access-control-allow-origin'], origin).toBeUndefined();
      }
      const simple = await onHost(
        app,
        A,
        panelOf(B),
      )('get', '/v1/me')
        .set('Cookie', adminA.cookie)
        .expect(200);
      expect(simple.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('login no endereço de A vindo do painel de B: 403, sem gastar tentativa', async () => {
      const user = await createUser(app, { role: 'leitura', tenantId: tenantA });
      await onHost(
        app,
        A,
        panelOf(B),
      )('post', '/v1/auth/sign-in/email')
        .send({ email: user.email, password: user.password })
        .expect(403);
      expect(await prisma.loginAttempt.findUnique({ where: { email: user.email } })).toBeNull();
    });

    it('escrita no endereço de A vinda do painel de B, com a sessão e o token de A: 403 do CSRF', async () => {
      const write = await writer(A, adminA.cookie, panelOf(B));
      const response = await write('post', '/v1/protected-resources')
        .send({ type: 'aws_account', identifier: accountId(), reason: 'Teste de origem' })
        .expect(403);
      expect(response.body).toMatchObject({ code: 'CSRF_INVALID' });
    });
  });

  describe('redefinição de senha', () => {
    it('no endereço do cliente: o link leva ao painel dele', async () => {
      const user = await createUser(app, { role: 'leitura', tenantId: tenantA });
      await onHost(app, A)('post', '/v1/auth/request-password-reset').send({ email: user.email }).expect(200);
      await vi.waitFor(() => expect(mailbox.to(user.email)).toHaveLength(1));
      expect(mailbox.to(user.email)[0]?.text).toContain(`${panelOf(A)}/redefinir-senha#token=`);
    });

    it('no endereço de outro cliente: a mesma resposta, e nenhum e-mail sai', async () => {
      const user = await createUser(app, { role: 'leitura', tenantId: tenantA });
      const elsewhere = await onHost(app, B)('post', '/v1/auth/request-password-reset')
        .send({ email: user.email })
        .expect(200);
      const unknown = await onHost(app, B)('post', '/v1/auth/request-password-reset')
        .send({ email: `ninguem-${randomUUID()}@cliente.example` })
        .expect(200);
      expect(elsewhere.body).toEqual(unknown.body);
      // A mensagem sai em segundo plano: dá tempo de ela aparecer, se fosse sair.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(mailbox.to(user.email)).toEqual([]);
    });
  });

  describe('troca de cliente do admin_verax', () => {
    it('no endereço da equipe, entra no cliente A (auditado na trilha de A) e lê os dados dele', async () => {
      const admin = await createSignedInUserOnHost(app, STAFF, { role: 'admin_verax' });
      const write = await writer(STAFF, admin.cookie);
      await write('post', '/v1/session/tenant').send({ tenantId: tenantA }).expect(200);
      const users = await onHost(app, STAFF)('get', '/v1/users').set('Cookie', admin.cookie).expect(200);
      expect(JSON.stringify(users.body)).toContain(adminA.email);
      expect(JSON.stringify(users.body)).not.toContain(adminB.email);
      expect(
        await prisma.auditLog.count({
          where: { action: 'session.switch_tenant', tenantId: tenantA, actorId: admin.id },
        }),
      ).toBe(1);
    });
  });

  describe('links do contato de escalonamento', () => {
    it('o link de A aberto no endereço de B: a mesma recusa do link inválido; no de A, vale', async () => {
      const token = randomBytes(32).toString('base64url');
      await prisma.tenant.update({
        where: { id: tenantA },
        data: {
          escalationEmail: 'contato@cliente-a.example',
          escalationState: 'pending',
          escalationGeneration: 1,
        },
      });
      await prisma.escalationContactToken.create({
        data: {
          tokenHash: escalationTokenHash(token),
          tenantId: tenantA,
          purpose: 'confirm',
          generation: 1,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      const invalid = await onHost(app, B)('post', '/v1/public/escalation-contact/confirm')
        .send({ token: randomBytes(32).toString('base64url') })
        .expect(400);
      const elsewhere = await onHost(app, B)('post', '/v1/public/escalation-contact/confirm')
        .send({ token })
        .expect(400);
      expect(bodyOf(elsewhere).message).toBe(bodyOf(invalid).message);
      expect(bodyOf(elsewhere).code).toBe(bodyOf(invalid).code);
      expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenantA } })).escalationState).toBe(
        'pending',
      );
      await onHost(app, A)('post', '/v1/public/escalation-contact/confirm').send({ token }).expect(200, {
        status: 'confirmed',
      });
    });
  });

  describe('conflitos de unicidade não dizem que a outra parte é de outro cliente', () => {
    it('e-mail de usuário: a mesma recusa para o de outro cliente, o da equipe e o do próprio cliente', async () => {
      const write = await writer(B, adminB.cookie);
      const staffAdmin = await createUser(app, { role: 'admin_verax' });
      const bodies = [];
      for (const email of [adminA.email, staffAdmin.email, adminB.email]) {
        const response = await write('post', '/v1/users')
          .send({ email, name: 'Pessoa', role: 'leitura' })
          .expect(409);
        const { requestId: _requestId, ...body } = response.body as Record<string, unknown>;
        bodies.push(body);
      }
      expect(bodies[0]).toEqual(bodies[2]);
      expect(bodies[1]).toEqual(bodies[2]);
    });

    it('ID de conta da AWS: a mesma recusa para a conta de outro cliente e a do próprio', async () => {
      const writeA = await writer(A, adminA.cookie);
      const writeB = await writer(B, adminB.cookie);
      const fromA = accountId();
      const fromB = accountId();
      const account = (id: string) => ({ provider: 'aws', accountId: id, regions: ['sa-east-1'] });
      await writeA('post', '/v1/cloud-accounts').send(account(fromA)).expect(201);
      await writeB('post', '/v1/cloud-accounts').send(account(fromB)).expect(201);
      const other = await writeB('post', '/v1/cloud-accounts').send(account(fromA)).expect(409);
      const own = await writeB('post', '/v1/cloud-accounts').send(account(fromB)).expect(409);
      expect(bodyOf(other).message).toBe(bodyOf(own).message);
      expect(bodyOf(other).message).not.toMatch(/cliente/i);
    });

    it('bucket de log de outro cliente: a frase não aponta para o outro cliente', async () => {
      const writeA = await writer(A, adminA.cookie);
      const writeB = await writer(B, adminB.cookie);
      const name = bucket();
      const account = () => ({
        provider: 'aws',
        accountId: accountId(),
        regions: ['sa-east-1'],
        buckets: { cloudtrail: name },
      });
      await writeA('post', '/v1/cloud-accounts').send(account()).expect(201);
      const refused = await writeB('post', '/v1/cloud-accounts').send(account()).expect(409);
      expect(bodyOf(refused).message).toBe(`O bucket ${name} já está cadastrado`);
    });
  });

  describe('IDs de B usados no endereço de A, em toda rota com parâmetro', () => {
    /** Tudo o que é de B no banco, para provar que nada mudou depois da varredura. */
    async function snapshotOfB(): Promise<string> {
      const where = { tenantId: tenantB };
      return JSON.stringify(
        await Promise.all([
          prisma.tenant.findUniqueOrThrow({ where: { id: tenantB } }),
          prisma.tenantHost.findMany({ where }),
          prisma.user.findMany({ where, orderBy: { id: 'asc' } }),
          prisma.cloudAccount.findMany({ where, orderBy: { id: 'asc' } }),
          prisma.protectedResource.findMany({ where, orderBy: { id: 'asc' } }),
          prisma.alertException.findMany({ where, orderBy: { id: 'asc' } }),
          prisma.finding.findMany({ where, orderBy: { id: 'asc' } }),
          prisma.incident.findMany({ where, orderBy: { id: 'asc' } }),
          prisma.auditLog.count({ where }),
          prisma.session.count({ where: { user: { tenantId: tenantB } } }),
        ]),
      );
    }

    it('nenhuma alcança nada de B: nunca 2xx, nada de B na resposta, nada de B alterado', async () => {
      const writeB = await writer(B, adminB.cookie);
      const ids: string[] = [tenantB, adminB.id];
      ids.push(
        bodyOf(
          await writeB('post', '/v1/cloud-accounts')
            .send({ provider: 'aws', accountId: accountId(), regions: ['sa-east-1'] })
            .expect(201),
        ).id,
        bodyOf(
          await writeB('post', '/v1/protected-resources')
            .send({ type: 'aws_account', identifier: accountId(), reason: 'Conta de produção' })
            .expect(201),
        ).id,
        bodyOf(
          await writeB('post', '/v1/alert-exceptions')
            .send({
              ruleId: '80202',
              field: 'ip',
              value: '203.0.113.0/24',
              reason: 'Varredura autorizada',
              expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            })
            .expect(201),
        ).id,
        bodyOf(
          await writeB('post', '/v1/users')
            .send({ email: `pessoa-b-${randomUUID()}@cliente.example`, name: 'Pessoa B', role: 'leitura' })
            .expect(201),
        ).user.id,
      );
      const incident = await prisma.incident.create({
        data: {
          tenantId: tenantB,
          severity: 'high',
          riskScore: 50,
          findingCount: 1,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
          keys: ['ip:198.51.100.23'],
          accounts: ['111111111111'],
          resources: [],
          mitreTactics: [],
          mitreTechniques: [],
        },
      });
      const finding = await prisma.finding.create({
        data: {
          tenantId: tenantB,
          incidentId: incident.id,
          accountId: '111111111111',
          source: 'wazuh',
          sourceEventId: randomUUID(),
          logSource: 'cloudtrail',
          occurredAt: new Date(),
          severity: 'high',
          ruleId: '80202',
          ruleLevel: 10,
          title: 'Achado de B',
        },
      });
      ids.push(incident.id, finding.id);
      // As ids são reais: B as lê no próprio endereço.
      await onHost(app, B)('get', `/v1/findings/${finding.id}`).set('Cookie', adminB.cookie).expect(200);

      const before = await snapshotOfB();
      const writeA = await writer(A, adminA.cookie);
      const routes = listHttpRoutes(app).filter(
        ({ path }) => path.includes(':') && !path.startsWith('/v1/auth/') && !path.startsWith('/health'),
      );
      expect(routes.length).toBeGreaterThan(15);
      const reached: string[] = [];
      const refusedByScope = new Set<string>();
      for (const { method, path } of routes) {
        const route = `${method} ${path}`;
        for (const id of ids) {
          const concrete = fillPath(path, id);
          const response =
            method === 'get'
              ? await onHost(app, A)('get', concrete).set('Cookie', adminA.cookie)
              : await writeA(method as 'post' | 'put' | 'patch' | 'delete', concrete).send(
                  WRITE_BODIES[route] ?? {},
                );
          if (response.status === 403 || response.status === 404) refusedByScope.add(route);
          const text = JSON.stringify(response.body ?? null);
          const leaked = ids.filter((other) => text.includes(other));
          if ((response.status >= 200 && response.status < 300) || leaked.length > 0) {
            reached.push(`${method.toUpperCase()} ${path} (${id}): ${response.status} ${text.slice(0, 200)}`);
          }
        }
      }
      expect(reached).toEqual([]);
      // As escritas com corpo válido chegaram à permissão ou ao escopo (403 ou 404), não pararam na validação.
      expect(Object.keys(WRITE_BODIES).filter((route) => !refusedByScope.has(route))).toEqual([]);
      expect(await snapshotOfB()).toBe(before);
    }, 180_000);
  });
});
