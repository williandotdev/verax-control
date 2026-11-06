import { AUDIT_PERIODS, FINDING_PERIODS, REPORT_PERIODS, resolvePlan } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { offeredPeriods } from './plan-history';

const history = (plan: 'essencial' | 'profissional' | 'interno') => ({
  historyDays: resolvePlan(plan).limits.historyDays,
});

describe('períodos oferecidos pelo histórico do plano', () => {
  it('Essencial (90 dias): sem 12 meses em achados, auditoria e relatórios', () => {
    expect(offeredPeriods(FINDING_PERIODS, history('essencial'))).toEqual(['24h', '7d', '30d', '90d']);
    expect(offeredPeriods(AUDIT_PERIODS, history('essencial'))).toEqual(['24h', '7d', '30d', '90d']);
    expect(offeredPeriods(REPORT_PERIODS, history('essencial'))).toEqual(['7d', '30d', '90d']);
  });

  it('Profissional (365 dias) e Interno (sem limite): todos, com 12 meses', () => {
    expect(offeredPeriods(FINDING_PERIODS, history('profissional'))).toEqual([...FINDING_PERIODS]);
    expect(offeredPeriods(REPORT_PERIODS, history('profissional'))).toContain('12m');
    expect(offeredPeriods(AUDIT_PERIODS, history('interno'))).toEqual([...AUDIT_PERIODS]);
  });

  it('ajuste do histórico abaixo de 90 dias tira também os 90 dias', () => {
    expect(offeredPeriods(REPORT_PERIODS, { historyDays: 60 })).toEqual(['7d', '30d']);
  });

  it('sem o plano (carregando ou com erro), só o que todo plano tem: até 30 dias', () => {
    expect(offeredPeriods(FINDING_PERIODS, undefined)).toEqual(['24h', '7d', '30d']);
    expect(offeredPeriods(REPORT_PERIODS, undefined)).toEqual(['7d', '30d']);
  });
});
