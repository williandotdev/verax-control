import { type AwsSource, bucketNameProblem, isAwsRegion } from '@verax/shared';

/**
 * Como o cliente liga o log de acesso de um ALB: a política do bucket e os comandos prontos. A Verax nunca roda nada disto: os
 * textos só são mostrados para copiar. Tudo o que entra num comando é conferido antes, por partes (a região, a conta, o ARN do
 * balanceador e o nome do bucket): nada do que veio da AWS ou foi digitado chega ao terminal como texto livre.
 */

export const ALB_LOG_DELIVERY_PRINCIPAL = 'logdelivery.elasticloadbalancing.amazonaws.com';

const PARTITIONS = ['aws', 'aws-cn', 'aws-us-gov'] as const;
type Partition = (typeof PARTITIONS)[number];

const isDigit = (char: string): boolean => char >= '0' && char <= '9';
const isHex = (char: string): boolean => isDigit(char) || (char >= 'a' && char <= 'f');
const isNameChar = (char: string): boolean =>
  isDigit(char) || (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char === '-';
const every = (text: string, accept: (char: string) => boolean): boolean =>
  text.length > 0 && [...text].every(accept);

/** O tipo do balanceador pelo ARN (`app`, `net` ou `gwy`); null fora do formato. */
export function loadBalancerType(arn: string | undefined): 'app' | 'net' | 'gwy' | null {
  const marker = ':loadbalancer/';
  const at = arn === undefined ? -1 : arn.indexOf(marker);
  if (arn === undefined || at < 0) return null;
  const [type] = arn.slice(at + marker.length).split('/');
  return type === 'app' || type === 'net' || type === 'gwy' ? type : null;
}

export interface AlbTarget {
  partition: Partition;
  region: string;
  accountId: string;
  arn: string;
}

/**
 * O ARN de um ALB, conferido por partes: `arn:<partição>:elasticloadbalancing:<região>:<conta>:loadbalancer/app/<nome>/<id>`.
 * Null fora desse formato, ou de outra conta ou região que não a da fonte.
 */
export function albTarget(
  source: Pick<AwsSource, 'details' | 'region'>,
  accountId: string,
): AlbTarget | null {
  const { arn } = source.details;
  if (arn === undefined) return null;
  const [prefix, partition = '', service, region = '', account = '', resource = '', ...rest] = arn.split(':');
  if (prefix !== 'arn' || service !== 'elasticloadbalancing' || rest.length > 0) return null;
  if (!(PARTITIONS as readonly string[]).includes(partition)) return null;
  if (!isAwsRegion(region) || region !== source.region) return null;
  if (account.length !== 12 || !every(account, isDigit) || account !== accountId) return null;
  const [kind, type, name = '', id = '', ...more] = resource.split('/');
  if (kind !== 'loadbalancer' || type !== 'app' || more.length > 0) return null;
  if (name.length > 32 || !every(name, isNameChar) || id.length !== 16 || !every(id, isHex)) return null;
  return { partition: partition as Partition, region, accountId, arn };
}

/** Um nome de bucket para começar: o cliente troca pelo dele. */
export const suggestedLogBucket = (accountId: string, region: string): string =>
  `logs-alb-${accountId}-${region}`;

/** A política do bucket: só a entrega de logs do ELB, só na pasta desta conta. */
export function albBucketPolicy(target: AlbTarget, bucket: string): string | null {
  if (bucketNameProblem(bucket) !== null) return null;
  return JSON.stringify(
    {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'EntregaDosLogsDoBalanceador',
          Effect: 'Allow',
          Principal: { Service: ALB_LOG_DELIVERY_PRINCIPAL },
          Action: 's3:PutObject',
          Resource: `arn:${target.partition}:s3:::${bucket}/AWSLogs/${target.accountId}/*`,
        },
      ],
    },
    null,
    2,
  );
}

/** Cria o bucket na região do balanceador. Na us-east-1, a AWS não aceita o `LocationConstraint`. */
export function createBucketCommand(target: AlbTarget, bucket: string): string | null {
  if (bucketNameProblem(bucket) !== null) return null;
  const base = `aws s3api create-bucket --bucket '${bucket}' --region ${target.region}`;
  return target.region === 'us-east-1'
    ? base
    : `${base} --create-bucket-configuration LocationConstraint=${target.region}`;
}

/** Grava a política no bucket (troca a que existir). */
export function putBucketPolicyCommand(target: AlbTarget, bucket: string): string | null {
  const policy = albBucketPolicy(target, bucket);
  if (policy === null) return null;
  return `aws s3api put-bucket-policy --bucket '${bucket}' --region ${target.region} --policy '${JSON.stringify(JSON.parse(policy))}'`;
}

/** Liga o log de acesso do balanceador, sem prefixo. */
export function enableAccessLogsCommand(target: AlbTarget, bucket: string): string | null {
  if (bucketNameProblem(bucket) !== null) return null;
  return `aws elbv2 modify-load-balancer-attributes --region ${target.region} --load-balancer-arn '${target.arn}' --attributes Key=access_logs.s3.enabled,Value=true Key=access_logs.s3.bucket,Value='${bucket}'`;
}

/** Tira o prefixo do log de acesso: os arquivos novos passam a ficar em `AWSLogs/`, na raiz do bucket. */
export function clearPrefixCommand(target: AlbTarget): string {
  return `aws elbv2 modify-load-balancer-attributes --region ${target.region} --load-balancer-arn '${target.arn}' --attributes Key=access_logs.s3.prefix,Value=`;
}
