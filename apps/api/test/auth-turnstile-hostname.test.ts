import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TURNSTILE_TOKEN_HEADER } from '../src/auth/turnstile.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { cookieHeader, createUser, hasSessionCookie, signInRequest } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';
import { LogCapture } from './support/log-capture.js';

// Marcados para a busca nos logs e nas respostas: nenhum dos dois pode aparecer em lugar nenhum.
const LEAK = { secretKey: 'leak-ts-secret-3', token: 'leak-ts-token-4' };
/** No formato de uma chave real (`0x…`), sem ser uma: com ela, a API confere o hostname do siteverify. */
const REAL_SHAPED_SITE_KEY = '0x0000000000000000000000AA';

/**
 * Com uma chave de site real, o token só vale se foi resolvido numa página do painel: o `hostname` que o siteverify
 * devolve precisa ser o do `WEB_ORIGIN` (`localhost` nos testes). Um app próprio, porque a chave é da configuração.
 */
describe('Turnstile com chave de site real: o hostname do siteverify precisa ser o do painel', () => {
  const capture = new LogCapture();
  let siteverify: Server;
  let hostname: string | undefined;
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    siteverify = createServer((incoming, response) => {
      incoming.resume();
      incoming.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            success: true,
            'error-codes': [],
            action: 'login',
            ...(hostname !== undefined && { hostname }),
          }),
        );
      });
    });
    await new Promise<void>((resolve) => siteverify.listen(0, '127.0.0.1', resolve));
    const { port } = siteverify.address() as AddressInfo;
    app = await createApp({
      capture,
      turnstile: {
        secretKey: LEAK.secretKey,
        siteKey: REAL_SHAPED_SITE_KEY,
        siteverifyUrl: `http://127.0.0.1:${port}/siteverify`,
      },
    });
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve) => siteverify.close(() => resolve()));
  });

  beforeEach(() => {
    hostname = 'localhost';
  });

  const signIn = (email: string, password: string) =>
    signInRequest(app, email, password).set(TURNSTILE_TOKEN_HEADER, LEAK.token);

  it('hostname do WEB_ORIGIN: o login segue', async () => {
    const user = await createUser(app);
    const response = await signIn(user.email, user.password).expect(200);
    expect(hasSessionCookie(cookieHeader(response.headers['set-cookie']))).toBe(true);
  });

  it.each([
    ['outro site', 'outro.example'],
    ['subdomínio do painel', 'app.localhost'],
    ['sem hostname', undefined],
  ])('%s: 400 genérico, sem gastar tentativa, com o motivo só no log', async (_label, value) => {
    hostname = value;
    const user = await createUser(app);
    const response = await signIn(user.email, user.password).expect(400);
    expect(response.body).toMatchObject({ code: 'TURNSTILE_FAILED' });
    expect(JSON.stringify(response.body)).not.toMatch(/hostname|localhost/);
    expect(hasSessionCookie(cookieHeader(response.headers['set-cookie']))).toBe(false);
    expect(await prisma.loginAttempt.findUnique({ where: { email: user.email } })).toBeNull();
    expect(capture.text).toContain('hostname-mismatch');
    expect(capture.text).not.toContain(LEAK.token);
    expect(capture.text).not.toContain(LEAK.secretKey);
  });
});
