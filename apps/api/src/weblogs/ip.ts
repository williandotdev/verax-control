import { decimal, hexValue } from './ascii.js';

/**
 * Endereços IP sem regex. O cliente de um ALB é identificado pelo IPv4 inteiro ou pelo prefixo /64 do IPv6: quem tem um
 * /64 tem 2^64 endereços, e trocar de endereço dentro dele não pode zerar a contagem.
 */

export interface Ip {
  version: 4 | 6;
  /** O endereço em palavras de 32 bits: uma no IPv4, quatro no IPv6. */
  words: readonly number[];
}

export interface Cidr extends Ip {
  prefix: number;
}

function parseIpv4(text: string): number | null {
  let value = 0;
  let parts = 0;
  let start = 0;
  for (let i = 0; i <= text.length; i += 1) {
    if (i < text.length && text.charCodeAt(i) !== 46) continue;
    const part = text.slice(start, i);
    const octet = decimal(part, 3);
    // Zero à esquerda é ambíguo (octal em alguns sistemas): recusado.
    if (octet < 0 || octet > 255 || (part.length > 1 && part.charCodeAt(0) === 48)) return null;
    value = value * 256 + octet;
    parts += 1;
    if (parts > 4) return null;
    start = i + 1;
  }
  return parts === 4 ? value >>> 0 : null;
}

function parseHextet(text: string): number {
  if (text.length === 0 || text.length > 4) return -1;
  let value = 0;
  for (let i = 0; i < text.length; i += 1) {
    const digit = hexValue(text.charCodeAt(i));
    if (digit < 0) return -1;
    value = value * 16 + digit;
  }
  return value;
}

/** Os grupos de 16 bits de um lado do `::`; null se algum não serve. O IPv4 embutido só vale no fim do endereço. */
function parseGroups(text: string, allowIpv4: boolean): number[] | null {
  if (text === '') return [];
  const groups: number[] = [];
  const parts = text.split(':');
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? '';
    if (allowIpv4 && i === parts.length - 1 && part.includes('.')) {
      const v4 = parseIpv4(part);
      if (v4 === null) return null;
      groups.push(v4 >>> 16, v4 & 0xffff);
      continue;
    }
    const hextet = parseHextet(part);
    if (hextet < 0) return null;
    groups.push(hextet);
  }
  return groups;
}

function parseIpv6(text: string): number[] | null {
  if (text.length > 45) return null;
  const gap = text.indexOf('::');
  let groups: number[];
  if (gap < 0) {
    const all = parseGroups(text, true);
    if (all === null || all.length !== 8) return null;
    groups = all;
  } else {
    if (text.indexOf('::', gap + 1) >= 0) return null;
    const head = parseGroups(text.slice(0, gap), false);
    const tail = parseGroups(text.slice(gap + 2), true);
    if (head === null || tail === null || head.length + tail.length > 7) return null;
    groups = [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
  }
  const words: number[] = [];
  for (let i = 0; i < 8; i += 2) words.push((((groups[i] ?? 0) << 16) | (groups[i + 1] ?? 0)) >>> 0);
  return words;
}

/** O endereço, ou null. O IPv4 mapeado em IPv6 (`::ffff:192.0.2.1`) vira IPv4. */
export function parseIp(text: string): Ip | null {
  if (text.includes(':')) {
    const words = parseIpv6(text);
    if (words === null) return null;
    if (words[0] === 0 && words[1] === 0 && words[2] === 0xffff) {
      return { version: 4, words: [words[3] ?? 0] };
    }
    return { version: 6, words };
  }
  const v4 = text.length > 15 ? null : parseIpv4(text);
  return v4 === null ? null : { version: 4, words: [v4] };
}

/** Os bits de rede da palavra `index`, com o prefixo dado. */
function maskOf(prefix: number, index: number): number {
  const bits = Math.min(32, Math.max(0, prefix - index * 32));
  return bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
}

/** A faixa CIDR, ou null. Bit de máquina diferente de zero é recusado (`192.0.2.1/24` não é uma faixa). */
export function parseCidr(text: string): Cidr | null {
  const slash = text.indexOf('/');
  if (slash < 0) return null;
  const ip = parseIp(text.slice(0, slash));
  const prefix = decimal(text.slice(slash + 1), 3);
  if (ip === null || prefix < 0 || prefix > (ip.version === 4 ? 32 : 128)) return null;
  // A faixa mapeada (`::ffff:192.0.2.0/120`) teria o prefixo na escala do IPv6: recusada.
  if (ip.version === 4 && text.includes(':')) return null;
  for (let i = 0; i < ip.words.length; i += 1) {
    const word = ip.words[i] ?? 0;
    if ((word & maskOf(prefix, i)) >>> 0 !== word) return null;
  }
  return { ...ip, prefix };
}

export function cidrContains(cidr: Cidr, ip: Ip): boolean {
  if (cidr.version !== ip.version) return false;
  for (let i = 0; i < cidr.words.length; i += 1) {
    const mask = maskOf(cidr.prefix, i);
    if (((ip.words[i] ?? 0) & mask) >>> 0 !== (cidr.words[i] ?? 0)) return false;
  }
  return true;
}

export function formatIpv4(word: number): string {
  return `${word >>> 24}.${(word >>> 16) & 255}.${(word >>> 8) & 255}.${word & 255}`;
}

/** O prefixo /64 por extenso: `2001:db8:0:1::/64`. */
function formatNet64(words: readonly number[]): string {
  const [high = 0, low = 0] = words;
  const groups = [high >>> 16, high & 0xffff, low >>> 16, low & 0xffff];
  while (groups.length > 0 && groups.at(-1) === 0) groups.pop();
  return `${groups.map((group) => group.toString(16)).join(':')}::/64`;
}

/** A identidade do cliente nas contagens: o IPv4 ou o /64 do IPv6. */
export function clientKeyOf(ip: Ip): string {
  return ip.version === 4 ? formatIpv4(ip.words[0] ?? 0) : formatNet64(ip.words);
}
