import { describe, expect, it } from 'vitest';
import {
  coverageReport,
  entitiesReport,
  exceptionsReport,
  incidentsReport,
  MITRE_TACTICS,
  mitreReport,
  mitreTactics,
  type ReportFinding,
  type ReportIncident,
  reportWindow,
  rulesReport,
  summaryFold,
  summaryReport,
  summaryReportSchema,
} from './reports.js';

const NOW = new Date('2026-11-03T12:00:00.000Z');
const WINDOW = reportWindow('7d', NOW);
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

function finding(overrides: Partial<ReportFinding> = {}): ReportFinding {
  return {
    occurredAt: hoursAgo(2),
    createdAt: hoursAgo(2),
    triagedAt: null,
    severity: 'high',
    status: 'new',
    source: 'cloudtrail',
    ruleId: '80202',
    title: 'Trilha desligada',
    accountId: '111122223333',
    actorUser: 'deploy-bot',
    accessKeyId: null,
    sourceIp: '198.51.100.23',
    resource: null,
    mitreTactics: ['Defense Evasion'],
    mitreTechniques: ['T1562.008'],
    incidentId: null,
    exceptionId: null,
    ...overrides,
  };
}

function incident(overrides: Partial<ReportIncident> = {}): ReportIncident {
  return {
    id: '018f2c1e-0000-7000-8000-0000000a0001',
    severity: 'critical',
    status: 'open',
    riskScore: 80,
    firstSeenAt: hoursAgo(3),
    createdAt: hoursAgo(3),
    resolvedAt: null,
    assignee: null,
    mitreTactics: ['Defense Evasion', 'Credential Access'],
    ...overrides,
  };
}

describe('MITRE ATT&CK', () => {
  it('as 14 táticas, na ordem da cadeia, com achados, incidentes e técnicas mais vistas', () => {
    const tactics = mitreTactics(
      [
        finding(),
        finding({ mitreTechniques: ['T1562.008', 'T1078'] }),
        finding({ mitreTactics: ['Credential Access'], mitreTechniques: ['T1110'] }),
      ],
      [incident()],
    );
    expect(tactics.map((tactic) => tactic.id)).toEqual(MITRE_TACTICS.map((tactic) => tactic.id));
    expect(tactics.find((tactic) => tactic.name === 'Defense Evasion')).toEqual({
      id: 'TA0005',
      name: 'Defense Evasion',
      findings: 2,
      incidents: 1,
      techniques: [
        { id: 'T1562.008', findings: 2 },
        { id: 'T1078', findings: 1 },
      ],
    });
    expect(tactics.find((tactic) => tactic.name === 'Impact')).toMatchObject({ findings: 0, incidents: 0 });
  });

  it('o relatório conta só o que começou no período', () => {
    const report = mitreReport([finding(), finding({ occurredAt: hoursAgo(24 * 10) })], [], WINDOW);
    expect(report.tactics.find((tactic) => tactic.name === 'Defense Evasion')?.findings).toBe(1);
  });
});

describe('resumo do período', () => {
  it('totais, tempo médio até a triagem e até a resolução, e achados por dia', () => {
    const report = summaryReportSchema.parse(
      summaryReport(
        [
          finding({ createdAt: hoursAgo(5), triagedAt: hoursAgo(4), status: 'investigating' }),
          finding({ severity: 'low', createdAt: hoursAgo(3), triagedAt: hoursAgo(2), status: 'resolved' }),
          finding({ occurredAt: hoursAgo(24 * 30), severity: 'critical' }),
        ],
        [
          incident({ status: 'resolved', createdAt: hoursAgo(10), resolvedAt: hoursAgo(8) }),
          incident({ id: '018f2c1e-0000-7000-8000-0000000a0002' }),
        ],
        WINDOW,
      ),
    );
    expect(report.findings).toMatchObject({
      total: 2,
      bySeverity: { critical: 0, high: 1, low: 1 },
      byStatus: { investigating: 1, resolved: 1, new: 0 },
      bySource: [{ source: 'cloudtrail', count: 2 }],
    });
    expect(report.incidents).toMatchObject({ opened: 2, resolved: 1, open: 1 });
    expect(report.meanTimeToTriageMinutes).toBe(60);
    expect(report.meanTimeToResolveMinutes).toBe(120);
    expect(report.daily.at(-1)).toMatchObject({ date: '2026-11-03', high: 1, low: 1 });
  });

  it('90 dias tocam 91 datas: o achado do primeiro dia aparece na tabela por dia', () => {
    const window = reportWindow('90d', NOW);
    const report = summaryReportSchema.parse(
      summaryReport([finding({ occurredAt: window.from }), finding({ occurredAt: window.to })], [], window),
    );
    expect(report.daily).toHaveLength(91);
    expect(report.daily[0]).toMatchObject({ date: '2026-08-05', high: 1 });
    expect(report.daily.at(-1)).toMatchObject({ date: '2026-11-03', high: 1 });
    const perDay = report.daily.reduce((sum, day) => sum + day.critical + day.high + day.medium + day.low, 0);
    expect(perDay).toBe(report.findings.total);
    expect(summaryReport([], [], WINDOW).daily).toHaveLength(8);
  });

  it('em lotes dá o mesmo que de uma vez (a API lê o período em lotes)', () => {
    const findings = [
      finding({ createdAt: hoursAgo(5), triagedAt: hoursAgo(4), status: 'investigating' }),
      finding({ severity: 'low', source: 'guardduty', createdAt: hoursAgo(3), triagedAt: hoursAgo(1) }),
      finding({ occurredAt: hoursAgo(24 * 3), severity: 'critical' }),
      finding({ occurredAt: hoursAgo(24 * 30) }),
    ];
    const fold = summaryFold([incident()], WINDOW);
    for (const batch of [findings.slice(0, 1), findings.slice(1, 3), findings.slice(3)]) {
      for (const item of batch) fold.add(item);
    }
    expect(fold.result()).toEqual(summaryReport(findings, [incident()], WINDOW));
    expect(fold.result().meanTimeToTriageMinutes).toBe(90);
  });

  it('sem triagem nem resolução, os tempos ficam vazios', () => {
    const report = summaryReport([finding()], [incident()], WINDOW);
    expect(report.meanTimeToTriageMinutes).toBeNull();
    expect(report.meanTimeToResolveMinutes).toBeNull();
  });
});

describe('detecções, entidades, incidentes, cobertura e exceções', () => {
  it('regras por volume, com a severidade mais alta e as contas', () => {
    const report = rulesReport(
      [
        finding(),
        finding({ severity: 'critical', accountId: '444455556666' }),
        finding({ ruleId: '80254', title: 'Login com falha', severity: 'low' }),
      ],
      WINDOW,
    );
    expect(report.items[0]).toMatchObject({
      ruleId: '80202',
      findings: 2,
      accounts: 2,
      severity: 'critical',
    });
    expect(report.items[1]).toMatchObject({ ruleId: '80254', findings: 1 });
  });

  it('usuários, IPs, chaves e recursos mais envolvidos, com incidentes distintos', () => {
    const report = entitiesReport(
      [
        finding({ incidentId: 'i1' }),
        finding({ incidentId: 'i1' }),
        finding({ actorUser: 'ana', incidentId: 'i2', resource: 's3:relatorios' }),
      ],
      WINDOW,
    );
    expect(report.users[0]).toEqual({ value: 'deploy-bot', findings: 2, incidents: 1 });
    expect(report.ips[0]).toEqual({ value: '198.51.100.23', findings: 3, incidents: 2 });
    expect(report.keys).toEqual([]);
    expect(report.resources).toEqual([{ value: 's3:relatorios', findings: 1, incidents: 1 }]);
  });

  it('incidentes por severidade (com tempo até resolver) e por responsável', () => {
    const ana = { id: 'u1', name: 'Ana' };
    const report = incidentsReport(
      [
        incident({ status: 'resolved', assignee: ana, createdAt: hoursAgo(6), resolvedAt: hoursAgo(5) }),
        incident({ id: '018f2c1e-0000-7000-8000-0000000a0003', assignee: ana }),
        incident({ id: '018f2c1e-0000-7000-8000-0000000a0004', severity: 'medium', riskScore: 30 }),
      ],
      WINDOW,
    );
    expect(report.bySeverity.find((row) => row.severity === 'critical')).toMatchObject({
      opened: 2,
      resolved: 1,
      meanTimeToResolveMinutes: 60,
    });
    expect(report.byAssignee[0]).toEqual({ assignee: ana, open: 1, resolved: 1 });
    expect(report.byAssignee[1]).toEqual({ assignee: null, open: 1, resolved: 0 });
    expect(report.items.map((item) => item.riskScore)).toEqual([80, 80, 30]);
  });

  it('cobertura por conta e fonte; exceções com os usos do período', () => {
    const coverage = coverageReport(
      [
        { provider: 'aws', accountId: '111122223333', active: true, lastEventAt: hoursAgo(1) },
        { provider: 'gcp', accountId: 'verax-prod-123', active: true, lastEventAt: null },
      ],
      [finding(), finding({ source: 'guardduty' })],
      WINDOW,
    );
    expect(coverage.accounts[0]).toMatchObject({ findings: 2 });
    expect(coverage.accounts[1]).toMatchObject({ findings: 0, bySource: [] });

    const id = '018f2c1e-0000-7000-8000-0000000e0001';
    const exceptions = exceptionsReport(
      [
        {
          id,
          ruleId: '80254',
          field: 'ip',
          value: '203.0.113.0/24',
          reason: 'Fornecedor',
          expiresAt: null,
          matchedCount: 9,
          lastMatchedAt: hoursAgo(1),
        },
      ],
      [finding({ exceptionId: id }), finding({ exceptionId: id, occurredAt: hoursAgo(24 * 20) })],
      WINDOW,
    );
    expect(exceptions.items[0]).toMatchObject({ active: true, matchedInPeriod: 1, matchedTotal: 9 });
  });
});
