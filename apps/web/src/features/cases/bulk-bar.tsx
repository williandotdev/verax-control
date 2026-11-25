import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import {
  BULK_ACTION_LABELS,
  BULK_ACTIONS,
  type BulkAction,
  INCIDENT_ACTIONS,
  type PendingCounts,
  sumPending,
} from './bulk';
import { useCasesContext } from './cases-context';
import { alertCount } from './labels';

/**
 * A barra da triagem em massa, que aparece com a seleção: presa ao pé da lista no computador e ao pé da tela no celular
 * (onde as ações ficam num botão só, que abre o diálogo). A contagem é anunciada; a barra nunca muda nada sozinha.
 */
export function BulkBar({
  summary,
  pending,
  note,
  extra,
  onAction,
  onClear,
}: {
  /** "3 casos" ou "Todos os 57 casos do filtro". */
  summary: string;
  /** Os alertas pendentes da seleção; null quando só a API sabe (o filtro inteiro). */
  pending: PendingCounts | null;
  /** Um aviso, por exemplo o teto da seleção. */
  note?: ReactNode;
  /** Outras ações da seleção ("Selecionar os N casos do filtro"). */
  extra?: ReactNode;
  onAction: (action: BulkAction | undefined) => void;
  onClear: () => void;
}) {
  const { canPromote } = useCasesContext();
  const actions = BULK_ACTIONS.filter((action) => canPromote || !INCIDENT_ACTIONS.includes(action));
  return (
    <>
      {/* No celular a barra cobre o pé da tela: a paginação e o fim da lista sobem acima dela. */}
      <div aria-hidden className="h-44 md:hidden" />
      <section
        role="region"
        aria-label="Ações em lote"
        data-tour="casos-lote"
        className={cn(
          'z-20 space-y-2 border bg-surface-raised p-3 shadow-lg',
          'max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:my-0 max-md:rounded-t-xl max-md:pb-[max(0.75rem,env(safe-area-inset-bottom))]',
          'md:sticky md:bottom-4 md:rounded-xl',
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <p role="status" className="min-w-0 text-sm">
            <strong>{summary}</strong>
            {pending !== null && (
              <span className="text-muted-foreground"> · {alertCount(sumPending(pending))}</span>
            )}
          </p>
          <Button variant="ghost" size="sm" className="shrink-0 max-md:h-11" onClick={onClear}>
            <X aria-hidden />
            Limpar<span className="sr-only"> a seleção</span>
          </Button>
        </div>
        <div className="hidden flex-wrap gap-2 md:flex">
          {actions.map((action) => (
            <Button key={action} variant="secondary" size="sm" onClick={() => onAction(action)}>
              {BULK_ACTION_LABELS[action].label}
            </Button>
          ))}
        </div>
        <Button className="h-11 w-full md:hidden" onClick={() => onAction(undefined)}>
          Tratar a seleção
        </Button>
        {extra}
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </section>
    </>
  );
}
