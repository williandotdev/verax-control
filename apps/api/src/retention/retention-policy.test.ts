import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  decideHistoryDays,
  retentionCutoffs,
  retentionWindowStart,
  subtractUtcMonths,
} from './retention-policy.js';

const at = (iso: string) => new Date(iso);

describe('janela do expurgo', () => {
  it('começa às 04:00 UTC da data UTC', () => {
    expect(retentionWindowStart(at('2026-11-09T03:59:59.999Z')).toISOString()).toBe(
      '2026-11-09T04:00:00.000Z',
    );
    expect(retentionWindowStart(at('2026-11-09T23:30:00.000Z')).toISOString()).toBe(
      '2026-11-09T04:00:00.000Z',
    );
    // 01:00 de Brasília no dia 10 ainda é dia 10 em UTC.
    expect(retentionWindowStart(at('2026-11-10T04:00:00.000Z')).toISOString()).toBe(
      '2026-11-10T04:00:00.000Z',
    );
  });
});

describe('meses no calendário UTC (como o Postgres)', () => {
  it.each([
    ['2027-12-15T10:20:30.400Z', 13, '2026-11-15T10:20:30.400Z'],
    ['2027-03-31T00:00:00.000Z', 1, '2027-02-28T00:00:00.000Z'],
    ['2028-03-31T00:00:00.000Z', 1, '2028-02-29T00:00:00.000Z'],
    ['2028-01-31T12:00:00.000Z', 13, '2026-12-31T12:00:00.000Z'],
    ['2027-12-31T23:59:59.999Z', 13, '2026-11-30T23:59:59.999Z'],
  ])('%s menos %i meses é %s', (from, months, expected) => {
    expect(subtractUtcMonths(at(from), months).toISOString()).toBe(expected);
  });
});

describe('cortes', () => {
  const now = at('2027-12-15T05:00:00.000Z');

  it('histórico pelo plano mais um dia de folga; auditoria em 13 meses mais um dia', () => {
    const cutoffs = retentionCutoffs(now, 90);
    expect(cutoffs.history?.toISOString()).toBe(new Date(now.getTime() - 91 * DAY_MS).toISOString());
    expect(cutoffs.audit?.toISOString()).toBe('2026-11-14T05:00:00.000Z');
    expect(cutoffs.inventory.toISOString()).toBe(new Date(now.getTime() - 31 * DAY_MS).toISOString());
    expect(cutoffs.unowned.toISOString()).toBe(new Date(now.getTime() - 90 * DAY_MS).toISOString());
    expect(cutoffs.notifications.toISOString()).toBe(new Date(now.getTime() - 90 * DAY_MS).toISOString());
    expect(cutoffs.operational.toISOString()).toBe('2027-12-14T05:00:00.000Z');
  });

  it('a auditoria nunca sai antes do histórico que ela descreve', () => {
    // 365 dias: 13 meses ainda é mais antigo.
    expect(retentionCutoffs(now, 365).audit?.toISOString()).toBe('2026-11-14T05:00:00.000Z');
    // 730 dias: vale o histórico.
    const long = retentionCutoffs(now, 730);
    expect(long.audit?.toISOString()).toBe(long.history?.toISOString());
  });

  it('sem limite (plano interno): nem histórico nem auditoria saem; inventário, fila e operação sim', () => {
    const cutoffs = retentionCutoffs(now, null);
    expect(cutoffs.history).toBeNull();
    expect(cutoffs.audit).toBeNull();
    expect(cutoffs.inventory.getTime()).toBeLessThan(now.getTime());
    expect(cutoffs.unowned.getTime()).toBeLessThan(now.getTime());
  });

  it('recusa prazo fora da faixa dos planos (piso de 30 dias)', () => {
    expect(() => retentionCutoffs(now, 29)).toThrow(/30 a 3650/);
    expect(() => retentionCutoffs(now, 0)).toThrow(/30 a 3650/);
    expect(() => retentionCutoffs(now, 3651)).toThrow(/30 a 3650/);
    expect(() => retentionCutoffs(now, 90.5)).toThrow(/30 a 3650/);
  });
});

describe('carência quando o plano diminui o prazo', () => {
  const now = at('2027-01-10T05:00:00.000Z');
  const days = (n: number) => new Date(now.getTime() - n * DAY_MS);

  it('primeira execução: vale o plano', () => {
    expect(decideHistoryDays(90, null, now)).toEqual({
      days: 90,
      state: { appliedDays: 90, pendingSince: null },
      graceUntil: null,
    });
  });

  it('mesmo prazo ou aumento: vale o plano na hora', () => {
    expect(decideHistoryDays(90, { appliedDays: 90, pendingSince: null }, now).days).toBe(90);
    expect(decideHistoryDays(365, { appliedDays: 90, pendingSince: null }, now)).toMatchObject({
      days: 365,
      state: { appliedDays: 365, pendingSince: null },
    });
    expect(decideHistoryDays(null, { appliedDays: 365, pendingSince: null }, now).days).toBeNull();
  });

  it('redução: o prazo anterior continua por 30 dias, contados da primeira execução que viu a redução', () => {
    const first = decideHistoryDays(90, { appliedDays: 365, pendingSince: null }, now);
    expect(first).toEqual({
      days: 365,
      state: { appliedDays: 365, pendingSince: now },
      graceUntil: new Date(now.getTime() + 30 * DAY_MS),
    });
    // 29 dias depois, ainda na carência; a data da primeira vez não muda.
    const later = new Date(now.getTime() + 29 * DAY_MS);
    expect(decideHistoryDays(90, first.state, later)).toMatchObject({
      days: 365,
      state: { pendingSince: now },
    });
    // Com 30 dias, passa ao prazo novo.
    const after = new Date(now.getTime() + 30 * DAY_MS);
    expect(decideHistoryDays(90, first.state, after)).toEqual({
      days: 90,
      state: { appliedDays: 90, pendingSince: null },
      graceUntil: null,
    });
  });

  it('sem limite para limitado também tem carência', () => {
    expect(decideHistoryDays(90, { appliedDays: null, pendingSince: null }, now)).toMatchObject({
      days: null,
      state: { appliedDays: null, pendingSince: now },
    });
  });

  it('voltar ao prazo maior durante a carência cancela a redução', () => {
    expect(decideHistoryDays(365, { appliedDays: 365, pendingSince: days(10) }, now)).toEqual({
      days: 365,
      state: { appliedDays: 365, pendingSince: null },
      graceUntil: null,
    });
  });

  it('nova redução durante a carência não reinicia a contagem', () => {
    const decision = decideHistoryDays(30, { appliedDays: 365, pendingSince: days(20) }, now);
    expect(decision).toMatchObject({ days: 365, state: { pendingSince: days(20) } });
    expect(decision.graceUntil).toEqual(new Date(days(20).getTime() + 30 * DAY_MS));
  });
});
