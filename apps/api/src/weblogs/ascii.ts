/** Classes de caractere ASCII por código: a entrada do log é varrida caractere a caractere, sem regex. */

export const isDigit = (code: number): boolean => code >= 48 && code <= 57;
export const isUpper = (code: number): boolean => code >= 65 && code <= 90;
export const isLower = (code: number): boolean => code >= 97 && code <= 122;
export const isAlpha = (code: number): boolean => isUpper(code) || isLower(code);
export const isAlnum = (code: number): boolean => isDigit(code) || isAlpha(code);
export const isPrintable = (code: number): boolean => code >= 0x20 && code <= 0x7e;

/** O valor de um algarismo hexadecimal, ou -1. */
export function hexValue(code: number): number {
  if (isDigit(code)) return code - 48;
  if (code >= 97 && code <= 102) return code - 87;
  if (code >= 65 && code <= 70) return code - 55;
  return -1;
}

export const isHex = (code: number): boolean => hexValue(code) >= 0;

/** Todo caractere passa no teste (o texto vazio, não). */
export function every(text: string, test: (code: number) => boolean): boolean {
  if (text.length === 0) return false;
  for (let i = 0; i < text.length; i += 1) if (!test(text.charCodeAt(i))) return false;
  return true;
}

/** Número inteiro decimal de até `max` algarismos, sem sinal; -1 se não for. */
export function decimal(text: string, max = 15): number {
  if (text.length === 0 || text.length > max || !every(text, isDigit)) return -1;
  return Number(text);
}
