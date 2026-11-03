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

  it('aceita a conta nova, sem varredura nem evento', () => {
    const fresh = {
      ...summary,
      light: 'green',
      reasons: [],
      pendingDecisions: [],
      openIncidents: { critical: 0, high: 0, medium: 0, low: 0 },
      posture: { score: null, scannedAt: null, warningBelow: 70 },
      coverage: {
        connectedAccounts: 1,
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
