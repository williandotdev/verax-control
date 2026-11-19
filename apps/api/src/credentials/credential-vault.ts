import {
  constants,
  createCipheriv,
  createDecipheriv,
  type KeyObject,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';
import { inspect } from 'node:util';
import {
  AWS_ACCESS_KEY_ID_PATTERN,
  AWS_SECRET_ACCESS_KEY_PATTERN,
  type GcpServiceAccountKeyFields,
  gcpServiceAccountKeyFieldsSchema,
} from '@verax/shared';
import { z } from 'zod';
import { forgetLiveSecret, registerLiveSecret } from '../common/logger/sanitize.js';
import type { CloudCredentialKind, CloudProvider } from '../generated/prisma/enums.js';
import type { VaultKeyring, VaultPublicKey } from './credential-keys.js';

/**
 * Cofre de credenciais do nó (fase 2, PR-V1): o token só de leitura do Cloudflare e, só na VM própria do cliente
 * (`NODE_PLATFORM=vm`), a chave de acesso do usuário IAM de leitura da AWS e a chave da conta de serviço de leitura da
 * GCP (`docs/ARQUITETURA.md`, "Cofre de credenciais"). Nos nós da GCP, a AWS e a GCP são lidas sem chave, e a API
 * recusa os dois tipos.
 *
 * - `seal` cifra com a chave pública. É o que a API faz quando o admin cola a credencial: ela não tem a privada, então
 *   uma execução remota de código nela não abre o que já está guardado.
 * - `open` decifra com as chaves privadas e só existe no worker.
 * - O rótulo do OAEP (`oaepLabel`) amarra o texto ao cliente, à conta, ao tipo e ao ID da conta no provedor: uma linha
 *   copiada para outra conta ou outro cliente, ou trocada de tipo, não abre.
 * - O envelope é `v<versão da chave>:<base64>`. Versão que o worker não tem (desativada ou destruída) falha fechado.
 * - O texto claro é o mínimo, em JSON de chave curta (`{t}` no Cloudflare, `{i,s}` na AWS, `{p,e,d,k}` na GCP),
 *   conferido com zod ao abrir. Até 318 bytes (o que o RSA-3072 com OAEP-SHA256 cifra de uma vez), o base64 é só o
 *   bloco do RSA-OAEP. Maior que isso (a chave da conta de serviço da GCP, com o PEM da RSA-2048), o envelope é
 *   híbrido: uma chave AES-256-GCM aleatória cifrada com a RSA do nó (o mesmo rótulo do OAEP), o IV, a etiqueta e o
 *   texto cifrado, com o rótulo também como dado autenticado. O tamanho do bloco do RSA separa os dois; o formato do
 *   envelope (e o CHECK do banco) não muda.
 * - O que sai de `open` (e o que a API monta com o que foi colado) são invólucros que se recusam a virar JSON ou texto
 *   e registram o segredo no logger, que passa a ocultá-lo em qualquer linha (`registerLiveSecret`).
 *
 * Os erros levam só um código (`CredentialVaultError.code`), nunca o segredo, o texto cifrado ou a chave.
 */

/** O máximo que o RSA-3072 com OAEP-SHA256 cifra: 384 - 2 × 32 - 2 bytes. Vale também para as chaves maiores. */
export const MAX_PLAINTEXT_BYTES = 318;
/** O máximo do envelope híbrido: com a RSA-4096, ele ainda cabe na coluna. */
export const MAX_HYBRID_PLAINTEXT_BYTES = 5120;
/** Tamanho da coluna `CloudCredential.ciphertext`. */
export const MAX_CIPHERTEXT_LENGTH = 8192;
const AES_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

const LABEL_PREFIX = 'verax-cred:v1';
const ENVELOPE = /^v([1-9][0-9]{0,8}):([A-Za-z0-9+/]+={0,2})$/;
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
 * O texto claro de cada tipo, em JSON de chave curta. É a régua única do formato: o invólucro a aplica ao que a API
 * recebe colado (antes de cifrar), e `open`, ao que saiu da cifra. Na AWS e na GCP, as regras do contrato
 * (`packages/shared`), conferidas de novo aqui.
 */
const cloudflarePayload = z.strictObject({ t: z.string().regex(CLOUDFLARE_API_TOKEN) });
const awsPayload = z.strictObject({
  i: z.string().regex(AWS_ACCESS_KEY_ID_PATTERN),
  s: z.string().regex(AWS_SECRET_ACCESS_KEY_PATTERN),
});
const gcpFields = gcpServiceAccountKeyFieldsSchema.shape;
const gcpPayload = z.strictObject({
  p: gcpFields.projectId,
  e: gcpFields.clientEmail,
  d: gcpFields.privateKeyId,
  k: gcpFields.privateKey,
});

/** Provedor de cada tipo de credencial: o token do Cloudflare só vale numa conta do Cloudflare, e assim por diante. */
export const CREDENTIAL_KIND_PROVIDER = {
  cloudflare_api_token: 'cloudflare',
  aws_access_key: 'aws',
  gcp_service_account_key: 'gcp',
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

const HIDDEN_CLOUDFLARE = '[token do Cloudflare]';

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

const HIDDEN_AWS = '[chave de acesso da AWS]';

/**
 * Chave de acesso do usuário IAM de leitura (a VM própria do cliente). O ID da chave não é segredo (vai para o
 * `keyIdSuffix` e aparece no CloudTrail do cliente); o segredo só sai por `secret()`, para os clientes da AWS.
 */
export class AwsAccessKey {
  readonly accessKeyId: string;
  readonly #secret: string;

  constructor(accessKeyId: string, secretAccessKey: string) {
    if (!awsPayload.safeParse({ i: accessKeyId, s: secretAccessKey }).success) {
      throw new CredentialVaultError('secret_invalid');
    }
    registerLiveSecret(secretAccessKey);
    this.accessKeyId = accessKeyId;
    this.#secret = secretAccessKey;
  }

  get kind(): 'aws_access_key' {
    return 'aws_access_key';
  }

  secret(): string {
    return this.#secret;
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

const HIDDEN_GCP = '[chave da conta de serviço da GCP]';

/**
 * Chave da conta de serviço de leitura da GCP (a VM própria do cliente). O projeto, o e-mail e o ID da chave não são
 * segredo; a chave privada só sai por `privateKey()`, para assinar o pedido do token ao Google.
 */
export class GcpServiceAccountKey {
  readonly projectId: string;
  readonly clientEmail: string;
  readonly privateKeyId: string;
  readonly #privateKey: string;

  constructor(fields: GcpServiceAccountKeyFields) {
    const parsed = gcpPayload.safeParse({
      p: fields.projectId,
      e: fields.clientEmail,
      d: fields.privateKeyId,
      k: fields.privateKey,
    });
    if (!parsed.success) throw new CredentialVaultError('secret_invalid');
    registerLiveSecret(fields.privateKey);
    this.projectId = fields.projectId;
    this.clientEmail = fields.clientEmail;
    this.privateKeyId = fields.privateKeyId;
    this.#privateKey = fields.privateKey;
  }

  get kind(): 'gcp_service_account_key' {
    return 'gcp_service_account_key';
  }

  privateKey(): string {
    return this.#privateKey;
  }

  toJSON(): string {
    return HIDDEN_GCP;
  }

  toString(): string {
    return HIDDEN_GCP;
  }

  [inspect.custom](): string {
    return HIDDEN_GCP;
  }
}

/** O que o cofre guarda. Um tipo novo de credencial entra aqui como mais um invólucro. */
export type VaultSecret = CloudflareToken | AwsAccessKey | GcpServiceAccountKey;

/** O valor secreto do invólucro: o que o logger oculta enquanto ele vale. */
function secretOf(credential: VaultSecret): string {
  if (credential instanceof AwsAccessKey) return credential.secret();
  if (credential instanceof GcpServiceAccountKey) return credential.privateKey();
  return credential.value();
}

/**
 * A API acabou de usar a credencial colada (conferir e cifrar): o logger deixa de guardar o valor dela
 * (`forgetLiveSecret`). Só a API chama, no fim da requisição; o worker mantém o que decifrou.
 */
export function releaseSecret(credential: VaultSecret): void {
  forgetLiveSecret(secretOf(credential));
}

/** O que vai para a linha: o envelope e a versão da chave que cifrou. */
export interface SealedCredential {
  ciphertext: string;
  keyVersion: number;
}

function payloadOf(credential: VaultSecret): string {
  if (credential instanceof AwsAccessKey) {
    return JSON.stringify({ i: credential.accessKeyId, s: credential.secret() });
  }
  if (credential instanceof GcpServiceAccountKey) {
    return JSON.stringify({
      p: credential.projectId,
      e: credential.clientEmail,
      d: credential.privateKeyId,
      k: credential.privateKey(),
    });
  }
  return JSON.stringify({ t: credential.value() });
}

/** O invólucro do texto claro já aberto, pelo tipo da amarração; fora do formato, `payload_invalid`. */
function secretFrom(kind: CloudCredentialKind, json: unknown): VaultSecret {
  switch (kind) {
    case 'cloudflare_api_token': {
      const parsed = cloudflarePayload.safeParse(json);
      if (!parsed.success) throw new CredentialVaultError('payload_invalid');
      return new CloudflareToken(parsed.data.t);
    }
    case 'aws_access_key': {
      const parsed = awsPayload.safeParse(json);
      if (!parsed.success) throw new CredentialVaultError('payload_invalid');
      return new AwsAccessKey(parsed.data.i, parsed.data.s);
    }
    case 'gcp_service_account_key': {
      const parsed = gcpPayload.safeParse(json);
      if (!parsed.success) throw new CredentialVaultError('payload_invalid');
      return new GcpServiceAccountKey({
        projectId: parsed.data.p,
        clientEmail: parsed.data.e,
        privateKeyId: parsed.data.d,
        privateKey: parsed.data.k,
      });
    }
  }
}

/** RSA-OAEP com SHA-256 e o rótulo da amarração, igual ao cifrar e ao decifrar. */
function oaep(key: KeyObject, label: Buffer) {
  return { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', oaepLabel: label };
}

/** O tamanho do bloco do RSA da chave (384 bytes na RSA-3072): o tamanho exato do envelope só de RSA. */
function rsaBlockBytes(key: KeyObject): number {
  const bits = key.asymmetricKeyDetails?.modulusLength;
  if (bits === undefined) throw new CredentialVaultError('decrypt_failed');
  return bits / 8;
}

/**
 * O envelope híbrido: a chave AES-256-GCM aleatória cifrada com a RSA do nó (OAEP, com o rótulo), o IV, a etiqueta e o
 * texto cifrado, com o rótulo também como dado autenticado. A chave AES é zerada no fim.
 */
function sealHybrid(publicKey: KeyObject, label: Buffer, plaintext: Buffer): Buffer {
  const aesKey = randomBytes(AES_KEY_BYTES);
  try {
    const wrapped = publicEncrypt(oaep(publicKey, label), aesKey);
    const iv = randomBytes(GCM_IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', aesKey, iv, { authTagLength: GCM_TAG_BYTES });
    cipher.setAAD(label);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([wrapped, iv, cipher.getAuthTag(), encrypted]);
  } finally {
    aesKey.fill(0);
  }
}

/** Abre o envelope híbrido; qualquer divergência (rótulo, etiqueta, tamanho) é `decrypt_failed`. */
function openHybrid(privateKey: KeyObject, label: Buffer, body: Buffer, block: number): Buffer {
  let aesKey: Buffer;
  try {
    aesKey = privateDecrypt(oaep(privateKey, label), body.subarray(0, block));
  } catch {
    throw new CredentialVaultError('decrypt_failed');
  }
  try {
    if (aesKey.length !== AES_KEY_BYTES) throw new CredentialVaultError('decrypt_failed');
    const iv = body.subarray(block, block + GCM_IV_BYTES);
    const tag = body.subarray(block + GCM_IV_BYTES, block + GCM_IV_BYTES + GCM_TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', aesKey, iv, { authTagLength: GCM_TAG_BYTES });
    decipher.setAAD(label);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([
        decipher.update(body.subarray(block + GCM_IV_BYTES + GCM_TAG_BYTES)),
        decipher.final(),
      ]);
    } catch {
      throw new CredentialVaultError('decrypt_failed');
    }
  } finally {
    aesKey.fill(0);
  }
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
    if (plaintext.length > MAX_HYBRID_PLAINTEXT_BYTES) throw new CredentialVaultError('plaintext_too_large');
    const encrypted =
      plaintext.length > MAX_PLAINTEXT_BYTES
        ? sealHybrid(publicKey.key, label, plaintext)
        : publicEncrypt(oaep(publicKey.key, label), plaintext);
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
  const body = Buffer.from(ciphertext.slice(ciphertext.indexOf(':') + 1), 'base64');
  const block = rsaBlockBytes(key);
  let plaintext: Buffer;
  if (body.length === block) {
    try {
      plaintext = privateDecrypt(oaep(key, label), body);
    } catch {
      throw new CredentialVaultError('decrypt_failed');
    }
  } else if (body.length > block + GCM_IV_BYTES + GCM_TAG_BYTES) {
    plaintext = openHybrid(key, label, body, block);
  } else {
    throw new CredentialVaultError('decrypt_failed');
  }
  try {
    let json: unknown;
    try {
      json = JSON.parse(plaintext.toString('utf8'));
    } catch {
      throw new CredentialVaultError('payload_invalid');
    }
    return secretFrom(binding.kind, json);
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
