import { describe, expect, it } from 'vitest';
import { IpCountry } from './ip-country.js';
import {
  type Boundary,
  buildV4,
  buildV6,
  decodeTables,
  encodeTables,
  RESERVED_V4,
  RESERVED_V6,
  type SourceRange,
} from './ip-country-format.js';

const M64 = (1n << 64n) - 1n;
const EMPTY: Boundary[] = [{ start: 0n, code: null }];

function prng(seed: number): (below: number) => number {
  let state = seed;
  return (below) => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000) * below);
  };
}

const open = (v4: readonly Boundary[], v6: readonly Boundary[]): IpCountry =>
  new IpCountry(decodeTables(encodeTables(v4, v6)), '2026-11-24T00:00:00.000Z');

/** Canônica: começa no zero, em ordem, e vizinhas de países diferentes. */
function expectCanonical(table: readonly Boundary[]): void {
  expect(table[0]?.start).toBe(0n);
  for (let i = 1; i < table.length; i += 1) {
    expect((table[i]?.start ?? 0n) > (table[i - 1]?.start ?? 0n)).toBe(true);
    expect(table[i]?.code).not.toBe(table[i - 1]?.code);
  }
}

describe('tabela IPv4: codificar, ler e comparar com a varredura da fonte', () => {
  // Dois pedaços pequenos do espaço, um em cada ponta: todo endereço deles é conferido.
  const SPAN = 400n;
  const TOP = (1n << 32n) - SPAN;

  it('200 tabelas aleatórias', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const random = prng(seed);
      const ranges: SourceRange[] = [];
      const reserved: [bigint, bigint][] = [];
      for (const base of [0n, TOP]) {
        for (let at = BigInt(random(3)); at < SPAN;) {
          const size = random(3) === 0 ? 1n : BigInt(1 + random(40));
          const end = at + size - 1n < SPAN ? at + size - 1n : SPAN - 1n;
          ranges.push({ start: base + at, end: base + end, code: ['AA', 'BB', 'CC'][random(3)] ?? '' });
          at = end + 1n + (random(2) === 0 ? 0n : BigInt(random(10)));
        }
        if (random(2) === 0) {
          const from = BigInt(random(300));
          reserved.push([base + from, base + from + BigInt(random(100))]);
        }
      }
      const table = buildV4(ranges, reserved);
      expectCanonical(table);
      const lookup = open(table, EMPTY);
      for (const base of [0n, TOP]) {
        for (let address = base; address < base + SPAN; address += 1n) {
          const blocked = reserved.some(([first, last]) => address >= first && address <= last);
          const hit = ranges.find(({ start, end }) => address >= start && address <= end);
          const expected = blocked ? null : (hit?.code ?? null);
          const got = lookup.code(lookup.countryOfV4(Number(address)));
          if (got !== expected) expect([seed, address, got]).toEqual([seed, address, expected]);
        }
      }
    }
  });

  it('o endereço mais baixo, o mais alto e a vizinhança exata', () => {
    const lookup = open(
      buildV4(
        [
          { start: 0n, end: 0n, code: 'AA' },
          { start: 2n, end: 3n, code: 'BB' },
          { start: 4n, end: 9n, code: 'BB' },
          { start: 0xffff_ffffn, end: 0xffff_ffffn, code: 'CC' },
        ],
        [],
      ),
      EMPTY,
    );
    const at = (word: number): string | null => lookup.code(lookup.countryOfV4(word));
    expect([0, 1, 2, 3, 4, 9, 10, 0xffff_fffe, 0xffff_ffff].map(at)).toEqual([
      'AA',
      null,
      'BB',
      'BB',
      'BB',
      'BB',
      null,
      null,
      'CC',
    ]);
    // A palavra com sinal é o mesmo endereço.
    expect(at(-1)).toBe('CC');
  });

  it('a faixa que cobre o espaço inteiro perde só os endereços reservados', () => {
    const table = buildV4([{ start: 0n, end: 0xffff_ffffn, code: 'AA' }]);
    const gaps = table.filter(({ code }) => code === null);
    // 192.0.0.0/24 e 192.0.2.0/24 são faixas separadas; nenhuma das 14 encosta na outra.
    expect(gaps).toHaveLength(RESERVED_V4.length);
    expect(gaps.map(({ start }) => start)).toEqual(RESERVED_V4.map(([first]) => first));
  });
});

describe('tabela IPv6: codificar, ler e comparar com a varredura da fonte', () => {
  const SPAN = 60n;
  /** O país de um /64 pela definição: mais endereços; no empate, o que aparece primeiro; o vazio não concorre. */
  function naive(ranges: readonly SourceRange[], prefix: bigint): string | null {
    const first = prefix << 64n;
    const totals: { code: string; count: bigint }[] = [];
    for (const { start, end, code } of ranges) {
      const from = start > first ? start : first;
      const to = end < (first | M64) ? end : first | M64;
      if (from > to) continue;
      const total = totals.find((entry) => entry.code === code);
      if (total === undefined) totals.push({ code, count: to - from + 1n });
      else total.count += to - from + 1n;
    }
    let best: { code: string; count: bigint } | null = null;
    for (const total of totals) if (best === null || total.count > best.count) best = total;
    return best?.code ?? null;
  }

  it('200 tabelas aleatórias, com faixas mais finas que /64', () => {
    // Nas pontas do espaço e onde a soma das distâncias muda de palavra.
    const bases = [0n, (1n << 32n) - 30n, (7n << 32n) - 1n, (1n << 63n) - 30n, (1n << 64n) - SPAN];
    let split = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const random = prng(seed);
      const low = (): bigint => {
        const kind = random(6);
        if (kind < 2) return 0n;
        if (kind === 2) return M64;
        if (kind === 3) return 1n << 63n;
        return kind === 4 ? BigInt(random(5)) : (BigInt(random(0xffff)) << 48n) | 0xffffn;
      };
      const ranges: SourceRange[] = [];
      for (const base of bases) {
        const limit = ((base + SPAN) << 64n) - 1n;
        for (let at = (base << 64n) + (random(2) === 0 ? 0n : low()); at <= limit;) {
          const raw = ((at >> 64n) + BigInt(random(4))) << 64n;
          let end = raw + (random(3) === 0 ? low() : M64);
          if (end < at) end = at;
          if (end > limit) end = limit;
          if ((at & M64) !== 0n || (end & M64) !== M64) split += 1;
          ranges.push({ start: at, end, code: ['AA', 'BB', 'CC'][random(3)] ?? '' });
          at = end + 1n;
          const skip = random(4);
          if (skip === 0) at += BigInt(1 + random(3)) << 64n;
          if (skip === 1) at += BigInt(random(1000));
        }
      }
      const table = buildV6(ranges, []);
      expectCanonical(table);
      const lookup = open(EMPTY, table);
      for (const base of bases) {
        for (let prefix = base - 2n; prefix < base + SPAN + 2n; prefix += 1n) {
          if (prefix < 0n || prefix > M64) continue;
          const expected = naive(ranges, prefix);
          const got = lookup.code(lookup.countryOfV6(Number(prefix >> 32n), Number(prefix & 0xffff_ffffn)));
          if (got !== expected) expect([seed, prefix, got]).toEqual([seed, prefix, expected]);
        }
      }
    }
    expect(split).toBeGreaterThan(1_000);
  });

  it('o /64 dividido fica com a maioria, o empate com o primeiro, e o vazio não concorre', () => {
    const net = (n: bigint): bigint => n << 64n;
    const table = buildV6(
      [
        // /64 nº 1: AA tem os primeiros endereços, BB tem quase tudo, em dois pedaços.
        { start: net(1n), end: net(1n) + 9n, code: 'AA' },
        { start: net(1n) + 10n, end: net(1n) + 99n, code: 'BB' },
        { start: net(1n) + 100n, end: net(1n) + 109n, code: 'AA' },
        { start: net(1n) + 110n, end: net(2n) - 1n, code: 'BB' },
        // nº 2: metade de cada um.
        { start: net(2n), end: net(2n) + (1n << 63n) - 1n, code: 'CC' },
        { start: net(2n) + (1n << 63n), end: net(3n) - 1n, code: 'AA' },
        // nº 4: um endereço só, o resto vazio.
        { start: net(4n) + 5n, end: net(4n) + 5n, code: 'AA' },
        // nº 6 a 8: começa no meio de um /64 e termina no meio de outro.
        { start: net(6n) + 1n, end: net(8n), code: 'BB' },
      ],
      [],
    );
    expect(table).toEqual([
      { start: 0n, code: null },
      { start: 1n, code: 'BB' },
      { start: 2n, code: 'CC' },
      { start: 3n, code: null },
      { start: 4n, code: 'AA' },
      { start: 5n, code: null },
      { start: 6n, code: 'BB' },
      { start: 9n, code: null },
    ]);
  });

  it('só 2000::/3 tem país, sem os pedaços reservados', () => {
    const table = buildV6([{ start: 0n, end: (1n << 128n) - 1n, code: 'AA' }]);
    const known = table.filter(({ code }) => code === 'AA').map(({ start }) => start >> 32n);
    expect(known).toEqual([0x2000_0000n, 0x2001_0200n, 0x2001_0db9n, 0x2003_0000n, 0x3fff_1000n]);
    expect(table.at(-1)).toEqual({ start: 0x4000_0000n << 32n, code: null });
    expect(RESERVED_V6).toHaveLength(6);
  });
});

describe('montagem: entrada fora das regras', () => {
  it.each<[string, SourceRange[]]>([
    ['invertida', [{ start: 5n, end: 4n, code: 'AA' }]],
    ['acima da família', [{ start: 0n, end: 1n << 32n, code: 'AA' }]],
    [
      'fora de ordem',
      [
        { start: 10n, end: 11n, code: 'AA' },
        { start: 1n, end: 2n, code: 'AA' },
      ],
    ],
    [
      'sobreposta',
      [
        { start: 1n, end: 10n, code: 'AA' },
        { start: 10n, end: 11n, code: 'BB' },
      ],
    ],
  ])('IPv4 %s', (_name, ranges) => {
    expect(() => buildV4(ranges)).toThrow(/ip-country/);
  });

  it('IPv6 acima da família', () => {
    expect(() => buildV6([{ start: 0n, end: 1n << 128n, code: 'AA' }])).toThrow(/ip-country/);
  });

  it('mais códigos do que cabem num byte', () => {
    const many = Array.from({ length: 256 }, (_, i) => ({
      start: BigInt(i),
      code: String.fromCharCode(65 + (i >> 4), 65 + (i & 15)),
    }));
    expect(() => encodeTables(many, EMPTY)).toThrow(/255/);
    expect(decodeTables(encodeTables(many.slice(0, 255), EMPTY)).codes).toHaveLength(256);
  });
});

describe('leitura: conteúdo corrompido', () => {
  const V4: Boundary[] = [
    { start: 0n, code: null },
    { start: 0x100n, code: 'BR' },
    { start: 0x300n, code: 'US' },
  ];
  const V6: Boundary[] = [
    { start: 0n, code: null },
    { start: 0x2001_0db8n << 32n, code: 'US' },
  ];
  const good = encodeTables(V4, V6);
  // 8 da assinatura, versão, quantidade de códigos, dois códigos, duas contagens.
  const AT = { version: 8, codes: 10, v4Count: 14, v6Count: 18, v4Starts: 22, v4Codes: 27 } as const;
  const patched = (at: number, ...bytes: number[]): Uint8Array => {
    const copy = Uint8Array.from(good);
    copy.set(bytes, at);
    return copy;
  };

  it('o conteúdo bom é lido, e a mesma tabela dá os mesmos bytes', () => {
    expect(decodeTables(good).codes).toEqual([null, 'BR', 'US']);
    expect([...decodeTables(good).v4Starts]).toEqual([0, 0x100, 0x300]);
    expect(encodeTables(V4, V6)).toEqual(good);
    expect([...good.subarray(AT.v4Starts, AT.v4Codes + 3)]).toEqual([0, 0x80, 2, 0x80, 4, 0, 1, 2]);
  });

  it('cortado em qualquer ponto, ou com um byte sobrando', () => {
    for (let size = 0; size < good.length; size += 1) {
      expect(() => decodeTables(good.subarray(0, size))).toThrow('ip-country: dados corrompidos');
    }
    expect(() => decodeTables(Uint8Array.from([...good, 0]))).toThrow(/sobra/);
  });

  it.each<[string, Uint8Array, RegExp]>([
    ['assinatura', patched(0, 0x58), /assinatura/],
    ['versão', patched(AT.version, 2), /versão/],
    ['código minúsculo', patched(AT.codes, 0x62), /código de país/],
    ['código fora de ordem', patched(AT.codes, 0x5a, 0x5a), /fora de ordem/],
    ['código repetido', patched(AT.codes, 0x55, 0x53), /fora de ordem/],
    ['IPv4 sem fronteira', patched(AT.v4Count, 0, 0, 0, 0), /quantidade/],
    ['contagem enorme', patched(AT.v4Count, 0xff, 0xff, 0xff, 0xff), /quantidade/],
    ['contagem maior que o conteúdo', patched(AT.v4Count, 0, 0, 1, 0), /truncado/],
    ['contagem IPv6 enorme', patched(AT.v6Count, 0, 0x09, 0x3d, 0x00), /truncado/],
    ['primeira fronteira fora do zero', patched(AT.v4Starts, 1), /zero/],
    ['início repetido', patched(AT.v4Starts + 1, 0x80, 0), /fora de ordem/],
    ['índice fora da lista', patched(AT.v4Codes + 1, 3), /fora da lista/],
    ['vizinhas do mesmo país', patched(AT.v4Codes + 2, 1), /mesmo país/],
  ])('%s', (_name, content, message) => {
    expect(() => decodeTables(content)).toThrow(message);
  });

  /** Um conteúdo com uma só fronteira IPv4 além do zero, de distância `delta` (bytes do varint). */
  const withDelta = (delta: readonly number[], family: 4 | 6): Uint8Array => {
    const zero = [0, 0];
    const two = [0, ...delta, 0, 1];
    const counts = family === 4 ? [2, 0, 0, 0, 1, 0, 0, 0] : [1, 0, 0, 0, 2, 0, 0, 0];
    const body = family === 4 ? [...two, ...zero] : [...zero, ...two];
    return Uint8Array.from([...good.subarray(0, AT.v4Count), ...counts, ...body]);
  };
  const FF = 0xff;

  it('distâncias no limite e além dele', () => {
    expect([...decodeTables(withDelta([FF, FF, FF, FF, 0x0f], 4)).v4Starts]).toEqual([0, 0xffff_ffff]);
    expect(() => decodeTables(withDelta([0x80, 0x80, 0x80, 0x80, 0x10], 4))).toThrow(/fora da família/);

    const top = decodeTables(withDelta([FF, FF, FF, FF, FF, FF, FF, FF, FF, 0x01], 6));
    expect([top.v6High[1], top.v6Low[1]]).toEqual([0xffff_ffff, 0xffff_ffff]);
    expect(() => decodeTables(withDelta([FF, FF, FF, FF, FF, FF, FF, FF, FF, 0x03], 6))).toThrow(/longa/);
    expect(() => decodeTables(withDelta(Array<number>(11).fill(0x80), 6))).toThrow(/longa/);
  });

  it('a distância que não termina antes do fim', () => {
    const cut = withDelta([0x80, 0x80, 0x80, 0x80], 6).subarray(0, -2);
    expect(() => decodeTables(cut)).toThrow(/truncado/);
  });

  it('a soma que passa do fim da família', () => {
    const content = (family: 4 | 6): Uint8Array => {
      const max = family === 4 ? [FF, FF, FF, FF, 0x0f] : [FF, FF, FF, FF, FF, FF, FF, FF, FF, 0x01];
      const three = [0, ...max, 1, 0, 1, 2];
      const counts = family === 4 ? [3, 0, 0, 0, 1, 0, 0, 0] : [1, 0, 0, 0, 3, 0, 0, 0];
      const body = family === 4 ? [...three, 0, 0] : [0, 0, ...three];
      return Uint8Array.from([...good.subarray(0, AT.v4Count), ...counts, ...body]);
    };
    expect(() => decodeTables(content(4))).toThrow(/fora da família/);
    expect(() => decodeTables(content(6))).toThrow(/fora da família/);
  });
});
