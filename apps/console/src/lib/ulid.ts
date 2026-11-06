/** Alfabeto Crockford base32 do ULID (sem I, L, O e U), o mesmo do plano de controle. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Um ULID (https://github.com/ulid/spec): 10 caracteres do instante em milissegundos e 16 aleatórios, do
 * `crypto.getRandomValues` do navegador. É a chave de idempotência do cadastro de um cliente (o id dele na API): gerada
 * uma vez por formulário aberto, então o mesmo envio repetido (clique duplo, resposta perdida) cria um cliente só.
 */
export function newUlid(timeMs: number = Date.now()): string {
  let time = '';
  let rest = Math.floor(timeMs);
  for (let index = 0; index < 10; index += 1) {
    time = (ALPHABET[rest % 32] ?? '0') + time;
    rest = Math.floor(rest / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let random = '';
  for (const byte of bytes) random += ALPHABET[byte % 32] ?? '0';
  return time + random;
}

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
