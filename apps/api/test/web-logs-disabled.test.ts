import 'reflect-metadata';
import { randomInt, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { awsOnboardingSchema, type Role, ROLES } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { createSignedInUser, createTenant, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import { previousMeSchema, previousOnboardingSchema } from './support/previous-panel.js';
import type { TestSession } from './support/tenant-isolation.js';

const VERIFIED = new Date('2026-11-21T00:00:00.000Z');

/**
 * Os ataques web pelos logs do ALB desligados no nó (a linha não existe, o padrão): o balanceador é como sempre foi, e tudo o
 * que veio com eles não existe, inclusive o que ficou gravado de quando estavam ligados.
 */
describe('ataques web pelos logs do ALB: desligados', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenant: string;
  let admin: TestSession & { userId: string };
  const sessions = new Map<Role, TestSession>();

  async function sessionFor(tenantId: string | null, role: Role) {
    const user = await createSignedInUser(app, { role, ...(tenantId !== null && { tenantId }) });
    const { cookie, token } = await withCsrf(app, user.cookie);
    return { cookie, csrfToken: token, userId: user.id };
  }
  const get = (as: TestSession, path: string) =>
    request(app.getHttpServer()).get(path).set('Cookie', as.cookie);
  const write = (as: TestSession, method: 'post' | 'patch' | 'delete', path: string) => {
    const agent = request(app.getHttpServer());
    return agent[method](path)
      .set('Cookie', as.cookie)
      .set('Origin', TEST_WEB_ORIGIN)
      .set('X-CSRF-Token', as.csrfToken);
  };

  const account = () =>
    prisma.cloudAccount.create({
      data: {
        tenantId: tenant,
        provider: 'aws',
        accountId: String(randomInt(100_000_000_000, 999_999_999_999)),
        regions: ['sa-east-1'],
        connection: 'connected',
        ingestFrom: VERIFIED,
        awsTemplateVersion: 2,
        awsCapabilities: ['discovery', 'service-logs', 'findings', 'log-groups'],
        awsCapabilitiesCheckedAt: VERIFIED,
      },
    });
  function source(cloudAccountId: string, data: Partial<Prisma.AwsSourceUncheckedCreateInput> = {}) {
    const name = `alb-${randomInt(1e6, 9e6)}`;
    return prisma.awsSource.create({
      data: {
        tenantId: tenant,
        cloudAccountId,
        kind: 'elb_logs',
        region: 'sa-east-1',
        resourceId: name,
        name,
        details: { arn: `arn:aws:elasticloadbalancing:sa-east-1:111111111111:loadbalancer/app/${name}/1` },
        method: 's3',
        availability: 'available',
        loggingState: 'logging',
        // O que a descoberta de sempre grava.
        notes: ['not_collected_yet'],
        state: 'unavailable',
        stateCode: 'not_collectable_yet',
        ...data,
      },
    });
  }
  const onboardingOf = async (id: string) => {
    const response = await get(admin, `/v1/cloud-accounts/${id}/aws/onboarding`).expect(200);
    const body = response.body as unknown;
    // O painel de antes lê a resposta inteira.
    previousOnboardingSchema.parse(body);
    return awsOnboardingSchema.parse(body);
  };

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    tenant = await createTenant(app, 'Cliente Demo A (logs do ALB desligados)');
    admin = await sessionFor(tenant, 'admin_cliente');
    sessions.set('admin_cliente', admin);
    sessions.set('analista_cliente', await sessionFor(tenant, 'analista_cliente'));
    sessions.set('leitura', await sessionFor(tenant, 'leitura'));
    const verax = await sessionFor(null, 'admin_verax');
    await write(verax, 'post', '/v1/session/tenant').send({ tenantId: tenant }).expect(200);
    sessions.set('admin_verax', verax);
  });

  afterAll(async () => {
    await app.close();
  });

  it('toda rota de /v1/web-logs é 404 com o código, antes de olhar o corpo; sem permissão, 403; sem sessão, 401', async () => {
    const id = randomUUID();
    const own = `/v1/web-logs/sources/${id}`;
    const reads = [
      '/v1/web-logs/sources',
      own,
      `${own}/health`,
      `${own}/routes`,
      '/v1/web-logs/trusted-sources',
      '/v1/web-logs/traffic',
    ];
    const writes: ['post' | 'patch' | 'delete', string][] = [
      ['patch', `${own}/settings`],
      ['post', `${own}/estimate`],
      ['post', `${own}/routes`],
      ['patch', `${own}/routes/${id}`],
      ['delete', `${own}/routes/${id}`],
      ['post', '/v1/web-logs/trusted-sources'],
      ['patch', `/v1/web-logs/trusted-sources/${id}`],
      ['delete', `/v1/web-logs/trusted-sources/${id}`],
    ];
    for (const role of ROLES) {
      const as = sessions.get(role) as TestSession;
      const canWrite = role === 'admin_cliente' || role === 'admin_verax';
      for (const path of reads) {
        expect((await get(as, path).expect(404)).body, path).toMatchObject({ code: 'WEB_LOGS_DISABLED' });
      }
      for (const [method, path] of writes) {
        const response = await write(as, method, path).send({ qualquer: 'coisa' });
        expect(response.status, `${role} ${method} ${path}`).toBe(canWrite ? 404 : 403);
        if (canWrite) expect(response.body).toMatchObject({ code: 'WEB_LOGS_DISABLED' });
      }
    }
    for (const path of reads) await request(app.getHttpServer()).get(path).expect(401);
  });

  it('nenhuma rota autoriza um balanceador, nem com a estimativa gravada e confirmada', async () => {
    const cloud = await account();
    const at = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    // Uma linha como a descoberta a deixaria com eles ligados: disponível e com a permissão conferida.
    const row = await source(cloud.id, {
      permission: 'granted',
      notes: ['high_volume'],
      state: 'available',
      stateCode: null,
    });
    await prisma.webSourceEstimate.create({
      data: {
        sourceId: row.id,
        tenantId: tenant,
        lastRequestAt: at,
        status: 'ready',
        computedAt: at,
        day: new Date('2026-11-23'),
        objects: 1,
        bytesPerDay: 0n,
      },
    });
    for (const body of [
      { sourceIds: [row.id] },
      {
        sourceIds: [row.id],
        webLogs: [
          {
            sourceId: row.id,
            estimatedAt: at.toISOString(),
            estimatedGbPerDay: 0,
            projectedPercent: null,
            acknowledged: true,
          },
        ],
      },
    ]) {
      const response = await write(admin, 'post', `/v1/cloud-accounts/${cloud.id}/aws/sources/authorize`)
        .send(body)
        .expect(409);
      expect(response.body).toMatchObject({ code: 'SOURCE_NOT_COLLECTABLE' });
    }
    expect(await prisma.awsSource.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
    expect(await prisma.webSourceSettings.count({ where: { sourceId: row.id } })).toBe(0);
  });

  it('a resposta do onboarding é a de sempre, também para o que ficou gravado de quando estavam ligados', async () => {
    const cloud = await account();
    const common = { permissionCheckedAt: VERIFIED, notes: ['high_volume'], stateCode: null };
    const facing = {
      arn: 'arn:aws:elasticloadbalancing:sa-east-1:111111111111:loadbalancer/app/x/1',
      internetFacing: true,
      destinationType: 's3',
      bucket: 'acessos',
    };
    const before = await source(cloud.id, { name: 'de-sempre' });
    const ready = await source(cloud.id, {
      ...common,
      name: 'disponivel',
      permission: 'granted',
      state: 'available',
      details: facing,
    });
    const denied = await source(cloud.id, {
      ...common,
      name: 'negado',
      permission: 'missing',
      permissionDetail: 'bucket_denied',
      state: 'needs_permission',
      details: facing,
    });
    const revoked = await source(cloud.id, {
      ...common,
      name: 'revogado',
      permission: 'granted',
      state: 'revoked',
      authorizedAt: VERIFIED,
      revokedAt: VERIFIED,
      details: facing,
    });
    const collecting = await source(cloud.id, {
      ...common,
      name: 'coletando',
      permission: 'granted',
      state: 'collecting',
      authorizedAt: VERIFIED,
      lastSyncAt: VERIFIED,
      lagSeconds: 60,
      details: facing,
    });
    const broken = await source(cloud.id, {
      ...common,
      name: 'com-erro',
      permission: 'missing',
      permissionDetail: 'bucket_denied',
      state: 'permission_error',
      stateCode: 'bucket_denied',
      authorizedAt: VERIFIED,
      details: facing,
    });
    // O que a descoberta de sempre nem traria: sem log, NLB.
    await source(cloud.id, {
      name: 'sem-log',
      availability: 'no_destination',
      loggingState: 'disabled',
      notes: ['aws_cost_alb_logs'],
      stateCode: 'no_destination',
      details: { arn: facing.arn, internetFacing: true, destinationType: 'none' },
    });
    await source(cloud.id, {
      name: 'nlb',
      availability: 'unsupported_format',
      notes: [],
      stateCode: 'unsupported_format',
      details: { arn: facing.arn, internetFacing: false },
    });
    const stored = await prisma.awsSource.findMany({
      where: { cloudAccountId: cloud.id },
      orderBy: { id: 'asc' },
    });

    const onboarding = await onboardingOf(cloud.id);
    const shown = new Map(onboarding.sources.map((item) => [item.name, item]));
    expect([...shown.keys()].sort()).toEqual([
      'coletando',
      'com-erro',
      'de-sempre',
      'disponivel',
      'negado',
      'revogado',
    ]);
    for (const item of onboarding.sources) {
      expect(item).toMatchObject({
        collectable: false,
        notes: ['not_collected_yet'],
        permission: 'unknown',
        permissionDetail: null,
        permissionCheckedAt: null,
      });
      expect(item.details).not.toHaveProperty('internetFacing');
    }
    // Os sem autorização são iguais ao de sempre, no que o painel mostra.
    for (const row of [before, ready, denied]) {
      expect(shown.get(row.name)).toMatchObject({ state: 'unavailable', stateCode: 'not_collectable_yet' });
    }
    expect(shown.get('revogado')).toMatchObject({ state: 'revoked', stateCode: null });
    // O autorizado não finge coleta nem erro, e a conta não fica "coletando" (nem com erro) por causa dele.
    for (const name of ['coletando', 'com-erro']) {
      expect(shown.get(name)).toMatchObject({ state: 'authorized', stateCode: 'not_collectable_yet' });
    }
    await prisma.awsDiscoveryRun.create({
      data: {
        tenantId: tenant,
        cloudAccountId: cloud.id,
        trigger: 'connect',
        status: 'succeeded',
        startedAt: VERIFIED,
        finishedAt: VERIFIED,
      },
    });
    const derived = await onboardingOf(cloud.id);
    expect(derived.state).toBe('configuring');
    const collector = derived.checks.find((check) => check.id === 'collector_config');
    expect(collector?.status).toBe('pending');
    expect([...(collector?.sourceIds ?? [])].sort()).toEqual([collecting.id, broken.id].sort());
    // Ler não muda nada do que está gravado.
    expect(
      await prisma.awsSource.findMany({ where: { cloudAccountId: cloud.id }, orderBy: { id: 'asc' } }),
    ).toEqual(stored);

    // E tirar a autorização continua possível.
    const response = await write(
      admin,
      'post',
      `/v1/cloud-accounts/${cloud.id}/aws/sources/${collecting.id}/revoke`,
    ).expect(200);
    previousOnboardingSchema.parse(response.body);
    expect(await prisma.awsSource.findUniqueOrThrow({ where: { id: collecting.id } })).toMatchObject({
      state: 'revoked',
    });
    expect(await prisma.awsSource.findUniqueOrThrow({ where: { id: revoked.id } })).toMatchObject({
      state: 'revoked',
    });
  });

  it('a identidade da sessão é a que um painel de antes lê, para todos os papéis', async () => {
    for (const role of ROLES) {
      const response = await get(sessions.get(role) as TestSession, '/v1/me').expect(200);
      expect(previousMeSchema.safeParse(response.body).success, role).toBe(true);
    }
  });
});
