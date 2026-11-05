import { describe, expect, it } from 'vitest';
import { BYTES_PER_GIB, reachedThresholds, usageDedupeKey, usageNoticeRows } from './usage-notices.js';

const tenantId = '018f2c1e-0000-7000-8000-00000000a001';
const month = new Date('2026-11-01T00:00:00.000Z');
const limit = 15n * BYTES_PER_GIB;

describe('avisos de volume do plano (PR-16)', () => {
  it('o GiB é 2^30 bytes', () => {
    expect(BYTES_PER_GIB).toBe(1_073_741_824n);
  });

  it('faixas alcançadas: 80% e 100% do limite, contando a igualdade', () => {
    expect(reachedThresholds(0n, limit)).toEqual([]);
    expect(reachedThresholds((limit * 80n) / 100n - 1n, limit)).toEqual([]);
    expect(reachedThresholds((limit * 80n) / 100n, limit)).toEqual([80]);
    expect(reachedThresholds(limit - 1n, limit)).toEqual([80]);
    expect(reachedThresholds(limit, limit)).toEqual([80, 100]);
    expect(reachedThresholds(limit * 3n, limit)).toEqual([80, 100]);
  });

  it('chave por mês e faixa', () => {
    expect(usageDedupeKey(month, 80)).toBe('usage:2026-11:80');
    expect(usageDedupeKey(new Date('2027-01-01T00:00:00.000Z'), 100)).toBe('usage:2027-01:100');
  });

  it('abaixo de 80%, nada; de 80% a 100%, o aviso de 80%', () => {
    expect(usageNoticeRows(tenantId, month, limit / 2n, limit)).toEqual([]);
    expect(usageNoticeRows(tenantId, month, (limit * 9n) / 10n, limit)).toEqual([
      { tenantId, kind: 'plan_usage', dedupeKey: 'usage:2026-11:80', usageMonth: month, usagePercent: 80 },
    ]);
  });

  it('em 100%, o aviso de 100% e o de 80% já coberto (nasce skipped, para sair um e-mail só)', () => {
    expect(usageNoticeRows(tenantId, month, limit, limit)).toEqual([
      {
        tenantId,
        kind: 'plan_usage',
        dedupeKey: 'usage:2026-11:80',
        usageMonth: month,
        usagePercent: 80,
        status: 'skipped',
        lastError: 'superseded',
      },
      { tenantId, kind: 'plan_usage', dedupeKey: 'usage:2026-11:100', usageMonth: month, usagePercent: 100 },
    ]);
  });
});
