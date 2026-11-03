import { describe, expect, it } from 'vitest';
import type { FindingDraft } from '../../src/alerts/finding-draft.js';
import {
  correlationKeys,
  incidentRiskScore,
  isPrivilegedIdentity,
  planIncident,
  summarizeIncident,
  type IncidentCandidate,
} from '../../src/incidents/correlation.js';

const ALFA = '018f2c1e-0000-7000-8000-00000000a1fa';
const BETA = '018f2c1e-0000-7000-8000-00000000be7a';

function finding(overrides: Partial<FindingDraft> = {}): FindingDraft {
  return {
    tenantId: ALFA,
    accountId: '111122223333',
    source: 'wazuh',
    sourceEventId: '1793527200.000001',
    occurredAt: '2026-11-01T10:00:00.000Z',
    severity: 'high',
    ruleId: '80255',
    ruleLevel: 10,
    title: 'Possible break in attempt',
    awsSource: 'cloudtrail',
    eventName: 'ConsoleLogin',
    region: 'sa-east-1',
    resource: null,
    actorUser: 'arn:aws:iam::111122223333:user/ana',
    actorType: 'IAMUser',
    accessKeyId: null,
    sourceIp: '203.0.113.50',
    mitreTactics: ['Credential Access'],
    mitreTechniques: ['T1110'],
    ...overrides,
  };
}

function incident(overrides: Partial<IncidentCandidate> = {}): IncidentCandidate {
  return {
    id: 'inc-1',
    tenantId: ALFA,
    keys: ['ip:203.0.113.50'],
    firstSeenAt: '2026-11-01T09:30:00.000Z',
    lastSeenAt: '2026-11-01T09:40:00.000Z',
    ...overrides,
  };
}

describe('agrupamento em incidentes (T5.6)', () => {
  it('chaves de correlação: usuário, chave de acesso, IP e recurso presentes', () => {
    expect(correlationKeys(finding({ accessKeyId: 'AKIAEXEMPLO000000000', resource: 's3:dados' }))).toEqual([
      'user:arn:aws:iam::111122223333:user/ana',
      'key:AKIAEXEMPLO000000000',
      'ip:203.0.113.50',
      'resource:s3:dados',
    ]);
    expect(correlationKeys(finding({ actorUser: null, sourceIp: null }))).toEqual([]);
  });

  it('entra no incidente aberto do mesmo cliente com chave em comum dentro da janela', () => {
    expect(planIncident(finding(), [incident()])).toEqual({ action: 'join', incidentId: 'inc-1' });
    // 60 minutos depois do último achado do incidente ainda entra; um minuto além, não.
    expect(planIncident(finding({ occurredAt: '2026-11-01T10:40:00.000Z' }), [incident()])).toMatchObject({
      action: 'join',
    });
    expect(planIncident(finding({ occurredAt: '2026-11-01T10:41:00.000Z' }), [incident()])).toEqual({
      action: 'open',
    });
    // Achado que chega atrasado, de antes do incidente, também entra se estiver na janela.
    expect(planIncident(finding({ occurredAt: '2026-11-01T08:45:00.000Z' }), [incident()])).toMatchObject({
      action: 'join',
    });
  });

  it('nunca entra em incidente de outro cliente, nem com o mesmo IP', () => {
    expect(planIncident(finding(), [incident({ tenantId: BETA })])).toEqual({ action: 'open' });
    expect(planIncident(finding({ severity: 'low' }), [incident({ tenantId: BETA })])).toEqual({
      action: 'none',
    });
  });

  it('sem chave em comum não agrupa', () => {
    expect(planIncident(finding(), [incident({ keys: ['ip:198.51.100.7', 'user:outro'] })])).toEqual({
      action: 'open',
    });
  });

  it('vários candidatos: o de atividade mais recente; empate pelo id', () => {
    const candidates = [
      incident({ id: 'inc-b', lastSeenAt: '2026-11-01T09:50:00.000Z' }),
      incident({ id: 'inc-a', lastSeenAt: '2026-11-01T09:50:00.000Z' }),
      incident({ id: 'inc-c', lastSeenAt: '2026-11-01T09:45:00.000Z' }),
    ];
    expect(planIncident(finding(), candidates)).toEqual({ action: 'join', incidentId: 'inc-a' });
  });

  it('sem incidente para entrar: médio ou mais abre; baixo fica só como achado', () => {
    for (const severity of ['critical', 'high', 'medium'] as const) {
      expect(planIncident(finding({ severity }), [])).toEqual({ action: 'open' });
    }
    expect(planIncident(finding({ severity: 'low' }), [])).toEqual({ action: 'none' });
    expect(planIncident(finding({ severity: 'low' }), [incident()])).toMatchObject({ action: 'join' });
  });

  it('achado grave sem nenhuma chave (usuário, chave, IP, recurso) não abre incidente', () => {
    const bare = finding({
      severity: 'critical',
      actorUser: null,
      accessKeyId: null,
      sourceIp: null,
      resource: null,
    });
    expect(planIncident(bare, [])).toEqual({ action: 'none' });
  });

  it('janela configurável', () => {
    expect(planIncident(finding(), [incident()], 10)).toEqual({ action: 'open' });
    expect(planIncident(finding(), [incident()], 20)).toMatchObject({ action: 'join' });
  });
});

describe('nota de risco do incidente (T5.6)', () => {
  it('base pela severidade mais alta', () => {
    const base = { touchesProtected: false, privilegedIdentity: false };
    expect(incidentRiskScore({ ...base, severities: ['critical'] })).toBe(70);
    expect(incidentRiskScore({ ...base, severities: ['high'] })).toBe(50);
    expect(incidentRiskScore({ ...base, severities: ['medium'] })).toBe(30);
    expect(incidentRiskScore({ ...base, severities: ['low'] })).toBe(10);
    expect(incidentRiskScore({ ...base, severities: ['low', 'high', 'medium'] })).toBe(50 + 6);
    expect(incidentRiskScore({ ...base, severities: [] })).toBe(0);
  });

  it('+15 lista de proteção, +10 identidade privilegiada, +3 por achado extra até 15, teto 100', () => {
    expect(
      incidentRiskScore({ severities: ['medium'], touchesProtected: true, privilegedIdentity: false }),
    ).toBe(45);
    expect(
      incidentRiskScore({ severities: ['medium'], touchesProtected: false, privilegedIdentity: true }),
    ).toBe(40);
    const many = Array.from({ length: 12 }, () => 'medium' as const);
    expect(incidentRiskScore({ severities: many, touchesProtected: false, privilegedIdentity: false })).toBe(
      45,
    );
    const worst = Array.from({ length: 12 }, () => 'critical' as const);
    expect(incidentRiskScore({ severities: worst, touchesProtected: true, privilegedIdentity: true })).toBe(
      100,
    );
  });

  it('identidade privilegiada: root ou "admin" no nome, sem pegar palavras que só contêm "admin"', () => {
    expect(isPrivilegedIdentity({ actorType: 'Root', actorUser: null })).toBe(true);
    expect(isPrivilegedIdentity({ actorType: null, actorUser: 'arn:aws:iam::111122223333:root' })).toBe(true);
    expect(
      isPrivilegedIdentity({
        actorType: 'AssumedRole',
        actorUser: 'arn:aws:sts::111122223333:assumed-role/AdminRole/s',
      }),
    ).toBe(true);
    expect(
      isPrivilegedIdentity({ actorType: 'IAMUser', actorUser: 'arn:aws:iam::111122223333:user/ana' }),
    ).toBe(false);
    expect(
      isPrivilegedIdentity({ actorType: 'IAMUser', actorUser: 'arn:aws:iam::111122223333:user/badminton' }),
    ).toBe(false);
  });
});

describe('resumo do incidente (T5.6 e T5.7)', () => {
  it('severidade, nota, período, chaves, contas, recursos e MITRE sem repetição', () => {
    const summary = summarizeIncident(
      [
        finding({ occurredAt: '2026-11-01T10:05:00.000Z', severity: 'medium', resource: 's3:dados' }),
        finding({
          occurredAt: '2026-11-01T10:00:00.000Z',
          severity: 'critical',
          accessKeyId: 'AKIAEXEMPLO000000000',
          mitreTactics: ['Initial Access', 'Credential Access'],
          mitreTechniques: ['T1078', 'T1110'],
        }),
      ],
      new Set(['s3:dados']),
    );
    expect(summary).toEqual({
      severity: 'critical',
      riskScore: 70 + 15 + 3,
      findingCount: 2,
      firstSeenAt: '2026-11-01T10:00:00.000Z',
      lastSeenAt: '2026-11-01T10:05:00.000Z',
      keys: [
        'ip:203.0.113.50',
        'key:AKIAEXEMPLO000000000',
        'resource:s3:dados',
        'user:arn:aws:iam::111122223333:user/ana',
      ],
      accounts: ['111122223333'],
      resources: ['s3:dados'],
      mitreTactics: ['Credential Access', 'Initial Access'],
      mitreTechniques: ['T1078', 'T1110'],
    });
  });

  it('recusa incidente vazio ou com achados de clientes diferentes', () => {
    expect(() => summarizeIncident([])).toThrow(RangeError);
    expect(() => summarizeIncident([finding(), finding({ tenantId: BETA })])).toThrow(/clientes diferentes/);
  });
});
