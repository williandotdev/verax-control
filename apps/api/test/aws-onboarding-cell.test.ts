import 'reflect-metadata';
import { randomInt } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { awsOnboardingSchema } from '@verax/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import {
  createCellTenant,
  createSignedInUserOnHost,
  csrfOnHost,
  onHost,
  testCell,
  uniqueSlug,
} from './support/cell.js';
import { createApp } from './support/create-app.js';

const SLUG = uniqueSlug('fontes');

/**
 * O onboarding da AWS na célula compartilhada: a coleta da AWS ainda não foi construída lá (CE-11/CE-12), e a tarefa
 * `aws-discovery` não roda. O estado continua legível, mas a descoberta e a sondagem são recusadas com um código claro,
 * em vez de deixar um pedido pendente para sempre.
 */
describe('onboarding self-service da AWS na célula compartilhada', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenant: string;
  let session: { cookie: string; token: string };

  beforeAll(async () => {
    app = await createApp({ cell: testCell() });
    prisma = app.get(PrismaService);
    tenant = await createCellTenant(app, SLUG);
    const admin = await createSignedInUserOnHost(app, SLUG, { role: 'admin_cliente', tenantId: tenant });
    session = await csrfOnHost(app, SLUG, admin.cookie);
  });

  afterAll(async () => {
    await app.close();
  });

  const call = (method: 'get' | 'post', path: string) => {
    const pending = onHost(app, SLUG)(method, path).set('Cookie', session.cookie);
    return method === 'post' ? pending.set('X-CSRF-Token', session.token) : pending;
  };

  it('o estado é legível; a descoberta e a sondagem respondem 409 DISCOVERY_UNAVAILABLE, sem gravar pedido', async () => {
    const verified = new Date('2026-11-21T00:00:00.000Z');
    const cloud = await prisma.cloudAccount.create({
      data: {
        tenantId: tenant,
        provider: 'aws',
        accountId: String(randomInt(100_000_000_000, 999_999_999_999)),
        regions: ['sa-east-1'],
        connection: 'connected',
        ingestFrom: verified,
      },
    });
    const source = await prisma.awsSource.create({
      data: {
        tenantId: tenant,
        cloudAccountId: cloud.id,
        kind: 'guardduty',
        region: 'sa-east-1',
        resourceId: 'det1',
        name: 'GuardDuty',
        method: 'api',
        availability: 'available',
        permission: 'missing',
        permissionDetail: 'guardduty:ListFindings',
        state: 'needs_permission',
      },
    });
    const base = `/v1/cloud-accounts/${cloud.id}/aws`;
    const onboarding = awsOnboardingSchema.parse((await call('get', `${base}/onboarding`).expect(200)).body);
    // Honesto: autenticada, com a descoberta por pedir (ela não roda aqui), e a resposta já diz que não adianta
    // pedir: o painel não oferece "Descobrir de novo" nem "Tentar de novo" para explicar a recusa depois do clique.
    expect(onboarding).toMatchObject({
      state: 'authenticated',
      discovery: { run: null },
      discoveryAvailable: false,
    });

    expect((await call('post', `${base}/discovery`).expect(409)).body).toMatchObject({
      code: 'DISCOVERY_UNAVAILABLE',
    });
    expect((await call('post', `${base}/sources/${source.id}/retry`).expect(409)).body).toMatchObject({
      code: 'DISCOVERY_UNAVAILABLE',
    });
    expect(await prisma.awsDiscoveryRun.count({ where: { cloudAccountId: cloud.id } })).toBe(0);
    expect(
      (await prisma.awsSource.findUniqueOrThrow({ where: { id: source.id } })).probeRequestedAt,
    ).toBeNull();
  });
});
