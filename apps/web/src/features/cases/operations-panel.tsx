import { type Author, isMassTriageRole, type TriageOperationDetail } from '@verax/shared';
import { ChevronDown, ChevronRight, LoaderCircle } from 'lucide-react';
import { useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Pagination } from '@/components/data-table';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { SelectField } from '@/components/ui/select-field';
import { withChanges } from '@/features/detections/url-state';
import { ApiRequestError } from '@/lib/api-client';
import { formatRelative, formatTimestamp } from '@/lib/format';
import { useCasesContext } from './cases-context';
import { OperationActions, OperationProgress, OperationResult } from './operation-outcome';
import {
  isActive,
  OPERATION_STATE_LABELS,
  operationTitle,
  progressText,
  resultText,
  targetText,
} from './operation-text';
import { OPERATIONS_PAGE, useRefreshWhenFinished, useTriageOperations } from './triage-api';

const ALL_AUTHORS = '';

/**
 * "Operações recentes": o histórico da triagem em massa, sempre na tela (nada some sozinho), com o andamento, cancelar,
 * continuar e desfazer. Recolhido, diz em uma linha o que anda ou a última que terminou. Sem nenhuma operação, não aparece.
 * Só se relê sozinho enquanto há operação andando.
 */
export function OperationsPanel() {
  const { role, userId } = useCasesContext();
  const [expanded, setExpanded] = useState(false);
  const [authorId, setAuthorId] = useState(ALL_AUTHORS);
  const [page, setPage] = useState(1);
  const contentId = useId();
  const titleId = useId();
  // A primeira página de todos é a que diz o que anda; o filtro e as outras páginas são outra leitura.
  const latest = useTriageOperations({ page: 1 }, true);
  const filtered = authorId !== ALL_AUTHORS || page > 1;
  const listed = useTriageOperations(
    { page, ...(authorId !== ALL_AUTHORS && { authorId }) },
    filtered && expanded,
  );
  const shown = filtered ? listed : latest;
  const operations = latest.data?.items ?? [];
  useRefreshWhenFinished(operations);

  // As pessoas das operações mais recentes, e quem está vendo.
  const authors = new Map<string, Author>();
  for (const { author } of [...operations, ...(listed.data?.items ?? [])]) {
    if (author) authors.set(author.id, author);
  }
  const chosen = authors.get(authorId);

  if (latest.isError && operations.length === 0) {
    // Um nó que já tem os casos e ainda não tem as operações: sem histórico, sem erro.
    if (latest.error instanceof ApiRequestError && latest.error.status === 404) return null;
    return <ErrorState error={latest.error} onRetry={() => void latest.refetch()} />;
  }
  if (operations.length === 0) return null;

  const moving = operations.filter((operation) => isActive(operation) || operation.state === 'undoing');
  const active = moving.filter(isActive);
  const [last] = operations;
  return (
    <section aria-labelledby={titleId} className="rounded-xl border bg-surface shadow-xs">
      <header className="flex items-center justify-between gap-3 py-1 pr-1 pl-4">
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <h2 id={titleId} className="text-sm font-semibold">
            Operações recentes
          </h2>
          {/* O que muda de fase é anunciado; o número que anda, não (seria uma fala a cada releitura). */}
          <p role="status" className="sr-only">
            {active[0]
              ? `Em andamento: ${operationTitle(active[0]).toLowerCase()}.`
              : last && `Última operação: ${operationTitle(last).toLowerCase()}. ${resultText(last)}`}
          </p>
          <p aria-hidden className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {active[0] ? (
              <>
                <LoaderCircle aria-hidden className="size-3.5 shrink-0 motion-safe:animate-spin" />
                {operationTitle(active[0])}: {progressText(active[0])}
                {active.length > 1 && ` e mais ${active.length - 1} na fila`}
              </>
            ) : (
              last &&
              `Última: ${operationTitle(last).toLowerCase()}, ${formatRelative(last.createdAt)}. ${resultText(last)}`
            )}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="max-md:h-11"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
          {expanded ? 'Recolher' : 'Mostrar'}
          <span className="sr-only"> as operações recentes</span>
        </Button>
      </header>
      <div id={contentId} hidden={!expanded} className="space-y-3 border-t p-4">
        {expanded && (
          <>
            <div className="flex flex-wrap items-end gap-2">
              <SelectField
                label="De quem"
                value={authorId}
                onChange={(value) => {
                  setAuthorId(value);
                  setPage(1);
                }}
                options={[
                  { value: ALL_AUTHORS, label: 'Todas as pessoas' },
                  ...(userId !== null ? [{ value: userId, label: 'As minhas' }] : []),
                  ...[...authors.values()]
                    .filter((author) => author.id !== userId)
                    .map((author) => ({ value: author.id, label: author.name })),
                ]}
              />
              {chosen && role !== null && isMassTriageRole(role) && <UndoAllButton author={chosen} />}
            </div>
            {shown.isError ? (
              <ErrorState error={shown.error} onRetry={() => void shown.refetch()} />
            ) : !shown.data ? (
              <LoadingState rows={2} label="Carregando as operações" />
            ) : shown.data.items.length === 0 ? (
              <EmptyState title="Nenhuma operação desta pessoa" />
            ) : (
              <ul className="divide-y rounded-md border">
                {shown.data.items.map((operation) => (
                  <OperationRow key={operation.id} operation={operation} />
                ))}
              </ul>
            )}
            {(shown.data?.total ?? 0) > OPERATIONS_PAGE && (
              <Pagination
                page={page}
                pageSize={OPERATIONS_PAGE}
                total={shown.data?.total ?? 0}
                onPageChange={setPage}
                busy={shown.isFetching && shown.isPlaceholderData}
              />
            )}
          </>
        )}
      </div>
    </section>
  );
}

function UndoAllButton({ author }: { author: Author }) {
  const { openUndoAll, canTriage } = useCasesContext();
  if (!canTriage) return null;
  return (
    <Button variant="secondary" size="sm" className="h-9 max-md:h-11" onClick={() => openUndoAll(author)}>
      Desfazer tudo de {author.name}
    </Button>
  );
}

function OperationRow({ operation }: { operation: TriageOperationDetail }) {
  const [params] = useSearchParams();
  const active = isActive(operation);
  return (
    <li className="space-y-2 px-3 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 text-sm">
          <strong>{operationTitle(operation)}</strong>
          <span className="wrap-anywhere text-muted-foreground"> · {targetText(operation.target)}</span>
        </p>
        <span className="rounded-full border px-2 py-0.5 text-xs font-medium text-muted-foreground">
          {OPERATION_STATE_LABELS[operation.state]}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {operation.author?.name ?? 'Pessoa excluída'} ·{' '}
        <time dateTime={operation.createdAt} title={formatTimestamp(operation.createdAt)}>
          {formatRelative(operation.createdAt)}
        </time>
      </p>
      {operation.reason !== null && (
        <p className="text-sm wrap-anywhere whitespace-pre-wrap">{operation.reason}</p>
      )}
      {active ? <OperationProgress operation={operation} /> : <OperationResult operation={operation} />}
      {operation.incidentId !== null && operation.action !== 'undo' && (
        <p className="text-sm">
          <Link
            className="underline"
            to={{
              search: withChanges(
                params,
                { incident: operation.incidentId, finding: null, case: null },
                { keepPage: true },
              ).toString(),
            }}
          >
            Ver o incidente
          </Link>
        </p>
      )}
      <OperationActions operation={operation} />
    </li>
  );
}
