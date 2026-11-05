import { CloudTrailClient, DescribeTrailsCommand, GetTrailStatusCommand } from '@aws-sdk/client-cloudtrail';
import {
  DescribePublishingDestinationCommand,
  GuardDutyClient,
  ListDetectorsCommand,
  ListPublishingDestinationsCommand,
} from '@aws-sdk/client-guardduty';
import { IAMClient, SimulatePrincipalPolicyCommand } from '@aws-sdk/client-iam';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import {
  AWS_CONNECTION_WARNING_CODES,
  type AwsConnectionWarningCode,
  awsReaderRoleArn,
  isAwsRegion,
  isNodeEgressIp,
  LOG_SOURCES,
  type LogSource,
} from '@verax/shared';
import { z } from 'zod';
import type { AwsCredentialIdentity } from '../inventory/read-only-session.js';
import type { AwsCheckOutcome, AwsCheckTarget, AwsConnectionChecker } from './aws-connection-check.js';
import {
  AWS_CLIENT_OPTIONS,
  AwsConnectionError,
  type AwsLogger,
  awsErrorName,
  isTransientAwsError,
  READER_SESSION_ARN_SUFFIX,
  STS_FALLBACK_REGION,
  type WebIdentityCredentials,
} from './web-identity.js';

/**
 * A conferência real da conexão da AWS (fase 2, PR-V5'; a interface e a tarefa são do PR-V3'). Cada chamada é uma
 * linha no CloudTrail do cliente: só leitura, o mínimo de chamadas, nada escrito nem apagado na conta dele.
 *
 * A cada conferência (o "Verificar" e, sem pedido, a cada 15 min):
 * 1. a sessão no papel (`WebIdentityCredentials`: token do Google e `AssumeRoleWithWebIdentity`, uma vez por hora);
 * 2. `GetCallerIdentity`: a sessão é a do papel da conta cadastrada (`assumed-role/verax-control-reader/
 *    verax-control-worker`), ou `account_mismatch`;
 * 3. em cada bucket cadastrado (sem repetir), `ListObjectsV2` com `MaxKeys=1` e `GetObject` de 1 byte
 *    (`Range: bytes=0-0`) do primeiro objeto, que prova o KMS quando ele é cifrado com SSE-KMS.
 *
 * Uma vez por dia (`daily`), depois de uma conferência sem erro, os avisos que não param a coleta:
 * - `trail_not_logging`: nenhuma trilha que grava no bucket do CloudTrail cadastrado está ligada (`DescribeTrails` com
 *   as trilhas de outras regiões e de organização, e `GetTrailStatus` só das que gravam nele);
 * - `guardduty_export_missing`: nenhum detector do GuardDuty publica no bucket cadastrado (`ListDetectors`,
 *   `ListPublishingDestinations` e `DescribePublishingDestination` só dos destinos S3 publicando);
 * - `excess_permissions`: `SimulatePrincipalPolicy` no próprio papel, com o IP de saída do nó em `aws:SourceIp` (sem
 *   ele, o Deny de IP da pilha negaria tudo e esconderia a permissão a mais), numa amostra de escrita, IAM, KMS e
 *   leitura fora da política. Sem o IP do nó configurado, a simulação fica de fora.
 * A trilha e o export são procurados nas regiões monitoradas, na ordem, até o primeiro encontrado.
 *
 * Mapa dos erros (só o código vai para a conta, nunca a mensagem):
 * - a troca do token: ver `stsErrorOf` (`trust_denied`, `token_invalid`, `idp_unavailable`, `aws_unavailable`) e
 *   `fetchGoogleIdToken` (`metadata_unavailable`);
 * - `NoSuchBucket`: `bucket_missing:<fonte>`; `AccessDenied` na listagem: `bucket_denied:<fonte>`;
 * - no `GetObject`, `KMS.*` ou `AccessDenied` que cita o KMS: `kms_denied:<fonte>`; `AccessDenied` por negação
 *   explícita na política do papel (o prefixo opcional `LogObjectPrefix`: o primeiro objeto é de outra conta do
 *   bucket da organização) não é erro; outro `AccessDenied`: `bucket_denied:<fonte>`; objeto arquivado, vazio ou
 *   apagado entre as duas chamadas também não;
 * - tempo esgotado, 5xx e limite: `aws_unavailable` (pode passar); qualquer outro: `check_unavailable` (pode passar).
 * Uma falha depois da entrada no papel descarta a sessão guardada da conta: a próxima conferência entra de novo (uma
 * sessão revogada pelo "Revoke active sessions" não fica em uso até vencer).
 */

/** O cliente da AWS que a conferência usa: o `send` e, nos reais, o `destroy` (os testes usam falsos). */
type SdkClient<T extends { send: unknown }> = Pick<T, 'send'> & { destroy?: () => void };

/** Os clientes da AWS, já com a sessão do papel. Os testes trocam por falsos. */
export interface AwsCheckClients {
  sts(region: string, credentials: AwsCredentialIdentity): SdkClient<STSClient>;
  s3(region: string, credentials: AwsCredentialIdentity): SdkClient<S3Client>;
  iam(credentials: AwsCredentialIdentity): SdkClient<IAMClient>;
  cloudtrail(region: string, credentials: AwsCredentialIdentity): SdkClient<CloudTrailClient>;
  guardduty(region: string, credentials: AwsCredentialIdentity): SdkClient<GuardDutyClient>;
}

/** Os clientes de verdade: o S3 segue o redirecionamento para a região do bucket (que pode não ser a da conta). */
export const SDK_AWS_CHECK_CLIENTS: AwsCheckClients = {
  sts: (region, credentials) => new STSClient({ region, credentials, ...AWS_CLIENT_OPTIONS }),
  s3: (region, credentials) =>
    new S3Client({ region, credentials, followRegionRedirects: true, ...AWS_CLIENT_OPTIONS }),
  // O IAM é global: assinado em us-east-1.
  iam: (credentials) => new IAMClient({ region: STS_FALLBACK_REGION, credentials, ...AWS_CLIENT_OPTIONS }),
  cloudtrail: (region, credentials) => new CloudTrailClient({ region, credentials, ...AWS_CLIENT_OPTIONS }),
  guardduty: (region, credentials) => new GuardDutyClient({ region, credentials, ...AWS_CLIENT_OPTIONS }),
};

/**
 * A amostra da permissão demais: ações que a política de leitura nunca permite neste recurso. O recurso é um objeto
 * de um bucket que nunca é cadastrado (cada ação é avaliada contra ele): uma permissão ampla (`Resource: *`, como a
 * `AdministratorAccess` ou a `ReadOnlyAccess`) aparece como `allowed`; uma permissão estreita fora da amostra não é
 * detectada. As do IAM e do STS são negadas também pelas negações da pilha: só aparecem se elas forem tiradas do papel.
 */
export const EXCESS_PERMISSION_SAMPLE = [
  // Escrita
  'ec2:RunInstances',
  'ec2:AuthorizeSecurityGroupIngress',
  'lambda:UpdateFunctionCode',
  // IAM e STS
  'iam:CreateUser',
  'iam:CreateAccessKey',
  'iam:AttachRolePolicy',
  'iam:PassRole',
  'sts:AssumeRole',
  // KMS fora do S3
  'kms:Decrypt',
  'kms:CreateGrant',
  // Leitura fora da política
  's3:GetObject',
  'secretsmanager:GetSecretValue',
  'ssm:GetParameter',
  'dynamodb:Scan',
] as const;
export const EXCESS_PERMISSION_RESOURCE =
  'arn:aws:s3:::verax-control-amostra-fora-da-politica/amostra.json.gz';

const callerSchema = z.object({ Account: z.string(), Arn: z.string() });
const keySchema = z.string().min(1).max(1024);
const trailsSchema = z.array(
  z.object({
    TrailARN: z.string().max(512).optional(),
    S3BucketName: z.string().max(255).optional(),
    HomeRegion: z.string().max(64).optional(),
  }),
);
const detectorIdsSchema = z.array(z.string().regex(/^[a-z0-9]{1,300}$/)).max(50);
const destinationsSchema = z.array(
  z.object({
    DestinationId: z.string().min(1).max(300),
    DestinationType: z.string().optional(),
    Status: z.string().optional(),
  }),
);
const evaluationsSchema = z.array(z.object({ EvalDecision: z.string().optional() }));

/** Um bucket a conferir e a primeira fonte que o usa (a fonte vai com o erro). */
interface BucketToCheck {
  name: string;
  source: LogSource;
}

/** Os buckets cadastrados, cada nome uma vez, na ordem das fontes. */
function bucketsOf(target: AwsCheckTarget): BucketToCheck[] {
  const seen = new Set<string>();
  const buckets: BucketToCheck[] = [];
  for (const source of LOG_SOURCES) {
    const name = target.buckets[source];
    if (name === null || seen.has(name)) continue;
    seen.add(name);
    buckets.push({ name, source });
  }
  return buckets;
}

/** As regiões monitoradas, válidas e sem repetir; sem nenhuma, us-east-1. */
function regionsOf(target: AwsCheckTarget): string[] {
  const regions = [...new Set(target.regions.filter(isAwsRegion))];
  return regions.length > 0 ? regions : [STS_FALLBACK_REGION];
}

const S3_ARN_PREFIXES = ['arn:aws:s3:::', 'arn:aws-cn:s3:::', 'arn:aws-us-gov:s3:::'];

/** O nome do bucket de um ARN do S3 (`arn:aws:s3:::bucket/prefixo`); null fora desse formato. */
function bucketOfArn(arn: unknown): string | null {
  if (typeof arn !== 'string') return null;
  const prefix = S3_ARN_PREFIXES.find((candidate) => arn.startsWith(candidate));
  if (prefix === undefined) return null;
  const bucket = arn.slice(prefix.length).split('/', 1)[0] ?? '';
  return bucket.length >= 3 && bucket.length <= 63 ? bucket : null;
}

/** Uma falha qualquer da AWS: passageira (`aws_unavailable`) ou não (`check_unavailable`); as duas podem passar. */
function unexpected(error: unknown): AwsConnectionError {
  return new AwsConnectionError(isTransientAwsError(error) ? 'aws_unavailable' : 'check_unavailable', true);
}

function messageOf(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : '';
}

/** A listagem do bucket falhou. */
function listErrorOf(error: unknown, source: LogSource): AwsConnectionError {
  switch (awsErrorName(error)) {
    case 'NoSuchBucket':
      return new AwsConnectionError('bucket_missing', false, source);
    case 'AccessDenied':
    case 'AllAccessDisabled':
      return new AwsConnectionError('bucket_denied', false, source);
    default:
      return unexpected(error);
  }
}

/**
 * O `GetObject` de 1 byte falhou: o erro da conta, ou null quando a falha não diz nada sobre o acesso (o objeto foi
 * arquivado, está vazio, sumiu entre a listagem e a leitura, ou fica fora do prefixo do papel).
 */
function readErrorOf(error: unknown, source: LogSource): AwsConnectionError | null {
  const name = awsErrorName(error);
  if (name.startsWith('KMS.')) return new AwsConnectionError('kms_denied', false, source);
  switch (name) {
    case 'NoSuchKey':
    case 'InvalidObjectState':
    case 'InvalidRange':
      return null;
    case 'NoSuchBucket':
      return new AwsConnectionError('bucket_missing', false, source);
    case 'AccessDenied': {
      // A mensagem só é lida aqui, para separar o KMS do resto; nunca vai para o log nem para a conta.
      const message = messageOf(error);
      if (/\bkms\b|ciphertext|master key/i.test(message)) {
        return new AwsConnectionError('kms_denied', false, source);
      }
      if (/explicit deny in an identity-based policy/i.test(message)) return null;
      return new AwsConnectionError('bucket_denied', false, source);
    }
    default:
      return unexpected(error);
  }
}

/** Esvazia o corpo de 1 byte do `GetObject`, para a conexão voltar ao pool. O conteúdo é descartado. */
async function discard(body: unknown): Promise<void> {
  const stream = body as { transformToByteArray?: () => Promise<Uint8Array> } | null | undefined;
  if (typeof stream?.transformToByteArray === 'function') await stream.transformToByteArray();
}

/** O resultado de uma conferência diária: tudo certo, um aviso, ou não deu para concluir (falha passageira). */
type DailyResult = 'ok' | 'unknown' | AwsConnectionWarningCode;

/** Os clientes de uma conferência, criados sob demanda e fechados no fim. */
class CheckClients {
  readonly #cache = new Map<string, SdkClient<{ send: unknown }>>();

  constructor(
    private readonly factory: AwsCheckClients,
    private readonly credentials: AwsCredentialIdentity,
  ) {}

  #get<T extends SdkClient<{ send: unknown }>>(key: string, create: () => T): T {
    const cached = this.#cache.get(key);
    if (cached !== undefined) return cached as T;
    const client = create();
    this.#cache.set(key, client);
    return client;
  }

  sts(region: string): SdkClient<STSClient> {
    return this.#get(`sts:${region}`, () => this.factory.sts(region, this.credentials));
  }

  s3(region: string): SdkClient<S3Client> {
    return this.#get(`s3:${region}`, () => this.factory.s3(region, this.credentials));
  }

  iam(): SdkClient<IAMClient> {
    return this.#get('iam', () => this.factory.iam(this.credentials));
  }

  cloudtrail(region: string): SdkClient<CloudTrailClient> {
    return this.#get(`cloudtrail:${region}`, () => this.factory.cloudtrail(region, this.credentials));
  }

  guardduty(region: string): SdkClient<GuardDutyClient> {
    return this.#get(`guardduty:${region}`, () => this.factory.guardduty(region, this.credentials));
  }

  destroy(): void {
    for (const client of this.#cache.values()) client.destroy?.();
    this.#cache.clear();
  }
}

export interface WebIdentityCheckerOptions {
  /** As sessões no papel (uma por conta, guardadas até perto de vencer). */
  credentials: WebIdentityCredentials;
  /** Os IPs de saída do nó (`NODE_EGRESS_IPS`): o primeiro vai em `aws:SourceIp` na simulação. */
  egressIps?: readonly string[];
  clients?: AwsCheckClients;
  logger?: AwsLogger;
}

/** A conferência real (PR-V5'), no lugar da `UnavailableAwsConnectionChecker` do PR-V3'. */
export class WebIdentityAwsConnectionChecker implements AwsConnectionChecker {
  readonly #credentials: WebIdentityCredentials;
  readonly #sourceIp: string | null;
  readonly #clients: AwsCheckClients;
  readonly #logger: AwsLogger;

  constructor({
    credentials,
    egressIps = [],
    clients = SDK_AWS_CHECK_CLIENTS,
    logger,
  }: WebIdentityCheckerOptions) {
    this.#credentials = credentials;
    const first = egressIps.find(isNodeEgressIp);
    this.#sourceIp = first === undefined ? null : first.slice(0, -'/32'.length);
    this.#clients = clients;
    this.#logger = logger ?? { warn: () => undefined };
  }

  /** A simulação da permissão demais roda (o nó informou o IP de saída)? */
  get simulatesPermissions(): boolean {
    return this.#sourceIp !== null;
  }

  async check(target: AwsCheckTarget, signal: AbortSignal): Promise<AwsCheckOutcome> {
    let entered = false;
    let clients: CheckClients | null = null;
    try {
      const region = regionsOf(target)[0] ?? STS_FALLBACK_REGION;
      const session = await this.#credentials.session(target.accountId, region, signal);
      entered = true;
      clients = new CheckClients(this.#clients, session.credentials.identity());
      await this.#callerIdentity(target.accountId, clients.sts(session.stsRegion), signal);
      for (const bucket of bucketsOf(target)) await this.#readBucket(bucket, clients.s3(region), signal);
      const warnings: AwsConnectionWarningCode[] = session.regionFallback ? ['region_disabled'] : [];
      if (!target.daily) return { ok: true, warnings };
      const daily = await this.#daily(target, clients, signal);
      return daily === null ? { ok: true, warnings } : { ok: true, warnings, daily: { warnings: daily } };
    } catch (error) {
      if (signal.aborted) throw error;
      if (!(error instanceof AwsConnectionError)) throw error;
      // Uma sessão revogada no console ("Revoke active sessions") falha com AccessDenied: a próxima entra de novo.
      if (entered && error.code !== 'aws_unavailable') this.#credentials.forget(target.accountId);
      return {
        ok: false,
        code: error.code,
        retryable: error.retryable,
        ...(error.source !== undefined && { source: error.source }),
      };
    } finally {
      clients?.destroy();
    }
  }

  async #callerIdentity(accountId: string, sts: SdkClient<STSClient>, signal: AbortSignal): Promise<void> {
    let response: unknown;
    try {
      response = await sts.send(new GetCallerIdentityCommand({}), { abortSignal: signal });
    } catch (error) {
      if (signal.aborted) throw error;
      throw unexpected(error);
    }
    const caller = callerSchema.safeParse(response);
    if (
      !caller.success ||
      caller.data.Account !== accountId ||
      caller.data.Arn !== `arn:aws:sts::${accountId}${READER_SESSION_ARN_SUFFIX}`
    ) {
      throw new AwsConnectionError('account_mismatch', false);
    }
  }

  async #readBucket(bucket: BucketToCheck, s3: SdkClient<S3Client>, signal: AbortSignal): Promise<void> {
    let listed: { Contents?: { Key?: string }[] | undefined };
    try {
      listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket.name, MaxKeys: 1 }), {
        abortSignal: signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw listErrorOf(error, bucket.source);
    }
    // Bucket vazio: a listagem está provada; o KMS fica para quando houver objeto.
    const key = keySchema.safeParse(listed.Contents?.[0]?.Key);
    if (!key.success) return;
    try {
      const object = await s3.send(
        new GetObjectCommand({ Bucket: bucket.name, Key: key.data, Range: 'bytes=0-0' }),
        { abortSignal: signal },
      );
      await discard(object.Body);
    } catch (error) {
      if (signal.aborted) throw error;
      const failure = readErrorOf(error, bucket.source);
      if (failure !== null) throw failure;
    }
  }

  /** As três conferências diárias, uma depois da outra. Null se alguma não pôde ser concluída (falha passageira). */
  async #daily(
    target: AwsCheckTarget,
    clients: CheckClients,
    signal: AbortSignal,
  ): Promise<AwsConnectionWarningCode[] | null> {
    const results: DailyResult[] = [
      await this.#trail(target, clients, signal),
      await this.#guardDutyExport(target, clients, signal),
      await this.#excessPermissions(target, clients, signal),
    ];
    if (results.includes('unknown')) return null;
    return AWS_CONNECTION_WARNING_CODES.filter((code) => results.includes(code));
  }

  /** Uma chamada das conferências diárias: o resultado, ou `failed` (passageira ou não) sem a mensagem. */
  async #attempt<T>(
    call: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<{ ok: true; value: T } | { ok: false; transient: boolean }> {
    try {
      return { ok: true, value: await call() };
    } catch (error) {
      if (signal.aborted) throw error;
      return { ok: false, transient: isTransientAwsError(error) };
    }
  }

  async #trail(target: AwsCheckTarget, clients: CheckClients, signal: AbortSignal): Promise<DailyResult> {
    const bucket = target.buckets.cloudtrail;
    if (bucket === null) return 'ok';
    const checked = new Set<string>();
    let unknown = false;
    for (const region of regionsOf(target)) {
      const described = await this.#attempt(
        () =>
          clients
            .cloudtrail(region)
            .send(new DescribeTrailsCommand({ includeShadowTrails: true }), { abortSignal: signal }),
        signal,
      );
      if (!described.ok) {
        unknown ||= described.transient;
        continue;
      }
      const trails = trailsSchema.safeParse(described.value.trailList ?? []);
      if (!trails.success) continue;
      for (const trail of trails.data) {
        const arn = trail.TrailARN;
        if (trail.S3BucketName !== bucket || arn === undefined || checked.has(arn)) continue;
        checked.add(arn);
        const home =
          trail.HomeRegion !== undefined && isAwsRegion(trail.HomeRegion) ? trail.HomeRegion : region;
        const status = await this.#attempt(
          () =>
            clients.cloudtrail(home).send(new GetTrailStatusCommand({ Name: arn }), { abortSignal: signal }),
          signal,
        );
        if (status.ok && status.value.IsLogging === true) return 'ok';
        if (!status.ok) unknown ||= status.transient;
      }
    }
    return unknown ? 'unknown' : 'trail_not_logging';
  }

  async #guardDutyExport(
    target: AwsCheckTarget,
    clients: CheckClients,
    signal: AbortSignal,
  ): Promise<DailyResult> {
    const bucket = target.buckets.guardduty;
    if (bucket === null) return 'ok';
    let unknown = false;
    for (const region of regionsOf(target)) {
      const guardduty = clients.guardduty(region);
      const listed = await this.#attempt(
        () => guardduty.send(new ListDetectorsCommand({}), { abortSignal: signal }),
        signal,
      );
      if (!listed.ok) {
        unknown ||= listed.transient;
        continue;
      }
      const detectors = detectorIdsSchema.safeParse(listed.value.DetectorIds ?? []);
      if (!detectors.success) continue;
      for (const detectorId of detectors.data) {
        const destinations = await this.#attempt(
          () =>
            guardduty.send(new ListPublishingDestinationsCommand({ DetectorId: detectorId }), {
              abortSignal: signal,
            }),
          signal,
        );
        if (!destinations.ok) {
          unknown ||= destinations.transient;
          continue;
        }
        const parsed = destinationsSchema.safeParse(destinations.value.Destinations ?? []);
        if (!parsed.success) continue;
        for (const destination of parsed.data) {
          if (destination.DestinationType !== 'S3' || destination.Status !== 'PUBLISHING') continue;
          const described = await this.#attempt(
            () =>
              guardduty.send(
                new DescribePublishingDestinationCommand({
                  DetectorId: detectorId,
                  DestinationId: destination.DestinationId,
                }),
                { abortSignal: signal },
              ),
            signal,
          );
          if (!described.ok) {
            unknown ||= described.transient;
            continue;
          }
          if (
            described.value.Status === 'PUBLISHING' &&
            bucketOfArn(described.value.DestinationProperties?.DestinationArn) === bucket
          ) {
            return 'ok';
          }
        }
      }
    }
    return unknown ? 'unknown' : 'guardduty_export_missing';
  }

  async #excessPermissions(
    target: AwsCheckTarget,
    clients: CheckClients,
    signal: AbortSignal,
  ): Promise<DailyResult> {
    const sourceIp = this.#sourceIp;
    if (sourceIp === null) return 'ok';
    const simulated = await this.#attempt(
      () =>
        clients.iam().send(
          new SimulatePrincipalPolicyCommand({
            PolicySourceArn: awsReaderRoleArn(target.accountId),
            ActionNames: [...EXCESS_PERMISSION_SAMPLE],
            ResourceArns: [EXCESS_PERMISSION_RESOURCE],
            ContextEntries: [
              { ContextKeyName: 'aws:SourceIp', ContextKeyType: 'ip', ContextKeyValues: [sourceIp] },
            ],
            MaxItems: 100,
          }),
          { abortSignal: signal },
        ),
      signal,
    );
    if (!simulated.ok) {
      if (simulated.transient) return 'unknown';
      // Sem a permissão de simular (a pilha mudou): o aviso fica de fora, e o log diz por quê (sem dado da conta).
      this.#logger.warn(
        {},
        'a AWS recusou a simulação da permissão demais: o aviso fica de fora nesta conta',
      );
      return 'ok';
    }
    const evaluations = evaluationsSchema.safeParse(simulated.value.EvaluationResults ?? []);
    if (!evaluations.success) return 'ok';
    return evaluations.data.some((result) => result.EvalDecision === 'allowed') ? 'excess_permissions' : 'ok';
  }
}
