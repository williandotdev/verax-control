import type { TowerCases, TowerSummary } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { DEMO_TENANTS, demoTower } from '@/mocks/fixtures';
import {
  casePhrase,
  countsByCase,
  pendingCasesNote,
  situationHeadline,
  towerReason,
  uncoveredPhrase,
  vulnerabilityPhrase,
} from './tower-reason';

const [alfa, beta] = DEMO_TENANTS.map((tenant) => tenant.id);

describe('frase do semáforo', () => {
  // Sem alerta para validar: a frase só dos motivos (a dos alertas tem os próprios testes abaixo).
  const base = demoTower(alfa ?? '', { includeUnowned: false, untriagedFindings: 0 });

  it('só a coleta parada, com as fontes pelo nome', () => {
    expect(
      towerReason({
        ...base,
        light: 'yellow',
        reasons: ['collection_stalled'],
        coverage: {
          ...base.coverage,
          sources: base.coverage.sources?.map((source) =>
            source.source === 'agents' ? { ...source, state: 'stalled' } : source,
          ),
        },
      }),
    ).toBe('coleta parada (GCP e agentes).');
  });

  it('verde com fonte atrasada: a prova, sem "Tudo calmo"; sem fonte nenhuma, diz que falta conectar', () => {
    const now = new Date(base.generatedAt);
    const green = { ...base, light: 'green' as const, reasons: [] };
    const delayed = {
      ...green,
      coverage: {
        ...green.coverage,
        sources: green.coverage.sources?.map((source) =>
          source.state === 'stalled' ? { ...source, state: 'delayed' as const } : source,
        ),
      },
    };
    expect(towerReason(delayed, now)).toBe(
      'Nenhum incidente crítico ou alto aberto, e a postura está dentro do esperado. Coleta ativa em 3 de 5 fontes, último dado agora há pouco.',
    );
    const none = {
      ...green,
      coverage: {
        ...green.coverage,
        lastDataAt: null,
        sources: green.coverage.sources?.map((source) => ({
          ...source,
          state: 'not_configured' as const,
          lastDataAt: null,
        })),
      },
    };
    expect(towerReason(none, now)).toBe(
      'Nenhum incidente crítico ou alto aberto, e a postura está dentro do esperado. Nenhuma fonte de dados conectada ainda.',
    );
  });

  it('só postura baixa', () => {
    expect(
      towerReason({
        ...base,
        light: 'yellow',
        reasons: ['low_posture'],
        openIncidents: { critical: 0, high: 0, medium: 0, low: 0 },
      }),
    ).toBe('nota de postura 69, abaixo de 70.');
  });

  it('um incidente alto no singular', () => {
    expect(
      towerReason({
        ...base,
        light: 'yellow',
        reasons: ['high_incident'],
        openIncidents: { ...base.openIncidents, high: 1 },
      }),
    ).toBe('1 incidente alto aberto.');
  });
});

describe('alertas altos ou críticos para validar', () => {
  /** A Beta: tudo coletando, postura boa e nenhum incidente crítico ou alto aberto. */
  const tower = (options: Partial<Parameters<typeof demoTower>[1]> = {}) =>
    demoTower(beta ?? '', { includeUnowned: false, ...options });
  const reasonOf = (summary: TowerSummary) => towerReason(summary, new Date(summary.generatedAt));

  it('com a fila cheia e nenhum incidente, nunca "Tudo calmo": diz quantos, em pt-BR, com a prova da coleta', () => {
    const summary = tower({ untriagedFindings: 24_321 });
    expect(summary).toMatchObject({ light: 'yellow', reasons: [] });
    expect(reasonOf(summary)).toBe(
      '24.321 alertas altos ou críticos para validar. Coleta ativa em 2 de 2 fontes, último dado há 2 minutos.',
    );
    expect(reasonOf(tower({ untriagedFindings: 1 }))).toMatch(
      /^1 alerta alto ou crítico para validar\. Coleta/,
    );
  });

  it('um nó de antes diz verde com a fila cheia: a frase sai da contagem, e não da cor', () => {
    const older: TowerSummary = { ...tower({ untriagedFindings: 24_321 }), light: 'green' };
    expect(reasonOf(older)).toMatch(/^24\.321 alertas altos ou críticos para validar\./);
    expect(reasonOf(older)).not.toMatch(/calmo|Nenhum incidente/);
    // Antes ainda do OP-02 (sem as fontes), só a frase.
    const { sources: _sources, lastDataAt: _lastDataAt, ...coverage } = older.coverage;
    expect(reasonOf({ ...older, coverage })).toBe('24.321 alertas altos ou críticos para validar.');
  });

  it('com motivos, a contagem vem depois deles', () => {
    expect(
      reasonOf({
        ...tower({ untriagedFindings: 1_200 }),
        light: 'red',
        reasons: ['critical_incident'],
        openIncidents: { critical: 1, high: 0, medium: 0, low: 0 },
      }),
    ).toBe('1 incidente crítico aberto. 1.200 alertas altos ou críticos para validar.');
  });

  it('"Tudo calmo" só sem decisão do cliente: a fila sem dono, da Verax, não conta; o incidente sem responsável, sim', () => {
    expect(reasonOf(tower())).toMatch(/^Tudo calmo\. Nenhum incidente crítico ou alto aberto/);
    expect(reasonOf(tower({ includeUnowned: true, unownedAlerts: 3 }))).toMatch(/^Tudo calmo\./);
    expect(reasonOf(tower({ unassignedIncidents: 1 }))).toMatch(/^Nenhum incidente crítico ou alto aberto/);
  });
});

describe('com os casos, a frase conta casos', () => {
  const base = demoTower(beta ?? '', { includeUnowned: false, untriagedFindings: 0 });
  const of = (
    cases: number,
    vulnerabilities: number,
    findings: number,
    reasons: TowerSummary['reasons'] = [],
  ) =>
    ({
      ...base,
      light: 'yellow',
      reasons,
      openIncidents: { ...base.openIncidents, high: 2 },
      pendingDecisions: [
        { kind: 'untriaged_case', count: cases },
        { kind: 'untriaged_vulnerability_case', count: vulnerabilities },
        { kind: 'untriaged_finding', count: findings },
      ].filter(({ count }) => count > 0),
    }) as TowerSummary;
  const reasonOf = (summary: TowerSummary) => towerReason(summary, new Date(summary.generatedAt));

  it('os casos, as vulnerabilidades e o que ficou fora deles, sem repetir', () => {
    expect(reasonOf(of(12, 840, 3))).toMatch(
      /^12 casos e 840 casos de vulnerabilidade com alerta alto ou crítico para validar, e 3 alertas fora dos casos\. Coleta/,
    );
    expect(reasonOf(of(1, 0, 0))).toMatch(/^1 caso com alerta alto ou crítico para validar\. Coleta/);
    expect(reasonOf(of(0, 1_200, 1))).toMatch(
      /^1\.200 casos de vulnerabilidade com alerta alto ou crítico para validar, e 1 alerta fora dos casos\./,
    );
    expect(reasonOf(of(0, 0, 24_321))).toMatch(/^24\.321 alertas altos ou críticos para validar\./);
    expect(reasonOf(of(3, 0, 0, ['high_incident']))).toBe(
      '2 incidentes altos abertos. 3 casos com alerta alto ou crítico para validar.',
    );
  });

  it('um caso a validar não é calma', () => {
    for (const summary of [of(1, 0, 0), of(0, 1, 0), of(0, 0, 1)]) {
      expect(reasonOf(summary)).not.toMatch(/calmo|Nenhum incidente/);
    }
  });

  it('os cartões, no singular e no plural', () => {
    expect(casePhrase(1)).toBe('1 caso com alerta alto ou crítico para validar');
    expect(casePhrase(12)).toBe('12 casos com alerta alto ou crítico para validar');
    expect(vulnerabilityPhrase(1_200)).toBe(
      '1.200 casos de vulnerabilidade com alerta alto ou crítico para validar',
    );
    expect(uncoveredPhrase(2)).toBe('2 alertas altos ou críticos para validar fora dos casos');
    expect(countsByCase(of(1, 0, 5))).toBe(true);
    expect(countsByCase(of(0, 1, 5))).toBe(true);
    expect(countsByCase(of(0, 0, 5))).toBe(false);
  });

  it('os casos pendentes por fila, e o mais antigo da fila mais urgente', () => {
    const now = new Date('2026-11-25T12:00:00.000Z');
    const none = { critical: 0, high: 0, medium: 0, low: 0 };
    const cases = (changes: Partial<TowerCases>): TowerCases => ({
      detection: none,
      vulnerability: none,
      posture: none,
      oldestPendingAt: { detection: null, vulnerability: null, posture: null },
      ...changes,
    });
    const at = { vulnerability: '2026-10-01T12:00:00.000Z', posture: '2026-11-20T12:00:00.000Z' };
    expect(pendingCasesNote(cases({}), now)).toBe('Nenhum caso pendente.');
    expect(
      pendingCasesNote(
        cases({
          detection: { critical: 1, high: 2, medium: 3, low: 4 },
          vulnerability: { ...none, low: 1_830 },
          posture: { ...none, high: 1 },
          oldestPendingAt: { ...at, detection: '2026-11-25T09:00:00.000Z' },
        }),
        now,
      ),
    ).toBe(
      '10 casos pendentes de detecção, 1.830 de vulnerabilidade e 1 de postura. O mais antigo de detecção foi aberto há 3 horas.',
    );
    expect(
      pendingCasesNote(
        cases({
          vulnerability: { ...none, low: 1 },
          posture: { ...none, high: 1 },
          oldestPendingAt: { ...at, detection: null },
        }),
        now,
      ),
    ).toBe(
      '1 caso pendente de vulnerabilidade e 1 de postura. O mais antigo de postura foi aberto há 5 dias.',
    );
  });
});

describe('a manchete da situação (R-01)', () => {
  const base = demoTower(alfa ?? '', { includeUnowned: false, untriagedFindings: 45 });

  it('o incidente crítico em destaque, os altos na linha de baixo', () => {
    expect(
      situationHeadline({ ...base, reasons: ['critical_incident', 'high_incident', 'collection_stalled'] }),
    ).toEqual({
      severity: 'critical',
      title: '1 incidente crítico aberto',
      detail: 'e 2 incidentes altos abertos',
    });
  });

  it('sem incidente, o motivo (a coleta parada) vira a manchete, com a severidade alta', () => {
    expect(situationHeadline({ ...base, reasons: ['collection_stalled', 'low_posture'] })).toMatchObject({
      severity: 'high',
      title: 'Coleta parada (GCP) e nota de postura 69, abaixo de 70',
    });
  });

  it('sem motivo e com alertas para validar: nada de "Tudo calmo"; a prova da coleta fica à vista', () => {
    const now = new Date(base.generatedAt);
    const headline = situationHeadline({ ...base, light: 'green', reasons: [] }, now);
    expect(headline.severity).toBe('high');
    expect(headline.title).toBe('45 alertas altos ou críticos para validar.');
    expect(headline.detail).toMatch(/^Coleta ativa em \d+ de \d+ fontes/);
    expect(`${headline.title} ${headline.detail}`).not.toMatch(/calmo/i);
  });

  it('"Tudo calmo" só com a prova: todas as fontes coletando e nada para decidir', () => {
    const calm = demoTower(alfa ?? '', { includeUnowned: false, untriagedFindings: 0 });
    const collecting = {
      ...calm,
      light: 'green' as const,
      reasons: [],
      pendingDecisions: [],
      coverage: {
        ...calm.coverage,
        sources: calm.coverage.sources?.map((source) =>
          source.state === 'not_configured' ? source : { ...source, state: 'collecting' as const },
        ),
      },
    };
    expect(situationHeadline(collecting).severity).toBe('ok');
    expect(situationHeadline(collecting).title).toMatch(/^Tudo calmo\./);
    const stalled = {
      ...collecting,
      coverage: {
        ...collecting.coverage,
        sources: collecting.coverage.sources?.map((source) =>
          source.source === 'gcp' ? { ...source, state: 'stalled' as const } : source,
        ),
      },
    };
    expect(situationHeadline(stalled).title).not.toMatch(/calmo/i);
    expect(situationHeadline(stalled).severity).toBe('low');
  });
});
