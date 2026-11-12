import { describe, expect, it } from 'vitest';
import {
  billingCycleOf,
  currentBillingCycle,
  cycleBudgetGb,
  franchiseOnDay,
  franchiseScheduleSchema,
  GB_BYTES,
  overageUnits,
  projectedOverageUnits,
} from './franchise.js';

describe('franquia em GB/dia (CE-10)', () => {
  it('o ciclo é o mês de Brasília, do dia 1º ao último', () => {
    expect(billingCycleOf('2026-11-11')).toEqual({
      start: '2026-11-01',
      end: '2026-11-30',
      day: 11,
      days: 30,
    });
    expect(billingCycleOf('2027-02-28')).toEqual({
      start: '2027-02-01',
      end: '2027-02-28',
      day: 28,
      days: 28,
    });
    expect(billingCycleOf('2028-02-29').days).toBe(29);
    expect(billingCycleOf('2026-12-31')).toEqual({
      start: '2026-12-01',
      end: '2026-12-31',
      day: 31,
      days: 31,
    });
    // 00:30 UTC do dia 1º ainda é o último dia do mês anterior em Brasília.
    expect(currentBillingCycle(new Date('2026-12-01T00:30:00Z')).start).toBe('2026-11-01');
  });

  it('a franquia de cada dia e o orçamento do ciclo (Σ F_d)', () => {
    const schedule = [
      { from: '2026-10-15', gbPerDay: 3 },
      { from: '2026-11-11', gbPerDay: 5 },
    ];
    expect(franchiseOnDay(schedule, '2026-10-14')).toBe(0);
    expect(franchiseOnDay(schedule, '2026-11-10')).toBe(3);
    expect(franchiseOnDay(schedule, '2026-11-11')).toBe(5);
    // Novembro: 10 dias a 3 e 20 dias a 5.
    expect(cycleBudgetGb(schedule, billingCycleOf('2026-11-20'))).toBe(10 * 3 + 20 * 5);
    expect(franchiseScheduleSchema.safeParse(schedule).success).toBe(true);
    expect(franchiseScheduleSchema.safeParse([...schedule].reverse()).success).toBe(false);
    expect(franchiseScheduleSchema.safeParse([schedule[0], schedule[0]]).success).toBe(false);
    expect(franchiseScheduleSchema.safeParse([]).success).toBe(false);
  });

  it('excedente: floor(100 × max(0, U − B) / D), a dúvida a favor do cliente', () => {
    // 30 dias a 3 GB/dia: B = 90 GB.
    expect(overageUnits(90 * GB_BYTES, 90, 30)).toBe(0);
    expect(overageUnits(80 * GB_BYTES, 90, 30)).toBe(0);
    // 3 GB acima em 30 dias: 0,1 GB/dia = 10 centésimos.
    expect(overageUnits(93 * GB_BYTES, 90, 30)).toBe(10);
    // Um byte a menos do que 10 centésimos: fica em 9.
    expect(overageUnits(93 * GB_BYTES - 1, 90, 30)).toBe(9);
    // Um byte acima do orçamento ainda não é um centésimo.
    expect(overageUnits(90 * GB_BYTES + 1, 90, 30)).toBe(0);
    // Valores grandes, sem erro de ponto flutuante: 1000 GB/dia por 31 dias, 1 GB acima.
    expect(overageUnits(31_001 * GB_BYTES, 31_000, 31)).toBe(3);
    expect(() => overageUnits(-1, 90, 30)).toThrow(RangeError);
    expect(() => overageUnits(1, 90, 0)).toThrow(RangeError);
  });

  it('excedente projetado: a média até hoje mantida até o fim do ciclo', () => {
    // Dia 10 de 30, 40 GB usados: a média é 4 GB/dia, a projeção é 120 GB contra 90.
    expect(projectedOverageUnits(40 * GB_BYTES, 90, 10, 30)).toBe(100);
    // Dentro do orçamento: zero.
    expect(projectedOverageUnits(30 * GB_BYTES, 90, 10, 30)).toBe(0);
    // Igual ao excedente do ciclo fechado no último dia.
    expect(projectedOverageUnits(93 * GB_BYTES, 90, 30, 30)).toBe(overageUnits(93 * GB_BYTES, 90, 30));
    // Para baixo: 3 dias de 31 com 10 GB, contra 93 GB (3 GB/dia): 10/3 × 31 = 103,33 GB, (103,33 − 93)/31 = 0,333.
    expect(projectedOverageUnits(10 * GB_BYTES, 93, 3, 31)).toBe(33);
  });
});
