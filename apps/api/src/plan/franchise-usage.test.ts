import { GB_BYTES } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { franchiseUsageOf, type UsageDayRow } from './franchise-usage.js';

const row = (day: string, source: string, gb: number): UsageDayRow => ({
  day: new Date(`${day}T00:00:00Z`),
  source,
  bytes: BigInt(Math.round(gb * GB_BYTES)),
});

describe('contador da franquia (CE-10)', () => {
  // 10/11/2026, 15:00 em Brasília: dia 10 de 30 de novembro.
  const now = new Date('2026-11-10T18:00:00.000Z');

  it('o ciclo, o orçamento, o volume do ciclo, a média, a projeção e o excedente projetado', () => {
    const rows = [
      // Outubro fica fora do ciclo (mas entra no gráfico dos 30 dias).
      row('2026-10-31', 'aws', 50),
      row('2026-11-01', 'aws', 3),
      row('2026-11-01', 'gcp', 0.5),
      row('2026-11-05', 'cloudflare', 0.5),
      row('2026-11-10', 'aws', 36),
    ];
    const usage = franchiseUsageOf(3, rows, now);
    expect(usage.cycle).toEqual({ start: '2026-11-01', end: '2026-11-30', day: 10, days: 30 });
    expect(usage.franchiseGbPerDay).toBe(3);
    expect(usage.schedule).toEqual([{ from: '2026-11-01', gbPerDay: 3 }]);
    expect(usage.budgetGb).toBe(90);
    // U_10 = 40 GB; média 4 GB/dia; projeção 120 GB; excedente (120 − 90) / 30 = 1 GB/dia = 100 centésimos.
    expect(usage.usedBytes).toBe(40 * GB_BYTES);
    expect(usage.dailyAverageBytes).toBe(4 * GB_BYTES);
    expect(usage.projectedBytes).toBe(120 * GB_BYTES);
    expect(usage.projectedOverageUnits).toBe(100);
  });

  it('os últimos 30 dias, hoje incluído, por fonte, com zero nos dias sem leitura', () => {
    const usage = franchiseUsageOf(3, [row('2026-10-12', 'aws', 1), row('2026-10-11', 'aws', 9)], now);
    expect(usage.days).toHaveLength(30);
    expect(usage.days[0]).toEqual({ day: '2026-10-12', aws: GB_BYTES, gcp: 0, cloudflare: 0 });
    expect(usage.days.at(-1)).toEqual({ day: '2026-11-10', aws: 0, gcp: 0, cloudflare: 0 });
    // O dia 11/10 fica fora dos 30 dias, e outubro não entra no ciclo.
    expect(usage.usedBytes).toBe(0);
    expect(usage.projectedOverageUnits).toBe(0);
  });

  it('o dia é o de Brasília: às 02:59 UTC do dia 1º ainda é o último dia do ciclo anterior', () => {
    const lastDay = franchiseUsageOf(5, [row('2026-11-30', 'gcp', 10)], new Date('2026-12-01T02:59:00Z'));
    expect(lastDay.cycle).toMatchObject({ start: '2026-11-01', day: 30, days: 30 });
    expect(lastDay.usedBytes).toBe(10 * GB_BYTES);
    const firstDay = franchiseUsageOf(5, [row('2026-11-30', 'gcp', 10)], new Date('2026-12-01T03:00:00Z'));
    expect(firstDay.cycle).toMatchObject({ start: '2026-12-01', day: 1, days: 31 });
    expect(firstDay.usedBytes).toBe(0);
    expect(firstDay.budgetGb).toBe(5 * 31);
  });

  it('dentro da franquia: excedente zero; uma fonte desconhecida não conta', () => {
    const usage = franchiseUsageOf(3, [row('2026-11-02', 'aws', 20), row('2026-11-02', 'outra', 999)], now);
    expect(usage.usedBytes).toBe(20 * GB_BYTES);
    expect(usage.projectedOverageUnits).toBe(0);
  });
});
