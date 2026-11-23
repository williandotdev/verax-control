import { describe, expect, it } from 'vitest';
import {
  AWS_AUTHORIZE_MAX_SOURCES,
  AWS_DISCOVERY_MAX_ERRORS,
  AWS_DISCOVERY_STATUSES,
  AWS_DISCOVERY_TRIGGERS,
  AWS_MAX_SOURCES_PER_ACCOUNT,
  AWS_ONBOARDING_CAPABILITIES,
  AWS_ONBOARDING_CHECK_IDS,
  AWS_ONBOARDING_CHECK_STATUSES,
  AWS_ONBOARDING_STATES,
  AWS_ONBOARDING_TEMPLATE_VERSION,
  AWS_SOURCE_ACTIVE_STATES,
  AWS_SOURCE_AVAILABILITIES,
  AWS_SOURCE_KIND_INFO,
  AWS_SOURCE_KINDS,
  AWS_SOURCE_METHODS,
  AWS_SOURCE_NOTES,
  AWS_SOURCE_PERMISSION_CODES,
  AWS_SOURCE_PERMISSIONS,
  AWS_SOURCE_STATES,
  type AwsOnboarding,
  type AwsSource,
  awsDiscoveryRunSchema,
  awsInfrastructureSummarySchema,
  awsOnboardingRoleFacts,
  awsOnboardingSchema,
  awsSourceDetailsSchema,
  awsSourceIdleState,
  awsSourceSchema,
  awsSourcesAuthorizeSchema,
  hasAwsLogGroupReadTag,
  isAwsSourceActiveState,
  isAwsSourcePermissionDetail,
  isAwsSourceRegion,
  isAwsTemplateOutdated,
} from './aws-onboarding.js';
import * as shared from './index.js';

const NOW = '2026-11-22T12:00:00.000Z';
const uuid = (suffix: number) => `018f0000-0000-7000-8000-${String(suffix).padStart(12, '0')}`;

function source(overrides: Partial<AwsSource> = {}): AwsSource {
  return {
    id: uuid(1),
    kind: 'cloudtrail',
    region: 'sa-east-1',
    resourceId: 'arn:aws:cloudtrail:sa-east-1:111111111111:trail/principal',
    name: 'principal',
    method: 's3',
    origin: 'discovered',
    collectable: true,
    sensitive: false,
    availability: 'available',
    loggingState: 'logging',
    permission: 'granted',
    permissionDetail: null,
    permissionCheckedAt: NOW,
    probeRequestedAt: null,
    notes: [],
    details: { bucket: 'trilha-111111111111', prefix: 'AWSLogs/111111111111/CloudTrail/sa-east-1/' },
    state: 'available',
    stateCode: null,
    stateSince: NOW,
    authorization: { authorizedAt: null, authorizedBy: null, revokedAt: null },
    collectFrom: null,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    missingSince: null,
    health: {
      lastSyncAt: null,
      lastEventAt: null,
      lastIngestedAt: null,
      lagSeconds: null,
      eventsLast24h: null,
      bytesLast24h: null,
    },
    ...overrides,
  };
}

function onboarding(overrides: Partial<AwsOnboarding> = {}): AwsOnboarding {
  return {
    cloudAccountId: uuid(9),
    state: 'awaiting_sources',
    credentialMode: 'role',
    connect: { requestedAt: NOW, waitingUntil: null },
    checks: AWS_ONBOARDING_CHECK_IDS.map((id) => ({ id, status: 'skipped', code: null, checkedAt: null })),
    template: { version: 2, capabilities: ['discovery', 'findings'], outdated: false, checkedAt: NOW },
    discovery: {
      run: {
        id: uuid(2),
        trigger: 'connect',
        status: 'partial',
        requestedAt: NOW,
        startedAt: NOW,
        finishedAt: NOW,
        regions: ['sa-east-1', 'us-east-1'],
        errors: [{ service: 'security_hub', region: 'us-east-1', code: 'AccessDeniedException' }],
        requestedBy: null,
      },
      lastCompletedAt: NOW,
      regions: ['sa-east-1'],
    },
    infrastructure: null,
    sources: [source()],
    updatedAt: NOW,
    ...overrides,
  };
}

describe('onboarding da AWS: enumerações do contrato', () => {
  it('os tipos de fonte, com o método, a capacidade, o que já é coletado e o que é sensível', () => {
    expect(AWS_SOURCE_KINDS).toEqual([
      'cloudtrail',
      'vpc_flow_logs',
      'waf',
      'guardduty_export',
      'guardduty',
      'security_hub',
      'inspector',
      'access_analyzer',
      'cloudwatch_log_group',
      'config',
      'elb_logs',
    ]);
    expect(Object.keys(AWS_SOURCE_KIND_INFO).sort()).toEqual([...AWS_SOURCE_KINDS].sort());
    expect(AWS_SOURCE_METHODS).toEqual(['s3', 'api', 'cloudwatch']);
    for (const kind of AWS_SOURCE_KINDS) {
      const info = AWS_SOURCE_KIND_INFO[kind];
      // A capacidade do papel segue o método: S3, APIs de achados ou grupos com a tag.
      expect(info.capability).toBe(
        { s3: 'service-logs', api: 'findings', cloudwatch: 'log-groups' }[info.method],
      );
    }
    // Só os grupos do CloudWatch Logs são sensíveis; o Config e os logs de load balancer ainda não são coletados.
    expect(AWS_SOURCE_KINDS.filter((kind) => AWS_SOURCE_KIND_INFO[kind].sensitive)).toEqual([
      'cloudwatch_log_group',
    ]);
    expect(AWS_SOURCE_KINDS.filter((kind) => !AWS_SOURCE_KIND_INFO[kind].collectable)).toEqual([
      'config',
      'elb_logs',
    ]);
  });

  it('disponibilidade, permissão, estados da fonte, estados da conta, conferências e a descoberta', () => {
    expect(AWS_SOURCE_AVAILABILITIES).toEqual([
      'available',
      'not_enabled',
      'no_destination',
      'unsupported_destination',
      'unsupported_format',
    ]);
    expect(AWS_SOURCE_PERMISSIONS).toEqual(['granted', 'missing', 'unknown']);
    expect(AWS_SOURCE_STATES).toEqual([
      'available',
      'needs_permission',
      'unavailable',
      'authorized',
      'configuring',
      'waiting_events',
      'collecting',
      'stalled',
      'permission_error',
      'ingestion_error',
      'source_missing',
      'revoked',
    ]);
    expect(AWS_ONBOARDING_STATES).toEqual([
      'not_started',
      'awaiting_authorization',
      'authenticated',
      'discovering',
      'awaiting_sources',
      'configuring',
      'collecting',
      'partial',
      'permission_error',
      'ingestion_failure',
      'disconnected',
      'authorization_timeout',
    ]);
    expect(AWS_ONBOARDING_CHECK_IDS).toEqual([
      'assume_role',
      'identity',
      'template',
      'discovery',
      'permission',
      'collector_config',
      'events',
      'last_sync',
      'lag',
    ]);
    expect(AWS_ONBOARDING_CHECK_STATUSES).toEqual(['ok', 'pending', 'failed', 'skipped']);
    expect(AWS_DISCOVERY_TRIGGERS).toEqual(['connect', 'manual', 'scheduled']);
    expect(AWS_DISCOVERY_STATUSES).toEqual(['pending', 'running', 'succeeded', 'partial', 'failed']);
  });

  it('os estados com a autorização valendo não incluem a fonte sumida nem a revogada', () => {
    for (const state of AWS_SOURCE_STATES) {
      expect(isAwsSourceActiveState(state)).toBe(
        (AWS_SOURCE_ACTIVE_STATES as readonly string[]).includes(state),
      );
    }
    expect(isAwsSourceActiveState('authorized')).toBe(true);
    expect(isAwsSourceActiveState('source_missing')).toBe(false);
    expect(isAwsSourceActiveState('revoked')).toBe(false);
    expect(isAwsSourceActiveState('available')).toBe(false);
  });

  it('as notas são códigos sem repetição, e as de custo cobrem os serviços que a Verax nunca liga', () => {
    expect(new Set(AWS_SOURCE_NOTES).size).toBe(AWS_SOURCE_NOTES.length);
    for (const note of AWS_SOURCE_NOTES) expect(note).toMatch(/^[a-z_]+$/);
    for (const service of ['guardduty', 'security_hub', 'inspector', 'new_trail', 'flow_logs']) {
      expect(AWS_SOURCE_NOTES).toContain(`aws_cost_${service}`);
    }
  });

  it('os nomes exportados não colidem com os que o template v2 traz para o aws-reader', () => {
    // O `export *` do índice quebraria com o mesmo nome em dois módulos.
    for (const name of [
      'AWS_READER_TEMPLATE_VERSION',
      'AWS_READER_CAPABILITIES',
      'AWS_READER_ROLE_TAGS',
      'AWS_READER_CAPABILITIES_SEPARATOR',
      'AWS_LOG_GROUP_TAG',
      'parseReaderRoleTags',
      'prefillReaderTemplate',
    ]) {
      expect(Object.keys(shared)).not.toContain(name);
    }
    expect(shared.AWS_ONBOARDING_CAPABILITIES).toBe(AWS_ONBOARDING_CAPABILITIES);
  });
});

describe('tags do papel: versão do template e capacidades', () => {
  it('a v2 com as capacidades ligadas, na ordem do catálogo; a descoberta está sempre ligada', () => {
    expect(AWS_ONBOARDING_TEMPLATE_VERSION).toBe(2);
    expect(AWS_ONBOARDING_CAPABILITIES).toEqual(['discovery', 'service-logs', 'findings', 'log-groups']);
    // As capacidades vêm separadas por espaço (o valor de uma tag do IAM não aceita vírgula).
    expect(
      awsOnboardingRoleFacts({
        'verax-control:template': '2',
        'verax-control:capabilities': 'discovery service-logs findings log-groups',
      }),
    ).toEqual({ templateVersion: 2, capabilities: ['discovery', 'service-logs', 'findings', 'log-groups'] });
    expect(
      awsOnboardingRoleFacts({
        'verax-control:template': '2',
        'verax-control:capabilities': 'log-groups discovery findings',
      }),
    ).toEqual({ templateVersion: 2, capabilities: ['discovery', 'findings', 'log-groups'] });
    expect(awsOnboardingRoleFacts({ 'verax-control:template': '2' })).toEqual({
      templateVersion: 2,
      capabilities: ['discovery'],
    });
    expect(
      awsOnboardingRoleFacts({ 'verax-control:template': '2', 'verax-control:capabilities': '' }),
    ).toEqual({ templateVersion: 2, capabilities: ['discovery'] });
  });

  it('a lista é lida com folga: espaço, vírgula, tabulação e quebra de linha, em qualquer quantidade', () => {
    for (const listed of [
      'findings,log-groups',
      'findings, log-groups',
      '  findings\tlog-groups  ',
      'findings\nlog-groups',
      'findings ,, log-groups',
    ]) {
      expect(
        awsOnboardingRoleFacts({ 'verax-control:template': '2', 'verax-control:capabilities': listed }),
      ).toEqual({ templateVersion: 2, capabilities: ['discovery', 'findings', 'log-groups'] });
    }
  });

  it('sem a tag da versão (ou fora do formato) é o template v1: só a descoberta', () => {
    const cases: Record<string, string>[] = [
      {},
      { Name: 'verax-control-reader' },
      { 'verax-control:capabilities': 'discovery findings' },
      { 'verax-control:template': '' },
      { 'verax-control:template': 'v2' },
      { 'verax-control:template': '0' },
      { 'verax-control:template': '2.0' },
      // Na v1, as outras capacidades não existem, mesmo que a tag as cite.
      { 'verax-control:template': '1', 'verax-control:capabilities': 'findings' },
    ];
    for (const tags of cases) {
      expect(awsOnboardingRoleFacts(tags)).toEqual({ templateVersion: 1, capabilities: ['discovery'] });
    }
  });

  it('um nome desconhecido na lista é ignorado; uma versão futura é aceita como está', () => {
    expect(
      awsOnboardingRoleFacts({
        'verax-control:template': '3',
        'verax-control:capabilities': 'discovery resposta service-logs __proto__',
      }),
    ).toEqual({ templateVersion: 3, capabilities: ['discovery', 'service-logs'] });
    // Chaves herdadas do protótipo não contam como tag.
    expect(
      awsOnboardingRoleFacts(Object.create({ 'verax-control:template': '2' }) as Record<string, string>),
    ).toEqual({
      templateVersion: 1,
      capabilities: ['discovery'],
    });
  });

  it('desatualizado: versão menor que a deste código; null (ainda não lido) não é', () => {
    expect(isAwsTemplateOutdated(1)).toBe(true);
    expect(isAwsTemplateOutdated(2)).toBe(false);
    expect(isAwsTemplateOutdated(3)).toBe(false);
    expect(isAwsTemplateOutdated(null)).toBe(false);
  });

  it('a tag de leitura do grupo de logs é verax-control = leitura, exata', () => {
    expect(hasAwsLogGroupReadTag({ 'verax-control': 'leitura' })).toBe(true);
    expect(hasAwsLogGroupReadTag({ 'verax-control': 'leitura', ambiente: 'producao' })).toBe(true);
    const cases: (Record<string, string> | undefined)[] = [
      undefined,
      {},
      { 'verax-control': 'Leitura' },
      { 'verax-control': 'leitura ' },
      { 'Verax-Control': 'leitura' },
      { 'verax-control': '' },
    ];
    for (const tags of cases) {
      expect(hasAwsLogGroupReadTag(tags)).toBe(false);
    }
  });
});

describe('fonte: schema estrito', () => {
  it('aceita uma fonte completa e recusa campo a mais, em qualquer nível', () => {
    expect(awsSourceSchema.parse(source())).toEqual(source());
    expect(awsSourceSchema.safeParse({ ...source(), tenantId: uuid(5) }).success).toBe(false);
    expect(
      awsSourceSchema.safeParse({ ...source(), details: { bucket: 'trilha-1', segredo: 'x' } }).success,
    ).toBe(false);
    expect(awsSourceSchema.safeParse({ ...source(), health: { ...source().health, extra: 1 } }).success).toBe(
      false,
    );
    expect(
      awsSourceSchema.safeParse({
        ...source(),
        authorization: { ...source().authorization, authorizedByEmail: 'a@exemplo.com' },
      }).success,
    ).toBe(false);
  });

  it('recusa valor fora das enumerações e região fora do formato', () => {
    for (const patch of [
      { kind: 'route53' },
      { method: 'firehose' },
      { availability: 'enabled' },
      { permission: 'denied' },
      { state: 'active' },
      { origin: 'manual' },
      { loggingState: 'on' },
      { notes: ['custo'] },
      { region: 'brasil' },
      { region: '' },
      { resourceId: '' },
    ]) {
      expect(awsSourceSchema.safeParse({ ...source(), ...patch }).success).toBe(false);
    }
    expect(isAwsSourceRegion('global')).toBe(true);
    expect(isAwsSourceRegion('us-gov-west-1')).toBe(true);
    expect(isAwsSourceRegion('Global')).toBe(false);
  });

  it('o detalhe da permissão é um código do catálogo ou a ação do IAM negada', () => {
    for (const code of AWS_SOURCE_PERMISSION_CODES) expect(isAwsSourcePermissionDetail(code)).toBe(true);
    for (const action of [
      'guardduty:ListFindings',
      'securityhub:GetFindings',
      'access-analyzer:ListFindings',
      'logs:DescribeLogStreams',
      's3:ListBucket',
    ]) {
      expect(isAwsSourcePermissionDetail(action)).toBe(true);
    }
    for (const value of [
      '',
      'AccessDenied: User arn:aws:iam::111111111111:role/x is not authorized',
      'guardduty:*',
      'guardduty:List Findings',
      ':ListFindings',
      'negado',
    ]) {
      expect(isAwsSourcePermissionDetail(value)).toBe(false);
    }
    expect(awsSourceSchema.safeParse({ ...source(), permissionDetail: 'kms_denied' }).success).toBe(true);
    expect(awsSourceSchema.safeParse({ ...source(), permissionDetail: 'mensagem da AWS' }).success).toBe(
      false,
    );
  });

  it('os detalhes só aceitam nomes e configuração no formato; o ID da organização é o-…', () => {
    expect(
      awsSourceDetailsSchema.safeParse({
        bucket: 'trilha-central',
        prefix: 'AWSLogs/o-abcde12345/111111111111/CloudTrail/sa-east-1/',
        organizationTrail: true,
        organizationId: 'o-abcde12345',
        multiRegion: true,
      }).success,
    ).toBe(true);
    expect(awsSourceDetailsSchema.safeParse({ organizationId: '111111111111' }).success).toBe(false);
    expect(awsSourceDetailsSchema.safeParse({ bucket: 'Com_Maiuscula' }).success).toBe(false);
    expect(awsSourceDetailsSchema.safeParse({ storedBytes: -1 }).success).toBe(false);
    expect(awsSourceDetailsSchema.safeParse({ category: 'aplicacao' }).success).toBe(false);
    expect(awsSourceDetailsSchema.safeParse({ webAclScope: 'GLOBAL' }).success).toBe(false);
    expect(
      awsSourceDetailsSchema.safeParse({ regionsChecked: Array.from({ length: 65 }, () => 'sa-east-1') })
        .success,
    ).toBe(false);
  });

  it('o estado de uma fonte não autorizada sai da disponibilidade, do tipo e da permissão', () => {
    expect(awsSourceIdleState('cloudtrail', 'available', 'granted')).toEqual({
      state: 'available',
      stateCode: null,
    });
    expect(awsSourceIdleState('cloudtrail', 'available', 'missing')).toEqual({
      state: 'needs_permission',
      stateCode: null,
    });
    expect(awsSourceIdleState('cloudtrail', 'available', 'unknown')).toEqual({
      state: 'needs_permission',
      stateCode: null,
    });
    for (const availability of AWS_SOURCE_AVAILABILITIES.filter((value) => value !== 'available')) {
      // Mesmo com a permissão concedida, o que não dá para ler de onde está não fica disponível.
      expect(awsSourceIdleState('guardduty', availability, 'granted')).toEqual({
        state: 'unavailable',
        stateCode: availability,
      });
    }
    for (const kind of ['config', 'elb_logs'] as const) {
      expect(awsSourceIdleState(kind, 'available', 'granted')).toEqual({
        state: 'unavailable',
        stateCode: 'not_collectable_yet',
      });
    }
  });
});

describe('descoberta e resposta do onboarding', () => {
  it('a execução recusa campo a mais, serviço desconhecido e erros além do teto', () => {
    const run = onboarding().discovery.run;
    expect(awsDiscoveryRunSchema.parse(run)).toEqual(run);
    expect(awsDiscoveryRunSchema.safeParse({ ...run, summary: {} }).success).toBe(false);
    expect(
      awsDiscoveryRunSchema.safeParse({
        ...run,
        errors: [{ service: 'lambda', region: 'sa-east-1', code: 'AccessDenied' }],
      }).success,
    ).toBe(false);
    expect(
      awsDiscoveryRunSchema.safeParse({
        ...run,
        errors: [{ service: 'ec2', region: 'sa-east-1', code: 'mensagem com espaço' }],
      }).success,
    ).toBe(false);
    const many = Array.from({ length: AWS_DISCOVERY_MAX_ERRORS + 1 }, () => ({
      service: 'ec2' as const,
      region: 'sa-east-1',
      code: 'UnauthorizedOperation',
    }));
    expect(awsDiscoveryRunSchema.safeParse({ ...run, errors: many }).success).toBe(false);
    expect(awsDiscoveryRunSchema.safeParse({ ...run, errors: many.slice(1) }).success).toBe(true);
  });

  it('o retrato da infraestrutura só tem contagens (ou null, quando a leitura foi recusada)', () => {
    const summary = {
      instances: 12,
      publicInstances: 3,
      securityGroups: 18,
      openSecurityGroups: 2,
      buckets: 4,
      publicBuckets: null,
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
    expect(awsInfrastructureSummarySchema.parse(summary)).toEqual(summary);
    expect(awsInfrastructureSummarySchema.safeParse({ ...summary, instances: -1 }).success).toBe(false);
    expect(awsInfrastructureSummarySchema.safeParse({ ...summary, instanceIds: ['i-1'] }).success).toBe(
      false,
    );
    const { trails: _trails, ...missing } = summary;
    expect(awsInfrastructureSummarySchema.safeParse(missing).success).toBe(false);
  });

  it('a resposta do onboarding é estrita, com as nove conferências e o teto de fontes', () => {
    expect(awsOnboardingSchema.parse(onboarding())).toEqual(onboarding());
    expect(awsOnboardingSchema.safeParse({ ...onboarding(), tenantId: uuid(7) }).success).toBe(false);
    expect(awsOnboardingSchema.safeParse({ ...onboarding(), state: 'connected' }).success).toBe(false);
    expect(awsOnboardingSchema.safeParse({ ...onboarding(), credentialMode: 'external_id' }).success).toBe(
      false,
    );
    expect(
      awsOnboardingSchema.safeParse({ ...onboarding(), checks: onboarding().checks.slice(1) }).success,
    ).toBe(false);
    expect(
      awsOnboardingSchema.safeParse({
        ...onboarding(),
        checks: onboarding().checks.map((check) => ({ ...check, message: 'texto livre' })),
      }).success,
    ).toBe(false);
    expect(
      awsOnboardingSchema.safeParse({
        ...onboarding(),
        template: { ...onboarding().template, capabilities: ['discovery', 'resposta'] },
      }).success,
    ).toBe(false);
    const tooMany = Array.from({ length: AWS_MAX_SOURCES_PER_ACCOUNT + 1 }, () => source());
    expect(awsOnboardingSchema.safeParse({ ...onboarding(), sources: tooMany }).success).toBe(false);
  });
});

describe('pedido de autorização', () => {
  it('aceita de 1 a 50 fontes, sem repetir, e a confirmação das sensíveis dentro do pedido', () => {
    expect(awsSourcesAuthorizeSchema.safeParse({ sourceIds: [uuid(1)] }).success).toBe(true);
    expect(
      awsSourcesAuthorizeSchema.safeParse({ sourceIds: [uuid(1), uuid(2)], sensitiveSourceIds: [uuid(2)] })
        .success,
    ).toBe(true);
    const fifty = Array.from({ length: AWS_AUTHORIZE_MAX_SOURCES }, (_, index) => uuid(index + 1));
    expect(awsSourcesAuthorizeSchema.safeParse({ sourceIds: fifty }).success).toBe(true);
    expect(awsSourcesAuthorizeSchema.safeParse({ sourceIds: [...fifty, uuid(99)] }).success).toBe(false);
  });

  it('recusa lista vazia, ID repetido, ID fora do formato, campo a mais e "todas"', () => {
    for (const body of [
      {},
      { sourceIds: [] },
      { sourceIds: [uuid(1), uuid(1)] },
      { sourceIds: ['fonte-1'] },
      { sourceIds: 'all' },
      { all: true },
      { sourceIds: [uuid(1)], all: true },
      { sourceIds: [uuid(1)], kind: 'cloudwatch_log_group' },
      { sourceIds: [uuid(1)], sensitiveSourceIds: [uuid(2)] },
      { sourceIds: [uuid(1)], sensitiveSourceIds: [uuid(1), uuid(1)] },
      { sourceIds: [uuid(1)], sensitiveSourceIds: true },
    ]) {
      expect(awsSourcesAuthorizeSchema.safeParse(body).success).toBe(false);
    }
  });
});
