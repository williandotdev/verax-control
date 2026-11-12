import { describe, expect, it } from 'vitest';
import {
  addDays,
  brasiliaDay,
  isCalendarDay,
  isUsageDayFinal,
  usageDailyReportSchema,
  usageDayFinalAt,
} from './usage-day.js';

describe('volume por dia (CE-09)', () => {
  it('o dia é o do calendário de Brasília: vira às 03:00 UTC', () => {
    expect(brasiliaDay(new Date('2026-11-12T02:59:59.999Z'))).toBe('2026-11-11');
    expect(brasiliaDay(new Date('2026-11-12T03:00:00.000Z'))).toBe('2026-11-12');
    // Virada de mês e de ano.
    expect(brasiliaDay(new Date('2026-12-01T02:00:00Z'))).toBe('2026-11-30');
    expect(brasiliaDay(new Date('2027-01-01T02:59:00Z'))).toBe('2026-12-31');
  });

  it('dias do calendário e a conta de dias', () => {
    expect(isCalendarDay('2026-02-28')).toBe(true);
    expect(isCalendarDay('2026-02-29')).toBe(false);
    expect(isCalendarDay('2028-02-29')).toBe(true);
    expect(isCalendarDay('2026-11-1')).toBe(false);
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('o dia fecha às 06:00 de Brasília do dia seguinte', () => {
    expect(usageDayFinalAt('2026-11-11').toISOString()).toBe('2026-11-12T09:00:00.000Z');
    expect(isUsageDayFinal('2026-11-11', new Date('2026-11-12T08:59:59.999Z'))).toBe(false);
    expect(isUsageDayFinal('2026-11-11', new Date('2026-11-12T09:00:00.000Z'))).toBe(true);
  });

  it('o relatório usage.daily: estrito, com todas as fontes', () => {
    const report = {
      tenantId: '01900000-0000-7000-8000-000000000001',
      day: '2026-11-11',
      sources: {
        aws: { bytes: 10, events: 0 },
        gcp: { bytes: 5, events: 2 },
        cloudflare: { bytes: 0, events: 0 },
      },
      final: false,
    };
    expect(usageDailyReportSchema.parse(report)).toEqual(report);
    expect(usageDailyReportSchema.safeParse({ ...report, extra: 1 }).success).toBe(false);
    const { gcp: _gcp, ...withoutGcp } = report.sources;
    expect(usageDailyReportSchema.safeParse({ ...report, sources: withoutGcp }).success).toBe(false);
    expect(
      usageDailyReportSchema.safeParse({
        ...report,
        sources: { ...report.sources, aws: { bytes: -1, events: 0 } },
      }).success,
    ).toBe(false);
    expect(usageDailyReportSchema.safeParse({ ...report, day: '2026-11-31' }).success).toBe(false);
  });
});
