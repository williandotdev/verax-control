import { describe, expect, it } from 'vitest';
import { T0, TEST_RANGES } from '../../test/support/alb-lines.js';
import { ClientClassifier, RANGES_MAX_AGE_MS } from './client-class.js';
import { PROXY_RANGES } from './data/proxy-ranges.js';
import { IntSet, KeyedHash } from './hash.js';
import { cidrContains, clientKeyOf, parseCidr, parseIp } from './ip.js';

const ip = (text: string) => {
  const parsed = parseIp(text);
  if (parsed === null) throw new Error(`IP inválido: ${text}`);
  return parsed;
};
const cidr = (text: string) => {
  const parsed = parseCidr(text);
  if (parsed === null) throw new Error(`faixa inválida: ${text}`);
  return parsed;
};

describe('endereços', () => {
  it.each([
    ['192.0.2.1', '192.0.2.1'],
    ['0.0.0.0', '0.0.0.0'],
    ['255.255.255.255', '255.255.255.255'],
    ['::ffff:192.0.2.1', '192.0.2.1'],
    ['2001:db8::1', '2001:db8::/64'],
    ['2001:DB8:0:1:ffff:ffff:ffff:ffff', '2001:db8:0:1::/64'],
    ['2001:db8:a:b:1:2:3:4', '2001:db8:a:b::/64'],
    ['2001:db8:0:0:1::', '2001:db8::/64'],
    ['::1', '::/64'],
  ])('a chave de %s é %s', (text, key) => {
    expect(clientKeyOf(ip(text))).toBe(key);
  });

  it('trocar de endereço dentro do /64 não muda a chave; sair dele, muda', () => {
    expect(clientKeyOf(ip('2001:db8:1:2::a'))).toBe(clientKeyOf(ip('2001:db8:1:2:ffff::b')));
    expect(clientKeyOf(ip('2001:db8:1:2::a'))).not.toBe(clientKeyOf(ip('2001:db8:1:3::a')));
  });

  it.each([
    '',
    '1.2.3',
    '1.2.3.4.5',
    '1.2.3.256',
    '01.2.3.4',
    '1.2.3.4 ',
    'a.b.c.d',
    '1.2..4',
    '-1.2.3.4',
    ':::',
    '1::2::3',
    '2001:db8::g',
    '2001:db8:1:2:3:4:5',
    '2001:db8:1:2:3:4:5:6:7',
    '2001:db8::1%eth0',
    '12345::',
    '1.2.3.4::',
    `${'1'.repeat(60)}:1`,
  ])('recusa o endereço %s', (text) => {
    expect(parseIp(text)).toBeNull();
  });

  it('faixas: contém, não contém e o que é recusado', () => {
    expect(cidrContains(cidr('192.0.2.0/24'), ip('192.0.2.255'))).toBe(true);
    expect(cidrContains(cidr('192.0.2.0/24'), ip('192.0.3.0'))).toBe(false);
    expect(cidrContains(cidr('192.0.2.7/32'), ip('192.0.2.7'))).toBe(true);
    expect(cidrContains(cidr('0.0.0.0/0'), ip('198.51.100.1'))).toBe(true);
    expect(cidrContains(cidr('2001:db8::/33'), ip('2001:db8:7fff::1'))).toBe(true);
    expect(cidrContains(cidr('2001:db8::/33'), ip('2001:db8:8000::1'))).toBe(false);
    expect(cidrContains(cidr('2001:db8::/32'), ip('192.0.2.1'))).toBe(false);
    for (const bad of [
      '192.0.2.1/24',
      '192.0.2.0',
      '192.0.2.0/33',
      '2001:db8::1/64',
      '::ffff:192.0.2.0/120',
      '/8',
    ]) {
      expect(parseCidr(bad)).toBeNull();
    }
  });
});

describe('classe do cliente', () => {
  const classify = (text: string, options: Partial<ConstructorParameters<typeof ClientClassifier>[0]> = {}) =>
    new ClientClassifier({ now: T0, ranges: TEST_RANGES, ...options }).classify(ip(text));

  it('proxy do cliente, CDN, privado e direto, nessa ordem', () => {
    const proxies = [cidr('203.0.113.0/25')];
    expect(classify('203.0.113.5', { proxies })).toBe('customer_proxy');
    expect(classify('203.0.113.5')).toBe('cloudflare');
    expect(classify('203.0.113.200')).toBe('cloudfront');
    expect(classify('2001:db8:cf00::9')).toBe('cloudflare');
    for (const local of [
      '10.1.2.3',
      '172.31.0.1',
      '192.168.0.1',
      '100.64.0.1',
      '127.0.0.1',
      'fd00::1',
      'fe80::1',
      '::1',
    ]) {
      expect(classify(local)).toBe('private');
    }
    for (const direct of ['192.0.2.1', '198.51.100.7', '172.32.0.1', '100.128.0.1', '2001:db8::1']) {
      expect(classify(direct)).toBe('direct');
    }
  });

  it('a lista vendorizada é o padrão: o primeiro endereço de cada faixa é da CDN dela, e o resto é direto', () => {
    const now = Math.min(...PROXY_RANGES.map((entry) => Date.parse(entry.generatedAt!)));
    const classifier = new ClientClassifier({ now });
    expect(classifier.status).toBe('ok');
    for (const entry of PROXY_RANGES) {
      for (const range of entry.ranges) {
        expect(classifier.classify(ip(range.split('/')[0]!)), range).toBe(entry.provider);
      }
    }
    for (const direct of ['198.51.100.7', '203.0.113.9', '2001:db8::1']) {
      expect(classifier.classify(ip(direct))).toBe('direct');
    }
    expect(classifier.classify(ip('10.0.0.1'))).toBe('private');
  });

  it.each([
    ['uma CDN sem faixa', [TEST_RANGES[0]!, { ...TEST_RANGES[1]!, ranges: [] }]],
    ['uma CDN sem data', [TEST_RANGES[0]!, { ...TEST_RANGES[1]!, generatedAt: null }]],
    ['data inválida', [TEST_RANGES[0]!, { ...TEST_RANGES[1]!, generatedAt: 'ontem' }]],
    ['uma CDN a menos', [TEST_RANGES[0]!]],
    ['nenhuma', []],
  ])('lista incompleta não vira lista válida: %s', (_, ranges) => {
    expect(classify('198.51.100.7', { ranges })).toBe('unverified');
  });

  it('mais de 180 dias: velha, mas em uso', () => {
    const generated = Date.parse(TEST_RANGES[0]!.generatedAt!);
    const at = (now: number) => new ClientClassifier({ now, ranges: TEST_RANGES }).status;
    expect(at(generated + RANGES_MAX_AGE_MS)).toBe('ok');
    expect(at(generated + RANGES_MAX_AGE_MS + 1)).toBe('stale');
    expect(classify('198.51.100.7', { now: generated + 2 * RANGES_MAX_AGE_MS })).toBe('direct');
  });

  it('faixa malformada ou larga demais derruba a carga', () => {
    for (const bad of ['0.0.0.0/0', '10.0.0.0/7', '::/0', '2001:db8::/23', '203.0.113.1/24', 'x']) {
      expect(() => classify('192.0.2.1', { ranges: [{ ...TEST_RANGES[0]!, ranges: [bad] }] })).toThrow();
    }
  });

  it('as faixas vendorizadas são válidas, sem repetição, nos dois IPs e com fonte', () => {
    expect(PROXY_RANGES.map((entry) => entry.provider).sort()).toEqual(['cloudflare', 'cloudfront']);
    expect(() => new ClientClassifier({ now: T0, ranges: PROXY_RANGES })).not.toThrow();
    for (const entry of PROXY_RANGES) {
      expect(entry.source).toContain('https://');
      expect(Number.isNaN(Date.parse(entry.generatedAt!))).toBe(false);
      expect(new Set(entry.ranges).size).toBe(entry.ranges.length);
      expect(entry.ranges.some((range) => range.includes(':'))).toBe(true);
      expect(entry.ranges.some((range) => !range.includes(':'))).toBe(true);
    }
  });
});

describe('conjuntos de hash', () => {
  it('a chave muda o hash, e a mesma chave o repete', () => {
    const a = new KeyedHash(new Uint8Array(16).fill(1));
    const b = new KeyedHash(new Uint8Array(16).fill(2));
    expect(a.of('/x')).toBe(a.of('/x'));
    expect(a.of('/x')).not.toBe(b.of('/x'));
    expect(() => new KeyedHash(new Uint8Array(8))).toThrow();
  });

  it('conta os distintos, inclusive o zero, e para no teto', () => {
    const set = new IntSet(100);
    for (let round = 0; round < 2; round += 1) for (let i = 0; i < 99; i += 1) set.add(i - 50);
    expect(set.size).toBe(99);
    expect(set.full).toBe(false);
    set.add(1000);
    expect(set.size).toBe(100);
    set.add(1000);
    expect(set.full).toBe(false);
    set.add(1001);
    expect(set.size).toBe(100);
    expect(set.full).toBe(true);
    const all = new Set<number>();
    set.addTo(all);
    expect(all.size).toBe(100);
    expect(all.has(0)).toBe(true);
  });

  it('o zero além do teto também não entra', () => {
    const set = new IntSet(1);
    set.add(5);
    set.add(0);
    expect(set.size).toBe(1);
    expect(set.full).toBe(true);
  });
});
