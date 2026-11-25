import { describe, expect, it } from 'vitest';
import {
  type CiEvidence,
  type DetectionScenario,
  detectionScenarioSchema,
  effectiveScenarioState,
} from './detection-coverage.js';

const OLD = `sha256:${'a'.repeat(64)}`;
const NOW = `sha256:${'b'.repeat(64)}`;
const COMMIT = 'c'.repeat(40);

const evidence = (ruleId: string, fires: boolean, overrides: Partial<CiEvidence> = {}): CiEvidence => ({
  kind: 'ci',
  ruleId,
  fingerprint: NOW,
  event: `detections/evidence/SC-0001/${fires ? 'positivo' : 'negativo'}-${ruleId}.json`,
  expected: { fires },
  result: 'pass',
  date: '2026-11-25',
  approver: 'equipe-soc',
  commit: COMMIT,
  ...overrides,
});

const scenario = (overrides: Partial<DetectionScenario> = {}): DetectionScenario => ({
  id: 'SC-0001',
  title: 'Cenário de teste',
  goal: 'Objetivo de teste.',
  logSources: ['cloudtrail'],
  rules: ['100310'],
  providerDetection: false,
  mitre: { tactics: [], techniques: ['T1562.008'] },
  severity: 'critical',
  expectedResponse: 'Resposta de teste.',
  owner: 'Equipe SOC da Verax',
  state: 'em_teste',
  quietExpected: false,
  evidence: [],
  ...overrides,
});

const current = new Map([
  ['100310', NOW],
  ['100311', NOW],
]);

describe('estado efetivo de um cenário de detecção', () => {
  it('homologado com evidência positiva e negativa na fingerprint atual vale', () => {
    const declared = scenario({
      state: 'homologado',
      evidence: [evidence('100310', true), evidence('100310', false)],
    });
    expect(effectiveScenarioState(declared, current)).toEqual({ state: 'homologado', reasons: [] });
  });

  it('regra mudada (fingerprint diferente) derruba para em_teste', () => {
    const declared = scenario({
      state: 'homologado',
      evidence: [
        evidence('100310', true, { fingerprint: OLD }),
        evidence('100310', false, { fingerprint: OLD }),
      ],
    });
    expect(effectiveScenarioState(declared, current)).toEqual({
      state: 'em_teste',
      reasons: ['rule_changed:100310'],
    });
  });

  it('só a positiva, ou só a negativa, não basta', () => {
    for (const fires of [true, false]) {
      const declared = scenario({ state: 'homologado', evidence: [evidence('100310', fires)] });
      expect(effectiveScenarioState(declared, current)).toEqual({
        state: 'em_teste',
        reasons: ['missing_evidence:100310'],
      });
    }
  });

  it('cada regra do cenário precisa da própria evidência', () => {
    const declared = scenario({
      state: 'homologado',
      rules: ['100310', '100311'],
      evidence: [evidence('100310', true), evidence('100310', false)],
    });
    expect(effectiveScenarioState(declared, current).reasons).toEqual(['missing_evidence:100311']);
  });

  it('evidência que falhou na fingerprint atual derruba, mesmo com outras que passaram', () => {
    const declared = scenario({
      state: 'homologado',
      evidence: [
        evidence('100310', true),
        evidence('100310', false),
        evidence('100310', true, { result: 'fail' }),
      ],
    });
    expect(effectiveScenarioState(declared, current)).toEqual({
      state: 'em_teste',
      reasons: ['evidence_failed:100310'],
    });
  });

  it('regra que não existe nesta versão derruba', () => {
    const declared = scenario({
      state: 'homologado',
      evidence: [evidence('100310', true), evidence('100310', false)],
    });
    expect(effectiveScenarioState(declared, new Map())).toEqual({
      state: 'em_teste',
      reasons: ['rule_missing:100310'],
    });
  });

  it('evidência de laboratório não homologa sozinha', () => {
    const declared = scenario({
      state: 'homologado',
      evidence: [
        {
          kind: 'lab',
          ruleId: '100310',
          fingerprint: NOW,
          eventSha256: 'd'.repeat(64),
          result: 'pass',
          date: '2026-11-25',
          approver: 'equipe-soc',
        },
      ],
    });
    expect(effectiveScenarioState(declared, current).state).toBe('em_teste');
  });

  it('em_teste e aposentado valem como declarados', () => {
    expect(effectiveScenarioState(scenario(), current)).toEqual({ state: 'em_teste', reasons: [] });
    expect(effectiveScenarioState(scenario({ state: 'aposentado', rules: [] }), current)).toEqual({
      state: 'aposentado',
      reasons: [],
    });
  });

  it('homologado sem regra nenhuma não vale', () => {
    expect(effectiveScenarioState(scenario({ state: 'homologado', rules: [] }), current).state).toBe(
      'em_teste',
    );
  });
});

describe('schema do arquivo do catálogo', () => {
  it('aceita o cenário válido', () => {
    expect(detectionScenarioSchema.safeParse(scenario()).success).toBe(true);
  });

  it('recusa campo desconhecido, estado de fora do repositório e cenário sem regra que não está aposentado', () => {
    expect(detectionScenarioSchema.safeParse({ ...scenario(), extra: 1 }).success).toBe(false);
    expect(detectionScenarioSchema.safeParse(scenario({ state: 'sugerido' as never })).success).toBe(false);
    expect(detectionScenarioSchema.safeParse(scenario({ rules: [] })).success).toBe(false);
    expect(detectionScenarioSchema.safeParse(scenario({ state: 'aposentado', rules: [] })).success).toBe(
      true,
    );
  });

  it('recusa regra, fonte ou técnica repetida, tática fora da lista e técnica fora do padrão', () => {
    expect(detectionScenarioSchema.safeParse(scenario({ rules: ['100310', '100310'] })).success).toBe(false);
    expect(detectionScenarioSchema.safeParse(scenario({ logSources: ['waf', 'waf'] })).success).toBe(false);
    const mitre = (tactics: string[], techniques: string[]) =>
      detectionScenarioSchema.safeParse({ ...scenario(), mitre: { tactics, techniques } }).success;
    expect(mitre(['Impact'], ['T1485'])).toBe(true);
    expect(mitre(['Impacto'], [])).toBe(false);
    expect(mitre([], ['T1485', 'T1485'])).toBe(false);
    expect(mitre([], ['T148'])).toBe(false);
  });

  it('dono e aprovador são apelidos, nunca e-mail', () => {
    expect(detectionScenarioSchema.safeParse(scenario({ owner: 'soc@example.com' })).success).toBe(false);
    const withApprover = (approver: string) =>
      detectionScenarioSchema.safeParse(scenario({ evidence: [evidence('100310', true, { approver })] }))
        .success;
    expect(withApprover('equipe-soc')).toBe(true);
    expect(withApprover('soc@example.com')).toBe(false);
  });

  it('evidência só de regra do cenário e com evento na pasta do próprio cenário', () => {
    expect(
      detectionScenarioSchema.safeParse(scenario({ evidence: [evidence('100311', true)] })).success,
    ).toBe(false);
    const other = evidence('100310', true, { event: 'detections/evidence/SC-0002/positivo.json' });
    expect(detectionScenarioSchema.safeParse(scenario({ evidence: [other] })).success).toBe(false);
    const outside = evidence('100310', true, { event: 'detections/evidence/SC-0001/../segredo.json' });
    expect(detectionScenarioSchema.safeParse(scenario({ evidence: [outside] })).success).toBe(false);
  });

  it('severidade da origem só e sempre na detecção do provedor', () => {
    expect(
      detectionScenarioSchema.safeParse(scenario({ providerDetection: true, severity: 'from_source' }))
        .success,
    ).toBe(true);
    expect(detectionScenarioSchema.safeParse(scenario({ providerDetection: true })).success).toBe(false);
    expect(detectionScenarioSchema.safeParse(scenario({ severity: 'from_source' })).success).toBe(false);
  });

  it('recusa texto com quebra de linha ou espaço nas pontas', () => {
    expect(detectionScenarioSchema.safeParse(scenario({ title: 'Linha\nquebrada' })).success).toBe(false);
    expect(detectionScenarioSchema.safeParse(scenario({ goal: ' Objetivo' })).success).toBe(false);
  });
});
