import { z } from 'zod';
import {
  AWS_LOG_GROUP_TAG,
  AWS_READER_AUTHORIZATIONS,
  AWS_READER_CAPABILITIES,
  AWS_READER_TEMPLATE_VERSION,
  type AwsReaderAuthorization,
  type AwsReaderCapability,
} from './aws-reader.js';
import { bucketNameProblem, isAwsRegion } from './cloud-accounts.js';

/**
 * Onboarding self-service da AWS (`docs/ARQUITETURA.md`, "Onboarding AWS self-service"): o contrato entre a API e o
 * painel do que o nó descobre na conta do cliente (as fontes de log), do que o cliente autoriza e de em que passo a
 * conexão está. Só códigos neutros: os textos ficam no painel.
 *
 * - O estado da conta (`AWS_ONBOARDING_STATES`) e as conferências (`AWS_ONBOARDING_CHECK_IDS`) são derivados pela API a
 *   cada leitura, do que está gravado: nunca um texto livre, e nunca um "tudo certo" com um passo essencial pendente.
 * - Cada fonte (`AwsSource`) é uma linha por conta, tipo, região e recurso. O nó nunca cria nem altera nada na conta do
 *   cliente: as notas (`AWS_SOURCE_NOTES`) dizem quando ligar um serviço tem custo na AWS.
 * - Nenhum log é descartado por plano: o volume é controlado pela data de início (a da autorização, sem histórico),
 *   pelos tetos de quantidade e pela desautorização a qualquer momento.
 */

/**
 * O papel de uma versão anterior do template (sem as tags, a 1): o painel pede a atualização da pilha. As tags do papel
 * (a versão e as capacidades) são lidas por `parseReaderRoleTags` (`aws-reader.ts`); null é a versão ainda não lida,
 * ou a tag que não é um número de versão.
 */
export function isAwsTemplateOutdated(version: number | null): boolean {
  return version !== null && version < AWS_READER_TEMPLATE_VERSION;
}

/**
 * O grupo de logs tem a tag que libera a leitura dele (`AWS_LOG_GROUP_TAG`: `verax-control = leitura`)? O valor é
 * exato. A chave é comparada sem distinguir maiúsculas de minúsculas, como o IAM faz na condição
 * `aws:ResourceTag/<chave>` da política do papel: o que a política aceitaria não fica de fora aqui (e a sondagem de
 * leitura, que vem depois, é quem prova a permissão).
 */
export function hasAwsLogGroupReadTag(tags: Readonly<Record<string, string>> | undefined): boolean {
  if (tags === undefined) return false;
  return Object.keys(tags).some(
    (key) => key.toLowerCase() === AWS_LOG_GROUP_TAG.key && tags[key] === AWS_LOG_GROUP_TAG.value,
  );
}

// --- Fontes ---

/**
 * Os tipos de fonte. Coletados na primeira versão: a trilha do CloudTrail, os VPC Flow Logs, o WAF e o export do
 * GuardDuty (S3); o GuardDuty, o Security Hub, o Inspector e o Access Analyzer (API); os grupos do CloudWatch Logs.
 * O Config e os logs de acesso dos load balancers são descobertos e mostrados, mas ainda não coletados.
 */
export const AWS_SOURCE_KINDS = [
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
] as const;
export type AwsSourceKind = (typeof AWS_SOURCE_KINDS)[number];

/** Como a fonte é lida: objetos de um bucket (Wazuh), a API do serviço (worker) ou o CloudWatch Logs (Wazuh). */
export const AWS_SOURCE_METHODS = ['s3', 'api', 'cloudwatch'] as const;
export type AwsSourceMethod = (typeof AWS_SOURCE_METHODS)[number];

/** O que cada tipo é: o método, a capacidade do papel que o libera, se já é coletado e se é sensível. */
export interface AwsSourceKindInfo {
  method: AwsSourceMethod;
  capability: AwsReaderCapability;
  /** Coletado nesta versão. Os outros aparecem como "ainda não coletado" e não aceitam autorização. */
  collectable: boolean;
  /** Pode trazer dado de aplicação: só entra citada uma a uma na autorização. */
  sensitive: boolean;
}

export const AWS_SOURCE_KIND_INFO: Readonly<Record<AwsSourceKind, AwsSourceKindInfo>> = {
  cloudtrail: { method: 's3', capability: 'service-logs', collectable: true, sensitive: false },
  vpc_flow_logs: { method: 's3', capability: 'service-logs', collectable: true, sensitive: false },
  waf: { method: 's3', capability: 'service-logs', collectable: true, sensitive: false },
  guardduty_export: { method: 's3', capability: 'service-logs', collectable: true, sensitive: false },
  guardduty: { method: 'api', capability: 'findings', collectable: true, sensitive: false },
  security_hub: { method: 'api', capability: 'findings', collectable: true, sensitive: false },
  inspector: { method: 'api', capability: 'findings', collectable: true, sensitive: false },
  access_analyzer: { method: 'api', capability: 'findings', collectable: true, sensitive: false },
  cloudwatch_log_group: {
    method: 'cloudwatch',
    capability: 'log-groups',
    collectable: true,
    sensitive: true,
  },
  config: { method: 's3', capability: 'service-logs', collectable: false, sensitive: false },
  elb_logs: { method: 's3', capability: 'service-logs', collectable: false, sensitive: false },
};

/**
 * A fonte existe e dá para ler de onde está? `not_enabled`: o serviço está desligado na conta; `no_destination`: ligado,
 * mas sem log configurado (uma Web ACL sem logging); `unsupported_destination`: o log vai para onde o nó não lê (o
 * Firehose); `unsupported_format`: o formato não é lido (flow logs em Parquet, com partições do Hive ou campos fora do
 * padrão).
 */
export const AWS_SOURCE_AVAILABILITIES = [
  'available',
  'not_enabled',
  'no_destination',
  'unsupported_destination',
  'unsupported_format',
] as const;
export type AwsSourceAvailability = (typeof AWS_SOURCE_AVAILABILITIES)[number];

/** A permissão do papel para ler a fonte, pela última sondagem: concedida, faltando ou ainda não conferida. */
export const AWS_SOURCE_PERMISSIONS = ['granted', 'missing', 'unknown'] as const;
export type AwsSourcePermission = (typeof AWS_SOURCE_PERMISSIONS)[number];

/**
 * Por que a permissão falta (ou não pôde ser conferida), além da ação do IAM que foi negada (`guardduty:ListFindings`):
 * - `capability_off`: a capacidade do tipo está desligada no papel (o parâmetro do template);
 * - `tag_missing`: o grupo de logs não tem a tag `verax-control = leitura`;
 * - `kms_denied`: o papel lista o bucket, mas a chave KMS não decifra para ele;
 * - `bucket_denied` e `bucket_missing`: o bucket não deixa o papel listar (o bucket central de outra conta), ou não
 *   existe;
 * - `outside_awslogs_prefix`: os objetos ficam atrás de um prefixo antes de `AWSLogs/`, fora do que o papel lê sem o
 *   bucket citado nos buckets adicionais;
 * - `probe_failed`: a sondagem não terminou (a AWS não respondeu); tenta de novo na próxima descoberta.
 */
export const AWS_SOURCE_PERMISSION_CODES = [
  'capability_off',
  'tag_missing',
  'kms_denied',
  'bucket_denied',
  'bucket_missing',
  'outside_awslogs_prefix',
  'probe_failed',
] as const;
export type AwsSourcePermissionCode = (typeof AWS_SOURCE_PERMISSION_CODES)[number];

/** Uma ação do IAM (`serviço:Ação`), como a AWS a escreve: o serviço em minúsculas com hífen, a ação em letras e números. */
const IAM_ACTION = /^[a-z][a-z0-9-]{1,31}:[A-Za-z][A-Za-z0-9]{1,63}$/;

/** O detalhe da permissão: um dos códigos acima ou a ação do IAM negada. */
export function isAwsSourcePermissionDetail(value: string): boolean {
  return (AWS_SOURCE_PERMISSION_CODES as readonly string[]).includes(value) || IAM_ACTION.test(value);
}

/**
 * O estado de uma fonte.
 * - Antes da autorização: `available` (pode ser autorizada), `needs_permission` (existe, mas o papel não a lê) e
 *   `unavailable` (desligada, sem destino, num destino ou formato que o nó não lê, ou de um tipo ainda não coletado).
 * - Depois: `authorized` (aguardando o coletor), `configuring`, `waiting_events`, `collecting`, `stalled`,
 *   `permission_error` e `ingestion_error`.
 * - `source_missing`: a fonte autorizada sumiu da conta (ou mudou de destino); a linha fica.
 * - `revoked`: o cliente tirou a autorização.
 */
export const AWS_SOURCE_STATES = [
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
] as const;
export type AwsSourceState = (typeof AWS_SOURCE_STATES)[number];

/** Os estados de uma fonte com a autorização valendo (o coletor a lê, ou vai ler). */
export const AWS_SOURCE_ACTIVE_STATES = [
  'authorized',
  'configuring',
  'waiting_events',
  'collecting',
  'stalled',
  'permission_error',
  'ingestion_error',
] as const satisfies readonly AwsSourceState[];

export function isAwsSourceActiveState(state: AwsSourceState): boolean {
  return (AWS_SOURCE_ACTIVE_STATES as readonly string[]).includes(state);
}

/**
 * O motivo do estado, quando há um: o coletor que ainda não existe para a fonte, o tipo ainda não coletado etc. Os que
 * a coleta pelo Wazuh grava nas fontes de bucket e do CloudWatch Logs (a lista ainda não aplicada, a fonte parada, o
 * motivo de ela ter ficado de fora da lista) estão em `aws-wazuh-sources.ts` (`AWS_WAZUH_SOURCE_STATE_CODES`).
 */
export const AWS_SOURCE_STATE_CODES = [
  /** `authorized`: a autorização está gravada, e o coletor ainda não começou a ler. */
  'awaiting_collector',
  /** `unavailable`: o tipo é descoberto, mas ainda não coletado. */
  'not_collectable_yet',
  /** `source_missing`: a descoberta não achou mais a fonte. */
  'not_found',
  /** `source_missing`: o serviço foi desligado na conta depois da autorização (o coletor de achados o viu recusar). */
  'not_enabled',
  /** `collecting`: a fonte de achados já foi lida sem erro, e ainda não trouxe nenhum achado. */
  'no_findings_yet',
  /** `ingestion_error`: a API do serviço segue limitando as chamadas (os demais códigos são o nome do erro da AWS). */
  'throttled',
] as const;

/** De onde a linha veio: da descoberta, ou dos buckets cadastrados antes dela (`cloudtrailBucket` e os outros dois). */
export const AWS_SOURCE_ORIGINS = ['discovered', 'legacy'] as const;
export type AwsSourceOrigin = (typeof AWS_SOURCE_ORIGINS)[number];

/** O que o serviço diz do próprio log: a trilha gravando ou parada, o serviço ligado ou desligado, o export publicando. */
export const AWS_SOURCE_LOGGING_STATES = ['logging', 'stopped', 'enabled', 'disabled', 'publishing'] as const;
export type AwsSourceLoggingState = (typeof AWS_SOURCE_LOGGING_STATES)[number];

/**
 * Avisos de custo e de pré-requisito de uma fonte (o painel tem o texto de cada um). A Verax nunca liga nada na conta
 * do cliente: os de custo dizem que ligar o serviço é cobrado pela AWS.
 * - `aws_cost_*`: ligar o serviço (ou criar a trilha, os flow logs, o logging do WAF) tem custo na AWS;
 * - `high_volume`: fonte de volume alto (flow logs, um grupo grande), que conta no volume contratado;
 * - `flow_logs_read_together`: autorizar um flow log da VPC lê todos os flow logs daquela conta e região que gravam no
 *   mesmo bucket (o módulo do Wazuh lê a pasta da conta e da região, e não um flow log só);
 * - `tag_required`: o grupo de logs só é lido com a tag `verax-control = leitura`;
 * - `stack_update_required`: o papel é de um template anterior, ou a capacidade do tipo está desligada;
 * - `additional_bucket_required`: o bucket precisa entrar nos buckets adicionais da pilha (prefixo antes de `AWSLogs/`);
 * - `central_bucket`: trilha de organização, com o bucket em outra conta (a política do bucket precisa citar o papel);
 * - `covered_by_api`: o export do GuardDuty, quando a API do GuardDuty já é lida (o mesmo achado);
 * - `covered_by_legacy`: o mesmo bucket já é lido pelo cadastro anterior da conta;
 * - `recommended`: a forma recomendada de ler o serviço;
 * - `not_security_events`: grupo de métricas de desempenho, não de eventos de segurança;
 * - `not_collected_yet`: tipo descoberto, mas ainda não coletado.
 */
export const AWS_SOURCE_NOTES = [
  'aws_cost_guardduty',
  'aws_cost_security_hub',
  'aws_cost_inspector',
  'aws_cost_access_analyzer',
  'aws_cost_new_trail',
  'aws_cost_flow_logs',
  'aws_cost_waf_logging',
  'high_volume',
  'flow_logs_read_together',
  'tag_required',
  'stack_update_required',
  'additional_bucket_required',
  'central_bucket',
  'covered_by_api',
  'covered_by_legacy',
  'recommended',
  'not_security_events',
  'not_collected_yet',
] as const;
export type AwsSourceNote = (typeof AWS_SOURCE_NOTES)[number];

/** A região de uma fonte: a da AWS, ou `global` (o serviço desligado na conta inteira, o bucket cadastrado antes). */
export const AWS_SOURCE_GLOBAL_REGION = 'global';

export function isAwsSourceRegion(value: string): boolean {
  return value === AWS_SOURCE_GLOBAL_REGION || isAwsRegion(value);
}

const sourceRegionSchema = z.string().max(32).refine(isAwsSourceRegion, { error: 'região inválida' });

/** O recurso de uma linha "serviço desligado" (uma por tipo, na região `global`) e o da linha de um bucket cadastrado. */
export const AWS_SOURCE_NONE_RESOURCE = 'none';
export const AWS_SOURCE_LEGACY_RESOURCE = 'legacy';

/** Categoria de um grupo do CloudWatch Logs, pelo nome ou por quem grava nele. */
export const AWS_LOG_GROUP_CATEGORIES = [
  'cloudtrail',
  'vpc_flow_logs',
  'waf',
  'route53',
  'rds',
  'api_gateway',
  'lambda',
  'eks',
  'amplify',
  'metrics',
  'other',
] as const;
export type AwsLogGroupCategory = (typeof AWS_LOG_GROUP_CATEGORIES)[number];

const bucketNameSchema = z
  .string()
  .max(63)
  .refine((name) => bucketNameProblem(name) === null, { error: 'bucket inválido' });
const arnSchema = z.string().min(1).max(2048);

/**
 * O que a descoberta sabe de uma fonte, conforme o tipo. Só nomes e configuração: nenhum conteúdo de log. Objeto
 * estrito, com todo campo opcional: o que não se aplica ao tipo fica de fora.
 */
export const awsSourceDetailsSchema = z.strictObject({
  /** O ARN do recurso (a trilha, a Web ACL, o analisador, o grupo de logs, o load balancer). */
  arn: arnSchema.optional(),
  /** Fontes do S3: o bucket de destino. */
  bucket: bucketNameSchema.optional(),
  /** O prefixo exato que o coletor lista (`AWSLogs/<conta>/CloudTrail/<região>/`), sempre com a barra no fim. */
  prefix: z.string().max(1024).optional(),
  /** O prefixo antes de `AWSLogs/`, quando o cliente configurou um. */
  customPrefix: z.string().max(512).optional(),
  /** A chave KMS do destino, quando o serviço a informa. */
  kmsKeyArn: arnSchema.optional(),
  /** Trilha de organização e o ID da organização (`AWSLogs/o-…/<conta>/`), quando o bucket o mostra. */
  organizationTrail: z.boolean().optional(),
  organizationId: z
    .string()
    .regex(/^o-[a-z0-9]{10,32}$/)
    .optional(),
  multiRegion: z.boolean().optional(),
  /** A trilha grava os eventos de gerenciamento (os que as regras de detecção leem)? */
  managementEvents: z.boolean().optional(),
  /** Para onde o serviço manda o log: o S3, o CloudWatch Logs, o Firehose, ou nenhum. */
  destinationType: z.enum(['s3', 'cloudwatch', 'firehose', 'none']).optional(),
  /** O destino que o nó não lê (o ARN do Firehose), para o painel mostrar. */
  destination: arnSchema.optional(),
  /** WAF: a Web ACL e o escopo. */
  webAclName: z.string().max(128).optional(),
  webAclScope: z.enum(['REGIONAL', 'CLOUDFRONT']).optional(),
  /** Flow logs: o ID, a que estão ligados (VPC, sub-rede ou interface), o tráfego e o formato. */
  flowLogId: z.string().max(64).optional(),
  attachedTo: z.string().max(64).optional(),
  trafficType: z.string().max(16).optional(),
  fileFormat: z.string().max(16).optional(),
  hivePartitions: z.boolean().optional(),
  customFormat: z.boolean().optional(),
  /** GuardDuty: o detector. */
  detectorId: z.string().max(300).optional(),
  /** Access Analyzer: o tipo do analisador (`ACCOUNT`, `ORGANIZATION`, `ACCOUNT_UNUSED_ACCESS`...). */
  analyzerType: z.string().max(64).optional(),
  /** CloudWatch Logs: o grupo, o tamanho guardado, a retenção, a categoria e se tem a tag de leitura. */
  logGroup: z.string().max(512).optional(),
  storedBytes: z.number().int().nonnegative().optional(),
  retentionDays: z.number().int().positive().nullable().optional(),
  category: z.enum(AWS_LOG_GROUP_CATEGORIES).optional(),
  tagged: z.boolean().optional(),
  /** Config: o gravador está gravando. */
  recording: z.boolean().optional(),
  /** Linha "serviço desligado": as regiões em que a descoberta conferiu. */
  regionsChecked: z.array(z.string().max(32)).max(64).optional(),
  /** Linha de um bucket cadastrado antes da descoberta: a fonte do cadastro (`cloudtrail`, `guardduty` ou `waf`). */
  legacySource: z.enum(['cloudtrail', 'guardduty', 'waf']).optional(),
});
export type AwsSourceDetails = z.infer<typeof awsSourceDetailsSchema>;

/**
 * Saúde da coleta de uma fonte. Tudo null até o coletor da fonte rodar. Nas fontes lidas por API (achados), o
 * `lastSyncAt` é a última leitura sem erro, o `lastEventAt` é a atualização mais recente de um achado na origem, o
 * `lastIngestedAt` é quando o achado mais recente entrou no nó, o `lagSeconds` é o tempo desde a última leitura sem
 * erro, e o volume é o dos achados novos (ou com versão nova) das últimas 24 h.
 */
export const awsSourceHealthSchema = z.strictObject({
  /** A última vez que o coletor leu a fonte sem erro. */
  lastSyncAt: z.iso.datetime().nullable(),
  /** O horário do evento mais recente lido. */
  lastEventAt: z.iso.datetime().nullable(),
  /** Quando o evento mais recente entrou no nó. */
  lastIngestedAt: z.iso.datetime().nullable(),
  lagSeconds: z.number().int().nonnegative().nullable(),
  eventsLast24h: z.number().int().nonnegative().nullable(),
  bytesLast24h: z.number().int().nonnegative().nullable(),
});
export type AwsSourceHealth = z.infer<typeof awsSourceHealthSchema>;

const codeSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);

export const awsSourceSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(AWS_SOURCE_KINDS),
  region: sourceRegionSchema,
  /** O identificador estável do recurso dentro do tipo (o ARN da trilha, o ID do flow log, o nome do grupo...). */
  resourceId: z.string().min(1).max(512),
  name: z.string().max(512),
  method: z.enum(AWS_SOURCE_METHODS),
  origin: z.enum(AWS_SOURCE_ORIGINS),
  /** O tipo já é coletado nesta versão (`AWS_SOURCE_KIND_INFO`). */
  collectable: z.boolean(),
  sensitive: z.boolean(),
  availability: z.enum(AWS_SOURCE_AVAILABILITIES),
  loggingState: z.enum(AWS_SOURCE_LOGGING_STATES).nullable(),
  permission: z.enum(AWS_SOURCE_PERMISSIONS),
  /** `AWS_SOURCE_PERMISSION_CODES` ou a ação do IAM negada; null com a permissão concedida. */
  permissionDetail: z
    .string()
    .max(96)
    .refine(isAwsSourcePermissionDetail, { error: 'detalhe de permissão inválido' })
    .nullable(),
  permissionCheckedAt: z.iso.datetime().nullable(),
  /** "Tentar de novo" pedido e ainda não respondido pelo worker. */
  probeRequestedAt: z.iso.datetime().nullable(),
  notes: z.array(z.enum(AWS_SOURCE_NOTES)).max(AWS_SOURCE_NOTES.length),
  details: awsSourceDetailsSchema,
  state: z.enum(AWS_SOURCE_STATES),
  stateCode: codeSchema.nullable(),
  stateSince: z.iso.datetime(),
  authorization: z.strictObject({
    authorizedAt: z.iso.datetime().nullable(),
    /** O ID do usuário que autorizou; null na linha de um bucket cadastrado antes da descoberta. */
    authorizedBy: z.string().max(64).nullable(),
    revokedAt: z.iso.datetime().nullable(),
  }),
  /** O dia (`AAAA-MM-DD`, UTC) a partir do qual a fonte é coletada: o da autorização. Sem histórico anterior. */
  collectFrom: z.iso.date().nullable(),
  firstSeenAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  /** Desde quando a descoberta não acha mais a fonte; null enquanto ela é vista. */
  missingSince: z.iso.datetime().nullable(),
  health: awsSourceHealthSchema,
});
export type AwsSource = z.infer<typeof awsSourceSchema>;

/**
 * O estado de uma fonte que não está autorizada, pelo que a descoberta viu: o tipo ainda não coletado e a fonte que não
 * dá para ler ficam `unavailable`; a que existe e o papel lê, `available`; a que existe sem a permissão, `needs_permission`.
 */
export function awsSourceIdleState(
  kind: AwsSourceKind,
  availability: AwsSourceAvailability,
  permission: AwsSourcePermission,
): { state: AwsSourceState; stateCode: string | null } {
  if (availability !== 'available') return { state: 'unavailable', stateCode: availability };
  if (!AWS_SOURCE_KIND_INFO[kind].collectable)
    return { state: 'unavailable', stateCode: 'not_collectable_yet' };
  return permission === 'granted'
    ? { state: 'available', stateCode: null }
    : { state: 'needs_permission', stateCode: null };
}

// --- Descoberta ---

export const AWS_DISCOVERY_TRIGGERS = ['connect', 'manual', 'scheduled'] as const;
export type AwsDiscoveryTrigger = (typeof AWS_DISCOVERY_TRIGGERS)[number];

/** `partial` é um resultado válido: alguma leitura foi recusada (falta permissão, região opt-in) e o resto entrou. */
export const AWS_DISCOVERY_STATUSES = ['pending', 'running', 'succeeded', 'partial', 'failed'] as const;
export type AwsDiscoveryStatus = (typeof AWS_DISCOVERY_STATUSES)[number];

/** O que a descoberta lê, para o registro do que ficou de fora (`serviço × região × código`). */
export const AWS_DISCOVERY_SERVICES = [
  'sts',
  'regions',
  'cloudtrail',
  'flow_logs',
  'waf',
  'guardduty',
  'security_hub',
  'inspector',
  'access_analyzer',
  'cloudwatch_logs',
  'config',
  'elb',
  'rds',
  'ec2',
  's3',
  'iam',
  'run',
] as const;
export type AwsDiscoveryService = (typeof AWS_DISCOVERY_SERVICES)[number];

/** Uma leitura que ficou de fora: o serviço, a região (ou `global`) e o nome do erro da AWS (nunca a mensagem). */
export const awsDiscoveryErrorSchema = z.strictObject({
  service: z.enum(AWS_DISCOVERY_SERVICES),
  region: sourceRegionSchema,
  code: codeSchema,
});
export type AwsDiscoveryError = z.infer<typeof awsDiscoveryErrorSchema>;

/** Teto dos erros guardados por execução (o que passar disso não muda o resultado: `partial`). */
export const AWS_DISCOVERY_MAX_ERRORS = 200;

const count = z.number().int().nonnegative().nullable();

/**
 * O que existe na conta, em números (null: a leitura foi recusada). Os detalhes ficam em Ativos (o inventário); aqui é
 * só o retrato que a tela da conexão mostra.
 */
export const awsInfrastructureSummarySchema = z.strictObject({
  instances: count,
  publicInstances: count,
  securityGroups: count,
  openSecurityGroups: count,
  buckets: count,
  publicBuckets: count,
  iamUsers: count,
  rootMfaEnabled: z.boolean().nullable(),
  rdsInstances: count,
  rdsPublic: count,
  rdsUnencrypted: count,
  rdsClusters: count,
  loadBalancers: count,
  internetFacingLoadBalancers: count,
  vpcs: count,
  webAcls: count,
  logGroups: count,
  trails: count,
});
export type AwsInfrastructureSummary = z.infer<typeof awsInfrastructureSummarySchema>;

export const awsDiscoveryRunSchema = z.strictObject({
  id: z.uuid(),
  trigger: z.enum(AWS_DISCOVERY_TRIGGERS),
  status: z.enum(AWS_DISCOVERY_STATUSES),
  requestedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  /** As regiões habilitadas na conta que a execução leu. */
  regions: z.array(z.string().max(32)).max(64),
  errors: z.array(awsDiscoveryErrorSchema).max(AWS_DISCOVERY_MAX_ERRORS),
  /** O ID do usuário que pediu (a descoberta manual); null na automática. */
  requestedBy: z.string().max(64).nullable(),
});
export type AwsDiscoveryRun = z.infer<typeof awsDiscoveryRunSchema>;

/** A descoberta manual: no máximo uma a cada 5 min por conta, e nenhuma com outra pendente ou em curso. */
export const AWS_DISCOVERY_MANUAL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * O "Tentar de novo" de uma fonte: no máximo um pedido a cada 30 s por fonte (um pedido ainda pendente não conta: ele
 * não é renovado). A sondagem de uma fonte que sumiu pede uma descoberta da conta, fora do limite da manual; este
 * limite e o de uma execução por vez na conta contêm quantas descobertas o botão consegue pedir.
 */
export const AWS_SOURCE_RETRY_INTERVAL_MS = 30 * 1000;

// --- Conexão e estado da conta ---

/**
 * Depois de "Conectar com AWS", o nó tenta entrar no papel por até 60 min, sem tratar a recusa como erro: a pilha ainda
 * está sendo criada. Passado o prazo sem o papel, o erro da conexão é `authorization_timeout`
 * (`AWS_CONNECTION_ERROR_CODES`).
 */
export const AWS_CONNECT_WINDOW_MS = 60 * 60 * 1000;

/**
 * O estado da conexão da conta, derivado pela API:
 * - `not_started`: ninguém pediu a conexão (ou ela recomeçou: outra lista de buckets, conta reativada);
 * - `awaiting_authorization`: o nó está tentando entrar no papel. Enquanto a pilha do CloudFormation é criada, o papel
 *   ainda não existe, e o nó não enxerga a pilha: só sabe que ainda não entrou;
 * - `authenticated`: entrou no papel, e a descoberta ainda não rodou (ou falhou inteira);
 * - `discovering`: a primeira descoberta está pendente ou em curso;
 * - `awaiting_sources`: a descoberta terminou e nenhuma fonte está autorizada;
 * - `configuring`: há fonte autorizada, e nenhuma coleta começou ainda;
 * - `collecting`: toda fonte autorizada está coletando; `partial`: só parte delas;
 * - `permission_error`: uma fonte autorizada (ou um bucket cadastrado) não pode ser lida por falta de permissão;
 * - `ingestion_failure`: a coleta de uma fonte autorizada falha, ou o nó não aplica a configuração;
 * - `disconnected`: a AWS recusa a entrada no papel (removido, alterado), ou o nó não consegue conferir a conexão;
 * - `authorization_timeout`: o papel não apareceu na janela do "Conectar".
 */
export const AWS_ONBOARDING_STATES = [
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
] as const;
export type AwsOnboardingState = (typeof AWS_ONBOARDING_STATES)[number];

/** Tetos do que uma conta pode ter autorizado, e do que uma resposta carrega. */
export const AWS_MAX_AUTHORIZED_LOG_GROUPS = 50;
export const AWS_MAX_AUTHORIZED_S3_SOURCES = 200;
export const AWS_MAX_SOURCES_PER_ACCOUNT = 2000;

/**
 * As conferências da conexão, na ordem em que acontecem: a entrada no papel, a identidade (a conta e o papel certos), o
 * template (versão e capacidades), a descoberta e, das fontes autorizadas, a permissão, a configuração do coletor, a
 * chegada de eventos, a última leitura e o atraso.
 */
export const AWS_ONBOARDING_CHECK_IDS = [
  'assume_role',
  'identity',
  'template',
  'discovery',
  'permission',
  'collector_config',
  'events',
  'last_sync',
  'lag',
] as const;
export type AwsOnboardingCheckId = (typeof AWS_ONBOARDING_CHECK_IDS)[number];

/** `skipped`: a conferência não se aplica agora (nenhuma fonte autorizada, o passo anterior não passou). */
export const AWS_ONBOARDING_CHECK_STATUSES = ['ok', 'pending', 'failed', 'skipped'] as const;
export type AwsOnboardingCheckStatus = (typeof AWS_ONBOARDING_CHECK_STATUSES)[number];

/**
 * Os motivos próprios das conferências (os demais códigos são os da conexão, da descoberta e das fontes):
 * - `not_requested`: ninguém pediu a conexão ou a descoberta ainda;
 * - `awaiting_stack`: dentro da janela do "Conectar", esperando o papel existir;
 * - `verifying`: um "Verificar" pendente;
 * - `template_outdated`: o papel (ou, na VM própria do cliente, o usuário IAM de leitura) é de um template anterior;
 * - `template_unreadable`: a tag da versão do template existe e não é um número de versão;
 * - `awaiting_collector`: fonte autorizada, com o coletor ainda sem ler;
 * - `no_data`: sem medida ainda;
 * - `sync_delayed`: uma fonte lida por API (achados) está há mais de 2 h sem uma leitura bem-sucedida. Fonte de
 *   achados nunca fica "parada" por não ter achado: o que conta é a última leitura.
 */
export const AWS_ONBOARDING_CHECK_CODES = [
  'not_requested',
  'awaiting_stack',
  'verifying',
  'template_outdated',
  'template_unreadable',
  'awaiting_collector',
  'no_data',
  'sync_delayed',
] as const;

/**
 * As conferências das fontes autorizadas: só elas levam `sourceIds`, as fontes que deixam a conferência pendente ou com
 * falha, para o painel apontar a linha de cada uma.
 */
export const AWS_ONBOARDING_SOURCE_CHECK_IDS = [
  'permission',
  'collector_config',
  'events',
  'last_sync',
  'lag',
] as const satisfies readonly AwsOnboardingCheckId[];

export const awsOnboardingCheckSchema = z.strictObject({
  id: z.enum(AWS_ONBOARDING_CHECK_IDS),
  status: z.enum(AWS_ONBOARDING_CHECK_STATUSES),
  /** O motivo (um código, nunca a mensagem da AWS); null sem motivo. */
  code: codeSchema.nullable(),
  /** Quando a conferência foi feita pela última vez; null se nunca, ou se o horário não é guardado. */
  checkedAt: z.iso.datetime().nullable(),
  /**
   * As fontes autorizadas que deixam a conferência pendente ou com falha (os IDs de `sources`). Só nas conferências de
   * `AWS_ONBOARDING_SOURCE_CHECK_IDS`, e só quando o motivo é de fontes: no aviso do nó inteiro (o token parado, a
   * configuração não aplicada) e no bucket do cadastro negado, o campo não vem.
   */
  sourceIds: z.array(z.uuid()).min(1).max(AWS_MAX_SOURCES_PER_ACCOUNT).optional(),
});
export type AwsOnboardingCheck = z.infer<typeof awsOnboardingCheckSchema>;

/** Como o nó lê a conta: pelo papel sem chave, ou (na VM própria do cliente) com a chave do usuário IAM de leitura. */
export const AWS_CREDENTIAL_MODES = ['role', 'access_key'] as const;
export type AwsCredentialMode = (typeof AWS_CREDENTIAL_MODES)[number];

/**
 * As autorizações que o cliente escolhe no painel (as três do papel; a descoberta vale sempre e não entra): sem
 * repetição, em qualquer ordem. A lista vazia é uma escolha (só a descoberta).
 */
const chosenCapabilitiesSchema = z
  .array(z.enum(AWS_READER_AUTHORIZATIONS))
  .max(AWS_READER_AUTHORIZATIONS.length)
  .refine((list) => new Set(list).size === list.length, { error: 'autorização repetida' });

/** As autorizações escolhidas, na ordem do catálogo (a mesma em que a API as guarda e devolve). */
export function sortAwsChosenCapabilities(
  chosen: readonly AwsReaderAuthorization[],
): AwsReaderAuthorization[] {
  return AWS_READER_AUTHORIZATIONS.filter((authorization) => chosen.includes(authorization));
}

/**
 * O corpo, opcional, de `POST /v1/cloud-accounts/:id/aws/connect` e de `POST /v1/cloud-accounts/:id/aws/verify`: as
 * autorizações que o cliente marcou no painel para o arquivo da pilha (ou, na VM própria, para a política do usuário de
 * leitura). A API só as guarda, para a tela mostrar a mesma escolha depois de recarregada e avisar quando o papel na
 * AWS ficou diferente dela: quem diz o que o papel pode ler são as tags dele, nunca este campo. Sem o corpo, ou sem
 * `capabilities`, a escolha gravada fica como está.
 */
export const awsConnectSchema = z.strictObject({
  capabilities: chosenCapabilitiesSchema.optional(),
});
export type AwsConnect = z.infer<typeof awsConnectSchema>;

/** `GET /v1/cloud-accounts/:id/aws/onboarding` (e a resposta de todas as escritas do onboarding). */
export const awsOnboardingSchema = z.strictObject({
  /** O ID do cadastro da conta (não o da AWS). */
  cloudAccountId: z.uuid(),
  state: z.enum(AWS_ONBOARDING_STATES),
  credentialMode: z.enum(AWS_CREDENTIAL_MODES),
  /**
   * O "Conectar com AWS": quando foi pedido, até quando o nó espera o papel (null fora da janela) e as autorizações que
   * o cliente escolheu no painel (`awsConnectSchema`), para a tela devolver as mesmas caixas marcadas e o mesmo arquivo
   * depois de recarregada. Null se nenhuma escolha foi gravada (a conta de antes disso, ou conectada sem o painel). É o
   * que o cliente escolheu, e não o que o papel tem: isso é `template.capabilities`, lido das tags dele.
   */
  connect: z.strictObject({
    requestedAt: z.iso.datetime().nullable(),
    waitingUntil: z.iso.datetime().nullable(),
    capabilities: chosenCapabilitiesSchema.nullable(),
  }),
  checks: z.array(awsOnboardingCheckSchema).length(AWS_ONBOARDING_CHECK_IDS.length),
  template: z.strictObject({
    /**
     * A versão do template do papel (ou do usuário de leitura), pelas tags dele; null antes da primeira leitura, e
     * quando a tag não é um número de versão.
     */
    version: z.number().int().positive().nullable(),
    capabilities: z.array(z.enum(AWS_READER_CAPABILITIES)).max(AWS_READER_CAPABILITIES.length),
    outdated: z.boolean(),
    checkedAt: z.iso.datetime().nullable(),
  }),
  discovery: z.strictObject({
    /** A execução mais recente (pendente, em curso ou terminada); null se nenhuma foi pedida. */
    run: awsDiscoveryRunSchema.nullable(),
    /** Quando terminou a última execução que entrou na conta (completa ou parcial). */
    lastCompletedAt: z.iso.datetime().nullable(),
    /** As regiões com recurso ou fonte, pela última descoberta. */
    regions: z.array(z.string().max(32)).max(64),
  }),
  /**
   * Este nó descobre as fontes sozinho? False na célula compartilhada, onde a descoberta e a sondagem de uma fonte ainda
   * não rodam (os pedidos respondem `DISCOVERY_UNAVAILABLE`): o painel não oferece o que seria recusado.
   */
  discoveryAvailable: z.boolean(),
  /** O retrato da última descoberta que entrou na conta; null antes dela. */
  infrastructure: awsInfrastructureSummarySchema.nullable(),
  sources: z.array(awsSourceSchema).max(AWS_MAX_SOURCES_PER_ACCOUNT),
  updatedAt: z.iso.datetime(),
});
export type AwsOnboarding = z.infer<typeof awsOnboardingSchema>;

// --- Pedidos ---

/** O ID de uma fonte no caminho (`…/aws/sources/:sourceId/revoke` e `/retry`). */
export const awsSourceIdSchema = z.uuid();

/** Fontes por pedido de autorização. */
export const AWS_AUTHORIZE_MAX_SOURCES = 50;

function distinct(ids: readonly string[]): boolean {
  return new Set(ids).size === ids.length;
}

/**
 * `POST /v1/cloud-accounts/:id/aws/sources/authorize`. As fontes sensíveis (os grupos do CloudWatch Logs, que podem
 * trazer dado de aplicação) só entram citadas de novo, uma a uma, em `sensitiveSourceIds`: um "autorizar tudo" que
 * mande só `sourceIds` é recusado inteiro se a lista tiver uma fonte sensível. Tudo ou nada: uma fonte recusada recusa
 * o pedido.
 *
 * Das demais escritas do onboarding, só o `…/aws/connect` aceita corpo, e opcional (`awsConnectSchema`):
 * `…/aws/discovery`, `…/aws/sources/:sourceId/revoke` e `…/aws/sources/:sourceId/retry` levam só os IDs no caminho.
 */
export const awsSourcesAuthorizeSchema = z
  .strictObject({
    sourceIds: z
      .array(awsSourceIdSchema)
      .min(1)
      .max(AWS_AUTHORIZE_MAX_SOURCES)
      .refine(distinct, { error: 'fonte repetida' }),
    sensitiveSourceIds: z
      .array(awsSourceIdSchema)
      .max(AWS_AUTHORIZE_MAX_SOURCES)
      .refine(distinct, { error: 'fonte repetida' })
      .optional(),
  })
  .refine((body) => (body.sensitiveSourceIds ?? []).every((id) => body.sourceIds.includes(id)), {
    error: 'a confirmação cita uma fonte fora do pedido',
    path: ['sensitiveSourceIds'],
  });
export type AwsSourcesAuthorize = z.infer<typeof awsSourcesAuthorizeSchema>;

/**
 * Os códigos das recusas das escritas do onboarding (o `code` do erro da API): o painel decide o texto por eles.
 * - `SOURCE_NOT_AVAILABLE`: a fonte não existe mais ou não dá para ler de onde está;
 * - `SOURCE_NOT_COLLECTABLE`: tipo descoberto, mas ainda não coletado;
 * - `SOURCE_PERMISSION_MISSING`: o papel não lê a fonte (ou a permissão ainda não foi conferida);
 * - `SOURCE_LEGACY`: a linha espelha um bucket do cadastro da conta, e muda por lá;
 * - `SOURCE_COVERED_BY_LEGACY`: o mesmo bucket já é lido pelo cadastro anterior (autorizar duplicaria a coleta);
 * - `SOURCE_NOT_AUTHORIZED`: revogar uma fonte que não está autorizada;
 * - `SENSITIVE_CONFIRMATION_REQUIRED`: fonte sensível fora de `sensitiveSourceIds`;
 * - `SOURCE_LIMIT_REACHED`: o teto de fontes autorizadas da conta;
 * - `ACCOUNT_NOT_CONNECTED`: a conta não está conectada (a descoberta e a sondagem precisam do papel);
 * - `DISCOVERY_RATE_LIMITED`: descoberta manual pedida há menos de 5 min;
 * - `SOURCE_RETRY_RATE_LIMITED`: "Tentar de novo" pedido para a mesma fonte há menos de 30 s;
 * - `DISCOVERY_UNAVAILABLE`: este nó não descobre as fontes sozinho (a célula compartilhada, por enquanto).
 */
export const AWS_ONBOARDING_ERROR_CODES = [
  'SOURCE_NOT_AVAILABLE',
  'SOURCE_NOT_COLLECTABLE',
  'SOURCE_PERMISSION_MISSING',
  'SOURCE_LEGACY',
  'SOURCE_COVERED_BY_LEGACY',
  'SOURCE_NOT_AUTHORIZED',
  'SENSITIVE_CONFIRMATION_REQUIRED',
  'SOURCE_LIMIT_REACHED',
  'ACCOUNT_NOT_CONNECTED',
  'DISCOVERY_RATE_LIMITED',
  'SOURCE_RETRY_RATE_LIMITED',
  'DISCOVERY_UNAVAILABLE',
] as const;
export type AwsOnboardingErrorCode = (typeof AWS_ONBOARDING_ERROR_CODES)[number];
