import { type CaseQueueName, type TowerCases, type TowerSummary } from '@verax/shared';
import type { Severity } from '@/design/severity';
import { formatCount, formatList, formatRelative, plural } from '@/lib/format';
import { allCollecting, collectionProof, proofSentence, stalledPhrase } from './tower-collection';

const NOTHING_OPEN = 'Nenhum incidente crítico ou alto aberto, e a postura está dentro do esperado.';

/** "24.321 alertas altos ou críticos para validar" (a frase da situação e o cartão de decisões). */
export function validationPhrase(count: number): string {
  return `${plural(count, 'alerta alto ou crítico', 'alertas altos ou críticos')} para validar`;
}

const CASE_WORK = 'com alerta alto ou crítico para validar';

/** "12 casos com alerta alto ou crítico para validar". */
export const casePhrase = (count: number): string => `${plural(count, 'caso', 'casos')} ${CASE_WORK}`;

/** "840 casos de vulnerabilidade com alerta alto ou crítico para validar". */
export const vulnerabilityPhrase = (count: number): string =>
  `${plural(count, 'caso de vulnerabilidade', 'casos de vulnerabilidade')} ${CASE_WORK}`;

/** Com os casos, os alertas que nenhum deles cobre: à espera do agrupamento, ou dentro de um incidente. */
export const uncoveredPhrase = (count: number): string => `${validationPhrase(count)} fora dos casos`;

const countOf = (summary: TowerSummary, kind: TowerSummary['pendingDecisions'][number]['kind']): number =>
  summary.pendingDecisions.find((decision) => decision.kind === kind)?.count ?? 0;

/** As decisões deste resumo contam casos: o `untriaged_finding` é só o que ficou fora deles. */
export function countsByCase(summary: TowerSummary): boolean {
  return countOf(summary, 'untriaged_case') + countOf(summary, 'untriaged_vulnerability_case') > 0;
}

/**
 * O que ninguém validou ainda, pelas decisões pendentes, numa frase; null sem nada. Sai das decisões, e não da cor nem dos
 * motivos: um nó de antes diz "verde" e sem motivo com a fila cheia, mas já manda a contagem. Com os casos, conta os casos,
 * e os alertas só fora deles.
 */
function waitingSentence(summary: TowerSummary): string | null {
  const cases = countOf(summary, 'untriaged_case');
  const vulnerabilities = countOf(summary, 'untriaged_vulnerability_case');
  const findings = countOf(summary, 'untriaged_finding');
  if (cases + vulnerabilities === 0) return findings > 0 ? `${validationPhrase(findings)}.` : null;
  const subjects = [
    ...(cases > 0 ? [plural(cases, 'caso', 'casos')] : []),
    ...(vulnerabilities > 0
      ? [plural(vulnerabilities, 'caso de vulnerabilidade', 'casos de vulnerabilidade')]
      : []),
  ];
  const outside = findings > 0 ? `, e ${plural(findings, 'alerta', 'alertas')} fora dos casos` : '';
  return `${formatList(subjects)} ${CASE_WORK}${outside}.`;
}

const QUEUE_NOUNS: Readonly<Record<CaseQueueName, string>> = {
  detection: 'de detecção',
  vulnerability: 'de vulnerabilidade',
  posture: 'de postura',
};
/** A ordem em que se olha o mais antigo: a detecção é a que tem pressa. */
const OLDEST_ORDER: readonly CaseQueueName[] = ['detection', 'posture', 'vulnerability'];

/**
 * Os casos pendentes por fila, na ordem da pressa, e desde quando espera o mais antigo da fila mais urgente (R-03):
 * "Pendentes: 18 de detecção · 3 de postura · 10 de vulnerabilidade. O mais antigo de detecção, há 5 dias."
 */
export function pendingCasesNote(cases: TowerCases, now: Date): string {
  const totals = OLDEST_ORDER.map((queue) => {
    const { critical, high, medium, low } = cases[queue];
    return { queue, total: critical + high + medium + low };
  }).filter(({ total }) => total > 0);
  if (totals.length === 0) return 'Nenhum caso pendente.';
  const counts = totals.map(({ queue, total }) => `${formatCount(total)} ${QUEUE_NOUNS[queue]}`);
  const oldest = OLDEST_ORDER.find((queue) => cases.oldestPendingAt[queue] !== null);
  const since = oldest === undefined ? null : cases.oldestPendingAt[oldest];
  return `Pendentes: ${counts.join(' · ')}.${
    oldest === undefined || since === null
      ? ''
      : ` O mais antigo ${QUEUE_NOUNS[oldest]}, ${formatRelative(since, now)}.`
  }`;
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
  const waiting = waitingSentence(summary);
  if (summary.reasons.length === 0) {
    const situation = waiting ?? `${calmPrefix(summary, proof)}${NOTHING_OPEN}`;
    return proof === null ? situation : `${situation} ${proofSentence(proof, now)}`;
  }
  return [`${formatList(reasonParts(summary))}.`, waiting].filter((sentence) => sentence !== null).join(' ');
}

/** "Tudo calmo. " só com a prova de que tudo coleta e nada espera uma decisão do cliente. */
function calmPrefix(summary: TowerSummary, proof: ReturnType<typeof collectionProof>): string {
  return allCollecting(proof) && nothingToDecide(summary) ? 'Tudo calmo. ' : '';
}

/** A manchete da situação (R-01): o mais grave em destaque, com a severidade; o resto fica nos botões e nas decisões. */
export interface SituationHeadline {
  severity: Severity;
  title: string;
  /** Uma linha abaixo, menor: os incidentes altos junto dos críticos, ou a prova da coleta no verde. */
  detail: string | null;
}

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * A manchete de "Situação agora". Com incidente crítico ou alto aberto, eles; com outro motivo (a coleta parada, a postura
 * baixa), o motivo; sem motivo, a frase de sempre, com a prova da coleta inteira. As regras de honestidade são as de
 * `towerReason`: o "Tudo calmo" só aparece onde ela o diria, e a frase completa continua no rótulo do leitor de tela.
 */
export function situationHeadline(summary: TowerSummary, now?: Date): SituationHeadline {
  const { critical, high } = summary.openIncidents;
  const reasons = summary.reasons;
  const highText = plural(high, 'incidente alto aberto', 'incidentes altos abertos');
  if (reasons.includes('critical_incident') && critical > 0) {
    return {
      severity: 'critical',
      title: plural(critical, 'incidente crítico aberto', 'incidentes críticos abertos'),
      detail: reasons.includes('high_incident') && high > 0 ? `e ${highText}` : null,
    };
  }
  if (reasons.includes('high_incident') && high > 0)
    return { severity: 'high', title: highText, detail: null };
  const proof = collectionProof(summary);
  if (reasons.length > 0) {
    return {
      severity: reasons.includes('collection_stalled') ? 'high' : 'medium',
      title: capitalize(formatList(reasonParts(summary))),
      detail: null,
    };
  }
  const waiting = waitingSentence(summary);
  const calm = calmPrefix(summary, proof);
  return {
    severity: waiting !== null ? 'high' : calm ? 'ok' : 'low',
    title: waiting ?? `${calm}${NOTHING_OPEN}`,
    detail: proof === null ? null : proofSentence(proof, now),
  };
}

/** Os motivos da situação, um trecho por motivo. */
function reasonParts(summary: TowerSummary): string[] {
  const proof = collectionProof(summary);
  return summary.reasons.map((reason) => {
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
}
