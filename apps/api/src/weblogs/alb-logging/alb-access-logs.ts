import {
  DescribeLoadBalancerAttributesCommand,
  type ElasticLoadBalancingV2Client,
  ModifyLoadBalancerAttributesCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import {
  ALB_ACCESS_LOG_KEYS,
  ALB_ACCESS_LOG_PREFIX,
  bucketNameProblem,
  type WebAlbLoggingFailure,
} from '@verax/shared';
import { commandName } from '../../aws/discovery/read-only.js';
import { isThrottling } from '../../aws/findings/throttle.js';
import { awsErrorName } from '../../aws/web-identity.js';

/**
 * A única escrita da Verax na conta do cliente: o log de acesso de um ALB, ligado ou desligado a pedido no painel (a pilha
 * com `EnableAlbAccessLogs`). O IAM não filtra qual atributo do balanceador muda, então a trava é daqui:
 *
 * - **O que sai:** só `ModifyLoadBalancerAttributes` com as chaves de `ALB_ACCESS_LOG_KEYS`: para ligar, `enabled=true`, o
 *   bucket da pilha e o prefixo vazio; para desligar, só `enabled=false`. Nenhuma outra chave, nenhum outro valor, nenhum
 *   outro comando (além da leitura dos atributos): `AlbLoggingViolation`, lançada antes de sair para a rede.
 * - **Quem monta:** só `accessLogAttributes`, a partir de um `AlbAccessLogChange`; o cliente com a trava (`albLoggingClient`)
 *   confere de novo o comando inteiro, para um erro nosso (outro atributo que entre por engano) nunca chegar à AWS.
 */

type ElbSender = Pick<ElasticLoadBalancingV2Client, 'send'>;

/** O que pode mudar: ligar no bucket da pilha, ou desligar. */
export type AlbAccessLogChange = { kind: 'enable'; bucket: string } | { kind: 'disable' };

export interface AlbAttribute {
  Key: string;
  Value: string;
}

/** Tentativa de mandar ao ALB algo além do log de acesso. A mensagem não leva valor nenhum. */
export class AlbLoggingViolation extends Error {
  constructor(reason: string) {
    super(`o log do ALB só muda o log de acesso: ${reason}`);
    this.name = 'AlbLoggingViolation';
  }
}

/** Os atributos de uma mudança, e só eles. */
export function accessLogAttributes(change: AlbAccessLogChange): AlbAttribute[] {
  if (change.kind === 'disable') return [{ Key: ALB_ACCESS_LOG_KEYS.enabled, Value: 'false' }];
  if (bucketNameProblem(change.bucket) !== null) throw new AlbLoggingViolation('bucket fora do formato');
  return [
    { Key: ALB_ACCESS_LOG_KEYS.enabled, Value: 'true' },
    { Key: ALB_ACCESS_LOG_KEYS.bucket, Value: change.bucket },
    { Key: ALB_ACCESS_LOG_KEYS.prefix, Value: ALB_ACCESS_LOG_PREFIX },
  ];
}

const sameAttributes = (a: readonly AlbAttribute[], b: readonly unknown[]): boolean =>
  a.length === b.length &&
  a.every((attribute, index) => {
    const other = b[index] as { Key?: unknown; Value?: unknown } | null | undefined;
    return (
      other !== null &&
      typeof other === 'object' &&
      Object.keys(other).every((key) => key === 'Key' || key === 'Value') &&
      other.Key === attribute.Key &&
      other.Value === attribute.Value
    );
  });

/**
 * Confere um comando antes de ele sair: a leitura dos atributos do ALB, ou a mudança que `accessLogAttributes` monta para o
 * bucket permitido (ligar) ou para desligar, no ARN dado. Qualquer outra coisa lança `AlbLoggingViolation`.
 */
export function assertAccessLogCommand(command: unknown, arn: string, bucket: string | null): void {
  const input = (command as { input?: Record<string, unknown> } | null)?.input ?? {};
  if (command instanceof DescribeLoadBalancerAttributesCommand) {
    if (input['LoadBalancerArn'] !== arn || Object.keys(input).length !== 1)
      throw new AlbLoggingViolation('leitura de outro balanceador');
    return;
  }
  if (!(command instanceof ModifyLoadBalancerAttributesCommand)) {
    throw new AlbLoggingViolation(`comando ${commandName(command) || 'desconhecido'}`);
  }
  if (input['LoadBalancerArn'] !== arn) throw new AlbLoggingViolation('outro balanceador');
  if (Object.keys(input).some((key) => key !== 'LoadBalancerArn' && key !== 'Attributes'))
    throw new AlbLoggingViolation('campo a mais no pedido');
  const attributes = input['Attributes'];
  if (!Array.isArray(attributes)) throw new AlbLoggingViolation('sem atributos');
  const allowed = [
    accessLogAttributes({ kind: 'disable' }),
    ...(bucket === null ? [] : [accessLogAttributes({ kind: 'enable', bucket })]),
  ];
  if (!allowed.some((expected) => sameAttributes(expected, attributes)))
    throw new AlbLoggingViolation('atributo fora do log de acesso');
}

/**
 * O cliente do ELB com a trava: só o ALB dado, só a leitura dos atributos e a mudança do log de acesso no bucket dado (ou
 * o desligar). A recusa é lançada na hora, sem nenhuma chamada de rede.
 */
export function albLoggingClient<T extends { send: unknown }>(
  client: Pick<T, 'send'>,
  arn: string,
  bucket: string | null,
): Pick<T, 'send'> {
  const target = client as unknown as { send(command: unknown, ...rest: unknown[]): unknown };
  const send = (command: unknown, ...rest: unknown[]): unknown => {
    assertAccessLogCommand(command, arn, bucket);
    return target.send(command, ...rest);
  };
  return { send };
}

/** O log de acesso de um ALB como os atributos dizem. */
export interface AccessLogState {
  enabled: boolean;
  bucket: string | null;
  prefix: string | null;
}

/** Lê os atributos do log (a resposta é da AWS: só as três chaves contam, com tamanho limitado). */
export async function readAccessLog(
  elb: ElbSender,
  arn: string,
  signal: AbortSignal,
): Promise<AccessLogState> {
  const response = await elb.send(new DescribeLoadBalancerAttributesCommand({ LoadBalancerArn: arn }), {
    abortSignal: signal,
  });
  const values = new Map<string, string>();
  for (const attribute of response.Attributes ?? []) {
    if (
      typeof attribute.Key === 'string' &&
      typeof attribute.Value === 'string' &&
      attribute.Value.length <= 1024
    )
      values.set(attribute.Key, attribute.Value);
  }
  const bucket = values.get(ALB_ACCESS_LOG_KEYS.bucket) ?? '';
  const prefix = values.get(ALB_ACCESS_LOG_KEYS.prefix) ?? '';
  return {
    enabled: values.get(ALB_ACCESS_LOG_KEYS.enabled) === 'true',
    bucket: bucket === '' || bucketNameProblem(bucket) !== null ? null : bucket,
    prefix: prefix === '' ? null : prefix.slice(0, 512),
  };
}

/** Manda a mudança (já conferida pela trava do cliente). */
export async function changeAccessLog(
  elb: ElbSender,
  arn: string,
  change: AlbAccessLogChange,
  signal: AbortSignal,
): Promise<void> {
  await elb.send(
    new ModifyLoadBalancerAttributesCommand({
      LoadBalancerArn: arn,
      Attributes: accessLogAttributes(change),
    }),
    { abortSignal: signal },
  );
}

const DENIED = new Set([
  'AccessDenied',
  'AccessDeniedException',
  'UnauthorizedOperation',
  'AuthorizationError',
]);

/**
 * O motivo de uma recusa da AWS, só pelo nome do erro (a mensagem pode trazer o nome do bucket ou o ARN, e não sai daqui):
 * a permissão negada (a pilha sem a opção, ou uma SCP), o bucket que a AWS não conseguiu usar (o ELB grava um arquivo de
 * teste antes de aceitar), o balanceador que não existe mais e o limite de requisições.
 */
export function albLoggingFailureOf(error: unknown): WebAlbLoggingFailure {
  const name = awsErrorName(error);
  if (DENIED.has(name)) return 'permission_denied';
  if (name === 'InvalidConfigurationRequest' || name === 'InvalidConfigurationRequestException')
    return 'bucket_rejected';
  if (name === 'LoadBalancerNotFound' || name === 'LoadBalancerNotFoundException') return 'balancer_missing';
  if (isThrottling(error)) return 'throttled';
  return 'failed';
}
