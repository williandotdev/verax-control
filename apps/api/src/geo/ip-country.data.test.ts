import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ISO_3166_1_ALPHA_2, resolveCountryCode, SPECIAL_CODES } from './country-codes.js';
import { IP_COUNTRY_META } from './data/ip-country-meta.js';
import { loadIpCountry } from './ip-country.js';
import { decodeTables, RESERVED_V4, RESERVED_V6 } from './ip-country-format.js';

/** O arquivo que vai na imagem. Depois de atualizar os dados, é este teste que diz se a tabela nova presta. */
const file = readFileSync(new URL('./data/ip-country.bin.gz', import.meta.url));
const content = gunzipSync(file);
const tables = decodeTables(content);
const lookup = loadIpCountry();
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe('arquivo e metadados', () => {
  it('são do mesmo gerador, e o arquivo não leva data nem sistema', () => {
    expect(sha256(file)).toBe(IP_COUNTRY_META.sha256);
    expect(sha256(content)).toBe(IP_COUNTRY_META.contentSha256);
    expect([...file.subarray(0, 10)]).toEqual([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 255]);
    expect(IP_COUNTRY_META.formatVersion).toBe(1);
    expect(IP_COUNTRY_META.counts).toEqual({
      codes: tables.codes.length - 1,
      v4Boundaries: tables.v4Starts.length,
      v6Boundaries: tables.v6Low.length,
    });
    expect(IP_COUNTRY_META.sources.map(({ name }) => name)).toEqual([
      'user-country-ipv4.csv',
      'user-country-ipv6.csv',
    ]);
    for (const source of IP_COUNTRY_META.sources) {
      expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(source.ranges).toBeGreaterThan(150_000);
    }
  });

  it('a data de geração é legível e não está no futuro', () => {
    expect(new Date(IP_COUNTRY_META.generatedAt).toISOString()).toBe(IP_COUNTRY_META.generatedAt);
    expect(Date.parse(IP_COUNTRY_META.generatedAt)).toBeLessThanOrEqual(Date.now());
    expect(lookup.generatedAt).toBe(IP_COUNTRY_META.generatedAt);
  });

  it('cabe no orçamento: menos de 1 MB no repositório e de 8 MB em memória', () => {
    expect(file.length).toBeLessThan(1024 * 1024);
    const bytes = [tables.v4Starts, tables.v4Codes, tables.v6High, tables.v6Low, tables.v6Codes].reduce(
      (sum, array) => sum + array.byteLength,
      0,
    );
    expect(bytes).toBeLessThan(8 * 1024 * 1024);
  });
});

describe('estrutura', () => {
  it('IPv4: começa no zero, inícios crescentes, índices válidos e vizinhas diferentes', () => {
    const { v4Starts, v4Codes, codes } = tables;
    expect(v4Codes.length).toBe(v4Starts.length);
    expect(v4Starts[0]).toBe(0);
    let bad = 0;
    for (let i = 0; i < v4Starts.length; i += 1) {
      if ((v4Codes[i] ?? 255) >= codes.length) bad += 1;
      if (i === 0) continue;
      if ((v4Starts[i] ?? 0) <= (v4Starts[i - 1] ?? 0)) bad += 1;
      if (v4Codes[i] === v4Codes[i - 1]) bad += 1;
    }
    expect(bad).toBe(0);
  });

  it('IPv6: o mesmo, em prefixos /64', () => {
    const { v6High, v6Low, v6Codes, codes } = tables;
    expect([v6High.length, v6Codes.length]).toEqual([v6Low.length, v6Low.length]);
    expect([v6High[0], v6Low[0]]).toEqual([0, 0]);
    let bad = 0;
    let previous = -1n;
    for (let i = 0; i < v6Low.length; i += 1) {
      const start = (BigInt(v6High[i] ?? 0) << 32n) | BigInt(v6Low[i] ?? 0);
      if (start <= previous) bad += 1;
      previous = start;
      if ((v6Codes[i] ?? 255) >= codes.length) bad += 1;
      if (i > 0 && v6Codes[i] === v6Codes[i - 1]) bad += 1;
    }
    expect(bad).toBe(0);
  });

  it('cada fronteira é encontrada por ela mesma e pelo endereço anterior', () => {
    const { v4Starts, v4Codes, v6High, v6Low, v6Codes } = tables;
    let bad = 0;
    for (let i = 0; i < v4Starts.length; i += 1) {
      const start = v4Starts[i] ?? 0;
      if (lookup.countryOfV4(start) !== v4Codes[i]) bad += 1;
      if (i > 0 && lookup.countryOfV4(start - 1) !== v4Codes[i - 1]) bad += 1;
    }
    if (lookup.countryOfV4(0xffff_ffff) !== v4Codes.at(-1)) bad += 1;
    for (let i = 0; i < v6Low.length; i += 1) {
      const high = v6High[i] ?? 0;
      const low = v6Low[i] ?? 0;
      if (lookup.countryOfV6(high, low) !== v6Codes[i]) bad += 1;
      if (i === 0) continue;
      const before = low === 0 ? [high - 1, 0xffff_ffff] : [high, low - 1];
      if (lookup.countryOfV6(before[0] ?? 0, before[1] ?? 0) !== v6Codes[i - 1]) bad += 1;
    }
    if (lookup.countryOfV6(0xffff_ffff, 0xffff_ffff) !== v6Codes.at(-1)) bad += 1;
    expect(bad).toBe(0);
  });

  it('nenhuma fronteira com país cai dentro de uma faixa reservada', () => {
    const inside = (blocks: typeof RESERVED_V4, start: bigint): boolean =>
      blocks.some(([first, last]) => start >= first && start <= last);
    let bad = 0;
    tables.v4Starts.forEach((start, i) => {
      if (tables.v4Codes[i] !== 0 && inside(RESERVED_V4, BigInt(start))) bad += 1;
    });
    tables.v6Low.forEach((low, i) => {
      const start = (BigInt(tables.v6High[i] ?? 0) << 32n) | BigInt(low);
      if (tables.v6Codes[i] !== 0 && inside(RESERVED_V6, start)) bad += 1;
    });
    for (const [first, last] of RESERVED_V4) {
      if (lookup.countryOfV4(Number(first)) !== 0 || lookup.countryOfV4(Number(last)) !== 0) bad += 1;
    }
    for (const bound of RESERVED_V6.flat()) {
      if (lookup.countryOfV6(Number(bound >> 32n), Number(bound & 0xffff_ffffn)) !== 0) bad += 1;
    }
    expect(bad).toBe(0);
  });

  it('cobre a maior parte do IPv4 público', () => {
    const { v4Starts, v4Codes } = tables;
    let known = 0;
    for (let i = 0; i < v4Starts.length; i += 1) {
      if (v4Codes[i] !== 0) known += (v4Starts[i + 1] ?? 0x1_0000_0000) - (v4Starts[i] ?? 0);
    }
    // 3,7 bilhões de endereços públicos; a base conhece quase todos os que são anunciados.
    expect(known).toBeGreaterThan(2.8e9);
    expect(known).toBeLessThan(3.71e9);
  });
});

describe('códigos', () => {
  it('são ISO 3166-1 alpha-2 ou um especial decidido', () => {
    expect(ISO_3166_1_ALPHA_2).toHaveLength(249);
    expect([...ISO_3166_1_ALPHA_2].sort()).toEqual(ISO_3166_1_ALPHA_2);
    expect(new Set(ISO_3166_1_ALPHA_2).size).toBe(249);
    const kept = Object.values(SPECIAL_CODES).flatMap(({ code }) => code ?? []);
    const allowed = new Set([...ISO_3166_1_ALPHA_2, ...kept]);
    const codes = tables.codes.slice(1);
    expect(codes.filter((code) => code === null || !allowed.has(code))).toEqual([]);
    // Os grandes não podem sumir numa atualização.
    for (const code of ['BR', 'US', 'PT', 'AR', 'CN', 'RU', 'DE', 'IN', 'XK', 'SH'])
      expect(codes).toContain(code);
    for (const code of ['AC', 'TA', 'AN']) expect(codes).not.toContain(code);
  });

  it('o que não é ISO nem especial é desconhecido', () => {
    expect(resolveCountryCode('BR')).toBe('BR');
    expect(resolveCountryCode('XK')).toBe('XK');
    expect(resolveCountryCode('AC')).toBe('SH');
    expect(resolveCountryCode('TA')).toBe('SH');
    expect(resolveCountryCode('AN')).toBeNull();
    for (const code of ['EU', 'AP', 'ZZ', 'UK', '', 'br', 'constructor', '__proto__', 'toString']) {
      expect(resolveCountryCode(code)).toBeUndefined();
    }
    for (const { reason } of Object.values(SPECIAL_CODES)) expect(reason.length).toBeGreaterThan(20);
  });
});

/**
 * Âncoras públicas e neutras: redes de universidades e de registros nacionais, atribuídas há décadas à própria
 * instituição e anunciadas do próprio país, por isso das menos prováveis de mudar. Serviços anycast e nuvens não servem:
 * o mesmo endereço responde em vários países. Se uma atualização derrubar uma âncora, confira a fonte antes de trocá-la.
 */
describe('âncoras', () => {
  it.each([
    ['200.160.2.3', 'BR', 'NIC.br'],
    ['143.107.0.1', 'BR', 'Universidade de São Paulo'],
    ['133.11.0.1', 'JP', 'Universidade de Tóquio'],
    ['129.132.0.1', 'CH', 'ETH Zürich'],
    ['128.2.0.1', 'US', 'Carnegie Mellon'],
    ['130.216.0.1', 'NZ', 'Universidade de Auckland'],
    ['131.111.0.1', 'GB', 'Universidade de Cambridge'],
    ['137.158.0.1', 'ZA', 'Universidade da Cidade do Cabo'],
    ['2001:12ff:0:2::3', 'BR', 'NIC.br'],
    ['2001:660::1', 'FR', 'RENATER, rede acadêmica'],
    ['2001:638::1', 'DE', 'DFN, rede acadêmica'],
    ['2001:630::1', 'GB', 'Janet, rede acadêmica'],
    ['2001:200::1', 'JP', 'WIDE, rede acadêmica'],
    ['2001:388::1', 'AU', 'AARNet, rede acadêmica'],
    ['::ffff:200.160.2.3', 'BR', 'NIC.br, mapeado'],
    ['64:ff9b::200.160.2.3', 'BR', 'NIC.br, por NAT64'],
  ])('%s é %s (%s)', (ip, code) => {
    expect(lookup.countryOf(ip)).toBe(code);
  });

  it.each(['10.1.2.3', '192.0.2.1', '100.64.0.1', '::1', 'fe80::1%eth0', '2001:db8::1', 'fd12::1'])(
    '%s não tem país',
    (ip) => {
      expect(lookup.countryOf(ip)).toBeNull();
    },
  );
});
