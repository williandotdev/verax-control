import { PLAN_LIMIT_BOUNDS } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { NOTIFICATION_RETENTION_DAYS } from '../retention/retention-policy.js';
import { CASE_AGE_MS } from './case-lifecycle.js';
import {
  CASE_CRITICAL_INTERVAL_MS,
  CASE_CRITICAL_ITEMS,
  CASE_DAILY_HOUR,
  CASE_DAILY_ITEMS,
  CASE_DAILY_REMINDER_DAYS,
  CASE_GROWTH_FACTOR,
  CASE_GROWTH_INTERVAL_MS,
  CASE_GROWTH_MIN_ALERTS,
  CASE_LAG_NOTICE_MS,
  CASE_NOTICE_MEMORY_MS,
  CASE_NOTICE_REARM_MS,
  caseGrowthKey,
  caseNoticeKey,
  caseNoticeType,
  caseWaveKey,
  covers,
  criticalCasesKey,
  dailyCasesKey,
  dailyDayOf,
  dailyMoment,
  detectionDecision,
  type DetectionFacts,
  dueDaily,
  growthDue,
  type GrowthFacts,
  noticeKindOf,
  recentCriticalCasesKeys,
  rememberedDailyDays,
} from './case-notice-policy.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const caseId = '018f2c1e-0000-7000-8000-0000000000ca';

describe('as regras dos avisos por caso', () => {
  it('os limites (decisão D4, a confirmar)', () => {
    expect({
      dailyHour: CASE_DAILY_HOUR,
      reminderDays: CASE_DAILY_REMINDER_DAYS,
      dailyItems: CASE_DAILY_ITEMS,
      criticalInterval: CASE_CRITICAL_INTERVAL_MS,
      criticalItems: CASE_CRITICAL_ITEMS,
      growthInterval: CASE_GROWTH_INTERVAL_MS,
      growthFactor: CASE_GROWTH_FACTOR,
      growthMinimum: CASE_GROWTH_MIN_ALERTS,
      lag: CASE_LAG_NOTICE_MS,
      rearm: CASE_NOTICE_REARM_MS,
    }).toEqual({
      dailyHour: 9,
      reminderDays: 7,
      dailyItems: 10,
      criticalInterval: HOUR_MS,
      criticalItems: 5,
      growthInterval: DAY_MS,
      growthFactor: 10,
      growthMinimum: 100,
      lag: 600_000,
      rearm: 6 * HOUR_MS,
    });
    // O que se lembra cabe no que o expurgo guarda: o aviso, e o alerta da âncora no menor plano.
    expect(CASE_NOTICE_MEMORY_MS).toBeLessThan(NOTIFICATION_RETENTION_DAYS * DAY_MS);
    expect(CASE_NOTICE_MEMORY_MS + CASE_AGE_MS).toBeLessThan(PLAN_LIMIT_BOUNDS.historyDays.min * DAY_MS);
  });

  it('as chaves cabem na coluna e dizem o que o aviso é', () => {
    const at = new Date('2026-12-02T15:42:10.123Z');
    const keys = {
      notice: caseNoticeKey(caseId, 'critical'),
      wave: caseWaveKey(caseId, 'critical', at),
      growth: caseGrowthKey(caseId, at),
      critical: criticalCasesKey(at),
      daily: dailyCasesKey('2026-12-02'),
    };
    expect(keys).toEqual({
      notice: `case:${caseId}:critical`,
      wave: `case:${caseId}:critical:${at.getTime()}`,
      growth: `case:${caseId}:growth:2026-12-02`,
      critical: 'cases-critical:2026-12-02T15:00:00.000Z',
      daily: 'cases-daily:2026-12-02',
    });
    for (const key of Object.values(keys)) expect(key.length).toBeLessThanOrEqual(128);
    expect(caseNoticeType({ caseId, dedupeKey: keys.notice })).toBe('case');
    expect(caseNoticeType({ caseId, dedupeKey: keys.wave })).toBe('case');
    expect(caseNoticeType({ caseId, dedupeKey: keys.growth })).toBe('growth');
    expect(caseNoticeType({ caseId: null, dedupeKey: keys.critical })).toBe('critical');
    expect(caseNoticeType({ caseId: null, dedupeKey: keys.daily })).toBe('daily');
    for (const dedupeKey of [
      `finding:${caseId}`,
      `incident:${caseId}:high`,
      'usage:2026-12:80',
      'case',
      '',
    ]) {
      expect(caseNoticeType({ caseId: null, dedupeKey })).toBeNull();
    }
    expect(dailyDayOf(keys.daily)).toBe('2026-12-02');
  });

  it('o dia do crescimento é o de Brasília', () => {
    expect(caseGrowthKey(caseId, new Date('2026-12-03T02:59:59.999Z'))).toBe(
      `case:${caseId}:growth:2026-12-02`,
    );
    expect(caseGrowthKey(caseId, new Date('2026-12-03T03:00:00.000Z'))).toBe(
      `case:${caseId}:growth:2026-12-03`,
    );
  });

  it('as horas cheias do aviso imediato que ainda importam', () => {
    const at = new Date('2026-12-02T00:20:00.000Z');
    expect(recentCriticalCasesKeys(at, 1)).toEqual([
      'cases-critical:2026-12-02T00:00:00.000Z',
      'cases-critical:2026-12-01T23:00:00.000Z',
    ]);
    expect(recentCriticalCasesKeys(at, 24)).toHaveLength(25);
  });

  it('09:00 de Brasília é 12:00 UTC o ano todo, inclusive nas datas em que havia horário de verão', () => {
    for (const day of [
      '2026-01-15',
      '2026-02-28',
      '2026-07-01',
      '2026-10-18',
      '2026-11-01',
      '2026-12-31',
      '2028-02-29',
    ]) {
      expect(dailyMoment(day).toISOString()).toBe(`${day}T12:00:00.000Z`);
    }
    expect(dueDaily(new Date('2026-12-02T11:59:59.999Z'))).toBeNull();
    expect(dueDaily(new Date('2026-12-02T12:00:00.000Z'))).toEqual({
      day: '2026-12-02',
      at: new Date('2026-12-02T12:00:00.000Z'),
    });
    // 23:59 de Brasília já é o dia seguinte em UTC; 00:00 de Brasília ainda não é hora.
    expect(dueDaily(new Date('2026-12-03T02:59:59.999Z'))?.day).toBe('2026-12-02');
    expect(dueDaily(new Date('2026-12-03T03:00:00.000Z'))).toBeNull();
    expect(dueDaily(new Date('2027-01-01T02:00:00.000Z'))?.day).toBe('2026-12-31');
  });

  it('um resumo enviado conta por menos de uma semana', () => {
    expect(rememberedDailyDays('2026-12-03')).toEqual([
      '2026-12-02',
      '2026-12-01',
      '2026-11-30',
      '2026-11-29',
      '2026-11-28',
      '2026-11-27',
    ]);
  });

  it('a severidade avisada cobre a igual e as menores', () => {
    expect(covers(null, 'low')).toBe(false);
    expect(covers('high', 'high')).toBe(true);
    expect(covers('critical', 'high')).toBe(true);
    expect(covers('high', 'critical')).toBe(false);
    expect(covers('medium', 'high')).toBe(false);
  });

  it('os tipos da linha são os do alerta', () => {
    expect([noticeKindOf('critical'), noticeKindOf('high')]).toEqual(['critical_finding', 'high_finding']);
  });

  describe('a decisão de um caso de detecção', () => {
    const decide = (overrides: Partial<DetectionFacts>) =>
      detectionDecision({
        worst: 'high',
        noticed: null,
        fresh: false,
        told: false,
        waiting: false,
        ...overrides,
      });

    it('a pior severidade passa da avisada: avisa se há alerta que ninguém avisou; senão, só marca', () => {
      expect(decide({ fresh: true })).toBe('notice');
      expect(decide({ fresh: false })).toBe('mark');
      expect(decide({ worst: 'critical', noticed: 'high', fresh: true })).toBe('notice');
      expect(decide({ worst: 'critical', noticed: 'high', fresh: false })).toBe('mark');
      // Mesmo com outro já avisado no meio.
      expect(decide({ worst: 'critical', noticed: 'high', fresh: true, told: true })).toBe('notice');
    });

    it('a severidade já avisada: só a onda seguinte, quando nada do que foi avisado está pendente', () => {
      expect(decide({ noticed: 'high', fresh: true, told: true })).toBe('none');
      expect(decide({ noticed: 'high', fresh: true, told: false })).toBe('notice');
      expect(decide({ noticed: 'critical', fresh: true, told: false })).toBe('notice');
      expect(decide({ noticed: 'critical', fresh: false, told: false })).toBe('none');
    });

    it('há aviso de um alerta na fila (a virada): um aviso do caso, em qualquer situação', () => {
      for (const noticed of [null, 'high', 'critical'] as const) {
        expect(decide({ noticed, waiting: true })).toBe('notice');
        expect(decide({ noticed, waiting: true, told: true, fresh: true })).toBe('notice');
      }
    });
  });

  describe('o crescimento de um caso', () => {
    const now = new Date('2026-12-02T15:00:00.000Z');
    const due = (overrides: Partial<GrowthFacts>) =>
      growthDue(
        { total: 0, earlier: 0, newTactic: false, newCritical: false, lastGrowthAt: null, ...overrides },
        now,
      );

    it('dez vezes o que era, a partir de 100 alertas', () => {
      expect(due({ total: 100, earlier: 10 })).toBe(true);
      expect(due({ total: 99, earlier: 0 })).toBe(false);
      expect(due({ total: 100, earlier: 11 })).toBe(false);
      expect(due({ total: 1_000, earlier: 100 })).toBe(true);
      expect(due({ total: 1_009, earlier: 101 })).toBe(false);
      expect(due({ total: 100, earlier: 0 })).toBe(true);
    });

    it('a tática nova e o crítico novo em análise, com qualquer tamanho', () => {
      expect(due({ total: 2, earlier: 1 })).toBe(false);
      expect(due({ total: 2, earlier: 1, newTactic: true })).toBe(true);
      expect(due({ total: 2, earlier: 1, newCritical: true })).toBe(true);
    });

    it('no máximo um por dia', () => {
      const grown = { total: 500, earlier: 1, newTactic: true, newCritical: true };
      expect(due({ ...grown, lastGrowthAt: new Date(now.getTime() - DAY_MS + 1) })).toBe(false);
      expect(due({ ...grown, lastGrowthAt: new Date(now.getTime() - DAY_MS) })).toBe(true);
    });
  });
});
