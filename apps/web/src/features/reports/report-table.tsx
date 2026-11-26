import { ChevronRight, Download } from 'lucide-react';
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

/** Coluna do CSV: o cabeçalho e o valor cru da linha (texto ou número, sem formatação de tela). */
export interface CsvColumn<Row> {
  header: string;
  csv: (row: Row) => CsvCell;
}

/**
 * Bloco de relatório: o título e a exportação em CSV, com o conteúdo embaixo (a tabela ou um gráfico dos mesmos
 * números). O CSV é o mesmo nos dois casos, para o especialista levar à planilha ou a outra ferramenta.
 */
export function ReportSection<Row>({
  caption,
  file,
  rows,
  csv,
  children,
}: {
  caption: string;
  /** Nome do arquivo, sem o período (que vem dos próprios números) nem a extensão. */
  file: string;
  rows: readonly Row[];
  csv: readonly CsvColumn<Row>[];
  children: ReactNode;
}) {
  const { period, current } = useContext(ReportContext);
  const exportCsv = () =>
    downloadCsv(
      `verax-${file}-${period === 'custom' ? 'personalizado' : period}.csv`,
      toCsv(
        csv.map((column) => column.header),
        rows.map((row) => csv.map((column) => column.csv(row))),
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
      {children}
    </section>
  );
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
  collapsed,
}: {
  caption: string;
  /**
   * Com um rótulo, a tabela fica atrás de um trecho que abre e fecha ("Ver tabela completa"), quando o gráfico e a lista
   * ao lado já dão a leitura (R-11). O CSV continua à vista.
   */
  collapsed?: string;
  columns: readonly ReportColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row, index: number) => string;
  /** Nome do arquivo, sem o período (que vem dos próprios números) nem a extensão. */
  file: string;
  empty?: string;
}) {
  const exported = columns.flatMap((column) =>
    column.csv === undefined ? [] : [{ header: column.header, csv: column.csv }],
  );
  return (
    <ReportSection caption={caption} file={file} rows={rows} csv={exported}>
      {rows.length === 0 ? (
        <p className="rounded-md border p-3 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <Collapsible label={collapsed}>
          // Rola por dentro no celular: o foco pelo teclado deixa ler as colunas da direita sem mouse.
          <div
            role="region"
            aria-label={`Tabela: ${caption}`}
            tabIndex={0}
            className="overflow-x-auto rounded-md border focus-visible:outline-2 focus-visible:outline-ring"
          >
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
        </Collapsible>
      )}
    </ReportSection>
  );
}

/** A tabela atrás de um trecho que abre e fecha, ou à vista (sem rótulo). */
function Collapsible({ label, children }: { label: string | undefined; children: ReactNode }) {
  if (label === undefined) return children;
  return (
    <details className="group">
      <summary className="inline-flex min-h-6 cursor-pointer list-none items-center gap-1 rounded py-1 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring max-sm:min-h-11 [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-4 group-open:rotate-90 motion-safe:transition-transform" />
        {label}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}
