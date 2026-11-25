/**
 * Endereço IP em palavras de 32 bits, sem regex e sem alocar: o texto vem de log e é varrido caractere a caractere. Aceita
 * o mesmo que o leitor do motor de ataques web (octeto com zero à esquerda é recusado: em alguns sistemas é octal) e mais
 * o identificador de zona do IPv6 (`fe80::1%eth0`), que é descartado.
 */

export type IpFamily = 4 | 6;

/** O maior IPv6 por extenso, com o IPv4 no fim. */
const MAX_IPV6 = 45;
/** Nome de interface com folga (o do Linux tem até 15 caracteres). */
const MAX_ZONE = 32;

const DOT = 46;
const COLON = 58;

const groups = new Uint16Array(8);

/** O IPv4 de `text[start, end)`, ou -1. */
function parseIpv4(text: string, start: number, end: number): number {
  if (end - start > 15) return -1;
  let value = 0;
  let octet = 0;
  let digits = 0;
  let dots = 0;
  for (let i = start; i < end; i += 1) {
    const code = text.charCodeAt(i);
    if (code === DOT) {
      if (digits === 0 || dots === 3) return -1;
      value = value * 256 + octet;
      octet = 0;
      digits = 0;
      dots += 1;
      continue;
    }
    if (code < 48 || code > 57 || (digits > 0 && octet === 0)) return -1;
    octet = octet * 10 + (code - 48);
    digits += 1;
    if (octet > 255) return -1;
  }
  return dots === 3 && digits > 0 ? value * 256 + octet : -1;
}

function hexValue(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  const lower = code | 32;
  return lower >= 97 && lower <= 102 ? lower - 87 : -1;
}

/** Os oito grupos de `text[0, end)` em `groups`; false se não é um IPv6. */
function parseIpv6(text: string, end: number): boolean {
  if (end < 2 || end > MAX_IPV6) return false;
  let count = 0;
  let gap = -1;
  let i = 0;
  if (text.charCodeAt(0) === COLON) {
    if (text.charCodeAt(1) !== COLON) return false;
    gap = 0;
    i = 2;
  }
  while (i < end) {
    if (count === 8) return false;
    let value = 0;
    let at = i;
    for (; at < end; at += 1) {
      const digit = hexValue(text.charCodeAt(at));
      if (digit < 0) break;
      if (at - i === 4) return false;
      value = value * 16 + digit;
    }
    if (at < end && text.charCodeAt(at) === DOT) {
      // O IPv4 embutido só vale no fim do endereço.
      const v4 = count > 6 ? -1 : parseIpv4(text, i, end);
      if (v4 < 0) return false;
      groups[count] = v4 >>> 16;
      groups[count + 1] = v4 & 0xffff;
      count += 2;
      break;
    }
    if (at === i) return false;
    groups[count] = value;
    count += 1;
    if (at === end) break;
    if (text.charCodeAt(at) !== COLON || at + 1 === end) return false;
    if (text.charCodeAt(at + 1) === COLON) {
      if (gap >= 0) return false;
      gap = count;
      i = at + 2;
    } else {
      i = at + 1;
    }
  }
  if (gap < 0) return count === 8;
  // O `::` vale ao menos um grupo.
  if (count === 8) return false;
  for (let k = 7, from = count - 1; k >= gap; k -= 1, from -= 1) {
    groups[k] = from >= gap ? (groups[from] ?? 0) : 0;
  }
  return true;
}

/** O fim do endereço, sem a zona; -1 se a zona não tem forma de nome de interface. */
function zoneStart(text: string): number {
  const percent = text.indexOf('%');
  if (percent < 0) return text.length;
  const size = text.length - percent - 1;
  if (size < 1 || size > MAX_ZONE) return -1;
  for (let i = percent + 1; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) return -1;
  }
  return percent;
}

/**
 * Lê o endereço para `words` (quatro posições: o IPv4 usa a primeira) e devolve a família; 0 se não é um endereço. O IPv4
 * mapeado em IPv6 (`::ffff:192.0.2.1`) sai como IPv4.
 */
export function parseIp(text: string, words: Uint32Array): IpFamily | 0 {
  if (text.length > MAX_IPV6 + 1 + MAX_ZONE) return 0;
  if (!text.includes(':')) {
    const v4 = parseIpv4(text, 0, text.length);
    if (v4 < 0) return 0;
    words[0] = v4;
    return 4;
  }
  if (!parseIpv6(text, zoneStart(text))) return 0;
  for (let i = 0; i < 4; i += 1) words[i] = (groups[2 * i] ?? 0) * 0x1_0000 + (groups[2 * i + 1] ?? 0);
  if (words[0] === 0 && words[1] === 0 && words[2] === 0xffff) {
    words[0] = words[3] ?? 0;
    return 4;
  }
  return 6;
}
