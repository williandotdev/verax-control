import { AssumeRoleWithWebIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import {
  AWS_READER_ROLE_NAME,
  type AwsConnectionErrorCode,
  awsReaderRoleArn,
  isAwsRegion,
  isWebIdentityAudience,
  type LogSource,
} from '@verax/shared';
import { z } from 'zod';
import { forgetLiveSecret, registerLiveSecret } from '../common/logger/sanitize.js';
import { type AwsCredentialIdentity, TemporaryCredentials } from '../inventory/read-only-session.js';

/**
 * Entrada do worker no papel de leitura da conta AWS do cliente, sem chave (fase 2, PR-V5'; `docs/ARQUITETURA.md`,
 * "Por que papel sem chave"). O worker, o único contêiner do nó com o metadata da GCP, pede ao servidor de metadados
 * um token do Google (ID token da conta de serviço do nó, para o audience do nó, `format=standard`) e o troca no STS
 * (`AssumeRoleWithWebIdentity`, que não usa credencial da AWS) por uma sessão de 1 hora no papel
 * `/verax/verax-control-reader` da conta, derivado do ID cadastrado.
 *
 * - O token nunca vai para o log nem para erro: só o código. O logger oculta qualquer texto com a forma de um JWT, e as
 *   credenciais da sessão ficam num objeto que se recusa a virar JSON ou texto de log (`TemporaryCredentials`), com o
 *   segredo e o token da sessão registrados como segredos vivos enquanto valem.
 * - Uma sessão por conta, guardada até faltarem 5 min para vencer (o mesmo limiar do SDK): os clientes da AWS de uma
 *   conferência e o inventário (PR-14', `credentialsFor`) dividem a mesma entrada no papel, uma por hora.
 * - O STS é o da região da conta (endpoint regional). Se o cliente desligou o STS dela (`RegionDisabled`), a troca é
 *   repetida em us-east-1, que não pode ser desligado, e a sessão fica marcada (`regionFallback`): o Wazuh usa o STS
 *   da região, e a conferência mostra o aviso `region_disabled`.
 */

export const GOOGLE_IDENTITY_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';
/** O metadata responde na hora; 3 s bastam e não prendem a tarefa. */
export const METADATA_TIMEOUT_MS = 3_000;
/** O nome da sessão no CloudTrail do cliente: `assumed-role/verax-control-reader/verax-control-worker`. */
export const WORKER_SESSION_NAME = 'verax-control-worker';
/** 1 hora, a `MaxSessionDuration` do papel no template. */
export const WORKER_SESSION_SECONDS = 3600;
/** Renova a sessão quando faltam 5 min para vencer, como o SDK. */
export const SESSION_REFRESH_MARGIN_MS = 5 * 60_000;
/** O STS que não pode ser desligado: a segunda tentativa diante de `RegionDisabled`. */
export const STS_FALLBACK_REGION = 'us-east-1';

/** JWT compacto: três partes em base64url. O tamanho limita o que um metadata estranho poderia mandar. */
const idTokenSchema = z
  .string()
  .max(8192)
  .regex(/^[\w-]+\.[\w-]+\.[\w-]+$/);

/** As quatro partes da sessão que a AWS devolve; qualquer outra forma é recusada sem ir para o log. */
const sessionSchema = z.object({
  AccessKeyId: z.string().regex(/^[A-Z0-9]{16,128}$/),
  SecretAccessKey: z.string().min(16).max(256),
  SessionToken: z.string().min(16).max(8192),
  Expiration: z.date(),
});

/** Os claims que o worker confere no token, sem validar a assinatura (quem valida é a AWS). */
const claimsSchema = z.object({ sub: z.string().max(128) });

/** Uma falha da conexão da AWS com o código que vai para a conta. A mensagem é só o código. */
export class AwsConnectionError extends Error {
  constructor(
    readonly code: AwsConnectionErrorCode,
    readonly retryable: boolean,
    readonly source?: LogSource,
  ) {
    super(`conexão da AWS: ${code}`);
    this.name = 'AwsConnectionError';
  }
}

/** O que o worker loga sobre a AWS: só o tipo e campos sem dado de cliente (o pino do worker, um dublê nos testes). */
export interface AwsLogger {
  warn(fields: object, message: string): void;
}

const SILENT: AwsLogger = { warn: () => undefined };

/** O nome do erro da AWS (o código), ou '' para um erro sem nome. A mensagem nunca é usada para o log. */
export function awsErrorName(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name : '';
}

/** O código do erro sem o sufixo `Exception` que o SDK põe nos modelados (`RegionDisabledException`). */
function baseName(error: unknown): string {
  return awsErrorName(error).replace(/Exception$/, '');
}

const TRANSIENT_NAMES = new Set([
  'Throttling',
  'ThrottlingException',
  'TooManyRequestsException',
  'RequestLimitExceeded',
  'SlowDown',
  'RequestTimeout',
  'RequestTimeoutException',
  'ServiceUnavailable',
  'ServiceUnavailableException',
  'InternalError',
  'InternalFailure',
  'InternalServerError',
  'InternalServerErrorException',
  'TimeoutError',
]);

/**
 * Falha passageira da AWS: limite, tempo esgotado, erro 5xx ou nenhuma resposta (rede). Os erros de serviço trazem
 * `$metadata` com o código HTTP; um erro sem ele não chegou a ter resposta.
 */
export function isTransientAwsError(error: unknown): boolean {
  const details = error as {
    $retryable?: unknown;
    $fault?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  } | null;
  if (details === null || typeof details !== 'object') return true;
  if (details.$retryable || details.$fault === 'server') return true;
  const status = details.$metadata?.httpStatusCode;
  if (typeof status === 'number' && (status >= 500 || status === 429)) return true;
  if (TRANSIENT_NAMES.has(awsErrorName(error))) return true;
  return details.$metadata === undefined && !(error instanceof AwsConnectionError);
}

/**
 * O código da conta para uma falha do `AssumeRoleWithWebIdentity` (o `RegionDisabled` é tratado antes, com a segunda
 * tentativa em us-east-1):
 * - `AccessDenied`: `trust_denied`, que pode passar (logo depois da criação da pilha, o IAM leva alguns segundos);
 * - token recusado (`InvalidIdentityToken`, `ExpiredToken`, `IDPRejectedClaim`): `token_invalid`;
 * - `IDPCommunicationError` (a AWS não alcançou o Google): `idp_unavailable`, que pode passar;
 * - falha passageira: `aws_unavailable`; qualquer outra: `check_unavailable`, que pode passar.
 */
export function stsErrorOf(error: unknown): AwsConnectionError {
  switch (baseName(error)) {
    case 'AccessDenied':
      return new AwsConnectionError('trust_denied', true);
    case 'InvalidIdentityToken':
    case 'ExpiredToken':
    case 'IDPRejectedClaim':
      return new AwsConnectionError('token_invalid', false);
    case 'IDPCommunicationError':
      return new AwsConnectionError('idp_unavailable', true);
    case 'RegionDisabled':
      return new AwsConnectionError('region_disabled', false);
    default:
      return new AwsConnectionError(
        isTransientAwsError(error) ? 'aws_unavailable' : 'check_unavailable',
        true,
      );
  }
}

function isRegionDisabled(error: unknown): boolean {
  return baseName(error) === 'RegionDisabled';
}

export interface GoogleIdTokenOptions {
  /** O endereço do metadata (os testes usam um servidor falso). */
  url?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * O token do Google da conta de serviço do nó, para o audience pedido (`format=standard`: sem o projeto nem a VM). O
 * metadata emite um token novo a cada pedido, válido por até 1 hora. Fora do ar, fora do tempo ou com uma resposta
 * fora do formato: `metadata_unavailable`, que pode passar. O token nunca vai para log nem para erro.
 */
export async function fetchGoogleIdToken(
  audience: string,
  signal?: AbortSignal,
  {
    url = GOOGLE_IDENTITY_URL,
    fetch: fetchImpl = fetch,
    timeoutMs = METADATA_TIMEOUT_MS,
  }: GoogleIdTokenOptions = {},
): Promise<string> {
  if (!isWebIdentityAudience(audience)) throw new AwsConnectionError('metadata_unavailable', false);
  const query = new URLSearchParams({ audience, format: 'standard' });
  const timeout = AbortSignal.timeout(timeoutMs);
  let text: string;
  try {
    const response = await fetchImpl(`${url}?${query.toString()}`, {
      headers: { 'Metadata-Flavor': 'Google' },
      redirect: 'error',
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    if (!response.ok) throw new AwsConnectionError('metadata_unavailable', true);
    text = (await response.text()).trim();
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof AwsConnectionError) throw error;
    throw new AwsConnectionError('metadata_unavailable', true);
  }
  const token = idTokenSchema.safeParse(text);
  if (!token.success) throw new AwsConnectionError('metadata_unavailable', true);
  return token.data;
}

/**
 * O `sub` do token do Google, lido sem conferir a assinatura (quem confere é a AWS) e sem rede: é o ID único da conta
 * de serviço que emitiu o token. Null para um token fora do formato.
 */
export function googleIdTokenSubject(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'));
    const claims = claimsSchema.safeParse(payload);
    return claims.success ? claims.data.sub : null;
  } catch {
    return null;
  }
}

/** O resultado da conferência da identidade do nó na partida do worker. Nenhum campo é segredo. */
export type NodeIdentityCheck =
  | { readonly status: 'ok' }
  | { readonly status: 'mismatch'; readonly expected: string; readonly actual: string | null }
  | { readonly status: 'unavailable'; readonly code: AwsConnectionErrorCode };

/**
 * Na partida do worker: o `sub` do token que o metadata emite é o ID único da conta de serviço que o `node.conf`
 * informa (`NODE_SA_UNIQUE_ID`, o `NodeServiceAccountId` que o painel mostra para a pilha do cliente)? Se não for, a
 * confiança de todo papel criado com o valor do painel recusa o nó. Só decodifica o token (sem rede além do metadata),
 * e nenhum resultado carrega o token.
 */
export async function checkNodeIdentity(
  expectedSubject: string,
  idToken: (signal?: AbortSignal) => Promise<string>,
): Promise<NodeIdentityCheck> {
  let token: string;
  try {
    token = await idToken();
  } catch (error) {
    return {
      status: 'unavailable',
      code: error instanceof AwsConnectionError ? error.code : 'metadata_unavailable',
    };
  }
  const actual = googleIdTokenSubject(token);
  return actual === expectedSubject
    ? { status: 'ok' }
    : { status: 'mismatch', expected: expectedSubject, actual };
}

/** O logger da partida do worker (o pino; um dublê nos testes). */
export interface NodeIdentityLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

/**
 * O resultado da conferência da identidade do nó, no log do worker: os dois IDs (não são segredo: o painel mostra o do
 * `node.conf`) e o código, nunca o token. A divergência é um erro: os papéis criados com o valor do painel recusam o
 * nó (`trust_denied`) até o `node.conf` (ou a pilha de cada cliente) ser corrigido.
 */
export function reportNodeIdentity(check: NodeIdentityCheck, logger: NodeIdentityLogger): void {
  switch (check.status) {
    case 'ok':
      logger.info(
        {},
        'identidade do nó conferida: o token do Google é da conta de serviço do NODE_SA_UNIQUE_ID',
      );
      return;
    case 'mismatch':
      logger.error(
        { nodeServiceAccountId: check.expected, googleSubject: check.actual },
        'o token do Google do nó não é da conta de serviço do NODE_SA_UNIQUE_ID do node.conf: as pilhas criadas com ' +
          'o valor do painel recusam o nó. Corrija o NODE_SA_UNIQUE_ID (terraform output) e reinicie o nó',
      );
      return;
    case 'unavailable':
      logger.warn(
        { code: check.code },
        'não foi possível pedir o token do Google na partida: a identidade do nó não foi conferida',
      );
  }
}

/** O que o SDK aceita em `credentials`: a função que devolve a sessão (memorizada e renovada pelo próprio cliente). */
export type AwsCredentialProvider = () => Promise<AwsCredentialIdentity>;

/** Uma sessão no papel de leitura de uma conta. */
export interface ReaderSession {
  readonly credentials: TemporaryCredentials;
  /** A região do STS que emitiu a sessão (a da conta, ou us-east-1 na segunda tentativa). */
  readonly stsRegion: string;
  /** O STS da região da conta está desligado: a sessão veio de us-east-1. */
  readonly regionFallback: boolean;
}

/** Um STS para a troca: sem credencial (a operação não é assinada); os testes usam um falso. */
export type StsForRegion = (region: string) => Pick<STSClient, 'send'>;

export interface WebIdentityCredentialsOptions {
  /** O audience do token (o `AWS_WEB_IDENTITY_AUDIENCE` do nó, ou o padrão do template). */
  audience: string;
  /** O token do Google; o padrão pede ao metadata da GCP. */
  idToken?: (signal?: AbortSignal) => Promise<string>;
  sts?: StsForRegion;
  now?: () => Date;
  logger?: AwsLogger;
}

/**
 * Opções comuns dos clientes da AWS do worker: uma tentativa a mais nas falhas passageiras (cada tentativa é uma linha
 * no CloudTrail do cliente) e tempo curto, para a tarefa não ficar presa.
 */
export const AWS_CLIENT_OPTIONS = {
  maxAttempts: 2,
  requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000 },
} as const;

/** O STS da região para a troca: endpoint regional e sem credencial (a operação usa `noAuth`). */
function defaultSts(region: string): Pick<STSClient, 'send'> {
  return new STSClient({
    region,
    ...AWS_CLIENT_OPTIONS,
    // Se o SDK um dia tentasse assinar a troca, a falha seria explícita, sem passar pela cadeia padrão (que procuraria
    // credencial no ambiente e no metadata da EC2, que na GCP é o da VM).
    credentials: () => Promise.reject(new Error('a troca do token no STS não usa credencial da AWS')),
  });
}

/**
 * Provedor de sessões no papel de leitura, uma por conta, para qualquer cliente do SDK (`credentialsFor`). Exportado
 * para o inventário (PR-14'), que deixa o `assumeReadOnlyRole` do conector antigo.
 */
export class WebIdentityCredentials {
  readonly #sessions = new Map<string, ReaderSession>();
  readonly #pending = new Map<string, Promise<ReaderSession>>();
  readonly #audience: string;
  readonly #idToken: (signal?: AbortSignal) => Promise<string>;
  readonly #sts: StsForRegion;
  readonly #now: () => Date;
  readonly #logger: AwsLogger;

  constructor({
    audience,
    idToken,
    sts,
    now = () => new Date(),
    logger = SILENT,
  }: WebIdentityCredentialsOptions) {
    if (!isWebIdentityAudience(audience)) throw new Error('audience do token do Google fora do formato');
    this.#audience = audience;
    this.#idToken = idToken ?? ((signal) => fetchGoogleIdToken(this.#audience, signal));
    this.#sts = sts ?? defaultSts;
    this.#now = now;
    this.#logger = logger;
  }

  /**
   * A sessão da conta: a guardada, se ainda falta mais de 5 min para vencer, ou uma nova (um token novo do metadata e
   * uma entrada no papel). Pedidos ao mesmo tempo para a mesma conta dividem a mesma entrada. A falha é um
   * `AwsConnectionError` com o código da conta.
   */
  async session(accountId: string, region: string, signal?: AbortSignal): Promise<ReaderSession> {
    const cached = this.#sessions.get(accountId);
    if (cached !== undefined && this.#fresh(cached)) return cached;
    const running = this.#pending.get(accountId);
    if (running !== undefined) return running;
    const assumed = this.#assume(accountId, region, signal).finally(() => this.#pending.delete(accountId));
    this.#pending.set(accountId, assumed);
    return assumed;
  }

  /** Para um cliente do SDK: `new S3Client({ region, credentials: provedor.credentialsFor(conta, região) })`. */
  credentialsFor(accountId: string, region: string): AwsCredentialProvider {
    return async () => (await this.session(accountId, region)).credentials.identity();
  }

  /** Descarta a sessão guardada da conta (conta removida). */
  forget(accountId: string): void {
    const cached = this.#sessions.get(accountId);
    if (cached !== undefined) this.#release(cached);
    this.#sessions.delete(accountId);
  }

  #fresh(session: ReaderSession): boolean {
    const expiration = session.credentials.expiration;
    return (
      expiration !== undefined && expiration.getTime() - this.#now().getTime() > SESSION_REFRESH_MARGIN_MS
    );
  }

  async #assume(accountId: string, region: string, signal?: AbortSignal): Promise<ReaderSession> {
    if (!/^\d{12}$/.test(accountId)) throw new Error('conta AWS fora do formato');
    const home = isAwsRegion(region) ? region : STS_FALLBACK_REGION;
    const token = await this.#idToken(signal);
    const command = new AssumeRoleWithWebIdentityCommand({
      RoleArn: awsReaderRoleArn(accountId),
      RoleSessionName: WORKER_SESSION_NAME,
      WebIdentityToken: token,
      DurationSeconds: WORKER_SESSION_SECONDS,
    });
    let stsRegion = home;
    let response;
    try {
      response = await this.#sts(home).send(command, { abortSignal: signal });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (!isRegionDisabled(error) || home === STS_FALLBACK_REGION) throw stsErrorOf(error);
      // O cliente desligou o STS da região: o de us-east-1 não pode ser desligado. O mesmo token vale (a troca não o
      // consome). Só a região vai para o log.
      this.#logger.warn(
        { stsRegion: home, fallbackRegion: STS_FALLBACK_REGION },
        'STS da região desligado na conta AWS: entrando no papel pelo de us-east-1',
      );
      stsRegion = STS_FALLBACK_REGION;
      try {
        response = await this.#sts(STS_FALLBACK_REGION).send(command, { abortSignal: signal });
      } catch (fallbackError) {
        if (signal?.aborted) throw signal.reason;
        throw stsErrorOf(fallbackError);
      }
    }
    const parsed = sessionSchema.safeParse(response.Credentials);
    if (!parsed.success) throw new AwsConnectionError('aws_unavailable', true);
    const identity: AwsCredentialIdentity = {
      accessKeyId: parsed.data.AccessKeyId,
      secretAccessKey: parsed.data.SecretAccessKey,
      sessionToken: parsed.data.SessionToken,
      expiration: parsed.data.Expiration,
    };
    const session: ReaderSession = {
      credentials: new TemporaryCredentials(identity),
      stsRegion,
      regionFallback: stsRegion !== home,
    };
    const previous = this.#sessions.get(accountId);
    if (previous !== undefined) this.#release(previous);
    registerLiveSecret(identity.secretAccessKey);
    registerLiveSecret(identity.sessionToken);
    this.#sessions.set(accountId, session);
    return session;
  }

  /** A sessão substituída deixa de ser segredo vivo do logger (o conjunto não cresce a cada hora). */
  #release(session: ReaderSession): void {
    const identity = session.credentials.identity();
    forgetLiveSecret(identity.secretAccessKey);
    forgetLiveSecret(identity.sessionToken);
  }
}

/** O nome do papel, para conferir o ARN da sessão (`assumed-role/<papel>/<sessão>`: o ARN da sessão não tem o caminho). */
export const READER_SESSION_ARN_SUFFIX = `:assumed-role/${AWS_READER_ROLE_NAME}/${WORKER_SESSION_NAME}`;
