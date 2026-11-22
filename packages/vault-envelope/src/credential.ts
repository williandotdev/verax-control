import {
  AWS_ACCESS_KEY_ID_PATTERN,
  AWS_SECRET_ACCESS_KEY_PATTERN,
  type CloudCredentialKind,
  type CloudProvider,
  CREDENTIAL_KIND_PROVIDERS,
  gcpServiceAccountKeyFieldsSchema,
} from '@verax/shared';
import { z } from 'zod';
import { type EnvelopeKeySource, openEnvelopeWith, sealEnvelope } from './envelope.js';
import { CredentialVaultError } from './errors.js';
import type { EnvelopePublicKey } from './public-key.js';

/**
 * As credenciais de leitura do cofre do nó (o token do Cloudflare e, na VM própria do cliente, as chaves de leitura da
 * AWS e da GCP; `docs/ARQUITETURA.md`, "Cofre de credenciais").
 *
 * - O rótulo do OAEP (`oaepLabel`) amarra o texto ao cliente do banco do nó, à conta, ao tipo e ao ID da conta no
 *   provedor: uma linha copiada para outra conta ou outro cliente, ou trocada de tipo, não abre.
 * - O texto claro é o mínimo, em JSON de chave curta (`{t}` no Cloudflare, `{i,s}` na AWS, `{p,e,d,k}` na GCP),
 *   conferido com zod ao cifrar e ao abrir.
 *
 * Aqui só ficam os dados: os invólucros que se recusam a virar texto de log (`CloudflareToken` e os outros) são da API
 * do nó, em cima destas funções.
 */

const LABEL_PREFIX = 'verax-cred:v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * ID da conta no provedor (32 hexadecimais no Cloudflare, 12 dígitos na AWS, o ID do projeto na GCP). Sem `:`, que
 * separa o rótulo.
 */
const PROVIDER_ACCOUNT_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Token do Cloudflare: o alfabeto do Bearer (RFC 6750), com tamanho limitado. Expressão ancorada, de tamanho limitado e
 * sem quantificador aninhado: o tempo de conferir é proporcional ao tamanho da entrada.
 */
export const CLOUDFLARE_API_TOKEN = /^[A-Za-z0-9._~+/-]{20,255}={0,2}$/;

/**
 * O texto claro de cada tipo, em JSON de chave curta. É a régua única do formato: vale para o que se cifra e para o
 * que sai da cifra. Na AWS e na GCP, as regras do contrato (`packages/shared`), conferidas de novo aqui.
 */
export const cloudflareCredentialPayloadSchema = z.strictObject({
  t: z.string().regex(CLOUDFLARE_API_TOKEN),
});
export const awsCredentialPayloadSchema = z.strictObject({
  i: z.string().regex(AWS_ACCESS_KEY_ID_PATTERN),
  s: z.string().regex(AWS_SECRET_ACCESS_KEY_PATTERN),
});
const gcpFields = gcpServiceAccountKeyFieldsSchema.shape;
export const gcpCredentialPayloadSchema = z.strictObject({
  p: gcpFields.projectId,
  e: gcpFields.clientEmail,
  d: gcpFields.privateKeyId,
  k: gcpFields.privateKey,
});

/** O schema do texto claro de cada tipo de credencial. */
export const CREDENTIAL_PAYLOAD_SCHEMAS = {
  cloudflare_api_token: cloudflareCredentialPayloadSchema,
  aws_access_key: awsCredentialPayloadSchema,
  gcp_service_account_key: gcpCredentialPayloadSchema,
} as const satisfies Record<CloudCredentialKind, z.ZodType>;

export type CloudflareCredentialPayload = z.infer<typeof cloudflareCredentialPayloadSchema>;
export type AwsCredentialPayload = z.infer<typeof awsCredentialPayloadSchema>;
export type GcpCredentialPayload = z.infer<typeof gcpCredentialPayloadSchema>;
export type CredentialPayload = CloudflareCredentialPayload | AwsCredentialPayload | GcpCredentialPayload;

/** O que `openCredential` devolve: o tipo (o da amarração) e o texto claro já conferido. */
export type OpenedCredential =
  | { kind: 'cloudflare_api_token'; payload: CloudflareCredentialPayload }
  | { kind: 'aws_access_key'; payload: AwsCredentialPayload }
  | { kind: 'gcp_service_account_key'; payload: GcpCredentialPayload };

/** Provedor de cada tipo de credencial: o token do Cloudflare só vale numa conta do Cloudflare, e assim por diante. */
export const CREDENTIAL_KIND_PROVIDER = CREDENTIAL_KIND_PROVIDERS;

/**
 * A quem a credencial pertence. No nó, montada sempre pelo cadastro da conta no banco, nunca por um valor do request.
 * Fora dele (o plano de controle), pelo id do cliente no banco do nó, que o próprio nó informa, e pelo id da conta que
 * o plano de controle escolheu.
 */
export interface CredentialBinding {
  readonly tenantId: string;
  readonly cloudAccountId: string;
  readonly kind: CloudCredentialKind;
  /** ID da conta no provedor (32 hexadecimais no Cloudflare, 12 dígitos na AWS, o projeto na GCP). */
  readonly accountId: string;
}

/** A amarração de uma credencial à conta cadastrada; o tipo tem de ser o do provedor da conta. */
export function credentialBinding(
  account: { id: string; tenantId: string; provider: CloudProvider; accountId: string },
  kind: CloudCredentialKind,
): CredentialBinding {
  if (CREDENTIAL_KIND_PROVIDER[kind] !== account.provider) throw new CredentialVaultError('binding_invalid');
  return { tenantId: account.tenantId, cloudAccountId: account.id, kind, accountId: account.accountId };
}

/** `verax-cred:v1:<cliente>:<conta>:<tipo>:<ID no provedor>`, conferido parte a parte (nenhuma parte tem `:`). */
export function oaepLabel(binding: CredentialBinding): Buffer {
  const { tenantId, cloudAccountId, kind, accountId } = binding;
  if (
    !UUID.test(tenantId) ||
    !UUID.test(cloudAccountId) ||
    !Object.hasOwn(CREDENTIAL_KIND_PROVIDER, kind) ||
    !PROVIDER_ACCOUNT_ID.test(accountId)
  ) {
    throw new CredentialVaultError('binding_invalid');
  }
  return Buffer.from(`${LABEL_PREFIX}:${tenantId}:${cloudAccountId}:${kind}:${accountId}`, 'utf8');
}

/** O que vai para a linha: o envelope e a versão da chave que cifrou. */
export interface SealedCredential {
  ciphertext: string;
  keyVersion: number;
}

/**
 * Cifra o texto claro da credencial com a chave pública do nó, amarrado à conta. O texto tem de ser o do tipo da
 * amarração (`secret_invalid` fora do formato). O JSON intermediário é zerado no fim.
 */
export function sealCredential(
  publicKey: EnvelopePublicKey,
  binding: CredentialBinding,
  payload: CredentialPayload,
): SealedCredential {
  const label = oaepLabel(binding);
  const parsed = CREDENTIAL_PAYLOAD_SCHEMAS[binding.kind].safeParse(payload);
  if (!parsed.success) throw new CredentialVaultError('secret_invalid');
  const plaintext = Buffer.from(JSON.stringify(parsed.data), 'utf8');
  try {
    return { ciphertext: sealEnvelope(publicKey, label, plaintext), keyVersion: publicKey.version };
  } finally {
    plaintext.fill(0);
  }
}

/** O texto claro já aberto, pelo tipo da amarração; fora do formato, `payload_invalid`. */
function payloadFrom(kind: CloudCredentialKind, json: unknown): OpenedCredential {
  switch (kind) {
    case 'cloudflare_api_token': {
      const parsed = cloudflareCredentialPayloadSchema.safeParse(json);
      if (!parsed.success) throw new CredentialVaultError('payload_invalid');
      return { kind, payload: parsed.data };
    }
    case 'aws_access_key': {
      const parsed = awsCredentialPayloadSchema.safeParse(json);
      if (!parsed.success) throw new CredentialVaultError('payload_invalid');
      return { kind, payload: parsed.data };
    }
    case 'gcp_service_account_key': {
      const parsed = gcpCredentialPayloadSchema.safeParse(json);
      if (!parsed.success) throw new CredentialVaultError('payload_invalid');
      return { kind, payload: parsed.data };
    }
  }
}

/** Decifra a credencial (só o worker do nó tem as chaves privadas). Qualquer divergência falha fechado. */
export function openCredential(
  keys: EnvelopeKeySource,
  binding: CredentialBinding,
  ciphertext: string,
): OpenedCredential {
  const plaintext = openEnvelopeWith(keys, ciphertext, () => oaepLabel(binding));
  try {
    let json: unknown;
    try {
      json = JSON.parse(plaintext.toString('utf8'));
    } catch {
      throw new CredentialVaultError('payload_invalid');
    }
    return payloadFrom(binding.kind, json);
  } finally {
    plaintext.fill(0);
  }
}
