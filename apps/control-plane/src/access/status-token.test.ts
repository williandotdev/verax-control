import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  newStatusTokenValue,
  readStatusCookie,
  signStatusCookie,
  STATUS_COOKIE_NAME,
  statusCookiesFrom,
  statusTokenId,
  verifyStatusCookie,
} from './status-token.js';

/** Chave do cookie gerada no teste (32 bytes ou mais, como a `COOKIE_KEY`). */
const key = (): string => randomBytes(32).toString('base64url');

describe('valores da página de status', () => {
  it('são aleatórios, em base64url, e o id é o SHA-256 em hexadecimal', () => {
    const value = newStatusTokenValue();
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newStatusTokenValue()).not.toBe(value);
    expect(statusTokenId(value)).toMatch(/^[0-9a-f]{64}$/);
    expect(statusTokenId(value)).not.toContain(value);
  });
});

describe('cookie __session assinado', () => {
  it('devolve o valor de um cookie assinado com a mesma chave', () => {
    const cookieKey = key();
    const value = newStatusTokenValue();
    const cookie = signStatusCookie(value, cookieKey);
    expect(cookie).toMatch(/^v1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
    expect(verifyStatusCookie(cookie, cookieKey)).toBe(value);
  });

  it('recusa cookie alterado, de outra chave, sem assinatura ou fora do formato', () => {
    const cookieKey = key();
    const value = newStatusTokenValue();
    const cookie = signStatusCookie(value, cookieKey);
    const [version, , mac] = cookie.split('.');
    const otherValue = newStatusTokenValue();

    expect(verifyStatusCookie(`${version}.${otherValue}.${mac}`, cookieKey)).toBeUndefined();
    expect(verifyStatusCookie(cookie, key())).toBeUndefined();
    expect(verifyStatusCookie(`v1.${value}`, cookieKey)).toBeUndefined();
    expect(verifyStatusCookie(`v2.${value}.${mac}`, cookieKey)).toBeUndefined();
    expect(verifyStatusCookie(`${cookie}x`, cookieKey)).toBeUndefined();
    const flipped = `${cookie.slice(0, -1)}${cookie.endsWith('A') ? 'B' : 'A'}`;
    expect(verifyStatusCookie(flipped, cookieKey)).toBeUndefined();
  });

  it('lê o cabeçalho Cookie: só o __session, o primeiro válido entre vários', () => {
    const cookieKey = key();
    const value = newStatusTokenValue();
    const good = signStatusCookie(value, cookieKey);
    const forged = signStatusCookie(newStatusTokenValue(), key());
    const header = `outro=1; ${STATUS_COOKIE_NAME}=${forged}; ${STATUS_COOKIE_NAME}=${good}; x`;

    expect(statusCookiesFrom(header)).toEqual([forged, good]);
    expect(readStatusCookie(header, cookieKey)).toBe(value);
    expect(readStatusCookie(`${STATUS_COOKIE_NAME}=${forged}`, cookieKey)).toBeUndefined();
    expect(readStatusCookie(undefined, cookieKey)).toBeUndefined();
    expect(readStatusCookie('a'.repeat(9000), cookieKey)).toBeUndefined();
  });
});
