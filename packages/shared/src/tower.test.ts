import { describe, expect, it } from 'vitest';
import { FINDING_SEVERITIES, FINDING_STATUSES } from './findings.js';
import { mitreTactics } from './reports.js';
import { type TowerSummary, towerSummarySchema } from './tower.js';

const summary: TowerSummary = {
  light: 'yellow',
  reasons: ['high_incident'],
  pendingDecisions: [{ kind: 'unassigned_incident', count: 2 }],
  openIncidents: { critical: 0, high: 2, medium: 1, low: 0 },
  posture: { score: 74, scannedAt: '2026-11-02T06:00:00.000Z', warningBelow: 70 },
  coverage: {
    connectedAccounts: 2,
    lastCollectedAt: '2026-11-02T12:59:00.000Z',
    lastEventAt: '2026-11-02T12:58:00.000Z',
    silentAccounts: [],
    silentAfterHours: 24,
  },
  mitre: { periodDays: 30, tactics: mitreTactics([], []) },
  generatedAt: '2026-11-02T13:00:00.000Z',
};

describe('resumo da Torre', () => {
  it('aceita o resumo completo', () => {
    expect(towerSummarySchema.parse(summary)).toEqual(summary);
  });

  it('a saúde da ingestão da AWS (PR-V6): opcional (um nó de antes não manda), com a data da parada ou null', () => {
    const stalled = {
      ...summary,
      coverage: {
        ...summary.coverage,
        awsLogsStalledSince: '2026-11-02T09:00:00.000Z',
        awsStalledAfterHours: 2,
        awsMeterBlocked: true,
      },
    };
    expect(towerSummarySchema.parse(stalled)).toEqual(stalled);
    const quiet = {
      ...summary,
      coverage: { ...summary.coverage, awsLogsStalledSince: null, awsStalledAfterHours: 2 },
    };
    expect(towerSummarySchema.parse(quiet)).toEqual(quiet);
    expect(() =>
      towerSummarySchema.parse({
        ...summary,
        coverage: { ...summary.coverage, awsLogsStalledSince: 'ontem' },
      }),
    ).toThrow();
    expect(() =>
      towerSummarySchema.parse({ ...summary, coverage: { ...summary.coverage, awsStalledAfterHours: 0 } }),
    ).toThrow();
  });

  describe('saúde da coleta e pulso da operação (OP-01 e OP-02)', () => {
    const sources = [
      {
        source: 'aws',
        state: 'collecting',
        lastDataAt: '2026-11-02T12:57:00.000Z',
        lastAlertAt: '2026-10-30T08:00:00.000Z',
        delayedAfterMinutes: 30,
        stalledAfterMinutes: 120,
      },
      {
        source: 'gcp',
        state: 'stalled',
        lastDataAt: '2026-11-01T09:00:00.000Z',
        delayedAfterMinutes: 720,
        stalledAfterMinutes: 1440,
      },
      {
        source: 'cloudflare',
        state: 'not_configured',
        lastDataAt: null,
        delayedAfterMinutes: 30,
        stalledAfterMinutes: 120,
      },
      {
        source: 'agents',
        state: 'waiting',
        lastDataAt: null,
        delayedAfterMinutes: 15,
        stalledAfterMinutes: 60,
      },
      {
        source: 'posture',
        state: 'delayed',
        lastDataAt: '2026-11-01T06:00:00.000Z',
        delayedAfterMinutes: 1560,
        stalledAfterMinutes: 3000,
      },
    ] as const;
    const pulse = {
      since: '2026-11-01T14:00:00.000Z',
      findings: { total: 3, expected: 1, hourly: [...Array<number>(21).fill(0), 1, 0, 2] },
      timeToDetectSeconds: 240,
      agents: { online: 3, total: 5 },
      monthEvents: {
        month: '2026-11',
        sources: [
          { source: 'aws', events: 1_204_331 },
          { source: 'gcp', events: 80_120 },
        ],
      },
    } as const;
    const full = {
      ...summary,
      light: 'yellow',
      reasons: ['high_incident', 'collection_stalled'],
      coverage: { ...summary.coverage, lastDataAt: '2026-11-02T12:57:00.000Z', sources },
      pulse,
    };

    it('aceita as fontes, o último dado e o pulso, todos opcionais (um nó de antes não manda)', () => {
      expect(towerSummarySchema.parse(full)).toEqual(full);
      // Sem os campos novos, o resumo de antes continua válido: o painel novo lê um nó antigo.
      expect(towerSummarySchema.parse(summary)).toEqual(summary);
      // Agentes ausentes e um mês sem volume.
      const quiet = {
        ...full,
        coverage: { ...full.coverage, lastDataAt: null },
        pulse: {
          ...pulse,
          timeToDetectSeconds: null,
          agents: null,
          monthEvents: { month: '2026-11', sources: [] },
        },
      };
      expect(towerSummarySchema.safeParse(quiet).success).toBe(true);
    });

    it.each([
      [
        'fonte desconhecida',
        { coverage: { ...full.coverage, sources: [{ ...sources[0], source: 'azure' }] } },
      ],
      ['estado desconhecido', { coverage: { ...full.coverage, sources: [{ ...sources[0], state: 'ok' }] } }],
      ['fonte repetida', { coverage: { ...full.coverage, sources: [sources[0], sources[0]] } }],
      [
        'prazo de atraso depois do de parada',
        { coverage: { ...full.coverage, sources: [{ ...sources[0], delayedAfterMinutes: 200 }] } },
      ],
      ['último dado fora do formato', { coverage: { ...full.coverage, lastDataAt: 'agora' } }],
      ['hora a menos no pulso', { pulse: { ...pulse, findings: { ...pulse.findings, hourly: [0] } } }],
      ['mais esperados que achados', { pulse: { ...pulse, findings: { ...pulse.findings, expected: 4 } } }],
      ['mais agentes online que registrados', { pulse: { ...pulse, agents: { online: 6, total: 5 } } }],
      ['nenhum agente registrado como objeto', { pulse: { ...pulse, agents: { online: 0, total: 0 } } }],
      [
        'eventos do Cloudflare (não são eventos de log)',
        {
          pulse: {
            ...pulse,
            monthEvents: { month: '2026-11', sources: [{ source: 'cloudflare', events: 1 }] },
          },
        },
      ],
      ['tempo até detectar negativo', { pulse: { ...pulse, timeToDetectSeconds: -1 } }],
      ['campo a mais no pulso', { pulse: { ...pulse, extra: true } }],
    ])('recusa %s', (_name, change) => {
      expect(towerSummarySchema.safeParse({ ...full, ...change }).success).toBe(false);
    });
  });

  it('aceita a conta nova, sem varredura, coleta nem evento', () => {
    const fresh = {
      ...summary,
      light: 'green',
      reasons: [],
      pendingDecisions: [],
      openIncidents: { critical: 0, high: 0, medium: 0, low: 0 },
      posture: { score: null, scannedAt: null, warningBelow: 70 },
      coverage: {
        connectedAccounts: 0,
        lastCollectedAt: null,
        lastEventAt: null,
        silentAccounts: ['111122223333'],
        silentAfterHours: 24,
      },
    };
    expect(towerSummarySchema.safeParse(fresh).success).toBe(true);
  });

  it.each([
    ['cor desconhecida', { light: 'blue' }],
    ['motivo desconhecido', { reasons: ['other'] }],
    ['decisão com contagem zero', { pendingDecisions: [{ kind: 'unassigned_incident', count: 0 }] }],
    ['nota acima de 100', { posture: { ...summary.posture, score: 101 } }],
    ['contagem negativa', { openIncidents: { ...summary.openIncidents, high: -1 } }],
    ['conta fora do formato', { coverage: { ...summary.coverage, silentAccounts: ['123'] } }],
    ['campo a mais', { extra: true }],
  ])('recusa %s', (_name, change) => {
    expect(towerSummarySchema.safeParse({ ...summary, ...change }).success).toBe(false);
  });
});

describe('vocabulário dos achados', () => {
  it('tem as severidades das regras da T5.3 e os status da T5.5', () => {
    expect(FINDING_SEVERITIES).toEqual(['critical', 'high', 'medium', 'low']);
    expect(FINDING_STATUSES).toEqual(['new', 'investigating', 'legitimate', 'resolved']);
  });
});
