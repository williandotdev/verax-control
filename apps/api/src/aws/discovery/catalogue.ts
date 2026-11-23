import {
  AWS_SOURCE_GLOBAL_REGION,
  AWS_SOURCE_NONE_RESOURCE,
  type AwsLogGroupCategory,
  type AwsOnboardingCapability,
  type AwsSourceAvailability,
  type AwsSourceDetails,
  type AwsSourceKind,
  type AwsSourceLoggingState,
  type AwsSourceNote,
  type AwsSourcePermission,
  bucketNameProblem,
  type LogBuckets,
  type LogSource,
} from '@verax/shared';

/**
 * O catálogo da descoberta (onboarding self-service): do que cada serviço da AWS respondeu (`lookups.ts`) para as fontes
 * de log que a tela mostra. Só classificação, sem rede nem banco; a ideia vem de `infra/diagnostico/diagnostico_aws.py`
 * (as fontes sugeridas e as categorias dos grupos de logs).
 *
 * Cada fonte diz se dá para ler de onde está (`availability`) e o que o cliente precisa saber antes de autorizar
 * (`notes`). A permissão sai da sondagem (`probes.ts`), depois. Os caminhos no S3 seguem o padrão da AWS,
 * `[<prefixo>/]AWSLogs/[<organização>/]<conta>/<Serviço>/<região>/`, que é o que o papel de leitura lê sem o cliente
 * citar bucket nenhum.
 */

/** Uma fonte como a descoberta a viu, antes de ir para o banco. */
export interface DiscoveredSource {
  kind: AwsSourceKind;
  /** A região da AWS, ou `global`. */
  region: string;
  resourceId: string;
  name: string;
  availability: AwsSourceAvailability;
  loggingState: AwsSourceLoggingState | null;
  notes: AwsSourceNote[];
  details: AwsSourceDetails;
  permission: AwsSourcePermission;
  permissionDetail: string | null;
}

/** O que a classificação precisa saber da conta. */
export interface CatalogueContext {
  /** O ID da conta AWS (12 dígitos): entra nos caminhos `AWSLogs/<conta>/`. */
  accountId: string;
  /** Os buckets do cadastro anterior da conta: o papel os lê inteiros (`LogBucketArns` da pilha). */
  legacyBuckets: LogBuckets;
  /** As capacidades do papel pelas tags; null quando não se sabe (template v1, ou a chave de leitura da VM própria). */
  capabilities: readonly AwsOnboardingCapability[] | null;
}

// --- O que os serviços responderam ---

export interface TrailFact {
  arn: string;
  name: string;
  homeRegion: string;
  bucket: string | null;
  keyPrefix: string | null;
  multiRegion: boolean;
  organizationTrail: boolean;
  kmsKeyId: string | null;
  logGroupArn: string | null;
  /** null: o status não pôde ser lido. */
  logging: boolean | null;
  managementEvents: boolean | null;
}

export interface FlowLogFact {
  id: string;
  /** A VPC, a sub-rede ou a interface. */
  attachedTo: string | null;
  trafficType: string | null;
  /** `s3`, `cloud-watch-logs` ou `kinesis-data-firehose`. */
  destinationType: string | null;
  /** O ARN do destino (o bucket com o prefixo, ou o Firehose). */
  destination: string | null;
  logGroupName: string | null;
  logFormat: string | null;
  fileFormat: string | null;
  hivePartitions: boolean;
}

export interface WebAclFact {
  id: string;
  name: string;
  arn: string;
  scope: 'REGIONAL' | 'CLOUDFRONT';
  /** Os destinos do log da Web ACL; vazio sem logging configurado. */
  destinations: string[];
}

export interface DetectorFact {
  id: string;
  /** null: o detector não pôde ser lido. */
  enabled: boolean | null;
  destinations: { id: string; arn: string | null; kmsKeyArn: string | null; status: string | null }[];
}

export interface AnalyzerFact {
  name: string;
  arn: string;
  type: string | null;
}

export interface LogGroupFact {
  name: string;
  arn: string | null;
  storedBytes: number | null;
  retentionDays: number | null;
  kmsKeyId: string | null;
  /** A tag de leitura; null quando as tags não foram lidas. */
  tagged: boolean | null;
}

export interface ConfigRecorderFact {
  name: string;
  recording: boolean | null;
  bucket: string | null;
  keyPrefix: string | null;
}

export interface LoadBalancerFact {
  name: string;
  arn: string;
  internetFacing: boolean;
  /** O log de acesso no S3; null desligado; undefined quando os atributos não foram lidos. */
  accessLogs: { bucket: string; prefix: string | null } | null | undefined;
}

// --- Caminhos no S3 ---

const S3_ARN_PREFIXES = ['arn:aws:s3:::', 'arn:aws-cn:s3:::', 'arn:aws-us-gov:s3:::'] as const;

/** O prefixo sem as barras das pontas; null para vazio. */
export function cleanPrefix(prefix: string | null | undefined): string | null {
  if (prefix == null) return null;
  let start = 0;
  let end = prefix.length;
  while (start < end && prefix.charAt(start) === '/') start += 1;
  while (end > start && prefix.charAt(end - 1) === '/') end -= 1;
  const cleaned = prefix.slice(start, end);
  return cleaned.length > 0 && cleaned.length <= 512 ? cleaned : null;
}

/** O bucket e o prefixo de um destino no S3 (`arn:aws:s3:::bucket/prefixo`); null fora desse formato. */
export function parseS3Destination(
  arn: string | null,
): { bucket: string; customPrefix: string | null } | null {
  if (arn === null) return null;
  const prefix = S3_ARN_PREFIXES.find((candidate) => arn.startsWith(candidate));
  if (prefix === undefined) return null;
  const rest = arn.slice(prefix.length);
  const slash = rest.indexOf('/');
  const bucket = slash < 0 ? rest : rest.slice(0, slash);
  if (bucketNameProblem(bucket) !== null) return null;
  return { bucket, customPrefix: slash < 0 ? null : cleanPrefix(rest.slice(slash + 1)) };
}

/**
 * O prefixo exato dos objetos de um serviço no padrão da AWS, com a barra no fim:
 * `[<prefixo>/]AWSLogs/[<organização>/]<conta>/<Serviço>/<região>/[<resto>/]`.
 */
export function awsLogsPrefix(parts: {
  customPrefix: string | null;
  organizationId?: string | null;
  accountId: string;
  service: string;
  region: string;
  tail?: string;
}): string {
  const head = parts.customPrefix === null ? '' : `${parts.customPrefix}/`;
  const organization = parts.organizationId ? `${parts.organizationId}/` : '';
  const tail = parts.tail === undefined ? '' : `${parts.tail}/`;
  return `${head}AWSLogs/${organization}${parts.accountId}/${parts.service}/${parts.region}/${tail}`;
}

/** A pasta de cada serviço dentro de `AWSLogs/<conta>/`. */
export const AWS_LOGS_SERVICE = {
  cloudtrail: 'CloudTrail',
  vpc_flow_logs: 'vpcflowlogs',
  waf: 'WAFLogs',
  guardduty_export: 'GuardDuty',
  config: 'Config',
  elb_logs: 'elasticloadbalancing',
} as const;

/**
 * A "região" no caminho dos logs de uma Web ACL do CloudFront (escopo global): a AWS grava em `WAFLogs/cloudfront/`.
 * Derivado da documentação do WAF, ainda sem conferência com objetos reais: um teste fixa o caminho gerado.
 */
export const WAF_CLOUDFRONT_PATH_REGION = 'cloudfront';

const LEGACY_SOURCE_OF_KIND: Partial<Record<AwsSourceKind, LogSource>> = {
  cloudtrail: 'cloudtrail',
  guardduty_export: 'guardduty',
  waf: 'waf',
};

/** O bucket é um dos do cadastro anterior (o papel o lê inteiro, com qualquer prefixo)? */
export function isLegacyBucket(bucket: string, context: CatalogueContext): boolean {
  const { cloudtrail, guardduty, waf } = context.legacyBuckets;
  return bucket === cloudtrail || bucket === guardduty || bucket === waf;
}

/** O mesmo bucket já é lido pelo cadastro anterior, para o mesmo tipo de log: autorizar a fonte duplicaria a coleta. */
function coveredByLegacy(kind: AwsSourceKind, bucket: string, context: CatalogueContext): boolean {
  const source = LEGACY_SOURCE_OF_KIND[kind];
  return source !== undefined && context.legacyBuckets[source] === bucket;
}

/** As notas de uma fonte lida de bucket: o prefixo fora do padrão e a cobertura pelo cadastro anterior. */
function bucketNotes(
  kind: AwsSourceKind,
  bucket: string,
  customPrefix: string | null,
  context: CatalogueContext,
): AwsSourceNote[] {
  const notes: AwsSourceNote[] = [];
  if (customPrefix !== null && !isLegacyBucket(bucket, context)) notes.push('additional_bucket_required');
  if (coveredByLegacy(kind, bucket, context)) notes.push('covered_by_legacy');
  return notes;
}

const arnOrUndefined = (value: string | null): string | undefined =>
  value !== null && value.startsWith('arn:') ? value : undefined;

const unknownPermission = { permission: 'unknown', permissionDetail: null } as const;

// --- CloudTrail ---

/** A trilha que grava num bucket. A que só manda para o CloudWatch Logs aparece pelo grupo dela. */
export function trailSource(trail: TrailFact, context: CatalogueContext): DiscoveredSource | null {
  if (trail.bucket === null || bucketNameProblem(trail.bucket) !== null) return null;
  const customPrefix = cleanPrefix(trail.keyPrefix);
  const notes = bucketNotes('cloudtrail', trail.bucket, customPrefix, context);
  // A trilha de organização grava no bucket da conta de gestão (ou da de arquivo de logs): a política dele decide.
  if (trail.organizationTrail) notes.unshift('central_bucket');
  const kmsKeyArn = arnOrUndefined(trail.kmsKeyId);
  return {
    kind: 'cloudtrail',
    region: trail.homeRegion,
    resourceId: trail.arn,
    name: trail.name,
    availability: 'available',
    loggingState: trail.logging === null ? null : trail.logging ? 'logging' : 'stopped',
    notes,
    details: {
      arn: trail.arn,
      destinationType: 's3',
      bucket: trail.bucket,
      prefix: awsLogsPrefix({
        customPrefix,
        accountId: context.accountId,
        service: AWS_LOGS_SERVICE.cloudtrail,
        region: trail.homeRegion,
      }),
      ...(customPrefix !== null && { customPrefix }),
      ...(kmsKeyArn !== undefined && { kmsKeyArn }),
      multiRegion: trail.multiRegion,
      organizationTrail: trail.organizationTrail,
      ...(trail.managementEvents !== null && { managementEvents: trail.managementEvents }),
    },
    ...unknownPermission,
  };
}

// --- VPC Flow Logs ---

/** Os 14 campos do formato padrão, o único que o Wazuh interpreta. */
export const DEFAULT_FLOW_LOG_FIELDS = [
  'version',
  'account-id',
  'interface-id',
  'srcaddr',
  'dstaddr',
  'srcport',
  'dstport',
  'protocol',
  'packets',
  'bytes',
  'start',
  'end',
  'action',
  'log-status',
] as const;

/** O formato do flow log é o padrão (os 14 campos, nessa ordem)? Sem formato informado, é o padrão. */
export function isDefaultFlowLogFormat(format: string | null): boolean {
  if (format === null) return true;
  const fields = format
    .trim()
    .split(/\s+/)
    .map((field) => (field.startsWith('${') && field.endsWith('}') ? field.slice(2, -1) : field));
  return (
    fields.length === DEFAULT_FLOW_LOG_FIELDS.length &&
    fields.every((field, index) => field === DEFAULT_FLOW_LOG_FIELDS[index])
  );
}

/**
 * O flow log que grava no S3 (ou num destino que o nó não lê). O que grava no CloudWatch Logs não vira fonte aqui: o
 * grupo dele é oferecido como grupo de logs (`flowLogGroup`). Em Parquet, com partições do Hive ou com campos fora do
 * padrão, o formato não é lido.
 */
export function flowLogSource(
  flow: FlowLogFact,
  region: string,
  context: CatalogueContext,
): DiscoveredSource | null {
  if (flow.destinationType === 'cloud-watch-logs') return null;
  const base = {
    kind: 'vpc_flow_logs' as const,
    region,
    resourceId: flow.id,
    name: flow.attachedTo === null ? flow.id : `${flow.id} (${flow.attachedTo})`,
    loggingState: 'logging' as const,
    ...unknownPermission,
  };
  const common: AwsSourceDetails = {
    flowLogId: flow.id,
    ...(flow.attachedTo !== null && { attachedTo: flow.attachedTo }),
    ...(flow.trafficType !== null && { trafficType: flow.trafficType }),
  };
  const destination = parseS3Destination(flow.destination);
  if (flow.destinationType !== 's3' || destination === null) {
    const arn = arnOrUndefined(flow.destination);
    return {
      ...base,
      availability: 'unsupported_destination',
      notes: [],
      details: { ...common, destinationType: 'firehose', ...(arn !== undefined && { destination: arn }) },
    };
  }
  const { bucket, customPrefix } = destination;
  const fileFormat = flow.fileFormat ?? 'plain-text';
  const customFormat = !isDefaultFlowLogFormat(flow.logFormat);
  const readable = fileFormat === 'plain-text' && !flow.hivePartitions && !customFormat;
  return {
    ...base,
    availability: readable ? 'available' : 'unsupported_format',
    // Volume alto por natureza: conta no volume contratado.
    notes: ['high_volume', ...bucketNotes('vpc_flow_logs', bucket, customPrefix, context)],
    details: {
      ...common,
      destinationType: 's3',
      bucket,
      prefix: awsLogsPrefix({
        customPrefix,
        accountId: context.accountId,
        service: AWS_LOGS_SERVICE.vpc_flow_logs,
        region,
      }),
      ...(customPrefix !== null && { customPrefix }),
      fileFormat,
      hivePartitions: flow.hivePartitions,
      customFormat,
    },
  };
}

/** O grupo do CloudWatch Logs para onde um flow log grava; null quando o destino é outro. */
export function flowLogGroup(flow: FlowLogFact): string | null {
  return flow.destinationType === 'cloud-watch-logs' ? flow.logGroupName : null;
}

// --- WAF ---

const LOG_GROUP_MARKER = ':log-group:';

/** O nome e a região do grupo de um ARN do CloudWatch Logs (`arn:aws:logs:<região>:<conta>:log-group:<nome>[:*]`). */
export function parseLogGroupArn(arn: string | null): { region: string; name: string } | null {
  if (arn === null) return null;
  const marker = arn.indexOf(LOG_GROUP_MARKER);
  if (marker < 0) return null;
  const parts = arn.slice(0, marker).split(':');
  if (parts.length !== 5 || parts[0] !== 'arn' || parts[2] !== 'logs') return null;
  const region = parts[3] ?? '';
  let name = arn.slice(marker + LOG_GROUP_MARKER.length);
  if (name.endsWith(':*')) name = name.slice(0, -2);
  return region.length > 0 && name.length > 0 && name.length <= 512 ? { region, name } : null;
}

/**
 * A Web ACL e o log dela: num bucket (uma fonte por Web ACL, no caminho `WAFLogs/<região>/<nome>/`), sem log
 * configurado, ou num destino que o nó não lê (o Firehose). O log que vai para o CloudWatch Logs não vira fonte aqui: o
 * grupo é oferecido como grupo de logs (`webAclLogGroup`).
 */
export function webAclSource(
  acl: WebAclFact,
  region: string,
  context: CatalogueContext,
): DiscoveredSource | null {
  const cloudfront = acl.scope === 'CLOUDFRONT';
  const base = {
    kind: 'waf' as const,
    region: cloudfront ? AWS_SOURCE_GLOBAL_REGION : region,
    resourceId: acl.id,
    name: acl.name,
    ...unknownPermission,
  };
  const common: AwsSourceDetails = { arn: acl.arn, webAclName: acl.name, webAclScope: acl.scope };
  const [first] = acl.destinations;
  if (first === undefined) {
    return {
      ...base,
      availability: 'no_destination',
      loggingState: 'disabled',
      notes: ['aws_cost_waf_logging'],
      details: { ...common, destinationType: 'none' },
    };
  }
  if (parseLogGroupArn(first) !== null) return null;
  const destination = parseS3Destination(first);
  if (destination === null) {
    const arn = arnOrUndefined(first);
    return {
      ...base,
      availability: 'unsupported_destination',
      loggingState: 'logging',
      notes: [],
      details: { ...common, destinationType: 'firehose', ...(arn !== undefined && { destination: arn }) },
    };
  }
  const { bucket, customPrefix } = destination;
  return {
    ...base,
    availability: 'available',
    loggingState: 'logging',
    notes: bucketNotes('waf', bucket, customPrefix, context),
    details: {
      ...common,
      destinationType: 's3',
      bucket,
      prefix: awsLogsPrefix({
        customPrefix,
        accountId: context.accountId,
        service: AWS_LOGS_SERVICE.waf,
        region: cloudfront ? WAF_CLOUDFRONT_PATH_REGION : region,
        tail: acl.name,
      }),
      ...(customPrefix !== null && { customPrefix }),
    },
  };
}

/** O grupo do CloudWatch Logs para onde a Web ACL grava (com a região dele); null quando o destino é outro. */
export function webAclLogGroup(acl: WebAclFact): { region: string; name: string } | null {
  return parseLogGroupArn(acl.destinations[0] ?? null);
}

// --- GuardDuty ---

/** O detector (lido pela API) e cada export dele para um bucket. */
export function detectorSources(
  detector: DetectorFact,
  region: string,
  context: CatalogueContext,
): DiscoveredSource[] {
  const enabled = detector.enabled !== false;
  const sources: DiscoveredSource[] = [
    {
      kind: 'guardduty',
      region,
      resourceId: detector.id,
      name: 'GuardDuty',
      availability: enabled ? 'available' : 'not_enabled',
      loggingState: detector.enabled === null ? null : detector.enabled ? 'enabled' : 'disabled',
      // Com o detector ligado, a API é a forma recomendada de ler os achados.
      notes: enabled ? ['recommended'] : ['aws_cost_guardduty'],
      details: { detectorId: detector.id },
      ...unknownPermission,
    },
  ];
  for (const published of detector.destinations) {
    const destination = parseS3Destination(published.arn);
    if (destination === null) continue;
    const { bucket, customPrefix } = destination;
    const notes = bucketNotes('guardduty_export', bucket, customPrefix, context);
    // Com a API de achados liberada no papel, o export traz o mesmo achado: fica como alternativa.
    if (context.capabilities?.includes('findings') === true) notes.unshift('covered_by_api');
    const kmsKeyArn = arnOrUndefined(published.kmsKeyArn);
    sources.push({
      kind: 'guardduty_export',
      region,
      resourceId: published.id,
      name: bucket,
      availability: 'available',
      loggingState:
        published.status === null ? null : published.status === 'PUBLISHING' ? 'publishing' : 'stopped',
      notes,
      details: {
        detectorId: detector.id,
        destinationType: 's3',
        bucket,
        prefix: awsLogsPrefix({
          customPrefix,
          accountId: context.accountId,
          service: AWS_LOGS_SERVICE.guardduty_export,
          region,
        }),
        ...(customPrefix !== null && { customPrefix }),
        ...(kmsKeyArn !== undefined && { kmsKeyArn }),
      },
      ...unknownPermission,
    });
  }
  return sources;
}

// --- Security Hub, Inspector e Access Analyzer ---

export function securityHubSource(region: string, hubArn: string | null): DiscoveredSource {
  const arn = arnOrUndefined(hubArn);
  return {
    kind: 'security_hub',
    region,
    resourceId: 'hub',
    name: 'Security Hub',
    availability: 'available',
    loggingState: 'enabled',
    notes: [],
    details: arn === undefined ? {} : { arn },
    ...unknownPermission,
  };
}

export function inspectorSource(region: string): DiscoveredSource {
  return {
    kind: 'inspector',
    region,
    resourceId: 'account',
    name: 'Inspector',
    availability: 'available',
    loggingState: 'enabled',
    notes: [],
    details: {},
    ...unknownPermission,
  };
}

export function analyzerSource(analyzer: AnalyzerFact, region: string): DiscoveredSource {
  return {
    kind: 'access_analyzer',
    region,
    resourceId: analyzer.name,
    name: analyzer.name,
    availability: 'available',
    loggingState: 'enabled',
    notes: [],
    details: { arn: analyzer.arn, ...(analyzer.type !== null && { analyzerType: analyzer.type }) },
    ...unknownPermission,
  };
}

// --- Serviço desligado ---

/** O aviso de custo de ligar cada serviço. A Verax nunca liga: só avisa. */
const COST_NOTE: Partial<Record<AwsSourceKind, AwsSourceNote>> = {
  cloudtrail: 'aws_cost_new_trail',
  vpc_flow_logs: 'aws_cost_flow_logs',
  guardduty: 'aws_cost_guardduty',
  security_hub: 'aws_cost_security_hub',
  inspector: 'aws_cost_inspector',
  access_analyzer: 'aws_cost_access_analyzer',
};

/** Os tipos que ganham uma linha "desligado na conta" quando a descoberta não acha nenhum em região nenhuma. */
export const NOT_ENABLED_KINDS = [
  'cloudtrail',
  'vpc_flow_logs',
  'guardduty',
  'security_hub',
  'inspector',
  'access_analyzer',
] as const satisfies readonly AwsSourceKind[];

/** A linha de um serviço desligado na conta inteira (uma por tipo, na região `global`), com o aviso de custo. */
export function notEnabledSource(kind: AwsSourceKind, regionsChecked: readonly string[]): DiscoveredSource {
  const note = COST_NOTE[kind];
  return {
    kind,
    region: AWS_SOURCE_GLOBAL_REGION,
    resourceId: AWS_SOURCE_NONE_RESOURCE,
    name: kind,
    availability: 'not_enabled',
    loggingState: 'disabled',
    notes: note === undefined ? [] : [note],
    details: { regionsChecked: [...regionsChecked].sort().slice(0, 64) },
    ...unknownPermission,
  };
}

// --- CloudWatch Logs ---

/** Grupos de métricas de desempenho: não são eventos de segurança. */
const METRIC_PREFIXES = [
  '/aws/ecs/containerinsights',
  '/aws/containerinsights',
  '/aws/lambda-insights',
  'RDSOSMetrics',
] as const;

/** A categoria pelo nome do grupo (os padrões da própria AWS). */
const NAME_CATEGORIES: readonly (readonly [string, AwsLogGroupCategory])[] = [
  ['/aws/rds/', 'rds'],
  ['/aws/apigateway/', 'api_gateway'],
  ['API-Gateway-Execution-Logs', 'api_gateway'],
  ['/aws/route53/', 'route53'],
  ['/aws/lambda/', 'lambda'],
  ['/aws/eks/', 'eks'],
  ['/aws/amplify/', 'amplify'],
  ['aws-waf-logs-', 'waf'],
];

export function logGroupCategory(name: string): AwsLogGroupCategory {
  if (METRIC_PREFIXES.some((prefix) => name.startsWith(prefix))) return 'metrics';
  return NAME_CATEGORIES.find(([marker]) => name.includes(marker))?.[1] ?? 'other';
}

const GIB = 1024 ** 3;
/** Acima de 1 GiB por dia (o guardado dividido pela retenção), ou de 50 GiB guardados sem retenção: volume alto. */
const HIGH_VOLUME_DAILY_BYTES = GIB;
const HIGH_VOLUME_STORED_BYTES = 50 * GIB;

function isHighVolume(group: LogGroupFact, category: AwsLogGroupCategory): boolean {
  if (category === 'vpc_flow_logs') return true;
  if (group.storedBytes === null) return false;
  if (group.retentionDays === null) return group.storedBytes >= HIGH_VOLUME_STORED_BYTES;
  return group.storedBytes / group.retentionDays >= HIGH_VOLUME_DAILY_BYTES;
}

/**
 * Um grupo do CloudWatch Logs. `feeds` é quem grava nele, quando a descoberta sabe (a trilha, o flow log ou a Web ACL
 * que apontam para o grupo); sem isso, a categoria sai do nome. Todo grupo é sensível: pode trazer dado de aplicação,
 * e só é lido com a tag `verax-control = leitura`.
 */
export function logGroupSource(
  group: LogGroupFact,
  region: string,
  feeds?: Extract<AwsLogGroupCategory, 'cloudtrail' | 'vpc_flow_logs' | 'waf'>,
): DiscoveredSource {
  const category = feeds ?? logGroupCategory(group.name);
  const notes: AwsSourceNote[] = [];
  if (group.tagged !== true) notes.push('tag_required');
  if (category === 'metrics') notes.push('not_security_events');
  if (isHighVolume(group, category)) notes.push('high_volume');
  const arn = arnOrUndefined(group.arn);
  const kmsKeyArn = arnOrUndefined(group.kmsKeyId);
  return {
    kind: 'cloudwatch_log_group',
    region,
    resourceId: group.name,
    name: group.name,
    availability: 'available',
    loggingState: null,
    notes,
    details: {
      ...(arn !== undefined && { arn }),
      destinationType: 'cloudwatch',
      logGroup: group.name,
      ...(group.storedBytes !== null && { storedBytes: group.storedBytes }),
      retentionDays: group.retentionDays,
      ...(kmsKeyArn !== undefined && { kmsKeyArn }),
      category,
      ...(group.tagged !== null && { tagged: group.tagged }),
    },
    ...unknownPermission,
  };
}

// --- Descobertos, ainda não coletados ---

/** O gravador do Config e o bucket do canal de entrega. Descoberto e mostrado; ainda não coletado. */
export function configSource(
  recorder: ConfigRecorderFact,
  region: string,
  context: CatalogueContext,
): DiscoveredSource {
  const customPrefix = cleanPrefix(recorder.keyPrefix);
  const bucket =
    recorder.bucket !== null && bucketNameProblem(recorder.bucket) === null ? recorder.bucket : null;
  return {
    kind: 'config',
    region,
    resourceId: recorder.name,
    name: recorder.name,
    availability:
      recorder.recording === false ? 'not_enabled' : bucket === null ? 'no_destination' : 'available',
    loggingState: recorder.recording === null ? null : recorder.recording ? 'logging' : 'stopped',
    notes: ['not_collected_yet'],
    details: {
      ...(recorder.recording !== null && { recording: recorder.recording }),
      ...(bucket !== null && {
        destinationType: 's3' as const,
        bucket,
        prefix: awsLogsPrefix({
          customPrefix,
          accountId: context.accountId,
          service: AWS_LOGS_SERVICE.config,
          region,
        }),
      }),
      ...(customPrefix !== null && { customPrefix }),
    },
    ...unknownPermission,
  };
}

/** O load balancer com o log de acesso ligado. Descoberto e mostrado; ainda não coletado. */
export function loadBalancerSource(
  balancer: LoadBalancerFact,
  region: string,
  context: CatalogueContext,
): DiscoveredSource | null {
  if (balancer.accessLogs == null || bucketNameProblem(balancer.accessLogs.bucket) !== null) return null;
  const customPrefix = cleanPrefix(balancer.accessLogs.prefix);
  return {
    kind: 'elb_logs',
    region,
    resourceId: balancer.name,
    name: balancer.name,
    availability: 'available',
    loggingState: 'logging',
    notes: ['not_collected_yet'],
    details: {
      arn: balancer.arn,
      destinationType: 's3',
      bucket: balancer.accessLogs.bucket,
      prefix: awsLogsPrefix({
        customPrefix,
        accountId: context.accountId,
        service: AWS_LOGS_SERVICE.elb_logs,
        region,
      }),
      ...(customPrefix !== null && { customPrefix }),
    },
    ...unknownPermission,
  };
}
