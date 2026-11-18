import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminAuthService } from '../src/admin/auth/admin-auth.service.js';
import { newTotpSecret } from '../src/admin/auth/totp.js';
import {
  CONSOLE_LOGIN_ACTION,
  TURNSTILE_FAILED_MESSAGE,
  TURNSTILE_REQUIRED_MESSAGE,
  TURNSTILE_SITEVERIFY_URL,
  type TurnstileFetch,
} from '../src/admin/auth/turnstile.js';
import { COLLECTIONS } from '../src/firestore/collections.js';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import { MemoryAdminSecrets, totpAt } from './support/admin-auth.js';
import { createApp } from './support/create-app.js';
import { FakeClock, MINUTE_MS } from './support/fake-clock.js';
import { LogCapture } from './support/log-capture.js';

const START = new Date('2026-11-04T12:00:00.000Z');
const OWNER = 'responsavel@verax.example';
const OPERATOR = 'operador@verax.example';
/** No formato de uma chave real (`0x…`), sem ser uma: liga a conferência do hostname e da action. */
const SITE_KEY = '0x0000000000000000000000AA';
const CONSOLE_HOST = 'admin.verax.example';

type SiteverifyMode = 'ok' | 'rejected' | 'other-host' | 'panel-action' | 'down';

/**
 * O siteverify da Cloudflare num dublê em memória (nada sai para a rede): guarda o que recebeu e responde conforme o
 * modo do teste. O token de teste só vale se for um dos emitidos pelo próprio teste (`newToken`).
 */
class FakeSiteverify {
  mode: SiteverifyMode = 'ok';
  readonly calls: { url: string; body: Record<string, unknown> }[] = [];

  readonly fetch: TurnstileFetch = (url, init) => {
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<string, unknown>;
    this.calls.push({ url, body });
    if (this.mode === 'down') return Promise.reject(new TypeError('fetch failed'));
    const answer =
      this.mode === 'rejected'
        ? { success: false, 'error-codes': ['invalid-input-response'] }
        : {
            success: true,
            'error-codes': [],
            hostname: this.mode === 'other-host' ? 'veraxsistemas.com.br' : CONSOLE_HOST,
            action: this.mode === 'panel-action' ? 'login' : CONSOLE_LOGIN_ACTION,
          };
    return Promise.resolve(
      new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  };
}

/**
 * O login do console com o Turnstile ligado (`ADMIN_TURNSTILE_SITE_KEY` e o cofre `cp-admin-turnstile-secret-key`), pelo
 * app inteiro: o token do widget no header `X-Turnstile-Token`, conferido no siteverify (um dublê) antes da senha, com
 * o IP de `req.ip`, sempre fechando a porta quando não dá para conferir, sem afrouxar os limites do login e sem levar
 * token nem chave ao log. Um app por arquivo.
 */
describe('cp-admin: Turnstile no login do console', () => {
  const capture = new LogCapture();
  const clock = new FakeClock(START);
  const documents = new MemoryDocumentStore();
  const secrets = new MemoryAdminSecrets();
  const siteverify = new FakeSiteverify();
  /** A chave secreta gerada no teste (nunca um valor fixo no repositório). */
  const turnstileSecret = randomBytes(24).toString('base64url');
  const issuedTokens: string[] = [];
  let round = 0;
  let ipSequence = 0;
  let ip = '';
  let app: NestExpressApplication;

  function newToken(): string {
    const token = `token-${randomBytes(12).toString('base64url')}`;
    issuedTokens.push(token);
    return token;
  }

  function login(body: Record<string, string>, token?: string): request.Test {
    const test = request(app.getHttpServer())
      .post('/v1/admin/login')
      .set('X-Forwarded-For', ip)
      .set('Content-Type', 'application/json');
    return (token === undefined ? test : test.set('X-Turnstile-Token', token)).send(JSON.stringify(body));
  }

  async function enroll(): Promise<{ password: string; secret: string }> {
    const password = `senha-${randomBytes(9).toString('base64url')}`;
    const secret = newTotpSecret();
    await app
      .get(AdminAuthService)
      .enrollOwner(
        { email: OWNER, password, secret, code: await totpAt(secret, clock.now()), replace: false },
        { email: OPERATOR },
      );
    clock.advance(30_000);
    return { password, secret };
  }

  /** O pedido não chegou à senha: nenhum `admin_auth_failed` e nenhum contador de bloqueio da conta. */
  async function passwordNotChecked(): Promise<void> {
    expect(capture.entries().filter((entry) => entry['event'] === 'admin_auth_failed')).toHaveLength(0);
    expect(await documents.query(COLLECTIONS.adminLoginThrottle)).toHaveLength(0);
  }

  /** Os eventos da partida (o cofre da chave secreta começa vazio, como logo depois do `terraform apply`). */
  let bootEvents: unknown[] = [];

  beforeAll(async () => {
    secrets.turnstile = undefined;
    app = await createApp({
      role: 'admin',
      nodeEnv: 'production',
      trustProxyHops: 1,
      capture,
      documentStore: documents,
      clock,
      adminSecrets: secrets,
      turnstileFetch: siteverify.fetch,
      env: {
        ADMIN_SECRETS_PROJECT_ID: 'projeto-exemplo',
        OWNER_PRINCIPALS: OWNER,
        ADMIN_TURNSTILE_SITE_KEY: SITE_KEY,
        ADMIN_CONSOLE_HOSTNAME: CONSOLE_HOST,
      },
    });
    await app.listen(0, '127.0.0.1');
    await vi.waitFor(() =>
      expect(capture.entries().map((entry) => entry['event'])).toContain('admin_turnstile_secret_missing'),
    );
    bootEvents = capture.entries().map((entry) => entry['event']);
  });

  beforeEach(() => {
    round += 1;
    clock.set(new Date(START.getTime() + round * 60 * MINUTE_MS));
    documents.clear();
    ipSequence += 1;
    ip = `198.51.100.${ipSequence}`;
    siteverify.mode = 'ok';
    siteverify.calls.length = 0;
    capture.lines.length = 0;
    secrets.failing = false;
  });

  afterAll(async () => {
    await app.close();
  });

  // Primeiro teste do arquivo (a ordem importa): a chave secreta só fica guardada depois da primeira leitura com valor.
  it('cofre vazio: a partida avisa, o login responde 503 (fecha), e gravar uma versão vale sem reiniciar', async () => {
    expect(bootEvents).toContain('admin_turnstile_secret_missing');
    const owner = await enroll();
    const closed = await login(
      { email: OWNER, password: owner.password, code: await totpAt(owner.secret, clock.now()) },
      newToken(),
    ).expect(503);
    expect(closed.body).toMatchObject({ code: 'turnstile_unavailable' });
    expect(siteverify.calls).toHaveLength(0);
    await passwordNotChecked();
    secrets.turnstile = turnstileSecret;
    await login(
      { email: OWNER, password: owner.password, code: await totpAt(owner.secret, clock.now()) },
      newToken(),
    ).expect(200);
  });

  it('a tela recebe a chave do site sem sessão (só a pública), sem cache', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/admin/client-config')
      .set('X-Forwarded-For', ip)
      .expect(200);
    expect(response.body).toEqual({ turnstileSiteKey: SITE_KEY });
    expect(response.text).not.toContain(turnstileSecret);
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('token aceito: o siteverify recebe a chave secreta, o token e o IP do cliente (req.ip), e o login segue', async () => {
    const owner = await enroll();
    const token = newToken();
    const response = await login(
      { email: OWNER, password: owner.password, code: await totpAt(owner.secret, clock.now()) },
      token,
    ).expect(200);
    expect(response.body).toEqual({ email: OWNER });
    expect(siteverify.calls).toEqual([
      { url: TURNSTILE_SITEVERIFY_URL, body: { secret: turnstileSecret, response: token, remoteip: ip } },
    ]);
  });

  it('sem o header: 400 turnstile_required com a mensagem genérica, sem ir à Cloudflare e sem olhar a senha', async () => {
    const owner = await enroll();
    const response = await login({ email: OWNER, password: owner.password, code: '123456' }).expect(400);
    expect(response.body).toMatchObject({ code: 'turnstile_required', message: TURNSTILE_REQUIRED_MESSAGE });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(siteverify.calls).toHaveLength(0);
    await passwordNotChecked();
  });

  it.each([
    ['token recusado pela Cloudflare', 'rejected'],
    ['token resolvido em outro site (o painel)', 'other-host'],
    ['token do formulário de login do painel', 'panel-action'],
  ] as const)('%s: 400 turnstile_failed, mesma mensagem, senha nem conferida', async (_label, mode) => {
    const owner = await enroll();
    siteverify.mode = mode;
    const response = await login(
      { email: OWNER, password: owner.password, code: await totpAt(owner.secret, clock.now()) },
      newToken(),
    ).expect(400);
    expect(response.body).toMatchObject({ code: 'turnstile_failed', message: TURNSTILE_FAILED_MESSAGE });
    expect(response.headers['set-cookie']).toBeUndefined();
    await passwordNotChecked();
    expect(capture.entries().some((entry) => entry['event'] === 'admin_turnstile_failed')).toBe(true);
  });

  it('Cloudflare fora do ar: 503 (fecha), sem gastar o limite do IP', async () => {
    const owner = await enroll();
    const body = { email: OWNER, password: owner.password, code: '000000' };
    siteverify.mode = 'down';
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await login(body, newToken()).expect(503);
      expect(response.body).toMatchObject({ code: 'turnstile_unavailable' });
    }
    siteverify.mode = 'ok';
    // As 12 indisponibilidades devolveram a tentativa: o balde do IP (10) continua cheio.
    const ok = await login(
      { email: OWNER, password: owner.password, code: await totpAt(owner.secret, clock.now()) },
      newToken(),
    );
    expect(ok.status).toBe(200);
    await passwordNotChecked();
  });

  it('os limites do login continuam: recusas do Turnstile contam no balde do IP, e o IP limitado nem vai à Cloudflare', async () => {
    const owner = await enroll();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await login({ email: OWNER, password: owner.password, code: '000000' }).expect(400);
    }
    const limited = await login(
      { email: OWNER, password: owner.password, code: await totpAt(owner.secret, clock.now()) },
      newToken(),
    );
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ code: 'rate_limited' });
    expect(siteverify.calls).toHaveLength(0);
  });

  it('com o token certo, a senha errada e o código errado seguem como antes (401 genérico e bloqueio da conta)', async () => {
    const owner = await enroll();
    await login({ email: OWNER, password: `${owner.password}x`, code: '000000' }, newToken()).expect(401);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await login({ email: OWNER, password: owner.password, code: '000000' }, newToken()).expect(401);
    }
    // Bloqueada: nem com tudo certo (e o token aceito) entra.
    clock.advance(30_000);
    await login(
      { email: OWNER, password: owner.password, code: await totpAt(owner.secret, clock.now()) },
      newToken(),
    ).expect(401);
    expect(capture.entries().some((entry) => entry['event'] === 'admin_account_locked')).toBe(true);
  });

  it('nenhum log leva o token do widget nem a chave secreta', async () => {
    const owner = await enroll();
    siteverify.mode = 'rejected';
    await login({ email: OWNER, password: owner.password, code: '000000' }, newToken()).expect(400);
    siteverify.mode = 'down';
    await login({ email: OWNER, password: owner.password, code: '000000' }, newToken()).expect(503);
    siteverify.mode = 'ok';
    await login({ email: OWNER, password: owner.password, code: '000000' }, newToken()).expect(401);
    const text = capture.text;
    expect(text).not.toContain(turnstileSecret);
    for (const token of issuedTokens) expect(text, token).not.toContain(token);
  });
});
