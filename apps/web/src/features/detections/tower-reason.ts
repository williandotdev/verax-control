import type { TowerSummary } from '@verax/shared';
import { formatList, plural } from '@/lib/format';
import { allCollecting, collectionProof, proofSentence, stalledPhrase } from './tower-collection';

const NOTHING_OPEN = 'Nenhum incidente crítico ou alto aberto, e a postura está dentro do esperado.';

/** "24.321 alertas altos ou críticos para validar" (a frase da situação e o cartão de decisões). */
export function validationPhrase(count: number): string {
  return `${plural(count, 'alerta alto ou crítico', 'alertas altos ou críticos')} para validar`;
}

/**
 * Os alertas altos ou críticos que ninguém validou ainda, pela decisão pendente deles. Sai das decisões, e não da cor
 * nem dos motivos: um nó de antes diz "verde" e sem motivo com a fila cheia, mas já manda a contagem.
 */
function waitingValidation(summary: TowerSummary): number {
  return summary.pendingDecisions.find((decision) => decision.kind === 'untriaged_finding')?.count ?? 0;
}

/**
 * Nada do cliente esperando uma decisão. A fila de alertas sem dono é da equipe da Verax, e não deste cliente: não tira
 * o "Tudo calmo" dele (o cartão de decisões a mostra do mesmo jeito).
 */
function nothingToDecide(summary: TowerSummary): boolean {
  return summary.pendingDecisions.every((decision) => decision.kind === 'unowned_alert');
}

/**
 * A frase da situação, no topo da tela Detecções: o que pede atenção, com os números. Alerta alto ou crítico sem
 * validação pede atenção sempre: um incidente só existe depois que uma pessoa promove um alerta, então "nenhum incidente
 * aberto" com a fila cheia não é calma. No verde, a prova de que a coleta anda (OP-02): "Tudo calmo" só quando todas as
 * fontes configuradas estão coletando e nada espera uma decisão do cliente; sem a prova (um nó de antes), só a frase.
 */
export function towerReason(summary: TowerSummary, now?: Date): string {
  const proof = collectionProof(summary);
  const waiting = waitingValidation(summary);
  const waitingSentence = waiting > 0 ? `${validationPhrase(waiting)}.` : null;
  if (summary.reasons.length === 0) {
    const calm = allCollecting(proof) && nothingToDecide(summary) ? 'Tudo calmo. ' : '';
    const situation = waitingSentence ?? `${calm}${NOTHING_OPEN}`;
    return proof === null ? situation : `${situation} ${proofSentence(proof, now)}`;
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
  return [`${formatList(parts)}.`, waitingSentence].filter((sentence) => sentence !== null).join(' ');
}
