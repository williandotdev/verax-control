import { ListFindingsV2Command } from '@aws-sdk/client-accessanalyzer';
import { DescribeLogStreamsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { ListFindingsCommand as ListGuardDutyFindingsCommand } from '@aws-sdk/client-guardduty';
import { ListFindingsCommand as ListInspectorFindingsCommand } from '@aws-sdk/client-inspector2';
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { GetFindingsCommand } from '@aws-sdk/client-securityhub';
import {
  AWS_SOURCE_GLOBAL_REGION,
  AWS_SOURCE_KIND_INFO,
  type AwsSourceDetails,
  type AwsSourcePermission,
} from '@verax/shared';
import { REFUSED_CODES } from '../../inventory/collectors.js';
import { AwsConnectionError, awsErrorName } from '../web-identity.js';
import {
  AWS_LOGS_SERVICE,
  awsLogsPrefix,
  type CatalogueContext,
  type DiscoveredSource,
  isLegacyBucket,
} from './catalogue.js';
import type { DiscoveryClients } from './clients.js';
import { ReadOnlyViolation } from './read-only.js';

/**
 * As sondagens de permissão de cada fonte (onboarding self-service): a prova, barata e só de leitura, de que o papel lê
 * a fonte antes de o cliente autorizá-la. Nenhum conteúdo é guardado: do S3, só o nome de um objeto e 1 byte dele.
 *
 * - **S3** (trilha, flow logs, WAF, export do GuardDuty): `ListObjectsV2` no prefixo exato da fonte (`MaxKeys=1`, no dia
 *   de hoje, no de ontem e, sem objeto neles, no prefixo inteiro) e `GetObject` de 1 byte (`Range: bytes=0-0`) do objeto
 *   achado, que prova a chave KMS num bucket cifrado. Na trilha de organização, antes, uma listagem de
 *   `AWSLogs/` com delimitador para achar o ID da organização (só os nomes do primeiro nível). As listagens são as que a
 *   política do papel aceita: o prefixo da conta (`AWSLogs/<conta>/…` ou `AWSLogs/<organização>/<conta>/…`, sempre com
 *   a barra no fim e até a região) ou os nomes do primeiro nível, com delimitador. Nunca `HeadBucket`, nem a pasta da
 *   organização sozinha.
 * - **APIs** (GuardDuty, Security Hub, Inspector, Access Analyzer): uma listagem de 1 item.
 * - **CloudWatch Logs**: a tag de leitura (já lida na descoberta) e, com ela, `DescribeLogStreams` de 1 item.
 *
 * Sem chamada nenhuma: a capacidade do tipo desligada no papel (`capability_off`), o grupo sem a tag (`tag_missing`), e
 * o bucket com prefixo antes de `AWSLogs/` que não está nos buckets do cadastro (`outside_awslogs_prefix`).
 */

export interface ProbeResult {
  permission: AwsSourcePermission;
  permissionDetail: string | null;
  /** O que a sondagem descobriu da fonte (o ID da organização da trilha e o prefixo com ele). */
  details?: Partial<AwsSourceDetails>;
}

export interface ProbeOptions {
  signal: AbortSignal;
  now: Date;
  /** Resultados já obtidos nesta execução, por bucket e prefixo: fontes que dividem o destino são sondadas uma vez. */
  cache?: Map<string, ProbeResult>;
}

const GRANTED: ProbeResult = { permission: 'granted', permissionDetail: null };
const FAILED: ProbeResult = { permission: 'unknown', permissionDetail: 'probe_failed' };
const missing = (detail: string): ProbeResult => ({ permission: 'missing', permissionDetail: detail });

function isRefused(error: unknown): boolean {
  return REFUSED_CODES.has(awsErrorName(error));
}

function messageOf(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : '';
}

/** O que nunca vira resultado de sondagem: o cancelamento, a trava de só leitura e a sessão que caiu. */
function rethrowFatal(error: unknown, signal: AbortSignal): void {
  if (signal.aborted) throw error;
  if (error instanceof ReadOnlyViolation || error instanceof AwsConnectionError) throw error;
}

async function discard(body: unknown): Promise<void> {
  const stream = body as { transformToByteArray?: () => Promise<Uint8Array> } | null | undefined;
  if (typeof stream?.transformToByteArray === 'function') await stream.transformToByteArray();
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** O dia no caminho dos logs da AWS (`AAAA/MM/DD/`), em UTC. */
function dayPath(day: Date): string {
  return `${day.getUTCFullYear()}/${pad(day.getUTCMonth() + 1)}/${pad(day.getUTCDate())}/`;
}

const ORGANIZATION_PREFIX = /AWSLogs\/(o-[a-z0-9]{10,32})\/$/;

/** A sondagem de um bucket: o primeiro objeto de um prefixo e 1 byte dele. */
async function probeObjects(
  clients: DiscoveryClients,
  bucket: string,
  prefixes: readonly string[],
  signal: AbortSignal,
): Promise<ProbeResult> {
  const s3 = clients.s3(null);
  let key: string | null = null;
  for (const prefix of prefixes) {
    try {
      // Sem prefixo, só o primeiro nível (prefixo vazio e delimitador): é a única listagem "solta" que o papel aceita.
      const listed = await s3.send(
        new ListObjectsV2Command(
          prefix.length > 0
            ? { Bucket: bucket, MaxKeys: 1, Prefix: prefix }
            : { Bucket: bucket, MaxKeys: 1, Prefix: '', Delimiter: '/' },
        ),
      );
      const first = listed.Contents?.[0]?.Key;
      if (typeof first === 'string' && first.length > 0 && first.length <= 1024) {
        key = first;
        break;
      }
    } catch (error) {
      rethrowFatal(error, signal);
      const name = awsErrorName(error);
      if (name === 'NoSuchBucket') return missing('bucket_missing');
      if (isRefused(error)) return missing('bucket_denied');
      return FAILED;
    }
  }
  // Sem objeto ainda: a listagem está provada, e a chave KMS fica para quando houver o que ler.
  if (key === null) return GRANTED;
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: 'bytes=0-0' }));
    await discard(object.Body);
    return GRANTED;
  } catch (error) {
    rethrowFatal(error, signal);
    const name = awsErrorName(error);
    if (name.startsWith('KMS.')) return missing('kms_denied');
    // O objeto arquivado, vazio ou apagado entre as duas chamadas não diz nada sobre o acesso.
    if (name === 'NoSuchKey' || name === 'InvalidObjectState' || name === 'InvalidRange') return GRANTED;
    if (name === 'NoSuchBucket') return missing('bucket_missing');
    if (isRefused(error)) {
      // A mensagem só é lida aqui, para separar a chave KMS do resto; nunca vai para o banco nem para o log.
      const message = messageOf(error).toLowerCase();
      if (['kms:', 'ciphertext', 'master key'].some((mark) => message.includes(mark)))
        return missing('kms_denied');
      return missing('s3:GetObject');
    }
    return FAILED;
  }
}

/**
 * O ID da organização de uma trilha de organização, pelos nomes do primeiro nível de `AWSLogs/` no bucket (a listagem
 * com delimitador, que não devolve objeto nenhum). Null quando a pasta da organização não aparece.
 */
async function findOrganizationId(
  clients: DiscoveryClients,
  bucket: string,
  customPrefix: string | null,
  signal: AbortSignal,
): Promise<{ organizationId: string | null } | ProbeResult> {
  const base = `${customPrefix === null ? '' : `${customPrefix}/`}AWSLogs/`;
  try {
    const listed = await clients
      .s3(null)
      .send(new ListObjectsV2Command({ Bucket: bucket, Prefix: base, Delimiter: '/', MaxKeys: 50 }));
    for (const common of listed.CommonPrefixes ?? []) {
      const match = ORGANIZATION_PREFIX.exec(common.Prefix ?? '');
      if (match?.[1] !== undefined) return { organizationId: match[1] };
    }
    return { organizationId: null };
  } catch (error) {
    rethrowFatal(error, signal);
    if (awsErrorName(error) === 'NoSuchBucket') return missing('bucket_missing');
    if (isRefused(error)) return missing('bucket_denied');
    return FAILED;
  }
}

/** A sondagem de uma fonte lida de bucket, com o resultado dividido entre as fontes do mesmo destino. */
async function probeBucketSource(
  source: DiscoveredSource,
  context: CatalogueContext,
  clients: DiscoveryClients,
  options: ProbeOptions,
): Promise<ProbeResult> {
  const { bucket } = source.details;
  if (bucket === undefined) return FAILED;
  const customPrefix = source.details.customPrefix ?? null;
  const legacy = isLegacyBucket(bucket, context);
  // O papel só lista o que começa em `AWSLogs/<conta>/`: com um prefixo antes, o bucket precisa estar nos adicionais.
  if (customPrefix !== null && !legacy) return missing('outside_awslogs_prefix');
  let prefix = source.details.prefix ?? '';
  let found: Partial<AwsSourceDetails> | undefined;
  if (source.kind === 'cloudtrail' && source.details.organizationTrail === true) {
    const organization = await findOrganizationId(clients, bucket, customPrefix, options.signal);
    if ('permission' in organization) return organization;
    if (organization.organizationId !== null) {
      prefix = awsLogsPrefix({
        customPrefix,
        organizationId: organization.organizationId,
        accountId: context.accountId,
        service: AWS_LOGS_SERVICE.cloudtrail,
        region: source.region,
      });
      found = { organizationId: organization.organizationId, prefix };
    }
  }
  const cacheKey = `${bucket}|${prefix}`;
  const cached = options.cache?.get(cacheKey);
  if (cached !== undefined) return { ...cached, ...(found !== undefined && { details: found }) };
  const today = options.now;
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  // O objeto mais recente primeiro (o de hoje ou o de ontem): é a chave KMS de agora que importa.
  const prefixes =
    prefix.length === 0 ? [''] : [`${prefix}${dayPath(today)}`, `${prefix}${dayPath(yesterday)}`, prefix];
  const result = await probeObjects(clients, bucket, prefixes, options.signal);
  options.cache?.set(cacheKey, result);
  return { ...result, ...(found !== undefined && { details: found }) };
}

/** Uma listagem de 1 item da API de achados da fonte: concedida, ou a ação do IAM que faltou. */
async function probeApiSource(
  source: DiscoveredSource,
  clients: DiscoveryClients,
  signal: AbortSignal,
): Promise<ProbeResult> {
  const { region } = source;
  if (region === AWS_SOURCE_GLOBAL_REGION) return FAILED;
  let action: string;
  let call: () => Promise<unknown>;
  switch (source.kind) {
    case 'guardduty': {
      const { detectorId } = source.details;
      if (detectorId === undefined) return FAILED;
      action = 'guardduty:ListFindings';
      call = () =>
        clients
          .guardduty(region)
          .send(new ListGuardDutyFindingsCommand({ DetectorId: detectorId, MaxResults: 1 }));
      break;
    }
    case 'security_hub':
      action = 'securityhub:GetFindings';
      call = () => clients.securityhub(region).send(new GetFindingsCommand({ MaxResults: 1 }));
      break;
    case 'inspector':
      action = 'inspector2:ListFindings';
      call = () => clients.inspector2(region).send(new ListInspectorFindingsCommand({ maxResults: 1 }));
      break;
    case 'access_analyzer': {
      const { arn } = source.details;
      if (arn === undefined) return FAILED;
      action = 'access-analyzer:ListFindings';
      call = () =>
        clients.accessanalyzer(region).send(new ListFindingsV2Command({ analyzerArn: arn, maxResults: 1 }));
      break;
    }
    default:
      return FAILED;
  }
  try {
    await call();
    return GRANTED;
  } catch (error) {
    rethrowFatal(error, signal);
    return isRefused(error) ? missing(action) : FAILED;
  }
}

/** O grupo de logs: sem a tag, nada a sondar; com ela, uma listagem de 1 stream. */
async function probeLogGroup(
  source: DiscoveredSource,
  clients: DiscoveryClients,
  signal: AbortSignal,
): Promise<ProbeResult> {
  if (source.details.tagged === false) return missing('tag_missing');
  // As tags não puderam ser lidas: sem saber se o grupo tem a tag, a leitura dele não é tentada.
  if (source.details.tagged === undefined)
    return { permission: 'unknown', permissionDetail: 'logs:ListTagsForResource' };
  if (source.region === AWS_SOURCE_GLOBAL_REGION) return FAILED;
  try {
    await clients
      .logs(source.region)
      .send(new DescribeLogStreamsCommand({ logGroupName: source.resourceId, limit: 1 }));
    return GRANTED;
  } catch (error) {
    rethrowFatal(error, signal);
    return isRefused(error) ? missing('logs:DescribeLogStreams') : FAILED;
  }
}

/**
 * A sondagem de uma fonte. O que não dá para ler de onde está, ou é de um tipo ainda não coletado, fica sem conferir:
 * ninguém vai autorizá-lo. Um erro fatal (cancelamento, sessão perdida, a trava de só leitura) sobe.
 */
export async function probeSource(
  source: DiscoveredSource,
  context: CatalogueContext,
  clients: DiscoveryClients,
  options: ProbeOptions,
): Promise<ProbeResult> {
  const info = AWS_SOURCE_KIND_INFO[source.kind];
  if (source.availability !== 'available' || !info.collectable)
    return { permission: 'unknown', permissionDetail: null };
  // A capacidade desligada nas tags do papel: a política não tem as ações do tipo. O bucket do cadastro anterior
  // continua lido (a pilha o cita em `LogBucketArns`), então é sondado assim mesmo.
  const capabilityOff = context.capabilities !== null && !context.capabilities.includes(info.capability);
  const legacyBucket =
    info.method === 's3' &&
    source.details.bucket !== undefined &&
    isLegacyBucket(source.details.bucket, context);
  if (capabilityOff && !legacyBucket) return missing('capability_off');
  switch (info.method) {
    case 's3':
      return probeBucketSource(source, context, clients, options);
    case 'api':
      return probeApiSource(source, clients, options.signal);
    case 'cloudwatch':
      return probeLogGroup(source, clients, options.signal);
  }
}
