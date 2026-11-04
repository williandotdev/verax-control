import { describe, expect, it } from 'vitest';
import { buildTrustProxy } from './client-ip.js';

/** Endereços de documentação (RFC 5737 e 3849): cliente, saída do Hosting e um chamador direto. */
const CLIENT = '203.0.113.10';
const HOSTING_EGRESS = '198.51.100.7';
const DIRECT_CALLER = '192.0.2.44';

describe('buildTrustProxy (regra do IP do cliente)', () => {
  it('confia pela posição só nos primeiros TRUST_PROXY_HOPS saltos', () => {
    const trust = buildTrustProxy({ TRUST_PROXY_HOPS: 1, TRUSTED_PROXIES: undefined });
    expect(trust('169.254.1.1', 0)).toBe(true);
    expect(trust(HOSTING_EGRESS, 1)).toBe(false);
    expect(trust(CLIENT, 2)).toBe(false);
    const none = buildTrustProxy({ TRUST_PROXY_HOPS: 0, TRUSTED_PROXIES: undefined });
    expect(none('127.0.0.1', 0)).toBe(false);
  });

  it('confia em qualquer posição nos endereços e blocos de TRUSTED_PROXIES, v4 e v6', () => {
    const trust = buildTrustProxy({
      TRUST_PROXY_HOPS: 1,
      TRUSTED_PROXIES: ['198.51.100.0/24', '2001:db8::/32', '2001:db8:ff::1', '192.0.2.1'],
    });
    expect(trust(HOSTING_EGRESS, 1)).toBe(true);
    expect(trust('198.51.100.250', 3)).toBe(true);
    expect(trust('2001:db8:1::5', 1)).toBe(true);
    expect(trust('2001:db8:ff::1', 1)).toBe(true);
    expect(trust('192.0.2.1', 1)).toBe(true);
    expect(trust('192.0.2.2', 1)).toBe(false);
    expect(trust(CLIENT, 1)).toBe(false);
    expect(trust(DIRECT_CALLER, 1)).toBe(false);
    expect(trust('2001:db9::1', 1)).toBe(false);
  });

  it('entende o IPv4 mapeado em IPv6 do socket e nunca confia em lixo', () => {
    const trust = buildTrustProxy({ TRUST_PROXY_HOPS: 1, TRUSTED_PROXIES: ['198.51.100.0/24'] });
    expect(trust('::ffff:198.51.100.7', 1)).toBe(true);
    expect(trust('::FFFF:198.51.100.7', 1)).toBe(true);
    expect(trust('::ffff:203.0.113.10', 1)).toBe(false);
    for (const garbage of ['', 'lixo', '198.51.100', '::ffff:lixo', '198.51.100.7, 1.1.1.1']) {
      expect(trust(garbage, 1)).toBe(false);
    }
  });
});
