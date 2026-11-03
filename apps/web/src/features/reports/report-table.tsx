import { Download } from 'lucide-react';
import { type ReactNode, useContext } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { type CsvCell, downloadCsv, toCsv } from './csv';
import { ReportContext } from './report-context';

export interface ReportColumn<Row> {
  header: string;
  /** O que aparece na tela. */
  cell: (row: Row) => ReactNode;
  /** O que vai para o CSV (texto ou número cru, sem formatação de tela). Sem ele, a coluna fica fora do arquivo. */
  csv?: (row: Row) => CsvCell;
  align?: 'right';
}

/**
 * Tabela de relatório: rolagem horizontal dentro do próprio quadro (no celular) e exportação em CSV com o mesmo
 * conteúdo, para o especialista levar à planilha ou a outra ferramenta.
 */
export function ReportTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
  file,
  empty = 'Nada no período.',
}: {
  caption: string;
  columns: readonly ReportColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row, index: number) => string;
  /** Nome do arquivo, sem o período (que vem dos próprios números) nem a extensão. */
  file: string;
  empty?: string;
}) {
  const { period, current } = useContext(ReportContext);
  const exported = columns.filter((column) => column.csv !== undefined);
  const exportCsv = () =>
    downloadCsv(
      `verax-${file}-${period}.csv`,
      toCsv(
        exported.map((column) => column.header),
        rows.map((row) => exported.map((column) => column.csv?.(row))),
      ),
    );
  return (
    // min-w-0: numa grade, o bloco encolhe até a tela e a tabela rola por dentro, em vez de alargar a página.
    <section className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{caption}</h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={exportCsv}
          disabled={rows.length === 0 || !current}
          aria-label={`Exportar ${caption} em CSV`}
        >
          <Download aria-hidden />
          CSV
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-md border p-3 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <caption className="sr-only">{caption}</caption>
            <thead className="bg-foreground/[0.03] text-left text-xs text-muted-foreground">
              <tr>
                {columns.map((column) => (
                  <th
                    key={column.header}
                    scope="col"
                    className={cn(
                      'px-3 py-2 font-medium whitespace-nowrap',
                      column.align === 'right' && 'text-right',
                    )}
                  >
                    {column.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={rowKey(row, index)} className="border-t">
                  {columns.map((column) => (
                    <td
                      key={column.header}
                      className={cn(
                        'px-3 py-2 align-top',
                        column.align === 'right' && 'text-right tabular-nums',
                      )}
                    >
                      {column.cell(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
