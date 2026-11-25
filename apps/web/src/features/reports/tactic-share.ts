import type { MitreTactic } from '@verax/shared';
import { TACTIC_LABELS } from './labels';

/**
 * A participação de cada tática no período: os casos dela divididos pela soma dos casos das 14 táticas ou, sem os casos, os
 * alertas pelos alertas. Um caso (ou alerta) com duas táticas entra nas duas, então a soma é de marcações.
 */

/** O que a participação conta. */
export type ShareBasis = 'cases' | 'findings';

export interface TacticShare {
  tactic: MitreTactic;
  /** O nome em português; sem tradução, o nome que veio do relatório. */
  label: string;
  /** De 0 a 1. */
  share: number;
}

/**
 * Com os casos no relatório, conta casos: 20 mil alertas iguais são um caso, e não 20 mil ataques. Se nenhum alerta do período
 * tem caso (o histórico de antes deles), conta alertas: uma teia zerada pareceria quebrada.
 */
export function shareBasis(tactics: readonly MitreTactic[]): ShareBasis {
  return tactics.some((tactic) => (tactic.cases ?? 0) > 0) ? 'cases' : 'findings';
}

const weightOf = (tactic: MitreTactic, basis: ShareBasis): number =>
  basis === 'cases' ? (tactic.cases ?? 0) : tactic.findings;

/** As táticas na ordem dada (a da cadeia de ataque), com a participação de cada uma. */
export function tacticShares(
  tactics: readonly MitreTactic[],
  basis: ShareBasis = shareBasis(tactics),
): TacticShare[] {
  const total = tactics.reduce((sum, tactic) => sum + weightOf(tactic, basis), 0);
  return tactics.map((tactic) => ({
    tactic,
    label: TACTIC_LABELS[tactic.name] ?? tactic.name,
    share: total === 0 ? 0 : weightOf(tactic, basis) / total,
  }));
}

/** Só as táticas com alerta, da maior para a menor; empatadas, a de mais alertas e, por fim, a ordem da cadeia de ataque. */
export function rankedTactics(shares: readonly TacticShare[]): TacticShare[] {
  return shares
    .filter(({ tactic }) => tactic.findings > 0)
    .sort((left, right) => right.share - left.share || right.tactic.findings - left.tactic.findings);
}

/**
 * O percentual sem casas e o que vem antes dele. O que existe nunca vira "0%" (abaixo de 1%, é menos de 1%), e o que não é
 * tudo nunca vira "100%" (é mais de 99%). Por causa do arredondamento, a soma dos percentuais escritos pode não dar 100.
 */
function partOf(share: number): { bound: 'under' | 'over' | null; percent: number } {
  if (share <= 0) return { bound: null, percent: 0 };
  if (share < 0.01) return { bound: 'under', percent: 1 };
  const percent = Math.round(share * 100);
  return percent >= 100 && share < 1 ? { bound: 'over', percent: 99 } : { bound: null, percent };
}

const WRITTEN_BOUND = { under: '<', over: '>' } as const;
const SPOKEN_BOUND = { under: 'menos de ', over: 'mais de ' } as const;

/** O percentual escrito: "34%", "<1%", ">99%". */
export function formatPart(share: number): string {
  const { bound, percent } = partOf(share);
  return `${bound === null ? '' : WRITTEN_BOUND[bound]}${percent}%`;
}

/** O mesmo percentual para o leitor de tela: "menos de 1%", "mais de 99%". */
export function spokenPart(share: number): string {
  const { bound, percent } = partOf(share);
  return `${bound === null ? '' : SPOKEN_BOUND[bound]}${percent}%`;
}
