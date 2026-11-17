import { describe, expect, it } from 'vitest';
import type { FindingSeverity } from '../alerts/finding-draft.js';
import { alertNotices, incidentNotices } from './finding-notices.js';

const tenantId = '018f2c1e-0000-7000-8000-00000000a001';
const incidentId = '018f2c1e-0000-7000-8000-0000000000c1';
const findingId = '018f2c1e-0000-7000-8000-0000000000f1';

const finding = (severity: FindingSeverity) => ({ tenantId, id: findingId, severity });

describe('avisos de alerta e incidente (PR-16; regras de 17/11/2026)', () => {
  it('alerta alto ou crítico que chega avisa pelo próprio alerta; médio e baixo, não', () => {
    expect(alertNotices(finding('critical'))).toEqual([
      {
        tenantId,
        kind: 'critical_finding',
        dedupeKey: `finding:${findingId}`,
        severity: 'critical',
        findingId,
      },
    ]);
    expect(alertNotices(finding('high'))).toEqual([
      { tenantId, kind: 'high_finding', dedupeKey: `finding:${findingId}`, severity: 'high', findingId },
    ]);
    expect(alertNotices(finding('medium'))).toEqual([]);
    expect(alertNotices(finding('low'))).toEqual([]);
  });

  it('incidente confirmado avisa em qualquer severidade, com a severidade na chave', () => {
    for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
      expect(incidentNotices(tenantId, { change: 'opened', incidentId, severity })).toEqual([
        {
          tenantId,
          kind: 'incident_opened',
          dedupeKey: `incident:${incidentId}:${severity}`,
          severity,
          incidentId,
        },
      ]);
    }
  });

  it('anexar que sobe para alto ou crítico avisa; a mesma faixa e as faixas abaixo de alto, não', () => {
    const attached = (previousSeverity: FindingSeverity, severity: FindingSeverity) =>
      incidentNotices(tenantId, { change: 'attached', incidentId, severity, previousSeverity });
    expect(attached('medium', 'high')).toEqual([
      {
        tenantId,
        kind: 'incident_escalated',
        dedupeKey: `incident:${incidentId}:high`,
        severity: 'high',
        incidentId,
      },
    ]);
    expect(attached('high', 'critical')).toEqual([
      expect.objectContaining({ kind: 'incident_escalated', dedupeKey: `incident:${incidentId}:critical` }),
    ]);
    expect(attached('low', 'critical')).toHaveLength(1);
    expect(attached('high', 'high')).toEqual([]);
    expect(attached('critical', 'critical')).toEqual([]);
    expect(attached('low', 'medium')).toEqual([]);
  });
});
