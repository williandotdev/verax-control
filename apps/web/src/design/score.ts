import type { Severity } from './severity';

export interface ScoreThresholds {
  /** Abaixo disto: atenção. Padrão 70 (regra do semáforo da Torre). */
  warning: number;
  /** Abaixo disto: crítico. */
  critical: number;
}

export const DEFAULT_THRESHOLDS: ScoreThresholds = { warning: 70, critical: 40 };

export function scoreSeverity(score: number, thresholds: ScoreThresholds = DEFAULT_THRESHOLDS): Severity {
  if (score < thresholds.critical) return 'critical';
  if (score < thresholds.warning) return 'medium';
  return 'ok';
}
