import { createHash, type KeyObject, timingSafeEqual, verify } from 'node:crypto';
import {
  SSO_AMR,
  SSO_CLOCK_SKEW_SECONDS,
  SSO_ID_TOKEN_MAX_LENGTH,
  SSO_ID_TOKEN_TTL_SECONDS,
  type SsoIdTokenClaims,
  ssoIdTokenClaimsSchema,
  ssoIdTokenHeaderSchema,
} from '@verax/shared';

/**
 * Conferência do token de identidade da entrada única (`docs/ARQUITETURA.md`, "Entrada única"), escrita à mão com
 * `node:crypto` e sem biblioteca de JOSE (nenhuma dependência nova), e por isso estrita em tudo:
 *
 * - o texto: até 4 KB, exatamente três partes em base64url (sem preenchimento, sem espaço, sem ponto a mais), e a
 *   assinatura com os 64 bytes de uma Ed25519;
 * - o cabeçalho: exatamente `{alg: "EdDSA", typ: "JWT", kid}` (nada de `none`, HS256, `jku`, `jwk`, `x5u` ou `crit`), e
 *   o `kid` precisa ser o da chave FIXADA na configuração. A chave nunca vem do token nem da rede;
 * - a assinatura: conferida com a chave pública Ed25519 fixada, e só com ela (o `verify` do Node com uma chave do tipo
 *   `ed25519` não aceita outro algoritmo, nem um HMAC com a chave pública como segredo);
 * - as declarações: objeto estrito (campo a mais recusa), `iss` igual à origem do console, `aud` igual ao cliente (texto,
 *   nunca lista), prazo vigente com 30 s de folga, `iat` no passado, validade de no máximo 5 min, `auth_time` antes do
 *   `iat`, o `nonce` do pedido e `amr` com senha e código de uso único.
 *
 * O `jti` de uso único é conferido por quem chama, no banco (`SsoTokenUse`): aqui só o formato.
 */

export interface IdTokenExpectations {
  publicKey: KeyObject;
  keyId: string;
  issuer: string;
  audience: string;
  nonce: string;
  now: Date;
}

/** Por que um token foi recusado (vai ao log e à auditoria; a pessoa vê só a recusa genérica). */
export type IdTokenRefusal =
  | 'malformed'
  | 'bad_header'
  | 'unknown_key'
  | 'bad_signature'
  | 'bad_claims'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'expired'
  | 'not_yet_valid'
  | 'too_long_lived'
  | 'wrong_nonce'
  | 'weak_authentication';

export type IdTokenResult = { ok: true; claims: SsoIdTokenClaims } | { ok: false; reason: IdTokenRefusal };

const BASE64URL_PART = /^[A-Za-z0-9_-]+$/;
const ED25519_SIGNATURE_BYTES = 64;

function decodePart(part: string): Buffer | undefined {
  if (!BASE64URL_PART.test(part)) return undefined;
  const bytes = Buffer.from(part, 'base64url');
  // Ida e volta: um texto que o Node decodifica "com folga" (bits sobrando no fim) não passa.
  return bytes.toString('base64url') === part ? bytes : undefined;
}

function parseJsonObject(bytes: Buffer): unknown {
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Comparação em tempo constante de dois textos (pelos SHA-256, que têm o mesmo tamanho). */
export function sameSecret(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

/** A assinatura Ed25519 sobre o texto assinado, com a chave fixada; qualquer erro do Node conta como inválida. */
function signatureValid(input: string, signature: Buffer, publicKey: KeyObject): boolean {
  try {
    return verify(null, Buffer.from(input, 'ascii'), publicKey, signature);
  } catch {
    return false;
  }
}

export function verifyIdToken(token: string, expected: IdTokenExpectations): IdTokenResult {
  if (typeof token !== 'string' || token.length === 0 || token.length > SSO_ID_TOKEN_MAX_LENGTH) {
    return { ok: false, reason: 'malformed' };
  }
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [headerPart = '', payloadPart = '', signaturePart = ''] = parts;
  const headerBytes = decodePart(headerPart);
  const payloadBytes = decodePart(payloadPart);
  const signature = decodePart(signaturePart);
  if (headerBytes === undefined || payloadBytes === undefined || signature === undefined) {
    return { ok: false, reason: 'malformed' };
  }

  const header = ssoIdTokenHeaderSchema.safeParse(parseJsonObject(headerBytes));
  if (!header.success) return { ok: false, reason: 'bad_header' };
  if (!sameSecret(header.data.kid, expected.keyId)) return { ok: false, reason: 'unknown_key' };

  if (signature.length !== ED25519_SIGNATURE_BYTES) return { ok: false, reason: 'bad_signature' };
  if (expected.publicKey.asymmetricKeyType !== 'ed25519') return { ok: false, reason: 'bad_signature' };
  if (!signatureValid(`${headerPart}.${payloadPart}`, signature, expected.publicKey)) {
    return { ok: false, reason: 'bad_signature' };
  }

  const parsed = ssoIdTokenClaimsSchema.safeParse(parseJsonObject(payloadBytes));
  if (!parsed.success) return { ok: false, reason: 'bad_claims' };
  const claims = parsed.data;
  if (claims.iss !== expected.issuer) return { ok: false, reason: 'wrong_issuer' };
  if (claims.aud !== expected.audience) return { ok: false, reason: 'wrong_audience' };

  const now = Math.floor(expected.now.getTime() / 1000);
  if (claims.exp + SSO_CLOCK_SKEW_SECONDS <= now) return { ok: false, reason: 'expired' };
  if (claims.iat - SSO_CLOCK_SKEW_SECONDS > now) return { ok: false, reason: 'not_yet_valid' };
  if (claims.exp <= claims.iat || claims.exp - claims.iat > SSO_ID_TOKEN_TTL_SECONDS) {
    return { ok: false, reason: 'too_long_lived' };
  }
  if (claims.auth_time > claims.iat + SSO_CLOCK_SKEW_SECONDS) return { ok: false, reason: 'bad_claims' };
  if (!sameSecret(claims.nonce, expected.nonce)) return { ok: false, reason: 'wrong_nonce' };
  if (!SSO_AMR.every((method) => claims.amr.includes(method))) {
    return { ok: false, reason: 'weak_authentication' };
  }
  return { ok: true, claims };
}
