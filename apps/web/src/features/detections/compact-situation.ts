import type { TowerSummary } from '@verax/shared';
import { scoreSeverity } from '@/design/score';
import type { Severity } from '@/design/severity';
import { formatList, plural } from '@/lib/format';
import { collectionProof } from './tower-collection';

/** Um trecho da linha recolhida: o texto e, no que pede atenção, o ícone da severidade. */
export interface CompactPart {
  text: string;
  severity?: Severity;
  /** O menos urgente: sai da linha no celular, onde não cabe (continua no radar e na lista). */
  optional?: boolean;
  /** Já dito pela frase da situação (o rótulo do leitor de tela): não se repete nele. */
  inReason?: boolean;
}

/**
 * Recolhido: as contagens, numa linha, começando pelo que pede atenção (R-13): a coleta parada e a postura abaixo do
 * limite ficam à vista também recolhidas, como no quadro aberto. Silêncio não é segurança: uma fonte parada nunca some.
 */
export function compactParts(summary: TowerSummary): CompactPart[] {
  const decisions = summary.pendingDecisions.reduce((sum, decision) => sum + decision.count, 0);
  const radarCases = summary.radar?.cases;
  const proof = collectionProof(summary);
  const stalled =
    proof && proof.stalled.length > 0
      ? `Coleta parada: ${formatList(proof.stalled)}`
      : summary.reasons.includes('collection_stalled')
        ? 'Coleta parada'
        : null;
  const { score, warningBelow } = summary.posture;
  const lowPosture = score !== null && score < warningBelow;
  const attention = stalled !== null || lowPosture;
  return [
    ...(stalled ? [{ text: stalled, severity: 'high' as const, inReason: true }] : []),
    {
      text: plural(summary.openIncidents.critical, 'incidente crítico aberto', 'incidentes críticos abertos'),
      ...(summary.openIncidents.critical > 0 && { severity: 'critical' as const }),
    },
    { text: plural(summary.openIncidents.high, 'alto', 'altos') },
    ...(lowPosture
      ? [
          {
            text: `postura ${score}, abaixo de ${warningBelow}`,
            severity: scoreSeverity(score, { warning: warningBelow, critical: 40 }),
            inReason: true,
          },
        ]
      : []),
    ...(summary.radar
      ? [
          {
            text: plural(summary.radar.total, 'detecção em 24 h', 'detecções em 24 h'),
            optional: attention,
          },
        ]
      : []),
    ...(radarCases ? [{ text: plural(radarCases.total, 'caso de detecção', 'casos de detecção') }] : []),
    { text: plural(decisions, 'decisão pendente', 'decisões pendentes') },
  ];
}
