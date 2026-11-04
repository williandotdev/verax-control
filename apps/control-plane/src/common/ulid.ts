import { randomBytes } from 'node:crypto';

/** Alfabeto Crockford base32 do ULID (sem I, L, O e U). */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** A parte aleatória tem 80 bits; este é o maior valor dela. */
const RANDOM_MAX = (1n << 80n) - 1n;

let lastTimeMs = -1;
let lastRandom = 0n;

function encode(value: bigint, length: number): string {
  let rest = value;
  let text = '';
  for (let i = 0; i < length; i += 1) {
    text = ALPHABET[Number(rest % 32n)] + text;
    rest /= 32n;
  }
  return text;
}

/**
 * ULID (https://github.com/ulid/spec): 10 caracteres de tempo em milissegundos mais 16 aleatórios, ordenável por
 * criação e seguro para id de documento. Implementado aqui em vez de trazer um pacote. A parte aleatória vem de
 * `randomBytes`; no mesmo milissegundo, dentro do mesmo processo, ela é incrementada (o modo monotônico da
 * especificação), para que dois ids do mesmo instante saiam na ordem em que foram pedidos: `transitions` e
 * `auditLog` usam o id como desempate da ordenação por `at`, e o relógio falso dos testes não anda sozinho.
 */
export function newUlid(timeMs: number = Date.now()): string {
  if (!Number.isInteger(timeMs) || timeMs < 0 || timeMs > 2 ** 48 - 1) {
    throw new RangeError('tempo fora do intervalo do ULID');
  }
  let random: bigint;
  if (timeMs === lastTimeMs && lastRandom < RANDOM_MAX) {
    random = lastRandom + 1n;
  } else {
    random = randomBytes(10).reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
  }
  lastTimeMs = timeMs;
  lastRandom = random;
  return encode(BigInt(timeMs), 10) + encode(random, 16);
}
