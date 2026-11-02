import 'reflect-metadata';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InvitationService } from '../src/auth/invitation.service.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { DevMailboxTransport } from '../src/mail/dev-mailbox.transport.js';
import { invitationMail } from '../src/mail/templates.js';
import {
  authPost,
  createSignedInUser,
  createTenant,
  createUser,
  signIn,
  signInRequest,
  signInWithMfa,
} from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import { LogCapture } from './support/log-capture.js';
import { MemoryMailTransport } from './support/memory-mail.js';

const NEW_PASSWORD = 'senha-nova-bem-longa-1';

describe('convite e redefinição de senha (T2.6)', () => {
  const mailbox = new MemoryMailTransport();
  const capture = new LogCapture();
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let invitations: InvitationService;

  const resetPassword = (token: string, newPassword = NEW_PASSWORD) =>
    request(app.getHttpServer())
      .post('/v1/auth/reset-password')
      .set('Origin', TEST_WEB_ORIGIN)
      .send({ token, newPassword });

  const requestReset = (email: string) =>
    request(app.getHttpServer())
      .post('/v1/auth/request-password-reset')
      .set('Origin', TEST_WEB_ORIGIN)
      .send({ email });

  async function tokenFor(email: string): Promise<string> {
    let token: string | undefined;
    await vi.waitFor(() => {
      token = mailbox.lastToken(email);
      expect(token).toBeDefined();
    });
    return token as string;
  }

  beforeAll(async () => {
    app = await createApp({ mailbox, capture });
    prisma = app.get(PrismaService);
    invitations = app.get(InvitationService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('convite', () => {
    it('cria o usuário convidado, sem senha, e manda o link por e-mail', async () => {
      const tenantId = await createTenant(app);
      const email = 'convidado-1@cliente.example';
      const { id } = await invitations.invite({ email, name: 'Ana', role: 'analista_cliente', tenantId });

      const user = await prisma.user.findUniqueOrThrow({ where: { id }, include: { accounts: true } });
      expect(user).toMatchObject({ status: 'invited', role: 'analista_cliente', tenantId });
      expect(user.accounts).toHaveLength(0);

      await tokenFor(email);
      const [message] = mailbox.to(email);
      expect(message?.subject).toBe('Convite para o Verax Control');
      expect(message?.text).toContain(`${TEST_WEB_ORIGIN}/convite#token=`);
      expect(message?.text).toContain('60 minutos');
    });

    it('definir a senha pelo link ativa a conta; o login passa a funcionar e pede o cadastro do MFA', async () => {
      const email = 'convidado-2@cliente.example';
      const { id } = await invitations.invite({ email, name: 'Bruno', role: 'admin_verax', tenantId: null });
      await signInRequest(app, email, NEW_PASSWORD).expect(401);

      await resetPassword(await tokenFor(email)).expect(200);

      expect((await prisma.user.findUniqueOrThrow({ where: { id } })).status).toBe('active');
      const cookie = await signIn(app, email, NEW_PASSWORD);
      const me = await request(app.getHttpServer()).get('/v1/me').set('Cookie', cookie).expect(200);
      expect(me.body).toMatchObject({ mfaEnabled: false });
    });

    it('o link é de uso único', async () => {
      const email = 'convidado-3@cliente.example';
      await invitations.invite({ email, name: 'Carla', role: 'admin_verax', tenantId: null });
      const token = await tokenFor(email);

      await resetPassword(token).expect(200);
      await resetPassword(token, 'outra-senha-bem-longa').expect(400);
    });

    it('o link expira', async () => {
      const email = 'convidado-4@cliente.example';
      await invitations.invite({ email, name: 'Davi', role: 'admin_verax', tenantId: null });
      const token = await tokenFor(email);
      await prisma.verification.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

      await resetPassword(token).expect(400);
    });

    it('o token fica só com hash no banco', async () => {
      const email = 'convidado-5@cliente.example';
      await invitations.invite({ email, name: 'Eva', role: 'admin_verax', tenantId: null });
      const token = await tokenFor(email);

      const rows = await prisma.verification.findMany();
      expect(JSON.stringify(rows)).not.toContain(token);
    });

    it('senha curta é recusada e o link continua valendo', async () => {
      const email = 'convidado-6@cliente.example';
      await invitations.invite({ email, name: 'Fábio', role: 'admin_verax', tenantId: null });
      const token = await tokenFor(email);

      await resetPassword(token, 'curta').expect(400);
      await resetPassword(token).expect(200);
    });
  });

  describe('redefinição de senha', () => {
    it('resposta idêntica para e-mail existente, inexistente e de usuário desativado', async () => {
      const active = await createUser(app);
      const disabled = await createUser(app, { status: 'disabled' });

      const responses = await Promise.all([
        requestReset(active.email),
        requestReset('ninguem-aqui@cliente.example'),
        requestReset(disabled.email),
      ]);
      for (const response of responses) expect(response.status).toBe(200);
      expect(responses[1]?.body).toEqual(responses[0]?.body);
      expect(responses[2]?.body).toEqual(responses[0]?.body);

      await tokenFor(active.email);
      expect(mailbox.to('ninguem-aqui@cliente.example')).toHaveLength(0);
      expect(mailbox.to(disabled.email)).toHaveLength(0);
    });

    it('redefinir derruba as sessões abertas e mantém o MFA exigido', async () => {
      const user = await createUser(app);
      const oldSession = await signIn(app, user.email, user.password);

      await requestReset(user.email).expect(200);
      const token = await tokenFor(user.email);
      expect(mailbox.to(user.email).at(-1)?.text).toContain(`${TEST_WEB_ORIGIN}/redefinir-senha#token=`);
      await resetPassword(token).expect(200);

      await request(app.getHttpServer()).get('/v1/me').set('Cookie', oldSession).expect(401);
      await signInRequest(app, user.email, user.password).expect(401);
      await signInRequest(app, user.email, NEW_PASSWORD).expect(200);
    });

    it('o pedido e a redefinição vão para a auditoria, sem token nem senha', async () => {
      const user = await createUser(app);
      const requested = await requestReset(user.email).expect(200);
      const token = await tokenFor(user.email);
      const reset = await resetPassword(token).expect(200);

      const events = await prisma.auditLog.findMany({
        where: {
          requestId: {
            in: [requested.headers['x-request-id'] as string, reset.headers['x-request-id'] as string],
          },
        },
      });
      expect(events.map((event) => event.action).sort()).toEqual([
        'auth.password_reset',
        'auth.password_reset_request',
      ]);
      expect(JSON.stringify(events)).not.toContain(token);
      expect(JSON.stringify(events)).not.toContain(NEW_PASSWORD);
    });

    it('troca de senha logado exige a senha atual', async () => {
      const { cookie, ...user } = await createSignedInUser(app);
      await authPost(app, '/change-password', cookie, {
        currentPassword: 'senha-errada-longa',
        newPassword: NEW_PASSWORD,
      }).expect(400);
      await authPost(app, '/change-password', cookie, {
        currentPassword: user.password,
        newPassword: NEW_PASSWORD,
      }).expect(200);
    });

    it('trocar a senha derruba as outras sessões; a atual continua, com a mesma idade', async () => {
      const user = await createSignedInUser(app);
      const other = await signInWithMfa(app, user.email, user.password, user.secret);
      const before = await prisma.session.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(before).toHaveLength(2);

      const changed = await authPost(app, '/change-password', user.cookie, {
        currentPassword: user.password,
        newPassword: NEW_PASSWORD,
      }).expect(200);
      expect(changed.headers['set-cookie']).toBeUndefined();

      await request(app.getHttpServer()).get('/v1/me').set('Cookie', other).expect(401);
      await request(app.getHttpServer()).get('/v1/me').set('Cookie', user.cookie).expect(200);
      const after = await prisma.session.findMany({ where: { userId: user.id } });
      expect(after).toHaveLength(1);
      expect(after[0]?.createdAt).toEqual(before[0]?.createdAt);
    });

    it('revokeOtherSessions é recusado (criaria sessão nova, zerando o limite de 12 h)', async () => {
      const { cookie, ...user } = await createSignedInUser(app);
      await authPost(app, '/change-password', cookie, {
        currentPassword: user.password,
        newPassword: NEW_PASSWORD,
        revokeOtherSessions: true,
      }).expect(400);
    });

    it('pela rota pública, convidado não recebe link novo: o convite expira de fato', async () => {
      const email = 'convidado-sem-reenvio@cliente.example';
      await invitations.invite({ email, name: 'Eva', role: 'admin_verax', tenantId: null });
      await tokenFor(email);
      const active = await createUser(app);

      await Promise.all([requestReset(email).expect(200), requestReset(active.email).expect(200)]);
      await tokenFor(active.email);
      expect(mailbox.to(email)).toHaveLength(1);
    });

    it('o reenvio pelo administrador serve só a convidados', async () => {
      const active = await createUser(app);
      const email = 'convidado-reenvio@cliente.example';
      await invitations.invite({ email, name: 'Fábio', role: 'admin_verax', tenantId: null });
      await tokenFor(email);

      await invitations.sendLink(active.email);
      await invitations.sendLink(email);
      await vi.waitFor(() => expect(mailbox.to(email)).toHaveLength(2));
      expect(mailbox.to(active.email)).toHaveLength(0);
    });
  });

  it('nenhum token de link vai para o log', () => {
    for (const message of mailbox.messages) {
      const token = /#token=([^\s"<]+)/.exec(message.text)?.[1];
      if (token) expect(capture.text).not.toContain(decodeURIComponent(token));
    }
    expect(mailbox.messages.length).toBeGreaterThan(5);
  });
});

describe('caixa de e-mail local de desenvolvimento', () => {
  it('grava cada mensagem num arquivo legível só pelo dono', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'verax-mailbox-'));
    try {
      const transport = new DevMailboxTransport(join(directory, 'caixa'));
      await transport.send({ to: 'a@b.example', subject: 's', text: 't', html: '<p>h</p>' });

      const [file] = await readdir(join(directory, 'caixa'));
      expect(file).toMatch(/\.json$/);
      const content = JSON.parse(await readFile(join(directory, 'caixa', file as string), 'utf8')) as unknown;
      expect(content).toMatchObject({ to: 'a@b.example', subject: 's' });
      if (process.platform !== 'win32') {
        expect((await stat(join(directory, 'caixa', file as string))).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('modelos de e-mail', () => {
  it('escapam o nome no HTML', () => {
    const message = invitationMail({
      to: 'a@b.example',
      name: '<script>alert(1)</script>',
      link: 'https://painel.example/convite#token=x',
      validMinutes: 60,
    });
    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
  });
});
