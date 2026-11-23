import 'reflect-metadata';
import { randomInt } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { awsInfrastructureSummarySchema } from '@verax/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AWS_DISCOVERY_BACKOFF,
  AWS_DISCOVERY_INTERVAL_MS,
  AWS_DISCOVERY_JITTER_MS,
  AWS_DISCOVERY_STREAM,
  AwsDiscovery,
  type AwsDiscoveryOptions,
} from '../src/aws/discovery/discovery-job.js';
import { requestAwsDiscovery } from '../src/aws/discovery/discovery-runs.js';
import { isReadOnlyCommand } from '../src/aws/discovery/read-only.js';
import { AwsConnectionError } from '../src/aws/web-identity.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import {
  awsError,
  fakeDiscovery,
  type FakeDiscoveryAccount,
  type Handlers,
} from './aws/discovery/fake-discovery.js';
import { clockAt, FakeCredentials } from './inventory/fake-job.js';
import { createTenant } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const START = new Date('2026-11-22T10:00:00.000Z');
const accountId = () => String(randomInt(100_000_000_000, 999_999_999_999));

const TRAIL_ARN = 'arn:aws:cloudtrail:sa-east-1:111111111111:trail/principal';
const ACL_ARN = 'arn:aws:wafv2:sa-east-1:111111111111:regional/webacl/loja/acl-1';

/** A conta fictícia destes testes: uma trilha, uma Web ACL com log no S3 e um detector do GuardDuty, em sa-east-1. */
function account(
  overrides: Partial<FakeDiscoveryAccount> & { handlers?: Record<string, Handlers> } = {},
): FakeDiscoveryAccount {
  return {
    regions: ['sa-east-1', 'us-east-1'],
    ...overrides,
    handlers: {
      'cloudtrail:*': {
        DescribeTrailsCommand: () => ({
          trailList: [
            {
              Name: 'principal',
              TrailARN: TRAIL_ARN,
              HomeRegion: 'sa-east-1',
              S3BucketName: 'trilha-da-conta',
            },
          ],
        }),
        GetTrailStatusCommand: () => ({ IsLogging: true }),
      },
      'wafv2:sa-east-1': {
        ListWebACLsCommand: () => ({ WebACLs: [{ Id: 'acl-1', Name: 'loja', ARN: ACL_ARN }] }),
        ListLoggingConfigurationsCommand: () => ({
          LoggingConfigurations: [
            { ResourceArn: ACL_ARN, LogDestinationConfigs: ['arn:aws:s3:::aws-waf-logs-da-conta'] },
          ],
        }),
      },
      'guardduty:sa-east-1': {
        ListDetectorsCommand: () => ({ DetectorIds: ['det1'] }),
        GetDetectorCommand: () => ({ Status: 'ENABLED' }),
        ListFindingsCommand: () => ({ FindingIds: [] }),
      },
      'ec2:sa-east-1': {
        DescribeInstancesCommand: () => ({
          Reservations: [{ Instances: [{ InstanceId: 'i-0aaa0000000000001', State: { Name: 'running' } }] }],
        }),
      },
      ...overrides.handlers,
    },
  };
}

describe('tarefa aws-discovery: a descoberta das fontes de log da conta AWS (onboarding self-service)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Uma conta AWS já verificada e conectada, com as tags do papel lidas (template v2, tudo ligado). */
  function connectedAccount(tenantId: string, data: Partial<Prisma.CloudAccountUncheckedCreateInput> = {}) {
    return prisma.cloudAccount.create({
      data: {
        tenantId,
        provider: 'aws',
        accountId: accountId(),
        regions: ['sa-east-1'],
        connection: 'connected',
        ingestFrom: new Date('2026-11-21T00:00:00.000Z'),
        awsTemplateVersion: 2,
        awsCapabilities: ['discovery', 'service-logs', 'findings', 'log-groups'],
        awsCapabilitiesCheckedAt: START,
        ...data,
      },
    });
  }

  /** A tarefa com o provedor de sessões e a conta falsos. A conta falsa pode ser trocada entre uma execução e outra. */
  function setup(
    tenantIds: string[],
    fake: FakeDiscoveryAccount = account(),
    options: AwsDiscoveryOptions = {},
  ) {
    const clock = clockAt(START);
    const credentials = new FakeCredentials();
    const current = { fake: fakeDiscovery(fake) };
    const name = `disc-${randomInt(1e6, 9e6)}`;
    const task = new AwsDiscovery(
      prisma,
      credentials,
      (provider, home) => current.fake.factory(provider, home),
      {
        name,
        now: clock.now,
        random: () => 0.5,
        tenantIds,
        // O agendamento diário é conferido em toda execução nos testes.
        scheduleEveryMs: 0,
        ...options,
      },
    );
    return {
      task,
      name,
      clock,
      credentials,
      calls: () => current.fake.calls,
      /** Troca a conta falsa (o que a AWS responde a partir de agora). */
      become: (next: FakeDiscoveryAccount) => {
        current.fake = fakeDiscovery(next);
      },
    };
  }

  const request = (
    cloudAccount: { id: string; tenantId: string },
    trigger: 'connect' | 'manual' | 'scheduled' = 'connect',
    now = START,
  ) =>
    prisma.$transaction((tx) =>
      requestAwsDiscovery(tx, {
        tenantId: cloudAccount.tenantId,
        cloudAccountId: cloudAccount.id,
        trigger,
        now,
      }),
    );
  const runsOf = (cloudAccountId: string) =>
    prisma.awsDiscoveryRun.findMany({
      where: { cloudAccountId },
      orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
    });
  const sourcesOf = async (cloudAccountId: string) =>
    Object.fromEntries(
      (await prisma.awsSource.findMany({ where: { cloudAccountId } })).map((source) => [
        `${source.kind}:${source.region}:${source.resourceId}`,
        source,
      ]),
    );
  const accountOf = (id: string) => prisma.cloudAccount.findUniqueOrThrow({ where: { id } });
  const auditOf = (id: string) =>
    prisma.auditLog.findMany({
      where: { action: 'cloud_account.aws_discovery', resourceId: id },
      orderBy: { occurredAt: 'asc' },
    });
  const cursorOf = (cloudAccountId: string) =>
    prisma.collectorCursor.findUnique({
      where: { cloudAccountId_stream_region: { cloudAccountId, stream: AWS_DISCOVERY_STREAM, region: '' } },
    });
  const authorize = (id: string) =>
    prisma.awsSource.update({
      where: { id },
      data: {
        authorizedAt: START,
        authorizedBy: 'usuario-de-teste',
        collectFrom: new Date('2026-11-22T00:00:00.000Z'),
        state: 'authorized',
        stateCode: 'awaiting_collector',
      },
    });

  it('executa o pedido do "Conectar": grava as fontes, o retrato, as regiões e o fim da execução, com auditoria', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (descoberta)');
    const cloud = await connectedAccount(tenant);
    await request(cloud);
    const { task, credentials, calls, clock } = setup([tenant]);

    expect(await task.runOnce()).toEqual({
      status: 'done',
      interrupted: 0,
      scheduled: 0,
      pending: 1,
      succeeded: 1,
      partial: 0,
      failed: 0,
      stale: 0,
      sources: { created: 7, updated: 0, missing: 0, removed: 0 },
      probes: 0,
    });
    // A mesma entrada no papel da conferência e do inventário: pela primeira região monitorada.
    expect(credentials.sessions).toEqual([{ accountId: cloud.accountId, region: 'sa-east-1' }]);
    for (const call of calls()) {
      expect(isReadOnlyCommand({ constructor: { name: call.command } }), call.command).toBe(true);
    }

    const [run] = await runsOf(cloud.id);
    expect(run).toMatchObject({
      tenantId: tenant,
      trigger: 'connect',
      status: 'succeeded',
      startedAt: START,
      regions: ['sa-east-1', 'us-east-1'],
      errors: [],
      requestedBy: null,
    });
    expect(run?.finishedAt).not.toBeNull();
    expect(awsInfrastructureSummarySchema.parse(run?.summary)).toMatchObject({
      instances: 1,
      trails: 1,
      webAcls: 1,
    });

    const sources = await sourcesOf(cloud.id);
    expect(Object.keys(sources).sort()).toEqual(
      [
        `cloudtrail:sa-east-1:${TRAIL_ARN}`,
        'waf:sa-east-1:acl-1',
        'guardduty:sa-east-1:det1',
        'vpc_flow_logs:global:none',
        'security_hub:global:none',
        'inspector:global:none',
        'access_analyzer:global:none',
      ].sort(),
    );
    expect(sources[`cloudtrail:sa-east-1:${TRAIL_ARN}`]).toMatchObject({
      tenantId: tenant,
      origin: 'discovered',
      method: 's3',
      sensitive: false,
      availability: 'available',
      loggingState: 'logging',
      permission: 'granted',
      permissionDetail: null,
      state: 'available',
      stateCode: null,
      authorizedAt: null,
      collectFrom: null,
      firstSeenAt: START,
      lastSeenAt: START,
      missingSince: null,
      // A saúde fica vazia até o coletor da fonte existir.
      lastSyncAt: null,
      lastEventAt: null,
      lagSeconds: null,
      details: {
        bucket: 'trilha-da-conta',
        prefix: `AWSLogs/${cloud.accountId}/CloudTrail/sa-east-1/`,
      },
    });
    expect(sources[`cloudtrail:sa-east-1:${TRAIL_ARN}`]?.permissionCheckedAt).toEqual(START);
    expect(sources['guardduty:sa-east-1:det1']).toMatchObject({
      method: 'api',
      state: 'available',
      permission: 'granted',
      notes: ['recommended'],
    });
    expect(sources['security_hub:global:none']).toMatchObject({
      availability: 'not_enabled',
      state: 'unavailable',
      stateCode: 'not_enabled',
      notes: ['aws_cost_security_hub'],
    });

    // As regiões com recurso ou fonte; as monitoradas só ganham (a conta é do painel).
    expect(await accountOf(cloud.id)).toMatchObject({
      awsDiscoveredRegions: ['sa-east-1'],
      regions: ['sa-east-1'],
    });
    const audit = await auditOf(cloud.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorType: 'system',
      tenantId: tenant,
      outcome: 'success',
      before: { regions: ['sa-east-1'], awsDiscoveredRegions: [] },
      after: {
        regions: ['sa-east-1'],
        awsDiscoveredRegions: ['sa-east-1'],
        trigger: 'connect',
        status: 'succeeded',
        sources: { created: 7 },
      },
    });
    // A próxima descoberta diária: 24 h depois do início, mais metade do sorteio de 1 h.
    expect((await cursorOf(cloud.id))?.nextRunAt).toEqual(
      new Date(START.getTime() + AWS_DISCOVERY_INTERVAL_MS + AWS_DISCOVERY_JITTER_MS / 2),
    );
    // Sem pedido novo, nada roda de novo.
    clock.advance(HOUR);
    expect(await task.runOnce()).toMatchObject({ pending: 0, scheduled: 0 });
  });

  it('as regiões novas entram nas monitoradas da conta do painel, sem tirar nenhuma; na conta do console, não', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (regiões)');
    const panel = await connectedAccount(tenant, { regions: ['us-east-1'] });
    const console_ = await connectedAccount(tenant, {
      regions: ['us-east-1'],
      origin: 'control_plane',
      controlPlaneRevision: 1,
    });
    await request(panel);
    await request(console_);
    const { task } = setup([tenant]);
    expect(await task.runOnce()).toMatchObject({ succeeded: 2 });
    // A região de partida continua a primeira (é a do STS e do S3 da conferência e do Wazuh).
    expect(await accountOf(panel.id)).toMatchObject({
      regions: ['us-east-1', 'sa-east-1'],
      awsDiscoveredRegions: ['sa-east-1'],
    });
    // As regiões da conta que a Verax cadastrou são do console: só as descobertas são gravadas.
    expect(await accountOf(console_.id)).toMatchObject({
      regions: ['us-east-1'],
      awsDiscoveredRegions: ['sa-east-1'],
    });
    expect((await auditOf(panel.id))[0]).toMatchObject({
      before: { regions: ['us-east-1'] },
      after: { regions: ['us-east-1', 'sa-east-1'] },
    });
  });

  it('descoberta parcial: o que foi recusado fica registrado, e o que a execução não leu não some', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (parcial)');
    const cloud = await connectedAccount(tenant);
    const { task, clock, become } = setup([tenant]);
    await request(cloud);
    await task.runOnce();
    expect(Object.keys(await sourcesOf(cloud.id))).toContain('guardduty:sa-east-1:det1');

    // Na descoberta seguinte, o GuardDuty de sa-east-1 nega a leitura.
    become(account({ deny: { 'guardduty:sa-east-1': awsError('AccessDeniedException', 403) } }));
    clock.advance(HOUR);
    await request(cloud, 'manual', clock.now());
    expect(await task.runOnce()).toMatchObject({ pending: 1, partial: 1, succeeded: 0, failed: 0 });
    const runs = await runsOf(cloud.id);
    expect(runs[1]).toMatchObject({
      status: 'partial',
      errors: [{ service: 'guardduty', region: 'sa-east-1', code: 'AccessDeniedException' }],
    });
    // O detector que a execução não conseguiu ler continua na lista, como estava.
    const sources = await sourcesOf(cloud.id);
    expect(sources['guardduty:sa-east-1:det1']).toMatchObject({
      state: 'available',
      lastSeenAt: START,
      missingSince: null,
    });
    expect(sources['guardduty:global:none']).toBeUndefined();
    // O que foi lido teve a data atualizada.
    expect(sources[`cloudtrail:sa-east-1:${TRAIL_ARN}`]?.lastSeenAt).toEqual(clock.now());
  });

  it('a fonte que some: a nunca autorizada sai da lista; a autorizada vira source_missing; a revogada fica; a que volta, volta', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (sumiço)');
    const cloud = await connectedAccount(tenant, { cloudtrailBucket: 'bucket-do-cadastro' });
    const legacy = await prisma.awsSource.create({
      data: {
        tenantId: tenant,
        cloudAccountId: cloud.id,
        kind: 'cloudtrail',
        region: 'global',
        resourceId: 'legacy',
        name: 'bucket-do-cadastro',
        details: { bucket: 'bucket-do-cadastro', legacySource: 'cloudtrail' },
        method: 's3',
        availability: 'available',
        origin: 'legacy',
        authorizedAt: START,
        state: 'authorized',
        stateCode: 'awaiting_collector',
      },
    });
    const { task, clock, become } = setup([tenant]);
    await request(cloud);
    await task.runOnce();
    const first = await sourcesOf(cloud.id);
    const trail = first[`cloudtrail:sa-east-1:${TRAIL_ARN}`];
    const waf = first['waf:sa-east-1:acl-1'];
    const detector = first['guardduty:sa-east-1:det1'];
    if (!trail || !waf || !detector) throw new Error('fontes esperadas não foram criadas');
    // A trilha autorizada; a Web ACL autorizada e depois revogada; o detector nunca autorizado.
    await authorize(trail.id);
    await prisma.awsSource.update({
      where: { id: waf.id },
      data: { authorizedAt: START, revokedAt: START, state: 'revoked', stateCode: null },
    });

    // A conta fica sem nada: nenhuma trilha, nenhuma Web ACL, nenhum detector.
    become({ regions: ['sa-east-1', 'us-east-1'] });
    clock.advance(HOUR);
    await request(cloud, 'manual', clock.now());
    const gone = clock.now();
    expect(await task.runOnce()).toMatchObject({ succeeded: 1, sources: { missing: 1, removed: 1 } });
    let sources = await sourcesOf(cloud.id);
    expect(sources[`cloudtrail:sa-east-1:${TRAIL_ARN}`]).toMatchObject({
      state: 'source_missing',
      stateCode: 'not_found',
      missingSince: gone,
      // A autorização não é mexida: quem, quando e a partir de quando.
      authorizedAt: START,
      authorizedBy: 'usuario-de-teste',
      revokedAt: null,
      collectFrom: new Date('2026-11-22T00:00:00.000Z'),
    });
    expect(sources['waf:sa-east-1:acl-1']).toMatchObject({ state: 'revoked', missingSince: gone });
    expect(sources['guardduty:sa-east-1:det1']).toBeUndefined();
    // Sem nenhum serviço, entram as linhas "desligado"; a linha do bucket cadastrado não é tocada.
    expect(sources['guardduty:global:none']).toMatchObject({ availability: 'not_enabled' });
    expect(sources['cloudtrail:global:none']).toMatchObject({ availability: 'not_enabled' });
    expect(sources['cloudtrail:global:legacy']).toEqual(legacy);
    expect((await auditOf(cloud.id)).at(-1)).toMatchObject({
      after: { sources: { missing: 1, removed: 1 } },
    });

    // Outra descoberta com a fonte ainda sumida não conta o sumiço de novo.
    clock.advance(HOUR);
    await request(cloud, 'manual', clock.now());
    expect(await task.runOnce()).toMatchObject({ sources: { missing: 0 } });
    expect((await sourcesOf(cloud.id))[`cloudtrail:sa-east-1:${TRAIL_ARN}`]).toMatchObject({
      missingSince: gone,
    });

    // A trilha volta: a fonte autorizada volta a esperar o coletor, e as linhas "desligado" saem.
    become(account());
    clock.advance(HOUR);
    await request(cloud, 'manual', clock.now());
    await task.runOnce();
    sources = await sourcesOf(cloud.id);
    expect(sources[`cloudtrail:sa-east-1:${TRAIL_ARN}`]).toMatchObject({
      id: trail.id,
      state: 'authorized',
      stateCode: 'awaiting_collector',
      missingSince: null,
      authorizedAt: START,
    });
    expect(sources['waf:sa-east-1:acl-1']).toMatchObject({
      id: waf.id,
      state: 'revoked',
      missingSince: null,
    });
    expect(sources['cloudtrail:global:none']).toBeUndefined();
    expect(sources['guardduty:global:none']).toBeUndefined();
    expect(sources['guardduty:sa-east-1:det1']).toMatchObject({ state: 'available' });
  });

  it('a fonte autorizada que perde a permissão vira permission_error; com a permissão de volta, espera o coletor de novo', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (permissão)');
    const cloud = await connectedAccount(tenant);
    const { task, clock, become } = setup([tenant]);
    await request(cloud);
    await task.runOnce();
    const detector = (await sourcesOf(cloud.id))['guardduty:sa-east-1:det1'];
    if (!detector) throw new Error('detector não criado');
    await authorize(detector.id);

    const denied = account();
    (denied.handlers as Record<string, Handlers>)['guardduty:sa-east-1'] = {
      ...(denied.handlers as Record<string, Handlers>)['guardduty:sa-east-1'],
      ListFindingsCommand: () => {
        throw awsError('AccessDeniedException', 403);
      },
    };
    become(denied);
    clock.advance(HOUR);
    await request(cloud, 'manual', clock.now());
    await task.runOnce();
    expect((await sourcesOf(cloud.id))['guardduty:sa-east-1:det1']).toMatchObject({
      state: 'permission_error',
      stateCode: 'guardduty:ListFindings',
      permission: 'missing',
      permissionDetail: 'guardduty:ListFindings',
      authorizedAt: START,
    });

    // Uma sondagem que não termina (a AWS limitando) não apaga o que já se sabia.
    const throttled = account();
    (throttled.handlers as Record<string, Handlers>)['guardduty:sa-east-1'] = {
      ...(throttled.handlers as Record<string, Handlers>)['guardduty:sa-east-1'],
      ListFindingsCommand: () => {
        throw awsError('ThrottlingException', 400);
      },
    };
    become(throttled);
    clock.advance(HOUR);
    await request(cloud, 'manual', clock.now());
    await task.runOnce();
    expect((await sourcesOf(cloud.id))['guardduty:sa-east-1:det1']).toMatchObject({
      state: 'permission_error',
      permission: 'missing',
      permissionDetail: 'guardduty:ListFindings',
    });

    become(account());
    clock.advance(HOUR);
    await request(cloud, 'manual', clock.now());
    await task.runOnce();
    expect((await sourcesOf(cloud.id))['guardduty:sa-east-1:det1']).toMatchObject({
      state: 'authorized',
      stateCode: 'awaiting_collector',
      permission: 'granted',
      permissionDetail: null,
    });
  });

  it('a fonte autorizada cujo log foi para um destino que o nó não lê: source_missing, com o motivo', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (destino)');
    const cloud = await connectedAccount(tenant);
    const { task, clock, become } = setup([tenant]);
    await request(cloud);
    await task.runOnce();
    const waf = (await sourcesOf(cloud.id))['waf:sa-east-1:acl-1'];
    if (!waf) throw new Error('Web ACL não criada');
    await authorize(waf.id);

    become(
      account({
        handlers: {
          'wafv2:sa-east-1': {
            ListWebACLsCommand: () => ({ WebACLs: [{ Id: 'acl-1', Name: 'loja', ARN: ACL_ARN }] }),
            ListLoggingConfigurationsCommand: () => ({
              LoggingConfigurations: [
                {
                  ResourceArn: ACL_ARN,
                  LogDestinationConfigs: [
                    'arn:aws:firehose:sa-east-1:111111111111:deliverystream/aws-waf-logs-x',
                  ],
                },
              ],
            }),
          },
        },
      }),
    );
    clock.advance(HOUR);
    await request(cloud, 'manual', clock.now());
    await task.runOnce();
    expect((await sourcesOf(cloud.id))['waf:sa-east-1:acl-1']).toMatchObject({
      availability: 'unsupported_destination',
      state: 'source_missing',
      stateCode: 'unsupported_destination',
      missingSince: clock.now(),
      authorizedAt: START,
    });
  });

  it('no template v1 (só a descoberta), as fontes aparecem pedindo a atualização da pilha, sem sondagem', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (template v1)');
    const cloud = await connectedAccount(tenant, { awsTemplateVersion: 1, awsCapabilities: ['discovery'] });
    await request(cloud);
    const { task, calls } = setup([tenant]);
    await task.runOnce();
    const sources = await sourcesOf(cloud.id);
    for (const key of [
      `cloudtrail:sa-east-1:${TRAIL_ARN}`,
      'waf:sa-east-1:acl-1',
      'guardduty:sa-east-1:det1',
    ]) {
      expect(sources[key], key).toMatchObject({
        state: 'needs_permission',
        permission: 'missing',
        permissionDetail: 'capability_off',
      });
      expect(sources[key]?.notes, key).toContain('stack_update_required');
    }
    expect(
      calls().some((call) => ['ListObjectsV2Command', 'ListFindingsCommand'].includes(call.command)),
    ).toBe(false);
  });

  it('a descoberta diária: pedida quando a última tem mais de 24 h, só para a conta que entra no papel', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (diária)');
    const inactiveTenant = await createTenant(app, 'Cliente Demo B (inativo)');
    await prisma.tenant.update({ where: { id: inactiveTenant }, data: { status: 'inactive' } });
    const connected = await connectedAccount(tenant);
    const bucketError = await connectedAccount(tenant, {
      connection: 'error',
      connectionError: 'bucket_denied:waf',
    });
    const skipped = [
      await connectedAccount(tenant, { connection: 'error', connectionError: 'trust_denied' }),
      await connectedAccount(tenant, { connection: 'waiting' }),
      await connectedAccount(tenant, { ingestFrom: null }),
      await connectedAccount(tenant, { status: 'inactive', connection: 'waiting' }),
      await connectedAccount(inactiveTenant),
    ];
    const { task, clock } = setup([tenant, inactiveTenant]);

    // A conta que nunca foi descoberta entra já, na primeira execução.
    expect(await task.runOnce()).toMatchObject({ scheduled: 2, pending: 2, succeeded: 2 });
    expect((await runsOf(connected.id)).map((run) => [run.trigger, run.status])).toEqual([
      ['scheduled', 'succeeded'],
    ]);
    expect(await runsOf(bucketError.id)).toHaveLength(1);
    for (const cloud of skipped) expect(await runsOf(cloud.id)).toEqual([]);

    // Antes das 24 h (mais o sorteio), nada.
    clock.advance(AWS_DISCOVERY_INTERVAL_MS);
    expect(await task.runOnce()).toMatchObject({ scheduled: 0, pending: 0 });
    clock.advance(AWS_DISCOVERY_JITTER_MS / 2);
    expect(await task.runOnce()).toMatchObject({ scheduled: 2, succeeded: 2 });
    expect(await runsOf(connected.id)).toHaveLength(2);
    // Sem mudança nas regiões nem na lista de fontes, a descoberta diária não deixa registro na trilha.
    expect(await auditOf(connected.id)).toHaveLength(1);
  });

  it('com um pedido já pendente, o agendamento não cria outro (no máximo uma por conta)', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (uma por vez)');
    const cloud = await connectedAccount(tenant);
    const first = await request(cloud, 'manual');
    expect(first.created).toBe(true);
    const again = await request(cloud, 'connect');
    expect(again).toMatchObject({ created: false, run: { id: first.run.id, trigger: 'manual' } });
    const { task } = setup([tenant]);
    expect(await task.runOnce()).toMatchObject({ scheduled: 0, pending: 1, succeeded: 1 });
    expect(await runsOf(cloud.id)).toHaveLength(1);
  });

  it('a entrada no papel recusada: a execução falha com o código, nada é gravado nas fontes, e a diária recua', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (recusada)');
    const cloud = await connectedAccount(tenant);
    await request(cloud);
    const { task, credentials, calls, clock } = setup([tenant]);
    credentials.failures.set(cloud.accountId, new AwsConnectionError('trust_denied', true));

    expect(await task.runOnce()).toMatchObject({ pending: 1, failed: 1, failures: { trust_denied: 1 } });
    expect(calls()).toEqual([]);
    expect((await runsOf(cloud.id))[0]).toMatchObject({
      status: 'failed',
      errors: [{ service: 'sts', region: 'global', code: 'trust_denied' }],
      summary: null,
    });
    expect(await sourcesOf(cloud.id)).toEqual({});
    expect(await auditOf(cloud.id)).toEqual([]);
    const cursor = await cursorOf(cloud.id);
    expect(cursor).toMatchObject({ failures: 1, lastErrorKind: 'trust_denied' });
    expect(cursor?.nextRunAt).toEqual(new Date(START.getTime() + AWS_DISCOVERY_BACKOFF.baseMs));
    const state = await prisma.syncState.findUniqueOrThrow({ where: { name: task['name'] } });
    expect(state).toMatchObject({ lastError: 'trust_denied', leaseOwner: null });

    // Passado o recuo, a diária tenta de novo, e a conta corrigida é descoberta.
    credentials.failures.clear();
    clock.advance(AWS_DISCOVERY_BACKOFF.baseMs);
    expect(await task.runOnce()).toMatchObject({ scheduled: 1, succeeded: 1 });
  });

  it('tudo recusado pela AWS: falha sem gravar nada, e a sessão guardada é descartada', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (tudo recusado)');
    const cloud = await connectedAccount(tenant);
    await request(cloud);
    const denied = awsError('AccessDenied', 403);
    const { task, credentials } = setup([tenant], {
      regions: ['sa-east-1'],
      deny: Object.fromEntries(
        [
          'ec2',
          'cloudtrail',
          'guardduty',
          's3',
          'iam',
          'logs',
          'wafv2',
          'securityhub',
          'inspector2',
          'accessanalyzer',
          'rds',
          'elbv2',
          'config',
        ].map((service) => [`${service}:*`, denied]),
      ),
    });
    expect(await task.runOnce()).toMatchObject({ failed: 1, failures: { discovery_refused: 1 } });
    expect((await runsOf(cloud.id))[0]).toMatchObject({
      status: 'failed',
      errors: [{ service: 'run', region: 'global', code: 'discovery_refused' }],
    });
    expect(credentials.forgotten).toEqual([cloud.accountId]);
    expect(await sourcesOf(cloud.id)).toEqual({});
  });

  it('a conta que não entra mais no papel, ou foi desativada: a execução falha sem chamar a AWS', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (sem conexão)');
    const refused = await connectedAccount(tenant);
    const inactive = await connectedAccount(tenant);
    await request(refused);
    await request(inactive);
    await prisma.cloudAccount.update({
      where: { id: refused.id },
      data: { connection: 'error', connectionError: 'trust_denied' },
    });
    await prisma.cloudAccount.update({
      where: { id: inactive.id },
      data: { status: 'inactive', connection: 'waiting' },
    });
    const { task, credentials } = setup([tenant]);
    expect(await task.runOnce()).toMatchObject({
      pending: 2,
      failed: 2,
      failures: { not_connected: 1, account_unavailable: 1 },
    });
    expect(credentials.sessions).toEqual([]);
    expect((await runsOf(refused.id))[0]).toMatchObject({
      status: 'failed',
      errors: [{ service: 'run', region: 'global', code: 'not_connected' }],
    });
    expect((await runsOf(inactive.id))[0]).toMatchObject({
      status: 'failed',
      errors: [{ service: 'run', region: 'global', code: 'account_unavailable' }],
    });
  });

  it('a conta desativada durante a descoberta: nada é gravado', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (desativada no meio)');
    const cloud = await connectedAccount(tenant);
    await request(cloud);
    const { task } = setup(
      [tenant],
      account({
        handlers: {
          'iam:global': {
            GetAccountSummaryCommand: async () => {
              // Enquanto a AWS responde, um administrador desativa a conta.
              await prisma.cloudAccount.update({
                where: { id: cloud.id },
                data: { status: 'inactive', connection: 'waiting' },
              });
              return { SummaryMap: { Users: 1, AccountMFAEnabled: 1 } };
            },
          },
        },
      }),
    );
    expect(await task.runOnce()).toMatchObject({ pending: 1, stale: 1, succeeded: 0 });
    expect(await sourcesOf(cloud.id)).toEqual({});
    expect((await runsOf(cloud.id))[0]).toMatchObject({
      status: 'failed',
      errors: [{ service: 'run', region: 'global', code: 'account_unavailable' }],
    });
    expect(await accountOf(cloud.id)).toMatchObject({ awsDiscoveredRegions: [] });
  });

  it('a execução que um worker deixou "em curso" ao parar vira falha (interrupted), e outra pode ser pedida', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (interrompida)');
    const cloud = await connectedAccount(tenant);
    const { run } = await request(cloud);
    await prisma.awsDiscoveryRun.update({
      where: { id: run.id },
      data: { status: 'running', startedAt: START },
    });
    // Com uma em curso, nenhuma outra é criada.
    expect((await request(cloud, 'manual')).created).toBe(false);

    const { task } = setup([tenant]);
    // A execução marca a que ficou para trás e, na mesma volta, agenda e roda a diária da conta.
    expect(await task.runOnce()).toMatchObject({ interrupted: 1, scheduled: 1, succeeded: 1 });
    expect((await runsOf(cloud.id)).map((item) => [item.trigger, item.status])).toEqual([
      ['connect', 'failed'],
      ['scheduled', 'succeeded'],
    ]);
    expect((await runsOf(cloud.id))[0]?.errors).toEqual([
      { service: 'run', region: 'global', code: 'interrupted' },
    ]);
  });

  it('o sinal abortado no meio: a execução fica marcada como interrompida, e nada das fontes é gravado', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (parada)');
    const cloud = await connectedAccount(tenant);
    await request(cloud);
    const controller = new AbortController();
    const { task } = setup(
      [tenant],
      account({
        handlers: {
          'iam:global': {
            GetAccountSummaryCommand: () => {
              controller.abort(new DOMException('o worker está parando', 'AbortError'));
              return { SummaryMap: {} };
            },
          },
        },
      }),
    );
    await expect(task.runOnce(controller.signal)).rejects.toThrow();
    expect((await runsOf(cloud.id))[0]).toMatchObject({
      status: 'failed',
      errors: [{ service: 'run', region: 'global', code: 'interrupted' }],
    });
    expect(await sourcesOf(cloud.id)).toEqual({});
    // A concessão é solta mesmo assim.
    const state = await prisma.syncState.findUniqueOrThrow({ where: { name: task['name'] } });
    expect(state.leaseOwner).toBeNull();
  });

  it('com a concessão em outra réplica, nada roda', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (concessão)');
    const cloud = await connectedAccount(tenant);
    await request(cloud);
    const { task, name, credentials } = setup([tenant]);
    await prisma.syncState.create({
      data: { name, leaseOwner: 'outra-replica', leaseUntil: new Date(START.getTime() + HOUR) },
    });
    expect(await task.runOnce()).toMatchObject({ status: 'locked', pending: 0 });
    expect(credentials.sessions).toEqual([]);
    expect((await runsOf(cloud.id))[0]).toMatchObject({ status: 'pending' });
  });

  it('os pedidos mais antigos primeiro, no máximo o lote por execução', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (lote)');
    const older = await connectedAccount(tenant);
    const newer = await connectedAccount(tenant);
    await request(older, 'connect', new Date(START.getTime() - 2 * MINUTE));
    await request(newer, 'connect', new Date(START.getTime() - MINUTE));
    // Sem o agendamento diário nesta execução (o cursor das duas já está para depois).
    const { task } = setup([tenant], account(), { batch: 1, scheduleEveryMs: 24 * HOUR });
    await task.runOnce();
    await task.runOnce();
    expect((await runsOf(older.id))[0]?.status).toBe('succeeded');
    expect((await runsOf(newer.id))[0]?.status).toBe('succeeded');
    const [first] = await runsOf(older.id);
    const [second] = await runsOf(newer.id);
    expect((first?.finishedAt ?? new Date()) <= (second?.finishedAt ?? new Date(0))).toBe(true);
  });

  it('A/B: cada conta recebe as próprias fontes, no próprio cliente e na própria trilha', async () => {
    const tenantA = await createTenant(app, 'Cliente Demo A (descoberta A/B)');
    const tenantB = await createTenant(app, 'Cliente Demo B (descoberta A/B)');
    const ofA = await connectedAccount(tenantA);
    const ofB = await connectedAccount(tenantB);
    await request(ofA);
    await request(ofB);
    // Só o cliente A entra nesta tarefa: o pedido de B fica pendente.
    const onlyA = setup([tenantA]);
    expect(await onlyA.task.runOnce()).toMatchObject({ pending: 1, succeeded: 1 });
    expect((await runsOf(ofB.id))[0]?.status).toBe('pending');
    expect(await sourcesOf(ofB.id)).toEqual({});

    const both = setup([tenantA, tenantB]);
    await both.task.runOnce();
    const rowsA = await prisma.awsSource.findMany({ where: { cloudAccountId: ofA.id } });
    const rowsB = await prisma.awsSource.findMany({ where: { cloudAccountId: ofB.id } });
    expect(rowsA.length).toBeGreaterThan(0);
    expect(rowsB).toHaveLength(rowsA.length);
    expect(new Set(rowsA.map((row) => row.tenantId))).toEqual(new Set([tenantA]));
    expect(new Set(rowsB.map((row) => row.tenantId))).toEqual(new Set([tenantB]));
    // O caminho de cada fonte usa o ID da conta AWS da própria conta.
    expect(JSON.stringify(rowsA)).not.toContain(ofB.accountId);
    expect(JSON.stringify(rowsB)).not.toContain(ofA.accountId);
    expect((await auditOf(ofA.id)).map((entry) => entry.tenantId)).toEqual([tenantA]);
    expect((await auditOf(ofB.id)).map((entry) => entry.tenantId)).toEqual([tenantB]);
  });

  describe('"Tentar de novo" numa fonte (a sondagem pedida no painel)', () => {
    it('confere de novo a permissão da fonte, grava o resultado e o estado que decorre dele, e desfaz o pedido', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (sondagem)');
      const cloud = await connectedAccount(tenant);
      const group = await prisma.awsSource.create({
        data: {
          tenantId: tenant,
          cloudAccountId: cloud.id,
          kind: 'cloudwatch_log_group',
          region: 'sa-east-1',
          resourceId: '/app/api',
          name: '/app/api',
          details: { logGroup: '/app/api', tagged: true, category: 'other' },
          method: 'cloudwatch',
          availability: 'available',
          permission: 'missing',
          permissionDetail: 'logs:DescribeLogStreams',
          sensitive: true,
          state: 'needs_permission',
          probeRequestedAt: START,
        },
      });
      const untouched = await prisma.awsSource.create({
        data: {
          tenantId: tenant,
          cloudAccountId: cloud.id,
          kind: 'security_hub',
          region: 'sa-east-1',
          resourceId: 'hub',
          name: 'Security Hub',
          method: 'api',
          availability: 'available',
          permission: 'missing',
          permissionDetail: 'securityhub:GetFindings',
          state: 'needs_permission',
        },
      });
      // Sem agendar a diária: só a sondagem.
      const { task, calls, clock } = setup([tenant], account(), { scheduleEveryMs: 24 * HOUR });
      await prisma.collectorCursor.create({
        data: {
          cloudAccountId: cloud.id,
          stream: AWS_DISCOVERY_STREAM,
          nextRunAt: new Date(START.getTime() + HOUR),
        },
      });
      clock.advance(MINUTE);
      expect(await task.runOnce()).toMatchObject({ pending: 0, probes: 1 });
      expect(calls().map((call) => [call.service, call.command, call.input])).toEqual([
        ['logs', 'DescribeLogStreamsCommand', { logGroupName: '/app/api', limit: 1 }],
      ]);
      expect(await prisma.awsSource.findUniqueOrThrow({ where: { id: group.id } })).toMatchObject({
        probeRequestedAt: null,
        permission: 'granted',
        permissionDetail: null,
        permissionCheckedAt: clock.now(),
        state: 'available',
      });
      expect(await prisma.awsSource.findUniqueOrThrow({ where: { id: untouched.id } })).toEqual(untouched);
    });

    it('a conta que não entra no papel, ou a sondagem que não termina: só o pedido é desfeito', async () => {
      const tenant = await createTenant(app, 'Cliente Demo A (sondagem sem conexão)');
      const refused = await connectedAccount(tenant, {
        connection: 'error',
        connectionError: 'trust_denied',
      });
      const throttled = await connectedAccount(tenant);
      const row = (cloudAccountId: string) =>
        prisma.awsSource.create({
          data: {
            tenantId: tenant,
            cloudAccountId,
            kind: 'security_hub',
            region: 'sa-east-1',
            resourceId: 'hub',
            name: 'Security Hub',
            method: 'api',
            availability: 'available',
            permission: 'missing',
            permissionDetail: 'securityhub:GetFindings',
            state: 'needs_permission',
            probeRequestedAt: START,
          },
        });
      const ofRefused = await row(refused.id);
      const ofThrottled = await row(throttled.id);
      await prisma.collectorCursor.create({
        data: {
          cloudAccountId: throttled.id,
          stream: AWS_DISCOVERY_STREAM,
          nextRunAt: new Date(START.getTime() + HOUR),
        },
      });
      const { task, credentials } = setup(
        [tenant],
        account({
          handlers: {
            'securityhub:sa-east-1': {
              GetFindingsCommand: () => {
                throw awsError('ThrottlingException', 400);
              },
            },
          },
        }),
        { scheduleEveryMs: 24 * HOUR },
      );
      expect(await task.runOnce()).toMatchObject({ probes: 2 });
      // Só a conta que entra no papel abriu sessão.
      expect(credentials.sessions).toEqual([{ accountId: throttled.accountId, region: 'sa-east-1' }]);
      for (const source of [ofRefused, ofThrottled]) {
        expect(await prisma.awsSource.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({
          probeRequestedAt: null,
          permission: 'missing',
          permissionDetail: 'securityhub:GetFindings',
          permissionCheckedAt: null,
          state: 'needs_permission',
        });
      }
    });
  });
});
