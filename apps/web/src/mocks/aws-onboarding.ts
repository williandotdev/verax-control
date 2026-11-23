import {
  AWS_BUCKET_ERROR_CODES,
  AWS_CONNECT_WINDOW_MS,
  AWS_DISCOVERY_MANUAL_INTERVAL_MS,
  AWS_MAX_AUTHORIZED_LOG_GROUPS,
  AWS_MAX_AUTHORIZED_S3_SOURCES,
  AWS_READER_CAPABILITIES,
  AWS_READER_TEMPLATE_VERSION,
  AWS_SOURCE_GLOBAL_REGION,
  AWS_SOURCE_KIND_INFO,
  AWS_SOURCE_LEGACY_RESOURCE,
  AWS_SOURCE_NONE_RESOURCE,
  type AwsCredentialMode,
  type AwsDiscoveryError,
  type AwsDiscoveryRun,
  type AwsInfrastructureSummary,
  type AwsOnboarding,
  type AwsOnboardingCheck,
  type AwsOnboardingCheckId,
  type AwsOnboardingCheckStatus,
  type AwsOnboardingErrorCode,
  awsOnboardingSchema,
  type AwsOnboardingState,
  type AwsReaderCapability,
  type AwsSource,
  type AwsSourceDetails,
  awsSourceIdleState,
  type AwsSourceKind,
  type AwsSourceNote,
  awsSourcesAuthorizeSchema,
  type AwsSourceState,
  type CloudAccount,
  isAwsTemplateOutdated,
  LOG_SOURCES,
  type LogSource,
  parseAwsConnectionError,
} from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { API_URL } from '@/lib/env';
import { DEMO_ACCOUNTS, DEMO_AWS_CHECK_DELAY_MS } from './fixtures';

/**
 * O onboarding self-service da AWS no modo mock: uma imitação com estado das rotas `/v1/cloud-accounts/:id/aws/...`
 * (`apps/api/src/cloud-accounts/aws-onboarding.*`), para a demonstração mostrar o fluxo inteiro sem API e sem AWS. O
 * "worker" da demonstração anda com o relógio, a cada leitura: responde o "Conectar" e o "Verificar", roda a
 * descoberta, confere a permissão pedida e faz as fontes autorizadas passarem pelos estados dos coletores (que na API
 * de verdade chegam com os PRs dos coletores: `configuring`, `waiting_events`, `collecting`, `stalled`,
 * `ingestion_error`). O estado da conta e as conferências saem do que está guardado, com as mesmas regras de
 * `apps/api/src/aws/onboarding/onboarding-state.ts`, e toda resposta passa pelo schema do contrato.
 *
 * As contas da demonstração cobrem os estados que não aparecem no caminho feliz:
 * - a de produção da Alfa: parcialmente operacional, com a autorização dos grupos de logs desligada na pilha, a
 *   descoberta parcial e fontes em quase todos os estados;
 * - a de homologação da Alfa: desconectada (a AWS recusa a entrada no papel);
 * - a da Beta: coletando, com a pilha do modelo anterior (o bloco "Atualize a pilha");
 * - uma conta nova: do "Conectar com AWS" até coletar tudo. Os IDs de `DEMO_AWS_SCENARIO_ACCOUNTS`, cadastrados na
 *   demonstração, levam aos outros desfechos: o tempo esgotado, o erro de permissão e a falha de ingestão.
 *
 * Tudo fictício: contas de exemplo, nomes de bucket inventados, nenhum segredo.
 */

/** Os IDs de conta que, cadastrados na demonstração, mostram os desfechos fora do caminho feliz. */
export const DEMO_AWS_SCENARIO_ACCOUNTS = {
  /** A pilha nunca aparece: o "Conectar" termina em tempo esgotado (a janela da demonstração é curta). */
  timeout: '999900000001',
  /** Uma fonte autorizada perde a permissão: erro de permissão. */
  permissionError: '999900000002',
  /** A leitura de uma fonte autorizada falha: falha de ingestão. */
  ingestionFailure: '999900000003',
} as const;

export type AwsFakeScenario = 'happy' | 'timeout' | 'permission_error' | 'ingestion_failure';

/** Quanto o "worker" da demonstração leva em cada passo (a tela relê a cada 5 s enquanto espera). */
export const DEMO_AWS_CONNECT_DELAY_MS = 6_000;
export const DEMO_AWS_CONNECT_TIMEOUT_MS = 20_000;
/** Entre a entrada no papel e o pedido da descoberta: a conta fica um instante em "autenticação validada". */
export const DEMO_AWS_DISCOVERY_REQUEST_MS = 2_000;
export const DEMO_AWS_DISCOVERY_QUEUE_MS = 1_500;
export const DEMO_AWS_DISCOVERY_RUN_MS = 4_000;
export const DEMO_AWS_PROBE_DELAY_MS = 2_000;
/** Desde a autorização: o coletor configura, espera o primeiro evento e passa a coletar. As APIs de achados andam antes. */
export const DEMO_AWS_COLLECTOR_MS = {
  configuring: 3_000,
  waitingEvents: 7_000,
  collecting: 13_000,
  api: 9_000,
};

/** O que o mock guarda de uma conta AWS além do cadastro dela (o que na API fica na conta, na descoberta e nas fontes). */
export interface AwsFake {
  scenario: AwsFakeScenario;
  connectRequestedAt: string | null;
  templateVersion: number | null;
  capabilities: AwsReaderCapability[];
  capabilitiesCheckedAt: string | null;
  discoveredRegions: string[];
  run: AwsDiscoveryRun | null;
  lastCompletedAt: string | null;
  infrastructure: AwsInfrastructureSummary | null;
  sources: AwsSource[];
  /** As fontes da demonstração que ficam no estado em que foram postas (o "worker" não as faz andar). */
  frozen: Set<string>;
  /** O que a próxima descoberta deixa de fora (a descoberta parcial da demonstração). */
  discoveryErrors: AwsDiscoveryError[];
  /** Nos cenários de erro: a fonte autorizada que para em erro (a primeira autorizada pela tela). */
  troubled: string | null;
  /** Quando a descoberta pedida pela conferência da conexão entra na fila; null sem pedido a caminho. */
  discoveryDueAt: number | null;
}

export type AwsOnboardingStore = Map<string, AwsFake>;

const iso = (ms: number): string => new Date(ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GB = 1_000_000_000;

let sequence = 0;
/** Um ID de fonte fictício, no formato de UUID. */
function newSourceId(): string {
  sequence += 1;
  return `018f2c1e-0000-7000-8000-00f5${sequence.toString(16).padStart(8, '0')}`;
}

const NO_HEALTH: AwsSource['health'] = {
  lastSyncAt: null,
  lastEventAt: null,
  lastIngestedAt: null,
  lagSeconds: null,
  eventsLast24h: null,
  bytesLast24h: null,
};

/** O que a "descoberta" da demonstração acha de uma fonte, antes de virar linha. */
interface Discovered {
  kind: AwsSourceKind;
  region: string;
  resourceId: string;
  name: string;
  availability?: AwsSource['availability'];
  loggingState?: AwsSource['loggingState'];
  notes?: AwsSourceNote[];
  details?: AwsSourceDetails;
  permission?: AwsSource['permission'];
  permissionDetail?: string | null;
}

/** A linha nova de uma fonte descoberta: sem autorização, no estado que a disponibilidade e a permissão dão. */
function sourceRow(found: Discovered, now: number): AwsSource {
  const info = AWS_SOURCE_KIND_INFO[found.kind];
  const availability = found.availability ?? 'available';
  const permission = found.permission ?? (availability === 'available' ? 'granted' : 'unknown');
  const idle = awsSourceIdleState(found.kind, availability, permission);
  return {
    id: newSourceId(),
    kind: found.kind,
    region: found.region,
    resourceId: found.resourceId,
    name: found.name,
    method: info.method,
    origin: 'discovered',
    collectable: info.collectable,
    sensitive: info.sensitive,
    availability,
    loggingState: found.loggingState ?? null,
    permission,
    permissionDetail: found.permissionDetail ?? null,
    permissionCheckedAt: permission === 'unknown' ? null : iso(now),
    probeRequestedAt: null,
    notes: found.notes ?? [],
    details: found.details ?? {},
    state: idle.state,
    stateCode: idle.stateCode,
    stateSince: iso(now),
    authorization: { authorizedAt: null, authorizedBy: null, revokedAt: null },
    collectFrom: null,
    firstSeenAt: iso(now),
    lastSeenAt: iso(now),
    missingSince: null,
    health: { ...NO_HEALTH },
  };
}

/** A autorização da fonte está valendo? */
const isAuthorized = (source: AwsSource): boolean =>
  source.authorization.authorizedAt !== null && source.authorization.revokedAt === null;

/** A saúde de uma fonte coletando, na demonstração: lida há pouco, com o volume do dia. */
function collectingHealth(source: AwsSource, now: number): AwsSource['health'] {
  const api = source.method === 'api';
  // O Access Analyzer e o Security Hub da demonstração não têm achado novo: sincronizados, sem evento.
  const quiet = source.kind === 'access_analyzer' || source.kind === 'security_hub';
  return {
    lastSyncAt: iso(now - 40_000),
    lastEventAt: quiet ? null : iso(now - (api ? 50 * 60_000 : 3 * 60_000)),
    lastIngestedAt: quiet ? null : iso(now - (api ? 49 * 60_000 : 2 * 60_000)),
    lagSeconds: api ? 45 : 95,
    eventsLast24h: quiet ? 0 : api ? 3 : source.kind === 'vpc_flow_logs' ? 184_300 : 12_480,
    bytesLast24h: quiet ? 0 : api ? 14_200 : source.kind === 'vpc_flow_logs' ? 2.4 * GB : 0.3 * GB,
  };
}

function setState(source: AwsSource, state: AwsSourceState, stateCode: string | null, now: number): void {
  if (source.state === state && source.stateCode === stateCode) return;
  Object.assign(source, { state, stateCode, stateSince: iso(now) });
}

// --- O que a descoberta da demonstração acha ---

const LOG_GROUP_NAMES: readonly (readonly [
  name: string,
  gb: number,
  retention: number | null,
  tagged: boolean,
])[] = [
  ['/aplicacao/auditoria', 1.2, 365, true],
  ['/aplicacao/autenticacao', 0.8, 90, true],
  ['/aws/apigateway/loja-api', 6.4, 30, true],
  ['/aws/route53/loja-alfa.example', 0.3, 30, true],
  ['/aws/lambda/loja-checkout', 2.1, 30, false],
  ['/aws/lambda/loja-pagamentos', 1.7, 30, false],
  ['/aws/lambda/loja-notificacoes', 0.2, 14, false],
  ['/aws/lambda/relatorios-noturnos', 0.1, 14, false],
  ['API-Gateway-Execution-Logs_a1b2c3d4e5/prod', 3.9, 30, false],
  ['/aws/rds/instance/loja-db/postgresql', 4.5, 90, false],
  ['/aws/rds/instance/loja-db/upgrade', 0.01, 90, false],
  ['/aws/eks/loja/cluster', 18.2, 30, false],
  ['/aws/containerinsights/loja/performance', 72, 7, false],
  ['aws-waf-logs-loja-api', 9.6, 30, false],
  ['/ecs/loja-web', 22.4, 30, false],
  ['/ecs/loja-worker', 11.8, 30, false],
  ['/aws/amplify/loja-admin', 0.05, null, false],
  ['vpc-flow-logs-homologacao', 140, 14, false],
  ...Array.from(
    { length: 16 },
    (_, index) =>
      [`/aws/lambda/servico-${String(index + 1).padStart(2, '0')}`, 0.1 + index * 0.05, 30, false] as const,
  ),
];

const LOG_GROUP_CATEGORIES: readonly (readonly [
  marker: string,
  category: NonNullable<AwsSourceDetails['category']>,
])[] = [
  ['/aws/containerinsights', 'metrics'],
  ['/aws/rds/', 'rds'],
  ['/aws/apigateway/', 'api_gateway'],
  ['API-Gateway-Execution-Logs', 'api_gateway'],
  ['/aws/route53/', 'route53'],
  ['/aws/lambda/', 'lambda'],
  ['/aws/eks/', 'eks'],
  ['/aws/amplify/', 'amplify'],
  ['aws-waf-logs-', 'waf'],
  ['vpc-flow-logs', 'vpc_flow_logs'],
];

/** O que a descoberta da demonstração acha numa conta, pelas capacidades do papel e pelos buckets do cadastro. */
function discoveredSources(account: CloudAccount, fake: AwsFake): Discovered[] {
  const id = account.accountId;
  const main = account.regions[0] ?? 'sa-east-1';
  const second = main === 'us-east-1' ? 'sa-east-1' : 'us-east-1';
  const can = (capability: AwsReaderCapability) => fake.capabilities.includes(capability);
  const { cloudtrail, guardduty, waf } = account.buckets;
  const prefix = (service: string, region: string, tail = '') => `AWSLogs/${id}/${service}/${region}/${tail}`;
  /** A permissão de uma fonte que dá para ler: concedida, ou a capacidade do tipo desligada na pilha. */
  const granted = (
    kind: AwsSourceKind,
    legacyBucket = false,
  ): Pick<Discovered, 'permission' | 'permissionDetail'> =>
    can(AWS_SOURCE_KIND_INFO[kind].capability) || legacyBucket
      ? { permission: 'granted', permissionDetail: null }
      : missing('capability_off');
  const missing = (detail: string): Pick<Discovered, 'permission' | 'permissionDetail'> => ({
    permission: 'missing',
    permissionDetail: detail,
  });
  const withUpdate = (kind: AwsSourceKind, notes: AwsSourceNote[], legacyBucket = false): AwsSourceNote[] =>
    can(AWS_SOURCE_KIND_INFO[kind].capability) || legacyBucket ? notes : [...notes, 'stack_update_required'];

  const trailBucket = cloudtrail ?? `aws-cloudtrail-logs-${id}-demo`;
  const exportBucket = guardduty ?? `guardduty-export-${id}-demo`;
  const wafBucket = waf ?? `aws-waf-logs-loja-${id}`;
  const kmsKey = `arn:aws:kms:${main}:${id}:key/11111111-2222-3333-4444-555555555555`;

  const found: Discovered[] = [
    {
      kind: 'cloudtrail',
      region: main,
      resourceId: `arn:aws:cloudtrail:${main}:${id}:trail/management-events`,
      name: 'management-events',
      loggingState: 'logging',
      notes: withUpdate('cloudtrail', cloudtrail !== null ? ['covered_by_legacy'] : [], cloudtrail !== null),
      details: {
        arn: `arn:aws:cloudtrail:${main}:${id}:trail/management-events`,
        destinationType: 's3',
        bucket: trailBucket,
        prefix: prefix('CloudTrail', main),
        multiRegion: true,
        organizationTrail: false,
        managementEvents: true,
      },
      ...granted('cloudtrail', cloudtrail !== null),
    },
    {
      kind: 'cloudtrail',
      region: second,
      resourceId: `arn:aws:cloudtrail:${second}:${id}:trail/trilha-da-organizacao`,
      name: 'trilha-da-organizacao',
      loggingState: 'logging',
      notes: ['central_bucket', 'additional_bucket_required'],
      details: {
        arn: `arn:aws:cloudtrail:${second}:${id}:trail/trilha-da-organizacao`,
        destinationType: 's3',
        bucket: 'logs-centrais-organizacao-demo',
        prefix: `auditoria/AWSLogs/${id}/CloudTrail/${second}/`,
        customPrefix: 'auditoria',
        multiRegion: true,
        organizationTrail: true,
        managementEvents: true,
      },
      permission: 'missing',
      permissionDetail: can('service-logs') ? 'outside_awslogs_prefix' : 'capability_off',
    },
    {
      kind: 'vpc_flow_logs',
      region: main,
      resourceId: 'fl-0a1b2c3d4e5f60718',
      name: 'fl-0a1b2c3d4e5f60718 (vpc-0a1b2c3d)',
      loggingState: 'logging',
      notes: withUpdate('vpc_flow_logs', ['high_volume']),
      details: {
        flowLogId: 'fl-0a1b2c3d4e5f60718',
        attachedTo: 'vpc-0a1b2c3d',
        trafficType: 'ALL',
        destinationType: 's3',
        bucket: `vpc-flow-logs-${id}-demo`,
        prefix: prefix('vpcflowlogs', main),
        fileFormat: 'plain-text',
        hivePartitions: false,
        customFormat: false,
      },
      ...granted('vpc_flow_logs'),
    },
    {
      kind: 'vpc_flow_logs',
      region: second,
      resourceId: 'fl-0f9e8d7c6b5a40312',
      name: 'fl-0f9e8d7c6b5a40312 (vpc-0f9e8d7c)',
      availability: 'unsupported_format',
      loggingState: 'logging',
      notes: ['high_volume'],
      details: {
        flowLogId: 'fl-0f9e8d7c6b5a40312',
        attachedTo: 'vpc-0f9e8d7c',
        trafficType: 'REJECT',
        destinationType: 's3',
        bucket: `vpc-flow-logs-${id}-parquet`,
        prefix: prefix('vpcflowlogs', second),
        fileFormat: 'parquet',
        hivePartitions: true,
        customFormat: false,
      },
    },
    {
      kind: 'vpc_flow_logs',
      region: second,
      resourceId: 'fl-0c0ffee0c0ffee012',
      name: 'fl-0c0ffee0c0ffee012 (subnet-0c0ffee0)',
      loggingState: 'logging',
      notes: withUpdate('vpc_flow_logs', ['high_volume']),
      details: {
        flowLogId: 'fl-0c0ffee0c0ffee012',
        attachedTo: 'subnet-0c0ffee0',
        trafficType: 'ALL',
        destinationType: 's3',
        bucket: 'vpc-flow-logs-conta-de-rede-demo',
        prefix: prefix('vpcflowlogs', second),
        fileFormat: 'plain-text',
        hivePartitions: false,
        customFormat: false,
      },
      permission: 'missing',
      permissionDetail: can('service-logs') ? 'bucket_denied' : 'capability_off',
    },
    {
      kind: 'waf',
      region: main,
      resourceId: 'a1b2c3d4-0000-4000-8000-000000000001',
      name: 'loja-web-acl',
      loggingState: 'logging',
      notes: withUpdate('waf', waf !== null ? ['covered_by_legacy'] : [], waf !== null),
      details: {
        arn: `arn:aws:wafv2:${main}:${id}:regional/webacl/loja-web-acl/a1b2c3d4-0000-4000-8000-000000000001`,
        webAclName: 'loja-web-acl',
        webAclScope: 'REGIONAL',
        destinationType: 's3',
        bucket: wafBucket,
        prefix: prefix('WAFLogs', main, 'loja-web-acl/'),
        kmsKeyArn: kmsKey,
      },
      // Na conta sem o bucket no cadastro, a chave KMS do bucket do WAF não decifra para o papel.
      ...(waf !== null
        ? granted('waf', true)
        : missing(can('service-logs') ? 'kms_denied' : 'capability_off')),
    },
    {
      kind: 'waf',
      region: second,
      resourceId: 'a1b2c3d4-0000-4000-8000-000000000002',
      name: 'api-acl',
      availability: 'no_destination',
      loggingState: 'disabled',
      notes: ['aws_cost_waf_logging'],
      details: {
        arn: `arn:aws:wafv2:${second}:${id}:regional/webacl/api-acl/a1b2c3d4-0000-4000-8000-000000000002`,
        webAclName: 'api-acl',
        webAclScope: 'REGIONAL',
        destinationType: 'none',
      },
    },
    {
      kind: 'waf',
      region: AWS_SOURCE_GLOBAL_REGION,
      resourceId: 'a1b2c3d4-0000-4000-8000-000000000003',
      name: 'cdn-acl',
      availability: 'unsupported_destination',
      loggingState: 'logging',
      details: {
        arn: `arn:aws:wafv2:us-east-1:${id}:global/webacl/cdn-acl/a1b2c3d4-0000-4000-8000-000000000003`,
        webAclName: 'cdn-acl',
        webAclScope: 'CLOUDFRONT',
        destinationType: 'firehose',
        destination: `arn:aws:firehose:us-east-1:${id}:deliverystream/aws-waf-logs-cdn`,
      },
    },
    {
      kind: 'guardduty',
      region: main,
      resourceId: '12abc34d567e8fa901bc2d34e56789f0',
      name: 'GuardDuty',
      loggingState: 'enabled',
      notes: withUpdate('guardduty', ['recommended']),
      details: { detectorId: '12abc34d567e8fa901bc2d34e56789f0' },
      ...granted('guardduty'),
    },
    {
      kind: 'guardduty_export',
      region: main,
      resourceId: 'f0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5',
      name: exportBucket,
      loggingState: 'publishing',
      notes: withUpdate(
        'guardduty_export',
        [
          ...(can('findings') ? (['covered_by_api'] as const) : []),
          ...(guardduty !== null ? (['covered_by_legacy'] as const) : []),
        ],
        guardduty !== null,
      ),
      details: {
        detectorId: '12abc34d567e8fa901bc2d34e56789f0',
        destinationType: 's3',
        bucket: exportBucket,
        prefix: prefix('GuardDuty', main),
        kmsKeyArn: kmsKey,
      },
      ...granted('guardduty_export', guardduty !== null),
    },
    {
      kind: 'guardduty_export',
      region: second,
      resourceId: 'a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5',
      name: 'guardduty-export-antigo-demo',
      loggingState: 'stopped',
      notes: withUpdate('guardduty_export', can('findings') ? ['covered_by_api'] : []),
      details: {
        detectorId: '98fed76c543b2a109876fedc5432ba10',
        destinationType: 's3',
        bucket: 'guardduty-export-antigo-demo',
        prefix: prefix('GuardDuty', second),
      },
      // O bucket de destino foi apagado: o export aponta para o que não existe mais.
      permission: 'missing',
      permissionDetail: can('service-logs') ? 'bucket_missing' : 'capability_off',
    },
    {
      kind: 'security_hub',
      region: main,
      resourceId: 'hub',
      name: 'Security Hub',
      loggingState: 'enabled',
      notes: withUpdate('security_hub', []),
      details: { arn: `arn:aws:securityhub:${main}:${id}:hub/default` },
      ...granted('security_hub'),
    },
    {
      kind: 'security_hub',
      region: second,
      resourceId: 'hub',
      name: 'Security Hub',
      loggingState: 'enabled',
      details: { arn: `arn:aws:securityhub:${second}:${id}:hub/default` },
      // A AWS não respondeu à conferência: fica por conferir, com o "Verificar de novo".
      permission: 'unknown',
      permissionDetail: 'probe_failed',
    },
    {
      kind: 'inspector',
      region: AWS_SOURCE_GLOBAL_REGION,
      resourceId: AWS_SOURCE_NONE_RESOURCE,
      name: 'inspector',
      availability: 'not_enabled',
      loggingState: 'disabled',
      notes: ['aws_cost_inspector'],
      details: { regionsChecked: [main, second].sort() },
    },
    {
      kind: 'access_analyzer',
      region: main,
      resourceId: 'analisador-da-conta',
      name: 'analisador-da-conta',
      loggingState: 'enabled',
      notes: withUpdate('access_analyzer', []),
      details: {
        arn: `arn:aws:access-analyzer:${main}:${id}:analyzer/analisador-da-conta`,
        analyzerType: 'ACCOUNT',
      },
      ...granted('access_analyzer'),
    },
    {
      kind: 'access_analyzer',
      region: second,
      resourceId: 'analisador-da-organizacao',
      name: 'analisador-da-organizacao',
      loggingState: 'enabled',
      notes: withUpdate('access_analyzer', []),
      details: {
        arn: `arn:aws:access-analyzer:${second}:${id}:analyzer/analisador-da-organizacao`,
        analyzerType: 'ORGANIZATION',
      },
      // Uma política da organização nega a leitura dos achados deste analisador: a ação negada é o motivo.
      permission: 'missing',
      permissionDetail: can('findings') ? 'access-analyzer:ListFindings' : 'capability_off',
    },
    {
      kind: 'config',
      region: main,
      resourceId: 'default',
      name: 'default',
      loggingState: 'logging',
      notes: ['not_collected_yet'],
      details: {
        recording: true,
        destinationType: 's3',
        bucket: `config-bucket-${id}`,
        prefix: prefix('Config', main),
      },
    },
    {
      kind: 'elb_logs',
      region: main,
      resourceId: 'loja-alb',
      name: 'loja-alb',
      loggingState: 'logging',
      notes: ['not_collected_yet'],
      details: {
        arn: `arn:aws:elasticloadbalancing:${main}:${id}:loadbalancer/app/loja-alb/50dc6c495c0c9188`,
        destinationType: 's3',
        bucket: `alb-logs-${id}-demo`,
        prefix: prefix('elasticloadbalancing', main),
      },
    },
  ];

  LOG_GROUP_NAMES.forEach(([name, gb, retentionDays, tagged], index) => {
    const region = index % 5 === 4 ? second : main;
    const category = LOG_GROUP_CATEGORIES.find(([marker]) => name.includes(marker))?.[1] ?? 'other';
    const highVolume = category === 'vpc_flow_logs' || (retentionDays !== null && gb / retentionDays >= 1);
    const notes: AwsSourceNote[] = [];
    if (!tagged) notes.push('tag_required');
    if (category === 'metrics') notes.push('not_security_events');
    if (highVolume) notes.push('high_volume');
    if (!can('log-groups')) notes.push('stack_update_required');
    found.push({
      kind: 'cloudwatch_log_group',
      region,
      resourceId: name,
      name,
      notes,
      details: {
        arn: `arn:aws:logs:${region}:${id}:log-group:${name}`,
        destinationType: 'cloudwatch',
        logGroup: name,
        storedBytes: Math.round(gb * GB),
        retentionDays,
        category,
        tagged,
      },
      ...(!can('log-groups')
        ? missing('capability_off')
        : tagged
          ? granted('cloudwatch_log_group')
          : missing('tag_missing')),
    });
  });
  return found;
}

/** O retrato da infraestrutura da demonstração. Com a descoberta parcial, uma leitura fica sem número. */
function demoInfrastructure(partial: boolean): AwsInfrastructureSummary {
  return {
    instances: 14,
    publicInstances: 3,
    securityGroups: 31,
    openSecurityGroups: 2,
    buckets: 18,
    publicBuckets: 1,
    iamUsers: 9,
    rootMfaEnabled: true,
    rdsInstances: 3,
    rdsPublic: 0,
    rdsUnencrypted: 1,
    rdsClusters: 1,
    loadBalancers: partial ? null : 2,
    internetFacingLoadBalancers: partial ? null : 2,
    vpcs: 3,
    webAcls: 3,
    logGroups: LOG_GROUP_NAMES.length,
    trails: 2,
  };
}

const keyOf = (source: Pick<AwsSource, 'kind' | 'region' | 'resourceId'>): string =>
  `${source.kind}|${source.region}|${source.resourceId}`;

/**
 * Grava o que a descoberta achou, como a API: a fonte nova entra; a conhecida ganha o que foi visto agora, sem perder
 * a autorização (a que perdeu a permissão fica com erro de permissão); a que não apareceu mais fica "não encontrada" se
 * estava autorizada, e some se não estava.
 */
function storeDiscovery(account: CloudAccount, fake: AwsFake, now: number): void {
  const found = discoveredSources(account, fake);
  const seen = new Set<string>();
  for (const item of found) {
    const fresh = sourceRow(item, now);
    seen.add(keyOf(fresh));
    const row = fake.sources.find((candidate) => keyOf(candidate) === keyOf(fresh));
    if (row === undefined) {
      fake.sources.push(fresh);
      continue;
    }
    if (fake.frozen.has(row.id)) {
      row.lastSeenAt = iso(now);
      continue;
    }
    Object.assign(row, {
      name: fresh.name,
      availability: fresh.availability,
      loggingState: fresh.loggingState,
      notes: fresh.notes,
      details: fresh.details,
      permission: fresh.permission,
      permissionDetail: fresh.permissionDetail,
      permissionCheckedAt: fresh.permissionCheckedAt,
      lastSeenAt: iso(now),
      missingSince: null,
    });
    if (row.authorization.revokedAt !== null) continue;
    if (!isAuthorized(row)) setState(row, fresh.state, fresh.stateCode, now);
    else if (fresh.availability !== 'available') setState(row, 'source_missing', fresh.availability, now);
    else if (fresh.permission === 'missing') setState(row, 'permission_error', fresh.permissionDetail, now);
  }
  fake.sources = fake.sources.filter((row) => {
    if (row.origin === 'legacy' || seen.has(keyOf(row)) || fake.frozen.has(row.id)) return true;
    if (isAuthorized(row)) {
      row.missingSince ??= iso(now);
      setState(row, 'source_missing', 'not_found', now);
      return true;
    }
    if (row.authorization.revokedAt !== null) {
      row.missingSince ??= iso(now);
      return true;
    }
    return false;
  });
}

const LEGACY_KIND: Readonly<Record<LogSource, AwsSourceKind>> = {
  cloudtrail: 'cloudtrail',
  guardduty: 'guardduty_export',
  waf: 'waf',
};

/** As linhas dos buckets do cadastro (`origin = legacy`), espelhadas da conta como na API: uma por bucket, autorizada. */
function syncLegacySources(account: CloudAccount, fake: AwsFake, now: number): void {
  for (const source of LOG_SOURCES) {
    const kind = LEGACY_KIND[source];
    const bucket = account.buckets[source];
    const row = fake.sources.find((candidate) => candidate.origin === 'legacy' && candidate.kind === kind);
    if (bucket === null) {
      if (row !== undefined) fake.sources = fake.sources.filter((candidate) => candidate !== row);
      continue;
    }
    if (row === undefined) {
      fake.sources.push({
        ...sourceRow(
          {
            kind,
            region: AWS_SOURCE_GLOBAL_REGION,
            resourceId: AWS_SOURCE_LEGACY_RESOURCE,
            name: bucket,
            details: { bucket, legacySource: source },
            permission: 'unknown',
          },
          now,
        ),
        origin: 'legacy',
        permissionCheckedAt: null,
        authorization: { authorizedAt: iso(now), authorizedBy: null, revokedAt: null },
        collectFrom: account.ingestFrom,
        state: 'authorized',
        stateCode: 'awaiting_collector',
      });
    } else if (row.name !== bucket) {
      // Outro bucket: a fonte volta a esperar o coletor.
      Object.assign(row, {
        name: bucket,
        details: { bucket, legacySource: source },
        health: { ...NO_HEALTH },
      });
      fake.frozen.delete(row.id);
      setState(row, 'authorized', 'awaiting_collector', now);
    }
    if (row !== undefined) row.collectFrom = account.ingestFrom;
  }
}

// --- O "worker" da demonstração ---

const BUCKET_ERRORS: readonly string[] = AWS_BUCKET_ERROR_CODES;

function isBucketError(connectionError: string | null): boolean {
  const parsed = connectionError === null ? null : parseAwsConnectionError(connectionError);
  return parsed !== null && BUCKET_ERRORS.includes(parsed.code);
}

/** O nó entra no papel desta conta agora (conectada, ou com erro só num bucket), como `entersRole` da API. */
function entersRole(account: CloudAccount): boolean {
  if (account.ingestFrom === null) return false;
  return (
    account.connection === 'connected' ||
    (account.connection === 'error' && isBucketError(account.connectionError))
  );
}

const isConnectRequest = (account: CloudAccount, fake: AwsFake): boolean =>
  account.checkRequestedAt !== null && account.checkRequestedAt === fake.connectRequestedAt;

function requestDiscovery(
  fake: AwsFake,
  trigger: AwsDiscoveryRun['trigger'],
  now: number,
  requestedBy: string | null,
) {
  const active = fake.run !== null && (fake.run.status === 'pending' || fake.run.status === 'running');
  if (active) return;
  sequence += 1;
  fake.run = {
    id: `018f2c1e-0000-7000-8000-00d5${sequence.toString(16).padStart(8, '0')}`,
    trigger,
    status: 'pending',
    requestedAt: iso(now),
    startedAt: null,
    finishedAt: null,
    regions: [],
    errors: [],
    requestedBy,
  };
}

/** A conferência da conexão que deu certo: a conta conecta, as etiquetas do papel são lidas e a descoberta é pedida. */
function enterRole(account: CloudAccount, fake: AwsFake, now: number, connect: boolean): void {
  const first = account.ingestFrom === null;
  Object.assign(account, {
    checkRequestedAt: null,
    connection: 'connected',
    connectionError: null,
    ingestFrom: account.ingestFrom ?? iso(now - DAY).slice(0, 10),
    updatedAt: iso(now),
  });
  // A demonstração não tem uma pilha de verdade: toda verificação que dá certo acha o papel no modelo atual, com as
  // três autorizações (como se a pilha tivesse acabado de ser criada ou atualizada pelos passos da tela). Mudou o que o
  // papel pode ler, a descoberta roda de novo, como na API.
  const changed =
    fake.templateVersion !== AWS_READER_TEMPLATE_VERSION ||
    fake.capabilities.length !== AWS_READER_CAPABILITIES.length;
  fake.templateVersion = AWS_READER_TEMPLATE_VERSION;
  fake.capabilities = [...AWS_READER_CAPABILITIES];
  fake.capabilitiesCheckedAt = iso(now);
  syncLegacySources(account, fake, now);
  if (first || connect || changed || fake.run === null) {
    fake.discoveryDueAt = now + DEMO_AWS_DISCOVERY_REQUEST_MS;
  }
}

/**
 * Responde o "Conectar" e o "Verificar" pendentes. A homologação da demonstração continua recusada; o cenário do tempo
 * esgotado nunca acha o papel e fecha a janela (curta, na demonstração); qualquer outra conta conecta.
 */
function answerCheck(account: CloudAccount, fake: AwsFake, now: number): void {
  if (account.checkRequestedAt === null) return;
  const elapsed = now - Date.parse(account.checkRequestedAt);
  const connect = isConnectRequest(account, fake);
  if (connect && fake.scenario === 'timeout') {
    if (elapsed < DEMO_AWS_CONNECT_TIMEOUT_MS) return;
    Object.assign(account, {
      checkRequestedAt: null,
      connection: 'error',
      connectionError: 'authorization_timeout',
      updatedAt: iso(now),
    });
    return;
  }
  if (elapsed < (connect ? DEMO_AWS_CONNECT_DELAY_MS : DEMO_AWS_CHECK_DELAY_MS)) return;
  if (account.accountId === DEMO_ACCOUNTS.alfaHomologacao) {
    Object.assign(account, {
      checkRequestedAt: null,
      connection: 'error',
      connectionError: 'trust_denied',
      updatedAt: iso(now),
    });
    return;
  }
  enterRole(account, fake, now, connect);
}

/** A descoberta pedida: sai da fila, roda e grava o que achou (as regiões com recurso entram nas monitoradas). */
function runDiscovery(account: CloudAccount, fake: AwsFake, now: number): void {
  if (!entersRole(account)) return;
  if (fake.discoveryDueAt !== null && now >= fake.discoveryDueAt) {
    fake.discoveryDueAt = null;
    requestDiscovery(fake, 'connect', now, null);
    return;
  }
  const run = fake.run;
  if (run === null) return;
  if (run.status === 'pending' && now - Date.parse(run.requestedAt) >= DEMO_AWS_DISCOVERY_QUEUE_MS) {
    Object.assign(run, { status: 'running', startedAt: iso(now) });
    return;
  }
  if (run.status !== 'running' || run.startedAt === null) return;
  if (now - Date.parse(run.startedAt) < DEMO_AWS_DISCOVERY_RUN_MS) return;
  const main = account.regions[0] ?? 'sa-east-1';
  const second = main === 'us-east-1' ? 'sa-east-1' : 'us-east-1';
  const regions = [main, second, 'us-west-2', 'eu-west-1'].filter(
    (region, index, list) => list.indexOf(region) === index,
  );
  const partial = fake.discoveryErrors.length > 0;
  Object.assign(run, {
    status: partial ? 'partial' : 'succeeded',
    finishedAt: iso(now),
    regions,
    errors: fake.discoveryErrors,
  });
  storeDiscovery(account, fake, now);
  fake.lastCompletedAt = iso(now);
  fake.infrastructure = demoInfrastructure(partial);
  fake.discoveredRegions = [main, second].sort();
  if (account.managedBy !== 'verax') {
    account.regions = [...new Set([...account.regions, ...fake.discoveredRegions])];
    account.updatedAt = iso(now);
  }
}

/** A conferência de permissão pedida no painel: o grupo sem etiqueta passa a ter (o cliente rodou o comando). */
function answerProbes(fake: AwsFake, now: number): void {
  for (const source of fake.sources) {
    if (source.probeRequestedAt === null) continue;
    if (now - Date.parse(source.probeRequestedAt) < DEMO_AWS_PROBE_DELAY_MS) continue;
    source.probeRequestedAt = null;
    source.permissionCheckedAt = iso(now);
    const fixable =
      source.permissionDetail === 'tag_missing' ||
      source.permissionDetail === 'probe_failed' ||
      source.permission === 'unknown';
    if (!fixable || fake.frozen.has(source.id) || source.origin === 'legacy') continue;
    Object.assign(source, {
      permission: 'granted',
      permissionDetail: null,
      notes: source.notes.filter((note) => note !== 'tag_required'),
      ...(source.kind === 'cloudwatch_log_group' && { details: { ...source.details, tagged: true } }),
    });
    if (source.authorization.revokedAt !== null) continue;
    if (!isAuthorized(source)) setState(source, 'available', null, now);
    else if (source.state === 'permission_error') setState(source, 'authorized', 'awaiting_collector', now);
  }
}

/**
 * Os coletores da demonstração: a fonte autorizada passa por "configurando", "ainda sem eventos" e "coletando" (as de
 * achados, lidas pela API, mais cedo). Nos cenários de erro, a primeira fonte autorizada pela tela para em erro de
 * permissão ou em falha de ingestão.
 */
function runCollectors(account: CloudAccount, fake: AwsFake, now: number): void {
  if (!entersRole(account)) return;
  if (fake.scenario !== 'happy' && fake.troubled === null) {
    fake.troubled =
      fake.sources.find(
        (source) => isAuthorized(source) && source.origin !== 'legacy' && !fake.frozen.has(source.id),
      )?.id ?? null;
  }
  for (const source of fake.sources) {
    if (!isAuthorized(source) || fake.frozen.has(source.id)) continue;
    if (source.state === 'collecting') {
      source.health = collectingHealth(source, now);
      continue;
    }
    if (!['authorized', 'configuring', 'waiting_events'].includes(source.state)) continue;
    const since = Date.parse(source.authorization.authorizedAt ?? source.stateSince);
    // Uma fonte que voltou a esperar o coletor (o bucket trocado, a permissão corrigida) recomeça dali.
    const elapsed =
      now - Math.max(since, source.state === 'authorized' ? Date.parse(source.stateSince) : since);
    if (source.id === fake.troubled && elapsed >= DEMO_AWS_COLLECTOR_MS.configuring) {
      if (fake.scenario === 'permission_error') {
        Object.assign(source, { permission: 'missing', permissionDetail: 'kms_denied' });
        setState(source, 'permission_error', 'kms_denied', now);
        fake.frozen.add(source.id);
        continue;
      }
      if (fake.scenario === 'ingestion_failure') {
        setState(source, 'ingestion_error', 'parse_error', now);
        fake.frozen.add(source.id);
        continue;
      }
    }
    const collectingAt =
      source.method === 'api' ? DEMO_AWS_COLLECTOR_MS.api : DEMO_AWS_COLLECTOR_MS.collecting;
    if (elapsed >= collectingAt) {
      setState(source, 'collecting', null, now);
      source.health = collectingHealth(source, now);
    } else if (elapsed >= DEMO_AWS_COLLECTOR_MS.waitingEvents && source.method !== 'api') {
      setState(source, 'waiting_events', null, now);
      source.health = { ...NO_HEALTH, lastSyncAt: iso(now) };
    } else if (elapsed >= DEMO_AWS_COLLECTOR_MS.configuring) {
      setState(source, 'configuring', null, now);
    }
  }
}

/** Um passo do "worker" da demonstração para uma conta AWS: tudo o que o tempo já deixou acontecer. */
export function advanceAwsAccount(
  store: AwsOnboardingStore,
  account: CloudAccount,
  now: Date = new Date(),
): void {
  if (account.provider !== 'aws') return;
  const fake = awsFakeOf(store, account);
  const at = now.getTime();
  syncLegacySources(account, fake, at);
  if (account.status !== 'active') return;
  answerCheck(account, fake, at);
  runDiscovery(account, fake, at);
  answerProbes(fake, at);
  runCollectors(account, fake, at);
}

function scenarioOf(accountId: string): AwsFakeScenario {
  if (accountId === DEMO_AWS_SCENARIO_ACCOUNTS.timeout) return 'timeout';
  if (accountId === DEMO_AWS_SCENARIO_ACCOUNTS.permissionError) return 'permission_error';
  if (accountId === DEMO_AWS_SCENARIO_ACCOUNTS.ingestionFailure) return 'ingestion_failure';
  return 'happy';
}

function emptyFake(accountId: string): AwsFake {
  return {
    scenario: scenarioOf(accountId),
    connectRequestedAt: null,
    templateVersion: null,
    capabilities: [],
    capabilitiesCheckedAt: null,
    discoveredRegions: [],
    run: null,
    lastCompletedAt: null,
    infrastructure: null,
    sources: [],
    frozen: new Set(),
    discoveryErrors: [],
    troubled: null,
    discoveryDueAt: null,
  };
}

/** O que o mock guarda da conta; a conta nova começa sem nada (ninguém pediu a conexão). */
export function awsFakeOf(store: AwsOnboardingStore, account: CloudAccount): AwsFake {
  let fake = store.get(account.id);
  if (fake === undefined) {
    fake = emptyFake(account.accountId);
    store.set(account.id, fake);
  }
  return fake;
}

// --- As contas da demonstração ---

/** Uma descoberta que já terminou, há `minutes` minutos. */
function finishedRun(
  now: number,
  minutes: number,
  account: CloudAccount,
  errors: AwsDiscoveryError[],
): AwsDiscoveryRun {
  sequence += 1;
  const main = account.regions[0] ?? 'sa-east-1';
  return {
    id: `018f2c1e-0000-7000-8000-00d5${sequence.toString(16).padStart(8, '0')}`,
    trigger: 'scheduled',
    status: errors.length > 0 ? 'partial' : 'succeeded',
    requestedAt: iso(now - minutes * 60_000 - 20_000),
    startedAt: iso(now - minutes * 60_000 - 15_000),
    finishedAt: iso(now - minutes * 60_000),
    regions: [...new Set([main, 'us-east-1', 'us-west-2', 'eu-west-1'])],
    errors,
    requestedBy: null,
  };
}

/** Põe uma fonte da demonstração num estado fixo, autorizada há `days` dias, e a tira do alcance do "worker". */
function pin(
  fake: AwsFake,
  now: number,
  match: (source: AwsSource) => boolean,
  state: AwsSourceState,
  patch: Partial<AwsSource> = {},
  days = 12,
): void {
  const source = fake.sources.find(match);
  if (source === undefined) return;
  Object.assign(source, {
    authorization: {
      authorizedAt: iso(now - days * DAY),
      authorizedBy: 'demo-marina.alves',
      revokedAt: null,
    },
    collectFrom: iso(now - days * DAY).slice(0, 10),
    state,
    stateCode: null,
    stateSince: iso(now - 2 * HOUR),
    ...(state === 'collecting' && { health: collectingHealth(source, now) }),
    ...patch,
  });
  fake.frozen.add(source.id);
}

/**
 * O estado inicial das contas AWS da demonstração (`demoAdminStore`): a produção da Alfa, parcialmente operacional; a
 * homologação, desconectada; a da Beta, coletando com a pilha do modelo anterior.
 */
export function demoAwsOnboardingStore(
  accounts: readonly CloudAccount[],
  now: Date = new Date(),
): AwsOnboardingStore {
  const store: AwsOnboardingStore = new Map();
  const at = now.getTime();
  for (const account of accounts) {
    if (account.provider !== 'aws') continue;
    const fake = awsFakeOf(store, account);
    syncLegacySources(account, fake, at - 40 * DAY);
    if (account.connection !== 'connected') continue;
    const beta = account.accountId === DEMO_ACCOUNTS.beta;
    fake.capabilitiesCheckedAt = iso(at - 3 * HOUR);
    // A Beta criou a pilha com o modelo anterior; a produção da Alfa desligou a leitura dos grupos de logs.
    fake.templateVersion = beta ? 1 : AWS_READER_TEMPLATE_VERSION;
    fake.capabilities = beta ? ['discovery'] : ['discovery', 'service-logs', 'findings'];
    fake.discoveryErrors = beta
      ? []
      : [
          { service: 'inspector', region: 'us-east-1', code: 'AccessDeniedException' },
          { service: 'cloudwatch_logs', region: 'us-east-1', code: 'TimeoutError' },
          { service: 'elb', region: 'sa-east-1', code: 'Truncated' },
        ];
    fake.run = finishedRun(at, 95, account, fake.discoveryErrors);
    storeDiscovery(account, fake, at - 95 * 60_000);
    fake.lastCompletedAt = fake.run.finishedAt;
    fake.infrastructure = demoInfrastructure(fake.discoveryErrors.length > 0);
    fake.discoveredRegions = [...new Set([account.regions[0] ?? 'sa-east-1', 'us-east-1'])].sort();

    // Os buckets do cadastro: lidos há tempo. O do WAF da Alfa está configurado e ainda sem evento.
    for (const source of fake.sources.filter((candidate) => candidate.origin === 'legacy')) {
      Object.assign(source, { permission: 'granted', permissionCheckedAt: iso(at - 10 * 60_000) });
      const quiet = source.kind === 'waf';
      setState(source, quiet ? 'waiting_events' : 'collecting', null, at - 30 * DAY);
      source.health = quiet ? { ...NO_HEALTH, lastSyncAt: iso(at - 60_000) } : collectingHealth(source, at);
      fake.frozen.add(source.id);
    }
    if (beta) continue;
    pin(fake, at, (source) => source.kind === 'guardduty', 'collecting');
    pin(
      fake,
      at,
      (source) => source.kind === 'security_hub' && source.permission === 'granted',
      'collecting',
    );
    pin(fake, at, (source) => source.kind === 'access_analyzer', 'configuring', {}, 0);
    // Os flow logs pararam de chegar há 3 horas.
    pin(fake, at, (source) => source.kind === 'vpc_flow_logs' && source.state === 'available', 'stalled', {
      health: {
        lastSyncAt: iso(at - 60_000),
        lastEventAt: iso(at - 3 * HOUR),
        lastIngestedAt: iso(at - 3 * HOUR + 60_000),
        lagSeconds: 3 * 3_600,
        eventsLast24h: 96_400,
        bytesLast24h: 1.1 * GB,
      },
    });
    // Uma Web ACL autorizada que foi apagada da conta, e outra com a autorização retirada.
    const gone = sourceRow(
      {
        kind: 'waf',
        region: account.regions[0] ?? 'sa-east-1',
        resourceId: 'a1b2c3d4-0000-4000-8000-0000000000aa',
        name: 'acl-antiga',
        loggingState: 'logging',
        details: { webAclName: 'acl-antiga', webAclScope: 'REGIONAL', destinationType: 's3' },
      },
      at - 60 * DAY,
    );
    fake.sources.push(gone);
    pin(fake, at, (source) => source === gone, 'source_missing', {
      stateCode: 'not_found',
      missingSince: iso(at - 2 * DAY),
    });
    const revoked = sourceRow(
      {
        kind: 'access_analyzer',
        region: 'us-east-1',
        resourceId: 'analisador-de-acesso-nao-usado',
        name: 'analisador-de-acesso-nao-usado',
        loggingState: 'enabled',
        details: { analyzerType: 'ACCOUNT_UNUSED_ACCESS' },
      },
      at - 20 * DAY,
    );
    Object.assign(revoked, {
      authorization: {
        authorizedAt: iso(at - 15 * DAY),
        authorizedBy: 'demo-marina.alves',
        revokedAt: iso(at - 4 * DAY),
      },
      collectFrom: iso(at - 15 * DAY).slice(0, 10),
      state: 'revoked',
      stateCode: null,
      stateSince: iso(at - 4 * DAY),
    });
    fake.sources.push(revoked);
    fake.frozen.add(revoked.id);
  }
  return store;
}

// --- O estado da conta e as conferências (as regras de `onboarding-state.ts`, da API) ---

const AWS_LAG_LIMIT_SECONDS = 2 * 60 * 60;
const PENDING_STATES: readonly AwsSourceState[] = ['authorized', 'configuring', 'waiting_events'];
const AWAITING_COLLECTOR_STATES: readonly AwsSourceState[] = ['authorized', 'configuring'];

function check(
  id: AwsOnboardingCheckId,
  status: AwsOnboardingCheckStatus,
  code: string | null = null,
  checkedAt: string | null = null,
): AwsOnboardingCheck {
  return { id, status, code, checkedAt };
}

/** As linhas dos buckets do cadastro levam a permissão que a conferência da conexão provou (`legacyPermission`). */
function withLegacyPermission(source: AwsSource, account: CloudAccount): AwsSource {
  if (source.origin !== 'legacy') return source;
  const unknown: AwsSource = { ...source, permission: 'unknown', permissionDetail: null };
  if (account.status !== 'active' || account.checkRequestedAt !== null) return unknown;
  if (account.connection === 'connected') return { ...source, permission: 'granted', permissionDetail: null };
  if (account.connection !== 'error' || account.connectionError === null) return unknown;
  const parsed = parseAwsConnectionError(account.connectionError);
  if (parsed === null || !BUCKET_ERRORS.includes(parsed.code)) return unknown;
  if (parsed.source !== null && parsed.source !== source.details.legacySource) return unknown;
  return {
    ...source,
    permission: 'missing',
    permissionDetail: parsed.code,
    state: 'permission_error',
    stateCode: parsed.code,
  };
}

function deriveOnboarding(
  account: CloudAccount,
  fake: AwsFake,
  sources: readonly AwsSource[],
): Pick<AwsOnboarding, 'state' | 'checks'> & { waitingUntil: string | null } {
  const active = account.status === 'active';
  const pending = active && account.checkRequestedAt !== null;
  const timedOut = account.connection === 'error' && account.connectionError === 'authorization_timeout';
  const bucketError = account.connection === 'error' && isBucketError(account.connectionError);
  const entered = active && !pending && (account.connection === 'connected' || bucketError);
  const refused = active && !pending && account.connection === 'error' && !bucketError;
  const connectionCode = account.connectionError?.split(':', 1)[0] ?? null;
  const authorized = sources.filter(isAuthorized);
  const connect = isConnectRequest(account, fake);
  const run = fake.run;
  const checkedAt = fake.capabilitiesCheckedAt;

  const checks: AwsOnboardingCheck[] = [
    pending
      ? check('assume_role', 'pending', connect ? 'awaiting_stack' : 'verifying')
      : refused
        ? check('assume_role', 'failed', connectionCode)
        : entered
          ? check('assume_role', 'ok', account.connection === 'connected' ? connectionCode : null, checkedAt)
          : check('assume_role', 'pending', 'not_requested'),
    pending
      ? check('identity', 'pending')
      : entered
        ? check('identity', 'ok', null, checkedAt)
        : refused && connectionCode === 'account_mismatch'
          ? check('identity', 'failed', 'account_mismatch')
          : check('identity', 'skipped'),
    !entered
      ? check('template', 'skipped')
      : checkedAt === null
        ? check('template', 'pending')
        : fake.templateVersion === null
          ? check('template', 'failed', 'template_unreadable', checkedAt)
          : isAwsTemplateOutdated(fake.templateVersion)
            ? check('template', 'failed', 'template_outdated', checkedAt)
            : check('template', 'ok', null, checkedAt),
    !entered
      ? check('discovery', 'skipped')
      : run === null
        ? check('discovery', 'pending', 'not_requested')
        : run.status === 'pending' || run.status === 'running'
          ? check('discovery', 'pending', run.status)
          : run.status === 'failed'
            ? check('discovery', 'failed', run.errors[0]?.code ?? null, run.finishedAt)
            : check('discovery', 'ok', run.status === 'partial' ? 'partial' : null, run.finishedAt),
  ];
  if (authorized.length === 0) {
    checks.push(
      bucketError ? check('permission', 'failed', connectionCode) : check('permission', 'skipped'),
      check('collector_config', 'skipped'),
      check('events', 'skipped'),
      check('last_sync', 'skipped'),
      check('lag', 'skipped'),
    );
  } else {
    const denied = authorized.find(
      (source) => source.state === 'permission_error' || source.permission === 'missing',
    );
    const awaitingCollector = authorized.some((source) => AWAITING_COLLECTOR_STATES.includes(source.state));
    const failing = authorized.find(
      (source) => source.state === 'ingestion_error' || source.state === 'stalled',
    );
    const synced = authorized.map((source) => source.health.lastSyncAt);
    const oldest = synced.every((at) => at !== null) ? ([...synced].sort()[0] ?? null) : null;
    const lags = authorized.flatMap((source) =>
      source.health.lagSeconds === null ? [] : [source.health.lagSeconds],
    );
    checks.push(
      bucketError
        ? check('permission', 'failed', connectionCode)
        : denied !== undefined
          ? check('permission', 'failed', denied.permissionDetail ?? denied.stateCode)
          : authorized.some((source) => source.permission === 'unknown')
            ? check('permission', 'pending')
            : check('permission', 'ok'),
      account.collectionError != null
        ? check('collector_config', 'failed', account.collectionError)
        : awaitingCollector
          ? check('collector_config', 'pending', 'awaiting_collector')
          : check('collector_config', 'ok'),
      failing !== undefined
        ? check('events', 'failed', failing.stateCode ?? failing.state)
        : authorized.every((source) => source.state === 'collecting')
          ? check('events', 'ok')
          : check('events', 'pending', awaitingCollector ? 'awaiting_collector' : 'waiting_events'),
      oldest !== null ? check('last_sync', 'ok', null, oldest) : check('last_sync', 'pending', 'no_data'),
      authorized.some((source) => source.state === 'stalled') ||
        lags.some((lag) => lag > AWS_LAG_LIMIT_SECONDS)
        ? check('lag', 'failed', 'stalled')
        : lags.length === authorized.length
          ? check('lag', 'ok')
          : check('lag', 'pending', 'no_data'),
    );
  }

  const state = ((): AwsOnboardingState => {
    if (!active) return 'not_started';
    if (timedOut && !pending) return 'authorization_timeout';
    if (pending) return 'awaiting_authorization';
    if (account.connection === 'waiting') return 'not_started';
    if (refused) return 'disconnected';
    if (fake.lastCompletedAt === null) {
      return run !== null && (run.status === 'pending' || run.status === 'running')
        ? 'discovering'
        : 'authenticated';
    }
    if (authorized.length === 0) return 'awaiting_sources';
    if (
      bucketError ||
      authorized.some((source) => source.state === 'permission_error' || source.permission === 'missing')
    ) {
      return 'permission_error';
    }
    if (account.collectionError != null || authorized.some((source) => source.state === 'ingestion_error')) {
      return 'ingestion_failure';
    }
    const collecting = authorized.filter((source) => source.state === 'collecting').length;
    if (collecting === 0) {
      return authorized.some((source) => PENDING_STATES.includes(source.state))
        ? 'configuring'
        : 'ingestion_failure';
    }
    return collecting === authorized.length ? 'collecting' : 'partial';
  })();

  // No cenário do tempo esgotado, a janela da demonstração é curta, para o desfecho aparecer sem esperar 60 min.
  const windowMs = fake.scenario === 'timeout' ? DEMO_AWS_CONNECT_TIMEOUT_MS : AWS_CONNECT_WINDOW_MS;
  const waitingUntil =
    pending && connect && account.checkRequestedAt !== null
      ? iso(Date.parse(account.checkRequestedAt) + windowMs)
      : null;
  return { state, checks, waitingUntil };
}

/** A ordem das fontes na resposta, como a da API: tipo, região, nome e ID. */
const SOURCE_ORDER = ['kind', 'region', 'name', 'id'] as const;

/** O estado da conta como a API o devolve (`GET …/aws/onboarding`), conferido pelo schema do contrato. */
export function awsOnboardingView(
  account: CloudAccount,
  fake: AwsFake,
  credentialMode: AwsCredentialMode = 'role',
): AwsOnboarding {
  const sources = fake.sources
    .map((source) => withLegacyPermission(source, account))
    .sort((a, b) => {
      for (const field of SOURCE_ORDER) {
        const order = a[field].localeCompare(b[field]);
        if (order !== 0) return order;
      }
      return 0;
    });
  const derived = deriveOnboarding(account, fake, sources);
  const updatedAt = [
    account.updatedAt,
    fake.run?.finishedAt ?? null,
    ...sources.map((source) => source.stateSince),
  ]
    .filter((at): at is string => at !== null)
    .sort()
    .at(-1);
  return awsOnboardingSchema.parse({
    cloudAccountId: account.id,
    state: derived.state,
    credentialMode,
    connect: { requestedAt: fake.connectRequestedAt, waitingUntil: derived.waitingUntil },
    checks: derived.checks,
    template: {
      version: fake.templateVersion,
      capabilities: AWS_READER_CAPABILITIES.filter((capability) => fake.capabilities.includes(capability)),
      outdated: isAwsTemplateOutdated(fake.templateVersion),
      checkedAt: fake.capabilitiesCheckedAt,
    },
    discovery: { run: fake.run, lastCompletedAt: fake.lastCompletedAt, regions: fake.discoveredRegions },
    infrastructure: fake.lastCompletedAt === null ? null : fake.infrastructure,
    sources,
    updatedAt: updatedAt ?? account.updatedAt,
  });
}

// --- As rotas ---

const url = (path: string): string => `${API_URL}${path}`;
const problem = (status: number, message: string, code?: string) =>
  HttpResponse.json({ statusCode: status, message, ...(code ? { code } : {}) }, { status });
const refusal = (status: number, message: string, code: AwsOnboardingErrorCode) =>
  problem(status, message, code);

type Found = { ok: true; account: CloudAccount; userId: string } | { ok: false; error: Response };

export interface AwsOnboardingMockDeps {
  store: AwsOnboardingStore;
  /** A conta AWS do cliente da sessão, com a permissão conferida (e o CSRF, nas escritas); ou a recusa. */
  findAccount: (id: string, write: Request | null) => Found;
  /** Como o nó lê a conta: pelo papel, ou com a chave (a VM própria do cliente). */
  credentialMode: () => AwsCredentialMode;
}

/** As rotas do onboarding da AWS no mock, com os mesmos status e códigos de recusa da API. */
export function createAwsOnboardingHandlers({ store, findAccount, credentialMode }: AwsOnboardingMockDeps) {
  const view = (account: CloudAccount, status = 200) =>
    HttpResponse.json(awsOnboardingView(account, awsFakeOf(store, account), credentialMode()), { status });
  /** A conta já com o que o "worker" da demonstração fez até agora. */
  const load = (id: unknown, write: Request | null): Found => {
    const found = findAccount(String(id), write);
    if (found.ok) advanceAwsAccount(store, found.account);
    return found;
  };
  const inactive = (account: CloudAccount, message: string) =>
    account.status === 'active' ? null : problem(400, message);
  const notConnected = (account: CloudAccount) =>
    account.checkRequestedAt !== null || !entersRole(account)
      ? refusal(409, 'Conecte a conta antes de descobrir as fontes.', 'ACCOUNT_NOT_CONNECTED')
      : null;
  const legacy = (source: AwsSource) =>
    source.origin === 'legacy'
      ? refusal(409, 'Esta fonte é um bucket do cadastro da conta: altere-o no cadastro.', 'SOURCE_LEGACY')
      : null;

  return [
    http.get(url('/v1/cloud-accounts/:id/aws/onboarding'), ({ params }) => {
      const found = load(params['id'], null);
      return found.ok ? view(found.account) : found.error;
    }),

    // "Conectar com AWS": grava o pedido do "Conectar" e o da verificação com o mesmo horário; o pendente não renova.
    http.post(url('/v1/cloud-accounts/:id/aws/connect'), ({ params, request }) => {
      const found = load(params['id'], request);
      if (!found.ok) return found.error;
      const { account } = found;
      const refused = inactive(account, 'Reative o monitoramento antes de conectar a conta.');
      if (refused) return refused;
      const fake = awsFakeOf(store, account);
      if (!isConnectRequest(account, fake)) {
        const now = new Date().toISOString();
        fake.connectRequestedAt = now;
        Object.assign(account, {
          connection: 'waiting',
          connectionError: null,
          checkRequestedAt: now,
          updatedAt: now,
        });
      }
      return view(account, 202);
    }),

    // A descoberta manual: uma por vez, e no máximo uma a cada 5 min.
    http.post(url('/v1/cloud-accounts/:id/aws/discovery'), ({ params, request }) => {
      const found = load(params['id'], request);
      if (!found.ok) return found.error;
      const { account } = found;
      const refused =
        inactive(account, 'Reative o monitoramento antes de descobrir as fontes.') ?? notConnected(account);
      if (refused) return refused;
      const fake = awsFakeOf(store, account);
      const now = Date.now();
      const run = fake.run;
      const active = run !== null && (run.status === 'pending' || run.status === 'running');
      if (!active) {
        if (
          run !== null &&
          run.trigger === 'manual' &&
          now - Date.parse(run.requestedAt) < AWS_DISCOVERY_MANUAL_INTERVAL_MS
        ) {
          return refusal(
            429,
            'A descoberta acabou de rodar. Tente de novo em alguns minutos.',
            'DISCOVERY_RATE_LIMITED',
          );
        }
        requestDiscovery(fake, 'manual', now, found.userId);
      }
      return view(account, 202);
    }),

    // A autorização: tudo ou nada, com as mesmas recusas da API, na mesma ordem.
    http.post(url('/v1/cloud-accounts/:id/aws/sources/authorize'), async ({ params, request }) => {
      const found = load(params['id'], request);
      if (!found.ok) return found.error;
      const { account } = found;
      const input = awsSourcesAuthorizeSchema.safeParse(await request.json().catch(() => undefined));
      if (!input.success) return problem(400, 'Dados inválidos');
      const refused = inactive(account, 'Reative o monitoramento antes de autorizar uma fonte.');
      if (refused) return refused;
      const fake = awsFakeOf(store, account);
      const rows = fake.sources.filter((source) => input.data.sourceIds.includes(source.id));
      if (rows.length !== input.data.sourceIds.length) return problem(404, 'Fonte não encontrada');
      const confirmed = new Set(input.data.sensitiveSourceIds ?? []);
      for (const row of rows) {
        const refusedLegacy = legacy(row);
        if (refusedLegacy) return refusedLegacy;
      }
      const pending = rows.filter((row) => !isAuthorized(row) || row.state === 'source_missing');
      for (const row of pending) {
        if (!row.collectable) {
          return refusal(409, 'Este tipo de fonte ainda não é coletado.', 'SOURCE_NOT_COLLECTABLE');
        }
        if (row.availability !== 'available' || row.missingSince !== null) {
          return refusal(
            409,
            'Esta fonte não está disponível para coleta. Rode a descoberta de novo.',
            'SOURCE_NOT_AVAILABLE',
          );
        }
        if (row.notes.includes('covered_by_legacy')) {
          return refusal(
            409,
            'O bucket desta fonte já é lido pelo cadastro da conta.',
            'SOURCE_COVERED_BY_LEGACY',
          );
        }
        if (row.permission !== 'granted') {
          return refusal(
            409,
            'O Verax ainda não tem permissão para ler esta fonte.',
            'SOURCE_PERMISSION_MISSING',
          );
        }
        if (row.sensitive && !confirmed.has(row.id)) {
          return refusal(
            400,
            'Confirme cada fonte sensível, uma a uma, para autorizá-la.',
            'SENSITIVE_CONFIRMATION_REQUIRED',
          );
        }
      }
      const others = fake.sources.filter((source) => isAuthorized(source) && !pending.includes(source));
      const count = (list: readonly AwsSource[], method: AwsSource['method']) =>
        list.filter((source) => source.method === method).length;
      if (
        (count(pending, 'cloudwatch') > 0 &&
          count(others, 'cloudwatch') + count(pending, 'cloudwatch') > AWS_MAX_AUTHORIZED_LOG_GROUPS) ||
        (count(pending, 's3') > 0 &&
          count(others, 's3') + count(pending, 's3') > AWS_MAX_AUTHORIZED_S3_SOURCES)
      ) {
        return refusal(
          409,
          'Esta conta já tem o máximo de fontes deste tipo autorizadas.',
          'SOURCE_LIMIT_REACHED',
        );
      }
      const now = Date.now();
      for (const row of pending) {
        Object.assign(row, {
          authorization: { authorizedAt: iso(now), authorizedBy: found.userId, revokedAt: null },
          collectFrom: iso(now).slice(0, 10),
          health: { ...NO_HEALTH },
        });
        fake.frozen.delete(row.id);
        setState(row, 'authorized', 'awaiting_collector', now);
      }
      return view(account);
    }),

    http.post(url('/v1/cloud-accounts/:id/aws/sources/:sourceId/revoke'), ({ params, request }) => {
      const found = load(params['id'], request);
      if (!found.ok) return found.error;
      const fake = awsFakeOf(store, found.account);
      const row = fake.sources.find((source) => source.id === params['sourceId']);
      if (row === undefined) return problem(404, 'Fonte não encontrada');
      const refused = legacy(row);
      if (refused) return refused;
      if (!isAuthorized(row)) return refusal(409, 'Esta fonte não está autorizada.', 'SOURCE_NOT_AUTHORIZED');
      const now = Date.now();
      row.authorization = { ...row.authorization, revokedAt: iso(now) };
      row.health = { ...NO_HEALTH };
      fake.frozen.delete(row.id);
      setState(row, 'revoked', null, now);
      return view(found.account);
    }),

    // "Verificar de novo" numa fonte: grava o pedido; quem confere é o "worker" da demonstração.
    http.post(url('/v1/cloud-accounts/:id/aws/sources/:sourceId/retry'), ({ params, request }) => {
      const found = load(params['id'], request);
      if (!found.ok) return found.error;
      const { account } = found;
      const refused = inactive(account, 'Reative o monitoramento antes de conferir uma fonte.');
      if (refused) return refused;
      const row = awsFakeOf(store, account).sources.find((source) => source.id === params['sourceId']);
      if (row === undefined) return problem(404, 'Fonte não encontrada');
      const blocked = legacy(row) ?? notConnected(account);
      if (blocked) return blocked;
      row.probeRequestedAt ??= new Date().toISOString();
      return view(account, 202);
    }),
  ];
}
