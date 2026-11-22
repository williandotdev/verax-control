import { createHash, createPublicKey, type KeyObject } from 'node:crypto';
import { CredentialVaultError } from './errors.js';

/**
 * A chave pública do cofre do nó, o que basta para cifrar: a API do nó a recebe do ambiente, e o plano de controle, do
 * próprio nó (a sincronização informa o PEM, a versão e a impressão digital).
 */

/** RSA de 3072 bits (o que o instalador do nó gera) a 4096: o envelope de 4096 ainda cabe na coluna. */
export const MIN_KEY_BITS = 3072;
export const MAX_KEY_BITS = 4096;
export const MAX_KEY_VERSION = 999_999_999;

const PUBLIC_PEM = /^-----BEGIN PUBLIC KEY-----\r?\n/;

/** A chave pública e a versão dela, a que vai no prefixo do envelope (`v<versão>:`). */
export interface EnvelopePublicKey {
  readonly version: number;
  readonly key: KeyObject;
}

/** Versão de chave aceita: inteiro de 1 a 999.999.999. */
export function isKeyVersion(version: number): boolean {
  return Number.isSafeInteger(version) && version >= 1 && version <= MAX_KEY_VERSION;
}

/** Chave RSA do tipo pedido, de 3072 a 4096 bits. */
export function isVaultRsaKey(key: KeyObject, type: 'public' | 'private'): boolean {
  const bits = key.asymmetricKeyDetails?.modulusLength;
  return (
    key.type === type &&
    key.asymmetricKeyType === 'rsa' &&
    bits !== undefined &&
    bits >= MIN_KEY_BITS &&
    bits <= MAX_KEY_BITS
  );
}

/** Recusa (`public_key_invalid`) versão fora da faixa e chave que não é a pública RSA do cofre. */
export function assertEnvelopePublicKey(publicKey: EnvelopePublicKey): void {
  if (!isKeyVersion(publicKey.version) || !isVaultRsaKey(publicKey.key, 'public')) {
    throw new CredentialVaultError('public_key_invalid');
  }
}

/**
 * A chave pública do cofre a partir do PEM (`BEGIN PUBLIC KEY`, SPKI) e da versão. Recusa a chave privada no lugar
 * dela (o `createPublicKey` aceitaria e derivaria a pública), outro algoritmo e outro tamanho.
 */
export function vaultPublicKeyFromPem(pem: string, version: number): EnvelopePublicKey {
  if (pem.includes('PRIVATE KEY') || !PUBLIC_PEM.test(pem)) {
    throw new CredentialVaultError('public_key_invalid');
  }
  let key: KeyObject;
  try {
    key = createPublicKey({ key: pem, format: 'pem' });
  } catch {
    throw new CredentialVaultError('public_key_invalid');
  }
  const publicKey = { version, key };
  assertEnvelopePublicKey(publicKey);
  return publicKey;
}

/**
 * Impressão digital da chave pública: SHA-256, em hexadecimal minúsculo, do DER do SPKI. Aceita o PEM da pública ou o
 * `KeyObject` (da privada, deriva a pública). É o que o nó informa e o que o console e o painel mostram para conferir
 * que a chave é a mesma.
 */
export function publicKeyFingerprint(publicKey: string | KeyObject): string {
  let key: KeyObject;
  if (typeof publicKey === 'string') {
    if (publicKey.includes('PRIVATE KEY') || !PUBLIC_PEM.test(publicKey)) {
      throw new CredentialVaultError('public_key_invalid');
    }
    try {
      key = createPublicKey({ key: publicKey, format: 'pem' });
    } catch {
      throw new CredentialVaultError('public_key_invalid');
    }
  } else if (publicKey.type === 'secret') {
    throw new CredentialVaultError('public_key_invalid');
  } else {
    key = publicKey.type === 'public' ? publicKey : createPublicKey(publicKey);
  }
  return createHash('sha256')
    .update(key.export({ type: 'spki', format: 'der' }))
    .digest('hex');
}
