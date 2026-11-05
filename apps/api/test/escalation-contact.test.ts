import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  ESCALATION_CONFIRMATION_INTERVAL_MINUTES,
  escalationContactResponseSchema,
  tenantCreatedSchema,
  tenantSchema,
} from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { escalationTokenHash, mintEscalationTokens } from '../src/escalation/escalation-tokens.js';
import type { EscalationTokenPurpose } from '../src/generated/prisma/client.js';
import { createSignedInUser, createTenant, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import { LogCapture } from './support/log-capture.js';
import type { TestSession } from './support/tenant-isolation.js';

type Session = TestSession & { userId: string };
type Role = 'admin_cliente' | 'analista_cliente' | 'leitura' | 'admin_verax';

const PATH = '/v1/escalation-contact';
const HOUR = 3_600_000;

/**
 * Contato de escalonamento (D8): a tela do administrador do cliente (ler, trocar, pedir a confirmação de novo), o
 * cadastro de clientes da Verax e os links públicos do e-mail (confirmar e descadastrar). A entrega pelo worker está em
 * `notifications.test.ts`, o único arquivo que roda o despachante (ele lê a fila de todos os clientes). Por isso, aqui,
 * os links são gerados direto pelo mesmo código do worker, e nada depende de o pedido de confirmação ainda estar na fila.
 */
describe('contato de escalonamento (D8)', () => {
  const capture = new LogCapture();
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  const sessions = new Map<string, Session>();
  const seen: string[] = [];

  async function sessionFor(tenantId: string | null, role: Role): Promise<Session> {
    const user = await createSignedInUser(app, { role, tenantId });
    const { cookie, token } = await withCsrf(app, user.cookie);
    return { cookie, csrfToken: token, userId: user.id };
  }

  const session = (key: string): Session => {
    const found = sessions.get(key);
    if (!found) throw new Error(`sem sessão ${key}`);
    return found;
  };

  const call = (current: Session) => {
    const server = request(app.getHttpServer());
    const write = (method: 'put' | 'patch' | 'post', path: string) =>
      server[method](path)
        .set('Cookie', current.cookie)
        .set('Origin', TEST_WEB_ORIGIN)
        .set('X-CSRF-Token', current.csrfToken);
    return {
      get: (path: string) => server.get(path).set('Cookie', current.cookie),
      put: (path: string, body: object) => write('put', path).send(body),
      patch: (path: string, body: object) => write('patch', path).send(body),
      post: (path: string, body: object = {}) => write('post', path).send(body),
    };
  };

  const publicLink = (path: 'confirm' | 'unsubscribe', token: string) =>
    request(app.getHttpServer())
      .post(`/v1/public/escalation-contact/${path}`)
      .set('Origin', TEST_WEB_ORIGIN)
      .send({ token });

  /** Os links como o worker os gera, para a geração atual do contato (ou a dada). */
  async function linksOf(
    tenantId: string,
    purposes: EscalationTokenPurpose[] = ['confirm', 'unsubscribe'],
    { generation, now = new Date() }: { generation?: number; now?: Date } = {},
  ): Promise<Partial<Record<EscalationTokenPurpose, string>>> {
    const current = await prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { escalationGeneration: true },
    });
    const values = await mintEscalationTokens(
      prisma.forTenant(tenantId),
      tenantId,
      generation ?? current.escalationGeneration,
      purposes,
      now,
    );
    seen.push(...Object.values(values));
    return values;
  }

  const contactRow = (tenantId: string) =>
    prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: {
        escalationName: true,
        escalationEmail: true,
        escalationState: true,
        escalationGeneration: true,
        escalationConfirmedAt: true,
        escalationUnsubscribedAt: true,
      },
    });
  const confirmations = (tenantId: string) =>
    prisma.forTenant(tenantId).notification.findMany({
      where: { kind: 'escalation_confirmation' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  /** O contato da resposta, conferido pelo schema da API. */
  const contactOf = (response: request.Response) =>
    escalationContactResponseSchema.parse(response.body).contact;
  const entryOf = (response: request.Response) =>
    prisma.auditLog.findFirstOrThrow({ where: { requestId: response.headers['x-request-id'] } });
  const address = (label: string) => {
    const value = `contato-${label}-${randomUUID()}@cliente.example`;
    seen.push(value);
    return value;
  };

  beforeAll(async () => {
    app = await createApp({ capture });
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente demo A (contato)');
    tenantB = await createTenant(app, 'Cliente demo B (contato)');
    sessions.set('adminA', await sessionFor(tenantA, 'admin_cliente'));
    sessions.set('analystA', await sessionFor(tenantA, 'analista_cliente'));
    sessions.set('readerA', await sessionFor(tenantA, 'leitura'));
    sessions.set('adminB', await sessionFor(tenantB, 'admin_cliente'));
    sessions.set('verax', await sessionFor(null, 'admin_verax'));
  });

  afterAll(async () => {
    await app.close();
  });

  describe('a tela do administrador do cliente', () => {
    it('só administradores leem e mudam; analista e leitura recebem 403; a Verax precisa escolher um cliente', async () => {
      const empty = await call(session('adminA')).get(PATH).expect(200);
      expect(escalationContactResponseSchema.parse(empty.body)).toEqual({ contact: null });
      for (const key of ['analystA', 'readerA']) {
        await call(session(key)).get(PATH).expect(403);
        await call(session(key))
          .put(PATH, { name: 'Intruso', email: address('intruso') })
          .expect(403);
        await call(session(key)).post(`${PATH}/confirmation`).expect(403);
      }
      expect((await contactRow(tenantA)).escalationEmail).toBeNull();
      const verax = await call(session('verax')).get(PATH).expect(409);
      expect(verax.body).toMatchObject({ code: 'TENANT_REQUIRED' });
      // Sem o token CSRF, a escrita é recusada.
      await request(app.getHttpServer())
        .put(PATH)
        .set('Cookie', session('adminA').cookie)
        .set('Origin', TEST_WEB_ORIGIN)
        .send({ name: 'Ana', email: address('sem-csrf') })
        .expect(403);
      // O estado nunca vem do corpo.
      await call(session('adminA'))
        .put(PATH, { name: 'Ana', email: address('estado'), status: 'confirmed' })
        .expect(400);
    });

    it('endereço novo: aguardando confirmação, geração nova e o pedido na fila; nome e telefone não mexem na confirmação', async () => {
      const email = address('a');
      const saved = await call(session('adminA'))
        .put(PATH, { name: 'Ana', email, phone: '+55 11 91234-5678' })
        .expect(200);
      const { contact } = escalationContactResponseSchema.parse(saved.body);
      expect(contact).toMatchObject({
        name: 'Ana',
        email,
        phone: '+55 11 91234-5678',
        status: 'pending',
        confirmedAt: null,
        unsubscribedAt: null,
      });
      expect(contact?.confirmationEmail?.status).toBeDefined();
      const first = await contactRow(tenantA);
      expect(first).toMatchObject({ escalationState: 'pending', escalationEmail: email });
      const queued = await confirmations(tenantA);
      expect(queued.at(-1)).toMatchObject({
        dedupeKey: `escalation-confirmation:${first.escalationGeneration}`,
        escalationGeneration: first.escalationGeneration,
        severity: null,
        incidentId: null,
        findingId: null,
      });
      // Nenhum endereço na fila.
      expect(JSON.stringify(queued)).not.toContain(email);
      expect(await entryOf(saved)).toMatchObject({
        action: 'escalation_contact.update',
        resourceType: 'tenant',
        resourceId: tenantA,
        tenantId: tenantA,
        outcome: 'success',
        before: null,
        after: expect.objectContaining({ email, status: 'pending' }) as unknown,
      });

      // Confirmado pelo link, mudar o nome, o telefone ou só as maiúsculas do endereço não recomeça nada.
      const { confirm } = await linksOf(tenantA, ['confirm']);
      await publicLink('confirm', confirm as string).expect(200, { status: 'confirmed' });
      const before = await confirmations(tenantA);
      const renamed = await call(session('adminA'))
        .put(PATH, { name: 'Ana Lima', email: email.toUpperCase() })
        .expect(200);
      expect(contactOf(renamed)).toMatchObject({ name: 'Ana Lima', status: 'confirmed', phone: null });
      const after = await contactRow(tenantA);
      expect(after.escalationGeneration).toBe(first.escalationGeneration);
      expect(after.escalationState).toBe('confirmed');
      expect(await confirmations(tenantA)).toHaveLength(before.length);
    });

    it('endereço trocado recomeça a confirmação: geração nova, datas limpas e os links anteriores deixam de valer', async () => {
      const email = address('troca-1');
      await call(session('adminA')).put(PATH, { name: 'Ana', email }).expect(200);
      const { confirm, unsubscribe } = await linksOf(tenantA);
      await publicLink('confirm', confirm as string).expect(200);
      const confirmed = await contactRow(tenantA);
      expect(confirmed.escalationConfirmedAt).not.toBeNull();

      const replacement = address('troca-2');
      const changed = await call(session('adminA'))
        .put(PATH, { name: 'Bia', email: replacement })
        .expect(200);
      expect(contactOf(changed)).toMatchObject({
        email: replacement,
        status: 'pending',
        confirmedAt: null,
      });
      const row = await contactRow(tenantA);
      expect(row).toMatchObject({
        escalationState: 'pending',
        escalationGeneration: confirmed.escalationGeneration + 1,
        escalationConfirmedAt: null,
      });
      // O link de descadastro do endereço anterior não vale mais, e o registro dele saiu do banco.
      await publicLink('unsubscribe', unsubscribe as string).expect(400);
      expect(
        await prisma.escalationContactToken.count({
          where: { tokenHash: escalationTokenHash(unsubscribe as string) },
        }),
      ).toBe(0);
      expect((await contactRow(tenantA)).escalationState).toBe('pending');
    });

    it('pedir a confirmação de novo: só aguardando ou descadastrado, os links anteriores deixam de valer, e no mínimo 5 min entre dois e-mails', async () => {
      await call(session('adminA'))
        .put(PATH, { name: 'Ana', email: address('reenvio') })
        .expect(200);
      const { confirm: old } = await linksOf(tenantA, ['confirm']);
      const generation = (await contactRow(tenantA)).escalationGeneration;
      const resent = await call(session('adminA')).post(`${PATH}/confirmation`).expect(200);
      expect(contactOf(resent)).toMatchObject({ status: 'pending' });
      expect((await contactRow(tenantA)).escalationGeneration).toBe(generation + 1);
      expect(await entryOf(resent)).toMatchObject({
        action: 'escalation_contact.resend',
        tenantId: tenantA,
        resourceId: tenantA,
      });
      await publicLink('confirm', old as string).expect(400);
      const [previous, latest] = (await confirmations(tenantA)).slice(-2);
      expect(latest?.escalationGeneration).toBe(generation + 1);
      expect(latest?.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
        (previous?.createdAt.getTime() ?? 0) + ESCALATION_CONFIRMATION_INTERVAL_MINUTES * 60_000,
      );

      // Confirmado: não há o que pedir de novo.
      const { confirm } = await linksOf(tenantA, ['confirm']);
      await publicLink('confirm', confirm as string).expect(200);
      const refused = await call(session('adminA')).post(`${PATH}/confirmation`).expect(409);
      expect(refused.body).toMatchObject({ code: 'ESCALATION_CONTACT_CONFIRMED' });

      // Descadastrado: só um novo pedido (auditado) o traz de volta, e ele volta a aguardar a confirmação.
      const { unsubscribe } = await linksOf(tenantA, ['unsubscribe']);
      await publicLink('unsubscribe', unsubscribe as string).expect(200);
      const back = await call(session('adminA')).post(`${PATH}/confirmation`).expect(200);
      expect(contactOf(back)).toMatchObject({ status: 'pending', unsubscribedAt: null });
    });
  });

  describe('o cadastro de clientes da Verax', () => {
    const CNPJ = 'ESC00000000148';

    it('o contato do cliente novo nasce aguardando, a troca de endereço recomeça, e o reenvio fica no cadastro', async () => {
      const email = address('cadastro');
      const created = await call(session('verax'))
        .post('/v1/tenants', {
          name: 'Cliente demo A (contato no cadastro)',
          cnpj: CNPJ,
          plan: 'Essencial',
          escalationContact: { name: 'Ana', email },
          firstAdmin: { name: 'Bia', email: address('primeiro-admin') },
        })
        .expect(201);
      const { tenant } = tenantCreatedSchema.parse(created.body);
      expect(tenant.escalationContact).toMatchObject({
        email,
        status: 'pending',
        confirmationEmail: expect.anything() as unknown,
      });
      expect(await contactRow(tenant.id)).toMatchObject({
        escalationState: 'pending',
        escalationGeneration: 1,
      });
      expect((await confirmations(tenant.id)).map((notice) => notice.dedupeKey)).toEqual([
        'escalation-confirmation:1',
      ]);

      const renamed = await call(session('verax'))
        .patch(`/v1/tenants/${tenant.id}`, { name: 'Outro nome' })
        .expect(200);
      expect(tenantSchema.parse(renamed.body).escalationContact?.status).toBe('pending');
      const { confirm } = await linksOf(tenant.id, ['confirm']);
      await publicLink('confirm', confirm as string).expect(200);
      const same = await call(session('verax'))
        .patch(`/v1/tenants/${tenant.id}`, { escalationContact: { name: 'Ana Lima', email } })
        .expect(200);
      expect(tenantSchema.parse(same.body).escalationContact?.status).toBe('confirmed');

      const changed = await call(session('verax'))
        .patch(`/v1/tenants/${tenant.id}`, {
          escalationContact: { name: 'Ana', email: address('cadastro-2') },
        })
        .expect(200);
      expect(tenantSchema.parse(changed.body).escalationContact).toMatchObject({ status: 'pending' });
      expect(await contactRow(tenant.id)).toMatchObject({ escalationGeneration: 2 });
      expect(await entryOf(changed)).toMatchObject({ action: 'tenant.update', tenantId: tenant.id });

      const resent = await call(session('verax'))
        .post(`/v1/tenants/${tenant.id}/escalation-contact/confirmation`)
        .expect(200);
      expect(tenantSchema.parse(resent.body).escalationContact?.status).toBe('pending');
      expect(await contactRow(tenant.id)).toMatchObject({ escalationGeneration: 3 });
      expect(await entryOf(resent)).toMatchObject({
        action: 'escalation_contact.resend',
        tenantId: tenant.id,
        resourceType: 'tenant',
      });
      // Só a Verax usa a rota do cadastro.
      await call(session('adminA'))
        .post(`/v1/tenants/${tenant.id}/escalation-contact/confirmation`)
        .expect(403);
      // Cliente sem contato: não há o que pedir.
      const missing = await call(session('verax'))
        .post(`/v1/tenants/${tenantB}/escalation-contact/confirmation`)
        .expect(409);
      expect(missing.body).toMatchObject({ code: 'ESCALATION_CONTACT_MISSING' });
    });
  });

  describe('os links públicos do e-mail', () => {
    /** A recusa sem o id da requisição: tem de ser a mesma para todo link que não vale. */
    const refusal = (response: request.Response) => {
      const { requestId: _omitted, ...rest } = response.body as Record<string, unknown>;
      return rest;
    };

    it('confirmar: uso único, 72 h, e a mesma recusa para link errado, vencido, do outro tipo ou de outro endereço', async () => {
      const tenantId = await createTenant(app, 'Cliente demo A (links)');
      const email = address('links');
      await prisma.tenant.update({
        where: { id: tenantId },
        data: {
          escalationName: 'Ana',
          escalationEmail: email,
          escalationState: 'pending',
          escalationGeneration: 2,
        },
      });
      const { confirm, unsubscribe } = await linksOf(tenantId);
      const { confirm: expired } = await linksOf(tenantId, ['confirm'], {
        now: new Date(Date.now() - 73 * HOUR),
      });
      const { confirm: previous } = await linksOf(tenantId, ['confirm'], { generation: 1 });
      const unknown = Buffer.alloc(32, 7).toString('base64url');
      const bodies = [];
      for (const token of [unknown, expired, previous, unsubscribe]) {
        bodies.push(refusal(await publicLink('confirm', token as string).expect(400)));
      }
      expect(bodies).toEqual(
        Array(4).fill({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Link inválido ou vencido',
          code: 'ESCALATION_LINK_INVALID',
        }),
      );
      expect((await contactRow(tenantId)).escalationState).toBe('pending');
      // Recusa anônima não entra na trilha (só no log).
      expect(
        await prisma.auditLog.count({
          where: { actorType: 'anonymous', action: { contains: 'escalation' }, outcome: { not: 'success' } },
        }),
      ).toBe(0);

      const ok = await publicLink('confirm', confirm as string).expect(200);
      expect(ok.body).toEqual({ status: 'confirmed' });
      expect(ok.headers['cache-control']).toBe('no-store');
      expect(JSON.stringify(ok.body)).not.toContain(email);
      expect(await contactRow(tenantId)).toMatchObject({
        escalationState: 'confirmed',
        escalationGeneration: 2,
      });
      const entry = await entryOf(ok);
      expect(entry).toMatchObject({
        actorType: 'anonymous',
        actorId: null,
        tenantId,
        action: 'escalation_contact.confirm',
        outcome: 'success',
        resourceType: 'tenant',
        resourceId: tenantId,
        before: { status: 'pending' },
        after: { status: 'confirmed' },
      });
      expect(JSON.stringify(entry)).not.toContain(confirm as string);
      // Uso único: o mesmo link, e qualquer outro de confirmação do cliente, não vale mais.
      expect(refusal(await publicLink('confirm', confirm as string).expect(400))).toEqual(bodies[0]);
      expect(
        await prisma.forTenant(tenantId).escalationContactToken.count({ where: { purpose: 'confirm' } }),
      ).toBe(0);
      // Formato errado: a validação recusa antes de olhar o banco.
      await publicLink('confirm', 'curto').expect(400);
    });

    it('descadastrar: idempotente; o link vencido ou de um endereço anterior recebe a mesma recusa', async () => {
      const tenantId = await createTenant(app, 'Cliente demo A (descadastro)');
      await prisma.tenant.update({
        where: { id: tenantId },
        data: {
          escalationName: 'Ana',
          escalationEmail: address('descadastro'),
          escalationState: 'confirmed',
          escalationGeneration: 3,
          escalationConfirmedAt: new Date(),
        },
      });
      const { unsubscribe, confirm } = await linksOf(tenantId);
      const { unsubscribe: previous } = await linksOf(tenantId, ['unsubscribe'], { generation: 2 });
      const { unsubscribe: expired } = await linksOf(tenantId, ['unsubscribe'], {
        now: new Date(Date.now() - 366 * 24 * HOUR),
      });
      for (const token of [previous, expired, confirm]) {
        expect(refusal(await publicLink('unsubscribe', token as string).expect(400))).toMatchObject({
          code: 'ESCALATION_LINK_INVALID',
        });
      }
      const first = await publicLink('unsubscribe', unsubscribe as string).expect(200, {
        status: 'unsubscribed',
      });
      await publicLink('unsubscribe', unsubscribe as string).expect(200, { status: 'unsubscribed' });
      expect(await contactRow(tenantId)).toMatchObject({
        escalationState: 'unsubscribed',
        escalationConfirmedAt: null,
        escalationGeneration: 3,
      });
      expect((await contactRow(tenantId)).escalationUnsubscribedAt).not.toBeNull();
      expect(
        await prisma.auditLog.count({ where: { tenantId, action: 'escalation_contact.unsubscribe' } }),
      ).toBe(1);
      expect(await entryOf(first)).toMatchObject({
        before: { status: 'confirmed' },
        after: { status: 'unsubscribed' },
      });
      // Descadastrado, o link de confirmação que ainda valia saiu junto.
      await publicLink('confirm', confirm as string).expect(400);
    });

    it('só o painel chama: outra origem, sem origem ou formulário são recusados antes de olhar o link', async () => {
      const tenantId = await createTenant(app, 'Cliente demo A (origem)');
      await prisma.tenant.update({
        where: { id: tenantId },
        data: {
          escalationName: 'Ana',
          escalationEmail: address('origem'),
          escalationState: 'pending',
          escalationGeneration: 1,
        },
      });
      const { confirm } = await linksOf(tenantId, ['confirm']);
      const server = request(app.getHttpServer());
      await server
        .post('/v1/public/escalation-contact/confirm')
        .set('Origin', 'https://outro-site.example')
        .send({ token: confirm })
        .expect(403);
      await server.post('/v1/public/escalation-contact/confirm').send({ token: confirm }).expect(403);
      await server
        .post('/v1/public/escalation-contact/confirm')
        .set('Origin', TEST_WEB_ORIGIN)
        .type('form')
        .send(`token=${confirm}`)
        .expect(415);
      await server.get('/v1/public/escalation-contact/confirm').expect(404);
      expect((await contactRow(tenantId)).escalationState).toBe('pending');
    });
  });

  describe('isolamento por cliente (A/B)', () => {
    it('A muda só o próprio contato, lê só o próprio, e o link de A não mexe em B', async () => {
      const emailB = address('b');
      await call(session('adminB')).put(PATH, { name: 'Contato B', email: emailB }).expect(200);
      const beforeB = await contactRow(tenantB);

      const emailA = address('a-isolado');
      const changed = await call(session('adminA'))
        .put(PATH, { name: 'Contato A', email: emailA })
        .expect(200);
      await call(session('adminA')).post(`${PATH}/confirmation`).expect(200);
      expect(await contactRow(tenantB)).toEqual(beforeB);
      expect(contactOf(await call(session('adminB')).get(PATH).expect(200))).toMatchObject({
        email: emailB,
      });
      expect(JSON.stringify((await call(session('adminA')).get(PATH).expect(200)).body)).not.toContain(
        emailB,
      );
      expect((await entryOf(changed)).tenantId).toBe(tenantA);

      const { confirm } = await linksOf(tenantA, ['confirm']);
      await publicLink('confirm', confirm as string).expect(200);
      expect((await contactRow(tenantA)).escalationState).toBe('confirmed');
      expect(await contactRow(tenantB)).toEqual(beforeB);
      // A trilha de B não tem nada da mudança de A.
      expect(
        await prisma.auditLog.count({
          where: {
            tenantId: tenantB,
            action: { startsWith: 'escalation_contact.' },
            requestId: changed.headers['x-request-id'],
          },
        }),
      ).toBe(0);
    });
  });

  it('nenhum endereço do contato nem valor de link no log da API', () => {
    expect(seen.length).toBeGreaterThan(10);
    for (const value of seen) expect(capture.text).not.toContain(value);
  });
});
