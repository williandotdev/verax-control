import { describe, expect, it } from 'vitest';
import { TenantCache } from './tenant-cache.js';

const A = '018f2c1e-0000-7000-8000-00000000000a';
const B = '018f2c1e-0000-7000-8000-00000000000b';

function clock() {
  let at = 0;
  return { now: () => at, advance: (ms: number) => void (at += ms) };
}

describe('memória por cliente', () => {
  it('dentro da validade, devolve o mesmo valor; depois, calcula de novo', async () => {
    const time = clock();
    const cache = new TenantCache<number>({ ttlMs: 1_000, maxTenants: 5, now: time.now });
    let loads = 0;
    const load = () => Promise.resolve((loads += 1));
    expect(await cache.get(A, load)).toBe(1);
    time.advance(999);
    expect(await cache.get(A, load)).toBe(1);
    time.advance(1);
    expect(await cache.get(A, load)).toBe(2);
    expect(loads).toBe(2);
  });

  it('um cliente nunca recebe o valor de outro', async () => {
    const cache = new TenantCache<string>({ ttlMs: 60_000, maxTenants: 5 });
    expect(await cache.get(A, () => Promise.resolve('de A'))).toBe('de A');
    expect(await cache.get(B, () => Promise.resolve('de B'))).toBe('de B');
    expect(await cache.get(A, () => Promise.resolve('outro'))).toBe('de A');
  });

  it('pedidos juntos fazem um cálculo só, mesmo que ele passe da validade', async () => {
    const time = clock();
    const cache = new TenantCache<number>({ ttlMs: 1_000, maxTenants: 5, now: time.now });
    let loads = 0;
    let finish: (value: number) => void = () => undefined;
    const slow = () => {
      loads += 1;
      return new Promise<number>((resolve) => {
        finish = resolve;
      });
    };
    const first = cache.get(A, slow);
    time.advance(5_000);
    const second = cache.get(A, slow);
    expect(loads).toBe(1);
    finish(7);
    expect(await Promise.all([first, second])).toEqual([7, 7]);
    // Terminou já vencido: o próximo pedido calcula de novo.
    const third = cache.get(A, slow);
    expect(loads).toBe(2);
    finish(8);
    expect(await third).toBe(8);
  });

  it('o que falha não fica guardado', async () => {
    const cache = new TenantCache<number>({ ttlMs: 60_000, maxTenants: 5 });
    await expect(cache.get(A, () => Promise.reject(new Error('banco fora')))).rejects.toThrow('banco fora');
    expect(cache.size).toBe(0);
    expect(await cache.get(A, () => Promise.resolve(3))).toBe(3);
  });

  it('o tamanho é limitado: sai o mais antigo', async () => {
    const cache = new TenantCache<string>({ ttlMs: 60_000, maxTenants: 2 });
    for (const tenant of ['a', 'b', 'c']) await cache.get(tenant, () => Promise.resolve(tenant));
    expect(cache.size).toBe(2);
    expect(await cache.get('b', () => Promise.resolve('novo'))).toBe('b');
    expect(await cache.get('a', () => Promise.resolve('novo'))).toBe('novo');
    expect(cache.size).toBe(2);
  });

  it('recusa validade negativa e tamanho que não é um inteiro positivo', () => {
    expect(() => new TenantCache({ ttlMs: -1, maxTenants: 1 })).toThrow();
    expect(() => new TenantCache({ ttlMs: 1, maxTenants: 0 })).toThrow();
    expect(() => new TenantCache({ ttlMs: 1, maxTenants: 1.5 })).toThrow();
  });
});
