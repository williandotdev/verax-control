import { isIP } from 'node:net';
import { describe, expect, it } from 'vitest';
import { parseIp } from './ip-address.js';

const words = new Uint32Array(4);

/** `4:c0000201` ou `6:20010db8.0.0.1`; null se não é um endereço. */
function parsed(text: string): string | null {
  words.fill(0);
  const family = parseIp(text, words);
  if (family === 0) return null;
  const used = family === 4 ? words.subarray(0, 1) : words;
  return `${family}:${[...used].map((word) => word.toString(16)).join('.')}`;
}

/** A leitura de referência, sem os cuidados de desempenho. Só para o que o `isIP` aceita, sem zona. */
function reference(text: string): string | null {
  const family = isIP(text);
  if (family === 0) return null;
  const v4 = (part: string): number => part.split('.').reduce((sum, octet) => sum * 256 + Number(octet), 0);
  if (family === 4) return `4:${v4(text).toString(16)}`;
  const side = (part: string): number[] =>
    part === ''
      ? []
      : part
          .split(':')
          .flatMap((group) =>
            group.includes('.') ? [v4(group) >>> 16, v4(group) & 0xffff] : [parseInt(group, 16)],
          );
  const [head = [], tail] = text.split('::').map(side);
  const groups =
    tail === undefined ? head : [...head, ...Array<number>(8 - head.length - tail.length).fill(0), ...tail];
  const value = [0, 2, 4, 6].map((i) => (groups[i] ?? 0) * 0x10000 + (groups[i + 1] ?? 0));
  if (value[0] === 0 && value[1] === 0 && value[2] === 0xffff) return `4:${(value[3] ?? 0).toString(16)}`;
  return `6:${value.map((word) => word.toString(16)).join('.')}`;
}

function prng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

describe('parseIp', () => {
  it.each([
    ['0.0.0.0', '4:0'],
    ['192.0.2.1', '4:c0000201'],
    ['255.255.255.255', '4:ffffffff'],
    ['::', '6:0.0.0.0'],
    ['::1', '6:0.0.0.1'],
    ['2001:db8::', '6:20010db8.0.0.0'],
    ['2001:DB8::Aa', '6:20010db8.0.0.aa'],
    ['1:2:3:4:5:6:7:8', '6:10002.30004.50006.70008'],
    ['1:2:3:4:5:6:7::', '6:10002.30004.50006.70000'],
    ['::2:3:4:5:6:7:8', '6:2.30004.50006.70008'],
    ['1::8', '6:10000.0.0.8'],
    ['ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '6:ffffffff.ffffffff.ffffffff.ffffffff'],
    ['::ffff:192.0.2.1', '4:c0000201'],
    ['::ffff:c000:201', '4:c0000201'],
    ['0:0:0:0:0:ffff:255.255.255.255', '4:ffffffff'],
    ['64:ff9b::192.0.2.1', '6:64ff9b.0.0.c0000201'],
    // O IPv4 "compatível", retirado, não é o mapeado.
    ['::192.0.2.1', '6:0.0.0.c0000201'],
    ['1:2:3:4:5:6:192.0.2.1', '6:10002.30004.50006.c0000201'],
    ['fe80::1%eth0', '6:fe800000.0.0.1'],
    ['::ffff:192.0.2.1%25en0', '4:c0000201'],
  ])('%s', (text, expected) => {
    expect(parsed(text)).toBe(expected);
  });

  it.each([
    '',
    '.',
    ':',
    '%',
    ' ',
    '1',
    '1.2.3',
    '1.2.3.',
    '.1.2.3',
    '1..2.3',
    '1.2.3.4.',
    '1.2.3.4.5',
    '1.2.3.256',
    '1.2.3.1000',
    '1.2.3.-1',
    '1.2.3.+1',
    '1.2.3.0x1',
    '1.2.3.1e1',
    // Octeto com zero à esquerda: em alguns sistemas é octal (010.0.0.1 seria 8.0.0.1).
    '010.0.0.1',
    '1.2.3.00',
    '1.2.3.04',
    '0177.0.0.1',
    '3232235777',
    '0xc0a80101',
    ' 1.2.3.4',
    '1.2.3.4 ',
    '1.2.3.4\n',
    '1.2.3.4\0',
    '1.2.3.4:80',
    '1.2.3.4/32',
    '1.2.3.4%eth0',
    // Algarismos que não são ASCII.
    '١.٢.٣.٤',
    '1.2.3.４',
    '2001:db８::',
    ':::',
    '1:',
    ':1',
    '1::2::3',
    '::1::',
    '1:2:3:4:5:6:7',
    '1:2:3:4:5:6:7:8:9',
    '1:2:3:4:5:6:7:8::',
    '::1:2:3:4:5:6:7:8',
    '1:2:3:4::5:6:7:8',
    '12345::',
    '00001::',
    'g::',
    '::1.2.3.4:5',
    '1.2.3.4::',
    '::1.2.3',
    '::1.2.3.256',
    '::010.0.0.1',
    '1:2:3:4:5:6:7:1.2.3.4',
    '[::1]',
    '::1%',
    '::1%a b',
    '::1%a\0',
    `::1%${'z'.repeat(33)}`,
    '%eth0',
    '1%::',
    `${'0:'.repeat(50)}0`,
    '1'.repeat(1_000_000),
    ':'.repeat(1_000_000),
    `::${'f'.repeat(1_000_000)}`,
    `::1%${'z'.repeat(1_000_000)}`,
  ])('recusa %j', (text) => {
    expect(parsed(text)).toBeNull();
  });

  it('lê o que o Node lê, e mais nada (500 mil textos)', () => {
    const random = prng(1);
    const pick = (list: readonly string[]): string => list[Math.floor(random() * list.length)] ?? '';
    const pieces = [
      '0',
      '1',
      '9',
      '25',
      '255',
      '256',
      '01',
      'a',
      'F',
      'ffff',
      '10000',
      '.',
      '.',
      ':',
      ':',
      '::',
    ];
    const tails = ['::ffff:', '64:ff9b::', '::', '2001:db8:', ''];
    let accepted = 0;
    for (let i = 0; i < 500_000; i += 1) {
      let text = random() < 0.3 ? pick(tails) : '';
      const separator = pick([':', '.', '']);
      for (let left = 1 + Math.floor(random() * 8); left > 0; left -= 1) {
        text += pick(pieces) + (left > 1 ? separator : '');
      }
      const expected = reference(text);
      if (expected !== null) accepted += 1;
      if (parsed(text) !== expected) expect([text, parsed(text)]).toEqual([text, expected]);
    }
    expect(accepted).toBeGreaterThan(2_000);
  });
});
