import 'reflect-metadata';
import { randomInt, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  AWS_MAX_AUTHORIZED_S3_SOURCES,
  AWS_MAX_AUTHORIZED_WEB_SOURCES,
  awsOnboardingSchema,
  type Role,
  ROLES,
  WEB_ESTIMATE_MAX_AGE_MS,
  WEB_ESTIMATE_REQUEST_INTERVAL_MS,
  WEB_OBSERVE_MS,
  WEB_ROUTES_LIMIT,
  WEB_TRUSTED_LIMIT,
  webLogSourceListSchema,
  webLogSourceSchema,
  webRouteListSchema,
  webRouteSchema,
  webTrustedSourceListSchema,
  webTrustedSourceSchema,
} from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { createSignedInUser, createTenant, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import type { TestSession } from './support/tenant-isolation.js';

const VERIFIED = new Date('2026-11-21T00:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const accountNumber = () => String(randomInt(100_000_000_000, 999_999_999_999));
const hex = () => randomInt(0x10000000, 0xffffffff).toString(16).padStart(16, '0');
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

interface Cloud {
  id: string;
  tenantId: string;
  accountId: string;
}

/**
 * A configuração dos ataques web pelos logs do ALB, com eles ligados no nó (`AWS_WEB_LOGS_ENABLED`): a autorização dos
 * balanceadores, os modos, a estimativa, as fontes confiáveis e as rotas. O nó é do plano Profissional (60 GiB por mês).
 */
describe('ataques web pelos logs do ALB: configuração (ligados)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let adminA: TestSession & { userId: string };
  let adminB: TestSession & { userId: string };
  const sessions = new Map<Role, TestSession & { userId: string }>();

  async function sessionFor(tenantId: string | null, role: Role) {
    const user = await createSignedInUser(app, { role, ...(tenantId !== null && { tenantId }) });
    const { cookie, token } = await withCsrf(app, user.cookie);
    return { cookie, csrfToken: token, userId: user.id };
  }
  const session = (role: Role) => sessions.get(role) as TestSession & { userId: string };
  const get = (as: TestSession, path: string) =>
    request(app.getHttpServer()).get(path).set('Cookie', as.cookie);
  const write = (as: TestSession, method: 'post' | 'patch' | 'delete', path: string) => {
    const agent = request(app.getHttpServer());
    return agent[method](path)
      .set('Cookie', as.cookie)
      .set('Origin', TEST_WEB_ORIGIN)
      .set('X-CSRF-Token', as.csrfToken);
  };
  const post = (as: TestSession, path: string) => write(as, 'post', path);
  const entryOf = (response: request.Response) =>
    prisma.auditLog.findFirstOrThrow({ where: { requestId: response.headers['x-request-id'] } });
  const sourceRow = (id: string) => prisma.awsSource.findUniqueOrThrow({ where: { id } });
  const settingsRow = (sourceId: string) => prisma.webSourceSettings.findFirst({ where: { sourceId } });

  function account(
    tenantId: string,
    data: Partial<Prisma.CloudAccountUncheckedCreateInput> = {},
  ): Promise<Cloud> {
    return prisma.cloudAccount.create({
      data: {
        tenantId,
        provider: 'aws',
        accountId: accountNumber(),
        regions: ['sa-east-1'],
        connection: 'connected',
        ingestFrom: VERIFIED,
        awsTemplateVersion: 2,
        awsCapabilities: ['discovery', 'service-logs', 'findings', 'log-groups'],
        awsCapabilitiesCheckedAt: VERIFIED,
        ...data,
      },
      select: { id: true, tenantId: true, accountId: true },
    });
  }

  /** Um ALB descoberto, com o log ligado e a permissão conferida (o que a tarefa aws-discovery grava). */
  function balancer(cloud: Cloud, data: Partial<Prisma.AwsSourceUncheckedCreateInput> = {}) {
    const name = `alb-${randomInt(1e6, 9e6)}`;
    return prisma.awsSource.create({
      data: {
        tenantId: cloud.tenantId,
        cloudAccountId: cloud.id,
        kind: 'elb_logs',
        region: 'sa-east-1',
        resourceId: name,
        name,
        details: {
          arn: `arn:aws:elasticloadbalancing:sa-east-1:${cloud.accountId}:loadbalancer/app/${name}/${hex()}`,
          internetFacing: true,
          destinationType: 's3',
          bucket: 'acessos',
          prefix: `AWSLogs/${cloud.accountId}/elasticloadbalancing/sa-east-1/`,
        },
        method: 's3',
        availability: 'available',
        loggingState: 'logging',
        permission: 'granted',
        permissionCheckedAt: VERIFIED,
        notes: ['high_volume'],
        state: 'available',
        ...data,
      },
    });
  }
  const detector = (cloud: Cloud) =>
    prisma.awsSource.create({
      data: {
        tenantId: cloud.tenantId,
        cloudAccountId: cloud.id,
        kind: 'guardduty',
        region: 'sa-east-1',
        resourceId: `det-${randomInt(1e6, 9e6)}`,
        name: 'GuardDuty',
        method: 'api',
        availability: 'available',
        permission: 'granted',
        state: 'available',
      },
    });

  /** A estimativa como o worker a grava (PR-4). 1 GB por dia é 46,6% dos 60 GiB do mês. */
  const COMPUTED = new Date(Math.floor((Date.now() - HOUR) / 1000) * 1000);
  function estimate(
    source: { id: string; tenantId: string },
    data: Partial<Prisma.WebSourceEstimateUncheckedCreateInput> = {},
  ) {
    return prisma.webSourceEstimate.create({
      data: {
        sourceId: source.id,
        tenantId: source.tenantId,
        lastRequestAt: COMPUTED,
        status: 'ready',
        computedAt: COMPUTED,
        day: new Date('2026-11-23'),
        objects: 864,
        sampledObjects: 20,
        bytesPerDay: 1_000_000_000n,
        ...data,
      },
    });
  }
  const acknowledgement = (sourceId: string, overrides: Record<string, unknown> = {}) => ({
    sourceId,
    estimatedAt: COMPUTED.toISOString(),
    estimatedGbPerDay: 1,
    projectedPercent: 46.6,
    acknowledged: true,
    ...overrides,
  });
  const authorizePath = (cloud: Cloud) => `/v1/cloud-accounts/${cloud.id}/aws/sources/authorize`;
  const authorize = (as: TestSession, cloud: Cloud, body: object) =>
    post(as, authorizePath(cloud)).send(body);
  /** Um ALB já autorizado pela rota, com a estimativa confirmada. */
  async function authorized(cloud: Cloud, as: TestSession = adminA) {
    const source = await balancer(cloud);
    await estimate(source);
    await authorize(as, cloud, { sourceIds: [source.id], webLogs: [acknowledgement(source.id)] }).expect(200);
    return source;
  }
  const endObservation = (sourceId: string) =>
    prisma.webSourceSettings.updateMany({
      where: { sourceId },
      data: { observeUntil: new Date(Date.now() - 1000) },
    });

  const trustedBody = (overrides: Record<string, unknown> = {}) => ({
    sourceId: null,
    cidr: `10.${randomInt(0, 256)}.${randomInt(0, 256)}.${randomInt(0, 256)}/32`,
    kind: 'office',
    reason: 'Escritório de teste',
    expiresAt: iso(30 * DAY),
    ...overrides,
  });
  const routeBody = (overrides: Record<string, unknown> = {}) => ({
    host: null,
    method: 'POST',
    path: `/entrar-${randomInt(1e6, 9e6)}`,
    kind: 'login',
    failureCodes: [401],
    successCodes: [200, 302],
    multiplier: 1,
    ...overrides,
  });

  beforeAll(async () => {
    app = await createApp({ awsWebLogs: true, plan: { PLAN: 'profissional' } });
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente Demo A (logs do ALB)');
    tenantB = await createTenant(app, 'Cliente Demo B (logs do ALB)');
    adminA = await sessionFor(tenantA, 'admin_cliente');
    adminB = await sessionFor(tenantB, 'admin_cliente');
    sessions.set('admin_cliente', adminA);
    sessions.set('analista_cliente', await sessionFor(tenantA, 'analista_cliente'));
    sessions.set('leitura', await sessionFor(tenantA, 'leitura'));
    const verax = await sessionFor(null, 'admin_verax');
    await post(verax, '/v1/session/tenant').send({ tenantId: tenantA }).expect(200);
    sessions.set('admin_verax', verax);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('a autorização do balanceador', () => {
    it('com a estimativa confirmada: autorizado, observando por 72 h, e a trilha diz o que o cliente viu', async () => {
      const cloud = await account(tenantA);
      const source = await balancer(cloud);
      const api = await detector(cloud);
      await estimate(source);
      const before = Date.now();
      const response = await authorize(adminA, cloud, {
        sourceIds: [source.id, api.id],
        webLogs: [acknowledgement(source.id)],
      }).expect(200);
      const item = awsOnboardingSchema
        .parse(response.body)
        .sources.find((candidate) => candidate.id === source.id);
      expect(item).toMatchObject({
        collectable: true,
        state: 'authorized',
        stateCode: 'awaiting_collector',
        method: 's3',
        notes: ['high_volume'],
      });
      const settings = await settingsRow(source.id);
      expect(settings).toMatchObject({
        tenantId: tenantA,
        mode: 'observe',
        thresholdMultiplier: 1,
        updatedBy: adminA.userId,
      });
      const until = settings?.observeUntil?.getTime() ?? 0;
      expect(until).toBeGreaterThanOrEqual(before + WEB_OBSERVE_MS);
      expect(until).toBeLessThanOrEqual(Date.now() + WEB_OBSERVE_MS);
      expect(WEB_OBSERVE_MS).toBe(72 * HOUR);
      // Só o balanceador tem configuração e estimativa na trilha.
      expect(await settingsRow(api.id)).toBeNull();
      const entry = await entryOf(response);
      expect(entry).toMatchObject({
        action: 'cloud_account.aws_source_authorized',
        outcome: 'success',
        tenantId: tenantA,
        resourceId: cloud.id,
      });
      const after = entry.after as Record<string, unknown>[];
      expect(after.find((row) => row['id'] === source.id)).toMatchObject({
        kind: 'elb_logs',
        state: 'authorized',
        estimate: acknowledgement(source.id),
        mode: 'observe',
        observeUntil: settings?.observeUntil?.toISOString(),
      });
      expect(after.find((row) => row['id'] === api.id)).not.toHaveProperty('mode');
    });

    it('sem a estimativa que vale, sem a ciência dela, com outros números ou sem a confirmação: 409, e nada muda', async () => {
      const cloud = await account(tenantA);
      const api = await detector(cloud);
      const cases: [
        string,
        Partial<Prisma.WebSourceEstimateUncheckedCreateInput> | null,
        Record<string, unknown> | null,
      ][] = [
        ['WEB_LOGS_ESTIMATE_REQUIRED', null, {}],
        ['WEB_LOGS_ESTIMATE_REQUIRED', {}, null],
        // Pedida e nunca respondida, com falha, ou velha demais (a idade conta do cálculo).
        [
          'WEB_LOGS_ESTIMATE_REQUIRED',
          {
            status: null,
            computedAt: null,
            day: null,
            objects: null,
            sampledObjects: null,
            bytesPerDay: null,
            requestedAt: COMPUTED,
          },
          {},
        ],
        [
          'WEB_LOGS_ESTIMATE_REQUIRED',
          { status: 'failed', errorCode: 'AccessDenied', bytesPerDay: null },
          {},
        ],
        [
          'WEB_LOGS_ESTIMATE_REQUIRED',
          { computedAt: new Date(COMPUTED.getTime() - WEB_ESTIMATE_MAX_AGE_MS) },
          { estimatedAt: new Date(COMPUTED.getTime() - WEB_ESTIMATE_MAX_AGE_MS).toISOString() },
        ],
        [
          'WEB_LOGS_ESTIMATE_REQUIRED',
          { computedAt: new Date(COMPUTED.getTime() + 2 * HOUR) },
          { estimatedAt: new Date(COMPUTED.getTime() + 2 * HOUR).toISOString() },
        ],
        ['WEB_LOGS_ESTIMATE_CHANGED', {}, { estimatedGbPerDay: 0.9 }],
        ['WEB_LOGS_ESTIMATE_CHANGED', {}, { estimatedGbPerDay: null }],
        ['WEB_LOGS_ESTIMATE_CHANGED', {}, { projectedPercent: 4.6 }],
        ['WEB_LOGS_ESTIMATE_CHANGED', {}, { projectedPercent: null }],
        ['WEB_LOGS_ESTIMATE_CHANGED', {}, { estimatedAt: new Date(COMPUTED.getTime() + 1000).toISOString() }],
        ['WEB_LOGS_ACKNOWLEDGEMENT_REQUIRED', {}, { acknowledged: false }],
        [
          'WEB_LOGS_ACKNOWLEDGEMENT_REQUIRED',
          { status: 'no_sample', bytesPerDay: null, objects: 0, sampledObjects: 0 },
          { estimatedGbPerDay: null, projectedPercent: null, acknowledged: false },
        ],
        // Um byte por dia, mas com a listagem cortada: o número é um piso.
        [
          'WEB_LOGS_ACKNOWLEDGEMENT_REQUIRED',
          { bytesPerDay: 1n, truncated: true },
          { estimatedGbPerDay: 0, projectedPercent: 0, acknowledged: false },
        ],
      ];
      for (const [code, stored, sent] of cases) {
        const source = await balancer(cloud);
        if (stored !== null) await estimate(source, stored);
        const response = await authorize(adminA, cloud, {
          sourceIds: [source.id, api.id],
          ...(sent !== null && { webLogs: [acknowledgement(source.id, sent)] }),
        }).expect(409);
        expect(response.body, code).toMatchObject({ code });
        // Tudo ou nada.
        expect(await sourceRow(source.id)).toEqual(source);
        expect(await sourceRow(api.id)).toEqual(api);
        expect(await settingsRow(source.id)).toBeNull();
        expect(await entryOf(response)).toMatchObject({
          action: 'cloud_account.aws_source_authorized',
          outcome: 'failure',
          statusCode: 409,
          tenantId: tenantA,
        });
      }
    });

    it('até 20% do plano (ou sem amostra, com a confirmação) entra; a estimativa de um não serve para outro', async () => {
      const cloud = await account(tenantA);
      const small = await balancer(cloud);
      await estimate(small, { bytesPerDay: 400_000_000n });
      await authorize(adminA, cloud, {
        sourceIds: [small.id],
        webLogs: [
          acknowledgement(small.id, { estimatedGbPerDay: 0.4, projectedPercent: 18.6, acknowledged: false }),
        ],
      }).expect(200);
      const unknown = await balancer(cloud);
      await estimate(unknown, { status: 'no_sample', bytesPerDay: null, objects: 0, sampledObjects: 0 });
      await authorize(adminA, cloud, {
        sourceIds: [unknown.id],
        webLogs: [acknowledgement(unknown.id, { estimatedGbPerDay: null, projectedPercent: null })],
      }).expect(200);
      const [first, second] = [await balancer(cloud), await balancer(cloud)];
      await estimate(first);
      const response = await authorize(adminA, cloud, {
        sourceIds: [first.id, second.id],
        webLogs: [acknowledgement(first.id), acknowledgement(second.id)],
      }).expect(409);
      expect(response.body).toMatchObject({ code: 'WEB_LOGS_ESTIMATE_REQUIRED' });
      expect(await sourceRow(first.id)).toEqual(first);
    });

    it('a estimativa é só dos balanceadores, e a que um pedido novo está refazendo ainda vale', async () => {
      const cloud = await account(tenantA);
      const api = await detector(cloud);
      await authorize(adminA, cloud, {
        sourceIds: [api.id],
        webLogs: [acknowledgement(api.id)],
      }).expect(400);
      expect(await sourceRow(api.id)).toEqual(api);
      const source = await balancer(cloud);
      await estimate(source, { requestedAt: new Date() });
      await authorize(adminA, cloud, {
        sourceIds: [source.id],
        webLogs: [acknowledgement(source.id)],
      }).expect(200);
    });

    it('o que a descoberta não dá como legível não entra: sem log, NLB, sem permissão ou sumido', async () => {
      const cloud = await account(tenantA);
      for (const [data, code] of [
        [
          { availability: 'no_destination', state: 'unavailable', notes: ['aws_cost_alb_logs'] },
          'SOURCE_NOT_AVAILABLE',
        ],
        [{ availability: 'unsupported_format', state: 'unavailable' }, 'SOURCE_NOT_AVAILABLE'],
        [
          {
            permission: 'missing',
            permissionDetail: 'outside_awslogs_prefix',
            state: 'needs_permission',
            notes: ['high_volume', 'additional_bucket_required'],
          },
          'SOURCE_PERMISSION_MISSING',
        ],
        [{ missingSince: VERIFIED }, 'SOURCE_NOT_AVAILABLE'],
      ] as [Partial<Prisma.AwsSourceUncheckedCreateInput>, string][]) {
        const source = await balancer(cloud, data);
        await estimate(source);
        const response = await authorize(adminA, cloud, {
          sourceIds: [source.id],
          webLogs: [acknowledgement(source.id)],
        }).expect(409);
        expect(response.body).toMatchObject({ code });
        expect(await settingsRow(source.id)).toBeNull();
      }
    });

    it('os tetos: 20 balanceadores por conta, e os 200 de bucket contam com eles', async () => {
      const many = (cloud: Cloud, total: number, data: Partial<Prisma.AwsSourceUncheckedCreateInput>) =>
        prisma.awsSource.createMany({
          data: Array.from({ length: total }, (_, i) => ({
            tenantId: cloud.tenantId,
            cloudAccountId: cloud.id,
            kind: 'elb_logs',
            region: 'sa-east-1',
            resourceId: `cheio-${i}`,
            name: `cheio-${i}`,
            method: 's3',
            availability: 'available',
            permission: 'granted',
            authorizedAt: VERIFIED,
            state: 'authorized',
            ...data,
          })),
        });
      const attempt = async (cloud: Cloud, status: 200 | 409) => {
        const source = await balancer(cloud);
        await estimate(source);
        const response = await authorize(adminA, cloud, {
          sourceIds: [source.id],
          webLogs: [acknowledgement(source.id)],
        }).expect(status);
        if (status === 409) expect(response.body).toMatchObject({ code: 'SOURCE_LIMIT_REACHED' });
      };
      const full = await account(tenantA);
      await many(full, AWS_MAX_AUTHORIZED_WEB_SOURCES - 1, {});
      await attempt(full, 200);
      await attempt(full, 409);
      // Uma revogada abre a vaga.
      await prisma.awsSource.updateMany({
        where: { cloudAccountId: full.id, resourceId: 'cheio-0' },
        data: { revokedAt: new Date(), state: 'revoked' },
      });
      await attempt(full, 200);
      const buckets = await account(tenantA);
      await many(buckets, AWS_MAX_AUTHORIZED_S3_SOURCES - 1, { kind: 'vpc_flow_logs' });
      await attempt(buckets, 200);
      await attempt(buckets, 409);
      // E o balanceador ocupa a vaga de uma fonte do Wazuh, como sempre ocupou a de bucket.
      const flow = await balancer(buckets, { kind: 'vpc_flow_logs', notes: [] });
      const response = await authorize(adminA, buckets, { sourceIds: [flow.id] }).expect(409);
      expect(response.body).toMatchObject({ code: 'SOURCE_LIMIT_REACHED' });
    });

    it('retirar a autorização não apaga nada; a nova recomeça a observação e guarda o resto', async () => {
      const cloud = await account(tenantA);
      const source = await authorized(cloud);
      await endObservation(source.id);
      await write(adminA, 'patch', `/v1/web-logs/sources/${source.id}/settings`)
        .send({ mode: 'alert', thresholdMultiplier: 2.5 })
        .expect(200);
      await post(adminA, `/v1/web-logs/sources/${source.id}/routes`).send(routeBody()).expect(201);
      await post(adminA, '/v1/web-logs/trusted-sources')
        .send(trustedBody({ sourceId: source.id }))
        .expect(201);
      const slot = new Date('2026-11-24T12:00:00.000Z');
      const counters = { requests: 3n, blocked: 0n, clientErrors: 0n, serverErrors: 0n, flagged: 0n };
      await prisma.webTrafficSlot.create({
        data: {
          tenantId: tenantA,
          sourceId: source.id,
          slotStart: slot,
          country: 'BR',
          clientClass: 'direct',
          ...counters,
        },
      });
      await prisma.webLogObject.create({
        data: {
          cloudAccountId: cloud.id,
          objectHash: 'a'.repeat(64),
          tenantId: tenantA,
          sourceId: source.id,
          status: 'read',
          slotStart: slot,
        },
      });
      await prisma.webEngineState.create({
        data: {
          sourceId: source.id,
          tenantId: tenantA,
          loadBalancer: 'app/loja/0123456789abcdef',
          version: 1,
          state: {},
        },
      });
      const leftovers = async () =>
        Promise.all(
          [
            prisma.webSourceSettings.count({ where: { sourceId: source.id } }),
            prisma.webSourceEstimate.count({ where: { sourceId: source.id } }),
            prisma.webRoute.count({ where: { sourceId: source.id } }),
            prisma.webTrustedSource.count({ where: { sourceId: source.id } }),
            prisma.webTrafficSlot.count({ where: { sourceId: source.id } }),
            prisma.webLogObject.count({ where: { sourceId: source.id } }),
            prisma.webEngineState.count({ where: { sourceId: source.id } }),
          ].map((count) => count),
        );
      await post(adminA, `/v1/cloud-accounts/${cloud.id}/aws/sources/${source.id}/revoke`).expect(200);
      expect(await leftovers()).toEqual([1, 1, 1, 1, 1, 1, 1]);
      expect(await settingsRow(source.id)).toMatchObject({ mode: 'alert', thresholdMultiplier: 2.5 });
      // Sem a autorização, o modo não muda; a leitura diz que ela não vale.
      const refused = await write(adminA, 'patch', `/v1/web-logs/sources/${source.id}/settings`)
        .send({ mode: 'observe' })
        .expect(409);
      expect(refused.body).toMatchObject({ code: 'SOURCE_NOT_AUTHORIZED' });
      const item = webLogSourceSchema.parse(
        (await get(adminA, `/v1/web-logs/sources/${source.id}`).expect(200)).body,
      );
      expect(item).toMatchObject({ authorized: false, state: 'revoked' });

      const before = Date.now();
      await authorize(adminA, cloud, {
        sourceIds: [source.id],
        webLogs: [acknowledgement(source.id)],
      }).expect(200);
      const again = await settingsRow(source.id);
      expect(again).toMatchObject({ mode: 'observe', thresholdMultiplier: 2.5 });
      expect(again?.observeUntil?.getTime()).toBeGreaterThanOrEqual(before + WEB_OBSERVE_MS);
      expect(await leftovers()).toEqual([1, 1, 1, 1, 1, 1, 1]);

      // A conta apagada leva tudo o que é dos balanceadores dela.
      await prisma.cloudAccount.delete({ where: { id: cloud.id } });
      expect(await leftovers()).toEqual([0, 0, 0, 0, 0, 0, 0]);
    });

    it('autorizar de novo um já autorizado não mexe na configuração nem pede a estimativa; o que sumiu, pede', async () => {
      const cloud = await account(tenantA);
      const source = await authorized(cloud);
      await endObservation(source.id);
      const settings = await settingsRow(source.id);
      await authorize(adminA, cloud, { sourceIds: [source.id] }).expect(200);
      expect(await settingsRow(source.id)).toEqual(settings);
      await prisma.awsSource.update({
        where: { id: source.id },
        data: { state: 'source_missing', stateCode: 'not_found' },
      });
      const response = await authorize(adminA, cloud, { sourceIds: [source.id] }).expect(409);
      expect(response.body).toMatchObject({ code: 'WEB_LOGS_ESTIMATE_REQUIRED' });
      await authorize(adminA, cloud, {
        sourceIds: [source.id],
        webLogs: [acknowledgement(source.id)],
      }).expect(200);
      expect((await settingsRow(source.id))?.observeUntil?.getTime()).toBeGreaterThan(Date.now() + 71 * HOUR);
    });

    it('só administradores autorizam, e só no próprio cliente', async () => {
      const cloud = await account(tenantA);
      for (const role of ROLES) {
        const source = await balancer(cloud);
        await estimate(source);
        const allowed = role === 'admin_cliente' || role === 'admin_verax';
        await authorize(session(role), cloud, {
          sourceIds: [source.id],
          webLogs: [acknowledgement(source.id)],
        }).expect(allowed ? 200 : 403);
        expect((await settingsRow(source.id)) !== null).toBe(allowed);
      }
      const ofB = await account(tenantB);
      const sourceB = await balancer(ofB);
      await estimate(sourceB);
      const body = { sourceIds: [sourceB.id], webLogs: [acknowledgement(sourceB.id)] };
      await authorize(adminA, ofB, body).expect(404);
      // Nem pela conta própria, citando a fonte do outro.
      await authorize(adminA, cloud, body).expect(404);
      expect(await sourceRow(sourceB.id)).toEqual(sourceB);
      expect(await settingsRow(sourceB.id)).toBeNull();
    });
  });

  describe('os balanceadores e o modo', () => {
    it('a lista: os da internet primeiro, o identificador do ALB, e a projeção só para quem lê o plano', async () => {
      const tenant = await createTenant(app, 'Cliente Demo (lista de balanceadores)');
      const admin = await sessionFor(tenant, 'admin_cliente');
      const analyst = await sessionFor(tenant, 'analista_cliente');
      const reader = await sessionFor(tenant, 'leitura');
      expect((await get(admin, '/v1/web-logs/sources').expect(200)).body).toEqual({ items: [] });
      const cloud = await account(tenant);
      const other = await account(tenant);
      const arn = (path: string) =>
        `arn:aws:elasticloadbalancing:sa-east-1:${cloud.accountId}:loadbalancer/${path}`;
      const internal = await balancer(cloud, {
        name: 'a-interno',
        resourceId: 'a-interno',
        details: { arn: arn('app/a-interno/0123456789abcdef'), internetFacing: false },
      });
      const facing = await balancer(other, {
        name: 'z-loja',
        resourceId: 'z-loja',
        details: { arn: arn('app/z-loja/0123456789abcdef'), internetFacing: true },
      });
      const network = await balancer(cloud, {
        name: 'b-rede',
        resourceId: 'b-rede',
        availability: 'unsupported_format',
        state: 'unavailable',
        details: { arn: arn('net/b-rede/0123456789abcdef'), internetFacing: true },
      });
      await estimate(facing, { requestedAt: COMPUTED, requestedBy: 'quem-pediu' });
      await detector(cloud);

      const list = webLogSourceListSchema.parse((await get(admin, '/v1/web-logs/sources').expect(200)).body);
      expect(list.items.map((item) => [item.name, item.loadBalancer, item.internetFacing])).toEqual([
        ['b-rede', null, true],
        ['z-loja', 'app/z-loja/0123456789abcdef', true],
        ['a-interno', 'app/a-interno/0123456789abcdef', false],
      ]);
      expect(list.items.map((item) => item.accountId)).toEqual([
        cloud.accountId,
        other.accountId,
        cloud.accountId,
      ]);
      const item = list.items.find((candidate) => candidate.id === facing.id);
      expect(item).toMatchObject({ authorized: false, settings: null, state: 'available' });
      expect(item?.estimate).toEqual({
        requestedAt: COMPUTED.toISOString(),
        status: 'ready',
        computedAt: COMPUTED.toISOString(),
        day: '2026-11-23',
        objects: 864,
        truncated: false,
        errorCode: null,
        projection: {
          gbPerDay: 1,
          percent: 46.6,
          basis: 'monthly',
          acknowledgementRequired: true,
          validUntil: new Date(COMPUTED.getTime() + WEB_ESTIMATE_MAX_AGE_MS).toISOString(),
        },
      });
      expect(list.items.find((candidate) => candidate.id === internal.id)?.estimate).toBeNull();
      expect(network.id).not.toBe(facing.id);
      // O analista e o de leitura leem tudo, menos a porcentagem: ela diria o tamanho do plano (`plan:read`).
      for (const as of [analyst, reader]) {
        const seen = webLogSourceSchema.parse(
          (await get(as, `/v1/web-logs/sources/${facing.id}`).expect(200)).body,
        );
        expect(seen).toEqual({ ...item, estimate: { ...item?.estimate, projection: null } });
      }
    });

    it('a estimativa velha ou com falha não tem projeção', async () => {
      const cloud = await account(tenantA);
      for (const data of [
        { computedAt: new Date(Date.now() - WEB_ESTIMATE_MAX_AGE_MS - 1000) },
        { status: 'failed', errorCode: 'AccessDenied', bytesPerDay: null },
      ]) {
        const source = await balancer(cloud);
        await estimate(source, data);
        const response = await get(adminA, `/v1/web-logs/sources/${source.id}`).expect(200);
        expect(webLogSourceSchema.parse(response.body).estimate?.projection).toBeNull();
      }
    });

    it('só alerta depois da observação; volta a observar quando quiser; e tudo entra na trilha', async () => {
      const cloud = await account(tenantA);
      const source = await authorized(cloud);
      const path = `/v1/web-logs/sources/${source.id}/settings`;
      const early = await write(adminA, 'patch', path).send({ mode: 'alert' }).expect(409);
      expect(early.body).toMatchObject({ code: 'WEB_OBSERVATION_PENDING' });
      expect(await entryOf(early)).toMatchObject({
        action: 'web_logs.settings_update',
        outcome: 'failure',
        statusCode: 409,
        tenantId: tenantA,
      });
      // O multiplicador não espera.
      await write(adminA, 'patch', path).send({ thresholdMultiplier: 0.5 }).expect(200);
      expect(await settingsRow(source.id)).toMatchObject({ mode: 'observe', thresholdMultiplier: 0.5 });
      // Quem mudou por último é quem mudou, e não quem autorizou.
      const verax = session('admin_verax');
      await write(verax, 'patch', path).send({ thresholdMultiplier: 0.5 }).expect(200);
      expect(await settingsRow(source.id)).toMatchObject({ updatedBy: verax.userId });
      await endObservation(source.id);
      const response = await write(adminA, 'patch', path).send({ mode: 'alert' }).expect(200);
      expect(webLogSourceSchema.parse(response.body)).toMatchObject({
        authorized: true,
        settings: { mode: 'alert', thresholdMultiplier: 0.5, updatedBy: adminA.userId },
      });
      const entry = await entryOf(response);
      expect(entry).toMatchObject({
        action: 'web_logs.settings_update',
        outcome: 'success',
        actorId: adminA.userId,
        tenantId: tenantA,
        resourceType: 'cloud_account',
        resourceId: cloud.id,
      });
      expect(entry.before).toMatchObject({ sourceId: source.id, mode: 'observe' });
      expect(entry.after).toMatchObject({ sourceId: source.id, mode: 'alert' });
      // Já alertando, mudar outra coisa não esbarra numa observação que recomeçou por fora.
      await prisma.webSourceSettings.updateMany({
        where: { sourceId: source.id },
        data: { observeUntil: new Date(Date.now() + HOUR) },
      });
      await write(adminA, 'patch', path).send({ mode: 'alert', thresholdMultiplier: 10 }).expect(200);
      await write(adminA, 'patch', path).send({ mode: 'observe' }).expect(200);
      await write(adminA, 'patch', path).send({ mode: 'alert' }).expect(409);
      for (const body of [{}, { mode: 'off' }, { thresholdMultiplier: 11 }, { observeUntil: null }]) {
        await write(adminA, 'patch', path).send(body).expect(400);
      }
      // Sem autorização nenhuma, não há o que configurar.
      const fresh = await balancer(cloud);
      const refused = await write(adminA, 'patch', `/v1/web-logs/sources/${fresh.id}/settings`)
        .send({ mode: 'observe' })
        .expect(409);
      expect(refused.body).toMatchObject({ code: 'SOURCE_NOT_AUTHORIZED' });
      expect(await settingsRow(fresh.id)).toBeNull();
      // Outro tipo de fonte não é um balanceador.
      const api = await detector(cloud);
      await get(adminA, `/v1/web-logs/sources/${api.id}`).expect(404);
      await write(adminA, 'patch', `/v1/web-logs/sources/${api.id}/settings`)
        .send({ mode: 'observe' })
        .expect(404);
    });
  });

  describe('o pedido da estimativa', () => {
    const path = (id: string) => `/v1/web-logs/sources/${id}/estimate`;

    it('grava o pedido uma vez (202), com o limite de um a cada 5 min depois de respondido, na trilha', async () => {
      const cloud = await account(tenantA);
      const source = await balancer(cloud);
      const response = await post(adminA, path(source.id)).expect(202);
      const pending = webLogSourceSchema.parse(response.body).estimate;
      expect(pending).toMatchObject({ status: null, computedAt: null, projection: null });
      expect(pending?.requestedAt).not.toBeNull();
      const row = await prisma.webSourceEstimate.findFirstOrThrow({ where: { sourceId: source.id } });
      expect(row).toMatchObject({ tenantId: tenantA, requestedBy: adminA.userId });
      expect(row.lastRequestAt).toEqual(row.requestedAt);
      expect(await entryOf(response)).toMatchObject({
        action: 'web_logs.estimate_request',
        outcome: 'success',
        tenantId: tenantA,
        resourceType: 'cloud_account',
        resourceId: cloud.id,
        before: { sourceId: source.id, requestedAt: null },
        after: { sourceId: source.id, requestedAt: row.requestedAt?.toISOString() },
      });
      // Pendente: o pedido de novo não o renova.
      await post(adminA, path(source.id)).expect(202);
      expect(await prisma.webSourceEstimate.findFirstOrThrow({ where: { sourceId: source.id } })).toEqual(
        row,
      );
      // Respondido: o seguinte espera.
      const answer = (lastRequestAt: Date) =>
        prisma.webSourceEstimate.updateMany({
          where: { sourceId: source.id },
          data: {
            requestedAt: null,
            lastRequestAt,
            status: 'ready',
            computedAt: COMPUTED,
            day: new Date('2026-11-23'),
            objects: 1,
            bytesPerDay: 5n,
          },
        });
      await answer(new Date(Date.now() - WEB_ESTIMATE_REQUEST_INTERVAL_MS + 60_000));
      const limited = await post(adminA, path(source.id)).expect(429);
      expect(limited.body).toMatchObject({ code: 'WEB_ESTIMATE_RATE_LIMITED' });
      await answer(new Date(Date.now() - WEB_ESTIMATE_REQUEST_INTERVAL_MS - 1000));
      const renewed = webLogSourceSchema.parse((await post(adminA, path(source.id)).expect(202)).body);
      // O resultado anterior continua à vista enquanto o novo não vem.
      expect(renewed.estimate).toMatchObject({ status: 'ready', objects: 1 });
      expect(renewed.estimate?.requestedAt).not.toBeNull();
    });

    it('recusa o que não dá para estimar, sem gravar pedido', async () => {
      const ok = await account(tenantA);
      const cases: [
        Partial<Prisma.CloudAccountUncheckedCreateInput>,
        Partial<Prisma.AwsSourceUncheckedCreateInput>,
        string,
      ][] = [
        [{ status: 'inactive' }, {}, 'ACCOUNT_NOT_CONNECTED'],
        [{ connection: 'waiting' }, {}, 'ACCOUNT_NOT_CONNECTED'],
        [{ checkRequestedAt: new Date(0) }, {}, 'ACCOUNT_NOT_CONNECTED'],
        [{}, { availability: 'no_destination', state: 'unavailable' }, 'SOURCE_NOT_AVAILABLE'],
        [{}, { availability: 'unsupported_format', state: 'unavailable' }, 'SOURCE_NOT_AVAILABLE'],
        [{}, { missingSince: VERIFIED }, 'SOURCE_NOT_AVAILABLE'],
        [{}, { permission: 'missing', state: 'needs_permission' }, 'SOURCE_PERMISSION_MISSING'],
        [{}, { permission: 'unknown', state: 'needs_permission' }, 'SOURCE_PERMISSION_MISSING'],
      ];
      for (const [accountData, sourceData, code] of cases) {
        const cloud = Object.keys(accountData).length === 0 ? ok : await account(tenantA, accountData);
        const source = await balancer(cloud, sourceData);
        const response = await post(adminA, path(source.id)).expect(409);
        expect(response.body, code).toMatchObject({ code });
        expect(await prisma.webSourceEstimate.count({ where: { sourceId: source.id } })).toBe(0);
        // Nenhum teste deixa verificação pendente (outras suítes olham os pedidos de todos os clientes).
        if (cloud.id !== ok.id) await prisma.cloudAccount.delete({ where: { id: cloud.id } });
      }
    });
  });

  describe('as fontes confiáveis', () => {
    const base = '/v1/web-logs/trusted-sources';

    it('cria, lista, altera e remove, com a faixa normalizada e tudo na trilha', async () => {
      const cloud = await account(tenantA);
      const source = await balancer(cloud);
      const expiresAt = iso(364 * DAY);
      const response = await post(adminA, base)
        .send(trustedBody({ cidr: '2001:0DB8:0:7::/64', expiresAt }))
        .expect(201);
      const created = webTrustedSourceSchema.parse(response.body);
      expect(created).toMatchObject({
        sourceId: null,
        cidr: '2001:db8:0:7::/64',
        kind: 'office',
        active: true,
        expiresAt,
        createdBy: adminA.userId,
        updatedBy: adminA.userId,
      });
      expect(await entryOf(response)).toMatchObject({
        action: 'web_logs.trusted_source_create',
        outcome: 'success',
        actorId: adminA.userId,
        tenantId: tenantA,
        resourceType: 'tenant',
        resourceId: tenantA,
        after: { id: created.id, cidr: '2001:db8:0:7::/64' },
      });
      const own = await post(adminA, base)
        .send(trustedBody({ sourceId: source.id, cidr: '2001:db8:0:7::/64' }))
        .expect(201);
      expect(await entryOf(own)).toMatchObject({ resourceType: 'cloud_account', resourceId: cloud.id });

      const updated = await write(adminA, 'patch', `${base}/${created.id}`)
        .send({ kind: 'pentest', reason: 'Teste contratado', expiresAt: iso(2 * DAY) })
        .expect(200);
      expect(webTrustedSourceSchema.parse(updated.body)).toMatchObject({
        cidr: '2001:db8:0:7::/64',
        kind: 'pentest',
        reason: 'Teste contratado',
      });
      expect(await entryOf(updated)).toMatchObject({
        action: 'web_logs.trusted_source_update',
        before: { kind: 'office' },
        after: { kind: 'pentest' },
      });
      const list = webTrustedSourceListSchema.parse((await get(adminA, base).expect(200)).body);
      expect(list.limit).toBe(WEB_TRUSTED_LIMIT);
      expect(list.items.map((item) => item.id)).toEqual(
        expect.arrayContaining([created.id, (own.body as { id: string }).id]),
      );
      const removed = await write(adminA, 'delete', `${base}/${created.id}`).expect(204);
      expect(await entryOf(removed)).toMatchObject({
        action: 'web_logs.trusted_source_delete',
        outcome: 'success',
        tenantId: tenantA,
        before: { id: created.id, cidr: '2001:db8:0:7::/64' },
      });
      await write(adminA, 'delete', `${base}/${created.id}`).expect(404);
    });

    it('a mesma faixa não se repete no mesmo lugar, escrita como for; em outro lugar, vale', async () => {
      const cloud = await account(tenantA);
      const [first, second] = [await balancer(cloud), await balancer(cloud)];
      const cidr = `2001:db8:${randomInt(1, 9999)}::/48`;
      for (const sourceId of [null, first.id, second.id]) {
        await post(adminA, base).send(trustedBody({ sourceId, cidr })).expect(201);
        const response = await post(adminA, base)
          .send(trustedBody({ sourceId, cidr: cidr.slice(0, cidr.indexOf('::')) + ':0:0:0:0:0/48' }))
          .expect(409);
        expect(response.body).toMatchObject({ code: 'WEB_TRUSTED_DUPLICATE' });
      }
    });

    it('recusa a faixa larga demais, a validade fora do prazo, o balanceador que não existe e o corpo fora do contrato', async () => {
      const before = await prisma.webTrustedSource.count({ where: { tenantId: tenantA } });
      for (const overrides of [
        { cidr: '198.51.0.0/15' },
        { cidr: '0.0.0.0/0' },
        { cidr: '2001:db8::/31' },
        { cidr: '2001:db8::/65' },
        { cidr: '192.0.2.1/24' },
        { cidr: undefined },
        { kind: 'vpn' },
        { reason: '' },
        { sourceId: undefined },
        { tenantId: tenantB },
        { createdBy: 'outro' },
      ]) {
        await post(adminA, base).send(trustedBody(overrides)).expect(400);
      }
      for (const expiresAt of [iso(-1000), iso(366 * DAY)]) {
        const response = await post(adminA, base).send(trustedBody({ expiresAt })).expect(400);
        expect(response.body).toMatchObject({ code: 'WEB_TRUSTED_EXPIRY_INVALID' });
      }
      const cloud = await account(tenantA);
      for (const sourceId of [randomUUID(), (await detector(cloud)).id]) {
        await post(adminA, base).send(trustedBody({ sourceId })).expect(404);
      }
      expect(await prisma.webTrustedSource.count({ where: { tenantId: tenantA } })).toBe(before);
      const created = webTrustedSourceSchema.parse(
        (await post(adminA, base).send(trustedBody()).expect(201)).body,
      );
      const response = await write(adminA, 'patch', `${base}/${created.id}`)
        .send({ expiresAt: iso(366 * DAY) })
        .expect(400);
      expect(response.body).toMatchObject({ code: 'WEB_TRUSTED_EXPIRY_INVALID' });
      for (const body of [{}, { cidr: '192.0.2.0/24' }, { sourceId: null }]) {
        await write(adminA, 'patch', `${base}/${created.id}`).send(body).expect(400);
      }
    });

    it('o teto é do cliente inteiro, e dois pedidos ao mesmo tempo não passam os dois por ele', async () => {
      const tenant = await createTenant(app, 'Cliente Demo (teto de fontes confiáveis)');
      const admin = await sessionFor(tenant, 'admin_cliente');
      const cloud = await account(tenant);
      const source = await balancer(cloud);
      const now = new Date();
      await prisma.webTrustedSource.createMany({
        data: Array.from({ length: WEB_TRUSTED_LIMIT - 1 }, (_, i) => ({
          tenantId: tenant,
          // Metade de todos os balanceadores, metade de um; uma delas já vencida.
          sourceId: i % 2 === 0 ? null : source.id,
          cidr: `198.51.100.${i}/32`,
          kind: 'monitor',
          reason: 'Teste',
          expiresAt: i === 0 ? new Date(now.getTime() - DAY) : new Date(now.getTime() + DAY),
        })),
      });
      const results = await Promise.all(
        [0, 1, 2].map((i) => post(admin, base).send(trustedBody({ cidr: `192.0.2.${i}/32` }))),
      );
      expect(results.map((response) => response.status).sort()).toEqual([201, 409, 409]);
      expect(results.find((response) => response.status === 409)?.body).toMatchObject({
        code: 'WEB_TRUSTED_LIMIT_REACHED',
      });
      const list = webTrustedSourceListSchema.parse((await get(admin, base).expect(200)).body);
      expect(list.items).toHaveLength(WEB_TRUSTED_LIMIT);
      expect(list.items.filter((item) => !item.active)).toHaveLength(1);
      // Tirar uma (até a vencida) abre a vaga.
      const expired = list.items.find((item) => !item.active)?.id ?? '';
      await write(admin, 'delete', `${base}/${expired}`).expect(204);
      await post(admin, base)
        .send(trustedBody({ cidr: '192.0.2.99/32' }))
        .expect(201);
      // O teto de um cliente não é o de outro.
      await post(adminA, base).send(trustedBody()).expect(201);
    });
  });

  describe('as rotas declaradas', () => {
    const base = (id: string) => `/v1/web-logs/sources/${id}/routes`;

    it('cria, lista, altera e remove, em minúsculas e na trilha da conta', async () => {
      const cloud = await account(tenantA);
      const source = await balancer(cloud);
      const response = await post(adminA, base(source.id))
        .send(routeBody({ host: 'Loja.Example.com', path: '/Conta/*/Entrar' }))
        .expect(201);
      const created = webRouteSchema.parse(response.body);
      expect(created).toMatchObject({
        sourceId: source.id,
        host: 'loja.example.com',
        path: '/conta/*/entrar',
        failureCodes: [401],
        createdBy: adminA.userId,
      });
      expect(await entryOf(response)).toMatchObject({
        action: 'web_logs.route_create',
        outcome: 'success',
        actorId: adminA.userId,
        tenantId: tenantA,
        resourceType: 'cloud_account',
        resourceId: cloud.id,
        after: { id: created.id, path: '/conta/*/entrar' },
      });
      const path = `${base(source.id)}/${created.id}`;
      const updated = await write(adminA, 'patch', path)
        .send({ kind: 'mfa', failureCodes: [], multiplier: 3 })
        .expect(200);
      expect(webRouteSchema.parse(updated.body)).toMatchObject({
        path: '/conta/*/entrar',
        kind: 'mfa',
        failureCodes: [],
        successCodes: [200, 302],
        multiplier: 3,
      });
      expect(await entryOf(updated)).toMatchObject({
        action: 'web_logs.route_update',
        before: { kind: 'login' },
        after: { kind: 'mfa' },
      });
      // O código que já é de sucesso não vira também de falha, mesmo mandando só uma das listas.
      await write(adminA, 'patch', path)
        .send({ failureCodes: [200] })
        .expect(400);
      for (const body of [{}, { path: '/outra' }, { host: null }, { method: 'GET' }, { multiplier: 11 }]) {
        await write(adminA, 'patch', path).send(body).expect(400);
      }
      const list = webRouteListSchema.parse((await get(adminA, base(source.id)).expect(200)).body);
      expect(list).toMatchObject({ limit: WEB_ROUTES_LIMIT, items: [{ id: created.id, kind: 'mfa' }] });
      const removed = await write(adminA, 'delete', path).expect(204);
      expect(await entryOf(removed)).toMatchObject({
        action: 'web_logs.route_delete',
        resourceId: cloud.id,
        before: { id: created.id },
      });
      await write(adminA, 'delete', path).expect(404);
    });

    it('a mesma rota não se repete (o host vazio conta), e a de outro balanceador não aparece aqui', async () => {
      const cloud = await account(tenantA);
      const [first, second] = [await balancer(cloud), await balancer(cloud)];
      for (const host of [null, 'loja.example.com']) {
        await post(adminA, base(first.id))
          .send(routeBody({ host, path: '/entrar' }))
          .expect(201);
        const response = await post(adminA, base(first.id))
          .send(routeBody({ host, path: '/ENTRAR', kind: 'ignore' }))
          .expect(409);
        expect(response.body).toMatchObject({ code: 'WEB_ROUTE_DUPLICATE' });
        await post(adminA, base(first.id))
          .send(routeBody({ host, path: '/entrar', method: 'PUT' }))
          .expect(201);
      }
      const own = webRouteSchema.parse(
        (
          await post(adminA, base(second.id))
            .send(routeBody({ path: '/entrar' }))
            .expect(201)
        ).body,
      );
      // Pelo caminho do outro balanceador, a rota não existe.
      const list = webRouteListSchema.parse((await get(adminA, base(first.id)).expect(200)).body);
      expect(list.items).toHaveLength(4);
      expect(list.items.map((item) => item.id)).not.toContain(own.id);
      await write(adminA, 'patch', `${base(first.id)}/${own.id}`)
        .send({ kind: 'ignore' })
        .expect(404);
      await write(adminA, 'delete', `${base(first.id)}/${own.id}`).expect(404);
      expect(await prisma.webRoute.findUnique({ where: { id: own.id } })).toMatchObject({ kind: 'login' });
    });

    it('recusa o que está fora do contrato, e o balanceador que não existe', async () => {
      const cloud = await account(tenantA);
      const source = await balancer(cloud);
      for (const overrides of [
        { path: 'entrar' },
        { path: '/a//b' },
        { path: '/log*' },
        { path: '/a/b/c/d/e/f/g/h/i' },
        { path: '/a/../b' },
        { host: '*.example.com' },
        { method: 'HEAD' },
        { kind: 'admin' },
        { failureCodes: [200] },
        { failureCodes: [99] },
        { multiplier: 0.4 },
        { sourceId: source.id },
        { tenantId: tenantB },
      ]) {
        await post(adminA, base(source.id)).send(routeBody(overrides)).expect(400);
      }
      for (const id of [randomUUID(), (await detector(cloud)).id]) {
        await get(adminA, base(id)).expect(404);
        await post(adminA, base(id)).send(routeBody()).expect(404);
      }
      expect(await prisma.webRoute.count({ where: { sourceId: source.id } })).toBe(0);
    });

    it('o teto é por balanceador, e dois pedidos ao mesmo tempo não passam os dois por ele', async () => {
      const cloud = await account(tenantA);
      const [full, other] = [await balancer(cloud), await balancer(cloud)];
      await prisma.webRoute.createMany({
        data: Array.from({ length: WEB_ROUTES_LIMIT - 1 }, (_, i) => ({
          tenantId: tenantA,
          sourceId: full.id,
          path: `/rota-${i}`,
          kind: 'login',
        })),
      });
      const results = await Promise.all([0, 1, 2].map(() => post(adminA, base(full.id)).send(routeBody())));
      expect(results.map((response) => response.status).sort()).toEqual([201, 409, 409]);
      expect(results.find((response) => response.status === 409)?.body).toMatchObject({
        code: 'WEB_ROUTE_LIMIT_REACHED',
      });
      const list = webRouteListSchema.parse((await get(adminA, base(full.id)).expect(200)).body);
      expect(list.items).toHaveLength(WEB_ROUTES_LIMIT);
      await post(adminA, base(other.id)).send(routeBody()).expect(201);
    });
  });

  describe('quem pode o quê', () => {
    interface Call {
      name: string;
      method: 'get' | 'post' | 'patch' | 'delete';
      path: string;
      body?: object;
      ok: number;
    }
    /** Todas as rotas, com recursos novos a cada vez. */
    async function calls(tenantId: string): Promise<Call[]> {
      const cloud = await account(tenantId);
      const source = await authorized(cloud, tenantId === tenantA ? adminA : adminB);
      const fresh = await balancer(cloud);
      const now = new Date();
      const trusted = () =>
        prisma.webTrustedSource.create({
          data: {
            tenantId,
            cidr: `10.${randomInt(0, 256)}.${randomInt(0, 256)}.${randomInt(0, 256)}/32`,
            sourceId: source.id,
            kind: 'office',
            reason: 'Teste',
            expiresAt: new Date(now.getTime() + DAY),
          },
        });
      const route = () =>
        prisma.webRoute.create({
          data: { tenantId, sourceId: source.id, path: `/r-${randomInt(1e6, 9e6)}`, kind: 'login' },
        });
      const wide = await prisma.webTrustedSource.create({
        data: {
          tenantId,
          cidr: `10.${randomInt(0, 256)}.${randomInt(0, 256)}.${randomInt(0, 256)}/32`,
          kind: 'office',
          reason: 'Teste',
          expiresAt: new Date(now.getTime() + DAY),
        },
      });
      const [trustedA, trustedB, routeA, routeB] = [
        await trusted(),
        await trusted(),
        await route(),
        await route(),
      ];
      const own = `/v1/web-logs/sources/${source.id}`;
      const list = '/v1/web-logs/trusted-sources';
      return [
        { name: 'ler um balanceador', method: 'get', path: own, ok: 200 },
        { name: 'ler as rotas', method: 'get', path: `${own}/routes`, ok: 200 },
        {
          name: 'mudar o modo',
          method: 'patch',
          path: `${own}/settings`,
          body: { thresholdMultiplier: 2 },
          ok: 200,
        },
        {
          name: 'pedir a estimativa',
          method: 'post',
          path: `/v1/web-logs/sources/${fresh.id}/estimate`,
          ok: 202,
        },
        { name: 'criar rota', method: 'post', path: `${own}/routes`, body: routeBody(), ok: 201 },
        {
          name: 'alterar rota',
          method: 'patch',
          path: `${own}/routes/${routeA.id}`,
          body: { kind: 'mfa' },
          ok: 200,
        },
        { name: 'remover rota', method: 'delete', path: `${own}/routes/${routeB.id}`, ok: 204 },
        {
          name: 'criar fonte confiável num balanceador',
          method: 'post',
          path: list,
          body: trustedBody({ sourceId: source.id }),
          ok: 201,
        },
        {
          name: 'alterar fonte confiável',
          method: 'patch',
          path: `${list}/${trustedA.id}`,
          body: { reason: 'Outro' },
          ok: 200,
        },
        { name: 'remover fonte confiável', method: 'delete', path: `${list}/${trustedB.id}`, ok: 204 },
        {
          name: 'alterar fonte confiável de todos os balanceadores',
          method: 'patch',
          path: `${list}/${wide.id}`,
          body: { kind: 'monitor' },
          ok: 200,
        },
        {
          name: 'remover fonte confiável de todos os balanceadores',
          method: 'delete',
          path: `${list}/${wide.id}`,
          ok: 204,
        },
      ];
    }
    const run = (as: TestSession, call: Call) =>
      call.method === 'get'
        ? get(as, call.path)
        : call.body === undefined
          ? write(as, call.method, call.path)
          : write(as, call.method, call.path).send(call.body);

    it.each(ROLES)('%s: todos leem, só administradores mudam', async (role) => {
      const admin = role === 'admin_cliente' || role === 'admin_verax';
      for (const path of ['/v1/web-logs/sources', '/v1/web-logs/trusted-sources']) {
        await get(session(role), path).expect(200);
      }
      for (const call of await calls(tenantA)) {
        const response = await run(session(role), call);
        expect(response.status, call.name).toBe(call.method === 'get' || admin ? call.ok : 403);
        if (call.method === 'get') continue;
        expect(await entryOf(response), call.name).toMatchObject({
          outcome: admin ? 'success' : 'denied',
          actorId: session(role).userId,
          tenantId: tenantA,
        });
      }
    });

    it('A não lê nem altera nada de B, em rota nenhuma', async () => {
      const ofB = await calls(tenantB);
      const snapshot = async () =>
        JSON.stringify(
          await Promise.all([
            prisma.awsSource
              .findMany({ where: { tenantId: tenantB }, orderBy: { id: 'asc' } })
              .then((rows) => rows.map((row) => ({ ...row, bytesLast24h: null }))),
            prisma.webSourceSettings.findMany({
              where: { tenantId: tenantB },
              orderBy: { sourceId: 'asc' },
            }),
            prisma.webSourceEstimate
              .findMany({ where: { tenantId: tenantB }, orderBy: { sourceId: 'asc' } })
              .then((rows) => rows.map((row) => ({ ...row, bytesPerDay: String(row.bytesPerDay) }))),
            prisma.webTrustedSource.findMany({ where: { tenantId: tenantB }, orderBy: { id: 'asc' } }),
            prisma.webRoute.findMany({ where: { tenantId: tenantB }, orderBy: { id: 'asc' } }),
          ]),
        );
      const before = await snapshot();
      const ids = [...before.matchAll(/"id":"([0-9a-f-]{36})"/g)].map((match) => match[1] ?? '');
      expect(ids.length).toBeGreaterThan(5);
      for (const as of [adminA, session('admin_verax')]) {
        for (const call of ofB) {
          const response = await run(as, call);
          expect(response.status, call.name).toBe(404);
        }
        for (const path of ['/v1/web-logs/sources', '/v1/web-logs/trusted-sources']) {
          const text = JSON.stringify((await get(as, path).expect(200)).body);
          for (const id of ids) expect(text).not.toContain(id);
        }
      }
      expect(await snapshot()).toBe(before);
      // B continua enxergando o que é dele.
      for (const call of ofB) expect((await run(adminB, call)).status, call.name).toBe(call.ok);
    });

    it('a equipe da Verax sem cliente escolhido não lê nada (409), e ninguém sem sessão (401)', async () => {
      const verax = await sessionFor(null, 'admin_verax');
      const cloud = await account(tenantA);
      const source = await balancer(cloud);
      for (const path of [
        '/v1/web-logs/sources',
        `/v1/web-logs/sources/${source.id}`,
        `/v1/web-logs/sources/${source.id}/routes`,
        '/v1/web-logs/trusted-sources',
      ]) {
        expect((await get(verax, path).expect(409)).body).toMatchObject({ code: 'TENANT_REQUIRED' });
        await request(app.getHttpServer()).get(path).expect(401);
      }
      await post(verax, '/v1/web-logs/trusted-sources').send(trustedBody()).expect(409);
    });

    it('identificador fora do formato e parâmetro a mais: 400', async () => {
      await get(adminA, '/v1/web-logs/sources/loja').expect(400);
      await get(adminA, '/v1/web-logs/sources?tenantId=x').expect(400);
      await write(adminA, 'delete', '/v1/web-logs/trusted-sources/1').expect(400);
      await post(adminA, `/v1/web-logs/sources/${randomUUID()}/estimate`)
        .send({ bytesPerDay: 1 })
        .expect(400);
    });
  });
});
