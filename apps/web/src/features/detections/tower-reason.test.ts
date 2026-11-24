import type { TowerSummary } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { DEMO_TENANTS, demoTower } from '@/mocks/fixtures';
import { towerReason } from './tower-reason';

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
