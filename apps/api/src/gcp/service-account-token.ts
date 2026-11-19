import { createSign } from 'node:crypto';
import { z } from 'zod';
import { forgetLiveSecret, registerLiveSecret } from '../common/logger/sanitize.js';
import type { GcpServiceAccountKey } from '../credentials/credential-vault.js';
import type { AccessTokenProvider } from './pubsub.client.js';

/**
 * Token de acesso do Google para a conta de serviço de leitura do cliente, com a chave dela (só na VM própria do
 * cliente, `NODE_PLATFORM=vm`, onde não há a identidade da VM). É o fluxo de conta de serviço do OAuth 2.0 (RFC 7523):
 * um JWT assinado com a chave privada (RS256) e trocado no endpoint de token do Google por um token de 1 hora, só com o
 * escopo do Pub/Sub. Sem biblioteca do Google, como a leitura do Pub/Sub (`pubsub.client.ts`).
 *
 * - O endereço é fixo (`oauth2.googleapis.com`): o `token_uri` do arquivo da chave nunca chega ao nó, e só os testes
 *   apontam para um servidor falso em 127.0.0.1.
 * - O JWT e o token nunca vão para log nem erro: o token fica registrado como segredo vivo enquanto vale, e os erros
 *   levam só o código (`GoogleTokenError`).
 */

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Só o Pub/Sub: a conta de serviço só tem `roles/pubsub.subscriber` na assinatura, e o token não pede mais que isso. */
export const PUBSUB_SCOPE = 'https://www.googleapis.com/auth/pubsub';
const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
/** O JWT vale 1 hora (o máximo do Google); o token também. */
const ASSERTION_SECONDS = 3600;
/** Renova com folga, um minuto antes de vencer (como o token da VM). */
const TOKEN_MARGIN_MS = 60_000;
export const GOOGLE_TOKEN_TIMEOUT_MS = 5_000;

const tokenResponseSchema = z.object({
  access_token: z.string().min(16).max(4096),
  expires_in: z.number().int().min(60).max(86_400),
});
const errorResponseSchema = z.object({ error: z.string().max(64) });

/**
 * Por que o Google não deu o token. `rejected`: a chave foi recusada (apagada, desativada, conta de serviço apagada ou
 * desativada: `invalid_grant`, `invalid_client`, `unauthorized_client`); senão, uma falha que pode passar (`timeout`,
 * `network`, `bad_response`, `http_<status>`).
 */
export class GoogleTokenError extends Error {
  constructor(
    readonly code: string,
    readonly rejected: boolean,
    readonly status?: number,
  ) {
    super(`token do Google: ${code}`);
    this.name = 'GoogleTokenError';
  }
}

const REJECTED_ERRORS = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);

/** Só o endereço oficial ou, nos testes, um servidor falso em 127.0.0.1 por http. */
export function isAllowedTokenUrl(url: string): boolean {
  if (url === GOOGLE_TOKEN_URL) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

/** O JWT da conta de serviço para o endpoint de token: assinado com a chave dela, com o ID da chave no cabeçalho. */
export function serviceAccountAssertion(key: GcpServiceAccountKey, audience: string, now: Date): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: key.privateKeyId }));
  const claims = base64url(
    JSON.stringify({
      iss: key.clientEmail,
      scope: PUBSUB_SCOPE,
      aud: audience,
      iat: issuedAt,
      exp: issuedAt + ASSERTION_SECONDS,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${signer.sign(key.privateKey()).toString('base64url')}`;
}

export interface ServiceAccountTokenOptions {
  /** Só para os testes (servidor falso em 127.0.0.1); fora deles, o endereço oficial. */
  url?: string;
  timeoutMs?: number;
  now?: () => Date;
}

/** O token de 1 hora da conta de serviço, guardado até 1 minuto antes de vencer. */
export class ServiceAccountTokenProvider implements AccessTokenProvider {
  readonly #key: GcpServiceAccountKey;
  readonly #url: string;
  readonly #timeoutMs: number;
  readonly #now: () => Date;
  #cached: { value: string; until: number } | null = null;

  constructor(
    key: GcpServiceAccountKey,
    {
      url = GOOGLE_TOKEN_URL,
      timeoutMs = GOOGLE_TOKEN_TIMEOUT_MS,
      now = () => new Date(),
    }: ServiceAccountTokenOptions = {},
  ) {
    if (!isAllowedTokenUrl(url)) throw new Error('endereço do token do Google fora da lista');
    this.#key = key;
    this.#url = url;
    this.#timeoutMs = timeoutMs;
    this.#now = now;
  }

  async token(): Promise<string> {
    const now = this.#now();
    if (this.#cached && now.getTime() < this.#cached.until) return this.#cached.value;
    let response: Response;
    try {
      response = await fetch(this.#url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: JWT_BEARER,
          assertion: serviceAccountAssertion(this.#key, GOOGLE_TOKEN_URL, now),
        }).toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: unknown } | null)?.name;
      throw new GoogleTokenError(name === 'TimeoutError' ? 'timeout' : 'network', false);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      // Só o código do OAuth (`invalid_grant`), nunca a descrição, que pode citar a conta.
      const parsed = errorResponseSchema.safeParse(body);
      const code = parsed.success && REJECTED_ERRORS.has(parsed.data.error) ? parsed.data.error : null;
      if (code !== null && response.status >= 400 && response.status < 500) {
        throw new GoogleTokenError(code, true, response.status);
      }
      throw new GoogleTokenError(`http_${response.status}`, false, response.status);
    }
    const parsed = tokenResponseSchema.safeParse(body);
    if (!parsed.success) throw new GoogleTokenError('bad_response', false, response.status);
    if (this.#cached) forgetLiveSecret(this.#cached.value);
    registerLiveSecret(parsed.data.access_token);
    this.#cached = {
      value: parsed.data.access_token,
      until: now.getTime() + Math.max(0, parsed.data.expires_in * 1000 - TOKEN_MARGIN_MS),
    };
    return parsed.data.access_token;
  }

  /** O token guardado deixa de ser segredo vivo (a chave saiu do cofre ou foi trocada). */
  release(): void {
    if (this.#cached) forgetLiveSecret(this.#cached.value);
    this.#cached = null;
  }
}
