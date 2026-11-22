import {
  constants,
  createCipheriv,
  createDecipheriv,
  type KeyObject,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';
import { CredentialVaultError } from './errors.js';
import { assertEnvelopePublicKey, type EnvelopePublicKey } from './public-key.js';

/**
 * O envelope do cofre do nó: `v<versão da chave>:<base64>`, cifrado com a chave pública RSA do nó (RSA-OAEP com
 * SHA-256 e um rótulo que amarra o texto ao dono dele). Só o worker do nó tem as chaves privadas e abre.
 *
 * - Até 318 bytes de texto claro (o que o RSA-3072 com OAEP-SHA256 cifra de uma vez), o base64 é só o bloco do RSA.
 * - Maior que isso, o envelope é híbrido: uma chave AES-256-GCM aleatória cifrada com a RSA do nó (com o mesmo rótulo
 *   do OAEP), o IV, a etiqueta e o texto cifrado, com o rótulo também como dado autenticado. O tamanho do bloco do RSA
 *   separa os dois; o formato do envelope não muda.
 * - Versão que o worker não tem (desativada ou destruída) falha fechado.
 *
 * Quem cifra (a API do nó, o plano de controle) só precisa da chave pública e da versão dela. Os erros levam só o
 * código (`CredentialVaultError.code`).
 */

/** O máximo que o RSA-3072 com OAEP-SHA256 cifra: 384 - 2 × 32 - 2 bytes. Vale também para as chaves maiores. */
export const MAX_PLAINTEXT_BYTES = 318;
/** O máximo do envelope híbrido: com a RSA-4096, ele ainda cabe na coluna. */
export const MAX_HYBRID_PLAINTEXT_BYTES = 5120;
/** Tamanho máximo do envelope (a coluna `CloudCredential.ciphertext` do nó). */
export const MAX_CIPHERTEXT_LENGTH = 8192;
const AES_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

/** `v<versão>:<base64>`: a versão (1 a 999.999.999, sem zero à esquerda) e o corpo em base64 padrão. */
export const ENVELOPE_PATTERN = /^v([1-9][0-9]{0,8}):([A-Za-z0-9+/]+={0,2})$/;

/** De onde o worker tira a chave privada de cada versão (o `VaultKeyring` do nó). */
export interface EnvelopeKeySource {
  privateKey(version: number): KeyObject | undefined;
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

export interface EnvelopeOptions {
  /**
   * Só o bloco do RSA, sem o envelope híbrido: texto claro maior que `MAX_PLAINTEXT_BYTES` é recusado ao cifrar
   * (`plaintext_too_large`), e o envelope híbrido não abre (`decrypt_failed`).
   */
  readonly rsaOnly?: boolean;
}

/**
 * Cifra o texto claro com a chave pública do nó e o rótulo. Quem chama zera o texto claro depois
 * (`plaintext.fill(0)`), dê certo ou não.
 */
export function sealEnvelope(
  publicKey: EnvelopePublicKey,
  label: Buffer,
  plaintext: Buffer,
  options: EnvelopeOptions = {},
): string {
  assertEnvelopePublicKey(publicKey);
  const limit = options.rsaOnly === true ? MAX_PLAINTEXT_BYTES : MAX_HYBRID_PLAINTEXT_BYTES;
  if (plaintext.length > limit) throw new CredentialVaultError('plaintext_too_large');
  const encrypted =
    plaintext.length > MAX_PLAINTEXT_BYTES
      ? sealHybrid(publicKey.key, label, plaintext)
      : publicEncrypt(oaep(publicKey.key, label), plaintext);
  const envelope = `v${publicKey.version}:${encrypted.toString('base64')}`;
  if (envelope.length > MAX_CIPHERTEXT_LENGTH) throw new CredentialVaultError('plaintext_too_large');
  return envelope;
}

/** Versão da chave que cifrou o envelope, sem decifrar nada. */
export function envelopeVersion(ciphertext: string): number {
  if (ciphertext.length > MAX_CIPHERTEXT_LENGTH) throw new CredentialVaultError('envelope_invalid');
  const match = ENVELOPE_PATTERN.exec(ciphertext);
  if (!match) throw new CredentialVaultError('envelope_invalid');
  return Number(match[1]);
}

/**
 * Decifra o envelope. O rótulo é montado depois de conferir o formato e a versão (`labelOf`), na ordem dos erros de
 * sempre: envelope fora do formato, versão ausente, amarração inválida, decifragem.
 */
export function openEnvelopeWith(
  keys: EnvelopeKeySource,
  ciphertext: string,
  labelOf: () => Buffer,
  options: EnvelopeOptions = {},
): Buffer {
  const version = envelopeVersion(ciphertext);
  const key = keys.privateKey(version);
  if (key === undefined) throw new CredentialVaultError('key_version_missing');
  const label = labelOf();
  const body = Buffer.from(ciphertext.slice(ciphertext.indexOf(':') + 1), 'base64');
  const block = rsaBlockBytes(key);
  if (body.length === block) {
    try {
      return privateDecrypt(oaep(key, label), body);
    } catch {
      throw new CredentialVaultError('decrypt_failed');
    }
  }
  if (options.rsaOnly !== true && body.length > block + GCM_IV_BYTES + GCM_TAG_BYTES) {
    return openHybrid(key, label, body, block);
  }
  throw new CredentialVaultError('decrypt_failed');
}

/**
 * Decifra o envelope com a chave privada da versão dele e o rótulo. Qualquer divergência falha fechado. Quem chama
 * zera o texto claro depois de ler (`plaintext.fill(0)`).
 */
export function openEnvelope(
  keys: EnvelopeKeySource,
  label: Buffer,
  ciphertext: string,
  options: EnvelopeOptions = {},
): Buffer {
  return openEnvelopeWith(keys, ciphertext, () => label, options);
}
