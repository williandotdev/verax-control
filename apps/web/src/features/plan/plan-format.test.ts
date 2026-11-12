import { GB_BYTES, GIB_BYTES } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import {
  formatCycle,
  formatGb,
  formatGbPerDay,
  formatOverage,
  formatPercent,
  formatShortDay,
  formatUsageMonth,
  formatVolume,
} from './plan-format';

describe('textos de "Plano e uso"', () => {
  it('volume em GiB com uma casa; pouco volume em MiB, para o começo do mês não virar "0 GiB"', () => {
    expect(formatVolume(0)).toBe('0 GiB');
    expect(formatVolume(12.34 * GIB_BYTES)).toBe('12,3 GiB');
    expect(formatVolume(1500 * GIB_BYTES)).toBe('1.500 GiB');
    expect(formatVolume(GIB_BYTES / 10)).toBe('0,1 GiB');
    expect(formatVolume(50 * 1024 ** 2)).toBe('50 MiB');
    expect(formatVolume(1000)).toBe('menos de 1 MiB');
  });

  it('porcentagem para baixo (99,6% não é 100%), sem perder ponto no erro do ponto flutuante', () => {
    expect(formatPercent(0.996)).toBe('99%');
    expect(formatPercent(0.29)).toBe('29%');
    expect(formatPercent(1.25)).toBe('125%');
    expect(formatPercent(0)).toBe('0%');
  });

  it('mês do uso por extenso', () => {
    expect(formatUsageMonth('2026-11')).toBe('novembro de 2026');
    expect(formatUsageMonth('2027-01')).toBe('janeiro de 2027');
  });

  it('franquia (CE-10): GB de 10⁹ bytes para baixo, excedente em centésimos de GB/dia, o ciclo por extenso', () => {
    expect(formatGb(0)).toBe('0 GB');
    expect(formatGb(3.56 * GB_BYTES)).toBe('3,5 GB');
    expect(formatGb(GIB_BYTES)).toBe('1 GB');
    expect(formatGb(1500 * GB_BYTES)).toBe('1.500 GB');
    expect(formatGb(42 * 1_000_000)).toBe('42 MB');
    expect(formatGb(999)).toBe('menos de 1 MB');
    expect(formatGbPerDay(2.25 * GB_BYTES)).toBe('2,2 GB/dia');
    expect(formatOverage(33)).toBe('0,33 GB/dia');
    expect(formatOverage(100)).toBe('1,00 GB/dia');
    expect(formatCycle('2026-11-01', '2026-11-30')).toBe('1º a 30 de novembro');
    expect(formatShortDay('2026-11-05')).toBe('05/11');
  });
});
