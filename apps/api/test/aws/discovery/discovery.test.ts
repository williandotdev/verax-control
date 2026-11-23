import {
  AWS_READER_CAPABILITY_ACTIONS,
  awsInfrastructureSummarySchema,
  type AwsSourceDetails,
  awsSourceDetailsSchema,
} from '@verax/shared';
import { describe, expect, it } from 'vitest';
import type { CatalogueContext, DiscoveredSource } from '../../../src/aws/discovery/catalogue.js';
import {
  discoverAccount,
  type DiscoveryResult,
  type DiscoveryTarget,
  DiscoveryUnavailable,
} from '../../../src/aws/discovery/discovery.js';
import { probeInto } from '../../../src/aws/discovery/probes.js';
import { isReadOnlyCommand } from '../../../src/aws/discovery/read-only.js';
import {
  readSource,
  type SourceReading,
  type StoredSource,
} from '../../../src/aws/discovery/source-reading.js';
import { AwsConnectionError } from '../../../src/aws/web-identity.js';
import {
  awsError,
  fakeDiscovery,
  type FakeDiscoveryAccount,
  type FakeDiscoveryCall,
  type Handlers,
} from './fake-discovery.js';

const ACCOUNT = '111111111111';
const NOW = new Date('2026-11-22T12:00:00.000Z');
const TRAIL_ARN = `arn:aws:cloudtrail:sa-east-1:${ACCOUNT}:trail/principal`;
const TRAIL_BUCKET = `trilha-${ACCOUNT}`;

function target(overrides: Partial<DiscoveryTarget> = {}): DiscoveryTarget {
  return {
    accountId: ACCOUNT,
    regions: ['sa-east-1'],
    capabilities: ['discovery', 'service-logs', 'findings', 'log-groups'],
    templateOutdated: false,
    legacyBuckets: { cloudtrail: null, guardduty: null, waf: null },
    ...overrides,
  };
}

async function discover(account: FakeDiscoveryAccount, overrides: Partial<DiscoveryTarget> = {}) {
  const fake = fakeDiscovery(account);
  const result = await discoverAccount(target(overrides), fake.clients, {
    signal: new AbortController().signal,
    now: NOW,
  });
  return { ...fake, result };
}

const find = (
  result: DiscoveryResult,
  kind: string,
  match: (source: DiscoveredSource) => boolean = () => true,
) => result.sources.filter((source) => source.kind === kind && match(source));
const one = (result: DiscoveryResult, kind: string, match?: (source: DiscoveredSource) => boolean) => {
  const [source, ...rest] = find(result, kind, match);
  if (source === undefined || rest.length > 0) throw new Error(`esperava uma fonte ${kind}`);
  return source;
};

/** O prefixo do IAM de cada serviço, quando não é o nome do cliente. */
const IAM_SERVICE: Record<string, string> = {
  accessanalyzer: 'access-analyzer',
  elbv2: 'elasticloadbalancing',
};
/** As operações cuja ação do IAM não tem o nome da operação. */
const IAM_ACTION: Record<string, string> = {
  's3:ListBuckets': 's3:ListAllMyBuckets',
  's3:ListObjectsV2': 's3:ListBucket',
  's3:GetPublicAccessBlock': 's3:GetBucketPublicAccessBlock',
  // As operações V2 do Access Analyzer são cobertas pela ação da V1.
  'access-analyzer:ListFindingsV2': 'access-analyzer:ListFindings',
};

/** A ação do IAM que uma chamada da descoberta exige. */
function iamActionOf(call: FakeDiscoveryCall): string {
  const operation = `${IAM_SERVICE[call.service] ?? call.service}:${call.command.replace(/Command$/, '')}`;
  return IAM_ACTION[operation] ?? operation;
}

/**
 * Toda chamada é de leitura e é uma ação que a política do papel dá (o modelo 2 do template): a descoberta (e a
 * releitura de uma fonte) só chama o que a capacidade `discovery` permite, e cada sondagem, uma ação da capacidade do
 * tipo.
 */
function expectWithinPolicy(calls: readonly FakeDiscoveryCall[]): void {
  const granted: Record<string, readonly string[]> = AWS_READER_CAPABILITY_ACTIONS;
  const probes = new Set(['ListObjectsV2Command', 'GetObjectCommand', 'DescribeLogStreamsCommand']);
  const findings = new Set(['guardduty', 'securityhub', 'inspector2', 'accessanalyzer']);
  for (const call of calls) {
    expect(isReadOnlyCommand({ constructor: { name: call.command } }), call.command).toBe(true);
    const action = iamActionOf(call);
    const isFindingsProbe =
      findings.has(call.service) && /^(ListFindings(V2)?|GetFindings)Command$/.test(call.command);
    const capability = isFindingsProbe
      ? 'findings'
      : call.command === 'DescribeLogStreamsCommand'
        ? 'log-groups'
        : probes.has(call.command)
          ? 'service-logs'
          : 'discovery';
    expect(granted[capability], `${call.service} ${call.command}`).toContain(action);
  }
}

/** A trilha multirregião da conta fictícia, vista por toda região. */
function trailHandlers(overrides: Record<string, unknown> = {}): Handlers {
  return {
    DescribeTrailsCommand: () => ({
      trailList: [
        {
          Name: 'principal',
          TrailARN: TRAIL_ARN,
          HomeRegion: 'sa-east-1',
          S3BucketName: TRAIL_BUCKET,
          IsMultiRegionTrail: true,
          IsOrganizationTrail: false,
          ...overrides,
        },
      ],
    }),
    GetTrailStatusCommand: () => ({ IsLogging: true }),
    GetEventSelectorsCommand: () => ({ EventSelectors: [{ IncludeManagementEvents: true }] }),
  };
}

/** Um S3 com objetos: a listagem devolve uma chave no prefixo pedido. */
function s3WithObjects(overrides: Handlers = {}): Handlers {
  return {
    ListObjectsV2Command: (input) => ({
      Contents: [{ Key: `${typeof input['Prefix'] === 'string' ? input['Prefix'] : ''}objeto.json.gz` }],
    }),
    ...overrides,
  };
}

/** A conta completa: duas regiões, todo serviço ligado em sa-east-1 e quase nada em us-east-1. */
function completeAccount(): FakeDiscoveryAccount {
  return {
    regions: ['sa-east-1', 'us-east-1'],
    handlers: {
      'cloudtrail:*': trailHandlers({
        CloudWatchLogsLogGroupArn: `arn:aws:logs:sa-east-1:${ACCOUNT}:log-group:trilha/principal:*`,
      }),
      'ec2:sa-east-1': {
        DescribeFlowLogsCommand: () => ({
          FlowLogs: [
            {
              FlowLogId: 'fl-0aaa0000000000001',
              ResourceId: 'vpc-0aaa0000000000001',
              TrafficType: 'ALL',
              LogDestinationType: 's3',
              LogDestination: `arn:aws:s3:::rede-${ACCOUNT}`,
              DestinationOptions: { FileFormat: 'plain-text', HiveCompatiblePartitions: false },
            },
            {
              FlowLogId: 'fl-0aaa0000000000002',
              ResourceId: 'vpc-0aaa0000000000002',
              LogDestinationType: 'cloud-watch-logs',
              LogGroupName: '/aws/vpc/fluxo',
            },
          ],
        }),
        DescribeVpcsCommand: () => ({
          Vpcs: [{ VpcId: 'vpc-0aaa0000000000001' }, { VpcId: 'vpc-0aaa0000000000002' }],
        }),
        DescribeInstancesCommand: () => ({
          Reservations: [
            {
              Instances: [
                {
                  InstanceId: 'i-0aaa0000000000001',
                  State: { Name: 'running' },
                  PublicIpAddress: '198.51.100.10',
                },
                { InstanceId: 'i-0aaa0000000000002', State: { Name: 'running' } },
              ],
            },
          ],
        }),
        DescribeSecurityGroupsCommand: () => ({
          SecurityGroups: [
            {
              GroupId: 'sg-0aaa0000000000001',
              IpPermissions: [{ IpProtocol: 'tcp', IpRanges: [{ CidrIp: '0.0.0.0/0' }] }],
            },
            { GroupId: 'sg-0aaa0000000000002', IpPermissions: [] },
          ],
        }),
      },
      'wafv2:sa-east-1': {
        ListWebACLsCommand: () => ({
          WebACLs: [
            {
              Id: 'acl-1',
              Name: 'loja',
              ARN: `arn:aws:wafv2:sa-east-1:${ACCOUNT}:regional/webacl/loja/acl-1`,
            },
          ],
        }),
        ListLoggingConfigurationsCommand: () => ({
          LoggingConfigurations: [
            {
              ResourceArn: `arn:aws:wafv2:sa-east-1:${ACCOUNT}:regional/webacl/loja/acl-1`,
              LogDestinationConfigs: [`arn:aws:s3:::aws-waf-logs-${ACCOUNT}`],
            },
          ],
        }),
      },
      'guardduty:sa-east-1': {
        ListDetectorsCommand: () => ({ DetectorIds: ['det1'] }),
        GetDetectorCommand: () => ({ Status: 'ENABLED' }),
        ListPublishingDestinationsCommand: () => ({
          Destinations: [{ DestinationId: 'dest1', DestinationType: 'S3', Status: 'PUBLISHING' }],
        }),
        DescribePublishingDestinationCommand: () => ({
          Status: 'PUBLISHING',
          DestinationProperties: {
            DestinationArn: `arn:aws:s3:::achados-${ACCOUNT}`,
            KmsKeyArn: `arn:aws:kms:sa-east-1:${ACCOUNT}:key/k1`,
          },
        }),
      },
      'securityhub:sa-east-1': {
        DescribeHubCommand: () => ({ HubArn: `arn:aws:securityhub:sa-east-1:${ACCOUNT}:hub/default` }),
      },
      'inspector2:sa-east-1': {
        BatchGetAccountStatusCommand: () => ({
          accounts: [{ accountId: ACCOUNT, state: { status: 'ENABLED' } }],
        }),
      },
      'accessanalyzer:sa-east-1': {
        ListAnalyzersCommand: () => ({
          analyzers: [
            {
              name: 'externo',
              arn: `arn:aws:access-analyzer:sa-east-1:${ACCOUNT}:analyzer/externo`,
              type: 'ACCOUNT',
              status: 'ACTIVE',
            },
          ],
        }),
      },
      'logs:sa-east-1': {
        DescribeLogGroupsCommand: () => ({
          logGroups: [
            {
              logGroupName: '/app/api',
              logGroupArn: `arn:aws:logs:sa-east-1:${ACCOUNT}:log-group:/app/api`,
              storedBytes: 2048,
              retentionInDays: 30,
            },
            {
              logGroupName: '/aws/vpc/fluxo',
              arn: `arn:aws:logs:sa-east-1:${ACCOUNT}:log-group:/aws/vpc/fluxo:*`,
              storedBytes: 4096,
            },
            {
              logGroupName: 'trilha/principal',
              logGroupArn: `arn:aws:logs:sa-east-1:${ACCOUNT}:log-group:trilha/principal`,
              storedBytes: 1024,
              retentionInDays: 90,
            },
          ],
        }),
        // Só o grupo da aplicação tem a tag de leitura.
        ListTagsForResourceCommand: (input) => ({
          tags: String(input['resourceArn']).endsWith(':/app/api')
            ? { 'verax-control': 'leitura' }
            : { time: 'rede' },
        }),
        DescribeLogStreamsCommand: () => ({ logStreams: [] }),
      },
      'config:sa-east-1': {
        DescribeConfigurationRecordersCommand: () => ({ ConfigurationRecorders: [{ name: 'default' }] }),
        DescribeConfigurationRecorderStatusCommand: () => ({
          ConfigurationRecordersStatus: [{ name: 'default', recording: true }],
        }),
        DescribeDeliveryChannelsCommand: () => ({
          DeliveryChannels: [{ name: 'default', s3BucketName: 'config-central' }],
        }),
      },
      'elbv2:sa-east-1': {
        DescribeLoadBalancersCommand: () => ({
          LoadBalancers: [
            {
              LoadBalancerName: 'loja',
              LoadBalancerArn: `arn:aws:elasticloadbalancing:sa-east-1:${ACCOUNT}:loadbalancer/app/loja/a`,
              Scheme: 'internet-facing',
            },
            {
              LoadBalancerName: 'interno',
              LoadBalancerArn: `arn:aws:elasticloadbalancing:sa-east-1:${ACCOUNT}:loadbalancer/app/interno/b`,
              Scheme: 'internal',
            },
          ],
        }),
        DescribeLoadBalancerAttributesCommand: (input) => ({
          Attributes: String(input['LoadBalancerArn']).includes('/loja/')
            ? [
                { Key: 'access_logs.s3.enabled', Value: 'true' },
                { Key: 'access_logs.s3.bucket', Value: 'acessos-loja' },
              ]
            : [{ Key: 'access_logs.s3.enabled', Value: 'false' }],
        }),
      },
      'rds:sa-east-1': {
        DescribeDBInstancesCommand: () => ({
          DBInstances: [
            { DBInstanceIdentifier: 'banco', PubliclyAccessible: true, StorageEncrypted: false },
            { DBInstanceIdentifier: 'replica', PubliclyAccessible: false, StorageEncrypted: true },
          ],
        }),
        DescribeDBClustersCommand: () => ({ DBClusters: [{ DBClusterIdentifier: 'aurora' }] }),
      },
      'guardduty:*': { ListFindingsCommand: () => ({ FindingIds: [] }) },
      'securityhub:*': { GetFindingsCommand: () => ({ Findings: [] }) },
      'inspector2:*': { ListFindingsCommand: () => ({ findings: [] }) },
      'accessanalyzer:*': { ListFindingsV2Command: () => ({ findings: [] }) },
      'iam:global': { GetAccountSummaryCommand: () => ({ SummaryMap: { Users: 7, AccountMFAEnabled: 1 } }) },
      's3:*': s3WithObjects({
        ListBucketsCommand: () => ({
          Buckets: [
            { Name: TRAIL_BUCKET, BucketRegion: 'sa-east-1' },
            { Name: 'site-publico', BucketRegion: 'sa-east-1' },
          ],
        }),
        GetBucketPolicyStatusCommand: (input) => ({
          PolicyStatus: { IsPublic: input['Bucket'] === 'site-publico' },
        }),
        GetBucketAclCommand: () => ({ Grants: [] }),
        GetPublicAccessBlockCommand: () => ({ PublicAccessBlockConfiguration: {} }),
      }),
    },
  };
}

describe('descoberta de uma conta AWS (clientes falsos, sem rede)', () => {
  it('conta completa: uma fonte de cada tipo, com a permissão conferida, o retrato e as regiões', async () => {
    const { result, calls } = await discover(completeAccount());

    expect(result.errors).toEqual([]);
    expect(result.regions).toEqual(['sa-east-1', 'us-east-1']);
    // Só sa-east-1 tem recurso e fonte: us-east-1 está habilitada, mas vazia.
    expect(result.discoveredRegions).toEqual(['sa-east-1']);

    expect(one(result, 'cloudtrail')).toMatchObject({
      region: 'sa-east-1',
      resourceId: TRAIL_ARN,
      availability: 'available',
      loggingState: 'logging',
      permission: 'granted',
      permissionDetail: null,
      details: {
        bucket: TRAIL_BUCKET,
        prefix: `AWSLogs/${ACCOUNT}/CloudTrail/sa-east-1/`,
        managementEvents: true,
      },
    });
    expect(one(result, 'vpc_flow_logs')).toMatchObject({
      resourceId: 'fl-0aaa0000000000001',
      availability: 'available',
      permission: 'granted',
    });
    expect(one(result, 'waf')).toMatchObject({
      region: 'sa-east-1',
      availability: 'available',
      permission: 'granted',
      details: { prefix: `AWSLogs/${ACCOUNT}/WAFLogs/sa-east-1/loja/` },
    });
    expect(one(result, 'guardduty')).toMatchObject({
      resourceId: 'det1',
      availability: 'available',
      permission: 'granted',
      notes: ['recommended'],
    });
    expect(one(result, 'guardduty_export')).toMatchObject({
      resourceId: 'dest1',
      permission: 'granted',
      notes: ['covered_by_api'],
    });
    expect(one(result, 'security_hub')).toMatchObject({ region: 'sa-east-1', permission: 'granted' });
    expect(one(result, 'inspector')).toMatchObject({ region: 'sa-east-1', permission: 'granted' });
    expect(one(result, 'access_analyzer')).toMatchObject({ resourceId: 'externo', permission: 'granted' });
    // Descobertos, ainda não coletados: sem sondagem.
    expect(one(result, 'config')).toMatchObject({
      availability: 'available',
      permission: 'unknown',
      notes: ['not_collected_yet'],
    });
    expect(one(result, 'elb_logs')).toMatchObject({ resourceId: 'loja', permission: 'unknown' });

    // Os grupos: o da aplicação com a tag (lido), o dos flow logs e o da trilha sem a tag.
    const groups = find(result, 'cloudwatch_log_group');
    expect(groups.map((source) => source.resourceId).sort()).toEqual([
      '/app/api',
      '/aws/vpc/fluxo',
      'trilha/principal',
    ]);
    expect(one(result, 'cloudwatch_log_group', (source) => source.resourceId === '/app/api')).toMatchObject({
      permission: 'granted',
      notes: [],
      details: { tagged: true, category: 'other', storedBytes: 2048, retentionDays: 30 },
    });
    expect(
      one(result, 'cloudwatch_log_group', (source) => source.resourceId === '/aws/vpc/fluxo'),
    ).toMatchObject({
      permission: 'missing',
      permissionDetail: 'tag_missing',
      notes: ['tag_required', 'high_volume'],
      details: { tagged: false, category: 'vpc_flow_logs' },
    });
    expect(
      one(result, 'cloudwatch_log_group', (source) => source.resourceId === 'trilha/principal'),
    ).toMatchObject({
      permissionDetail: 'tag_missing',
      details: { category: 'cloudtrail' },
    });

    // Nenhuma linha "desligado": todo serviço existe em alguma região.
    expect(result.sources.filter((source) => source.resourceId === 'none')).toEqual([]);
    for (const source of result.sources) {
      expect(awsSourceDetailsSchema.safeParse(source.details).success, source.kind).toBe(true);
    }

    expect(awsInfrastructureSummarySchema.parse(result.summary)).toEqual({
      instances: 2,
      publicInstances: 1,
      securityGroups: 2,
      openSecurityGroups: 1,
      buckets: 2,
      publicBuckets: 1,
      iamUsers: 7,
      rootMfaEnabled: true,
      rdsInstances: 2,
      rdsPublic: 1,
      rdsUnencrypted: 1,
      rdsClusters: 1,
      loadBalancers: 2,
      internetFacingLoadBalancers: 1,
      vpcs: 2,
      webAcls: 1,
      logGroups: 3,
      trails: 1,
    });

    // Tudo o que saiu é chamada de leitura, e cada uma é uma ação que a política do papel dá.
    expect(calls.length).toBeGreaterThan(40);
    expectWithinPolicy(calls);
    // A trilha multirregião aparece nas duas regiões e é conferida uma vez, na região dela.
    expect(calls.filter((call) => call.command === 'GetTrailStatusCommand')).toHaveLength(1);
    expect(calls.find((call) => call.command === 'GetTrailStatusCommand')?.region).toBe('sa-east-1');
    // O grupo sem a tag não é sondado: só o que tem a tag recebe o DescribeLogStreams.
    expect(
      calls.filter((call) => call.command === 'DescribeLogStreamsCommand').map((call) => call.input),
    ).toEqual([{ logGroupName: '/app/api', limit: 1 }]);
  });

  it('a sondagem do S3 lista o prefixo exato (hoje, ontem, depois o prefixo inteiro) e lê 1 byte do objeto', async () => {
    const { result, calls } = await discover({
      regions: ['sa-east-1'],
      handlers: {
        'cloudtrail:*': trailHandlers(),
        's3:*': {
          // Só o prefixo inteiro tem objeto (a trilha parou de gravar há dias).
          ListObjectsV2Command: (input) => ({
            Contents: /\d{4}\/\d{2}\/\d{2}\/$/.test(String(input['Prefix']))
              ? []
              : [{ Key: `${String(input['Prefix'])}2026/11/01/a.json.gz` }],
          }),
        },
      },
    });
    expect(one(result, 'cloudtrail').permission).toBe('granted');
    const prefix = `AWSLogs/${ACCOUNT}/CloudTrail/sa-east-1/`;
    expect(calls.filter((call) => call.command === 'ListObjectsV2Command').map((call) => call.input)).toEqual(
      [
        { Bucket: TRAIL_BUCKET, MaxKeys: 1, Prefix: `${prefix}2026/11/22/` },
        { Bucket: TRAIL_BUCKET, MaxKeys: 1, Prefix: `${prefix}2026/11/21/` },
        { Bucket: TRAIL_BUCKET, MaxKeys: 1, Prefix: prefix },
      ],
    );
    expect(calls.filter((call) => call.command === 'GetObjectCommand').map((call) => call.input)).toEqual([
      { Bucket: TRAIL_BUCKET, Key: `${prefix}2026/11/01/a.json.gz`, Range: 'bytes=0-0' },
    ]);
  });

  it('bucket sem objeto ainda: a listagem prova a permissão, e nada é lido', async () => {
    const { result, commands } = await discover({
      regions: ['sa-east-1'],
      handlers: { 'cloudtrail:*': trailHandlers() },
    });
    expect(one(result, 'cloudtrail').permission).toBe('granted');
    expect(commands('s3')).not.toContain('GetObjectCommand');
  });

  it('conta sem CloudTrail, GuardDuty, Security Hub, Inspector e Access Analyzer: linhas "desligado" com o aviso de custo', async () => {
    const { result } = await discover({ regions: ['sa-east-1', 'us-east-1'] });
    expect(result.errors).toEqual([]);
    const missing = result.sources.filter((source) => source.resourceId === 'none');
    expect(Object.fromEntries(missing.map((source) => [source.kind, source.notes]))).toEqual({
      cloudtrail: ['aws_cost_new_trail'],
      vpc_flow_logs: ['aws_cost_flow_logs'],
      guardduty: ['aws_cost_guardduty'],
      security_hub: ['aws_cost_security_hub'],
      inspector: ['aws_cost_inspector'],
      access_analyzer: ['aws_cost_access_analyzer'],
    });
    for (const source of missing) {
      expect(source).toMatchObject({
        region: 'global',
        availability: 'not_enabled',
        loggingState: 'disabled',
        permission: 'unknown',
        details: { regionsChecked: ['sa-east-1', 'us-east-1'] },
      });
    }
    // Só as linhas "desligado": nada mais existe na conta.
    expect(result.sources).toHaveLength(6);
    expect(result.discoveredRegions).toEqual([]);
    expect(result.summary).toMatchObject({ trails: 0, instances: 0, logGroups: 0, buckets: 0 });
    // O que foi lido por inteiro: a linha "desligado" pode sair quando o serviço for ligado.
    expect(result.covered).toEqual(
      expect.arrayContaining(['guardduty:global', 'cloudtrail:global', 'cloudtrail:sa-east-1']),
    );
  });

  it('permissão negada em alguns serviços: o resto entra, e o que faltou fica registrado (parcial)', async () => {
    const account = completeAccount();
    account.deny = {
      'securityhub:sa-east-1': awsError('AccessDeniedException', 403),
      'logs:sa-east-1': awsError('AccessDeniedException', 403),
      'rds:*': awsError('AccessDenied', 403),
    };
    const { result } = await discover(account);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        { service: 'security_hub', region: 'sa-east-1', code: 'AccessDeniedException' },
        { service: 'cloudwatch_logs', region: 'sa-east-1', code: 'AccessDeniedException' },
        { service: 'rds', region: 'sa-east-1', code: 'AccessDenied' },
        { service: 'rds', region: 'us-east-1', code: 'AccessDenied' },
      ]),
    );
    // Cada falha uma vez (as duas leituras do RDS na mesma região dão um registro só).
    expect(result.errors).toHaveLength(4);
    // Nenhuma mensagem da AWS no registro.
    expect(JSON.stringify(result.errors)).not.toMatch(/not authorized|detalhe-interno|arn:aws/);

    // O Security Hub de sa-east-1 não foi lido: nem fonte, nem "desligado na conta", nem escopo coberto.
    expect(find(result, 'security_hub')).toEqual([]);
    expect(result.covered).not.toContain('security_hub:sa-east-1');
    expect(result.covered).not.toContain('security_hub:global');
    expect(result.covered).toContain('security_hub:us-east-1');
    // Os grupos listados sumiram, mas os que um serviço alimenta continuam aparecendo, sem a tag conferida.
    const groups = find(result, 'cloudwatch_log_group');
    expect(groups.map((source) => source.resourceId).sort()).toEqual(['/aws/vpc/fluxo', 'trilha/principal']);
    for (const group of groups) {
      expect(group).toMatchObject({ permission: 'unknown', permissionDetail: 'logs:ListTagsForResource' });
    }
    expect(result.covered).not.toContain('cloudwatch_log_group:sa-east-1');
    // O retrato diz o que não foi lido.
    expect(result.summary).toMatchObject({
      rdsInstances: null,
      rdsClusters: null,
      logGroups: 0,
      instances: 2,
    });
    // O resto entrou.
    expect(one(result, 'cloudtrail').permission).toBe('granted');
    expect(one(result, 'guardduty').permission).toBe('granted');
  });

  it('várias regiões, com uma opt-in que recusa a sessão: os erros são daquela região, e as outras entram', async () => {
    const account = completeAccount();
    account.regions = ['sa-east-1', 'us-east-1', 'me-south-1'];
    const refused = awsError('UnrecognizedClientException', 403);
    account.deny = Object.fromEntries(
      [
        'ec2',
        'cloudtrail',
        'guardduty',
        'logs',
        'wafv2',
        'securityhub',
        'inspector2',
        'accessanalyzer',
        'rds',
        'elbv2',
        'config',
      ].map((service) => [
        `${service}:me-south-1`,
        service === 'ec2' ? awsError('AuthFailure', 401) : refused,
      ]),
    );
    const { result } = await discover(account);
    // As regiões habilitadas, em ordem alfabética (como o inventário as lista).
    expect(result.regions).toEqual(['me-south-1', 'sa-east-1', 'us-east-1']);
    expect(new Set(result.errors.map((error) => error.region))).toEqual(new Set(['me-south-1']));
    expect(new Set(result.errors.map((error) => error.service))).toEqual(
      new Set([
        'cloudtrail',
        'flow_logs',
        'ec2',
        'waf',
        'guardduty',
        'security_hub',
        'inspector',
        'access_analyzer',
        'cloudwatch_logs',
        'config',
        'elb',
        'rds',
      ]),
    );
    expect(result.errors.filter((error) => error.service === 'ec2').map((error) => error.code)).toEqual([
      'AuthFailure',
    ]);
    // A conta inteira não fica "desligada" por causa de uma região que não respondeu.
    expect(result.sources.filter((source) => source.resourceId === 'none')).toEqual([]);
    expect(result.covered.filter((scope) => scope.endsWith(':me-south-1'))).toEqual([]);
    expect(result.discoveredRegions).toEqual(['sa-east-1']);
    expect(one(result, 'guardduty').region).toBe('sa-east-1');
  });

  it('o limite de requisições e o tempo esgotado numa leitura também só ficam registrados', async () => {
    const account = completeAccount();
    const timeout = new Error('a chamada foi cancelada');
    timeout.name = 'AbortError';
    account.deny = {
      'inspector2:sa-east-1': awsError('ThrottlingException', 400),
      'config:sa-east-1': timeout,
    };
    const { result } = await discover(account);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        { service: 'inspector', region: 'sa-east-1', code: 'ThrottlingException' },
        { service: 'config', region: 'sa-east-1', code: 'TimeoutError' },
      ]),
    );
    expect(find(result, 'inspector')).toEqual([]);
    expect(one(result, 'cloudtrail').permission).toBe('granted');
  });

  it('DescribeRegions recusado: valem as regiões monitoradas do cadastro, com o registro', async () => {
    const { result, calls } = await discover(
      {
        regions: ['sa-east-1', 'us-east-1', 'eu-west-1'],
        handlers: {
          'ec2:sa-east-1': {
            DescribeRegionsCommand: () => {
              throw awsError('UnauthorizedOperation', 403);
            },
          },
        },
      },
      { regions: ['sa-east-1', 'us-east-1'] },
    );
    expect(result.regions).toEqual(['sa-east-1', 'us-east-1']);
    expect(result.errors).toContainEqual({
      service: 'regions',
      region: 'global',
      code: 'UnauthorizedOperation',
    });
    expect(calls.some((call) => call.region === 'eu-west-1')).toBe(false);
  });
});

describe('sondagens de permissão', () => {
  it('bucket cifrado com KMS que o papel não decifra: kms_denied', async () => {
    const kms = Object.assign(
      new Error('User is not authorized to perform: kms:Decrypt on resource (detalhe)'),
      {
        $metadata: { httpStatusCode: 403 },
      },
    );
    kms.name = 'AccessDenied';
    const { result } = await discover({
      regions: ['sa-east-1'],
      handlers: {
        'cloudtrail:*': trailHandlers({ KmsKeyId: `arn:aws:kms:sa-east-1:${ACCOUNT}:key/k1` }),
        's3:*': s3WithObjects({
          GetObjectCommand: () => {
            throw kms;
          },
        }),
      },
    });
    expect(one(result, 'cloudtrail')).toMatchObject({
      permission: 'missing',
      permissionDetail: 'kms_denied',
    });
    // O erro com o nome do KMS, como o S3 também responde.
    const named = await discover({
      regions: ['sa-east-1'],
      handlers: {
        'cloudtrail:*': trailHandlers(),
        's3:*': s3WithObjects({
          GetObjectCommand: () => {
            throw awsError('KMS.DisabledException', 400);
          },
        }),
      },
    });
    expect(one(named.result, 'cloudtrail').permissionDetail).toBe('kms_denied');
  });

  it('a listagem negada, o bucket que não existe e o objeto negado sem ser pela chave', async () => {
    const cases: [Handlers, string][] = [
      [
        {
          ListObjectsV2Command: () => {
            throw awsError('AccessDenied', 403);
          },
        },
        'bucket_denied',
      ],
      [
        {
          ListObjectsV2Command: () => {
            throw awsError('NoSuchBucket', 404);
          },
        },
        'bucket_missing',
      ],
      [
        s3WithObjects({
          GetObjectCommand: () => {
            throw awsError('AccessDenied', 403);
          },
        }),
        's3:GetObject',
      ],
    ];
    for (const [s3, detail] of cases) {
      const { result } = await discover({
        regions: ['sa-east-1'],
        handlers: { 'cloudtrail:*': trailHandlers(), 's3:*': s3 },
      });
      expect(one(result, 'cloudtrail')).toMatchObject({ permission: 'missing', permissionDetail: detail });
    }
    // Uma falha passageira não diz nada sobre a permissão.
    const { result } = await discover({
      regions: ['sa-east-1'],
      handlers: {
        'cloudtrail:*': trailHandlers(),
        's3:*': {
          ListObjectsV2Command: () => {
            throw awsError('SlowDown', 503);
          },
        },
      },
    });
    expect(one(result, 'cloudtrail')).toMatchObject({
      permission: 'unknown',
      permissionDetail: 'probe_failed',
    });
  });

  it('trilha de organização: o ID da organização sai dos nomes de AWSLogs/, e a sondagem usa o caminho com ele', async () => {
    const { result, calls } = await discover({
      regions: ['sa-east-1'],
      handlers: {
        'cloudtrail:*': trailHandlers({ IsOrganizationTrail: true, S3BucketName: 'trilha-central' }),
        's3:*': {
          ListObjectsV2Command: (input) =>
            input['Delimiter'] === '/'
              ? { CommonPrefixes: [{ Prefix: 'AWSLogs/222222222222/' }, { Prefix: 'AWSLogs/o-abcde12345/' }] }
              : { Contents: [{ Key: `${String(input['Prefix'])}a.json.gz` }] },
        },
      },
    });
    expect(one(result, 'cloudtrail')).toMatchObject({
      permission: 'granted',
      notes: ['central_bucket'],
      details: {
        organizationTrail: true,
        organizationId: 'o-abcde12345',
        prefix: `AWSLogs/o-abcde12345/${ACCOUNT}/CloudTrail/sa-east-1/`,
      },
    });
    const listings = calls
      .filter((call) => call.command === 'ListObjectsV2Command')
      .map((call) => call.input);
    // Primeiro os nomes do primeiro nível (sem objeto nenhum), depois o prefixo da conta dentro da organização.
    expect(listings[0]).toEqual({
      Bucket: 'trilha-central',
      Prefix: 'AWSLogs/',
      Delimiter: '/',
      MaxKeys: 50,
    });
    expect(listings[1]).toMatchObject({
      Prefix: `AWSLogs/o-abcde12345/${ACCOUNT}/CloudTrail/sa-east-1/2026/11/22/`,
    });
  });

  it('trilha de organização num bucket central que não cita o papel: bucket_denied, sem o ID da organização', async () => {
    const { result } = await discover({
      regions: ['sa-east-1'],
      handlers: {
        'cloudtrail:*': trailHandlers({ IsOrganizationTrail: true, S3BucketName: 'trilha-central' }),
      },
      deny: { 's3:*': awsError('AccessDenied', 403) },
    });
    const source = one(result, 'cloudtrail');
    expect(source).toMatchObject({ permission: 'missing', permissionDetail: 'bucket_denied' });
    expect(source.details.organizationId).toBeUndefined();
    // A listagem dos buckets da conta também foi negada: fica registrada.
    expect(result.errors).toContainEqual({ service: 's3', region: 'global', code: 'AccessDenied' });
  });

  it('prefixo antes de AWSLogs: fora do que o papel lê, sem chamar o S3; no bucket do cadastro, é sondado', async () => {
    const account: FakeDiscoveryAccount = {
      regions: ['sa-east-1'],
      handlers: { 'cloudtrail:*': trailHandlers({ S3KeyPrefix: 'auditoria' }), 's3:*': s3WithObjects() },
    };
    const outside = await discover(account);
    expect(one(outside.result, 'cloudtrail')).toMatchObject({
      availability: 'available',
      permission: 'missing',
      permissionDetail: 'outside_awslogs_prefix',
      notes: ['additional_bucket_required'],
    });
    expect(outside.commands('s3')).not.toContain('ListObjectsV2Command');

    const legacy = await discover(account, {
      legacyBuckets: { cloudtrail: TRAIL_BUCKET, guardduty: null, waf: null },
    });
    expect(one(legacy.result, 'cloudtrail')).toMatchObject({
      permission: 'granted',
      notes: ['covered_by_legacy'],
    });
    expect(legacy.calls.find((call) => call.command === 'ListObjectsV2Command')?.input).toMatchObject({
      Prefix: `auditoria/AWSLogs/${ACCOUNT}/CloudTrail/sa-east-1/2026/11/22/`,
    });
  });

  it('flow logs com partições do Hive e para o Firehose: indisponíveis, sem sondagem', async () => {
    const { result, commands } = await discover({
      regions: ['sa-east-1'],
      handlers: {
        'ec2:sa-east-1': {
          DescribeFlowLogsCommand: () => ({
            FlowLogs: [
              {
                FlowLogId: 'fl-hive',
                LogDestinationType: 's3',
                LogDestination: `arn:aws:s3:::rede-${ACCOUNT}`,
                DestinationOptions: { FileFormat: 'plain-text', HiveCompatiblePartitions: true },
              },
              {
                FlowLogId: 'fl-firehose',
                LogDestinationType: 'kinesis-data-firehose',
                LogDestination: `arn:aws:firehose:sa-east-1:${ACCOUNT}:deliverystream/fluxo`,
              },
            ],
          }),
        },
      },
    });
    expect(one(result, 'vpc_flow_logs', (source) => source.resourceId === 'fl-hive')).toMatchObject({
      availability: 'unsupported_format',
      permission: 'unknown',
      permissionDetail: null,
    });
    expect(one(result, 'vpc_flow_logs', (source) => source.resourceId === 'fl-firehose')).toMatchObject({
      availability: 'unsupported_destination',
      permission: 'unknown',
    });
    expect(commands('s3')).not.toContain('ListObjectsV2Command');
    // Há flow logs na conta: nada de linha "desligado".
    expect(find(result, 'vpc_flow_logs', (source) => source.resourceId === 'none')).toEqual([]);
  });

  it('WAF: no S3 por Web ACL (regional e do CloudFront), no Firehose, no CloudWatch Logs e sem logging', async () => {
    const arn = (name: string, scope = 'regional') =>
      `arn:aws:wafv2:us-east-1:${ACCOUNT}:${scope}/webacl/${name}/id-${name}`;
    const { result } = await discover({
      regions: ['us-east-1'],
      handlers: {
        'wafv2:us-east-1': {
          ListWebACLsCommand: (input) => ({
            WebACLs:
              input['Scope'] === 'CLOUDFRONT'
                ? [{ Id: 'id-site', Name: 'site', ARN: arn('site', 'global') }]
                : ['s3', 'firehose', 'logs', 'mudo'].map((name) => ({
                    Id: `id-${name}`,
                    Name: name,
                    ARN: arn(name),
                  })),
          }),
          ListLoggingConfigurationsCommand: (input) => ({
            LoggingConfigurations:
              input['Scope'] === 'CLOUDFRONT'
                ? [
                    {
                      ResourceArn: arn('site', 'global'),
                      LogDestinationConfigs: [`arn:aws:s3:::aws-waf-logs-site`],
                    },
                  ]
                : [
                    { ResourceArn: arn('s3'), LogDestinationConfigs: ['arn:aws:s3:::aws-waf-logs-loja'] },
                    {
                      ResourceArn: arn('firehose'),
                      LogDestinationConfigs: [
                        `arn:aws:firehose:us-east-1:${ACCOUNT}:deliverystream/aws-waf-logs-x`,
                      ],
                    },
                    {
                      ResourceArn: arn('logs'),
                      LogDestinationConfigs: [
                        `arn:aws:logs:us-east-1:${ACCOUNT}:log-group:aws-waf-logs-grupo`,
                      ],
                    },
                  ],
          }),
        },
        's3:*': s3WithObjects(),
      },
    });
    const byName = Object.fromEntries(find(result, 'waf').map((source) => [source.name, source]));
    expect(Object.keys(byName).sort()).toEqual(['firehose', 'mudo', 's3', 'site']);
    expect(byName['s3']).toMatchObject({
      region: 'us-east-1',
      availability: 'available',
      permission: 'granted',
      details: { prefix: `AWSLogs/${ACCOUNT}/WAFLogs/us-east-1/s3/` },
    });
    expect(byName['site']).toMatchObject({
      region: 'global',
      availability: 'available',
      permission: 'granted',
      details: { webAclScope: 'CLOUDFRONT', prefix: `AWSLogs/${ACCOUNT}/WAFLogs/cloudfront/site/` },
    });
    expect(byName['firehose']).toMatchObject({
      availability: 'unsupported_destination',
      permission: 'unknown',
    });
    expect(byName['mudo']).toMatchObject({ availability: 'no_destination', notes: ['aws_cost_waf_logging'] });
    // A Web ACL que grava no CloudWatch Logs aparece pelo grupo dela.
    expect(one(result, 'cloudwatch_log_group')).toMatchObject({
      region: 'us-east-1',
      resourceId: 'aws-waf-logs-grupo',
      details: { category: 'waf' },
    });
    expect(result.covered).toEqual(expect.arrayContaining(['waf:us-east-1', 'waf:global']));
  });

  it('as tags negadas: uma recusa basta para parar, os grupos ficam sem conferir e nenhum é lido', async () => {
    const names = Array.from({ length: 12 }, (_, index) => `/app/servico-${index}`);
    const { result, calls } = await discover({
      regions: ['sa-east-1'],
      handlers: {
        'logs:sa-east-1': {
          DescribeLogGroupsCommand: () => ({
            logGroups: names.map((logGroupName) => ({
              logGroupName,
              logGroupArn: `arn:aws:logs:sa-east-1:${ACCOUNT}:log-group:${logGroupName}`,
            })),
          }),
          ListTagsForResourceCommand: () => {
            throw awsError('AccessDeniedException', 403);
          },
        },
      },
    });
    const groups = find(result, 'cloudwatch_log_group');
    expect(groups).toHaveLength(12);
    for (const group of groups) {
      expect(group).toMatchObject({ permission: 'unknown', permissionDetail: 'logs:ListTagsForResource' });
      expect(group.details.tagged).toBeUndefined();
    }
    expect(result.errors).toEqual([
      { service: 'cloudwatch_logs', region: 'sa-east-1', code: 'AccessDeniedException' },
    ]);
    // No máximo as chamadas que já estavam em curso quando a primeira recusa chegou.
    expect(calls.filter((call) => call.command === 'ListTagsForResourceCommand').length).toBeLessThanOrEqual(
      4,
    );
    expect(calls.some((call) => call.command === 'DescribeLogStreamsCommand')).toBe(false);
  });

  it('o grupo com a tag que o papel não lê: a ação que faltou', async () => {
    const { result } = await discover({
      regions: ['sa-east-1'],
      handlers: {
        'logs:sa-east-1': {
          DescribeLogGroupsCommand: () => ({
            logGroups: [
              {
                logGroupName: '/app/api',
                logGroupArn: `arn:aws:logs:sa-east-1:${ACCOUNT}:log-group:/app/api`,
              },
            ],
          }),
          ListTagsForResourceCommand: () => ({ tags: { 'verax-control': 'leitura' } }),
          DescribeLogStreamsCommand: () => {
            throw awsError('AccessDeniedException', 403);
          },
        },
      },
    });
    expect(one(result, 'cloudwatch_log_group')).toMatchObject({
      permission: 'missing',
      permissionDetail: 'logs:DescribeLogStreams',
    });
  });

  it('capacidade desligada no papel (ou o template v1, que só tem a descoberta): sem sondagem, com a nota de atualizar a pilha', async () => {
    const account = completeAccount();
    const { result, calls } = await discover(account, {
      capabilities: ['discovery'],
      templateOutdated: true,
    });
    for (const kind of [
      'cloudtrail',
      'vpc_flow_logs',
      'waf',
      'guardduty_export',
      'guardduty',
      'security_hub',
      'inspector',
      'access_analyzer',
    ]) {
      const source = one(result, kind);
      expect(source, kind).toMatchObject({ permission: 'missing', permissionDetail: 'capability_off' });
      expect(source.notes, kind).toContain('stack_update_required');
    }
    for (const group of find(result, 'cloudwatch_log_group')) {
      expect(group).toMatchObject({ permission: 'missing', permissionDetail: 'capability_off' });
    }
    // Sem a API de achados, o export do GuardDuty não está "coberto pela API".
    expect(one(result, 'guardduty_export').notes).not.toContain('covered_by_api');
    const commands = new Set(calls.map((call) => call.command));
    for (const command of [
      'ListObjectsV2Command',
      'GetObjectCommand',
      'ListFindingsCommand',
      'GetFindingsCommand',
      'ListFindingsV2Command',
      'ListTagsForResourceCommand',
      'DescribeLogStreamsCommand',
    ]) {
      expect(commands.has(command), command).toBe(false);
    }
  });

  it('no template v1, a fonte no bucket do cadastro continua sondada (a pilha cita o bucket)', async () => {
    const { result, commands } = await discover(
      { regions: ['sa-east-1'], handlers: { 'cloudtrail:*': trailHandlers(), 's3:*': s3WithObjects() } },
      {
        capabilities: ['discovery'],
        templateOutdated: true,
        legacyBuckets: { cloudtrail: TRAIL_BUCKET, guardduty: null, waf: null },
      },
    );
    expect(one(result, 'cloudtrail')).toMatchObject({ permission: 'granted', notes: ['covered_by_legacy'] });
    expect(commands('s3')).toContain('GetObjectCommand');
  });

  it('as tags do papel ainda não lidas (capacidades desconhecidas): tudo é sondado, e a recusa diz a ação que faltou', async () => {
    const account = completeAccount();
    account.handlers = {
      ...account.handlers,
      'guardduty:*': {
        ListFindingsCommand: () => {
          throw awsError('AccessDeniedException', 403);
        },
      },
      'securityhub:*': {
        GetFindingsCommand: () => {
          throw awsError('AccessDeniedException', 403);
        },
      },
      'inspector2:*': {
        ListFindingsCommand: () => {
          throw awsError('AccessDeniedException', 403);
        },
      },
      'accessanalyzer:*': {
        ListFindingsV2Command: () => {
          throw awsError('AccessDeniedException', 403);
        },
      },
    };
    const { result } = await discover(account, { capabilities: null });
    expect(
      Object.fromEntries(
        ['guardduty', 'security_hub', 'inspector', 'access_analyzer'].map((kind) => [
          kind,
          [one(result, kind).permission, one(result, kind).permissionDetail],
        ]),
      ),
    ).toEqual({
      guardduty: ['missing', 'guardduty:ListFindings'],
      security_hub: ['missing', 'securityhub:GetFindings'],
      inspector: ['missing', 'inspector2:ListFindings'],
      access_analyzer: ['missing', 'access-analyzer:ListFindings'],
    });
    // A ação que a sondagem diz faltar é uma das que a capacidade de achados dá no template.
    for (const kind of ['guardduty', 'security_hub', 'inspector', 'access_analyzer']) {
      expect(AWS_READER_CAPABILITY_ACTIONS.findings).toContain(one(result, kind).permissionDetail);
    }
    // Sem saber a versão do template, a nota de atualizar a pilha não aparece: só a ação que faltou.
    expect(one(result, 'guardduty').notes).toEqual(['recommended']);
    expect(one(result, 'cloudtrail')).toMatchObject({ permission: 'granted', notes: [] });
    // Sem saber as capacidades, o export não é dado como coberto pela API.
    expect(one(result, 'guardduty_export').notes).not.toContain('covered_by_api');
  });
});

describe('o que para a descoberta inteira', () => {
  it('nada lido (tudo recusado): DiscoveryUnavailable, sem resultado', async () => {
    const denied = awsError('AccessDenied', 403);
    const fake = fakeDiscovery({
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
    await expect(
      discoverAccount(target(), fake.clients, { signal: new AbortController().signal, now: NOW }),
    ).rejects.toThrow(DiscoveryUnavailable);
  });

  it('a sessão que caiu no meio sobe como erro de conexão (não vira registro)', async () => {
    const fake = fakeDiscovery({
      regions: ['sa-east-1'],
      deny: { 'cloudtrail:sa-east-1': new AwsConnectionError('trust_denied', true) },
    });
    await expect(
      discoverAccount(target(), fake.clients, { signal: new AbortController().signal, now: NOW }),
    ).rejects.toMatchObject({ code: 'trust_denied' });
  });

  it('o sinal abortado interrompe a execução', async () => {
    const controller = new AbortController();
    const fake = fakeDiscovery({
      regions: ['sa-east-1'],
      handlers: {
        'cloudtrail:sa-east-1': {
          DescribeTrailsCommand: () => {
            controller.abort(new DOMException('o worker está parando', 'AbortError'));
            throw awsError('AccessDenied', 403);
          },
        },
      },
    });
    await expect(
      discoverAccount(target(), fake.clients, { signal: controller.signal, now: NOW }),
    ).rejects.toThrow();
  });
});

describe('a releitura de uma fonte ("Tentar de novo"): vale o que a AWS diz agora, e não o que foi gravado', () => {
  const signal = new AbortController().signal;
  const GROUP_ARN = `arn:aws:logs:sa-east-1:${ACCOUNT}:log-group:/app/api`;
  const ACL_ARN = `arn:aws:wafv2:sa-east-1:${ACCOUNT}:regional/webacl/loja/acl-1`;

  const contextOf = (overrides: Partial<CatalogueContext> = {}): CatalogueContext => ({
    accountId: ACCOUNT,
    legacyBuckets: { cloudtrail: null, guardduty: null, waf: null },
    capabilities: ['discovery', 'service-logs', 'findings', 'log-groups'],
    ...overrides,
  });

  /** Lê a fonte de novo e, achada, sonda a permissão: o que a tarefa faz no "Tentar de novo". */
  async function recheck(
    account: FakeDiscoveryAccount,
    stored: StoredSource,
    overrides: Partial<CatalogueContext> = {},
  ) {
    const fake = fakeDiscovery(account);
    const context = contextOf(overrides);
    const reading = await readSource(stored, context, fake.clients, signal);
    if (reading.status === 'found') {
      await probeInto(reading.source, context, fake.clients, { signal, now: NOW, templateOutdated: false });
    }
    return { ...fake, reading };
  }

  const foundOf = (reading: SourceReading): DiscoveredSource => {
    if (reading.status !== 'found') throw new Error(`esperava a fonte, veio ${reading.status}`);
    return reading.source;
  };

  /** Uma conta só com o grupo `/app/api` (e outro com o mesmo começo de nome), com as tags dadas. */
  const groupAccount = (
    tags: Record<string, string> | Error,
    extra: Handlers = {},
  ): FakeDiscoveryAccount => ({
    regions: ['sa-east-1'],
    handlers: {
      'logs:sa-east-1': {
        DescribeLogGroupsCommand: () => ({
          logGroups: [
            { logGroupName: '/app/api', logGroupArn: GROUP_ARN, storedBytes: 2048, retentionInDays: 30 },
            { logGroupName: '/app/api-interna', logGroupArn: `${GROUP_ARN}-interna` },
          ],
        }),
        ListTagsForResourceCommand: () => {
          if (tags instanceof Error) throw tags;
          return { tags };
        },
        DescribeLogStreamsCommand: () => ({ logStreams: [] }),
        ...extra,
      },
    },
  });
  const storedGroup = (details: AwsSourceDetails = {}): StoredSource => ({
    kind: 'cloudwatch_log_group',
    region: 'sa-east-1',
    resourceId: '/app/api',
    details: { logGroup: '/app/api', category: 'other', ...details },
  });
  const storedAcl = (details: AwsSourceDetails = {}, region = 'sa-east-1'): StoredSource => ({
    kind: 'waf',
    region,
    resourceId: 'acl-1',
    details: { webAclName: 'loja', ...details },
  });
  const aclAccount = (destinations: string[] | null): FakeDiscoveryAccount => ({
    regions: ['sa-east-1'],
    handlers: {
      'wafv2:sa-east-1': {
        ListWebACLsCommand: () => ({ WebACLs: [{ Id: 'acl-1', Name: 'loja', ARN: ACL_ARN }] }),
        ListLoggingConfigurationsCommand: () => ({
          LoggingConfigurations:
            destinations === null ? [] : [{ ResourceArn: ACL_ARN, LogDestinationConfigs: destinations }],
        }),
      },
      's3:*': s3WithObjects(),
    },
  });

  it('conta completa: cada fonte relida e sondada sozinha dá o mesmo que a descoberta, só com ações que a política dá', async () => {
    const { result } = await discover(completeAccount());
    expect(result.sources.map((source) => source.kind).sort()).toEqual([
      'access_analyzer',
      'cloudtrail',
      'cloudwatch_log_group',
      'cloudwatch_log_group',
      'cloudwatch_log_group',
      'config',
      'elb_logs',
      'guardduty',
      'guardduty_export',
      'inspector',
      'security_hub',
      'vpc_flow_logs',
      'waf',
    ]);
    for (const source of result.sources) {
      const label = `${source.kind} ${source.resourceId}`;
      // Do que está gravado, só a identidade (e a categoria do grupo de logs) é aproveitada.
      const { reading, calls } = await recheck(completeAccount(), {
        kind: source.kind,
        region: source.region,
        resourceId: source.resourceId,
        details: source.kind === 'cloudwatch_log_group' ? { category: source.details.category } : {},
      });
      expect(foundOf(reading), label).toEqual(source);
      expect(calls.length, label).toBeGreaterThan(0);
      expectWithinPolicy(calls);
    }
  });

  it('grupo de logs: a tag é lida de novo; o cliente pôs a tag, e a leitura é sondada e concedida', async () => {
    // A AWS confirma o que está gravado: sem a tag, nada é sondado.
    const before = await recheck(groupAccount({ time: 'rede' }), storedGroup({ tagged: false }));
    expect(foundOf(before.reading)).toMatchObject({
      permission: 'missing',
      permissionDetail: 'tag_missing',
      details: { tagged: false },
    });
    expect(foundOf(before.reading).notes).toContain('tag_required');
    expect(before.commands('logs')).toEqual(['DescribeLogGroupsCommand', 'ListTagsForResourceCommand']);

    // O cliente pôs a tag. O gravado ainda diz "sem a tag", e não decide nada.
    const after = await recheck(groupAccount({ 'verax-control': 'leitura' }), storedGroup({ tagged: false }));
    expect(foundOf(after.reading)).toMatchObject({
      permission: 'granted',
      permissionDetail: null,
      details: { tagged: true, storedBytes: 2048, retentionDays: 30 },
    });
    expect(foundOf(after.reading).notes).not.toContain('tag_required');
    expect(after.calls.map((call) => [call.command, call.input])).toEqual([
      ['DescribeLogGroupsCommand', { logGroupNamePrefix: '/app/api', limit: 50 }],
      ['ListTagsForResourceCommand', { resourceArn: GROUP_ARN }],
      ['DescribeLogStreamsCommand', { logGroupName: '/app/api', limit: 1 }],
    ]);

    // E o contrário: o gravado diz "com a tag", mas ela foi tirada do grupo.
    const removed = await recheck(groupAccount({}), storedGroup({ tagged: true }));
    expect(foundOf(removed.reading)).toMatchObject({
      permission: 'missing',
      permissionDetail: 'tag_missing',
      details: { tagged: false },
    });
    expect(removed.commands('logs')).not.toContain('DescribeLogStreamsCommand');
  });

  it('grupo de logs: a leitura das tags negada é a permissão que falta (a ação), e não a tag', async () => {
    for (const tagged of [false, true]) {
      const { reading, commands } = await recheck(
        groupAccount(awsError('AccessDeniedException', 403)),
        storedGroup({ tagged }),
      );
      const source = foundOf(reading);
      expect(source).toMatchObject({ permission: 'missing', permissionDetail: 'logs:ListTagsForResource' });
      // O que estava gravado da tag não vale mais: ela ficou desconhecida.
      expect(source.details.tagged).toBeUndefined();
      expect(source.notes).toContain('tag_required');
      expect(commands('logs')).toEqual(['DescribeLogGroupsCommand', 'ListTagsForResourceCommand']);
    }
  });

  it('grupo de logs: com a tag e a leitura negada, a ação que faltou; uma falha passageira nas tags não vira resposta', async () => {
    const denied = await recheck(
      groupAccount(
        { 'verax-control': 'leitura' },
        {
          DescribeLogStreamsCommand: () => {
            throw awsError('AccessDeniedException', 403);
          },
        },
      ),
      storedGroup({ tagged: false }),
    );
    expect(foundOf(denied.reading)).toMatchObject({
      permission: 'missing',
      permissionDetail: 'logs:DescribeLogStreams',
      details: { tagged: true },
    });
    await expect(
      recheck(groupAccount(awsError('ThrottlingException', 400)), storedGroup({ tagged: false })),
    ).rejects.toMatchObject({ name: 'ThrottlingException' });
    await expect(
      recheck(
        groupAccount(
          {},
          { DescribeLogGroupsCommand: () => Promise.reject(awsError('AccessDeniedException', 403)) },
        ),
        storedGroup({ tagged: false }),
      ),
    ).rejects.toMatchObject({ name: 'AccessDeniedException' });
  });

  it('grupo de logs: o apagado está ausente; com a capacidade dos grupos desligada, nem a tag é lida', async () => {
    const gone = await recheck(
      {
        regions: ['sa-east-1'],
        handlers: {
          'logs:sa-east-1': {
            DescribeLogGroupsCommand: () => ({
              logGroups: [{ logGroupName: '/app/api-interna', logGroupArn: `${GROUP_ARN}-interna` }],
            }),
          },
        },
      },
      storedGroup({ tagged: true }),
    );
    expect(gone.reading).toEqual({ status: 'absent' });
    expect(gone.commands('logs')).toEqual(['DescribeLogGroupsCommand']);

    const off = await recheck(groupAccount({ 'verax-control': 'leitura' }), storedGroup({ tagged: true }), {
      capabilities: ['discovery'],
    });
    expect(foundOf(off.reading)).toMatchObject({ permission: 'missing', permissionDetail: 'capability_off' });
    expect(foundOf(off.reading).notes).toContain('stack_update_required');
    expect(off.commands('logs')).toEqual(['DescribeLogGroupsCommand']);
  });

  it('Web ACL: o destino do log é lido de novo (do Firehose para o S3, para outro bucket, para o CloudWatch Logs, sem log)', async () => {
    // Gravado: o log ia para o Firehose. Agora vai para um bucket.
    const firehose = { destinationType: 'firehose' as const };
    const toBucket = await recheck(aclAccount([`arn:aws:s3:::aws-waf-logs-${ACCOUNT}`]), storedAcl(firehose));
    expect(foundOf(toBucket.reading)).toMatchObject({
      availability: 'available',
      loggingState: 'logging',
      permission: 'granted',
      details: {
        destinationType: 's3',
        bucket: `aws-waf-logs-${ACCOUNT}`,
        prefix: `AWSLogs/${ACCOUNT}/WAFLogs/sa-east-1/loja/`,
      },
    });
    expectWithinPolicy(toBucket.calls);

    // Gravado: um bucket. Agora é outro, e é o novo que é sondado.
    const moved = await recheck(
      aclAccount([`arn:aws:s3:::aws-waf-logs-novo-${ACCOUNT}`]),
      storedAcl({ destinationType: 's3', bucket: `aws-waf-logs-${ACCOUNT}` }),
    );
    expect(foundOf(moved.reading).details.bucket).toBe(`aws-waf-logs-novo-${ACCOUNT}`);
    expect(
      new Set(moved.calls.filter((call) => call.service === 's3').map((call) => call.input['Bucket'])),
    ).toEqual(new Set([`aws-waf-logs-novo-${ACCOUNT}`]));

    // Para o Firehose: indisponível, sem sondagem. Sem log: sem destino.
    const toFirehose = await recheck(
      aclAccount([`arn:aws:firehose:sa-east-1:${ACCOUNT}:deliverystream/aws-waf-logs-x`]),
      storedAcl({ destinationType: 's3', bucket: `aws-waf-logs-${ACCOUNT}` }),
    );
    expect(foundOf(toFirehose.reading)).toMatchObject({
      availability: 'unsupported_destination',
      permission: 'unknown',
      permissionDetail: null,
    });
    expect(toFirehose.commands('s3')).toEqual([]);
    expect(foundOf((await recheck(aclAccount(null), storedAcl())).reading)).toMatchObject({
      availability: 'no_destination',
      loggingState: 'disabled',
    });

    // Para o CloudWatch Logs, a fonte vira um grupo de logs (outra linha); a Web ACL apagada também some daqui.
    const toGroup = await recheck(
      aclAccount([`arn:aws:logs:sa-east-1:${ACCOUNT}:log-group:aws-waf-logs-grupo`]),
      storedAcl(),
    );
    expect(toGroup.reading).toEqual({ status: 'absent' });
    expect((await recheck({ regions: ['sa-east-1'] }, storedAcl())).reading).toEqual({ status: 'absent' });

    // A Web ACL do CloudFront é lida em us-east-1, no escopo dela.
    const cloudfront = await recheck(
      {
        regions: ['sa-east-1'],
        handlers: {
          'wafv2:us-east-1': {
            ListWebACLsCommand: (input) => ({
              WebACLs: input['Scope'] === 'CLOUDFRONT' ? [{ Id: 'acl-1', Name: 'loja', ARN: ACL_ARN }] : [],
            }),
            ListLoggingConfigurationsCommand: () => ({
              LoggingConfigurations: [
                { ResourceArn: ACL_ARN, LogDestinationConfigs: [`arn:aws:s3:::aws-waf-logs-${ACCOUNT}`] },
              ],
            }),
          },
          's3:*': s3WithObjects(),
        },
      },
      storedAcl({}, 'global'),
    );
    expect(foundOf(cloudfront.reading)).toMatchObject({
      region: 'global',
      permission: 'granted',
      details: { prefix: `AWSLogs/${ACCOUNT}/WAFLogs/cloudfront/loja/` },
    });
    expect(cloudfront.commands('wafv2', 'us-east-1')).toEqual([
      'ListWebACLsCommand',
      'ListLoggingConfigurationsCommand',
    ]);
  });

  it('flow log: o destino e o formato são lidos de novo; o que passou a gravar no CloudWatch Logs some daqui', async () => {
    const flowAccount = (flow: Record<string, unknown>): FakeDiscoveryAccount => ({
      regions: ['sa-east-1'],
      handlers: {
        'ec2:sa-east-1': {
          DescribeFlowLogsCommand: () => ({
            FlowLogs: [{ FlowLogId: 'fl-0aaa0000000000001', ResourceId: 'vpc-0aaa0000000000001', ...flow }],
          }),
        },
        's3:*': s3WithObjects(),
      },
    });
    const stored: StoredSource = {
      kind: 'vpc_flow_logs',
      region: 'sa-east-1',
      resourceId: 'fl-0aaa0000000000001',
      // Gravado: Parquet, num bucket antigo.
      details: { destinationType: 's3', bucket: `rede-antiga-${ACCOUNT}`, fileFormat: 'parquet' },
    };
    const fixed = await recheck(
      flowAccount({ LogDestinationType: 's3', LogDestination: `arn:aws:s3:::rede-${ACCOUNT}` }),
      stored,
    );
    expect(foundOf(fixed.reading)).toMatchObject({
      availability: 'available',
      permission: 'granted',
      details: {
        bucket: `rede-${ACCOUNT}`,
        prefix: `AWSLogs/${ACCOUNT}/vpcflowlogs/sa-east-1/`,
        fileFormat: 'plain-text',
      },
    });
    const parquet = await recheck(
      flowAccount({
        LogDestinationType: 's3',
        LogDestination: `arn:aws:s3:::rede-${ACCOUNT}`,
        DestinationOptions: { FileFormat: 'parquet' },
      }),
      stored,
    );
    expect(foundOf(parquet.reading)).toMatchObject({
      availability: 'unsupported_format',
      permission: 'unknown',
    });
    expect(parquet.commands('s3')).toEqual([]);
    const toGroup = await recheck(
      flowAccount({ LogDestinationType: 'cloud-watch-logs', LogGroupName: '/aws/vpc/fluxo' }),
      stored,
    );
    expect(toGroup.reading).toEqual({ status: 'absent' });
    expect((await recheck({ regions: ['sa-east-1'] }, stored)).reading).toEqual({ status: 'absent' });
  });

  it('trilha: o bucket é lido de novo, e a chave KMS é provada na hora (negada, depois corrigida)', async () => {
    const stored: StoredSource = {
      kind: 'cloudtrail',
      region: 'sa-east-1',
      resourceId: TRAIL_ARN,
      details: { destinationType: 's3', bucket: 'trilha-antiga', prefix: 'AWSLogs/x/' },
    };
    const kms = Object.assign(new Error('not authorized to perform: kms:Decrypt (detalhe)'), {
      $metadata: { httpStatusCode: 403 },
    });
    kms.name = 'AccessDenied';
    const denied = await recheck(
      {
        regions: ['sa-east-1'],
        handlers: {
          'cloudtrail:*': trailHandlers(),
          's3:*': s3WithObjects({
            GetObjectCommand: () => {
              throw kms;
            },
          }),
        },
      },
      stored,
    );
    expect(foundOf(denied.reading)).toMatchObject({
      permission: 'missing',
      permissionDetail: 'kms_denied',
      loggingState: 'logging',
      details: {
        bucket: TRAIL_BUCKET,
        prefix: `AWSLogs/${ACCOUNT}/CloudTrail/sa-east-1/`,
        managementEvents: true,
      },
    });
    // O cliente corrigiu a política da chave: a mesma fonte gravada, e agora o objeto é lido.
    const fixed = await recheck(
      { regions: ['sa-east-1'], handlers: { 'cloudtrail:*': trailHandlers(), 's3:*': s3WithObjects() } },
      { ...stored, details: { ...stored.details, bucket: TRAIL_BUCKET } },
    );
    expect(foundOf(fixed.reading)).toMatchObject({ permission: 'granted', permissionDetail: null });
    expect(fixed.commands('s3')).toEqual(['ListObjectsV2Command', 'GetObjectCommand']);
    expect(fixed.calls.find((call) => call.command === 'ListObjectsV2Command')?.input['Bucket']).toBe(
      TRAIL_BUCKET,
    );
    // A trilha apagada, ou que deixou de gravar num bucket: ausente.
    expect((await recheck({ regions: ['sa-east-1'] }, stored)).reading).toEqual({ status: 'absent' });
    const noBucket = await recheck(
      { regions: ['sa-east-1'], handlers: { 'cloudtrail:*': trailHandlers({ S3BucketName: undefined }) } },
      stored,
    );
    expect(noBucket.reading).toEqual({ status: 'absent' });
  });

  it('serviços de achados: o estado é lido de novo (ligado, desligado, apagado), e a sondagem usa as capacidades de agora', async () => {
    const storedOf = (kind: StoredSource['kind'], resourceId: string): StoredSource => ({
      kind,
      region: 'sa-east-1',
      resourceId,
      details: {},
    });
    // Tudo desligado ou apagado: ausente, sem sondagem.
    for (const stored of [
      storedOf('guardduty', 'det1'),
      storedOf('guardduty_export', 'dest1'),
      storedOf('security_hub', 'hub'),
      storedOf('inspector', 'account'),
      storedOf('access_analyzer', 'externo'),
      storedOf('config', 'default'),
      storedOf('elb_logs', 'loja'),
    ]) {
      const { reading, calls } = await recheck({ regions: ['sa-east-1'] }, stored);
      expect(reading, stored.kind).toEqual({ status: 'absent' });
      expect(calls.length, stored.kind).toBeGreaterThan(0);
      expectWithinPolicy(calls);
    }
    // O detector desligado continua na lista, como desligado.
    const disabled = await recheck(
      {
        regions: ['sa-east-1'],
        handlers: {
          'guardduty:sa-east-1': {
            ListDetectorsCommand: () => ({ DetectorIds: ['det1'] }),
            GetDetectorCommand: () => ({ Status: 'DISABLED' }),
          },
        },
      },
      storedOf('guardduty', 'det1'),
    );
    expect(foundOf(disabled.reading)).toMatchObject({
      availability: 'not_enabled',
      loggingState: 'disabled',
    });
    expect(disabled.commands('guardduty')).not.toContain('ListFindingsCommand');
    // A capacidade dos achados desligada agora: sem sondagem. Ligada: a API é sondada.
    const off = await recheck(completeAccount(), storedOf('guardduty', 'det1'), {
      capabilities: ['discovery'],
    });
    expect(foundOf(off.reading)).toMatchObject({ permission: 'missing', permissionDetail: 'capability_off' });
    expect(off.commands('guardduty')).not.toContain('ListFindingsCommand');
    const on = await recheck(completeAccount(), storedOf('guardduty', 'det1'));
    expect(foundOf(on.reading)).toMatchObject({ permission: 'granted', notes: ['recommended'] });
    expect(on.commands('guardduty')).toContain('ListFindingsCommand');
    // A leitura recusada do detector: não dá para dizer se o export existe.
    const unread = await recheck(
      {
        regions: ['sa-east-1'],
        handlers: {
          'guardduty:sa-east-1': {
            ListDetectorsCommand: () => ({ DetectorIds: ['det1'] }),
            GetDetectorCommand: () => ({ Status: 'ENABLED' }),
            ListPublishingDestinationsCommand: () => {
              throw awsError('AccessDeniedException', 403);
            },
          },
        },
      },
      storedOf('guardduty_export', 'dest1'),
    );
    expect(unread.reading).toEqual({ status: 'unread' });
  });

  it('a linha "desligado na conta" é da conta inteira: ausente, sem chamada (só a descoberta responde)', async () => {
    const { reading, calls } = await recheck(completeAccount(), {
      kind: 'guardduty',
      region: 'global',
      resourceId: 'none',
      details: { regionsChecked: ['sa-east-1'] },
    });
    expect(reading).toEqual({ status: 'absent' });
    expect(calls).toEqual([]);
  });

  it('o cancelamento e a sessão que caiu sobem; a leitura recusada da fonte também (nada é respondido)', async () => {
    await expect(
      recheck(
        { regions: ['sa-east-1'], deny: { 'cloudtrail:sa-east-1': awsError('AccessDeniedException', 403) } },
        { kind: 'cloudtrail', region: 'sa-east-1', resourceId: TRAIL_ARN, details: {} },
      ),
    ).rejects.toMatchObject({ name: 'AccessDeniedException' });
    const lost = new AwsConnectionError('trust_denied', false);
    await expect(
      recheck(
        {
          regions: ['sa-east-1'],
          handlers: {
            'cloudtrail:*': {
              ...trailHandlers(),
              GetTrailStatusCommand: () => {
                throw lost;
              },
            },
          },
        },
        { kind: 'cloudtrail', region: 'sa-east-1', resourceId: TRAIL_ARN, details: {} },
      ),
    ).rejects.toBe(lost);
  });
});
