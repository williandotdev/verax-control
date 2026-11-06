import { describe, expect, it } from 'vitest';
import {
  digestItems,
  hourStartOf,
  NOTICE_CATCH_UP_MS,
  NOTICE_RECIPIENT_ROLES,
  NOTIFICATION_MAX_ATTEMPTS,
  NOTIFICATION_RETRY_DELAYS_MS,
  noticeOf,
  reachesEscalationContact,
  receives,
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
      // O pedido de confirmação vai só ao contato de escalonamento (D8).
      escalation_confirmation: [],
    });
  });

  it('o contato de escalonamento (D8) recebe só os avisos críticos de incidente e de achado', () => {
    const reaches = (kind: Parameters<typeof reachesEscalationContact>[0]['kind'], severity: string | null) =>
      reachesEscalationContact({ kind, severity });
    expect(reaches('incident_opened', 'critical')).toBe(true);
    expect(reaches('incident_escalated', 'critical')).toBe(true);
    expect(reaches('critical_finding', 'critical')).toBe(true);
    expect(reaches('incident_opened', 'high')).toBe(false);
    expect(reaches('incident_escalated', 'high')).toBe(false);
    expect(reaches('plan_usage', null)).toBe(false);
    expect(reaches('aws_ingestion_stalled', null)).toBe(false);
    expect(reaches('escalation_confirmation', null)).toBe(false);
  });

  it('o pedido de confirmação não tem texto de aviso nem entra em resumo', () => {
    expect(() => noticeOf({ ...empty, kind: 'escalation_confirmation' }, origin)).toThrow(RangeError);
    expect(receives('escalation_confirmation', { role: 'admin_cliente', incidentEmails: true })).toBe(false);
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

describe("preferência e resumo por hora (PR-17')", () => {
  it('a preferência desliga só os avisos de incidente e de achado; o papel continua decidindo', () => {
    const off = { role: 'analista_cliente', incidentEmails: false } as const;
    const on = { role: 'analista_cliente', incidentEmails: true } as const;
    const adminOff = { role: 'admin_cliente', incidentEmails: false } as const;
    for (const kind of ['incident_opened', 'incident_escalated', 'critical_finding'] as const) {
      expect(receives(kind, on)).toBe(true);
      expect(receives(kind, off)).toBe(false);
      expect(receives(kind, adminOff)).toBe(false);
    }
    // Plano e coleta: sempre para quem administra, com a preferência desligada ou não; nunca para o analista.
    for (const kind of ['plan_usage', 'aws_ingestion_stalled'] as const) {
      expect(receives(kind, adminOff)).toBe(true);
      expect(receives(kind, on)).toBe(false);
    }
    expect(receives('incident_opened', { role: 'leitura', incidentEmails: true })).toBe(false);
    expect(receives('incident_opened', { role: 'admin_verax', incidentEmails: true })).toBe(false);
  });

  it('a hora cheia (UTC, que bate com a de Brasília) e a retomada depois de 24 h', () => {
    expect(hourStartOf(new Date('2026-11-05T17:59:59.999Z')).toISOString()).toBe('2026-11-05T17:00:00.000Z');
    expect(hourStartOf(new Date('2026-11-05T18:00:00.000Z')).toISOString()).toBe('2026-11-05T18:00:00.000Z');
    expect(NOTICE_CATCH_UP_MS).toBe(24 * 3_600_000);
  });

  it('itens do resumo: os críticos primeiro, cada grupo na ordem da fila; o aviso sem alvo fica de fora', () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 10, 5, 17, minute));
    const row = (id: string, minute: number, target: Record<string, unknown>) => ({
      ...empty,
      ...target,
      id,
      createdAt: at(minute),
    });
    const items = digestItems(
      [
        row('a', 1, { kind: 'incident_opened', severity: 'high', incidentId }),
        row('b', 2, { kind: 'plan_usage', usageMonth: new Date('2026-11-01'), usagePercent: 80 }),
        row('c', 3, { kind: 'critical_finding', severity: 'critical', findingId }),
        row('d', 4, { kind: 'incident_escalated', severity: 'critical', incidentId }),
        row('e', 0, { kind: 'incident_opened', severity: 'critical' }),
      ] as unknown as Parameters<typeof digestItems>[0],
      origin,
    );
    expect(items.map(({ notice, at: when }) => [notice.kind, when.getUTCMinutes()])).toEqual([
      ['critical_finding', 3],
      ['incident_escalated', 4],
      ['incident_opened', 1],
      ['plan_usage', 2],
    ]);
  });
});
