import { CASE_TIMELINE_MAX_DAYS } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { bucketStart, DAY_MS, fillTimeline, HOUR_MS, timelineCap, timelineWindow } from './case-timeline.js';

const at = (text: string) => new Date(text);
const isoOf = (ms: number) => new Date(ms).toISOString();

describe('as faixas', () => {
  it('a hora cheia é a mesma em UTC e em Brasília', () => {
    expect(isoOf(bucketStart(at('2026-11-24T12:59:59.999Z'), 'hour'))).toBe('2026-11-24T12:00:00.000Z');
    expect(isoOf(bucketStart(at('2026-11-24T13:00:00.000Z'), 'hour'))).toBe('2026-11-24T13:00:00.000Z');
  });

  it('o dia é o de Brasília: vira às 03:00 UTC', () => {
    expect(isoOf(bucketStart(at('2026-11-24T02:59:59.999Z'), 'day'))).toBe('2026-11-23T03:00:00.000Z');
    expect(isoOf(bucketStart(at('2026-11-24T03:00:00.000Z'), 'day'))).toBe('2026-11-24T03:00:00.000Z');
  });

  it('o dia tem 24 h também nas datas em que havia horário de verão, e antes de 1970', () => {
    for (const day of ['2018-11-04T05:00:00.000Z', '2019-02-17T05:00:00.000Z', '1969-12-31T05:00:00.000Z']) {
      const start = bucketStart(at(day), 'day');
      expect(new Date(start).getUTCHours()).toBe(3);
      expect(bucketStart(new Date(start + DAY_MS - 1), 'day')).toBe(start);
      expect(bucketStart(new Date(start + DAY_MS), 'day')).toBe(start + DAY_MS);
      expect(bucketStart(new Date(start - 1), 'day')).toBe(start - DAY_MS);
    }
  });

  it('o limite é o fim da hora de agora', () => {
    expect(timelineCap(at('2026-11-24T12:34:56.789Z')).toISOString()).toBe('2026-11-24T13:00:00.000Z');
    expect(timelineCap(at('2026-11-24T13:00:00.000Z')).toISOString()).toBe('2026-11-24T14:00:00.000Z');
  });
});

describe('a janela', () => {
  it('um alerta só: uma hora', () => {
    const window = timelineWindow(at('2026-11-24T12:30:00Z'), at('2026-11-24T12:30:00Z'));
    expect(window).toEqual({
      granularity: 'hour',
      stepMs: HOUR_MS,
      from: at('2026-11-24T12:00:00Z'),
      to: at('2026-11-24T13:00:00Z'),
    });
  });

  it('até 7 dias, por hora; um milissegundo a mais, por dia', () => {
    const oldest = at('2026-11-17T12:59:59.999Z');
    const hourly = timelineWindow(oldest, new Date(oldest.getTime() + 7 * DAY_MS));
    expect(hourly.granularity).toBe('hour');
    expect(fillTimeline(hourly, [])).toHaveLength(169);
    const daily = timelineWindow(oldest, new Date(oldest.getTime() + 7 * DAY_MS + 1));
    expect(daily.granularity).toBe('day');
    expect(daily.stepMs).toBe(DAY_MS);
    expect(daily.from.toISOString()).toBe('2026-11-17T03:00:00.000Z');
    expect(daily.to.toISOString()).toBe('2026-11-25T03:00:00.000Z');
    expect(fillTimeline(daily, [])).toHaveLength(8);
  });

  it('um alerta de décadas atrás não passa de um ano de faixas, que acabam no mais recente', () => {
    const window = timelineWindow(at('1970-01-01T00:00:00Z'), at('2026-11-24T12:00:00Z'));
    const buckets = fillTimeline(window, []);
    expect(buckets).toHaveLength(CASE_TIMELINE_MAX_DAYS);
    expect(buckets[0]?.at).toBe('2025-11-24T03:00:00.000Z');
    expect(buckets.at(-1)?.at).toBe('2026-11-24T03:00:00.000Z');
  });

  it('o alerta da primeira faixa que cabe fica dentro; o da anterior, fora', () => {
    const newest = at('2026-11-24T12:00:00Z');
    const oldest = new Date(newest.getTime() - (CASE_TIMELINE_MAX_DAYS - 1) * DAY_MS);
    expect(timelineWindow(oldest, newest).from.getTime()).toBeLessThanOrEqual(oldest.getTime());
    const older = new Date(oldest.getTime() - DAY_MS);
    expect(timelineWindow(older, newest).from.getTime()).toBeGreaterThan(older.getTime());
  });
});

describe('os buracos', () => {
  it('as faixas sem alerta vêm com zero, em ordem; o que não é começo de faixa não entra', () => {
    const window = timelineWindow(at('2026-11-24T10:00:00Z'), at('2026-11-24T13:10:00Z'));
    const counts = [
      { at: at('2026-11-24T13:00:00Z'), critical: 0, high: 2, medium: 0, low: 1 },
      { at: at('2026-11-24T10:00:00Z'), critical: 1, high: 0, medium: 3, low: 0 },
      { at: at('2026-11-24T11:30:00Z'), critical: 9, high: 9, medium: 9, low: 9 },
    ];
    const zero = { critical: 0, high: 0, medium: 0, low: 0 };
    expect(fillTimeline(window, counts)).toEqual([
      { at: '2026-11-24T10:00:00.000Z', critical: 1, high: 0, medium: 3, low: 0 },
      { at: '2026-11-24T11:00:00.000Z', ...zero },
      { at: '2026-11-24T12:00:00.000Z', ...zero },
      { at: '2026-11-24T13:00:00.000Z', critical: 0, high: 2, medium: 0, low: 1 },
    ]);
  });
});
