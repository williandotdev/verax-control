import { CLOUDFLARE_OAUTH_REVOKE_URL, CLOUDFLARE_OAUTH_TOKEN_URL } from '@verax/shared';
import { CLOUDFLARE_OAUTH_TOKEN_MAX_LENGTH } from '@verax/vault-envelope';
import { z } from 'zod';
import { CloudflareApiError, readBounded, retryAfterMs } from '../cloudflare.client.js';

/**
 * Os tokens do Cloudflare por OAuth, do lado do worker do nó: a renovação, que o coletor usa (CF-3), e a troca do código
 * e a revogação, da tarefa `cloudflare-oauth` (CF-4).
 *
 * Um modo só existe hoje: `PublicClientTokens`, o app sem segredo (método `none`), em que o nó fala direto com o
 * Cloudflare. Se o Cloudflare não renovar um app assim, outra implementação destas interfaces pede ao plano de controle,
 * sem mudar o coletor nem o banco.
 */

/** O que a renovação devolve. */
export interface RefreshedTokens {
  accessToken: string;
  /** O token de renovação novo, quando o Cloudflare o troca a cada uso; null quando o guardado continua valendo. */
  refreshToken: string | null;
  expiresInSeconds: number;
  /** Os escopos concedidos, quando a resposta os repete. */
  scope: string | null;
}

export interface CloudflareOAuthTokens {
  /**
   * Uma renovação. Nunca é repetida aqui dentro: com a troca a cada uso, um segundo envio do mesmo token pode derrubar a
   * autorização inteira. Também não recebe o sinal da parada do worker: interrompida no meio, o token novo se perderia.
   */
  refresh(clientId: string, refreshToken: string): Promise<RefreshedTokens>;
}

/** O pedido da troca do código: o app e o retorno são os da tentativa, os mesmos da URL de autorização. */
export interface CodeExchange {
  clientId: string;
  redirectUri: string;
  code: string;
  verifier: string;
}

export type ExchangedTokens =
  | ({ kind: 'tokens' } & RefreshedTokens)
  /** O Cloudflare autorizou, mas a resposta não serve (fora do formato): o token que der para revogar, ou null. */
  | { kind: 'unusable'; token: string | null };

/** O que conecta e desconecta: só a tarefa `cloudflare-oauth` usa. */
export interface CloudflareOAuthConnection {
  /** Uma troca. O código vale uma vez: quem chama decide se tenta de novo. */
  exchange(request: CodeExchange): Promise<ExchangedTokens>;
  /** Revoga o token (e, com ele, a autorização dele). O token que já não vale é sucesso (RFC 7009). */
  revoke(clientId: string, token: string): Promise<void>;
}

/** Por que a chamada falhou, e o que fazer. */
export type OAuthFailure =
  /** A autorização acabou (`invalid_grant`): só o cliente conectando de novo. */
  | 'grant_rejected'
  /** O Cloudflare recusou o app ou os escopos: não depende do cliente. */
  | 'client_rejected'
  /** Passageira: limite de requisições, 5xx, rede, tempo esgotado, resposta fora do formato. */
  | 'unavailable';

/** Só um código, nunca a mensagem do Cloudflare (que pode repetir o token). O nome do erro é o código. */
export class CloudflareOAuthError extends Error {
  constructor(
    readonly failure: OAuthFailure,
    readonly code: string,
    /** O pedido pode ter sido atendido mesmo assim (o token de renovação enviado pode já não valer). */
    readonly ambiguous: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(`OAuth do Cloudflare: ${code}`);
    this.name = code;
  }
}

/** A validade quando a resposta não a informa: curta, para o acesso ser renovado cedo. */
const UNKNOWN_EXPIRES_IN_SECONDS = 600;
const MAX_EXPIRES_IN_SECONDS = 366 * 24 * 60 * 60;

/** O alfabeto do Bearer, o mesmo do envelope (`@verax/vault-envelope`): nada que mude o header. */
const tokenSchema = z
  .string()
  .min(16)
  .max(CLOUDFLARE_OAUTH_TOKEN_MAX_LENGTH)
  .regex(/^[A-Za-z0-9._~+/=-]+$/);

/**
 * A resposta da renovação, só o que é usado. A validade fora do formato não recusa a resposta: o token de renovação novo
 * já vale, e jogá-lo fora perderia a autorização.
 */
const refreshResponseSchema = z.object({
  access_token: tokenSchema,
  token_type: z.string().refine((value) => value.toLowerCase() === 'bearer'),
  refresh_token: tokenSchema.nullish(),
  expires_in: z.number().int().min(1).max(MAX_EXPIRES_IN_SECONDS).catch(UNKNOWN_EXPIRES_IN_SECONDS),
  scope: z.string().max(2048).nullish(),
});

const errorResponseSchema = z.object({ error: z.string().max(64) });

/** Os tokens de uma resposta fora do formato, só para revogar: sem limite de alfabeto, com teto de tamanho. */
const leftoverSchema = z.object({
  access_token: z.string().min(1).max(32_768).optional().catch(undefined),
  refresh_token: z.string().min(1).max(32_768).optional().catch(undefined),
});

/** O token que revoga mais: o da renovação, se veio, ou o de acesso. */
function leftoverToken(json: unknown): string | null {
  const parsed = leftoverSchema.safeParse(json);
  if (!parsed.success) return null;
  return parsed.data.refresh_token ?? parsed.data.access_token ?? null;
}

/** Os erros do OAuth que são do app registrado pela Verax, e não da autorização do cliente. */
const CLIENT_ERRORS: ReadonlySet<string> = new Set([
  'invalid_client',
  'unauthorized_client',
  'invalid_scope',
  'invalid_request',
  'unsupported_grant_type',
]);

/**
 * Tempo limite de cada chamada, do envio ao fim do corpo. Cabe na parada do contêiner do worker (10 s), que não interrompe
 * a renovação, com folga para gravar o resultado.
 */
export const OAUTH_REFRESH_TIMEOUT_MS = 6_000;
/** Dois tokens de até 4096 caracteres cabem com folga. */
const MAX_BODY_BYTES = 64 * 1024;

/** Só o endereço oficial ou, nos testes, um servidor falso em 127.0.0.1 por http. */
function isAllowedUrl(value: string, official: string): boolean {
  if (value === official) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

export interface PublicClientTokensOptions {
  /** Só para os testes (servidor falso em 127.0.0.1); fora deles, os endereços oficiais. */
  tokenUrl?: string;
  revokeUrl?: string;
  timeoutMs?: number;
}

/** O que chegou: o status, o corpo já lido (até o teto) e a espera pedida. */
interface OAuthReply {
  status: number;
  json: unknown;
  retryAfterMs: number | undefined;
}

/**
 * O app sem segredo. Os endereços são fixos no código (não vêm do documento de descoberta nem da configuração), sem
 * seguir redirecionamento; o corpo tem teto, e o de um erro só é lido para achar o código do OAuth, por lista fechada.
 * Nenhuma chamada é repetida aqui dentro nem recebe o sinal da parada do worker.
 */
export class PublicClientTokens implements CloudflareOAuthTokens, CloudflareOAuthConnection {
  readonly #tokenUrl: string;
  readonly #revokeUrl: string;
  readonly #timeoutMs: number;

  constructor({
    tokenUrl = CLOUDFLARE_OAUTH_TOKEN_URL,
    revokeUrl = CLOUDFLARE_OAUTH_REVOKE_URL,
    timeoutMs = OAUTH_REFRESH_TIMEOUT_MS,
  }: PublicClientTokensOptions = {}) {
    if (
      !isAllowedUrl(tokenUrl, CLOUDFLARE_OAUTH_TOKEN_URL) ||
      !isAllowedUrl(revokeUrl, CLOUDFLARE_OAUTH_REVOKE_URL)
    ) {
      throw new Error(
        'o OAuth do Cloudflare só é chamado no endereço oficial (ou num servidor falso local, nos testes)',
      );
    }
    this.#tokenUrl = tokenUrl;
    this.#revokeUrl = revokeUrl;
    this.#timeoutMs = timeoutMs;
  }

  async refresh(clientId: string, refreshToken: string): Promise<RefreshedTokens> {
    const reply = await this.post(this.#tokenUrl, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    });
    if (reply.status !== 200) throw failureOf(reply);
    const tokens = tokensOf(reply.json);
    if (tokens === null) throw new CloudflareOAuthError('unavailable', 'bad_response', true);
    return tokens;
  }

  async exchange({ clientId, redirectUri, code, verifier }: CodeExchange): Promise<ExchangedTokens> {
    const reply = await this.post(this.#tokenUrl, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    });
    if (reply.status !== 200) throw failureOf(reply);
    const tokens = tokensOf(reply.json);
    return tokens === null
      ? { kind: 'unusable', token: leftoverToken(reply.json) }
      : { kind: 'tokens', ...tokens };
  }

  async revoke(clientId: string, token: string): Promise<void> {
    const reply = await this.post(this.#revokeUrl, {
      token,
      token_type_hint: 'refresh_token',
      client_id: clientId,
    });
    if (reply.status !== 200 && reply.status !== 204) throw failureOf(reply);
  }

  private async post(url: string, form: Record<string, string>): Promise<OAuthReply> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
        redirect: 'error',
        signal: timeout,
      });
      const { text } = await readBounded(response, MAX_BODY_BYTES);
      return {
        status: response.status,
        json: parseJson(text),
        retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
      };
    } catch (error) {
      if (error instanceof CloudflareApiError) {
        throw new CloudflareOAuthError('unavailable', error.code, true);
      }
      throw new CloudflareOAuthError('unavailable', timeout.aborted ? 'timeout' : 'network', true);
    }
  }
}

function tokensOf(json: unknown): RefreshedTokens | null {
  const parsed = refreshResponseSchema.safeParse(json);
  if (!parsed.success) return null;
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? null,
    expiresInSeconds: parsed.data.expires_in,
    scope: parsed.data.scope ?? null,
  };
}

function failureOf({ status, json, retryAfterMs: wait }: OAuthReply): CloudflareOAuthError {
  if (status === 429) return new CloudflareOAuthError('unavailable', 'rate_limited', false, wait);
  if (status === 400 || status === 401) {
    const parsed = errorResponseSchema.safeParse(json);
    const code = parsed.success ? parsed.data.error : null;
    if (code === 'invalid_grant') return new CloudflareOAuthError('grant_rejected', code, false);
    if (code !== null && CLIENT_ERRORS.has(code)) {
      return new CloudflareOAuthError('client_rejected', code, false);
    }
  }
  // Um erro que o OAuth não explica (a página de um bloqueio no caminho, um 5xx): nada prova que a autorização acabou.
  return new CloudflareOAuthError('unavailable', `http_${status}`, status >= 500);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
