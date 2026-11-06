import { describe, expect, it } from 'vitest';
import type { FindingSeverity } from '../alerts/finding-draft.js';
import type { IncidentPlacement } from '../incidents/incident-grouping.js';
import { findingNotices } from './finding-notices.js';

const tenantId = '018f2c1e-0000-7000-8000-00000000a001';
const incidentId = '018f2c1e-0000-7000-8000-0000000000c1';
const findingId = '018f2c1e-0000-7000-8000-0000000000f1';

const finding = (severity: FindingSeverity) => ({ tenantId, id: findingId, severity });
const opened = (severity: FindingSeverity): IncidentPlacement => ({
  outcome: 'opened',
  incidentId,
  severity,
  previousSeverity: null,
});
const joined = (previousSeverity: FindingSeverity, severity: FindingSeverity): IncidentPlacement => ({
  outcome: 'joined',
  incidentId,
  severity,
  previousSeverity,
});
const none: IncidentPlacement = { outcome: 'none', incidentId: null, severity: null, previousSeverity: null };

describe('avisos que um achado gera (PR-16)', () => {
  it('incidente alto ou crítico que abre gera um aviso, com a severidade na chave', () => {
    expect(findingNotices(finding('high'), opened('high'))).toEqual([
      {
        tenantId,
        kind: 'incident_opened',
        dedupeKey: `incident:${incidentId}:high`,
        severity: 'high',
        incidentId,
      },
    ]);
    expect(findingNotices(finding('critical'), opened('critical'))).toEqual([
      expect.objectContaining({ kind: 'incident_opened', dedupeKey: `incident:${incidentId}:critical` }),
    ]);
  });

  it('incidente médio que abre não avisa', () => {
    expect(findingNotices(finding('medium'), opened('medium'))).toEqual([]);
  });

  it('subir para alto ou crítico avisa; a mesma faixa e as faixas abaixo de alto, não', () => {
    expect(findingNotices(finding('high'), joined('medium', 'high'))).toEqual([
      {
        tenantId,
        kind: 'incident_escalated',
        dedupeKey: `incident:${incidentId}:high`,
        severity: 'high',
        incidentId,
      },
    ]);
    expect(findingNotices(finding('critical'), joined('high', 'critical'))).toEqual([
      expect.objectContaining({ kind: 'incident_escalated', dedupeKey: `incident:${incidentId}:critical` }),
    ]);
    expect(findingNotices(finding('critical'), joined('low', 'critical'))).toHaveLength(1);
    // Junção sem mudança de severidade (o achado novo é igual ou mais baixo).
    expect(findingNotices(finding('high'), joined('high', 'high'))).toEqual([]);
    expect(findingNotices(finding('low'), joined('critical', 'critical'))).toEqual([]);
    // Subir de baixo para médio não avisa.
    expect(findingNotices(finding('medium'), joined('low', 'medium'))).toEqual([]);
  });

  it('achado crítico fora de incidente avisa pelo próprio achado; os outros fora de incidente, não', () => {
    expect(findingNotices(finding('critical'), none)).toEqual([
      {
        tenantId,
        kind: 'critical_finding',
        dedupeKey: `finding:${findingId}`,
        severity: 'critical',
        findingId,
      },
    ]);
    for (const severity of ['high', 'medium', 'low'] as const) {
      expect(findingNotices(finding(severity), none)).toEqual([]);
    }
  });
});
