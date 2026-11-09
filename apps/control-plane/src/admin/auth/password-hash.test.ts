import { describe, expect, it } from 'vitest';
import { burnPasswordCheck, hashPassword, PASSWORD_PARAMS, verifyPassword } from './password-hash.js';

/** Custo baixo nos testes que não são do custo (o formato e a comparação são os mesmos). */
const FAST = { logN: 10, r: 8, p: 1 };

describe('hash de senha (scrypt)', () => {
  it('usa os parâmetros da OWASP por padrão e guarda sal e parâmetros no formato', async () => {
    expect(PASSWORD_PARAMS).toEqual({ logN: 15, r: 8, p: 3 });
    const stored = await hashPassword('senha de teste bem longa');
    expect(stored).toMatch(/^scrypt\$15\$8\$3\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(stored).not.toContain('senha');
    await expect(verifyPassword('senha de teste bem longa', stored)).resolves.toBe(true);
  });

  it('confere a senha certa e recusa a errada, outra caixa e o vazio', async () => {
    const stored = await hashPassword('Correta-Cavalo-Bateria', FAST);
    await expect(verifyPassword('Correta-Cavalo-Bateria', stored)).resolves.toBe(true);
    for (const wrong of ['correta-cavalo-bateria', 'Correta-Cavalo-Bateri', '', 'Correta-Cavalo-Bateria ']) {
      await expect(verifyPassword(wrong, stored), wrong).resolves.toBe(false);
    }
  });

  it('sal novo a cada hash: a mesma senha nunca gera o mesmo texto', async () => {
    const first = await hashPassword('mesma senha de teste', FAST);
    const second = await hashPassword('mesma senha de teste', FAST);
    expect(first).not.toBe(second);
    await expect(verifyPassword('mesma senha de teste', second)).resolves.toBe(true);
  });

  it('a mesma senha em formas Unicode diferentes (NFC e NFD) confere', async () => {
    const stored = await hashPassword('ação-segura-123', FAST);
    await expect(verifyPassword('ação-segura-123'.normalize('NFD'), stored)).resolves.toBe(true);
  });

  it('hash fora do formato ou com custo absurdo é recusado, sem exceção', async () => {
    const stored = await hashPassword('qualquer senha longa', FAST);
    const parts = stored.split('$');
    const cases = [
      '',
      'conta-de-teste-sem-senha',
      stored.replace('scrypt$', 'bcrypt$'),
      [parts[0], '30', parts[2], parts[3], parts[4], parts[5]].join('$'),
      [parts[0], parts[1], '99', parts[3], parts[4], parts[5]].join('$'),
      `${stored}x`,
    ];
    for (const value of cases) {
      await expect(verifyPassword('qualquer senha longa', value), value).resolves.toBe(false);
    }
  });

  it('sem conta, o mesmo trabalho e sempre falso', async () => {
    await expect(burnPasswordCheck('qualquer coisa')).resolves.toBe(false);
  });
});
