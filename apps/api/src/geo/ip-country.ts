import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { IP_COUNTRY_META } from './data/ip-country-meta.js';
import { parseIp } from './ip-address.js';
import { decodeTables, type IpCountryTables, MAX_CONTENT_BYTES } from './ip-country-format.js';

/**
 * País de um endereço IP, embutido e offline: nenhuma consulta sai para a rede. Os dados são da base pública
 * `user-country` do projeto sapics/ip-location-db (domínio público, PDDL; ver `data/README.md`) e o país é o do
 * **endereço**: atrás de VPN, proxy ou nuvem, é o de onde o endereço é anunciado, e não o da pessoa.
 *
 * O caminho quente usa os métodos numéricos, que não alocam nem criam texto: devolvem um índice (0 é "sem país"), e
 * `code(indice)` dá o código ISO 3166-1 alpha-2. Contar por país é um `Uint32Array(lookup.size)`.
 */

/** Tabela mais velha que isto é avisada. */
export const IP_COUNTRY_MAX_AGE_DAYS = 180;
const DAY_MS = 24 * 60 * 60_000;

export interface IpCountryMeta {
  formatVersion: number;
  /** Quando a tabela foi gerada (ISO 8601). */
  generatedAt: string;
  sources: readonly { name: string; sha256: string; ranges: number }[];
  counts: { codes: number; v4Boundaries: number; v6Boundaries: number };
  /** Do arquivo `ip-country.bin.gz`. */
  sha256: string;
  /** Do conteúdo, sem o gzip: não muda com a versão do zlib. */
  contentSha256: string;
}

export class IpCountry {
  readonly generatedAt: string;
  /** Quantidade de índices, com o 0. */
  readonly size: number;
  private readonly generatedMs: number;
  private readonly codes: readonly (string | null)[];
  private readonly v4Starts: Uint32Array;
  private readonly v4Codes: Uint8Array;
  private readonly v6High: Uint32Array;
  private readonly v6Low: Uint32Array;
  private readonly v6Codes: Uint8Array;
  private readonly words = new Uint32Array(4);

  constructor(tables: IpCountryTables, generatedAt: string) {
    this.generatedAt = generatedAt;
    this.generatedMs = Date.parse(generatedAt);
    this.codes = tables.codes;
    this.size = tables.codes.length;
    this.v4Starts = tables.v4Starts;
    this.v4Codes = tables.v4Codes;
    this.v6High = tables.v6High;
    this.v6Low = tables.v6Low;
    this.v6Codes = tables.v6Codes;
    Object.freeze(this);
  }

  /** O código do país de um índice; null no 0 ("sem país") e fora da lista. */
  code(index: number): string | null {
    return this.codes[index] ?? null;
  }

  /** O índice do país de um IPv4 em 32 bits. */
  countryOfV4(word: number): number {
    const key = word >>> 0;
    const starts = this.v4Starts;
    let low = 0;
    let high = starts.length;
    while (high - low > 1) {
      const middle = (low + high) >>> 1;
      if ((starts[middle] ?? 0) <= key) low = middle;
      else high = middle;
    }
    return this.v4Codes[low] ?? 0;
  }

  /**
   * O índice do país de um prefixo /64, em duas palavras de 32 bits. O IPv4 mapeado e o NAT64 não cabem num /64: para eles,
   * `countryOfWords`.
   */
  countryOfV6(first: number, second: number): number {
    const keyHigh = first >>> 0;
    const keyLow = second >>> 0;
    const highs = this.v6High;
    const lows = this.v6Low;
    let low = 0;
    let high = highs.length;
    while (high - low > 1) {
      const middle = (low + high) >>> 1;
      const head = highs[middle] ?? 0;
      if (head < keyHigh || (head === keyHigh && (lows[middle] ?? 0) <= keyLow)) low = middle;
      else high = middle;
    }
    return this.v6Codes[low] ?? 0;
  }

  /** O índice do país de um IPv6 inteiro, em quatro palavras: o IPv4 mapeado e o NAT64 (64:ff9b::/96) valem pelo IPv4. */
  countryOfWords(first: number, second: number, third: number, fourth: number): number {
    if ((second | 0) === 0) {
      if ((first | 0) === 0 && third >>> 0 === 0xffff) return this.countryOfV4(fourth);
      if (first >>> 0 === 0x0064_ff9b && (third | 0) === 0) return this.countryOfV4(fourth);
    }
    return this.countryOfV6(first, second);
  }

  /** O código do país do endereço; null se não é um endereço, se é reservado ou se a base não o conhece. Nunca lança. */
  countryOf(ip: string): string | null {
    if (typeof ip !== 'string') return null;
    const words = this.words;
    const family = parseIp(ip, words);
    if (family === 0) return null;
    const first = words[0] ?? 0;
    if (family === 4) return this.code(this.countryOfV4(first));
    return this.code(this.countryOfWords(first, words[1] ?? 0, words[2] ?? 0, words[3] ?? 0));
  }

  /** Idade da tabela em dias, em relação a `now` (milissegundos). */
  ageDays(now: number): number {
    return Math.max(0, (now - this.generatedMs) / DAY_MS);
  }

  /** Velha demais para não avisar. Com a data ilegível, também: o aviso é o lado seguro. */
  isStale(now: number): boolean {
    return !(this.ageDays(now) <= IP_COUNTRY_MAX_AGE_DAYS);
  }
}

/** Abre a tabela a partir dos bytes do arquivo; lança se eles não são exatamente os descritos por `meta`. */
export function openIpCountry(file: Uint8Array, meta: IpCountryMeta): IpCountry {
  if (createHash('sha256').update(file).digest('hex') !== meta.sha256) {
    throw new Error('ip-country: dados corrompidos (SHA-256 diferente do registrado)');
  }
  const tables = decodeTables(gunzipSync(file, { maxOutputLength: MAX_CONTENT_BYTES }));
  return new IpCountry(tables, meta.generatedAt);
}

let loaded: IpCountry | undefined;

/**
 * A tabela embutida, lida na primeira chamada (cerca de 5 MB em memória) e guardada. Lança se o arquivo falta ou está
 * corrompido; quem chama decide seguir sem o país. Síncrona: chamar ao ligar o recurso, e não num pedido.
 */
export function loadIpCountry(): IpCountry {
  if (loaded === undefined) {
    const path = new URL('./data/ip-country.bin.gz', import.meta.url);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- caminho fixo, ao lado deste módulo
    loaded = openIpCountry(readFileSync(path), IP_COUNTRY_META);
  }
  return loaded;
}
