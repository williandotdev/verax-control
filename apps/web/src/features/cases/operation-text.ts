import {
  FINDING_SEVERITIES,
  FINDING_SOURCES,
  type TriageAction,
  type TriageOperationDetail,
  type TriageOperationView,
  type TriageState,
  type TriageStop,
  type TriageTargetView,
  type TriageWarning,
} from '@verax/shared';
import { FINDING_SOURCE_LABELS } from '@/features/findings/labels';
import { formatCount, plural } from '@/lib/format';
import { alertCount, caseCount, GROUPING_LABELS, QUEUE_LABELS } from './labels';

/** Os textos de uma operação de triagem em massa: o que foi pedido, em que pé está e o que aconteceu. */

const STATUS_TITLES: Readonly<Record<NonNullable<TriageOperationView['status']>, string>> = {
  new: 'Voltar para novo',
  investigating: 'Colocar em análise',
  legitimate: 'Marcar como legítimo',
  resolved: 'Marcar como resolvido',
};

const ACTION_TITLES: Readonly<Record<Exclude<TriageAction, 'status'>, string>> = {
  promote: 'Promover a incidente',
  attach: 'Anexar a incidente',
  undo: 'Desfazer',
  undo_all_of: 'Desfazer tudo de uma pessoa',
};

export function operationTitle(operation: Pick<TriageOperationView, 'action' | 'status'>): string {
  if (operation.action !== 'status') return ACTION_TITLES[operation.action];
  return operation.status === null ? 'Mudar o status' : STATUS_TITLES[operation.status];
}

export const OPERATION_STATE_LABELS: Readonly<Record<TriageState, string>> = {
  queued: 'Na fila',
  running: 'Em andamento',
  done: 'Concluída',
  partial: 'Parou antes do fim',
  failed: 'Falhou',
  canceled: 'Cancelada',
  undoing: 'Sendo desfeita',
  undone: 'Desfeita',
};

const ACTIVE: readonly TriageState[] = ['queued', 'running'];
/** Na fila ou em curso: o andamento ainda muda. */
export const isActive = (operation: Pick<TriageOperationView, 'state'>): boolean =>
  ACTIVE.includes(operation.state);

/** O que já foi visto do conjunto, de 0 a 1. */
export function progressOf(operation: Pick<TriageOperationDetail, 'matched' | 'remaining'>): number {
  if (operation.matched === 0) return 1;
  return Math.min(1, Math.max(0, (operation.matched - operation.remaining) / operation.matched));
}

/** "120 de 240 alertas". */
export function progressText(operation: Pick<TriageOperationDetail, 'matched' | 'remaining'>): string {
  return `${formatCount(Math.max(0, operation.matched - operation.remaining))} de ${alertCount(operation.matched)}`;
}

const STOP_TEXTS: Readonly<Record<TriageStop, string>> = {
  incident_resolved: 'O incidente foi resolvido no meio da operação. Reabra o incidente para continuar.',
  incident_gone: 'O incidente da operação não existe mais.',
  failed_alerts: 'Alguns alertas não puderam ser gravados. Os outros entraram.',
  too_many_failures: 'Alertas demais falharam, e a operação parou.',
  unavailable: 'O banco ficou indisponível por tempo demais, e a operação parou.',
};
export const stopText = (stop: TriageStop): string => STOP_TEXTS[stop];

export function warningText(
  warning: TriageWarning,
  operation: Pick<TriageOperationDetail, 'excludedCritical'>,
): string {
  switch (warning) {
    case 'critical_excluded':
      return operation.excludedCritical === 1
        ? '1 alerta crítico ficou de fora.'
        : `${formatCount(operation.excludedCritical)} alertas críticos ficaram de fora.`;
    case 'notice_not_recalled':
      return 'O aviso por e-mail do incidente já tinha saído, e não volta.';
    case 'anchor_kept':
      return 'O alerta que abriu o incidente continua nele.';
  }
}

/** O resultado em números: mudados, pulados e que falharam. No `undo_all_of`, as contas são de operações. */
export function resultText(
  operation: Pick<TriageOperationDetail, 'action' | 'changed' | 'skipped' | 'failed'>,
): string {
  if (operation.action === 'undo_all_of') {
    const rest =
      operation.skipped > 0
        ? `; ${plural(operation.skipped, 'não podia mais ser desfeita', 'não podiam mais ser desfeitas')}`
        : '';
    return `${plural(operation.changed, 'operação vai ser desfeita', 'operações vão ser desfeitas')}${rest}.`;
  }
  const changed =
    operation.action === 'undo'
      ? plural(operation.changed, 'alerta voltou ao que era', 'alertas voltaram ao que eram')
      : plural(operation.changed, 'alerta mudou', 'alertas mudaram');
  // O que falhou está dentro dos pulados.
  const skipped = Math.max(0, operation.skipped - operation.failed);
  return `${[
    changed,
    ...(skipped > 0
      ? [plural(skipped, 'pulado (mudou no meio do caminho)', 'pulados (mudaram no meio do caminho)')]
      : []),
    ...(operation.failed > 0
      ? [plural(operation.failed, 'não pôde ser gravado', 'não puderam ser gravados')]
      : []),
  ].join(', ')}.`;
}

const SEVERITY_WORDS = { critical: 'crítica', high: 'alta', medium: 'média', low: 'baixa' } as const;

/** O filtro gravado de uma operação, em palavras. Valor que o painel não conhece aparece como veio, como texto. */
function filterWords(filter: Readonly<Record<string, string>>): string[] {
  const severity = FINDING_SEVERITIES.find((value) => value === filter['severity']);
  const source = FINDING_SOURCES.find((value) => value === filter['source']);
  const queue = (['detection', 'posture', 'vulnerability'] as const).find(
    (value) => value === filter['queue'],
  );
  const groupBy = (['package', 'resource', 'account'] as const).find((value) => value === filter['groupBy']);
  return [
    ...(queue ? [QUEUE_LABELS[queue].toLowerCase()] : []),
    ...(severity ? [`severidade ${SEVERITY_WORDS[severity]}`] : []),
    ...(source ? [FINDING_SOURCE_LABELS[source]] : []),
    ...(filter['accountId'] ? [`conta ${filter['accountId']}`] : []),
    ...(filter['tactic'] ? [filter['tactic']] : []),
    ...(filter['technique'] ? [filter['technique']] : []),
    ...(filter['q'] ? [`busca "${filter['q']}"`] : []),
    ...(groupBy ? [`${GROUPING_LABELS[groupBy].toLowerCase()} ${filter['group'] ?? '(sem valor)'}`] : []),
  ];
}

/** O alvo da operação, numa frase curta. */
export function targetText(target: TriageTargetView): string {
  switch (target.kind) {
    case 'cases':
      return target.group === null
        ? caseCount(target.caseIds.length)
        : `grupo ${target.group} de ${caseCount(target.caseIds.length)}`;
    case 'findings':
      return `${alertCount(target.count)} da lista`;
    case 'filter':
      return ['casos do filtro', filterWords(target.filter).join(', ')].filter(Boolean).join(': ');
    case 'operation':
      return 'uma operação anterior';
    case 'user':
      return 'as operações de uma pessoa';
  }
}
