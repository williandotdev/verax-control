import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import type { Clock } from '../common/clock.js';

/**
 * O token de identidade do Google que chega ao cp-worker, e de qual cabeçalho ele deve sair.
 *
 * O Cloud Run aceita o token em dois cabeçalhos e confere, na entrada (IAM com `run.invoker`), só um deles: "If you
 * provide both headers, only the `X-Serverless-Authorization` header is checked", e, nesse cabeçalho, "This removes
 * the signature before passing the token to the user container" (seção "Acquire and configure the ID token" de
 * https://docs.cloud.google.com/run/docs/authenticating/service-to-service). No `Authorization` a documentação não fala
 * em remoção, e os exemplos de "Receive authenticated requests" conferem o token de novo no serviço que recebe.
 *
 * Daí a regra, a única em que a identidade usada pelo app é sempre a que o Cloud Run conferiu:
 * - os dois cabeçalhos juntos são recusados (senão um chamador com `run.invoker` mandaria o próprio token verdadeiro no
 *   `X-Serverless-Authorization` e um token forjado, com o e-mail de outro grupo, no `Authorization`);
 * - com um só, a identidade sai dele;
 * - assinatura presente é conferida aqui de novo, com as chaves públicas do Google (`google-auth-library`), o emissor,
 *   a audiência e os prazos: defesa em profundidade, caso a entrada do serviço deixe passar algo;
 * - assinatura removida só é aceita no `X-Serverless-Authorization`, onde a documentação diz que o Cloud Run a remove
 *   depois de conferi-la; no `Authorization`, um token sem assinatura é recusado.
 */
export const SERVERLESS_AUTHORIZATION_HEADER = 'x-serverless-authorization';
export type CredentialHeader = 'authorization' | typeof SERVERLESS_AUTHORIZATION_HEADER;

export type CredentialSelection =
  | { kind: 'missing' }
  /** Os dois cabeçalhos: recusado; `value` é o que o Cloud Run conferiu, só para o teste ver a escolha. */
  | { kind: 'ambiguous'; header: CredentialHeader; value: string }
  | { kind: 'single'; header: CredentialHeader; value: string };

function single(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(',') : value;
}

/** O cabeçalho que o Cloud Run conferiu: o `X-Serverless-Authorization` quando houver, senão o `Authorization`. */
export function selectValidatedCredential(
  headers: Record<string, string | string[] | undefined>,
): CredentialSelection {
  const serverless = single(headers[SERVERLESS_AUTHORIZATION_HEADER]);
  const authorization = single(headers['authorization']);
  if (serverless !== undefined && authorization !== undefined) {
    return { kind: 'ambiguous', header: SERVERLESS_AUTHORIZATION_HEADER, value: serverless };
  }
  if (serverless !== undefined)
    return { kind: 'single', header: SERVERLESS_AUTHORIZATION_HEADER, value: serverless };
  if (authorization !== undefined) return { kind: 'single', header: 'authorization', value: authorization };
  return { kind: 'missing' };
}

/** Emissores dos tokens de identidade do Google. */
export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'] as const;
/** O que marca a assinatura removida pelo Google na terceira parte do JWT. */
export const SIGNATURE_REMOVED = 'SIGNATURE_REMOVED_BY_GOOGLE';

const identityClaimsSchema = z.object({
  iss: z.enum(GOOGLE_ISSUERS),
  aud: z.string().max(512),
  email: z.string().min(3).max(254),
  email_verified: z.literal(true),
  exp: z.number().int().positive(),
});
export type IdentityClaims = z.infer<typeof identityClaimsSchema>;

/** Um token de identidade tem por volta de 1 KB; acima disto nem se tenta decodificar. */
const MAX_CREDENTIAL_LENGTH = 4096;

/** Só letras, números, `-` e `_` (base64url sem preenchimento), sem regex sobre a entrada. */
function isBase64Url(value: string): boolean {
  if (value.length === 0) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const alphanumeric =
      (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
    if (!alphanumeric && code !== 0x2d && code !== 0x5f) return false;
  }
  return true;
}

function decodeSegment(segment: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Chaves públicas dos tokens de identidade do Google, por `kid` (PEM). */
export interface IdTokenKeySource {
  /** As chaves conhecidas; `refresh` pede releitura (um `kid` novo depois de uma rotação de chave). */
  keys(refresh?: boolean): Promise<Readonly<Record<string, string>>>;
}

export const ID_TOKEN_KEY_SOURCE = Symbol('ID_TOKEN_KEY_SOURCE');

const KEYS_CACHE_MS = 60 * 60_000;
const KEYS_MIN_REFRESH_MS = 60_000;

/**
 * As chaves do Google (`getFederatedSignonCertsAsync` da biblioteca: os certificados de
 * `https://www.googleapis.com/oauth2/v1/certs`), em cache por 1 h. Só em produção: os testes injetam um
 * `IdTokenKeySource` com uma chave RSA gerada no teste.
 */
export class GoogleIdTokenKeySource implements IdTokenKeySource {
  private cached: { keys: Readonly<Record<string, string>>; at: number } | undefined;
  private readonly client = new OAuth2Client();

  constructor(private readonly clock: Clock) {}

  async keys(refresh = false): Promise<Readonly<Record<string, string>>> {
    const now = this.clock.now().getTime();
    const maxAge = refresh ? KEYS_MIN_REFRESH_MS : KEYS_CACHE_MS;
    if (this.cached !== undefined && now - this.cached.at < maxAge) return this.cached.keys;
    const { certs } = await this.client.getFederatedSignonCertsAsync();
    const keys: Record<string, string> = {};
    for (const [kid, value] of Object.entries(certs)) if (typeof value === 'string') keys[kid] = value;
    this.cached = { keys, at: now };
    return keys;
  }
}

export type IdentityFailure =
  'malformed' | 'signature_missing' | 'algorithm' | 'unknown_key' | 'keys_unavailable' | 'invalid' | 'claims';

export type IdentityVerification =
  { ok: true; claims: IdentityClaims } | { ok: false; reason: IdentityFailure };

function normalizeAudience(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/**
 * Confere o token do cabeçalho escolhido (`selectValidatedCredential`). As mensagens de erro da biblioteca repetem o
 * token inteiro: nada delas sai daqui, só o motivo.
 */
export class IdentityTokenVerifier {
  private readonly client = new OAuth2Client();

  constructor(
    private readonly keySource: IdTokenKeySource,
    private readonly clock: Clock,
  ) {}

  async verify(header: CredentialHeader, value: string, audience: string): Promise<IdentityVerification> {
    if (value.length > MAX_CREDENTIAL_LENGTH) return { ok: false, reason: 'malformed' };
    const [scheme, jwt, ...rest] = value.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || jwt === undefined || rest.length > 0) {
      return { ok: false, reason: 'malformed' };
    }
    const parts = jwt.split('.');
    const [encodedHeader = '', encodedPayload = '', signature = ''] = parts;
    if (parts.length < 2 || parts.length > 3 || !isBase64Url(encodedHeader) || !isBase64Url(encodedPayload)) {
      return { ok: false, reason: 'malformed' };
    }
    const jose = decodeSegment(encodedHeader);
    const payload = decodeSegment(encodedPayload);
    if (jose === undefined || payload === undefined) return { ok: false, reason: 'malformed' };

    const removed = parts.length === 2 || signature === '' || signature === SIGNATURE_REMOVED;
    if (removed) {
      // Só onde o Cloud Run remove a assinatura depois de conferi-la (ver o comentário do arquivo).
      if (header !== SERVERLESS_AUTHORIZATION_HEADER) return { ok: false, reason: 'signature_missing' };
      return this.checkClaims(payload, audience, true);
    }
    if (!isBase64Url(signature)) return { ok: false, reason: 'malformed' };
    if (jose['alg'] !== 'RS256') return { ok: false, reason: 'algorithm' };
    const kid = jose['kid'];
    if (typeof kid !== 'string' || kid === '') return { ok: false, reason: 'malformed' };

    let keys: Readonly<Record<string, string>>;
    try {
      keys = await this.keySource.keys();
      if (!Object.hasOwn(keys, kid)) keys = await this.keySource.keys(true);
    } catch {
      return { ok: false, reason: 'keys_unavailable' };
    }
    if (!Object.hasOwn(keys, kid)) return { ok: false, reason: 'unknown_key' };
    try {
      // Assinatura, emissor, audiência, `iat` e `exp` (com a folga da biblioteca, pelo relógio do sistema).
      await this.client.verifySignedJwtWithCertsAsync(
        jwt,
        { ...keys },
        [normalizeAudience(audience), `${normalizeAudience(audience)}/`],
        [...GOOGLE_ISSUERS],
      );
    } catch {
      return { ok: false, reason: 'invalid' };
    }
    return this.checkClaims(payload, audience, false);
  }

  /** O formato das declarações; sem assinatura para conferir, também a audiência e o prazo (pelo relógio injetável). */
  private checkClaims(
    payload: Record<string, unknown>,
    audience: string,
    unsigned: boolean,
  ): IdentityVerification {
    const parsed = identityClaimsSchema.safeParse(payload);
    if (!parsed.success) return { ok: false, reason: 'claims' };
    if (unsigned) {
      const sameAudience = normalizeAudience(parsed.data.aud) === normalizeAudience(audience);
      if (!sameAudience || parsed.data.exp * 1000 <= this.clock.now().getTime()) {
        return { ok: false, reason: 'claims' };
      }
    }
    return { ok: true, claims: parsed.data };
  }
}
