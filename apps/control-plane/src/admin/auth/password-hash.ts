import { randomBytes, scrypt as scryptCallback, type ScryptOptions, timingSafeEqual } from 'node:crypto';

/**
 * Hash da senha do responsável no console (cp-admin) com o `scrypt` do Node: sal aleatório de 16 bytes por senha e o
 * custo de uma das combinações equivalentes da OWASP (Password Storage Cheat Sheet: N=2^15, r=8, p=3, 32 MiB por
 * cálculo), escolhida pela memória: o cp-admin roda com 512 MiB e o pool do libuv calcula até 4 ao mesmo tempo.
 *
 * Formato guardado: `scrypt$<log2 N>$<r>$<p>$<sal base64url>$<hash base64url>`. Os parâmetros vão junto, para um custo
 * maior no futuro valer só para as senhas novas sem invalidar as antigas. A comparação é em tempo constante.
 */
export interface ScryptParams {
  /** log2 de N (custo de CPU e memória). */
  logN: number;
  r: number;
  p: number;
}

export const PASSWORD_PARAMS: ScryptParams = { logN: 15, r: 8, p: 3 };

/** Tamanhos aceitos para a senha (o mínimo vale para senha nova; o máximo evita trabalho à toa com entrada enorme). */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

const SALT_BYTES = 16;
const KEY_BYTES = 32;
const PREFIX = 'scrypt';
/** Teto de memória do cálculo: 128 * N * r com folga (o padrão do Node, 32 MiB, é justo o tamanho do bloco). */
const MAX_MEMORY = 96 * 1024 * 1024;
const HASH_PATTERN = /^scrypt\$(\d{1,2})\$(\d{1,2})\$(\d{1,2})\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/;

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const options: ScryptOptions = { N: 2 ** params.logN, r: params.r, p: params.p, maxmem: MAX_MEMORY };
  return new Promise((resolve, reject) => {
    scryptCallback(password.normalize('NFC'), salt, KEY_BYTES, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** O hash de uma senha nova, com sal novo. */
export async function hashPassword(
  password: string,
  params: ScryptParams = PASSWORD_PARAMS,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, params);
  return [
    PREFIX,
    params.logN,
    params.r,
    params.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

/** `true` se a senha confere com o hash guardado. Hash fora do formato: `false` (nunca exceção). */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const match = HASH_PATTERN.exec(stored);
  if (match === null) return false;
  const [, logN, r, p, salt, expected] = match;
  const params = { logN: Number(logN), r: Number(r), p: Number(p) };
  // Custos fora do razoável num documento adulterado não viram um cálculo de vários GiB.
  if (
    params.logN < 10 ||
    params.logN > 20 ||
    params.r < 1 ||
    params.r > 16 ||
    params.p < 1 ||
    params.p > 16
  ) {
    return false;
  }
  const actual = await derive(password, Buffer.from(salt ?? '', 'base64url'), params);
  const wanted = Buffer.from(expected ?? '', 'base64url');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

let dummyHash: Promise<string> | undefined;

/**
 * Um cálculo de mesmo custo para quando não há conta (e-mail desconhecido): o tempo da resposta não diz se o e-mail
 * existe. O hash fictício é gerado uma vez por processo, com uma senha aleatória.
 */
export async function burnPasswordCheck(password: string): Promise<false> {
  await verifyPassword(password, await dummyPasswordHash());
  return false;
}

/** Gera o hash fictício já na partida, para nem o primeiro e-mail desconhecido levar o dobro do tempo. */
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64url'));
  return dummyHash;
}
