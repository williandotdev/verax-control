import { describe, expect, it } from 'vitest';
import { MAX_SESSION_COOKIES, sessionCookieValues } from './session-cookie.js';

describe('cookie __session do console', () => {
  it('lê todos os __session do cabeçalho, na ordem, até o teto (os plantados por um site irmão não escondem o nosso)', () => {
    expect(sessionCookieValues(undefined)).toEqual([]);
    expect(sessionCookieValues('outro=1; __session=a; __Session=b;__session=c')).toEqual(['a', 'c']);
    const many = Array.from({ length: 19 }, (_, index) => `__session=plantado${index}`);
    expect(sessionCookieValues([...many, '__session=verdadeiro'].join('; ')).at(-1)).toBe('verdadeiro');
    const tooMany = Array.from({ length: 30 }, (_, index) => `__session=v${index}`).join('; ');
    expect(sessionCookieValues(tooMany)).toHaveLength(MAX_SESSION_COOKIES);
    expect(MAX_SESSION_COOKIES).toBe(20);
  });

  it('um cabeçalho grande não é descartado pelo tamanho', () => {
    const padding = `pad=${'x'.repeat(9000)}`;
    expect(sessionCookieValues(`${padding}; __session=depois`)).toEqual(['depois']);
  });
});
