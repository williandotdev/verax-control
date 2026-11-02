import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { EmptyState, ErrorState, LoadingState } from './states';

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  className?: string;
}

export interface DataTableProps<T> {
  /** Descrição da tabela para leitor de tela. */
  caption: string;
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  /** Paginação feita na API: a tabela só mostra a página recebida e avisa as mudanças. */
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  /** Filtros (campos controlados pelo chamador), numa linha acima da tabela. */
  filters?: ReactNode;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  emptyTitle?: string;
  emptyDescription?: string;
  onRowClick?: (row: T) => void;
}

const numberFormat = new Intl.NumberFormat('pt-BR');

export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  page,
  pageSize,
  total,
  onPageChange,
  filters,
  loading = false,
  error,
  onRetry,
  emptyTitle = 'Nada encontrado',
  emptyDescription = 'Ajuste os filtros ou tente mais tarde.',
  onRowClick,
}: DataTableProps<T>) {
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  let body: ReactNode;
  if (error) body = <ErrorState error={error} onRetry={onRetry} />;
  else if (loading || !rows) body = <LoadingState rows={Math.min(pageSize, 5)} />;
  else if (rows.length === 0) body = <EmptyState title={emptyTitle} description={emptyDescription} />;
  else
    body = (
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-foreground/[0.03] text-left text-xs text-muted-foreground">
            <tr>
              {columns.map((column) => (
                <th key={column.key} scope="col" className={cn('px-3 py-2 font-medium', column.className)}>
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map((row) => (
              <tr
                key={rowKey(row)}
                className={cn('border-t', onRowClick && 'cursor-pointer hover:bg-foreground/[0.03]')}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((column) => (
                  <td key={column.key} className={cn('px-3 py-2 align-top', column.className)}>
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );

  return (
    <div className="space-y-3">
      {filters && <div className="flex flex-wrap items-end gap-2">{filters}</div>}
      {body}
      <nav
        aria-label="Paginação"
        className="flex items-center justify-between gap-3 text-sm text-muted-foreground"
      >
        <span aria-live="polite">
          {numberFormat.format(first)}–{numberFormat.format(last)} de {numberFormat.format(total)}
        </span>
        <span className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1 || loading}
            aria-label="Página anterior"
          >
            <ChevronLeft aria-hidden />
          </Button>
          <span>
            Página {page} de {lastPage}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= lastPage || loading}
            aria-label="Próxima página"
          >
            <ChevronRight aria-hidden />
          </Button>
        </span>
      </nav>
    </div>
  );
}
