import { describe, expect, it } from 'vitest';
import { dateInDays, endOfDay, previewText, targetText } from './case-exception-text';

describe('textos da exceção a partir do caso', () => {
  it('a prévia diz quantos alertas e quantos altos, no singular e no plural', () => {
    expect(previewText({ days: 30, matched: 0, high: 0 })).toBe(
      'Teria coberto 0 alertas nos últimos 30 dias.',
    );
    expect(previewText({ days: 30, matched: 1, high: 0 })).toBe(
      'Teria coberto 1 alerta nos últimos 30 dias.',
    );
    expect(previewText({ days: 30, matched: 1234, high: 1 })).toBe(
      'Teria coberto 1.234 alertas nos últimos 30 dias, 1 alto.',
    );
    expect(previewText({ days: 30, matched: 12, high: 3 })).toBe(
      'Teria coberto 12 alertas nos últimos 30 dias, 3 altos.',
    );
  });

  it('o alvo leva a regra, a fonte pelo nome, a conta e o evento, como texto', () => {
    const target = {
      ruleId: '990511',
      logSource: 'inspector',
      accountId: '111111111111',
      eventName: '<img src=x onerror=alert(1)>',
      alerts: 3,
      severity: 'high' as const,
    };
    const text = targetText(target);
    expect(text.startsWith('Regra 990511 · ')).toBe(true);
    expect(text).toContain('conta 111111111111');
    expect(text.endsWith('<img src=x onerror=alert(1)>')).toBe(true);
    expect(targetText({ ...target, eventName: null, logSource: 'desconhecida' })).toBe(
      'Regra 990511 · desconhecida · conta 111111111111',
    );
  });

  it('as datas: daqui a N dias no fuso local, e o fim do dia escolhido; vazio é sem validade', () => {
    expect(dateInDays(30, new Date(2026, 10, 25, 12))).toBe('2026-12-25');
    expect(endOfDay('')).toBeNull();
    expect(new Date(endOfDay('2026-12-25') ?? '').getDate()).toBe(25);
  });
});
