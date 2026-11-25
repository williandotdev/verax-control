import { describe, expect, it } from 'vitest';
import type { FindingDraft } from '../../src/alerts/finding-draft.js';
import {
  correlationKeys,
  incidentRiskScore,
  isPrivilegedIdentity,
  relatedFindings,
  riskFlags,
  sortedUnique,
  summarizeIncident,
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
    logSource: 'cloudtrail',
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

/** Um alerta candidato a relacionado (o id e os campos que viram chave). */
function candidate(id: string, overrides: Partial<FindingDraft> = {}) {
  return { id, ...finding(overrides) };
}

describe('alertas relacionados (sugestão ao promover; decisão de 17/11/2026)', () => {
  it('chaves de correlação: usuário, chave de acesso, IP e recurso presentes', () => {
    expect(correlationKeys(finding({ accessKeyId: 'AKIAEXEMPLO000000000', resource: 's3:dados' }))).toEqual([
      'user:arn:aws:iam::111122223333:user/ana',
      'key:AKIAEXEMPLO000000000',
      'ip:203.0.113.50',
      'resource:s3:dados',
    ]);
    expect(correlationKeys(finding({ actorUser: null, sourceIp: null }))).toEqual([]);
  });

  it('do mesmo cliente, com chave em comum, dentro da janela para os dois lados', () => {
    const anchor = candidate('a0');
    const sameIp = candidate('a1', { actorUser: null, occurredAt: '2026-11-01T10:59:00.000Z' });
    const before = candidate('a2', { sourceIp: null, occurredAt: '2026-11-01T09:00:00.000Z' });
    const tooLate = candidate('a3', { occurredAt: '2026-11-01T11:01:00.000Z' });
    const unrelated = candidate('a4', { actorUser: 'outro', sourceIp: '198.51.100.7' });
    expect(relatedFindings(anchor, [anchor, sameIp, before, tooLate, unrelated]).map((f) => f.id)).toEqual([
      'a1',
      'a2',
    ]);
  });

  it('nunca sugere alerta de outro cliente, nem com o mesmo IP', () => {
    expect(relatedFindings(candidate('a0'), [candidate('b1', { tenantId: BETA })])).toEqual([]);
  });

  it('alerta sem nenhuma chave (usuário, chave, IP, recurso) não tem relacionado', () => {
    const bare = candidate('a0', { actorUser: null, accessKeyId: null, sourceIp: null, resource: null });
    expect(relatedFindings(bare, [candidate('a1'), { ...bare, id: 'a2' }])).toEqual([]);
  });

  it('janela configurável; os mais recentes primeiro, empate pelo id', () => {
    const anchor = candidate('a0');
    const later = candidate('a2', { occurredAt: '2026-11-01T10:15:00.000Z' });
    const tie = candidate('a1', { occurredAt: '2026-11-01T10:15:00.000Z' });
    expect(relatedFindings(anchor, [later, tie], 10)).toEqual([]);
    expect(relatedFindings(anchor, [later, tie], 20).map((f) => f.id)).toEqual(['a1', 'a2']);
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

  it('a nota diz as parcelas dela, em toda severidade e volume, menos no teto; a de outra conta não diz nada', () => {
    for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
      for (const count of [1, 2, 3, 4, 5, 6, 7, 500]) {
        for (const touchesProtected of [false, true]) {
          for (const privilegedIdentity of [false, true]) {
            const severities = Array.from({ length: count }, () => severity);
            const score = incidentRiskScore({ severities, touchesProtected, privilegedIdentity });
            expect(riskFlags(score, severity, count), `${severity} ${count} ${score}`).toEqual(
              score >= 100 ? null : { touchesProtected, privilegedIdentity },
            );
          }
        }
      }
    }
    for (const score of [0, 1, 33, 51, 64, 66, 76, 99]) expect(riskFlags(score, 'high', 1)).toBeNull();
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

  it('as listas vão na ordem dos bytes em UTF-8, a do banco, e não na das unidades de 16 bits', () => {
    const values = ['\u{1F600}', '\uE000', 'z', 'Z', 'á', 'a', ''];
    expect(sortedUnique([...values, ...values])).toEqual(['', 'Z', 'a', 'z', 'á', '\uE000', '\u{1F600}']);
  });

  it('recusa incidente vazio ou com achados de clientes diferentes', () => {
    expect(() => summarizeIncident([])).toThrow(RangeError);
    expect(() => summarizeIncident([finding(), finding({ tenantId: BETA })])).toThrow(/clientes diferentes/);
  });
});
