import type { TriageCan, TriageOperationDetail, TriageOperationView } from '@verax/shared';
import { useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { withChanges } from '@/features/detections/url-state';
import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/errors';
import { formatTimestamp } from '@/lib/format';
import { bulkProblem } from './bulk';
import { useCasesContext } from './cases-context';
import {
  isActive,
  OPERATION_STATE_LABELS,
  operationTitle,
  progressOf,
  progressText,
  resultText,
  stopText,
  warningText,
} from './operation-text';
import { useCancelTriage, useContinueTriage, useRefreshWhenFinished, useTriageOperation } from './triage-api';

/** A barra do andamento: o número está sempre em texto ao lado. */
export function OperationProgress({ operation }: { operation: TriageOperationDetail }) {
  const ratio = progressOf(operation);
  return (
    <div className="space-y-1">
      <div
        role="progressbar"
        aria-label={`Andamento: ${operationTitle(operation)}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
        className="h-2 overflow-hidden rounded-full bg-foreground/10"
      >
        <div
          className="h-full rounded-full bg-primary motion-safe:transition-[width]"
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {OPERATION_STATE_LABELS[operation.state]}: {progressText(operation)}
      </p>
    </div>
  );
}

/** O que aconteceu, em texto: o resultado, o motivo da parada e os avisos. */
export function OperationResult({ operation }: { operation: TriageOperationDetail }) {
  const active = isActive(operation);
  return (
    <div className="space-y-1 text-sm">
      {!active && operation.state !== 'undoing' && <p className="font-medium">{resultText(operation)}</p>}
      {operation.stop !== null && !active && <p>{stopText(operation.stop)}</p>}
      {operation.warnings.map((warning) => (
        <p key={warning} className="text-muted-foreground">
          {warningText(warning, operation)}
        </p>
      ))}
    </div>
  );
}

/** Cancelar, continuar e desfazer: o que a API diz que esta pessoa pode fazer agora. */
export function OperationActions({
  operation,
  onUndo,
  className,
}: {
  operation: TriageOperationView & { can: TriageCan };
  onUndo?: (() => void) | undefined;
  className?: string;
}) {
  const { openUndo } = useCasesContext();
  const cancel = useCancelTriage();
  const resume = useContinueTriage();
  const error = cancel.error ?? resume.error;
  const busy = cancel.isPending || resume.isPending;
  const active = isActive(operation);
  if (!operation.can.cancel && !operation.can.continue && !operation.can.undo) return null;
  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex flex-wrap gap-2">
        {operation.can.continue && (
          <Button
            size="sm"
            className="max-md:h-11"
            disabled={busy}
            onClick={() => resume.mutate(operation.id)}
          >
            Continuar<span className="sr-only">: {operationTitle(operation)}</span>
          </Button>
        )}
        {operation.can.cancel && (
          <Button
            variant="secondary"
            size="sm"
            className="max-md:h-11"
            disabled={busy}
            onClick={() => cancel.mutate(operation.id)}
          >
            {active ? 'Cancelar' : 'Desistir do resto'}
            <span className="sr-only">: {operationTitle(operation)}</span>
          </Button>
        )}
        {operation.can.undo && (
          <Button
            variant="secondary"
            size="sm"
            className="max-md:h-11"
            disabled={busy}
            onClick={() => {
              onUndo?.();
              openUndo(operation);
            }}
          >
            Desfazer<span className="sr-only">: {operationTitle(operation)}</span>
          </Button>
        )}
      </div>
      {operation.can.undo && operation.undoUntil !== null && (
        <p className="text-xs text-muted-foreground">
          Dá para desfazer até {formatTimestamp(operation.undoUntil)}.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-critical-text">
          {bulkProblem(error).message || errorMessage(error)}
        </p>
      )}
    </div>
  );
}

/**
 * O resultado de um pedido, dentro do diálogo: na hora (o resumo) ou na fila (o andamento, relido enquanto anda). Fechar o
 * diálogo não para nada: a operação segue em "Operações recentes".
 */
export function OperationOutcome({
  operation: accepted,
  onUndo,
  onFollowLink,
}: {
  operation: TriageOperationDetail;
  onUndo: () => void;
  onFollowLink: () => void;
}) {
  const [params] = useSearchParams();
  const query = useTriageOperation(accepted);
  const operation = query.data ?? accepted;
  useRefreshWhenFinished([operation]);
  const active = isActive(operation);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <div className="space-y-3">
      <div role="status" className="space-y-2">
        <h3 ref={heading} tabIndex={-1} className="text-sm font-semibold focus:outline-none">
          {active
            ? 'A operação está na fila e segue sozinha.'
            : operation.state === 'done'
              ? 'Pronto.'
              : `${OPERATION_STATE_LABELS[operation.state]}.`}
        </h3>
        <OperationResult operation={operation} />
      </div>
      {active && (
        <>
          <OperationProgress operation={operation} />
          <p className="text-xs text-muted-foreground">
            Pode fechar: o andamento continua em Operações recentes.
          </p>
        </>
      )}
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {operation.incidentId !== null && operation.action !== 'undo' && (
        <p className="text-sm">
          <Link
            className="font-medium underline"
            to={{
              search: withChanges(
                params,
                { incident: operation.incidentId, finding: null },
                { keepPage: true },
              ).toString(),
            }}
            onClick={onFollowLink}
          >
            Ver o incidente
          </Link>
        </p>
      )}
      <OperationActions operation={operation} onUndo={onUndo} />
    </div>
  );
}
