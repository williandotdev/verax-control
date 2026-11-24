import type { MitreTactic } from '@verax/shared';
import { TACTIC_LABELS } from './labels';

/**
 * A participação de cada tática no período: os alertas dela divididos pela soma dos alertas das 14 táticas. Um alerta
 * com duas táticas entra nas duas, então a soma é de marcações, e não de alertas.
 */

export interface TacticShare {
  tactic: MitreTactic;
  /** O nome em português; sem tradução, o nome que veio do relatório. */
  label: string;
  /** De 0 a 1. */
  share: number;
}

/** As táticas na ordem dada (a da cadeia de ataque), com a participação de cada uma. */
export function tacticShares(tactics: readonly MitreTactic[]): TacticShare[] {
  const total = tactics.reduce((sum, tactic) => sum + tactic.findings, 0);
  return tactics.map((tactic) => ({
    tactic,
    label: TACTIC_LABELS[tactic.name] ?? tactic.name,
    share: total === 0 ? 0 : tactic.findings / total,
  }));
}

/** Só as táticas com alerta, da maior para a menor; empatadas, na ordem da cadeia de ataque. */
export function rankedTactics(shares: readonly TacticShare[]): TacticShare[] {
  return shares
    .filter(({ tactic }) => tactic.findings > 0)
    .sort((left, right) => right.tactic.findings - left.tactic.findings);
}

/**
 * O percentual escrito, sem casas: "34%". O que existe nunca vira "0%" (abaixo de 1%, "<1%"), e o que não é tudo nunca
 * vira "100%" (">99%"). Por causa do arredondamento, a soma dos percentuais escritos pode não dar 100.
 */
export function formatPart(share: number): string {
  if (share <= 0) return '0%';
  if (share < 0.01) return '<1%';
  const whole = Math.round(share * 100);
  return whole >= 100 && share < 1 ? '>99%' : `${whole}%`;
}

/** O mesmo percentual para o leitor de tela, sem os sinais de menor e maior. */
export function spokenPart(share: number): string {
  return formatPart(share).replace('<', 'menos de ').replace('>', 'mais de ');
}
