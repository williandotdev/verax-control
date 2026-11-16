import { createHash, createPrivateKey, createPublicKey, type KeyObject, sign } from 'node:crypto';
import {
  SSO_ALG,
  type SsoIdTokenClaims,
  type SsoIdTokenHeader,
  type SsoJwk,
  ssoThumbprintInput,
} from '@verax/shared';

/**
 * A chave de assinatura da entrada única no SIEM (`cp-admin-sso-signing-key`): Ed25519, em PEM (PKCS #8). Só o
 * cp-admin a lê; a célula tem só a parte pública, fixada na configuração do nó (`SSO_PUBLIC_KEY`, o `x` abaixo).
 *
 * O token é um JWS compacto montado aqui, sem biblioteca de JOSE (nenhuma dependência nova): o cabeçalho é sempre o
 * mesmo (`alg: EdDSA`, `typ: JWT` e o `kid`), e a assinatura é a do `node:crypto` (Ed25519 é determinística: nada de
 * nonce a errar, como no ECDSA).
 */
export interface SsoSigningKey {
  privateKey: KeyObject;
  /** A chave pública como sai no JWKS e como o nó a fixa. */
  jwk: SsoJwk;
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

/** O `kid`: a impressão digital RFC 7638 da chave pública (SHA-256 em base64url). */
export function ssoKeyId(x: string): string {
  return createHash('sha256').update(ssoThumbprintInput(x), 'utf8').digest('base64url');
}

/**
 * Lê o PEM do cofre. Qualquer coisa que não seja uma chave privada Ed25519 (outra curva, RSA, uma chave pública, texto
 * solto) devolve `undefined`, e a entrada única responde indisponível: nunca assina com outro algoritmo.
 */
export function parseSsoSigningKey(pem: string): SsoSigningKey | undefined {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    return undefined;
  }
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') return undefined;
  const exported = createPublicKey(privateKey).export({ format: 'jwk' });
  const x = typeof exported.x === 'string' ? exported.x : undefined;
  if (x === undefined) return undefined;
  return {
    privateKey,
    jwk: { kty: 'OKP', crv: 'Ed25519', x, kid: ssoKeyId(x), alg: SSO_ALG, use: 'sig' },
  };
}

/** O token de identidade assinado (JWS compacto: cabeçalho, declarações e assinatura, em base64url). */
export function signIdToken(key: SsoSigningKey, claims: SsoIdTokenClaims): string {
  const header: SsoIdTokenHeader = { alg: SSO_ALG, typ: 'JWT', kid: key.jwk.kid };
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = sign(null, Buffer.from(input, 'ascii'), key.privateKey);
  return `${input}.${base64url(signature)}`;
}
