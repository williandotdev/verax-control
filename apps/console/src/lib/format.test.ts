import { describe, expect, it } from 'vitest';
import { formatDateTime, startOfDayInBrasilia } from './format';

describe('startOfDayInBrasilia (o dia escolhido no calendário)', () => {
  it('é o começo do dia em Brasília, e as telas mostram o mesmo dia, qualquer que seja o fuso da máquina', () => {
    expect(startOfDayInBrasilia('2027-01-31')).toBe('2027-01-31T03:00:00.000Z');
    expect(formatDateTime(startOfDayInBrasilia('2027-01-31'))).toBe('31/01/2027, 00:00');
    expect(startOfDayInBrasilia('2028-02-29')).toBe('2028-02-29T03:00:00.000Z');
  });

  it('recusa o que não é uma data do calendário', () => {
    for (const day of ['2027-02-31', '31/01/2027', '2027-1-31', '', '2027-01-31T00:00']) {
      expect(startOfDayInBrasilia(day), day).toBeUndefined();
    }
  });
});
