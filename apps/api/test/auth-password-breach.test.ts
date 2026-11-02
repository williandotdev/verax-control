import 'reflect-metadata';
import { createHash } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { InvitationService } from '../src/auth/invitation.service.js';
import { authPost, createSignedInUser, signInRequest } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import { MemoryMailTransport } from './support/memory-mail.js';

const LEAKED = 'senha-vazada-conhecida-123';
const SAFE = 'senha-nova-e-inedita-456';

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex').toUpperCase();
}

/**
 * Simula o serviço de faixas do Have I Been Pwned: só as chamadas a ele são interceptadas, e cada uma é
 * registrada para conferir que apenas o prefixo do hash sai da API.
 */
function mockPwnedPasswords(mode: 'ok' | 'down' = 'ok') {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://api.pwnedpasswords.com/')) return realFetch(input, init);
    calls.push(url);
    if (mode === 'down') return Promise.resolve(new Response('indisponível', { status: 503 }));
    const leaked = sha1(LEAKED);
    const prefix = url.split('/').at(-1) ?? '';
    const lines =
      prefix === leaked.slice(0, 5) ? `${leaked.slice(5)}:1234\r\n0000000000000000000000000000000000A:0` : '';
    return Promise.resolve(new Response(lines, { status: 200 }));
  });
  return calls;
}

describe('senha vazada (Have I Been Pwned, k-anonimato)', () => {
  const mailbox = new MemoryMailTransport();
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createApp({ mailbox, passwordBreachCheck: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  async function inviteToken(email: string): Promise<string> {
    await app.get(InvitationService).invite({ email, name: 'Teste', role: 'admin_verax', tenantId: null });
    let token: string | undefined;
    await vi.waitFor(() => {
      token = mailbox.lastToken(email);
      expect(token).toBeDefined();
    });
    return token as string;
  }

  const reset = (token: string, newPassword: string) =>
    request(app.getHttpServer())
      .post('/v1/auth/reset-password')
      .set('Origin', TEST_WEB_ORIGIN)
      .send({ token, newPassword });

  it('recusa senha vazada ao aceitar convite, e só o prefixo do hash sai da API', async () => {
    const calls = mockPwnedPasswords();
    const token = await inviteToken('vazada-convite@cliente.example');

    const response = await reset(token, LEAKED).expect(400);
    expect(JSON.stringify(response.body)).toContain('vazamentos conhecidos');
    // O painel decide a mensagem por este código estável, não pelo texto.
    expect(response.body).toMatchObject({ code: 'PASSWORD_COMPROMISED' });
    expect(calls).toEqual([`https://api.pwnedpasswords.com/range/${sha1(LEAKED).slice(0, 5)}`]);
    expect(calls.join(' ')).not.toContain(sha1(LEAKED).slice(5));

    await reset(token, SAFE).expect(200);
  });

  it('recusa senha vazada na troca de senha', async () => {
    mockPwnedPasswords();
    const { cookie, ...user } = await createSignedInUser(app);

    await authPost(app, '/change-password', cookie, {
      currentPassword: user.password,
      newPassword: LEAKED,
    }).expect(400);
    await authPost(app, '/change-password', cookie, {
      currentPassword: user.password,
      newPassword: SAFE,
    }).expect(200);
  });

  it('se o serviço não responder, a senha não é aceita (falha fechada)', async () => {
    mockPwnedPasswords('down');
    const email = 'servico-fora@cliente.example';
    const token = await inviteToken(email);

    const response = await reset(token, SAFE);
    expect(response.status).toBeGreaterThanOrEqual(500);
    await signInRequest(app, email, SAFE).expect(401);
  });
});
