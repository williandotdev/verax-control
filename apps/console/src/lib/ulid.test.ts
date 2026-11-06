import { describe, expect, it } from 'vitest';
import { newUlid, ULID_PATTERN } from './ulid';

describe('newUlid (a chave de idempotência do cadastro)', () => {
  it('tem a forma de um ULID, com o instante na frente, e não se repete', () => {
    const first = newUlid(Date.UTC(2026, 10, 5, 12));
    expect(first).toMatch(ULID_PATTERN);
    expect(first.slice(0, 10)).toBe(newUlid(Date.UTC(2026, 10, 5, 12)).slice(0, 10));
    expect(newUlid(Date.UTC(2026, 10, 5, 13)) > first).toBe(true);
    const many = new Set(Array.from({ length: 200 }, () => newUlid()));
    expect(many.size).toBe(200);
  });
});
