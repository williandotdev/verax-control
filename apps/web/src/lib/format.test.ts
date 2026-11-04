import { describe, expect, it } from 'vitest';
import { formatDay, formatList, formatRelative, formatTimestamp, plural } from './format';

const now = new Date('2026-11-02T13:00:00.000Z');

describe('formatação', () => {
  it.each([
    ['2026-11-02T12:59:40.000Z', 'agora há pouco'],
    ['2026-11-02T12:57:00.000Z', 'há 3 minutos'],
    ['2026-11-02T11:00:00.000Z', 'há 2 horas'],
    ['2026-11-01T13:00:00.000Z', 'ontem'],
    ['2026-10-30T13:00:00.000Z', 'há 3 dias'],
  ])('tempo relativo de %s', (value, expected) => {
    expect(formatRelative(value, now)).toBe(expected);
  });

  it('data inválida vira traço', () => {
    expect(formatRelative('não é data', now)).toBe('—');
    expect(formatTimestamp('não é data')).toBe('—');
    expect(formatDay('2026-11')).toBe('—');
    expect(formatDay('2026-11-03T00:00:00.000Z')).toBe('—');
  });

  it('dia do calendário pelas partes, sem o fuso puxar para o dia anterior', () => {
    expect(formatDay('2026-11-03')).toBe('03/11/2026');
  });

  it('lista em português', () => {
    expect(formatList(['a'])).toBe('a');
    expect(formatList(['a', 'b'])).toBe('a e b');
    expect(formatList(['a', 'b', 'c'])).toBe('a, b e c');
  });

  it('plural', () => {
    expect(plural(1, 'conta', 'contas')).toBe('1 conta');
    expect(plural(0, 'conta', 'contas')).toBe('0 contas');
    expect(plural(2, 'conta', 'contas')).toBe('2 contas');
  });
});
