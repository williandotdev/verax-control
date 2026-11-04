import { randomBytes } from 'node:crypto';

/** Alfabeto Crockford base32 do ULID (sem I, L, O e U). */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * ULID (https://github.com/ulid/spec): 10 caracteres de tempo em milissegundos mais 16 aleatórios, ordenável por
 * criação e seguro para id de documento. Implementado aqui (20 linhas) em vez de trazer um pacote: a parte
 * aleatória usa `randomBytes`, e cada byte vira um caractere por `& 31`, sem viés (256 é múltiplo de 32).
 */
export function newUlid(timeMs: number = Date.now()): string {
  if (!Number.isInteger(timeMs) || timeMs < 0 || timeMs > 2 ** 48 - 1) {
    throw new RangeError('tempo fora do intervalo do ULID');
  }
  let time = timeMs;
  let timePart = '';
  for (let i = 0; i < 10; i += 1) {
    timePart = ALPHABET[time % 32] + timePart;
    time = Math.floor(time / 32);
  }
  let randomPart = '';
  for (const byte of randomBytes(16)) {
    randomPart += ALPHABET[byte & 31];
  }
  return timePart + randomPart;
}
