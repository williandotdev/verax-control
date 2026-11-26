import { describe, expect, it } from 'vitest';
import { DEMO_TENANTS, demoTower } from '@/mocks/fixtures';
import { compactParts } from './compact-situation';

const [alfa] = DEMO_TENANTS.map((tenant) => tenant.id);

describe('a situação recolhida (R-13)', () => {
  const base = demoTower(alfa ?? '', { includeUnowned: false, untriagedFindings: 0 });

  it('começa pela coleta parada, com o ícone de severidade alta', () => {
    const parts = compactParts(base);
    expect(parts[0]).toMatchObject({ text: 'Coleta parada: GCP', severity: 'high', inReason: true });
  });

  it('num nó de antes (sem as fontes), a coleta parada continua dita, pelo motivo', () => {
    const old = {
      ...base,
      reasons: ['collection_stalled' as const],
      coverage: { ...base.coverage, sources: undefined },
    };
    expect(compactParts(old)[0]?.text).toBe('Coleta parada');
  });

  it('a postura entra só abaixo do limite; a contagem de 24 h sai no celular só quando há o que pede atenção', () => {
    const calm = {
      ...base,
      reasons: [],
      posture: { ...base.posture, score: 90 },
      coverage: {
        ...base.coverage,
        sources: base.coverage.sources?.map((source) =>
          source.state === 'stalled' ? { ...source, state: 'collecting' as const } : source,
        ),
      },
    };
    const parts = compactParts(calm);
    expect(parts.map((part) => part.text).join(' · ')).not.toMatch(/Coleta parada|postura/);
    expect(parts.find((part) => part.text.includes('em 24 h'))?.optional).toBe(false);

    const low = compactParts({ ...calm, posture: { ...calm.posture, score: 30 } });
    expect(low.find((part) => part.text.startsWith('postura'))).toMatchObject({
      text: 'postura 30, abaixo de 70',
      severity: 'critical',
    });
    expect(low.find((part) => part.text.includes('em 24 h'))?.optional).toBe(true);
  });
});
