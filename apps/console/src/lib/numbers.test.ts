import { describe, expect, it } from 'vitest';
import {
  centsText,
  formatCents,
  formatRatio,
  parseDecimal,
  parseInteger,
  parseMoney,
  parsePercent,
  rateText,
} from './numbers';

/** Valores de exemplo, sem relação com preços ou custos de verdade. */
describe('números em pt-BR', () => {
  it('formata centavos em reais e taxas em percentual', () => {
    expect(formatCents(100_000)).toBe('R$ 1.000,00');
    expect(formatCents(-2_550)).toBe('-R$ 25,50');
    expect(formatRatio(0.4552)).toBe('45,5%');
    expect(centsText(123_456)).toBe('1.234,56');
    expect(rateText(0.0469)).toBe('4,69');
    expect(rateText(0.1)).toBe('10');
  });

  it('lê reais com vírgula decimal e ponto de milhar, em centavos', () => {
    expect(parseMoney('1.000,00')).toBe(100_000);
    expect(parseMoney('R$ 1.000')).toBe(100_000);
    expect(parseMoney('1000')).toBe(100_000);
    expect(parseMoney('12,5')).toBe(1_250);
    expect(parseMoney('12.5')).toBe(1_250);
    expect(parseMoney('1.000.000,10')).toBe(100_000_010);
    expect(parseMoney('2,')).toBe(200);
    expect(parseMoney('')).toBeUndefined();
    expect(parseMoney('1,234')).toBeNaN();
    expect(parseMoney('abc')).toBeNaN();
    expect(parseMoney('-5')).toBeNaN();
  });

  it('lê decimais pequenos com vírgula ou ponto, sem milhar', () => {
    expect(parseDecimal('0,11')).toBe(0.11);
    expect(parseDecimal('0.11')).toBe(0.11);
    expect(parseDecimal('1,')).toBe(1);
    expect(parseDecimal('1.000,5')).toBeNaN();
    expect(parseDecimal(' ')).toBeUndefined();
  });

  it('lê inteiros (com ponto de milhar) e percentuais (em taxa)', () => {
    expect(parseInteger('1.000')).toBe(1_000);
    expect(parseInteger('12')).toBe(12);
    expect(parseInteger('1,5')).toBeNaN();
    expect(parsePercent('4,69')).toBe(0.0469);
    expect(parsePercent('57%')).toBe(0.57);
    expect(parsePercent('x')).toBeNaN();
  });
});
