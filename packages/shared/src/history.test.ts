import { describe, expect, it } from 'vitest';
import { AUDIT_PERIODS } from './audit.js';
import { FINDING_PERIODS } from './findings.js';
import {
  HISTORY_PERIOD_DAYS,
  historyPeriodStart,
  MIN_HISTORY_DAYS,
  periodBeyondHistoryMessage,
  periodFitsHistory,
  periodsWithinHistory,
  planHistorySchema,
} from './history.js';
import { PLAN_LIMIT_BOUNDS, PLANS, resolvePlan } from './plans.js';
import { REPORT_PERIODS } from './reports.js';

describe('histórico do plano nas telas', () => {
  it('12 meses são 365 dias, o histórico do Profissional', () => {
    expect(HISTORY_PERIOD_DAYS['12m']).toBe(365);
    expect(HISTORY_PERIOD_DAYS['12m']).toBe(PLANS.profissional?.historyDays);
    expect(historyPeriodStart('12m', new Date('2026-11-05T12:00:00.000Z')).toISOString()).toBe(
      '2025-11-05T12:00:00.000Z',
    );
    expect(historyPeriodStart('24h', new Date('2026-11-05T12:00:00.000Z')).toISOString()).toBe(
      '2026-11-04T12:00:00.000Z',
    );
  });

  it('achados, auditoria e relatórios oferecem 12 meses', () => {
    expect(FINDING_PERIODS).toContain('12m');
    expect(AUDIT_PERIODS).toContain('12m');
    expect(REPORT_PERIODS).toContain('12m');
  });

  it('Essencial (90 dias) fica sem 12 meses; Profissional (365) e Interno (sem limite) têm todos', () => {
    const days = (plan: 'essencial' | 'profissional' | 'interno') => resolvePlan(plan).limits.historyDays;
    expect(periodsWithinHistory(FINDING_PERIODS, days('essencial'))).toEqual(['24h', '7d', '30d', '90d']);
    expect(periodsWithinHistory(REPORT_PERIODS, days('essencial'))).toEqual(['7d', '30d', '90d']);
    expect(periodsWithinHistory(FINDING_PERIODS, days('profissional'))).toEqual([...FINDING_PERIODS]);
    expect(periodsWithinHistory(AUDIT_PERIODS, days('interno'))).toEqual([...AUDIT_PERIODS]);
  });

  it('o limite é o próprio histórico: o período igual cabe, o mais longo não', () => {
    expect(periodFitsHistory('90d', 90)).toBe(true);
    expect(periodFitsHistory('12m', 364)).toBe(false);
    expect(periodFitsHistory('12m', 365)).toBe(true);
    // Um ajuste do Enterprise com menos de 90 dias tira também o 90d.
    expect(periodsWithinHistory(FINDING_PERIODS, 60)).toEqual(['24h', '7d', '30d']);
    expect(periodFitsHistory('12m', null)).toBe(true);
  });

  it('sem saber o plano, só o que todo plano tem (até 30 dias)', () => {
    expect(MIN_HISTORY_DAYS).toBe(PLAN_LIMIT_BOUNDS.historyDays.min);
    expect(periodsWithinHistory(FINDING_PERIODS, MIN_HISTORY_DAYS)).toEqual(['24h', '7d', '30d']);
  });

  it('a recusa diz o histórico do plano e o que fazer', () => {
    expect(periodBeyondHistoryMessage(90)).toBe(
      'Seu plano guarda 90 dias de histórico. Escolha um período menor ou fale com a Verax para ampliar.',
    );
  });

  it('contrato do GET /v1/plan/history: só o histórico, inteiro na faixa do plano ou sem limite', () => {
    expect(planHistorySchema.parse({ historyDays: 90 })).toEqual({ historyDays: 90 });
    expect(planHistorySchema.parse({ historyDays: null })).toEqual({ historyDays: null });
    expect(planHistorySchema.safeParse({ historyDays: 10 }).success).toBe(false);
    expect(planHistorySchema.safeParse({ historyDays: 90.5 }).success).toBe(false);
    expect(planHistorySchema.safeParse({ historyDays: 90, maxUsers: 5 }).success).toBe(false);
  });
});
