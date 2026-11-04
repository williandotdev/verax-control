import { describe, expect, it } from 'vitest';
import { cnpjCheckDigits, isValidCnpj, normalizeCnpj } from './cnpj.js';

/**
 * CNPJs sintéticos (CLAUDE.md, regra 10): o exemplo publicado pela Receita para o formato alfanumérico
 * (`12.ABC.345/01DE-35`), um numérico de exemplo com DV válido e bases inventadas com o DV calculado aqui.
 */
const RECEITA_EXAMPLE = '12ABC34501DE35';
const NUMERIC_EXAMPLE = '11222333000181';

describe('CNPJ alfanumérico (CP-03)', () => {
  it('confere o exemplo da Receita: cada caractere vale o código ASCII menos 48', () => {
    expect(cnpjCheckDigits('12ABC34501DE')).toBe('35');
    expect(isValidCnpj(RECEITA_EXAMPLE)).toBe(true);
  });

  it('o numérico antigo é um caso particular e continua válido', () => {
    expect(cnpjCheckDigits('112223330001')).toBe('81');
    expect(isValidCnpj(NUMERIC_EXAMPLE)).toBe(true);
  });

  it('recusa dígito verificador errado em qualquer das duas posições', () => {
    expect(isValidCnpj('12ABC34501DE36')).toBe(false);
    expect(isValidCnpj('12ABC34501DE45')).toBe(false);
    expect(isValidCnpj('11222333000182')).toBe(false);
  });

  it('recusa formato errado: letra no DV, tamanho, minúscula sem normalizar, símbolos', () => {
    for (const bad of [
      '12ABC34501DEA5',
      '12ABC34501DE3',
      '12ABC34501DE355',
      '12abc34501de35',
      '12ABC34501D_35',
      '',
      '00000000000000',
    ]) {
      expect(isValidCnpj(bad), bad).toBe(false);
    }
  });

  it('normaliza a máscara e as minúsculas, e só elas', () => {
    expect(normalizeCnpj(' 12.ABC.345/01DE-35 ')).toBe(RECEITA_EXAMPLE);
    expect(normalizeCnpj('12.abc.345/01de-35')).toBe(RECEITA_EXAMPLE);
    expect(normalizeCnpj('11.222.333/0001-81')).toBe(NUMERIC_EXAMPLE);
    expect(normalizeCnpj('12 ABC 345 01DE 35')).toBe('12 ABC 345 01DE 35');
    expect(isValidCnpj(normalizeCnpj('12 ABC 345 01DE 35'))).toBe(false);
  });

  it('bases inventadas com o DV calculado validam; trocar uma letra da base invalida', () => {
    for (const base of ['A1B2C3D4E5F6', 'ZZZZZZZZ0001', '0000000A0001']) {
      const cnpj = `${base}${cnpjCheckDigits(base)}`;
      expect(isValidCnpj(cnpj), cnpj).toBe(true);
      const changed = `${base.slice(0, 11)}${base[11] === 'X' ? 'Y' : 'X'}${cnpj.slice(12)}`;
      expect(isValidCnpj(changed), changed).toBe(false);
    }
    expect(() => cnpjCheckDigits('12abc34501de')).toThrow(RangeError);
  });
});
