import { GoogleAuth } from 'google-auth-library';

/**
 * A camada HTTP dos clientes REST do provisionamento (CP-07): Cloudflare, Firebase Hosting, Compute (guest attributes),
 * Cloud Storage, Cloud Run (o Job do Terraform) e Secret Manager. `fetch` do Node com `google-auth-library` para o
 * token do Google, em vez de um SDK por serviço (plano §8: sem `@google-cloud/compute`, `@google-cloud/storage`,
 * `@google-cloud/run` nem `firebase-admin`).
 *
 * Regras de toda chamada:
 * - prazo por tentativa (`AbortSignal.timeout`) e `redirect: 'error'`: um redirecionamento nunca leva o token para
 *   outro endereço;
 * - corpo da resposta com teto de tamanho, lido inteiro só até ele;
 * - o erro (`CloudApiError`) diz o serviço, a operação, o status e um código curto da API (`PERMISSION_DENIED`,
 *   `cf_1013`), nunca a mensagem nem o corpo da resposta, que podem repetir um valor da requisição, nem a URL com a
 *   query, nem o token.
 */

export type CloudService =
  'cloudflare' | 'firebase' | 'compute' | 'storage' | 'run' | 'secretmanager' | 'iamcredentials' | 'tenant';

/** Token de acesso OAuth do Google da conta do serviço (no Cloud Run, a `cp-worker`, pelo servidor de metadados). */
export interface AccessTokenSource {
  token(): Promise<string>;
}

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/**
 * As credenciais padrão do ambiente (`google-auth-library`): no Cloud Run, a conta do serviço pelo servidor de
 * metadados. A biblioteca guarda o token até perto do vencimento. O valor (`ya29.…`) é ocultado pelo logger por padrão
 * (`common/logger/sanitize.ts`) e nunca vai para um erro daqui.
 */
export class GoogleAccessTokenSource implements AccessTokenSource {
  private auth: GoogleAuth | undefined;

  async token(): Promise<string> {
    this.auth ??= new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
    let value: string | null | undefined;
    try {
      value = await this.auth.getAccessToken();
    } catch {
      // A mensagem da biblioteca pode citar o caminho de um arquivo de credencial; fica só o tipo da falha.
      throw new CloudApiError('run', 'access_token', 0, 'NO_TOKEN');
    }
    if (typeof value !== 'string' || value.length === 0)
      throw new CloudApiError('run', 'access_token', 0, 'NO_TOKEN');
    return value;
  }
}

/** Falha de uma chamada REST. `status` 0 é falha de rede, prazo vencido ou resposta acima do teto. */
export class CloudApiError extends Error {
  constructor(
    readonly service: CloudService,
    readonly operation: string,
    readonly status: number,
    /** Código curto da API, quando a resposta o tem num formato conhecido; nunca a mensagem. */
    readonly reason?: string,
  ) {
    super(
      `${service} ${operation}: ${status === 0 ? 'sem resposta' : `HTTP ${status}`}${reason === undefined ? '' : ` (${reason})`}`,
    );
    this.name = 'CloudApiError';
  }

  /** Vale tentar de novo: rede, prazo, 408, 429 e 5xx. */
  get retryable(): boolean {
    return isRetryableStatus(this.status);
  }

  /** Credencial recusada ou sem permissão: configuração, não vai melhorar sozinho. */
  get denied(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

export interface CloudRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  /** O valor inteiro do cabeçalho `Authorization` (`Bearer ...`). */
  authorization?: string;
  /** Objeto: vai como JSON. Bytes: vão como estão, com `contentType`. */
  json?: unknown;
  bytes?: Uint8Array;
  contentType?: string;
  /** Teto do corpo da resposta (padrão 1 MiB). */
  maxResponseBytes?: number;
  timeoutMs?: number;
}

export interface CloudResponse {
  status: number;
  headers: Headers;
  body: Buffer;
}

export const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ERROR_BYTES = 16 * 1024;

const GOOGLE_STATUS_PATTERN = /^[A-Z][A-Z_]{1,40}$/;
const CLOUDFLARE_CODE_PATTERN = /^[0-9]{1,6}$/;

/** O código curto do erro na resposta (Google: `error.status`; Cloudflare: `errors[0].code`), sem mensagem. */
export function errorReasonOf(body: Buffer): string | undefined {
  const parsed = tryParseJson(body);
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const googleStatus = (parsed as { error?: { status?: unknown } }).error?.status;
  if (typeof googleStatus === 'string' && GOOGLE_STATUS_PATTERN.test(googleStatus)) return googleStatus;
  const errors = (parsed as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const raw = (errors[0] as { code?: unknown } | null)?.code;
    const code = typeof raw === 'number' || typeof raw === 'string' ? String(raw) : '';
    if (CLOUDFLARE_CODE_PATTERN.test(code)) return `cf_${code}`;
  }
  return undefined;
}

export function tryParseJson(body: Buffer): unknown {
  if (body.length === 0) return undefined;
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<Buffer | undefined> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    return undefined;
  }
  if (response.body === null) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    const piece = Buffer.from(chunk as Uint8Array);
    total += piece.length;
    if (total > maxBytes) return undefined;
    chunks.push(piece);
  }
  return Buffer.concat(chunks);
}

/**
 * Uma chamada. Devolve qualquer status (quem chama decide o que é esperado: 404 e 409 muitas vezes são); só falha de
 * rede, prazo e resposta acima do teto viram `CloudApiError` aqui, com status 0.
 */
export async function cloudRequest(
  fetchFn: typeof fetch,
  service: CloudService,
  operation: string,
  request: CloudRequest,
): Promise<CloudResponse> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (request.authorization !== undefined) headers.Authorization = request.authorization;
  let body: string | Uint8Array | undefined;
  if (request.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(request.json);
  } else if (request.bytes !== undefined) {
    headers['Content-Type'] = request.contentType ?? 'application/octet-stream';
    body = request.bytes;
  }
  let response: Response;
  try {
    response = await fetchFn(request.url, {
      method: request.method,
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch {
    // A mensagem do fetch pode trazer a URL inteira; fica só o fato.
    throw new CloudApiError(service, operation, 0);
  }
  const success = response.status >= 200 && response.status < 300;
  let read: Buffer | undefined;
  try {
    // O teto pedido vale para a resposta de sucesso; de um erro só se lê o código curto, até 16 KiB.
    read = await readCapped(
      response,
      success ? (request.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES) : MAX_ERROR_BYTES,
    );
  } catch {
    throw new CloudApiError(service, operation, 0);
  }
  if (read === undefined) {
    if (success) throw new CloudApiError(service, operation, 0, 'RESPONSE_TOO_LARGE');
    read = Buffer.alloc(0);
  }
  return { status: response.status, headers: response.headers, body: read };
}

/** A resposta 2xx, ou `CloudApiError` com o status e o código curto. */
export function expectOk(service: CloudService, operation: string, response: CloudResponse): CloudResponse {
  if (response.status >= 200 && response.status < 300) return response;
  throw new CloudApiError(service, operation, response.status, errorReasonOf(response.body));
}

/** O corpo JSON de uma resposta 2xx; corpo que não é JSON vira erro (status da resposta, `INVALID_RESPONSE`). */
export function jsonOf(service: CloudService, operation: string, response: CloudResponse): unknown {
  const parsed = tryParseJson(response.body);
  if (parsed === undefined) throw new CloudApiError(service, operation, response.status, 'INVALID_RESPONSE');
  return parsed;
}

/** Resposta fora do formato esperado (o schema zod não passou): repetível (pode ser transitório) e sem o corpo. */
export function invalidResponse(service: CloudService, operation: string): CloudApiError {
  return new CloudApiError(service, operation, 502, 'INVALID_RESPONSE');
}

/** A URL de uma API do Google com o token da conta do serviço. */
export async function bearer(tokens: AccessTokenSource): Promise<string> {
  return `Bearer ${await tokens.token()}`;
}
