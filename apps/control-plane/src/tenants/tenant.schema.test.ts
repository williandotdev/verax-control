import { describe, expect, it } from 'vitest';
import { isReservableSlug, slugSchema } from './tenant.schema.js';

describe('subdomínio do cliente', () => {
  it('aceita 3 a 16 caracteres, começando por letra e sem terminar em traço', () => {
    for (const slug of ['abc', 'cliente-demo-a', 'a1-b2', 'abcdefghijklmnop']) {
      expect(slugSchema.safeParse(slug).success, slug).toBe(true);
    }
  });

  it('recusa formato errado', () => {
    for (const slug of ['ab', 'abcdefghijklmnopq', '1abc', 'abc-', 'Abc', 'ab_c', 'ab.c', '']) {
      expect(slugSchema.safeParse(slug).success, slug).toBe(false);
    }
  });

  it('recusa traços nas posições 3 e 4 juntos (xn-- e afins), como o painel', () => {
    for (const slug of ['xn--abc', 'ab--cd', 'zz--']) {
      expect(slugSchema.safeParse(slug).success, slug).toBe(false);
    }
    // Um traço só nessas posições, ou dois traços em outro lugar, continua valendo.
    for (const slug of ['ab-cd', 'abc-d', 'abc--d']) {
      expect(slugSchema.safeParse(slug).success, slug).toBe(true);
    }
  });

  it('a lista reservada fica de fora mesmo no formato certo', () => {
    expect(isReservableSlug('verax')).toBe(false);
    expect(isReservableSlug('cliente-demo-a')).toBe(true);
    expect(isReservableSlug('xn--abc')).toBe(false);
  });
});
