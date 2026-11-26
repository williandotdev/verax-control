import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { useMediaQuery } from '@/lib/use-media-query';
import { EmptyState, ErrorState, LoadingState } from './states';

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  className?: string;
  /**
   * No celular (abaixo de 768 px), a linha vira um cartão (E-05 da auditoria de UX): `title` vai em cima, inteiro;
   * `status` fica ao lado do título; as outras colunas vão embaixo, cada uma com o nome dela. Sem nenhuma coluna
   * `title`, a tabela continua tabela também no celular.
   */
  card?: 'title' | 'status';
  /** No cartão, esta coluna some nesta linha (o normal, como "Ativa", não ocupa espaço; o diferente aparece). */
  cardOmit?: (row: T) => boolean;
  /** No cartão, a coluna `status` mostra só isto ao lado do título (o selo curto)... */
  cardCell?: (row: T) => ReactNode;
  /** ...e isto embaixo do título, na largura toda (o motivo do estado). */
  cardDetail?: (row: T) => ReactNode;
}

/** Abaixo de 768 px: a largura em que as tabelas de cadastro viram cartões. */
export const CARD_LIST_QUERY = '(max-width: 47.98rem)';

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
  const narrow = useMediaQuery(CARD_LIST_QUERY);
  const cards = narrow && columns.some((column) => column.card === 'title');
  let body: ReactNode;
  if (error) body = <ErrorState error={error} onRetry={onRetry} />;
  else if (loading || !rows) body = <LoadingState rows={Math.min(pageSize, 5)} />;
  else if (rows.length === 0) body = <EmptyState title={emptyTitle} description={emptyDescription} />;
  else if (cards)
    body = (
      <CardList caption={caption} columns={columns} rows={rows} rowKey={rowKey} onRowClick={onRowClick} />
    );
  else
    body = (
      <div data-tour="tabela" className="overflow-x-auto rounded-lg border">
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
      {filters && (
        <div data-tour="filtros" className="flex flex-wrap items-end gap-2">
          {filters}
        </div>
      )}
      {body}
      <Pagination page={page} pageSize={pageSize} total={total} onPageChange={onPageChange} busy={loading} />
    </div>
  );
}

/** O que conta como controle dentro do cartão: um toque nele não abre o item. */
const CONTROLS = 'a, button, input, select, textarea, summary, [role="button"]';

/**
 * As linhas como cartões, no celular (E-05): uma lista com o nome da tabela, um item por linha. O título vai inteiro em
 * cima (o identificador não quebra em pedaços), o estado fica ao lado, com o ícone e o rótulo que a coluna já traz, e o
 * resto embaixo, cada dado com o nome da coluna. O cartão inteiro é o alvo de toque: tocar fora de um controle aciona o
 * primeiro controle do título (o que abre o item), que continua sendo o caminho pelo teclado.
 */
function CardList<T>({
  caption,
  columns,
  rows,
  rowKey,
  onRowClick,
}: Pick<DataTableProps<T>, 'caption' | 'columns' | 'rowKey' | 'onRowClick'> & { rows: T[] }) {
  const title = columns.find((column) => column.card === 'title');
  const status = columns.find((column) => column.card === 'status');
  const rest = columns.filter((column) => column.card === undefined);
  return (
    <ul data-tour="tabela" aria-label={caption} className="divide-y rounded-lg border">
      {rows.map((row) => (
        <li
          key={rowKey(row)}
          className="min-h-11 space-y-1.5 p-3 text-sm"
          onClick={(event) => {
            if ((event.target as Element).closest(CONTROLS)) return;
            if (onRowClick) onRowClick(row);
            else
              event.currentTarget.querySelector<HTMLElement>(`[data-card-title] :is(${CONTROLS})`)?.click();
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <div data-card-title className="min-w-0 flex-1 wrap-anywhere">
              {title?.cell(row)}
            </div>
            {status && !status.cardOmit?.(row) && (
              <div className="shrink-0 text-right">{(status.cardCell ?? status.cell)(row)}</div>
            )}
          </div>
          {status?.cardDetail && !status.cardOmit?.(row) && status.cardDetail(row)}
          {rest.length > 0 && (
            <dl className="space-y-0.5 text-xs">
              {rest
                .filter((column) => !column.cardOmit?.(row))
                .map((column) => (
                  <div key={column.key} className="flex flex-wrap gap-x-1">
                    <dt className="text-muted-foreground">{column.header}:</dt>
                    <dd className="min-w-0 wrap-anywhere">{column.cell(row)}</dd>
                  </div>
                ))}
            </dl>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Paginação feita na API: "1–20 de 134" e os botões de página anterior e seguinte. */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  busy = false,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  busy?: boolean;
}) {
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  const loading = busy;
  return (
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
  );
}
