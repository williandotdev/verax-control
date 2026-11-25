import { FINDING_STATUS_LABELS } from '@/features/findings/labels';
import { formatRelative, formatTimestamp } from '@/lib/format';
import { useFindingTriage } from './cases-api';
import { useCasesContext } from './cases-context';
import { OPERATION_STATE_LABELS, operationTitle } from './operation-text';

/**
 * As operações em massa que mexeram neste alerta: quem, quando, por quê e o que ele era antes. Só com os casos, e só se houve
 * alguma (a triagem de um alerta só não é uma operação). O detalhe do alerta não espera por isto nem falha com isto.
 */
export function FindingTriageTrail({ findingId }: { findingId: string }) {
  const { mode } = useCasesContext();
  const trail = useFindingTriage(findingId, mode !== 'off');
  const operations = trail.data?.operations ?? [];
  if (mode === 'off' || operations.length === 0) return null;
  const currentId = trail.data?.operation?.operation.id ?? null;
  return (
    <section aria-label="Triagem em massa deste alerta" className="space-y-2">
      <h3 className="text-sm font-semibold">Triagem em massa deste alerta</h3>
      <ol className="divide-y rounded-md border text-sm">
        {operations.map(({ operation, at, previousStatus }) => (
          <li key={operation.id} className="space-y-0.5 px-3 py-2">
            <p>
              <strong>{operationTitle(operation)}</strong>
              {operation.id === currentId && <span className="text-muted-foreground"> · a que vale</span>}
              {operation.state === 'undone' && (
                <span className="text-muted-foreground">
                  {' '}
                  · {OPERATION_STATE_LABELS.undone.toLowerCase()}
                </span>
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {operation.author?.name ?? 'Pessoa excluída'} ·{' '}
              <time dateTime={at} title={formatTimestamp(at)}>
                {formatRelative(at)}
              </time>{' '}
              · antes: {FINDING_STATUS_LABELS[previousStatus].label.toLowerCase()}
            </p>
            {operation.reason !== null && (
              <p className="wrap-anywhere whitespace-pre-wrap">{operation.reason}</p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
