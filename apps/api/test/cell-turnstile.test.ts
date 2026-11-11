import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TURNSTILE_TOKEN_HEADER } from '../src/auth/turnstile.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { createUser } from './support/auth-helpers.js';
import { createCellTenant, panelOf, signInOnHost, testCell, uniqueSlug } from './support/cell.js';
import { createApp } from './support/create-app.js';

/** No formato de uma chave real (`0x…`), sem ser uma: com ela, a API confere o hostname do siteverify. */
const REAL_SHAPED_SITE_KEY = '0x0000000000000000000000AA';

/**
 * Na célula (CE-01), com uma chave de site real, o token do Turnstile só vale se foi resolvido no painel do cliente do
 * endereço: o do painel de outro cliente (a mesma chave serve a todos) e o do painel da equipe são recusados.
 */
describe('célula: o Turnstile confere o painel do cliente do endereço (CE-01)', () => {
  const cell = testCell();
  const A = uniqueSlug('a');
  const B = uniqueSlug('b');
  let siteverify: Server;
  let hostname: string;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;

  beforeAll(async () => {
    siteverify = createServer((incoming, response) => {
      incoming.resume();
      incoming.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ success: true, 'error-codes': [], action: 'login', hostname }));
      });
    });
    await new Promise<void>((resolve) => siteverify.listen(0, '127.0.0.1', resolve));
    const { port } = siteverify.address() as AddressInfo;
    app = await createApp({
      cell,
      turnstile: {
        secretKey: 'segredo-do-turnstile-de-teste',
        siteKey: REAL_SHAPED_SITE_KEY,
        siteverifyUrl: `http://127.0.0.1:${port}/siteverify`,
      },
    });
    prisma = app.get(PrismaService);
    tenantA = await createCellTenant(app, A);
    await createCellTenant(app, B);
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve) => siteverify.close(() => resolve()));
  });

  const signIn = (email: string, password: string) =>
    signInOnHost(app, A, email, password).set(TURNSTILE_TOKEN_HEADER, 'token-do-widget');

  it('token resolvido no painel de A, no endereço de A: o login segue', async () => {
    hostname = new URL(panelOf(A)).hostname;
    const user = await createUser(app, { role: 'leitura', tenantId: tenantA });
    await signIn(user.email, user.password).expect(200);
  });

  it.each([
    ['no painel de B', () => new URL(panelOf(B)).hostname],
    ['no painel da equipe (o WEB_ORIGIN)', () => new URL(panelOf(cell.staffSlug)).hostname],
  ])('token resolvido %s: 400, sem gastar tentativa', async (_label, resolvedOn) => {
    hostname = resolvedOn();
    const user = await createUser(app, { role: 'leitura', tenantId: tenantA });
    const response = await signIn(user.email, user.password).expect(400);
    expect(response.body).toMatchObject({ code: 'TURNSTILE_FAILED' });
    expect(await prisma.loginAttempt.findUnique({ where: { email: user.email } })).toBeNull();
  });
});
