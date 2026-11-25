import { describe, expect, it } from 'vitest';
import { FINDING_SEVERITIES, FINDING_SOURCES, FINDING_STATUSES } from './findings.js';
import { mitreTactics } from './reports.js';
import {
  PENDING_DECISION_KINDS,
  RADAR_CASES_LIMIT,
  RADAR_DETECTIONS_LIMIT,
  RADAR_SECTORS,
  RADAR_WINDOW_HOURS,
  radarSectorOf,
  type TowerSummary,
  towerCasesSchema,
  towerQuerySchema,
  towerRadarCasesSchema,
  towerRadarSchema,
  towerSummarySchema,
} from './tower.js';

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
        lastEventAt: '2026-10-30T08:00:00.000Z',
        delayedAfterMinutes: 30,
        stalledAfterMinutes: 120,
      },
      {
        source: 'gcp',
        state: 'stalled',
        lastDataAt: '2026-11-02T09:00:00.000Z',
        lastEventAt: '2026-10-29T09:00:00.000Z',
        delayedAfterMinutes: 15,
        stalledAfterMinutes: 60,
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

  it('aceita o amarelo sem motivo: só há alertas para validar, e a contagem vai nas decisões', () => {
    const waiting = {
      ...summary,
      light: 'yellow',
      reasons: [],
      openIncidents: { critical: 0, high: 0, medium: 0, low: 0 },
      pendingDecisions: [{ kind: 'untriaged_finding', count: 24_321 }],
    };
    expect(towerSummarySchema.safeParse(waiting).success).toBe(true);
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

describe('radar de detecções', () => {
  const detection = {
    id: '018f2c1e-0000-7000-8000-000000001001',
    severity: 'critical',
    status: 'new',
    source: 'guardduty',
    occurredAt: '2026-11-02T12:40:00.000Z',
    title: 'Credencial usada de fora',
    incident: { id: '018f2c1e-0000-7000-8000-0000000a0001', open: true },
  } as const;
  const radar = {
    since: '2026-11-01T13:00:00.000Z',
    windowHours: RADAR_WINDOW_HOURS,
    limit: RADAR_DETECTIONS_LIMIT,
    total: 1,
    bySeverity: { critical: 1, high: 0, medium: 0, low: 0 },
    bySector: { aws: 1, gcp: 0, cloudflare: 0, agents: 0 },
    detections: [detection],
  };

  it('opcional no resumo (um nó de antes não manda); com ele, as detecções da janela', () => {
    expect(towerSummarySchema.parse(summary).radar).toBeUndefined();
    expect(towerSummarySchema.parse({ ...summary, radar }).radar).toEqual(radar);
    expect(
      towerSummarySchema.parse({
        ...summary,
        radar: { ...radar, detections: [{ ...detection, incident: null }] },
      }).radar?.detections[0]?.incident,
    ).toBeNull();
  });

  it('recusa mais detecções que o total, além do teto, fonte desconhecida e outra janela', () => {
    expect(() =>
      towerRadarSchema.parse({
        ...radar,
        total: 0,
        bySeverity: { ...radar.bySeverity, critical: 0 },
        bySector: { ...radar.bySector, aws: 0 },
      }),
    ).toThrow();
    // As contagens por severidade e por setor somam o total.
    expect(() => towerRadarSchema.parse({ ...radar, bySeverity: { ...radar.bySeverity, low: 1 } })).toThrow();
    expect(() => towerRadarSchema.parse({ ...radar, bySector: { ...radar.bySector, gcp: 2 } })).toThrow();
    expect(() =>
      towerRadarSchema.parse({
        ...radar,
        total: 101,
        bySeverity: { ...radar.bySeverity, critical: 101 },
        bySector: { ...radar.bySector, aws: 101 },
        detections: Array.from({ length: 101 }, () => detection),
      }),
    ).toThrow();
    expect(() =>
      towerRadarSchema.parse({ ...radar, detections: [{ ...detection, source: 'syslog' }] }),
    ).toThrow();
    expect(() => towerRadarSchema.parse({ ...radar, windowHours: 48 })).toThrow();
    // O teto mostra só uma parte: o total pode passar da lista.
    expect(
      towerRadarSchema.parse({
        ...radar,
        total: 340,
        bySeverity: { critical: 40, high: 100, medium: 100, low: 100 },
        bySector: { aws: 300, gcp: 10, cloudflare: 10, agents: 20 },
      }).total,
    ).toBe(340);
  });

  it('cada fonte de log cai num setor do radar, e todo setor tem fonte', () => {
    const sectors = new Set(FINDING_SOURCES.map(radarSectorOf));
    expect([...sectors].sort()).toEqual([...RADAR_SECTORS].sort());
  });
});

describe('casos no resumo da Torre', () => {
  const counts = { critical: 1, high: 2, medium: 0, low: 0 };
  const cases = {
    detection: counts,
    vulnerability: counts,
    posture: { critical: 0, high: 0, medium: 0, low: 0 },
    oldestPendingAt: {
      detection: '2026-11-01T13:00:00.000Z',
      vulnerability: '2026-10-01T13:00:00.000Z',
      posture: null,
    },
  };
  const item = {
    id: '018f2c1e-0000-7000-8000-00000000ca5e',
    title: 'Atividade suspeita na conta da AWS',
    severity: 'critical',
    sources: ['cloudtrail'],
    sector: 'aws',
    total: 20_000,
    pending: 12,
    recent: 4,
    lastActivityAt: '2026-11-02T12:40:00.000Z',
    incident: null,
  } as const;
  const radarCases = { total: 1, alerts: 4, limit: RADAR_CASES_LIMIT, items: [item] };
  const radar = {
    since: '2026-11-01T13:00:00.000Z',
    windowHours: RADAR_WINDOW_HOURS,
    limit: RADAR_DETECTIONS_LIMIT,
    total: 0,
    bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    bySector: { aws: 0, gcp: 0, cloudflare: 0, agents: 0 },
    detections: [],
  };
  const withCases = {
    ...summary,
    pendingDecisions: [
      { kind: 'untriaged_case', count: 3 },
      { kind: 'untriaged_vulnerability_case', count: 2 },
      { kind: 'untriaged_finding', count: 1 },
    ],
    radar: { ...radar, cases: radarCases },
    cases,
    mitre: { ...summary.mitre, tactics: summary.mitre.tactics.map((tactic) => ({ ...tactic, cases: 2 })) },
  };

  it('o pedido: `cases=true`, e nada mais', () => {
    expect(towerQuerySchema.parse({})).toEqual({});
    expect(towerQuerySchema.parse({ cases: 'true' })).toEqual({ cases: 'true' });
    for (const query of [
      { cases: 'false' },
      { cases: '1' },
      { cases: true },
      { cases: ['true', 'true'] },
      { x: '1' },
    ]) {
      expect(towerQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
    }
  });

  it('versões diferentes: sem os campos (um nó de antes), o resumo continua válido; com eles, também', () => {
    expect(towerSummarySchema.parse(summary)).toEqual(summary);
    expect(towerSummarySchema.parse({ ...summary, radar })).toEqual({ ...summary, radar });
    expect(towerSummarySchema.parse(withCases)).toEqual(withCases);
  });

  it('um painel de antes recusa a resposta inteira pelos campos novos: por isso só vêm para quem os pede', () => {
    const before = towerSummarySchema.omit({ cases: true });
    expect(before.safeParse(summary).success).toBe(true);
    expect(before.safeParse({ ...summary, cases }).success).toBe(false);
  });

  it('as decisões, na ordem, todas de uma vez', () => {
    const all = PENDING_DECISION_KINDS.map((kind) => ({ kind, count: 1 }));
    expect(all.map(({ kind }) => kind)).toEqual([
      'unassigned_incident',
      'untriaged_case',
      'untriaged_vulnerability_case',
      'untriaged_finding',
      'unowned_alert',
    ]);
    expect(towerSummarySchema.safeParse({ ...summary, pendingDecisions: all }).success).toBe(true);
    expect(
      towerSummarySchema.safeParse({ ...summary, pendingDecisions: [{ kind: 'untriaged_case', count: 0 }] })
        .success,
    ).toBe(false);
  });

  it.each([
    ['fila a mais', { ...cases, other: counts }],
    ['fila que falta', { ...cases, posture: undefined }],
    ['contagem negativa', { ...cases, detection: { ...counts, low: -1 } }],
    ['contagem quebrada', { ...cases, detection: { ...counts, low: 0.5 } }],
    [
      'o mais antigo fora do formato',
      { ...cases, oldestPendingAt: { ...cases.oldestPendingAt, posture: 'ontem' } },
    ],
  ])('os casos pendentes recusam %s', (_name, value) => {
    expect(towerCasesSchema.safeParse(value).success).toBe(false);
  });

  it('o radar: o caso sem nada pendente não tem severidade, e o de fonte desconhecida não tem fonte', () => {
    const treated = {
      ...item,
      severity: null,
      pending: 0,
      sources: [],
      incident: { id: item.id, open: false, severity: 'low' },
    };
    expect(towerRadarCasesSchema.safeParse({ ...radarCases, items: [treated] }).success).toBe(true);
  });

  it.each([
    ['mais casos que o total', { ...radarCases, total: 0 }],
    ['outro teto', { ...radarCases, limit: 50 }],
    ['além do teto', { ...radarCases, total: 500, items: Array.from({ length: 101 }, () => item) }],
    [
      'incidente sem a gravidade',
      { ...radarCases, items: [{ ...item, incident: { id: item.id, open: true } }] },
    ],
    ['setor desconhecido', { ...radarCases, items: [{ ...item, sector: 'azure' }] }],
    ['campo a mais', { ...radarCases, items: [{ ...item, actors: ['alguém'] }] }],
    ['título longo demais', { ...radarCases, items: [{ ...item, title: 'a'.repeat(201) }] }],
  ])('o radar recusa %s', (_name, value) => {
    expect(towerRadarCasesSchema.safeParse(value).success).toBe(false);
  });
});
