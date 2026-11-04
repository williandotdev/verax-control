import { describe, expect, it } from 'vitest';
import { fillTenant, isTenantSlug, resolveApiUrl, tenantFromHostname } from './tenant-address';

const TEMPLATE = 'https://api-{tenant}.veraxsistemas.com.br';

describe('subdomínio de cliente', () => {
  it.each(['abc', 'verax', 'cliente-demo-a', 'cliente-demo-b', 'a1b', 'a-1', 'a--b', 'abcdefghijklmnop'])(
    'aceita %s',
    (slug) => {
      expect(isTenantSlug(slug)).toBe(true);
    },
  );

  it.each([
    ['vazio', ''],
    ['curto demais', 'ab'],
    ['longo demais (17)', 'abcdefghijklmnopq'],
    ['começa com dígito', '1abc'],
    ['começa com hífen', '-abc'],
    ['termina com hífen', 'abc-'],
    ['maiúscula', 'Cliente'],
    ['sublinhado', 'cli_ente'],
    ['ponto', 'cli.ente'],
    ['espaço', 'cli ente'],
    ['acento', 'clientê'],
    ['punycode (domínio internacionalizado)', 'xn--clnte-bsa'],
    ['outro rótulo reservado (hífen na 3.ª e 4.ª posições)', 'ab--cd'],
  ])('recusa %s', (_case, slug) => {
    expect(isTenantSlug(slug)).toBe(false);
  });
});

describe('cliente pelo endereço do painel', () => {
  it('é o primeiro rótulo de <cliente>.control.veraxsistemas.com.br', () => {
    expect(tenantFromHostname('cliente-demo-a.control.veraxsistemas.com.br')).toBe('cliente-demo-a');
    expect(tenantFromHostname('verax.control.veraxsistemas.com.br')).toBe('verax');
  });

  it('aceita <cliente>.localhost, que só existe na própria máquina', () => {
    expect(tenantFromHostname('cliente-demo-a.localhost')).toBe('cliente-demo-a');
  });

  it.each([
    ['o domínio dos painéis sem cliente (a demonstração)', 'control.veraxsistemas.com.br'],
    ['localhost sem cliente', 'localhost'],
    ['IP', '127.0.0.1'],
    ['rótulo a mais', 'x.cliente-demo-a.control.veraxsistemas.com.br'],
    ['rótulo a mais no local', 'x.cliente-demo-a.localhost'],
    [
      'o domínio dos painéis como prefixo de outro',
      'cliente-demo-a.control.veraxsistemas.com.br.example.com',
    ],
    ['domínio parecido', 'cliente-demo-a.controlveraxsistemas.com.br'],
    ['outro subdomínio da Verax', 'cliente-demo-a.veraxsistemas.com.br'],
    ['endereço padrão do Firebase', 'vxc-cliente-demo-a.web.app'],
    ['domínio qualquer', 'cliente-demo-a.example.com'],
    ['maiúscula no cliente', 'CLIENTE-DEMO-A.control.veraxsistemas.com.br'],
    ['maiúscula no domínio', 'cliente-demo-a.CONTROL.veraxsistemas.com.br'],
    ['ponto final', 'cliente-demo-a.control.veraxsistemas.com.br.'],
    ['rótulo vazio', '.control.veraxsistemas.com.br'],
    ['punycode', 'xn--clnte-bsa.control.veraxsistemas.com.br'],
    ['cliente inválido', '1abc.control.veraxsistemas.com.br'],
    ['porta junto', 'cliente-demo-a.control.veraxsistemas.com.br:443'],
    ['vazio', ''],
  ])('recusa %s', (_case, hostname) => {
    expect(tenantFromHostname(hostname)).toBeUndefined();
  });
});

describe('URL da API', () => {
  it('sem o marcador, vale como está em qualquer endereço (destino único, demonstração, local)', () => {
    for (const hostname of ['localhost', 'control.veraxsistemas.com.br', 'qualquer.example.com']) {
      expect(resolveApiUrl('https://api-verax.veraxsistemas.com.br', hostname)).toEqual({
        ok: true,
        url: 'https://api-verax.veraxsistemas.com.br',
      });
    }
  });

  it('com o marcador, cada site chama a API do próprio cliente', () => {
    expect(resolveApiUrl(TEMPLATE, 'cliente-demo-a.control.veraxsistemas.com.br')).toEqual({
      ok: true,
      url: 'https://api-cliente-demo-a.veraxsistemas.com.br',
    });
    expect(resolveApiUrl(TEMPLATE, 'cliente-demo-b.control.veraxsistemas.com.br')).toEqual({
      ok: true,
      url: 'https://api-cliente-demo-b.veraxsistemas.com.br',
    });
  });

  it.each([
    'localhost',
    'control.veraxsistemas.com.br',
    'cliente-demo-a.example.com',
    'vxc-cliente-demo-a.web.app',
    'xn--clnte-bsa.control.veraxsistemas.com.br',
  ])('com o marcador, fora de um endereço de cliente não resolve (%s)', (hostname) => {
    expect(resolveApiUrl(TEMPLATE, hostname)).toEqual({ ok: false });
  });

  it('a troca só aceita um subdomínio válido', () => {
    expect(fillTenant(TEMPLATE, 'cliente-demo-a')).toBe('https://api-cliente-demo-a.veraxsistemas.com.br');
    expect(() => fillTenant(TEMPLATE, 'evil.example.com/x')).toThrow(/inválido/);
    expect(() => fillTenant(TEMPLATE, '')).toThrow(/inválido/);
  });
});
