import 'reflect-metadata';
import { randomBytes, randomInt } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { LINK_ATTEMPT_MAX } from '../src/escalation/escalation-link.guard.js';
import { mintEscalationTokens } from '../src/escalation/escalation-tokens.js';
import { createTenant } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import { LogCapture } from './support/log-capture.js';

/**
 * Limite por IP das rotas públicas dos links do contato de escalonamento (D8), com o interruptor das rotas de
 * autenticação ligado (como em produção) e um proxy na frente (o IP vem do `X-Forwarded-For`). Arquivo próprio: o
 * limite ligado atrapalharia os logins dos outros testes.
 */
describe('links do contato de escalonamento: limite por IP', () => {
  const capture = new LogCapture();
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createApp({ capture, authRateLimit: true, trustProxyHops: 1 });
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  /** IP de documentação próprio de cada teste: a contagem de um não vaza para o outro. */
  const freshIp = () => `198.51.100.${randomInt(1, 254)}`;
  const link = (path: 'confirm' | 'unsubscribe', ip: string, token: string) =>
    request(app.getHttpServer())
      .post(`/v1/public/escalation-contact/${path}`)
      .set('Origin', TEST_WEB_ORIGIN)
      .set('X-Forwarded-For', ip)
      .send({ token });
  const unknownToken = () => randomBytes(32).toString('base64url');

  it(`${LINK_ATTEMPT_MAX} chamadas por IP em 15 min, somadas as duas rotas; a seguinte recebe 429, e outro IP segue`, async () => {
    const ip = freshIp();
    await prisma.publicLinkAttempt.deleteMany({ where: { key: `escalation-link:${ip}` } });
    for (let index = 0; index < LINK_ATTEMPT_MAX; index += 1) {
      await link(index % 2 === 0 ? 'confirm' : 'unsubscribe', ip, unknownToken()).expect(400);
    }
    const limited = await link('confirm', ip, unknownToken()).expect(429);
    expect(limited.body).toMatchObject({ code: 'TOO_MANY_REQUESTS' });

    // Nem um link válido passa enquanto o IP está no limite; outro IP passa.
    const tenantId = await createTenant(app, 'Cliente demo A (limite dos links)');
    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        escalationName: 'Ana',
        escalationEmail: 'contato-limite@cliente.example',
        escalationState: 'pending',
        escalationGeneration: 1,
      },
    });
    const { confirm } = await mintEscalationTokens(
      prisma.forTenant(tenantId),
      tenantId,
      1,
      ['confirm'],
      new Date(),
    );
    await link('confirm', ip, confirm).expect(429);
    expect(
      (await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { escalationState: true } }))
        .escalationState,
    ).toBe('pending');
    await link('confirm', freshIp(), confirm).expect(200, { status: 'confirmed' });

    // Passada a janela, a contagem recomeça.
    await prisma.publicLinkAttempt.update({
      where: { key: `escalation-link:${ip}` },
      data: { windowStart: new Date(Date.now() - 16 * 60_000) },
    });
    await link('unsubscribe', ip, unknownToken()).expect(400);
    expect(
      await prisma.publicLinkAttempt.findUniqueOrThrow({ where: { key: `escalation-link:${ip}` } }),
    ).toMatchObject({ count: 1 });
  });

  it('a recusa do limite e a do link vão só para o log, sem o token nem o endereço; nada na trilha', async () => {
    const ip = freshIp();
    const tokens: string[] = [];
    for (let index = 0; index <= LINK_ATTEMPT_MAX; index += 1) {
      const token = unknownToken();
      tokens.push(token);
      await link('confirm', ip, token);
    }
    expect(capture.text).toContain('"refused":"rate_limit"');
    for (const token of tokens) expect(capture.text).not.toContain(token);
    expect(capture.text).not.toContain('contato-limite@cliente.example');
    expect(
      await prisma.auditLog.count({
        where: { actorType: 'anonymous', action: { contains: 'escalation' }, outcome: { not: 'success' } },
      }),
    ).toBe(0);
  });
});
