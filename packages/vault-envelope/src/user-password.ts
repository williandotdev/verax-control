import { createHash } from 'node:crypto';
import { userCreateSchema } from '@verax/shared';
import { z } from 'zod';
import { type EnvelopeKeySource, openEnvelopeWith, sealEnvelope } from './envelope.js';
import { CredentialVaultError } from './errors.js';
import type { EnvelopePublicKey } from './public-key.js';

/**
 * A senha temporária de um usuário que a Verax cria no nó pelo plano de controle: o plano de controle gera a senha,
 * mostra uma vez ao responsável e manda ao nó só o envelope, cifrado com a chave pública do cofre do nó. Só o worker do
 * nó abre, e a senha vira a senha temporária da conta (troca e MFA no primeiro acesso).
 *
 * - O rótulo do OAEP é `verax-user:v1:<cliente no banco do nó>:<id do pedido>:<SHA-256 do e-mail em minúsculas>`: o
 *   envelope de um pedido não abre em outro pedido, para outro e-mail nem noutro nó. O e-mail entra só como hash, e o
 *   rótulo nunca leva o endereço.
 * - O texto claro é `{p}`, só no bloco do RSA (sem o envelope híbrido): uma senha maior que o bloco é recusada.
 */

const LABEL_PREFIX = 'verax-user:v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Id do pedido de criação no plano de controle: ULID. */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** A senha: de 16 a 64 caracteres ASCII visíveis, sem espaço (a geradora usa 23). */
export const userPasswordPayloadSchema = z.strictObject({
  p: z.string().regex(/^[\x21-\x7e]{16,64}$/),
});

/** A quem a senha pertence: o cliente no banco do nó, o pedido do plano de controle e o e-mail da conta. */
export interface UserPasswordBinding {
  readonly nodeTenantId: string;
  readonly requestId: string;
  readonly email: string;
}

/** SHA-256, em hexadecimal minúsculo, do e-mail em minúsculas: o que entra no rótulo no lugar do endereço. */
export function emailDigest(email: string): string {
  return createHash('sha256').update(email.toLowerCase(), 'utf8').digest('hex');
}

/** `verax-user:v1:<cliente>:<pedido>:<SHA-256 do e-mail>`, conferido parte a parte. */
export function userPasswordLabel(binding: UserPasswordBinding): Buffer {
  const { nodeTenantId, requestId, email } = binding;
  if (
    !UUID.test(nodeTenantId) ||
    !ULID.test(requestId) ||
    !userCreateSchema.shape.email.safeParse(email).success
  ) {
    throw new CredentialVaultError('binding_invalid');
  }
  return Buffer.from(`${LABEL_PREFIX}:${nodeTenantId}:${requestId}:${emailDigest(email)}`, 'utf8');
}

/** Cifra a senha temporária com a chave pública do nó, amarrada ao pedido. Devolve o envelope. */
export function sealUserPassword(
  publicKey: EnvelopePublicKey,
  binding: UserPasswordBinding,
  password: string,
): string {
  const label = userPasswordLabel(binding);
  const parsed = userPasswordPayloadSchema.safeParse({ p: password });
  if (!parsed.success) throw new CredentialVaultError('secret_invalid');
  const plaintext = Buffer.from(JSON.stringify(parsed.data), 'utf8');
  try {
    return sealEnvelope(publicKey, label, plaintext, { rsaOnly: true });
  } finally {
    plaintext.fill(0);
  }
}

/**
 * Abre a senha temporária (só o worker do nó). Qualquer divergência falha fechado. Quem chama registra a senha no
 * logger como segredo vivo enquanto a usa.
 */
export function openUserPassword(
  keys: EnvelopeKeySource,
  binding: UserPasswordBinding,
  envelope: string,
): string {
  const plaintext = openEnvelopeWith(keys, envelope, () => userPasswordLabel(binding), { rsaOnly: true });
  try {
    let json: unknown;
    try {
      json = JSON.parse(plaintext.toString('utf8'));
    } catch {
      throw new CredentialVaultError('payload_invalid');
    }
    const parsed = userPasswordPayloadSchema.safeParse(json);
    if (!parsed.success) throw new CredentialVaultError('payload_invalid');
    return parsed.data.p;
  } finally {
    plaintext.fill(0);
  }
}
