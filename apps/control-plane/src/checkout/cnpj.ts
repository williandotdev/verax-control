/**
 * CNPJ no formato alfanumérico da Receita Federal (o numérico antigo é um caso particular): 14 posições, as 12
 * primeiras `[A-Z0-9]` (raiz e ordem do estabelecimento) e 2 dígitos verificadores numéricos. O valor de cada
 * caractere no cálculo é o código ASCII menos 48 (`0`..`9` valem 0..9, `A` vale 17, `Z` vale 42), com os pesos e o
 * módulo 11 de sempre: resto menor que 2 dá dígito 0; senão, 11 menos o resto.
 */
const CNPJ_PATTERN = /^[A-Z0-9]{12}[0-9]{2}$/;
/** Pontuação da máscara `12.ABC.345/01DE-35`, retirada antes da validação. Classe única: tempo linear. */
const MASK_PUNCTUATION = /[./-]/g;

const FIRST_DIGIT_WEIGHTS = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] as const;
const SECOND_DIGIT_WEIGHTS = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] as const;

/** Teto do texto recebido (com máscara e espaços), antes de qualquer processamento. */
export const CNPJ_INPUT_MAX_LENGTH = 32;

function checkDigit(chars: string, weights: readonly number[]): number {
  let sum = 0;
  weights.forEach((weight, index) => {
    sum += (chars.charCodeAt(index) - 48) * weight;
  });
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

/** Os dois dígitos verificadores das 12 primeiras posições (já em maiúsculas). */
export function cnpjCheckDigits(base: string): string {
  if (!/^[A-Z0-9]{12}$/.test(base)) throw new RangeError('a base do CNPJ tem 12 posições [A-Z0-9]');
  const first = checkDigit(base, FIRST_DIGIT_WEIGHTS);
  const second = checkDigit(`${base}${first}`, SECOND_DIGIT_WEIGHTS);
  return `${first}${second}`;
}

/** Tira espaços nas pontas e a pontuação da máscara; letras viram maiúsculas. Não valida. */
export function normalizeCnpj(value: string): string {
  return value.trim().replace(MASK_PUNCTUATION, '').toUpperCase();
}

/**
 * `true` para um CNPJ já normalizado com formato e dígitos verificadores corretos. Catorze caracteres iguais
 * (`00000000000000`) são recusados, como nos validadores da Receita, mesmo quando o cálculo fecha.
 */
export function isValidCnpj(cnpj: string): boolean {
  if (!CNPJ_PATTERN.test(cnpj)) return false;
  if ([...cnpj].every((char) => char === cnpj[0])) return false;
  return cnpjCheckDigits(cnpj.slice(0, 12)) === cnpj.slice(12);
}
