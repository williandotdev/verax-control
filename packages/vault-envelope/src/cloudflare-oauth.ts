import { cloudflareOauthCodeSchema, cloudflareOauthVerifierSchema } from '@verax/shared';
import { z } from 'zod';
import { type EnvelopeKeySource, openEnvelopeWith, sealEnvelope } from './envelope.js';
import { CredentialVaultError } from './errors.js';
import type { EnvelopePublicKey } from './public-key.js';

/**
 * O que a conexão do Cloudflare por OAuth guarda cifrado no nó (`@verax/shared`, `cloudflare-oauth.ts`): o verificador
 * do PKCE e o código de autorização, por minutos, na tentativa; e os tokens, na concessão. A API do nó só cifra (o
 * verificador e o código); quem abre, troca e guarda os tokens é o worker.
 *
 * - O rótulo do OAEP é `verax-cfoauth:v1:<cliente>:<tentativa ou concessão>:<uso>`: o texto de um cliente, de uma
 *   tentativa ou de um uso não abre em outro. O tipo existe só aqui, na amarração: não é um `CloudCredentialKind`, que
 *   a versão anterior do nó e o plano de controle anterior recusariam.
 * - O verificador cabe no bloco do RSA (`rsaOnly`). O código e os tokens podem passar dele e usam o envelope híbrido.
 * - Quem abre os tokens registra os dois no logger como segredos vivos enquanto os usa, e os esquece ao trocar: eles
 *   mudam a cada renovação.
 */

const LABEL_PREFIX = 'verax-cfoauth:v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** O que o envelope guarda: cada uso tem o rótulo e o formato dele. */
export const CLOUDFLARE_OAUTH_SEAL_USES = ['verifier', 'code', 'tokens'] as const;
export type CloudflareOauthSealUse = (typeof CLOUDFLARE_OAUTH_SEAL_USES)[number];

/**
 * A quem pertence: o cliente no banco do nó e a linha (a tentativa, no verificador e no código; a concessão, nos
 * tokens). Montada sempre pela linha do banco, nunca por um valor do request.
 */
export interface CloudflareOauthBinding {
  readonly tenantId: string;
  readonly subjectId: string;
}

/**
 * Token do Cloudflare por OAuth: opaco ou JWT, então só o alfabeto do Bearer e um teto folgado (o formato real depende
 * do app registrado). Os dois juntos ainda passam pelo teto do envelope híbrido (`plaintext_too_large`).
 */
export const CLOUDFLARE_OAUTH_TOKEN_MAX_LENGTH = 4096;
const tokenSchema = z
  .string()
  .min(16)
  .max(CLOUDFLARE_OAUTH_TOKEN_MAX_LENGTH)
  .regex(/^[A-Za-z0-9._~+/=-]+$/);

const verifierPayloadSchema = z.strictObject({ v: cloudflareOauthVerifierSchema });
const codePayloadSchema = z.strictObject({ c: cloudflareOauthCodeSchema });
/** `a`: o de acesso; `r`: o da renovação; `x`: até quando o de acesso vale. */
const tokensPayloadSchema = z.strictObject({ a: tokenSchema, r: tokenSchema, x: z.iso.datetime() });

/** Os tokens de uma concessão. */
export interface CloudflareOauthTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAt: Date;
}

/** `verax-cfoauth:v1:<cliente>:<linha>:<uso>`, conferido parte a parte. */
export function cloudflareOauthLabel(binding: CloudflareOauthBinding, use: CloudflareOauthSealUse): Buffer {
  const { tenantId, subjectId } = binding;
  if (!UUID.test(tenantId) || !UUID.test(subjectId) || !CLOUDFLARE_OAUTH_SEAL_USES.includes(use)) {
    throw new CredentialVaultError('binding_invalid');
  }
  return Buffer.from(`${LABEL_PREFIX}:${tenantId}:${subjectId}:${use}`, 'utf8');
}

/** Cifra o texto claro já conferido; o JSON intermediário é zerado no fim. */
function sealPayload(
  publicKey: EnvelopePublicKey,
  binding: CloudflareOauthBinding,
  use: CloudflareOauthSealUse,
  schema: z.ZodType,
  payload: unknown,
): string {
  const label = cloudflareOauthLabel(binding, use);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new CredentialVaultError('secret_invalid');
  const plaintext = Buffer.from(JSON.stringify(parsed.data), 'utf8');
  try {
    return sealEnvelope(publicKey, label, plaintext, { rsaOnly: use === 'verifier' });
  } finally {
    plaintext.fill(0);
  }
}

/** Abre e confere o formato; qualquer divergência falha fechado. */
function openPayload<T>(
  keys: EnvelopeKeySource,
  binding: CloudflareOauthBinding,
  use: CloudflareOauthSealUse,
  schema: z.ZodType<T>,
  envelope: string,
): T {
  const plaintext = openEnvelopeWith(keys, envelope, () => cloudflareOauthLabel(binding, use), {
    rsaOnly: use === 'verifier',
  });
  try {
    let json: unknown;
    try {
      json = JSON.parse(plaintext.toString('utf8'));
    } catch {
      throw new CredentialVaultError('payload_invalid');
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new CredentialVaultError('payload_invalid');
    return parsed.data;
  } finally {
    plaintext.fill(0);
  }
}

/** Cifra o verificador do PKCE de uma tentativa (a API do nó, ao começar). */
export function sealCloudflareOauthVerifier(
  publicKey: EnvelopePublicKey,
  attempt: CloudflareOauthBinding,
  verifier: string,
): string {
  return sealPayload(publicKey, attempt, 'verifier', verifierPayloadSchema, { v: verifier });
}

/** Abre o verificador (só o worker). */
export function openCloudflareOauthVerifier(
  keys: EnvelopeKeySource,
  attempt: CloudflareOauthBinding,
  envelope: string,
): string {
  return openPayload(keys, attempt, 'verifier', verifierPayloadSchema, envelope).v;
}

/** Cifra o código de autorização de uma tentativa (a API do nó, ao concluir). */
export function sealCloudflareOauthCode(
  publicKey: EnvelopePublicKey,
  attempt: CloudflareOauthBinding,
  code: string,
): string {
  return sealPayload(publicKey, attempt, 'code', codePayloadSchema, { c: code });
}

/** Abre o código (só o worker). */
export function openCloudflareOauthCode(
  keys: EnvelopeKeySource,
  attempt: CloudflareOauthBinding,
  envelope: string,
): string {
  return openPayload(keys, attempt, 'code', codePayloadSchema, envelope).c;
}

/** Cifra os tokens de uma concessão (o worker, na troca, a cada renovação e na recifragem). */
export function sealCloudflareOauthTokens(
  publicKey: EnvelopePublicKey,
  grant: CloudflareOauthBinding,
  tokens: CloudflareOauthTokens,
): string {
  // Data inválida: o `toISOString` lançaria outro erro.
  if (Number.isNaN(tokens.accessExpiresAt.getTime())) throw new CredentialVaultError('secret_invalid');
  return sealPayload(publicKey, grant, 'tokens', tokensPayloadSchema, {
    a: tokens.accessToken,
    r: tokens.refreshToken,
    x: tokens.accessExpiresAt.toISOString(),
  });
}

/** Abre os tokens (só o worker). */
export function openCloudflareOauthTokens(
  keys: EnvelopeKeySource,
  grant: CloudflareOauthBinding,
  envelope: string,
): CloudflareOauthTokens {
  const { a, r, x } = openPayload(keys, grant, 'tokens', tokensPayloadSchema, envelope);
  return { accessToken: a, refreshToken: r, accessExpiresAt: new Date(x) };
}
