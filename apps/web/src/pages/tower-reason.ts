import type { TowerSummary } from '@verax/shared';
import { formatList, plural } from '@/lib/format';
import { allCollecting, collectionProof, proofSentence, stalledPhrase } from './tower-collection';

const NOTHING_OPEN = 'Nenhum incidente crítico ou alto aberto, e a postura está dentro do esperado.';

/**
 * A frase do semáforo: por que a cor é aquela, com os números. No verde, a prova de que a coleta anda (OP-02): "Tudo
 * calmo" só quando todas as fontes configuradas estão coletando; sem a prova (um nó de antes), a frase de antes.
 */
export function towerReason(summary: TowerSummary, now?: Date): string {
  const proof = collectionProof(summary);
  if (summary.reasons.length === 0) {
    if (proof === null) return NOTHING_OPEN;
    const calm = allCollecting(proof) ? 'Tudo calmo. ' : '';
    return `${calm}${NOTHING_OPEN} ${proofSentence(proof, now)}`;
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
      case 'collection_stalled':
        return stalledPhrase(proof);
    }
  });
  return `${formatList(parts)}.`;
}
