import { describe, expect, it } from 'vitest';
import { isUlid, newUlid, ULID_PATTERN } from './ulid.js';

describe('isUlid', () => {
  it('aceita um ULID e recusa tamanho, alfabeto ou caixa errados', () => {
    expect(isUlid(newUlid())).toBe(true);
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true);
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FA')).toBe(false);
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAVX')).toBe(false);
    expect(isUlid('01arz3ndektsv4rrffq69g5fav')).toBe(false);
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAI')).toBe(false);
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAV/x')).toBe(false);
    expect(isUlid('')).toBe(false);
  });
});

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

  it('no mesmo milissegundo, os ids saem em ordem crescente (modo monotônico)', () => {
    const at = Date.UTC(2026, 10, 4, 12, 0, 0, 500);
    const ids = Array.from({ length: 50 }, () => newUlid(at));
    for (let i = 1; i < ids.length; i += 1) {
      expect(ids[i - 1]?.slice(0, 10)).toBe(ids[i]?.slice(0, 10));
      expect(ids[i - 1]! < ids[i]!).toBe(true);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('recusa tempo fora do intervalo', () => {
    expect(() => newUlid(-1)).toThrow(RangeError);
    expect(() => newUlid(2 ** 48)).toThrow(RangeError);
    expect(() => newUlid(1.5)).toThrow(RangeError);
  });
});
