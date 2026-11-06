import { describe, expect, it } from 'vitest';
import { FakeClock, MINUTE_MS } from '../../../test/support/fake-clock.js';
import { rateLimitKey, TokenBucketLimiter } from './rate-limiter.js';

const HOUR_MS = 60 * MINUTE_MS;

describe('TokenBucketLimiter (CP-03)', () => {
  it('libera a capacidade de uma vez e recusa a seguinte, dizendo quanto esperar', () => {
    const clock = new FakeClock();
    const limiter = new TokenBucketLimiter({ capacity: 5, windowMs: HOUR_MS }, clock);

    for (let i = 0; i < 5; i += 1) expect(limiter.take('203.0.113.10').allowed).toBe(true);
    const refused = limiter.take('203.0.113.10');

    expect(refused.allowed).toBe(false);
    // 5 por hora: um pedido novo a cada 12 minutos.
    expect(refused.retryAfterSeconds).toBe(12 * 60);
    // Outra chave tem o próprio balde.
    expect(limiter.take('203.0.113.11').allowed).toBe(true);
  });

  it('repõe aos poucos: um pedido a cada janela/capacidade, nunca acima da capacidade', () => {
    const clock = new FakeClock();
    const limiter = new TokenBucketLimiter({ capacity: 30, windowMs: MINUTE_MS }, clock);
    for (let i = 0; i < 30; i += 1) limiter.take('k');
    expect(limiter.take('k').allowed).toBe(false);

    clock.advance(2_000);
    expect(limiter.take('k').allowed).toBe(true);
    expect(limiter.take('k').allowed).toBe(false);

    clock.advance(10 * MINUTE_MS);
    for (let i = 0; i < 30; i += 1) expect(limiter.take('k').allowed).toBe(true);
    expect(limiter.take('k').allowed).toBe(false);
  });

  it('pedidos recusados não consomem: esperar o tempo dito basta', () => {
    const clock = new FakeClock();
    const limiter = new TokenBucketLimiter({ capacity: 1, windowMs: MINUTE_MS }, clock);
    limiter.take('k');
    for (let i = 0; i < 10; i += 1) limiter.take('k');
    const { retryAfterSeconds } = limiter.take('k');
    clock.advance(retryAfterSeconds * 1000);
    expect(limiter.take('k').allowed).toBe(true);
  });

  it('a memória é limitada: baldes cheios saem primeiro, depois os mais antigos', () => {
    const clock = new FakeClock();
    const limiter = new TokenBucketLimiter({ capacity: 2, windowMs: MINUTE_MS }, clock, 3);
    limiter.take('a');
    limiter.take('b');
    limiter.take('c');
    limiter.take('d');
    expect(limiter.size).toBe(3);

    // Depois de um minuto todos estão cheios: um balde novo tira os cheios.
    clock.advance(MINUTE_MS);
    limiter.take('e');
    expect(limiter.size).toBe(1);
  });

  it('recusa regra inválida', () => {
    expect(() => new TokenBucketLimiter({ capacity: 0, windowMs: 1 }, new FakeClock())).toThrow(RangeError);
    expect(() => new TokenBucketLimiter({ capacity: 1, windowMs: 0 }, new FakeClock())).toThrow(RangeError);
  });
});

describe('rateLimitKey', () => {
  it('IPv4 e IPv4 mapeado em IPv6 contam pelo endereço', () => {
    expect(rateLimitKey('203.0.113.10')).toBe('203.0.113.10');
    expect(rateLimitKey('::ffff:203.0.113.10')).toBe('203.0.113.10');
    expect(rateLimitKey('::FFFF:203.0.113.10')).toBe('203.0.113.10');
  });

  it('IPv6 conta pelo /64, em qualquer grafia', () => {
    const key = '2001:db8:1:2::/64';
    expect(rateLimitKey('2001:db8:1:2::10')).toBe(key);
    expect(rateLimitKey('2001:0db8:0001:0002:ffff:ffff:ffff:ffff')).toBe(key);
    expect(rateLimitKey('2001:DB8:1:2:0:0:0:1')).toBe(key);
    expect(rateLimitKey('2001:db8:1:3::10')).not.toBe(key);
    expect(rateLimitKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rateLimitKey('::1')).toBe('0:0:0:0::/64');
    expect(rateLimitKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('sem IP ou com lixo, um balde só por valor', () => {
    expect(rateLimitKey(undefined)).toBe('sem-ip');
    expect(rateLimitKey('lixo')).toBe('lixo');
  });
});
