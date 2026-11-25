import { isTrustedExpiryValid } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import {
  dateInput,
  endOfDay,
  formatMultiplier,
  formatRemaining,
  parseCodes,
  parseMultiplier,
  routeName,
} from './web-forms';

const MINUTE = 60_000;

describe('os formulários dos ataques web', () => {
  it('o que falta da observação: horas e minutos, nunca zero enquanto falta', () => {
    expect(formatRemaining(72 * 60 * MINUTE)).toBe('72 h');
    expect(formatRemaining(41 * 60 * MINUTE + 20 * MINUTE)).toBe('41 h 20 min');
    expect(formatRemaining(59 * MINUTE)).toBe('59 min');
    expect(formatRemaining(60 * MINUTE)).toBe('1 h');
    // Para cima: um segundo que falta ainda é um minuto.
    expect(formatRemaining(59 * MINUTE + 1_000)).toBe('1 h');
    expect(formatRemaining(1)).toBe('1 min');
  });

  it('o multiplicador: vírgula ou ponto, de 0,5 a 10, e nada além de número', () => {
    for (const [text, value] of [
      ['1', 1],
      [' 1,5 ', 1.5],
      ['1.5', 1.5],
      ['0,5', 0.5],
      ['10', 10],
    ] as const) {
      expect(parseMultiplier(text), text).toBe(value);
    }
    for (const text of ['', '0,49', '10,01', '0', '-1', '1e1', 'um', '1,5,2', '+1', '0x1', '.', 'Infinity']) {
      expect(parseMultiplier(text), text).toBeNull();
    }
    expect(formatMultiplier(1.5)).toBe('1,5');
    expect(parseMultiplier(formatMultiplier(2.25))).toBe(2.25);
  });

  it('os códigos de resposta: separados por vírgula, de 100 a 599; vazio é válido', () => {
    expect(parseCodes('401, 403,422')).toEqual([401, 403, 422]);
    expect(parseCodes('')).toEqual([]);
    expect(parseCodes(' , ')).toEqual([]);
    expect(parseCodes('100,599')).toEqual([100, 599]);
    for (const text of ['99', '600', '4xx', '401;403', '401 403', '4 01', '0401', '-401', '40.1']) {
      expect(parseCodes(text), text).toBeNull();
    }
  });

  it('o nome da rota: o método, o host e o caminho', () => {
    expect(routeName({ method: 'POST', host: 'loja.exemplo.com.br', path: '/entrar' })).toBe(
      'POST loja.exemplo.com.br/entrar',
    );
    expect(routeName({ method: 'ANY', host: null, path: '/entrar' })).toBe('/entrar');
  });

  it('a validade vai até o fim do dia escolhido; data que não existe é recusada', () => {
    const end = endOfDay('2026-12-31');
    expect(end && dateInput(end)).toBe('2026-12-31');
    expect(end?.getHours()).toBe(23);
    for (const text of ['', '2026-02-30', '2026-13-01', '31/12/2026', '2026-12', '2026-12-31-1', 'amanhã']) {
      expect(endOfDay(text), text).toBeNull();
    }
    // O último dia que o campo deixa escolher ainda cabe nos 365 dias da API.
    const now = new Date();
    const last = endOfDay(dateInput(new Date(now.getTime() + 364 * 24 * 60 * MINUTE)));
    expect(last !== null && isTrustedExpiryValid(last, now)).toBe(true);
    // Hoje também vale: até o fim do dia.
    const today = endOfDay(dateInput(now));
    expect(today !== null && today > now && isTrustedExpiryValid(today, now)).toBe(true);
  });
});
