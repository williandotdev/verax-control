import { describe, expect, it } from 'vitest';
import { loginPath, safeReturnPath } from './return-path';

describe('caminho de volta depois de entrar', () => {
  it('aceita só telas do próprio console', () => {
    expect(safeReturnPath('/clientes')).toBe('/clientes');
    expect(safeReturnPath('/tabelas-de-preco/teste-v2?aba=1')).toBe('/tabelas-de-preco/teste-v2?aba=1');
  });

  it('recusa outro site, esquema, barra invertida, caracteres de controle e as telas de acesso', () => {
    for (const bad of [
      null,
      undefined,
      '',
      'clientes',
      '//exemplo.example/x',
      'https://exemplo.example',
      '/\\exemplo.example',
      'javascript:alert(1)',
      '/clientes\n',
      '/entrar',
      '/entrar?voltar=/x',
      '/configurar',
      `/${'a'.repeat(600)}`,
    ]) {
      expect(safeReturnPath(bad), String(bad)).toBe('/');
    }
  });

  it('monta o endereço da entrada com a tela atual', () => {
    expect(loginPath('/clientes/01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(
      '/entrar?voltar=%2Fclientes%2F01ARZ3NDEKTSV4RRFFQ69G5FAV',
    );
    expect(loginPath('/')).toBe('/entrar');
    expect(loginPath('/entrar')).toBe('/entrar');
  });
});
