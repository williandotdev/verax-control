import { describe, expect, it } from 'vitest';
import { DEMO_TENANTS, demoTower } from '@/mocks/fixtures';
import { towerReason } from './tower-reason';

const [alfa] = DEMO_TENANTS.map((tenant) => tenant.id);

describe('frase do semáforo', () => {
  const base = demoTower(alfa ?? '', { includeUnowned: false });

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
