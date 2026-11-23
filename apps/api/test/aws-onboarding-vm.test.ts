import 'reflect-metadata';
import { randomInt } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { awsOnboardingSchema } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { createSignedInUser, createTenant, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';

/**
 * O onboarding da AWS no nó na VM própria do cliente (`NODE_PLATFORM=vm`): lá o nó lê a conta com a chave do usuário
 * IAM de leitura, e não com o papel. A descoberta, as fontes e a autorização são as mesmas; só muda como a conta é
 * conectada (os passos da chave), e a resposta diz isso ao painel.
 */
describe('onboarding self-service da AWS na VM própria do cliente (chave de leitura)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenant: string;
  let session: { cookie: string; csrfToken: string };

  beforeAll(async () => {
    app = await createApp({ nodePlatform: 'vm' });
    prisma = app.get(PrismaService);
    tenant = await createTenant(app, 'Cliente Demo A (onboarding na VM própria)');
    const user = await createSignedInUser(app, { role: 'admin_cliente', tenantId: tenant });
    const { cookie, token } = await withCsrf(app, user.cookie);
    session = { cookie, csrfToken: token };
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (path: string) =>
    request(app.getHttpServer())
      .post(path)
      .set('Cookie', session.cookie)
      .set('Origin', TEST_WEB_ORIGIN)
      .set('X-CSRF-Token', session.csrfToken);

  it('a resposta diz que a conta é lida com a chave; o template (as tags do usuário de leitura) vale como no papel', async () => {
    const verified = new Date('2026-11-21T00:00:00.000Z');
    const cloud = await prisma.cloudAccount.create({
      data: {
        tenantId: tenant,
        provider: 'aws',
        accountId: String(randomInt(100_000_000_000, 999_999_999_999)),
        regions: ['sa-east-1'],
        connection: 'connected',
        ingestFrom: verified,
        // As tags lidas do usuário IAM de leitura (`iam:GetUser` nele mesmo).
        awsTemplateVersion: 1,
        awsCapabilities: ['discovery'],
        awsCapabilitiesCheckedAt: verified,
      },
    });
    const read = await request(app.getHttpServer())
      .get(`/v1/cloud-accounts/${cloud.id}/aws/onboarding`)
      .set('Cookie', session.cookie)
      .expect(200);
    const onboarding = awsOnboardingSchema.parse(read.body);
    expect(onboarding).toMatchObject({
      state: 'authenticated',
      credentialMode: 'access_key',
      template: { version: 1, capabilities: ['discovery'], outdated: true },
      // A descoberta roda na VM própria como no nó com o papel.
      discoveryAvailable: true,
    });
    expect(onboarding.checks.find((check) => check.id === 'template')).toMatchObject({
      status: 'failed',
      code: 'template_outdated',
    });
    // A descoberta e a autorização funcionam como no nó com o papel.
    const requested = awsOnboardingSchema.parse(
      (await post(`/v1/cloud-accounts/${cloud.id}/aws/discovery`).expect(202)).body,
    );
    expect(requested).toMatchObject({
      state: 'discovering',
      credentialMode: 'access_key',
      discovery: { run: { trigger: 'manual', status: 'pending' } },
    });
  });
});
