import { constants, type KeyObject, privateDecrypt, publicEncrypt } from 'node:crypto';
import { inspect } from 'node:util';
import { z } from 'zod';
import { registerLiveSecret } from '../common/logger/sanitize.js';
import type { CloudCredentialKind, CloudProvider } from '../generated/prisma/enums.js';
import type { VaultKeyring, VaultPublicKey } from './credential-keys.js';

/**
 * Cofre de credenciais do nó (fase 2, PR-V1): a chave de acesso do usuário IAM de leitura da AWS e o token do
 * Cloudflare, cifrados com RSA-OAEP-SHA256 (`docs/ARQUITETURA.md`, "Cofre de credenciais").
 *
 * - `seal` cifra com a chave pública. É o que a API faz quando o admin cola a credencial: ela não tem a privada, então
 *   uma execução remota de código nela não abre o que já está guardado.
 * - `open` decifra com as chaves privadas e só existe no worker.
 * - O rótulo do OAEP (`oaepLabel`) amarra o texto ao cliente, à conta, ao tipo e ao ID da conta no provedor: uma linha
 *   copiada para outra conta ou outro cliente, ou trocada de tipo, não abre.
 * - O envelope é `v<versão da chave>:<base64>`. Versão que o worker não tem (desativada ou destruída) falha fechado.
 * - O texto claro é o mínimo, em JSON de chaves curtas (`{i,s}` na AWS, `{t}` no Cloudflare), conferido com zod ao
 *   abrir. Ele cabe nos 318 bytes que o RSA-3072 com OAEP-SHA256 cifra de uma vez.
 * - O que sai de `open` (e o que a API monta com o que foi colado) são invólucros que se recusam a virar JSON ou texto
 *   e registram o segredo no logger, que passa a ocultá-lo em qualquer linha (`registerLiveSecret`).
 *
 * Os erros levam só um código (`CredentialVaultError.code`), nunca o segredo, o texto cifrado ou a chave.
 */

/** O máximo que o RSA-3072 com OAEP-SHA256 cifra: 384 - 2 × 32 - 2 bytes. Vale também para as chaves maiores. */
export const MAX_PLAINTEXT_BYTES = 318;
/** Tamanho da coluna `CloudCredential.ciphertext`. */
export const MAX_CIPHERTEXT_LENGTH = 1024;

const LABEL_PREFIX = 'verax-cred:v1';
const ENVELOPE = /^v([1-9][0-9]{0,8}):([A-Za-z0-9+/]+={0,2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** ID da conta no provedor: 12 dígitos (AWS) ou 32 hexadecimais (Cloudflare). Sem `:`, que separa o rótulo. */
const PROVIDER_ACCOUNT_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Formatos aceitos (os mesmos que o contrato da tela vai conferir antes, no PR-V3). Expressões ancoradas, de tamanho
 * limitado e sem quantificador aninhado: o tempo de conferir é proporcional ao tamanho da entrada.
 */
export const AWS_ACCESS_KEY_ID = /^AKIA[A-Z0-9]{16}$/;
export const AWS_SECRET_ACCESS_KEY = /^[A-Za-z0-9/+]{40}$/;
/** Token do Cloudflare: o alfabeto do Bearer (RFC 6750), com tamanho limitado. */
export const CLOUDFLARE_API_TOKEN = /^[A-Za-z0-9._~+/-]{20,255}={0,2}$/;

/**
 * O texto claro de cada tipo, em JSON de chaves curtas. É a régua única do formato: os invólucros a aplicam ao que a
 * API recebe colado (antes de cifrar), e `open`, ao que saiu da cifra.
 */
const awsPayload = z.strictObject({
  i: z.string().regex(AWS_ACCESS_KEY_ID),
  s: z.string().regex(AWS_SECRET_ACCESS_KEY),
});
const cloudflarePayload = z.strictObject({ t: z.string().regex(CLOUDFLARE_API_TOKEN) });

/** Provedor de cada tipo de credencial: a credencial da AWS só vale numa conta AWS, e a do Cloudflare, numa Cloudflare. */
export const CREDENTIAL_KIND_PROVIDER = {
  aws_access_key: 'aws',
  cloudflare_api_token: 'cloudflare',
} as const satisfies Record<CloudCredentialKind, CloudProvider>;

export type CredentialVaultErrorCode =
  | 'binding_invalid'
  | 'secret_invalid'
  | 'plaintext_too_large'
  | 'envelope_invalid'
  | 'key_version_missing'
  | 'decrypt_failed'
  | 'payload_invalid';

export class CredentialVaultError extends Error {
  constructor(readonly code: CredentialVaultErrorCode) {
    super(`cofre de credenciais: ${code}`);
    this.name = 'CredentialVaultError';
  }
}

/** A quem a credencial pertence. Montada sempre pelo cadastro da conta no banco, nunca por um valor do request. */
export interface CredentialBinding {
  readonly tenantId: string;
  readonly cloudAccountId: string;
  readonly kind: CloudCredentialKind;
  /** ID da conta no provedor (12 dígitos na AWS, 32 hexadecimais no Cloudflare). */
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

const HIDDEN_AWS = '[credencial da AWS]';
const HIDDEN_CLOUDFLARE = '[token do Cloudflare]';

/**
 * Chave de acesso de longo prazo do usuário IAM de leitura (no molde de `TemporaryCredentials`, em
 * `inventory/read-only-session.ts`). O segredo só sai por `identity()`, para criar os clientes da AWS.
 */
export class StaticAwsCredentials {
  readonly #accessKeyId: string;
  readonly #secretAccessKey: string;

  constructor(accessKeyId: string, secretAccessKey: string) {
    if (!awsPayload.safeParse({ i: accessKeyId, s: secretAccessKey }).success) {
      throw new CredentialVaultError('secret_invalid');
    }
    registerLiveSecret(secretAccessKey);
    this.#accessKeyId = accessKeyId;
    this.#secretAccessKey = secretAccessKey;
  }

  get kind(): 'aws_access_key' {
    return 'aws_access_key';
  }

  /** Os 4 últimos caracteres do ID da chave: o que o painel e a auditoria mostram. */
  get keyIdSuffix(): string {
    return this.#accessKeyId.slice(-4);
  }

  /** Para criar os clientes da AWS e nada mais. */
  identity(): { accessKeyId: string; secretAccessKey: string } {
    return { accessKeyId: this.#accessKeyId, secretAccessKey: this.#secretAccessKey };
  }

  toJSON(): string {
    return HIDDEN_AWS;
  }

  toString(): string {
    return HIDDEN_AWS;
  }

  [inspect.custom](): string {
    return HIDDEN_AWS;
  }
}

/** Token só de leitura do Cloudflare. O valor só sai por `value()`, para o header da requisição. */
export class CloudflareToken {
  readonly #token: string;

  constructor(token: string) {
    if (!cloudflarePayload.safeParse({ t: token }).success) throw new CredentialVaultError('secret_invalid');
    registerLiveSecret(token);
    this.#token = token;
  }

  get kind(): 'cloudflare_api_token' {
    return 'cloudflare_api_token';
  }

  value(): string {
    return this.#token;
  }

  toJSON(): string {
    return HIDDEN_CLOUDFLARE;
  }

  toString(): string {
    return HIDDEN_CLOUDFLARE;
  }

  [inspect.custom](): string {
    return HIDDEN_CLOUDFLARE;
  }
}

export type VaultSecret = StaticAwsCredentials | CloudflareToken;

/** O que vai para a linha: o envelope e a versão da chave que cifrou. */
export interface SealedCredential {
  ciphertext: string;
  keyVersion: number;
}

function payloadOf(credential: VaultSecret): string {
  if (credential instanceof StaticAwsCredentials) {
    const { accessKeyId, secretAccessKey } = credential.identity();
    return JSON.stringify({ i: accessKeyId, s: secretAccessKey });
  }
  return JSON.stringify({ t: credential.value() });
}

/** RSA-OAEP com SHA-256 e o rótulo da amarração, igual ao cifrar e ao decifrar. */
function oaep(key: KeyObject, label: Buffer) {
  return { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', oaepLabel: label };
}

/** Cifra a credencial com a chave pública do nó, amarrada à conta. */
export function seal(
  publicKey: VaultPublicKey,
  binding: CredentialBinding,
  credential: VaultSecret,
): SealedCredential {
  if (credential.kind !== binding.kind) throw new CredentialVaultError('binding_invalid');
  const label = oaepLabel(binding);
  const plaintext = Buffer.from(payloadOf(credential), 'utf8');
  try {
    if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new CredentialVaultError('plaintext_too_large');
    const encrypted = publicEncrypt(oaep(publicKey.key, label), plaintext);
    const ciphertext = `v${publicKey.version}:${encrypted.toString('base64')}`;
    if (ciphertext.length > MAX_CIPHERTEXT_LENGTH) throw new CredentialVaultError('plaintext_too_large');
    return { ciphertext, keyVersion: publicKey.version };
  } finally {
    plaintext.fill(0);
  }
}

/** Versão da chave que cifrou o envelope, sem decifrar nada. */
export function envelopeVersion(ciphertext: string): number {
  if (ciphertext.length > MAX_CIPHERTEXT_LENGTH) throw new CredentialVaultError('envelope_invalid');
  const match = ENVELOPE.exec(ciphertext);
  if (!match) throw new CredentialVaultError('envelope_invalid');
  return Number(match[1]);
}

/** Decifra a credencial (só o worker tem as chaves privadas). Qualquer divergência falha fechado. */
export function open(keyring: VaultKeyring, binding: CredentialBinding, ciphertext: string): VaultSecret {
  const version = envelopeVersion(ciphertext);
  const key = keyring.privateKey(version);
  if (key === undefined) throw new CredentialVaultError('key_version_missing');
  const label = oaepLabel(binding);
  const body = ciphertext.slice(ciphertext.indexOf(':') + 1);
  let plaintext: Buffer;
  try {
    plaintext = privateDecrypt(oaep(key, label), Buffer.from(body, 'base64'));
  } catch {
    throw new CredentialVaultError('decrypt_failed');
  }
  try {
    let json: unknown;
    try {
      json = JSON.parse(plaintext.toString('utf8'));
    } catch {
      throw new CredentialVaultError('payload_invalid');
    }
    if (binding.kind === 'aws_access_key') {
      const parsed = awsPayload.safeParse(json);
      if (!parsed.success) throw new CredentialVaultError('payload_invalid');
      return new StaticAwsCredentials(parsed.data.i, parsed.data.s);
    }
    const parsed = cloudflarePayload.safeParse(json);
    if (!parsed.success) throw new CredentialVaultError('payload_invalid');
    return new CloudflareToken(parsed.data.t);
  } finally {
    plaintext.fill(0);
  }
}

/**
 * Recifra com a versão corrente (tarefa `credential-rekey` do worker). Devolve `null` quando o texto já está na
 * versão corrente ou numa mais nova.
 */
export function reseal(
  keyring: VaultKeyring,
  binding: CredentialBinding,
  ciphertext: string,
): SealedCredential | null {
  if (envelopeVersion(ciphertext) >= keyring.current) return null;
  return seal(keyring.publicKey(), binding, open(keyring, binding, ciphertext));
}
