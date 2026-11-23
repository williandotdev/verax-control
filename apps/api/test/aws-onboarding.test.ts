import 'reflect-metadata';
import { randomInt, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  AWS_DISCOVERY_MANUAL_INTERVAL_MS,
  AWS_MAX_AUTHORIZED_LOG_GROUPS,
  AWS_ONBOARDING_CHECK_IDS,
  awsOnboardingSchema,
  cloudAccountSchema,
  type Role,
} from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncLegacyAwsSources } from '../src/aws/onboarding/legacy-sources.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { createSignedInUser, createTenant, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import type { TestSession } from './support/tenant-isolation.js';

const accountId = () => String(randomInt(100_000_000_000, 999_999_999_999));
const bucket = (prefix = 'trilha') => `${prefix}-${randomInt(1_000_000, 9_999_999)}`;
const MINUTE = 60_000;
const VERIFIED = new Date('2026-11-21T00:00:00.000Z');
const today = () => new Date().toISOString().slice(0, 10);

/**
 * As rotas do onboarding self-service da AWS, sem o "Conectar" (que fica em `aws-connect.test.ts`, junto da tarefa
 * `aws-check`: aquele arquivo confere os pedidos de verificação pendentes de todos os clientes). Aqui as contas já
 * nascem conectadas, direto no banco, e nenhum teste deixa pedido de verificação pendente.
 */
describe('onboarding self-service da AWS: estado, descoberta manual e autorização das fontes', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let adminA: TestSession & { userId: string };
  let adminB: TestSession & { userId: string };
  const sessions = new Map<Role, TestSession>();

  async function sessionFor(tenantId: string | null, role: Role) {
    const user = await createSignedInUser(app, { role, ...(tenantId !== null && { tenantId }) });
    const { cookie, token } = await withCsrf(app, user.cookie);
    return { cookie, csrfToken: token, userId: user.id };
  }
  const get = (session: TestSession, path: string) =>
    request(app.getHttpServer()).get(path).set('Cookie', session.cookie);
  const post = (session: TestSession, path: string) =>
    request(app.getHttpServer())
      .post(path)
      .set('Cookie', session.cookie)
      .set('Origin', TEST_WEB_ORIGIN)
      .set('X-CSRF-Token', session.csrfToken);
  const write = (session: TestSession, method: 'post' | 'patch' | 'delete', path: string) => {
    const agent = request(app.getHttpServer());
    return agent[method](path)
      .set('Cookie', session.cookie)
      .set('Origin', TEST_WEB_ORIGIN)
      .set('X-CSRF-Token', session.csrfToken);
  };
  const base = (id: string) => `/v1/cloud-accounts/${id}/aws`;
  const onboardingOf = async (session: TestSession, id: string) =>
    awsOnboardingSchema.parse((await get(session, `${base(id)}/onboarding`).expect(200)).body);
  const entryOf = (response: request.Response) =>
    prisma.auditLog.findFirstOrThrow({ where: { requestId: response.headers['x-request-id'] } });
  const sourceRow = (id: string) => prisma.awsSource.findUniqueOrThrow({ where: { id } });
  const runsOf = (id: string) =>
    prisma.awsDiscoveryRun.findMany({
      where: { cloudAccountId: id },
      orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
    });

  /** Uma conta AWS já verificada e conectada, com as tags do papel lidas (template v2). */
  function connectedAccount(tenantId: string, data: Partial<Prisma.CloudAccountUncheckedCreateInput> = {}) {
    return prisma.cloudAccount.create({
      data: {
        tenantId,
        provider: 'aws',
        accountId: accountId(),
        regions: ['sa-east-1'],
        connection: 'connected',
        ingestFrom: VERIFIED,
        awsTemplateVersion: 2,
        awsCapabilities: ['discovery', 'service-logs', 'findings', 'log-groups'],
        awsCapabilitiesCheckedAt: VERIFIED,
        ...data,
      },
    });
  }

  /** Uma descoberta já terminada (o que a tarefa aws-discovery grava). */
  function finishedRun(
    cloud: { id: string; tenantId: string },
    data: Partial<Prisma.AwsDiscoveryRunUncheckedCreateInput> = {},
  ) {
    const at = new Date(Date.now() - 60 * MINUTE);
    return prisma.awsDiscoveryRun.create({
      data: {
        tenantId: cloud.tenantId,
        cloudAccountId: cloud.id,
        trigger: 'connect',
        status: 'succeeded',
        requestedAt: at,
        startedAt: at,
        finishedAt: at,
        regions: ['sa-east-1', 'us-east-1'],
        ...data,
      },
    });
  }

  /** Uma fonte descoberta, disponível e com a permissão conferida (o que a tarefa aws-discovery grava). */
  function source(
    cloud: { id: string; tenantId: string },
    data: Partial<Prisma.AwsSourceUncheckedCreateInput> = {},
  ) {
    return prisma.awsSource.create({
      data: {
        tenantId: cloud.tenantId,
        cloudAccountId: cloud.id,
        kind: 'guardduty',
        region: 'sa-east-1',
        resourceId: `det-${randomInt(1e6, 9e6)}`,
        name: 'GuardDuty',
        details: { detectorId: 'det1' },
        method: 'api',
        availability: 'available',
        loggingState: 'enabled',
        permission: 'granted',
        permissionCheckedAt: VERIFIED,
        notes: ['recommended'],
        state: 'available',
        ...data,
      },
    });
  }
  const logGroup = (
    cloud: { id: string; tenantId: string },
    data: Partial<Prisma.AwsSourceUncheckedCreateInput> = {},
  ) =>
    source(cloud, {
      kind: 'cloudwatch_log_group',
      resourceId: `/app/${randomInt(1e6, 9e6)}`,
      name: '/app/api',
      details: { logGroup: '/app/api', tagged: true, category: 'other', destinationType: 'cloudwatch' },
      method: 'cloudwatch',
      loggingState: null,
      sensitive: true,
      notes: [],
      ...data,
    });

  /** Uma conta conectada, com a descoberta terminada. */
  async function discoveredAccount(
    tenantId: string,
    data: Partial<Prisma.CloudAccountUncheckedCreateInput> = {},
  ) {
    const cloud = await connectedAccount(tenantId, data);
    await finishedRun(cloud);
    return cloud;
  }

  beforeAll(async () => {
    app = await createApp({
      nodeEgressIps: '203.0.113.10/32',
      awsReader: { serviceAccountId: '123456789012345678901' },
    });
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente Demo A (onboarding AWS)');
    tenantB = await createTenant(app, 'Cliente Demo B (onboarding AWS)');
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

  describe('o estado da conta (GET …/aws/onboarding)', () => {
    it('conectada e sem descoberta: autenticada, com a descoberta por pedir', async () => {
      const cloud = await connectedAccount(tenantA);
      const onboarding = await onboardingOf(adminA, cloud.id);
      expect(onboarding).toMatchObject({
        cloudAccountId: cloud.id,
        state: 'authenticated',
        credentialMode: 'role',
        template: {
          version: 2,
          capabilities: ['discovery', 'service-logs', 'findings', 'log-groups'],
          outdated: false,
          checkedAt: VERIFIED.toISOString(),
        },
        discovery: { run: null, lastCompletedAt: null, regions: [] },
        infrastructure: null,
        sources: [],
      });
      expect(onboarding.checks.map((check) => check.id)).toEqual([...AWS_ONBOARDING_CHECK_IDS]);
      expect(
        Object.fromEntries(onboarding.checks.map((check) => [check.id, [check.status, check.code]])),
      ).toMatchObject({
        assume_role: ['ok', null],
        identity: ['ok', null],
        template: ['ok', null],
        discovery: ['pending', 'not_requested'],
        permission: ['skipped', null],
      });
    });

    it('depois da descoberta: aguardando a escolha das fontes, com o retrato, as regiões e cada fonte no contrato', async () => {
      const summary = {
        instances: 12,
        publicInstances: 3,
        securityGroups: 18,
        openSecurityGroups: 2,
        buckets: 4,
        publicBuckets: 1,
        iamUsers: 7,
        rootMfaEnabled: true,
        rdsInstances: 2,
        rdsPublic: 1,
        rdsUnencrypted: 0,
        rdsClusters: 0,
        loadBalancers: 3,
        internetFacingLoadBalancers: 2,
        vpcs: 2,
        webAcls: 1,
        logGroups: 40,
        trails: 1,
      };
      const cloud = await connectedAccount(tenantA, { awsDiscoveredRegions: ['sa-east-1'] });
      const run = await finishedRun(cloud, {
        status: 'partial',
        summary,
        errors: [
          { service: 'security_hub', region: 'us-east-1', code: 'AccessDeniedException' },
          // Um registro fora do contrato fica de fora da resposta, em vez de quebrá-la.
          { service: 'lambda', region: 'us-east-1', code: 'mensagem com espaço' },
        ],
      });
      const trail = await source(cloud, {
        kind: 'cloudtrail',
        resourceId: 'arn:aws:cloudtrail:sa-east-1:111111111111:trail/principal',
        name: 'principal',
        method: 's3',
        loggingState: 'logging',
        notes: [],
        details: {
          bucket: 'trilha-111111111111',
          prefix: 'AWSLogs/111111111111/CloudTrail/sa-east-1/',
          destinationType: 's3',
          multiRegion: true,
          organizationTrail: false,
        },
      });
      const denied = await source(cloud, {
        kind: 'security_hub',
        resourceId: 'hub',
        name: 'Security Hub',
        permission: 'missing',
        permissionDetail: 'securityhub:GetFindings',
        state: 'needs_permission',
        notes: [],
        details: {},
      });
      const off = await source(cloud, {
        kind: 'inspector',
        region: 'global',
        resourceId: 'none',
        name: 'inspector',
        availability: 'not_enabled',
        loggingState: 'disabled',
        permission: 'unknown',
        permissionCheckedAt: null,
        state: 'unavailable',
        stateCode: 'not_enabled',
        notes: ['aws_cost_inspector'],
        details: { regionsChecked: ['sa-east-1', 'us-east-1'] },
      });

      const onboarding = await onboardingOf(adminA, cloud.id);
      expect(onboarding).toMatchObject({
        state: 'awaiting_sources',
        discovery: {
          run: {
            id: run.id,
            trigger: 'connect',
            status: 'partial',
            regions: ['sa-east-1', 'us-east-1'],
            errors: [{ service: 'security_hub', region: 'us-east-1', code: 'AccessDeniedException' }],
            requestedBy: null,
          },
          lastCompletedAt: run.finishedAt?.toISOString(),
          regions: ['sa-east-1'],
        },
        infrastructure: summary,
      });
      expect(onboarding.checks.find((check) => check.id === 'discovery')).toMatchObject({
        status: 'ok',
        code: 'partial',
        checkedAt: run.finishedAt?.toISOString(),
      });
      const byId = Object.fromEntries(onboarding.sources.map((item) => [item.id, item]));
      expect(byId[trail.id]).toMatchObject({
        kind: 'cloudtrail',
        region: 'sa-east-1',
        name: 'principal',
        method: 's3',
        origin: 'discovered',
        collectable: true,
        sensitive: false,
        availability: 'available',
        loggingState: 'logging',
        permission: 'granted',
        permissionDetail: null,
        permissionCheckedAt: VERIFIED.toISOString(),
        probeRequestedAt: null,
        state: 'available',
        stateCode: null,
        authorization: { authorizedAt: null, authorizedBy: null, revokedAt: null },
        collectFrom: null,
        missingSince: null,
        // A saúde fica vazia até o coletor da fonte existir.
        health: {
          lastSyncAt: null,
          lastEventAt: null,
          lastIngestedAt: null,
          lagSeconds: null,
          eventsLast24h: null,
          bytesLast24h: null,
        },
        details: { bucket: 'trilha-111111111111', prefix: 'AWSLogs/111111111111/CloudTrail/sa-east-1/' },
      });
      expect(byId[denied.id]).toMatchObject({
        state: 'needs_permission',
        permission: 'missing',
        permissionDetail: 'securityhub:GetFindings',
      });
      expect(byId[off.id]).toMatchObject({
        region: 'global',
        availability: 'not_enabled',
        state: 'unavailable',
        stateCode: 'not_enabled',
        notes: ['aws_cost_inspector'],
      });
      // Nenhum dado interno na resposta: nem o cliente, nem nada que não esteja no contrato estrito.
      const raw = await get(adminA, `${base(cloud.id)}/onboarding`).expect(200);
      expect(raw.text).not.toContain(tenantA);
      // Quem só lê vê o mesmo.
      expect((await onboardingOf(sessions.get('leitura') as TestSession, cloud.id)).sources).toHaveLength(3);
      expect((await onboardingOf(sessions.get('analista_cliente') as TestSession, cloud.id)).state).toBe(
        'awaiting_sources',
      );
    });

    it('os detalhes fora do contrato no banco saem vazios, e uma nota desconhecida fica de fora', async () => {
      const cloud = await discoveredAccount(tenantA);
      // As notas do banco são as do contrato (o CHECK garante); só os detalhes podem estar fora dele.
      const odd = await source(cloud, {
        details: { bucket: 'trilha-1', segredo: 'x' },
        notes: ['recommended'],
      });
      const [item] = (await onboardingOf(adminA, cloud.id)).sources;
      expect(item).toMatchObject({ id: odd.id, details: {}, notes: ['recommended'] });
    });

    it('conta de outro provedor: 400; sem sessão: 401', async () => {
      const gcp = cloudAccountSchema.parse(
        (
          await post(adminA, '/v1/cloud-accounts')
            .send({ provider: 'gcp', accountId: `vx-${randomInt(1_000_000, 9_999_999)}-onb` })
            .expect(201)
        ).body,
      );
      await get(adminA, `${base(gcp.id)}/onboarding`).expect(400);
      await post(adminA, `${base(gcp.id)}/discovery`).expect(400);
      await request(app.getHttpServer())
        .get(`${base(gcp.id)}/onboarding`)
        .expect(401);
      await get(adminA, `${base('nao-e-uuid')}/onboarding`).expect(400);
      await get(adminA, `${base(randomUUID())}/onboarding`).expect(404);
    });
  });

  describe('descoberta manual (POST …/aws/discovery)', () => {
    it('grava o pedido com quem pediu (202); com um pendente, não cria outro; auditado', async () => {
      const cloud = await connectedAccount(tenantA);
      const first = await post(adminA, `${base(cloud.id)}/discovery`).expect(202);
      const onboarding = awsOnboardingSchema.parse(first.body);
      expect(onboarding).toMatchObject({
        state: 'discovering',
        discovery: { run: { trigger: 'manual', status: 'pending', requestedBy: adminA.userId } },
      });
      const [run] = await runsOf(cloud.id);
      expect(run).toMatchObject({
        tenantId: tenantA,
        trigger: 'manual',
        status: 'pending',
        requestedBy: adminA.userId,
      });
      expect(await entryOf(first)).toMatchObject({
        action: 'cloud_account.aws_discovery_request',
        outcome: 'success',
        actorId: adminA.userId,
        tenantId: tenantA,
        resourceType: 'cloud_account',
        resourceId: cloud.id,
        after: { runId: run?.id, trigger: 'manual', status: 'pending', created: true },
      });

      // Clicar de novo mostra a mesma execução, sem criar outra.
      const again = awsOnboardingSchema.parse(
        (await post(adminA, `${base(cloud.id)}/discovery`).expect(202)).body,
      );
      expect(again.discovery.run?.id).toBe(run?.id);
      expect(await runsOf(cloud.id)).toHaveLength(1);
      expect(await entryOf(await post(adminA, `${base(cloud.id)}/discovery`).expect(202))).toMatchObject({
        after: { runId: run?.id, created: false },
      });
    });

    it('no máximo uma descoberta manual a cada 5 min por conta (429); a automática não conta', async () => {
      const cloud = await connectedAccount(tenantA);
      const recent = new Date(Date.now() - MINUTE);
      await finishedRun(cloud, {
        trigger: 'manual',
        requestedAt: recent,
        startedAt: recent,
        finishedAt: recent,
      });
      const limited = await post(adminA, `${base(cloud.id)}/discovery`).expect(429);
      expect(limited.body).toMatchObject({ code: 'DISCOVERY_RATE_LIMITED' });
      expect(await runsOf(cloud.id)).toHaveLength(1);
      expect(await entryOf(limited)).toMatchObject({
        action: 'cloud_account.aws_discovery_request',
        outcome: 'failure',
        statusCode: 429,
      });

      // Passados os 5 min, vale de novo.
      await prisma.awsDiscoveryRun.updateMany({
        where: { cloudAccountId: cloud.id },
        data: { requestedAt: new Date(Date.now() - AWS_DISCOVERY_MANUAL_INTERVAL_MS - MINUTE) },
      });
      await post(adminA, `${base(cloud.id)}/discovery`).expect(202);
      expect(await runsOf(cloud.id)).toHaveLength(2);

      // Uma descoberta automática de agora há pouco não impede a manual.
      const other = await connectedAccount(tenantA);
      await finishedRun(other, {
        trigger: 'scheduled',
        requestedAt: recent,
        startedAt: recent,
        finishedAt: recent,
      });
      await post(adminA, `${base(other.id)}/discovery`).expect(202);
    });

    it('só na conta em que o nó entra no papel: 409 ACCOUNT_NOT_CONNECTED; inativa, 400', async () => {
      const cases: Partial<Prisma.CloudAccountUncheckedCreateInput>[] = [
        { connection: 'waiting' },
        { connection: 'error', connectionError: 'trust_denied' },
        { connection: 'error', connectionError: 'authorization_timeout' },
        { ingestFrom: null },
      ];
      for (const data of cases) {
        const cloud = await connectedAccount(tenantA, data);
        expect((await post(adminA, `${base(cloud.id)}/discovery`).expect(409)).body).toMatchObject({
          code: 'ACCOUNT_NOT_CONNECTED',
        });
        expect(await runsOf(cloud.id)).toEqual([]);
      }
      // Com erro só num bucket cadastrado, o nó entra no papel: a descoberta vale.
      const bucketError = await connectedAccount(tenantA, {
        connection: 'error',
        connectionError: 'kms_denied:waf',
      });
      await post(adminA, `${base(bucketError.id)}/discovery`).expect(202);
      const inactive = await connectedAccount(tenantA, { status: 'inactive', connection: 'waiting' });
      await post(adminA, `${base(inactive.id)}/discovery`).expect(400);
    });

    it('papéis: só administradores pedem a descoberta; analista e leitura, 403, sem gravar', async () => {
      const expected: Record<Role, number> = {
        admin_verax: 202,
        admin_cliente: 202,
        analista_cliente: 403,
        leitura: 403,
      };
      for (const [role, status] of Object.entries(expected) as [Role, number][]) {
        const cloud = await connectedAccount(tenantA);
        await post(sessions.get(role) as TestSession, `${base(cloud.id)}/discovery`).expect(status);
        expect((await runsOf(cloud.id)).length).toBe(status === 202 ? 1 : 0);
      }
    });

    it('a rota não aceita corpo nem query', async () => {
      const cloud = await connectedAccount(tenantA);
      await post(adminA, `${base(cloud.id)}/discovery`)
        .send({ regions: ['sa-east-1'] })
        .expect(400);
      await post(adminA, `${base(cloud.id)}/discovery?force=1`).expect(400);
      expect(await runsOf(cloud.id)).toEqual([]);
    });
  });

  describe('autorizar fontes (POST …/aws/sources/authorize)', () => {
    it('autoriza as fontes citadas: a coleta começa hoje, com quem autorizou, e a conta passa a "configurando"', async () => {
      const cloud = await discoveredAccount(tenantA);
      const detector = await source(cloud);
      const trail = await source(cloud, {
        kind: 'cloudtrail',
        resourceId: 'arn:aws:cloudtrail:sa-east-1:111111111111:trail/a',
        name: 'principal',
        method: 's3',
        notes: [],
        details: { bucket: 'trilha-1', prefix: 'AWSLogs/111111111111/CloudTrail/sa-east-1/' },
      });
      const untouched = await source(cloud, {
        kind: 'security_hub',
        resourceId: 'hub',
        name: 'Security Hub',
        notes: [],
      });
      const before = Date.now();

      const response = await post(adminA, `${base(cloud.id)}/sources/authorize`)
        .send({ sourceIds: [detector.id, trail.id] })
        .expect(200);
      const onboarding = awsOnboardingSchema.parse(response.body);
      // Honesto: autorizada, mas ainda sem coletor lendo. Nunca "coletando" antes de haver coleta.
      expect(onboarding.state).toBe('configuring');
      expect(
        Object.fromEntries(onboarding.checks.map((check) => [check.id, [check.status, check.code]])),
      ).toMatchObject({
        permission: ['ok', null],
        collector_config: ['pending', 'awaiting_collector'],
        events: ['pending', 'awaiting_collector'],
        last_sync: ['pending', 'no_data'],
        lag: ['pending', 'no_data'],
      });
      for (const id of [detector.id, trail.id]) {
        const row = await sourceRow(id);
        expect(row).toMatchObject({
          state: 'authorized',
          stateCode: 'awaiting_collector',
          authorizedBy: adminA.userId,
          revokedAt: null,
          // A saúde continua vazia: quem a grava é o coletor.
          lastSyncAt: null,
          lastEventAt: null,
        });
        expect(row.authorizedAt?.getTime()).toBeGreaterThanOrEqual(before);
        // Sem histórico: a coleta começa no dia da autorização (UTC).
        expect(row.collectFrom?.toISOString().slice(0, 10)).toBe(today());
        expect(onboarding.sources.find((item) => item.id === id)).toMatchObject({
          state: 'authorized',
          stateCode: 'awaiting_collector',
          collectFrom: today(),
          authorization: { authorizedBy: adminA.userId, revokedAt: null },
        });
      }
      expect(await sourceRow(untouched.id)).toEqual(untouched);

      const entry = await entryOf(response);
      expect(entry).toMatchObject({
        action: 'cloud_account.aws_source_authorized',
        outcome: 'success',
        actorId: adminA.userId,
        tenantId: tenantA,
        resourceType: 'cloud_account',
        resourceId: cloud.id,
      });
      const beforeState = entry.before as { id: string; state: string }[];
      const afterState = entry.after as {
        id: string;
        state: string;
        authorizedBy: string;
        collectFrom: string;
      }[];
      expect(beforeState.map((item) => [item.id, item.state]).sort()).toEqual(
        [
          [detector.id, 'available'],
          [trail.id, 'available'],
        ].sort(),
      );
      for (const item of afterState) {
        expect(item).toMatchObject({
          state: 'authorized',
          authorizedBy: adminA.userId,
          collectFrom: today(),
        });
      }

      // Autorizar de novo não muda nada: nem a data, nem quem autorizou.
      const first = await sourceRow(detector.id);
      await post(sessions.get('admin_verax') as TestSession, `${base(cloud.id)}/sources/authorize`)
        .send({ sourceIds: [detector.id] })
        .expect(200);
      expect(await sourceRow(detector.id)).toMatchObject({
        authorizedAt: first.authorizedAt,
        authorizedBy: adminA.userId,
      });
    });

    it('tudo ou nada: uma fonte recusada recusa o pedido inteiro, com o código do motivo', async () => {
      const cloud = await discoveredAccount(tenantA, { cloudtrailBucket: bucket() });
      const good = await source(cloud);
      const refused: [Partial<Prisma.AwsSourceUncheckedCreateInput>, string][] = [
        [
          { permission: 'missing', permissionDetail: 'guardduty:ListFindings', state: 'needs_permission' },
          'SOURCE_PERMISSION_MISSING',
        ],
        [{ permission: 'unknown', state: 'needs_permission' }, 'SOURCE_PERMISSION_MISSING'],
        [
          {
            availability: 'not_enabled',
            state: 'unavailable',
            stateCode: 'not_enabled',
            permission: 'unknown',
          },
          'SOURCE_NOT_AVAILABLE',
        ],
        [
          { kind: 'waf', method: 's3', availability: 'unsupported_destination', state: 'unavailable' },
          'SOURCE_NOT_AVAILABLE',
        ],
        [
          { kind: 'vpc_flow_logs', method: 's3', availability: 'unsupported_format', state: 'unavailable' },
          'SOURCE_NOT_AVAILABLE',
        ],
        // A fonte que a descoberta não acha mais.
        [{ missingSince: VERIFIED }, 'SOURCE_NOT_AVAILABLE'],
        [
          {
            kind: 'config',
            method: 's3',
            state: 'unavailable',
            stateCode: 'not_collectable_yet',
            notes: ['not_collected_yet'],
          },
          'SOURCE_NOT_COLLECTABLE',
        ],
        [
          { kind: 'elb_logs', method: 's3', state: 'unavailable', notes: ['not_collected_yet'] },
          'SOURCE_NOT_COLLECTABLE',
        ],
        // A trilha que grava no bucket já lido pelo cadastro: autorizar duplicaria a coleta.
        [{ kind: 'cloudtrail', method: 's3', notes: ['covered_by_legacy'] }, 'SOURCE_COVERED_BY_LEGACY'],
      ];
      for (const [data, code] of refused) {
        const bad = await source(cloud, { notes: [], details: {}, ...data });
        const response = await post(adminA, `${base(cloud.id)}/sources/authorize`)
          .send({ sourceIds: [good.id, bad.id] })
          .expect(409);
        expect(response.body, code).toMatchObject({ code });
        // Nem a fonte boa do mesmo pedido foi autorizada.
        expect(await sourceRow(good.id)).toEqual(good);
        expect(await sourceRow(bad.id)).toEqual(bad);
        expect(await entryOf(response)).toMatchObject({
          action: 'cloud_account.aws_source_authorized',
          outcome: 'failure',
          statusCode: 409,
        });
      }
    });

    it('a linha de um bucket do cadastro não é autorizada nem revogada por aqui: muda no cadastro (409 SOURCE_LEGACY)', async () => {
      const created = cloudAccountSchema.parse(
        (
          await post(adminA, '/v1/cloud-accounts')
            .send({
              provider: 'aws',
              accountId: accountId(),
              regions: ['sa-east-1'],
              buckets: { cloudtrail: bucket() },
            })
            .expect(201)
        ).body,
      );
      const [legacy] = await prisma.awsSource.findMany({ where: { cloudAccountId: created.id } });
      if (!legacy) throw new Error('a linha do bucket não foi criada');
      for (const path of ['sources/authorize', `sources/${legacy.id}/revoke`, `sources/${legacy.id}/retry`]) {
        const call = post(adminA, `${base(created.id)}/${path}`);
        const response = await (
          path === 'sources/authorize' ? call.send({ sourceIds: [legacy.id] }) : call
        ).expect(409);
        expect(response.body, path).toMatchObject({ code: 'SOURCE_LEGACY' });
      }
      expect(await sourceRow(legacy.id)).toEqual(legacy);
    });

    it('fonte sensível (grupo do CloudWatch Logs): só entra confirmada, uma a uma; "autorizar tudo" é recusado inteiro', async () => {
      const cloud = await discoveredAccount(tenantA);
      const detector = await source(cloud);
      const groupA = await logGroup(cloud);
      const groupB = await logGroup(cloud);

      // Um "autorizar tudo" manda só os IDs: com uma fonte sensível na lista, nada é autorizado.
      const all = await post(adminA, `${base(cloud.id)}/sources/authorize`)
        .send({ sourceIds: [detector.id, groupA.id, groupB.id] })
        .expect(400);
      expect(all.body).toMatchObject({ code: 'SENSITIVE_CONFIRMATION_REQUIRED' });
      // Confirmar um grupo não confirma o outro.
      expect(
        (
          await post(adminA, `${base(cloud.id)}/sources/authorize`)
            .send({ sourceIds: [groupA.id, groupB.id], sensitiveSourceIds: [groupA.id] })
            .expect(400)
        ).body,
      ).toMatchObject({ code: 'SENSITIVE_CONFIRMATION_REQUIRED' });
      for (const row of [detector, groupA, groupB]) expect(await sourceRow(row.id)).toEqual(row);

      await post(adminA, `${base(cloud.id)}/sources/authorize`)
        .send({ sourceIds: [detector.id, groupA.id], sensitiveSourceIds: [groupA.id] })
        .expect(200);
      expect(await sourceRow(groupA.id)).toMatchObject({ state: 'authorized', authorizedBy: adminA.userId });
      expect(await sourceRow(groupB.id)).toEqual(groupB);
    });

    it('o pedido é estrito: sem lista, lista vazia, ID repetido, campo a mais, "all" e confirmação fora do pedido dão 400', async () => {
      const cloud = await discoveredAccount(tenantA);
      const detector = await source(cloud);
      for (const body of [
        {},
        { sourceIds: [] },
        { sourceIds: [detector.id, detector.id] },
        { sourceIds: 'all' },
        { all: true },
        { sourceIds: [detector.id], all: true },
        { sourceIds: [detector.id], tenantId: tenantB },
        { sourceIds: [detector.id], collectFrom: '2020-01-01' },
        { sourceIds: [detector.id], sensitiveSourceIds: [randomUUID()] },
        { sourceIds: ['fonte-1'] },
      ]) {
        await post(adminA, `${base(cloud.id)}/sources/authorize`)
          .send(body)
          .expect(400);
      }
      expect(await sourceRow(detector.id)).toEqual(detector);
    });

    it('o teto de grupos do CloudWatch Logs autorizados por conta', async () => {
      const cloud = await discoveredAccount(tenantA);
      await prisma.awsSource.createMany({
        data: Array.from({ length: AWS_MAX_AUTHORIZED_LOG_GROUPS - 1 }, (_, index) => ({
          tenantId: tenantA,
          cloudAccountId: cloud.id,
          kind: 'cloudwatch_log_group',
          region: 'sa-east-1',
          resourceId: `/app/autorizado-${index}`,
          name: `/app/autorizado-${index}`,
          method: 'cloudwatch',
          availability: 'available',
          permission: 'granted',
          sensitive: true,
          authorizedAt: VERIFIED,
          authorizedBy: adminA.userId,
          collectFrom: VERIFIED,
          state: 'authorized',
          stateCode: 'awaiting_collector',
        })),
      });
      const [first, second] = [await logGroup(cloud), await logGroup(cloud)];
      // Dois de uma vez passariam do teto: nenhum entra.
      expect(
        (
          await post(adminA, `${base(cloud.id)}/sources/authorize`)
            .send({ sourceIds: [first.id, second.id], sensitiveSourceIds: [first.id, second.id] })
            .expect(409)
        ).body,
      ).toMatchObject({ code: 'SOURCE_LIMIT_REACHED' });
      expect(await sourceRow(first.id)).toEqual(first);
      // O último que cabe entra; o seguinte, não. Uma fonte de outro método não conta nesse teto.
      await post(adminA, `${base(cloud.id)}/sources/authorize`)
        .send({ sourceIds: [first.id], sensitiveSourceIds: [first.id] })
        .expect(200);
      await post(adminA, `${base(cloud.id)}/sources/authorize`)
        .send({ sourceIds: [second.id], sensitiveSourceIds: [second.id] })
        .expect(409);
      const detector = await source(cloud);
      await post(adminA, `${base(cloud.id)}/sources/authorize`)
        .send({ sourceIds: [detector.id] })
        .expect(200);
    });

    it('conta inativa: 400; fonte que não existe, ou de outra conta do mesmo cliente: 404, sem autorizar nada', async () => {
      const cloud = await discoveredAccount(tenantA);
      const other = await discoveredAccount(tenantA);
      const mine = await source(cloud);
      const theirs = await source(other);
      await post(adminA, `${base(cloud.id)}/sources/authorize`)
        .send({ sourceIds: [mine.id, randomUUID()] })
        .expect(404);
      await post(adminA, `${base(cloud.id)}/sources/authorize`)
        .send({ sourceIds: [mine.id, theirs.id] })
        .expect(404);
      expect(await sourceRow(mine.id)).toEqual(mine);
      expect(await sourceRow(theirs.id)).toEqual(theirs);
      const inactive = await discoveredAccount(tenantA, { status: 'inactive', connection: 'waiting' });
      const idle = await source(inactive);
      await post(adminA, `${base(inactive.id)}/sources/authorize`)
        .send({ sourceIds: [idle.id] })
        .expect(400);
    });

    it('a conta que a Verax cadastrou pelo console: as fontes e a autorização são do cliente', async () => {
      const cloud = await discoveredAccount(tenantA, { origin: 'control_plane', controlPlaneRevision: 3 });
      const detector = await source(cloud);
      // O cadastro continua do console.
      expect(
        (
          await write(adminA, 'patch', `/v1/cloud-accounts/${cloud.id}`)
            .send({ regions: ['us-east-1'] })
            .expect(409)
        ).body,
      ).toMatchObject({
        code: 'CONSOLE_MANAGED',
      });
      await post(adminA, `${base(cloud.id)}/sources/authorize`)
        .send({ sourceIds: [detector.id] })
        .expect(200);
      await post(adminA, `${base(cloud.id)}/sources/${detector.id}/revoke`).expect(200);
      await post(adminA, `${base(cloud.id)}/discovery`).expect(202);
      expect(await sourceRow(detector.id)).toMatchObject({ state: 'revoked', authorizedBy: adminA.userId });
    });

    it('papéis: só administradores autorizam, revogam e pedem a sondagem; analista e leitura, 403, com a recusa na trilha', async () => {
      const cloud = await discoveredAccount(tenantA);
      const detector = await source(cloud);
      for (const role of ['analista_cliente', 'leitura'] as const) {
        const session = sessions.get(role) as TestSession;
        const denied = await post(session, `${base(cloud.id)}/sources/authorize`)
          .send({ sourceIds: [detector.id] })
          .expect(403);
        await post(session, `${base(cloud.id)}/sources/${detector.id}/revoke`).expect(403);
        await post(session, `${base(cloud.id)}/sources/${detector.id}/retry`).expect(403);
        expect(await entryOf(denied)).toMatchObject({
          outcome: 'denied',
          statusCode: 403,
          tenantId: tenantA,
        });
      }
      expect(await sourceRow(detector.id)).toEqual(detector);
    });
  });

  describe('desautorizar (POST …/aws/sources/:sourceId/revoke)', () => {
    it('tira a fonte da coleta e guarda quem tinha autorizado; depois, ela pode ser autorizada de novo', async () => {
      const cloud = await discoveredAccount(tenantA);
      const detector = await source(cloud);
      const other = await source(cloud, {
        kind: 'security_hub',
        resourceId: 'hub',
        name: 'Security Hub',
        notes: [],
      });
      await post(adminA, `${base(cloud.id)}/sources/authorize`)
        .send({ sourceIds: [detector.id, other.id] })
        .expect(200);
      const authorized = await sourceRow(detector.id);

      const response = await post(adminA, `${base(cloud.id)}/sources/${detector.id}/revoke`).expect(200);
      const onboarding = awsOnboardingSchema.parse(response.body);
      const revoked = await sourceRow(detector.id);
      expect(revoked).toMatchObject({
        state: 'revoked',
        stateCode: null,
        authorizedAt: authorized.authorizedAt,
        authorizedBy: adminA.userId,
      });
      expect(revoked.revokedAt).not.toBeNull();
      expect(onboarding.sources.find((item) => item.id === detector.id)).toMatchObject({
        state: 'revoked',
        authorization: { authorizedBy: adminA.userId, revokedAt: revoked.revokedAt?.toISOString() },
      });
      // A outra fonte continua autorizada: a conta segue configurando.
      expect(onboarding.state).toBe('configuring');
      expect(await entryOf(response)).toMatchObject({
        action: 'cloud_account.aws_source_revoked',
        outcome: 'success',
        actorId: adminA.userId,
        tenantId: tenantA,
        resourceId: cloud.id,
        before: { id: detector.id, state: 'authorized', revokedAt: null },
        after: { id: detector.id, state: 'revoked' },
      });

      // Revogar de novo: não há o que revogar.
      expect(
        (await post(adminA, `${base(cloud.id)}/sources/${detector.id}/revoke`).expect(409)).body,
      ).toMatchObject({
        code: 'SOURCE_NOT_AUTHORIZED',
      });
      // Sem nenhuma fonte autorizada, a conta volta a aguardar a escolha.
      const last = awsOnboardingSchema.parse(
        (await post(adminA, `${base(cloud.id)}/sources/${other.id}/revoke`).expect(200)).body,
      );
      expect(last.state).toBe('awaiting_sources');

      // Autorizar de novo: outra autorização, com a coleta a partir de hoje.
      await post(sessions.get('admin_verax') as TestSession, `${base(cloud.id)}/sources/authorize`)
        .send({ sourceIds: [detector.id] })
        .expect(200);
      const again = await sourceRow(detector.id);
      expect(again).toMatchObject({ state: 'authorized', revokedAt: null });
      expect(again.authorizedBy).not.toBe(adminA.userId);
      expect(again.collectFrom?.toISOString().slice(0, 10)).toBe(today());
    });

    it('a fonte nunca autorizada: 409; a que sumiu ainda autorizada pode ser revogada; a que não existe: 404', async () => {
      const cloud = await discoveredAccount(tenantA);
      const idle = await source(cloud);
      expect(
        (await post(adminA, `${base(cloud.id)}/sources/${idle.id}/revoke`).expect(409)).body,
      ).toMatchObject({
        code: 'SOURCE_NOT_AUTHORIZED',
      });
      const missing = await source(cloud, {
        authorizedAt: VERIFIED,
        authorizedBy: adminA.userId,
        collectFrom: VERIFIED,
        state: 'source_missing',
        stateCode: 'not_found',
        missingSince: VERIFIED,
      });
      await post(adminA, `${base(cloud.id)}/sources/${missing.id}/revoke`).expect(200);
      expect(await sourceRow(missing.id)).toMatchObject({ state: 'revoked', missingSince: VERIFIED });
      await post(adminA, `${base(cloud.id)}/sources/${randomUUID()}/revoke`).expect(404);
      await post(adminA, `${base(cloud.id)}/sources/nao-e-uuid/revoke`).expect(400);
    });

    it('a conta desativada ainda deixa desautorizar (tirar uma fonte nunca é bloqueado)', async () => {
      const cloud = await discoveredAccount(tenantA, { status: 'inactive', connection: 'waiting' });
      const detector = await source(cloud, {
        authorizedAt: VERIFIED,
        authorizedBy: adminA.userId,
        collectFrom: VERIFIED,
        state: 'authorized',
        stateCode: 'awaiting_collector',
      });
      await post(adminA, `${base(cloud.id)}/sources/${detector.id}/revoke`).expect(200);
      expect((await sourceRow(detector.id)).state).toBe('revoked');
    });
  });

  describe('"tentar de novo" numa fonte (POST …/aws/sources/:sourceId/retry)', () => {
    it('grava o pedido da sondagem (202); um pedido pendente não é renovado; auditado', async () => {
      const cloud = await discoveredAccount(tenantA);
      const denied = await logGroup(cloud, {
        permission: 'missing',
        permissionDetail: 'tag_missing',
        state: 'needs_permission',
        details: { logGroup: '/app/api', tagged: false },
        notes: ['tag_required'],
      });
      const response = await post(adminA, `${base(cloud.id)}/sources/${denied.id}/retry`).expect(202);
      const requestedAt = (await sourceRow(denied.id)).probeRequestedAt;
      expect(requestedAt).not.toBeNull();
      expect(
        awsOnboardingSchema.parse(response.body).sources.find((item) => item.id === denied.id),
      ).toMatchObject({
        probeRequestedAt: requestedAt?.toISOString(),
        // A permissão só muda quando o worker responde.
        permission: 'missing',
        permissionDetail: 'tag_missing',
        state: 'needs_permission',
      });
      expect(await entryOf(response)).toMatchObject({
        action: 'cloud_account.aws_source_retry',
        outcome: 'success',
        actorId: adminA.userId,
        tenantId: tenantA,
        resourceId: cloud.id,
        before: { id: denied.id, probeRequestedAt: null },
        after: { id: denied.id, probeRequestedAt: requestedAt?.toISOString() },
      });
      await post(adminA, `${base(cloud.id)}/sources/${denied.id}/retry`).expect(202);
      expect((await sourceRow(denied.id)).probeRequestedAt).toEqual(requestedAt);
    });

    it('só na conta em que o nó entra no papel (409); inativa, 400; fonte que não existe, 404', async () => {
      const refused = await discoveredAccount(tenantA, {
        connection: 'error',
        connectionError: 'trust_denied',
      });
      const row = await source(refused);
      expect(
        (await post(adminA, `${base(refused.id)}/sources/${row.id}/retry`).expect(409)).body,
      ).toMatchObject({
        code: 'ACCOUNT_NOT_CONNECTED',
      });
      expect((await sourceRow(row.id)).probeRequestedAt).toBeNull();
      const inactive = await discoveredAccount(tenantA, { status: 'inactive', connection: 'waiting' });
      const idle = await source(inactive);
      await post(adminA, `${base(inactive.id)}/sources/${idle.id}/retry`).expect(400);
      const cloud = await discoveredAccount(tenantA);
      await post(adminA, `${base(cloud.id)}/sources/${randomUUID()}/retry`).expect(404);
    });
  });

  describe('isolamento entre clientes', () => {
    it('A não lê, não descobre, não autoriza, não revoga e não sonda nada de B: 404, e nada muda', async () => {
      const ofB = await discoveredAccount(tenantB);
      const idle = await source(ofB);
      const authorized = await source(ofB, {
        kind: 'security_hub',
        resourceId: 'hub',
        name: 'Security Hub',
        authorizedAt: VERIFIED,
        authorizedBy: adminB.userId,
        collectFrom: VERIFIED,
        state: 'authorized',
        stateCode: 'awaiting_collector',
      });
      const runsBefore = await runsOf(ofB.id);

      await get(adminA, `${base(ofB.id)}/onboarding`).expect(404);
      const attempts = [
        await post(adminA, `${base(ofB.id)}/connect`).expect(404),
        await post(adminA, `${base(ofB.id)}/discovery`).expect(404),
        await post(adminA, `${base(ofB.id)}/sources/authorize`)
          .send({ sourceIds: [idle.id] })
          .expect(404),
        await post(adminA, `${base(ofB.id)}/sources/${authorized.id}/revoke`).expect(404),
        await post(adminA, `${base(ofB.id)}/sources/${idle.id}/retry`).expect(404),
      ];
      for (const attempt of attempts) {
        // A tentativa entra na trilha de A, como falha, sem citar nada de B além do que A mesmo mandou.
        expect(await entryOf(attempt)).toMatchObject({
          outcome: 'failure',
          statusCode: 404,
          tenantId: tenantA,
        });
      }
      expect(await sourceRow(idle.id)).toEqual(idle);
      expect(await sourceRow(authorized.id)).toEqual(authorized);
      expect(await runsOf(ofB.id)).toEqual(runsBefore);

      // Com uma conta própria, A também não alcança a fonte de B pelo ID dela.
      const ofA = await discoveredAccount(tenantA);
      const mine = await source(ofA);
      await post(adminA, `${base(ofA.id)}/sources/authorize`)
        .send({ sourceIds: [mine.id, idle.id] })
        .expect(404);
      await post(adminA, `${base(ofA.id)}/sources/${authorized.id}/revoke`).expect(404);
      await post(adminA, `${base(ofA.id)}/sources/${idle.id}/retry`).expect(404);
      expect(await sourceRow(mine.id)).toEqual(mine);
      expect(await sourceRow(idle.id)).toEqual(idle);
      expect(await sourceRow(authorized.id)).toEqual(authorized);
      const seen = await get(adminA, `${base(ofA.id)}/onboarding`).expect(200);
      expect(seen.text).not.toContain(idle.id);
      expect(seen.text).not.toContain(authorized.id);
      expect(seen.text).not.toContain(ofB.accountId);

      // B continua enxergando e operando o que é dele.
      const own = await onboardingOf(adminB, ofB.id);
      expect(own.sources.map((item) => item.id).sort()).toEqual([idle.id, authorized.id].sort());
      await post(adminB, `${base(ofB.id)}/sources/authorize`)
        .send({ sourceIds: [idle.id] })
        .expect(200);
      const trail = await prisma.auditLog.findMany({
        where: { action: 'cloud_account.aws_source_authorized', resourceId: ofB.id, outcome: 'success' },
      });
      expect(trail.map((entry) => entry.tenantId)).toEqual([tenantB]);
    });

    it('o admin_verax opera só no cliente selecionado', async () => {
      const ofB = await discoveredAccount(tenantB);
      const verax = sessions.get('admin_verax') as TestSession;
      await get(verax, `${base(ofB.id)}/onboarding`).expect(404);
      await post(verax, `${base(ofB.id)}/discovery`).expect(404);
      expect(await runsOf(ofB.id)).toHaveLength(1);
    });
  });

  describe('os buckets do cadastro como fontes (o espelho das colunas da conta)', () => {
    const legacyOf = async (cloudAccountId: string) =>
      Object.fromEntries(
        (await prisma.awsSource.findMany({ where: { cloudAccountId, origin: 'legacy' } })).map((row) => [
          row.kind,
          row,
        ]),
      );
    async function panelAccount(buckets: object = {}) {
      const created = await post(adminA, '/v1/cloud-accounts')
        .send({ provider: 'aws', accountId: accountId(), regions: ['sa-east-1'], buckets })
        .expect(201);
      return cloudAccountSchema.parse(created.body);
    }

    it('cadastrar a conta com buckets cria uma fonte autorizada por bucket, ainda sem data de início', async () => {
      const trail = bucket();
      const waf = `aws-waf-logs-${randomInt(1_000_000, 9_999_999)}`;
      // O mesmo bucket em duas fontes do cadastro: duas linhas, uma por tipo.
      const cloud = await panelAccount({ cloudtrail: trail, guardduty: trail, waf });
      const rows = await legacyOf(cloud.id);
      expect(Object.keys(rows).sort()).toEqual(['cloudtrail', 'guardduty_export', 'waf']);
      expect(rows['cloudtrail']).toMatchObject({
        tenantId: tenantA,
        region: 'global',
        resourceId: 'legacy',
        name: trail,
        details: { bucket: trail, legacySource: 'cloudtrail' },
        method: 's3',
        availability: 'available',
        permission: 'unknown',
        origin: 'legacy',
        state: 'authorized',
        stateCode: 'awaiting_collector',
        authorizedBy: null,
        revokedAt: null,
        // A conta ainda não foi verificada: a data de início chega com o `ingestFrom`.
        collectFrom: null,
      });
      expect(rows['cloudtrail']?.authorizedAt).not.toBeNull();
      expect(rows['guardduty_export']).toMatchObject({
        name: trail,
        details: { bucket: trail, legacySource: 'guardduty' },
      });
      expect(rows['waf']).toMatchObject({ name: waf, details: { bucket: waf, legacySource: 'waf' } });

      // Na tela: as três, autorizadas, com a permissão ainda por conferir (a conta não foi verificada).
      const onboarding = await onboardingOf(adminA, cloud.id);
      expect(onboarding.state).toBe('not_started');
      expect(
        onboarding.sources.map((item) => [item.kind, item.origin, item.state, item.permission]).sort(),
      ).toEqual(
        [
          ['cloudtrail', 'legacy', 'authorized', 'unknown'],
          ['guardduty_export', 'legacy', 'authorized', 'unknown'],
          ['waf', 'legacy', 'authorized', 'unknown'],
        ].sort(),
      );
    });

    it('trocar, tirar e pôr um bucket no cadastro deixa as fontes iguais às colunas', async () => {
      const first = bucket();
      const cloud = await panelAccount({ cloudtrail: first });
      const original = (await legacyOf(cloud.id))['cloudtrail'];
      if (!original) throw new Error('a linha do bucket não foi criada');
      // Uma sondagem antiga do bucket anterior.
      await prisma.awsSource.update({
        where: { id: original.id },
        data: {
          permission: 'missing',
          permissionDetail: 'bucket_denied',
          state: 'permission_error',
          stateCode: 'bucket_denied',
        },
      });

      const second = bucket();
      const guardduty = bucket('achados');
      await write(adminA, 'patch', `/v1/cloud-accounts/${cloud.id}`)
        .send({ buckets: { cloudtrail: second, guardduty } })
        .expect(200);
      let rows = await legacyOf(cloud.id);
      expect(Object.keys(rows).sort()).toEqual(['cloudtrail', 'guardduty_export']);
      // A mesma linha, com o bucket novo; o que se sabia do bucket antigo não vale mais.
      expect(rows['cloudtrail']).toMatchObject({
        id: original.id,
        name: second,
        details: { bucket: second, legacySource: 'cloudtrail' },
        permission: 'unknown',
        permissionDetail: null,
        state: 'authorized',
        stateCode: 'awaiting_collector',
        authorizedAt: original.authorizedAt,
      });
      expect(rows['guardduty_export']).toMatchObject({ name: guardduty, state: 'authorized' });

      // Uma alteração que não toca nos buckets não mexe nas fontes.
      const before = rows;
      await write(adminA, 'patch', `/v1/cloud-accounts/${cloud.id}`)
        .send({ regions: ['us-east-1'] })
        .expect(200);
      expect(await legacyOf(cloud.id)).toEqual(before);

      // Tirar o bucket tira a fonte (a coleta daquele bucket acabou).
      await write(adminA, 'patch', `/v1/cloud-accounts/${cloud.id}`)
        .send({ buckets: { cloudtrail: null } })
        .expect(200);
      rows = await legacyOf(cloud.id);
      expect(Object.keys(rows)).toEqual(['guardduty_export']);
      await write(adminA, 'patch', `/v1/cloud-accounts/${cloud.id}`)
        .send({ buckets: { guardduty: null } })
        .expect(200);
      expect(await legacyOf(cloud.id)).toEqual({});
    });

    it('a conta de outro provedor não ganha fonte; as fontes descobertas não são tocadas pelo espelho', async () => {
      const gcp = cloudAccountSchema.parse(
        (
          await post(adminA, '/v1/cloud-accounts')
            .send({ provider: 'gcp', accountId: `vx-${randomInt(1_000_000, 9_999_999)}-leg` })
            .expect(201)
        ).body,
      );
      expect(await prisma.awsSource.count({ where: { cloudAccountId: gcp.id } })).toBe(0);

      const cloud = await discoveredAccount(tenantA, { cloudtrailBucket: bucket() });
      const discovered = await source(cloud);
      await syncLegacyAwsSources(prisma.forTenant(tenantA), cloud.id);
      // Rodar de novo não muda nada (o espelho já está igual).
      const once = await prisma.awsSource.findMany({
        where: { cloudAccountId: cloud.id },
        orderBy: { id: 'asc' },
      });
      await syncLegacyAwsSources(prisma.forTenant(tenantA), cloud.id);
      expect(
        await prisma.awsSource.findMany({ where: { cloudAccountId: cloud.id }, orderBy: { id: 'asc' } }),
      ).toEqual(once);
      expect(once.map((row) => row.origin).sort()).toEqual(['discovered', 'legacy']);
      expect(await sourceRow(discovered.id)).toEqual(discovered);
      // A conta já verificada dá a data de início à fonte do bucket.
      expect(once.find((row) => row.origin === 'legacy')).toMatchObject({ collectFrom: VERIFIED });
      // Pelo escopo de outro cliente, a conta não existe: nada é criado.
      await syncLegacyAwsSources(prisma.forTenant(tenantB), cloud.id);
      expect(await prisma.awsSource.count({ where: { cloudAccountId: cloud.id } })).toBe(2);
    });

    it('a permissão da linha do bucket vem da conferência da conexão: concedida, negada naquele bucket, ou por conferir', async () => {
      const trail = bucket();
      const waf = `aws-waf-logs-${randomInt(1_000_000, 9_999_999)}`;
      const cloud = await discoveredAccount(tenantA, { cloudtrailBucket: trail, wafBucket: waf });
      await syncLegacyAwsSources(prisma.forTenant(tenantA), cloud.id);
      const permissions = async () =>
        Object.fromEntries(
          (await onboardingOf(adminA, cloud.id)).sources.map((item) => [
            item.kind,
            [item.permission, item.permissionDetail, item.state],
          ]),
        );
      // Conectada: a conferência leu os dois buckets. A conta espera o coletor: configurando.
      expect(await permissions()).toEqual({
        cloudtrail: ['granted', null, 'authorized'],
        waf: ['granted', null, 'authorized'],
      });
      expect((await onboardingOf(adminA, cloud.id)).state).toBe('configuring');

      await prisma.cloudAccount.update({
        where: { id: cloud.id },
        data: { connection: 'error', connectionError: 'kms_denied:waf' },
      });
      expect(await permissions()).toEqual({
        cloudtrail: ['unknown', null, 'authorized'],
        waf: ['missing', 'kms_denied', 'permission_error'],
      });
      const onboarding = await onboardingOf(adminA, cloud.id);
      expect(onboarding.state).toBe('permission_error');
      expect(onboarding.checks.find((check) => check.id === 'permission')).toMatchObject({
        status: 'failed',
        code: 'kms_denied',
      });
      // No banco, a linha fica como estava: quem prova a leitura do bucket é a conferência da conexão.
      expect(
        (await prisma.awsSource.findMany({ where: { cloudAccountId: cloud.id } })).map(
          (row) => row.permission,
        ),
      ).toEqual(['unknown', 'unknown']);
    });
  });
});
