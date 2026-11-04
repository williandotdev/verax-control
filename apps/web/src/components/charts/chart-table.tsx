import { ChevronRight } from 'lucide-react';

/**
 * A tabela de um gráfico, atrás de "Ver tabela": os mesmos números, sem depender da cor nem do mouse, para leitor de
 * tela, teclado e quem quer o valor exato. A primeira coluna nomeia a linha; as outras são números, alinhados à
 * direita. No celular a tabela rola dentro do próprio quadro, que recebe foco para rolar pelo teclado.
 */
export function ChartTable({
  title,
  headers,
  rows,
}: {
  title: string;
  headers: readonly string[];
  rows: readonly { key: string; cells: readonly string[] }[];
}) {
  return (
    <details className="group mt-3">
      <summary className="inline-flex min-h-6 cursor-pointer list-none items-center gap-1 rounded py-1 text-xs font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="size-3.5 group-open:rotate-90 motion-safe:transition-transform"
        />
        Ver tabela<span className="sr-only">: {title}</span>
      </summary>
      <div
        role="region"
        aria-label={`Tabela: ${title}`}
        tabIndex={0}
        className="mt-2 overflow-x-auto rounded-md border"
      >
        <table className="w-full text-sm">
          <caption className="sr-only">{title}</caption>
          <thead className="bg-foreground/[0.03] text-xs text-muted-foreground">
            <tr>
              {headers.map((header, index) => (
                <th
                  key={header}
                  scope="col"
                  className={
                    index === 0 ? 'px-3 py-2 text-left font-medium' : 'px-3 py-2 text-right font-medium'
                  }
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-t">
                {row.cells.map((cell, index) =>
                  index === 0 ? (
                    <th key={index} scope="row" className="px-3 py-2 text-left font-normal whitespace-nowrap">
                      {cell}
                    </th>
                  ) : (
                    <td key={index} className="px-3 py-2 text-right tabular-nums">
                      {cell}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
