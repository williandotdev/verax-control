import { MITRE_TACTICS, type MitreTactic } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { formatPart, rankedTactics, shareBasis, spokenPart, tacticShares } from './tactic-share';

/** As 14 táticas, com os alertas na ordem da cadeia (o que faltar fica zerado). */
const tactics = (...findings: number[]): MitreTactic[] =>
  MITRE_TACTICS.map(({ id, name }, index) => ({
    id,
    name,
    findings: findings[index] ?? 0,
    incidents: 0,
    techniques: [],
  }));

describe('participação das táticas', () => {
  it('cada tática sobre a soma das marcações das 14, na ordem da cadeia', () => {
    const shares = tacticShares(tactics(6, 0, 3, 1));
    expect(shares.map((item) => item.share)).toEqual([0.6, 0, 0.3, 0.1, ...Array<number>(10).fill(0)]);
    expect(shares.map((item) => item.tactic.id)).toEqual(MITRE_TACTICS.map((tactic) => tactic.id));
    expect(shares[0]?.label).toBe('Reconhecimento');
    expect(shares.reduce((sum, item) => sum + item.share, 0)).toBeCloseTo(1);
  });

  it('nenhum alerta: tudo zero, sem divisão por zero', () => {
    expect(tacticShares(tactics()).every((item) => item.share === 0)).toBe(true);
  });

  it('uma tática com tudo é 1', () => {
    expect(tacticShares(tactics(0, 0, 0, 42))[3]?.share).toBe(1);
  });

  it('números grandes: a soma não estoura e a tática pequena não some', () => {
    const shares = tacticShares(tactics(2_000_000_000, 1, 2_000_000_000));
    expect(shares[0]?.share).toBeCloseTo(0.5);
    expect(shares[1]?.share).toBeGreaterThan(0);
    expect(formatPart(shares[1]?.share ?? 0)).toBe('<1%');
  });

  it('tática sem tradução fica com o nome que veio', () => {
    const [first] = tacticShares([
      { id: 'TA9999', name: 'Brand New Tactic', findings: 1, incidents: 0, techniques: [] },
    ]);
    expect(first?.label).toBe('Brand New Tactic');
  });
});

describe('táticas com alerta', () => {
  it('da maior para a menor, só as que têm alerta; as empatadas, na ordem da cadeia', () => {
    expect(rankedTactics(tacticShares(tactics(2, 0, 5, 2, 9))).map((item) => item.tactic.id)).toEqual([
      'TA0003',
      'TA0001',
      'TA0043',
      'TA0002',
    ]);
    expect(rankedTactics(tacticShares(tactics()))).toEqual([]);
  });
});

describe('percentual escrito', () => {
  it.each([
    [0, '0%'],
    [0.000_01, '<1%'],
    [0.0099, '<1%'],
    [0.01, '1%'],
    [0.0149, '1%'],
    [0.015, '2%'],
    [0.344, '34%'],
    [0.345, '35%'],
    [0.5, '50%'],
    [0.994, '99%'],
    [0.996, '>99%'],
    [0.999_99, '>99%'],
    [1, '100%'],
  ])('%s vira %s', (share, text) => {
    expect(formatPart(share)).toBe(text);
  });

  it('para o leitor de tela, sem os sinais', () => {
    expect(spokenPart(0.001)).toBe('menos de 1%');
    expect(spokenPart(0.999)).toBe('mais de 99%');
    expect(spokenPart(0.34)).toBe('34%');
  });

  it('o que existe nunca vira 0%, e o que não é tudo nunca vira 100%', () => {
    for (let alerts = 1; alerts < 2_000; alerts += 1) {
      const text = formatPart(alerts / 2_000);
      expect(text).not.toBe('0%');
      expect(text).not.toBe('100%');
    }
  });
});

describe('participação por casos', () => {
  /** [alertas, casos] de cada tática, na ordem da cadeia. */
  const cased = (...values: [number, number][]): MitreTactic[] =>
    tactics(...values.map(([findings]) => findings)).map((tactic, index) => ({
      ...tactic,
      cases: values[index]?.[1] ?? 0,
    }));

  it('com os casos, conta casos: 20 mil alertas de um caso só pesam um', () => {
    const list = cased([20_000, 1], [30, 3]);
    expect(shareBasis(list)).toBe('cases');
    const shares = tacticShares(list);
    expect(shares.slice(0, 2).map((item) => item.share)).toEqual([0.25, 0.75]);
    expect(rankedTactics(shares).map((item) => item.tactic.id)).toEqual(['TA0042', 'TA0043']);
  });

  it('sem os casos (um nó de antes, ou desligados), conta alertas', () => {
    expect(shareBasis(tactics(5, 1))).toBe('findings');
    expect(tacticShares(tactics(5, 1))[0]?.share).toBeCloseTo(5 / 6);
  });

  it('se nenhum alerta do período tem caso, conta alertas: a teia não some', () => {
    const list = cased([5, 0], [5, 0]);
    expect(shareBasis(list)).toBe('findings');
    expect(tacticShares(list)[0]?.share).toBe(0.5);
    expect(shareBasis([])).toBe('findings');
  });

  it('a tática só com alertas sem caso continua na lista, por último, com 0%', () => {
    const shares = tacticShares(cased([900, 0], [1, 2], [7, 2], [40, 0]));
    const ranked = rankedTactics(shares);
    // Empatadas nos casos, a de mais alertas primeiro.
    expect(ranked.map((item) => item.tactic.findings)).toEqual([7, 1, 900, 40]);
    expect(ranked.at(-1)?.share).toBe(0);
    expect(formatPart(ranked.at(-1)?.share ?? 1)).toBe('0%');
  });
});
