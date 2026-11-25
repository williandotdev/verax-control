import { afterEach, describe, expect, it } from 'vitest';
import { attemptIdOf, parseCloudflareReturn, takeCloudflareReturn } from './oauth-return';

const STATE = `alfa.${'a'.repeat(43)}`;
const CODE = 'codigo-ficticio-0001';
const ISS = encodeURIComponent('https://dash.cloudflare.com');

describe('parseCloudflareReturn', () => {
  it('lê o retorno com código e o com erro', () => {
    expect(parseCloudflareReturn(`code=${CODE}&state=${STATE}&iss=${ISS}`)).toEqual({
      kind: 'return',
      input: { code: CODE, state: STATE, iss: 'https://dash.cloudflare.com' },
    });
    expect(parseCloudflareReturn(`error=access_denied&state=${STATE}`)).toEqual({
      kind: 'return',
      input: { error: 'access_denied', state: STATE },
    });
    // O repasse manda o `iss` também com o erro: ele não segue para a API.
    expect(parseCloudflareReturn(`error=access_denied&state=${STATE}&iss=${ISS}`)).toEqual({
      kind: 'return',
      input: { error: 'access_denied', state: STATE },
    });
  });

  it('sem fragmento, nada a fazer', () => {
    expect(parseCloudflareReturn('')).toEqual({ kind: 'none' });
  });

  it.each([
    ['campo repetido', `code=${CODE}&code=${CODE}&state=${STATE}&iss=${ISS}`],
    ['campo a mais', `code=${CODE}&state=${STATE}&iss=${ISS}&redirect=https://exemplo.example`],
    ['sem o emissor', `code=${CODE}&state=${STATE}`],
    ['código e erro juntos', `code=${CODE}&error=access_denied&state=${STATE}`],
    ['state fora do formato', `code=${CODE}&state=alfa.curto&iss=${ISS}`],
    ['código fora do alfabeto', `code=${encodeURIComponent('<script>')}&state=${STATE}&iss=${ISS}`],
    ['erro desconhecido', `error=qualquer&state=${STATE}`],
    ['grande demais', `code=${'a'.repeat(3000)}&state=${STATE}&iss=${ISS}`],
  ])('recusa %s', (_, fragment) => {
    expect(parseCloudflareReturn(fragment)).toEqual({ kind: 'invalid' });
  });
});

describe('takeCloudflareReturn', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('apaga o fragmento (e a query) da barra de endereço na hora', () => {
    window.history.replaceState(null, '', `/conexao-cloudflare?x=1#code=${CODE}&state=${STATE}&iss=${ISS}`);
    const taken = takeCloudflareReturn();
    expect(taken.kind).toBe('return');
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('');
    expect(window.location.href).not.toContain(CODE);
    expect(window.location.pathname).toBe('/conexao-cloudflare');
  });

  it('a segunda leitura não acha nada', () => {
    window.history.replaceState(null, '', `/conexao-cloudflare#error=access_denied&state=${STATE}`);
    takeCloudflareReturn();
    expect(takeCloudflareReturn()).toEqual({ kind: 'none' });
  });
});

describe('attemptIdOf', () => {
  it('só aceita um UUID', () => {
    expect(attemptIdOf('?tentativa=018f2c1e-0000-7000-8000-000000000001')).toBe(
      '018f2c1e-0000-7000-8000-000000000001',
    );
    expect(attemptIdOf('?tentativa=../../v1/me')).toBeNull();
    expect(attemptIdOf('')).toBeNull();
  });
});
