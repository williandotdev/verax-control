import { CLOUDFLARE_OAUTH_ISSUER } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { CALLBACK_QUERY_MAX_LENGTH, parseCallbackQuery } from './callback-query.js';

const NONCE = 'n'.repeat(43);
const STATE = `cliente-demo-a.${NONCE}`;
const CODE = 'ory_ac_Demo-123.abc~+/=';
const ISS = encodeURIComponent(CLOUDFLARE_OAUTH_ISSUER);
const code = encodeURIComponent(CODE);

describe('query do retorno do Cloudflare', () => {
  it('o código: segue com o state e o iss, codificados', () => {
    const parsed = parseCallbackQuery(`code=${code}&state=${STATE}&iss=${ISS}`);
    expect(parsed?.slug).toBe('cliente-demo-a');
    expect([...new URLSearchParams(parsed?.fragment)]).toEqual([
      ['code', CODE],
      ['state', STATE],
      ['iss', CLOUDFLARE_OAUTH_ISSUER],
    ]);
    // Nada que termine o fragmento ou o cabeçalho.
    expect(parsed?.fragment).toMatch(/^[A-Za-z0-9.*_%+&=-]+$/);
  });

  it('sem iss, passa sem ele (a API do nó é quem decide); escopos e explicação do erro são descartados', () => {
    expect(parseCallbackQuery(`code=${code}&scope=zone.read+offline_access&state=${STATE}`)?.fragment).toBe(
      new URLSearchParams({ code: CODE, state: STATE }).toString(),
    );
    const denied = parseCallbackQuery(
      `error=access_denied&error_description=texto+do+provedor&error_uri=https%3A%2F%2Fevil.example&error_hint=x&error_debug=y&state=${STATE}&iss=${ISS}`,
    );
    expect([...new URLSearchParams(denied?.fragment)]).toEqual([
      ['error', 'access_denied'],
      ['state', STATE],
      ['iss', CLOUDFLARE_OAUTH_ISSUER],
    ]);
    // Erro que ninguém conhece não passa adiante com o texto dele.
    expect(parseCallbackQuery(`error=texto_qualquer&state=${STATE}`)?.fragment).toBe(
      new URLSearchParams({ error: 'other', state: STATE }).toString(),
    );
  });

  it.each([
    ['vazia', ''],
    ['sem state', `code=${code}`],
    ['sem code nem error', `state=${STATE}`],
    ['code e error juntos', `code=${code}&error=access_denied&state=${STATE}`],
    ['error vazio', `error=&state=${STATE}`],
    ['error longo', `error=${'a'.repeat(65)}&state=${STATE}`],
    ['code vazio', `code=&state=${STATE}`],
    ['code curto', `code=abc&state=${STATE}`],
    ['code longo', `code=${'a'.repeat(1025)}&state=${STATE}`],
    ['code com espaço (o + cru)', `code=abcdefgh+ijkl&state=${STATE}`],
    ['code com CRLF', `code=abcdefgh%0d%0aSet-Cookie:x&state=${STATE}`],
    ['code com #', `code=abcdefgh%23ijkl&state=${STATE}`],
    ['code com &', `code=abcdefgh%26ijkl&state=${STATE}`],
    ['code com unicode', `code=abcdefgh%C3%A9&state=${STATE}`],
    ['code com % malformado', `code=abcdefgh%ZZ&state=${STATE}`],
    ['code com UTF-8 inválido', `code=abcdefgh%FF%FE&state=${STATE}`],
    ['code com NUL', `code=abcdefgh%00&state=${STATE}`],
    ['code repetido', `code=${code}&code=${code}&state=${STATE}`],
    ['state repetido', `code=${code}&state=${STATE}&state=cliente-demo-b.${NONCE}`],
    ['iss repetido', `code=${code}&state=${STATE}&iss=${ISS}&iss=${ISS}`],
    ['escopo repetido', `code=${code}&state=${STATE}&scope=a&scope=b`],
    ['nome repetido por codificação', `code=${code}&state=${STATE}&%73tate=${STATE}`],
    ['lista do Express', `code[]=${code}&state=${STATE}`],
    ['objeto do Express', `code[a]=${code}&state=${STATE}`],
    ['desconhecido', `code=${code}&state=${STATE}&redirect_uri=https%3A%2F%2Fevil.example`],
    ['desconhecido vazio', `code=${code}&state=${STATE}&x`],
    ['nome em maiúsculas', `Code=${code}&state=${STATE}`],
    ['constructor', `code=${code}&state=${STATE}&constructor=x`],
    ['__proto__', `code=${code}&state=${STATE}&__proto__=x`],
    ['iss de outro', `code=${code}&state=${STATE}&iss=https%3A%2F%2Fevil.example`],
    ['iss com barra', `code=${code}&state=${STATE}&iss=${ISS}%2F`],
    ['iss vazio', `code=${code}&state=${STATE}&iss=`],
    ['iss parecido', `code=${code}&state=${STATE}&iss=${ISS}.evil.example`],
    ['state sem ponto', `code=${code}&state=clientedemoa${NONCE}`],
    ['state com dois pontos finais', `code=${code}&state=cliente.demo.${NONCE}`],
    ['slug com ponto', `code=${code}&state=evil.example.${NONCE}`],
    ['slug com barra', `code=${code}&state=evil%2Fx.${NONCE}`],
    ['slug com @', `code=${code}&state=a%40evil.${NONCE}`],
    ['slug em maiúsculas', `code=${code}&state=Cliente-Demo-A.${NONCE}`],
    ['slug com CRLF', `code=${code}&state=cliente%0d%0a.${NONCE}`],
    ['slug unicode (homógrafo)', `code=${code}&state=cli%D0%B5nte.${NONCE}`],
    ['slug punycode', `code=${code}&state=xn--demo.${NONCE}`],
    ['slug vazio', `code=${code}&state=.${NONCE}`],
    ['nonce curto', `code=${code}&state=cliente-demo-a.${'n'.repeat(42)}`],
    ['nonce longo', `code=${code}&state=cliente-demo-a.${'n'.repeat(44)}`],
    ['nonce fora do alfabeto', `code=${code}&state=cliente-demo-a.${'n'.repeat(42)}%2F`],
    ['parâmetro descartado grande demais', `code=${code}&state=${STATE}&scope=${'a'.repeat(2049)}`],
    [
      'query grande demais',
      // Cada um dentro do teto dele; juntos, acima do da query.
      `code=${code}&state=${STATE}&${['scope', 'error_description', 'error_uri', 'error_hint', 'error_debug']
        .map((name) => `${name}=${'a'.repeat(CALLBACK_QUERY_MAX_LENGTH / 5)}`)
        .join('&')}`,
    ],
  ])('recusa: %s', (_name, query) => {
    expect(parseCallbackQuery(query)).toBeNull();
  });
});
