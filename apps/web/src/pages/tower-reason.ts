import type { TowerSummary } from '@verax/shared';
import { formatList, plural } from '@/lib/format';

/** A frase do semáforo: por que a cor é aquela, com os números. */
export function towerReason(summary: TowerSummary): string {
  if (summary.reasons.length === 0) {
    return 'Nenhum incidente crítico ou alto aberto, e a postura está dentro do esperado.';
  }
  const parts = summary.reasons.map((reason) => {
    switch (reason) {
      case 'critical_incident':
        return plural(
          summary.openIncidents.critical,
          'incidente crítico aberto',
          'incidentes críticos abertos',
        );
      case 'high_incident':
        return plural(summary.openIncidents.high, 'incidente alto aberto', 'incidentes altos abertos');
      case 'low_posture':
        return `nota de postura ${summary.posture.score ?? '—'}, abaixo de ${summary.posture.warningBelow}`;
    }
  });
  return `${formatList(parts)}.`;
}
