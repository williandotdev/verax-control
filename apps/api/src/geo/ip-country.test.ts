import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type IpCountry, IP_COUNTRY_MAX_AGE_DAYS, type IpCountryMeta, openIpCountry } from './ip-country.js';
import { buildV4, buildV6, encodeTables } from './ip-country-format.js';

const DAY = 24 * 60 * 60_000;
const GENERATED = '2026-11-24T12:00:00.000Z';
const T0 = Date.parse(GENERATED);

const v4 = (text: string): bigint =>
  BigInt(text.split('.').reduce((sum, octet) => sum * 256 + Number(octet), 0));
/** As faixas da fonte cobrem de propósito os endereços reservados: quem os tira é a tabela. */
const content = encodeTables(
  buildV4([
    { start: 0n, end: v4('99.255.255.255'), code: 'BR' },
    { start: v4('100.0.0.0'), end: v4('255.255.255.255'), code: 'US' },
  ]),
  buildV6([
    { start: 0n, end: (0x2a00n << 112n) - 1n, code: 'JP' },
    { start: 0x2a00n << 112n, end: (1n << 128n) - 1n, code: 'FR' },
  ]),
);

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const meta = (file: Uint8Array, generatedAt = GENERATED): IpCountryMeta => ({
  formatVersion: 1,
  generatedAt,
  sources: [],
  counts: { codes: 4, v4Boundaries: 0, v6Boundaries: 0 },
  sha256: sha256(file),
  contentSha256: sha256(content),
});
const file = gzipSync(content);
const open = (generatedAt?: string): IpCountry => openIpCountry(file, meta(file, generatedAt));
const lookup = open();

describe('countryOf', () => {
  it.each([
    ['8.8.8.8', 'BR'],
    ['99.255.255.255', 'BR'],
    ['100.0.0.0', 'US'],
    ['223.255.255.255', 'US'],
    ['2000::', 'JP'],
    ['2001:200::1', 'JP'],
    ['29ff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'JP'],
    ['2a00::', 'FR'],
    ['3ffe:ffff::', 'FR'],
    // O IPv4 dentro do IPv6, por extenso e em hexadecimal.
    ['::ffff:8.8.8.8', 'BR'],
    ['::FFFF:6400:1', 'US'],
    ['0:0:0:0:0:ffff:100.0.0.1', 'US'],
    ['64:ff9b::8.8.8.8', 'BR'],
    ['64:ff9b::6400:1', 'US'],
    ['2a00::1%eth0', 'FR'],
    ['::ffff:8.8.8.8%1', 'BR'],
  ])('%s é %s', (ip, code) => {
    expect(lookup.countryOf(ip)).toBe(code);
  });

  it.each([
    // "Esta rede", privado, CGNAT, loopback, link-local.
    ...['0.0.0.0', '0.255.255.255', '10.0.0.0', '10.255.255.255', '100.64.0.0', '100.127.255.255'],
    ...['127.0.0.1', '127.255.255.255', '169.254.0.0', '169.254.169.254', '172.16.0.0', '172.31.255.255'],
    ...['192.168.0.0', '192.168.255.255'],
    // IETF, documentação, 6to4, testes, multicast, reservado, broadcast.
    ...['192.0.0.1', '192.0.2.0', '192.0.2.255', '198.51.100.1', '203.0.113.255', '192.88.99.1'],
    ...['198.18.0.0', '198.19.255.255', '224.0.0.1', '239.255.255.255', '240.0.0.0', '255.255.255.255'],
    // IPv6: nada fora de 2000::/3, nem as faixas especiais de dentro.
    ...['::', '::1', '::8.8.8.8', '100::1', '1fff:ffff::', '4000::', '5f00::1', 'fc00::1', 'fd00::1'],
    ...['fe80::1', 'fe80::1%eth0', 'fec0::1', 'ff02::1', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ...['2001::1', '2001:1ff:ffff::', '2001:db8::1', '2001:db8:ffff:ffff::', '2002:808:808::1', '3fff::1'],
    // O IPv4 embutido continua reservado.
    ...['::ffff:10.0.0.1', '::ffff:127.0.0.1', '64:ff9b::192.168.0.1', '64:ff9b::ffff:ffff'],
    // Não é o prefixo do NAT64, e o NAT64 de uso local é privado.
    ...['64:ff9b:0:1::8.8.8.8', '64:ff9b::1:8.8.8.8', '64:ff9b:1::8.8.8.8', '64:ff9a::8.8.8.8'],
    // Zero à esquerda é recusado, e não lido como octal.
    ...['010.0.0.1', '8.8.8.08', '08.8.8.8'],
    ...['', ' ', 'x', 'localhost', '8.8.8.8 ', '8.8.8.8\0', '8.8.8.8:443', '[2a00::1]', '2a00::1/64'],
    ...['8.8.8.8%eth0', '8.8.8', '134744072', '0x08080808', '٨.٨.٨.٨', '８.８.８.８'],
    ...['9'.repeat(1_000_000), ':'.repeat(1_000_000), '\0'.repeat(1_000)],
  ])('%j não tem país', (ip) => {
    expect(lookup.countryOf(ip)).toBeNull();
  });

  it('nunca lança, nem com o que não é texto', () => {
    const values: unknown[] = [undefined, null, 0, NaN, {}, [], Symbol('x'), ['8.8.8.8'], 134744072n];
    for (const value of values) {
      expect(lookup.countryOf(value as string)).toBeNull();
    }
  });

  it('uma consulta não deixa resto para a seguinte', () => {
    expect(lookup.countryOf('2a00::ffff:1')).toBe('FR');
    expect(lookup.countryOf('8.8.8.8')).toBe('BR');
    expect(lookup.countryOf('2a00::1')).toBe('FR');
    expect(lookup.countryOf('garbage')).toBeNull();
  });
});

describe('caminho numérico', () => {
  it('devolve o índice, e `code` o código', () => {
    expect(lookup.size).toBe(5);
    expect([0, 1, 2, 3, 4].map((index) => lookup.code(index))).toEqual([null, 'BR', 'FR', 'JP', 'US']);
    expect(lookup.code(lookup.countryOfV4(0x08080808))).toBe('BR');
    expect(lookup.countryOfV4(0x0a000001)).toBe(0);
    expect(lookup.code(lookup.countryOfV6(0x2a000000, 1))).toBe('FR');
    expect(lookup.code(lookup.countryOfV6(0x29ffffff, 0xffffffff))).toBe('JP');
    expect(lookup.countryOfV6(0x20010db8, 0xffffffff)).toBe(0);
  });

  it('a palavra com sinal é o mesmo endereço', () => {
    expect(lookup.countryOfV4(0xdfffffff | 0)).toBe(lookup.countryOfV4(0xdfffffff));
    expect(lookup.countryOfV6(0x2a000000, -1)).toBe(lookup.countryOfV6(0x2a000000, 0xffffffff));
    expect(lookup.countryOfWords(0, 0, 0xffff, 0xdfffffff | 0)).toBe(lookup.countryOfV4(0xdfffffff));
  });

  it('quatro palavras: o IPv4 mapeado e o NAT64 valem pelo IPv4; o prefixo sozinho não tem como', () => {
    const us = lookup.countryOfV4(0xdf000001);
    expect(us).toBeGreaterThan(0);
    expect(lookup.countryOfWords(0, 0, 0xffff, 0xdf000001)).toBe(us);
    expect(lookup.countryOfWords(0x64ff9b, 0, 0, 0xdf000001)).toBe(us);
    expect(lookup.countryOfWords(0x64ff9b, 0, 1, 0xdf000001)).toBe(0);
    expect(lookup.countryOfWords(0x64ff9b, 1, 0, 0xdf000001)).toBe(0);
    expect(lookup.countryOfWords(0, 0, 0, 0xdf000001)).toBe(0);
    expect(lookup.countryOfWords(0, 1, 0xffff, 0xdf000001)).toBe(0);
    expect(lookup.countryOfV6(0, 0)).toBe(0);
    expect(lookup.countryOfV6(0x64ff9b, 0)).toBe(0);
  });

  it('entrada absurda não lança nem sai da lista', () => {
    for (const value of [NaN, Infinity, -Infinity, 1.5, -0, 2 ** 53, undefined as unknown as number]) {
      for (const index of [
        lookup.countryOfV4(value),
        lookup.countryOfV6(value, value),
        lookup.countryOfWords(value, value, value, value),
      ]) {
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(lookup.size);
      }
    }
    for (const index of [-1, 5, 255, 1.5, NaN, Infinity]) expect(lookup.code(index)).toBeNull();
  });
});

describe('idade da tabela', () => {
  it('é contada da geração e nunca é negativa', () => {
    expect(lookup.generatedAt).toBe(GENERATED);
    expect(lookup.ageDays(T0)).toBe(0);
    expect(lookup.ageDays(T0 + 1.5 * DAY)).toBe(1.5);
    expect(lookup.ageDays(T0 - 10 * DAY)).toBe(0);
  });

  it('vence depois de 180 dias', () => {
    expect(IP_COUNTRY_MAX_AGE_DAYS).toBe(180);
    expect(lookup.isStale(T0)).toBe(false);
    expect(lookup.isStale(T0 + 180 * DAY)).toBe(false);
    expect(lookup.isStale(T0 + 180 * DAY + 1)).toBe(true);
    expect(lookup.isStale(T0 - DAY)).toBe(false);
  });

  it('sem data legível, avisa', () => {
    expect(open('ontem').isStale(T0)).toBe(true);
    expect(lookup.isStale(NaN)).toBe(true);
  });
});

describe('abertura', () => {
  it('o objeto não muda', () => {
    expect(Object.isFrozen(lookup)).toBe(true);
    expect(() => Object.assign(lookup, { generatedAt: 'x' })).toThrow(TypeError);
  });

  it('um byte trocado em qualquer lugar, ou o arquivo cortado, para no SHA-256', () => {
    const expected = meta(file);
    for (let i = 0; i < file.length; i += 1) {
      const flipped = Uint8Array.from(file);
      flipped[i] = (flipped[i] ?? 0) ^ 1;
      expect(() => openIpCountry(flipped, expected)).toThrow(/SHA-256/);
    }
    expect(() => openIpCountry(file.subarray(0, -1), expected)).toThrow(/SHA-256/);
    expect(() => openIpCountry(new Uint8Array(), expected)).toThrow(/SHA-256/);
    expect(() => openIpCountry(file, { ...expected, sha256: '' })).toThrow(/SHA-256/);
  });

  it('com o SHA-256 certo, a estrutura ainda é conferida', () => {
    const opens = (bytes: Uint8Array): IpCountry => openIpCountry(bytes, meta(bytes));
    expect(() => opens(content)).toThrow(); // sem o gzip
    expect(() => opens(file.subarray(0, -4))).toThrow(); // gzip cortado
    expect(() => opens(gzipSync(content.subarray(0, -1)))).toThrow(/truncado/);
    // Bomba de compressão.
    expect(() => opens(gzipSync(new Uint8Array(33 * 1024 * 1024)))).toThrow(/larger than/);
  });
});

describe('loadIpCountry', () => {
  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it('só lê o arquivo quando é chamada, e uma vez', async () => {
    const real = await vi.importActual<typeof import('node:fs')>('node:fs');
    const readFileSync = vi.fn(real.readFileSync);
    vi.resetModules();
    vi.doMock('node:fs', () => ({ ...real, readFileSync }));
    const fresh = await import('./ip-country.js');
    expect(readFileSync).not.toHaveBeenCalled();
    const first = fresh.loadIpCountry();
    expect(fresh.loadIpCountry()).toBe(first);
    expect(readFileSync).toHaveBeenCalledTimes(1);
  });

  it('sem o arquivo, ou com ele corrompido, lança; e não guarda a falha', async () => {
    const real = await vi.importActual<typeof import('node:fs')>('node:fs');
    const readFileSync = vi.fn<(path: URL) => Uint8Array>();
    vi.resetModules();
    vi.doMock('node:fs', () => ({ ...real, readFileSync }));
    const fresh = await import('./ip-country.js');
    readFileSync.mockImplementationOnce(() => {
      throw new Error('ENOENT: ip-country.bin.gz');
    });
    expect(() => fresh.loadIpCountry()).toThrow(/ENOENT/);
    readFileSync.mockImplementationOnce(() => new Uint8Array([1, 2, 3]));
    expect(() => fresh.loadIpCountry()).toThrow(/SHA-256/);
    readFileSync.mockImplementationOnce((path) => real.readFileSync(path));
    expect(fresh.loadIpCountry().size).toBeGreaterThan(1);
  });
});
