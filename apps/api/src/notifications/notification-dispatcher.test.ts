import { describe, expect, it } from 'vitest';
import {
  NOTICE_RECIPIENT_ROLES,
  NOTIFICATION_MAX_ATTEMPTS,
  NOTIFICATION_RETRY_DELAYS_MS,
  noticeOf,
} from './notification-dispatcher.js';

const origin = 'https://cliente.control.exemplo.com.br';
const incidentId = '018f2c1e-0000-7000-8000-0000000000c1';
const findingId = '018f2c1e-0000-7000-8000-0000000000f1';
const empty = { severity: null, incidentId: null, findingId: null, usageMonth: null, usagePercent: null };

describe('despachante dos avisos (PR-16)', () => {
  it('recuo de 1, 5, 15 e 60 min, e failed na quinta tentativa', () => {
    expect(NOTIFICATION_RETRY_DELAYS_MS).toEqual([60_000, 300_000, 900_000, 3_600_000]);
    expect(NOTIFICATION_MAX_ATTEMPTS).toBe(5);
  });

  it('incidente e achado para administradores e analistas; volume e coleta parada só para quem administra', () => {
    expect(NOTICE_RECIPIENT_ROLES).toEqual({
      incident_opened: ['admin_cliente', 'analista_cliente'],
      incident_escalated: ['admin_cliente', 'analista_cliente'],
      critical_finding: ['admin_cliente', 'analista_cliente'],
      aws_ingestion_stalled: ['admin_cliente'],
      plan_usage: ['admin_cliente'],
    });
  });

  it('o link de cada tipo no painel, a partir da origem (com ou sem a barra no fim)', () => {
    expect(noticeOf({ ...empty, kind: 'incident_opened', severity: 'high', incidentId }, origin)).toEqual({
      kind: 'incident_opened',
      severity: 'high',
      link: `${origin}/incidentes/${incidentId}`,
    });
    expect(
      noticeOf({ ...empty, kind: 'incident_escalated', severity: 'critical', incidentId }, `${origin}/`).link,
    ).toBe(`${origin}/incidentes/${incidentId}`);
    expect(
      noticeOf({ ...empty, kind: 'critical_finding', severity: 'critical', findingId }, origin).link,
    ).toBe(`${origin}/achados?achado=${findingId}`);
    expect(noticeOf({ ...empty, kind: 'aws_ingestion_stalled' }, origin).link).toBe(
      `${origin}/cadastros/contas`,
    );
    const month = new Date('2026-11-01T00:00:00.000Z');
    expect(noticeOf({ ...empty, kind: 'plan_usage', usageMonth: month, usagePercent: 100 }, origin)).toEqual({
      kind: 'plan_usage',
      percent: 100,
      month,
      link: `${origin}/cadastros/plano`,
    });
  });

  it('aviso sem o alvo do tipo é recusado (o despachante o encerra como failed)', () => {
    expect(() => noticeOf({ ...empty, kind: 'incident_opened', severity: 'high' }, origin)).toThrow(
      RangeError,
    );
    expect(() =>
      noticeOf({ ...empty, kind: 'incident_opened', severity: 'medium', incidentId }, origin),
    ).toThrow(RangeError);
    expect(() => noticeOf({ ...empty, kind: 'critical_finding', severity: 'critical' }, origin)).toThrow(
      RangeError,
    );
    expect(() =>
      noticeOf(
        { ...empty, kind: 'plan_usage', usageMonth: new Date('2026-11-01'), usagePercent: 50 },
        origin,
      ),
    ).toThrow(RangeError);
  });
});
