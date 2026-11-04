import { describe, expect, it } from 'vitest';
import { newUlid, ULID_PATTERN } from './ulid.js';

describe('newUlid', () => {
  it('tem 26 caracteres do alfabeto Crockford e nunca se repete', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newUlid()));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(ULID_PATTERN);
  });

  it('ordena por tempo de criação (os 10 primeiros caracteres)', () => {
    const earlier = newUlid(Date.UTC(2026, 10, 4, 12, 0, 0));
    const later = newUlid(Date.UTC(2026, 10, 4, 12, 0, 1));
    expect(earlier.slice(0, 10) < later.slice(0, 10)).toBe(true);
    expect(newUlid(0).slice(0, 10)).toBe('0000000000');
  });

  it('recusa tempo fora do intervalo', () => {
    expect(() => newUlid(-1)).toThrow(RangeError);
    expect(() => newUlid(2 ** 48)).toThrow(RangeError);
    expect(() => newUlid(1.5)).toThrow(RangeError);
  });
});
