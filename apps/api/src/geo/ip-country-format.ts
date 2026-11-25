/**
 * O formato binário da tabela de país por endereço IP e a montagem dela a partir das faixas da fonte.
 *
 * O gerador (`scripts/update-ip-country.mjs`) roda este arquivo direto no Node, que só remove os tipos: aqui não entra
 * import de outro arquivo do projeto. Em execução, só a leitura (`decodeTables`) é usada.
 *
 * A tabela é uma lista de fronteiras: cada uma diz onde uma faixa começa e o país dela (ou "sem país"), e vale até a
 * seguinte. A primeira é sempre o zero, e duas vizinhas nunca têm o mesmo país.
 * - IPv4: o endereço inteiro (32 bits).
 * - IPv6: o prefixo /64 (64 bits), a mesma chave com que o motor de ataques web conta um cliente.
 *
 * O conteúdo (antes do gzip), com os inteiros em little-endian:
 *   8 bytes   assinatura `VXIPCTRY`
 *   1 byte    versão do formato
 *   1 byte    quantidade de códigos, N
 *   2N bytes  os códigos, em ordem alfabética (o primeiro é o índice 1; o índice 0 é "sem país")
 *   4 bytes   quantidade de fronteiras IPv4
 *   4 bytes   quantidade de fronteiras IPv6
 *   IPv4      a distância de cada fronteira até a anterior (varint LEB128) e, depois, um byte de índice por fronteira
 *   IPv6      o mesmo
 */

export const FORMAT_VERSION = 1;
const MAGIC = 'VXIPCTRY';
/** Nenhuma tabela plausível passa disto (hoje, cerca de 311 mil e 354 mil). */
const MAX_BOUNDARIES = 4_000_000;
/** Teto do conteúdo descomprimido (hoje, cerca de 2,4 MB). */
export const MAX_CONTENT_BYTES = 32 * 1024 * 1024;

export interface SourceRange {
  start: bigint;
  end: bigint;
  code: string;
}

/** Onde uma faixa começa e o código dela (null é "sem país"). */
export interface Boundary {
  start: bigint;
  code: string | null;
}

type Block = readonly [first: bigint, last: bigint];

const block = (first: bigint, prefix: number, width: number): Block => [
  first,
  first + (1n << BigInt(width - prefix)) - 1n,
];
const v4Block = (a: number, b: number, c: number, prefix: number): Block =>
  block(BigInt(a) * 0x100_0000n + BigInt(b * 0x1_0000 + c * 0x100), prefix, 32);
/** `head` são os 32 primeiros bits do endereço. */
const v6Block = (head: bigint, prefix: number): Block => block(head << 32n, prefix, 64);

/**
 * Faixas sem país, qualquer que seja a fonte (registros da IANA de endereços de uso especial, RFC 6890), em ordem. Ficam
 * gravadas na tabela como "sem país": a consulta não precisa testá-las, nem pelo caminho numérico.
 */
export const RESERVED_V4: readonly Block[] = [
  v4Block(0, 0, 0, 8), // "esta rede"
  v4Block(10, 0, 0, 8), // privado
  v4Block(100, 64, 0, 10), // CGNAT
  v4Block(127, 0, 0, 8), // loopback
  v4Block(169, 254, 0, 16), // link-local
  v4Block(172, 16, 0, 12), // privado
  v4Block(192, 0, 0, 24), // protocolos do IETF
  v4Block(192, 0, 2, 24), // documentação
  v4Block(192, 88, 99, 24), // 6to4 (retirado)
  v4Block(192, 168, 0, 16), // privado
  v4Block(198, 18, 0, 15), // testes de desempenho
  v4Block(198, 51, 100, 24), // documentação
  v4Block(203, 0, 113, 24), // documentação
  v4Block(224, 0, 0, 3), // multicast, reservado e broadcast
];

const MAX_V4 = (1n << 32n) - 1n;
const MAX_U64 = (1n << 64n) - 1n;
const MAX_V6 = (1n << 128n) - 1n;

/** O mesmo, em prefixos /64. Só `2000::/3` é unicast global: o resto do IPv6 fica sem país. */
export const RESERVED_V6: readonly Block[] = [
  [0n, (0x2000_0000n << 32n) - 1n], // antes de 2000::/3 (loopback, IPv4 mapeado, NAT64)
  v6Block(0x2001_0000n, 23), // protocolos do IETF (Teredo, ORCHID, testes)
  v6Block(0x2001_0db8n, 32), // documentação
  v6Block(0x2002_0000n, 16), // 6to4
  v6Block(0x3fff_0000n, 20), // documentação
  [0x4000_0000n << 32n, MAX_U64], // depois de 2000::/3 (privado, link-local, multicast)
];

function assertSorted(ranges: readonly SourceRange[], max: bigint): void {
  let previous = -1n;
  for (const { start, end } of ranges) {
    if (start > end || end > max) throw new Error('ip-country: faixa invertida ou fora da família');
    if (start <= previous) throw new Error('ip-country: faixas fora de ordem ou sobrepostas');
    previous = end;
  }
}

/** Tira das faixas os pedaços reservados. As duas listas estão em ordem e sem sobreposição. */
function carve(ranges: readonly SourceRange[], reserved: readonly Block[]): SourceRange[] {
  const out: SourceRange[] = [];
  for (const { start, end, code } of ranges) {
    let from = start;
    for (const [first, last] of reserved) {
      if (last < from) continue;
      if (first > end) break;
      if (first > from) out.push({ start: from, end: first - 1n, code });
      from = last + 1n;
    }
    if (from <= end) out.push({ start: from, end, code });
  }
  return out;
}

/** Junta as faixas vizinhas do mesmo país e torna explícito o vazio entre as outras. */
function toBoundaries(ranges: readonly SourceRange[], max: bigint): Boundary[] {
  const out: Boundary[] = [];
  const mark = (start: bigint, code: string | null): void => {
    if (out.at(-1)?.start === start) out.pop();
    if (out.length === 0 || out.at(-1)?.code !== code) out.push({ start, code });
  };
  mark(0n, null);
  for (const { start, end, code } of ranges) {
    mark(start, code);
    if (end < max) mark(end + 1n, null);
  }
  return out;
}

export function buildV4(ranges: readonly SourceRange[], reserved = RESERVED_V4): Boundary[] {
  assertSorted(ranges, MAX_V4);
  return toBoundaries(carve(ranges, reserved), MAX_V4);
}

/** Os pedaços de um mesmo /64, somados por país. */
class SplitNet64 {
  private prefix = -1n;
  private readonly counts = new Map<string, bigint>();
  private readonly out: SourceRange[];

  constructor(out: SourceRange[]) {
    this.out = out;
  }

  add(prefix: bigint, addresses: bigint, code: string): void {
    if (prefix !== this.prefix) this.flush();
    this.prefix = prefix;
    this.counts.set(code, (this.counts.get(code) ?? 0n) + addresses);
  }

  flush(): void {
    let winner: string | null = null;
    let most = 0n;
    // O Map guarda a ordem de chegada, que é a dos endereços: no empate, fica o primeiro.
    for (const [code, addresses] of this.counts) {
      if (addresses <= most) continue;
      winner = code;
      most = addresses;
    }
    if (winner !== null) this.out.push({ start: this.prefix, end: this.prefix, code: winner });
    this.counts.clear();
  }
}

/**
 * Reduz as faixas IPv6 a prefixos /64. Um /64 dividido (faixas mais finas que /64) fica com o país que tem mais endereços
 * dentro dele; no empate, com o que aparece primeiro. O vazio não concorre: um /64 com um só país e um pedaço sem país
 * fica com o país.
 */
function toNet64(ranges: readonly SourceRange[]): SourceRange[] {
  const out: SourceRange[] = [];
  const split = new SplitNet64(out);
  for (const { start, end, code } of ranges) {
    let first = start >> 64n;
    let last = end >> 64n;
    const startsInside = (start & MAX_U64) !== 0n;
    const endsInside = (end & MAX_U64) !== MAX_U64;
    if (first === last && (startsInside || endsInside)) {
      split.add(first, end - start + 1n, code);
      continue;
    }
    if (startsInside) {
      split.add(first, MAX_U64 - (start & MAX_U64) + 1n, code);
      first += 1n;
    }
    if (endsInside) last -= 1n;
    if (first <= last) {
      split.flush();
      out.push({ start: first, end: last, code });
    }
    if (endsInside) split.add(last + 1n, (end & MAX_U64) + 1n, code);
  }
  split.flush();
  return out;
}

export function buildV6(ranges: readonly SourceRange[], reserved = RESERVED_V6): Boundary[] {
  assertSorted(ranges, MAX_V6);
  return toBoundaries(carve(toNet64(ranges), reserved), MAX_U64);
}

/** O conteúdo do arquivo, sem o gzip. A mesma entrada dá sempre os mesmos bytes. */
export function encodeTables(v4: readonly Boundary[], v6: readonly Boundary[]): Uint8Array {
  const used = new Set<string>();
  for (const table of [v4, v6]) for (const { code } of table) if (code !== null) used.add(code);
  const codes = [...used].sort();
  if (codes.length > 255) throw new Error('ip-country: mais de 255 códigos não cabem num byte');
  const indexOf = new Map<string | null, number>([[null, 0]]);
  codes.forEach((code, i) => indexOf.set(code, i + 1));

  const out: number[] = [];
  const text = (value: string): void => {
    for (let i = 0; i < value.length; i += 1) out.push(value.charCodeAt(i));
  };
  const uint32 = (value: number): void => {
    out.push(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, value >>> 24);
  };
  const varint = (value: bigint): void => {
    let rest = value;
    for (; rest > 0x7fn; rest >>= 7n) out.push(Number(rest & 0x7fn) | 0x80);
    out.push(Number(rest));
  };
  text(MAGIC);
  out.push(FORMAT_VERSION, codes.length);
  codes.forEach(text);
  uint32(v4.length);
  uint32(v6.length);
  for (const table of [v4, v6]) {
    let previous = 0n;
    for (const { start } of table) {
      varint(start - previous);
      previous = start;
    }
    for (const { code } of table) out.push(indexOf.get(code) ?? 0);
  }
  return Uint8Array.from(out);
}

/** A tabela em memória, em arrays tipados: cerca de 1,5 MB (IPv4) e 3 MB (IPv6), fora do heap do V8. */
export interface IpCountryTables {
  /** O código de cada índice; o índice 0 ("sem país") é null. */
  codes: readonly (string | null)[];
  v4Starts: Uint32Array;
  v4Codes: Uint8Array;
  /** O prefixo /64 em duas palavras de 32 bits. */
  v6High: Uint32Array;
  v6Low: Uint32Array;
  v6Codes: Uint8Array;
}

const corrupt = (detail: string): Error => new Error(`ip-country: dados corrompidos (${detail})`);

class Reader {
  at = 0;
  readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get remaining(): number {
    return this.bytes.length - this.at;
  }

  byte(): number {
    const value = this.bytes[this.at];
    if (value === undefined) throw corrupt('conteúdo truncado');
    this.at += 1;
    return value;
  }

  uint32(): number {
    return (this.byte() | (this.byte() << 8) | (this.byte() << 16) | (this.byte() << 24)) >>> 0;
  }

  /** Uma cópia dos próximos bytes. */
  take(count: number): Uint8Array {
    if (this.remaining < count) throw corrupt('conteúdo truncado');
    this.at += count;
    return new Uint8Array(this.bytes.subarray(this.at - count, this.at));
  }
}

function readCodes(reader: Reader): (string | null)[] {
  const codes: (string | null)[] = [null];
  const count = reader.byte();
  let previous = '';
  for (let i = 0; i < count; i += 1) {
    const first = reader.byte();
    const second = reader.byte();
    if (first < 65 || first > 90 || second < 65 || second > 90) throw corrupt('código de país');
    const code = String.fromCharCode(first, second);
    if (code <= previous) throw corrupt('códigos fora de ordem');
    previous = code;
    codes.push(code);
  }
  return codes;
}

function readCount(reader: Reader): number {
  const count = reader.uint32();
  if (count < 1 || count > MAX_BOUNDARIES) throw corrupt('quantidade de fronteiras');
  return count;
}

/**
 * Os inícios, pela soma das distâncias, em 64 bits sem BigInt. Sem `high`, a família é de 32 bits. É o laço da carga: lê os
 * bytes direto, e não por `reader.byte()`.
 */
function readStarts(reader: Reader, low: Uint32Array, high: Uint32Array | null): void {
  const { bytes } = reader;
  let { at } = reader;
  let currentLow = 0;
  let currentHigh = 0;
  for (let i = 0; i < low.length; i += 1) {
    let a = 0; // bits 0 a 27 da distância
    let b = 0; // bits 28 a 55
    let c = 0; // bits 56 em diante
    for (let group = 0, more = true; more; group += 1) {
      if (group === 10) throw corrupt('distância longa demais');
      if (at >= bytes.length) throw corrupt('conteúdo truncado');
      const byte = bytes[at] ?? 0;
      at += 1;
      const bits = byte & 0x7f;
      if (group < 4) a |= bits << (7 * group);
      else if (group < 8) b |= bits << (7 * (group - 4));
      else c |= bits << (7 * (group - 8));
      more = byte > 0x7f;
    }
    if (c > 0xff) throw corrupt('distância longa demais');
    const deltaLow = (a | (b << 28)) >>> 0;
    const deltaHigh = ((b >>> 4) | (c << 24)) >>> 0;
    const zero = deltaLow === 0 && deltaHigh === 0;
    if (i === 0 && !zero) throw corrupt('a primeira fronteira não é o zero');
    if (i > 0 && zero) throw corrupt('inícios fora de ordem');
    const sum = currentLow + deltaLow;
    currentLow = sum >>> 0;
    currentHigh += deltaHigh + (sum > 0xffff_ffff ? 1 : 0);
    if (currentHigh > (high === null ? 0 : 0xffff_ffff)) throw corrupt('início fora da família');
    low[i] = currentLow;
    if (high !== null) high[i] = currentHigh;
  }
  reader.at = at;
}

/** O índice de país de cada fronteira: existe na lista e é diferente do da vizinha. */
function readIndexes(reader: Reader, count: number, codeCount: number): Uint8Array {
  const indexes = reader.take(count);
  let previous = -1;
  for (let i = 0; i < count; i += 1) {
    const index = indexes[i] ?? 0;
    if (index >= codeCount) throw corrupt('índice de país fora da lista');
    if (index === previous) throw corrupt('fronteiras vizinhas do mesmo país');
    previous = index;
  }
  return indexes;
}

/** Lê o conteúdo e confere a estrutura inteira; lança se algo não bate. */
export function decodeTables(content: Uint8Array): IpCountryTables {
  const reader = new Reader(content);
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (reader.byte() !== MAGIC.charCodeAt(i)) throw corrupt('assinatura');
  }
  if (reader.byte() !== FORMAT_VERSION) throw corrupt('versão do formato');
  const codes = readCodes(reader);
  const v4Count = readCount(reader);
  const v6Count = readCount(reader);
  // Cada fronteira ocupa ao menos dois bytes: a quantidade declarada não aloca o que o conteúdo não justifica.
  if (reader.remaining < 2 * (v4Count + v6Count)) throw corrupt('conteúdo truncado');

  const v4Starts = new Uint32Array(v4Count);
  readStarts(reader, v4Starts, null);
  const v4Codes = readIndexes(reader, v4Count, codes.length);
  const v6High = new Uint32Array(v6Count);
  const v6Low = new Uint32Array(v6Count);
  readStarts(reader, v6Low, v6High);
  const v6Codes = readIndexes(reader, v6Count, codes.length);
  if (reader.remaining !== 0) throw corrupt('sobra no fim do conteúdo');
  return { codes, v4Starts, v4Codes, v6High, v6Low, v6Codes };
}
