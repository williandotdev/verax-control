import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { inspect } from 'node:util';

/**
 * Chaves do cofre de credenciais do nó (fase 2, PR-V1). O par RSA nasce na VM, na instalação (`infra/node/bin/
 * install.sh`), e fica só no Secret Manager (`<prefixo>-credentials-key`): cada versão do segredo é uma versão da
 * chave. A cada partida, o `start.sh` entrega:
 * - à API, só a chave pública da versão corrente: `CREDENTIALS_PUBLIC_KEY` (o PEM em base64) e
 *   `CREDENTIALS_KEY_VERSION`. A API cifra o que o admin cola e não consegue decifrar o que está guardado;
 * - ao worker, as chaves privadas de todas as versões ativas: `CREDENTIALS_PRIVATE_KEYS` (`<versão>:<PEM em base64>`,
 *   separados por vírgula) e `CREDENTIALS_KEY_CURRENT` (a versão que cifra).
 *
 * O PEM vai em base64 porque o arquivo de ambiente do nó recusa quebra de linha. As mensagens de erro citam no máximo a
 * versão, nunca o conteúdo da chave.
 */

/** RSA de 3072 bits (o que o `install.sh` gera) a 4096: o envelope de 4096 ainda cabe na coluna de 1024. */
export const MIN_KEY_BITS = 3072;
export const MAX_KEY_BITS = 4096;
export const MAX_KEY_VERSION = 999_999_999;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const PRIVATE_KEY_ENTRY = /^([1-9][0-9]{0,8}):([A-Za-z0-9+/]+={0,2})$/;
const PUBLIC_PEM = /^-----BEGIN PUBLIC KEY-----\r?\n/;
const PRIVATE_PEM = /^-----BEGIN (?:RSA )?PRIVATE KEY-----\r?\n/;

export class CredentialKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialKeyError';
  }
}

function decodePem(base64: string): string {
  if (!BASE64.test(base64)) throw new CredentialKeyError('deve ser o PEM da chave em base64');
  return Buffer.from(base64, 'base64').toString('utf8').trimStart();
}

function checkVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1 || version > MAX_KEY_VERSION) {
    throw new CredentialKeyError('a versão da chave deve ser um inteiro positivo');
  }
}

function checkRsa(key: KeyObject, type: 'public' | 'private'): void {
  const bits = key.asymmetricKeyDetails?.modulusLength;
  if (key.type !== type || key.asymmetricKeyType !== 'rsa' || bits === undefined) {
    throw new CredentialKeyError(`deve ser uma chave ${type === 'public' ? 'pública' : 'privada'} RSA`);
  }
  if (bits < MIN_KEY_BITS || bits > MAX_KEY_BITS) {
    throw new CredentialKeyError(`a chave RSA deve ter de ${MIN_KEY_BITS} a ${MAX_KEY_BITS} bits`);
  }
}

const HIDDEN_KEYRING = '[chaves privadas do cofre]';

/** A chave pública corrente do cofre: o que a API usa para cifrar. Não é segredo. */
export class VaultPublicKey {
  constructor(
    readonly version: number,
    readonly key: KeyObject,
  ) {
    checkVersion(version);
    checkRsa(key, 'public');
  }
}

/**
 * Chave pública da API, vinda do ambiente. Recusa uma chave privada no lugar dela: o `createPublicKey` aceitaria e
 * derivaria a pública, e a privada ficaria no processo exposto pelo túnel.
 */
export function parsePublicKey(base64: string, version: number): VaultPublicKey {
  const pem = decodePem(base64);
  if (pem.includes('PRIVATE KEY')) {
    throw new CredentialKeyError('a API recebe só a chave pública do cofre; a privada fica só no worker');
  }
  if (!PUBLIC_PEM.test(pem))
    throw new CredentialKeyError('deve ser uma chave pública em PEM (BEGIN PUBLIC KEY)');
  let key: KeyObject;
  try {
    key = createPublicKey({ key: pem, format: 'pem' });
  } catch {
    throw new CredentialKeyError('chave pública ilegível');
  }
  return new VaultPublicKey(version, key);
}

/**
 * As chaves privadas do cofre, por versão, e a versão corrente: o que o worker usa para decifrar e recifrar. O objeto
 * se recusa a virar JSON ou texto de log, como as credenciais (o `KeyObject` já não expõe o conteúdo).
 */
export class VaultKeyring {
  readonly #keys: ReadonlyMap<number, KeyObject>;
  readonly #current: VaultPublicKey;

  constructor(keys: ReadonlyMap<number, KeyObject>, current: number) {
    checkVersion(current);
    for (const [version, key] of keys) {
      checkVersion(version);
      checkRsa(key, 'private');
    }
    const currentKey = keys.get(current);
    if (currentKey === undefined) {
      throw new CredentialKeyError('a versão corrente precisa estar entre as chaves privadas');
    }
    this.#keys = new Map(keys);
    this.#current = new VaultPublicKey(current, createPublicKey(currentKey));
  }

  /** Versão que cifra (a mais nova ativa no Secret Manager). */
  get current(): number {
    return this.#current.version;
  }

  /** Versões que o worker consegue abrir, em ordem. */
  get versions(): number[] {
    return [...this.#keys.keys()].sort((a, b) => a - b);
  }

  /** A chave pública da versão corrente, derivada da privada: a recifragem cifra com ela. */
  publicKey(): VaultPublicKey {
    return this.#current;
  }

  /** A chave privada de uma versão; sem ela (versão desativada ou destruída), o texto daquela versão não abre. */
  privateKey(version: number): KeyObject | undefined {
    return this.#keys.get(version);
  }

  toJSON(): string {
    return HIDDEN_KEYRING;
  }

  toString(): string {
    return HIDDEN_KEYRING;
  }

  [inspect.custom](): string {
    return HIDDEN_KEYRING;
  }
}

/** Chaves privadas do worker, vindas do ambiente (`<versão>:<PEM em base64>`, separados por vírgula). */
export function parsePrivateKeys(list: string, current: number): VaultKeyring {
  const keys = new Map<number, KeyObject>();
  for (const entry of list.split(',')) {
    const match = PRIVATE_KEY_ENTRY.exec(entry);
    if (!match) throw new CredentialKeyError('cada item deve ser <versão>:<PEM da chave privada em base64>');
    const version = Number(match[1]);
    if (keys.has(version)) throw new CredentialKeyError(`a versão ${version} aparece mais de uma vez`);
    const pem = decodePem(match[2] ?? '');
    if (!PRIVATE_PEM.test(pem)) {
      throw new CredentialKeyError(
        `a versão ${version} deve ser uma chave privada em PEM (BEGIN PRIVATE KEY)`,
      );
    }
    let key: KeyObject;
    try {
      key = createPrivateKey({ key: pem, format: 'pem' });
    } catch {
      throw new CredentialKeyError(`a chave privada da versão ${version} é ilegível`);
    }
    try {
      checkRsa(key, 'private');
    } catch (error) {
      throw new CredentialKeyError(`versão ${version}: ${(error as Error).message}`);
    }
    keys.set(version, key);
  }
  return new VaultKeyring(keys, current);
}
